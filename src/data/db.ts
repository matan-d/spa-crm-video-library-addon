/**
 * Opening the local database, and the migration runner.
 *
 * Nothing outside src/data opens a connection. Components never see an
 * IDBDatabase, because the scoped repository (F3) is the only reader and writer,
 * and it is also the only thing that appends to the outbox (F4). One choke point
 * for scope and for sync.
 */

import { MIGRATIONS, SCHEMA_VERSION, STORE_NAMES, type StoreName } from './schema'
import { databaseName, type ProfileId } from './profile'

export interface OpenResult {
  db: IDBDatabase
  profile: ProfileId
  /** Version found on disk before this open. 0 means the database did not exist. */
  previousVersion: number
  version: number
  /** Migrations actually executed during this open, in order. */
  applied: number[]
}

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This database was written by a newer version of the app (schema ${found}, this build supports ${supported}). ` +
        'Reload to get the current build rather than letting an older bundle write rows in an older shape.',
    )
    this.name = 'SchemaTooNewError'
  }
}

/**
 * Opens (and migrates) the database for a profile.
 *
 * The `indexedDB` factory is injected so tests can pass fake-indexeddb without a
 * global, and so a future shell can pass its own implementation.
 */
export async function openDatabase(
  profile: ProfileId,
  factory: IDBFactory = indexedDB,
): Promise<OpenResult> {
  const name = databaseName(profile)
  const applied: number[] = []
  let previousVersion = 0

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, SCHEMA_VERSION)

    request.onupgradeneeded = (event) => {
      previousVersion = event.oldVersion
      const target = request.result
      const tx = request.transaction
      if (!tx) {
        reject(new Error('openDatabase: upgrade fired without a transaction'))
        return
      }

      // A version on disk higher than ours cannot happen through this path
      // (IndexedDB rejects a downgrade before firing upgradeneeded), but a
      // mismatch is worth naming explicitly rather than trusting.
      if (event.oldVersion > SCHEMA_VERSION) {
        reject(new SchemaTooNewError(event.oldVersion, SCHEMA_VERSION))
        return
      }

      for (const migration of MIGRATIONS) {
        if (migration.version <= event.oldVersion) continue
        if (migration.version > SCHEMA_VERSION) continue
        migration.up(target, tx)
        applied.push(migration.version)
      }
    }

    request.onsuccess = () => resolve(request.result)

    // A blocked open means another tab holds an older version open. That is the
    // stale-tab case, and it must surface rather than hang forever.
    request.onblocked = () =>
      reject(
        new Error(
          'openDatabase: blocked by another open tab holding an older schema. Close other tabs of this app and reload.',
        ),
      )

    request.onerror = () => reject(request.error ?? new Error('openDatabase: unknown error'))
  })

  // A database that exists but is missing a store means a migration was
  // interrupted or hand-edited. Better to refuse than to fail later on a read
  // that returns nothing and looks like missing data.
  const missing = STORE_NAMES.filter((s) => !db.objectStoreNames.contains(s))
  if (missing.length > 0) {
    db.close()
    throw new Error(
      `openDatabase: schema is incomplete, missing object stores: ${missing.join(', ')}. Delete the database and reload to rebuild it.`,
    )
  }

  return { db, profile, previousVersion, version: db.version, applied }
}

/**
 * Deletes a profile's database entirely.
 *
 * Used by "Reset demo data". Deleting rather than clearing each store also resets
 * the schema version, which is what you actually want after a migration change,
 * and it cannot leave orphaned rows in a store somebody forgot to include.
 */
export async function deleteProfileDatabase(
  profile: ProfileId,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(databaseName(profile))
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteProfileDatabase: unknown error'))
    request.onblocked = () =>
      reject(new Error('deleteProfileDatabase: blocked by an open connection. Close other tabs and retry.'))
  })
}

/** Promise wrapper for a single IndexedDB request. */
export function fromRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/** Promise that settles when a transaction completes or fails. */
export function fromTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
  })
}

export function readTx(db: IDBDatabase, stores: StoreName[]): IDBTransaction {
  return db.transaction(stores, 'readonly')
}

export function writeTx(db: IDBDatabase, stores: StoreName[]): IDBTransaction {
  return db.transaction(stores, 'readwrite')
}

/** Reads a `meta` value. The meta store holds the seed version marker and similar. */
export async function readMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  const row = await fromRequest(readTx(db, ['meta']).objectStore('meta').get(key))
  return (row as { key: string; value: T } | undefined)?.value
}

export async function writeMeta(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = writeTx(db, ['meta'])
  tx.objectStore('meta').put({ key, value })
  await fromTransaction(tx)
}
