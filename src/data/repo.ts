/**
 * The scoped repository, and the outbox, in one layer.
 *
 * These are deliberately the same object. The outbox is fed by every mutation, so
 * building it separately later would mean reopening every write path in the
 * application. Built together, the repository is the only writer and the outbox
 * append is one line inside it, which is also why there is exactly one choke point
 * for both visibility and sync.
 *
 * No component may open a transaction or touch IndexedDB directly. If a view needs
 * data, it asks the repository, and the repository decides what that session is
 * allowed to see.
 */

import { fromRequest, fromTransaction, readTx, writeTx } from './db'
import { INDEXED_BOOLEANS, LOCAL_ONLY_STORES, type StoreName } from './schema'
import {
  assertReadable,
  assertWritable,
  project,
  visible,
  type Session,
} from './scope'
import type { Envelope, OutboxEntry } from './types'

export interface RepoDeps {
  db: IDBDatabase
  session: Session
  now: () => number
  newId: () => string
  /** Identifies this client in the sync envelope, so a conflict can name its origin. */
  deviceId: string
}

export interface ListOptions {
  /** Index to walk, otherwise the primary key order. */
  index?: string
  /** Exact key, or a range. */
  key?: IDBValidKey | IDBKeyRange
  limit?: number
  /** Applied after the scope predicate, never instead of it. */
  where?: (row: Record<string, unknown>) => boolean
}

export interface ScopedRepo {
  readonly session: Session
  get<T = Record<string, unknown>>(store: StoreName, id: string): Promise<T | undefined>
  list<T = Record<string, unknown>>(store: StoreName, options?: ListOptions): Promise<T[]>
  count(store: StoreName, options?: ListOptions): Promise<number>
  /** Inserts a new row, filling the envelope. Returns the id. */
  create(store: StoreName, value: Record<string, unknown>): Promise<string>
  /** Patches named fields only. A patch, not a whole-row write, so two devices editing different fields do not collide. */
  patch(store: StoreName, id: string, changes: Record<string, unknown>): Promise<void>
  /** Soft delete. There is no hard delete in this application. */
  softDelete(store: StoreName, id: string): Promise<void>
  /** Pending outbox entries, oldest first. */
  pendingOutbox(limit?: number): Promise<OutboxEntry[]>
  outboxDepth(): Promise<number>
}

export function createScopedRepo(deps: RepoDeps): ScopedRepo {
  const { db, session, now, newId, deviceId } = deps

  async function readRows(store: StoreName, options: ListOptions = {}): Promise<Record<string, unknown>[]> {
    assertReadable(session, store)

    const tx = readTx(db, [store])
    const objectStore = tx.objectStore(store)
    const source = options.index ? objectStore.index(options.index) : objectStore

    const rows: Record<string, unknown>[] = []
    const limit = options.limit ?? Number.POSITIVE_INFINITY

    await new Promise<void>((resolve, reject) => {
      const request = source.openCursor(options.key ?? null)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || rows.length >= limit) {
          resolve()
          return
        }
        const row = cursor.value as Record<string, unknown>
        // Scope first, caller filter second. Never the other way round, or a
        // caller could widen its own visibility by passing a clever predicate.
        if (visible(session, store, row) && (!options.where || options.where(row))) {
          rows.push(row)
        }
        cursor.continue()
      }
      request.onerror = () => reject(request.error)
    })

    return rows
  }

  return {
    session,

    async get(store, id) {
      assertReadable(session, store)
      const row = (await fromRequest(readTx(db, [store]).objectStore(store).get(id))) as
        | Record<string, unknown>
        | undefined
      if (!row) return undefined
      // A row the session cannot see reads as absent rather than as forbidden.
      // Distinguishing the two leaks existence, which is a real leak class: it
      // tells a caller that a record they may not read is nonetheless there.
      if (!visible(session, store, row)) return undefined
      return project(session, store, row) as never
    },

    async list(store, options) {
      const rows = await readRows(store, options)
      return rows.map((row) => project(session, store, row)) as never
    },

    async count(store, options) {
      return (await readRows(store, options)).length
    },

    async create(store, value) {
      assertWritable(session, store)
      const timestamp = now()
      const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : newId()

      const row: Record<string, unknown> = {
        ...value,
        id,
        org_id: value.org_id ?? session.org_id,
        created_at: value.created_at ?? timestamp,
        updated_at: timestamp,
        server_updated_at: null,
        deleted_at: null,
        rev: 1,
        origin_device: deviceId,
      }
      writeBooleanMirrors(row)

      const tx = writeTx(db, storesFor(store))
      tx.objectStore(store).put(row)
      appendOutbox(tx, { store, row_id: id, op: 'put', patch: row, base_rev: 0, queued_at: timestamp })
      await fromTransaction(tx)
      return id
    },

    async patch(store, id, changes) {
      assertWritable(session, store)
      const timestamp = now()

      const tx = writeTx(db, storesFor(store))
      const objectStore = tx.objectStore(store)
      const existing = (await fromRequest(objectStore.get(id))) as
        | (Record<string, unknown> & Envelope)
        | undefined

      if (!existing) throw new Error(`patch: ${store}/${id} does not exist`)
      if (!visible(session, store, existing)) {
        // Refuse rather than silently no-op: a caller that thinks it wrote and did
        // not is worse than one told it may not.
        throw new Error(`patch: ${store}/${id} is not visible to this session`)
      }

      const merged: Record<string, unknown> = {
        ...existing,
        ...changes,
        id,
        updated_at: timestamp,
        rev: (existing.rev ?? 0) + 1,
        origin_device: deviceId,
      }
      writeBooleanMirrors(merged)
      objectStore.put(merged)

      // Only the changed fields go to the outbox, plus the mirrors those fields
      // imply, so a field-level merge is possible on the far side.
      const patch: Record<string, unknown> = { ...changes, updated_at: timestamp }
      for (const [field, mirror] of Object.entries(INDEXED_BOOLEANS)) {
        if (field in changes) patch[mirror] = merged[mirror]
      }

      appendOutbox(tx, {
        store,
        row_id: id,
        op: 'patch',
        patch,
        base_rev: existing.rev ?? 0,
        queued_at: timestamp,
      })
      await fromTransaction(tx)
    },

    async softDelete(store, id) {
      assertWritable(session, store)
      const timestamp = now()

      const tx = writeTx(db, storesFor(store))
      const objectStore = tx.objectStore(store)
      const existing = (await fromRequest(objectStore.get(id))) as
        | (Record<string, unknown> & Envelope)
        | undefined
      if (!existing) return
      if (!visible(session, store, existing)) {
        throw new Error(`softDelete: ${store}/${id} is not visible to this session`)
      }

      const merged = {
        ...existing,
        deleted_at: timestamp,
        updated_at: timestamp,
        rev: (existing.rev ?? 0) + 1,
        origin_device: deviceId,
      }
      objectStore.put(merged)
      appendOutbox(tx, {
        store,
        row_id: id,
        op: 'soft_delete',
        patch: { deleted_at: timestamp, updated_at: timestamp },
        base_rev: existing.rev ?? 0,
        queued_at: timestamp,
      })
      await fromTransaction(tx)
    },

    async pendingOutbox(limit) {
      const rows = (await fromRequest(
        readTx(db, ['outbox']).objectStore('outbox').getAll(),
      )) as OutboxEntry[]
      const pending = rows.filter((entry) => entry.state === 'pending')
      return limit ? pending.slice(0, limit) : pending
    },

    async outboxDepth() {
      return (await this.pendingOutbox()).length
    },
  }
}

/**
 * Local-only stores never reach the outbox, so a write to one does not need the
 * outbox in its transaction.
 */
function storesFor(store: StoreName): StoreName[] {
  return LOCAL_ONLY_STORES.includes(store) ? [store] : [store, 'outbox']
}

/**
 * Writes the integer mirror for every indexed boolean present on the row.
 *
 * IndexedDB cannot use `true` as a key, so an index on a raw boolean silently
 * returns nothing. Doing this here rather than at call sites means a caller cannot
 * forget, and a new indexed boolean only has to be declared once in the schema.
 */
function writeBooleanMirrors(row: Record<string, unknown>): void {
  for (const [field, mirror] of Object.entries(INDEXED_BOOLEANS)) {
    if (field in row) row[mirror] = row[field] ? 1 : 0
  }
}

function appendOutbox(
  tx: IDBTransaction,
  entry: Omit<OutboxEntry, 'state' | 'attempts' | 'last_error' | 'seq'>,
): void {
  if (!tx.objectStoreNames.contains('outbox')) return
  const full: Omit<OutboxEntry, 'seq'> = {
    ...entry,
    state: 'pending',
    attempts: 0,
    last_error: null,
  }
  tx.objectStore('outbox').add(full)
}
