/**
 * Authored vetting responses.
 *
 * These were written against the seeded `creator` records rather than against an
 * image, so `provenance.artefact` names the record and `sha256` is null. The
 * honesty rule is the same one: the claims below only cite fields the seeded
 * record actually carries.
 *
 * ## Two things are never authored here
 *
 * `evidence_quote` is not authored. A risk flag names which input field its quote
 * must come from, and the mock lifts the quote out of that field at serve time.
 * A quote written into a fixture would be a quote about a person that no supplied
 * text contains, which is the highest damage output in the product (B1.2) and the
 * one thing a fixture must not be able to express.
 *
 * `cited_field` is authored but re-checked. If a reason cites a field the caller
 * did not supply, the mock rewrites the citation to `none`, and the UI renders it
 * as unsupported. A fluent reason resting on nothing is the failure B1.1
 * describes, and it is better to show it as unsupported than to let it read as
 * evidence.
 *
 * ## Deliberate imperfection
 *
 * The default answer is `insufficient_evidence`, because for an inbound
 * application that is the correct answer far more often than any other. One
 * fixture returns a 97 with almost no support, so the boundary post-check has
 * something real to demote. One names a tier outside a narrow band, so the
 * pricing guard has something real to drop. One carries a risk flag whose quote
 * field is empty, so the unevidenced-flag drop is reachable from data.
 */

import type { RiskFlagCode, VetBand, VetCitableField } from '../taxonomy'
import type { AuthoredFixture } from './types'

/** Which supplied field a flag's quote must be lifted from. Never authored inline. */
export type QuoteSource = 'application_note' | 'scorecard_summary' | 'injection_match' | null

export interface AuthoredRiskFlag {
  code: RiskFlagCode
  severity: 'low' | 'medium' | 'high'
  quote_source: QuoteSource
}

export interface VetOutputBody {
  band: VetBand
  score: number | null
  reasons: { claim: string; cited_field: VetCitableField; direction: 'for' | 'against' }[]
  risk_flags: AuthoredRiskFlag[]
  suggested_tier: string | null
  tier_rationale: string | null
  caveat: string | null
}

export interface VetFixture extends AuthoredFixture<VetOutputBody> {
  /** Seeded creators this answer was written for. Empty means it is only a fallback. */
  creator_ids: string[]
}

const RECORD = (id: string) => ({ artefact: `src/data/seed.ts creator ${id}`, sha256: null })

/**
 * The fallback, and the honest majority answer.
 *
 * Deliberately first in the file, because it is what an unknown creator gets and
 * it should be the shape a reader sees before the confident ones.
 */
export const VET_INSUFFICIENT: VetFixture = {
  id: 'vet.insufficient-evidence',
  provenance: RECORD('creator-7'),
  creator_ids: ['creator-7'],
  latency_ms: 2_100,
  imperfection:
    'Carries one risk flag whose quote source is the application note. When no note was supplied the flag arrives unevidenced and checkVet drops it before a human sees it, which is the guard doing its job on real data.',
  output: {
    band: 'insufficient_evidence',
    score: null,
    reasons: [
      {
        claim: 'No completed collaborations with us, so nothing in this assessment is verified by our own records.',
        cited_field: 'prior_collabs',
        direction: 'against',
      },
      {
        claim: 'A single platform with a self-reported follower count is the only audience evidence supplied.',
        cited_field: 'platforms',
        direction: 'against',
      },
    ],
    risk_flags: [{ code: 'unverified_audience', severity: 'low', quote_source: 'application_note' }],
    suggested_tier: null,
    tier_rationale: null,
    caveat:
      'Nothing supplied says what they shoot, where they shoot it, or whether they have worked with a studio before. This is not a judgement about fit, it is a statement that there is not enough here to make one.',
  },
}

export const VET_FIXTURES: readonly VetFixture[] = [
  VET_INSUFFICIENT,

  {
    id: 'vet.strong-fit-with-history',
    provenance: RECORD('creator-1'),
    creator_ids: ['creator-1', 'creator-2'],
    latency_ms: 2_650,
    imperfection:
      'Scores 81 where the seeded fit_score says 86, on purpose. Two runs of the same judgement agreeing to the point is not a property real models have, and the difference is what makes a stored override meaningful.',
    output: {
      band: 'strong_fit',
      score: 81,
      reasons: [
        {
          claim: 'Four completed collaborations with us, which is the strongest evidence available for this decision.',
          cited_field: 'prior_collabs',
          direction: 'for',
        },
        {
          claim: 'Our own scorecard records a promise-kept rate above two thirds across those visits.',
          cited_field: 'scorecard',
          direction: 'for',
        },
        {
          claim: 'Audience size sits mid five figures on one platform, which suits a single branch rather than a national push.',
          cited_field: 'platforms',
          direction: 'for',
        },
        {
          claim: 'Their recent posting cadence looks steady, though nothing supplied here actually shows it.',
          cited_field: 'none',
          direction: 'for',
        },
      ],
      risk_flags: [],
      suggested_tier: 'full_day',
      tier_rationale:
        'Chosen from the tiers the capacity rules already permitted, on the strength of the completed visits rather than on audience size.',
      caveat:
        'Follower counts here are self-reported and unverified, and nothing supplied shows engagement or the mix of their audience, so the number is a summary of our own history with them and little else.',
    },
  },

  {
    id: 'vet.boundary-score-thin-evidence',
    provenance: RECORD('creator-5'),
    creator_ids: ['creator-5'],
    latency_ms: 1_950,
    imperfection:
      'A 97 resting on one supported reason. This is the fluency artefact B1.1 and B6.1 describe, authored deliberately so the boundary post-check has a real case to demote to insufficient_evidence rather than a synthetic one.',
    output: {
      band: 'strong_fit',
      score: 97,
      reasons: [
        {
          claim: 'The handle and display name read as a wellness account, which fits the studio.',
          cited_field: 'primary_handle',
          direction: 'for',
        },
        {
          claim: 'Their aesthetic looks like a strong match for the brand.',
          cited_field: 'none',
          direction: 'for',
        },
        {
          claim: 'Likely to deliver on time.',
          cited_field: 'none',
          direction: 'for',
        },
      ],
      risk_flags: [],
      suggested_tier: 'half_day',
      tier_rationale: 'A first visit, so the smaller of the permitted tiers.',
      caveat: 'No prior work with us and no scorecard, so the number rests mostly on the handle.',
    },
  },

  {
    id: 'vet.tier-outside-band',
    provenance: RECORD('creator-4'),
    creator_ids: ['creator-4'],
    latency_ms: 2_240,
    imperfection:
      'Suggests full_day whether or not the caller permitted it. When the computed band is narrower, checkVet drops the suggestion and the rationale with it, which is what stops a language model making a pricing decision.',
    output: {
      band: 'possible',
      score: 64,
      reasons: [
        {
          claim: 'Two completed visits with us and both were approved, so the delivery record is real if short.',
          cited_field: 'prior_collabs',
          direction: 'for',
        },
        {
          claim: 'The scorecard summary mentions slow replies, which is a scheduling cost rather than a quality one.',
          cited_field: 'scorecard',
          direction: 'against',
        },
      ],
      risk_flags: [{ code: 'contactability', severity: 'medium', quote_source: 'scorecard_summary' }],
      suggested_tier: 'full_day',
      tier_rationale: 'Two clean deliveries argue for the larger tier despite the slow replies.',
      caveat: 'Nothing supplied shows why the replies are slow, so whether it repeats is not knowable from here.',
    },
  },

  {
    id: 'vet.injection-observed',
    provenance: { artefact: 'authored for the B6.1 injection case', sha256: null },
    creator_ids: [],
    latency_ms: 2_480,
    imperfection:
      'Served whenever the application note contains instruction-shaped text. The band stays where the evidence puts it and the attempt is reported as an observation, which is the posture the prompt states: the attack becomes a signal.',
    output: {
      band: 'possible',
      score: 55,
      reasons: [
        {
          claim: 'The application note contains text addressed to an automated reader rather than to a person.',
          cited_field: 'application_note',
          direction: 'against',
        },
        {
          claim: 'Setting that aside, the supplied platform and follower figures are ordinary for a local account.',
          cited_field: 'platforms',
          direction: 'for',
        },
      ],
      risk_flags: [{ code: 'other', severity: 'medium', quote_source: 'injection_match' }],
      suggested_tier: null,
      tier_rationale: null,
      caveat:
        'The note tried to state a verdict for me. I have reported it rather than followed it, and I would treat every other claim in that note as unverified for the same reason.',
    },
  },
]

export const VET_BY_CREATOR: ReadonlyMap<string, VetFixture> = new Map(
  VET_FIXTURES.flatMap((fixture) => fixture.creator_ids.map((id) => [id, fixture] as const)),
)

/**
 * Instruction-shaped patterns in untrusted creator text.
 *
 * This is not a sanitiser and must not be mistaken for one: the structural
 * mitigations are the fencing in the prompt and the closed output schema. It
 * exists so the mock can route to the injection fixture deterministically, and so
 * the manager surface can show which text tripped it.
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all )?(previous|prior|above) instructions?/i,
  /disregard (the )?(previous|prior|above)/i,
  /you (are|must) now/i,
  /system prompt/i,
  /\bscore\s*[:=]?\s*(100|99|98|97|96|95)\b/i,
  /(mark|set|rate)\s+(this|the)\s+creator\s+as/i,
  /perfect fit/i,
]

/** The matched sentence, so a quote is always lifted from the input and never authored. */
export function injectionMatch(text: string | null): string | null {
  if (!text) return null
  for (const pattern of INJECTION_PATTERNS) {
    const found = pattern.exec(text)
    if (found) {
      // Widen to the surrounding sentence so the manager sees context rather than
      // three words, then cap at the schema's evidence_quote length.
      const start = Math.max(0, text.lastIndexOf('.', found.index) + 1)
      const endMark = text.indexOf('.', found.index + found[0].length)
      const end = endMark === -1 ? text.length : endMark + 1
      return text.slice(start, end).trim().slice(0, 300)
    }
  }
  return null
}
