/**
 * The replay reader, and the proof that nothing has been laundered into it.
 *
 * Two claims are being defended here.
 *
 * The first is an honesty claim: the shipped bundle is empty. There was no capture
 * run in this build, so there is nothing real to replay, and an empty bundle is how
 * that is said in code rather than in a comment. If an authored answer were ever
 * moved in here it would arrive with `provider: 'replay'` and `model_id` set, which
 * would be a forged provenance record, so the emptiness is asserted.
 *
 * The second is a mechanical claim: replay is the response cache pre-seeded, not a
 * separate code path. It is keyed by `(input_hash, prompt_hash, model_key)` built
 * from the same helpers, and replaying the same fixture twice reproduces byte
 * identical output and byte identical projections.
 */

import { describe, expect, it } from 'vitest'
import {
  captureFixture,
  createMockProvider,
  createReplayProvider,
  EMPTY_REPLAY_BUNDLE,
  MODEL_ID,
  modelKeyFor,
  cacheKeyString,
  projectVisionTag,
  promptHash,
  PROVIDER_DETAIL,
  SIMULATED_MODEL_ID,
  type AiError,
  type AiMeta,
  type ReplayFixture,
} from '@/ai'
import { noSleep } from '@/ai/sleep'
import { canonicalJson, hashOf } from '@/platform/hash'
import { searchInput, visionInput } from './_inputs'

const CAPTURED_AT = '2026-08-01T09:10:00.000Z'

async function replayFixtureFor(assetId = 'asset-lib-1'): Promise<{ fixture: ReplayFixture; output: unknown }> {
  const input = visionInput({ asset_id: assetId })
  const mock = await createMockProvider({ sleep: noSleep }).vision_tag(input)
  return {
    output: mock.output,
    fixture: {
      id: `replay.vision.${assetId}`,
      kind: 'vision_tag',
      input_hash: await hashOf(input),
      prompt_hash: await promptHash('vision_tag'),
      // The live model key, because a replayed response really did come from a model.
      model_key: modelKeyFor('replay'),
      model_id: MODEL_ID,
      prompt_version: '1.0.0',
      captured_at: CAPTURED_AT,
      latency_ms: 1_842,
      output_json: mock.output,
    },
  }
}

describe('the shipped bundle', () => {
  it('is empty, because no model has been called in this build', () => {
    expect(EMPTY_REPLAY_BUNDLE.fixtures).toHaveLength(0)
    expect(EMPTY_REPLAY_BUNDLE.captured_with).toMatch(/No capture run/)
  })

  it('fails every capability with fixture_missing rather than inventing an answer', async () => {
    const ai = createReplayProvider({ sleep: noSleep })
    expect(ai.size).toBe(0)
    const vision = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(vision.reason).toBe('fixture_missing')
    expect(vision.retryable).toBe(false)
    const search = (await ai.search_parse(searchInput()).catch((e: unknown) => e)) as AiError
    expect(search.reason).toBe('fixture_missing')
  })

  it('names the cache key it looked for, so a missing capture is diagnosable', async () => {
    const ai = createReplayProvider({ sleep: noSleep })
    const input = visionInput()
    const error = (await ai.vision_tag(input).catch((e: unknown) => e)) as AiError
    const expected = cacheKeyString({
      input_hash: await hashOf(input),
      prompt_hash: await promptHash('vision_tag'),
      model_key: modelKeyFor('replay'),
    })
    expect(error.message).toContain(expected)
  })

  it('still refuses a clip with no stills, because that is a contract rule and not a mock behaviour', async () => {
    const ai = createReplayProvider({ sleep: noSleep })
    await expect(ai.vision_tag(visionInput({ sheet_base64: '' }))).rejects.toMatchObject({ reason: 'no_stills' })
  })
})

describe('reading a fixture', () => {
  it('is keyed exactly the way the response cache is keyed', async () => {
    const { fixture } = await replayFixtureFor()
    const ai = createReplayProvider({ sleep: noSleep, bundle: { bundle_version: 1, captured_with: 'test', fixtures: [fixture] } })
    const result = await ai.vision_tag(visionInput())
    expect(result.meta.input_hash).toBe(fixture.input_hash)
    expect(result.meta.prompt_hash).toBe(fixture.prompt_hash)
    expect(result.meta.model_key).toBe(fixture.model_key)
  })

  it('records the model, the fixture and a simulated latency', async () => {
    const { fixture } = await replayFixtureFor()
    const ai = createReplayProvider({ sleep: noSleep, bundle: { bundle_version: 1, captured_with: 'test', fixtures: [fixture] } })
    const result = await ai.vision_tag(visionInput())
    expect(result.meta.provider).toBe('replay')
    expect(result.meta.provider_detail).toBe(PROVIDER_DETAIL.replay)
    expect(result.meta.model_id).toBe(MODEL_ID)
    expect(result.meta.simulated_model_id).toBeNull()
    expect(result.meta.fixture_id).toBe(fixture.id)
    // Measured once, at capture time. Replaying it does not measure anything.
    expect(result.meta.latency_ms).toBe(1_842)
    expect(result.meta.latency_source).toBe('simulated')
  })

  it('reproduces byte identical output and byte identical projections', async () => {
    const { fixture } = await replayFixtureFor()
    const bundle = { bundle_version: 1, captured_with: 'test', fixtures: [fixture] }
    const first = await createReplayProvider({ sleep: noSleep, bundle }).vision_tag(visionInput())
    const second = await createReplayProvider({ sleep: noSleep, bundle }).vision_tag(visionInput())

    expect(canonicalJson(second.output)).toBe(canonicalJson(first.output))
    expect(canonicalJson(second.meta)).toBe(canonicalJson(first.meta))

    const projectionOf = (meta: AiMeta, output: typeof first.output) =>
      canonicalJson(
        projectVisionTag({ asset_id: 'asset-1', run_id: 'run-fixed', output, meta, previous_provenance: 'none' })
          .asset_patch,
      )
    expect(projectionOf(second.meta, second.output)).toBe(projectionOf(first.meta, first.output))
  })

  it('projects identically to the mock except for provenance, which must differ', async () => {
    // The badge reads `asset.ai_provenance`, never the current mode, so the one field
    // that has to change between two providers serving the same bytes is that one.
    const input = visionInput()
    const mock = await createMockProvider({ sleep: noSleep }).vision_tag(input)
    const { fixture } = await replayFixtureFor()
    const replay = await createReplayProvider({
      sleep: noSleep,
      bundle: { bundle_version: 1, captured_with: 'test', fixtures: [fixture] },
    }).vision_tag(input)

    const patchFor = (meta: AiMeta, output: typeof mock.output) =>
      projectVisionTag({ asset_id: 'asset-1', run_id: 'run-fixed', output, meta, previous_provenance: 'none' })
        .asset_patch

    const mockPatch = patchFor(mock.meta, mock.output)
    const replayPatch = patchFor(replay.meta, replay.output)

    expect(mockPatch.ai_provenance).toBe('mock')
    expect(replayPatch.ai_provenance).toBe('replay')
    expect(canonicalJson({ ...mockPatch, ai_provenance: null })).toBe(
      canonicalJson({ ...replayPatch, ai_provenance: null }),
    )
  })

  it('refuses a fixture that was never captured from a model', async () => {
    const { fixture } = await replayFixtureFor()
    // A mock keyed entry inside a replay bundle is an authored answer wearing a
    // captured answer's provenance. That is the exact lie this layer exists to stop.
    const forged: ReplayFixture = { ...fixture, model_key: `simulated:${SIMULATED_MODEL_ID}` }
    const ai = createReplayProvider({
      sleep: noSleep,
      bundle: { bundle_version: 1, captured_with: 'forged', fixtures: [forged] },
    })
    // It cannot even be found, because the lookup uses the live model key.
    await expect(ai.vision_tag(visionInput())).rejects.toMatchObject({ reason: 'fixture_missing' })
  })

  it('refuses a fixture whose output no longer validates', async () => {
    const { fixture } = await replayFixtureFor()
    const stale: ReplayFixture = {
      ...fixture,
      output_json: { ...(fixture.output_json as Record<string, unknown>), light: 'soft_indoor' },
    }
    const error = (await createReplayProvider({
      sleep: noSleep,
      bundle: { bundle_version: 1, captured_with: 'stale', fixtures: [stale] },
    })
      .vision_tag(visionInput())
      .catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('invalid_output')
    expect(error.message).toContain(fixture.id)
    expect(error.meta.schema_valid).toBe(false)
    // The captured bytes survive on the error, so a stale capture is inspectable.
    expect(error.rawOutput).toBeDefined()
  })
})

describe('capture, which is how a bundle would be produced', () => {
  it('refuses to turn a mock run into a captured fixture', async () => {
    const mock = await createMockProvider({ sleep: noSleep }).vision_tag(visionInput())
    expect(() =>
      captureFixture({ id: 'x', meta: mock.meta, output_json: mock.output, captured_at: CAPTURED_AT }),
    ).toThrow(/only a live run/)
  })

  it('refuses to capture a failed run', async () => {
    const mock = await createMockProvider({ sleep: noSleep }).vision_tag(visionInput())
    const meta: AiMeta = {
      ...mock.meta,
      provider: 'live',
      model_id: MODEL_ID,
      simulated_model_id: null,
      status: 'error',
      schema_valid: false,
    }
    expect(() => captureFixture({ id: 'x', meta, output_json: {}, captured_at: CAPTURED_AT })).toThrow(
      /failed or invalid/,
    )
  })

  it('carries the cache key through unchanged, so a capture is findable by the reader', async () => {
    const mock = await createMockProvider({ sleep: noSleep }).vision_tag(visionInput())
    const meta: AiMeta = {
      ...mock.meta,
      provider: 'live',
      provider_detail: PROVIDER_DETAIL.live,
      model_id: MODEL_ID,
      simulated_model_id: null,
      model_key: MODEL_ID,
      latency_source: 'measured',
      latency_ms: 2_100,
      fixture_id: null,
      fixture_hash: null,
    }
    const fixture = captureFixture({ id: 'replay.1', meta, output_json: mock.output, captured_at: CAPTURED_AT })
    expect(fixture.input_hash).toBe(meta.input_hash)
    expect(fixture.prompt_hash).toBe(meta.prompt_hash)
    expect(fixture.model_key).toBe(MODEL_ID)
    expect(fixture.latency_ms).toBe(2_100)

    const ai = createReplayProvider({
      sleep: noSleep,
      bundle: { bundle_version: 1, captured_with: 'round trip', fixtures: [fixture] },
    })
    await expect(ai.vision_tag(visionInput())).resolves.toBeDefined()
  })
})
