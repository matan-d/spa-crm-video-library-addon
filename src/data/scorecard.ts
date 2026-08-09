/**
 * The creator scorecard, computed from rows rather than remembered.
 *
 * This is the second feedback loop, and the half of it that has to exist before
 * the other half is worth building. Vetting proposes a fit score for a creator
 * nobody has worked with; reliability is what actually happened afterwards. If
 * reliability stays a stored number that somebody typed, then vetting can never
 * be scored against reality and the loop is decorative.
 *
 * So every figure here is derived, every figure names its denominator, and a
 * figure with no denominator is `null` rather than zero.
 *
 * ## Why null and not zero
 *
 * A creator with no completed collabs has no approval rate. Rendering that as
 * 0% would put a brand new creator below a creator who genuinely delivers badly,
 * which inverts the exact judgement this panel exists to support. This is the
 * same four-valued discipline pre-flight uses: absent evidence is absent, never
 * a failure.
 *
 * ## Why the stored value is kept and shown next to the computed one
 *
 * `creator.scorecard` is a denormalised cache, and the seed writes one. Silently
 * preferring the computed value would hide a drift that means something: if the
 * two disagree, either the cache is stale or the derivation is wrong, and both
 * are worth seeing. The panel shows the computed figure and flags the drift.
 *
 * ## Why this lives in `src/data` rather than next to the surface that shows it
 *
 * The seed writes the cache and the roster reads it, so both need the same
 * arithmetic, and a seed that imported from `src/app` would invert the layering.
 * This is pure logic over row types with no repository, no store and no Vue in
 * it, which is the same reason `signatureOf` sits in `src/data/seed.ts`.
 */

import type { Asset, Brief, BriefItem, Collab, Creator, Delivery } from './types'

export interface ComputedScorecard {
  /** Collabs that reached a terminal state with footage, not collabs created. */
  completed_collabs: number
  /** Assets a human approved, over assets a human ruled on. Null with no rulings. */
  approval_rate: number | null
  /** Approved-and-published assets over locked brief items. Null with no locked brief. */
  promise_kept_rate: number | null
  /** Denominators, so a rate is never a number with no story behind it. */
  assets_ruled_on: number
  assets_approved: number
  brief_items_promised: number
  brief_items_delivered: number
  /** Collabs that ended with nothing delivered. A different failure to a low rate. */
  ghosted: number
}

export interface ScoredCreator {
  creator: Creator
  computed: ComputedScorecard
  /** The stored cache disagrees with the derivation, field by field. */
  drift: string[]
  /**
   * The number a manager should act on: the human override where one exists,
   * otherwise the model's score, otherwise nothing.
   *
   * `source` is what the colour encodes. Deep green means a human decided it,
   * amber means a model produced it, and there is no third styling for "we
   * guessed": a creator with neither reads as unscored.
   */
  effective_score: number | null
  effective_source: 'human' | 'model' | 'none'
}

/** Rounds to three places so a float comparison against a stored value is stable. */
function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * 1000) / 1000
}

export interface ScorecardInput {
  creators: Creator[]
  collabs: Collab[]
  deliveries: Delivery[]
  assets: Asset[]
  briefs: Brief[]
  briefItems: BriefItem[]
}

export function computeScorecards(input: ScorecardInput): ScoredCreator[] {
  const collabsByCreator = new Map<string, Collab[]>()
  for (const collab of input.collabs) {
    const list = collabsByCreator.get(collab.creator_id) ?? []
    list.push(collab)
    collabsByCreator.set(collab.creator_id, list)
  }

  const assetsByCollab = new Map<string, Asset[]>()
  for (const asset of input.assets) {
    if (!asset.collab_id) continue
    const list = assetsByCollab.get(asset.collab_id) ?? []
    list.push(asset)
    assetsByCollab.set(asset.collab_id, list)
  }

  const briefsByCollab = new Map<string, Brief[]>()
  for (const brief of input.briefs) {
    const list = briefsByCollab.get(brief.collab_id) ?? []
    list.push(brief)
    briefsByCollab.set(brief.collab_id, list)
  }

  const itemsByBrief = new Map<string, BriefItem[]>()
  for (const item of input.briefItems) {
    const list = itemsByBrief.get(item.brief_id) ?? []
    list.push(item)
    itemsByBrief.set(item.brief_id, list)
  }

  return input.creators.map((creator) => {
    const collabs = collabsByCreator.get(creator.id) ?? []

    let assetsRuledOn = 0
    let assetsApproved = 0
    let promised = 0
    let delivered = 0
    let completed = 0
    let ghosted = 0

    for (const collab of collabs) {
      const assets = assetsByCollab.get(collab.id) ?? []

      for (const asset of assets) {
        // "Pending" is not a rejection. Counting it as one would punish a creator
        // for a review the studio has not got round to, which is the studio's
        // backlog wearing a creator's name.
        if (asset.review_status === 'approved' || asset.review_status === 'rejected') {
          assetsRuledOn += 1
          if (asset.review_status === 'approved') assetsApproved += 1
        }
      }

      // Promise kept is measured against what was agreed, so only a LOCKED brief
      // counts. An unlocked brief is still a draft, and holding a creator to a
      // shot list that changed after they shot it is not a reliability signal.
      for (const brief of briefsByCollab.get(collab.id) ?? []) {
        if (brief.locked_at == null) continue
        for (const item of itemsByBrief.get(brief.id) ?? []) {
          promised += 1
          // The HUMAN confirmation, never the AI match. The whole reason those
          // are separate columns is so match accuracy stays measurable, and
          // scoring a creator off the model's guess would spend that separation.
          const met = assets.some(
            (asset) =>
              asset.confirmed_brief_item_id === item.id &&
              asset.review_status === 'approved',
          )
          if (met) delivered += 1
        }
      }

      const anyFootage = assets.length > 0
      if (collab.outcome === 'completed' && anyFootage) completed += 1
      if (collab.outcome === 'ghosted' || (collab.outcome === 'completed' && !anyFootage)) {
        ghosted += 1
      }
    }

    const computed: ComputedScorecard = {
      completed_collabs: completed,
      approval_rate: rate(assetsApproved, assetsRuledOn),
      promise_kept_rate: rate(delivered, promised),
      assets_ruled_on: assetsRuledOn,
      assets_approved: assetsApproved,
      brief_items_promised: promised,
      brief_items_delivered: delivered,
      ghosted,
    }

    const stored = creator.scorecard
    const drift: string[] = []
    if (stored) {
      if (stored.completed_collabs !== computed.completed_collabs) {
        drift.push(`completed collabs: stored ${stored.completed_collabs}, computed ${computed.completed_collabs}`)
      }
      if (differs(stored.approval_rate, computed.approval_rate)) {
        drift.push(`approval rate: stored ${show(stored.approval_rate)}, computed ${show(computed.approval_rate)}`)
      }
      if (differs(stored.promise_kept_rate, computed.promise_kept_rate)) {
        drift.push(
          `promise kept: stored ${show(stored.promise_kept_rate)}, computed ${show(computed.promise_kept_rate)}`,
        )
      }
    }

    const effective_score = creator.fit_score_override ?? creator.fit_score ?? null
    const effective_source: ScoredCreator['effective_source'] =
      creator.fit_score_override != null ? 'human' : creator.fit_score != null ? 'model' : 'none'

    return { creator, computed, drift, effective_score, effective_source }
  })
}

/** Null and a number are always a difference; two numbers within a rounding step are not. */
function differs(stored: number | null | undefined, computed: number | null): boolean {
  const left = stored ?? null
  if (left === null || computed === null) return left !== computed
  return Math.abs(left - computed) > 0.0015
}

function show(value: number | null | undefined): string {
  return value == null ? 'unknown' : `${Math.round(value * 100)}%`
}

/**
 * The ordering the roster uses.
 *
 * Blocked creators sink regardless of score, because a hard gate that still
 * puts a name at the top of the list is a hard gate somebody will click through.
 * Then it is effective score descending, and a creator nobody has scored sorts
 * below one who has: unscored is not the same as scored zero, and the panel must
 * not let those two read alike.
 */
export function rosterOrder(a: ScoredCreator, b: ScoredCreator): number {
  const blocked = Number(a.creator.lifecycle === 'blocked') - Number(b.creator.lifecycle === 'blocked')
  if (blocked !== 0) return blocked
  const scored = Number(b.effective_score != null) - Number(a.effective_score != null)
  if (scored !== 0) return scored
  const score = (b.effective_score ?? 0) - (a.effective_score ?? 0)
  if (score !== 0) return score
  return a.creator.id.localeCompare(b.creator.id)
}
