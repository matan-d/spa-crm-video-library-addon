import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computeDiff, triageDelivery } from '@/app/manager/triage'
import { computeScorecards, rosterOrder } from '@/data/scorecard'
import { allowedTiers, overrideFitScore, vetCreator } from '@/app/manager/vetting'
import { createAiProvider } from '@/ai'
import { bootApp, repoForSession } from '@/app/bootstrap'
import { sessionForRole } from '@/app/session'
import type { Asset, BriefItem, Collab, Creator, Delivery } from '@/data/types'
import { testDeps } from './helpers'

// ---------------------------------------------------------------------------
// unit: triage bucketing
// ---------------------------------------------------------------------------

function makeDelivery(id: string): Delivery {
  return { id, collab_id: 'c1', state: 'submitted', submitted_at: 1 } as Delivery
}

function makeAsset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    delivery_id: 'd1',
    review_status: 'pending',
    derivative_state: 'ready',
    ai_brand_safety: 'clear',
    preflight: {},
    ...over,
  } as Asset
}

describe('triageDelivery', () => {
  it('puts a delivery with reviewable pending clips in needs_review', () => {
    const triaged = triageDelivery(makeDelivery('d1'), [makeAsset('a1')])
    expect(triaged.bucket).toBe('needs_review')
    expect(triaged.pendingCount).toBe(1)
  })

  it('puts a delivery whose pending clips all lack derivatives in awaiting_derivatives', () => {
    const triaged = triageDelivery(makeDelivery('d1'), [
      makeAsset('a1', { derivative_state: 'none' }),
    ])
    expect(triaged.bucket).toBe('awaiting_derivatives')
  })

  it('blocked outranks review: a brand safety hold cannot be waved through', () => {
    const triaged = triageDelivery(makeDelivery('d1'), [
      makeAsset('a1'),
      makeAsset('a2', { ai_brand_safety: 'blocked' }),
    ])
    expect(triaged.bucket).toBe('blocked')
  })

  it('a blocking pre-flight fail also blocks', () => {
    const triaged = triageDelivery(makeDelivery('d1'), [
      makeAsset('a1', {
        preflight: {
          orientation: { status: 'fail', blocking: true, evidence: 'coded_dims', reason: null },
        } as never,
      }),
    ])
    expect(triaged.bucket).toBe('blocked')
  })

  it('a fully decided delivery is done', () => {
    const triaged = triageDelivery(makeDelivery('d1'), [
      makeAsset('a1', { review_status: 'approved' }),
    ])
    expect(triaged.bucket).toBe('done')
    expect(triaged.pendingCount).toBe(0)
  })

  it('an advisory fail does not block', () => {
    const triaged = triageDelivery(makeDelivery('d1'), [
      makeAsset('a1', {
        preflight: {
          near_branch: { status: 'fail', blocking: false, evidence: 'gps', reason: null },
        } as never,
      }),
    ])
    expect(triaged.bucket).toBe('needs_review')
  })
})

// ---------------------------------------------------------------------------
// unit: the diff and the over-claim arithmetic
// ---------------------------------------------------------------------------

function makeItem(id: string, seq: number): BriefItem {
  return { id, brief_id: 'b1', seq, instruction: `shot ${seq}`, min_takes: 1 } as BriefItem
}

describe('computeDiff', () => {
  const items = Array.from({ length: 10 }, (_, i) => makeItem(`i${i + 1}`, i + 1))

  it('an AI match counts while the clip is undecided, and stops the moment a human decides', () => {
    const covered = [1, 3, 4, 5, 7, 8, 10]
    const assets = covered.map((n, index) =>
      makeAsset(`a${index}`, { ai_matched_brief_item_id: `i${n}`, confirmed_brief_item_id: null }),
    )
    // The over-claim: the model matched a clip to item 9, which nothing covers.
    const overClaim = makeAsset('a-over', {
      ai_matched_brief_item_id: 'i9',
      confirmed_brief_item_id: null,
    })

    const before = computeDiff(items, [...assets, overClaim])
    expect(before.metCount).toBe(8)
    expect(before.items.find((entry) => entry.item.id === 'i9')!.delivered[0]!.provenance).toBe('ai')

    // The human reviews the clip and does not confirm the match.
    const corrected = makeAsset('a-over', {
      ai_matched_brief_item_id: 'i9',
      confirmed_brief_item_id: null,
      review_status: 'approved',
    })
    const after = computeDiff(items, [...assets, corrected])
    expect(after.metCount).toBe(7)
    expect(after.extras.map((asset) => asset.id)).toContain('a-over')
  })

  it('a human confirmation renders as human provenance', () => {
    const diff = computeDiff(
      [makeItem('i1', 1)],
      [makeAsset('a1', { confirmed_brief_item_id: 'i1', review_status: 'approved' })],
    )
    expect(diff.items[0]!.status).toBe('met')
    expect(diff.items[0]!.delivered[0]!.provenance).toBe('human')
  })

  it('missing becomes indeterminate while sheetless clips exist', () => {
    const diff = computeDiff(
      [makeItem('i1', 1), makeItem('i2', 2)],
      [
        makeAsset('a1', { ai_matched_brief_item_id: 'i1' }),
        makeAsset('a2', { derivative_state: 'none' }),
      ],
    )
    expect(diff.items[0]!.status).toBe('met')
    expect(diff.items[1]!.status).toBe('indeterminate')
    expect(diff.awaitingDerivatives.map((asset) => asset.id)).toEqual(['a2'])
  })

  it('a sheetless clip is never an extra', () => {
    const diff = computeDiff([], [makeAsset('a1', { derivative_state: 'none' })])
    expect(diff.extras).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// integration: the seeded trap is real, and review moves the number
// ---------------------------------------------------------------------------

describe('the seeded hero delivery', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
  })

  it('contains the AI over-claim, and the human correction reveals the true seven of ten', async () => {
    const ctx = await bootApp(testDeps(factory))
    const manager = repoForSession(ctx, sessionForRole('manager'))

    const delivery = await manager.get<Delivery>('delivery', 'delivery-hero')
    expect(delivery).toBeDefined()

    const briefs = await manager.list<{ id: string; collab_id: string; status: string }>('brief', {
      where: (row) => row.collab_id === delivery!.collab_id,
    })
    const locked = briefs.find((row) => row.status === 'locked') ?? briefs[0]!
    const items = await manager.list<BriefItem>('brief_item', {
      where: (row) => row.brief_id === locked.id,
    })
    expect(items.length).toBe(10)

    const assets = await manager.list<Asset>('asset', {
      where: (row) => row.delivery_id === 'delivery-hero',
    })

    const diff = computeDiff(items, assets)

    // The model claims 8 distinct items; the human correction already in the
    // seed reveals the true seven of ten.
    const modelClaimed = new Set(
      assets
        .filter((asset) => asset.ai_matched_brief_item_id != null)
        .map((asset) => asset.ai_matched_brief_item_id),
    )
    expect(modelClaimed.size).toBe(8)
    expect(diff.metCount).toBe(7)
    expect(diff.coveragePct).toBe(70)

    // The over-claim must be visible, not silently gone: the uncovered item
    // shows the corrected model claim.
    const overClaimed = diff.items.find((entry) => entry.overClaims.length > 0)
    expect(overClaimed).toBeDefined()
    expect(overClaimed!.status).not.toBe('met')
    const claimant = overClaimed!.overClaims[0]!
    // And the human's correction points the same clip at a different item,
    // which is met through human provenance.
    expect(claimant.confirmed_brief_item_id).not.toBeNull()
    expect(claimant.confirmed_brief_item_id).not.toBe(overClaimed!.item.id)
    const correctedItem = diff.items.find((entry) => entry.item.id === claimant.confirmed_brief_item_id)
    expect(correctedItem!.status).toBe('met')
    expect(
      correctedItem!.delivered.some(
        (delivered) => delivered.asset.id === claimant.id && delivered.provenance === 'human',
      ),
    ).toBe(true)

    // The extras bucket is real: the seed ships three clips matching nothing.
    expect(diff.extras.length).toBeGreaterThanOrEqual(3)
  })

  it('publishing an approved clip makes it visible to the editor, and not before', async () => {
    const ctx = await bootApp(testDeps(factory))
    const manager = repoForSession(ctx, sessionForRole('manager'))
    const editor = repoForSession(ctx, sessionForRole('editor'))

    const pending = await manager.list<Asset>('asset', {
      where: (row) => row.delivery_id === 'delivery-hero' && row.review_status === 'pending',
      limit: 1,
    })
    const target = pending[0]!
    expect(await editor.get('asset', target.id)).toBeUndefined()

    await manager.patch('asset', target.id, { review_status: 'approved' })
    expect(await editor.get('asset', target.id)).toBeUndefined()

    await manager.patch('asset', target.id, { is_published: true })
    const visible = await editor.get<Asset>('asset', target.id)
    expect(visible).toBeDefined()
    // And the projection still strips what an editor may not see.
    expect(visible).not.toHaveProperty('reject_reason_text')
  })
})

// ---------------------------------------------------------------------------
// unit: the creator scorecard, the measured half of the second feedback loop
// ---------------------------------------------------------------------------

function makeCreator(id: string): Creator {
  return {
    id,
    display_name: id,
    primary_handle: `@${id}`,
    lifecycle: 'active',
    platforms: [],
    fit_score: null,
    fit_reasons: [],
    risk_flags: [],
    suggested_tier: null,
    fit_score_override: null,
    override_reason: null,
    reliability_tier: 'new',
    scorecard: null,
    notes: null,
  } as unknown as Creator
}

function makeCollab(id: string, creator_id: string, over: Partial<Collab> = {}): Collab {
  return { id, creator_id, branch_id: 'b1', stage: 'library', outcome: 'completed', ...over } as Collab
}

describe('computeScorecards', () => {
  const base = { deliveries: [] as never[], briefs: [] as never[], briefItems: [] as never[] }

  it('reports a rate with no denominator as unknown, never as zero', () => {
    // A brand new creator scored 0% would sort below one who genuinely delivers
    // badly, which inverts the judgement this panel exists to support.
    const [row] = computeScorecards({
      ...base,
      creators: [makeCreator('c1')],
      collabs: [],
      assets: [],
    })
    expect(row!.computed.approval_rate).toBeNull()
    expect(row!.computed.promise_kept_rate).toBeNull()
    expect(row!.computed.completed_collabs).toBe(0)
  })

  it('counts only clips a human actually ruled on, so a review backlog is not the creator fault', () => {
    const [row] = computeScorecards({
      ...base,
      creators: [makeCreator('c1')],
      collabs: [makeCollab('k1', 'c1')],
      assets: [
        makeAsset('a1', { collab_id: 'k1', review_status: 'approved' }),
        makeAsset('a2', { collab_id: 'k1', review_status: 'rejected' }),
        // Three still waiting. They are not failures, they are unreviewed.
        makeAsset('a3', { collab_id: 'k1', review_status: 'pending' }),
        makeAsset('a4', { collab_id: 'k1', review_status: 'pending' }),
        makeAsset('a5', { collab_id: 'k1', review_status: 'pending' }),
      ] as Asset[],
    })
    expect(row!.computed.assets_ruled_on).toBe(2)
    expect(row!.computed.approval_rate).toBe(0.5)
  })

  it('measures promise kept against a locked brief only, and against the human confirmation', () => {
    const locked = { id: 'br1', collab_id: 'k1', locked_at: 100 }
    const draft = { id: 'br2', collab_id: 'k1', locked_at: null }
    const [row] = computeScorecards({
      creators: [makeCreator('c1')],
      collabs: [makeCollab('k1', 'c1')],
      deliveries: [],
      briefs: [locked, draft] as never[],
      briefItems: [
        { id: 'i1', brief_id: 'br1' },
        { id: 'i2', brief_id: 'br1' },
        // On the draft. Holding a creator to a shot list that changed after they
        // shot it is not a reliability signal.
        { id: 'i3', brief_id: 'br2' },
      ] as never[],
      assets: [
        makeAsset('a1', { collab_id: 'k1', review_status: 'approved', confirmed_brief_item_id: 'i1' }),
        // The MODEL matched this one and no human confirmed it. Scoring a creator
        // off the model's guess would spend the separation those columns exist for.
        makeAsset('a2', {
          collab_id: 'k1',
          review_status: 'approved',
          ai_matched_brief_item_id: 'i2',
          confirmed_brief_item_id: null,
        }),
      ] as Asset[],
    })
    expect(row!.computed.brief_items_promised).toBe(2)
    expect(row!.computed.brief_items_delivered).toBe(1)
    expect(row!.computed.promise_kept_rate).toBe(0.5)
  })

  it('flags a stored scorecard that disagrees with the derivation rather than silently preferring one', () => {
    const creator = makeCreator('c1')
    creator.scorecard = {
      completed_collabs: 4,
      approval_rate: 0.9,
      promise_kept_rate: null,
      brand_safety_hits: 0,
      consent_problems: 0,
    }
    const [row] = computeScorecards({
      ...base,
      creators: [creator],
      collabs: [makeCollab('k1', 'c1')],
      assets: [makeAsset('a1', { collab_id: 'k1', review_status: 'approved' })] as Asset[],
    })
    expect(row!.computed.completed_collabs).toBe(1)
    expect(row!.drift.length).toBe(2)
    expect(row!.drift.join(' ')).toContain('stored 4, computed 1')
  })

  it('names the human override as the effective score, and keeps the model number separate', () => {
    const creator = makeCreator('c1')
    creator.fit_score = 88
    creator.fit_score_override = 62
    const [row] = computeScorecards({ ...base, creators: [creator], collabs: [], assets: [] })
    expect(row!.effective_score).toBe(62)
    expect(row!.effective_source).toBe('human')
    expect(row!.creator.fit_score).toBe(88)
  })

  it('sinks a blocked creator below every score, so a hard gate is not clicked through', () => {
    const blocked = makeCreator('blocked')
    blocked.lifecycle = 'blocked'
    blocked.fit_score = 99
    const ok = makeCreator('ok')
    ok.fit_score = 40
    const unscored = makeCreator('unscored')

    const order = computeScorecards({ ...base, creators: [blocked, ok, unscored], collabs: [], assets: [] })
      .sort(rosterOrder)
      .map((row) => row.creator.id)
    // Scored beats unscored, and both beat blocked. Unscored is not scored zero.
    expect(order).toEqual(['ok', 'unscored', 'blocked'])
  })
})

describe('vetting', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
    setActivePinia(createPinia())
  })

  it('widens the tier band with evidence, and never lets the model choose outside it', () => {
    expect(allowedTiers('new')).toEqual(['half_day'])
    expect(allowedTiers('proven')).toContain('full_day')
    expect(allowedTiers('trusted')).toContain('vip_full')
    expect(allowedTiers('new')).not.toContain('vip_full')
  })

  it('refuses to re-score a creator a human blocked', async () => {
    const ctx = await bootApp(testDeps(factory))
    const repo = repoForSession(ctx, sessionForRole('manager'))
    const creator = makeCreator('c1')
    creator.lifecycle = 'blocked'

    const outcome = await vetCreator({ repo }, creator, [], null)
    expect(outcome.status).toBe('refused')
  })

  it('drops a suggested tier the band did not permit', async () => {
    const ctx = await bootApp(testDeps(factory))
    const repo = repoForSession(ctx, sessionForRole('manager'))
    const [creator] = await repo.list<Creator>('creator', { limit: 1 })
    await repo.patch('creator', creator!.id, { reliability_tier: 'new' })
    const fresh = (await repo.get<Creator>('creator', creator!.id))!

    // The real mock provider, with one field bent. A hand-rolled meta would not
    // survive `writeAiRun`, and the point of the test is the band check rather
    // than a fake that happens to satisfy the run writer.
    const inner = createAiProvider({ mode: 'mock' })
    const generous = {
      async vet(input: Parameters<typeof inner.vet>[0]) {
        const result = await inner.vet(input)
        return {
          ...result,
          // Outside the band the code computed and told it about.
          output: { ...result.output, score: 91, suggested_tier: 'vip_full' },
        }
      },
    } as never

    const outcome = await vetCreator({ repo }, fresh, [], null, generous)
    expect(outcome.status).toBe('vetted')
    const after = (await repo.get<Creator>('creator', creator!.id))!
    expect(after.suggested_tier).toBeNull()
    expect(after.fit_score).toBe(91)
  })

  it('never clears a human override, however sure the model is', async () => {
    const ctx = await bootApp(testDeps(factory))
    const repo = repoForSession(ctx, sessionForRole('manager'))
    const [creator] = await repo.list<Creator>('creator', { limit: 1 })
    await overrideFitScore(repo, creator!.id, 62, 'Audience is younger than the branch demographic.')
    const fresh = (await repo.get<Creator>('creator', creator!.id))!

    await vetCreator({ repo }, fresh, [], null)

    const after = (await repo.get<Creator>('creator', creator!.id))!
    expect(after.fit_score_override).toBe(62)
    expect(after.override_reason).toBe('Audience is younger than the branch demographic.')
  })

  it('refuses an override with no reason, because a number alone is not a decision', async () => {
    const ctx = await bootApp(testDeps(factory))
    const repo = repoForSession(ctx, sessionForRole('manager'))
    const [creator] = await repo.list<Creator>('creator', { limit: 1 })
    await expect(overrideFitScore(repo, creator!.id, 71, '   ')).rejects.toThrow(/needs a reason/)
  })

  it('withdrawing an override clears its reason with it', async () => {
    const ctx = await bootApp(testDeps(factory))
    const repo = repoForSession(ctx, sessionForRole('manager'))
    const [creator] = await repo.list<Creator>('creator', { limit: 1 })
    await overrideFitScore(repo, creator!.id, 71, 'met them at the branch')
    await overrideFitScore(repo, creator!.id, null, '')
    const after = (await repo.get<Creator>('creator', creator!.id))!
    expect(after.fit_score_override).toBeNull()
    expect(after.override_reason).toBeNull()
  })
})
