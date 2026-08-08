/**
 * The live adapter, which is never called in this build.
 *
 * "Unexercised" means no model call and no spend: the network is stubbed here and no
 * request leaves the process. What is asserted is the adapter's own behaviour, and
 * it is worth asserting for one reason: every branch below maps to a distinct UI
 * state, and an error map nobody has ever run is a set of states nobody has ever
 * seen. The first time a real key is added should not also be the first time the
 * refusal path executes.
 *
 * The default construction is the important case. Off unless something deliberately
 * turns it on, so a demo cannot spend money by accident and a reviewer's first sixty
 * seconds cannot depend on a cold start.
 */

import { describe, expect, it } from 'vitest'
import { createAiProvider, createLiveProvider, createMockProvider, MODEL_ID, PROVIDER_DETAIL, type AiError, type AiFunctionResponse } from '@/ai'
import { noSleep } from '@/ai/sleep'
import { SEED_EPOCH_MS, SeededClock } from '@/platform/clock'
import { vetInput, visionInput } from './_inputs'

function clock(stepMs = 40): SeededClock {
  return new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: stepMs })
}

/** A stub function endpoint. Records what it was sent, so the request shape is assertable. */
function stub(reply: { status?: number; body: unknown }) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
    } as Response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

async function okBody(overrides: Partial<AiFunctionResponse> = {}): Promise<AiFunctionResponse> {
  // A schema valid payload, borrowed from the mock so the stub is not hand written.
  const mock = await createMockProvider({ sleep: noSleep }).vision_tag(visionInput())
  return {
    capability: 'vision_tag',
    prompt_version: '1.0.0',
    model_id: MODEL_ID,
    effort: 'low',
    stop_reason: 'end_turn',
    output: mock.output,
    usage: { input_tokens: 1_200, output_tokens: 380, cache_read_input_tokens: 900 },
    ...overrides,
  }
}

describe('the shipped configuration', () => {
  it('is disabled, and refuses before touching the network', async () => {
    const { calls, fetchImpl } = stub({ body: {} })
    const ai = createLiveProvider({ clock: clock(), fetchImpl })
    const error = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('not_configured')
    expect(error.message).toMatch(/spends nothing/)
    expect(calls).toHaveLength(0)
  })

  it('is what the factory builds only when asked, and never by default', () => {
    expect(createAiProvider().kind).toBe('mock')
    expect(createAiProvider({ mode: 'replay' }).kind).toBe('replay')
    expect(createAiProvider({ mode: 'live', clock: clock() }).kind).toBe('live')
  })

  it('refuses to build a live provider with no clock, because a real call measures its own latency', () => {
    expect(() => createAiProvider({ mode: 'live' })).toThrow(/needs a Clock/)
  })
})

describe('the request', () => {
  it('sends the capability, the prompt version and the input, and never a prompt or a model', async () => {
    const { calls, fetchImpl } = stub({ body: await okBody() })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    await ai.vision_tag(visionInput())

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/ai')
    const body = calls[0]!.body
    expect(Object.keys(body).sort()).toEqual(['capability', 'input', 'prompt_version'])
    expect(body.capability).toBe('vision_tag')
    // The function owns every model parameter and renders the prompt itself.
    expect(body).not.toHaveProperty('system')
    expect(body).not.toHaveProperty('prompt')
    expect(body).not.toHaveProperty('model')
    expect(body).not.toHaveProperty('max_tokens')
    // And no filename, ever.
    expect(JSON.stringify(body)).not.toContain('filename')
  })

  it('validates the input against the same allowlist the function uses, before sending', async () => {
    const { calls, fetchImpl } = stub({ body: await okBody() })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    // frames_seen above the declared maximum. The function would reject it as a 400
    // that looks nothing like an AI error, so it fails here instead.
    const error = (await ai.vision_tag(visionInput({ frames_seen: 99 })).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('invalid_output')
    expect(error.validationErrors.length).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
  })

  it('refuses a clip with no sheet and an oversized sheet without a request', async () => {
    const { calls, fetchImpl } = stub({ body: await okBody() })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl, sheetBase64Ceiling: 32 })
    await expect(ai.vision_tag(visionInput({ sheet_base64: '' }))).rejects.toMatchObject({ reason: 'no_stills' })
    await expect(ai.vision_tag(visionInput())).rejects.toMatchObject({ reason: 'payload_too_large' })
    expect(calls).toHaveLength(0)
  })

  it('forwards a caller supplied credential as a header and never in the body', async () => {
    const headers: Record<string, string>[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>)
      return { ok: true, status: 200, json: async () => await okBody() } as Response
    }) as unknown as typeof fetch
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl, credential: () => 'sk-reviewer-key' })
    await ai.vision_tag(visionInput())
    expect(headers[0]!['x-caller-credential']).toBe('sk-reviewer-key')
  })
})

describe('a successful response', () => {
  it('records the model, a measured latency, and no simulated model', async () => {
    const { fetchImpl } = stub({ body: await okBody() })
    const ai = createLiveProvider({ clock: clock(40), enabled: true, fetchImpl })
    const result = await ai.vision_tag(visionInput())
    expect(result.meta.provider).toBe('live')
    expect(result.meta.provider_detail).toBe(PROVIDER_DETAIL.live)
    expect(result.meta.model_id).toBe(MODEL_ID)
    expect(result.meta.simulated_model_id).toBeNull()
    expect(result.meta.fixture_id).toBeNull()
    expect(result.meta.latency_source).toBe('measured')
    expect(result.meta.latency_ms).toBe(40)
    expect(result.output.frames_seen).toBe(5)
  })
})

describe('the failure map, because every branch is a different thing to tell a human', () => {
  it('treats a refusal as a refusal, not as a crash', async () => {
    const { fetchImpl } = stub({
      body: await okBody({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        output: {},
      }),
    })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    const error = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('refused')
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('cyber')
    expect(error.meta.status).toBe('refused')
  })

  it('treats a truncation as truncated, and does not suggest a retry', async () => {
    const { fetchImpl } = stub({ body: await okBody({ stop_reason: 'max_tokens' }) })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    const error = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('truncated')
    expect(error.retryable).toBe(false)
    expect(error.message).toMatch(/thinking and text together/)
  })

  it('maps a rate limit, a budget ceiling and an auth failure to distinct reasons', async () => {
    const cases: [number, string, string][] = [
      [429, 'rate_limited', 'rate_limited'],
      [402, 'budget_exhausted', 'budget_exhausted'],
      [403, 'not_configured', 'not_configured'],
      [413, 'payload_too_large', 'payload_too_large'],
    ]
    for (const [status, code, expected] of cases) {
      const { fetchImpl } = stub({ status, body: { error: { code, message: 'from the function' } } })
      const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
      const error = (await ai.vet(vetInput()).catch((e: unknown) => e)) as AiError
      expect(error.reason, `status ${status}`).toBe(expected)
      expect(error.meta.latency_source).toBe('measured')
    }
  })

  it('refuses a response from a stale deployment rather than mislabelling the run', async () => {
    const { fetchImpl } = stub({ body: await okBody({ prompt_version: '0.9.0' }) })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    const error = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('invalid_output')
    expect(error.message).toMatch(/prompt version/)
  })

  it('refuses a response that used a different effort than the registry records', async () => {
    const { fetchImpl } = stub({ body: await okBody({ effort: 'high' }) })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    const error = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('invalid_output')
    expect(error.message).toMatch(/cost lever/)
  })

  it('refuses a response from a different model than this build is pinned to', async () => {
    const { fetchImpl } = stub({ body: await okBody({ model_id: 'claude-sonnet-5' }) })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    const error = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('invalid_output')
    expect(error.message).toContain(MODEL_ID)
  })

  it('refuses an output that does not validate, keeping the payload for the error path', async () => {
    const { fetchImpl } = stub({ body: await okBody({ output: { description: 'only a description' } }) })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    const error = (await ai.vision_tag(visionInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('invalid_output')
    expect(error.meta.schema_valid).toBe(false)
    expect(error.rawOutput).toEqual({ description: 'only a description' })
  })

  it('maps a transport failure to network rather than to an AI error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    const error = (await ai.vet(vetInput()).catch((e: unknown) => e)) as AiError
    expect(error.reason).toBe('network')
    expect(error.retryable).toBe(true)
  })

  it('honours a caller abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const { calls, fetchImpl } = stub({ body: await okBody() })
    const ai = createLiveProvider({ clock: clock(), enabled: true, fetchImpl })
    await expect(ai.vet(vetInput(), { signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled' })
    expect(calls).toHaveLength(0)
  })
})
