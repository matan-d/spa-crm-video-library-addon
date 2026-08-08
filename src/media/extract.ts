/**
 * A3: the frame extraction chain, the contact sheet, and the poster.
 *
 * Extraction is a capability chain rather than one technique, and the chain is the
 * design rather than a fallback bolted on:
 *
 * 1. **WebCodecs `VideoDecoder` plus the sample table from the parser.** Frame
 *    accurate and deterministic: the demux finds the last sync sample at or before
 *    a target time and feeds forward from there, so there is no seek flakiness and
 *    the frame we get is the frame we asked for.
 * 2. **`<video>` plus canvas.** Widely available and approximate: a seek snaps to
 *    the preceding keyframe, so a planned time is a target rather than a promise,
 *    and on a clip whose planned spacing is under the keyframe interval two tiles
 *    can legitimately land on the same decoded frame.
 * 3. **A placeholder tile.** A described grey tile so the interface never breaks
 *    on an undecodable file.
 *
 * Rung three is a UI descriptor and NEVER a stored artefact, and that distinction
 * is the whole no fabrication rule in one line. `hevc.mov` on a machine with no
 * HEVC decoder has no contact sheet, no poster, no frame rows and no `ai_run`. It
 * has a `placeholder` describing what the manager should be shown and why, which
 * the interface renders and nothing persists as a frame. A grey tile written into
 * the blob store as a contact sheet would eventually be handed to a model, and a
 * plausible tag on a clip nobody could decode is the least detectable and most
 * damaging failure this product has.
 *
 * Which rung produced a sheet is recorded on the sheet, along with
 * `EXTRACTOR_VERSION`, so a better extractor can re-derive old sheets later and
 * anybody comparing two sheets can see whether they are comparable.
 *
 * Everything in this module except `encodeJpeg` and the two decode adapters is a
 * pure function over pixels, which is what makes planning, rotation
 * reconciliation, blank detection, tiling and hashing testable in jsdom where
 * there is no video decoder at all.
 */

import {
  frameCountFor,
  layoutFor,
  type IngestPolicy,
  type IngestTier,
  type SheetLayout,
} from '@/platform/capability'
import type { Support } from '@/platform/port'
import type { ByteSource } from './bytes'
import type { ContainerFacts, Dimensions, Rotation, VideoSampleTable } from './atoms'
import { dHash, isBlankFrame, PHASH_VERSION, type RgbaImage } from './phash'
import type { StillFacts } from './still'

/**
 * Bumped whenever a change would alter the pixels of a sheet produced from the
 * same bytes at the same tier. Stored on every sheet, because a sheet produced by
 * a different extractor is different evidence, and a cached model run against the
 * old one must not be reused.
 */
export const EXTRACTOR_VERSION = 1

export type ExtractorPath = 'webcodecs' | 'video-canvas' | 'placeholder' | 'none'

/** Every enumerated way extraction can fail to produce pixels. */
export type ExtractionFailureReason =
  | 'no_extractor'
  | 'decode_unsupported'
  | 'demux_unavailable'
  | 'zero_duration'
  | 'zero_dimensions'
  | 'blank_frame'
  | 'seek_timeout'
  | 'metadata_timeout'
  | 'no_frames_decoded'
  | 'sheet_encode_failed'
  | 'not_decodable_input'

/**
 * Who applied the rotation, recorded so a later bug is diagnosable.
 *
 * Some engines apply the display matrix before handing pixels to a canvas and
 * some do not, and a doubled rotation looks exactly like a missed one in a bug
 * report. `undecidable` is real: on square coded dimensions the two cases are
 * indistinguishable from the element's reported size.
 */
export type RotationSource = 'not_needed' | 'element_applied' | 'we_applied' | 'decoder_applied' | 'undecidable'

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

export interface PlannedFrame {
  index: number
  planned_t_seconds: number
}

export interface FramePlan {
  tier: IngestTier
  count: number
  /** Null for a still, which is its own single frame and is not a tiled sheet. */
  layout: SheetLayout | null
  frames: PlannedFrame[]
  duration_s: number
  /** Gap between planned frames. Compared against the keyframe interval by the caller. */
  spacing_s: number
}

/**
 * Where the frames come from in time.
 *
 * The count is `frameCountFor()` and nothing here restates that formula: it is
 * owned by `src/platform/capability.ts` and settled in `docs/06-decisions.md` D2.
 *
 * The spacing skips the first and last moments (`t_i = (i + 1) * d / (count + 1)`)
 * because the first frame of a clip is frequently a fade in and the last is
 * frequently a hand reaching for the phone, and a contact sheet whose first tile
 * is black teaches a reviewer to distrust the sheet.
 */
export function planFrames(durationSeconds: number | null, tier: IngestTier): FramePlan {
  const duration = Number.isFinite(durationSeconds ?? NaN) && (durationSeconds ?? 0) > 0 ? (durationSeconds as number) : 0
  const count = frameCountFor(duration, tier)
  const frames: PlannedFrame[] = []
  for (let index = 0; index < count; index += 1) {
    frames.push({ index, planned_t_seconds: round((index + 1) * (duration / (count + 1)), 6) })
  }
  return {
    tier,
    count,
    layout: layoutFor(count),
    frames,
    duration_s: duration,
    spacing_s: round(duration / (count + 1), 6),
  }
}

/** A still is one frame, itself, at time zero. It is not a tiled sheet. */
export function planStillFrame(tier: IngestTier): FramePlan {
  return {
    tier,
    count: 1,
    layout: null,
    frames: [{ index: 0, planned_t_seconds: 0 }],
    duration_s: 0,
    spacing_s: 0,
  }
}

// ---------------------------------------------------------------------------
// rotation reconciliation
// ---------------------------------------------------------------------------

export interface RotationDecision {
  quarter_turns: 0 | 1 | 2 | 3
  source: RotationSource
  /** What a human should see, after rotation. */
  display: Dimensions
  note: string | null
}

/**
 * Decides whether the canvas must rotate, from what the element actually reported.
 *
 * Detected rather than guessed, per C4.2.1. If the element reports the display
 * size then the engine already applied the matrix and rotating again produces
 * sideways tiles; if it reports the coded size then we must rotate. Getting this
 * wrong on an iPhone clip tells a creator their correct vertical footage is
 * horizontal, which is the difference between accepting and rejecting real work.
 */
export function reconcileRotation(
  coded: Dimensions | null,
  rotationDeg: Rotation,
  reported: Dimensions | null,
): RotationDecision {
  const base = coded ?? reported ?? { width: 0, height: 0 }
  const swapped = { width: base.height, height: base.width }
  const turns = ((rotationDeg / 90) | 0) as 0 | 1 | 2 | 3
  const rotatedDisplay = turns === 1 || turns === 3 ? swapped : base

  if (rotationDeg === 0) {
    return { quarter_turns: 0, source: 'not_needed', display: base, note: null }
  }
  if (!reported) {
    return {
      quarter_turns: turns,
      source: 'we_applied',
      display: rotatedDisplay,
      note: 'nothing reported an intrinsic size, so the container matrix was applied',
    }
  }

  const matchesCoded = reported.width === base.width && reported.height === base.height
  const matchesDisplay = reported.width === rotatedDisplay.width && reported.height === rotatedDisplay.height

  if (matchesCoded && matchesDisplay) {
    return {
      quarter_turns: 0,
      source: 'undecidable',
      display: rotatedDisplay,
      note: 'coded dimensions are square, so whether the engine already rotated cannot be told from its reported size',
    }
  }
  if (matchesDisplay) {
    return {
      quarter_turns: 0,
      source: 'element_applied',
      display: rotatedDisplay,
      note: `the element reported ${reported.width}x${reported.height}, which is the display size, so the engine already applied the matrix`,
    }
  }
  if (matchesCoded) {
    return {
      quarter_turns: turns,
      source: 'we_applied',
      display: rotatedDisplay,
      note: `the element reported the coded size ${reported.width}x${reported.height}, so the canvas must rotate ${rotationDeg} degrees`,
    }
  }
  return {
    quarter_turns: turns,
    source: 'we_applied',
    display: rotatedDisplay,
    note: `the element reported ${reported.width}x${reported.height}, which matches neither the coded nor the display size, so the container matrix was applied and the result is suspect`,
  }
}

// ---------------------------------------------------------------------------
// the host seam: the only two things extraction cannot do purely
// ---------------------------------------------------------------------------

export interface MediaInput {
  /**
   * Something an object URL can be made from, for the element path. Null when all
   * we hold is a range reader, which is the case for a resumed remote original.
   */
  blob: Blob | null
  /** The range addressed reader, for the demux path. Never materialises the file. */
  bytes: ByteSource
  /** Reported by the picker. Recorded, never trusted: an iPhone writes .MOV for both codecs. */
  mime_type: string | null
  filename: string
}

export interface DecodeRequest {
  times: number[]
  duration_s: number | null
  coded: Dimensions | null
  rotation_deg: Rotation
  codec_string: string | null
  codec_description: Uint8Array | null
  sample_table: VideoSampleTable | null
  /** Frames are produced at this long edge and never at native resolution. */
  target_long_edge: number
  timeouts: { metadata_ms: number; seek_ms: number }
}

export interface DecodedFrame {
  planned_t_seconds: number
  /** Where the decoder actually landed. On the element path this is not the plan. */
  actual_t_seconds: number
  /** Already upright and already downscaled. Never a native resolution buffer. */
  raster: RgbaImage
}

export interface DecodeOutcome {
  ok: boolean
  reason: ExtractionFailureReason | null
  rotation_source: RotationSource | null
  frames: DecodedFrame[]
  /**
   * What the decode pass itself measured, where it measured anything.
   *
   * Reported as a by-product rather than through a second load, because the
   * element already had to know both to seek at all. The duration outranks the
   * container's declaration: a container is a claim and a decoder is a measurement.
   */
  measured_duration_s?: number | null
  /** The intrinsic size the runtime reported, which is what decides `rotation_source`. */
  reported_size?: Dimensions | null
  diagnostics: string[]
  /**
   * Releases whatever the adapter holds: `ImageBitmap`s, canvases, object URLs.
   * The extractor calls this exactly once per attempt, in a finally, because a
   * phone ingesting forty clips dies on retained bitmaps rather than on logic.
   */
  release(): void
}

export interface DecodeAdapter {
  readonly path: 'webcodecs' | 'video-canvas'
  decode(input: MediaInput, request: DecodeRequest): Promise<DecodeOutcome>
}

export interface ExtractionHost {
  /** In preference order. The policy decides how far down the list is allowed. */
  readonly adapters: readonly DecodeAdapter[]
  /** Encodes a composed raster. Null when this runtime cannot encode, which is not a crash. */
  encodeJpeg(image: RgbaImage, quality: number): Promise<Blob | null>
  /** Decodes a still to pixels. Absent in a runtime with no image decoder. */
  decodeStill?: (input: MediaInput, targetLongEdge: number) => Promise<RgbaImage | null>
  /**
   * Duration and intrinsic size from the runtime, without extracting anything.
   *
   * Only called when the container did not supply them, which is the file with no
   * `moov` at all: container metadata is an enhancement and never a dependency
   * (C5.2.2), so a clip whose header is gone still gets a sheet.
   */
  probeMedia?: (input: MediaInput, timeoutMs: number) => Promise<{ duration_s: number | null; reported: Dimensions | null } | null>
}

// ---------------------------------------------------------------------------
// the artefacts
// ---------------------------------------------------------------------------

export interface ExtractedFrame {
  index: number
  planned_t_seconds: number
  actual_t_seconds: number
  width: number
  height: number
  /** dHash of the frame as extracted, at the tile size the sheet uses. */
  dhash: string
}

export interface ContactSheet {
  blob: Blob
  width: number
  height: number
  layout: SheetLayout | null
  tile_width: number
  tile_height: number
  frame_count: number
  jpeg_quality: number
  policy_tier: IngestTier
  extractor_path: ExtractorPath
  extractor_version: number
  phash_version: number
}

export interface Poster {
  blob: Blob
  width: number
  height: number
  /** Which frame became the poster, so it is reproducible. */
  from_frame_index: number
}

/**
 * What the interface should render where a sheet would be, and why.
 *
 * A descriptor, never a stored blob. `derivative_state` stays `none` and no frame
 * row exists, so nothing downstream can mistake this for evidence about the clip.
 */
export interface PlaceholderTile {
  kind: 'grey_tile'
  reason: ExtractionFailureReason
  /** One clause a manager can read. */
  headline: string
  /** What would fix it, in the creator's terms. */
  remedy: string | null
  /** Facts we do have, so the card is not empty. */
  facts: { duration_s: number | null; display: Dimensions | null; codec: string | null }
}

export interface ExtractionAttempt {
  path: ExtractorPath
  ok: boolean
  reason: ExtractionFailureReason | null
  diagnostics: string[]
}

export interface ExtractionResult {
  /** Which rung produced the outcome. Recorded on the sheet too. */
  path: ExtractorPath
  extractor_version: number
  policy_tier: IngestTier
  plan: FramePlan
  frames: ExtractedFrame[]
  frame_hashes: string[]
  rotation_source: RotationSource | null
  sheet: ContactSheet | null
  poster: Poster | null
  /** Set only when there are no pixels. Mutually exclusive with `sheet`. */
  placeholder: PlaceholderTile | null
  reason: ExtractionFailureReason | null
  attempts: ExtractionAttempt[]
  diagnostics: string[]
  /**
   * What the runtime measured, where it measured anything: a duration and an
   * intrinsic size. Handed to the pre-flight engine, where it outranks the
   * container's declaration for duration and is the only source of either on a file
   * with no `moov`.
   */
  measured: { duration_s: number | null; reported: Dimensions | null } | null
}

export interface ExtractionRequest {
  input: MediaInput
  kind: 'video' | 'photo'
  policy: IngestPolicy
  /** The platform's answer about this codec. `unknown` is attempted; `no` is not. */
  decodable: Support
  container: ContainerFacts | null
  still: StillFacts | null
  /** Overrides for the wall clock ceilings, in tests. */
  timeouts?: { metadata_ms: number; seek_ms: number }
}

/** C1.2.2: nothing waits forever, because one file must never stall a forty file batch. */
export const DEFAULT_TIMEOUTS = { metadata_ms: 8000, seek_ms: 5000 }

// ---------------------------------------------------------------------------
// the chain
// ---------------------------------------------------------------------------

export async function extractFrames(
  request: ExtractionRequest,
  host: ExtractionHost,
): Promise<ExtractionResult> {
  const { policy, container, still, kind } = request
  const tier = policy.tier
  const coded = container?.coded.value ?? still?.coded.value ?? null
  const display = container?.display.value ?? still?.coded.value ?? null
  const rotation = (container?.rotation_deg.value ?? 0) as Rotation
  const durationSeconds = container?.duration_s.value ?? null
  const codec = container?.codec_video.value ?? still?.format ?? null

  let plan = kind === 'photo' ? planStillFrame(tier) : planFrames(durationSeconds, tier)
  let measured: { duration_s: number | null; reported: Dimensions | null } | null = null
  const attempts: ExtractionAttempt[] = []
  const diagnostics: string[] = []

  const refuse = (reason: ExtractionFailureReason, headline: string, remedy: string | null): ExtractionResult => ({
    path: 'placeholder',
    extractor_version: EXTRACTOR_VERSION,
    policy_tier: tier,
    plan,
    frames: [],
    frame_hashes: [],
    rotation_source: null,
    sheet: null,
    poster: null,
    placeholder: {
      kind: 'grey_tile',
      reason,
      headline,
      remedy,
      facts: { duration_s: durationSeconds ?? measured?.duration_s ?? null, display, codec },
    },
    reason,
    attempts,
    diagnostics,
    measured,
  })

  // The codec answer comes from the platform probe, and `no` means extraction is
  // not attempted at all. A try-and-catch into a black frame is worse than no
  // frame, because a black frame gets tagged.
  if (request.decodable === 'no') {
    return refuse(
      'decode_unsupported',
      codec === 'apcn' || codec === 'apch' || codec === 'apcs' || codec === 'apco'
        ? 'no preview: ProRes, which no browser decodes'
        : `no preview: ${codec ?? 'this codec'}, this browser has no decoder`,
      'send an H.264 version, or switch the iPhone camera to Most Compatible before shooting',
    )
  }

  if (kind === 'photo') {
    return await extractStill(request, host, plan, attempts, diagnostics, refuse)
  }

  // Container metadata is an enhancement, never a dependency (C5.2.2). A file with
  // no `moov` at all still gets a sheet, from whatever the runtime can measure.
  const needsProbe = durationSeconds === null || durationSeconds <= 0 || !coded || coded.width <= 0
  if (needsProbe && host.probeMedia) {
    measured = await host.probeMedia(request.input, (request.timeouts ?? DEFAULT_TIMEOUTS).metadata_ms)
    diagnostics.push(
      measured
        ? `the container supplied no usable duration or size, so the runtime was asked and reported ${measured.duration_s ?? 'no'} seconds`
        : 'the container supplied no usable duration or size and the runtime could not measure either',
    )
  }

  const effectiveDuration = durationSeconds && durationSeconds > 0 ? durationSeconds : (measured?.duration_s ?? null)
  const effectiveCoded = coded && coded.width > 0 ? coded : (measured?.reported ?? null)

  if (effectiveDuration === null || effectiveDuration <= 0) {
    return refuse(
      'zero_duration',
      'no preview: the file reports no duration',
      'the file may be truncated or still uploading, so sending it again is worth a try',
    )
  }
  if (!effectiveCoded || effectiveCoded.width <= 0 || effectiveCoded.height <= 0) {
    return refuse('zero_dimensions', 'no preview: the file reports no frame size', null)
  }
  if (effectiveDuration !== durationSeconds) plan = planFrames(effectiveDuration, tier)

  const allowed = allowedAdapters(host.adapters, policy)
  if (allowed.length === 0) {
    return refuse(
      'no_extractor',
      'no preview: this browser offers no way to decode a frame',
      'opening the link in a current Chrome, Edge, Firefox or Safari produces previews',
    )
  }

  const decodeRequest: DecodeRequest = {
    times: plan.frames.map((frame) => frame.planned_t_seconds),
    duration_s: effectiveDuration,
    coded: effectiveCoded,
    rotation_deg: rotation,
    codec_string: container?.codec_string.value ?? null,
    codec_description: container?.codec_description ?? null,
    sample_table: container?.video_sample_table ?? null,
    target_long_edge: policy.frameLongEdge,
    timeouts: request.timeouts ?? DEFAULT_TIMEOUTS,
  }

  for (const adapter of allowed) {
    let outcome: DecodeOutcome | null = null
    try {
      outcome = await adapter.decode(request.input, decodeRequest)
      const usable = outcome.frames.filter((frame) => !isBlankFrame(frame.raster))
      const dropped = outcome.frames.length - usable.length
      if (dropped > 0) {
        outcome.diagnostics.push(`${dropped} decoded frame(s) were blank and were dropped rather than tiled`)
      }

      if (!outcome.ok && usable.length === 0) {
        attempts.push({
          path: adapter.path,
          ok: false,
          reason: outcome.reason ?? 'no_frames_decoded',
          diagnostics: outcome.diagnostics,
        })
        continue
      }
      if (usable.length === 0) {
        attempts.push({ path: adapter.path, ok: false, reason: 'blank_frame', diagnostics: outcome.diagnostics })
        continue
      }

      const frames: ExtractedFrame[] = usable.map((frame, index) => ({
        index,
        planned_t_seconds: frame.planned_t_seconds,
        actual_t_seconds: frame.actual_t_seconds,
        width: frame.raster.width,
        height: frame.raster.height,
        dhash: dHash(frame.raster),
      }))

      const composed = composeSheetRaster(
        usable.map((frame) => frame.raster),
        policy,
      )
      const sheetBlob = composed ? await host.encodeJpeg(composed.raster, policy.jpegQuality) : null
      if (!composed || !sheetBlob) {
        attempts.push({
          path: adapter.path,
          ok: false,
          reason: 'sheet_encode_failed',
          diagnostics: [...outcome.diagnostics, 'frames decoded but the sheet could not be encoded'],
        })
        continue
      }

      const posterIndex = Math.floor(usable.length / 2)
      const posterSource = usable[posterIndex]?.raster ?? null
      const posterRaster = posterSource ? scaleToLongEdge(posterSource, policy.posterLongEdge) : null
      const posterBlob = posterRaster ? await host.encodeJpeg(posterRaster, policy.jpegQuality) : null

      attempts.push({ path: adapter.path, ok: true, reason: null, diagnostics: outcome.diagnostics })
      diagnostics.push(...outcome.diagnostics)
      if (outcome.measured_duration_s != null || outcome.reported_size != null) {
        measured = {
          duration_s: outcome.measured_duration_s ?? measured?.duration_s ?? null,
          reported: outcome.reported_size ?? measured?.reported ?? null,
        }
      }

      return {
        path: adapter.path,
        extractor_version: EXTRACTOR_VERSION,
        policy_tier: tier,
        plan,
        frames,
        frame_hashes: frames.map((frame) => frame.dhash),
        rotation_source: outcome.rotation_source,
        sheet: {
          blob: sheetBlob,
          width: composed.width,
          height: composed.height,
          layout: layoutFor(frames.length),
          tile_width: composed.tileWidth,
          tile_height: composed.tileHeight,
          frame_count: frames.length,
          jpeg_quality: policy.jpegQuality,
          policy_tier: tier,
          extractor_path: adapter.path,
          extractor_version: EXTRACTOR_VERSION,
          phash_version: PHASH_VERSION,
        },
        poster:
          posterBlob && posterRaster
            ? {
                blob: posterBlob,
                width: posterRaster.width,
                height: posterRaster.height,
                from_frame_index: posterIndex,
              }
            : null,
        placeholder: null,
        reason: null,
        attempts,
        diagnostics,
        measured,
      }
    } finally {
      // Always, on every path out of the attempt. A retained ImageBitmap is how a
      // phone dies partway through a batch with no diagnostic at all.
      outcome?.release()
    }
  }

  const lastReason = attempts.at(-1)?.reason ?? 'no_frames_decoded'
  return refuse(
    lastReason,
    lastReason === 'seek_timeout' || lastReason === 'metadata_timeout'
      ? 'no preview: decoding this file timed out in the browser'
      : 'no preview: the browser could not decode a frame from this file',
    'sending the original lets it be transcoded later, so nothing is lost',
  )
}

async function extractStill(
  request: ExtractionRequest,
  host: ExtractionHost,
  plan: FramePlan,
  attempts: ExtractionAttempt[],
  diagnostics: string[],
  refuse: (reason: ExtractionFailureReason, headline: string, remedy: string | null) => ExtractionResult,
): Promise<ExtractionResult> {
  const { policy, still } = request
  if (!host.decodeStill) {
    attempts.push({ path: 'none', ok: false, reason: 'decode_unsupported', diagnostics: ['no still decoder in this runtime'] })
    return refuse('decode_unsupported', 'no preview: this runtime cannot decode a still image', null)
  }
  if (!still?.ok) {
    attempts.push({ path: 'none', ok: false, reason: 'not_decodable_input', diagnostics: [still?.reason ?? 'no still facts'] })
    return refuse(
      still?.reason === 'no_heif_parser' ? 'decode_unsupported' : 'not_decodable_input',
      still?.reason === 'no_heif_parser'
        ? 'no preview: HEIC, which this browser cannot read'
        : 'no preview: this file is not an image we can read',
      still?.reason === 'no_heif_parser'
        ? 'switching the iPhone camera to Most Compatible produces JPEG instead of HEIC'
        : null,
    )
  }

  const raster = await host.decodeStill(request.input, policy.frameLongEdge)
  if (!raster || isBlankFrame(raster)) {
    attempts.push({ path: 'none', ok: false, reason: raster ? 'blank_frame' : 'no_frames_decoded', diagnostics: [] })
    return refuse(raster ? 'blank_frame' : 'no_frames_decoded', 'no preview: the image decoded to nothing', null)
  }

  // A still is its own sheet: one tile, no composition, and the poster is the same
  // pixels at poster size. `layout` stays null rather than becoming a made up 1x1.
  const sheetBlob = await host.encodeJpeg(raster, policy.jpegQuality)
  if (!sheetBlob) {
    attempts.push({ path: 'none', ok: false, reason: 'sheet_encode_failed', diagnostics: [] })
    return refuse('sheet_encode_failed', 'no preview: the image could not be re-encoded', null)
  }
  const posterRaster = scaleToLongEdge(raster, policy.posterLongEdge)
  const posterBlob = await host.encodeJpeg(posterRaster, policy.jpegQuality)
  const hash = dHash(raster)
  attempts.push({ path: 'none', ok: true, reason: null, diagnostics: ['still image: the file is its own sheet'] })

  return {
    path: 'video-canvas',
    extractor_version: EXTRACTOR_VERSION,
    policy_tier: policy.tier,
    plan,
    frames: [
      {
        index: 0,
        planned_t_seconds: 0,
        actual_t_seconds: 0,
        width: raster.width,
        height: raster.height,
        dhash: hash,
      },
    ],
    frame_hashes: [hash],
    rotation_source: 'not_needed',
    sheet: {
      blob: sheetBlob,
      width: raster.width,
      height: raster.height,
      layout: null,
      tile_width: raster.width,
      tile_height: raster.height,
      frame_count: 1,
      jpeg_quality: policy.jpegQuality,
      policy_tier: policy.tier,
      extractor_path: 'video-canvas',
      extractor_version: EXTRACTOR_VERSION,
      phash_version: PHASH_VERSION,
    },
    poster: posterBlob
      ? { blob: posterBlob, width: posterRaster.width, height: posterRaster.height, from_frame_index: 0 }
      : null,
    placeholder: null,
    reason: null,
    attempts,
    diagnostics,
    measured: { duration_s: null, reported: { width: raster.width, height: raster.height } },
  }
}

/**
 * Which rungs the policy allows, in order.
 *
 * The probe's answer is a ceiling, not an instruction: a runtime that reports
 * `webcodecs` may still fail on a particular file, so the element path stays
 * available below it. A runtime that reports `video-canvas` must not be handed a
 * WebCodecs adapter, because the probe already established the API is absent.
 */
export function allowedAdapters(
  adapters: readonly DecodeAdapter[],
  policy: IngestPolicy,
): readonly DecodeAdapter[] {
  if (policy.extractor === 'none') return []
  if (policy.extractor === 'video-canvas') return adapters.filter((adapter) => adapter.path === 'video-canvas')
  const order: ExtractorPath[] = ['webcodecs', 'video-canvas']
  return [...adapters].sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
}

// ---------------------------------------------------------------------------
// composition, pure
// ---------------------------------------------------------------------------

export interface ComposedSheet {
  raster: RgbaImage
  width: number
  height: number
  tileWidth: number
  tileHeight: number
}

/**
 * Tiles frames into one horizontal strip, capped on the long edge.
 *
 * One composite image per clip rather than N separate frames, and capped at
 * `sheetLongEdgeCap` (D3). The cap is a correctness requirement rather than a cost
 * preference: a bounded classification task does not improve with thousands of
 * visual tokens per image, and the payload ceiling makes it hard anyway.
 *
 * Tile geometry is computed once for the whole sheet and every tile gets the same
 * box, so five tiles are five comparable moments rather than five differently
 * scaled ones.
 */
export function composeSheetRaster(frames: readonly RgbaImage[], policy: IngestPolicy): ComposedSheet | null {
  if (frames.length === 0) return null
  const first = frames[0]
  if (!first || first.width <= 0 || first.height <= 0) return null

  const aspect = first.width / first.height
  let tileWidth = aspect >= 1 ? policy.frameLongEdge : Math.max(1, Math.round(policy.frameLongEdge * aspect))
  let tileHeight = aspect >= 1 ? Math.max(1, Math.round(policy.frameLongEdge / aspect)) : policy.frameLongEdge

  // Scale the tile down until the assembled strip fits the cap, rather than
  // assembling something large and resampling it twice.
  const stripLongEdge = Math.max(tileWidth * frames.length, tileHeight)
  if (stripLongEdge > policy.sheetLongEdgeCap) {
    const scale = policy.sheetLongEdgeCap / stripLongEdge
    tileWidth = Math.max(1, Math.floor(tileWidth * scale))
    tileHeight = Math.max(1, Math.floor(tileHeight * scale))
  }

  const width = tileWidth * frames.length
  const height = tileHeight
  const raster: RgbaImage = { width, height, data: new Uint8ClampedArray(width * height * 4) }

  frames.forEach((frame, index) => {
    drawScaled(raster, frame, index * tileWidth, 0, tileWidth, tileHeight)
  })

  return { raster, width, height, tileWidth, tileHeight }
}

/** Uniform downscale to a long edge. Used for the poster. */
export function scaleToLongEdge(image: RgbaImage, longEdge: number): RgbaImage {
  const current = Math.max(image.width, image.height)
  if (current <= 0) return image
  const scale = Math.min(1, longEdge / current)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  if (width === image.width && height === image.height) return image
  const out: RgbaImage = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  drawScaled(out, image, 0, 0, width, height)
  return out
}

/**
 * Area averaging copy of `src` into a box of `dest`.
 *
 * Averaging rather than point sampling because a point sampled 1080p frame at
 * 216px aliases badly on the hard vertical edges the fixtures are built from, and
 * an aliased tile perturbs its own perceptual hash.
 */
export function drawScaled(
  dest: RgbaImage,
  src: RgbaImage,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (src.width <= 0 || src.height <= 0 || dw <= 0 || dh <= 0) return

  for (let y = 0; y < dh; y += 1) {
    const sy0 = Math.floor((y * src.height) / dh)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / dh))
    for (let x = 0; x < dw; x += 1) {
      const sx0 = Math.floor((x * src.width) / dw)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / dw))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = sy0; sy < sy1 && sy < src.height; sy += 1) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx += 1) {
          const index = (sy * src.width + sx) * 4
          r += src.data[index] ?? 0
          g += src.data[index + 1] ?? 0
          b += src.data[index + 2] ?? 0
          a += src.data[index + 3] ?? 0
          count += 1
        }
      }
      if (count === 0) continue
      const target = ((dy + y) * dest.width + (dx + x)) * 4
      if (target + 3 >= dest.data.length) continue
      dest.data[target] = Math.round(r / count)
      dest.data[target + 1] = Math.round(g / count)
      dest.data[target + 2] = Math.round(b / count)
      dest.data[target + 3] = Math.round(a / count)
    }
  }
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
