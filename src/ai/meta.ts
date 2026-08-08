/**
 * Where provenance is decided, once, for all three implementations.
 *
 * `buildMeta` is the only sanctioned way to produce an `AiMeta`, and it derives
 * `model_id`, `simulated_model_id`, `model_key` and `latency_source` from the
 * provider rather than accepting them from a caller. That is deliberate: the
 * dishonest states this layer exists to prevent are all states a caller could
 * otherwise assemble by accident, and the most damaging one (a mock run claiming
 * a model produced it) is exactly the kind of field a busy call site copies from
 * the wrong variable.
 *
 * `assertProvenance` is the second belt. It runs again inside the `ai_run`
 * writer, because a row can also arrive from a test, from a future sync pull, or
 * from code written after this file, and the guard has to sit next to the write
 * rather than next to the construction. The architecture review calls for both:
 * a database check constraint and a local write guard.
 *
 * ## One deliberate deviation from docs/01-architecture-review.md C2.A
 *
 * The Postgres constraint in C2.A requires `fixture_id is null` for a mock run.
 * That was written before U8 settled that the mock's responses are authored
 * offline by a model looking at the real contact sheets and committed as
 * fixtures. Under U8 a mock run genuinely was served from a named committed
 * fixture, and dropping that name would remove the only way to answer "which
 * authored answer produced this tag". So `fixture_id` is allowed on a mock run
 * here, and the invariant that actually matters is unchanged and enforced:
 * `model_id` is null for mock, always. Recorded as D16 in docs/06-decisions.md,
 * and the future Postgres constraint has to be widened to match.
 */

import type { AiProvider as AiProviderKind } from '@/data/types'
import { modelKeyFor } from './cache'
import { MODEL_ID, SIMULATED_MODEL_ID } from './prompts'
import type { AiMeta, Effort } from './provider'
import type { CapabilityKey } from './schemas'
import { schemaFor } from './schemas'

/** Provider detail strings. Recorded per run so a reviewer can tell these apart. */
export const PROVIDER_DETAIL = {
  /** A real call to Claude through the Netlify function. Never used in this build. */
  live: 'claude-via-netlify',
  /** A captured real response, replayed from a committed fixture. */
  replay: 'fixture',
  /** A response authored offline by a model that looked at the real artefact (U8). */
  authored: 'authored-fixture-v1',
  /**
   * An authored fixture served for an input it was not authored against.
   *
   * Still mock, still simulated, and named differently on purpose: it is the
   * honest difference between "a model looked at this image" and "a model looked
   * at one of these images". Nothing downstream may treat the two as the same.
   */
  authoredReused: 'authored-fixture-v1-reused',
  /**
   * A batch answer where some parts were authored and some were assembled in code.
   *
   * Only the gap scan can be in this state: it phrases N computed cells in one
   * call, and a fixture set does not have to cover every cell the scan can
   * produce. Recorded distinctly so a demo showing a lot of these reads as a
   * fixture set that needs widening rather than as authored judgement.
   */
  authoredPartial: 'authored-fixture-v1-partial',
  /** Output assembled by local deterministic code, never seen by any model. */
  synthetic: 'synthetic-v1',
} as const

export type ProviderDetail = (typeof PROVIDER_DETAIL)[keyof typeof PROVIDER_DETAIL]

export interface MetaInput {
  kind: CapabilityKey
  provider: AiProviderKind
  provider_detail: ProviderDetail
  /** From `renderPrompt`, so version, hash and effort cannot drift from each other. */
  prompt: { prompt_version: string; prompt_hash: string; effort: Effort }
  input_hash: string
  fixture?: { id: string; hash: string | null } | null
  latency_ms: number | null
  status?: 'ok' | 'error' | 'refused'
  error_code?: string | null
  schema_valid?: boolean
}

/**
 * The one constructor for run metadata.
 *
 * Note what a caller cannot pass: `model_id`, `simulated_model_id`, `model_key`
 * and `latency_source`. All four are functions of the provider, and making them
 * arguments would make the lie expressible.
 */
export function buildMeta(input: MetaInput): AiMeta {
  const schema = schemaFor(input.kind)
  const isLive = input.provider === 'live'

  const meta: AiMeta = {
    kind: input.kind,
    provider: input.provider,
    provider_detail: input.provider_detail,
    // Null for mock, always. A replayed response really did come from this model,
    // so replay records it, which is the whole difference between the two.
    model_id: input.provider === 'mock' ? null : MODEL_ID,
    simulated_model_id: input.provider === 'mock' ? SIMULATED_MODEL_ID : null,
    fixture_id: input.fixture?.id ?? null,
    fixture_hash: input.fixture?.hash ?? null,
    effort: input.prompt.effort,
    prompt_key: input.kind,
    prompt_version: input.prompt.prompt_version,
    prompt_hash: input.prompt.prompt_hash,
    input_hash: input.input_hash,
    model_key: modelKeyFor(input.provider),
    schema_key: schema.schema_key,
    schema_version: schema.schema_version,
    schema_valid: input.schema_valid ?? true,
    latency_ms: input.latency_ms,
    // Only a real call measures anything. Everything else is reading a number off
    // a fixture, and averaging those into a performance figure would be a lie
    // told by arithmetic rather than by a field.
    latency_source: isLive ? 'measured' : 'simulated',
    status: input.status ?? 'ok',
    error_code: input.error_code ?? null,
  }

  assertProvenance(meta)
  return meta
}

export interface ProvenanceViolation {
  field: string
  message: string
}

/** Thrown by the write guard. Distinct from `AiError`, because this is our bug, not the model's. */
export class AiProvenanceError extends Error {
  constructor(readonly violations: readonly ProvenanceViolation[]) {
    super(
      `An ai_run would have recorded dishonest provenance and was refused: ${violations
        .map((v) => `${v.field}: ${v.message}`)
        .join('; ')}`,
    )
    this.name = 'AiProvenanceError'
  }
}

/**
 * The invariants, stated once, checked wherever a run is built or written.
 *
 * The provider field is the claim; every other field here either supports it or
 * contradicts it. A contradiction is refused rather than corrected, because
 * quietly nulling a `model_id` on a mock run would hide the bug that put it
 * there.
 */
export function provenanceViolations(
  meta: Pick<
    AiMeta,
    | 'provider'
    | 'model_id'
    | 'simulated_model_id'
    | 'fixture_id'
    | 'latency_source'
    | 'model_key'
    | 'prompt_key'
    | 'prompt_hash'
    | 'input_hash'
  >,
): ProvenanceViolation[] {
  const out: ProvenanceViolation[] = []
  const providers: AiProviderKind[] = ['live', 'replay', 'mock']

  if (!providers.includes(meta.provider)) {
    out.push({ field: 'provider', message: `must be one of live, replay, mock, got "${meta.provider}"` })
    return out
  }

  if (meta.provider === 'mock') {
    if (meta.model_id !== null) {
      out.push({
        field: 'model_id',
        message: `a mock run may never name a model, and this one claims "${meta.model_id}"`,
      })
    }
    if (!meta.simulated_model_id) {
      out.push({
        field: 'simulated_model_id',
        message: 'a mock run must say what it imitates, so the badge can name it without asserting it',
      })
    }
    if (meta.latency_source !== 'simulated') {
      out.push({
        field: 'latency_source',
        message: 'a mock run measured nothing, so its latency must be marked simulated',
      })
    }
  } else {
    if (!meta.model_id) {
      out.push({
        field: 'model_id',
        message: `a ${meta.provider} run came from a real model and must record which one`,
      })
    }
    if (meta.simulated_model_id !== null) {
      out.push({
        field: 'simulated_model_id',
        message: 'only a mock imitates a model; a real response does not simulate one',
      })
    }
  }

  if (meta.provider === 'live') {
    if (meta.fixture_id !== null) {
      out.push({ field: 'fixture_id', message: 'a live call read no fixture' })
    }
    if (meta.latency_source !== 'measured') {
      out.push({ field: 'latency_source', message: 'a live call measured its own latency' })
    }
  }

  if (meta.provider === 'replay' && !meta.fixture_id) {
    out.push({
      field: 'fixture_id',
      message: 'a replayed run must name the fixture it came from, or it is indistinguishable from a live call',
    })
  }

  const expectedKey = modelKeyFor(meta.provider)
  if (meta.model_key !== expectedKey) {
    out.push({
      field: 'model_key',
      message: `must be "${expectedKey}" for a ${meta.provider} run, so the cache cannot hand a synthetic answer to a caller that asked for a real one`,
    })
  }

  for (const field of ['prompt_key', 'prompt_hash', 'input_hash'] as const) {
    if (!meta[field]) {
      out.push({ field, message: 'is required: a run nobody can trace back to a prompt and an input is not evidence' })
    }
  }

  return out
}

export function assertProvenance(meta: Parameters<typeof provenanceViolations>[0]): void {
  const violations = provenanceViolations(meta)
  if (violations.length > 0) throw new AiProvenanceError(violations)
}

/**
 * A simulated latency, derived from the input hash rather than from a PRNG.
 *
 * A seeded `Rng` would have been the obvious choice and is the wrong one here: an
 * Rng advances with call order, so the same clip analysed second rather than
 * first would report a different think time, and two runs of the same demo in a
 * different order would stop being byte identical. A pure function of the input
 * hash has neither problem, needs no injected state, and is still varied enough
 * that the UI is not developed against one constant.
 */
export function simulatedLatencyMs(inputHash: string, baseMs: number, spreadMs = 400): number {
  const nibble = Number.parseInt(inputHash.slice(0, 4), 16)
  if (!Number.isFinite(nibble)) return baseMs
  return baseMs + (nibble % (spreadMs + 1))
}
