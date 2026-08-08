/**
 * The `ai_run` writer, the enqueue guard, and the projection.
 *
 * Runs against fake-indexeddb through the real scoped repository, because the
 * invariants being asserted are only true if the write path is the real one: the
 * envelope, the boolean mirror on `is_current`, the outbox entry and the scope
 * check all come from that layer rather than from this file.
 *
 * The load-bearing case is the last block. A clip with no contact sheet must leave
 * no run row, no tag row, and every AI field null. If that ever passes silently,
 * the product's least detectable failure has shipped.
 */

import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertVisionEnqueueAllowed,
  buildMeta,
  createMockProvider,
  defaultSubject,
  mergeProvenance,
  MODEL_ID,
  planVisionEnqueue,
  PROVIDER_DETAIL,
  projectVisionTag,
  recordVisionTag,
  writeAiRun,
  writeAiRunFailure,
  type AiError,
  type AiMeta,
  type VisionTagOutput,
} from '@/ai'
import { noSleep } from '@/ai/sleep'
import { openDatabase } from '@/data/db'
import { createScopedRepo, type ScopedRepo } from '@/data/repo'
import { editorSession, managerSession, ScopeError } from '@/data/scope'
import type { AiRun, Tag } from '@/data/types'
import { SEED_EPOCH_MS, SeededClock } from '@/platform/clock'
import { createIdFactory } from '@/platform/id'
import { SEED_STRING, SeededRng } from '@/platform/rng'
import { visionInput } from './_inputs'

const ORG = 'org-astolia'

let db: IDBDatabase
let manager: ScopedRepo
let editor: ScopedRepo

function repoFor(session: Parameters<typeof createScopedRepo>[0]['session']): ScopedRepo {
  const clock = new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: 1 })
  const rng = new SeededRng(SEED_STRING)
  return createScopedRepo({
    db,
    session,
    now: () => clock.now(),
    newId: createIdFactory(clock, rng),
    deviceId: 'test-device',
  })
}

const PROMPT = { prompt_version: '1.0.0', prompt_hash: 'prompt-hash', effort: 'low' as const }

function mockMeta(overrides: Partial<AiMeta> = {}): AiMeta {
  return {
    ...buildMeta({
      kind: 'vision_tag',
      provider: 'mock',
      provider_detail: PROVIDER_DETAIL.authored,
      prompt: PROMPT,
      input_hash: 'input-hash',
      fixture: { id: 'vision.hands-back-oil-01', hash: 'sheet-sha' },
      latency_ms: 1_450,
    }),
    ...overrides,
  }
}

async function assetRow(overrides: Record<string, unknown> = {}): Promise<string> {
  return manager.create('asset', {
    id: 'asset-1',
    kind: 'video',
    delivery_id: 'delivery-1',
    collab_id: 'collab-1',
    branch_id: 'branch-san-jose',
    filename: 'clip.mp4',
    bytes: 400_000,
    duration_s: 6,
    sheet_key: '/seed/sheets/hands-back-oil-01.jpg',
    poster_key: '/seed/posters/hands-back-oil-01.jpg',
    derivative_state: 'ready',
    client_decodable: true,
    ai_description: null,
    ai_shot_type: null,
    ai_room: null,
    ai_subjects: [],
    ai_quality_score: null,
    ai_framing_score: null,
    ai_confidence: null,
    ai_brand_safety: null,
    ai_provenance: 'none',
    review_status: 'pending',
    is_published: false,
    is_exemplar: false,
    media_state: 'bytes_local',
    used_count: 0,
    download_count: 0,
    creator_credit: 'Maya Kessler (@maya.k)',
    ...overrides,
  })
}

beforeEach(async () => {
  const opened = await openDatabase('demo', new IDBFactory())
  db = opened.db
  manager = repoFor(managerSession({ org_id: ORG, user_id: 'user-manager' }))
  editor = repoFor(editorSession({ org_id: ORG, user_id: 'user-editor' }))
})

describe('writing a run', () => {
  it('writes the row through the repository, envelope and mirror included', async () => {
    const id = await writeAiRun(manager, {
      subject_type: 'asset',
      subject_id: 'asset-1',
      meta: mockMeta(),
      output_json: { description: 'two hands on a back' },
    })

    const row = (await manager.get<AiRun & { is_current_i: number }>('ai_run', id))!
    expect(row.provider).toBe('mock')
    expect(row.model_id).toBeNull()
    expect(row.simulated_model_id).toBe(MODEL_ID)
    expect(row.latency_source).toBe('simulated')
    expect(row.is_current).toBe(true)
    // IndexedDB cannot index a boolean, so the repository writes the mirror.
    expect(row.is_current_i).toBe(1)
    expect(row.org_id).toBe(ORG)
    expect(row.rev).toBe(1)
  })

  it('keeps output_json verbatim, so a run can be re-projected without a new call', async () => {
    const output = { description: 'x', tags: [{ term: 'hands', confidence: 0.94 }], nested: { kept: true } }
    const id = await writeAiRun(manager, {
      subject_type: 'asset',
      subject_id: 'asset-1',
      meta: mockMeta(),
      output_json: output,
    })
    const row = (await manager.get<AiRun>('ai_run', id))!
    expect(row.output_json).toEqual(output)
  })

  it('appends to the outbox, because a run is a synced row', async () => {
    const before = await manager.outboxDepth()
    await writeAiRun(manager, {
      subject_type: 'asset',
      subject_id: 'asset-1',
      meta: mockMeta(),
      output_json: {},
    })
    expect(await manager.outboxDepth()).toBe(before + 1)
  })

  it('supersedes the previous current run rather than mutating it', async () => {
    const first = await writeAiRun(manager, {
      subject_type: 'asset',
      subject_id: 'asset-1',
      meta: mockMeta(),
      output_json: { v: 1 },
    })
    const second = await writeAiRun(manager, {
      subject_type: 'asset',
      subject_id: 'asset-1',
      meta: mockMeta({ prompt_version: '1.1.0' }),
      output_json: { v: 2 },
    })

    const old = (await manager.get<AiRun>('ai_run', first))!
    const current = (await manager.get<AiRun>('ai_run', second))!
    expect(old.is_current).toBe(false)
    expect(old.superseded_by_run_id).toBe(second)
    // The old answer is still there, which is what lets somebody diff what the mock
    // predicted against what a real model produces on the same input.
    expect(old.output_json).toEqual({ v: 1 })
    expect(current.is_current).toBe(true)
  })

  it('leaves another subject alone when superseding', async () => {
    const other = await writeAiRun(manager, {
      subject_type: 'asset',
      subject_id: 'asset-2',
      meta: mockMeta(),
      output_json: {},
    })
    await writeAiRun(manager, { subject_type: 'asset', subject_id: 'asset-1', meta: mockMeta(), output_json: {} })
    await writeAiRun(manager, { subject_type: 'asset', subject_id: 'asset-1', meta: mockMeta(), output_json: {} })
    expect((await manager.get<AiRun>('ai_run', other))!.is_current).toBe(true)
  })

  it('refuses a mock run that names a model, at the write rather than only at construction', async () => {
    await expect(
      writeAiRun(manager, {
        subject_type: 'asset',
        subject_id: 'asset-1',
        meta: { ...mockMeta(), model_id: MODEL_ID },
        output_json: {},
      }),
    ).rejects.toThrow(/may never name a model/)

    // And nothing was written.
    expect(await manager.count('ai_run')).toBe(0)
  })

  it('refuses a live run with no model id', async () => {
    await expect(
      writeAiRun(manager, {
        subject_type: 'asset',
        subject_id: 'asset-1',
        meta: { ...mockMeta(), provider: 'live', model_id: null, simulated_model_id: null, model_key: MODEL_ID },
        output_json: {},
      }),
    ).rejects.toThrow(/must record which one/)
  })

  it('cannot be written by an editor session at all', async () => {
    await expect(
      writeAiRun(editor, {
        subject_type: 'asset',
        subject_id: 'asset-1',
        meta: mockMeta(),
        output_json: {},
      }),
    ).rejects.toBeInstanceOf(ScopeError)
  })

  it('writes a failed run, because a refusal has to survive a reload', async () => {
    const provider = createMockProvider({ sleep: noSleep })
    let error: AiError | null = null
    try {
      await provider.vision_tag(visionInput({ asset_id: 'asset-hero-7' }))
    } catch (thrown) {
      error = thrown as AiError
    }
    expect(error).not.toBeNull()

    const id = await writeAiRunFailure(manager, {
      subject_type: 'asset',
      subject_id: 'asset-hero-7',
      error: error!,
    })
    expect(id).not.toBeNull()

    const row = (await manager.get<AiRun>('ai_run', id!))!
    expect(row.status).toBe('error')
    expect(row.error_code).toBe('invalid_output')
    expect(row.schema_valid).toBe(false)
    expect(row.model_id).toBeNull()
    // The malformed payload survives, so the failure is inspectable later.
    expect((row.output_json as { light: string }).light).toBe('soft_indoor')
  })

  it('writes nothing when the error carries no usable metadata', async () => {
    const bare = { reason: 'network', meta: {}, rawOutput: undefined } as unknown as AiError
    expect(
      await writeAiRunFailure(manager, { subject_type: 'asset', subject_id: 'asset-1', error: bare }),
    ).toBeNull()
    expect(await manager.count('ai_run')).toBe(0)
  })
})

describe('the enqueue guard', () => {
  it('refuses vision tagging for an asset with no sheet', () => {
    expect(() => assertVisionEnqueueAllowed({ id: 'asset-hevc', sheet_key: null })).toThrow(/no contact sheet/)
    expect(() => assertVisionEnqueueAllowed({ id: 'asset-hevc', sheet_key: '  ' })).toThrow(/no contact sheet/)
  })

  it('allows one with a sheet', () => {
    expect(() => assertVisionEnqueueAllowed({ id: 'asset-1', sheet_key: '/seed/sheets/a.jpg' })).not.toThrow()
  })

  it('names the codec in the refusal, so a human is told which stage failed', () => {
    expect(() =>
      assertVisionEnqueueAllowed({ id: 'a', sheet_key: null, codec_video: 'hvc1', client_decodable: false }),
    ).toThrow(/hvc1/)
  })

  it('splits a batch into what can be tagged and what cannot, with a reason each', () => {
    const plan = planVisionEnqueue([
      { id: 'ok-1', sheet_key: '/seed/sheets/a.jpg' },
      { id: 'hevc', sheet_key: null, codec_video: 'hvc1', client_decodable: false, derivative_state: 'none' },
      { id: 'pending', sheet_key: null, derivative_state: 'partial' },
    ])
    expect(plan.enqueue.map((a) => a.id)).toEqual(['ok-1'])
    expect(plan.refused.map((r) => r.asset_id)).toEqual(['hevc', 'pending'])
    expect(plan.refused[0]!.reason).toBe('no_sheet')
    expect(plan.refused[0]!.explanation).toMatch(/hvc1/)
    expect(plan.refused[1]!.reason).toBe('no_derivatives')
  })
})

describe('a clip with no contact sheet leaves no trace of an attempt', () => {
  it('writes no run, no tags, and no AI fields', async () => {
    await assetRow({ id: 'asset-1', sheet_key: null, codec_video: 'hvc1', client_decodable: false })
    const asset = (await manager.get<Record<string, unknown>>('asset', 'asset-1'))!

    await expect(
      recordVisionTag(manager, {
        asset: { id: 'asset-1', sheet_key: null, codec_video: 'hvc1', client_decodable: false },
        output: {} as VisionTagOutput,
        meta: mockMeta(),
      }),
    ).rejects.toMatchObject({ reason: 'no_stills' })

    expect(await manager.count('ai_run')).toBe(0)
    expect(await manager.count('tag')).toBe(0)

    const after = (await manager.get<Record<string, unknown>>('asset', 'asset-1'))!
    expect(after.ai_description).toBeNull()
    expect(after.ai_shot_type).toBeNull()
    expect(after.ai_confidence).toBeNull()
    expect(after.ai_provenance).toBe('none')
    // Untouched, not reset: the guard ran before anything was written.
    expect(after.updated_at).toBe(asset.updated_at)
  })
})

describe('the vision projection', () => {
  it('writes the run, patches only the AI band, and tags every term with its run id', async () => {
    await assetRow()
    const provider = createMockProvider({ sleep: noSleep })
    const result = await provider.vision_tag(visionInput({ asset_id: 'asset-lib-1' }))

    const { run_id } = await recordVisionTag(manager, {
      asset: { id: 'asset-1', sheet_key: '/seed/sheets/hands-back-oil-01.jpg', ai_provenance: 'none' },
      output: result.output,
      meta: result.meta,
    })

    const asset = (await manager.get<Record<string, unknown>>('asset', 'asset-1'))!
    expect(asset.ai_description).toBe(result.output.description)
    expect(asset.ai_shot_type).toBe('closeup')
    expect(asset.ai_room).toBe('treatment_room')
    expect(asset.ai_subjects).toEqual(['hands', 'client'])
    expect(asset.ai_provenance).toBe('mock')
    // Band one and band four are not this layer's business.
    expect(asset.filename).toBe('clip.mp4')
    expect(asset.review_status).toBe('pending')
    expect(asset.is_published).toBe(false)

    const tags = await manager.list<Tag>('tag', { index: 'by_asset', key: 'asset-1' })
    expect(tags.length).toBe(result.output.tags.length)
    for (const tag of tags) {
      expect(tag.source).toBe('ai')
      expect(tag.ai_run_id).toBe(run_id)
      expect(tag.rejected_by_human).toBe(false)
      expect(tag.removed_at).toBeNull()
    }
    // Which is what makes a mock purge one cursor rather than "delete this asset's tags".
    const byRun = await manager.list<Tag>('tag', { index: 'by_ai_run', key: run_id })
    expect(byRun.length).toBe(tags.length)
  })

  it('encodes quality as one of three fixed numbers, never a score the model produced', () => {
    const projection = projectVisionTag({
      asset_id: 'asset-1',
      run_id: 'run-1',
      output: baseOutput({ framing: 'poor', light_quality: 'usable' }),
      meta: mockMeta(),
    })
    expect(projection.asset_patch.ai_framing_score).toBe(0.3)
    expect(projection.asset_patch.ai_quality_score).toBe(0.55)
  })

  it('never writes blocked, because only a human blocks a clip', () => {
    const flagged = projectVisionTag({
      asset_id: 'asset-1',
      run_id: 'run-1',
      output: baseOutput({ review_flags: [{ flag: 'text_on_screen', note: 'a sign' }], text_on_screen: true }),
      meta: mockMeta(),
    })
    expect(flagged.asset_patch.ai_brand_safety).toBe('review')

    const clean = projectVisionTag({
      asset_id: 'asset-1',
      run_id: 'run-1',
      output: baseOutput(),
      meta: mockMeta(),
    })
    expect(clean.asset_patch.ai_brand_safety).toBe('clear')
  })

  it('drops a tag term that is no longer in the taxonomy and says so', () => {
    const projection = projectVisionTag({
      asset_id: 'asset-1',
      run_id: 'run-1',
      output: baseOutput({
        tags: [
          { term: 'hands', confidence: 0.9 },
          { term: 'soft_indoor', confidence: 0.8 },
        ],
      }),
      meta: mockMeta(),
    })
    expect(projection.tags.map((t) => t.term)).toEqual(['hands'])
    expect(projection.notes.map((n) => n.code)).toContain('tag_outside_taxonomy_dropped')
  })

  it('turns two providers on one asset into mixed, which is the case the badge exists for', () => {
    expect(mergeProvenance(null, 'mock')).toBe('mock')
    expect(mergeProvenance('none', 'mock')).toBe('mock')
    expect(mergeProvenance('mock', 'mock')).toBe('mock')
    expect(mergeProvenance('mock', 'live')).toBe('mixed')
    expect(mergeProvenance('mixed', 'live')).toBe('mixed')
  })
})

describe('the run subject', () => {
  it('names a real row for every kind that has one', () => {
    expect(defaultSubject('vet', { creator_id: 'creator-1' })).toEqual({
      subject_type: 'creator',
      subject_id: 'creator-1',
    })
    expect(defaultSubject('vision_tag', { asset_id: 'asset-1' }).subject_type).toBe('asset')
    expect(defaultSubject('brief_match', { brief_item_id: 'item-1' }).subject_type).toBe('brief_item')
    expect(defaultSubject('gap_scan', { gap_scan_id: 'scan-1' }).subject_type).toBe('gap_scan')
    expect(defaultSubject('nudge_draft', { collab_id: 'collab-1' }).subject_type).toBe('collab')
    expect(defaultSubject('brief_gen', { brief_id: 'brief-1' }).subject_type).toBe('brief')
  })

  it('uses the input hash for a query, because a query is not a row in this schema', () => {
    expect(defaultSubject('search_parse', { input_hash: 'abc' })).toEqual({
      subject_type: 'query',
      subject_id: 'abc',
    })
  })

  it('refuses to invent an id it was not given', () => {
    expect(() => defaultSubject('vet', {})).toThrow(/creator_id is required/)
  })
})

/** A minimal valid vision output, so a projection test can vary one field. */
function baseOutput(overrides: Partial<VisionTagOutput> = {}): VisionTagOutput {
  return {
    description: 'two hands on a back',
    shot_type: 'closeup',
    room: 'treatment_room',
    subjects: ['hands'],
    light: 'warm_light',
    vibe: 'calm',
    tags: [{ term: 'hands', confidence: 0.9 }],
    framing: 'good',
    framing_reason: null,
    light_quality: 'good',
    light_reason: null,
    review_flags: [],
    text_on_screen: false,
    frames_seen: 5,
    overall_confidence: 0.7,
    uncertainty: null,
    ...overrides,
  }
}
