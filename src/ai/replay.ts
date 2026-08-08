/**
 * The replay reader: captured real responses, served from a committed bundle, no
 * network.
 *
 * Implemented and unexercised, per decision U7. There has been no capture run in
 * this build, so `EMPTY_REPLAY_BUNDLE` is empty and every call through this
 * provider fails with `fixture_missing`. That is the honest state and it is
 * asserted by a test: an empty bundle is proof that no authored fixture has been
 * quietly relabelled as a captured one.
 *
 * ## Replay is the cache, pre-seeded
 *
 * The key is `(input_hash, prompt_hash, model_key)`, built by the same
 * `cache.ts` helpers the response cache uses, because replay is not a separate
 * code path: it is the cache with committed entries. Giving replay its own key
 * would mean a prompt version bump invalidated the live cache while replay kept
 * serving the stale capture, which is the worst of both.
 *
 * ## A committed fixture is not trusted for being committed
 *
 * Three checks run on every read, and each one exists because the alternative is a
 * quiet lie:
 *
 * 1. The output is validated against the same capability schema as live and mock.
 *    A capture taken under an older schema version must fail loudly rather than
 *    flow into the UI.
 * 2. The fixture's `model_key` must be the live model key. A mock-keyed entry
 *    inside a replay bundle would be an authored answer wearing a captured
 *    answer's provenance, and that is the one thing this whole layer exists to
 *    prevent.
 * 3. The fixture must name a `model_id`. A replayed run records which model
 *    produced the response, because it really did come from one.
 */

import { cacheKeyString, modelKeyFor, type CacheKey } from './cache'
import { buildMeta, PROVIDER_DETAIL } from './meta'
import { MODEL_ID, renderPrompt, type RenderedPrompt } from './prompts'
import { promptValuesFor } from './render'
import {
  AiError,
  throwIfAborted,
  type AiCallOptions,
  type AiMeta,
  type AiProvider,
  type AiResult,
  type BriefGenInput,
  type BriefGenOptions,
  type BriefGenOutput,
  type BriefMatchInput,
  type BriefMatchOutput,
  type CapabilityIo,
  type GapScanInput,
  type GapScanOutput,
  type NudgeDraftInput,
  type NudgeDraftOutput,
  type SearchParseInput,
  type SearchParseOutput,
  type VetInput,
  type VetOutput,
  type VisionTagInput,
  type VisionTagOutput,
} from './provider'
import { schemaFor, type CapabilityKey } from './schemas'
import { realSleep, type Sleep } from './sleep'
import { formatErrors, validate } from './validate'
import { hashOf } from '@/platform/hash'

export interface ReplayFixture {
  /** Stable id, recorded on `ai_run.fixture_id`. */
  id: string
  kind: CapabilityKey
  /** The three cache key parts, byte identical to what `cache.ts` produces. */
  input_hash: string
  prompt_hash: string
  model_key: string
  /** What actually answered. Non-null on every replay fixture, by definition. */
  model_id: string
  prompt_version: string
  /** ISO instant of the capture, from the capturing run's injected clock. */
  captured_at: string
  /** Measured at capture time, replayed as data. Never presented as a measurement. */
  latency_ms: number
  /** Verbatim, exactly as the model returned it. */
  output_json: unknown
}

export interface ReplayBundle {
  bundle_version: number
  /** Free text describing the capture run, or its absence. */
  captured_with: string
  fixtures: readonly ReplayFixture[]
}

/**
 * The shipped bundle.
 *
 * Empty, and it must stay empty in this build. There is no API spend in this
 * submission and therefore no captured response to commit. When a capture run
 * eventually happens, `captureFixture` below is what writes these entries.
 */
export const EMPTY_REPLAY_BUNDLE: ReplayBundle = {
  bundle_version: 1,
  captured_with:
    'No capture run has been performed. Decision U7: no model is called in this build, so there is nothing real to replay. The mock fixtures are authored, provider mock, and never pretend otherwise.',
  fixtures: [],
}

export interface ReplayDeps {
  bundle?: ReplayBundle
  sleep?: Sleep
}

/**
 * Turns a completed live run into a committable fixture.
 *
 * The other half of the "capture toggle" the reviews describe. It is written here
 * rather than in the live adapter so the fixture shape has exactly one owner, and
 * it refuses to capture anything that was not live: capturing a mock answer into a
 * replay bundle is the exact laundering this file is guarding against.
 */
export function captureFixture(args: {
  id: string
  meta: AiMeta
  output_json: unknown
  captured_at: string
}): ReplayFixture {
  const { meta } = args
  if (meta.provider !== 'live' || !meta.model_id) {
    throw new Error(
      `captureFixture: only a live run can become a replay fixture, and this one is "${meta.provider}". ` +
        'A captured fixture asserts that a model produced the bytes, so anything else would be a forged provenance record.',
    )
  }
  if (meta.status !== 'ok' || !meta.schema_valid) {
    throw new Error('captureFixture: refusing to capture a failed or invalid run as a replay fixture.')
  }
  return {
    id: args.id,
    kind: meta.kind,
    input_hash: meta.input_hash,
    prompt_hash: meta.prompt_hash,
    model_key: meta.model_key,
    model_id: meta.model_id,
    prompt_version: meta.prompt_version,
    captured_at: args.captured_at,
    latency_ms: meta.latency_ms ?? 0,
    output_json: args.output_json,
  }
}

export class ReplayAiProvider implements AiProvider {
  readonly kind = 'replay' as const
  readonly detail = PROVIDER_DETAIL.replay

  private readonly bundle: ReplayBundle
  private readonly sleep: Sleep
  private readonly index: Map<string, ReplayFixture>

  constructor(deps: ReplayDeps = {}) {
    this.bundle = deps.bundle ?? EMPTY_REPLAY_BUNDLE
    this.sleep = deps.sleep ?? realSleep
    this.index = new Map(
      this.bundle.fixtures.map((fixture) => [
        cacheKeyString({
          input_hash: fixture.input_hash,
          prompt_hash: fixture.prompt_hash,
          model_key: fixture.model_key,
        }),
        fixture,
      ]),
    )
  }

  /** How many entries this bundle carries. Read by the Data Health surface. */
  get size(): number {
    return this.index.size
  }

  async vet(input: VetInput, options: AiCallOptions = {}): Promise<AiResult<VetOutput>> {
    return this.serve('vet', input, options)
  }

  async brief_gen(input: BriefGenInput, options: BriefGenOptions = {}): Promise<AiResult<BriefGenOutput>> {
    const result = await this.serve('brief_gen', input, options)
    // Replay streams too. A UI that only assembles item by item on one provider is
    // a UI with two behaviours, and the seam is supposed to remove that.
    const perItem = Math.max(1, Math.floor((result.meta.latency_ms ?? 0) / Math.max(1, result.output.items.length)))
    for (let i = 0; i < result.output.items.length; i += 1) {
      await this.sleep(perItem, options.signal)
      throwIfAborted(options.signal, result.meta)
      options.onItem?.(result.output.items[i]!, i)
    }
    return result
  }

  async vision_tag(input: VisionTagInput, options: AiCallOptions = {}): Promise<AiResult<VisionTagOutput>> {
    // The no-fabrication rule is not a mock behaviour, it is a contract rule, so it
    // is enforced on every implementation rather than in one of them.
    if (!input.sheet_base64 || input.sheet_base64.trim() === '') {
      throw new AiError('no_stills', 'This asset has no contact sheet, so there is nothing to replay an answer about.')
    }
    return this.serve('vision_tag', input, options)
  }

  async brief_match(input: BriefMatchInput, options: AiCallOptions = {}): Promise<AiResult<BriefMatchOutput>> {
    return this.serve('brief_match', input, options)
  }

  async search_parse(input: SearchParseInput, options: AiCallOptions = {}): Promise<AiResult<SearchParseOutput>> {
    return this.serve('search_parse', input, options)
  }

  async gap_scan(input: GapScanInput, options: AiCallOptions = {}): Promise<AiResult<GapScanOutput>> {
    return this.serve('gap_scan', input, options)
  }

  async nudge_draft(input: NudgeDraftInput, options: AiCallOptions = {}): Promise<AiResult<NudgeDraftOutput>> {
    return this.serve('nudge_draft', input, options)
  }

  private async serve<K extends CapabilityKey>(
    kind: K,
    input: CapabilityIo[K]['input'],
    options: AiCallOptions,
  ): Promise<AiResult<CapabilityIo[K]['output']>> {
    throwIfAborted(options.signal, { kind })

    const input_hash = await hashOf(input)
    const prompt: RenderedPrompt = await renderPrompt(kind, promptValuesFor(kind, input))
    const key: CacheKey = {
      input_hash,
      prompt_hash: prompt.prompt_hash,
      model_key: modelKeyFor('replay'),
    }

    const fixture = this.index.get(cacheKeyString(key))
    if (!fixture) {
      throw new AiError(
        'fixture_missing',
        `No committed fixture for ${kind} at cache key ${cacheKeyString(key)}. ` +
          `The bundle holds ${this.index.size} fixture(s) and was described as: ${this.bundle.captured_with}`,
        {
          meta: {
            kind,
            provider: 'replay',
            prompt_key: kind,
            prompt_version: prompt.prompt_version,
            prompt_hash: prompt.prompt_hash,
            input_hash,
            model_key: key.model_key,
            status: 'error',
            error_code: 'fixture_missing',
          },
        },
      )
    }

    if (fixture.kind !== kind) {
      throw new AiError(
        'invalid_output',
        `Fixture ${fixture.id} is recorded as ${fixture.kind} and was matched for ${kind}. The bundle index is wrong.`,
      )
    }
    if (fixture.model_key !== MODEL_ID || !fixture.model_id) {
      throw new AiError(
        'invalid_output',
        `Fixture ${fixture.id} does not carry the live model key, so it was not captured from a model. ` +
          'A replay bundle may only hold real responses; an authored answer belongs to the mock provider, where the row says so.',
      )
    }

    await this.sleep(fixture.latency_ms, options.signal)
    throwIfAborted(options.signal, { kind })

    const schema = schemaFor(kind)
    const validated = validate<CapabilityIo[K]['output']>(schema.schema, fixture.output_json)

    const meta = buildMeta({
      kind,
      provider: 'replay',
      provider_detail: PROVIDER_DETAIL.replay,
      prompt,
      input_hash,
      fixture: { id: fixture.id, hash: null },
      latency_ms: fixture.latency_ms,
      status: validated.ok ? 'ok' : 'error',
      error_code: validated.ok ? null : 'invalid_output',
      schema_valid: validated.ok,
    })

    if (!validated.ok) {
      throw new AiError(
        'invalid_output',
        `Fixture ${fixture.id} no longer validates against ${kind} schema ${schema.schema_version}. ` +
          `It was captured under prompt version ${fixture.prompt_version}:\n${formatErrors(validated.errors)}`,
        { meta, validationErrors: validated.errors, rawOutput: fixture.output_json },
      )
    }

    return { output: validated.value, meta }
  }
}

export function createReplayProvider(deps: ReplayDeps = {}): ReplayAiProvider {
  return new ReplayAiProvider(deps)
}
