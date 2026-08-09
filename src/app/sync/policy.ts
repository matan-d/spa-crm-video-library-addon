/**
 * The merge policy, as data, and the one function that executes it.
 *
 * This file is the implementation of the conflict table in
 * `docs/01-architecture-review.md` C.3. The table is long and the executor is
 * short on purpose: the rules are the part a human has to argue about, so they
 * are declarative rows anybody can read, and the mechanism underneath them is
 * seven primitives that never grow.
 *
 * The reason it is not a pile of `if` statements: the worst bug available in
 * this product is a stale device flipping a `rejected` clip back to `approved`
 * and republishing footage a human killed for consent or brand-safety reasons.
 * A rule written as data can be read, tested and audited in one place. A rule
 * written as a branch inside a sync loop is discovered by the person who finds
 * the republished clip.
 *
 * CRDTs were rejected for the same reason (C.3). The conflicts here are
 * semantic, an approval against a rejection, not textual, and a CRDT converges
 * on a state that is mathematically consistent and can be a state no human
 * intended.
 */

import { LOCAL_ONLY_FIELDS, type StoreName } from '@/data/schema'

/** Which primitive decided a field. Recorded on every conflict row. */
export type MergePrimitive =
  | 'write_once'
  | 'ordinal'
  | 'sticky'
  | 'coupled'
  | 'recompute'
  | 'immutable'
  | 'implies'
  | 'lww'

export interface MergePolicy {
  /** First non-null value wins. A differing second value is a defect, not a merge. */
  writeOnce?: readonly string[]
  /** The value later in the array wins, regardless of any clock. */
  ordinal?: Readonly<Record<string, readonly string[]>>
  /**
   * Once at the named value, no incoming patch can move it.
   * `'set'` means any non-null value sticks, which is how a soft delete and a
   * human tag removal behave.
   */
  sticky?: Readonly<Record<string, 'set' | string | number | boolean>>
  /**
   * Fields that merge as one unit. If the group contains an ordinal field, that
   * field's decision governs the whole group.
   *
   * This is the primitive most designs miss. Field-level last-write-wins
   * without it produces a row where `review_status` is one person's rejection,
   * the note belongs to a second decision and the confirmed brief item to a
   * third. Every field individually took the latest write and the row as a
   * whole is fiction, which is exactly how an audit log starts lying.
   */
  coupled?: readonly (readonly string[])[]
  /** Never merged at all: discard both sides and re-derive locally. */
  recompute?: readonly string[]
  /** Insert-only rows. An update is ignored rather than applied. */
  immutable?: boolean
  /**
   * Cross-field invariants applied after the merge.
   *
   * Needed because a coupled group only applies the fields the patch actually
   * carried. A patch that rejects a clip without mentioning `is_published`
   * would otherwise leave the row rejected AND published, which is the precise
   * state the review step exists to prevent.
   */
  implies?: readonly {
    when: Readonly<Record<string, unknown>>
    then: Readonly<Record<string, unknown>>
    why: string
  }[]
}

/**
 * On every table, whatever else it declares.
 *
 * `deleted_at` is sticky rather than last-write-wins because resurrection is
 * the one direction that costs footage: soft delete only hides a row, and a
 * device that re-adds one has merely lost a deletion, whereas a device that
 * un-deletes one has silently republished it.
 */
const ENVELOPE_POLICY: MergePolicy = {
  writeOnce: ['id', 'org_id', 'created_at', 'origin_device'],
  sticky: { deleted_at: 'set' },
}

/**
 * Fields the server owns outright. A client may propose them and is ignored.
 *
 * `server_updated_at` in particular: it is the pull cursor, and a client that
 * could write it could make its own rows permanently invisible to every other
 * device, with no error anywhere.
 */
export const SERVER_OWNED_FIELDS: readonly string[] = ['server_updated_at', 'rev']

/**
 * Per table. Anything not named here merges last-write-wins on `updated_at`,
 * which is correct for text a human retypes and wrong for everything below.
 */
export const MERGE_POLICY: Partial<Record<StoreName, MergePolicy>> = {
  asset: {
    writeOnce: [
      // Band 1, the measured facts about the file. Two devices cannot honestly
      // disagree about a duration, so a disagreement is a defect to surface,
      // never a value to pick between.
      'kind', 'delivery_id', 'collab_id', 'branch_id',
      'filename', 'bytes', 'duration_s', 'coded_width', 'coded_height',
      'rotation_deg', 'codec_video', 'has_audio', 'captured_at',
      'captured_at_source', 'gps', 'phash_primary', 'frame_hashes',
      // Band 5 storage keys. Never merged toward null: a device that has not
      // seen the poster yet must not be able to erase the pointer to it.
      'bytes_key', 'poster_key', 'sheet_key',
    ],
    ordinal: {
      // The safety ladder. Rejected beats approved beats pending, whatever the
      // clocks say, because the alternative is republishing killed footage.
      review_status: ['pending', 'approved', 'rejected'],
      // A more capable producer's derivatives win regardless of clock, so a
      // stale `none` from the phone that ingested the file can never erase a
      // sheet a desktop later produced.
      derivative_state: ['none', 'partial', 'ready'],
    },
    coupled: [
      // The decision, the reason and the match travel together or not at all.
      [
        'review_status', 'is_published', 'is_published_i',
        'reject_reason_text', 'creator_facing_note', 'confirmed_brief_item_id',
      ],
      ['is_exemplar', 'is_exemplar_i', 'exemplar_note'],
    ],
    recompute: [
      // Derived from the file plus this runtime. Recomputed, never merged.
      'preflight', 'preflight_version', 'client_decodable', 'needs_transcode', 'probe_result',
      // Counters. Two devices that sum-merge a counter double count it, so both
      // are discarded and the number is recomputed from `usage_event`.
      'used_count', 'download_count',
      // Band 3. Never last-write-wins: `ai_run` rows are append-only and
      // immutable, so the projection is re-derived from the current run. This
      // deletes the whole class of "a stale device overwrote a fresh AI result".
      'ai_description', 'ai_shot_type', 'ai_room', 'ai_subjects',
      'ai_quality_score', 'ai_framing_score', 'ai_confidence', 'ai_brand_safety',
      'ai_matched_brief_item_id', 'ai_provenance',
    ],
    implies: [
      {
        when: { review_status: 'rejected' },
        then: { is_published: false, is_published_i: 0 },
        why: 'a rejected clip cannot stay in the library, whichever patch carried the rejection',
      },
    ],
  },

  collab: {
    ordinal: {
      stage: ['source', 'vet', 'book', 'brief', 'visit', 'delivered', 'library', 'closed'],
      // `cancelled` sits last so it beats every other outcome. The override
      // rule from C.3, expressed with the ordinal primitive rather than a
      // special case, because a special case is a rule nobody tests.
      outcome: ['open', 'completed', 'ghosted', 'cancelled'],
    },
    writeOnce: [
      'creator_id', 'branch_id',
      // Snapshotted at acceptance. A second differing value means two people
      // agreed to two different things, which a merge must never paper over.
      'usage_terms_text', 'consent_text_version', 'consent_accepted_at',
    ],
  },

  creator: {
    sticky: {
      // Block beats unblock from any device. The safe direction.
      lifecycle: 'blocked',
    },
    coupled: [['fit_score_override', 'override_reason']],
    // Computed locally from review and delivery history, never merged.
    recompute: ['scorecard', 'reliability_tier', 'fit_score', 'fit_reasons', 'risk_flags', 'suggested_tier'],
  },

  brief: {
    writeOnce: ['collab_id', 'gap_scan_id'],
    ordinal: { status: ['draft', 'locked', 'superseded'] },
    sticky: { locked_at: 'set' },
  },

  brief_item: {
    // The loop link. If it could be overwritten, the product's headline claim
    // would stop being provable from the data.
    writeOnce: ['brief_id', 'origin_gap_id'],
  },

  delivery: {
    ordinal: { state: ['open', 'submitted', 'reviewed'] },
    sticky: { submitted_at: 'set', nudge_sent_at: 'set' },
    writeOnce: ['collab_id'],
  },

  tag: {
    writeOnce: ['asset_id', 'term', 'source', 'ai_run_id'],
    // A human removal beats a re-add from a stale device, and a rejection
    // cannot be un-rejected: the disagreement is the evaluation set.
    sticky: { removed_at: 'set', rejected_by_human: true },
  },

  // Insert-only, immutable, and load-bearing for provenance. `ai_run` is the
  // audit trail behind every AI field, `review_action` behind every human one.
  ai_run: { immutable: true },
  review_action: { immutable: true },
  consent_record: { immutable: true },
  gap_scan: { immutable: true },

  gap: {
    writeOnce: ['cell_signature', 'gap_scan_id'],
    // A dismissal is a human saying stop asking, so it outranks an automatic
    // close, and both outrank open.
    ordinal: { status: ['open', 'closed', 'dismissed'] },
  },

  access_token: { sticky: { revoked_at: 'set' } },
}

// ---------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------

export interface MergeConflict {
  store: string
  row_id: string
  /** The field or coupled group the policy refused. */
  fields: string[]
  policy: MergePrimitive
  /** What the row kept. */
  kept: unknown
  /** What the incoming patch wanted, and did not get. */
  refused: unknown
  detail: string
}

export interface MergeResult {
  row: Record<string, unknown>
  /** Fields this merge actually changed. Empty means the write was a no-op. */
  applied: string[]
  conflicts: MergeConflict[]
}

export function policyFor(store: string): MergePolicy {
  const declared = MERGE_POLICY[store as StoreName] ?? {}
  return {
    writeOnce: [...(ENVELOPE_POLICY.writeOnce ?? []), ...(declared.writeOnce ?? [])],
    sticky: { ...ENVELOPE_POLICY.sticky, ...declared.sticky },
    ordinal: declared.ordinal,
    coupled: declared.coupled,
    recompute: declared.recompute,
    immutable: declared.immutable,
    implies: declared.implies,
  }
}

/**
 * Merges one incoming patch into one base row under the store's policy.
 *
 * Pure: no clock, no database, no id generation. That is what makes the rules
 * testable one at a time instead of only through a full sync round trip.
 */
export function mergeRow(input: {
  store: string
  /** The row as it currently stands, or null for an insert. */
  base: Record<string, unknown> | null
  /** The changed fields. For a create this is the whole row. */
  incoming: Record<string, unknown>
}): MergeResult {
  const { store, base } = input
  const policy = policyFor(store)
  const conflicts: MergeConflict[] = []

  // Stripped on the way in as well as on the way out. Belt and braces, because
  // the two ends of a sync are written months apart and only one of them is
  // ours in production.
  const localOnly = new Set(LOCAL_ONLY_FIELDS[store as StoreName] ?? [])
  const incoming: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(input.incoming)) {
    if (localOnly.has(field)) continue
    if (SERVER_OWNED_FIELDS.includes(field)) continue
    incoming[field] = value
  }

  const rowId = String(base?.id ?? incoming.id ?? '')

  if (!base) {
    const row = { ...incoming }
    const applied = Object.keys(row)
    applyImplications(store, row, policy, applied, conflicts, rowId)
    return { row, applied, conflicts }
  }

  if (policy.immutable) {
    // Not a conflict: these rows are insert-only by design, and a device that
    // re-sends one is echoing, not disagreeing.
    return { row: { ...base }, applied: [], conflicts: [] }
  }

  const row: Record<string, unknown> = { ...base }
  const applied: string[] = []
  const handled = new Set<string>()
  const incomingWins = timestampOf(incoming) >= timestampOf(base)

  // Coupled groups first: a group that contains an ordinal field is decided by
  // that field, so it has to run before the field-by-field pass sees it.
  for (const group of policy.coupled ?? []) {
    const present = group.filter((field) => field in incoming)
    if (present.length === 0) continue
    for (const field of group) handled.add(field)

    const ladderField = group.find((field) => policy.ordinal?.[field] && field in incoming)
    let accept = incomingWins
    if (ladderField) {
      const ladder = policy.ordinal![ladderField]!
      const decision = compareOrdinal(ladder, incoming[ladderField], base[ladderField])
      // A tie means both sides describe the same decision, so the rest of the
      // group falls back to last-write-wins. Refusing on a tie would freeze a
      // note or a reason the moment two devices agreed about the status.
      accept = decision === 'take' || (decision === 'keep' && incomingWins)
      if (decision === 'refuse') {
        conflicts.push({
          store,
          row_id: rowId,
          fields: [...present],
          policy: 'ordinal',
          kept: base[ladderField],
          refused: incoming[ladderField],
          detail:
            `${ladderField} is a one-way ladder (${ladder.join(' < ')}), so the incoming ` +
            `"${String(incoming[ladderField])}" cannot displace "${String(base[ladderField])}". ` +
            'The whole coupled group was refused with it, so no half of one decision lands next to half of another.',
        })
      }
    }
    if (!accept) continue
    for (const field of present) setField(row, field, incoming[field], applied)
  }

  for (const [field, value] of Object.entries(incoming)) {
    if (handled.has(field)) continue

    if (policy.recompute?.includes(field)) continue

    const stickyValue = policy.sticky?.[field]
    if (stickyValue !== undefined) {
      const stuck =
        stickyValue === 'set' ? base[field] != null : deepEqual(base[field], stickyValue)
      if (stuck) {
        if (!deepEqual(base[field], value)) {
          conflicts.push({
            store,
            row_id: rowId,
            fields: [field],
            policy: 'sticky',
            kept: base[field],
            refused: value,
            detail: `${field} is sticky once set, so no later patch can unset or change it.`,
          })
        }
        continue
      }
      setField(row, field, value, applied)
      continue
    }

    if (policy.writeOnce?.includes(field)) {
      if (base[field] == null) {
        setField(row, field, value, applied)
      } else if (!deepEqual(base[field], value)) {
        conflicts.push({
          store,
          row_id: rowId,
          fields: [field],
          policy: 'write_once',
          kept: base[field],
          refused: value,
          detail:
            `${field} is write-once. A second, different value is a defect rather than a conflict: ` +
            'nothing here picks a winner, and a human has to decide which observation was wrong.',
        })
      }
      continue
    }

    const ladder = policy.ordinal?.[field]
    if (ladder) {
      const decision = compareOrdinal(ladder, value, base[field])
      if (decision === 'take') {
        setField(row, field, value, applied)
      } else if (decision === 'refuse') {
        conflicts.push({
          store,
          row_id: rowId,
          fields: [field],
          policy: 'ordinal',
          kept: base[field],
          refused: value,
          detail: `${field} only moves forward along ${ladder.join(' < ')}.`,
        })
      }
      continue
    }

    if (incomingWins) setField(row, field, value, applied)
  }

  applyImplications(store, row, policy, applied, conflicts, rowId)
  return { row, applied, conflicts }
}

function applyImplications(
  store: string,
  row: Record<string, unknown>,
  policy: MergePolicy,
  applied: string[],
  conflicts: MergeConflict[],
  rowId: string,
): void {
  for (const rule of policy.implies ?? []) {
    const matches = Object.entries(rule.when).every(([field, value]) => deepEqual(row[field], value))
    if (!matches) continue
    for (const [field, value] of Object.entries(rule.then)) {
      // A field the row does not carry is not a contradiction. Adding one here
      // would invent state on a partial row, which is the opposite of the job.
      if (!(field in row)) continue
      if (deepEqual(row[field], value)) continue
      conflicts.push({
        store,
        row_id: rowId,
        fields: [field],
        policy: 'implies',
        kept: value,
        refused: row[field],
        detail: rule.why,
      })
      setField(row, field, value, applied)
    }
  }
}

function setField(
  row: Record<string, unknown>,
  field: string,
  value: unknown,
  applied: string[],
): void {
  if (deepEqual(row[field], value)) return
  row[field] = value
  applied.push(field)
}

/**
 * `take` if the incoming value is further along the ladder, `keep` if it is the
 * same rung, `refuse` if it would go backwards.
 *
 * A value not on the ladder ranks below every value that is, so an unknown
 * state can never displace a known one.
 */
function compareOrdinal(
  ladder: readonly string[],
  incoming: unknown,
  base: unknown,
): 'take' | 'keep' | 'refuse' {
  const incomingRank = ladder.indexOf(String(incoming))
  const baseRank = ladder.indexOf(String(base))
  if (incomingRank > baseRank) return 'take'
  if (incomingRank === baseRank) return 'keep'
  return 'refuse'
}

function timestampOf(row: Record<string, unknown>): number {
  const value = row.updated_at
  return typeof value === 'number' ? value : 0
}

/**
 * Structural equality, deliberately local rather than the canonical hash in
 * `src/platform/hash.ts`: that one throws on shapes it refuses to guess about,
 * and a merge comparing two arbitrary rows must answer rather than throw.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => key in right && deepEqual(left[key], right[key]))
  }
  return false
}
