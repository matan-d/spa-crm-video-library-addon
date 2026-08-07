/**
 * The engineered fixture set: the spec that `scripts/build-fixtures.mjs` builds
 * and `scripts/verify-fixtures.mjs` checks the committed bytes against.
 *
 * This file is the specification. The builder is only the mechanism.
 *
 * THE DISTINCTION THAT CARRIES THE WEIGHT
 *
 * `declared` is what ffmpeg was instructed to produce, so it is ground truth by
 * construction, and the builder additionally reads it back with ffprobe and
 * fails the build if the two disagree. A test that asserts `declared` is testing
 * ffmpeg, which is not interesting.
 *
 * `expected_preflight` is what our own client code must independently derive
 * from the bytes, later, with no help from this file. That is the only
 * interesting assertion, and it is why the statuses and reason codes below are
 * hand authored rather than computed: a machine that derives the expectation the
 * same way the parser will derive the answer proves nothing.
 *
 * The measured values inside `expected_preflight` (a duration in seconds, a
 * distance in metres) ARE filled in by the builder from the probe, because those
 * are facts about the bytes rather than judgements about them, and hand copying
 * a duration out of a probe log is how a manifest starts lying.
 *
 * WHAT IS NOT DERIVABLE FROM THE BYTES, STATED ONCE
 *
 * `codec_playable` is not a pure function of the container. It is the `stsd`
 * fourcc (bytes, ours) plus `VideoDecoder.isConfigSupported` (runtime, not
 * ours). Every status below is stated for one named reference runtime, recorded
 * in the manifest, and the rules whose answer moves with the runtime carry
 * `runtime_dependent: true`. The per runtime matrix belongs to
 * `platform-matrix`, not here.
 */

/** Bumped whenever a recipe changes, because every committed hash depends on it. */
export const GENERATOR_VERSION = 1

/**
 * The visit day the whole fixture set is written against.
 * Matches the `captured_at` in docs/01-architecture-review.md C2.D.
 */
export const VISIT_DATE = '2026-08-04'

/** Inside the visit day. The happy path capture instant. */
export const CAPTURED_AT = '2026-08-04T10:12:00Z'

/** Two days before the visit. The only `capture_date: fail` evidence in the set. */
export const CAPTURED_AT_OFF_DATE = '2026-08-02T09:40:00Z'

/**
 * The same instant as CAPTURED_AT expressed with an explicit offset, written to
 * `udta/©day` on the MOV fixture. QuickTime `©day` is the one place in these
 * containers where a timezone actually survives, which is why one fixture
 * carries it: mvhd is defined as UTC and cameras write local time into it
 * anyway (docs/02-caveats-review.md C5.2.3).
 */
export const CAPTURED_AT_WITH_OFFSET = '2026-08-04T03:12:00-0700'

/** San Jose, from docs/01-architecture-review.md C2.D. */
export const BRANCH = {
  branch_id: 'san-jose',
  lat: 37.3382,
  lng: -121.8863,
}

/**
 * `near_branch` needs a radius and no existing document sets one. 500m is wide
 * enough for a multi building wellness site plus consumer GPS error and narrow
 * enough that "8km from the branch" still fails. Recorded here, and flagged in
 * docs/media-pipeline.md as a threshold the branch or brief schema needs a
 * column for rather than a constant living in a fixture generator.
 */
export const NEAR_BRANCH_RADIUS_M = 500

/**
 * Preflight thresholds, from the `brief_item` defaults in
 * docs/01-architecture-review.md (`min_duration_s` 3, `min_width` 1080,
 * `min_height` 1920).
 *
 * `min_resolution` is evaluated orientation neutrally: the short display edge
 * against min_width and the long display edge against min_height. Without that,
 * a landscape 1920x1080 clip would fail both `orientation` and `min_resolution`
 * from a single defect, and a fixture that trips two rules cannot tell you which
 * rule is broken.
 */
export const RULE_THRESHOLDS = {
  required_orientation: 'vertical',
  min_duration_s: 3,
  min_short_edge_px: 1080,
  min_long_edge_px: 1920,
  visit_window_hours: 24,
  near_branch_radius_m: NEAR_BRANCH_RADIUS_M,
}

/**
 * The runtime every committed `status` below assumes.
 * This is the reviewer's machine, and it is the runtime in which the open hole
 * in E.4b is live rather than hypothetical.
 */
export const REFERENCE_RUNTIME = {
  id: 'chromium_desktop_windows_without_hevc_extension',
  decodes: ['avc1'],
  refuses: ['hvc1', 'hev1', 'apcn', 'apco'],
  note:
    'Chromium ships no software HEVC decoder, so HEVC is hardware only and absent on a machine with no HEVC Video Extension. No browser decodes ProRes at all. Where a status moves with the runtime the rule carries runtime_dependent: true and platform-matrix owns the matrix.',
}

/**
 * ISO 6709 strings. `+lat-lng+alt/`, which is the form Apple writes.
 *
 * NEAR is about 120m north of the branch, deliberately not 0m, so a wrong or
 * absent great circle calculation shows up as a number rather than passing by
 * accident.
 */
export const GPS_NEAR_BRANCH = '+37.33928-121.88630+017.000/'
export const GPS_NEAR_BRANCH_EXPECT_M = 120

/** About 134m from the branch, a different number so nothing can be hardcoded. */
export const GPS_NEAR_BRANCH_ALT = '+37.33765-121.88495+021.000/'
export const GPS_NEAR_BRANCH_ALT_EXPECT_M = 134

const LOCI = 'udta_loci_3gpp'
const XYZ = 'udta_c_xyz_iso6709'

/**
 * Enumerated reason codes. One code per distinct cause, per C1.2.2: a shared
 * "something went wrong" reason is the same defect as a boolean preflight.
 */
export const REASON_CODES = {
  MVHD_ZERO: 'mvhd_creation_time_zero',
  NO_DAY_ATOM: 'no_udta_day_atom',
  DATE_OUTSIDE_WINDOW: 'capture_date_outside_visit_window',
  NO_GPS_NO_RECEIVER: 'no_gps_atom_camera_has_no_receiver',
  NO_GPS_STRIPPED: 'no_gps_atom_metadata_stripped',
  NO_GPS_NOT_WRITTEN: 'no_gps_atom_not_written_by_encoder',
  NO_FRAMES: 'no_frames_no_decoder',
  NO_DECODER_SHELL: 'no_decoder_in_shell',
  NO_DECODER_ANYWHERE: 'codec_unsupported_in_every_browser',
  NOT_APPLICABLE: 'rule_not_applicable_to_kind',
  BELOW_MIN_DURATION: 'below_min_duration',
  BELOW_MIN_RESOLUTION: 'below_min_resolution',
  WRONG_ORIENTATION: 'display_orientation_not_vertical',
  OUTSIDE_RADIUS: 'gps_outside_branch_radius',
  DUPLICATE_FOUND: 'perceptual_hash_matches_earlier_asset',
  NO_EXIF_PARSER: 'no_exif_parser_for_still_images',
}

const R = REASON_CODES

/** Every entry gets the same tolerances. They are mandatory, not defensive. */
const TOLERANCE = {
  /** mvhd duration versus a decode pass duration versus an AAC padded track. */
  duration_s: 0.05,
  /** Great circle formulas and loci's 16.16 quantisation both move the answer a metre or two. */
  distance_m: 30,
  /** dHash is not bit exact across canvas implementations and codec builds. */
  dhash_hamming: 4,
  /** Keyframe snapping in the `<video>` plus canvas path. GOP is half a second, so this bounds it. */
  frame_t_seconds: 0.5,
}

/**
 * Contact sheet frame count, from E.4a:
 *   frameCount = clamp(round(duration_s / 4), 3, tierMax)
 * with tierMax 3 for `constrained` and 5 for `standard` and `ample`.
 *
 * FINDING, recorded here because it is a spec contradiction rather than a bug:
 * under that formula every clip shorter than about 14s gets 3 frames at every
 * tier, so C2.D's worked example of 5 frames for a 6s clip cannot both be right.
 * `long_ok.mp4` exists so the 1x5 layout and the tier difference have a fixture
 * at all. See docs/media-pipeline.md.
 */
export function frameCountFor(durationSeconds, tierMax) {
  return Math.min(Math.max(Math.round(durationSeconds / 4), 3), tierMax)
}

/** Evenly spaced, skipping the first and last moments where a clip has least to show. */
export function frameTimesFor(durationSeconds, count) {
  return Array.from({ length: count }, (_, i) =>
    Number((((i + 1) * durationSeconds) / (count + 1)).toFixed(3)),
  )
}

/**
 * Shared recipe defaults. Everything here is chosen for byte stability and for
 * small committed files, not for looks.
 *
 * `-fflags +bitexact` is load bearing twice: it stops ffmpeg stamping the build
 * time into mvhd, which would change the sha256 on every run, and it is what
 * produces the honest `mvhd creation_time == 0` on the fixtures that are
 * supposed to have no capture date.
 */
const VIDEO_DEFAULTS = {
  fps: 24,
  gop_frames: 12,
  pattern: 'bars_moving_box',
  crf: 30,
  encoder: 'libx264',
  video_codec_tag: 'avc1',
  pix_fmt: 'yuv420p',
  audio: { encoder: 'aac', tag: 'mp4a', bitrate: '32k', tone_hz: 220 },
  container: 'mp4',
  faststart: true,
  creation_time: CAPTURED_AT,
  day_tag: null,
  location: GPS_NEAR_BRANCH,
  location_atom: LOCI,
  rotation_ccw_deg: 0,
  post: null,
}

function pass(evidence, extra = {}) {
  return { status: 'pass', evidence, ...extra }
}
function fail(evidence, reason, extra = {}) {
  return { status: 'fail', evidence, reason, ...extra }
}
function unknown(reason, extra = {}) {
  return { status: 'unknown', evidence: 'none', reason, ...extra }
}
function skipped(reason, extra = {}) {
  return { status: 'skipped', evidence: 'none', reason, ...extra }
}

/** The rules every well formed vertical H.264 clip at the branch on the day passes. */
function allPassRules() {
  return {
    orientation: pass('coded_dims+tkhd_matrix'),
    min_duration: pass('mvhd'),
    min_resolution: pass('tkhd+stsd'),
    capture_date: pass('mvhd', { captured_at_source: 'mvhd' }),
    near_branch: pass('udta_loci'),
    duplicate: pass('phash_over_delivery'),
    codec_playable: pass('stsd+isConfigSupported'),
  }
}

export const FIXTURES = [
  {
    id: 'vertical_ok',
    file: 'vertical_ok.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves: 'The happy path. Every rule passes, so any fixture that fails a rule fails it for exactly one reason.',
    recipe: { width: 1080, height: 1920, duration_s: 6 },
    rules: allPassRules(),
  },

  {
    id: 'horizontal_fail',
    file: 'horizontal_fail.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves:
      '`orientation` fails on display dimensions, and only `orientation`. min_resolution still passes because it is evaluated on the short and long edges rather than on width and height, which is the design that keeps one defect from tripping two rules.',
    recipe: { width: 1920, height: 1080, duration_s: 6 },
    rules: {
      ...allPassRules(),
      orientation: fail('coded_dims+tkhd_matrix', R.WRONG_ORIENTATION, { blocking: true }),
    },
  },

  {
    id: 'short_fail',
    file: 'short_fail.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves: '`min_duration` fails at 1.5s against a 3s minimum, and nothing else fails.',
    recipe: { width: 1080, height: 1920, duration_s: 1.5 },
    rules: {
      ...allPassRules(),
      min_duration: fail('mvhd', R.BELOW_MIN_DURATION, { blocking: true }),
    },
  },

  {
    id: 'lowres_fail',
    file: 'lowres_fail.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves:
      '`min_resolution` fails at 480x854 while `orientation` still passes, because the clip is genuinely vertical and merely too small. A fixture that failed both would not distinguish the two rules.',
    recipe: { width: 480, height: 854, duration_s: 6 },
    rules: {
      ...allPassRules(),
      min_resolution: fail('tkhd+stsd', R.BELOW_MIN_RESOLUTION, { blocking: true }),
    },
  },

  {
    id: 'offdate_fail',
    file: 'offdate_fail.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: true,
    proves:
      'The only `capture_date: fail` in the set: shot two days before the visit, so the plus or minus 24 hour window from C5.2.3 has a negative case. Without it the window is only ever tested from the passing side, and a window that is accidentally infinite passes every test.',
    recipe: { width: 1080, height: 1920, duration_s: 6, creation_time: CAPTURED_AT_OFF_DATE },
    rules: {
      ...allPassRules(),
      capture_date: fail('mvhd', R.DATE_OUTSIDE_WINDOW, {
        captured_at_source: 'mvhd',
        blocking: false,
        advisory_note: 'Never hard blocks. C5.2.3: a container date is a triage hint, not verification.',
      }),
    },
  },

  {
    id: 'rotated_90',
    file: 'rotated_90.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves:
      'THE MOST VALUABLE FIXTURE IN THE SET. Coded 1920x1080 with a tkhd display matrix of (0,1,-1,0), which is byte for byte the matrix a portrait iPhone clip carries, so display orientation is 1080x1920 vertical. A parser that reads coded dimensions and stops tells a creator their correct vertical footage is horizontal. Every rule must pass.',
    recipe: {
      width: 1920,
      height: 1080,
      duration_s: 6,
      rotation_ccw_deg: -90,
      // The content is generated at the DISPLAY size with an upright label and
      // then rotated in the pixels, which is exactly what a phone does: the
      // sensor hands the encoder a landscape frame containing a sideways scene,
      // and the matrix tells the player to turn it back.
      //
      // The visual tell in the demo is therefore unambiguous: if the label reads
      // upright, rotation was honoured. If it reads sideways, it was not.
      pre_rotate: 'ccw90',
    },
    rules: allPassRules(),
  },

  {
    id: 'hevc',
    file: 'hevc.mov',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves:
      'The open hole in E.4b, live rather than simulated. `hvc1` in a QuickTime container: the metadata layer parses completely because atom parsing needs no decoder, and the pixel layer is permanently absent on the reference runtime. Also the only fixture carrying the QuickTime `©xyz` ISO 6709 location atom and a `udta/©day` with a real timezone offset.',
    recipe: {
      width: 1080,
      height: 1920,
      duration_s: 4,
      container: 'mov',
      encoder: 'libx265',
      video_codec_tag: 'hvc1',
      crf: 36,
      faststart: false,
      location: GPS_NEAR_BRANCH_ALT,
      location_atom: XYZ,
      day_tag: CAPTURED_AT_WITH_OFFSET,
    },
    rules: {
      ...allPassRules(),
      near_branch: pass('udta_c_xyz'),
      capture_date: pass('mvhd+udta_day', {
        captured_at_source: 'udta_day',
        note: 'udta/©day carries -0700, so this is the one fixture where the capture instant is unambiguous without assuming UTC.',
      }),
      duplicate: unknown(R.NO_FRAMES, {
        runtime_dependent: true,
        runtime_note: 'Passes on Safari and on any machine with an HEVC decoder, because frames exist there.',
      }),
      codec_playable: fail('stsd+isConfigSupported', R.NO_DECODER_SHELL, {
        blocking: false,
        routes_to: 'transcode',
        upload_priority: 'required_for_transcode',
        runtime_dependent: true,
        runtime_note: 'Passes on Safari, on iOS, and on Chromium with the HEVC Video Extension present.',
      }),
    },
    derivatives: {
      contact_sheet: false,
      poster: false,
      derivative_state: 'none',
      derivative_producer: null,
      reason: R.NO_DECODER_SHELL,
      guarantee:
        'No sheet, no poster, no asset_frame rows, no ai_run. Absence is the correct representation. A grey placeholder tile is a UI decision, never a stored artifact.',
    },
  },

  {
    id: 'no_metadata',
    file: 'no_metadata.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves:
      'Honest degradation with no evidence at all: mvhd creation_time is literally 0, which a naive parser reports as a capture date of 1904-01-01 rather than as an absence. No location atom. `moov` sits after `mdat`, so the header walker cannot assume the metadata is at the front.',
    recipe: {
      width: 1080,
      height: 1920,
      duration_s: 6,
      creation_time: null,
      location: null,
      location_atom: null,
      faststart: false,
    },
    rules: {
      ...allPassRules(),
      capture_date: unknown(R.MVHD_ZERO, {
        also: [R.NO_DAY_ATOM],
        fallback: 'file_mtime',
        fallback_never_promoted: true,
        captured_at_source: 'unknown',
        note: 'File.lastModified is recorded as a fallback and never written into captured_at. An absent creation atom does not distinguish "stripped by a re-encode" from "never written", so the UI must claim neither.',
      }),
      near_branch: unknown(R.NO_GPS_STRIPPED, {
        never_blocking: true,
        creator_facing: false,
      }),
    },
  },

  {
    id: 'duplicate_of_vertical_ok',
    file: 'duplicate_of_vertical_ok.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves:
      'Perceptual dedupe where a byte hash cannot help: re-encoded from vertical_ok.mp4 itself at a different quantiser, so the sha256 differs and the frames match within a Hamming distance of 4.',
    recipe: {
      width: 1080,
      height: 1920,
      duration_s: 6,
      reencode_of: 'vertical_ok',
      crf: 29,
    },
    rules: {
      ...allPassRules(),
      duplicate: fail('phash_over_delivery', R.DUPLICATE_FOUND, {
        duplicate_of_fixture_id: 'vertical_ok',
        blocking: false,
        advisory_note: 'Advisory only. A creator delivering the same shot twice is a nudge, not a rejection.',
      }),
    },
  },

  {
    id: 'prores',
    file: 'prores.mov',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: false,
    proves:
      'The camera offload path, and the fixture that makes `unknown` real. A mirrorless body has no GPS receiver, so `near_branch` is `unknown` and must never render as a red cross: failing a creator for owning better equipment is a product defect, not a strict rule. ProRes `apcn` also decodes in no browser at all, which is a stronger statement than the HEVC case. No audio track.',
    recipe: {
      width: 1024,
      height: 576,
      duration_s: 3.5,
      fps: 10,
      gop_frames: 1,
      pattern: 'flat_log',
      container: 'mov',
      encoder: 'prores_ks',
      prores_profile: 2,
      video_codec_tag: 'apcn',
      pix_fmt: 'yuv422p10le',
      audio: null,
      creation_time: null,
      location: null,
      location_atom: null,
      faststart: false,
    },
    rules: {
      orientation: fail('coded_dims+tkhd_matrix', R.WRONG_ORIENTATION, { blocking: true }),
      min_duration: pass('mvhd'),
      min_resolution: fail('tkhd+stsd', R.BELOW_MIN_RESOLUTION, { blocking: true }),
      capture_date: unknown(R.MVHD_ZERO, {
        also: [R.NO_DAY_ATOM],
        fallback: 'file_mtime',
        fallback_never_promoted: true,
        captured_at_source: 'unknown',
        note: 'Cameras commonly write no creation atom, or write camera local time with no offset. Either way this is absence of evidence, not a rule violation.',
      }),
      near_branch: unknown(R.NO_GPS_NO_RECEIVER, {
        never_blocking: true,
        creator_facing: false,
        note: 'THE RULE THAT GOVERNS THE WHOLE PIPELINE. Grey dash, never red. Nothing shown to the creator, because there is no action available.',
      }),
      duplicate: unknown(R.NO_FRAMES, { runtime_dependent: false }),
      codec_playable: fail('stsd+isConfigSupported', R.NO_DECODER_ANYWHERE, {
        blocking: false,
        routes_to: 'transcode',
        upload_priority: 'required_for_transcode',
        runtime_dependent: false,
        runtime_note: 'No browser decodes ProRes, so unlike hvc1 this answer does not move with the runtime.',
      }),
    },
    derivatives: {
      contact_sheet: false,
      poster: false,
      derivative_state: 'none',
      derivative_producer: null,
      reason: R.NO_DECODER_ANYWHERE,
      guarantee: 'Same guarantee as hevc.mov: no sheet, no poster, no ai_run, and no black frame passed off as a frame.',
    },
  },

  {
    id: 'largesize_mdat',
    file: 'largesize_mdat.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: true,
    proves:
      'The 64 bit atom size path the charter requires: `size == 1` followed by a 64 bit largesize. Real files only take that form above 4GB, which cannot be committed, so the builder rewrites the 8 byte `free` atom that ffmpeg already reserves in front of `mdat` into a 16 byte 64 bit `mdat` header. The mdat payload does not move, so every `stco` offset stays valid and the file still decodes. Without this fixture the 64 bit branch has nothing to assert against at any size.',
    recipe: { width: 1080, height: 1920, duration_s: 2, post: 'largesize_mdat' },
    rules: {
      ...allPassRules(),
      min_duration: fail('mvhd', R.BELOW_MIN_DURATION, {
        blocking: true,
        advisory_note:
          'This clip is 2s to keep the committed bytes small, so it fails min_duration as a side effect. It exists to test the atom walker, not the duration rule, and the QA case asserts the parsed duration rather than the verdict.',
      }),
    },
  },

  {
    id: 'long_ok',
    file: 'long_ok.mp4',
    kind: 'video',
    group: 'engineered',
    added_beyond_c2d: true,
    proves:
      'The only fixture long enough for the frame count formula to produce 5 frames, so the 1x5 sheet layout and the constrained versus standard tier difference have a fixture at all. Under E.4a every clip below about 14s gets 3 frames at every tier, which means the rest of this set cannot exercise the layout the contact sheet spec is written around.',
    recipe: { width: 1080, height: 1920, duration_s: 20, crf: 32 },
    rules: allPassRules(),
  },

  {
    id: 'photo_still',
    file: 'photo_still.jpg',
    kind: 'photo',
    group: 'engineered',
    added_beyond_c2d: true,
    proves:
      'The only fixture where a rule is `skipped` rather than `unknown`. A photo has no duration to check, and "this does not apply" reads differently to a human than "we could not tell". Also the not-a-movie input: the container walker must return a reason rather than throwing when handed bytes that are not ISO BMFF at all.',
    recipe: {
      width: 1080,
      height: 1920,
      still: true,
      pattern: 'calm_warm',
      audio: null,
      // A JPEG has no container to hold either, which is the point: the pipeline
      // must produce a useful result from a file with zero container metadata.
      creation_time: null,
      location: null,
      location_atom: null,
    },
    rules: {
      orientation: pass('image_dims'),
      min_duration: skipped(R.NOT_APPLICABLE, {
        kind: 'photo',
        note: 'Not rendered at all in the UI. `skipped` is invisible, `unknown` is a grey dash with a reason.',
      }),
      min_resolution: pass('image_dims'),
      capture_date: unknown(R.NO_EXIF_PARSER, {
        fallback: 'file_mtime',
        fallback_never_promoted: true,
        captured_at_source: 'unknown',
        note: 'ffmpeg writes no EXIF, and we ship no EXIF parser, so this is honestly unknown rather than pretending a stills path exists.',
      }),
      near_branch: unknown(R.NO_GPS_NOT_WRITTEN, { never_blocking: true, creator_facing: false }),
      duplicate: pass('phash_over_delivery', {
        note: 'A still has exactly one frame, which is its own sheet, so dedupe genuinely can run.',
      }),
      codec_playable: pass('image_decode'),
    },
  },

  // Preview clips. These exist for the player and the library grid, not for the
  // parser. They carry no engineered defect, and their names deliberately claim
  // nothing about their content: a synthetic gradient named
  // `preview_sauna_steam` would be a fabricated content claim that could leak
  // into a tag index.
  {
    id: 'preview_01',
    file: 'preview_01.mp4',
    kind: 'video',
    group: 'preview',
    added_beyond_c2d: false,
    proves: 'Preview player only. Pleasant vertical synthetic clip, no engineered defect, depicts no room and no subject.',
    recipe: { width: 1080, height: 1920, duration_s: 5, pattern: 'calm_warm', crf: 32 },
    rules: allPassRules(),
  },
  {
    id: 'preview_02',
    file: 'preview_02.mp4',
    kind: 'video',
    group: 'preview',
    added_beyond_c2d: false,
    proves: 'Preview player only. Second clip so the player can be driven across a queue rather than a single item.',
    recipe: { width: 1080, height: 1920, duration_s: 5, pattern: 'calm_cool', crf: 32 },
    rules: allPassRules(),
  },
  {
    id: 'preview_03',
    file: 'preview_03.mp4',
    kind: 'video',
    group: 'preview',
    added_beyond_c2d: false,
    proves: 'Preview player only. Third clip, slower movement, for scrub and seek behaviour.',
    recipe: { width: 1080, height: 1920, duration_s: 5, pattern: 'calm_green', crf: 32 },
    rules: allPassRules(),
  },
]

/**
 * The duplicate rule is the one rule whose answer depends on what else is in the
 * delivery, so the expectation is only meaningful against a stated comparison
 * set. Every `duplicate` status above assumes the whole engineered group is
 * ingested as one delivery in manifest order.
 */
export const DUPLICATE_ASSUMPTION = {
  comparison_set: 'all fixtures with group == "engineered", ingested as one delivery in manifest order',
  expected_pairs: [{ later: 'duplicate_of_vertical_ok', earlier: 'vertical_ok' }],
  note: 'Ingested alone, `duplicate_of_vertical_ok` has nothing to match and its status is `pass`. That is not a contradiction, it is the rule being set dependent, and any test asserting it must state the set.',
}

export { TOLERANCE, VIDEO_DEFAULTS, LOCI, XYZ }
