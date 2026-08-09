import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, readMeta } from '@/data/db'
import { hydrateIfNeeded } from '@/data/hydrate'
import { createScopedRepo } from '@/data/repo'
import { managerSession } from '@/data/scope'
import {
  SNAPSHOT_FORMAT,
  countRecords,
  exportSnapshot,
  importSnapshot,
  readSentinel,
  sentinelKey,
  verdictFrom,
  writeSentinel,
  type Snapshot,
} from '@/data/snapshot'
import { SEED_ORG_ID } from '@/data/seed'
import type { Asset, Creator } from '@/data/types'
import { media } from './media-fixture'

/** A localStorage stand-in, because jsdom's is shared across a whole file. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage
}

// ---------------------------------------------------------------------------
// the sentinel: telling eviction from a first visit
// ---------------------------------------------------------------------------

describe('verdictFrom', () => {
  it('reads no sentinel and no rows as a genuinely first visit', () => {
    expect(verdictFrom(null, 0)).toEqual({ state: 'first_run' })
  })

  it('reads a sentinel plus rows as intact', () => {
    expect(verdictFrom({ profile: 'demo', rows: 900, at: 1 }, 912)).toEqual({
      state: 'intact',
      rows: 912,
    })
  })

  it('reads a sentinel saying we had rows, plus none now, as eviction', () => {
    // This is the case the sentinel exists for. Without it, an evicted database
    // is indistinguishable from a first visit, so the app would re-seed the demo
    // over somebody's real work and call it a fresh start.
    expect(verdictFrom({ profile: 'live', rows: 431, at: 12_345 }, 0)).toEqual({
      state: 'evicted',
      expected: 431,
      at: 12_345,
    })
  })

  it('never claims eviction from a sentinel that recorded an empty database', () => {
    // The live profile starts empty on purpose. Calling that eviction on the
    // second visit would be a false alarm on the one profile holding real work.
    expect(verdictFrom({ profile: 'live', rows: 0, at: 5 }, 0)).toEqual({ state: 'first_run' })
  })

  it('does not treat a partial row count as loss, because eviction is all or nothing', () => {
    // A database with fewer rows than last time is normal: somebody deleted
    // things. Only "we had rows and now have none" is the browser's doing.
    expect(verdictFrom({ profile: 'demo', rows: 900, at: 1 }, 3)).toEqual({ state: 'intact', rows: 3 })
  })
})

describe('the sentinel record', () => {
  it('round trips through storage under a profile scoped key', () => {
    const storage = fakeStorage()
    writeSentinel(storage, { profile: 'demo', rows: 42, at: 7 })
    expect(readSentinel(storage, 'demo')).toEqual({ profile: 'demo', rows: 42, at: 7 })
    // Demo and live are separate databases, so they are separate sentinels.
    expect(readSentinel(storage, 'live')).toBeNull()
  })

  it('treats a corrupt sentinel as absent rather than guessing at it', () => {
    const storage = fakeStorage()
    storage.setItem(sentinelKey('demo'), 'not json{')
    expect(readSentinel(storage, 'demo')).toBeNull()
  })

  it('survives a storage that refuses to write, because a boot must not fail over it', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage
    expect(() => writeSentinel(refusing, { profile: 'demo', rows: 1, at: 1 })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// export and import
// ---------------------------------------------------------------------------

describe('the snapshot', () => {
  let factory: IDBFactory
  let db: IDBDatabase

  beforeEach(async () => {
    factory = new IDBFactory()
    db = (await openDatabase('demo', factory)).db
    await hydrateIfNeeded({ db, loadMediaManifest: async () => media(), measure: () => 0 })
  })

  it('carries the records and states what it is not carrying', async () => {
    const snapshot = await exportSnapshot(db, 'demo', 1_700_000_000_000)

    expect(snapshot.manifest.format).toBe(SNAPSHOT_FORMAT)
    expect(snapshot.manifest.profile).toBe('demo')
    expect(snapshot.manifest.total_rows).toBeGreaterThan(0)
    expect(snapshot.manifest.seed_version).not.toBeNull()
    expect(snapshot.rows.asset!.length).toBeGreaterThan(0)

    // The gaps are documented rather than discovered during a restore.
    expect(snapshot.manifest.excluded.original_bytes).toMatch(/OPFS/)
    expect(snapshot.manifest.excluded.derived_blobs).toMatch(/reproducible/)
  })

  it('never inlines the derived blobs, because size is why nobody takes backups', async () => {
    const snapshot = await exportSnapshot(db, 'demo', 1)
    expect(snapshot.rows.blob).toBeUndefined()
  })

  it('leaves local-only stores out, because they describe this machine', async () => {
    const snapshot = await exportSnapshot(db, 'demo', 1)
    for (const store of snapshot.manifest.excluded.local_only_stores) {
      expect(snapshot.rows[store]).toBeUndefined()
    }
  })

  it('restores into an empty database of the same schema', async () => {
    const snapshot = await exportSnapshot(db, 'demo', 1)

    const fresh = (await openDatabase('live', new IDBFactory())).db
    expect(await countRecords(fresh)).toBe(0)

    const report = await importSnapshot(fresh, snapshot)
    expect(report.total).toBe(snapshot.manifest.total_rows)
    expect(await countRecords(fresh)).toBe(snapshot.manifest.total_rows)

    // And the restored rows are readable through the scope, not just present.
    const repo = createScopedRepo({
      db: fresh,
      session: managerSession({ org_id: SEED_ORG_ID, user_id: 'user-manager', branch_scope: null }),
      now: () => 1,
      newId: () => 'x',
      deviceId: 'device-test',
    })
    expect((await repo.list<Asset>('asset')).length).toBeGreaterThan(0)
  })

  it('does not re-seed a restored database, because the seed marker travels with it', async () => {
    const snapshot = await exportSnapshot(db, 'demo', 1)
    const fresh = (await openDatabase('live', new IDBFactory())).db
    await importSnapshot(fresh, snapshot)
    expect(await readMeta<string>(fresh, 'seed_version')).toBe(snapshot.manifest.seed_version)
  })

  it('merges rather than clearing first, so a partial snapshot is not data loss', async () => {
    const repo = createScopedRepo({
      db,
      session: managerSession({ org_id: SEED_ORG_ID, user_id: 'user-manager', branch_scope: null }),
      now: () => 1,
      newId: () => 'creator-added-after-export',
      deviceId: 'device-test',
    })
    const snapshot = await exportSnapshot(db, 'demo', 1)

    // A row that exists locally and is absent from the snapshot.
    await repo.create('creator', {
      display_name: 'Added after the export',
      primary_handle: '@later',
      lifecycle: 'prospect',
      platforms: [],
      fit_reasons: [],
      risk_flags: [],
      reliability_tier: 'new',
    })

    await importSnapshot(db, snapshot)

    const after = await repo.get<Creator>('creator', 'creator-added-after-export')
    expect(after).toBeDefined()
  })

  it('carries soft deleted rows, so a restore does not resurrect deleted work', async () => {
    const repo = createScopedRepo({
      db,
      session: managerSession({ org_id: SEED_ORG_ID, user_id: 'user-manager', branch_scope: null }),
      now: () => 99,
      newId: () => 'x',
      deviceId: 'device-test',
    })
    const [creator] = await repo.list<Creator>('creator', { limit: 1 })
    await repo.softDelete('creator', creator!.id)

    const snapshot = await exportSnapshot(db, 'demo', 1)
    const row = snapshot.rows.creator!.find((entry) => entry.id === creator!.id)
    expect(row).toBeDefined()
    expect(row!.deleted_at).not.toBeNull()

    // Restored into a database that still has the row live, the deletion wins,
    // which is the point: a restore that dropped tombstones would un-delete
    // everything the moment two devices synced.
    const fresh = (await openDatabase('live', new IDBFactory())).db
    await importSnapshot(fresh, snapshot)
    const freshRepo = createScopedRepo({
      db: fresh,
      session: managerSession({ org_id: SEED_ORG_ID, user_id: 'user-manager', branch_scope: null }),
      now: () => 1,
      newId: () => 'x',
      deviceId: 'device-test',
    })
    expect(await freshRepo.get('creator', creator!.id)).toBeUndefined()
  })

  it('refuses a file that is not a snapshot, and changes nothing', async () => {
    const before = await countRecords(db)
    await expect(importSnapshot(db, { hello: 'world' })).rejects.toThrow(/not an Astolia snapshot/)
    expect(await countRecords(db)).toBe(before)
  })

  it('refuses a snapshot from a newer schema rather than writing rows it cannot index', async () => {
    const snapshot = await exportSnapshot(db, 'demo', 1)
    const fromTheFuture: Snapshot = {
      ...snapshot,
      manifest: { ...snapshot.manifest, schema_version: db.version + 5 },
    }
    await expect(importSnapshot(db, fromTheFuture)).rejects.toThrow(/schema version/)
  })
})
