import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { computeDiff, triageDelivery } from '@/app/manager/triage'
import { bootApp, repoForSession } from '@/app/bootstrap'
import { sessionForRole } from '@/app/session'
import type { Asset, BriefItem, Delivery } from '@/data/types'
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
