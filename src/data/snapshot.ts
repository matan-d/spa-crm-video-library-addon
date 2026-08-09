/**
 * Snapshot export and import, and the sentinel that makes eviction detectable.
 *
 * This is the remedy for the one failure mode this product cannot design around.
 * Every record lives in IndexedDB by constraint (U2), and IndexedDB is evictable:
 * a browser under storage pressure clears it, and on iOS the vendor documents it
 * as reclaimable with `navigator.storage.persist()` explicitly not planned
 * (`docs/09-shell-notes.md` P-13). There is nothing the web layer can do to stop
 * that. What it can do is refuse to lose the data silently, which is the whole
 * of this module.
 *
 * ## The sentinel
 *
 * A tiny record in `localStorage` (about 200 bytes, well inside the 50KB budget
 * U2 allows it) says "this profile had a database, with this many rows, at this
 * time". localStorage and IndexedDB are cleared together by an origin data wipe
 * but NOT by the storage pressure eviction that reclaims IndexedDB, so the pair
 * distinguishes three states that otherwise look identical on boot:
 *
 * - no sentinel, no database: a genuinely first visit. Hydrate.
 * - sentinel, database present: normal. Refresh the sentinel.
 * - **sentinel, database gone: eviction.** The user is told, by name, that their
 *   local records were reclaimed and what to do about it.
 *
 * The third case is the one that matters. Without the sentinel it is
 * indistinguishable from a first visit, so the app would cheerfully re-seed the
 * demo over somebody's real work and call it a fresh start.
 *
 * ## What the export contains, and what it deliberately does not
 *
 * Records only. Original video bytes live in OPFS and can be tens of gigabytes,
 * so a JSON snapshot that inlined them would be unopenable and would fail on the
 * first real library. The manifest therefore states the byte count it is NOT
 * carrying, so a restored snapshot reads as "records restored, N originals must
 * be re-uploaded" rather than as a complete backup that quietly is not one.
 *
 * Derived blobs (posters, contact sheets) are also excluded: they are
 * reproducible from the originals, and a backup that doubles in size to carry
 * regenerable data is a backup people stop taking.
 */

import { fromRequest, fromTransaction, readMeta, writeMeta } from './db'
import { LOCAL_ONLY_STORES, STORES, type StoreName } from './schema'

export const SNAPSHOT_FORMAT = 'astolia.snapshot.v1'

export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT
  /** The schema the rows were written against. An import refuses a newer one. */
  schema_version: number
  profile: string
  exported_at: number
  seed_version: string | null
  counts: Record<string, number>
  total_rows: number
  /**
   * What this file is not carrying, stated rather than implied.
   * A backup whose gaps are undocumented is discovered during a restore.
   */
  excluded: {
    original_bytes: 'OPFS originals are not included in a records snapshot'
    derived_blobs: 'posters and contact sheets are reproducible from the originals'
    local_only_stores: StoreName[]
  }
}

export interface Snapshot {
  manifest: SnapshotManifest
  rows: Record<string, Record<string, unknown>[]>
}

const SEED_VERSION_KEY = 'seed_version'

/** Stores worth exporting: everything the server would hold, plus nothing local. */
function exportableStores(db: IDBDatabase): StoreName[] {
  const localOnly = new Set<string>(LOCAL_ONLY_STORES)
  return STORES.map((spec) => spec.name).filter(
    (name) =>
      // `blob` is excluded by size, `meta` because it describes this database
      // rather than the records in it, and a restore writes its own.
      name !== 'blob' && name !== 'meta' && !localOnly.has(name) && db.objectStoreNames.contains(name),
  )
}

export async function exportSnapshot(
  db: IDBDatabase,
  profile: string,
  now: number,
): Promise<Snapshot> {
  const stores = exportableStores(db)
  const rows: Record<string, Record<string, unknown>[]> = {}
  const counts: Record<string, number> = {}

  for (const store of stores) {
    const tx = db.transaction([store], 'readonly')
    const all = (await fromRequest(tx.objectStore(store).getAll())) as Record<string, unknown>[]
    // Soft deleted rows are carried. A restore that dropped them would
    // resurrect anything another device had deleted the moment the two synced.
    rows[store] = all
    counts[store] = all.length
  }

  return {
    manifest: {
      format: SNAPSHOT_FORMAT,
      schema_version: db.version,
      profile,
      exported_at: now,
      seed_version: (await readMeta<string>(db, SEED_VERSION_KEY)) ?? null,
      counts,
      total_rows: Object.values(counts).reduce((sum, n) => sum + n, 0),
      excluded: {
        original_bytes: 'OPFS originals are not included in a records snapshot',
        derived_blobs: 'posters and contact sheets are reproducible from the originals',
        local_only_stores: [...LOCAL_ONLY_STORES],
      },
    },
    rows,
  }
}

export interface ImportReport {
  restored: Record<string, number>
  total: number
  skipped: string[]
}

/**
 * Restores a snapshot over the current database.
 *
 * Rows are `put`, not cleared-then-written. A restore that emptied the database
 * first would turn a snapshot missing one table into data loss, and the failure
 * would happen after the point of no return. Merging leaves anything the
 * snapshot does not mention alone, which is the safe direction for a restore to
 * be wrong in.
 */
export async function importSnapshot(db: IDBDatabase, snapshot: unknown): Promise<ImportReport> {
  const parsed = snapshot as Snapshot
  if (!parsed || typeof parsed !== 'object' || parsed.manifest?.format !== SNAPSHOT_FORMAT) {
    throw new Error('That file is not an Astolia snapshot. Nothing was changed.')
  }
  if (parsed.manifest.schema_version > db.version) {
    // Refuse loudly rather than write rows this schema has no indexes for.
    throw new Error(
      `That snapshot was written against schema version ${parsed.manifest.schema_version} and this build is version ${db.version}. Nothing was changed.`,
    )
  }

  const restored: Record<string, number> = {}
  const skipped: string[] = []
  const writable = new Set(exportableStores(db))

  for (const [store, rows] of Object.entries(parsed.rows ?? {})) {
    if (!writable.has(store as StoreName)) {
      skipped.push(store)
      continue
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      restored[store] = 0
      continue
    }
    const tx = db.transaction([store], 'readwrite')
    const objectStore = tx.objectStore(store)
    for (const row of rows) objectStore.put(row)
    await fromTransaction(tx)
    restored[store] = rows.length
  }

  if (parsed.manifest.seed_version) {
    // So a restored database is not re-seeded over on the next boot.
    await writeMeta(db, SEED_VERSION_KEY, parsed.manifest.seed_version)
  }

  return { restored, total: Object.values(restored).reduce((sum, n) => sum + n, 0), skipped }
}

// ---------------------------------------------------------------------------
// the sentinel
// ---------------------------------------------------------------------------

export interface Sentinel {
  profile: string
  rows: number
  at: number
}

export type StorageVerdict =
  /** No sentinel and no rows: a genuinely first visit. */
  | { state: 'first_run' }
  /** Sentinel and rows: normal. */
  | { state: 'intact'; rows: number }
  /** Sentinel says there were rows and there are none: the browser reclaimed them. */
  | { state: 'evicted'; expected: number; at: number }

export function sentinelKey(profile: string): string {
  return `astolia.sentinel.${profile}`
}

/**
 * Reads what happened between the last session and this one.
 *
 * Pure, and takes both readings as arguments, because the interesting logic is
 * the comparison and it must be testable without a browser.
 */
export function verdictFrom(sentinel: Sentinel | null, currentRows: number): StorageVerdict {
  if (!sentinel || sentinel.rows === 0) {
    return currentRows > 0 ? { state: 'intact', rows: currentRows } : { state: 'first_run' }
  }
  // A partial loss is still a loss, but IndexedDB eviction is all or nothing per
  // origin, so the only case worth naming is "we had rows and now we have none".
  if (currentRows === 0) return { state: 'evicted', expected: sentinel.rows, at: sentinel.at }
  return { state: 'intact', rows: currentRows }
}

export function readSentinel(storage: Storage, profile: string): Sentinel | null {
  try {
    const raw = storage.getItem(sentinelKey(profile))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Sentinel
    return typeof parsed?.rows === 'number' ? parsed : null
  } catch {
    // A corrupt sentinel is treated as absent. Guessing at it would be worse
    // than losing the eviction signal for one boot.
    return null
  }
}

export function writeSentinel(storage: Storage, sentinel: Sentinel): void {
  try {
    storage.setItem(sentinelKey(sentinel.profile), JSON.stringify(sentinel))
  } catch {
    // localStorage full or blocked. The app works without the sentinel; it just
    // loses the ability to tell eviction from a first visit, so this is not
    // worth failing a boot over.
  }
}

/** Counts rows across the exportable stores, which is what the sentinel records. */
export async function countRecords(db: IDBDatabase): Promise<number> {
  let total = 0
  for (const store of exportableStores(db)) {
    const tx = db.transaction([store], 'readonly')
    total += (await fromRequest(tx.objectStore(store).count())) as number
  }
  return total
}
