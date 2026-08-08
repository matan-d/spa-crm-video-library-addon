/**
 * Boot: everything that has to happen before the first view renders.
 *
 * Order matters and is the reason this is one function rather than scattered
 * setup: the database must be open before hydration, hydration must finish
 * before any repository read (or the first paint shows an empty library that
 * fills in a second later and looks like a bug), and the capability probe must
 * finish before the platform is assembled because the byte store choice
 * depends on it.
 *
 * Every ambient dependency is injectable so the whole boot runs under vitest
 * against fake-indexeddb with a stub platform. Production callers pass nothing
 * but the browser globals from `main.ts`.
 */

import { openDatabase } from '@/data/db'
import { countRows, hydrateIfNeeded, SEED_VERSION, type HydrateResult } from '@/data/hydrate'
import { readActiveProfile, bytesDirectory, type ProfileId } from '@/data/profile'
import { createScopedRepo, type ScopedRepo } from '@/data/repo'
import type { Session } from '@/data/scope'
import type { MediaManifest } from '@/data/seed'
import { createBrowserPlatform, type BrowserPlatform } from '@/platform/browser'
import { SystemClock, type Clock } from '@/platform/clock'
import { CryptoRng } from '@/platform/rng'
import { createIdFactory, type IdFactory } from '@/platform/id'
import { readMeta, writeMeta } from '@/data/db'

const DEVICE_ID_KEY = 'device_id'

export interface BootDeps {
  /** Defaults to the profile remembered in localStorage, falling back to demo. */
  profile?: ProfileId
  /** Storage the active profile is read from. Null means default to demo. */
  storage?: Pick<Storage, 'getItem'> | null
  indexedDbFactory?: IDBFactory
  clock?: Clock
  newId?: IdFactory
  /** Injected by tests so hydration needs no network. */
  loadMediaManifest?: () => Promise<MediaManifest>
  /** Injected by tests so jsdom never probes a runtime it does not have. */
  platform?: (db: IDBDatabase, bytesSubdirectory: string, now: () => number) => Promise<BrowserPlatform>
}

export interface AppContext {
  profile: ProfileId
  db: IDBDatabase
  platform: BrowserPlatform
  clock: Clock
  newId: IdFactory
  deviceId: string
  hydration: HydrateResult
  seedVersion: string
  /** Rows in the asset store after boot, for the seed-ready marker. */
  assetCount: number
}

export async function bootApp(deps: BootDeps = {}): Promise<AppContext> {
  const clock = deps.clock ?? new SystemClock()
  const newId = deps.newId ?? createIdFactory(clock, new CryptoRng())
  const profile = deps.profile ?? readActiveProfile(deps.storage ?? null)

  const { db } = await openDatabase(profile, deps.indexedDbFactory)

  // Only the demo profile is ever seeded. The live profile starts empty and
  // stays empty until real work happens, which is the whole point of D11's
  // separate-database rule: fabricated data cannot exist where real data lives.
  const hydration: HydrateResult =
    profile === 'demo'
      ? await hydrateIfNeeded({
          db,
          loadMediaManifest: deps.loadMediaManifest,
          measure: () => clock.now(),
        })
      : { seeded: false, version: SEED_VERSION, summary: null, elapsedMs: 0 }

  const deviceId = await ensureDeviceId(db, newId)

  const platformFactory = deps.platform ?? defaultPlatform
  const platform = await platformFactory(db, bytesDirectory(profile), () => clock.now())

  const assetCount = (await countRows(db, ['asset'])).asset ?? 0

  return {
    profile,
    db,
    platform,
    clock,
    newId,
    deviceId,
    hydration,
    seedVersion: SEED_VERSION,
    assetCount,
  }
}

function defaultPlatform(
  db: IDBDatabase,
  bytesSubdirectory: string,
  now: () => number,
): Promise<BrowserPlatform> {
  return createBrowserPlatform({ db, bytesSubdirectory, now })
}

/**
 * One stable id per browser profile, minted on first boot and kept in `meta`.
 * It names this client in every sync envelope, so it lives beside the data it
 * describes rather than in localStorage where a preferences wipe would silently
 * re-identify the device.
 */
async function ensureDeviceId(db: IDBDatabase, newId: IdFactory): Promise<string> {
  const existing = await readMeta<string>(db, DEVICE_ID_KEY)
  if (typeof existing === 'string' && existing.length > 0) return existing
  const minted = newId()
  await writeMeta(db, DEVICE_ID_KEY, minted)
  return minted
}

export function repoForSession(ctx: AppContext, session: Session): ScopedRepo {
  return createScopedRepo({
    db: ctx.db,
    session,
    now: () => ctx.clock.now(),
    newId: ctx.newId,
    deviceId: ctx.deviceId,
  })
}
