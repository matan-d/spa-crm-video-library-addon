/**
 * The live adapter. Implemented, and never called in this build.
 *
 * Decision U7: no model is called at runtime and there is no API spend. So this
 * file exists to make the seam real rather than to be exercised, and it is
 * constructed disabled: without an explicit `enabled: true` every method throws
 * `not_configured` before touching the network. A demo cannot spend money by
 * accident, and the reviewer's first sixty seconds cannot depend on a cold start,
 * a rate limit or somebody's balance.
 *
 * ## Why there is a function in the middle
 *
 * The browser never holds the key. Calls go to `/api/ai`, a Netlify function that
 * holds the credential and owns the model parameters. The client cannot send a
 * prompt at all: it sends `{ capability, prompt_version, input }` and the function
 * renders the prompt from its own committed copy of the same registry. A proxy that
 * forwards whatever it is given is a general purpose Claude endpoint on a public
 * URL; one that accepts seven validated input shapes is not. See
 * docs/02-caveats-review.md B10.1.
 *
 * **The function itself is not in this repository yet.** That is a real gap, not an
 * omission: with no capture run and no live mode there is nothing to deploy, and a
 * committed serverless function that has never run would be a fourth untested
 * surface. Recorded in the findings with a QA case blocked on it.
 *
 * ## What this file does before any request
 *
 * - validates the input against the same `CAPABILITY_INPUT_SCHEMAS` the function
 *   validates it against, so a bad shape fails locally and cheaply rather than as a
 *   400 that looks like a model error
 * - asserts the encoded contact sheet size, because the payload ceiling belongs to
 *   the platform and a request rejected there produces an error that looks nothing
 *   like an AI error (B10.3)
 * - never sends a filename, ever
 *
 * ## Model parameters live in the prompt registry, not here
 *
 * Verified through the claude-api skill: on `claude-opus-5` thinking is on by
 * default, `output_config.effort` is the cost lever, `temperature` / `top_p` /
 * `top_k` are removed and return a 400, and `max_tokens` caps thinking plus text
 * together. All of that is recorded per capability in `prompts.ts` and enforced by
 * the function. The client asserts the function agrees about effort and prompt
 * version, because a silent disagreement would quietly invalidate the whole cost
 * and provenance story.
 */

import type { Clock } from '@/platform/clock'
import { hashOf } from '@/platform/hash'
import { buildMeta, PROVIDER_DETAIL } from './meta'
import { MODEL_ID, renderPrompt, type RenderedPrompt } from './prompts'
import {
  AiError,
  throwIfAborted,
  type AiCallOptions,
  type AiErrorReason,
  type AiProvider,
  type AiResult,
  type BriefGenInput,
  type BriefGenOptions,
  type BriefGenOutput,
  type BriefMatchInput,
  type BriefMatchOutput,
  type CapabilityIo,
  type Effort,
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
import { promptValuesFor } from './render'
import { CAPABILITY_INPUT_SCHEMAS, schemaFor, type CapabilityKey } from './schemas'
import { formatErrors, validate } from './validate'

/** What the function returns on success. Mirrored in the function's own types. */
export interface AiFunctionResponse {
  capability: CapabilityKey
  /** The prompt version the function rendered from. Must match this client's. */
  prompt_version: string
  /** The model that answered. Recorded verbatim on the run row. */
  model_id: string
  /** The effort the function used, from its copy of the registry. */
  effort: Effort
  /** Checked before `output` is read. A refusal is HTTP 200 with an empty answer. */
  stop_reason: 'end_turn' | 'max_tokens' | 'refusal' | 'pause_turn' | 'tool_use'
  stop_details?: { type: string; category?: string | null; explanation?: string | null } | null
  output: unknown
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/** What the function returns on failure. The code maps to an `AiErrorReason`. */
export interface AiFunctionError {
  error: { code: string; message: string; retry_after_s?: number }
}

export interface LiveDeps {
  clock: Clock
  /**
   * Off unless something deliberately turns it on.
   *
   * The default has to be off rather than "on when a key exists", because the
   * profile and the provider are two separate switches: a real key present while
   * the demo profile is open must still route through mock, or a demo silently
   * spends money.
   */
  enabled?: boolean
  endpoint?: string
  fetchImpl?: typeof fetch
  /** Wall clock ceiling per request, under the platform's own function timeout. */
  timeoutMs?: number
  /**
   * A session-only caller-supplied credential, forwarded to the function.
   *
   * Optional, and never stored, never logged, never in a diagnostics blob. It
   * exists so a reviewer can verify the live path with their own key without
   * anyone else paying for it.
   */
  credential?: () => string | null
  /** Same ceiling the mock enforces, and the same one the input schema declares. */
  sheetBase64Ceiling?: number
}

const DEFAULT_ENDPOINT = '/api/ai'
const DEFAULT_TIMEOUT_MS = 25_000
const DEFAULT_SHEET_CEILING = 1_400_000

/**
 * Function error codes to reasons.
 *
 * A closed map rather than string matching, because every reason below has a
 * distinct UI state and "AI failed" is not something an editor can act on.
 */
const ERROR_CODES: Record<string, AiErrorReason> = {
  rate_limited: 'rate_limited',
  budget_exhausted: 'budget_exhausted',
  payload_too_large: 'payload_too_large',
  invalid_input: 'invalid_output',
  not_configured: 'not_configured',
  upstream_timeout: 'timeout',
  upstream_error: 'network',
  refused: 'refused',
}

export class LiveAiProvider implements AiProvider {
  readonly kind = 'live' as const
  readonly detail = PROVIDER_DETAIL.live

  private readonly clock: Clock
  private readonly enabled: boolean
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly credential: () => string | null
  private readonly sheetCeiling: number

  constructor(deps: LiveDeps) {
    this.clock = deps.clock
    this.enabled = deps.enabled ?? false
    this.endpoint = deps.endpoint ?? DEFAULT_ENDPOINT
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis)
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.credential = deps.credential ?? (() => null)
    this.sheetCeiling = deps.sheetBase64Ceiling ?? DEFAULT_SHEET_CEILING
  }

  async vet(input: VetInput, options: AiCallOptions = {}): Promise<AiResult<VetOutput>> {
    return this.call('vet', input, options)
  }

  async brief_gen(input: BriefGenInput, options: BriefGenOptions = {}): Promise<AiResult<BriefGenOutput>> {
    const result = await this.call('brief_gen', input, options)
    // Buffered, not streamed. The platform's streaming functions have a ten second
    // execution ceiling and brief generation is documented at five to thirty
    // seconds (B10.2), so a streamed live implementation would truncate the most
    // impressive output in the product. The items are emitted here so the caller's
    // streaming UI behaves the same way, and the difference is written down rather
    // than hidden.
    result.output.items.forEach((item, index) => options.onItem?.(item, index))
    return result
  }

  async vision_tag(input: VisionTagInput, options: AiCallOptions = {}): Promise<AiResult<VisionTagOutput>> {
    if (!input.sheet_base64 || input.sheet_base64.trim() === '') {
      throw new AiError(
        'no_stills',
        'This asset has no contact sheet. Refusing to call a vision model about a clip nobody could decode.',
      )
    }
    if (input.sheet_base64.length > this.sheetCeiling) {
      throw new AiError(
        'payload_too_large',
        `The encoded contact sheet is ${input.sheet_base64.length} characters, over the ${this.sheetCeiling} ceiling. Re-encode the sheet smaller; this is our bug, not the platform's.`,
      )
    }
    return this.call('vision_tag', input, options)
  }

  async brief_match(input: BriefMatchInput, options: AiCallOptions = {}): Promise<AiResult<BriefMatchOutput>> {
    return this.call('brief_match', input, options)
  }

  async search_parse(input: SearchParseInput, options: AiCallOptions = {}): Promise<AiResult<SearchParseOutput>> {
    return this.call('search_parse', input, options)
  }

  async gap_scan(input: GapScanInput, options: AiCallOptions = {}): Promise<AiResult<GapScanOutput>> {
    return this.call('gap_scan', input, options)
  }

  async nudge_draft(input: NudgeDraftInput, options: AiCallOptions = {}): Promise<AiResult<NudgeDraftOutput>> {
    return this.call('nudge_draft', input, options)
  }

  private async call<K extends CapabilityKey>(
    kind: K,
    input: CapabilityIo[K]['input'],
    options: AiCallOptions,
  ): Promise<AiResult<CapabilityIo[K]['output']>> {
    throwIfAborted(options.signal, { kind })

    if (!this.enabled) {
      throw new AiError(
        'not_configured',
        'The live provider is disabled. This build calls no model and spends nothing (decision U7); ' +
          'the seam exists so the live path is a configuration change rather than a rewrite.',
        { meta: { kind, provider: 'live', status: 'error', error_code: 'not_configured' } },
      )
    }
    if (!this.fetchImpl) {
      throw new AiError('not_configured', 'No fetch implementation is available in this runtime.')
    }

    // The client half of the function's allowlist. Failing here is cheaper than a
    // 400 from the function and it fails with a reason a human can read.
    const inputCheck = validate(CAPABILITY_INPUT_SCHEMAS[kind], input)
    if (!inputCheck.ok) {
      throw new AiError(
        'invalid_output',
        `Refusing to send a ${kind} request that does not match the agreed input shape:\n${formatErrors(inputCheck.errors)}`,
        { validationErrors: inputCheck.errors },
      )
    }

    const input_hash = await hashOf(input)
    const prompt: RenderedPrompt = await renderPrompt(kind, promptValuesFor(kind, input))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onCallerAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })

    const startedAt = this.clock.now()
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        // No prompt, no model, no max_tokens, no filename. The function owns every
        // model parameter and renders the prompt from its own copy of the registry.
        body: JSON.stringify({ capability: kind, prompt_version: prompt.prompt_version, input }),
        signal: controller.signal,
      })
    } catch (cause) {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
      if (options.signal?.aborted) {
        throw new AiError('cancelled', 'The caller aborted this request.', { cause })
      }
      throw new AiError(
        controller.signal.aborted ? 'timeout' : 'network',
        controller.signal.aborted
          ? `No response inside ${this.timeoutMs}ms.`
          : 'The request never reached the function. This includes being offline.',
        { cause },
      )
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }

    const latency_ms = this.clock.now() - startedAt

    if (!response.ok) {
      const body = (await safeJson(response)) as AiFunctionError | null
      const code = body?.error?.code ?? httpToCode(response.status)
      const reason = ERROR_CODES[code] ?? 'network'
      throw new AiError(reason, body?.error?.message ?? `The function returned ${response.status}.`, {
        meta: {
          kind,
          provider: 'live',
          prompt_key: kind,
          prompt_version: prompt.prompt_version,
          prompt_hash: prompt.prompt_hash,
          input_hash,
          latency_ms,
          latency_source: 'measured',
          status: 'error',
          error_code: reason,
        },
      })
    }

    const payload = (await safeJson(response)) as AiFunctionResponse | null
    if (!payload) {
      throw new AiError('invalid_output', 'The function returned a body that is not JSON.')
    }

    // A stale deployment answering with a different prompt version would silently
    // detach every run row from the prompt it claims to record.
    if (payload.prompt_version !== prompt.prompt_version) {
      throw new AiError(
        'invalid_output',
        `The function rendered prompt version ${payload.prompt_version} and this client records ${prompt.prompt_version}. ` +
          'Refusing rather than writing a run row that names the wrong prompt.',
      )
    }
    if (payload.effort !== prompt.effort) {
      throw new AiError(
        'invalid_output',
        `The function used effort "${payload.effort}" and the registry says "${prompt.effort}" for ${kind}. ` +
          'Refusing rather than recording a cost lever the run did not actually use.',
      )
    }
    if (payload.model_id !== MODEL_ID) {
      throw new AiError(
        'invalid_output',
        `The function answered from "${payload.model_id}" and this build is pinned to "${MODEL_ID}".`,
      )
    }

    const failure = stopReasonFailure(payload)
    if (failure) {
      throw new AiError(failure.reason, failure.message, {
        meta: buildMeta({
          kind,
          provider: 'live',
          provider_detail: PROVIDER_DETAIL.live,
          prompt,
          input_hash,
          latency_ms,
          status: failure.reason === 'refused' ? 'refused' : 'error',
          error_code: failure.reason,
          schema_valid: false,
        }),
        rawOutput: payload.output,
      })
    }

    const schema = schemaFor(kind)
    const validated = validate<CapabilityIo[K]['output']>(schema.schema, payload.output)
    const meta = buildMeta({
      kind,
      provider: 'live',
      provider_detail: PROVIDER_DETAIL.live,
      prompt,
      input_hash,
      latency_ms,
      status: validated.ok ? 'ok' : 'error',
      error_code: validated.ok ? null : 'invalid_output',
      schema_valid: validated.ok,
    })

    if (!validated.ok) {
      throw new AiError(
        'invalid_output',
        `A live ${kind} response did not validate against schema ${schema.schema_version}:\n${formatErrors(validated.errors)}`,
        { meta, validationErrors: validated.errors, rawOutput: payload.output },
      )
    }

    return { output: validated.value, meta }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const credential = this.credential()
    // Forwarded, never stored and never logged. The function decides whether it is
    // acceptable; the browser never holds the deployment's own key.
    if (credential) headers['x-caller-credential'] = credential
    return headers
  }
}

/**
 * `stop_reason` before `content`, on every call.
 *
 * A policy decline is an HTTP 200 with an empty answer, so code that reads the
 * output unconditionally throws at the exact moment a demo depends on it. A
 * truncation at the same `max_tokens` is not retryable either: it will truncate
 * identically, and structured outputs guarantee the shape only on completion.
 */
function stopReasonFailure(payload: AiFunctionResponse): { reason: AiErrorReason; message: string } | null {
  if (payload.stop_reason === 'refusal') {
    const category = payload.stop_details?.category ?? 'unstated'
    return {
      reason: 'refused',
      message: `The model declined this request (category: ${category}). This needs a human, not a retry.`,
    }
  }
  if (payload.stop_reason === 'max_tokens') {
    return {
      reason: 'truncated',
      message:
        'The response hit max_tokens, so the structured output is incomplete. On this model max_tokens caps thinking and text together, so the fix is headroom in the prompt registry rather than a retry.',
    }
  }
  if (payload.stop_reason === 'pause_turn' || payload.stop_reason === 'tool_use') {
    return {
      reason: 'invalid_output',
      message: `The function returned stop_reason "${payload.stop_reason}", which none of these capabilities should ever produce.`,
    }
  }
  return null
}

function httpToCode(status: number): string {
  if (status === 401 || status === 403) return 'not_configured'
  if (status === 413) return 'payload_too_large'
  if (status === 429) return 'rate_limited'
  if (status === 402) return 'budget_exhausted'
  if (status === 504 || status === 408) return 'upstream_timeout'
  return 'upstream_error'
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

export function createLiveProvider(deps: LiveDeps): LiveAiProvider {
  return new LiveAiProvider(deps)
}
