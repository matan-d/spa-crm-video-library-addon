/**
 * Visibility, in exactly one place.
 *
 * Three things are enforced on every read, in this order: a table allowlist per
 * role, a mandatory predicate per table per role, and a field projection per role.
 * Writes go through the same layer.
 *
 * Why it is one file rather than checks in components: the next component to be
 * written will forget, and the leak that results is a creator reading their own
 * fit score. Putting it here means a field added later is invisible by default,
 * and the scope test fails until somebody deliberately allowlists it. That
 * failure is the feature.
 *
 * The projection functions are also the written specification that the future
 * Supabase policies and `security definer` RPCs implement. Same allowlists, two
 * runtimes, written once.
 *
 * In this build the scope is client side and is therefore not security. Anyone
 * with devtools can bypass it. Its value now is that the boundary exists in one
 * file with a written contract, so real enforcement replaces it rather than being
 * retrofitted around it. The thinking doc says exactly that, in those words.
 */

import type { StoreName } from './schema'
import type { Asset, Collab, Creator, Role } from './types'

export type SessionKind = 'manager' | 'editor' | 'creator_token'

export interface Session {
  kind: SessionKind
  org_id: string
  /** Null for a creator, who has no account. */
  user_id: string | null
  role: Role | null
  /** Null means every branch. */
  branch_scope: string[] | null
  /** Only set for a creator token session. */
  collab_id: string | null
  token_id: string | null
}

export function managerSession(input: {
  org_id: string
  user_id: string
  branch_scope?: string[] | null
}): Session {
  return {
    kind: 'manager',
    org_id: input.org_id,
    user_id: input.user_id,
    role: 'manager',
    branch_scope: input.branch_scope ?? null,
    collab_id: null,
    token_id: null,
  }
}

export function editorSession(input: { org_id: string; user_id: string }): Session {
  return {
    kind: 'editor',
    org_id: input.org_id,
    user_id: input.user_id,
    role: 'editor',
    // An editor sees the library across every branch. The pooled library is the
    // product, so branch scoping an editor would fight the thesis.
    branch_scope: null,
    collab_id: null,
    token_id: null,
  }
}

export function creatorTokenSession(input: {
  org_id: string
  collab_id: string
  token_id: string
}): Session {
  return {
    kind: 'creator_token',
    org_id: input.org_id,
    user_id: null,
    role: null,
    branch_scope: null,
    collab_id: input.collab_id,
    token_id: input.token_id,
  }
}

// ---------------------------------------------------------------------------
// table allowlists
// ---------------------------------------------------------------------------

export type Access = 'r' | 'w' | 'rw'

/**
 * What each session kind may touch at all.
 *
 * Table invisibility beats column filtering: an editor that cannot read `creator`
 * or `collab` cannot leak `fit_score`, `risk_flags`, `comp_value_usd` or internal
 * notes, and there is no policy to get wrong. The library still needs a credit
 * line, which is why `asset.creator_credit` exists as one denormalised string.
 */
const ALLOWLIST: Record<SessionKind, Partial<Record<StoreName, Access>>> = {
  manager: {
    org: 'r',
    app_user: 'rw',
    branch: 'rw',
    creator: 'rw',
    collab: 'rw',
    brief: 'rw',
    brief_item: 'rw',
    delivery: 'rw',
    asset: 'rw',
    contact_sheet: 'rw',
    asset_frame: 'rw',
    tag_vocabulary: 'rw',
    tag: 'rw',
    ai_run: 'rw',
    access_token: 'rw',
    review_action: 'rw',
    review_session: 'rw',
    consent_record: 'rw',
    search_query_log: 'rw',
    saved_collection: 'rw',
    collection_item: 'rw',
    usage_event: 'r',
    gap: 'rw',
    gap_scan: 'rw',
    gap_dismissal: 'rw',
    insight: 'rw',
    // Local-only infrastructure. Declared per role like everything else rather
    // than exempted, because `blob` holds contact sheets and an exemption would
    // let a creator token enumerate every asset's stills.
    blob: 'rw',
    search_token: 'rw',
    asset_facet: 'rw',
    reindex_queue: 'rw',
    sync_state: 'rw',
    meta: 'rw',
  },
  editor: {
    org: 'r',
    app_user: 'r',
    branch: 'r',
    // creator and collab are deliberately absent, not restricted.
    asset: 'r',
    contact_sheet: 'r',
    asset_frame: 'r',
    tag_vocabulary: 'rw',
    tag: 'rw',
    // Read is narrowed to `vision_tag` and `search_parse` by the predicate below,
    // and write is narrowed to `search_parse` alone by `writable`: the editor's
    // own query parse must leave a run row, and nothing else here may.
    ai_run: 'rw',
    search_query_log: 'rw',
    saved_collection: 'rw',
    collection_item: 'rw',
    usage_event: 'rw',
    gap: 'rw',
    gap_scan: 'r',
    insight: 'r',
    // Reads the index it searches over, and its own sheets. Cannot write the
    // index: reindexing is the application's job, not a role's.
    blob: 'r',
    search_token: 'r',
    asset_facet: 'r',
    meta: 'r',
  },
  creator_token: {
    branch: 'r',
    creator: 'r',
    collab: 'r',
    brief: 'r',
    brief_item: 'r',
    delivery: 'rw',
    asset: 'rw',
    contact_sheet: 'rw',
    asset_frame: 'rw',
    consent_record: 'rw',
    // Their own sheets and posters, written during local pre-flight before
    // anything is uploaded. Nothing else local is reachable from a token.
    blob: 'rw',
  },
}

export class ScopeError extends Error {
  constructor(
    readonly session: SessionKind,
    readonly store: string,
    readonly attempted: 'read' | 'write',
  ) {
    super(
      `A ${session} session may not ${attempted} "${store}". This is a scope violation, not a missing feature: ` +
        'if the role genuinely needs it, widen the allowlist in src/data/scope.ts deliberately and update the visibility matrix.',
    )
    this.name = 'ScopeError'
  }
}

export function assertReadable(session: Session, store: StoreName): void {
  const access = ALLOWLIST[session.kind][store]
  if (!access) throw new ScopeError(session.kind, store, 'read')
}

export function assertWritable(session: Session, store: StoreName): void {
  const access = ALLOWLIST[session.kind][store]
  if (!access || access === 'r') throw new ScopeError(session.kind, store, 'write')
}

export function readableStores(session: Session): StoreName[] {
  return Object.keys(ALLOWLIST[session.kind]) as StoreName[]
}

// ---------------------------------------------------------------------------
// mandatory predicates
// ---------------------------------------------------------------------------

/**
 * Applied to every row on every read, after the allowlist and before the
 * projection. A row that fails the predicate does not exist as far as the caller
 * is concerned.
 */
export function visible(session: Session, store: StoreName, row: Record<string, unknown>): boolean {
  // Soft deleted rows are invisible everywhere. Nothing opts out of this.
  if (row.deleted_at != null) return false

  // Cross-org rows are invisible everywhere, even though this build seeds one org.
  if (row.org_id != null && row.org_id !== session.org_id) return false

  if (session.kind === 'manager') {
    // A branch scoped manager sees only their branches. Null scope means all.
    if (session.branch_scope && typeof row.branch_id === 'string') {
      return session.branch_scope.includes(row.branch_id)
    }
    return true
  }

  if (session.kind === 'editor') {
    if (store === 'asset') {
      const asset = row as unknown as Asset
      // The library is published and approved work only. An editor must never see
      // a clip still under review, because an unreviewed clip in a campaign is the
      // failure the review step exists to prevent.
      return asset.is_published === true && asset.review_status === 'approved'
    }
    if (store === 'ai_run') {
      // Only the kinds that explain a library asset. A `vet` run IS the creator's
      // score, so it stays out of the editor's reach entirely.
      const kind = row.kind
      return kind === 'vision_tag' || kind === 'search_parse'
    }
    if (store === 'saved_collection' || store === 'collection_item' || store === 'search_query_log') {
      return row.owner_user_id === session.user_id || row.user_id === session.user_id || row.is_shared === true
    }
    return true
  }

  // creator_token
  if (store === 'collab') return row.id === session.collab_id
  // Their own row only, and only once the collab has bound which creator that is.
  // Defaults to invisible: an unbound token session sees no creator at all, which
  // is the safe direction for this mistake to fall.
  if (store === 'creator') return isOwnCreator(session, row)
  if (store === 'asset') {
    const asset = row as unknown as Asset
    // Own submissions, plus the small manager-curated exemplar set.
    return asset.collab_id === session.collab_id || asset.is_exemplar === true
  }
  if (store === 'brief') return row.collab_id === session.collab_id
  if (store === 'delivery') return row.collab_id === session.collab_id
  if (store === 'consent_record') return row.collab_id === session.collab_id
  if (store === 'brief_item' || store === 'contact_sheet' || store === 'asset_frame') {
    // These are reached through a parent the caller already proved access to, so
    // the repository resolves them by parent id rather than filtering here.
    return true
  }
  if (store === 'branch') return true

  return false
}

// ---------------------------------------------------------------------------
// write predicates
// ---------------------------------------------------------------------------

/**
 * Applied to every write, after the allowlist. The read side has `visible`; this
 * is its `WITH CHECK` twin, and it exists for the same reason: an allowlist can
 * only say "this role touches this table", and sometimes the truth is "this role
 * writes exactly one kind of row into this table".
 *
 * Kept deliberately small. A predicate per table is a policy surface, and the
 * whole point of putting visibility in one layer is that there is not much of it.
 */
export function writable(session: Session, store: StoreName, row: Record<string, unknown>): boolean {
  if (session.kind === 'editor' && store === 'ai_run') {
    // The editor's search box parses a query through the AI seam, and that call
    // has to leave a run row or the provenance chip points at nothing and Data
    // Health undercounts. It is the only run an editor's action can produce.
    //
    // A `vet` run IS the creator's score and a `vision_tag` run is the manager's
    // curation record. Writing either from the editor surface would be a bug
    // with no legitimate caller, so it fails loudly rather than being filtered.
    return row.kind === 'search_parse'
  }
  return true
}

/**
 * A creator token resolves to a collab, and the collab names the creator. The
 * session carries the collab, so ownership of a creator row is established by the
 * caller passing the collab's `creator_id` in.
 */
function isOwnCreator(session: Session, row: Record<string, unknown>): boolean {
  const allowed = (session as Session & { creator_id?: string | null }).creator_id
  return typeof allowed === 'string' ? row.id === allowed : false
}

/** Binds the creator this token may read, once the collab has been resolved. */
export function withCreator(session: Session, creator_id: string): Session {
  return { ...session, creator_id } as Session & { creator_id: string }
}

// ---------------------------------------------------------------------------
// projections
// ---------------------------------------------------------------------------

/**
 * Fields an editor may see on an asset.
 *
 * An allowlist rather than a denylist, deliberately: a field added to `Asset` next
 * month is invisible to an editor until somebody adds it here on purpose. A
 * denylist would leak it by default, which is the wrong direction for a mistake
 * to fall.
 */
const EDITOR_ASSET_FIELDS = [
  'id', 'org_id', 'created_at', 'updated_at', 'kind', 'branch_id',
  'filename', 'duration_s', 'coded_width', 'coded_height', 'rotation_deg',
  'codec_video', 'has_audio', 'captured_at', 'captured_at_source',
  'client_decodable', 'needs_transcode',
  'ai_description', 'ai_shot_type', 'ai_room', 'ai_subjects',
  'ai_quality_score', 'ai_framing_score', 'ai_confidence', 'ai_provenance',
  'review_status', 'is_published', 'is_hero',
  'media_state', 'derivative_state', 'poster_key', 'sheet_key', 'bytes_key',
  'used_count', 'download_count',
  'creator_credit', 'usage_scope',
] as const

/**
 * Fields a creator may see on their own asset.
 *
 * Note what is absent: `reject_reason_text`, because piping a blunt internal note
 * to a stranger's phone is a real product mistake, and every `ai_*` score, because
 * showing somebody an algorithmic judgement of their work is a different product
 * decision than we have made.
 */
const CREATOR_ASSET_FIELDS = [
  'id', 'kind', 'filename', 'duration_s', 'coded_width', 'coded_height',
  'captured_at', 'captured_at_source', 'preflight', 'preflight_version',
  'review_status', 'confirmed_brief_item_id', 'creator_claimed_brief_item_id',
  'creator_facing_note',
  'media_state', 'derivative_state', 'poster_key', 'sheet_key',
] as const

const CREATOR_COLLAB_FIELDS = [
  'id', 'branch_id', 'stage', 'visit_at', 'usage_terms_text',
  'consent_text_version', 'consent_accepted_at',
] as const

const CREATOR_CREATOR_FIELDS = ['id', 'display_name', 'primary_handle'] as const

/**
 * `lat` and `lng` are here deliberately.
 *
 * Local pre-flight cannot answer "was this filmed at the studio" without the
 * studio's location, and doing that check on the creator's device is the whole
 * point: they learn the answer before uploading. The coordinates leak nothing,
 * because the projection already includes the street address they are travelling
 * to. Withholding them would move the check to a server this product does not
 * have, and would fail the creator for our architecture.
 */
const CREATOR_BRANCH_FIELDS = ['id', 'name', 'address', 'city', 'timezone', 'lat', 'lng'] as const

const EDITOR_BRANCH_FIELDS = ['id', 'name', 'city', 'timezone', 'rooms'] as const

const EDITOR_USER_FIELDS = ['id', 'display_name', 'role'] as const

function pick<T extends Record<string, unknown>>(row: T, fields: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in row) out[field] = row[field]
  }
  return out as Partial<T>
}

/** Per session kind and store, the projection applied to every row leaving the repository. */
export function project(
  session: Session,
  store: StoreName,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (session.kind === 'manager') return row

  if (session.kind === 'editor') {
    switch (store) {
      case 'asset':
        return pick(row, EDITOR_ASSET_FIELDS)
      case 'branch':
        return pick(row, EDITOR_BRANCH_FIELDS)
      case 'app_user':
        return pick(row, EDITOR_USER_FIELDS)
      default:
        return row
    }
  }

  switch (store) {
    case 'asset':
      return pick(row, CREATOR_ASSET_FIELDS)
    case 'collab':
      return pick(row, CREATOR_COLLAB_FIELDS)
    case 'creator':
      return pick(row, CREATOR_CREATOR_FIELDS)
    case 'branch':
      return pick(row, CREATOR_BRANCH_FIELDS)
    default:
      return row
  }
}

/**
 * Field names that must never appear in a projection for a given session kind.
 *
 * This exists so the scope test can assert absence by name rather than by
 * enumerating an allowlist twice. If a field here ever appears in projected
 * output, that is a leak and the test fails.
 */
export const FORBIDDEN_FIELDS: Record<Exclude<SessionKind, 'manager'>, string[]> = {
  editor: [
    'fit_score', 'fit_reasons', 'risk_flags', 'suggested_tier', 'fit_score_override',
    'override_reason', 'scorecard', 'reliability_tier', 'notes',
    'contact_email', 'contact_phone', 'platforms',
    'comp_value_usd', 'vip_tier', 'outcome', 'owner_user_id',
    'consent_text_version', 'consent_accepted_at', 'usage_terms_text',
    'reject_reason_text', 'nudge_draft_text', 'do_not_shoot',
    // An editor searching the library has no business knowing what the creator
    // claimed a clip was for: the manager's confirmation is the only match an
    // editor should ever act on, and showing both invites cutting on a claim
    // nobody checked.
    'creator_claimed_brief_item_id',
  ],
  creator_token: [
    'fit_score', 'fit_reasons', 'risk_flags', 'suggested_tier', 'scorecard',
    'reliability_tier', 'notes', 'comp_value_usd', 'owner_user_id',
    'reject_reason_text', 'do_not_shoot', 'target_coverage',
    'ai_description', 'ai_shot_type', 'ai_quality_score', 'ai_framing_score',
    'ai_confidence', 'ai_brand_safety', 'ai_matched_brief_item_id', 'ai_provenance',
    'creator_credit', 'phash_primary', 'frame_hashes', 'used_count', 'download_count',
  ],
}

/** Stores each non-manager session must not be able to read at all. */
export const FORBIDDEN_STORES: Record<Exclude<SessionKind, 'manager'>, StoreName[]> = {
  editor: ['creator', 'collab', 'brief', 'brief_item', 'delivery', 'review_action', 'access_token', 'gap_dismissal'],
  creator_token: [
    'app_user', 'tag', 'tag_vocabulary', 'ai_run', 'review_action', 'review_session',
    'access_token', 'gap', 'gap_scan', 'gap_dismissal', 'insight',
    'saved_collection', 'collection_item', 'usage_event', 'search_query_log',
  ],
}

export type { Asset, Collab, Creator }
