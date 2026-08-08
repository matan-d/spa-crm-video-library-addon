/**
 * Deterministic post-checks on model output.
 *
 * A schema constrains the shape. It cannot constrain the sense. These are the
 * cheap, code-side rules that catch the specific ways a valid-shaped answer is
 * still wrong, and they run identically on live, replay and mock output because
 * they run after the provider, not inside it.
 *
 * Each one exists because of a named failure mode, not because it seemed prudent:
 *
 * - a boundary score with thin evidence is the shape a successful prompt injection
 *   takes once the schema has capped the blast radius (B6.1 part 3)
 * - a risk flag with no quote is a free-floating adjective attached to a named
 *   human, which is the highest-damage output in the product (B1.2)
 * - a suggested tier outside the computed band is a language model making a
 *   pricing decision (B1.3)
 * - a tag term outside the taxonomy fragments the search index, and the enum stops
 *   it at the model, but a replayed fixture written before a taxonomy change can
 *   still carry a retired term (B3.1)
 * - a match verdict of `covers` at low confidence is worse than `possible`,
 *   because it resolves something a human should have confirmed (B3.4)
 *
 * They mutate the projection, never `output_json`. The verbatim response is kept
 * exactly as received so a later prompt version can re-project it without a new
 * call, and so the diff between what the model said and what we showed is
 * recoverable.
 */

import type { BriefMatchOutput, VetOutput, VisionTagOutput } from './provider'
import { TAG_TERM_ENUM } from './taxonomy'

export interface PostCheckNote {
  /** Stable code, so the UI can explain it and a test can assert on it. */
  code: string
  message: string
}

export interface PostCheckResult<T> {
  value: T
  notes: PostCheckNote[]
}

/** How confident a `covers` verdict must be before it is allowed to stand as `covers`. */
export const COVERS_CONFIDENCE_FLOOR = 0.6

/** Below this, a match is not shown as a suggestion at all. */
export const MATCH_SUGGESTION_FLOOR = 0.25

/**
 * Vetting post-checks.
 *
 * The boundary rule is the interesting one. A score of 98 or 3 from two supplied
 * fields is not a judgement, it is either a fluency artefact or a successful
 * injection, and in both cases `insufficient_evidence` is the honest answer. The
 * threshold is deliberately generous (at least two reasons that cite a real field)
 * because the cost of demoting a genuine extreme is one extra manager glance,
 * while the cost of accepting a manufactured 100 is a real person's assessment.
 */
export function checkVet(output: VetOutput, allowedTiers: readonly string[]): PostCheckResult<VetOutput> {
  const notes: PostCheckNote[] = []
  let value: VetOutput = output

  const supportedReasons = output.reasons.filter((r) => r.cited_field !== 'none')

  if (output.score !== null && (output.score >= 95 || output.score <= 5) && supportedReasons.length < 2) {
    notes.push({
      code: 'boundary_score_thin_evidence',
      message: `Score ${output.score} rests on ${supportedReasons.length} reason(s) citing a supplied field. Demoted to insufficient_evidence.`,
    })
    value = { ...value, band: 'insufficient_evidence', score: null }
  }

  if (value.band === 'insufficient_evidence' && value.score !== null) {
    notes.push({
      code: 'score_without_band',
      message: 'A number alongside insufficient_evidence reads as a judgement. Dropped.',
    })
    value = { ...value, score: null }
  }

  const evidenced = value.risk_flags.filter((f) => f.evidence_quote !== null && f.evidence_quote.trim() !== '')
  if (evidenced.length !== value.risk_flags.length) {
    notes.push({
      code: 'unevidenced_risk_flag_dropped',
      message: `${value.risk_flags.length - evidenced.length} risk flag(s) carried no quote and were dropped before any human saw them.`,
    })
    value = { ...value, risk_flags: evidenced }
  }

  if (value.suggested_tier !== null && !allowedTiers.includes(value.suggested_tier)) {
    notes.push({
      code: 'tier_outside_band',
      message: `Suggested tier "${value.suggested_tier}" is outside the band computed in code (${allowedTiers.join(', ')}). Dropped.`,
    })
    value = { ...value, suggested_tier: null, tier_rationale: null }
  }

  return { value, notes }
}

/**
 * Vision post-checks.
 *
 * Note what is not here: nothing rewrites the description, nothing invents a room,
 * and a low overall confidence is not promoted. The only mutations are removals.
 */
export function checkVisionTag(output: VisionTagOutput): PostCheckResult<VisionTagOutput> {
  const notes: PostCheckNote[] = []
  let value: VisionTagOutput = output

  const known = new Set(TAG_TERM_ENUM)
  const inVocabulary = value.tags.filter((t) => known.has(t.term))
  if (inVocabulary.length !== value.tags.length) {
    const dropped = value.tags.filter((t) => !known.has(t.term)).map((t) => t.term)
    notes.push({
      code: 'tag_outside_taxonomy_dropped',
      message: `Dropped ${dropped.length} term(s) not in the taxonomy: ${dropped.join(', ')}. A retired term in an old fixture reaches this path.`,
    })
    value = { ...value, tags: inVocabulary }
  }

  // A flag without a reason is still actionable (the flag IS the reason), but a
  // text_on_screen flag with text_on_screen false is a contradiction, and the safe
  // direction is to believe the flag.
  const hasTextFlag = value.review_flags.some((f) => f.flag === 'text_on_screen')
  if (hasTextFlag && !value.text_on_screen) {
    notes.push({
      code: 'text_flag_without_boolean',
      message: 'A text_on_screen flag was raised while the boolean said false. Trusting the flag.',
    })
    value = { ...value, text_on_screen: true }
  }

  if (value.framing !== 'good' && value.framing_reason === null) {
    notes.push({
      code: 'quality_bucket_without_reason',
      message: 'Framing was not good and carried no reason, so the UI has nothing to show a human.',
    })
  }

  return { value, notes }
}

/**
 * Match post-checks.
 *
 * Demoting a low-confidence `covers` to `possible` is the single most valuable rule
 * in this file. `covers` marks a brief item satisfied, which changes a coverage
 * number, which decides whether a real person gets chased for footage they already
 * sent. `possible` renders as a question to a human instead.
 */
export function checkBriefMatch(output: BriefMatchOutput): PostCheckResult<BriefMatchOutput> {
  const notes: PostCheckNote[] = []
  let demoted = 0
  let dropped = 0

  const matches = output.matches
    .filter((m) => {
      if (m.verdict !== 'no' && m.confidence < MATCH_SUGGESTION_FLOOR) {
        dropped += 1
        return false
      }
      return true
    })
    .map((m) => {
      if (m.verdict === 'covers' && m.confidence < COVERS_CONFIDENCE_FLOOR) {
        demoted += 1
        return { ...m, verdict: 'possible' as const }
      }
      return m
    })

  if (demoted > 0) {
    notes.push({
      code: 'low_confidence_covers_demoted',
      message: `${demoted} match(es) claimed covers below ${COVERS_CONFIDENCE_FLOOR} confidence and were demoted to possible, so a human confirms rather than a number moving.`,
    })
  }
  if (dropped > 0) {
    notes.push({
      code: 'below_suggestion_floor_dropped',
      message: `${dropped} match(es) fell below ${MATCH_SUGGESTION_FLOOR} confidence and are not shown as suggestions.`,
    })
  }

  return { value: { ...output, matches }, notes }
}

/**
 * Maps a review-flag set to the asset's brand safety field.
 *
 * `blocked` is never produced here. A flag blocks publish and a human clears it or
 * blocks the clip; a model output that could write `blocked` would be a model output
 * that changes state. B6.4.
 */
export function brandSafetyFrom(flags: readonly { flag: string }[]): 'clear' | 'review' {
  return flags.length > 0 ? 'review' : 'clear'
}

/**
 * Turns a coarse quality bucket into the numeric field the asset record already has.
 *
 * This is an encoding of a bucket, not a score. Three fixed values, so nothing can
 * read false precision into it, and the bucket remains recoverable from the number.
 * The alternative (letting the model emit 0.73) is the pseudo-objective score B3.2
 * rejects.
 */
export function bucketToScore(bucket: 'good' | 'usable' | 'poor'): number {
  if (bucket === 'good') return 0.8
  if (bucket === 'usable') return 0.55
  return 0.3
}
