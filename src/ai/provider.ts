/**
 * The AI seam: one interface, three implementations, one meta shape.
 *
 * `live`, `replay` and `mock` are interchangeable to every caller. Nothing above
 * this file may branch on which one is running, and nothing below it may lie about
 * which one produced a result.
 *
 * ## Why `meta` is as big as it is
 *
 * Every field on `AiMeta` maps to a column on `ai_run`. The provider returns it
 * rather than the caller assembling it, because the provider is the only thing
 * that actually knows the truth about provenance: whether a model was called, which
 * model id came back, which fixture was read, whether the latency was measured or
 * invented. A caller filling that in from the current mode is the exact bug the
 * `latency_source` and `simulated_model_id` columns exist to prevent.
 *
 * ## Errors are a closed taxonomy, not strings
 *
 * Callers branch on `reason`. Every reason below has a distinct UI state, because
 * "AI failed" is not something an editor or a manager can act on. A refusal means
 * "needs manual review"; a rate limit means "queued, retrying"; a payload that is
 * too large means "the sheet was not downscaled, this is our bug"; no stills means
 * "this clip was never decoded, and we will not guess".
 */

import type { AiProvider as AiProviderKind, AiRunKind } from '@/data/types'
import type { CapabilityKey } from './schemas'
import type { ValidationError } from './validate'
import type {
  LightTerm,
  MatchVerdict,
  Orientation,
  QualityBucket,
  ReviewFlag,
  RiskFlagCode,
  Room,
  SearchOrdering,
  ShotType,
  Subject,
  VetBand,
  VetCitableField,
  Vibe,
  NudgeTone,
} from './taxonomy'

/** `AiRunKind` and `CapabilityKey` are the same seven names, asserted in tests. */
export type { CapabilityKey }

export type Effort = 'low' | 'medium' | 'high'

/**
 * Everything `ai_run` needs, produced by the implementation that did the work.
 *
 * `model_key` and `model_id` are not the same thing and must not be merged.
 * `model_key` is a cache dimension: it is non-null for every provider so the cache
 * index `(input_hash, prompt_hash, model_key)` always has three usable parts.
 * `model_id` is a provenance claim: it is null for mock, always, because a mock run
 * asserting a model produced it is the one dishonest state this whole layer exists
 * to prevent.
 */
export interface AiMeta {
  kind: AiRunKind
  provider: AiProviderKind
  /** 'claude-via-netlify' | 'fixture' | 'authored-fixture-v1' | 'synthetic-v1' */
  provider_detail: string
  /** Null for mock, always. */
  model_id: string | null
  /** What a mock imitates. Null for live and replay. */
  simulated_model_id: string | null
  fixture_id: string | null
  fixture_hash: string | null
  effort: Effort | null
  prompt_key: string
  prompt_version: string
  prompt_hash: string
  input_hash: string
  /** Cache dimension. Never null, even for mock. See the note above. */
  model_key: string
  schema_key: string
  schema_version: string
  schema_valid: boolean
  latency_ms: number | null
  /** Simulated latency is data. It must never be averaged into real performance numbers. */
  latency_source: 'measured' | 'simulated'
  status: 'ok' | 'error' | 'refused'
  error_code: string | null
}

export interface AiResult<T> {
  output: T
  meta: AiMeta
}

export type AiErrorReason =
  /** The response did not validate against this capability's schema. */
  | 'invalid_output'
  /** stop_reason: 'refusal'. HTTP 200 with a policy decline. Needs manual review, not a retry. */
  | 'refused'
  /** stop_reason: 'max_tokens'. Structured output guarantees shape only on completion. */
  | 'truncated'
  | 'timeout'
  | 'rate_limited'
  /** The encoded image exceeded our own ceiling. Our bug, not the platform's. */
  | 'payload_too_large'
  /** The function's daily ceiling. Degrade to recorded mode, do not retry. */
  | 'budget_exhausted'
  /** Transport failed before any response. Includes offline. */
  | 'network'
  /** No key configured, which is the shipped state of this build. */
  | 'not_configured'
  /** Replay was asked for a key that no committed fixture carries. */
  | 'fixture_missing'
  /** The asset has no contact sheet. There is nothing to look at, so there is no answer. */
  | 'no_stills'
  /** The caller aborted, e.g. a role switch or a navigation. */
  | 'cancelled'

/**
 * The one error type across all three implementations.
 *
 * `retryable` is on the error rather than derived by callers, so retry policy
 * lives with the taxonomy instead of being re-guessed at each call site.
 */
export class AiError extends Error {
  readonly reason: AiErrorReason
  readonly retryable: boolean
  readonly validationErrors: readonly ValidationError[]
  /** As much of the run metadata as was known when it failed. A failed run is still a run. */
  readonly meta: Partial<AiMeta>
  /**
   * The response that failed, kept verbatim.
   *
   * A validation failure with nothing to look at is unresolvable after the fact,
   * so the malformed payload travels with the error and reaches
   * `ai_run.output_json` alongside `schema_valid: false`. Undefined when the
   * failure happened before any payload existed, which is every transport error.
   */
  readonly rawOutput: unknown

  constructor(
    reason: AiErrorReason,
    message: string,
    options: {
      meta?: Partial<AiMeta>
      validationErrors?: readonly ValidationError[]
      rawOutput?: unknown
      cause?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'AiError'
    this.reason = reason
    this.retryable = RETRYABLE.has(reason)
    this.validationErrors = options.validationErrors ?? []
    this.meta = options.meta ?? {}
    this.rawOutput = options.rawOutput
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * A refusal is not retryable and neither is a truncation at the same max_tokens:
 * retrying either one just spends money to fail identically. `invalid_output` is
 * retryable exactly once, which the caller enforces, not this flag.
 */
const RETRYABLE = new Set<AiErrorReason>(['rate_limited', 'timeout', 'network', 'invalid_output'])

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError
}

// ---------------------------------------------------------------------------
// capability inputs and outputs
// ---------------------------------------------------------------------------

export interface VetInput {
  creator_id: string
  display_name: string
  primary_handle: string
  platforms: { network: string; handle: string; followers: number | null }[]
  /** Untrusted creator text. Fenced in the prompt, never treated as instruction. */
  application_note: string | null
  prior_collabs: number
  scorecard_summary: string | null
  /** The band computed in code. The model may only pick inside it. */
  allowed_tiers: string[]
  branch_city: string
}

export interface VetOutput {
  band: VetBand
  score: number | null
  reasons: { claim: string; cited_field: VetCitableField; direction: 'for' | 'against' }[]
  risk_flags: { code: RiskFlagCode; evidence_quote: string | null; severity: 'low' | 'medium' | 'high' }[]
  suggested_tier: string | null
  tier_rationale: string | null
  caveat: string | null
}

export interface BriefGenInput {
  branch_slug: string
  branch_rooms: string[]
  /** Internal. Never shown to a creator, but the model must respect it. */
  do_not_shoot: string[]
  target_item_count: number
  gaps: { cell_signature: string; facets: string; severity: string }[]
  creator_style_note: string | null
  vip_tier: string | null
}

export interface BriefGenItem {
  seq: number
  instruction: string
  shot_type: ShotType | null
  room: Room | null
  subjects: Subject[]
  min_takes: number
  origin_gap_signature: string | null
  why: string
  feasibility_doubt: string | null
}

export interface BriefGenOutput {
  items: BriefGenItem[]
  caption_angles: string[]
  possible_overlaps: { seq_a: number; seq_b: number; note: string }[]
}

export interface VisionTagInput {
  asset_id: string
  /**
   * The composite contact sheet, base64. One image per request, capped well under
   * the platform ceiling. Absent means there is nothing to analyse, and the
   * pipeline must refuse rather than call.
   */
  sheet_base64: string
  sheet_media_type: 'image/jpeg' | 'image/png' | 'image/webp'
  frames_seen: number
  duration_s: number | null
  orientation: Orientation | null
  branch_rooms: string[]
}

export interface VisionTagOutput {
  description: string
  shot_type: ShotType
  room: Room | null
  subjects: Subject[]
  light: LightTerm
  vibe: Vibe | null
  tags: { term: string; confidence: number }[]
  framing: QualityBucket
  framing_reason: string | null
  light_quality: QualityBucket
  light_reason: string | null
  review_flags: { flag: ReviewFlag; note: string | null }[]
  text_on_screen: boolean
  frames_seen: number
  overall_confidence: number
  uncertainty: string | null
}

export interface BriefMatchInput {
  brief_item_id: string
  brief_item_instruction: string
  brief_item_shot_type: string | null
  brief_item_room: string | null
  candidates: {
    asset_id: string
    description: string
    shot_type: string | null
    room: string | null
    subjects: string[]
    duration_s: number | null
  }[]
}

export interface BriefMatchOutput {
  matches: {
    brief_item_id: string
    asset_id: string
    verdict: MatchVerdict
    confidence: number
    evidence: string
  }[]
  unmatched_asset_ids: string[]
  notes: string | null
}

export interface SearchParseInput {
  query_text: string
  branch_slugs: string[]
}

export interface SearchParseOutput {
  filters: {
    subjects: Subject[]
    shot_types: ShotType[]
    rooms: Room[]
    light: LightTerm[]
    vibes: Vibe[]
    orientation: Orientation | null
    branch_slug: string | null
    duration_min_s: number | null
    duration_max_s: number | null
  }
  mappings: { raw: string; facet: string; term: string; confidence: number }[]
  unmapped: string[]
  ranking: { order_by: SearchOrdering; boost_terms: string[] }
}

export interface GapScanInput {
  gap_scan_id: string
  /** Every number here was computed before the call. The model only phrases. */
  cells: { cell_signature: string; facets: string; severity: string; signal_summary: string }[]
  unmapped_query_tokens: string[]
}

export interface GapScanOutput {
  cells: {
    cell_signature: string
    title: string
    shot_instruction: string
    rationale: string
    cluster_label: string | null
  }[]
  vocabulary_candidates: string[]
}

export interface NudgeDraftInput {
  collab_id: string
  creator_display_name: string
  branch_city: string
  visit_date_text: string
  /** Human-confirmed missing only. A nudge about an unconfirmed gap is a false accusation. */
  missing_items: { brief_item_id: string; instruction: string }[]
  delivered_count: number
  promised_count: number
  deadline_text: string | null
  tone_hint: NudgeTone | null
}

export interface NudgeDraftOutput {
  subject_line: string
  body_text: string
  tone: NudgeTone
  missing_item_ids: string[]
  mentions_deadline: boolean
  warnings: string[]
}

/** Per-capability input and output types, so a call site cannot mix them up. */
export interface CapabilityIo {
  vet: { input: VetInput; output: VetOutput }
  brief_gen: { input: BriefGenInput; output: BriefGenOutput }
  vision_tag: { input: VisionTagInput; output: VisionTagOutput }
  brief_match: { input: BriefMatchInput; output: BriefMatchOutput }
  search_parse: { input: SearchParseInput; output: SearchParseOutput }
  gap_scan: { input: GapScanInput; output: GapScanOutput }
  nudge_draft: { input: NudgeDraftInput; output: NudgeDraftOutput }
}

export interface AiCallOptions {
  /**
   * Cancellation, present from the start.
   *
   * F1.3: a role switch or a navigation landing mid-request is how a result gets
   * attached to the wrong clip or the wrong deal. Every implementation honours this,
   * including mock, because a cancellation path that only exists on the live provider
   * is a cancellation path that has never run.
   */
  signal?: AbortSignal
}

export interface BriefGenOptions extends AiCallOptions {
  /**
   * Called per item as it arrives.
   *
   * Brief generation is the one capability whose output is a list a human watches
   * assemble, so it is the one capability where streaming is the product rather
   * than an optimisation. The mock streams for real, because a streaming UI
   * developed against a mock that resolves an array has never been exercised.
   */
  onItem?: (item: BriefGenItem, index: number) => void
}

/**
 * The provider interface. One method per capability.
 *
 * Not a single `run(kind, input)` method, deliberately: a generic method forces
 * every call site to cast, and a cast is where a `vision_tag` input reaches the
 * `vet` schema and nothing complains until runtime.
 */
export interface AiProvider {
  readonly kind: AiProviderKind
  /** For the badge panel and the Data Health surface. Never used to make a claim about a row. */
  readonly detail: string

  vet(input: VetInput, options?: AiCallOptions): Promise<AiResult<VetOutput>>
  brief_gen(input: BriefGenInput, options?: BriefGenOptions): Promise<AiResult<BriefGenOutput>>
  vision_tag(input: VisionTagInput, options?: AiCallOptions): Promise<AiResult<VisionTagOutput>>
  brief_match(input: BriefMatchInput, options?: AiCallOptions): Promise<AiResult<BriefMatchOutput>>
  search_parse(input: SearchParseInput, options?: AiCallOptions): Promise<AiResult<SearchParseOutput>>
  gap_scan(input: GapScanInput, options?: AiCallOptions): Promise<AiResult<GapScanOutput>>
  nudge_draft(input: NudgeDraftInput, options?: AiCallOptions): Promise<AiResult<NudgeDraftOutput>>
}

/** Throws `cancelled` if the caller has already aborted. Called at every await boundary. */
export function throwIfAborted(signal: AbortSignal | undefined, meta: Partial<AiMeta>): void {
  if (signal?.aborted) {
    throw new AiError('cancelled', 'The caller aborted this request before it completed.', { meta })
  }
}
