/**
 * Running the vetting model from the creators roster.
 *
 * Vetting is the first place a model touches a person rather than a file, and
 * that changes what the seam has to guarantee. A wrong tag on a clip wastes an
 * editor's minute. A wrong risk flag on a creator is a person not booked, so the
 * rules here are about what the model is not allowed to do.
 *
 * 1. **It never gates.** `vet()` writes an advisory score and returns it. No
 *    lifecycle transition, no booking, no block. A `blocked` creator was blocked
 *    by a human and stays blocked; the model is not asked and cannot un-block.
 * 2. **The tier band is computed in code and the model may only choose inside
 *    it.** `allowed_tiers` comes from the reliability tier the scorecard measured.
 *    A model that could hand a full-day VIP visit to an unproven creator is a
 *    model with a budget, which is not what it was hired for.
 * 3. **The creator's own words are input, never instruction.** The application
 *    note is passed as data and the prompt fences it. This is the one field in
 *    the product an outsider writes, so it is the one injection surface.
 * 4. **The human override is untouched.** `fit_score_override` is a human
 *    decision and a re-vet must not clear it. If a manager already said 62, a
 *    later model run saying 88 changes the model's column and nothing else, and
 *    the roster keeps showing 62 in green.
 */

import type { ScopedRepo } from '@/data/repo'
import type { Branch, Collab, Creator, ReliabilityTier } from '@/data/types'
import { AiError, createAiProvider, writeAiRun, type AiMode, type AiProvider, type VetOutput } from '@/ai'

export interface VettingDeps {
  repo: ScopedRepo
  /** Always `mock` in this build. Named rather than assumed, so the seam shows. */
  mode?: AiMode
}

export type VettingOutcome =
  | { status: 'vetted'; runId: string; output: VetOutput }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; reason: string }

/**
 * The visit tiers a creator at this reliability level may be offered.
 *
 * Computed here, in code, and passed to the model as a closed list. The bands
 * widen with evidence: an unproven creator gets the cheapest visit the studio
 * can afford to have wasted, and a trusted one is eligible for everything.
 */
export function allowedTiers(tier: ReliabilityTier): string[] {
  switch (tier) {
    case 'trusted':
      return ['half_day', 'full_day', 'vip_full']
    case 'proven':
      return ['half_day', 'full_day']
    default:
      return ['half_day']
  }
}

function scorecardSummary(creator: Creator): string | null {
  const card = creator.scorecard
  if (!card || card.completed_collabs === 0) return null
  const pct = (value: number | null) => (value == null ? 'unknown' : `${Math.round(value * 100)}%`)
  return (
    `${card.completed_collabs} completed collabs, ` +
    `approval ${pct(card.approval_rate)}, promise kept ${pct(card.promise_kept_rate)}, ` +
    `${card.brand_safety_hits} brand safety hits, ${card.consent_problems} consent problems`
  )
}

/**
 * Vets one creator, or explains why it will not.
 *
 * A refusal is a first class outcome rather than an exception, for the same
 * reason it is on the tagger: "we did not score this and here is why" is
 * information, and throwing it turns it into a silent no-op.
 */
export async function vetCreator(
  deps: VettingDeps,
  creator: Creator,
  collabs: Collab[],
  branch: Branch | null,
  provider?: AiProvider,
): Promise<VettingOutcome> {
  if (creator.lifecycle === 'blocked') {
    return {
      status: 'refused',
      reason:
        'This creator was blocked by a human. Asking a model to re-score them would produce a number that looks like a second opinion on a decision the model was never part of.',
    }
  }

  const ai = provider ?? createAiProvider({ mode: deps.mode ?? 'mock' })

  try {
    const result = await ai.vet({
      creator_id: creator.id,
      display_name: creator.display_name,
      primary_handle: creator.primary_handle,
      platforms: creator.platforms.map((platform) => ({
        network: platform.network,
        handle: platform.handle,
        followers: platform.followers ?? null,
      })),
      // The creator's own words. Fenced in the prompt, never treated as
      // instruction: this is the only field an outsider writes.
      application_note: creator.notes,
      prior_collabs: collabs.length,
      scorecard_summary: scorecardSummary(creator),
      allowed_tiers: allowedTiers(creator.reliability_tier),
      branch_city: branch?.city ?? 'San Jose',
    })

    const runId = await writeAiRun(deps.repo, {
      subject_type: 'creator',
      subject_id: creator.id,
      meta: result.meta,
      output_json: result.output,
    })

    // A tier the band did not permit is dropped rather than stored. The band is
    // the code's decision and the model was told it; ignoring it is not a
    // suggestion worth keeping.
    const permitted = allowedTiers(creator.reliability_tier)
    const suggested =
      result.output.suggested_tier && permitted.includes(result.output.suggested_tier)
        ? result.output.suggested_tier
        : null

    await deps.repo.patch('creator', creator.id, {
      fit_score: result.output.score,
      fit_reasons: result.output.reasons.map((reason) => reason.claim),
      risk_flags: result.output.risk_flags.map((flag) => flag.code),
      suggested_tier: suggested,
      // fit_score_override and override_reason are deliberately absent: a human
      // decision is not something a later model run gets to revise.
    })

    return { status: 'vetted', runId, output: result.output }
  } catch (error) {
    if (error instanceof AiError) return { status: 'failed', reason: `${error.reason}: ${error.message}` }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Records a human overriding the model's score.
 *
 * The reason is required, not optional. An override with no reason is
 * indistinguishable from a typo six months later, and the whole value of keeping
 * the human number in a separate column is that it carries an explanation the
 * model's number cannot.
 */
export async function overrideFitScore(
  repo: ScopedRepo,
  creatorId: string,
  score: number | null,
  reason: string,
): Promise<void> {
  if (score != null && reason.trim().length === 0) {
    throw new Error('An override needs a reason. A number with no explanation is not a decision.')
  }
  await repo.patch('creator', creatorId, {
    fit_score_override: score,
    override_reason: score == null ? null : reason.trim(),
  })
}
