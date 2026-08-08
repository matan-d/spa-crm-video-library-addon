import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { bootApp, repoForSession, type AppContext } from '@/app/bootstrap'
import { sessionForRole } from '@/app/session'
import {
  assetCoversCell,
  detectClosures,
  generateBriefFromGaps,
  instructionFor,
  lockBrief,
  runGapScan,
} from '@/app/loop/loop'
import { signatureOf } from '@/data/seed'
import type { Asset, Brief, BriefItem, Gap } from '@/data/types'
import { testDeps } from './helpers'

let factory: IDBFactory
let ctx: AppContext

beforeEach(async () => {
  factory = new IDBFactory()
  ctx = await bootApp(testDeps(factory))
})

const manager = () => repoForSession(ctx, sessionForRole('manager'))
const editor = () => repoForSession(ctx, sessionForRole('editor'))

describe('instructionFor', () => {
  it('phrases a cell deterministically with no model involved', () => {
    expect(instructionFor({ room: 'exterior', shot_type: 'wide' })).toBe(
      'wide of the exterior, vertical, natural light',
    )
    expect(instructionFor({ subject: 'towels', shot_type: 'macro', light: 'warm_light' })).toBe(
      'macro featuring towels, warm light, vertical, natural light',
    )
  })
})

describe('runGapScan', () => {
  it('clusters zero-result queries into cells from mapped terms only', async () => {
    const repo = manager()
    const result = await runGapScan({ repo, now: ctx.clock.now() })
    expect(result.scanId).toBeTruthy()

    const scanGaps = await repo.list<Gap>('gap', {
      where: (row) => row.gap_scan_id === result.scanId,
    })
    // The seeded zero-result queries include 'reception greeting' and
    // 'reception welcome': 'reception' maps as a room, 'greeting' and
    // 'welcome' do not. The cell is room: reception, nothing else.
    const reception = scanGaps.find((gap) => gap.facets.room === 'reception' && !gap.facets.branch)
    expect(reception).toBeDefined()
    expect(Object.keys(reception!.facets)).toEqual(['room'])
    expect(reception!.signals.some((signal) => signal.source === 'zero_result_queries')).toBe(true)
  })

  it('unmapped-only queries become vocabulary insights, never content gaps', async () => {
    const repo = manager()
    const result = await runGapScan({ repo, now: ctx.clock.now() })
    // 'exterior arrival' and friends: 'exterior' is not in the vocabulary and
    // recurs past the threshold, so it must surface as a vocabulary gap.
    expect(result.vocabularyGaps).toContain('exterior')
    // And no cell THIS scan minted may carry an unmapped word. The seeded
    // gaps predate the rule and are not this scan's responsibility.
    const scanGaps = await repo.list<Gap>('gap', {
      where: (row) => row.gap_scan_id === result.scanId && row.status === 'open',
    })
    for (const gap of scanGaps) {
      expect(Object.values(gap.facets)).not.toContain('exterior')
      expect(Object.values(gap.facets)).not.toContain('arrival')
    }
    const insights = await repo.list<{ kind: string; term: string }>('insight', {
      where: (row) => row.kind === 'vocabulary_gap',
    })
    expect(insights.some((insight) => insight.term === 'exterior')).toBe(true)
  })

  it('a dismissal keyed by signature suppresses the cell on rescan', async () => {
    const repo = manager()
    const first = await runGapScan({ repo, now: ctx.clock.now() })
    const gaps = await repo.list<Gap>('gap', {
      where: (row) => row.gap_scan_id === first.scanId && row.status === 'open',
    })
    const victim = gaps[0]!
    await repo.create('gap_dismissal', {
      cell_signature: victim.cell_signature,
      reason: 'not_a_real_gap',
      dismissed_by: 'user-manager',
    })
    await repo.patch('gap', victim.id, { status: 'dismissed' })

    const second = await runGapScan({ repo, now: ctx.clock.now() })
    expect(second.suppressed).toContain(victim.cell_signature)
    const resurrection = await repo.list<Gap>('gap', {
      where: (row) =>
        row.gap_scan_id === second.scanId &&
        row.cell_signature === victim.cell_signature &&
        row.status === 'open',
    })
    expect(resurrection).toEqual([])
  })

  it('a rescan refreshes an existing open cell rather than minting a twin', async () => {
    const repo = manager()
    const first = await runGapScan({ repo, now: ctx.clock.now() })
    const before = await repo.count('gap')
    const second = await runGapScan({ repo, now: ctx.clock.now() })
    expect(second.scanId).not.toBe(first.scanId)
    // Same signals, same cells: no new gap rows, only refreshed ones.
    expect(await repo.count('gap')).toBe(before)
  })
})

describe('the flagship chain: gap to brief to asset to closed gap, by ids alone', () => {
  it('every hop is written and readable from the data', async () => {
    const managerRepo = manager()
    const editorRepo = editor()

    // Hop 1: an editor's failed search becomes a gap.
    const facets = { room: 'studio', shot_type: 'macro' }
    const gapId = await editorRepo.create('gap', {
      gap_scan_id: null,
      branch_id: null,
      cell_signature: signatureOf(facets),
      facets,
      score: 0.9,
      severity: 'high',
      status: 'open',
      signals: [{ source: 'editor_request', weight: 1, detail: 'studio macro' }],
      closing_asset_ids: [],
    })

    // Hop 2: the manager generates a brief from open gaps. The new gap has the
    // highest score in the seed, so it is item one.
    const generated = await generateBriefFromGaps({
      repo: managerRepo,
      collabId: 'collab-brief',
      scanId: null,
      maxItems: 5,
    })
    const items = await managerRepo.list<BriefItem>('brief_item', {
      where: (row) => row.brief_id === generated.briefId,
    })
    const fromGap = items.find((item) => item.origin_gap_id === gapId)
    expect(fromGap).toBeDefined()

    // Hop 3: the lock freezes the promise.
    await lockBrief(managerRepo, generated.briefId, ctx.clock.now())
    const locked = await managerRepo.get<Brief>('brief', generated.briefId)
    expect(locked!.status).toBe('locked')
    expect(locked!.locked_at).not.toBeNull()

    // Hop 4: a delivered clip is confirmed against the item and published.
    const assetId = await managerRepo.create('asset', {
      kind: 'video',
      delivery_id: 'delivery-hero',
      collab_id: 'collab-brief',
      branch_id: 'branch-san-jose',
      filename: 'studio-macro-01.mp4',
      bytes: 1000,
      duration_s: 6,
      coded_width: 1080,
      coded_height: 1920,
      rotation_deg: 0,
      codec_video: 'avc1',
      has_audio: false,
      captured_at: ctx.clock.now(),
      captured_at_source: 'mvhd',
      gps: null,
      client_decodable: true,
      needs_transcode: false,
      probe_result: 'h264:yes',
      preflight_version: 2,
      preflight: {},
      ai_description: 'macro of product in the studio',
      ai_shot_type: 'macro',
      ai_room: 'studio',
      ai_subjects: ['product'],
      ai_quality_score: 0.8,
      ai_framing_score: 0.8,
      ai_confidence: 0.8,
      ai_brand_safety: 'clear',
      ai_matched_brief_item_id: fromGap!.id,
      ai_provenance: 'mock',
      review_status: 'approved',
      is_published: true,
      confirmed_brief_item_id: fromGap!.id,
      is_hero: false,
      reject_reason_text: null,
      creator_facing_note: null,
      is_exemplar: false,
      exemplar_note: null,
      media_state: 'bytes_absent',
      derivative_state: 'ready',
      bytes_key: null,
      poster_key: null,
      sheet_key: '/seed/sheets/item-1.jpg',
      phash_primary: 'p-chain',
      frame_hashes: [],
      used_count: 0,
      download_count: 0,
      creator_credit: 'Chain Creator',
      usage_scope: 'organic_and_paid_social',
    })

    // Hop 5: close detection names the closing asset and the counts.
    const closures = await detectClosures(managerRepo)
    const closure = closures.find((entry) => entry.gapId === gapId)
    expect(closure).toBeDefined()
    expect(closure!.closingAssetIds).toContain(assetId)
    expect(closure!.after).toBeGreaterThan(closure!.before)

    const closedGap = await managerRepo.get<Gap>('gap', gapId)
    expect(closedGap!.status).toBe('closed')
    expect(closedGap!.closing_asset_ids).toContain(assetId)

    // The whole chain, replayed from ids alone.
    expect(fromGap!.origin_gap_id).toBe(gapId)
    const chainAsset = await managerRepo.get<Asset>('asset', assetId)
    expect(chainAsset!.confirmed_brief_item_id).toBe(fromGap!.id)
    expect(locked!.id).toBe(fromGap!.brief_id)
  })
})

describe('closure by human confirmation', () => {
  it('a gap closes when a manager confirms a published clip covers the item that gap produced', async () => {
    const repo = manager()

    // A gap whose cell nothing in the library matches, so facet matching alone
    // could never close it. Only the paper trail can.
    const facets = { room: 'exterior', shot_type: 'wide' }
    const gapId = await repo.create('gap', {
      gap_scan_id: null,
      branch_id: null,
      cell_signature: signatureOf(facets),
      facets,
      score: 0.9,
      severity: 'critical',
      status: 'open',
      signals: [{ source: 'editor_request', weight: 1, detail: 'exterior wide' }],
      closing_asset_ids: [],
    })

    const briefId = await repo.create('brief', {
      collab_id: 'collab-brief',
      status: 'locked',
      version: 1,
      locked_at: ctx.clock.now(),
      gap_scan_id: null,
      tech_specs_key: 'tech-v1',
      usage_terms_key: 'terms-v1',
      edited_fields: [],
    })
    const itemId = await repo.create('brief_item', {
      brief_id: briefId,
      seq: 1,
      instruction: 'wide of the exterior',
      shot_type: 'wide',
      room: 'exterior',
      min_takes: 1,
      origin_gap_id: gapId,
    })

    // A published clip a human confirmed against that item. Its AI room is
    // deliberately WRONG for the cell, so if this closes it closed on the
    // human's confirmation rather than on a tag.
    const assetId = await repo.create('asset', {
      kind: 'video',
      delivery_id: 'delivery-hero',
      collab_id: 'collab-brief',
      branch_id: 'branch-san-jose',
      filename: 'exterior-wide-01.mp4',
      bytes: 1000,
      duration_s: 6,
      coded_width: 1080,
      coded_height: 1920,
      rotation_deg: 0,
      codec_video: 'avc1',
      has_audio: false,
      captured_at: ctx.clock.now(),
      captured_at_source: 'mvhd',
      gps: null,
      client_decodable: true,
      needs_transcode: false,
      probe_result: null,
      preflight_version: 2,
      preflight: {},
      ai_description: 'a corridor, which is not the exterior',
      ai_shot_type: 'medium',
      ai_room: 'corridor',
      ai_subjects: [],
      ai_quality_score: 0.7,
      ai_framing_score: 0.7,
      ai_confidence: 0.7,
      ai_brand_safety: 'clear',
      ai_matched_brief_item_id: null,
      ai_provenance: 'mock',
      review_status: 'approved',
      is_published: true,
      confirmed_brief_item_id: itemId,
      creator_claimed_brief_item_id: itemId,
      is_hero: false,
      reject_reason_text: null,
      creator_facing_note: null,
      is_exemplar: false,
      exemplar_note: null,
      media_state: 'bytes_absent',
      derivative_state: 'ready',
      bytes_key: null,
      poster_key: null,
      sheet_key: '/seed/sheets/item-1.jpg',
      phash_primary: null,
      frame_hashes: [],
      used_count: 0,
      download_count: 0,
      creator_credit: 'Test Creator',
      usage_scope: null,
    })

    const closures = await detectClosures(repo)
    const closure = closures.find((entry) => entry.gapId === gapId)
    expect(closure).toBeDefined()
    expect(closure!.via).toBe('confirmed_brief_item')
    expect(closure!.closingAssetIds).toContain(assetId)

    const closed = await repo.get<Gap>('gap', gapId)
    expect(closed!.status).toBe('closed')
  })

  it('an unconfirmed clip against the same item does not close the gap', async () => {
    const repo = manager()
    const facets = { room: 'parking', shot_type: 'wide' }
    const gapId = await repo.create('gap', {
      gap_scan_id: null,
      branch_id: null,
      cell_signature: signatureOf(facets),
      facets,
      score: 0.5,
      severity: 'medium',
      status: 'open',
      signals: [{ source: 'editor_request', weight: 1 }],
      closing_asset_ids: [],
    })
    const briefId = await repo.create('brief', {
      collab_id: 'collab-brief',
      status: 'locked',
      version: 1,
      locked_at: ctx.clock.now(),
      gap_scan_id: null,
      tech_specs_key: 'tech-v1',
      usage_terms_key: 'terms-v1',
      edited_fields: [],
    })
    const itemId = await repo.create('brief_item', {
      brief_id: briefId,
      seq: 1,
      instruction: 'wide of the parking',
      shot_type: 'wide',
      room: 'parking',
      min_takes: 1,
      origin_gap_id: gapId,
    })
    // The model proposed the match and nobody confirmed it, and it is not
    // published either. A gap must not close on a proposal.
    await repo.create('asset', {
      kind: 'video',
      delivery_id: 'delivery-hero',
      collab_id: 'collab-brief',
      branch_id: 'branch-san-jose',
      filename: 'parking-maybe.mp4',
      bytes: 1000,
      duration_s: 6,
      coded_width: 1080,
      coded_height: 1920,
      rotation_deg: 0,
      codec_video: 'avc1',
      has_audio: false,
      captured_at: ctx.clock.now(),
      captured_at_source: 'mvhd',
      gps: null,
      client_decodable: true,
      needs_transcode: false,
      probe_result: null,
      preflight_version: 2,
      preflight: {},
      ai_description: null,
      ai_shot_type: null,
      ai_room: null,
      ai_subjects: [],
      ai_quality_score: null,
      ai_framing_score: null,
      ai_confidence: null,
      ai_brand_safety: null,
      ai_matched_brief_item_id: itemId,
      ai_provenance: 'none',
      review_status: 'pending',
      is_published: false,
      confirmed_brief_item_id: null,
      creator_claimed_brief_item_id: null,
      is_hero: false,
      reject_reason_text: null,
      creator_facing_note: null,
      is_exemplar: false,
      exemplar_note: null,
      media_state: 'bytes_absent',
      derivative_state: 'none',
      bytes_key: null,
      poster_key: null,
      sheet_key: null,
      phash_primary: null,
      frame_hashes: [],
      used_count: 0,
      download_count: 0,
      creator_credit: 'Test Creator',
      usage_scope: null,
    })

    await detectClosures(repo)
    const still = await repo.get<Gap>('gap', gapId)
    expect(still!.status).toBe('open')
  })
})

describe('detectClosures thresholds', () => {
  it('a coverage-target gap does not close below its target', async () => {
    const repo = manager()
    const facets = { room: 'studio', branch: 'branch-san-jose' }
    const gapId = await repo.create('gap', {
      gap_scan_id: null,
      branch_id: 'branch-san-jose',
      cell_signature: signatureOf(facets),
      facets,
      score: 0.5,
      severity: 'medium',
      status: 'open',
      signals: [{ source: 'coverage_target', weight: 0.3, detail: '1 of 6 target clips' }],
      closing_asset_ids: [],
    })
    // The seeded library may hold a couple of studio clips at this branch,
    // but nowhere near six.
    await detectClosures(repo)
    const gap = await repo.get<Gap>('gap', gapId)
    expect(gap!.status).toBe('open')
  })
})

describe('assetCoversCell', () => {
  const asset = {
    ai_room: 'sauna',
    ai_shot_type: 'wide',
    ai_subjects: ['towels'],
    branch_id: 'branch-san-jose',
  } as Asset

  it('requires every facet to hold', () => {
    expect(assetCoversCell(asset, { room: 'sauna', shot_type: 'wide' }, undefined)).toBe(true)
    expect(assetCoversCell(asset, { room: 'sauna', shot_type: 'macro' }, undefined)).toBe(false)
    expect(assetCoversCell(asset, { subject: 'towels' }, undefined)).toBe(true)
    expect(assetCoversCell(asset, { light: 'warm_light' }, new Set(['warm_light']))).toBe(true)
    expect(assetCoversCell(asset, { light: 'warm_light' }, new Set())).toBe(false)
    expect(assetCoversCell(asset, { branch: 'branch-palo-alto' }, undefined)).toBe(false)
  })
})
