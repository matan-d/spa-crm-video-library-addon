import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@/data/db'
import { createScopedRepo, type ScopedRepo } from '@/data/repo'
import {
  creatorTokenSession,
  editorSession,
  managerSession,
  ScopeError,
  withCreator,
  FORBIDDEN_FIELDS,
  FORBIDDEN_STORES,
} from '@/data/scope'
import { SeededClock, SEED_EPOCH_MS } from '@/platform/clock'
import { SeededRng, SEED_STRING } from '@/platform/rng'
import { createIdFactory } from '@/platform/id'

const ORG = 'org-1'
const COLLAB = 'collab-1'
const CREATOR = 'creator-1'
const BRANCH_SJ = 'branch-sj'
const BRANCH_PA = 'branch-pa'

let db: IDBDatabase
let manager: ScopedRepo
let editor: ScopedRepo
let creator: ScopedRepo

function repoFor(session: Parameters<typeof createScopedRepo>[0]['session']): ScopedRepo {
  return createScopedRepo({
    db,
    session,
    now: () => new SeededClock({ startMs: SEED_EPOCH_MS }).now(),
    newId: createIdFactory(new SeededClock({ startMs: SEED_EPOCH_MS }), new SeededRng(SEED_STRING)),
    deviceId: 'test-device',
  })
}

/** A minimal but realistic dataset: two branches, one creator, one collab, four assets. */
async function seed(): Promise<void> {
  const write = repoFor(managerSession({ org_id: ORG, user_id: 'user-manager' }))

  await write.create('branch', { id: BRANCH_SJ, name: 'San Jose', city: 'San Jose', do_not_shoot: ['staff room'] })
  await write.create('branch', { id: BRANCH_PA, name: 'Palo Alto', city: 'Palo Alto', do_not_shoot: [] })
  await write.create('app_user', { id: 'user-editor', role: 'editor', display_name: 'Ed', email: 'ed@x.com' })

  await write.create('creator', {
    id: CREATOR,
    display_name: 'Maya K',
    primary_handle: '@maya.k',
    fit_score: 78,
    fit_reasons: ['strong wellness audience'],
    risk_flags: [],
    reliability_tier: 'proven',
    contact_email: 'maya@example.com',
    notes: 'chases invoices, fine otherwise',
  })

  await write.create('collab', {
    id: COLLAB,
    creator_id: CREATOR,
    branch_id: BRANCH_SJ,
    owner_user_id: 'user-manager',
    stage: 'delivered',
    comp_value_usd: 320,
    usage_terms_text: 'Paid social permitted until 2027-08-04.',
    notes: 'internal',
  })

  await write.create('delivery', { id: 'delivery-1', collab_id: COLLAB, state: 'submitted' })

  // published and approved: the editor sees this one
  await write.create('asset', assetRow('asset-published', {
    is_published: true,
    review_status: 'approved',
    branch_id: BRANCH_SJ,
  }))
  // pending: still under review, so invisible to an editor
  await write.create('asset', assetRow('asset-pending', {
    is_published: false,
    review_status: 'pending',
    branch_id: BRANCH_SJ,
  }))
  // published in another branch: an editor sees across every branch
  await write.create('asset', assetRow('asset-other-branch', {
    is_published: true,
    review_status: 'approved',
    branch_id: BRANCH_PA,
    collab_id: 'collab-other',
  }))
  // an exemplar, which is the only asset a creator sees that is not their own
  await write.create('asset', assetRow('asset-exemplar', {
    is_published: true,
    review_status: 'approved',
    branch_id: BRANCH_SJ,
    collab_id: 'collab-other',
    is_exemplar: true,
  }))
}

function assetRow(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    kind: 'video',
    delivery_id: 'delivery-1',
    collab_id: COLLAB,
    branch_id: BRANCH_SJ,
    filename: `${id}.mp4`,
    bytes: 1000,
    duration_s: 6,
    ai_description: 'hands on a back, warm light',
    ai_quality_score: 0.8,
    ai_provenance: 'mock',
    review_status: 'pending',
    is_published: false,
    is_exemplar: false,
    reject_reason_text: 'framing sloppy, creator rushed it',
    creator_facing_note: 'Could we get one more with the hands centred?',
    creator_credit: 'Maya K (@maya.k)',
    usage_scope: 'paid_social',
    media_state: 'bytes_absent',
    derivative_state: 'ready',
    used_count: 0,
    download_count: 0,
    phash_primary: 'abcd',
    frame_hashes: ['a', 'b'],
    ...overrides,
  }
}

beforeEach(async () => {
  const opened = await openDatabase('demo', new IDBFactory())
  db = opened.db
  manager = repoFor(managerSession({ org_id: ORG, user_id: 'user-manager' }))
  editor = repoFor(editorSession({ org_id: ORG, user_id: 'user-editor' }))
  creator = repoFor(
    withCreator(creatorTokenSession({ org_id: ORG, collab_id: COLLAB, token_id: 'tok-1' }), CREATOR),
  )
  await seed()
})

describe('the table allowlist', () => {
  it('lets a manager read everything it owns', async () => {
    await expect(manager.get('creator', CREATOR)).resolves.toBeDefined()
    await expect(manager.get('collab', COLLAB)).resolves.toBeDefined()
  })

  it('refuses every store an editor must not touch, by throwing rather than returning empty', async () => {
    for (const store of FORBIDDEN_STORES.editor) {
      await expect(editor.get(store, 'anything'), `editor read ${store}`).rejects.toBeInstanceOf(ScopeError)
    }
  })

  it('refuses every store a creator token must not touch', async () => {
    for (const store of FORBIDDEN_STORES.creator_token) {
      await expect(creator.get(store, 'anything'), `creator read ${store}`).rejects.toBeInstanceOf(ScopeError)
    }
  })

  it('says why, so the violation is not mistaken for a missing feature', async () => {
    await expect(editor.get('creator', CREATOR)).rejects.toThrow(/scope violation/)
  })

  it('refuses a write to a store the session may only read', async () => {
    await expect(editor.create('branch', { name: 'nope' })).rejects.toBeInstanceOf(ScopeError)
  })
})

describe('the projection', () => {
  it('never exposes a forbidden field name to an editor', async () => {
    const assets = await editor.list('asset')
    const branches = await editor.list('branch')
    const users = await editor.list('app_user')
    for (const row of [...assets, ...branches, ...users] as Record<string, unknown>[]) {
      for (const field of FORBIDDEN_FIELDS.editor) {
        expect(Object.keys(row), `editor saw ${field}`).not.toContain(field)
      }
    }
  })

  it('never exposes a forbidden field name to a creator', async () => {
    const assets = await creator.list('asset')
    const collab = await creator.get('collab', COLLAB)
    const self = await creator.get('creator', CREATOR)
    const branch = await creator.get('branch', BRANCH_SJ)
    for (const row of [...assets, collab, self, branch] as Record<string, unknown>[]) {
      for (const field of FORBIDDEN_FIELDS.creator_token) {
        expect(Object.keys(row ?? {}), `creator saw ${field}`).not.toContain(field)
      }
    }
  })

  it('gives the editor the denormalised credit instead of access to the creator row', async () => {
    // This is the whole reason asset.creator_credit exists: a credit line without
    // a column-level policy on a table the editor cannot open.
    const asset = (await editor.get('asset', 'asset-published')) as Record<string, unknown>
    expect(asset.creator_credit).toBe('Maya K (@maya.k)')
    await expect(editor.get('creator', CREATOR)).rejects.toBeInstanceOf(ScopeError)
  })

  it('shows a creator the softened note, never the blunt internal one', async () => {
    const asset = (await creator.get('asset', 'asset-published')) as Record<string, unknown>
    expect(asset.creator_facing_note).toMatch(/hands centred/)
    expect(Object.keys(asset)).not.toContain('reject_reason_text')
  })

  it('keeps the branch do-not-shoot list away from both non-manager roles', async () => {
    const forEditor = (await editor.get('branch', BRANCH_SJ)) as Record<string, unknown>
    const forCreator = (await creator.get('branch', BRANCH_SJ)) as Record<string, unknown>
    expect(Object.keys(forEditor)).not.toContain('do_not_shoot')
    expect(Object.keys(forCreator)).not.toContain('do_not_shoot')
    // The manager still needs it.
    expect((await manager.get('branch', BRANCH_SJ)) as Record<string, unknown>).toHaveProperty('do_not_shoot')
  })

  it('leaves the manager view unprojected', async () => {
    const asset = (await manager.get('asset', 'asset-published')) as Record<string, unknown>
    expect(asset.reject_reason_text).toBeDefined()
    expect(asset.phash_primary).toBeDefined()
  })
})

describe('the mandatory predicate', () => {
  it('hides an unreviewed asset from the editor', async () => {
    // An unreviewed clip reaching a campaign is the failure review exists to stop.
    await expect(editor.get('asset', 'asset-pending')).resolves.toBeUndefined()
    const ids = (await editor.list('asset')).map((a) => (a as { id: string }).id)
    expect(ids).not.toContain('asset-pending')
    expect(ids).toContain('asset-published')
  })

  it('reads a forbidden row as absent rather than as forbidden', async () => {
    // Distinguishing the two tells a caller that a record they may not read is
    // nonetheless there, which is a leak of existence.
    await expect(editor.get('asset', 'asset-pending')).resolves.toBeUndefined()
  })

  it('lets the editor see every branch, because the pooled library is the product', async () => {
    const ids = (await editor.list('asset')).map((a) => (a as { id: string }).id)
    expect(ids).toContain('asset-other-branch')
  })

  it('scopes a branch manager to their branches without a new role', async () => {
    const sjOnly = repoFor(
      managerSession({ org_id: ORG, user_id: 'user-manager', branch_scope: [BRANCH_SJ] }),
    )
    const ids = (await sjOnly.list('asset')).map((a) => (a as { id: string }).id)
    expect(ids).toContain('asset-published')
    expect(ids).not.toContain('asset-other-branch')
  })

  it('shows a creator their own submissions and the exemplar set, and nothing else', async () => {
    const ids = (await creator.list('asset')).map((a) => (a as { id: string }).id)
    expect(ids).toContain('asset-published')
    expect(ids).toContain('asset-pending')
    expect(ids).toContain('asset-exemplar')
    expect(ids).not.toContain('asset-other-branch')
  })

  it('shows a creator no creator row at all until the collab has bound one', async () => {
    // An unbound token defaults to invisible, which is the safe direction.
    const unbound = repoFor(creatorTokenSession({ org_id: ORG, collab_id: COLLAB, token_id: 'tok-1' }))
    await expect(unbound.get('creator', CREATOR)).resolves.toBeUndefined()
  })

  it('hides another organisation entirely', async () => {
    const other = repoFor(managerSession({ org_id: 'org-2', user_id: 'u' }))
    await expect(other.get('asset', 'asset-published')).resolves.toBeUndefined()
    await expect(other.list('asset')).resolves.toEqual([])
  })

  it('applies scope before a caller supplied filter, not after', async () => {
    // Otherwise a caller could widen its own visibility with a clever predicate.
    const rows = await editor.list('asset', { where: () => true })
    expect(rows.map((a) => (a as { id: string }).id)).not.toContain('asset-pending')
  })
})

describe('soft delete', () => {
  it('hides a deleted row from every session', async () => {
    await manager.softDelete('asset', 'asset-published')
    await expect(manager.get('asset', 'asset-published')).resolves.toBeUndefined()
    await expect(editor.get('asset', 'asset-published')).resolves.toBeUndefined()
  })

  it('keeps the row on disk, because a sync bug should cost a glitch and not footage', async () => {
    await manager.softDelete('asset', 'asset-published')
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(['asset'], 'readonly').objectStore('asset').get('asset-published')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(raw).toBeDefined()
    expect((raw as { deleted_at: number | null }).deleted_at).toBeTypeOf('number')
  })
})

describe('the boolean mirrors', () => {
  it('writes the integer mirror on create', async () => {
    const raw = await rawRow('asset', 'asset-published')
    expect(raw.is_published).toBe(true)
    expect(raw.is_published_i).toBe(1)
    expect(raw.is_exemplar_i).toBe(0)
  })

  it('updates the mirror on patch', async () => {
    await manager.patch('asset', 'asset-pending', { is_published: true, review_status: 'approved' })
    const raw = await rawRow('asset', 'asset-pending')
    expect(raw.is_published_i).toBe(1)
  })

  it('makes the published index actually usable, which a raw boolean would not', async () => {
    // The point of the mirror: IndexedDB cannot key on `true`, so this query
    // returns nothing without it.
    const rows = await manager.list('asset', {
      index: 'by_published',
      key: IDBKeyRange.bound([1, 0], [1, Number.MAX_SAFE_INTEGER]),
    })
    const ids = rows.map((r) => (r as { id: string }).id)
    expect(ids).toContain('asset-published')
    expect(ids).not.toContain('asset-pending')
  })
})

describe('the outbox, which is why this layer is also the only writer', () => {
  it('appends an entry for every create', async () => {
    const entries = await manager.pendingOutbox()
    // seed writes: 2 branches, 1 user, 1 creator, 1 collab, 1 delivery, 4 assets
    expect(entries).toHaveLength(10)
    expect(entries.every((e) => e.state === 'pending')).toBe(true)
  })

  it('appends a patch that carries only the changed fields', async () => {
    const before = await manager.outboxDepth()
    await manager.patch('asset', 'asset-pending', { review_status: 'approved' })
    const entries = await manager.pendingOutbox()
    expect(entries).toHaveLength(before + 1)
    const last = entries[entries.length - 1]
    expect(last.op).toBe('patch')
    expect(Object.keys(last.patch).sort()).toEqual(['review_status', 'updated_at'])
  })

  it('carries the mirror alongside its boolean in a patch', async () => {
    await manager.patch('asset', 'asset-pending', { is_published: true })
    const last = (await manager.pendingOutbox()).at(-1)!
    expect(last.patch.is_published).toBe(true)
    expect(last.patch.is_published_i).toBe(1)
  })

  it('records the base revision, so the far side can detect a conflict', async () => {
    await manager.patch('asset', 'asset-pending', { review_status: 'approved' })
    const last = (await manager.pendingOutbox()).at(-1)!
    expect(last.base_rev).toBe(1)
  })

  it('appends a soft delete rather than a hard one', async () => {
    await manager.softDelete('asset', 'asset-published')
    const last = (await manager.pendingOutbox()).at(-1)!
    expect(last.op).toBe('soft_delete')
    expect(last.patch.deleted_at).toBeTypeOf('number')
  })

  it('does not append for a local only store', async () => {
    // search_token, the reindex queue and the blob store are rebuildable and must
    // never be pushed anywhere.
    const before = await manager.outboxDepth()
    const local = repoFor(managerSession({ org_id: ORG, user_id: 'user-manager' }))
    await local.create('search_token', { id: 't1', token: 'hands', asset_id: 'asset-published' })
    expect(await manager.outboxDepth()).toBe(before)
  })

  it('writes the row and its outbox entry in one transaction', async () => {
    // If these could diverge, a crash between them would leave a row that never
    // syncs, or an entry for a row that does not exist.
    const depthBefore = await manager.outboxDepth()
    await manager.create('asset', assetRow('asset-new', {}))
    expect(await rawRow('asset', 'asset-new')).toBeDefined()
    expect(await manager.outboxDepth()).toBe(depthBefore + 1)
  })
})

describe('envelope handling', () => {
  it('fills the envelope on create and leaves server_updated_at null', async () => {
    const raw = await rawRow('asset', 'asset-published')
    expect(raw.org_id).toBe(ORG)
    expect(raw.rev).toBe(1)
    expect(raw.deleted_at).toBeNull()
    // The pull cursor reads the server clock, never the client's, because one
    // skewed device would otherwise make rows permanently invisible.
    expect(raw.server_updated_at).toBeNull()
    expect(raw.origin_device).toBe('test-device')
  })

  it('bumps the revision on every patch', async () => {
    await manager.patch('asset', 'asset-pending', { review_status: 'approved' })
    await manager.patch('asset', 'asset-pending', { is_hero: true })
    expect((await rawRow('asset', 'asset-pending')).rev).toBe(3)
  })

  it('refuses to patch a row that does not exist', async () => {
    await expect(manager.patch('asset', 'nope', { is_hero: true })).rejects.toThrow(/does not exist/)
  })

  it('refuses to patch a row the session cannot see, rather than silently doing nothing', async () => {
    // A caller that believes it wrote and did not is worse off than one told no.
    // A branch scoped manager is the real case: it may write assets, just not this one.
    const sjOnly = repoFor(
      managerSession({ org_id: ORG, user_id: 'user-manager', branch_scope: [BRANCH_SJ] }),
    )
    await expect(sjOnly.patch('asset', 'asset-other-branch', { is_hero: true })).rejects.toThrow(
      /not visible/,
    )
  })
})

async function rawRow(store: string, id: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = db.transaction([store], 'readonly').objectStore(store).get(id)
    request.onsuccess = () => resolve(request.result as Record<string, unknown>)
    request.onerror = () => reject(request.error)
  })
}
