/**
 * A5: the pre-flight rule engine.
 *
 * A pure function over three inputs: the facts derived from the bytes, the locked
 * brief item's thresholds, and the branch. No clock, no randomness, no platform
 * read, no I/O. The same inputs produce the same verdict on every machine and in
 * every replay, which matters because this verdict is shown to an external creator
 * as a judgement about their work.
 *
 * **Three states, never two, plus one for inapplicable.** `pass`, `fail`,
 * `unknown`, `skipped` (`docs/06-decisions.md` D6).
 *
 * - `unknown` is absent evidence. It never blocks, and it is never rendered as a
 *   pass. A mirrorless body has no GPS receiver, so `near_branch` on a camera
 *   offload is `unknown`, and rendering that as a red cross would fail a creator
 *   for owning better equipment. That is a product defect, not a strict rule.
 * - `skipped` is "this rule could not run", which is a different fact with
 *   different UI: a photo has no duration to check, and "does not apply" reads
 *   differently to a human than "we could not tell".
 * - `fail` is evidence that a requirement was not met. Only three rules block:
 *   `orientation`, `min_duration`, `min_resolution`. A date failure is advisory
 *   because container timestamps are user editable bytes, and a codec failure
 *   raises upload priority instead of blocking, because shipping the original is
 *   the only path forward for it.
 *
 * The contract this implements is already fixed in `public/fixtures/manifest.json`
 * under `expected_preflight` and `context`, and is asserted by
 * `tests/fixtures/manifest.spec.ts`. This module satisfies that contract; it does
 * not define it. Field names, evidence strings and reason codes therefore match
 * the manifest rather than being tidier than it.
 */

import type { Support } from '@/platform/port'
import type { CaptureAtom, ContainerFacts, Dimensions, GpsAtom, ParseFailureReason } from './atoms'
import type { ExtractionFailureReason } from './extract'
import { findDuplicate, type HashedAsset } from './phash'
import type { StillFacts } from './still'

/** A.19: the pre-flight contract version. Stored on every asset. */
export const PREFLIGHT_VERSION = 2

export type PreflightStatus = 'pass' | 'fail' | 'unknown' | 'skipped'

export type PreflightRuleName =
  | 'orientation'
  | 'min_duration'
  | 'min_resolution'
  | 'capture_date'
  | 'near_branch'
  | 'duplicate'
  | 'codec_playable'

/** The seven deterministic Layer A rules, in the order the UI renders them. */
export const PREFLIGHT_RULES: readonly PreflightRuleName[] = [
  'orientation',
  'min_duration',
  'min_resolution',
  'capture_date',
  'near_branch',
  'duplicate',
  'codec_playable',
]

/** A.19: the only three rules that may refuse an upload. */
export const BLOCKING_RULES: readonly PreflightRuleName[] = ['orientation', 'min_duration', 'min_resolution']

/**
 * Every reason code the engine can emit.
 *
 * The first sixteen are the enumeration in `manifest.context.reason_codes`, which
 * is what the sixteen committed fixtures produce. The rest are the codes a
 * fixture cannot reach: no committed file is unparseable, truncated, or ambiguous
 * to the codec probe, because committing deliberately broken bytes is worse than
 * synthesising them in a test. They are listed here rather than invented at the
 * call site, and `tests/media/preflight.spec.ts` asserts that the manifest's
 * enumeration is a subset of this one, so the two cannot drift apart silently.
 */
export const PREFLIGHT_REASON_CODES = [
  // in manifest.context.reason_codes
  'below_min_duration',
  'below_min_resolution',
  'capture_date_outside_visit_window',
  'codec_unsupported_in_every_browser',
  'display_orientation_not_vertical',
  'gps_outside_branch_radius',
  'mvhd_creation_time_zero',
  'no_decoder_in_shell',
  'no_exif_parser_for_still_images',
  'no_frames_no_decoder',
  'no_gps_atom_camera_has_no_receiver',
  'no_gps_atom_metadata_stripped',
  'no_gps_atom_not_written_by_encoder',
  'no_udta_day_atom',
  'perceptual_hash_matches_earlier_asset',
  'rule_not_applicable_to_kind',
  // engine only: no committed fixture reaches these, and each is a named outcome
  'container_facts_unavailable',
  'duration_not_derivable',
  'dimensions_not_derivable',
  'display_orientation_mismatch',
  'codec_not_identifiable',
  'codec_support_unknown_in_this_runtime',
  'no_visit_date_in_brief',
  'no_branch_coordinates',
] as const

export type PreflightReasonCode = (typeof PREFLIGHT_REASON_CODES)[number]

/** Where a capture instant came from. `unknown` is a real answer and is stored as one. */
export type CapturedAtSource = CaptureAtom | 'creator_stated' | 'unknown'

export interface PreflightThresholds {
  required_orientation: 'vertical' | 'horizontal'
  min_duration_s: number
  min_short_edge_px: number
  min_long_edge_px: number
  visit_window_hours: number
  near_branch_radius_m: number
}

export interface PreflightBranch {
  branch_id: string
  lat: number | null
  lng: number | null
}

export interface PreflightContext {
  thresholds: PreflightThresholds
  /** `YYYY-MM-DD` from the collab's visit. Null when there is no visit to compare against. */
  visit_date: string | null
  branch: PreflightBranch
  /** Label recorded on the duplicate verdict, because that rule is set dependent. */
  comparison_set: string
  /** Manifest tolerance: 4 of 64 bits. */
  dhash_hamming_threshold: number
  blocking_rules?: readonly PreflightRuleName[]
}

export interface PreflightFileFacts {
  filename: string
  bytes: number
  /**
   * `File.lastModified`. Recorded as a named fallback and NEVER promoted into a
   * capture date, because a download, an AirDrop and a copy all rewrite it.
   */
  last_modified_ms: number | null
  /** Reported by the browser. Recorded, never trusted. */
  mime_type: string | null
}

export interface PreflightSubject {
  kind: 'video' | 'photo'
  file: PreflightFileFacts
  /** Null when the bytes were not ISO BMFF at all. */
  container: ContainerFacts | null
  /** Null for a video. */
  still: StillFacts | null
  /** Why the container parse produced nothing, when it did not. */
  parse_failure: ParseFailureReason | null
  /**
   * What the decode pass measured, where one ran. It outranks the container for
   * duration, because a container can lie and a decoder cannot.
   */
  decode: { duration_s: number | null; reported: Dimensions | null } | null
  /** The platform's answer for this file's codec. Media never answers this itself. */
  codec_support: Support
  /** True when no browser decodes this codec at all, which is stronger than "not here". */
  codec_unsupported_everywhere: boolean
  frames: {
    hashes: string[]
    /** Why there are no frames, when there are none. */
    failure: ExtractionFailureReason | null
  }
  /** Assets already in this delivery, in a defined order. Earliest first. */
  priors: readonly HashedAsset[]
  /** A capture date the creator typed, which outranks every container source. */
  creator_stated_captured_at_ms?: number | null
}

export interface PreflightRuleResult {
  rule: PreflightRuleName
  status: PreflightStatus
  /** The atom path or API that produced the answer, or `none`. */
  evidence: string
  /** Mandatory whenever the status is `unknown`, `skipped` or `fail`. */
  reason: PreflightReasonCode | null
  blocking: boolean
  value?: unknown
  required?: unknown
  coded?: string | null
  display?: string | null
  rotation_deg?: number | null
  captured_at_source?: CapturedAtSource
  captured_at_ms?: number | null
  visit_date?: string | null
  window_hours?: number
  hours_outside_window?: number
  mvhd_creation_time_raw?: number | null
  fallback?: 'file_mtime'
  fallback_value?: number | null
  fallback_never_promoted?: boolean
  /** Additional absent evidence, so "no creation time AND no ©day" is visible. */
  also?: PreflightReasonCode[]
  distance_m?: number | null
  radius_m?: number
  gps_atom?: GpsAtom | null
  never_blocking?: boolean
  comparison_set?: string
  duplicate_of_asset_id?: string | null
  dhash_distance?: number | null
  routes_to?: 'transcode'
  upload_priority?: 'required_for_transcode'
  runtime_dependent?: boolean
  kind?: 'video' | 'photo'
  note?: string
}

export interface PreflightRollup {
  pass: number
  fail: number
  unknown: number
  skipped: number
  blocking_fail: number
}

/** What the row shows. `unknown` here means nothing about the file was verifiable. */
export type PreflightVerdict = 'ok' | 'advisory' | 'blocked' | 'unknown'

export interface PreflightResult {
  version: number
  rules: Record<PreflightRuleName, PreflightRuleResult>
  rollup: PreflightRollup
  verdict: PreflightVerdict
  /** Which rules blocked, named, so a refusal can explain itself. */
  blocked_by: PreflightRuleName[]
  captured_at_ms: number | null
  captured_at_source: CapturedAtSource
  /** Advisory failures, so the UI can say "we noticed" without saying "we refuse". */
  advisories: PreflightRuleName[]
}

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

export function evaluatePreflight(subject: PreflightSubject, context: PreflightContext): PreflightResult {
  const blockingRules = context.blocking_rules ?? BLOCKING_RULES
  const capture = resolveCapture(subject)

  const rules: Record<PreflightRuleName, PreflightRuleResult> = {
    orientation: orientationRule(subject, context),
    min_duration: minDurationRule(subject, context),
    min_resolution: minResolutionRule(subject, context),
    capture_date: captureDateRule(subject, context, capture),
    near_branch: nearBranchRule(subject, context),
    duplicate: duplicateRule(subject, context),
    codec_playable: codecPlayableRule(subject),
  }

  const rollup: PreflightRollup = { pass: 0, fail: 0, unknown: 0, skipped: 0, blocking_fail: 0 }
  const blockedBy: PreflightRuleName[] = []
  const advisories: PreflightRuleName[] = []

  for (const name of PREFLIGHT_RULES) {
    const rule = rules[name]
    // The blocking flag is derived here and never set by a rule, so "unknown never
    // blocks" is one line of code rather than a convention seven functions keep.
    rule.blocking = rule.status === 'fail' && blockingRules.includes(name)
    rollup[rule.status] += 1
    if (rule.blocking) {
      rollup.blocking_fail += 1
      blockedBy.push(name)
    } else if (rule.status === 'fail') {
      advisories.push(name)
    }
  }

  return {
    version: PREFLIGHT_VERSION,
    rules,
    rollup,
    verdict: verdictFor(rollup),
    blocked_by: blockedBy,
    captured_at_ms: capture.at_ms,
    captured_at_source: capture.source,
    advisories,
  }
}

/**
 * The row level verdict.
 *
 * `unknown` only when nothing at all was verifiable, which is the unparseable
 * file case. A file with five passes and two unknowns is `ok`: an unknown neither
 * blocks nor downgrades, or the grey dash would quietly become a soft rejection.
 */
export function verdictFor(rollup: PreflightRollup): PreflightVerdict {
  if (rollup.blocking_fail > 0) return 'blocked'
  if (rollup.fail > 0) return 'advisory'
  if (rollup.pass === 0 && rollup.unknown > 0) return 'unknown'
  return 'ok'
}

// ---------------------------------------------------------------------------
// rule: orientation
// ---------------------------------------------------------------------------

export type OrientationValue = 'vertical' | 'horizontal' | 'square'

export function orientationOf(dimensions: Dimensions): OrientationValue {
  if (dimensions.height > dimensions.width) return 'vertical'
  if (dimensions.width > dimensions.height) return 'horizontal'
  return 'square'
}

function orientationRule(subject: PreflightSubject, context: PreflightContext): PreflightRuleResult {
  const required = context.thresholds.required_orientation
  const base: PreflightRuleResult = {
    rule: 'orientation',
    status: 'unknown',
    evidence: 'none',
    reason: null,
    blocking: false,
    required,
  }

  if (subject.kind === 'photo') {
    const coded = subject.still?.coded.value ?? null
    if (!coded) {
      return { ...base, reason: subject.still ? 'dimensions_not_derivable' : 'container_facts_unavailable' }
    }
    const value = orientationOf(coded)
    return {
      ...base,
      status: value === required ? 'pass' : 'fail',
      evidence: 'image_dims',
      reason: value === required ? null : mismatchReason(required),
      value,
      coded: dimensionText(coded),
      display: dimensionText(coded),
      rotation_deg: 0,
    }
  }

  const container = subject.container
  const coded = container?.coded.value ?? null
  const display = container?.display.value ?? null
  if (!display) {
    return {
      ...base,
      reason: container ? 'dimensions_not_derivable' : 'container_facts_unavailable',
      coded: coded ? dimensionText(coded) : null,
      display: null,
    }
  }

  // THE rule this fixture set exists for. The verdict is on the DISPLAY size,
  // which is the coded size with the sample aspect and then the rotation matrix
  // applied. `rotated_90.mp4` is coded 1920x1080 and displays 1080x1920, and a
  // parser that reads coded dimensions and stops tells a creator their correct
  // vertical footage is horizontal.
  const value = orientationOf(display)
  const rotation = container?.rotation_deg.value ?? null
  return {
    ...base,
    status: value === required ? 'pass' : 'fail',
    evidence: rotation === null ? 'coded_dims' : 'coded_dims+tkhd_matrix',
    reason: value === required ? null : mismatchReason(required),
    value,
    coded: coded ? dimensionText(coded) : null,
    display: dimensionText(display),
    rotation_deg: rotation,
  }
}

function mismatchReason(required: 'vertical' | 'horizontal'): PreflightReasonCode {
  return required === 'vertical' ? 'display_orientation_not_vertical' : 'display_orientation_mismatch'
}

// ---------------------------------------------------------------------------
// rule: min_duration
// ---------------------------------------------------------------------------

function minDurationRule(subject: PreflightSubject, context: PreflightContext): PreflightRuleResult {
  const required = context.thresholds.min_duration_s
  const base: PreflightRuleResult = {
    rule: 'min_duration',
    status: 'unknown',
    evidence: 'none',
    reason: null,
    blocking: false,
    required,
  }

  if (subject.kind === 'photo') {
    // Not applicable, not unverifiable. A grey dash for a photo's duration is noise.
    return { ...base, status: 'skipped', reason: 'rule_not_applicable_to_kind', kind: 'photo' }
  }

  const fromContainer = subject.container?.duration_s.value ?? null
  const fromDecode = subject.decode?.duration_s ?? null

  if (fromContainer === null && fromDecode === null) {
    return { ...base, reason: subject.container ? 'duration_not_derivable' : 'container_facts_unavailable' }
  }

  // Where the two disagree the decode pass wins, because the container is a
  // declaration and the decoder is a measurement. The evidence string says which
  // one decided, so a later argument about a duration is a lookup.
  let value = fromContainer
  let evidence = 'mvhd'
  let note: string | undefined
  if (fromDecode !== null) {
    if (fromContainer === null) {
      value = fromDecode
      evidence = 'decode_pass'
    } else if (Math.abs(fromDecode - fromContainer) > 0.05) {
      value = fromDecode
      evidence = 'decode_pass'
      note = `the container declared ${fromContainer}s and the decode pass measured ${fromDecode}s, so the measurement was used`
    }
  }

  const measured = value as number
  return {
    ...base,
    status: measured >= required ? 'pass' : 'fail',
    evidence,
    reason: measured >= required ? null : 'below_min_duration',
    value: measured,
    note,
  }
}

// ---------------------------------------------------------------------------
// rule: min_resolution
// ---------------------------------------------------------------------------

function minResolutionRule(subject: PreflightSubject, context: PreflightContext): PreflightRuleResult {
  const { min_short_edge_px, min_long_edge_px } = context.thresholds
  const required = `short edge >= ${min_short_edge_px}, long edge >= ${min_long_edge_px}`
  const base: PreflightRuleResult = {
    rule: 'min_resolution',
    status: 'unknown',
    evidence: 'none',
    reason: null,
    blocking: false,
    required,
  }

  const display =
    subject.kind === 'photo' ? (subject.still?.coded.value ?? null) : (subject.container?.display.value ?? null)
  if (!display) {
    return {
      ...base,
      reason:
        subject.kind === 'photo'
          ? subject.still
            ? 'dimensions_not_derivable'
            : 'container_facts_unavailable'
          : subject.container
            ? 'dimensions_not_derivable'
            : 'container_facts_unavailable',
    }
  }

  // Evaluated on edges rather than on width and height, so a landscape 1920x1080
  // clip trips `orientation` alone. A fixture that trips two rules from one defect
  // cannot tell you which rule is broken.
  const shortEdge = Math.min(display.width, display.height)
  const longEdge = Math.max(display.width, display.height)
  const ok = shortEdge >= min_short_edge_px && longEdge >= min_long_edge_px

  return {
    ...base,
    status: ok ? 'pass' : 'fail',
    evidence: evidenceForResolution(subject),
    reason: ok ? null : 'below_min_resolution',
    value: dimensionText(display),
  }
}

function evidenceForResolution(subject: PreflightSubject): string {
  if (subject.kind === 'photo') return 'image_dims'
  const coded = subject.container?.coded.value ?? null
  const presentation = subject.container?.presentation.value ?? null
  // Both are named because both were consulted: the value is the coded size with
  // the aspect and matrix applied, and the tkhd presentation size is the cross
  // check that catches a non square pixel file (D8).
  if (coded && presentation) return 'tkhd+stsd'
  if (coded) return 'stsd'
  return 'tkhd'
}

// ---------------------------------------------------------------------------
// rule: capture_date
// ---------------------------------------------------------------------------

interface ResolvedCapture {
  at_ms: number | null
  source: CapturedAtSource
  evidence: string
  /** True when the winning source carried a UTC offset, so the instant is unambiguous. */
  has_offset: boolean
}

function resolveCapture(subject: PreflightSubject): ResolvedCapture {
  const stated = subject.creator_stated_captured_at_ms ?? null
  if (stated !== null) {
    // A human who was there outranks every byte in the container.
    return { at_ms: stated, source: 'creator_stated', evidence: 'creator_stated', has_offset: true }
  }
  const container = subject.container
  if (container?.captured_at.value !== null && container?.captured_at_source) {
    return {
      at_ms: container.captured_at.value,
      source: container.captured_at_source,
      evidence: container.captured_at.evidence,
      has_offset: container.captured_at_candidates.some(
        (candidate) => candidate.source === container.captured_at_source && candidate.has_offset,
      ),
    }
  }
  return { at_ms: null, source: 'unknown', evidence: 'none', has_offset: false }
}

function captureDateRule(
  subject: PreflightSubject,
  context: PreflightContext,
  capture: ResolvedCapture,
): PreflightRuleResult {
  const base: PreflightRuleResult = {
    rule: 'capture_date',
    status: 'unknown',
    evidence: 'none',
    reason: null,
    blocking: false,
    captured_at_source: capture.source,
    visit_date: context.visit_date,
    window_hours: context.thresholds.visit_window_hours,
  }

  if (capture.at_ms === null) {
    // Absence, with the fallback recorded and never promoted. `asset.captured_at`
    // stays null and the fallback appears only in the record.
    const raw = subject.container?.mvhd_creation_time_raw ?? null
    return {
      ...base,
      reason: absentCaptureReason(subject),
      also: alsoAbsent(subject),
      value: null,
      mvhd_creation_time_raw: raw,
      fallback: 'file_mtime',
      fallback_value: subject.file.last_modified_ms,
      fallback_never_promoted: true,
      note: 'File.lastModified is recorded as a fallback and never written into captured_at. An absent creation atom does not distinguish stripped from never written, so nothing claims which happened.',
    }
  }

  if (!context.visit_date) {
    // The rule could not run: there is nothing to compare against. That is
    // `skipped`, not a pass, and not a failure of the creator's file.
    return {
      ...base,
      status: 'skipped',
      reason: 'no_visit_date_in_brief',
      value: isoSeconds(capture.at_ms),
      captured_at_ms: capture.at_ms,
    }
  }

  const window = visitWindow(context.visit_date, context.thresholds.visit_window_hours)
  const inside = window !== null && capture.at_ms >= window.from_ms && capture.at_ms < window.to_ms
  const hoursOutside =
    window === null || inside
      ? 0
      : round(
          capture.at_ms < window.from_ms
            ? (window.from_ms - capture.at_ms) / 3_600_000
            : (capture.at_ms - window.to_ms) / 3_600_000,
          3,
        )

  return {
    ...base,
    status: inside ? 'pass' : 'fail',
    evidence: capture.evidence,
    reason: inside ? null : 'capture_date_outside_visit_window',
    value: isoSeconds(capture.at_ms),
    captured_at_ms: capture.at_ms,
    mvhd_creation_time_raw: subject.container?.mvhd_creation_time_raw ?? null,
    hours_outside_window: hoursOutside,
    // C5.2.4: a container timestamp is user editable bytes, so this is a triage
    // hint and never verification. It therefore never blocks.
    note: capture.has_offset
      ? 'the source carried a UTC offset, so the instant is unambiguous. Still a hint rather than verification: container timestamps are editable.'
      : 'mvhd is defined as UTC and cameras routinely write local time into it, so the timezone is assumed. A hint rather than verification.',
  }
}

/**
 * Which absence this is.
 *
 * A zero `mvhd` creation field and a missing one are the same fact to a human, so
 * they share one code. The 1904 epoch applied to zero would report a capture date
 * of 1904-01-01, which is worse than reporting nothing.
 */
function absentCaptureReason(subject: PreflightSubject): PreflightReasonCode {
  if (subject.kind === 'photo') return 'no_exif_parser_for_still_images'
  if (!subject.container) return 'container_facts_unavailable'
  return 'mvhd_creation_time_zero'
}

function alsoAbsent(subject: PreflightSubject): PreflightReasonCode[] | undefined {
  if (subject.kind === 'photo' || !subject.container) return undefined
  const sawDay = subject.container.captured_at_candidates.some((candidate) => candidate.source === 'udta_day')
  return sawDay ? undefined : ['no_udta_day_atom']
}

export interface VisitWindow {
  from_ms: number
  to_ms: number
}

/**
 * The acceptance window around a visit.
 *
 * The visit is a day rather than an instant, so the window is the whole visit day
 * expanded by `windowHours` on each side. Implemented as arithmetic on an instant
 * rather than as a string comparison on a date, because a calendar day match
 * passes a clip shot at 23:59 on the visit day and fails one shot at 00:05 the
 * next morning, which is the same shoot.
 *
 * The day is interpreted in UTC. The branch's own timezone would be more correct
 * and is not available to this layer, and the consequence is bounded and stated: a
 * clip shot at 23:00 local in San Jose is 06:00Z the following day, which is well
 * inside a 24 hour window either way.
 */
export function visitWindow(visitDate: string, windowHours: number): VisitWindow | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(visitDate.trim())
  if (!match) return null
  const dayStart = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (!Number.isFinite(dayStart)) return null
  const dayEnd = dayStart + 86_400_000
  const margin = windowHours * 3_600_000
  return { from_ms: dayStart - margin, to_ms: dayEnd + margin }
}

// ---------------------------------------------------------------------------
// rule: near_branch
// ---------------------------------------------------------------------------

function nearBranchRule(subject: PreflightSubject, context: PreflightContext): PreflightRuleResult {
  const radius = context.thresholds.near_branch_radius_m
  const base: PreflightRuleResult = {
    rule: 'near_branch',
    status: 'unknown',
    evidence: 'none',
    reason: null,
    blocking: false,
    radius_m: radius,
    // Structural, not a convention: this rule can never block, at any status.
    never_blocking: true,
  }

  const fix = subject.container?.gps.value ?? null
  const atom = subject.container?.gps_atom ?? null

  if (!fix) {
    return {
      ...base,
      reason: absentGpsReason(subject),
      value: null,
      distance_m: null,
      gps_atom: null,
      note: 'Absence of a location atom is absence of evidence. It is never a rule violation, because a camera with no GPS receiver cannot write one.',
    }
  }

  if (context.branch.lat === null || context.branch.lng === null) {
    return {
      ...base,
      status: 'skipped',
      reason: 'no_branch_coordinates',
      value: fix,
      distance_m: null,
      gps_atom: atom,
    }
  }

  const distance = Math.round(distanceMetres(fix.lat, fix.lng, context.branch.lat, context.branch.lng))
  const inside = distance <= radius
  return {
    ...base,
    status: inside ? 'pass' : 'fail',
    evidence: gpsEvidence(atom),
    reason: inside ? null : 'gps_outside_branch_radius',
    value: fix,
    // A distance, never a boolean: a parser that returns 0m has read the branch
    // coordinate rather than the file's, and a boolean hides that.
    distance_m: distance,
    gps_atom: atom,
  }
}

/**
 * Which absence this is, inferred from the only signal available.
 *
 * The three codes differ only in the sentence a human reads, never in the status
 * and never in whether the rule blocks, and the bytes genuinely cannot distinguish
 * "stripped by a re-encode" from "never written". The inference is therefore:
 *
 * - a still: no encoder in this pipeline writes GPS into one.
 * - an all intra professional acquisition codec (ProRes): a camera body, which has
 *   no GPS receiver.
 * - anything else: a consumer file whose metadata is absent, which most often means
 *   a re-encode or an export stripped it.
 *
 * Recorded as an inference in `docs/media-pipeline.md` section 8 rather than
 * presented as a fact, and nothing in the UI may state which of the three happened.
 */
function absentGpsReason(subject: PreflightSubject): PreflightReasonCode {
  if (subject.kind === 'photo') return 'no_gps_atom_not_written_by_encoder'
  if (subject.codec_unsupported_everywhere) return 'no_gps_atom_camera_has_no_receiver'
  return 'no_gps_atom_metadata_stripped'
}

function gpsEvidence(atom: GpsAtom | null): string {
  switch (atom) {
    case 'udta_loci_3gpp':
      return 'udta_loci'
    case 'udta_c_xyz_iso6709':
      return 'udta_c_xyz'
    case 'apple_quicktime_iso6709':
      return 'apple_quicktime'
    default:
      return 'none'
  }
}

/**
 * Great circle distance in metres.
 *
 * Haversine on a spherical earth. At the scale that matters here (a 500m radius)
 * the difference from an ellipsoidal model is centimetres, well inside the 30m
 * tolerance the manifest sets and far inside consumer GPS error.
 */
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_008.8
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLng = (lng2 - lng1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

// ---------------------------------------------------------------------------
// rule: duplicate
// ---------------------------------------------------------------------------

function duplicateRule(subject: PreflightSubject, context: PreflightContext): PreflightRuleResult {
  const base: PreflightRuleResult = {
    rule: 'duplicate',
    status: 'unknown',
    evidence: 'none',
    reason: null,
    blocking: false,
    // Set dependent, so the verdict names the set it was computed over. Without
    // this, the same file is a duplicate or not depending on invisible context.
    comparison_set: context.comparison_set,
  }

  if (subject.frames.hashes.length === 0) {
    // No frames means no perceptual hash, which means dedupe genuinely cannot run.
    // Coercing this to a pass is how QC becomes a rubber stamp.
    return { ...base, reason: 'no_frames_no_decoder', duplicate_of_asset_id: null, dhash_distance: null }
  }

  const match = findDuplicate(subject.frames.hashes, subject.priors, context.dhash_hamming_threshold)
  if (!match) {
    return {
      ...base,
      status: 'pass',
      evidence: 'phash_over_delivery',
      duplicate_of_asset_id: null,
      dhash_distance: null,
    }
  }

  return {
    ...base,
    status: 'fail',
    evidence: 'phash_over_delivery',
    reason: 'perceptual_hash_matches_earlier_asset',
    duplicate_of_asset_id: match.asset_id,
    dhash_distance: match.comparison.median,
    note: 'Advisory only. A creator delivering the same shot twice is a nudge, not a rejection.',
  }
}

// ---------------------------------------------------------------------------
// rule: codec_playable
// ---------------------------------------------------------------------------

function codecPlayableRule(subject: PreflightSubject): PreflightRuleResult {
  const base: PreflightRuleResult = {
    rule: 'codec_playable',
    status: 'unknown',
    evidence: 'none',
    reason: null,
    blocking: false,
  }

  if (subject.kind === 'photo') {
    const format = subject.still?.format ?? null
    if (!subject.still?.ok) {
      return {
        ...base,
        status: subject.still?.reason === 'no_heif_parser' ? 'fail' : 'unknown',
        evidence: subject.still?.reason === 'no_heif_parser' ? 'image_decode' : 'none',
        reason: subject.still?.reason === 'no_heif_parser' ? 'no_decoder_in_shell' : 'codec_not_identifiable',
        value: format,
        runtime_dependent: true,
        routes_to: subject.still?.reason === 'no_heif_parser' ? 'transcode' : undefined,
        upload_priority: subject.still?.reason === 'no_heif_parser' ? 'required_for_transcode' : undefined,
      }
    }
    // A JPEG the header reader understood is a JPEG every browser renders. The
    // fixture manifest records this one as `mjpeg`, which is the fourcc ffmpeg
    // reports for a still, so the value follows the manifest rather than the
    // format name.
    return {
      ...base,
      status: 'pass',
      evidence: 'image_decode',
      value: format === 'jpeg' ? 'mjpeg' : format,
    }
  }

  const fourcc = subject.container?.codec_video.value ?? null
  if (!fourcc) {
    return { ...base, reason: subject.container ? 'codec_not_identifiable' : 'container_facts_unavailable' }
  }

  // The fourcc comes from `stsd`, never from the extension or the MIME type. The
  // support answer comes from the platform probe, never from this module.
  if (subject.codec_support === 'yes') {
    return { ...base, status: 'pass', evidence: 'stsd+isConfigSupported', value: fourcc }
  }
  if (subject.codec_support === 'unknown') {
    return {
      ...base,
      reason: 'codec_support_unknown_in_this_runtime',
      value: fourcc,
      runtime_dependent: true,
      note: 'The runtime answered "maybe", which is reported as unknown rather than promoted to a pass. Promoting a maybe is how a black frame reaches a manager.',
    }
  }

  // A failure that routes rather than rejects: uploading the original is the only
  // way to make progress on it, so it raises upload priority and never blocks.
  return {
    ...base,
    status: 'fail',
    evidence: 'stsd+isConfigSupported',
    reason: subject.codec_unsupported_everywhere ? 'codec_unsupported_in_every_browser' : 'no_decoder_in_shell',
    value: fourcc,
    routes_to: 'transcode',
    upload_priority: 'required_for_transcode',
    runtime_dependent: !subject.codec_unsupported_everywhere,
  }
}

// ---------------------------------------------------------------------------
// projections and helpers
// ---------------------------------------------------------------------------

/**
 * Projects a rule result down to the four fields the `asset.preflight` column
 * holds, dropping the per rule extras.
 *
 * The extras are for the UI and for a QA case; the stored row keeps the shape the
 * schema declares so a rule gaining a field cannot silently change the database.
 */
export function toStoredRule(rule: PreflightRuleResult): {
  status: PreflightStatus
  evidence: string | null
  reason: string | null
  blocking: boolean
  value?: unknown
} {
  return {
    status: rule.status,
    evidence: rule.evidence === 'none' ? null : rule.evidence,
    reason: rule.reason,
    blocking: rule.blocking,
    value: rule.value,
  }
}

export function toStoredPreflight(result: PreflightResult): Record<string, ReturnType<typeof toStoredRule>> {
  const out: Record<string, ReturnType<typeof toStoredRule>> = {}
  for (const name of PREFLIGHT_RULES) out[name] = toStoredRule(result.rules[name])
  return out
}

/**
 * Maps the parser's capture source onto the narrower enum `asset.captured_at_source`
 * declares.
 *
 * The schema calls the QuickTime `©day` case `udta` while the fixture manifest and
 * these rules call it `udta_day`. Both names are already committed in different
 * files, so this is the one place the two vocabularies meet rather than a rename
 * that would break one of them. Recorded as a finding for whoever owns the schema.
 */
export function toAssetCapturedAtSource(
  source: CapturedAtSource,
): 'mvhd' | 'apple_quicktime' | 'udta' | 'filesystem' | 'creator_stated' | 'unknown' {
  switch (source) {
    case 'udta_day':
      return 'udta'
    case 'mvhd':
    case 'apple_quicktime':
    case 'creator_stated':
      return source
    default:
      return 'unknown'
  }
}

function dimensionText(dimensions: Dimensions): string {
  return `${Math.round(dimensions.width)}x${Math.round(dimensions.height)}`
}

/**
 * ISO 8601 in UTC, seconds precision when the instant is whole.
 *
 * `new Date(explicitMilliseconds)` is a pure conversion of a value we were given,
 * which is the distinction the determinism ban draws: formatting an instant is
 * fine, inventing one is not.
 */
export function isoSeconds(atMs: number): string {
  const iso = new Date(atMs).toISOString()
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
