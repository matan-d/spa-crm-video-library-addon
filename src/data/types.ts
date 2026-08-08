/**
 * Record shapes.
 *
 * Two conventions run through all of them.
 *
 * The sync envelope is on every synced row, because the pull cursor, soft delete
 * and conflict resolution all need it and retrofitting it later means touching
 * every table. Note `server_updated_at` is the cursor, never the client's
 * `updated_at`: one skewed device clock would otherwise make rows permanently
 * invisible with no error anywhere.
 *
 * Booleans that need to be queried carry an integer mirror with an `_i` suffix,
 * because IndexedDB cannot use `true` as a key and an index on one silently
 * returns nothing. The repository writes the mirror; nothing else should.
 */

export type Iso = string

/** On every synced row. */
export interface Envelope {
  id: string
  org_id: string
  created_at: number
  updated_at: number
  /** Set by the server. Null until a row has been synced. The pull cursor reads this. */
  server_updated_at: number | null
  /** Soft delete. Hard deletes are banned: a sync bug should cost a glitch, not footage. */
  deleted_at: number | null
  rev: number
  origin_device: string
}

export type Role = 'manager' | 'editor'

export interface Org extends Envelope {
  name: string
  timezone: string
}

export interface AppUser extends Envelope {
  role: Role
  display_name: string
  email: string | null
  /** Null means every branch. An array scopes a branch manager without a new role. */
  branch_scope: string[] | null
}

export interface BranchRoom {
  key: string
  label: string
}

export interface Branch extends Envelope {
  name: string
  city: string
  address: string
  timezone: string
  lat: number | null
  lng: number | null
  rooms: BranchRoom[]
  /** Internal. Never shown to a creator. */
  do_not_shoot: string[]
  target_coverage: Record<string, number>
}

export type CreatorLifecycle = 'prospect' | 'active' | 'paused' | 'blocked'
export type ReliabilityTier = 'new' | 'proven' | 'trusted'

export interface CreatorPlatform {
  network: string
  handle: string
  followers: number | null
}

export interface Creator extends Envelope {
  display_name: string
  primary_handle: string
  lifecycle: CreatorLifecycle
  platforms: CreatorPlatform[]
  contact_email: string | null
  contact_phone: string | null
  /** AI output, advisory, never authoritative. Projections keep all of this away from editors and creators. */
  fit_score: number | null
  fit_reasons: string[]
  risk_flags: string[]
  suggested_tier: string | null
  fit_score_override: number | null
  override_reason: string | null
  reliability_tier: ReliabilityTier
  scorecard: {
    completed_collabs: number
    approval_rate: number | null
    promise_kept_rate: number | null
    brand_safety_hits: number
    consent_problems: number
  }
  /** Internal notes. Blunt by design, and never leaves the manager surface. */
  notes: string | null
}

export type CollabStage =
  | 'source'
  | 'vet'
  | 'book'
  | 'brief'
  | 'visit'
  | 'delivered'
  | 'library'
  | 'closed'

export type CollabOutcome = 'open' | 'completed' | 'ghosted' | 'cancelled'

export interface Collab extends Envelope {
  creator_id: string
  branch_id: string
  owner_user_id: string
  stage: CollabStage
  stage_entered_at: number
  visit_at: number | null
  vip_tier: string | null
  comp_value_usd: number | null
  outcome: CollabOutcome
  /** Snapshotted at acceptance, never a pointer, so editing the standard terms cannot retroactively change what somebody agreed to. */
  usage_terms_text: string | null
  consent_text_version: string | null
  consent_accepted_at: number | null
  notes: string | null
}

export type BriefStatus = 'draft' | 'locked' | 'superseded'

export interface Brief extends Envelope {
  collab_id: string
  status: BriefStatus
  version: number
  locked_at: number | null
  /** The loop link. Cannot be reconstructed retroactively. */
  gap_scan_id: string | null
  tech_specs_key: string | null
  usage_terms_key: string | null
  edited_fields: string[]
}

export interface BriefItem extends Envelope {
  brief_id: string
  seq: number
  instruction: string
  shot_type: string | null
  room: string | null
  min_takes: number
  /** The other half of the loop link. Two columns that make the product's headline claim measurable. */
  origin_gap_id: string | null
}

export type DeliveryState = 'open' | 'submitted' | 'reviewed'

export interface Delivery extends Envelope {
  collab_id: string
  state: DeliveryState
  submitted_at: number | null
  /** The resolved policy, recorded because it shapes the stored artefacts. */
  ingest_policy: { tier: string; frame_long_edge: number; jpeg_quality: number } | null
  nudge_draft_text: string | null
  nudge_sent_at: number | null
}

export type AssetKind = 'video' | 'photo' | 'audio'
export type MediaState = 'bytes_local' | 'bytes_remote' | 'bytes_absent'
export type DerivativeState = 'none' | 'partial' | 'ready'
export type ReviewStatus = 'pending' | 'approved' | 'rejected'
export type AiProvenance = 'live' | 'replay' | 'mock' | 'mixed' | 'none'
export type PreflightStatus = 'pass' | 'fail' | 'unknown' | 'skipped'

export interface PreflightRule {
  status: PreflightStatus
  evidence: string | null
  /** Required whenever the status is unknown or skipped. */
  reason: string | null
  blocking: boolean
  value?: unknown
}

export interface Asset extends Envelope {
  kind: AssetKind
  delivery_id: string
  collab_id: string
  branch_id: string

  // band 1: measured facts about the file. Deterministic, never model output.
  filename: string
  bytes: number
  duration_s: number | null
  coded_width: number | null
  coded_height: number | null
  rotation_deg: number | null
  codec_video: string | null
  has_audio: boolean | null
  captured_at: number | null
  captured_at_source: 'mvhd' | 'apple_quicktime' | 'udta' | 'filesystem' | 'creator_stated' | 'unknown'
  gps: { lat: number; lng: number } | null

  // band 1b: what this runtime could do with it
  client_decodable: boolean | null
  needs_transcode: boolean
  probe_result: string | null

  // band 2: pre-flight, four-valued per rule
  preflight_version: number
  preflight: Record<string, PreflightRule>

  // band 3: AI projections. All null when no contact sheet exists, never guessed.
  ai_description: string | null
  ai_shot_type: string | null
  ai_room: string | null
  ai_subjects: string[]
  ai_quality_score: number | null
  ai_framing_score: number | null
  ai_confidence: number | null
  ai_brand_safety: 'clear' | 'review' | 'blocked' | null
  ai_matched_brief_item_id: string | null
  ai_provenance: AiProvenance

  // band 4: human curation. Monotonic and safety-biased under conflict.
  review_status: ReviewStatus
  is_published: boolean
  is_published_i: number
  confirmed_brief_item_id: string | null
  is_hero: boolean
  /** Blunt internal text. Never shown to a creator. */
  reject_reason_text: string | null
  /** What the creator sees instead. */
  creator_facing_note: string | null
  is_exemplar: boolean
  is_exemplar_i: number
  exemplar_note: string | null

  // band 5: storage and usage
  media_state: MediaState
  derivative_state: DerivativeState
  bytes_key: string | null
  poster_key: string | null
  sheet_key: string | null
  phash_primary: string | null
  frame_hashes: string[]
  used_count: number
  download_count: number

  /** Denormalised so the library can show a credit without the editor reading `creator`. */
  creator_credit: string
  /** Projection of the parent collab's snapshotted terms, so clearance is a facet rather than a join. */
  usage_scope: string | null
}

export type TagSource = 'ai' | 'human'

export interface Tag extends Envelope {
  asset_id: string
  term: string
  source: TagSource
  confidence: number | null
  /** Which run produced it, for provenance and for re-running. */
  ai_run_id: string | null
  /** Append-only: a removed tag is marked, never deleted, because the disagreement is the eval set. */
  removed_at: number | null
  rejected_by_human: boolean
}

export type AiProvider = 'live' | 'replay' | 'mock'

export type AiRunKind =
  | 'vet'
  | 'brief_gen'
  | 'vision_tag'
  | 'brief_match'
  | 'search_parse'
  | 'gap_scan'
  | 'nudge_draft'

export interface AiRun extends Envelope {
  subject_type: string
  subject_id: string
  kind: AiRunKind
  provider: AiProvider
  provider_detail: string | null
  /** Null for a mock run, always. The guard enforces it. */
  model_id: string | null
  /** What a mock imitates. Never what produced it. */
  simulated_model_id: string | null
  fixture_id: string | null
  effort: 'low' | 'medium' | 'high' | null
  prompt_key: string
  prompt_version: string
  prompt_hash: string
  input_hash: string
  model_key: string
  schema_key: string
  schema_version: string
  schema_valid: boolean
  latency_ms: number | null
  latency_source: 'measured' | 'simulated'
  status: 'ok' | 'error' | 'refused'
  error_code: string | null
  /** Kept verbatim so a run can be re-projected without a new call. */
  output_json: unknown
  is_current: boolean
  is_current_i: number
  superseded_by_run_id: string | null
}

export type ReviewMethod = 'manual' | 'batch' | 'auto_threshold' | 'sampled_qa'

export interface ReviewAction extends Envelope {
  asset_id: string
  session_id: string | null
  actor_user_id: string
  decision: 'approved' | 'rejected' | 'skipped' | 'unpublished'
  /** Without this, every scorecard computed from review_status becomes meaningless the day batch approve ships. */
  method: ReviewMethod
  /** Whether this human decision rested on simulated AI evidence. */
  ai_provenance_at_decision: AiProvenance | null
  note: string | null
}

export type GapStatus = 'open' | 'closed' | 'dismissed'

export interface Gap extends Envelope {
  /** Null for a gap born from an editor request rather than a scan. */
  gap_scan_id: string | null
  branch_id: string | null
  /** Keyed by signature, not id, so a dismissal survives a rescan. */
  cell_signature: string
  facets: Record<string, string>
  score: number
  severity: 'low' | 'medium' | 'high' | 'critical'
  status: GapStatus
  signals: { source: string; weight: number; detail?: string }[]
  closing_asset_ids: string[]
}

export interface OutboxEntry {
  seq?: number
  store: string
  row_id: string
  op: 'put' | 'patch' | 'soft_delete'
  /** Only the changed fields for a patch, so two devices editing different fields do not collide. */
  patch: Record<string, unknown>
  base_rev: number
  queued_at: number
  state: 'pending' | 'sent' | 'failed'
  attempts: number
  last_error: string | null
}

export interface SyncState {
  store: string
  /** Cursor into the server's clock, never the client's. */
  cursor_server_updated_at: number | null
  cursor_id: string | null
  last_pulled_at: number | null
  last_pushed_at: number | null
}

/** Every record the repository can hold, keyed by store name. */
export interface RecordMap {
  org: Org
  app_user: AppUser
  branch: Branch
  creator: Creator
  collab: Collab
  brief: Brief
  brief_item: BriefItem
  delivery: Delivery
  asset: Asset
  tag: Tag
  ai_run: AiRun
  review_action: ReviewAction
  gap: Gap
}
