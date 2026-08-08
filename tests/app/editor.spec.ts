import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  deriveFacets,
  gapFacetsFrom,
  parseQuery,
  runSearch,
  tagIndex,
  type VocabularyEntry,
} from '@/app/editor/search'
import { bootApp, repoForSession } from '@/app/bootstrap'
import { sessionForRole } from '@/app/session'
import { signatureOf } from '@/data/seed'
import type { Asset, Gap, Tag } from '@/data/types'
import { testDeps } from './helpers'

// ---------------------------------------------------------------------------
// unit: the deterministic pre-model search
// ---------------------------------------------------------------------------

const VOCAB: VocabularyEntry[] = [
  { term: 'hands', kind: 'subject', status: 'active' },
  { term: 'oil', kind: 'subject', status: 'active' },
  { term: 'warm_light', kind: 'light', status: 'active' },
  { term: 'calm', kind: 'vibe', status: 'active' },
  { term: 'closeup', kind: 'shot', status: 'active' },
  { term: 'retired_term', kind: 'subject', status: 'retired' },
]

const ROOMS = new Set(['sauna', 'treatment_room'])

function makeAsset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    coded_width: 1080,
    coded_height: 1920,
    rotation_deg: 0,
    ai_room: null,
    ai_shot_type: null,
    ai_subjects: [],
    ai_quality_score: 0,
    ...over,
  } as Asset
}

function makeTag(assetId: string, term: string, over: Partial<Tag> = {}): Tag {
  return {
    id: `tag-${assetId}-${term}`,
    asset_id: assetId,
    term,
    source: 'ai',
    confidence: 0.8,
    ai_run_id: null,
    removed_at: null,
    rejected_by_human: false,
    ...over,
  } as Tag
}

describe('parseQuery', () => {
  it('maps a two-word phrase to its underscore vocabulary term first', () => {
    const parsed = parseQuery('warm light hands', VOCAB, ROOMS)
    expect(parsed.mapped.map((t) => t.term)).toEqual(['warm_light', 'hands'])
    expect(parsed.unmapped).toEqual([])
  })

  it('surfaces an unknown word as unmapped rather than dropping it', () => {
    const parsed = parseQuery('golden hour hands', VOCAB, ROOMS)
    expect(parsed.mapped.map((t) => t.term)).toEqual(['hands'])
    expect(parsed.unmapped).toEqual(['golden', 'hour'])
  })

  it('maps a known room even though rooms are not vocabulary', () => {
    const parsed = parseQuery('sauna closeup', VOCAB, ROOMS)
    expect(parsed.mapped).toEqual([
      { raw: 'sauna', term: 'sauna', kind: 'room' },
      { raw: 'closeup', term: 'closeup', kind: 'shot' },
    ])
  })

  it('ignores retired vocabulary terms', () => {
    const parsed = parseQuery('retired_term', VOCAB, ROOMS)
    expect(parsed.mapped).toEqual([])
    expect(parsed.unmapped).toEqual(['retired_term'])
  })
})

describe('runSearch', () => {
  const assets = [
    makeAsset('a1', { ai_room: 'sauna', ai_shot_type: 'closeup', ai_quality_score: 3 }),
    makeAsset('a2', { ai_room: 'treatment_room', ai_shot_type: 'wide', ai_quality_score: 9 }),
    makeAsset('a3', { ai_room: 'sauna', ai_shot_type: 'wide', ai_quality_score: 5 }),
  ]
  const tags = [
    makeTag('a1', 'hands'),
    makeTag('a2', 'hands', { source: 'human', confidence: null }),
    makeTag('a3', 'warm_light'),
    makeTag('a3', 'hands', { removed_at: 123 }),
  ]

  it('an unmapped term never filters: a vocabulary gap is not a content gap', () => {
    const outcome = runSearch({
      text: 'hands doric-column',
      assets,
      tags,
      vocabulary: VOCAB,
      refinements: new Map(),
    })
    // 'doric-column' maps to nothing; 'hands' matches a1 (tag) and a2 (human tag).
    expect(outcome.parsed.unmapped).toContain('doric')
    expect(outcome.results.map((r) => r.asset.id).sort()).toEqual(['a1', 'a2'])
  })

  it('a removed tag no longer matches', () => {
    const outcome = runSearch({
      text: 'hands',
      assets: [assets[2]!],
      tags,
      vocabulary: VOCAB,
      refinements: new Map(),
    })
    expect(outcome.results).toEqual([])
  })

  it('ranking is deterministic and human confirmation outranks quality alone', () => {
    const outcome = runSearch({
      text: 'hands',
      assets,
      tags,
      vocabulary: VOCAB,
      refinements: new Map(),
    })
    // a2: match 10 + human 5 + quality 9 = 24. a1: match 10 + quality 3 = 13.
    expect(outcome.results.map((r) => r.asset.id)).toEqual(['a2', 'a1'])
    expect(outcome.results.map((r) => r.rank)).toEqual([1, 2])
    const again = runSearch({
      text: 'hands',
      assets,
      tags,
      vocabulary: VOCAB,
      refinements: new Map(),
    })
    expect(again.results).toEqual(outcome.results)
  })

  it('facets are derived from results with counts, never from the whole taxonomy', () => {
    const outcome = runSearch({
      text: '',
      assets,
      tags,
      vocabulary: VOCAB,
      refinements: new Map(),
    })
    const rooms = outcome.facets.filter((f) => f.facet === 'room')
    expect(rooms).toEqual([
      { facet: 'room', value: 'sauna', count: 2 },
      { facet: 'room', value: 'treatment_room', count: 1 },
    ])
  })

  it('the ladder names the dropped term and produces near matches', () => {
    const outcome = runSearch({
      text: 'treatment_room warm_light',
      assets,
      tags,
      vocabulary: VOCAB,
      refinements: new Map(),
    })
    expect(outcome.results).toEqual([])
    expect(outcome.relaxed).not.toBeNull()
    // Dropping warm_light (the later term) leaves treatment_room, which matches a2.
    expect(outcome.relaxed!.dropped.term).toBe('warm_light')
    expect(outcome.relaxed!.results.map((r) => r.asset.id)).toEqual(['a2'])
  })

  it('refinement chips filter results', () => {
    const outcome = runSearch({
      text: '',
      assets,
      tags,
      vocabulary: VOCAB,
      refinements: new Map([['room', 'sauna']]),
    })
    expect(outcome.results.map((r) => r.asset.id).sort()).toEqual(['a1', 'a3'])
  })
})

describe('gapFacetsFrom', () => {
  it('builds the cell from mapped terms only, first term per kind wins', () => {
    const parsed = parseQuery('sauna warm light hands oil', VOCAB, ROOMS)
    const facets = gapFacetsFrom(parsed.mapped)
    expect(facets).toEqual({ room: 'sauna', light: 'warm_light', subject: 'hands' })
  })
})

describe('tagIndex and deriveFacets', () => {
  it('excludes removed and rejected tags from the index', () => {
    const index = tagIndex([
      makeTag('a1', 'hands'),
      makeTag('a1', 'oil', { removed_at: 5 }),
      makeTag('a1', 'calm', { rejected_by_human: true }),
    ])
    expect([...index.get('a1')!]).toEqual(['hands'])
  })

  it('derives light and vibe facets from live tags', () => {
    const assets = [makeAsset('a1')]
    const index = tagIndex([makeTag('a1', 'warm_light'), makeTag('a1', 'calm')])
    const facets = deriveFacets(
      assets.map((asset, i) => ({ asset, rank: i + 1, score: 0 })),
      index,
      VOCAB,
    )
    expect(facets.some((f) => f.facet === 'light' && f.value === 'warm_light')).toBe(true)
    expect(facets.some((f) => f.facet === 'vibe' && f.value === 'calm')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// integration: the writes the surface performs, against the seeded database
// ---------------------------------------------------------------------------




describe('the editor surface writes', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
    setActivePinia(createPinia())
  })

  it('a requested shot writes a gap row an editor may write and a manager can read back', async () => {
    const ctx = await bootApp(testDeps(factory))
    const editor = repoForSession(ctx, sessionForRole('editor'))

    const facets = { room: 'reception', shot: 'wide' }
    const gapId = await editor.create('gap', {
      gap_scan_id: null,
      branch_id: null,
      cell_signature: signatureOf(facets),
      facets,
      score: 0,
      severity: 'medium',
      status: 'open',
      signals: [{ source: 'editor_request', weight: 1, detail: 'reception wide' }],
      closing_asset_ids: [],
    })

    const manager = repoForSession(ctx, sessionForRole('manager'))
    const row = await manager.get<Gap>('gap', gapId)
    expect(row).toBeDefined()
    expect(row!.cell_signature).toBe(signatureOf(facets))
    expect(row!.signals[0]!.source).toBe('editor_request')
    expect(row!.gap_scan_id).toBeNull()
  })

  it('a usage event records the rank at the moment of the event', async () => {
    const ctx = await bootApp(testDeps(factory))
    const editor = repoForSession(ctx, sessionForRole('editor'))
    const [first] = await editor.list<Asset>('asset', { limit: 1 })
    expect(first).toBeDefined()

    const id = await editor.create('usage_event', {
      asset_id: first!.id,
      user_id: 'user-editor',
      kind: 'confirmed_use',
      rank_at_event: 4,
      query_id: null,
      dwell_ms: null,
    })
    const row = await editor.get<{ rank_at_event: number; kind: string }>('usage_event', id)
    expect(row!.rank_at_event).toBe(4)
    expect(row!.kind).toBe('confirmed_use')
  })

  it('the search query log records outcome and count, and the write goes to the outbox', async () => {
    const ctx = await bootApp(testDeps(factory))
    const editor = repoForSession(ctx, sessionForRole('editor'))
    const before = await editor.outboxDepth()

    await editor.create('search_query_log', {
      user_id: 'user-editor',
      text: 'exterior arrival wide',
      tokens: ['exterior', 'arrival', 'wide'],
      outcome: 'zero_results',
      result_count: 0,
      clicked_ranks: [],
      refined_from_query_id: null,
    })

    expect(await editor.outboxDepth()).toBe(before + 1)
  })

  it('the seeded vocabulary really maps the demo phrases the surface depends on', async () => {
    const ctx = await bootApp(testDeps(factory))
    const editor = repoForSession(ctx, sessionForRole('editor'))
    const vocabulary = await editor.list<VocabularyEntry>('tag_vocabulary')
    const assets = await editor.list<Asset>('asset')
    const rooms = new Set(assets.map((a) => a.ai_room).filter((r): r is string => !!r))

    const parsed = parseQuery('hands warm light', vocabulary, rooms)
    expect(parsed.mapped.map((t) => t.term)).toEqual(['hands', 'warm_light'])
    expect(parsed.unmapped).toEqual([])

    // The seeded zero-result phrase stays unmapped: that is the vocabulary gap
    // the AI parser is later allowed to bridge, and the seed depends on it.
    const zero = parseQuery('golden hour window', vocabulary, rooms)
    expect(zero.mapped.filter((t) => t.kind !== 'room')).toEqual([])
  })
})
