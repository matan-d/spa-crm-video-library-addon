import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@/data/db'
import { countRows, hydrateIfNeeded, SEED_VERSION } from '@/data/hydrate'
import { buildSeed, signatureOf } from '@/data/seed'
import { computeScorecards } from '@/data/scorecard'
import type { Asset, Brief, BriefItem, Collab, Creator, Delivery } from '@/data/types'
import { createScopedRepo } from '@/data/repo'
import { editorSession, managerSession } from '@/data/scope'
import { SeededClock, SEED_EPOCH_MS } from '@/platform/clock'
import { SeededRng, SEED_STRING } from '@/platform/rng'
import { createIdFactory } from '@/platform/id'
import { media } from './media-fixture'


function build() {
  const clock = new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: 1 })
  const rng = new SeededRng(SEED_STRING)
  return buildSeed({ clock, rng, newId: createIdFactory(clock, rng), media: media() })
}

describe('the seed is deterministic', () => {
  it('produces byte identical output from the same inputs', () => {
    // If this ever fails, the demo no longer matches the README screenshots and
    // every test asserting a seeded id becomes flaky.
    expect(JSON.stringify(build().rows)).toBe(JSON.stringify(build().rows))
  })

  it('produces different output from a different seed', () => {
    const clock = new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: 1 })
    const rng = new SeededRng('a-different-seed')
    const other = buildSeed({ clock, rng, newId: createIdFactory(clock, rng), media: media() })
    expect(JSON.stringify(other.rows)).not.toBe(JSON.stringify(build().rows))
  })

  it('gives every row an id, an org and a revision', () => {
    for (const [store, rows] of Object.entries(build().rows)) {
      for (const row of rows) {
        expect(typeof row.id, `${store} id`).toBe('string')
        expect(row.org_id, `${store} org`).toBe('org-astolia')
        expect(row.rev, `${store} rev`).toBe(1)
        expect(row.deleted_at).toBeNull()
      }
    }
  })

  it('marks seeded rows as already synced, so the demo does not open with a fake backlog', () => {
    for (const rows of Object.values(build().rows)) {
      for (const row of rows) expect(row.server_updated_at).toBeTypeOf('number')
    }
  })
})

describe('the seed covers the cases that make the interface honest', () => {
  const { rows, summary } = build()

  it('has a collab in every pipeline stage', () => {
    const stages = new Set((rows.collab ?? []).map((c) => c.stage))
    for (const stage of ['source', 'vet', 'book', 'brief', 'visit', 'delivered', 'library']) {
      expect(stages, `no collab in stage ${stage}`).toContain(stage)
    }
  })

  it('has a ghosted collab, without which the creator scorecard is meaningless', () => {
    expect((rows.collab ?? []).some((c) => c.outcome === 'ghosted')).toBe(true)
  })

  it('has the AI over-claim coverage, which a human correction then reduces', () => {
    // The seed intends 7 of 10 brief items genuinely covered. The deliberate
    // AI-versus-human disagreement points one clip at an eighth item that nothing
    // actually covers, so the model proposes 8 of 10 and the human's correction
    // reveals the truth. That is a far more useful demo state than a clean 7,
    // because it is what the review screen exists to catch.
    const heroAssets = (rows.asset ?? []).filter((a) => a.delivery_id === 'delivery-hero')
    const aiClaimed = new Set(heroAssets.map((a) => a.ai_matched_brief_item_id).filter(Boolean))
    expect(aiClaimed.size).toBe(8)

    const corrections = heroAssets.filter(
      (a) =>
        a.confirmed_brief_item_id !== null &&
        a.ai_matched_brief_item_id !== null &&
        a.confirmed_brief_item_id !== a.ai_matched_brief_item_id,
    )
    expect(corrections).toHaveLength(1)

    // After the correction, the item the AI wrongly claimed has nothing covering it.
    const corrected = corrections[0]!
    const stillClaimedByAnother = heroAssets.some(
      (a) => a.id !== corrected.id && a.ai_matched_brief_item_id === corrected.ai_matched_brief_item_id,
    )
    expect(stillClaimedByAnother).toBe(false)
  })

  it('includes clips that match no brief item at all', () => {
    const extras = (rows.asset ?? []).filter(
      (a) => a.delivery_id === 'delivery-hero' && a.ai_matched_brief_item_id === null,
    )
    expect(extras.length).toBeGreaterThanOrEqual(3)
  })

  it('never invents AI fields for a clip with no contact sheet', () => {
    // The single most damaging failure available in this product, so the seed must
    // demonstrate the honest state rather than a plausible one.
    const noSheet = (rows.asset ?? []).filter((a) => a.sheet_key === null)
    expect(noSheet.length).toBeGreaterThan(0)
    for (const asset of noSheet) {
      expect(asset.ai_description).toBeNull()
      expect(asset.ai_quality_score).toBeNull()
      expect(asset.ai_provenance).toBe('none')
      expect(asset.ai_subjects).toEqual([])
    }
  })

  it('tags nothing on a clip nobody could see', () => {
    const noSheetIds = new Set((rows.asset ?? []).filter((a) => a.sheet_key === null).map((a) => a.id))
    const tagged = (rows.tag ?? []).filter((t) => noSheetIds.has(t.asset_id as string))
    expect(tagged).toHaveLength(0)
  })

  it('records unknown rather than fail where a camera has no GPS', () => {
    const cameraShots = (rows.asset ?? []).filter((a) => a.gps === null)
    expect(cameraShots.length).toBeGreaterThan(0)
    for (const asset of cameraShots) {
      const rule = (asset.preflight as Record<string, { status: string; reason: string | null }>).near_branch
      expect(rule.status).toBe('unknown')
      expect(rule.reason).toBe('no_gps_in_container')
    }
  })

  it('has an AI match a human corrected, so match accuracy is not a fake 100 percent', () => {
    const disagreements = (rows.asset ?? []).filter(
      (a) =>
        a.confirmed_brief_item_id !== null &&
        a.ai_matched_brief_item_id !== null &&
        a.confirmed_brief_item_id !== a.ai_matched_brief_item_id,
    )
    expect(disagreements.length).toBeGreaterThan(0)
  })

  it('keeps AI and human tags as separate rows, because the disagreement is the eval set', () => {
    const sources = new Set((rows.tag ?? []).map((t) => t.source))
    expect(sources).toContain('ai')
    expect(sources).toContain('human')
  })

  it('records the review method from the start', () => {
    // Without this, every scorecard computed from review_status becomes meaningless
    // the day batch approve ships.
    const methods = new Set((rows.review_action ?? []).map((r) => r.method))
    expect(methods.size).toBeGreaterThan(1)
  })

  it('links two brief items back to the gaps that produced them', () => {
    const linked = (rows.brief_item ?? []).filter((i) => i.origin_gap_id !== null)
    expect(linked.length).toBe(2)
    const gapIds = new Set((rows.gap ?? []).map((g) => g.id))
    for (const item of linked) expect(gapIds).toContain(item.origin_gap_id)
  })

  it('links the hero brief to the scan that generated it', () => {
    const brief = (rows.brief ?? []).find((b) => b.id === 'brief-delivered')
    expect(brief?.gap_scan_id).toBe('gap-scan-current')
  })

  it('keys a dismissal by cell signature so a rescan cannot resurrect it', () => {
    const dismissal = (rows.gap_dismissal ?? [])[0]
    expect(dismissal).toBeDefined()
    const gap = (rows.gap ?? []).find((g) => g.status === 'dismissed')
    expect(dismissal!.cell_signature).toBe(gap!.cell_signature)
    expect(dismissal!.cell_signature).not.toBe(gap!.id)
  })

  it('logs zero-result searches clustered on a few cells rather than scattered', () => {
    // Forty scattered gaps are indistinguishable from a random number generator,
    // and a reviewer reads them that way.
    const zero = (rows.search_query_log ?? []).filter((q) => q.outcome === 'zero_results')
    expect(zero.length).toBeGreaterThan(20)
    const distinct = new Set(zero.map((q) => q.text))
    expect(distinct.size).toBeLessThanOrEqual(8)
  })

  it('records rank_at_event on usage, which cannot be backfilled later', () => {
    const events = rows.usage_event ?? []
    expect(events.length).toBeGreaterThan(50)
    for (const event of events) expect(event.rank_at_event).toBeTypeOf('number')
  })

  it('clicks land beyond rank one, so the ranking signal is not trivial', () => {
    const ranks = new Set((rows.usage_event ?? []).map((e) => e.rank_at_event))
    expect(ranks.size).toBeGreaterThan(3)
  })

  it('keeps Palo Alto thin, so the gap scan cold start path has data', () => {
    const pa = (rows.asset ?? []).filter((a) => a.branch_id === 'branch-palo-alto')
    const sj = (rows.asset ?? []).filter((a) => a.branch_id === 'branch-san-jose')
    expect(pa.length).toBeGreaterThan(0)
    expect(pa.length).toBeLessThan(sj.length / 3)
  })

  it('lists what it deliberately got wrong, so nobody mistakes it for a happy path', () => {
    expect(summary.imperfectCases.length).toBeGreaterThanOrEqual(8)
  })
})

describe('hydration', () => {
  let db: IDBDatabase

  beforeEach(async () => {
    db = (await openDatabase('demo', new IDBFactory())).db
  })

  it('writes the seed and records its version', async () => {
    const result = await hydrateIfNeeded({ db, loadMediaManifest: async () => media() })
    expect(result.seeded).toBe(true)
    expect(result.version).toBe(SEED_VERSION)
    const counts = await countRows(db, ['asset', 'collab', 'gap', 'tag'])
    expect(counts.asset).toBeGreaterThan(20)
    expect(counts.collab).toBe(8)
    expect(counts.gap).toBe(11)
  })

  it('is idempotent, so a second boot does nothing', async () => {
    await hydrateIfNeeded({ db, loadMediaManifest: async () => media() })
    const before = await countRows(db, ['asset'])
    const second = await hydrateIfNeeded({ db, loadMediaManifest: async () => media() })
    expect(second.seeded).toBe(false)
    expect((await countRows(db, ['asset'])).asset).toBe(before.asset)
  })

  it('leaves the outbox empty, because seeded history is not work somebody did', async () => {
    await hydrateIfNeeded({ db, loadMediaManifest: async () => media() })
    const repo = createScopedRepo({
      db,
      session: managerSession({ org_id: 'org-astolia', user_id: 'user-manager' }),
      now: () => SEED_EPOCH_MS,
      newId: createIdFactory(new SeededClock({ startMs: SEED_EPOCH_MS }), new SeededRng(SEED_STRING)),
      deviceId: 'test',
    })
    expect(await repo.outboxDepth()).toBe(0)
  })

  it('opens on a non-empty library for the editor, which is the first thing a reviewer sees', async () => {
    await hydrateIfNeeded({ db, loadMediaManifest: async () => media() })
    const repo = createScopedRepo({
      db,
      session: editorSession({ org_id: 'org-astolia', user_id: 'user-editor' }),
      now: () => SEED_EPOCH_MS,
      newId: createIdFactory(new SeededClock({ startMs: SEED_EPOCH_MS }), new SeededRng(SEED_STRING)),
      deviceId: 'test',
    })
    const library = await repo.list('asset')
    expect(library.length).toBeGreaterThan(15)
    // And every one of them carries a real poster path, so the grid is not empty boxes.
    for (const asset of library as { poster_key: string | null }[]) {
      expect(asset.poster_key).toMatch(/^\/seed\/posters\//)
    }
  })

  it('hides the unreviewed hero delivery from the editor', async () => {
    await hydrateIfNeeded({ db, loadMediaManifest: async () => media() })
    const repo = createScopedRepo({
      db,
      session: editorSession({ org_id: 'org-astolia', user_id: 'user-editor' }),
      now: () => SEED_EPOCH_MS,
      newId: createIdFactory(new SeededClock({ startMs: SEED_EPOCH_MS }), new SeededRng(SEED_STRING)),
      deviceId: 'test',
    })
    const ids = (await repo.list('asset')).map((a) => (a as { id: string }).id)
    expect(ids.some((id) => id.startsWith('asset-hero'))).toBe(false)
  })
})

describe('signatureOf', () => {
  it('is stable regardless of key order', () => {
    expect(signatureOf({ room: 'sauna', shot_type: 'wide' })).toBe(
      signatureOf({ shot_type: 'wide', room: 'sauna' }),
    )
  })

  it('differs for different cells', () => {
    expect(signatureOf({ room: 'sauna' })).not.toBe(signatureOf({ room: 'lounge' }))
  })
})

describe('the seeded scorecard cache', () => {
  it('is derived from the rows it was seeded alongside, not typed in', async () => {
    const seed = build()
    const derived = computeScorecards({
      creators: seed.rows.creator as unknown as Creator[],
      collabs: seed.rows.collab as unknown as Collab[],
      deliveries: (seed.rows.delivery ?? []) as unknown as Delivery[],
      assets: seed.rows.asset as unknown as Asset[],
      briefs: (seed.rows.brief ?? []) as unknown as Brief[],
      briefItems: (seed.rows.brief_item ?? []) as unknown as BriefItem[],
    })

    // Exactly one row is left stale on purpose, so the roster's drift warning has
    // data. Every other cache agrees with the derivation, so a drift a reviewer
    // sees is a real one rather than seed noise.
    const drifting = derived.filter((row) => row.drift.length > 0).map((row) => row.creator.id)
    expect(drifting).toEqual(['creator-1'])
  })

  it('lists the stale cache among the imperfections rather than hiding it', () => {
    const seed = build()
    expect(seed.summary.imperfectCases.join(' ')).toContain('stale')
  })
})
