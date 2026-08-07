/**
 * Builds the committed media for the seeded library.
 *
 * Pipeline per source still:
 *   download -> render a slow pan and zoom clip -> extract 5 real frames into a
 *   contact sheet -> extract a poster frame -> record everything in a manifest
 *
 * Two things about this are deliberate and should not be "optimised" later.
 *
 * First, the contact sheets are produced by extracting frames from an actual
 * video file rather than by cropping the still five times. The tiles are
 * therefore genuine frame extractions, which is what the AI intake layer will
 * receive in production, so the authored fixtures are written against the same
 * artefact the real pipeline produces.
 *
 * Second, only a few clips are committed. Everything else ships as a poster plus
 * a sheet with bytes absent, which is exactly the state every record will be in
 * once bytes live in object storage. The local prototype and the real system
 * share one render path rather than two.
 *
 * Honest limitation, recorded here and in the manifest: these clips are derived
 * from photographs, so the motion is a synthetic pan rather than a camera move,
 * and the five frames of a sheet are closer together in content than five frames
 * of real footage would be. The engineered fixtures under public/fixtures are
 * real encodes and are what the parser is judged against. These are for the
 * library to look like a library.
 *
 * Usage:
 *   node scripts/build-seed-media.mjs [--only slug] [--force]
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { COMMITTED_CLIPS, ORIENTATIONS, SEED_MEDIA, SOURCE_WIDTH } from './seed-media.config.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const CACHE_DIR = join(root, '.cache', 'seed-sources')
const WORK_DIR = join(root, '.cache', 'seed-work')
const OUT_DIR = join(root, 'public', 'seed')
const POSTER_DIR = join(OUT_DIR, 'posters')
const SHEET_DIR = join(OUT_DIR, 'sheets')
const CLIP_DIR = join(OUT_DIR, 'clips')

const GENERATOR_VERSION = 1
const CLIP_SECONDS = 6
const CLIP_FPS = 25
const FRAMES_PER_SHEET = 5
const SHEET_TILE_WIDTH = 216 // 5 tiles at 9:16 lands the sheet at 1080x384
const POSTER_LONG_EDGE = 480

const args = process.argv.slice(2)
const only = valueOf('--only')
const force = args.includes('--force')

const LICENSE = {
  source: 'Pexels',
  license: 'Pexels License',
  url: 'https://www.pexels.com/license/',
  terms: 'Free to use, including commercially. Modification permitted. Attribution not required, recorded here anyway.',
}

async function main() {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary path')
  const ffprobePath = await findFfprobe()

  for (const dir of [CACHE_DIR, WORK_DIR, POSTER_DIR, SHEET_DIR, CLIP_DIR]) {
    await mkdir(dir, { recursive: true })
  }

  const selected = only ? SEED_MEDIA.filter((m) => m.slug === only) : SEED_MEDIA
  if (selected.length === 0) throw new Error(`--only ${only} matched no entry in seed-media.config.mjs`)

  const entries = []
  let failures = 0

  for (const item of selected) {
    try {
      entries.push(await buildOne(item, ffprobePath))
      process.stdout.write(`  ok   ${item.slug}\n`)
    } catch (error) {
      failures += 1
      process.stdout.write(`  FAIL ${item.slug}: ${error.message}\n`)
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${selected.length} seed media items failed`)
  }

  if (!only) {
    const manifest = {
      generator_version: GENERATOR_VERSION,
      built_at: new Date().toISOString(),
      license: LICENSE,
      note: 'Clips are derived from the source stills by a synthetic pan and zoom. Contact sheets are real frame extractions from those clips. See scripts/build-seed-media.mjs for why.',
      items: entries,
    }
    await writeFile(join(OUT_DIR, 'media-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeCredits(entries)
    await report(entries)
  }
}

async function buildOne(item, ffprobePath) {
  const { w, h } = ORIENTATIONS[item.orientation]
  const source = join(CACHE_DIR, `${item.slug}.jpg`)
  const clip = join(WORK_DIR, `${item.slug}.mp4`)
  const framePattern = join(WORK_DIR, `${item.slug}-f%02d.jpg`)
  const sheet = join(SHEET_DIR, `${item.slug}.jpg`)
  const poster = join(POSTER_DIR, `${item.slug}.jpg`)

  if (force || !existsSync(source)) {
    await download(
      `https://images.pexels.com/photos/${item.id}/pexels-photo-${item.id}.jpeg?auto=compress&cs=tinysrgb&w=${SOURCE_WIDTH}`,
      source,
    )
  }

  // A slow zoom with a gentle horizontal drift. The source is cropped to the
  // target aspect first, because zoompan samples a region with the input's
  // aspect ratio and would otherwise stretch it.
  const cropToAspect = `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'`
  const oversample = `scale=${w * 1.25}:${h * 1.25}:flags=lanczos`
  const totalFrames = CLIP_SECONDS * CLIP_FPS
  const pan =
    `zoompan=z='min(1+0.0012*on,1.16)'` +
    `:x='iw/2-(iw/zoom/2)+sin(on/${totalFrames}*3.14159)*(iw*0.04)'` +
    `:y='ih/2-(ih/zoom/2)'` +
    `:d=1:s=${w}x${h}:fps=${CLIP_FPS}`

  await ffmpeg([
    '-y',
    '-loop', '1',
    '-t', String(CLIP_SECONDS),
    '-i', source,
    '-vf', `${cropToAspect},${oversample},${pan},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '30',
    '-g', String(CLIP_FPS * 2),
    '-movflags', '+faststart',
    '-an',
    clip,
  ])

  // Five frames evenly spaced across the clip, avoiding the first and last
  // moments where a pan has the least movement.
  const step = CLIP_SECONDS / (FRAMES_PER_SHEET + 1)
  await ffmpeg([
    '-y',
    '-i', clip,
    '-vf', `fps=1/${step},scale=${SHEET_TILE_WIDTH}:-2`,
    '-frames:v', String(FRAMES_PER_SHEET),
    framePattern,
  ])

  const frameFiles = (await readdir(WORK_DIR))
    .filter((f) => f.startsWith(`${item.slug}-f`))
    .sort()
    .slice(0, FRAMES_PER_SHEET)
  if (frameFiles.length !== FRAMES_PER_SHEET) {
    throw new Error(`expected ${FRAMES_PER_SHEET} frames, extracted ${frameFiles.length}`)
  }

  await ffmpeg([
    '-y',
    ...frameFiles.flatMap((f) => ['-i', join(WORK_DIR, f)]),
    '-filter_complex', `hstack=inputs=${FRAMES_PER_SHEET}`,
    '-q:v', '6',
    sheet,
  ])

  const posterScale =
    w >= h ? `scale=${POSTER_LONG_EDGE}:-2` : `scale=-2:${POSTER_LONG_EDGE}`
  await ffmpeg([
    '-y',
    '-ss', String(CLIP_SECONDS / 2),
    '-i', clip,
    '-frames:v', '1',
    '-vf', posterScale,
    '-q:v', '5',
    poster,
  ])

  const commitClip = COMMITTED_CLIPS.includes(item.slug)
  let clipOut = null
  if (commitClip) {
    clipOut = join(CLIP_DIR, `${item.slug}.mp4`)
    await run('node', ['-e', `require('fs').copyFileSync(${JSON.stringify(clip)}, ${JSON.stringify(clipOut)})`])
  }

  for (const f of frameFiles) await rm(join(WORK_DIR, f), { force: true })

  const probe = await probeVideo(ffprobePath, clip, {
    width: w,
    height: h,
    duration_s: CLIP_SECONDS,
    codec_video: 'h264',
  })

  return {
    slug: item.slug,
    source: {
      provider: 'pexels',
      photo_id: item.id,
      page_url: `https://www.pexels.com/photo/${item.id}/`,
      file_url: `https://images.pexels.com/photos/${item.id}/pexels-photo-${item.id}.jpeg`,
    },
    orientation: item.orientation,
    meta: item.meta,
    // Facts about the derived clip, so the seed dataset does not have to invent them.
    derived_clip: {
      width: probe.width,
      height: probe.height,
      duration_s: probe.duration_s,
      fps: CLIP_FPS,
      codec_video: probe.codec_video,
      facts_verified: probe.verified,
      has_audio: false,
      committed: commitClip,
      path: commitClip ? `/seed/clips/${item.slug}.mp4` : null,
      bytes: commitClip ? (await stat(clipOut)).size : (await stat(clip)).size,
      sha256: commitClip ? await hashFile(clipOut) : null,
    },
    poster: await artefact(poster, `/seed/posters/${item.slug}.jpg`),
    contact_sheet: {
      ...(await artefact(sheet, `/seed/sheets/${item.slug}.jpg`)),
      layout: `1x${FRAMES_PER_SHEET}`,
      tile_width: SHEET_TILE_WIDTH,
      frames: FRAMES_PER_SHEET,
    },
    generator_version: GENERATOR_VERSION,
  }
}

async function artefact(path, publicPath) {
  return { path: publicPath, bytes: (await stat(path)).size, sha256: await hashFile(path) }
}

async function ffmpeg(argv) {
  try {
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...argv], { maxBuffer: 1024 * 1024 * 32 })
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim().split('\n').slice(-4).join(' | ')
    throw new Error(`ffmpeg failed: ${detail}`)
  }
}

/**
 * Same discipline as the engineered fixtures: what we asked the encoder for is
 * `declared`, and what a probe independently reads back is `verified`. If they
 * disagree the build fails, because a manifest that quietly disagrees with its
 * own files is worse than no manifest.
 */
async function probeVideo(ffprobePath, file, declared) {
  if (!ffprobePath) return { ...declared, verified: false }

  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,nb_frames:format=duration',
    '-of', 'json',
    file,
  ])
  const parsed = JSON.parse(stdout)
  const stream = parsed.streams?.[0] ?? {}
  const read = {
    width: stream.width ?? null,
    height: stream.height ?? null,
    codec_video: stream.codec_name ?? null,
    duration_s: parsed.format?.duration ? Number(Number(parsed.format.duration).toFixed(2)) : null,
  }

  if (read.width !== declared.width || read.height !== declared.height) {
    throw new Error(
      `probe disagrees with the encode: asked for ${declared.width}x${declared.height}, file is ${read.width}x${read.height}`,
    )
  }
  if (read.duration_s !== null && Math.abs(read.duration_s - declared.duration_s) > 0.2) {
    throw new Error(`probe duration ${read.duration_s}s is outside tolerance of declared ${declared.duration_s}s`)
  }

  return { ...read, verified: true }
}

/**
 * ffmpeg-static ships no ffprobe, so ffprobe-static supplies it. If neither
 * resolves the build still completes using declared values, but the manifest
 * records that nothing verified them, because a fact nobody checked should not
 * look like a fact somebody did.
 */
async function findFfprobe() {
  if (ffprobeStatic?.path && existsSync(ffprobeStatic.path)) return ffprobeStatic.path
  const sibling = join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (existsSync(sibling)) return sibling
  process.stdout.write('  note: ffprobe not found, clip facts will be declared but unverified\n')
  return null
}

async function download(url, dest) {
  const response = await fetch(url, { headers: { 'user-agent': 'astolia-seed-builder/1' } })
  if (!response.ok) throw new Error(`download ${response.status} for ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength < 10_000) throw new Error(`suspiciously small download, ${buffer.byteLength} bytes`)
  await writeFile(dest, buffer)
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function writeCredits(entries) {
  const lines = [
    '# Media credits',
    '',
    'Every photograph in the seeded library comes from Pexels under the Pexels License:',
    'free to use including commercially, modification permitted, attribution not required.',
    'We record it anyway, because a product about usage rights should be able to say where its own media came from.',
    '',
    'License: https://www.pexels.com/license/',
    '',
    'The clips in `public/seed/clips` are derived from these stills by a synthetic pan and zoom, and the contact sheets are real frame extractions from those clips.',
    'The engineered fixtures in `public/fixtures` are separate: they are synthetic encodes built to exercise specific container and codec paths.',
    '',
    '| slug | source photo | page |',
    '|---|---|---|',
    ...entries.map((e) => `| ${e.slug} | ${e.source.photo_id} | ${e.source.page_url} |`),
    '',
  ]
  await writeFile(join(root, 'docs', 'MEDIA-CREDITS.md'), lines.join('\n'))
}

async function report(entries) {
  const sum = (fn) => entries.reduce((total, e) => total + (fn(e) ?? 0), 0)
  const posters = sum((e) => e.poster.bytes)
  const sheets = sum((e) => e.contact_sheet.bytes)
  const clips = sum((e) => (e.derived_clip.committed ? e.derived_clip.bytes : 0))
  process.stdout.write(
    [
      '',
      `items            ${entries.length}`,
      `posters          ${kb(posters)} (${kb(posters / entries.length)} each)`,
      `contact sheets   ${kb(sheets)} (${kb(sheets / entries.length)} each)`,
      `committed clips  ${entries.filter((e) => e.derived_clip.committed).length}, ${kb(clips)}`,
      `committed total  ${kb(posters + sheets + clips)}`,
      '',
    ].join('\n'),
  )
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(0)}KB`
}

function valueOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}

main().catch((error) => {
  process.stderr.write(`\nbuild-seed-media failed: ${error.message}\n`)
  process.exit(1)
})
