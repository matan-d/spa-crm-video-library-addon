/**
 * Shared mechanism for the fixture generator and the fixture verifier.
 *
 * Two notes on scope, because one of them is easy to get wrong later.
 *
 * 1. `peekContainer()` reads a handful of atom headers. It is a VERIFICATION
 *    TOOL for the build, not the application parser, and the application parser
 *    in `src/` must be written independently. If the two ever share code the
 *    manifest stops being an independent statement about the bytes and starts
 *    being a restatement of whatever the parser happens to do, which is exactly
 *    the circularity the declared-versus-expected split exists to prevent.
 *    It reads only what ffprobe cannot report: the raw mvhd creation field
 *    (ffprobe omits it when it is zero, and zero is the interesting case), the
 *    top level atom order, and whether the mdat size field is 32 or 64 bit.
 *
 * 2. ffmpeg-static ships no ffprobe binary, so ffprobe comes from
 *    ffprobe-static. If neither resolves the build still completes, and the
 *    manifest records `facts_verified: false`, because a fact nobody checked
 *    must not look like a fact somebody did.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const exec = promisify(execFile)

/** The HFS+ epoch QuickTime and ISO BMFF timestamps count from: 1904-01-01. */
export const MAC_EPOCH_OFFSET_S = 2082844800

/** Mean earth radius, IUGG. Any correct great circle formula lands inside the 30m tolerance. */
const EARTH_RADIUS_M = 6371008.8

export function repoRoot(importMetaUrl) {
  return join(dirname(fileURLToPath(importMetaUrl)), '..')
}

// ---------------------------------------------------------------------------
// ffmpeg and ffprobe
// ---------------------------------------------------------------------------

export function ffmpegBinary() {
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error(
      'ffmpeg-static did not resolve a binary. Run `npm install` and check node_modules/ffmpeg-static.',
    )
  }
  return ffmpegPath
}

/**
 * ffprobe, or null. Never throws: an absent probe is a recorded gap, not a
 * crash, and the caller decides what that means.
 */
export function ffprobeBinary() {
  if (ffprobeStatic?.path && existsSync(ffprobeStatic.path)) return ffprobeStatic.path
  const sibling = join(dirname(ffmpegBinary()), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (existsSync(sibling)) return sibling
  return null
}

/** libfreetype needs a real font file. Fontconfig is unusable on this build, so the path is explicit. */
export function resolveFont() {
  const windir = process.env.WINDIR || 'C:/Windows'
  const candidates = [
    join(windir, 'Fonts', 'arial.ttf'),
    join(windir, 'Fonts', 'segoeui.ttf'),
    join(windir, 'Fonts', 'verdana.ttf'),
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(
    `no usable TrueType font found, tried:\n  ${candidates.join('\n  ')}\nEvery fixture carries a burned in label, so the build fails rather than shipping unlabelled clips.`,
  )
}

export async function runFfmpeg(argv) {
  try {
    const { stderr } = await exec(ffmpegBinary(), ['-hide_banner', '-loglevel', 'error', ...argv], {
      maxBuffer: 1024 * 1024 * 64,
    })
    return noise(stderr)
  } catch (error) {
    const detail = noise(error.stderr || error.message || '')
      .split('\n')
      .filter(Boolean)
      .slice(-5)
      .join(' | ')
    throw new Error(`ffmpeg failed: ${detail || 'no stderr'}`)
  }
}

/** The banner goes to stdout, which `runFfmpeg` deliberately does not return. */
export async function ffmpegVersion() {
  try {
    const { stdout } = await exec(ffmpegBinary(), ['-hide_banner', '-version'], { maxBuffer: 1024 * 256 })
    return /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The gyan build is compiled with fontconfig but ships no fontconfig
 * configuration, so libfreetype prints a config warning on every drawtext call
 * even when the explicit fontfile works. Dropping only that exact line keeps a
 * real warning visible.
 */
function noise(text) {
  return String(text)
    .split('\n')
    .filter((line) => !line.startsWith('Fontconfig error'))
    .join('\n')
    .trim()
}

/**
 * Everything ffprobe can tell us about a media file, normalised.
 * Returns `{ available: false }` when there is no ffprobe binary.
 */
export async function probe(file) {
  const bin = ffprobeBinary()
  if (!bin) return { available: false }

  const { stdout } = await exec(
    bin,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { maxBuffer: 1024 * 1024 * 32 },
  )
  const parsed = JSON.parse(stdout)
  const video = (parsed.streams || []).find((s) => s.codec_type === 'video') || null
  const audio = (parsed.streams || []).find((s) => s.codec_type === 'audio') || null
  const matrix = (video?.side_data_list || []).find((s) => s.side_data_type === 'Display Matrix')

  // ffprobe reports the display matrix as counter-clockwise degrees. Our
  // canonical `rotation_deg` is clockwise-degrees-to-display, which is the
  // convention every camera and every player uses, and which makes a portrait
  // iPhone clip read as 90 rather than as -90.
  const ccw = matrix ? Number(matrix.rotation) : 0
  const rotationDeg = ((Math.round(-ccw) % 360) + 360) % 360

  const tags = parsed.format?.tags || {}
  return {
    available: true,
    format_name: parsed.format?.format_name ?? null,
    duration_s: parsed.format?.duration != null ? Number(parsed.format.duration) : null,
    bytes: parsed.format?.size != null ? Number(parsed.format.size) : null,
    format_tags: tags,
    creation_time: tags.creation_time ?? null,
    location: tags.location ?? null,
    day_tag: tags.date ?? null,
    video: video
      ? {
          codec_name: video.codec_name ?? null,
          codec_tag_string: video.codec_tag_string ?? null,
          coded_width: video.width ?? null,
          coded_height: video.height ?? null,
          // tkhd holds the aspect corrected presentation size, so a SAR other
          // than 1:1 makes tkhd dimensions differ from coded dimensions.
          sar: video.sample_aspect_ratio ?? '1:1',
          pix_fmt: video.pix_fmt ?? null,
          r_frame_rate: video.r_frame_rate ?? null,
          fps: rateToNumber(video.r_frame_rate),
          nb_frames: video.nb_frames != null ? Number(video.nb_frames) : null,
          duration_s: video.duration != null ? Number(video.duration) : null,
          rotation_ccw_deg: matrix ? Number(matrix.rotation) : null,
          rotation_deg: rotationDeg,
          display_matrix_present: Boolean(matrix),
        }
      : null,
    audio: audio
      ? {
          codec_name: audio.codec_name ?? null,
          codec_tag_string: audio.codec_tag_string ?? null,
          sample_rate: audio.sample_rate != null ? Number(audio.sample_rate) : null,
          channels: audio.channels ?? null,
        }
      : null,
    has_audio: Boolean(audio),
  }
}

function rateToNumber(rate) {
  if (!rate) return null
  const [n, d] = String(rate).split('/').map(Number)
  if (!d) return n ?? null
  return Number((n / d).toFixed(3))
}

// ---------------------------------------------------------------------------
// Container peek: only the facts ffprobe cannot report
// ---------------------------------------------------------------------------

/**
 * Walk sibling atoms, header only, exactly the technique C5.2.1 prescribes for
 * the browser: read the 8 or 16 byte header and jump by the size field, never
 * read `mdat`.
 */
function siblings(buffer, start, end) {
  const out = []
  let offset = start
  let hops = 0
  while (offset + 8 <= end && hops < 512) {
    hops += 1
    const size32 = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let size = size32
    let headerSize = 8
    if (size32 === 1) {
      if (offset + 16 > end) break
      size = Number(buffer.readBigUInt64BE(offset + 8))
      headerSize = 16
    } else if (size32 === 0) {
      size = end - offset // "to end of file", legal for the last atom
    }
    if (size < headerSize) break
    out.push({ type, start: offset, size, headerSize, size_field: size32 === 1 ? '64bit_largesize' : '32bit' })
    offset += size
  }
  return out
}

function descend(buffer, parent, type) {
  return siblings(buffer, parent.start + parent.headerSize, parent.start + parent.size).find(
    (a) => a.type === type,
  )
}

/**
 * Reads: the ftyp brand, the top level atom order, whether mdat carries a 32 or
 * 64 bit size field, the raw mvhd creation field, and the video track's tkhd
 * display matrix and 16.16 dimensions.
 *
 * Not the application parser. See the header of this file.
 */
export function peekContainer(file) {
  const buffer = readFileSync(file)
  const top = siblings(buffer, 0, buffer.length)
  const names = top.map((a) => a.type)
  const ftyp = top.find((a) => a.type === 'ftyp')
  const mdat = top.find((a) => a.type === 'mdat')
  const moov = top.find((a) => a.type === 'moov')

  const result = {
    is_isobmff: Boolean(ftyp || moov),
    ftyp_brand: ftyp ? buffer.toString('latin1', ftyp.start + 8, ftyp.start + 12) : null,
    top_level_atoms: names,
    moov_position:
      moov && mdat ? (moov.start < mdat.start ? 'start' : 'end') : moov ? 'only_moov' : null,
    mdat_size_field: mdat ? mdat.size_field : null,
    mdat_bytes: mdat ? mdat.size : null,
    mvhd: null,
    video_tkhd: null,
  }
  if (!moov) return result

  const mvhd = descend(buffer, moov, 'mvhd')
  if (mvhd) {
    const p = mvhd.start + mvhd.headerSize
    const version = buffer[p]
    const wide = version === 1
    const creationRaw = wide ? Number(buffer.readBigUInt64BE(p + 4)) : buffer.readUInt32BE(p + 4)
    const timescale = buffer.readUInt32BE(p + 4 + (wide ? 16 : 8))
    const durationRaw = wide
      ? Number(buffer.readBigUInt64BE(p + 4 + 20))
      : buffer.readUInt32BE(p + 4 + 12)
    result.mvhd = {
      version,
      creation_time_raw: creationRaw,
      creation_time_iso:
        creationRaw === 0 ? null : new Date((creationRaw - MAC_EPOCH_OFFSET_S) * 1000).toISOString(),
      timescale,
      duration_raw: durationRaw,
      duration_s: timescale ? Number((durationRaw / timescale).toFixed(3)) : null,
    }
  }

  for (const trak of siblings(buffer, moov.start + moov.headerSize, moov.start + moov.size).filter(
    (a) => a.type === 'trak',
  )) {
    const mdia = descend(buffer, trak, 'mdia')
    const hdlr = mdia ? descend(buffer, mdia, 'hdlr') : null
    const handler = hdlr ? buffer.toString('latin1', hdlr.start + 16, hdlr.start + 20) : null
    if (handler !== 'vide') continue
    const tkhd = descend(buffer, trak, 'tkhd')
    if (!tkhd) continue
    const p = tkhd.start + tkhd.headerSize
    const version = buffer[p]
    const matrixOffset = p + 4 + (version === 1 ? 32 : 20) + 8 + 8
    const matrix = Array.from({ length: 9 }, (_, i) => buffer.readInt32BE(matrixOffset + i * 4))
    result.video_tkhd = {
      version,
      matrix,
      matrix_hex: matrix.map((v) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`),
      // a, b, c, d as plain numbers, which is the only part orientation needs
      abcd: [matrix[0] / 65536, matrix[1] / 65536, matrix[3] / 65536, matrix[4] / 65536],
      rotation_deg: matrixToClockwiseDegrees(matrix),
      width: buffer.readUInt32BE(matrixOffset + 36) / 65536,
      height: buffer.readUInt32BE(matrixOffset + 40) / 65536,
    }
    break
  }
  return result
}

/**
 * The display matrix reduced to clockwise degrees to apply for display, which is
 * the only thing orientation needs from it. Returns null for a matrix that is
 * not one of the four right angle cases, because a sheared or flipped matrix is
 * a real container that this product does not claim to handle.
 */
export function matrixToClockwiseDegrees(matrix) {
  const a = matrix[0] / 65536
  const b = matrix[1] / 65536
  const c = matrix[3] / 65536
  const d = matrix[4] / 65536
  const is = (w, x, y, z) => a === w && b === x && c === y && d === z
  if (is(1, 0, 0, 1)) return 0
  if (is(0, 1, -1, 0)) return 90
  if (is(-1, 0, 0, -1)) return 180
  if (is(0, -1, 1, 0)) return 270
  return null
}

/**
 * Rewrites the 8 byte `free` atom ffmpeg reserves in front of `mdat` into a 16
 * byte 64 bit `mdat` header (`size == 1` plus a largesize). The mdat payload
 * keeps its absolute offset, so every `stco` entry stays correct and the file
 * still decodes. Real files only take this form above 4GB, which cannot be
 * committed.
 */
export function patchToLargesizeMdat(file) {
  const buffer = readFileSync(file)
  const top = siblings(buffer, 0, buffer.length)
  const freeIndex = top.findIndex(
    (a, i) => a.type === 'free' && a.size === 8 && top[i + 1]?.type === 'mdat',
  )
  if (freeIndex < 0) {
    throw new Error(
      'no 8 byte `free` atom immediately before `mdat`, so the 64 bit rewrite would have to move the mdat payload and invalidate every stco offset. Refusing rather than shipping a broken fixture.',
    )
  }
  const free = top[freeIndex]
  const mdat = top[freeIndex + 1]
  if (mdat.size_field !== '32bit') throw new Error('mdat already carries a 64 bit size field')

  const header = Buffer.alloc(16)
  header.writeUInt32BE(1, 0) // size == 1 means "the real size is the 64 bit largesize"
  header.write('mdat', 4, 'latin1')
  header.writeBigUInt64BE(BigInt(free.size + mdat.size), 8)
  header.copy(buffer, free.start)
  writeFileSync(file, buffer)
  return { at: free.start, largesize: free.size + mdat.size }
}

// ---------------------------------------------------------------------------
// Geometry, geography, hashing
// ---------------------------------------------------------------------------

/** Display dimensions from coded dimensions plus clockwise rotation. */
export function displayDims(codedWidth, codedHeight, rotationDeg) {
  return rotationDeg === 90 || rotationDeg === 270
    ? { width: codedHeight, height: codedWidth }
    : { width: codedWidth, height: codedHeight }
}

export function orientationOf(width, height) {
  if (height > width) return 'vertical'
  if (width > height) return 'horizontal'
  return 'square'
}

/** `+37.33928-121.88630+017.000/` to degrees. Fails loudly rather than guessing. */
export function parseIso6709(value) {
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?))?\/?$/.exec(
    String(value).trim(),
  )
  if (!match) throw new Error(`not an ISO 6709 location string: ${value}`)
  return {
    lat: Number(match[1]),
    lng: Number(match[2]),
    alt_m: match[3] != null ? Number(match[3]) : null,
  }
}

export function haversineMetres(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

export async function byteLength(file) {
  return (await stat(file)).size
}

export function kb(bytes) {
  return `${(bytes / 1024).toFixed(0)}KB`
}

// ---------------------------------------------------------------------------
// drawtext
// ---------------------------------------------------------------------------

/** A filtergraph option value that is a filesystem path. Backslashes and the drive colon both bite. */
export function escapeFilterPath(path) {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:')
}

/** A filtergraph option value that is literal text. */
export function escapeFilterText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%')
}
