/**
 * Seeding the demo profile.
 *
 * This is the one sanctioned bypass of the scoped repository, and it is worth
 * stating why rather than leaving it as an inconsistency.
 *
 * Seeded rows are already synced: they represent history, not work somebody did in
 * this session. Writing them through the repository would append two thousand
 * outbox entries and the app would open showing a huge pending queue implying
 * unsynced work that never happened. So hydration writes directly, with
 * `server_updated_at` already set, and touches nothing else. Every write after
 * boot goes through the repository.
 *
 * Idempotent: a `seed_version` marker in `meta` means a second boot does nothing.
 */

import { fromRequest, fromTransaction, readMeta, writeMeta } from './db'
import { buildSeed, type MediaManifest, type SeedResult } from './seed'
import type { StoreName } from './schema'
import { SeededClock, SEED_EPOCH_MS } from '@/platform/clock'
import { SeededRng, SEED_STRING } from '@/platform/rng'
import { createIdFactory } from '@/platform/id'

// v2: access token hashes became the real sha256 of the exported demo tokens,
// so the creator token link resolves through the same lookup production uses.
// v3: the HEVC case no longer carries an AI brief-item match, because a match
// claim on a clip nobody could decode is fabrication and the health panel
// counts it as such.
// v4: the demo visit date and the San Jose branch coordinates now match the
// fixture manifest's context, so the committed fixtures pre-flight in the demo
// exactly as the manifest says they must.
export const SEED_VERSION = 'seed-v4'
const SEED_VERSION_KEY = 'seed_version'

export interface HydrateResult {
  seeded: boolean
  version: string
  summary: SeedResult['summary'] | null
  elapsedMs: number
}

export interface HydrateDeps {
  db: IDBDatabase
  /** Injected so a test can supply a manifest without a network. */
  loadMediaManifest?: () => Promise<MediaManifest>
  /** Real time, only for reporting how long hydration took. */
  measure?: () => number
}

async function fetchMediaManifest(): Promise<MediaManifest> {
  const response = await fetch('/seed/media-manifest.json')
  if (!response.ok) {
    throw new Error(
      `seed media manifest missing (${response.status}). It is a committed artefact, so this means the file was deleted rather than not yet built.`,
    )
  }
  return (await response.json()) as MediaManifest
}

export async function hydrateIfNeeded(deps: HydrateDeps): Promise<HydrateResult> {
  const measure = deps.measure ?? (() => 0)
  const started = measure()

  const existing = await readMeta<string>(deps.db, SEED_VERSION_KEY)
  if (existing === SEED_VERSION) {
    return { seeded: false, version: SEED_VERSION, summary: null, elapsedMs: measure() - started }
  }

  const media = await (deps.loadMediaManifest ?? fetchMediaManifest)()

  // The same seeded clock and RNG the tests use, so the dataset is byte identical
  // on every run and a reviewer sees exactly what the README describes.
  const clock = new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: 1 })
  const rng = new SeededRng(SEED_STRING)
  const newId = createIdFactory(clock, rng)

  const result = buildSeed({ clock, rng, newId, media })

  const stores = Object.keys(result.rows) as StoreName[]
  // One transaction per store rather than one enormous one: a single transaction
  // spanning twenty stores holds locks for the whole hydration and blocks any
  // other tab, and a failure part way is harder to reason about.
  for (const store of stores) {
    const rows = result.rows[store] ?? []
    if (rows.length === 0) continue
    const tx = deps.db.transaction([store], 'readwrite')
    const objectStore = tx.objectStore(store)
    for (const row of rows) objectStore.put(row)
    await fromTransaction(tx)
  }

  await writeMeta(deps.db, SEED_VERSION_KEY, SEED_VERSION)

  return { seeded: true, version: SEED_VERSION, summary: result.summary, elapsedMs: measure() - started }
}

/** Row counts actually on disk, for the data health panel and for tests. */
export async function countRows(db: IDBDatabase, stores: StoreName[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const store of stores) {
    out[store] = await fromRequest(db.transaction([store], 'readonly').objectStore(store).count())
  }
  return out
}

/** Wipes the seed marker so the next boot rebuilds. Used by "reset demo data". */
export async function clearSeedMarker(db: IDBDatabase): Promise<void> {
  await writeMeta(db, SEED_VERSION_KEY, null)
}
