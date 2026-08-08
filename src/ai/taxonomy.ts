/**
 * The closed vocabularies every AI capability is constrained to.
 *
 * These exist because free-text tags drift lexically. The same clip analysed
 * twice yields "warm light", "warm lighting" and "golden warm light", the search
 * index splits into three terms that never intersect, and the gap scan then
 * reports a gap in a cell that is already covered. A closed enum in the JSON
 * schema removes that failure at the source: the model classifies, it does not
 * name. See docs/02-caveats-review.md B3.1.
 *
 * ## This file does not own the vocabulary, it mirrors it
 *
 * The five axes below are the ones `src/data/seed.ts` already writes into
 * `asset.ai_subjects`, `asset.ai_shot_type`, `asset.ai_room` and the `tag` rows.
 * A parallel AI vocabulary would be the worst possible outcome: the mock would
 * validate against terms the search index has never heard of, every seeded tag
 * would read as `other`, and the gap scan would compare two different alphabets.
 * So the seed's terms are reproduced verbatim, and every addition is listed in
 * `TAXONOMY_ADDITIONS` with the reason it was needed.
 *
 * Two of those additions are not cosmetic, they are bug fixes:
 *
 * - `moody` (vibe) is referenced by the seeded gap `gap-product-dark`
 *   (`facets: { vibe: 'moody' }`). Without it in the vocabulary no delivered clip
 *   could ever carry the term, so that gap was structurally unclosable and the
 *   loop could never be demonstrated closing on it.
 * - `exterior` (room) is referenced by the seeded zero-result queries
 *   ("exterior arrival") and by the hero brief's unmet items. Same problem: a gap
 *   nothing can ever close.
 *
 * Both are recorded in docs/ai-findings.md.
 *
 * ## Escapes
 *
 * Every axis the model chooses from carries an `other` escape, because a taxonomy
 * with no escape makes the model pick the nearest wrong member instead of
 * admitting the thing does not fit, and an `other` rate is itself the signal that
 * the vocabulary needs a new term (E.3 vocabulary growth).
 *
 * `none_visible` and a `null` room are deliberately distinct from `other`.
 * "Not in this list", "nothing recognisable in frame" and "cannot tell from these
 * frames" are three different facts and the UI renders them differently.
 *
 * These arrays are also what the live prompt sends ahead of the prompt-cache
 * breakpoint. They are stable, so they cost almost nothing after the first call,
 * and one stable prefix serves all seven capabilities because there is one model.
 */

/** Seed terms, verbatim, plus the additions noted below. */
export const SUBJECTS = [
  // from src/data/seed.ts SHOT_VOCABULARY, kind 'subject'
  'hands',
  'oil',
  'towels',
  'product',
  'plants',
  'client',
  'therapist',
  // additions
  'face',
  'feet',
  'water',
  'signage',
  'none_visible',
  'other',
] as const

export type Subject = (typeof SUBJECTS)[number]

/**
 * No motion members.
 *
 * A pan, a push-in and a static hold are indistinguishable from sampled stills,
 * so the vocabulary must not offer a word the evidence cannot support. This is the
 * taxonomy enforcing docs/02-caveats-review.md B3.5 rather than the prompt asking
 * politely.
 */
export const SHOT_TYPES = [
  // seed terms, kind 'shot'
  'closeup',
  'macro',
  'wide',
  'medium',
  // additions
  'overhead',
  'other',
] as const

export type ShotType = (typeof SHOT_TYPES)[number]

/** Seed terms, kind 'light'. No additions: these three cover the seeded sheets. */
export const LIGHT_TERMS = ['warm_light', 'daylight', 'low_light'] as const
export type LightTerm = (typeof LIGHT_TERMS)[number]

/** Seed terms, kind 'vibe', plus `moody`, which a seeded gap already requires. */
export const VIBES = ['calm', 'clean', 'lush', 'moody', 'other'] as const
export type Vibe = (typeof VIBES)[number]

/** `branch.rooms` from the seed, plus `exterior` and an `other` escape. */
export const ROOMS = [
  'treatment_room',
  'reception',
  'corridor',
  'sauna',
  'wet_room',
  'lounge',
  'studio',
  // additions
  'exterior',
  'other',
] as const

export type Room = (typeof ROOMS)[number]

/**
 * What was added on top of the seed vocabulary, and why.
 *
 * Exported rather than left in a comment so a test can assert that every seed
 * term is still present and that nothing was quietly dropped.
 */
export const TAXONOMY_ADDITIONS: { axis: string; term: string; reason: string }[] = [
  { axis: 'subject', term: 'face', reason: 'facial and gua sha footage has no other honest subject term' },
  { axis: 'subject', term: 'feet', reason: 'foot massage is a real shot list item and would otherwise read as other' },
  { axis: 'subject', term: 'water', reason: 'the plunge pool and wet room sheets have water as the primary subject' },
  { axis: 'subject', term: 'signage', reason: 'legible signage is both a subject and the text_on_screen review trigger' },
  { axis: 'subject', term: 'none_visible', reason: 'a frame with no recognisable subject must be sayable without inventing one' },
  { axis: 'subject', term: 'other', reason: 'escape hatch, and the other rate is the vocabulary growth signal' },
  { axis: 'shot_type', term: 'overhead', reason: 'flatlay product framing is common in the seeded sheets and is none of closeup, macro, wide, medium' },
  { axis: 'shot_type', term: 'other', reason: 'escape hatch' },
  { axis: 'vibe', term: 'moody', reason: 'the seeded gap gap-product-dark keys on vibe=moody, which nothing could otherwise carry' },
  { axis: 'vibe', term: 'other', reason: 'escape hatch' },
  { axis: 'room', term: 'exterior', reason: 'the seeded exterior-arrival gap and the unmet brief items key on a room the branch list lacked' },
  { axis: 'room', term: 'other', reason: 'escape hatch' },
]

/**
 * The tag vocabulary: the union of the five axes.
 *
 * Deliberately the union rather than a separate list, because the seed builds
 * `tag.term` from subjects plus shot type plus room, and the search index
 * tokenises those same strings. One alphabet, three consumers.
 *
 * Note what is absent, and must stay absent: no room numbers, no branch names, no
 * staff names, no product SKUs, no dates. Those are identity facts that come from
 * the deal record, never from pixels, because a model asserting "treatment room 2"
 * invents a fact that then becomes a search result. B3.1 part 2.
 */
export const TAG_TERMS = [
  ...SUBJECTS,
  ...SHOT_TYPES,
  ...LIGHT_TERMS,
  ...VIBES,
  ...ROOMS,
] as const

export type TagTerm = (typeof TAG_TERMS)[number]

/** Deduplicated tag terms, for the schema enum. `other` appears on three axes. */
export const TAG_TERM_ENUM: readonly string[] = [...new Set<string>(TAG_TERMS)]

/**
 * Coarse buckets, never a number.
 *
 * A 0-100 "framing and light quality" score from five stills is pseudo-objective:
 * it has no defensible basis, it will disagree with the editor's taste, and the
 * editor will then distrust the whole layer. docs/02-caveats-review.md B3.2.
 */
export const QUALITY_BUCKETS = ['good', 'usable', 'poor'] as const
export type QualityBucket = (typeof QUALITY_BUCKETS)[number]

/**
 * Review reasons, each mapping to a specific human check.
 *
 * Never a `brand_safe` boolean: both directions of a boolean are bad, and a flag
 * with an enumerated reason is the only version a human can act on or clear. B3.3.
 *
 * `text_on_screen` earns its place twice. Legible text is usually a problem for
 * b-roll anyway, and it is also the prompt-injection surface from B6.3, so a text
 * attack turns itself into a review flag.
 *
 * There is no `blocked` member on purpose. A flag blocks publish; only a human
 * blocks a clip. B6.4.
 */
export const REVIEW_FLAGS = [
  'possible_third_party',
  'possible_minor',
  'nudity_or_underwear',
  'competitor_branding',
  'text_on_screen',
  'identifiable_client',
  'other',
] as const

export type ReviewFlag = (typeof REVIEW_FLAGS)[number]

/** Vetting bands. The band is the primary output; the number is secondary detail. B1.1. */
export const VET_BANDS = ['strong_fit', 'possible', 'weak', 'insufficient_evidence'] as const
export type VetBand = (typeof VET_BANDS)[number]

/**
 * Which input field a vetting reason may cite.
 *
 * A reason citing `none` renders as "unsupported" rather than as evidence, which
 * is the cheapest available defence against fluent invention about a named human.
 * B1.1 part 2.
 */
export const VET_CITABLE_FIELDS = [
  'display_name',
  'primary_handle',
  'platforms',
  'follower_count',
  'prior_collabs',
  'scorecard',
  'application_note',
  'none',
] as const

export type VetCitableField = (typeof VET_CITABLE_FIELDS)[number]

export const RISK_FLAG_CODES = [
  'unverified_audience',
  'engagement_mismatch',
  'off_niche',
  'prior_no_show',
  'usage_rights_conflict',
  'competitor_affiliation',
  'contactability',
  'other',
] as const

export type RiskFlagCode = (typeof RISK_FLAG_CODES)[number]

/** Brief-match verdicts. The middle band is the entire point. B3.4. */
export const MATCH_VERDICTS = ['covers', 'partial', 'possible', 'no'] as const
export type MatchVerdict = (typeof MATCH_VERDICTS)[number]

export const ORIENTATIONS = ['vertical', 'horizontal', 'square'] as const
export type Orientation = (typeof ORIENTATIONS)[number]

export const SEARCH_ORDERINGS = ['relevance', 'newest', 'least_used', 'quality'] as const
export type SearchOrdering = (typeof SEARCH_ORDERINGS)[number]

export const NUDGE_TONES = ['friendly', 'neutral', 'firm'] as const
export type NudgeTone = (typeof NUDGE_TONES)[number]

/**
 * One version marker for the whole vocabulary.
 *
 * It is part of every prompt hash, so widening the taxonomy invalidates the
 * response cache deliberately rather than silently mixing outputs from two
 * different alphabets in one library.
 */
export const TAXONOMY_VERSION = '1.1.0'
