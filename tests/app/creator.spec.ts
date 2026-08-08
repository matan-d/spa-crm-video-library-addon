import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { bootApp, repoForSession, type AppContext } from '@/app/bootstrap'
import { resolveCreatorToken, sessionForRole } from '@/app/session'
import { DEMO_CREATOR_TOKEN } from '@/data/seed'
import type { Collab } from '@/data/types'
import { testDeps } from './helpers'

interface ConsentRow {
  id: string
  collab_id: string
  consent_text_version: string
  terms_text_snapshot: string | null
  accepted_at: number
}

describe('the creator consent flow', () => {
  let factory: IDBFactory
  let ctx: AppContext

  beforeEach(async () => {
    factory = new IDBFactory()
    ctx = await bootApp(testDeps(factory))
  })

  async function creatorRepo() {
    const resolved = await resolveCreatorToken(ctx.db, DEMO_CREATOR_TOKEN, ctx.clock.now())
    if (resolved.status !== 'ok') throw new Error('expected a live token')
    return { repo: repoForSession(ctx, resolved.session), session: resolved.session }
  }

  it('the seed ships no consent record, so acceptance is a real demo action', async () => {
    const { repo, session } = await creatorRepo()
    const records = await repo.list<ConsentRow>('consent_record', {
      where: (row) => row.collab_id === session.collab_id,
    })
    expect(records).toEqual([])
  })

  it('acceptance writes an immutable, versioned record with the terms snapshotted', async () => {
    const { repo, session } = await creatorRepo()
    const collab = await repo.get<Collab>('collab', session.collab_id!)
    expect(collab?.usage_terms_text).toBeTruthy()

    const id = await repo.create('consent_record', {
      collab_id: session.collab_id,
      token_id: session.token_id,
      consent_text_version: collab!.consent_text_version ?? 'consent-v1',
      terms_text_snapshot: collab!.usage_terms_text,
      accepted_at: ctx.clock.now(),
      consent_ip_hash: null,
      consent_user_agent: null,
    })

    const record = await repo.get<ConsentRow>('consent_record', id)
    expect(record).toBeDefined()
    expect(record!.consent_text_version).toBe('consent-v1')
    // The snapshot, not a pointer: editing the standard terms later cannot
    // change what this creator agreed to.
    expect(record!.terms_text_snapshot).toBe(collab!.usage_terms_text)
    expect(record!.accepted_at).toBeGreaterThan(0)
  })

  it('a consent record is invisible to a different token and readable by the manager', async () => {
    const { repo, session } = await creatorRepo()
    const id = await repo.create('consent_record', {
      collab_id: session.collab_id,
      token_id: session.token_id,
      consent_text_version: 'consent-v1',
      terms_text_snapshot: 'terms',
      accepted_at: ctx.clock.now(),
      consent_ip_hash: null,
      consent_user_agent: null,
    })

    // Another collab's would-be token session must not see it. Build a session
    // for a different collab directly: same kind, different scope.
    const manager = repoForSession(ctx, sessionForRole('manager'))
    const otherCollab = (await manager.list<Collab>('collab')).find(
      (row) => row.id !== session.collab_id,
    )!
    const { creatorTokenSession } = await import('@/data/scope')
    const foreign = repoForSession(
      ctx,
      creatorTokenSession({
        org_id: session.org_id,
        collab_id: otherCollab.id,
        token_id: 'token-foreign',
      }),
    )
    expect(await foreign.get('consent_record', id)).toBeUndefined()

    // The manager sees the record: consent is part of the deal.
    expect(await manager.get('consent_record', id)).toBeDefined()
  })
})
