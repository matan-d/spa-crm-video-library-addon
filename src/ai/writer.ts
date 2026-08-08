/**
 * The `ai_run` writer, the enqueue guard, and the vision projection.
 *
 * Three jobs that belong together because they are the same rule seen from three
 * angles: an AI field may only exist as the projection of a run, a run may only
 * exist if there was something to look at, and a run may never misrepresent what
 * produced it.
 *
 * ## Every write goes through the scoped repository
 *
 * Nothing here opens a transaction. `ai_run` is written with `repo.create`, so the
 * envelope, the boolean mirrors and the outbox entry are all handled in the one
 * layer that owns them. A consequence worth stating: an editor session cannot write
 * a run at all, because `ai_run` is read only in the editor allowlist, and the
 * repository throws rather than silently doing nothing.
 *
 * ## Append only, and `is_current` is a flip
 *
 * A re-run never mutates the previous row. It inserts, then flips the old row's
 * `is_current` and records `superseded_by_run_id`. Two reasons: `output_json` is
 * kept verbatim so an old run can be re-projected under a new prompt version
 * without a new call, and keeping the superseded mock rows is what lets somebody
 * later diff what the mock predicted against what a real model produced on the
 * same input.
 *
 * ## The guard that matters most
 *
 * `assertVisionEnqueueAllowed` refuses a vision run for an asset with no
 * `sheet_key`. The HEVC clip in the seeded delivery is exactly this case: nothing
 * this runtime ships can decode it, so there is no contact sheet, so there is
 * nothing to describe. A plausible tag on a clip nobody could decode is the least
 * detectable and most damaging failure available in this product, and the refusal
 * lives here rather than in a component because a component is where it would be
 * forgotten.
 *
 * Note the field name. `CLAUDE.md` and the architecture review both say `sheet_id`;
 * the implemented `Asset` carries `sheet_key`. The code follows the code.
 */

import type { ScopedRepo } from '@/data/repo'
import type { AiProvenance, AiRun, Asset, Envelope, Tag } from '@/data/types'
import { assertProvenance } from './meta'
import { brandSafetyFrom, bucketToScore, checkVisionTag, type PostCheckNote } from './postchecks'
import { AiError, type AiMeta, type VisionTagOutput } from './provider'

/** The minimum an asset has to prove before a vision run is allowed to exist. */
export interface VisionCandidate {
  id: string
  sheet_key: string | null
  /** Only read for the refusal message, so a human is told which stage failed. */
  derivative_state?: Asset['derivative_state']
  codec_video?: string | null
  client_decodable?: boolean | null
}

export type EnqueueRefusalReason = 'no_sheet' | 'no_derivatives'

export interface EnqueueRefusal {
  asset_id: string
  reason: EnqueueRefusalReason
  /** Written for a human. This ends up in the "awaiting derivatives" bucket. */
  explanation: string
}

/**
 * Throws unless this asset has a contact sheet.
 *
 * `no_stills` rather than a generic error, because the caller has a specific UI
 * state for it: approval disabled with a stated reason, no tags, and no AI badge of
 * any kind. Not an amber "simulated" badge either, because nothing was simulated.
 *
 * The evidence is the asset row's `sheet_key`, and nothing else. The media track
 * reports that no contact sheet has yet been produced by `src/media` code in this
 * build: every committed sheet came from the ffmpeg seed generator, and the seeded
 * rows carry a `sheet_key` pointing at one. So "a sheet exists" must mean "this row
 * says where it is", never "the pipeline can probably make one" and never "a blob
 * with a plausible key might be in the store". Anything looser and the HEVC clip
 * becomes taggable the moment somebody optimistically pre-fills a key.
 */
export function assertVisionEnqueueAllowed(asset: VisionCandidate): void {
  if (asset.sheet_key && asset.sheet_key.trim() !== '') return
  const codec = asset.codec_video ? ` (${asset.codec_video})` : ''
  throw new AiError(
    'no_stills',
    `Asset ${asset.id} has no contact sheet${codec}, so it cannot be tagged. ` +
      'No run row, no tags, and every AI field stays null. We do not guess what a clip we could not decode contains.',
    { meta: { kind: 'vision_tag' } },
  )
}

/**
 * Splits a batch into what can be tagged and what cannot, with a reason each.
 *
 * The batch runner needs both halves: a delivery where three clips never decoded
 * must show three explained tiles rather than twelve of fifteen and no explanation
 * of the difference.
 */
export function planVisionEnqueue(assets: readonly VisionCandidate[]): {
  enqueue: VisionCandidate[]
  refused: EnqueueRefusal[]
} {
  const enqueue: VisionCandidate[] = []
  const refused: EnqueueRefusal[] = []

  for (const asset of assets) {
    if (!asset.sheet_key || asset.sheet_key.trim() === '') {
      const undecodable = asset.client_decodable === false
      refused.push({
        asset_id: asset.id,
        reason: asset.derivative_state === 'none' && undecodable ? 'no_sheet' : 'no_derivatives',
        explanation: undecodable
          ? `Nothing in this runtime can decode ${asset.codec_video ?? 'this codec'}, so no frames were extracted and there is nothing for the model to look at.`
          : 'Derivatives have not been produced yet, so there is no contact sheet to analyse.',
      })
      continue
    }
    enqueue.push(asset)
  }

  return { enqueue, refused }
}

// ---------------------------------------------------------------------------
// the run row
// ---------------------------------------------------------------------------

export interface AiRunWriteInput {
  subject_type: string
  subject_id: string
  meta: AiMeta
  /** Verbatim, always. Null only when the failure happened before any payload existed. */
  output_json: unknown
}

/**
 * Writes one `ai_run` and supersedes the previous current run for the same subject
 * and kind.
 *
 * The provenance guard runs here as well as inside `buildMeta`, on purpose. A row
 * can also arrive from a test, from a future sync pull, or from code written after
 * this file, so the check belongs next to the write and not only next to the
 * construction. This is the local half of what a Postgres check constraint does on
 * the other side.
 */
export async function writeAiRun(repo: ScopedRepo, input: AiRunWriteInput): Promise<string> {
  assertProvenance(input.meta)

  const { meta } = input
  // Typed as the row minus the envelope, so a new column on `ai_run` fails here
  // rather than being silently omitted from every run this writer produces.
  const row: Omit<AiRun, keyof Envelope> = {
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    kind: meta.kind,
    provider: meta.provider,
    provider_detail: meta.provider_detail,
    // Null for mock, always. The guard above has already refused anything else.
    model_id: meta.model_id,
    simulated_model_id: meta.simulated_model_id,
    fixture_id: meta.fixture_id,
    effort: meta.effort,
    prompt_key: meta.prompt_key,
    prompt_version: meta.prompt_version,
    prompt_hash: meta.prompt_hash,
    input_hash: meta.input_hash,
    model_key: meta.model_key,
    schema_key: meta.schema_key,
    schema_version: meta.schema_version,
    schema_valid: meta.schema_valid,
    latency_ms: meta.latency_ms,
    // Simulated latency is data. Averaging it into a real performance number is the
    // failure this column exists to prevent.
    latency_source: meta.latency_source,
    status: meta.status,
    error_code: meta.error_code,
    output_json: input.output_json ?? null,
    is_current: true,
    // The repository writes every `_i` mirror from the schema's declared list, so
    // this is here only because the row type requires it. Nothing else should set a
    // mirror by hand.
    is_current_i: 1,
    superseded_by_run_id: null,
  }

  const runId = await repo.create('ai_run', row as unknown as Record<string, unknown>)

  // Supersede after the insert, so a crash between the two leaves two current rows
  // rather than none. Two is a visible glitch; none silently un-enriches an asset.
  const previous = await repo.list<AiRun>('ai_run', {
    index: 'by_current',
    key: [input.subject_type, input.subject_id, meta.kind, 1],
  })
  for (const run of previous) {
    if (run.id === runId) continue
    await repo.patch('ai_run', run.id, { is_current: false, superseded_by_run_id: runId })
  }

  return runId
}

/**
 * Writes the run row for a failed call.
 *
 * A failed run is still a run: it is how "the model refused" and "the response was
 * malformed" survive a page reload, and how the Data Health panel can report that
 * two of the seeded runs are errors. The malformed payload is kept verbatim so the
 * failure is inspectable later without a new call.
 */
export async function writeAiRunFailure(
  repo: ScopedRepo,
  args: { subject_type: string; subject_id: string; error: AiError },
): Promise<string | null> {
  const meta = args.error.meta
  // Without a complete meta there is nothing honest to write: a row with no prompt
  // hash and no input hash is not evidence of anything.
  if (!isCompleteMeta(meta)) return null
  return writeAiRun(repo, {
    subject_type: args.subject_type,
    subject_id: args.subject_id,
    meta,
    output_json: args.error.rawOutput ?? null,
  })
}

function isCompleteMeta(meta: Partial<AiMeta>): meta is AiMeta {
  return (
    typeof meta.kind === 'string' &&
    typeof meta.provider === 'string' &&
    typeof meta.prompt_hash === 'string' &&
    typeof meta.input_hash === 'string' &&
    typeof meta.model_key === 'string' &&
    typeof meta.schema_key === 'string' &&
    typeof meta.latency_source === 'string' &&
    typeof meta.status === 'string'
  )
}

// ---------------------------------------------------------------------------
// the vision projection
// ---------------------------------------------------------------------------

export type TagRow = Pick<Tag, 'asset_id' | 'term' | 'source' | 'confidence' | 'ai_run_id' | 'removed_at' | 'rejected_by_human'>

export interface VisionProjection {
  /** Only the AI band. Band one facts and band four human decisions are never touched. */
  asset_patch: Record<string, unknown>
  tags: TagRow[]
  /** What the deterministic post-checks changed, for the "why does it say that" panel. */
  notes: PostCheckNote[]
}

/**
 * Turns a validated vision response into the asset patch and the tag rows.
 *
 * Pure, so the projection is testable without a database and so the same function
 * can re-project an old `output_json` under a new prompt version. Everything it
 * writes is regenerable from the run row, which is what makes
 * `rebuildDerived({ sources: ['live'] })` possible later: wipe the AI band,
 * re-project from live runs only, and whatever comes back un-enriched is exactly
 * what the demo contributed.
 */
export function projectVisionTag(args: {
  asset_id: string
  run_id: string
  output: VisionTagOutput
  meta: AiMeta
  /** The asset's current provenance, so a second provider makes it `mixed`. */
  previous_provenance?: AiProvenance | null
}): VisionProjection {
  const { value, notes } = checkVisionTag(args.output)

  const asset_patch: Record<string, unknown> = {
    ai_description: value.description,
    ai_shot_type: value.shot_type,
    ai_room: value.room,
    ai_subjects: value.subjects,
    // A bucket encoded as one of three fixed numbers, never a score the model
    // produced. The bucket stays recoverable and nobody can read false precision
    // into 0.55.
    ai_quality_score: bucketToScore(value.light_quality),
    ai_framing_score: bucketToScore(value.framing),
    ai_confidence: value.overall_confidence,
    // Never `blocked`. A flag blocks publish; only a human blocks a clip.
    ai_brand_safety: brandSafetyFrom(value.review_flags),
    ai_provenance: mergeProvenance(args.previous_provenance ?? null, args.meta.provider),
  }

  const tags: TagRow[] = value.tags.map((tag) => ({
    asset_id: args.asset_id,
    term: tag.term,
    source: 'ai',
    confidence: tag.confidence,
    // Which run produced this exact tag. This is what makes a mock purge a single
    // cursor rather than "delete the tags on this asset", which would destroy the
    // human curation alongside it.
    ai_run_id: args.run_id,
    removed_at: null,
    rejected_by_human: false,
  }))

  return { asset_patch, tags, notes }
}

/**
 * The badge's source of truth.
 *
 * Two providers on one asset make it `mixed`, which is the case the badge exists
 * for: a badge driven by the current mode lies the moment the data is mixed.
 */
export function mergeProvenance(previous: AiProvenance | null, incoming: AiMeta['provider']): AiProvenance {
  if (previous === null || previous === 'none') return incoming
  if (previous === 'mixed') return 'mixed'
  return previous === incoming ? previous : 'mixed'
}

/**
 * The whole vision write, in the order the invariants require.
 *
 * The guard first, so an asset with no sheet leaves no trace of an attempt. Then the
 * run, so every tag can name the run that produced it. Then the projection, in one
 * patch, so an asset never shows half of one reading.
 */
export async function recordVisionTag(
  repo: ScopedRepo,
  args: {
    asset: VisionCandidate & { ai_provenance?: AiProvenance | null }
    output: VisionTagOutput
    meta: AiMeta
  },
): Promise<{ run_id: string; projection: VisionProjection }> {
  assertVisionEnqueueAllowed(args.asset)

  const run_id = await writeAiRun(repo, {
    subject_type: 'asset',
    subject_id: args.asset.id,
    meta: args.meta,
    output_json: args.output,
  })

  const projection = projectVisionTag({
    asset_id: args.asset.id,
    run_id,
    output: args.output,
    meta: args.meta,
    previous_provenance: args.asset.ai_provenance ?? null,
  })

  await repo.patch('asset', args.asset.id, projection.asset_patch)
  for (const tag of projection.tags) {
    await repo.create('tag', tag as unknown as Record<string, unknown>)
  }

  return { run_id, projection }
}

/**
 * Default subject for a run, per capability.
 *
 * `search_parse` has no row to hang off, so it uses the input hash as its subject
 * id: a query is not an entity in this schema, and inventing one would be a bigger
 * lie than a synthetic id. Everything else names a real row.
 */
export function defaultSubject(
  kind: AiMeta['kind'],
  ids: {
    creator_id?: string
    brief_id?: string
    asset_id?: string
    brief_item_id?: string
    gap_scan_id?: string
    collab_id?: string
    input_hash?: string
  },
): { subject_type: string; subject_id: string } {
  switch (kind) {
    case 'vet':
      return { subject_type: 'creator', subject_id: required(ids.creator_id, 'creator_id') }
    case 'brief_gen':
      return { subject_type: 'brief', subject_id: required(ids.brief_id, 'brief_id') }
    case 'vision_tag':
      return { subject_type: 'asset', subject_id: required(ids.asset_id, 'asset_id') }
    case 'brief_match':
      return { subject_type: 'brief_item', subject_id: required(ids.brief_item_id, 'brief_item_id') }
    case 'search_parse':
      return { subject_type: 'query', subject_id: required(ids.input_hash, 'input_hash') }
    case 'gap_scan':
      return { subject_type: 'gap_scan', subject_id: required(ids.gap_scan_id, 'gap_scan_id') }
    case 'nudge_draft':
      return { subject_type: 'collab', subject_id: required(ids.collab_id, 'collab_id') }
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`defaultSubject: ${name} is required for this run kind and was not supplied.`)
  return value
}
