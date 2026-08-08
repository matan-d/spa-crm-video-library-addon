import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { computeHealth } from '@/app/manager/health'
import { bootApp, repoForSession } from '@/app/bootstrap'
import { sessionForRole } from '@/app/session'
import type { AiRun, Asset } from '@/data/types'
import { testDeps } from './helpers'

function asset(over: Partial<Asset>): Asset {
  return {
    id: 'a1',
    sheet_key: '/seed/sheets/x.jpg',
    ai_description: null,
    ai_shot_type: null,
    ai_quality_score: null,
    ai_matched_brief_item_id: null,
    ai_provenance: 'none',
    review_status: 'approved',
    is_published: false,
    is_published_i: 0,
    is_exemplar: false,
    is_exemplar_i: 0,
    ...over,
  } as Asset
}

describe('computeHealth', () => {
  it('flags AI output on a sheetless clip as fabrication', () => {
    const { rows } = computeHealth({
      assets: [asset({ sheet_key: null, ai_description: 'invented', ai_provenance: 'mock' })],
      aiRuns: [],
      outboxDepth: 0,
    })
    const fabrication = rows.find((row) => row.id === 'no_fabrication')!
    expect(fabrication.status).toBe('fail')
    expect(fabrication.count).toBe(1)
  })

  it('flags a mock run that claims a model id', () => {
    const { rows } = computeHealth({
      assets: [],
      aiRuns: [{ id: 'r1', provider: 'mock', model_id: 'claude-x' } as AiRun],
      outboxDepth: 0,
    })
    expect(rows.find((row) => row.id === 'mock_never_claims_model')!.status).toBe('fail')
  })

  it('flags published work that never passed review', () => {
    const { rows } = computeHealth({
      assets: [asset({ is_published: true, is_published_i: 1, review_status: 'pending' })],
      aiRuns: [],
      outboxDepth: 0,
    })
    expect(rows.find((row) => row.id === 'published_implies_approved')!.status).toBe('fail')
  })

  it('flags a stale boolean mirror', () => {
    const { rows } = computeHealth({
      assets: [asset({ is_published: true, is_published_i: 0, review_status: 'approved' })],
      aiRuns: [],
      outboxDepth: 0,
    })
    expect(rows.find((row) => row.id === 'boolean_mirrors')!.status).toBe('fail')
  })

  it('counts runs per provider with all three providers always present', () => {
    const { providers } = computeHealth({
      assets: [],
      aiRuns: [
        { id: 'r1', provider: 'mock', model_id: null } as AiRun,
        { id: 'r2', provider: 'mock', model_id: null } as AiRun,
      ],
      outboxDepth: 0,
    })
    expect(providers).toEqual([
      { provider: 'live', count: 0 },
      { provider: 'replay', count: 0 },
      { provider: 'mock', count: 2 },
    ])
  })
})

describe('the seeded database passes its own audit', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
  })

  it('every invariant row passes on a fresh seed', async () => {
    const ctx = await bootApp(testDeps(factory))
    const repo = repoForSession(ctx, sessionForRole('manager'))
    const { rows } = computeHealth({
      assets: await repo.list<Asset>('asset'),
      aiRuns: await repo.list<AiRun>('ai_run'),
      outboxDepth: await repo.outboxDepth(),
    })
    for (const row of rows) {
      expect(row.status, `${row.id}: ${row.reason ?? ''}`).toBe('pass')
    }
  })
})
