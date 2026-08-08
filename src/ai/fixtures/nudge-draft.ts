/**
 * Authored nudge drafts.
 *
 * The prose is authored. Every fact in it is substituted from the input at serve
 * time, marked with `%TOKEN%` below, because the one unforgivable failure here is a
 * fluent message asking a creator for footage they already sent. A fixture that
 * hardcoded a name, a count or a shot would be able to do exactly that.
 *
 * `missing_item_ids` is never authored either. It is echoed from the input, which
 * carries only items a human has already confirmed as missing.
 *
 * ## Deliberate imperfection
 *
 * The friendly draft leaves a warning on the manager rather than smoothing over an
 * inconsistency it noticed in the numbers, and it does not mention a deadline
 * unless one was supplied. The firm draft is shorter and colder and still thanks
 * them for what arrived, because the shortfall is not evidence of bad faith and a
 * draft that reads as an accusation will be sent by somebody in a hurry.
 */

import type { NudgeTone } from '../taxonomy'
import type { AuthoredFixture } from './types'

export interface NudgeOutputBody {
  subject_line: string
  body_text: string
  tone: NudgeTone
  mentions_deadline: boolean
  /** Authored warnings. Input-derived ones are appended by the mock. */
  warnings: string[]
}

export type NudgeFixture = AuthoredFixture<NudgeOutputBody> & { tone: NudgeTone }

/**
 * Substitution tokens, resolved from the input.
 *
 * `%ITEMS%` becomes one line per human-confirmed missing item, using the
 * instruction text the creator already agreed to, so the ask is recognisable.
 * `%DEADLINE_LINE%` is empty when no deadline was supplied, which is how the
 * "no deadline you were not given" rule is enforced structurally rather than by
 * hoping the prose behaves.
 */
export const NUDGE_TOKENS = [
  '%NAME%',
  '%CITY%',
  '%VISIT_DATE%',
  '%DELIVERED%',
  '%PROMISED%',
  '%ITEMS%',
  '%DEADLINE_LINE%',
] as const

export const NUDGE_FIXTURES: readonly NudgeFixture[] = [
  {
    id: 'nudge_draft.friendly',
    tone: 'friendly',
    provenance: { artefact: 'src/data/seed.ts delivery-hero and its unmet brief items', sha256: null },
    latency_ms: 2_300,
    imperfection:
      'Names the shortfall in the first line rather than burying it, and puts the arithmetic doubt in warnings instead of in the message. A manager can delete a warning; they cannot unsend a wrong count.',
    output: {
      // No count in the subject line. "two things still outstanding" would be a
      // fabrication the moment a delivery is short by three, and the subject is the
      // part a manager is least likely to re-read before sending.
      subject_line: 'Thanks for the %CITY% visit, and the shots still outstanding',
      body_text: [
        'Hi %NAME%,',
        '',
        'Thank you for coming to %CITY% on %VISIT_DATE%. %DELIVERED% of the %PROMISED% shots we agreed have come through and a few of them are better than what we asked for.',
        '',
        'There are still these outstanding:',
        '%ITEMS%',
        '',
        'If any of them turned out not to be possible on the day, that is completely fine, just tell us which and we will take them off the list. If you did film them and they have not uploaded, the same link still works.%DEADLINE_LINE%',
        '',
        'Either way, thank you. What did arrive is already being used.',
      ].join('\n'),
      tone: 'friendly',
      mentions_deadline: false,
      warnings: [
        'Check the delivered count against the review queue before sending: rejected clips are delivered but not usable, and this message counts them as arrived.',
      ],
    },
  },
  {
    id: 'nudge_draft.firm',
    tone: 'firm',
    provenance: { artefact: 'src/data/seed.ts collab-ghosted', sha256: null },
    latency_ms: 2_150,
    imperfection:
      'Written for the ghosted case, and still opens by thanking them. A firm draft that reads as a complaint is the one a manager will regret sending, and this is the tone the send confirmation should slow down.',
    output: {
      subject_line: 'Following up on the %CITY% shot list',
      body_text: [
        'Hi %NAME%,',
        '',
        'Thanks again for the visit on %VISIT_DATE%. We have %DELIVERED% of the %PROMISED% shots from the list we agreed before the day.',
        '',
        'Still missing:',
        '%ITEMS%',
        '',
        'Could you let us know either way, even if the answer is that they did not happen? We would rather close the list than keep it open.%DEADLINE_LINE%',
      ].join('\n'),
      tone: 'firm',
      mentions_deadline: false,
      warnings: [],
    },
  },
]

export const NUDGE_BY_TONE: ReadonlyMap<NudgeTone, NudgeFixture> = new Map(
  NUDGE_FIXTURES.map((fixture) => [fixture.tone, fixture] as const),
)
