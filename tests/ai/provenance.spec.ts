/**
 * Provenance, which is the invariant the whole AI layer is built around.
 *
 * The claim being defended: a mock run can never assert that a model produced it.
 * The architecture review asks for that to be a constraint rather than a
 * convention, enforced in two places (a database check and a local write guard), so
 * this suite asserts both halves of the local one: at construction, where a caller
 * cannot even express the lie, and at validation, where a hand-built row is
 * refused.
 */

import { describe, expect, it } from 'vitest'
import {
  assertProvenance,
  AiProvenanceError,
  buildMeta,
  modelKeyFor,
  MODEL_ID,
  PROVIDER_DETAIL,
  provenanceViolations,
  simulatedLatencyMs,
  SIMULATED_MODEL_ID,
  type AiMeta,
} from '@/ai'

const PROMPT = { prompt_version: '1.0.0', prompt_hash: 'ph', effort: 'low' as const }

function metaFor(provider: AiMeta['provider']): AiMeta {
  return buildMeta({
    kind: 'vision_tag',
    provider,
    provider_detail:
      provider === 'mock'
        ? PROVIDER_DETAIL.authored
        : provider === 'replay'
          ? PROVIDER_DETAIL.replay
          : PROVIDER_DETAIL.live,
    prompt: PROMPT,
    input_hash: 'ih',
    fixture: provider === 'live' ? null : { id: 'fix-1', hash: null },
    latency_ms: 100,
  })
}

describe('buildMeta makes the dishonest state unrepresentable', () => {
  it('never lets a mock run carry a model id', () => {
    const meta = metaFor('mock')
    expect(meta.model_id).toBeNull()
    expect(meta.simulated_model_id).toBe(SIMULATED_MODEL_ID)
  })

  it('records the model on a replayed run, because a captured response really came from one', () => {
    const meta = metaFor('replay')
    expect(meta.model_id).toBe(MODEL_ID)
    expect(meta.simulated_model_id).toBeNull()
    expect(meta.fixture_id).toBe('fix-1')
  })

  it('marks only a live call as measured, so simulated delays never reach a performance number', () => {
    expect(metaFor('live').latency_source).toBe('measured')
    expect(metaFor('mock').latency_source).toBe('simulated')
    expect(metaFor('replay').latency_source).toBe('simulated')
  })

  it('keys the cache differently for mock, so a synthetic answer cannot serve a real request', () => {
    expect(metaFor('mock').model_key).toBe(`simulated:${SIMULATED_MODEL_ID}`)
    expect(metaFor('live').model_key).toBe(MODEL_ID)
    expect(modelKeyFor('mock')).not.toBe(modelKeyFor('live'))
  })

  it('carries the schema identity, which is the whole claim that mock is not a fork', () => {
    const meta = metaFor('mock')
    expect(meta.schema_key).toBe('vision_tag')
    expect(meta.schema_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(meta.schema_valid).toBe(true)
  })
})

describe('the write guard refuses a row that lies', () => {
  it('refuses a mock run that names a model', () => {
    const meta = { ...metaFor('mock'), model_id: MODEL_ID }
    expect(() => assertProvenance(meta)).toThrow(AiProvenanceError)
    expect(provenanceViolations(meta).map((v) => v.field)).toContain('model_id')
  })

  it('refuses a mock run with no simulated model, because the badge would have nothing to name', () => {
    const meta = { ...metaFor('mock'), simulated_model_id: null }
    expect(() => assertProvenance(meta)).toThrow(/simulated_model_id/)
  })

  it('refuses a mock run whose latency claims to be measured', () => {
    const meta = { ...metaFor('mock'), latency_source: 'measured' as const }
    expect(() => assertProvenance(meta)).toThrow(/latency_source/)
  })

  it('refuses a live run with no model id', () => {
    const meta = { ...metaFor('live'), model_id: null }
    expect(() => assertProvenance(meta)).toThrow(/model_id/)
  })

  it('refuses a live run that pretends to have read a fixture', () => {
    const meta = { ...metaFor('live'), fixture_id: 'fix-1' }
    expect(() => assertProvenance(meta)).toThrow(/fixture_id/)
  })

  it('refuses a replayed run with no fixture, which would be indistinguishable from a live call', () => {
    const meta = { ...metaFor('replay'), fixture_id: null }
    expect(() => assertProvenance(meta)).toThrow(/fixture_id/)
  })

  it('refuses a run whose model key does not match its provider', () => {
    const meta = { ...metaFor('mock'), model_key: MODEL_ID }
    expect(() => assertProvenance(meta)).toThrow(/model_key/)
  })

  it('refuses a provider outside the three', () => {
    const meta = { ...metaFor('mock'), provider: 'synthetic' as unknown as AiMeta['provider'] }
    expect(() => assertProvenance(meta)).toThrow(/provider/)
  })

  it('refuses a run that cannot be traced to a prompt and an input', () => {
    expect(() => assertProvenance({ ...metaFor('mock'), input_hash: '' })).toThrow(/input_hash/)
    expect(() => assertProvenance({ ...metaFor('mock'), prompt_hash: '' })).toThrow(/prompt_hash/)
  })

  it('allows a mock run to name the authored fixture it served', () => {
    // A deliberate widening of the C2.A constraint, recorded as D16: under U8 a mock
    // answer really was read from a committed authored fixture, and dropping the id
    // would remove the only route from a tag back to the answer that produced it.
    expect(() => assertProvenance(metaFor('mock'))).not.toThrow()
    expect(metaFor('mock').fixture_id).toBe('fix-1')
  })
})

describe('simulated latency', () => {
  it('is a pure function of the input hash, so call order cannot change it', () => {
    const a = simulatedLatencyMs('deadbeefcafe', 1_000)
    const b = simulatedLatencyMs('deadbeefcafe', 1_000)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(1_000)
    expect(a).toBeLessThanOrEqual(1_400)
  })

  it('varies across inputs, so the UI is not developed against one constant', () => {
    const values = new Set(
      ['0000', '1111', '2222', 'abcd', 'ef01', '7777'].map((h) => simulatedLatencyMs(h, 1_000)),
    )
    expect(values.size).toBeGreaterThan(1)
  })
})
