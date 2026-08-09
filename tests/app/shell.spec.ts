import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { mount } from '@vue/test-utils'
import App from '@/App.vue'
import { bootApp, repoForSession, type AppContext } from '@/app/bootstrap'
import { createAppRouter, roleHome } from '@/app/router'
import { resolveCreatorToken, sessionForRole } from '@/app/session'
import { useAppStore } from '@/app/store'
import { sha256Hex } from '@/platform/hash'
import { ScopeError } from '@/data/scope'
import { DEMO_CREATOR_TOKEN, DEMO_CREATOR_TOKEN_HASH, DEMO_EXPIRED_TOKEN } from '@/data/seed'
import { readSentinel } from '@/data/snapshot'
import { testDeps } from './helpers'

/** A localStorage stand-in, so one test's sentinel cannot leak into the next. */
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


let factory: IDBFactory

beforeEach(() => {
  factory = new IDBFactory()
  setActivePinia(createPinia())
})

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

describe('bootApp', () => {
  it('opens the demo profile, hydrates once, and reports a non-empty library', async () => {
    const ctx = await bootApp(testDeps(factory))
    expect(ctx.profile).toBe('demo')
    expect(ctx.hydration.seeded).toBe(true)
    expect(ctx.assetCount).toBeGreaterThan(0)
  })

  it('is idempotent: a second boot against the same database does not reseed', async () => {
    const first = await bootApp(testDeps(factory))
    first.db.close()
    const second = await bootApp(testDeps(factory))
    expect(second.hydration.seeded).toBe(false)
    expect(second.assetCount).toBe(first.assetCount)
  })

  it('mints a device id once and keeps it across boots', async () => {
    const first = await bootApp(testDeps(factory))
    first.db.close()
    const second = await bootApp(testDeps(factory))
    expect(first.deviceId).toBeTruthy()
    expect(second.deviceId).toBe(first.deviceId)
  })

  it('hydration writes no outbox entries, so boot does not fake pending work', async () => {
    const ctx = await bootApp(testDeps(factory))
    const repo = repoForSession(ctx, sessionForRole('manager'))
    expect(await repo.outboxDepth()).toBe(0)
  })

  it('does not hydrate the live profile', async () => {
    const ctx = await bootApp({ ...testDeps(factory), profile: 'live' })
    expect(ctx.hydration.seeded).toBe(false)
    expect(ctx.assetCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// creator token resolution
// ---------------------------------------------------------------------------

describe('resolveCreatorToken', () => {
  let ctx: AppContext

  beforeEach(async () => {
    ctx = await bootApp(testDeps(factory))
  })

  const now = () => ctx.clock.now()

  it('the committed hash really is the sha256 of the demo token', async () => {
    expect(await sha256Hex(DEMO_CREATOR_TOKEN)).toBe(DEMO_CREATOR_TOKEN_HASH)
  })

  it('resolves the live demo token to a creator session bound to its collab', async () => {
    const result = await resolveCreatorToken(ctx.db, DEMO_CREATOR_TOKEN, now())
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.session.kind).toBe('creator_token')
    expect(result.session.collab_id).toBeTruthy()
    expect(result.session.user_id).toBeNull()
    expect(result.session.role).toBeNull()
  })

  it('reports the expired token as expired, not invalid', async () => {
    const result = await resolveCreatorToken(ctx.db, DEMO_EXPIRED_TOKEN, now())
    expect(result.status).toBe('expired')
  })

  it('reports an unknown token as invalid', async () => {
    const result = await resolveCreatorToken(ctx.db, 'not-a-real-token', now())
    expect(result.status).toBe('invalid')
  })

  it('reports an empty token as invalid without touching the database', async () => {
    const result = await resolveCreatorToken(ctx.db, '   ', now())
    expect(result.status).toBe('invalid')
  })

  it('a creator session from the token can read its own collab but never the creator table wholesale', async () => {
    const result = await resolveCreatorToken(ctx.db, DEMO_CREATOR_TOKEN, now())
    if (result.status !== 'ok') throw new Error('expected ok')
    const repo = repoForSession(ctx, result.session)
    const collab = await repo.get('collab', result.session.collab_id!)
    expect(collab).toBeDefined()
    // The projection must not leak internal fields to the token holder.
    expect(collab).not.toHaveProperty('comp_value_usd')
    expect(collab).not.toHaveProperty('outcome')
    await expect(repo.list('gap')).rejects.toThrow(ScopeError)
  })
})

// ---------------------------------------------------------------------------
// the store: role switching is a teardown
// ---------------------------------------------------------------------------

describe('useAppStore', () => {
  it('boots to a manager session with a working repository', async () => {
    const store = useAppStore()
    await store.boot(testDeps(factory))
    expect(store.status).toBe('ready')
    expect(store.session?.kind).toBe('manager')
    expect(await store.repo!.count('collab')).toBeGreaterThan(0)
  })

  it('switching role rebuilds the session and the repository, and bumps the view key', async () => {
    const store = useAppStore()
    await store.boot(testDeps(factory))
    const managerRepo = store.repo
    const keyBefore = store.viewKey

    store.enterStaffRole('editor')

    expect(store.session?.kind).toBe('editor')
    expect(store.repo).not.toBe(managerRepo)
    expect(store.viewKey).not.toBe(keyBefore)
    // The new repository enforces the new role: an editor cannot read collab.
    await expect(store.repo!.list('collab')).rejects.toThrow(ScopeError)
  })

  it('switching manager to manager still remounts, because staleness does not care about sameness', async () => {
    const store = useAppStore()
    await store.boot(testDeps(factory))
    const keyBefore = store.viewKey
    store.enterStaffRole('manager')
    expect(store.viewKey).not.toBe(keyBefore)
  })

  it('a failed token leaves no session and no repository at all', async () => {
    const store = useAppStore()
    await store.boot(testDeps(factory))
    const gate = await store.enterCreatorToken('junk')
    expect(gate).toBe('invalid')
    expect(store.session).toBeNull()
    expect(store.repo).toBeNull()
    expect(store.creatorGate).toBe('invalid')
  })

  it('a good token builds exactly a creator_token session', async () => {
    const store = useAppStore()
    await store.boot(testDeps(factory))
    const gate = await store.enterCreatorToken(DEMO_CREATOR_TOKEN)
    expect(gate).toBe('ok')
    expect(store.session?.kind).toBe('creator_token')
  })
})

// ---------------------------------------------------------------------------
// the router: role gates and the remount
// ---------------------------------------------------------------------------

describe('the router', () => {
  async function readyApp() {
    const store = useAppStore()
    await store.boot(testDeps(factory))
    const router = createAppRouter(createMemoryHistory())
    return { store, router }
  }

  it('sends each role to its home', () => {
    // The manager home is the library until the triage surface lands; the
    // submission must open on a non-empty library, not on a placeholder.
    expect(roleHome('manager')).toBe('/library')
    expect(roleHome('editor')).toBe('/library')
    expect(roleHome('creator', 'tok')).toBe('/c/tok')
    expect(roleHome('creator', null)).toBe('/c/invalid')
  })

  it('refuses a manager route to an editor and redirects home', async () => {
    const { store, router } = await readyApp()
    store.enterStaffRole('editor')
    await router.push('/triage')
    expect(router.currentRoute.value.path).toBe('/library')
  })

  it('the token route resolves the token and enters the creator context', async () => {
    const { store, router } = await readyApp()
    await router.push(`/c/${DEMO_CREATOR_TOKEN}`)
    expect(store.role).toBe('creator')
    expect(store.creatorGate).toBe('ok')
    expect(store.session?.kind).toBe('creator_token')
  })

  it('a creator cannot reach any staff route, only their token page', async () => {
    const { store, router } = await readyApp()
    await router.push(`/c/${DEMO_CREATOR_TOKEN}`)
    for (const path of ['/triage', '/library', '/gaps', '/data-health']) {
      await router.push(path)
      expect(router.currentRoute.value.path).toBe(`/c/${DEMO_CREATOR_TOKEN}`)
    }
    // And through it all, the session never became anything but a token session.
    expect(store.session?.kind).toBe('creator_token')
  })

  it('an expired token renders the expired gate with no session', async () => {
    const { store, router } = await readyApp()
    await router.push(`/c/${DEMO_EXPIRED_TOKEN}`)
    expect(store.creatorGate).toBe('expired')
    expect(store.session).toBeNull()
    expect(store.repo).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// the mounted shell: the remount is real, not just a key that changed
// ---------------------------------------------------------------------------

describe('the mounted shell', () => {
  it('remounts the view tree on a role switch, so no cached view can hold the previous role data', async () => {
    const store = useAppStore()
    await store.boot(testDeps(factory))

    const router = createAppRouter(createMemoryHistory())
    const wrapper = mount(App, { global: { plugins: [router] } })

    store.enterStaffRole('editor')
    await router.push('/library')
    await router.isReady()
    await flush(wrapper)

    const firstMount = wrapper.find('[data-testid="library"]')
    expect(firstMount.exists()).toBe(true)
    const firstElement = firstMount.element

    // Manager also has library access, so the route survives the switch. Only
    // the remount separates the two sessions.
    store.enterStaffRole('manager')
    await flush(wrapper)

    const secondMount = wrapper.find('[data-testid="library"]')
    expect(secondMount.exists()).toBe(true)
    expect(secondMount.element).not.toBe(firstElement)
  })

  it('renders the seed-ready marker with a non-empty count', async () => {
    const store = useAppStore()
    await store.boot(testDeps(factory))
    const router = createAppRouter(createMemoryHistory())
    const wrapper = mount(App, { global: { plugins: [router] } })
    await flush(wrapper)

    const marker = wrapper.find('[data-testid="seed-ready"]')
    expect(marker.exists()).toBe(true)
    expect(Number(marker.attributes('data-count'))).toBeGreaterThan(0)
    const { SEED_VERSION } = await import('@/data/hydrate')
    expect(marker.attributes('data-seed-version')).toBe(SEED_VERSION)
  })
})

/** Lets pending promises, router hooks and Vue's queue settle. */
async function flush(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()
  }
}

describe('the eviction sentinel, decided before hydration can hide it', () => {
  it('reads a first boot as a first run, and leaves a sentinel behind', async () => {
    const storage = fakeStorage()
    const ctx = await bootApp({ ...testDeps(new IDBFactory()), sentinelStorage: storage })

    expect(ctx.storageVerdict).toEqual({ state: 'first_run' })
    const left = readSentinel(storage, 'demo')
    expect(left).not.toBeNull()
    expect(left!.rows).toBeGreaterThan(0)
  })

  it('reads a second boot of the same database as intact', async () => {
    const storage = fakeStorage()
    const factory = new IDBFactory()
    await bootApp({ ...testDeps(factory), sentinelStorage: storage })
    const second = await bootApp({ ...testDeps(factory), sentinelStorage: storage })

    expect(second.storageVerdict.state).toBe('intact')
  })

  it('names an eviction even though hydration immediately re-seeds over it', async () => {
    // The load bearing case. The browser reclaimed IndexedDB, localStorage
    // survived, and boot then re-seeds the demo. A panel reading the row count
    // afterwards sees a full database and would report `intact`, so the verdict
    // has to be decided before hydration runs. If this test ever fails, total
    // silent data loss is back.
    const storage = fakeStorage()
    await bootApp({ ...testDeps(new IDBFactory()), sentinelStorage: storage })

    // A fresh factory is exactly what an eviction looks like: the sentinel is
    // still in localStorage, and the database it describes is gone.
    const afterEviction = await bootApp({
      ...testDeps(new IDBFactory()),
      sentinelStorage: storage,
    })

    expect(afterEviction.storageVerdict.state).toBe('evicted')
    expect(afterEviction.assetCount).toBeGreaterThan(0)
  })

  it('boots normally with no sentinel storage at all', async () => {
    const ctx = await bootApp({ ...testDeps(new IDBFactory()), sentinelStorage: null })
    expect(ctx.storageVerdict).toEqual({ state: 'first_run' })
  })
})
