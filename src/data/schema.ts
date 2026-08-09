/**
 * The local schema: object stores, indexes, and the ordered migrations that build
 * them.
 *
 * Two decisions here are worth reading before changing anything.
 *
 * 1. IndexedDB cannot index a boolean. `IDBKeyRange` needs a valid key, and
 *    `true` is not one, so a store indexed on `is_published` silently returns
 *    nothing. Every boolean the app needs to query by therefore carries a 0/1
 *    mirror with an `_i` suffix, written by the repository rather than by callers.
 *    This is the single most common way a local-first Vue app appears to lose
 *    rows.
 *
 * 2. The database name does NOT carry the schema version, even though the
 *    architecture review's shorthand wrote it that way. Putting the version in
 *    the name means every migration creates a fresh empty database, which is
 *    tolerable for the demo profile (the seed re-hydrates) and is data loss for a
 *    real one. IndexedDB already has a version mechanism, so the name carries the
 *    profile and the version drives `onupgradeneeded`. One mechanism for both
 *    profiles, and it is the correct one.
 */

export const SCHEMA_VERSION = 2

export type StoreName =
  // durable record
  | 'org'
  | 'app_user'
  | 'branch'
  | 'creator'
  | 'collab'
  | 'brief'
  | 'brief_item'
  | 'delivery'
  | 'asset'
  | 'contact_sheet'
  | 'asset_frame'
  | 'tag_vocabulary'
  | 'tag'
  | 'ai_run'
  | 'access_token'
  | 'review_action'
  | 'review_session'
  | 'consent_record'
  // derived, regenerable
  | 'search_query_log'
  | 'saved_collection'
  | 'collection_item'
  | 'usage_event'
  | 'gap'
  | 'gap_scan'
  | 'gap_dismissal'
  | 'insight'
  // local only, never synced
  | 'blob'
  | 'search_token'
  | 'asset_facet'
  | 'reindex_queue'
  | 'outbox'
  | 'sync_state'
  | 'sync_conflict'
  | 'meta'

interface IndexSpec {
  name: string
  keyPath: string | string[]
  unique?: boolean
  multiEntry?: boolean
}

interface StoreSpec {
  name: StoreName
  keyPath: string
  autoIncrement?: boolean
  indexes: IndexSpec[]
  /** Local-only stores are never drained to the outbox and never sync. */
  localOnly?: boolean
  /**
   * The schema version that introduced this store. Defaults to 1.
   *
   * It exists so migration 1 stays a truthful record of what version 1 was,
   * rather than quietly growing every time a store is added. A migration that
   * rewrites its own history is a migration nobody can reason about on a
   * database that already ran it.
   */
  since?: number
}

/**
 * Every synced store gets these, because every synced row carries the envelope
 * from the architecture review A.0 and both are needed by the pull cursor and by
 * soft-delete filtering.
 */
const ENVELOPE_INDEXES: IndexSpec[] = [
  { name: 'by_org', keyPath: 'org_id' },
  { name: 'by_updated', keyPath: 'updated_at' },
  { name: 'by_server_updated', keyPath: 'server_updated_at' },
]

export const STORES: StoreSpec[] = [
  { name: 'org', keyPath: 'id', indexes: [] },
  {
    name: 'app_user',
    keyPath: 'id',
    indexes: [...ENVELOPE_INDEXES, { name: 'by_role', keyPath: 'role' }],
  },
  { name: 'branch', keyPath: 'id', indexes: [...ENVELOPE_INDEXES] },
  {
    name: 'creator',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_lifecycle', keyPath: 'lifecycle' },
      { name: 'by_reliability', keyPath: 'reliability_tier' },
      { name: 'by_handle', keyPath: 'primary_handle' },
    ],
  },
  {
    name: 'collab',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_stage', keyPath: 'stage' },
      { name: 'by_creator', keyPath: 'creator_id' },
      { name: 'by_branch', keyPath: 'branch_id' },
      // Stage ageing drives the triage inbox, which is the manager's real home.
      { name: 'by_stage_entered', keyPath: ['stage', 'stage_entered_at'] },
    ],
  },
  {
    name: 'brief',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_collab', keyPath: 'collab_id' },
      { name: 'by_gap_scan', keyPath: 'gap_scan_id' },
    ],
  },
  {
    name: 'brief_item',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_brief', keyPath: 'brief_id' },
      { name: 'by_brief_seq', keyPath: ['brief_id', 'seq'] },
      // The loop link. Without this the product's headline claim is unmeasurable.
      { name: 'by_origin_gap', keyPath: 'origin_gap_id' },
    ],
  },
  {
    name: 'delivery',
    keyPath: 'id',
    indexes: [...ENVELOPE_INDEXES, { name: 'by_collab', keyPath: 'collab_id' }],
  },
  {
    name: 'asset',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_delivery', keyPath: 'delivery_id' },
      { name: 'by_collab', keyPath: 'collab_id' },
      { name: 'by_branch', keyPath: 'branch_id' },
      { name: 'by_review_status', keyPath: 'review_status' },
      { name: 'by_media_state', keyPath: 'media_state' },
      { name: 'by_derivative_state', keyPath: 'derivative_state' },
      { name: 'by_provenance', keyPath: 'ai_provenance' },
      // The editor's library predicate: published and approved, newest first.
      { name: 'by_published', keyPath: ['is_published_i', 'created_at'] },
      // The manager's review queue predicate, grouped the way review happens.
      { name: 'by_review_queue', keyPath: ['delivery_id', 'confirmed_brief_item_id'] },
      { name: 'by_phash', keyPath: 'phash_primary' },
    ],
  },
  {
    name: 'contact_sheet',
    keyPath: 'id',
    indexes: [...ENVELOPE_INDEXES, { name: 'by_asset', keyPath: 'asset_id' }],
  },
  {
    name: 'asset_frame',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_sheet', keyPath: 'contact_sheet_id' },
      { name: 'by_asset', keyPath: 'asset_id' },
    ],
  },
  {
    name: 'tag_vocabulary',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_term', keyPath: 'term', unique: false },
      { name: 'by_status', keyPath: 'status' },
      { name: 'by_alias', keyPath: 'aliases', multiEntry: true },
    ],
  },
  {
    name: 'tag',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_asset', keyPath: 'asset_id' },
      { name: 'by_term', keyPath: 'term' },
      // AI and human tags are separate rows and must stay separately queryable:
      // their disagreement is the only free evaluation set this product gets.
      { name: 'by_asset_source', keyPath: ['asset_id', 'source'] },
      { name: 'by_ai_run', keyPath: 'ai_run_id' },
    ],
  },
  {
    name: 'ai_run',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_subject', keyPath: ['subject_type', 'subject_id'] },
      { name: 'by_kind', keyPath: 'kind' },
      { name: 'by_provider', keyPath: 'provider' },
      { name: 'by_current', keyPath: ['subject_type', 'subject_id', 'kind', 'is_current_i'] },
      // The response cache key. Replay is this cache, pre-seeded.
      { name: 'by_cache_key', keyPath: ['input_hash', 'prompt_hash', 'model_key'] },
    ],
  },
  {
    name: 'access_token',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_token_hash', keyPath: 'token_hash', unique: true },
      { name: 'by_collab', keyPath: 'collab_id' },
    ],
  },
  {
    name: 'review_action',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_asset', keyPath: 'asset_id' },
      { name: 'by_session', keyPath: 'session_id' },
      { name: 'by_method', keyPath: 'method' },
    ],
  },
  {
    name: 'review_session',
    keyPath: 'id',
    indexes: [...ENVELOPE_INDEXES, { name: 'by_delivery', keyPath: 'delivery_id' }],
  },
  {
    name: 'consent_record',
    keyPath: 'id',
    indexes: [...ENVELOPE_INDEXES, { name: 'by_collab', keyPath: 'collab_id' }],
  },

  {
    name: 'search_query_log',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_user', keyPath: 'user_id' },
      { name: 'by_outcome', keyPath: 'outcome' },
      { name: 'by_refined_from', keyPath: 'refined_from_query_id' },
      { name: 'by_token', keyPath: 'tokens', multiEntry: true },
    ],
  },
  {
    name: 'saved_collection',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_owner', keyPath: 'owner_user_id' },
      { name: 'by_kind', keyPath: 'kind' },
      { name: 'by_pinned', keyPath: 'is_pinned_i' },
    ],
  },
  {
    name: 'collection_item',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_collection', keyPath: 'collection_id' },
      { name: 'by_collection_rank', keyPath: ['collection_id', 'rank'] },
      { name: 'by_asset', keyPath: 'asset_id' },
    ],
  },
  {
    name: 'usage_event',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_asset', keyPath: 'asset_id' },
      { name: 'by_user', keyPath: 'user_id' },
      { name: 'by_kind', keyPath: 'kind' },
      { name: 'by_query', keyPath: 'query_id' },
    ],
  },
  {
    name: 'gap',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      // Keyed by signature, not id, so a dismissal survives a rescan. Keying by
      // id is what turns this feature into nagware and gets it switched off.
      { name: 'by_signature', keyPath: 'cell_signature' },
      { name: 'by_status', keyPath: 'status' },
      { name: 'by_scan', keyPath: 'gap_scan_id' },
      { name: 'by_branch', keyPath: 'branch_id' },
      { name: 'by_priority', keyPath: ['status', 'score'] },
    ],
  },
  { name: 'gap_scan', keyPath: 'id', indexes: [...ENVELOPE_INDEXES] },
  {
    name: 'gap_dismissal',
    keyPath: 'id',
    indexes: [
      ...ENVELOPE_INDEXES,
      { name: 'by_signature', keyPath: 'cell_signature', unique: false },
    ],
  },
  {
    name: 'insight',
    keyPath: 'id',
    indexes: [...ENVELOPE_INDEXES, { name: 'by_subject', keyPath: ['subject_type', 'subject_id'] }],
  },

  // ---- local only ----
  {
    // Contact sheets and posters, as Blobs. A separate store rather than a field
    // on the record, for two reasons: the records stay small enough to scan
    // cheaply, and eviction needs to walk these oldest-first without dragging
    // every record's metadata through memory. Derived and regenerable, so never
    // synced: in production these live in object storage.
    name: 'blob',
    keyPath: 'key',
    localOnly: true,
    indexes: [
      { name: 'by_created', keyPath: 'created_at' },
      { name: 'by_kind', keyPath: 'kind' },
    ],
  },
  {
    name: 'search_token',
    keyPath: 'id',
    localOnly: true,
    indexes: [
      { name: 'by_token', keyPath: 'token' },
      { name: 'by_asset', keyPath: 'asset_id' },
      { name: 'by_token_asset', keyPath: ['token', 'asset_id'], unique: true },
    ],
  },
  {
    name: 'asset_facet',
    keyPath: 'id',
    localOnly: true,
    indexes: [
      { name: 'by_facet_value', keyPath: ['facet', 'value'] },
      { name: 'by_asset', keyPath: 'asset_id' },
    ],
  },
  {
    name: 'reindex_queue',
    keyPath: 'asset_id',
    localOnly: true,
    indexes: [{ name: 'by_queued', keyPath: 'queued_at' }],
  },
  {
    name: 'outbox',
    keyPath: 'seq',
    autoIncrement: true,
    localOnly: true,
    indexes: [
      { name: 'by_store_row', keyPath: ['store', 'row_id'] },
      { name: 'by_state', keyPath: 'state' },
    ],
  },
  { name: 'sync_state', keyPath: 'store', localOnly: true, indexes: [] },
  {
    // A merge the policy refused, kept as a row.
    //
    // C.3 is explicit that a conflict is a record and never a toast: a
    // notification gets dismissed and the disagreement is then discovered three
    // weeks later inside a campaign. Local only, because it describes what this
    // device tried to do and what the merge did instead.
    name: 'sync_conflict',
    keyPath: 'id',
    localOnly: true,
    since: 2,
    indexes: [
      { name: 'by_store_row', keyPath: ['store', 'row_id'] },
      { name: 'by_detected', keyPath: 'detected_at' },
    ],
  },
  { name: 'meta', keyPath: 'key', localOnly: true, indexes: [] },
]

export const STORE_NAMES: StoreName[] = STORES.map((s) => s.name)

export const SYNCED_STORES: StoreName[] = STORES.filter((s) => !s.localOnly).map((s) => s.name)

export const LOCAL_ONLY_STORES: StoreName[] = STORES.filter((s) => s.localOnly).map((s) => s.name)

/**
 * Boolean fields that carry an integer mirror for indexing, as `field` ->
 * `field_i`. The repository writes the mirror; nothing else should.
 */
export const INDEXED_BOOLEANS: Record<string, string> = {
  is_published: 'is_published_i',
  is_current: 'is_current_i',
  is_pinned: 'is_pinned_i',
  is_exemplar: 'is_exemplar_i',
  is_shared: 'is_shared_i',
}

/**
 * Fields that are true only of THIS device and must never be pushed anywhere.
 *
 * They are stripped at the outbox append in `src/data/repo.ts`, and ignored
 * again when a row arrives from the far side, which is the `localOnly` merge
 * primitive from the architecture review C.3.
 *
 * The reason this is a declared list rather than a rule in the sync code: an
 * upload half finished on a phone is not a fact about the clip, it is a fact
 * about the phone. Syncing `upload_state` would make a laptop believe it has a
 * partial upload it never started, and syncing `media_state` would make it
 * believe the bytes are on disk when the disk in question is somebody else's.
 * `local_file_key` is worse still: it is a handle into another device's OPFS.
 */
export const LOCAL_ONLY_FIELDS: Partial<Record<StoreName, readonly string[]>> = {
  asset: ['upload_state', 'upload_offset_bytes', 'media_state', 'local_file_key'],
}

export interface Migration {
  version: number
  description: string
  up: (db: IDBDatabase, tx: IDBTransaction) => void
}

function createStore(db: IDBDatabase, spec: StoreSpec): void {
  const store = db.createObjectStore(spec.name, {
    keyPath: spec.keyPath,
    autoIncrement: spec.autoIncrement ?? false,
  })
  for (const index of spec.indexes) {
    store.createIndex(index.name, index.keyPath, {
      unique: index.unique ?? false,
      multiEntry: index.multiEntry ?? false,
    })
  }
}

/** Stores introduced at a given schema version, so a migration cannot drift. */
function storesIntroducedAt(version: number): StoreSpec[] {
  return STORES.filter((spec) => (spec.since ?? 1) === version)
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial stores and indexes',
    up(db) {
      for (const spec of storesIntroducedAt(1)) createStore(db, spec)
    },
  },
  {
    version: 2,
    description: 'sync_conflict: a refused merge is a row, never a toast',
    up(db) {
      for (const spec of storesIntroducedAt(2)) createStore(db, spec)
    },
  },
]
