/**
 * A6: the state machine for bytes.
 *
 * Two states, orthogonal, and the orthogonality is what makes the product's
 * hardest case expressible at all:
 *
 * - `media_state` is where the original bytes are: `bytes_local`, `bytes_remote`,
 *   `bytes_absent`.
 * - `derivative_state` is whether the small derived things exist: `none`,
 *   `partial`, `ready`.
 *
 * "Real metadata, no pixels, permanently" is `bytes_local` plus `none`, which is
 * exactly `hevc.mov` on a Windows laptop with no HEVC decoder. Collapsing the two
 * into one status would force that asset to be described either as broken (it is
 * not, the file is fine and the metadata is complete) or as ready (it is not,
 * there is nothing to look at). Both would be lies, and the second one is the
 * dangerous one, because a manager would be asked to approve something nobody can
 * see.
 *
 * The transport gate lives here rather than in a caller. Bytes are the last thing
 * that moves: review happens on a contact sheet plus metadata at roughly 170KB per
 * clip against roughly 150MB of original, and an original only moves when somebody
 * decided it should. A caller side check would hold for exactly as long as nobody
 * added a second call site.
 */

import type { PreflightResult, PreflightRuleName } from './preflight'
import type { ExtractionResult } from './extract'

/** Matches `asset.media_state` in `src/data/types.ts`. */
export type MediaState = 'bytes_local' | 'bytes_remote' | 'bytes_absent'

/** Matches `asset.derivative_state` in `src/data/types.ts`. */
export type DerivativeState = 'none' | 'partial' | 'ready'

/**
 * Who produced the derivatives.
 *
 * `browser` is the only one this build can be. `desktop_shell` and `server` exist
 * because the HEVC hole closes only when one of them does, and a null producer on a
 * `ready` state would be unattributable.
 */
export type DerivativeProducer = 'browser' | 'desktop_shell' | 'server' | null

/** Why the bytes are not local, when they are not. Each has different UI. */
export type MediaAbsenceReason =
  | 'over_local_byte_budget'
  | 'no_local_byte_store'
  | 'byte_write_failed'
  | 'not_offered_by_creator'
  | 'evicted_under_quota_pressure'

export interface MediaStateDecision {
  state: MediaState
  reason: MediaAbsenceReason | null
  /** Bytes we declined to keep, so the storage panel can explain a number. */
  declined_bytes: number | null
  note: string | null
}

export interface MediaStateInputs {
  file_bytes: number
  /** From `deriveIngestPolicy()`. Budgeted in bytes, never in clip count. */
  max_local_original_bytes: number
  /** Bytes already held locally for this profile. */
  used_local_bytes: number
  /** False when the runtime has no OPFS at all. */
  byte_store_available: boolean
  /** True once a write actually completed. */
  written_locally: boolean
  /** True when the original is known to exist on a server. */
  present_remotely: boolean
}

/**
 * Where the original is, decided from measured facts rather than from intent.
 *
 * The budget is checked against the file's own size plus what is already held,
 * because one ProRes clip is 1.8GB and a budget expressed in clips would let a
 * single file blow a device's quota while reporting two of twenty used.
 */
export function deriveMediaState(inputs: MediaStateInputs): MediaStateDecision {
  if (inputs.written_locally) {
    return { state: 'bytes_local', reason: null, declined_bytes: null, note: null }
  }
  if (!inputs.byte_store_available) {
    return {
      state: inputs.present_remotely ? 'bytes_remote' : 'bytes_absent',
      reason: 'no_local_byte_store',
      declined_bytes: inputs.file_bytes,
      note: 'This runtime has no origin private file system, so originals cannot be kept on the device. Derivatives still work.',
    }
  }
  if (inputs.used_local_bytes + inputs.file_bytes > inputs.max_local_original_bytes) {
    return {
      state: inputs.present_remotely ? 'bytes_remote' : 'bytes_absent',
      reason: 'over_local_byte_budget',
      declined_bytes: inputs.file_bytes,
      note: `Keeping this original would take local storage past the ${inputs.max_local_original_bytes} byte budget for this tier, so the contact sheet was kept and the original was not.`,
    }
  }
  return {
    state: inputs.present_remotely ? 'bytes_remote' : 'bytes_absent',
    reason: 'byte_write_failed',
    declined_bytes: inputs.file_bytes,
    note: null,
  }
}

export interface DerivativeStateDecision {
  state: DerivativeState
  producer: DerivativeProducer
  /**
   * The manifest's vocabulary for the same fact. `client_derived` says both that
   * derivatives exist and that this device made them, which is one word the schema
   * splits across `derivative_state` and a producer.
   */
  manifest_label: 'client_derived' | 'none' | 'partial'
  /** Why there are no pixels, when there are none. Never null on `none`. */
  reason: string | null
  /** Set only where a real sheet exists. */
  extractor_path: ExtractionResult['path'] | null
  extractor_version: number | null
  policy_tier: ExtractionResult['policy_tier'] | null
}

/**
 * Whether derivatives exist, read off the extraction result rather than assumed.
 *
 * `partial` is a real outcome and not a hedge: frames decoded and the sheet
 * encoded but the poster did not, which leaves a reviewable clip with a broken
 * grid tile. Saying so lets the poster be re-derived without redoing the decode.
 *
 * A placeholder never produces anything but `none`. That is the no fabrication
 * rule at the state layer: the interface may draw a grey tile, and the record must
 * not claim a derivative exists.
 */
export function deriveDerivativeState(extraction: ExtractionResult): DerivativeStateDecision {
  if (!extraction.sheet) {
    return {
      state: 'none',
      producer: null,
      manifest_label: 'none',
      reason: extraction.reason ?? 'no_frames_decoded',
      extractor_path: null,
      extractor_version: null,
      policy_tier: null,
    }
  }
  const complete = extraction.poster !== null
  return {
    state: complete ? 'ready' : 'partial',
    producer: 'browser',
    manifest_label: complete ? 'client_derived' : 'partial',
    reason: complete ? null : 'poster_encode_failed',
    extractor_path: extraction.path,
    extractor_version: extraction.extractor_version,
    policy_tier: extraction.policy_tier,
  }
}

// ---------------------------------------------------------------------------
// the transport gate
// ---------------------------------------------------------------------------

export type TransferState = 'not_queued' | 'queued' | 'in_flight' | 'transferred' | 'failed'

export type TransferTransition = 'queue' | 'start' | 'complete' | 'fail' | 'requeue'

export type TransferRefusalReason =
  | 'preflight_not_run'
  | 'preflight_blocking_fail'
  | 'review_has_not_moved'
  | 'no_bytes_to_send'
  | 'already_transferred'
  | 'illegal_transition'

export type UploadPriority = 'normal' | 'required_for_transcode'

export interface TransferGateInputs {
  preflight: PreflightResult | null
  media_state: MediaState
  /**
   * True once a human decided something about this clip: approved, rejected, or
   * explicitly asked for the original. Review moving on is a gate, not a courtesy.
   */
  review_has_moved: boolean
  /**
   * True when the clip has no derivatives and cannot get any here, so review
   * cannot move until the bytes do. This is the one sanctioned way past the review
   * gate, and without it the HEVC asset deadlocks: no sheet without a transcode,
   * no transcode without the bytes, no bytes without a review, no review without a
   * sheet.
   */
  needs_transcode: boolean
}

export interface TransferDecision {
  allowed: boolean
  reason: TransferRefusalReason | null
  /** Named rules, so a refusal explains itself instead of saying no. */
  blocked_by: PreflightRuleName[]
  priority: UploadPriority
  note: string | null
}

export function canTransferOriginal(inputs: TransferGateInputs): TransferDecision {
  const priority: UploadPriority = inputs.needs_transcode ? 'required_for_transcode' : 'normal'

  if (inputs.media_state !== 'bytes_local') {
    return {
      allowed: false,
      reason: 'no_bytes_to_send',
      blocked_by: [],
      priority,
      note: `the original is ${inputs.media_state}, so there is nothing on this device to send`,
    }
  }
  if (!inputs.preflight) {
    return {
      allowed: false,
      reason: 'preflight_not_run',
      blocked_by: [],
      priority,
      note: 'pre-flight has not run, and an unassessed original is exactly what this gate exists to hold back',
    }
  }
  if (inputs.preflight.rollup.blocking_fail > 0) {
    return {
      allowed: false,
      reason: 'preflight_blocking_fail',
      blocked_by: [...inputs.preflight.blocked_by],
      priority,
      note: `refused by ${inputs.preflight.blocked_by.join(', ')}`,
    }
  }
  if (!inputs.review_has_moved && !inputs.needs_transcode) {
    return {
      allowed: false,
      reason: 'review_has_not_moved',
      blocked_by: [],
      priority,
      note: 'review happens on the contact sheet, so the original waits for a human to ask for it',
    }
  }
  return {
    allowed: true,
    reason: null,
    blocked_by: [],
    priority,
    note: inputs.needs_transcode
      ? 'no decoder here, so shipping the original is the only way this clip can ever be reviewed'
      : null,
  }
}

const LEGAL_TRANSITIONS: Record<TransferState, Partial<Record<TransferTransition, TransferState>>> = {
  not_queued: { queue: 'queued' },
  queued: { start: 'in_flight', fail: 'failed' },
  in_flight: { complete: 'transferred', fail: 'failed' },
  failed: { requeue: 'queued' },
  transferred: {},
}

export interface TransferStepResult {
  state: TransferState
  refused: boolean
  reason: TransferRefusalReason | null
  decision: TransferDecision | null
}

/**
 * The only way a transfer state changes.
 *
 * The gate is evaluated inside the transition rather than before it, so a caller
 * cannot queue an original by writing the state directly. An illegal transition is
 * refused and named rather than ignored, because a silently dropped transition
 * turns into an upload that never happens and never explains itself.
 */
export function applyTransfer(
  state: TransferState,
  transition: TransferTransition,
  inputs: TransferGateInputs,
): TransferStepResult {
  const next = LEGAL_TRANSITIONS[state][transition]
  if (!next) {
    return {
      state,
      refused: true,
      reason: state === 'transferred' ? 'already_transferred' : 'illegal_transition',
      decision: null,
    }
  }
  if (transition === 'queue' || transition === 'requeue') {
    const decision = canTransferOriginal(inputs)
    if (!decision.allowed) {
      return { state, refused: true, reason: decision.reason, decision }
    }
    return { state: next, refused: false, reason: null, decision }
  }
  return { state: next, refused: false, reason: null, decision: null }
}

/**
 * What review costs in bytes, which is the claim the whole tiering rests on.
 *
 * Counted from the artefacts rather than estimated, so the number in the demo is
 * the number the pipeline produced.
 */
export function reviewTransferBytes(
  assets: readonly { sheet_bytes: number | null; poster_bytes: number | null }[],
): { total_bytes: number; per_asset_bytes: number; assets_with_derivatives: number } {
  let total = 0
  let counted = 0
  for (const asset of assets) {
    const bytes = (asset.sheet_bytes ?? 0) + (asset.poster_bytes ?? 0)
    if (bytes > 0) counted += 1
    total += bytes
  }
  return {
    total_bytes: total,
    per_asset_bytes: counted === 0 ? 0 : Math.round(total / counted),
    assets_with_derivatives: counted,
  }
}
