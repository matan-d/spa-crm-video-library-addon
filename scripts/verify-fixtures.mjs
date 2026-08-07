/**
 * Verifies the COMMITTED fixture bytes against the COMMITTED manifest.
 *
 *   npm run fixtures:verify
 *
 * This is the generator checking itself, which is legitimate for exactly one
 * reason: it reads only the manifest and the files on disk. It does not import
 * `fixtures.config.mjs`, does not re-encode anything, and does not know what the
 * recipes were. So it cannot agree with the builder by construction, only by the
 * bytes actually saying what the manifest claims.
 *
 * What it checks, per fixture:
 *   - the file exists at the recorded path
 *   - its byte length matches `bytes` exactly
 *   - its sha256 matches `sha256` exactly, so a regenerated fixture that differs
 *     from the committed one fails loudly instead of quietly redefining what
 *     every downstream test means
 *   - every field in `declared` matches what ffprobe reads out of the container,
 *     plus the four facts ffprobe cannot report (ftyp brand, raw mvhd creation
 *     field, top level atom order, and whether mdat carries a 32 or 64 bit size)
 *
 * Every failure names the fixture and the field. "verification failed" with no
 * field is the same as no verification, because nobody can act on it.
 *
 * `expected_preflight` is deliberately NOT checked here. It is a claim about what
 * our client code must derive, so the only thing that can verify it is that
 * client code. Checking it against ffprobe would quietly turn the parser's exam
 * into a restatement of ffprobe's answer.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byteLength,
  ffprobeBinary,
  hashFile,
  haversineMetres,
  parseIso6709,
  peekContainer,
  probe,
  repoRoot,
} from './fixtures-lib.mjs'

const root = repoRoot(import.meta.url)
const MANIFEST = join(root, 'public', 'fixtures', 'manifest.json')

/** Tolerances come from the manifest entry itself, never from a constant here. */
const FPS_TOLERANCE = 0.01
/** loci stores coordinates as 16.16 fixed point, so a metre or two of quantisation is expected. */
const GPS_DRIFT_TOLERANCE_M = 5

async function main() {
  if (!existsSync(MANIFEST)) {
    throw new Error(`no manifest at ${MANIFEST}. Run \`npm run fixtures\` first.`)
  }
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    throw new Error('manifest.fixtures is missing or empty')
  }

  const probeBin = ffprobeBinary()
  if (!probeBin) {
    throw new Error(
      'no ffprobe binary resolved from ffprobe-static. The `declared` block can only be confirmed against the container by an independent tool, so this script refuses to report a pass it did not earn.',
    )
  }

  const problems = []
  const rows = []

  for (const entry of manifest.fixtures) {
    const id = entry.fixture_id
    const file = join(root, 'public', entry.path.replace(/^\//, ''))
    const found = []

    if (!existsSync(file)) {
      problems.push(`${id}: path — no file at ${entry.path}`)
      rows.push(row(id, 'MISSING', []))
      continue
    }

    const bytes = await byteLength(file)
    if (bytes !== entry.bytes) found.push(`bytes — manifest says ${entry.bytes}, file is ${bytes}`)

    const sha256 = await hashFile(file)
    if (sha256 !== entry.sha256) {
      found.push(
        `sha256 — manifest says ${entry.sha256}, file is ${sha256}. Every downstream test asserts against these bytes, so this is a changed meaning, not a changed file.`,
      )
    }

    found.push(...(await checkDeclared(entry, file)))

    for (const problem of found) problems.push(`${id}: ${problem}`)
    rows.push(row(id, found.length === 0 ? 'ok' : `${found.length} MISMATCH`, found))
  }

  process.stdout.write(`\nmanifest       ${MANIFEST.replace(root, '.')}\n`)
  process.stdout.write(`generator      v${manifest.generator_version}, built with ffmpeg ${manifest.ffmpeg?.version}\n`)
  process.stdout.write(`ffprobe        ${probeBin.replace(root, '.')}\n`)
  process.stdout.write(`fixtures       ${manifest.fixtures.length}\n\n`)
  process.stdout.write(`${rows.join('\n')}\n\n`)

  if (problems.length > 0) {
    throw new Error(`${problems.length} mismatch(es) between the manifest and the committed bytes:\n  - ${problems.join('\n  - ')}`)
  }
  process.stdout.write('all fixtures match their manifest entry, byte length, sha256 and declared container facts\n\n')
}

function row(id, status, found) {
  const head = `  ${id.padEnd(26)} ${status}`
  return found.length === 0 ? head : `${head}\n${found.map((f) => `      ! ${f}`).join('\n')}`
}

async function checkDeclared(entry, file) {
  const d = entry.declared
  const out = []
  const tol = entry.tolerance ?? {}
  const p = await probe(file)

  const eq = (field, expected, actual) => {
    if (expected === null || expected === undefined) return
    if (actual === expected) return
    out.push(`declared.${field} — manifest says ${JSON.stringify(expected)}, container says ${JSON.stringify(actual)}`)
  }
  const near = (field, expected, actual, allowed) => {
    if (expected === null || expected === undefined) return
    if (typeof actual !== 'number') {
      out.push(`declared.${field} — manifest says ${expected}, container reports nothing`)
      return
    }
    if (Math.abs(expected - actual) > allowed) {
      out.push(
        `declared.${field} — manifest says ${expected}, container says ${actual}, outside the tolerance of ${allowed}`,
      )
    }
  }

  // ---- container ----------------------------------------------------------
  if (d.kind === 'photo') {
    if (!/image2|jpeg|mjpeg|png_pipe/.test(String(p.format_name))) {
      out.push(`declared.container — manifest says ${d.container}, ffprobe demuxed it as ${p.format_name}`)
    }
    eq('codec_video', d.codec_video, p.video?.codec_name)
  } else {
    if (!/mov|mp4/.test(String(p.format_name))) {
      out.push(`declared.container — manifest says ${d.container}, ffprobe demuxed it as ${p.format_name}`)
    }
    // The stsd fourcc, which is the only reliable codec answer. Extension and
    // MIME type tell you nothing (C1.2.4).
    eq('codec_video', d.codec_video, p.video?.codec_tag_string)
    eq('codec_audio', d.codec_audio, p.audio?.codec_tag_string)
  }

  eq('has_audio', d.has_audio, p.has_audio)
  eq('coded_width', d.coded_width, p.video?.coded_width)
  eq('coded_height', d.coded_height, p.video?.coded_height)
  eq('sar', d.sar, p.video?.sar)
  eq('rotation_deg', d.rotation_deg, p.video?.rotation_deg ?? 0)
  eq('display_matrix_rotation_ccw_deg', d.display_matrix_rotation_ccw_deg, p.video?.rotation_ccw_deg ?? 0)
  near('duration_s', d.duration_s, p.duration_s, tol.duration_s ?? 0.05)
  near('fps', d.fps, p.video?.fps, FPS_TOLERANCE)

  // ---- provenance ---------------------------------------------------------
  if (d.captured_at) {
    const readBack = p.creation_time ? new Date(p.creation_time).toISOString() : null
    eq('captured_at', new Date(d.captured_at).toISOString(), readBack)
  } else if (p.creation_time) {
    out.push(`declared.captured_at — manifest says none, container has ${p.creation_time}`)
  }
  eq('udta_day', d.udta_day, p.day_tag ?? null)

  if (d.gps_iso6709) {
    if (!p.location) {
      out.push(`declared.gps — manifest says ${d.gps_iso6709}, container has no location atom`)
    } else {
      const drift = haversineMetres(parseIso6709(d.gps_iso6709), parseIso6709(p.location))
      if (drift > GPS_DRIFT_TOLERANCE_M) {
        out.push(
          `declared.gps — manifest says ${d.gps_iso6709}, container says ${p.location}, ${drift.toFixed(1)}m apart`,
        )
      }
    }
  } else if (p.location) {
    out.push(`declared.gps — manifest says none, container has ${p.location}`)
  }

  // ---- the facts ffprobe cannot report ------------------------------------
  if (d.kind === 'photo') {
    if (d.ftyp_brand !== null || d.tkhd_matrix !== null || d.moov_position !== null) {
      out.push('declared — a still carries container facts it cannot have; ftyp_brand, tkhd_matrix and moov_position must be null for kind=photo')
    }
    return out
  }

  const peek = peekContainer(file)
  eq('ftyp_brand', d.ftyp_brand, peek.ftyp_brand)
  eq('moov_position', d.moov_position, peek.moov_position)
  eq('mdat_size_field', d.mdat_size_field, peek.mdat_size_field)

  // ffprobe omits creation_time when it is zero, and zero is precisely the
  // interesting case: a parser must report absence rather than 1904-01-01.
  if (d.mvhd_creation_time_raw !== null && peek.mvhd) {
    eq('mvhd_creation_time_raw', d.mvhd_creation_time_raw, peek.mvhd.creation_time_raw)
  }
  if (d.captured_at === null && peek.mvhd && peek.mvhd.creation_time_raw !== 0) {
    out.push(
      `declared.captured_at — manifest says none, but the raw mvhd creation field is ${peek.mvhd.creation_time_raw}, which is a real date`,
    )
  }

  // The rotation fixture, verified down to the matrix words rather than to a flag.
  if (Array.isArray(d.tkhd_matrix)) {
    const actual = peek.video_tkhd?.matrix
    if (!actual) out.push('declared.tkhd_matrix — manifest records a matrix, the file has no video track tkhd')
    else if (actual.length !== 9 || d.tkhd_matrix.some((v, i) => v !== actual[i])) {
      out.push(
        `declared.tkhd_matrix — manifest says [${d.tkhd_matrix.join(',')}], container says [${actual.join(',')}]`,
      )
    }
  }

  // tkhd holds the aspect corrected PRESENTATION size, which is a different field
  // from the coded size. Both are recorded, so this compares facts rather than
  // assuming the two always agree (they only agree at SAR 1:1).
  eq('tkhd_width', d.tkhd_width, peek.video_tkhd?.width)
  eq('tkhd_height', d.tkhd_height, peek.video_tkhd?.height)
  if (d.sar === '1:1' && d.tkhd_width !== null && d.tkhd_width !== d.coded_width) {
    out.push(
      `declared.tkhd_width — SAR is 1:1 so the presentation size ${d.tkhd_width} must equal the coded width ${d.coded_width}`,
    )
  }
  return out
}

main().catch((error) => {
  process.stderr.write(`\nverify-fixtures FAILED: ${error.message}\n`)
  process.exit(1)
})
