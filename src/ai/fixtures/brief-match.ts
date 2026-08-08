/**
 * Authored brief match responses, one per brief item.
 *
 * Matching reads clip summaries, not pixels, so these were written against the
 * descriptions the vision fixtures in this directory produce for the same clips.
 * That is why the evidence lines quote things like "a passage with doors": the
 * summary really does say that, because the same fixture set wrote it.
 *
 * ## The shape, and what the mock supplies
 *
 * A fixture speaks in `(asset_id, verdict, confidence, evidence)` tuples and never
 * names a brief item. `brief_item_id` is echoed from the caller. Any candidate a
 * fixture has nothing to say about is put in `unmatched_asset_ids` by the mock,
 * which is what the schema asks for anyway: creators always shoot extra, and a
 * diff that cannot show extras is wrong.
 *
 * ## Deliberate imperfection, and it is the point of this file
 *
 * - `brief-delivered-item-9` claims `covers` at 0.63 for the empty treatment table
 *   clip, and the item asks for a corridor. That is a confident wrong answer,
 *   authored on purpose, and it is the AI over-claim the manager surface is
 *   supposed to surface. The seeded human confirmation puts the same clip on item
 *   5 instead, so the disagreement is in the data rather than in a screenshot.
 * - One `covers` sits at 0.55, below the covers floor, so `checkBriefMatch`
 *   demotes it to `possible` and a human confirms instead of a number moving.
 * - One tuple sits at 0.18, below the suggestion floor, so it is dropped and never
 *   shown. Both post-checks therefore have real cases rather than test-only ones.
 * - One clip matches two different brief items, which is the normal case and the
 *   reason the unit here is a tuple rather than a winner.
 * - Three covered items get no confident match at all. The model finding less than
 *   the human is a real and common direction, and the diff has to render it.
 */

import type { MatchVerdict } from '../taxonomy'
import type { AuthoredFixture } from './types'

export interface BriefMatchTupleBody {
  asset_id: string
  verdict: MatchVerdict
  confidence: number
  evidence: string
}

export interface BriefMatchOutputBody {
  tuples: BriefMatchTupleBody[]
  notes: string | null
}

export interface BriefMatchFixture extends AuthoredFixture<BriefMatchOutputBody> {
  /** Seeded brief items this answer was written for. */
  brief_item_ids: string[]
}

const BRIEF = (n: number) => `brief-delivered-item-${n}`

const RECORD = (n: number) => ({
  artefact: `src/data/seed.ts ${BRIEF(n)} plus the vision fixtures for its candidates`,
  sha256: null,
})

/** The fallback: nothing in the supplied summaries was conclusive. A real and frequent answer. */
export const BRIEF_MATCH_INCONCLUSIVE: BriefMatchFixture = {
  id: 'brief_match.inconclusive',
  provenance: { artefact: 'authored as the honest empty answer', sha256: null },
  brief_item_ids: [BRIEF(5), BRIEF(8), BRIEF(10)],
  latency_ms: 3_100,
  imperfection:
    'Returns no matches at all. Three of the seven covered items land here, so the diff has to render "the model found nothing, a human found something" rather than only the reverse.',
  output: {
    tuples: [],
    notes:
      'None of the supplied summaries names the room this item asks for, and I will not infer a room from a subject. Worth a human pass over the thumbnails: a summary can miss what a frame shows.',
  },
}

export const BRIEF_MATCH_FIXTURES: readonly BriefMatchFixture[] = [
  BRIEF_MATCH_INCONCLUSIVE,

  {
    id: 'brief_match.item-1-reception',
    provenance: RECORD(1),
    brief_item_ids: [BRIEF(1)],
    latency_ms: 3_450,
    imperfection:
      'Two clips cover one item, which inflates nothing but does mean the coverage arithmetic must count items and not clips.',
    output: {
      tuples: [
        {
          asset_id: 'asset-hero-9',
          verdict: 'covers',
          confidence: 0.82,
          evidence: 'The summary names a reception with a sofa, an arched mirror and a low table, shot wide.',
        },
        {
          asset_id: 'asset-hero-extra-1',
          verdict: 'covers',
          confidence: 0.78,
          evidence: 'Same space and framing as the other reception clip, so it covers the item a second time.',
        },
      ],
      notes: 'Both carry a legible signage flag, so covering the item and being publishable are two different questions.',
    },
  },

  {
    id: 'brief_match.item-2-corridor',
    provenance: RECORD(2),
    brief_item_ids: [BRIEF(2)],
    latency_ms: 3_260,
    imperfection:
      'Carries a 0.18 tuple that the suggestion floor drops. Without one, the floor is only ever exercised by a test.',
    output: {
      tuples: [
        {
          asset_id: 'asset-hero-12',
          verdict: 'possible',
          confidence: 0.55,
          evidence:
            'The summary calls it a passage with doors and a brick wall. That may be the corridor the item means, and the summary does not settle it.',
        },
        {
          asset_id: 'asset-hero-5',
          verdict: 'possible',
          confidence: 0.18,
          evidence: 'Sheer curtain behind a table could be a corridor window. Thin, and I would not act on it.',
        },
      ],
      notes: null,
    },
  },

  {
    id: 'brief_match.item-3-sauna',
    provenance: RECORD(3),
    brief_item_ids: [BRIEF(3)],
    latency_ms: 2_980,
    imperfection:
      'The same clip as item 2, at a lower confidence. One clip covering, or possibly covering, two items is the normal case and the shape has to carry it.',
    output: {
      tuples: [
        {
          asset_id: 'asset-hero-12',
          verdict: 'possible',
          confidence: 0.44,
          evidence:
            'The frosted doors in the summary could be the sauna this item asks for, but the clip is shot from outside them.',
        },
      ],
      notes: 'If this is the sauna door rather than a changing room door, it is the closest thing in the delivery.',
    },
  },

  {
    id: 'brief_match.item-4-wet-room',
    provenance: RECORD(4),
    brief_item_ids: [BRIEF(4)],
    latency_ms: 3_050,
    imperfection: null,
    output: {
      tuples: [
        {
          asset_id: 'asset-hero-14',
          verdict: 'covers',
          confidence: 0.71,
          evidence: 'The summary names a tub, greenery and daylight through roof glazing, filed as a wet room.',
        },
      ],
      notes:
        'The same summary questions whether this was shot on site at all. That is a publishing question rather than a coverage one, but it belongs on the same screen.',
    },
  },

  {
    id: 'brief_match.item-7-treatment-room',
    provenance: RECORD(7),
    brief_item_ids: [BRIEF(7)],
    latency_ms: 3_680,
    imperfection:
      'The 0.55 covers here is demoted to possible by the covers floor, so a human confirms rather than the coverage number moving on a coin flip.',
    output: {
      tuples: [
        {
          asset_id: 'asset-hero-1',
          verdict: 'covers',
          confidence: 0.74,
          evidence: 'The summary places hands on a client in a treatment room in warm light, which is what the item asks for.',
        },
        {
          asset_id: 'asset-hero-4',
          verdict: 'covers',
          confidence: 0.55,
          evidence:
            'A therapist and a client on a table, but the summary calls the light low and underexposed and the item asks for natural light.',
        },
        {
          asset_id: 'asset-hero-3',
          verdict: 'partial',
          confidence: 0.52,
          evidence: 'Hands and feet on a towel fit the subject, and the summary says the room is not visible at all.',
        },
      ],
      notes: 'Three takes, one of which the tagging pass already called underexposed.',
    },
  },

  {
    id: 'brief_match.item-9-corridor-overclaim',
    provenance: RECORD(9),
    brief_item_ids: [BRIEF(9)],
    latency_ms: 3_320,
    imperfection:
      'A deliberate over-claim: covers at 0.63 for a clip whose own summary says empty treatment table and sheer curtains, against an item asking for a corridor. This is the wrong answer the manager surface exists to catch, and the seeded human confirmation moves the same clip to item 5.',
    output: {
      tuples: [
        {
          asset_id: 'asset-hero-5',
          verdict: 'covers',
          confidence: 0.63,
          evidence: 'Pale linen and a long sheer wall of curtain read as the corridor by the treatment rooms.',
        },
      ],
      notes: null,
    },
  },
]

export const BRIEF_MATCH_BY_ITEM: ReadonlyMap<string, BriefMatchFixture> = new Map(
  BRIEF_MATCH_FIXTURES.flatMap((fixture) => fixture.brief_item_ids.map((id) => [id, fixture] as const)),
)
