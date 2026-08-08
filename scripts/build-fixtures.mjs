/**
 * Builds the engineered media fixtures and their manifest.
 *
 *   npm run fixtures            build anything missing or changed, verify all
 *   npm run fixtures -- --force re-encode everything and report hash drift
 *   npm run fixtures -- --only rotated_90
 *
 * WHY THIS EXISTS BEFORE THE PARSER
 *
 * Nothing in the media pipeline should be written before there is something to
 * assert it against. A parser developed against files it also defines will agree
 * with itself about a rotation matrix it has misread. So the fixtures, their
 * ground truth, and the expected verdicts all land first, in a committed
 * manifest, and the parser is judged against literal numbers in a JSON file.
 *
 * THREE THINGS THIS SCRIPT REFUSES TO DO
 *
 * 1. Ship a file whose name claims something the bytes do not. Every `declared`
 *    fact is read back with ffprobe (an independent tool) and, for the facts
 *    ffprobe cannot report, with a narrow header peek. Any disagreement fails
 *    the build rather than being recorded as whatever value turned up.
 * 2. Assume a flag worked. `rotated_90` is verified down to the four tkhd matrix
 *    words, because `-display_rotation` silently doing nothing would produce the
 *    exact fixture that hides the bug it exists to catch.
 * 3. Invent a value it does not have. `expected_phash_prefix` stays null until
 *    the hasher exists.
 *
 * The generator runs on real wall clock time and real filesystem state, which is
 * why `scripts/**` is exempt from the determinism lint. The OUTPUT is what must
 * be reproducible, and `-fflags +bitexact` plus explicit metadata is how: ffmpeg
 * would otherwise stamp the build time into `mvhd` and change every sha256 on
 * every run.
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DUPLICATE_ASSUMPTION,
  FIXTURES,
  GENERATOR_VERSION,
  BRANCH,
  REASON_CODES,
  REFERENCE_RUNTIME,
  RULE_THRESHOLDS,
  TOLERANCE,
  VIDEO_DEFAULTS,
  VISIT_DATE,
  GPS_NEAR_BRANCH,
  GPS_NEAR_BRANCH_EXPECT_M,
  GPS_NEAR_BRANCH_ALT,
  GPS_NEAR_BRANCH_ALT_EXPECT_M,
  FRAME_COUNT,
  FRAME_TIME_SPACING,
  TIER_NAMES,
  assertFrameFormulaMatchesSource,
  frameCountFor,
  frameTimesFor,
  layoutFor,
} from './fixtures.config.mjs'
import {
  byteLength,
  displayDims,
  escapeFilterPath,
  escapeFilterText,
  ffmpegBinary,
  ffmpegVersion,
  ffprobeBinary,
  hashFile,
  haversineMetres,
  kb,
  orientationOf,
  parseIso6709,
  patchToLargesizeMdat,
  peekContainer,
  probe,
  repoRoot,
  resolveFont,
  runFfmpeg,
} from './fixtures-lib.mjs'

const root = repoRoot(import.meta.url)
const OUT_DIR = join(root, 'public', 'fixtures')
const WORK_DIR = join(root, '.cache', 'fixture-work')
const MANIFEST = join(OUT_DIR, 'manifest.json')

const args = process.argv.slice(2)
const force = args.includes('--force')
const acceptDrift = args.includes('--accept-drift')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

/** Only these three gate the original upload. See A.19 rule three. */
const BLOCKING_RULES = new Set(['orientation', 'min_duration', 'min_resolution'])
const RULE_ORDER = [
  'orientation',
  'min_duration',
  'min_resolution',
  'capture_date',
  'near_branch',
  'duplicate',
  'codec_playable',
]

const GPS_EXPECTATIONS = new Map([
  [GPS_NEAR_BRANCH, GPS_NEAR_BRANCH_EXPECT_M],
  [GPS_NEAR_BRANCH_ALT, GPS_NEAR_BRANCH_ALT_EXPECT_M],
])

async function main() {
  ffmpegBinary()
  // Before anything is encoded: the frame count formula this generator restates
  // must still match src/platform/capability.ts, which owns it.
  assertFrameFormulaMatchesSource()
  const ffprobeAvailable = Boolean(ffprobeBinary())
  const font = resolveFont()

  if (!ffprobeAvailable) {
    log('  note: no ffprobe binary resolved, declared facts will be recorded as UNVERIFIED')
  }

  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(WORK_DIR, { recursive: true })

  const previous = await readPreviousManifest()
  const selected = only ? FIXTURES.filter((f) => f.id === only) : FIXTURES
  if (selected.length === 0) throw new Error(`--only ${only} matched no fixture in fixtures.config.mjs`)

  const entries = []
  const built = []
  const skipped = []
  const failures = []

  for (const fixture of selected) {
    try {
      const plan = planFor(fixture, font)
      const outPath = join(OUT_DIR, fixture.file)
      const prior = previous?.fixtures?.find((e) => e.fixture_id === fixture.id)
      const reusable =
        !force &&
        existsSync(outPath) &&
        prior &&
        prior.generator_version === GENERATOR_VERSION &&
        JSON.stringify(prior.build_steps) === JSON.stringify(plan.steps) &&
        (await hashFile(outPath)) === prior.sha256

      if (!reusable) {
        await encode(fixture, plan, outPath)
        built.push(fixture.id)
      } else {
        skipped.push(fixture.id)
      }

      // Verification runs on every pass, reused or not, so a file edited by hand
      // between runs cannot survive a build.
      entries.push(await describe(fixture, plan, outPath, ffprobeAvailable))
    } catch (error) {
      failures.push(`${fixture.id}: ${error.message}`)
      log(`  FAIL ${fixture.id}: ${error.message}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${selected.length} fixtures failed:\n  - ${failures.join('\n  - ')}`)
  }

  if (only) {
    log(`\nbuilt --only ${only}, manifest NOT rewritten (it must describe the whole set)\n`)
    return
  }

  const drift = driftAgainst(previous, entries)
  const manifest = {
    manifest_version: 1,
    generator_version: GENERATOR_VERSION,
    generator: 'scripts/build-fixtures.mjs',
    spec: 'scripts/fixtures.config.mjs',
    built_at: new Date().toISOString(),
    ffmpeg: await toolVersion(),
    facts_verified: entries.every((e) => e.declared.facts_verified),
    reference_runtime: REFERENCE_RUNTIME,
    context: {
      visit_date: VISIT_DATE,
      branch: BRANCH,
      rule_thresholds: RULE_THRESHOLDS,
      reason_codes: Object.values(REASON_CODES).sort(),
      blocking_rules: [...BLOCKING_RULES],
      preflight_version: 2,
      // The frame count contract, recorded once here so no test hardcodes a bound.
      frame_count: {
        formula: FRAME_COUNT.formula,
        source: FRAME_COUNT.source,
        decision: FRAME_COUNT.decision,
        tiers: FRAME_COUNT.tiers,
        spacing: FRAME_TIME_SPACING,
        note: 'Capability sets the ceiling, duration sets the count within it. The verdict in expected_preflight is tier invariant; only expected_frames varies by tier.',
      },
    },
    duplicate_assumption: DUPLICATE_ASSUMPTION,
    notes: [
      '`declared` is what ffmpeg was instructed to produce and is ground truth by construction, then read back with ffprobe. A test asserting `declared` tests ffmpeg.',
      '`expected_preflight` is what our own client code must independently derive from the bytes. That is the only interesting assertion.',
      '`expected_phash_prefix` is null on every entry because no perceptual hasher exists yet. A value invented now would be asserted against forever.',
      'Statuses assume the runtime in `reference_runtime`. Rules whose answer moves with the runtime carry `runtime_dependent: true`, and platform-matrix owns that matrix.',
      '`expected_frames` is stated per tier, because capability sets the ceiling and duration sets the count within it (D2). The formula belongs to src/platform/capability.ts and is restated once in the generator with a build time check that fails if the two drift.',
      'Every status is one of pass, fail, unknown, skipped. `unknown` never blocks and is never rendered as a pass.',
    ],
    fixtures: entries,
  }
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

  report({ entries, built, skipped, drift, ffprobeAvailable })

  if (drift.length > 0 && !acceptDrift) {
    throw new Error(
      `${drift.length} committed fixture hash(es) changed:\n  - ${drift.join('\n  - ')}\n` +
        'Every downstream test asserts against these bytes, so a silent change would quietly redefine what those tests mean.\n' +
        'If the change is intended, bump GENERATOR_VERSION in scripts/fixtures.config.mjs and re-run with --accept-drift.',
    )
  }
}

// ---------------------------------------------------------------------------
// Planning: a recipe becomes an ordered list of ffmpeg argv arrays
// ---------------------------------------------------------------------------

function planFor(fixture, font) {
  const r = { ...VIDEO_DEFAULTS, ...fixture.recipe }
  const steps = []

  if (r.still) {
    steps.push({
      step: 'encode_still',
      argv: stillArgv(fixture, r, font),
    })
    return { recipe: r, steps }
  }

  if (r.reencode_of) {
    steps.push({
      step: 'reencode',
      argv: reencodeArgv(fixture, r),
    })
    return { recipe: r, steps }
  }

  steps.push({ step: 'encode', argv: encodeArgv(fixture, r, font) })

  if (r.rotation_ccw_deg) {
    steps.push({ step: 'set_display_matrix', argv: rotateArgv(fixture, r) })
  }
  if (r.post === 'largesize_mdat') {
    steps.push({ step: 'patch_bytes', argv: [], patch: 'largesize_mdat' })
  }
  return { recipe: r, steps }
}

/**
 * Content choice is a repo size decision, not an aesthetic one, because these
 * files are committed.
 *
 * `bars_moving_box` is SMPTE bars generated at a quarter size and upscaled, plus
 * one white box that travels across the frame, plus a burned in timecode. That
 * combination was picked deliberately over `testsrc2`:
 *
 * - bars are static after the first frame, so a 1080x1920 six second clip lands
 *   near 150KB instead of near 700KB
 * - hard vertical colour edges give a perceptual hash real structure to hash,
 *   where a smooth gradient would produce a near degenerate dHash and make the
 *   duplicate fixture vacuous
 * - the travelling box and the timecode make five sheet tiles visibly five
 *   different moments, which is what a human checks a contact sheet for
 */
function sourceFilter(recipe) {
  // For `pre_rotate` the label has to be drawn upright in DISPLAY orientation and
  // the pixels rotated afterwards, exactly as a phone does it, so the content is
  // generated at the display size rather than the coded size.
  const w = recipe.pre_rotate ? recipe.height : recipe.width
  const h = recipe.pre_rotate ? recipe.width : recipe.height
  const dur = recipe.duration_s
  const rate = recipe.fps
  const seed = 20260804

  switch (recipe.pattern) {
    case 'bars_moving_box': {
      const gw = even(Math.round(w / 4))
      const gh = even(Math.round(h / 4))
      const box = even(Math.round(Math.min(w, h) / 5))
      return {
        input: `smptebars=size=${gw}x${gh}:rate=${rate}:duration=${dur}`,
        pre: [
          `scale=${w}:${h}:flags=bilinear`,
          `drawbox=x='(w-${box})*mod(t/${dur}\\,1)':y=h*0.55:w=${box}:h=${box}:color=white@0.92:t=fill`,
        ],
      }
    }
    case 'testsrc2': {
      const gw = even(Math.round(w / 4))
      const gh = even(Math.round(h / 4))
      return {
        input: `testsrc2=size=${gw}x${gh}:rate=${rate}:duration=${dur}`,
        pre: [`scale=${w}:${h}:flags=neighbor`],
      }
    }
    case 'flat_log':
      return {
        input: `gradients=size=${w}x${h}:rate=${rate}:duration=${dur}:c0=0x3f4448:c1=0x6b7076:seed=${seed}:speed=0.03:type=linear`,
        // A log profile is flat and desaturated, which is also why ProRes of it
        // compresses far below its nominal bitrate and can be committed at all.
        pre: ['eq=contrast=0.55:brightness=0.06:saturation=0.35'],
      }
    case 'calm_warm':
      return {
        input: `gradients=size=${w}x${h}:rate=${rate}:duration=${dur}:c0=0xf7ddc6:c1=0xd39c74:seed=${seed}:speed=0.02:type=radial`,
        pre: [],
      }
    case 'calm_cool':
      return {
        input: `gradients=size=${w}x${h}:rate=${rate}:duration=${dur}:c0=0xd6e6ee:c1=0x8ba7b8:seed=${seed}:speed=0.02:type=radial`,
        pre: [],
      }
    case 'calm_green':
      return {
        input: `gradients=size=${w}x${h}:rate=${rate}:duration=${dur}:c0=0xdde8d4:c1=0x8ea988:seed=${seed}:speed=0.015:type=circular`,
        pre: [],
      }
    default:
      throw new Error(`unknown pattern: ${recipe.pattern}`)
  }
}

function even(n) {
  return n % 2 === 0 ? n : n + 1
}

/**
 * The burned in label. A reviewer watching the demo must be able to name the
 * fixture on screen, and a contact sheet tile with a visible timecode is how a
 * human checks that five tiles are five different moments rather than the same
 * frame five times.
 */
function labelFilters(fixture, recipe, font) {
  const shortEdge = Math.min(recipe.width, recipe.height)
  const title = Math.max(18, Math.round(shortEdge / 14))
  const small = Math.max(12, Math.round(shortEdge / 30))
  const f = escapeFilterPath(font)
  const common = `fontfile=${f}:box=1:boxcolor=black@0.55:boxborderw=${Math.round(title / 5)}:fontcolor=white`

  const spec = [
    `${recipe.width}x${recipe.height}`,
    recipe.video_codec_tag,
    recipe.audio ? `+${recipe.audio.tag}` : 'no-audio',
    `${recipe.duration_s}s`,
    `rot${recipe.rotation_ccw_deg ? Math.abs(recipe.rotation_ccw_deg) : 0}`,
  ].join(' ')

  return [
    `drawtext=${common}:fontsize=${title}:text='${escapeFilterText(fixture.id)}':x=(w-text_w)/2:y=h*0.06`,
    `drawtext=${common}:fontsize=${small}:text='${escapeFilterText(spec)}':x=(w-text_w)/2:y=h*0.06+${Math.round(title * 1.7)}`,
    ...(recipe.still
      ? []
      : [`drawtext=${common}:fontsize=${Math.round(small * 1.3)}:text='%{pts\\:hms}':x=(w-text_w)/2:y=h-text_h-h*0.06`]),
  ]
}

function metadataArgs(recipe) {
  const out = ['-map_metadata', '-1']
  if (recipe.creation_time) out.push('-metadata', `creation_time=${recipe.creation_time}`)
  if (recipe.location) out.push('-metadata', `location=${recipe.location}`)
  if (recipe.day_tag) out.push('-metadata', `date=${recipe.day_tag}`)
  return out
}

function containerArgs(recipe) {
  const out = ['-f', recipe.container]
  if (recipe.faststart) out.push('-movflags', '+faststart')
  return out
}

function videoCodecArgs(recipe) {
  if (recipe.encoder === 'prores_ks') {
    return [
      '-c:v', 'prores_ks',
      '-profile:v', String(recipe.prores_profile),
      '-vendor', 'apl0',
      '-pix_fmt', recipe.pix_fmt,
      '-threads', '1',
    ]
  }
  if (recipe.encoder === 'libx265') {
    return [
      '-c:v', 'libx265',
      '-preset', 'medium',
      '-crf', String(recipe.crf),
      '-x265-params', 'log-level=none:info=0',
      '-g', String(recipe.gop_frames),
      '-pix_fmt', recipe.pix_fmt,
      '-tag:v', recipe.video_codec_tag,
      '-threads', '1',
    ]
  }
  return [
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', String(recipe.crf),
    '-g', String(recipe.gop_frames),
    '-keyint_min', String(recipe.gop_frames),
    '-sc_threshold', '0',
    '-pix_fmt', recipe.pix_fmt,
    '-threads', '1',
  ]
}

function audioArgs(recipe) {
  if (!recipe.audio) return ['-an']
  return ['-c:a', recipe.audio.encoder, '-b:a', recipe.audio.bitrate, '-ac', '1']
}

function encodeArgv(fixture, recipe, font) {
  const src = sourceFilter(recipe)
  const chain = [...src.pre, ...labelFilters(fixture, recipe, font)]
  if (recipe.pre_rotate === 'ccw90') chain.push('transpose=2')
  // `setsar=1` is load bearing, and finding out why cost a build failure worth
  // keeping. `scale` preserves the DISPLAY aspect ratio by adjusting the sample
  // aspect ratio, so scaling a 120x214 pattern up to 480x854 left SAR at
  // 1.00234, and ffmpeg then wrote 478.88x854 into `tkhd` because tkhd holds the
  // aspect corrected PRESENTATION size, not the coded size. Every fixture is
  // pinned to square pixels so coded and display dimensions coincide and a
  // failing orientation test means the rotation matrix was misread rather than
  // the pixel aspect ratio. The non-square-pixel case is a named gap in
  // docs/media-pipeline.md.
  chain.push('setsar=1')
  chain.push(`format=${recipe.pix_fmt}`)

  const argv = ['-y', '-f', 'lavfi', '-i', src.input]
  if (recipe.audio) {
    argv.push(
      '-f', 'lavfi',
      '-i', `sine=frequency=${recipe.audio.tone_hz}:beep_factor=4:sample_rate=48000:duration=${recipe.duration_s}`,
    )
  }
  argv.push(
    '-vf', chain.join(','),
    '-t', String(recipe.duration_s),
    ...videoCodecArgs(recipe),
    ...audioArgs(recipe),
    // Output side bitexact: without it ffmpeg writes the build instant into mvhd
    // and every committed sha256 changes on every run.
    '-fflags', '+bitexact',
    '-flags', '+bitexact',
    ...metadataArgs(recipe),
    ...containerArgs(recipe),
  )
  return argv
}

/**
 * The rotation is applied as a container remux with `-c copy`, so the coded
 * frames are byte identical to the unrotated encode and the ONLY difference is
 * the tkhd display matrix. If a parser gets this fixture wrong, it is the matrix
 * it got wrong and nothing else.
 */
function rotateArgv(fixture, recipe) {
  return [
    '-y',
    '-noautorotate',
    '-display_rotation', String(recipe.rotation_ccw_deg),
    '-i', 'STEP_INPUT',
    '-map', '0',
    '-c', 'copy',
    '-fflags', '+bitexact',
    ...metadataArgs(recipe),
    ...containerArgs(recipe),
  ]
}

function reencodeArgv(fixture, recipe) {
  return [
    '-y',
    '-i', 'STEP_INPUT',
    ...videoCodecArgs(recipe),
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1',
    '-fflags', '+bitexact',
    '-flags', '+bitexact',
    ...metadataArgs(recipe),
    ...containerArgs(recipe),
  ]
}

function stillArgv(fixture, recipe, font) {
  const src = sourceFilter({ ...recipe, pattern: recipe.pattern ?? 'calm_warm', fps: 1, duration_s: 1 })
  return [
    '-y',
    '-f', 'lavfi',
    '-i', src.input,
    '-frames:v', '1',
    '-vf', [...src.pre, ...labelFilters(fixture, recipe, font)].join(','),
    '-q:v', '4',
    '-fflags', '+bitexact',
    '-flags', '+bitexact',
    '-update', '1',
    '-f', 'image2',
  ]
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

async function encode(fixture, plan, outPath) {
  const work = []
  let current = null

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]
    const isLast = i === plan.steps.length - 1
    const target = isLast ? join(WORK_DIR, `${fixture.id}.final`) : join(WORK_DIR, `${fixture.id}.s${i}`)

    if (step.patch === 'largesize_mdat') {
      await copyFile(current, target)
      patchToLargesizeMdat(target)
    } else {
      const source = step.argv.includes('STEP_INPUT')
        ? plan.recipe.reencode_of
          ? join(OUT_DIR, FIXTURES.find((f) => f.id === plan.recipe.reencode_of).file)
          : current
        : null
      if (step.argv.includes('STEP_INPUT') && !source) {
        throw new Error(`step ${step.step} needs an input and none was produced`)
      }
      const argv = step.argv.map((a) => (a === 'STEP_INPUT' ? source : a)).concat([target])
      const warnings = await runFfmpeg(argv)
      if (warnings) log(`  note ${fixture.id} (${step.step}): ${warnings.split('\n')[0]}`)
    }
    work.push(target)
    current = target
  }

  await copyFile(current, outPath)
  for (const file of work) await rm(file, { force: true })
}

// ---------------------------------------------------------------------------
// Verification and the manifest entry
// ---------------------------------------------------------------------------

async function describe(fixture, plan, outPath, _ffprobeAvailable) {
  const recipe = plan.recipe
  const bytes = await byteLength(outPath)
  const sha256 = await hashFile(outPath)
  const p = await probe(outPath)
  const peek = fixture.kind === 'photo' ? null : peekContainer(outPath)

  // ---- read back and refuse to disagree -----------------------------------
  const declared = {
    kind: fixture.kind,
    container: recipe.still ? 'jpeg' : recipe.container,
    ftyp_brand: peek?.ftyp_brand ?? null,
    codec_video: recipe.still ? 'mjpeg' : recipe.video_codec_tag,
    codec_audio: recipe.audio ? recipe.audio.tag : null,
    has_audio: Boolean(recipe.audio),
    coded_width: recipe.width,
    coded_height: recipe.height,
    // Square pixels on every fixture, so coded and presentation size coincide.
    sar: recipe.still ? null : '1:1',
    // tkhd is the aspect corrected presentation size, which is a different field
    // from the coded size even though they agree here. Recorded separately so the
    // verifier checks a fact rather than an assumption.
    tkhd_width: peek?.video_tkhd?.width ?? null,
    tkhd_height: peek?.video_tkhd?.height ?? null,
    rotation_deg: recipe.rotation_ccw_deg ? normalizeCw(-recipe.rotation_ccw_deg) : 0,
    display_matrix_rotation_ccw_deg: recipe.rotation_ccw_deg || 0,
    tkhd_matrix: peek?.video_tkhd?.matrix ?? null,
    duration_s: recipe.still ? null : recipe.duration_s,
    fps: recipe.still ? null : recipe.fps,
    gop_frames: recipe.still ? null : recipe.gop_frames,
    captured_at: recipe.creation_time ?? null,
    captured_at_atom: recipe.creation_time ? (recipe.day_tag ? 'mvhd+udta_day' : 'mvhd') : null,
    mvhd_creation_time_raw: peek?.mvhd?.creation_time_raw ?? null,
    udta_day: recipe.day_tag ?? null,
    gps: recipe.location ? parseIso6709(recipe.location) : null,
    gps_atom: recipe.location ? recipe.location_atom : null,
    gps_iso6709: recipe.location ?? null,
    moov_position: peek?.moov_position ?? null,
    mdat_size_field: peek?.mdat_size_field ?? null,
    bytes,
    facts_verified: false,
  }

  const disagreements = []
  const cmp = (label, asked, read, tol = 0) => {
    if (read == null) return
    if (typeof asked === 'number' && typeof read === 'number') {
      if (Math.abs(asked - read) > tol) disagreements.push(`${label}: asked ${asked}, file says ${read}`)
    } else if (asked !== read) {
      disagreements.push(`${label}: asked ${JSON.stringify(asked)}, file says ${JSON.stringify(read)}`)
    }
  }

  if (p.available) {
    cmp('coded_width', declared.coded_width, p.video?.coded_width)
    cmp('coded_height', declared.coded_height, p.video?.coded_height)
    // A still has no `stsd`, so the fourcc is meaningless there and the codec
    // name is the only honest comparison.
    if (fixture.kind === 'photo') cmp('codec_video (codec name)', declared.codec_video, p.video?.codec_name)
    else cmp('codec_video (stsd fourcc)', declared.codec_video, p.video?.codec_tag_string)
    cmp('rotation_deg', declared.rotation_deg, p.video?.rotation_deg)
    cmp('has_audio', declared.has_audio, p.has_audio)
    if (declared.codec_audio) cmp('codec_audio', declared.codec_audio, p.audio?.codec_tag_string)
    if (declared.duration_s != null) cmp('duration_s', declared.duration_s, p.duration_s, TOLERANCE.duration_s)
    if (declared.fps != null) cmp('fps', declared.fps, p.video?.fps, 0.01)
    if (declared.captured_at) {
      const readIso = p.creation_time ? new Date(p.creation_time).toISOString() : null
      cmp('captured_at', new Date(declared.captured_at).toISOString(), readIso)
    } else if (p.creation_time) {
      disagreements.push(`captured_at: asked for none, file says ${p.creation_time}`)
    }
    if (declared.gps_iso6709) {
      if (!p.location) disagreements.push('gps: asked for a location atom, file has none')
      else {
        const read = parseIso6709(p.location)
        const asked = parseIso6709(declared.gps_iso6709)
        // loci is 16.16 fixed point, so a couple of metres of quantisation is expected.
        const drift = haversineMetres(asked, read)
        if (drift > 5) disagreements.push(`gps: asked ${declared.gps_iso6709}, file reads ${p.location} (${drift.toFixed(1)}m away)`)
      }
    } else if (p.location) {
      disagreements.push(`gps: asked for none, file has ${p.location}`)
    }
    if (declared.udta_day) cmp('udta_day', declared.udta_day, p.day_tag)
    if (declared.sar) cmp('sar', declared.sar, p.video?.sar)
  }

  // Facts ffprobe cannot report, checked against the bytes directly.
  if (peek) {
    if (!declared.captured_at && peek.mvhd && peek.mvhd.creation_time_raw !== 0) {
      disagreements.push(`mvhd creation_time: asked for none, raw field is ${peek.mvhd.creation_time_raw}`)
    }
    if (recipe.post === 'largesize_mdat' && peek.mdat_size_field !== '64bit_largesize') {
      disagreements.push(`mdat size field: asked for 64bit_largesize, file says ${peek.mdat_size_field}`)
    }
    if (recipe.faststart && peek.moov_position !== 'start') {
      disagreements.push(`moov position: faststart requested, moov is at the ${peek.moov_position}`)
    }
    // The whole point of rotated_90: verify the matrix words, not the flag.
    if (declared.rotation_deg !== 0) {
      const abcd = peek.video_tkhd?.abcd
      const want = declared.rotation_deg === 90 ? [0, 1, -1, 0] : null
      if (!want) disagreements.push(`no expected matrix defined for rotation ${declared.rotation_deg}`)
      else if (!abcd || abcd.some((v, i) => v !== want[i])) {
        disagreements.push(
          `tkhd matrix: expected a,b,c,d = ${want.join(',')} for a ${declared.rotation_deg} degree clockwise display rotation, file has ${abcd ? abcd.join(',') : 'no video tkhd'}`,
        )
      }
    }
    // With SAR pinned to 1:1 the presentation size in tkhd must equal the coded
    // size. If it does not, the pixel aspect ratio leaked back in and every
    // orientation assertion in the set becomes ambiguous.
    if (peek.video_tkhd && (peek.video_tkhd.width !== declared.coded_width || peek.video_tkhd.height !== declared.coded_height)) {
      disagreements.push(
        `tkhd presentation size ${peek.video_tkhd.width}x${peek.video_tkhd.height} differs from the coded ${declared.coded_width}x${declared.coded_height}, so the sample aspect ratio is not 1:1`,
      )
    }
  }

  if (disagreements.length > 0) {
    throw new Error(`the file disagrees with its declaration:\n      - ${disagreements.join('\n      - ')}`)
  }
  declared.facts_verified = p.available && (fixture.kind === 'photo' || Boolean(peek))

  // ---- derived display facts, and the expected verdict --------------------
  const codedW = p.available ? p.video.coded_width : recipe.width
  const codedH = p.available ? p.video.coded_height : recipe.height
  const display = displayDims(codedW, codedH, declared.rotation_deg)
  const orientation = orientationOf(display.width, display.height)
  const measuredDuration = p.available && p.duration_s != null ? Number(p.duration_s.toFixed(3)) : recipe.duration_s

  // Hand authored expectations are cross checked against the bytes here, because
  // a hand authored expectation is the point and a wrong one is invisible.
  assertConsistent(fixture, { orientation, display, measuredDuration, declared })

  const rules = buildRules(fixture, {
    orientation,
    display,
    measuredDuration,
    declared,
    codec: declared.codec_video,
  })

  return {
    fixture_id: fixture.id,
    path: `/fixtures/${fixture.file}`,
    group: fixture.group,
    kind: fixture.kind,
    proves: fixture.proves,
    added_beyond_c2d: fixture.added_beyond_c2d,
    bytes,
    sha256,
    generator_version: GENERATOR_VERSION,
    ffmpeg_args: plan.steps.filter((s) => s.argv.length > 0).at(-1).argv,
    build_steps: plan.steps,
    declared,
    expected_preflight: {
      version: 2,
      // The verdict is tier invariant: no rule reads the ingest policy. Only the
      // frame count does, which is why expected_frames is per tier and this is null.
      policy_tier: null,
      policy_tier_note: 'Every rule verdict here holds at every ingest policy tier. Only expected_frames varies by tier.',
      producer: 'browser',
      reference_runtime: REFERENCE_RUNTIME.id,
      rules,
      rollup: rollupOf(rules),
    },
    expected_frames: expectedFrames(fixture, measuredDuration),
    expected_derivatives: fixture.derivatives ?? {
      contact_sheet: true,
      poster: true,
      derivative_state: 'client_derived',
      derivative_producer: 'browser',
      reason: null,
      guarantee: 'A real sheet extracted from real frames, or none. Never a fabricated tile presented as a frame.',
    },
    expected_phash_prefix: null,
    expected_phash_note: 'null until the perceptual hasher exists. An invented prefix would be asserted against forever.',
    tolerance: { ...TOLERANCE },
  }
}

function normalizeCw(deg) {
  return ((Math.round(deg) % 360) + 360) % 360
}

function assertConsistent(fixture, { orientation, display, measuredDuration, declared }) {
  const problems = []
  const rules = fixture.rules

  const wantVertical = rules.orientation.status === 'pass'
  if (wantVertical !== (orientation === 'vertical')) {
    problems.push(
      `orientation is hand authored as ${rules.orientation.status} but the bytes display as ${orientation} (${display.width}x${display.height})`,
    )
  }
  if (rules.min_duration.status === 'pass' && measuredDuration != null && measuredDuration < RULE_THRESHOLDS.min_duration_s) {
    problems.push(`min_duration is hand authored as pass but the file is ${measuredDuration}s`)
  }
  if (rules.min_duration.status === 'fail' && measuredDuration != null && measuredDuration >= RULE_THRESHOLDS.min_duration_s) {
    problems.push(`min_duration is hand authored as fail but the file is ${measuredDuration}s`)
  }
  const short = Math.min(display.width, display.height)
  const long = Math.max(display.width, display.height)
  const bigEnough = short >= RULE_THRESHOLDS.min_short_edge_px && long >= RULE_THRESHOLDS.min_long_edge_px
  if ((rules.min_resolution.status === 'pass') !== bigEnough && rules.min_resolution.status !== 'skipped') {
    problems.push(
      `min_resolution is hand authored as ${rules.min_resolution.status} but the display size is ${display.width}x${display.height}`,
    )
  }
  const hasGps = Boolean(declared.gps)
  if (hasGps !== (rules.near_branch.status !== 'unknown')) {
    problems.push(
      `near_branch is hand authored as ${rules.near_branch.status} but the file ${hasGps ? 'has' : 'has no'} location atom`,
    )
  }
  if (problems.length > 0) {
    throw new Error(`hand authored expectation disagrees with the bytes:\n      - ${problems.join('\n      - ')}`)
  }
}

function buildRules(fixture, ctx) {
  const out = {}
  for (const name of RULE_ORDER) {
    const authored = fixture.rules[name]
    if (!authored) throw new Error(`fixture ${fixture.id} has no expectation for rule ${name}`)
    const rule = { ...authored }

    // Every rule carries whether it can gate the upload, because "unknown never
    // blocks" is only checkable if blocking is written down per rule.
    rule.blocking = BLOCKING_RULES.has(name) && rule.status === 'fail'
    if (rule.status === 'unknown' || rule.status === 'skipped') {
      if (!rule.reason) throw new Error(`fixture ${fixture.id} rule ${name} is ${rule.status} with no reason`)
      rule.blocking = false
    }

    switch (name) {
      case 'orientation':
        rule.value = ctx.orientation
        rule.required = RULE_THRESHOLDS.required_orientation
        rule.coded = `${ctx.declared.coded_width}x${ctx.declared.coded_height}`
        rule.display = `${ctx.display.width}x${ctx.display.height}`
        rule.rotation_deg = ctx.declared.rotation_deg
        break
      case 'min_duration':
        if (rule.status !== 'skipped') {
          rule.value = ctx.measuredDuration
          rule.required = RULE_THRESHOLDS.min_duration_s
        }
        break
      case 'min_resolution':
        rule.value = `${ctx.display.width}x${ctx.display.height}`
        rule.required = `short edge >= ${RULE_THRESHOLDS.min_short_edge_px}, long edge >= ${RULE_THRESHOLDS.min_long_edge_px}`
        break
      case 'capture_date':
        rule.value = ctx.declared.captured_at ?? null
        rule.visit_date = VISIT_DATE
        rule.window_hours = RULE_THRESHOLDS.visit_window_hours
        if (rule.status !== 'unknown' && rule.status !== 'skipped') {
          rule.mvhd_creation_time_raw = ctx.declared.mvhd_creation_time_raw
        }
        break
      case 'near_branch':
        if (ctx.declared.gps) {
          const distance = haversineMetres(BRANCH, ctx.declared.gps)
          const expected = GPS_EXPECTATIONS.get(ctx.declared.gps_iso6709)
          if (expected != null && Math.abs(distance - expected) > 5) {
            throw new Error(
              `fixture ${fixture.id}: GPS ${ctx.declared.gps_iso6709} is ${distance.toFixed(1)}m from the branch, the spec says about ${expected}m. One of the two is a typo.`,
            )
          }
          rule.value = ctx.declared.gps
          rule.distance_m = Math.round(distance)
          rule.radius_m = RULE_THRESHOLDS.near_branch_radius_m
          rule.gps_atom = ctx.declared.gps_atom
        } else {
          rule.value = null
          rule.distance_m = null
          rule.radius_m = RULE_THRESHOLDS.near_branch_radius_m
        }
        rule.never_blocking = true
        break
      case 'duplicate':
        rule.comparison_set = DUPLICATE_ASSUMPTION.comparison_set
        break
      case 'codec_playable':
        rule.value = ctx.codec
        break
      default:
        break
    }
    out[name] = rule
  }
  return out
}

function rollupOf(rules) {
  const counts = { pass: 0, fail: 0, unknown: 0, skipped: 0, blocking_fail: 0 }
  for (const rule of Object.values(rules)) {
    counts[rule.status] += 1
    if (rule.blocking) counts.blocking_fail += 1
  }
  return counts
}

/**
 * The per tier frame plan.
 *
 * Per tier rather than a single number, because a test that asserts extraction at a
 * given tier needs the expected count FOR that tier, and the whole point of D2 is
 * that the tier changes the answer. `layout` is carried alongside the count so the
 * sheet layout enum is asserted from data rather than re-derived in a test.
 */
function expectedFrames(fixture, durationSeconds) {
  const flat = (count, layout) =>
    Object.fromEntries(TIER_NAMES.map((tier) => [tier, { count, layout, t_seconds: [] }]))

  if (fixture.kind === 'photo') {
    return {
      by_tier: flat(1, null),
      formula: 'a still is its own single frame, so neither the duration term nor the tier applies',
      formula_source: FRAME_COUNT.source,
      approximate: false,
      reason: null,
    }
  }
  if (fixture.derivatives && fixture.derivatives.contact_sheet === false) {
    return {
      by_tier: flat(0, null),
      formula: null,
      formula_source: FRAME_COUNT.source,
      approximate: false,
      reason: fixture.derivatives.reason,
      note: 'Extraction is NOT attempted. A try-and-catch into a black frame is worse than no frame, because a black frame gets tagged.',
    }
  }

  const measured = Number(durationSeconds.toFixed(3))
  const byTier = {}
  for (const tier of TIER_NAMES) {
    const count = frameCountFor(measured, tier)
    byTier[tier] = { count, layout: layoutFor(count), t_seconds: frameTimesFor(measured, count) }
  }
  return {
    by_tier: byTier,
    formula: FRAME_COUNT.formula,
    formula_source: FRAME_COUNT.source,
    decision: FRAME_COUNT.decision,
    spacing: FRAME_TIME_SPACING,
    approximate: true,
    reason:
      'The `<video>` plus canvas path snaps to the preceding keyframe, so t_seconds is a target rather than a guarantee. GOP is half a second, which is what bounds tolerance.frame_t_seconds.',
  }
}

// ---------------------------------------------------------------------------
// Drift, reporting, plumbing
// ---------------------------------------------------------------------------

async function readPreviousManifest() {
  if (!existsSync(MANIFEST)) return null
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'))
  } catch {
    log('  note: existing manifest.json is unreadable, treating this as a first build')
    return null
  }
}

function driftAgainst(previous, entries) {
  if (!previous?.fixtures) return []
  const out = []
  for (const entry of entries) {
    const prior = previous.fixtures.find((e) => e.fixture_id === entry.fixture_id)
    if (!prior) continue
    if (prior.sha256 !== entry.sha256) {
      out.push(
        `${entry.fixture_id}: ${prior.sha256.slice(0, 12)} -> ${entry.sha256.slice(0, 12)} (${prior.bytes} -> ${entry.bytes} bytes)`,
      )
    }
  }
  return out
}

async function toolVersion() {
  return {
    binary: 'ffmpeg-static',
    version: await ffmpegVersion(),
    ffprobe: ffprobeBinary() ? 'ffprobe-static' : null,
    note: 'Fixtures are generated locally and committed, never generated in CI: two ffmpeg builds do not produce byte identical output, which would break the reproducibility the hashes exist to guarantee.',
  }
}

function report({ entries, built, skipped, drift, ffprobeAvailable }) {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0)
  const engineered = entries.filter((e) => e.group === 'engineered')
  const statuses = { pass: 0, fail: 0, unknown: 0, skipped: 0 }
  for (const e of engineered) for (const k of Object.keys(statuses)) statuses[k] += e.expected_preflight.rollup[k]

  const rows = entries.map((e) => {
    const r = e.expected_preflight.rollup
    return `  ${e.fixture_id.padEnd(26)} ${kb(e.bytes).padStart(7)}  ${e.declared.facts_verified ? 'verified' : 'UNVERIFIED'}  ${r.pass}P ${r.fail}F ${r.unknown}U ${r.skipped}S  ${e.sha256.slice(0, 12)}`
  })

  log('')
  log(`fixtures       ${entries.length} (${engineered.length} engineered, ${entries.length - engineered.length} preview)`)
  log(`encoded now    ${built.length}${built.length ? `: ${built.join(', ')}` : ''}`)
  log(`unchanged      ${skipped.length}${skipped.length ? `: ${skipped.join(', ')}` : ''}`)
  log(`committed      ${kb(total)} total`)
  log(`declared facts ${ffprobeAvailable ? 'read back with ffprobe and a header peek, build fails on disagreement' : 'NOT VERIFIED, no ffprobe binary'}`)
  log(`rule statuses  ${statuses.pass} pass, ${statuses.fail} fail, ${statuses.unknown} unknown, ${statuses.skipped} skipped (engineered only)`)
  log(`frame counts   ${FRAME_COUNT.formula}, checked against ${FRAME_COUNT.source}`)
  log(
    `               per tier: ${entries
      .filter((e) => e.kind === 'video' && e.expected_frames.by_tier.ample.count > 0)
      .map((e) => `${e.fixture_id} ${TIER_NAMES.map((t) => e.expected_frames.by_tier[t].count).join('/')}`)
      .join(', ')} (constrained/standard/ample)`,
  )
  log(`no sheet       ${entries.filter((e) => e.expected_derivatives.contact_sheet === false).map((e) => e.fixture_id).join(', ') || 'none'}`)
  log(`hash drift     ${drift.length === 0 ? 'none' : `${drift.length} CHANGED`}`)
  for (const line of drift) log(`  ! ${line}`)
  log('')
  log(rows.join('\n'))
  log('')
  log(`manifest       ${MANIFEST.replace(root, '.')}`)
  log('')
}

function log(line) {
  process.stdout.write(`${line}\n`)
}

main().catch((error) => {
  process.stderr.write(`\nbuild-fixtures failed: ${error.message}\n`)
  process.exit(1)
})
