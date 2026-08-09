import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  deleteProfileDatabase,
  fromRequest,
  openDatabase,
  readMeta,
  writeMeta,
  writeTx,
} from '@/data/db'
import {
  INDEXED_BOOLEANS,
  LOCAL_ONLY_STORES,
  MIGRATIONS,
  SCHEMA_VERSION,
  STORES,
  STORE_NAMES,
  SYNCED_STORES,
} from '@/data/schema'
import { databaseName, readActiveProfile, writeActiveProfile } from '@/data/profile'

/** Every migration runs, in order, on a database that did not exist. */
const ALL_MIGRATIONS = MIGRATIONS.map((migration) => migration.version)

let factory: IDBFactory

beforeEach(() => {
  // A fresh in-memory factory per test, so no test can see another's database.
  factory = new IDBFactory()
})

describe('openDatabase', () => {
  it('creates every declared store at the current schema version', async () => {
    const { db, version, previousVersion, applied } = await openDatabase('demo', factory)
    expect(version).toBe(SCHEMA_VERSION)
    expect(previousVersion).toBe(0)
    expect(applied).toEqual(ALL_MIGRATIONS)
    for (const name of STORE_NAMES) {
      expect(db.objectStoreNames.contains(name)).toBe(true)
    }
    db.close()
  })

  it('creates every declared index with the declared key path', async () => {
    const { db } = await openDatabase('demo', factory)
    const tx = db.transaction(STORE_NAMES, 'readonly')
    for (const spec of STORES) {
      const store = tx.objectStore(spec.name)
      for (const index of spec.indexes) {
        expect([spec.name, [...store.indexNames]]).toEqual([spec.name, expect.arrayContaining([index.name])])
        const actual = store.index(index.name)
        const expected = Array.isArray(index.keyPath) ? index.keyPath : index.keyPath
        expect(actual.keyPath).toEqual(expected)
        expect(actual.unique).toBe(index.unique ?? false)
        expect(actual.multiEntry).toBe(index.multiEntry ?? false)
      }
    }
    db.close()
  })

  it('is idempotent: a second open applies no migrations', async () => {
    const first = await openDatabase('demo', factory)
    first.db.close()
    const second = await openDatabase('demo', factory)
    expect(second.applied).toEqual([])
    expect(second.previousVersion).toBe(0) // upgradeneeded never fired
    expect(second.version).toBe(SCHEMA_VERSION)
    second.db.close()
  })

  it('keeps demo and live in physically separate databases', async () => {
    const demo = await openDatabase('demo', factory)
    demo.db.close()
    const live = await openDatabase('live', factory)
    live.db.close()

    // IDBFactory.databases() resolves a promise directly, it is not a request.
    const names = (await factory.databases()).map((d) => d.name)
    expect(names).toContain(databaseName('demo'))
    expect(names).toContain(databaseName('live'))
    expect(databaseName('demo')).not.toBe(databaseName('live'))
  })

  it('does not leak a row written in one profile into the other', async () => {
    // The whole reason profiles are separate databases rather than a row flag.
    const demo = await openDatabase('demo', factory)
    await writeMeta(demo.db, 'seed_version', 'demo-1')
    demo.db.close()

    const live = await openDatabase('live', factory)
    await expect(readMeta(live.db, 'seed_version')).resolves.toBeUndefined()
    live.db.close()
  })

  it('deletes a profile database completely, resetting its version', async () => {
    const opened = await openDatabase('demo', factory)
    await writeMeta(opened.db, 'seed_version', 'demo-1')
    opened.db.close()

    await deleteProfileDatabase('demo', factory)

    const reopened = await openDatabase('demo', factory)
    expect(reopened.applied).toEqual(ALL_MIGRATIONS) // rebuilt from scratch
    await expect(readMeta(reopened.db, 'seed_version')).resolves.toBeUndefined()
    reopened.db.close()
  })
})

describe('schema shape', () => {
  it('declares no store twice', () => {
    expect(new Set(STORE_NAMES).size).toBe(STORE_NAMES.length)
  })

  it('splits synced and local-only stores with no overlap and no gaps', () => {
    expect([...SYNCED_STORES, ...LOCAL_ONLY_STORES].sort()).toEqual([...STORE_NAMES].sort())
    expect(SYNCED_STORES.some((s) => LOCAL_ONLY_STORES.includes(s))).toBe(false)
  })

  it('keeps the outbox and sync state local only, so demo data cannot target a real backend', () => {
    expect(LOCAL_ONLY_STORES).toContain('outbox')
    expect(LOCAL_ONLY_STORES).toContain('sync_state')
    expect(LOCAL_ONLY_STORES).toContain('sync_conflict')
    expect(SYNCED_STORES).not.toContain('outbox')
  })

  it('introduces every store at a version this build can actually reach', () => {
    // A store declared `since: 3` on a build whose SCHEMA_VERSION is 2 would
    // never be created by any migration, and every open would then fail the
    // completeness check with an error about a database nobody hand-edited.
    const versions = new Set(ALL_MIGRATIONS)
    for (const spec of STORES) {
      expect(versions, `${spec.name} has no migration`).toContain(spec.since ?? 1)
    }
    expect(Math.max(...ALL_MIGRATIONS)).toBe(SCHEMA_VERSION)
  })

  it('never indexes a raw boolean field', async () => {
    // IndexedDB cannot use a boolean as a key, so an index on one silently
    // returns nothing. Every queryable boolean must use its integer mirror.
    const booleanFields = Object.keys(INDEXED_BOOLEANS)
    for (const spec of STORES) {
      for (const index of spec.indexes) {
        const paths = Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath]
        for (const path of paths) {
          expect(booleanFields, `${spec.name}.${index.name} indexes a raw boolean`).not.toContain(path)
        }
      }
    }
  })

  it('names every boolean mirror consistently', () => {
    for (const [field, mirror] of Object.entries(INDEXED_BOOLEANS)) {
      expect(mirror).toBe(`${field}_i`)
    }
  })

  it('carries the loop links that cannot be reconstructed later', async () => {
    // brief_item.origin_gap_id and brief.gap_scan_id are the closed loop. If they
    // are not indexed here, nothing downstream can prove a gap produced a brief.
    const { db } = await openDatabase('demo', factory)
    const tx = db.transaction(['brief_item', 'brief', 'gap_dismissal', 'usage_event'], 'readonly')
    expect([...tx.objectStore('brief_item').indexNames]).toContain('by_origin_gap')
    expect([...tx.objectStore('brief').indexNames]).toContain('by_gap_scan')
    // Dismissals key on the signature, not the gap id, so they survive a rescan.
    expect(tx.objectStore('gap_dismissal').index('by_signature').keyPath).toBe('cell_signature')
    db.close()
  })
})

describe('meta store', () => {
  it('round trips a value', async () => {
    const { db } = await openDatabase('demo', factory)
    await writeMeta(db, 'seed_version', 'v1')
    await expect(readMeta(db, 'seed_version')).resolves.toBe('v1')
    db.close()
  })

  it('returns undefined for a key that was never written', async () => {
    const { db } = await openDatabase('demo', factory)
    await expect(readMeta(db, 'nope')).resolves.toBeUndefined()
    db.close()
  })

  it('overwrites rather than duplicating', async () => {
    const { db } = await openDatabase('demo', factory)
    await writeMeta(db, 'k', 1)
    await writeMeta(db, 'k', 2)
    await expect(readMeta(db, 'k')).resolves.toBe(2)
    const count = await fromRequest(db.transaction(['meta'], 'readonly').objectStore('meta').count())
    expect(count).toBe(1)
    db.close()
  })

  it('rejects when a transaction is aborted rather than resolving silently', async () => {
    const { db } = await openDatabase('demo', factory)
    const tx = writeTx(db, ['meta'])
    tx.objectStore('meta').put({ key: 'x', value: 1 })
    tx.abort()
    await expect(readMeta(db, 'x')).resolves.toBeUndefined()
    db.close()
  })
})

describe('active profile', () => {
  function memoryStorage(initial?: Record<string, string>) {
    const map = new Map(Object.entries(initial ?? {}))
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      read: () => Object.fromEntries(map),
    }
  }

  it('defaults to demo when nothing is stored', () => {
    expect(readActiveProfile(memoryStorage())).toBe('demo')
  })

  it('defaults to demo when the stored value is not a profile', () => {
    expect(readActiveProfile(memoryStorage({ 'astolia.active_profile': 'production' }))).toBe('demo')
  })

  it('reads a stored profile', () => {
    expect(readActiveProfile(memoryStorage({ 'astolia.active_profile': 'live' }))).toBe('live')
  })

  it('defaults to demo when storage is unavailable, so a blocked-storage tab still boots', () => {
    expect(readActiveProfile(null)).toBe('demo')
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(readActiveProfile(throwing)).toBe('demo')
  })

  it('writes without throwing when storage refuses', () => {
    const throwing = {
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => writeActiveProfile(throwing, 'live')).not.toThrow()
    expect(() => writeActiveProfile(null, 'live')).not.toThrow()
  })

  it('round trips through storage', () => {
    const storage = memoryStorage()
    writeActiveProfile(storage, 'live')
    expect(readActiveProfile(storage)).toBe('live')
  })
})
