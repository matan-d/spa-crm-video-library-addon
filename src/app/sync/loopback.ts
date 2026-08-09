/**
 * The loopback sync adapter: a real drain, a real merge, and a real cursor,
 * against a second IndexedDB database that plays the part of the server.
 *
 * Why this exists rather than a mock. The merge policy in `policy.ts` is the
 * part of a sync design most likely to be wrong and least likely to be
 * exercised before it matters, which is usually the morning somebody finds a
 * rejected clip back in the library. A loopback server executes every rule for
 * real, with its own `server_updated_at` clock and its own row store, so the
 * rules are tested rather than merely written down (architecture review C.4).
 *
 * What it honestly is not. It is not a network, so it cannot fail the way a
 * network fails: no partial writes, no timeouts, no duplicate delivery. The
 * retry and attempt fields on an outbox entry exist and are maintained, and
 * nothing in this build has ever exercised them under a real transport. The
 * sync panel says `Adapter: loopback` in plain text for exactly that reason,
 * and nothing anywhere claims a connection to Supabase.
 *
 * The one sanctioned bypass: pulled rows are written straight to their store
 * rather than through the scoped repository. Applying them through the
 * repository would append an outbox entry per row and echo every pull straight
 * back at the server, forever. This is the same argument as D12 (hydration),
 * and it is why this module lives beside the repository conceptually even
 * though it sits in the app layer.
 */

import { fromRequest, fromTransaction, readTx, writeTx } from '@/data/db'
import { databaseName, type ProfileId } from '@/data/profile'
import { SYNCED_STORES, type StoreName } from '@/data/schema'
import type { OutboxEntry, SyncConflict, SyncState } from '@/data/types'
import type { Clock } from '@/platform/clock'
import { mergeRow, type MergeConflict } from './policy'

/** How many rows one pull takes per store, matching the planned Postgres limit. */
const PULL_BATCH = 500

/** The server database's own key for its monotonic clock. */
const SERVER_CLOCK_KEY = 'server_clock'

const SERVER_META_STORE = 'server_meta'

export interface PushReport {
  drained: number
  sent: number
  failed: number
  /** Entries drained, per store. */
  byStore: Record<string, number>
  conflicts: MergeConflict[]
  /** The server instant this batch was stamped with, or null if nothing moved. */
  serverUpdatedAt: number | null
}

export interface PullReport {
  /** Rows the merge actually changed locally. */
  applied: number
  /** Rows that arrived and changed nothing, which is the steady state. */
  unchanged: number
  conflicts: MergeConflict[]
  cursors: SyncState[]
}

export interface LoopbackAdapter {
  /** Plain text, shown in the panel. Nothing here may ever say "supabase". */
  readonly name: 'loopback'
  push(): Promise<PushReport>
  pull(): Promise<PullReport>
  sync(): Promise<{ push: PushReport; pull: PullReport }>
  snapshot(): Promise<SyncSnapshot>
  /** Closes the server connection. The local database is not ours to close. */
  close(): void
}

export interface LoopbackDeps {
  local: IDBDatabase
  server: IDBDatabase
  clock: Clock
  newId: () => string
  deviceId: string
  /**
   * Injected for the same reason `openDatabase` takes an `IDBFactory`: jsdom
   * has no IndexedDB at all, so a test supplies fake-indexeddb's implementation
   * and the pull walks a real composite-key range rather than a simulated one.
   */
  keyRange?: typeof IDBKeyRange
}

/** The name of the loopback server database for a profile. */
export function serverDatabaseName(profile: ProfileId): string {
  return `${databaseName(profile)}_loopback_server`
}

/**
 * Opens (or creates) the loopback server database.
 *
 * One store per synced table, keyed by id, plus the composite cursor index that
 * the pull actually walks. `server_meta` holds the server's clock, which is the
 * whole point of a second database: the cursor must be the server's notion of
 * time, never a client's, or one skewed device makes rows permanently invisible
 * to everybody with no error anywhere.
 */
export function openLoopbackServer(
  profile: ProfileId,
  factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(serverDatabaseName(profile), 1)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of SYNCED_STORES) {
        const objectStore = db.createObjectStore(store, { keyPath: 'id' })
        // (server_updated_at, id), never server_updated_at alone: a batch write
        // produces hundreds of rows at one timestamp, and a timestamp-only
        // cursor either skips them or loops on them forever.
        objectStore.createIndex('by_cursor', ['server_updated_at', 'id'])
      }
      db.createObjectStore(SERVER_META_STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('openLoopbackServer: unknown error'))
    request.onblocked = () =>
      reject(new Error('openLoopbackServer: blocked by another open connection.'))
  })
}

/**
 * Opens the loopback server for a profile and builds the adapter over it.
 *
 * The one entry point a view uses, so no component ever opens a database. Note
 * the server database is per profile, like everything else: a demo outbox is
 * structurally incapable of reaching the live loopback server, let alone a real
 * one (src/data/profile.ts).
 */
export async function connectLoopback(input: {
  profile: ProfileId
  local: IDBDatabase
  clock: Clock
  newId: () => string
  deviceId: string
  indexedDbFactory?: IDBFactory
  keyRange?: typeof IDBKeyRange
}): Promise<LoopbackAdapter> {
  const server = await openLoopbackServer(input.profile, input.indexedDbFactory)
  return createLoopbackAdapter({
    local: input.local,
    server,
    clock: input.clock,
    newId: input.newId,
    deviceId: input.deviceId,
    keyRange: input.keyRange,
  })
}

export function createLoopbackAdapter(deps: LoopbackDeps): LoopbackAdapter {
  const { local, server, clock, newId, deviceId } = deps
  const keyRange = deps.keyRange ?? IDBKeyRange

  return {
    name: 'loopback',

    async push() {
      const entries = await pendingEntries(local)
      const report: PushReport = {
        drained: 0,
        sent: 0,
        failed: 0,
        byStore: {},
        conflicts: [],
        serverUpdatedAt: null,
      }
      if (entries.length === 0) return report

      // One server instant for the whole batch, the way a Postgres transaction
      // shares one `now()`. It also means the composite cursor tiebreak is
      // exercised on every push rather than only in theory.
      const serverUpdatedAt = await nextServerTick(server, clock)
      report.serverUpdatedAt = serverUpdatedAt

      for (const entry of entries) {
        report.drained += 1
        report.byStore[entry.store] = (report.byStore[entry.store] ?? 0) + 1
        try {
          const conflicts = await applyToServer(local, server, entry, serverUpdatedAt)
          report.conflicts.push(...conflicts)
          await recordConflicts(local, conflicts, 'push', clock, newId, deviceId)
          await markEntry(local, entry, 'sent', null)
          report.sent += 1
        } catch (error) {
          await markEntry(local, entry, 'failed', messageOf(error))
          report.failed += 1
        }
      }

      const pushedAt = clock.now()
      for (const store of Object.keys(report.byStore)) {
        await updateSyncState(local, store, (state) => ({ ...state, last_pushed_at: pushedAt }))
      }
      return report
    },

    async pull() {
      const report: PullReport = { applied: 0, unchanged: 0, conflicts: [], cursors: [] }
      const pulledAt = clock.now()

      for (const store of SYNCED_STORES) {
        const state = await readSyncState(local, store)
        const rows = await rowsSince(server, store, state, keyRange)
        let cursor = { ts: state.cursor_server_updated_at, id: state.cursor_id }

        for (const row of rows) {
          const id = String(row.id)
          const base = (await fromRequest(
            readTx(local, [store]).objectStore(store).get(id),
          )) as Record<string, unknown> | undefined

          const merged = mergeRow({ store, base: base ?? null, incoming: row })
          report.conflicts.push(...merged.conflicts)
          await recordConflicts(local, merged.conflicts, 'pull', clock, newId, deviceId)

          // The envelope the server owns is copied across verbatim, outside the
          // merge. `mergeRow` refuses these fields from a patch on purpose (a
          // client that could write the cursor could hide its own rows from
          // every other device), and on the way IN they are exactly the fields
          // that tell this device the row is no longer unsynced.
          const envelopeChanged =
            base?.server_updated_at !== row.server_updated_at || base?.rev !== row.rev
          merged.row.server_updated_at = row.server_updated_at
          merged.row.rev = row.rev

          if (merged.applied.length > 0 || envelopeChanged) {
            const tx = writeTx(local, [store])
            tx.objectStore(store).put(merged.row)
            await fromTransaction(tx)
          }
          if (merged.applied.length > 0) report.applied += 1
          else report.unchanged += 1
          cursor = { ts: row.server_updated_at as number, id }
        }

        // A table with nothing new keeps the cursor it had, and is not written
        // back: a pull of an idle app would otherwise touch every synced table
        // on every poll, and the sync panel would list a cursor for tables that
        // have never carried a row.
        if (rows.length === 0) {
          report.cursors.push(state)
          continue
        }

        report.cursors.push(
          await updateSyncState(local, store, (current) => ({
            ...current,
            cursor_server_updated_at: cursor.ts,
            cursor_id: cursor.id,
            last_pulled_at: pulledAt,
          })),
        )
      }

      return report
    },

    async sync() {
      const push = await this.push()
      const pull = await this.pull()
      return { push, pull }
    },

    snapshot() {
      return readSnapshot(local, server)
    },

    close() {
      server.close()
    },
  }
}

// ---------------------------------------------------------------------------
// the server side
// ---------------------------------------------------------------------------

/**
 * The server's clock.
 *
 * Monotonic first and wall-clock second: it never returns a value it has
 * already issued, even if the injected clock is frozen (every test) or steps
 * backwards (a real machine correcting NTP drift). A cursor built on a clock
 * that can repeat a value silently loses every row written in the repeat.
 */
async function nextServerTick(server: IDBDatabase, clock: Clock): Promise<number> {
  // The server database is not the local schema, so it takes plain transactions
  // rather than the typed `writeTx` helper: its store list is the synced tables
  // plus one meta store, and pretending otherwise would need a cast per call.
  const tx = server.transaction([SERVER_META_STORE], 'readwrite')
  const store = tx.objectStore(SERVER_META_STORE)
  const previous = ((await fromRequest(store.get(SERVER_CLOCK_KEY))) as
    | { key: string; value: number }
    | undefined)?.value
  const next = Math.max((previous ?? 0) + 1, clock.now())
  store.put({ key: SERVER_CLOCK_KEY, value: next })
  await fromTransaction(tx)
  return next
}

/**
 * Applies one outbox entry to the server, under the store's merge policy.
 *
 * `base_rev` is what the writer believed when it wrote. The server does not use
 * it to reject a write: the policy decides field by field, so a patch written
 * against stale data still lands the fields nobody else touched. That is the
 * whole reason the outbox is patch-level rather than row-level.
 */
async function applyToServer(
  local: IDBDatabase,
  server: IDBDatabase,
  entry: OutboxEntry,
  serverUpdatedAt: number,
): Promise<MergeConflict[]> {
  // Read, decide, then write, each in its own transaction. An IndexedDB
  // transaction goes inactive the moment the task queue drains, so a read of
  // the LOCAL database in the middle of a SERVER transaction kills that
  // transaction, and the failure arrives later as an unrelated InvalidStateError.
  const base = (await fromRequest(
    server.transaction([entry.store], 'readonly').objectStore(entry.store).get(entry.row_id),
  )) as Record<string, unknown> | undefined

  let incoming: Record<string, unknown> = { ...entry.patch, id: entry.row_id }

  if (!base && entry.op !== 'put') {
    // A patch for a row the server has never seen. It is the normal case here
    // rather than an error, because the seeded dataset is history: hydration
    // writes it straight to disk with no outbox entries (D12), so the first
    // thing the server ever hears about a seeded clip is somebody approving it.
    //
    // Sending only the changed fields would create a row that is one field and
    // no clip, so the patch is promoted to the whole local row. A patch with no
    // local row either is a genuine defect and fails loudly below.
    const localRow = (await fromRequest(
      readTx(local, [entry.store as StoreName]).objectStore(entry.store).get(entry.row_id),
    )) as Record<string, unknown> | undefined
    if (!localRow) {
      throw new Error(
        `no row for ${entry.store}/${entry.row_id} on the server or on this device: nothing to merge into`,
      )
    }
    incoming = { ...localRow }
  }

  const merged = mergeRow({
    store: entry.store,
    base: base ?? null,
    incoming,
  })

  // Nothing changed, so nothing is stamped. Stamping anyway would move the row
  // to the head of every device's cursor and make them all re-pull a row that
  // is identical to the one they hold.
  if (merged.applied.length === 0 && base) return merged.conflicts

  const tx = server.transaction([entry.store], 'readwrite')
  tx.objectStore(entry.store).put({
    ...merged.row,
    server_updated_at: serverUpdatedAt,
    rev: typeof base?.rev === 'number' ? base.rev + 1 : 1,
  })
  await fromTransaction(tx)
  return merged.conflicts
}

/** One page of rows after the cursor, ordered by (server_updated_at, id). */
async function rowsSince(
  server: IDBDatabase,
  store: StoreName,
  state: SyncState,
  keyRange: typeof IDBKeyRange,
): Promise<Record<string, unknown>[]> {
  const index = server.transaction([store], 'readonly').objectStore(store).index('by_cursor')
  const lower: [number, string] = [state.cursor_server_updated_at ?? 0, state.cursor_id ?? '']
  // Exclusive lower bound: the cursor names the last row already applied.
  const range = keyRange.lowerBound(lower, true)

  const rows: Record<string, unknown>[] = []
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(range)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || rows.length >= PULL_BATCH) {
        resolve()
        return
      }
      rows.push(cursor.value as Record<string, unknown>)
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
  return rows
}

// ---------------------------------------------------------------------------
// the local side: outbox, cursors, conflicts
// ---------------------------------------------------------------------------

async function pendingEntries(local: IDBDatabase): Promise<OutboxEntry[]> {
  const all = (await fromRequest(
    readTx(local, ['outbox']).objectStore('outbox').getAll(),
  )) as OutboxEntry[]
  // Oldest first: causal order is the only order a patch stream can be applied
  // in, and `seq` is the local autoincrement that records it.
  return all.filter((entry) => entry.state === 'pending').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

async function markEntry(
  local: IDBDatabase,
  entry: OutboxEntry,
  state: OutboxEntry['state'],
  error: string | null,
): Promise<void> {
  const tx = writeTx(local, ['outbox'])
  // Entries are kept after sending rather than deleted, so the panel can show
  // what actually left this device instead of an empty queue and a claim.
  tx.objectStore('outbox').put({ ...entry, state, attempts: entry.attempts + 1, last_error: error })
  await fromTransaction(tx)
}

export async function readSyncState(local: IDBDatabase, store: string): Promise<SyncState> {
  const row = (await fromRequest(readTx(local, ['sync_state']).objectStore('sync_state').get(store))) as
    | SyncState
    | undefined
  return (
    row ?? {
      store,
      cursor_server_updated_at: null,
      cursor_id: null,
      last_pulled_at: null,
      last_pushed_at: null,
    }
  )
}

async function updateSyncState(
  local: IDBDatabase,
  store: string,
  update: (current: SyncState) => SyncState,
): Promise<SyncState> {
  const next = update(await readSyncState(local, store))
  const tx = writeTx(local, ['sync_state'])
  tx.objectStore('sync_state').put(next)
  await fromTransaction(tx)
  return next
}

async function recordConflicts(
  local: IDBDatabase,
  conflicts: MergeConflict[],
  direction: SyncConflict['direction'],
  clock: Clock,
  newId: () => string,
  deviceId: string,
): Promise<void> {
  if (conflicts.length === 0) return
  const detectedAt = clock.now()
  const tx = writeTx(local, ['sync_conflict'])
  const store = tx.objectStore('sync_conflict')
  for (const conflict of conflicts) {
    const row: SyncConflict = {
      id: newId(),
      store: conflict.store,
      row_id: conflict.row_id,
      fields: conflict.fields,
      policy: conflict.policy,
      kept: conflict.kept,
      refused: conflict.refused,
      detail: `${conflict.detail} (observed on ${deviceId})`,
      direction,
      detected_at: detectedAt,
      // Unresolved by construction. A human resolves it explicitly, because a
      // machine picking a side is how the disagreement disappears unrecorded.
      resolved_by: null,
      resolved_at: null,
    }
    store.put(row)
  }
  await fromTransaction(tx)
}

// ---------------------------------------------------------------------------
// what the panel reads
// ---------------------------------------------------------------------------

export interface StoreQueue {
  store: string
  pending: number
  sent: number
  failed: number
}

export interface SyncSnapshot {
  adapter: 'loopback'
  pending: number
  sent: number
  failed: number
  byStore: StoreQueue[]
  /** Newest first, with the real patch payloads. */
  entries: OutboxEntry[]
  /** Only the stores that have ever synced, so the list is readable. */
  cursors: SyncState[]
  conflicts: SyncConflict[]
  /** Rows the loopback server currently holds. */
  serverRows: number
}

export async function readSnapshot(
  local: IDBDatabase,
  server: IDBDatabase,
): Promise<SyncSnapshot> {
  const entries = (await fromRequest(
    readTx(local, ['outbox']).objectStore('outbox').getAll(),
  )) as OutboxEntry[]

  const queues = new Map<string, StoreQueue>()
  for (const entry of entries) {
    const queue = queues.get(entry.store) ?? { store: entry.store, pending: 0, sent: 0, failed: 0 }
    queue[entry.state] += 1
    queues.set(entry.store, queue)
  }

  const conflicts = (await fromRequest(
    readTx(local, ['sync_conflict']).objectStore('sync_conflict').getAll(),
  )) as SyncConflict[]

  const cursors: SyncState[] = []
  for (const store of SYNCED_STORES) {
    const state = await readSyncState(local, store)
    if (state.cursor_server_updated_at != null || state.last_pushed_at != null) cursors.push(state)
  }

  let serverRows = 0
  for (const store of SYNCED_STORES) {
    serverRows += await fromRequest(
      server.transaction([store], 'readonly').objectStore(store).count(),
    )
  }

  return {
    adapter: 'loopback',
    pending: entries.filter((entry) => entry.state === 'pending').length,
    sent: entries.filter((entry) => entry.state === 'sent').length,
    failed: entries.filter((entry) => entry.state === 'failed').length,
    byStore: [...queues.values()].sort((a, b) => a.store.localeCompare(b.store)),
    entries: [...entries].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)),
    cursors,
    conflicts: conflicts.sort((a, b) => b.detected_at - a.detected_at),
    serverRows,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
