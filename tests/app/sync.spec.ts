/**
 * The loopback adapter, and the merge rules it executes.
 *
 * Two devices, one server, all three in memory. The point of these tests is not
 * that a drain works, it is that the rules in `src/app/sync/policy.ts` behave
 * the way the conflict table says under a genuinely stale second writer. The
 * headline case is the last one anybody wants to discover in production: a
 * device that has not synced for a while approving a clip a human rejected.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { bootApp, repoForSession } from '@/app/bootstrap'
import { sessionForRole } from '@/app/session'
import {
  connectLoopback,
  createLoopbackAdapter,
  openLoopbackServer,
  serverDatabaseName,
  type LoopbackAdapter,
} from '@/app/sync/loopback'
import { mergeRow } from '@/app/sync/policy'
import { fromRequest, openDatabase, readTx } from '@/data/db'
import { createScopedRepo, type ScopedRepo } from '@/data/repo'
import { managerSession } from '@/data/scope'
import type { OutboxEntry, SyncConflict } from '@/data/types'
import { SeededClock, SEED_EPOCH_MS } from '@/platform/clock'
import { SeededRng, SEED_STRING } from '@/platform/rng'
import { createIdFactory } from '@/platform/id'
import { testDeps } from './helpers'

const ORG = 'org-1'

let factory: IDBFactory
let clock: SeededClock
let server: IDBDatabase

/** One device: its own local database, its own repository, its own adapter. */
interface Device {
  db: IDBDatabase
  repo: ScopedRepo
  sync: LoopbackAdapter
  id: string
}

/**
 * Two devices are two profiles here only because a profile is what names a
 * local database. They share one loopback server, which is the arrangement the
 * adapter exists to exercise.
 */
async function device(profile: 'demo' | 'live', deviceId: string): Promise<Device> {
  const { db } = await openDatabase(profile, factory)
  const newId = createIdFactory(clock, new SeededRng(`${SEED_STRING}-${deviceId}`))
  const repo = createScopedRepo({
    db,
    session: managerSession({ org_id: ORG, user_id: 'user-manager' }),
    now: () => clock.now(),
    newId,
    deviceId,
  })
  const sync = createLoopbackAdapter({
    local: db,
    server,
    clock,
    newId,
    deviceId,
    keyRange: IDBKeyRange,
  })
  return { db, repo, sync, id: deviceId }
}

function assetRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'video',
    delivery_id: 'delivery-1',
    collab_id: 'collab-1',
    branch_id: 'branch-sj',
    filename: `${id}.mp4`,
    bytes: 1000,
    duration_s: 6,
    review_status: 'pending',
    is_published: false,
    is_exemplar: false,
    ai_provenance: 'none',
    media_state: 'bytes_absent',
    derivative_state: 'none',
    creator_credit: 'Maya K (@maya.k)',
    used_count: 0,
    download_count: 0,
    ...overrides,
  }
}

async function rawRow(db: IDBDatabase, store: string, id: string): Promise<Record<string, unknown> | undefined> {
  return (await fromRequest(db.transaction([store], 'readonly').objectStore(store).get(id))) as
    | Record<string, unknown>
    | undefined
}

async function outbox(db: IDBDatabase): Promise<OutboxEntry[]> {
  const rows = (await fromRequest(readTx(db, ['outbox']).objectStore('outbox').getAll())) as OutboxEntry[]
  return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

async function conflicts(db: IDBDatabase): Promise<SyncConflict[]> {
  return (await fromRequest(
    readTx(db, ['sync_conflict']).objectStore('sync_conflict').getAll(),
  )) as SyncConflict[]
}

beforeEach(async () => {
  factory = new IDBFactory()
  // autoAdvance keeps every write at a distinct instant, so last-write-wins has
  // something to compare and the id factory never exhausts its counter.
  clock = new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: 1 })
  server = await openLoopbackServer('live', factory)
})

describe('the adapter says what it is', () => {
  it('never claims a connection this build does not have', () => {
    // The honesty rule from the architecture review C.4, asserted rather than
    // trusted: a panel that overclaims discounts everything else in the build.
    // Source text rather than a rendered DOM, because the claim must be absent
    // from the component in every state it can render, including error states.
    const source = readFileSync(join(cwd(), 'src/app/views/SyncView.vue'), 'utf8')
    expect(source).toContain('Adapter: loopback')
    expect(source).toContain('data-adapter="loopback"')

    // Naming Supabase is allowed, claiming one is not, so the test is about the
    // sentence rather than the word: any sentence that mentions a backend or a
    // connection has to deny it in the same breath.
    const sentences = source.replace(/\s+/g, ' ').toLowerCase().split(/(?<=\.)\s/)
    for (const sentence of sentences) {
      if (!/supabase|connected|deployed/.test(sentence)) continue
      expect(sentence, 'a sentence claims a backend').toMatch(/\bnot\b|\bnever\b|\bno\b|\bnothing\b/)
    }
  })

  it('is named loopback, and its server is a separate database per profile', () => {
    expect(serverDatabaseName('demo')).toBe('astolia_demo_loopback_server')
    expect(serverDatabaseName('live')).toBe('astolia_live_loopback_server')
    // A demo outbox cannot reach the live loopback server, let alone a real one.
    expect(serverDatabaseName('demo')).not.toBe(serverDatabaseName('live'))
  })
})

describe('a drain', () => {
  it('moves every pending entry to sent and lands the row on the server', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1'))

    expect((await outbox(a.db)).map((entry) => entry.state)).toEqual(['pending'])

    const report = await a.sync.push()
    expect(report.sent).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.byStore.asset).toBe(1)

    const entries = await outbox(a.db)
    expect(entries.map((entry) => entry.state)).toEqual(['sent'])
    // Kept rather than deleted: the panel shows what actually left this device.
    expect(entries[0].attempts).toBe(1)
    expect(await a.repo.outboxDepth()).toBe(0)

    const onServer = await rawRow(server, 'asset', 'asset-1')
    expect(onServer).toBeDefined()
    expect(onServer!.filename).toBe('asset-1.mp4')
    // The server stamps its own clock. A client may not write this column.
    expect(onServer!.server_updated_at).toBeTypeOf('number')
    expect(report.serverUpdatedAt).toBe(onServer!.server_updated_at)
  })

  it('merges a later patch into the row its create made, rather than replacing it', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1'))
    await a.repo.patch('asset', 'asset-1', { is_hero: true })
    await a.sync.push()

    const onServer = await rawRow(server, 'asset', 'asset-1')
    expect(onServer!.is_hero).toBe(true)
    expect(onServer!.filename).toBe('asset-1.mp4')
    expect(onServer!.rev).toBe(2)
  })

  it('promotes a patch to the whole local row when the server has never seen it', async () => {
    // The normal case for seeded history: hydration writes it straight to disk
    // with no outbox entries (D12), so the first thing the server hears about a
    // seeded clip is somebody approving it. Sending only the changed field
    // would create a row that is one field and no clip.
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1'))
    await a.repo.patch('asset', 'asset-1', { is_hero: true })

    // Drop the create, keeping the patch: the state a partial drain leaves.
    const entries = await outbox(a.db)
    const tx = a.db.transaction(['outbox'], 'readwrite')
    tx.objectStore('outbox').delete(entries[0].seq!)
    await new Promise((resolve) => (tx.oncomplete = resolve))

    const report = await a.sync.push()
    expect(report.sent).toBe(1)
    const onServer = await rawRow(server, 'asset', 'asset-1')
    expect(onServer!.is_hero).toBe(true)
    expect(onServer!.filename).toBe('asset-1.mp4')
    // Promotion sends the local row, and the local row's device-only fields are
    // still not part of it.
    expect(onServer!.media_state).toBeUndefined()
  })

  it('fails loudly when there is no row on the server or on this device', async () => {
    const a = await device('live', 'device-a')
    const tx = a.db.transaction(['outbox'], 'readwrite')
    tx.objectStore('outbox').add({
      store: 'asset',
      row_id: 'ghost',
      op: 'patch',
      patch: { is_hero: true, updated_at: 1 },
      base_rev: 1,
      queued_at: 1,
      state: 'pending',
      attempts: 0,
      last_error: null,
    })
    await new Promise((resolve) => (tx.oncomplete = resolve))

    const report = await a.sync.push()
    expect(report.failed).toBe(1)
    expect((await outbox(a.db))[0].state).toBe('failed')
    expect((await outbox(a.db))[0].last_error).toMatch(/nothing to merge into/)
    expect(await rawRow(server, 'asset', 'ghost')).toBeUndefined()
  })
})

describe('a pull', () => {
  it('applies rows another device pushed', async () => {
    const a = await device('live', 'device-a')
    const b = await device('demo', 'device-b')

    await a.repo.create('asset', assetRow('asset-1', { filename: 'from-a.mp4' }))
    await a.sync.push()

    const report = await b.sync.pull()
    expect(report.applied).toBe(1)
    const local = await rawRow(b.db, 'asset', 'asset-1')
    expect(local!.filename).toBe('from-a.mp4')
    // B did not write it, so B must not queue it back.
    expect(await b.repo.outboxDepth()).toBe(0)
  })

  it('advances the cursor so a second pull is a no-op', async () => {
    const a = await device('live', 'device-a')
    const b = await device('demo', 'device-b')
    await a.repo.create('asset', assetRow('asset-1'))
    await a.sync.push()

    await b.sync.pull()
    const second = await b.sync.pull()
    expect(second.applied).toBe(0)
    expect(second.unchanged).toBe(0)

    const cursor = second.cursors.find((state) => state.store === 'asset')!
    expect(cursor.cursor_server_updated_at).toBeTypeOf('number')
    expect(cursor.cursor_id).toBe('asset-1')
  })

  it('records the server clock on the local row, so a synced row stops reading as unsynced', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1'))
    expect((await rawRow(a.db, 'asset', 'asset-1'))!.server_updated_at).toBeNull()

    await a.sync.push()
    await a.sync.pull()
    expect((await rawRow(a.db, 'asset', 'asset-1'))!.server_updated_at).toBeTypeOf('number')
  })
})

describe('band 4 is monotonic and safety biased', () => {
  /** A rejects the clip. B, holding a stale copy, approves it. */
  async function twoWayReview(): Promise<{ a: Device; b: Device }> {
    const a = await device('live', 'device-a')
    const b = await device('demo', 'device-b')
    await a.repo.create('asset', assetRow('asset-1'))
    await a.sync.push()
    await b.sync.pull()

    await a.repo.patch('asset', 'asset-1', { review_status: 'rejected', reject_reason_text: 'consent unclear' })
    await a.sync.push()

    await b.repo.patch('asset', 'asset-1', { review_status: 'approved' })
    await b.sync.push()
    return { a, b }
  }

  it('never lets a stale device flip a rejected clip back to approved', async () => {
    const { b } = await twoWayReview()
    // The single worst bug available in this system, refused by policy rather
    // than by luck of ordering.
    expect((await rawRow(server, 'asset', 'asset-1'))!.review_status).toBe('rejected')
    // And the rejection wins back on the stale device the moment it pulls.
    await b.sync.pull()
    expect((await rawRow(b.db, 'asset', 'asset-1'))!.review_status).toBe('rejected')
  })

  it('records the refusal as a row, not as a notification', async () => {
    const { b } = await twoWayReview()
    const recorded = await conflicts(b.db)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].policy).toBe('ordinal')
    expect(recorded[0].store).toBe('asset')
    expect(recorded[0].row_id).toBe('asset-1')
    expect(recorded[0].fields).toContain('review_status')
    expect(recorded[0].kept).toBe('rejected')
    expect(recorded[0].refused).toBe('approved')
    expect(recorded[0].direction).toBe('push')
    // Unresolved by construction: a machine picking a side is how a
    // disagreement disappears unrecorded.
    expect(recorded[0].resolved_at).toBeNull()
  })

  it('keeps the reason with the decision, so an audit row cannot be half of two decisions', async () => {
    const { b } = await twoWayReview()
    const onServer = await rawRow(server, 'asset', 'asset-1')
    expect(onServer!.reject_reason_text).toBe('consent unclear')
    // B's approval carried no note, and its whole coupled group was refused
    // with it, so nothing of B's decision landed beside A's.
    await b.sync.pull()
    expect((await rawRow(b.db, 'asset', 'asset-1'))!.reject_reason_text).toBe('consent unclear')
  })

  it('unpublishes on rejection even when the patch never mentioned publication', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1', { review_status: 'approved', is_published: true }))
    await a.sync.push()
    expect((await rawRow(server, 'asset', 'asset-1'))!.is_published).toBe(true)

    await a.repo.patch('asset', 'asset-1', { review_status: 'rejected' })
    await a.sync.push()

    const onServer = await rawRow(server, 'asset', 'asset-1')
    expect(onServer!.review_status).toBe('rejected')
    expect(onServer!.is_published).toBe(false)
    expect(onServer!.is_published_i).toBe(0)
    const recorded = await conflicts(a.db)
    expect(recorded.map((row) => row.policy)).toContain('implies')
  })
})

describe('write-once fields', () => {
  it('refuses a second, different value rather than picking a winner', async () => {
    const a = await device('live', 'device-a')
    const b = await device('demo', 'device-b')
    await a.repo.create('collab', {
      id: 'collab-1',
      creator_id: 'creator-1',
      branch_id: 'branch-sj',
      owner_user_id: 'user-manager',
      stage: 'brief',
      outcome: 'open',
      usage_terms_text: 'Paid social permitted until 2027-08-04.',
    })
    await a.sync.push()
    await b.sync.pull()

    await b.repo.patch('collab', 'collab-1', { usage_terms_text: 'Anything, forever.' })
    await b.sync.push()

    expect((await rawRow(server, 'collab', 'collab-1'))!.usage_terms_text).toBe(
      'Paid social permitted until 2027-08-04.',
    )
    const recorded = await conflicts(b.db)
    expect(recorded[0].policy).toBe('write_once')
    expect(recorded[0].fields).toEqual(['usage_terms_text'])
  })

  it('still accepts the first value when the field was null', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('collab', {
      id: 'collab-1',
      creator_id: 'creator-1',
      branch_id: 'branch-sj',
      stage: 'brief',
      usage_terms_text: null,
    })
    await a.sync.push()
    await a.repo.patch('collab', 'collab-1', { usage_terms_text: 'Organic social only.' })
    await a.sync.push()

    expect((await rawRow(server, 'collab', 'collab-1'))!.usage_terms_text).toBe('Organic social only.')
    expect(await conflicts(a.db)).toHaveLength(0)
  })

  it('does not treat an identical resend as a conflict', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('collab', { id: 'collab-1', stage: 'brief', usage_terms_text: 'Same text.' })
    await a.sync.push()
    await a.repo.patch('collab', 'collab-1', { usage_terms_text: 'Same text.' })
    await a.sync.push()
    expect(await conflicts(a.db)).toHaveLength(0)
  })
})

describe('derivative_state is an ordinal that never goes backwards', () => {
  it('refuses a regression from a device that has not derived anything yet', async () => {
    const a = await device('live', 'device-a')
    const b = await device('demo', 'device-b')
    await a.repo.create('asset', assetRow('asset-1', { derivative_state: 'none' }))
    await a.sync.push()
    await b.sync.pull()

    // The capable device produces the sheet.
    await a.repo.patch('asset', 'asset-1', { derivative_state: 'ready' })
    await a.sync.push()

    // The stale one reports what it still believes.
    await b.repo.patch('asset', 'asset-1', { derivative_state: 'none' })
    await b.sync.push()

    expect((await rawRow(server, 'asset', 'asset-1'))!.derivative_state).toBe('ready')
    const recorded = await conflicts(b.db)
    expect(recorded[0].policy).toBe('ordinal')
    expect(recorded[0].fields).toEqual(['derivative_state'])
  })

  it('accepts every step forward along the ladder', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1', { derivative_state: 'none' }))
    await a.sync.push()
    await a.repo.patch('asset', 'asset-1', { derivative_state: 'partial' })
    await a.sync.push()
    expect((await rawRow(server, 'asset', 'asset-1'))!.derivative_state).toBe('partial')
    await a.repo.patch('asset', 'asset-1', { derivative_state: 'ready' })
    await a.sync.push()
    expect((await rawRow(server, 'asset', 'asset-1'))!.derivative_state).toBe('ready')
    expect(await conflicts(a.db)).toHaveLength(0)
  })
})

describe('local-only fields never leave the device', () => {
  it('strips them from the patch a create queues', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1', { media_state: 'bytes_local' }))
    const entry = (await outbox(a.db))[0]
    expect(entry.patch.media_state).toBeUndefined()
    // The row itself still carries it: it is true of this device.
    expect((await rawRow(a.db, 'asset', 'asset-1'))!.media_state).toBe('bytes_local')
  })

  it('strips them from a patch, keeping the fields that do sync', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1'))
    await a.repo.patch('asset', 'asset-1', {
      media_state: 'bytes_local',
      upload_state: 'done',
      upload_offset_bytes: 4096,
      local_file_key: 'original/asset-1',
      poster_key: 'poster/asset-1.jpg',
    })
    const entry = (await outbox(a.db)).at(-1)!
    expect(Object.keys(entry.patch).sort()).toEqual(['poster_key', 'updated_at'])
  })

  it('queues nothing at all for a patch that is only local state', async () => {
    const a = await device('live', 'device-a')
    await a.repo.create('asset', assetRow('asset-1'))
    const before = (await outbox(a.db)).length
    await a.repo.patch('asset', 'asset-1', { media_state: 'bytes_local', upload_offset_bytes: 12 })
    expect((await outbox(a.db)).length).toBe(before)
    // The write itself still happened locally. Only the queueing was skipped.
    expect((await rawRow(a.db, 'asset', 'asset-1'))!.media_state).toBe('bytes_local')
  })

  it('never lands one on the server, and never overwrites the local answer on the way back', async () => {
    const a = await device('live', 'device-a')
    const b = await device('demo', 'device-b')
    await a.repo.create('asset', assetRow('asset-1', { media_state: 'bytes_local' }))
    await a.sync.push()

    expect((await rawRow(server, 'asset', 'asset-1'))!.media_state).toBeUndefined()

    // B has no bytes, and pulling A's row must not tell it otherwise.
    await b.sync.pull()
    expect((await rawRow(b.db, 'asset', 'asset-1'))!.media_state).toBeUndefined()
    await b.repo.patch('asset', 'asset-1', { media_state: 'bytes_absent' })
    await a.sync.pull()
    expect((await rawRow(a.db, 'asset', 'asset-1'))!.media_state).toBe('bytes_local')
  })
})

describe('the merge executor on its own', () => {
  it('keeps a coupled group together when the ordinal member refuses', () => {
    const { row, conflicts: refused } = mergeRow({
      store: 'asset',
      base: {
        id: 'a',
        updated_at: 10,
        review_status: 'rejected',
        reject_reason_text: 'consent unclear',
        creator_facing_note: 'one more take please',
      },
      incoming: {
        id: 'a',
        updated_at: 99,
        review_status: 'approved',
        reject_reason_text: null,
        creator_facing_note: 'looks great',
      },
    })
    // Every field of the losing decision loses with it. Field-level
    // last-write-wins would have left a rejection with the other reviewer's note.
    expect(row.review_status).toBe('rejected')
    expect(row.reject_reason_text).toBe('consent unclear')
    expect(row.creator_facing_note).toBe('one more take please')
    expect(refused).toHaveLength(1)
    expect(refused[0].policy).toBe('ordinal')
    expect(refused[0].fields).toEqual(['review_status', 'reject_reason_text', 'creator_facing_note'])
  })

  it('lets a coupled group fall back to last-write-wins when both sides agree on the status', () => {
    // Refusing on a tie would freeze the reason and the note the moment two
    // devices agreed about the decision itself.
    const { row } = mergeRow({
      store: 'asset',
      base: { id: 'a', updated_at: 10, review_status: 'rejected', creator_facing_note: 'first note' },
      incoming: { id: 'a', updated_at: 20, review_status: 'rejected', creator_facing_note: 'clearer note' },
    })
    expect(row.creator_facing_note).toBe('clearer note')
  })

  it('never merges an AI projection, because the run rows are the source', () => {
    const { row } = mergeRow({
      store: 'asset',
      base: { id: 'a', updated_at: 1, ai_description: 'hands on a back', ai_provenance: 'mock' },
      incoming: { id: 'a', updated_at: 99, ai_description: 'a stale device guessed', ai_provenance: 'none' },
    })
    expect(row.ai_description).toBe('hands on a back')
    expect(row.ai_provenance).toBe('mock')
  })

  it('refuses to resurrect a soft deleted row', () => {
    const { row, conflicts: refused } = mergeRow({
      store: 'asset',
      base: { id: 'a', updated_at: 1, deleted_at: 500 },
      incoming: { id: 'a', updated_at: 99, deleted_at: null },
    })
    expect(row.deleted_at).toBe(500)
    expect(refused[0].policy).toBe('sticky')
  })

  it('ignores an update to an insert-only row', () => {
    const { row, applied } = mergeRow({
      store: 'ai_run',
      base: { id: 'r1', updated_at: 1, output_json: { tags: ['calm'] } },
      incoming: { id: 'r1', updated_at: 99, output_json: { tags: ['edited'] } },
    })
    expect(row.output_json).toEqual({ tags: ['calm'] })
    expect(applied).toEqual([])
  })

  it('refuses a client attempt to write the pull cursor', () => {
    const { row } = mergeRow({
      store: 'asset',
      base: { id: 'a', updated_at: 1, server_updated_at: 40, rev: 3 },
      incoming: { id: 'a', updated_at: 99, server_updated_at: 999999, rev: 1 },
    })
    // A client that could write server_updated_at could hide its own rows from
    // every other device, permanently, with no error anywhere.
    expect(row.server_updated_at).toBe(40)
    expect(row.rev).toBe(3)
  })

  it('takes last-write-wins for the fields nobody declared a rule for', () => {
    const later = mergeRow({
      store: 'asset',
      base: { id: 'a', updated_at: 1, creator_facing_note: 'old' },
      incoming: { id: 'a', updated_at: 2, creator_facing_note: 'new' },
    })
    expect(later.row.creator_facing_note).toBe('new')
    const earlier = mergeRow({
      store: 'asset',
      base: { id: 'a', updated_at: 5, creator_facing_note: 'current' },
      incoming: { id: 'a', updated_at: 2, creator_facing_note: 'stale' },
    })
    expect(earlier.row.creator_facing_note).toBe('current')
  })
})

describe('against a real booted context', () => {
  it('drains work the app itself queued, through the app is own boot path', async () => {
    // The same deps every app-shell suite boots with, so this exercises the
    // real context (device id from meta, injected clock, seeded profile) rather
    // than a hand-built one.
    const bootFactory = new IDBFactory()
    const ctx = await bootApp(testDeps(bootFactory))
    const repo = repoForSession(ctx, sessionForRole('manager'))

    // Hydration writes no outbox entries: seeded rows are history, not work
    // this session did (D12). So the queue starts empty on a freshly seeded app.
    expect(await repo.outboxDepth()).toBe(0)

    const assets = await repo.list<{ id: string }>('asset', { limit: 1 })
    await repo.patch('asset', assets[0].id, { is_hero: true })
    expect(await repo.outboxDepth()).toBe(1)

    const adapter = await connectLoopback({
      profile: ctx.profile,
      local: ctx.db,
      clock: ctx.clock,
      newId: ctx.newId,
      deviceId: ctx.deviceId,
      indexedDbFactory: bootFactory,
      keyRange: IDBKeyRange,
    })
    const report = await adapter.push()
    expect(report.sent).toBe(1)
    expect(await repo.outboxDepth()).toBe(0)

    const snapshot = await adapter.snapshot()
    expect(snapshot.adapter).toBe('loopback')
    expect(snapshot.pending).toBe(0)
    expect(snapshot.sent).toBe(1)
    expect(snapshot.serverRows).toBe(1)
    expect(snapshot.entries[0].patch.is_hero).toBe(true)
    adapter.close()
  })
})
