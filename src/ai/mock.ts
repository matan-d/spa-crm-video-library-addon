/**
 * The deterministic mock provider.
 *
 * This is the only implementation exercised in this build (U7), and it is a peer of
 * the other two rather than a fork: same interface, same prompt registry, same
 * schemas, same validator, same post-checks, same `ai_run` shape. The only thing it
 * does differently is where the answer comes from, and that difference is recorded
 * on every row rather than inferred from a mode.
 *
 * ## How an answer is chosen, and how that stays honest
 *
 * Three paths, and they are named differently on the run so nobody has to guess:
 *
 * 1. `authored-fixture-v1`: a fixture written offline by a model that looked at the
 *    actual artefact, keyed to the subject it was written for.
 * 2. `authored-fixture-v1-reused`: an authored fixture served for a subject it was
 *    not written for. Still a real answer in a real register, and honestly not an
 *    observation about this particular clip. Vision has no third option, because
 *    code cannot look at an image either.
 * 3. `synthetic-v1`: assembled by local code from the input. Used where the input
 *    space is unbounded and reuse would be visibly wrong, which in practice means
 *    query parsing and the phrasing of a coverage cell nobody authored.
 *
 * Identifiers are never taken from a fixture. Frame counts, cell signatures, brief
 * item ids, asset ids, missing item ids and evidence quotes are all echoed from the
 * input at serve time, exactly as a real response would echo them. That is the line
 * between "a fixture is an authored answer" and "a fixture can name something the
 * caller never asked about".
 *
 * ## Determinism without an Rng
 *
 * There is no injected `Rng` here on purpose. An Rng advances with call order, so
 * the same clip analysed second rather than first would report a different think
 * time and the demo would stop being byte identical when a view mounted twice.
 * Every varying value is a pure function of `input_hash` instead, so identical input
 * gives identical output regardless of what else ran first.
 *
 * The one stateful exception is deliberate and documented: the transient failures
 * (a rate limit, a timeout) count attempts on the instance, because "fails once and
 * then succeeds" is a state the UI has to handle and it cannot be expressed by a
 * pure function of the input. A fresh provider replays the same sequence.
 *
 * ## Simulated latency is data
 *
 * Every delay comes from the fixture and is stamped `latency_source: 'simulated'`,
 * so a fake 1.4 second think time can never be averaged into a real performance
 * number. `sleep` is injected so tests do not wait.
 */

import { hashOf } from '@/platform/hash'
import { modelKeyFor, ResponseCache, type CacheKey } from './cache'
import {
  BRIEF_GEN_SAN_JOSE,
  BRIEF_MATCH_BY_ITEM,
  BRIEF_MATCH_INCONCLUSIVE,
  DEFAULT_ORDERING,
  GAP_SCAN_BY_SIGNATURE,
  injectionMatch,
  normaliseQuery,
  NUDGE_BY_TONE,
  SEARCH_PARSE_BY_QUERY,
  STOPWORDS,
  SYNONYMS,
  TAXONOMY_LOOKUP,
  VET_BY_CREATOR,
  VET_FAILURES,
  VET_FIXTURES,
  VET_INSUFFICIENT,
  VISION_BY_ASSET,
  VISION_FAILURES,
  VISION_FIXTURES,
  type AuthoredFailure,
  type BriefGenOutputBody,
  type Facet,
  type NudgeOutputBody,
  type VetOutputBody,
} from './fixtures'
import { buildMeta, PROVIDER_DETAIL, simulatedLatencyMs, type ProviderDetail } from './meta'
import { renderPrompt, type RenderedPrompt } from './prompts'
import {
  AiError,
  throwIfAborted,
  type AiCallOptions,
  type AiMeta,
  type AiProvider,
  type AiResult,
  type BriefGenInput,
  type BriefGenItem,
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
import { promptValuesFor } from './render'
import { schemaFor, type CapabilityKey } from './schemas'
import { realSleep, type Sleep } from './sleep'
import type { NudgeTone, Subject, VetCitableField } from './taxonomy'
import { formatErrors, validate } from './validate'

export interface MockConditions {
  /**
   * Ceiling on the encoded contact sheet, in base64 characters.
   *
   * The same check the live path has to make before sending: the platform payload
   * limit applies to the proxy, not to the model, and a request rejected there
   * produces an error that looks nothing like an AI error. Mock enforces it so the
   * UI state exists before the live path is ever switched on.
   */
  sheetBase64Ceiling?: number
  /** Turns the authored failures off, for a demo that needs a clean run. */
  disableFailures?: boolean
}

export interface MockDeps {
  sleep?: Sleep
  cache?: ResponseCache
  conditions?: MockConditions
}

/**
 * About 1MB of image bytes, which is roughly 1.4M base64 characters after the
 * one third inflation, and well under the platform ceiling. Same number as the
 * `sheet_base64` bound in the input schema, on purpose: the function's allowlist
 * and this check must agree or one of them is decoration. See B10.3.
 */
const DEFAULT_SHEET_CEILING = 1_400_000

interface Served {
  output: unknown
  detail: ProviderDetail
  fixture: { id: string; hash: string | null } | null
  latency_ms: number
}

type Production = { ok: true; served: Served } | { ok: false; failure: AuthoredFailure }

/** What the cache holds: the served answer, so a second identical call is identical. */
type CachedServed = Served

export class MockAiProvider implements AiProvider {
  readonly kind = 'mock' as const
  readonly detail = PROVIDER_DETAIL.authored

  private readonly sleep: Sleep
  private readonly cache: ResponseCache
  private readonly conditions: MockConditions
  /** Attempt counts for the transient failures. See the header note on determinism. */
  private readonly attempts = new Map<string, number>()

  constructor(deps: MockDeps = {}) {
    this.sleep = deps.sleep ?? realSleep
    this.cache = deps.cache ?? new ResponseCache()
    this.conditions = deps.conditions ?? {}
  }

  // -------------------------------------------------------------------------
  // vet
  // -------------------------------------------------------------------------

  async vet(input: VetInput, options: AiCallOptions = {}): Promise<AiResult<VetOutput>> {
    return this.run('vet', input, options, ({ input_hash }) => {
      const failure = this.failureFor('vet', input.creator_id, VET_FAILURES)
      if (failure) return { ok: false, failure }

      const injected = injectionMatch(input.application_note)
      const fixture =
        injected !== null
          ? (VET_FIXTURES.find((f) => f.id === 'vet.injection-observed') ?? VET_INSUFFICIENT)
          : (VET_BY_CREATOR.get(input.creator_id) ?? VET_INSUFFICIENT)

      const authoredFor = fixture.creator_ids.includes(input.creator_id) || injected !== null
      return {
        ok: true,
        served: {
          output: projectVet(fixture.output, input, injected),
          detail: authoredFor ? PROVIDER_DETAIL.authored : PROVIDER_DETAIL.authoredReused,
          fixture: { id: fixture.id, hash: null },
          latency_ms: simulatedLatencyMs(input_hash, fixture.latency_ms, 600),
        },
      }
    })
  }

  // -------------------------------------------------------------------------
  // brief_gen
  // -------------------------------------------------------------------------

  async brief_gen(input: BriefGenInput, options: BriefGenOptions = {}): Promise<AiResult<BriefGenOutput>> {
    const fixture = BRIEF_GEN_SAN_JOSE
    return this.run(
      'brief_gen',
      input,
      options,
      ({ input_hash }) => ({
        ok: true,
        served: {
          output: projectBriefGen(fixture.output, input),
          detail:
            input.branch_slug === 'branch-san-jose' ? PROVIDER_DETAIL.authored : PROVIDER_DETAIL.authoredReused,
          fixture: { id: fixture.id, hash: null },
          latency_ms: simulatedLatencyMs(input_hash, fixture.latency_ms, 2_000),
        },
      }),
      // Brief generation is the one capability whose output is a list a human
      // watches assemble, so the mock streams for real. A streaming UI developed
      // against a mock that resolves an array has never actually streamed.
      async (served, step, signal) => {
        const output = served.output as BriefGenOutput
        const perItem = Math.max(1, Math.floor(served.latency_ms / Math.max(1, output.items.length)))
        for (let i = 0; i < output.items.length; i += 1) {
          await step(perItem)
          throwIfAborted(signal, { kind: 'brief_gen' })
          options.onItem?.(output.items[i]!, i)
        }
      },
    )
  }

  // -------------------------------------------------------------------------
  // vision_tag
  // -------------------------------------------------------------------------

  async vision_tag(input: VisionTagInput, options: AiCallOptions = {}): Promise<AiResult<VisionTagOutput>> {
    return this.run('vision_tag', input, options, ({ input_hash }) => {
      // The load-bearing refusal, and it comes before everything else including
      // the cache. A clip nobody could decode has no sheet, and the honest answer
      // is that there is nothing to look at. A plausible tag here would be the
      // least detectable and most damaging output in the product.
      if (!input.sheet_base64 || input.sheet_base64.trim() === '') {
        return {
          ok: false,
          failure: {
            id: 'vision.no-stills',
            reason: 'no_stills',
            message:
              'This asset has no contact sheet, so there is nothing to analyse. No tags, no description, and no run row that implies otherwise.',
            latency_ms: 0,
            detail: PROVIDER_DETAIL.synthetic,
            note: 'Structural, never keyed to an asset id.',
          },
        }
      }

      const ceiling = this.conditions.sheetBase64Ceiling ?? DEFAULT_SHEET_CEILING
      if (input.sheet_base64.length > ceiling) {
        return {
          ok: false,
          failure: {
            id: 'vision.payload-too-large',
            reason: 'payload_too_large',
            message: `The encoded contact sheet is ${input.sheet_base64.length} characters, over the ${ceiling} ceiling. The sheet was not downscaled, which is our bug rather than the platform's.`,
            latency_ms: 0,
            detail: PROVIDER_DETAIL.synthetic,
            note: 'Checked before anything is sent, exactly as the live path checks it.',
          },
        }
      }

      const failure = this.failureFor('vision_tag', input.asset_id, VISION_FAILURES)
      if (failure) return { ok: false, failure }

      const keyed = VISION_BY_ASSET.get(input.asset_id)
      const fixture = keyed ?? pickByHash(VISION_FIXTURES, input_hash)
      return {
        ok: true,
        served: {
          // frames_seen is echoed, never authored, so a three frame constrained
          // tier sheet is never reported as five.
          output: { ...fixture.output, frames_seen: input.frames_seen } satisfies VisionTagOutput,
          detail: keyed ? PROVIDER_DETAIL.authored : PROVIDER_DETAIL.authoredReused,
          fixture: { id: fixture.id, hash: fixture.provenance.sha256 },
          latency_ms: simulatedLatencyMs(input_hash, fixture.latency_ms, 500),
        },
      }
    })
  }

  // -------------------------------------------------------------------------
  // brief_match
  // -------------------------------------------------------------------------

  async brief_match(input: BriefMatchInput, options: AiCallOptions = {}): Promise<AiResult<BriefMatchOutput>> {
    return this.run('brief_match', input, options, ({ input_hash }) => {
      const keyed = BRIEF_MATCH_BY_ITEM.get(input.brief_item_id)
      const fixture = keyed ?? BRIEF_MATCH_INCONCLUSIVE
      const candidateIds = new Set(input.candidates.map((c) => c.asset_id))

      const matches = fixture.output.tuples
        .filter((tuple) => candidateIds.has(tuple.asset_id))
        .map((tuple) => ({
          brief_item_id: input.brief_item_id,
          asset_id: tuple.asset_id,
          verdict: tuple.verdict,
          confidence: tuple.confidence,
          evidence: tuple.evidence,
        }))

      const named = new Set(matches.map((m) => m.asset_id))
      const output: BriefMatchOutput = {
        matches: matches.slice(0, 200),
        // Every candidate this answer says nothing about. Creators always shoot
        // extra, and a diff that cannot show extras is wrong.
        unmatched_asset_ids: input.candidates
          .map((c) => c.asset_id)
          .filter((id) => !named.has(id))
          .slice(0, 100),
        notes: fixture.output.notes,
      }

      return {
        ok: true,
        served: {
          output,
          detail: keyed ? PROVIDER_DETAIL.authored : PROVIDER_DETAIL.authoredReused,
          fixture: { id: fixture.id, hash: null },
          latency_ms: simulatedLatencyMs(input_hash, fixture.latency_ms, 900),
        },
      }
    })
  }

  // -------------------------------------------------------------------------
  // search_parse
  // -------------------------------------------------------------------------

  async search_parse(input: SearchParseInput, options: AiCallOptions = {}): Promise<AiResult<SearchParseOutput>> {
    return this.run('search_parse', input, options, ({ input_hash }) => {
      const normalised = normaliseQuery(input.query_text)
      const authored = SEARCH_PARSE_BY_QUERY.get(normalised)

      if (authored) {
        const output = { ...authored.output }
        // A branch slug the caller did not supply is not a filter, it is an
        // invention. Drop it rather than send it.
        if (output.filters.branch_slug && !input.branch_slugs.includes(output.filters.branch_slug)) {
          output.filters = { ...output.filters, branch_slug: null }
        }
        return {
          ok: true,
          served: {
            output,
            detail: PROVIDER_DETAIL.authored,
            fixture: { id: authored.id, hash: null },
            latency_ms: simulatedLatencyMs(input_hash, authored.latency_ms, 200),
          },
        }
      }

      return {
        ok: true,
        served: {
          output: synthesiseParse(input),
          // Assembled by the synonym table, not by a model, and the row says so.
          detail: PROVIDER_DETAIL.synthetic,
          fixture: null,
          latency_ms: simulatedLatencyMs(input_hash, 220, 160),
        },
      }
    })
  }

  // -------------------------------------------------------------------------
  // gap_scan
  // -------------------------------------------------------------------------

  async gap_scan(input: GapScanInput, options: AiCallOptions = {}): Promise<AiResult<GapScanOutput>> {
    return this.run('gap_scan', input, options, ({ input_hash }) => {
      const authoredIds: string[] = []
      let synthesised = 0

      const cells = input.cells.slice(0, 40).map((cell) => {
        const fixture = GAP_SCAN_BY_SIGNATURE.get(cell.cell_signature)
        if (fixture) {
          authoredIds.push(fixture.id)
          return {
            // Echoed byte for byte. A signature this layer tidied would not
            // rejoin the computed cell it belongs to.
            cell_signature: cell.cell_signature,
            title: fixture.output.title,
            shot_instruction: fixture.output.shot_instruction,
            rationale: fixture.output.rationale,
            cluster_label: fixture.output.cluster_label,
          }
        }
        synthesised += 1
        return synthesiseCell(cell)
      })

      const output: GapScanOutput = {
        cells,
        // Echoed from the input, deduped. Inventing a vocabulary candidate nobody
        // typed would put a made up word into the taxonomy proposal queue.
        vocabulary_candidates: dedupe(input.unmapped_query_tokens.map((t) => t.trim()).filter(Boolean))
          .slice(0, 12)
          .map((t) => t.slice(0, 60)),
      }

      const detail =
        synthesised === 0
          ? PROVIDER_DETAIL.authored
          : authoredIds.length === 0
            ? PROVIDER_DETAIL.synthetic
            : PROVIDER_DETAIL.authoredPartial

      return {
        ok: true,
        served: {
          output,
          detail,
          fixture: authoredIds.length > 0 ? { id: authoredIds.join('+').slice(0, 200), hash: null } : null,
          latency_ms: simulatedLatencyMs(input_hash, 300 + cells.length * 120, 800),
        },
      }
    })
  }

  // -------------------------------------------------------------------------
  // nudge_draft
  // -------------------------------------------------------------------------

  async nudge_draft(input: NudgeDraftInput, options: AiCallOptions = {}): Promise<AiResult<NudgeDraftOutput>> {
    return this.run('nudge_draft', input, options, ({ input_hash }) => {
      const requested: NudgeTone = input.tone_hint ?? 'friendly'
      const fixture = NUDGE_BY_TONE.get(requested) ?? NUDGE_BY_TONE.get('friendly')!
      return {
        ok: true,
        served: {
          output: projectNudge(fixture.output, input, requested),
          detail: fixture.tone === requested ? PROVIDER_DETAIL.authored : PROVIDER_DETAIL.authoredReused,
          fixture: { id: fixture.id, hash: null },
          latency_ms: simulatedLatencyMs(input_hash, fixture.latency_ms, 700),
        },
      }
    })
  }

  // -------------------------------------------------------------------------
  // the one path every capability goes through
  // -------------------------------------------------------------------------

  private async run<K extends CapabilityKey>(
    kind: K,
    input: CapabilityIo[K]['input'],
    options: AiCallOptions,
    produce: (ctx: { input_hash: string }) => Production,
    /** Replaces the single sleep, for the one capability that streams. */
    stream?: (
      served: Served,
      step: (ms: number) => Promise<void>,
      signal: AbortSignal | undefined,
    ) => Promise<void>,
  ): Promise<AiResult<CapabilityIo[K]['output']>> {
    const signal = options.signal
    throwIfAborted(signal, { kind })

    const input_hash = await hashOf(input)
    // Rendering the real prompt and discarding it is not waste: renderTemplate
    // throws on an unfilled slot, so a template that has drifted from its input
    // shape fails in the only mode this build runs rather than on the first live
    // call, which by decision U7 never happens.
    const prompt = await renderPrompt(kind, promptValuesFor(kind, input))
    const key: CacheKey = { input_hash, prompt_hash: prompt.prompt_hash, model_key: modelKeyFor('mock') }

    const partialMeta: Partial<AiMeta> = {
      kind,
      provider: 'mock',
      prompt_key: kind,
      prompt_version: prompt.prompt_version,
      prompt_hash: prompt.prompt_hash,
      input_hash,
      model_key: key.model_key,
    }

    const cached = this.cache.get<CachedServed>(key)
    if (cached) {
      // A cache hit really is instant, and the fixture's latency is a property of
      // the answer rather than of this call, so it is reported unchanged and the
      // sleep is skipped. That keeps two identical calls byte identical.
      return this.finish(kind, cached, prompt, input_hash)
    }

    const production = produce({ input_hash })

    if (!production.ok) {
      const failure = production.failure
      await this.sleep(failure.latency_ms, signal)
      throwIfAborted(signal, partialMeta)
      throw new AiError(failure.reason, failure.message, {
        meta: buildMeta({
          kind,
          provider: 'mock',
          provider_detail: failure.detail ?? PROVIDER_DETAIL.authored,
          prompt,
          input_hash,
          fixture: { id: failure.id, hash: null },
          latency_ms: failure.latency_ms,
          status: failure.reason === 'refused' ? 'refused' : 'error',
          error_code: failure.reason,
          schema_valid: failure.reason !== 'invalid_output',
        }),
        rawOutput: failure.raw_output,
      })
    }

    const served = production.served
    const step = async (ms: number): Promise<void> => {
      await this.sleep(ms, signal)
    }
    if (stream) {
      await stream(served, step, signal)
    } else {
      await step(served.latency_ms)
    }
    throwIfAborted(signal, partialMeta)

    this.cache.set(key, served)
    return this.finish(kind, served, prompt, input_hash)
  }

  /** Validation and meta, shared by the fresh path and the cache hit. */
  private finish<K extends CapabilityKey>(
    kind: K,
    served: Served,
    prompt: RenderedPrompt,
    input_hash: string,
  ): AiResult<CapabilityIo[K]['output']> {
    const schema = schemaFor(kind)
    const result = validate<CapabilityIo[K]['output']>(schema.schema, served.output)

    if (!result.ok) {
      throw new AiError(
        'invalid_output',
        `A mock response failed its own capability schema, which means the fixture and the schema have diverged:\n${formatErrors(result.errors)}`,
        {
          meta: buildMeta({
            kind,
            provider: 'mock',
            provider_detail: served.detail,
            prompt,
            input_hash,
            fixture: served.fixture,
            latency_ms: served.latency_ms,
            status: 'error',
            error_code: 'invalid_output',
            schema_valid: false,
          }),
          validationErrors: result.errors,
          rawOutput: served.output,
        },
      )
    }

    return {
      output: result.value,
      meta: buildMeta({
        kind,
        provider: 'mock',
        provider_detail: served.detail,
        prompt,
        input_hash,
        fixture: served.fixture,
        latency_ms: served.latency_ms,
      }),
    }
  }

  /**
   * A keyed failure, if this attempt is still inside its failure count.
   *
   * The counter is per instance and per subject, which is what makes "fails once,
   * then succeeds" reproducible: a fresh provider replays the same sequence.
   */
  private failureFor(
    kind: CapabilityKey,
    subjectId: string,
    table: ReadonlyMap<string, AuthoredFailure>,
  ): AuthoredFailure | null {
    if (this.conditions.disableFailures) return null
    const failure = table.get(subjectId)
    if (!failure) return null
    const budget = failure.failures ?? Number.POSITIVE_INFINITY
    const slot = `${kind}:${subjectId}`
    const seen = this.attempts.get(slot) ?? 0
    this.attempts.set(slot, seen + 1)
    return seen < budget ? failure : null
  }
}

// ---------------------------------------------------------------------------
// projections: authored prose plus echoed identifiers
// ---------------------------------------------------------------------------

/** Deterministic pick from a pool, so an un-keyed subject still gets a stable answer. */
function pickByHash<T>(pool: readonly T[], inputHash: string): T {
  const n = Number.parseInt(inputHash.slice(0, 8), 16)
  const index = Number.isFinite(n) ? n % pool.length : 0
  return pool[index]!
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Vetting: quotes and citations come from the input, never from the fixture.
 *
 * A risk flag names which supplied field its quote must come from. If that field
 * is empty the flag arrives with no quote and `checkVet` drops it before a human
 * sees it, which is the correct outcome: an unevidenced adjective about a named
 * person is the highest damage output in this product.
 */
function projectVet(body: VetOutputBody, input: VetInput, injected: string | null): VetOutput {
  const quoteFor = (source: VetOutputBody['risk_flags'][number]['quote_source']): string | null => {
    if (source === 'application_note') return input.application_note?.slice(0, 300) ?? null
    if (source === 'scorecard_summary') return input.scorecard_summary?.slice(0, 300) ?? null
    if (source === 'injection_match') return injected
    return null
  }

  return {
    band: body.band,
    score: body.score,
    reasons: body.reasons.slice(0, 6).map((reason) => ({
      claim: reason.claim,
      // A citation of a field the caller did not supply is not evidence. Rewriting
      // it to none means the UI renders it as unsupported instead of as proof.
      cited_field: supports(reason.cited_field, input) ? reason.cited_field : 'none',
      direction: reason.direction,
    })),
    risk_flags: body.risk_flags.slice(0, 5).map((flag) => ({
      code: flag.code,
      evidence_quote: quoteFor(flag.quote_source),
      severity: flag.severity,
    })),
    suggested_tier: body.suggested_tier,
    tier_rationale: body.tier_rationale,
    caveat: body.caveat,
  }
}

function supports(field: VetCitableField, input: VetInput): boolean {
  switch (field) {
    case 'display_name':
      return input.display_name.trim().length > 0
    case 'primary_handle':
      return input.primary_handle.trim().length > 0
    case 'platforms':
      return input.platforms.length > 0
    case 'follower_count':
      return input.platforms.some((p) => p.followers !== null)
    case 'prior_collabs':
      return true // always supplied, and zero is itself evidence
    case 'scorecard':
      return input.scorecard_summary !== null && input.scorecard_summary.trim().length > 0
    case 'application_note':
      return input.application_note !== null && input.application_note.trim().length > 0
    default:
      return false
  }
}

/**
 * Brief generation: sequence numbers and gap links are assigned here.
 *
 * `origin_gap_signature` is echoed from the caller's gap list by position, so an
 * item can only claim to close a gap the caller actually supplied. That link is
 * what makes the loop's headline claim provable from the data.
 */
function projectBriefGen(body: BriefGenOutputBody, input: BriefGenInput): BriefGenOutput {
  const target = Math.max(1, Math.min(24, input.target_item_count))
  const chosen = body.items.slice(0, target)
  const seqByPoolIndex = new Map<number, number>()

  const items: BriefGenItem[] = chosen.map((item, index) => {
    seqByPoolIndex.set(index, index + 1)
    const gap = item.origin_gap_index === null ? undefined : input.gaps[item.origin_gap_index]
    return {
      seq: index + 1,
      instruction: item.instruction,
      shot_type: item.shot_type,
      room: item.room,
      subjects: item.subjects.slice(0, 4),
      min_takes: item.min_takes,
      origin_gap_signature: gap ? gap.cell_signature : null,
      why: item.why,
      feasibility_doubt: item.feasibility_doubt,
    }
  })

  return {
    items,
    caption_angles: body.caption_angles.slice(0, 5),
    possible_overlaps: body.possible_overlaps
      .filter((pair) => seqByPoolIndex.has(pair.a) && seqByPoolIndex.has(pair.b))
      .map((pair) => ({
        seq_a: seqByPoolIndex.get(pair.a)!,
        seq_b: seqByPoolIndex.get(pair.b)!,
        note: pair.note,
      }))
      .slice(0, 6),
  }
}

/**
 * A nudge draft: authored prose, every fact substituted from the input.
 *
 * The deadline line is absent unless a deadline was supplied, so "no deadline you
 * were not given" is enforced by the shape rather than by trusting the prose. The
 * item list is built from the human-confirmed missing items only.
 */
function projectNudge(body: NudgeOutputBody, input: NudgeDraftInput, requested: NudgeTone): NudgeDraftOutput {
  const items = input.missing_items.slice(0, 5)
  const extra = input.missing_items.length - items.length
  const itemLines = [
    ...items.map((item) => `- ${item.instruction.slice(0, 100)}`),
    ...(extra > 0 ? [`- and ${extra} more on the list`] : []),
  ].join('\n')

  const deadlineLine = input.deadline_text ? ` If you can, before ${input.deadline_text}.` : ''

  const substitute = (text: string): string =>
    text
      .replaceAll('%NAME%', input.creator_display_name)
      .replaceAll('%CITY%', input.branch_city)
      .replaceAll('%VISIT_DATE%', input.visit_date_text)
      .replaceAll('%DELIVERED%', String(input.delivered_count))
      .replaceAll('%PROMISED%', String(input.promised_count))
      .replaceAll('%ITEMS%', itemLines)
      .replaceAll('%DEADLINE_LINE%', deadlineLine)

  const warnings = [...body.warnings]
  if (input.delivered_count > input.promised_count) {
    warnings.push(
      'The delivered count is higher than the promised count. Check the diff before sending: this message says they are short.',
    )
  }
  if (input.missing_items.length > Math.max(0, input.promised_count - input.delivered_count)) {
    warnings.push(
      'More items are listed as missing than the counts imply. One of the two numbers is wrong and the message uses both.',
    )
  }
  if (body.tone !== requested) {
    warnings.push(`A ${requested} tone was asked for and this draft reads ${body.tone}. Adjust before sending.`)
  }

  return {
    subject_line: substitute(body.subject_line).slice(0, 90),
    body_text: fitBody(substitute(body.body_text)),
    tone: body.tone,
    // Echoed, so the draft cannot name a shot the diff did not find missing.
    missing_item_ids: input.missing_items.map((item) => item.brief_item_id).slice(0, 24),
    mentions_deadline: deadlineLine !== '',
    warnings: warnings.slice(0, 4).map((w) => w.slice(0, 160)),
  }
}

/**
 * Keeps a substituted body inside the schema bound.
 *
 * Trims whole trailing paragraphs rather than cutting mid sentence, because a
 * draft that stops halfway through a word reads as a bug and will be sent anyway
 * by somebody in a hurry.
 */
function fitBody(text: string, limit = 900): string {
  if (text.length <= limit) return text
  const paragraphs = text.split('\n\n')
  while (paragraphs.length > 2 && paragraphs.join('\n\n').length > limit) paragraphs.pop()
  const trimmed = paragraphs.join('\n\n')
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit)
}

/**
 * Phrasing for a coverage cell nobody authored.
 *
 * Deliberately plain. It reads the supplied facets and signal summary back, which
 * is honest and dull, and it is recorded as `synthetic-v1` so nobody mistakes it
 * for a model's phrasing. If a demo shows a lot of these, the fixture set needs
 * widening rather than the label softening.
 */
function synthesiseCell(cell: GapScanInput['cells'][number]): GapScanOutput['cells'][number] {
  const facets = cell.facets.trim()
  const readable = facets.replace(/[|]/g, ', ').replace(/_/g, ' ')
  return {
    cell_signature: cell.cell_signature,
    title: `Uncovered: ${readable}`.slice(0, 60),
    shot_instruction: `Film one shot covering ${readable}, vertical, one steady take.`.slice(0, 200),
    rationale: `Computed from the supplied signals: ${cell.signal_summary}`.slice(0, 200),
    cluster_label: null,
  }
}

// ---------------------------------------------------------------------------
// the synthetic query parser: the synonym table doing the model's job
// ---------------------------------------------------------------------------

const FILTER_CAPS: Record<'subjects' | 'shot_types' | 'rooms' | 'light' | 'vibes', number> = {
  subjects: 6,
  shot_types: 4,
  rooms: 4,
  light: 3,
  vibes: 3,
}

export function synthesiseParse(input: SearchParseInput): SearchParseOutput {
  const normalised = normaliseQuery(input.query_text)
  let remaining = ` ${normalised} `
  const mappings: SearchParseOutput['mappings'] = []

  const take = (phrase: string, facet: Facet, term: string, confidence: number): void => {
    mappings.push({ raw: phrase.slice(0, 80), facet, term: term.slice(0, 64), confidence })
    remaining = remaining.replace(` ${phrase} `, '  ')
  }

  /** For a match that is not surrounded by single spaces, such as a duration phrase. */
  const takeRaw = (matched: string, facet: Facet, term: string, confidence: number): void => {
    mappings.push({ raw: matched.slice(0, 80), facet, term: term.slice(0, 64), confidence })
    remaining = remaining.replace(matched, ' ')
  }

  // Longest phrases first, so "warm light" is not eaten by "light".
  const phrases = [...SYNONYMS].sort((a, b) => b.phrase.length - a.phrase.length)
  for (const entry of phrases) {
    if (remaining.includes(` ${entry.phrase} `)) take(entry.phrase, entry.facet, entry.term, entry.confidence)
  }

  const taxonomyPhrases = [...TAXONOMY_LOOKUP.keys()].sort((a, b) => b.length - a.length)
  for (const phrase of taxonomyPhrases) {
    if (remaining.includes(` ${phrase} `)) {
      const hit = TAXONOMY_LOOKUP.get(phrase)!
      take(phrase, hit.facet, hit.term, 0.95)
    }
  }

  // A branch is only ever one the caller supplied.
  let branch_slug: string | null = null
  for (const slug of input.branch_slugs) {
    const words = slug.replace(/^branch-/, '').replace(/-/g, ' ')
    if (remaining.includes(` ${words} `)) {
      branch_slug = slug
      take(words, 'branch', slug, 0.9)
      break
    }
  }

  let duration_min_s: number | null = null
  let duration_max_s: number | null = null
  const under = /(?:under|less than|shorter than)\s+(\d{1,4})\s*(?:s|sec|secs|second|seconds)?/.exec(remaining)
  if (under) {
    duration_max_s = Number(under[1])
    takeRaw(under[0], 'duration', `max ${duration_max_s}s`, 0.9)
  }
  const over = /(?:over|longer than|at least)\s+(\d{1,4})\s*(?:s|sec|secs|second|seconds)?/.exec(remaining)
  if (over) {
    duration_min_s = Number(over[1])
    takeRaw(over[0], 'duration', `min ${duration_min_s}s`, 0.9)
  }

  const byFacet = (facet: Facet): string[] =>
    dedupe(mappings.filter((m) => m.facet === facet).map((m) => m.term))

  const orientationTerm = byFacet('orientation')[0]
  const unmapped = dedupe(
    remaining
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !STOPWORDS.has(token) && !/^\d+$/.test(token)),
  )

  const filters: SearchParseOutput['filters'] = {
    subjects: byFacet('subject').slice(0, FILTER_CAPS.subjects) as Subject[],
    shot_types: byFacet('shot_type').slice(0, FILTER_CAPS.shot_types) as SearchParseOutput['filters']['shot_types'],
    rooms: byFacet('room').slice(0, FILTER_CAPS.rooms) as SearchParseOutput['filters']['rooms'],
    light: byFacet('light').slice(0, FILTER_CAPS.light) as SearchParseOutput['filters']['light'],
    vibes: byFacet('vibe').slice(0, FILTER_CAPS.vibes) as SearchParseOutput['filters']['vibes'],
    orientation: (orientationTerm ?? null) as SearchParseOutput['filters']['orientation'],
    branch_slug,
    duration_min_s,
    duration_max_s,
  }

  const boostable = new Set<string>([
    ...filters.subjects,
    ...filters.shot_types,
    ...filters.rooms,
    ...filters.light,
    ...filters.vibes,
  ])

  return {
    filters,
    mappings: mappings.slice(0, 12),
    unmapped: unmapped.slice(0, 8).map((t) => t.slice(0, 80)),
    ranking: {
      order_by: DEFAULT_ORDERING,
      boost_terms: [...boostable].slice(0, 6),
    },
  }
}

export function createMockProvider(deps: MockDeps = {}): MockAiProvider {
  return new MockAiProvider(deps)
}
