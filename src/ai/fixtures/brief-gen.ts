/**
 * An authored shot list for the San Jose branch.
 *
 * Written against the seeded branch record (its seven rooms and its two entry
 * do-not-shoot lines) and the seeded gap set, so the items are shootable in that
 * building rather than in a generic spa.
 *
 * ## What is not authored
 *
 * `seq` and `origin_gap_signature`. Sequence numbers are assigned after the list
 * is trimmed to the caller's target count, and a gap signature is echoed from the
 * caller's gap list by position. An authored signature would let a fixture claim
 * an item closes a gap the caller never mentioned, and that link is the exact
 * thing the loop's headline claim rests on.
 *
 * ## Deliberate imperfection
 *
 * Items 3 and 11 overlap and the fixture says so in `possible_overlaps` rather
 * than quietly shipping both, because a brief that inflates its own denominator
 * makes the coverage number wrong in the direction that gets a creator chased for
 * footage they did deliver. Three items carry a `feasibility_doubt` the model
 * cannot resolve, which is what the deterministic feasibility gate is for.
 * Nothing here mentions a resolution, a frame rate or a licence, because those
 * come from templates and a model that writes them is a legal problem (B2.3).
 */

import type { Room, ShotType, Subject } from '../taxonomy'
import type { AuthoredFixture } from './types'

export interface BriefGenItemBody {
  instruction: string
  shot_type: ShotType | null
  room: Room | null
  subjects: Subject[]
  min_takes: number
  why: string
  feasibility_doubt: string | null
  /** Position in the caller's gap list, or null when the item comes from the branch profile. */
  origin_gap_index: number | null
}

export interface BriefGenOutputBody {
  items: BriefGenItemBody[]
  caption_angles: string[]
  /** Pairs of indices into `items`, resolved to sequence numbers after trimming. */
  possible_overlaps: { a: number; b: number; note: string }[]
}

export const BRIEF_GEN_SAN_JOSE: AuthoredFixture<BriefGenOutputBody> = {
  id: 'brief_gen.san-jose-gap-fed',
  provenance: { artefact: 'src/data/seed.ts branch-san-jose and its gap set', sha256: null },
  latency_ms: 9_400,
  imperfection:
    'Twelve items for a ten item ask, one deliberate near duplicate pair, and three unresolved feasibility doubts. A brief that arrives clean has already made decisions the manager is supposed to make.',
  output: {
    items: [
      {
        instruction:
          'From across the street, film the entrance in one steady vertical shot while somebody walks in. Waist height, no zoom.',
        shot_type: 'wide',
        room: 'exterior',
        subjects: ['signage'],
        min_takes: 2,
        why: 'The library has nothing at all of arriving, and every campaign opens with it.',
        feasibility_doubt:
          'Needs someone willing to be in frame, and the pavement is public, so passers-by cannot be controlled.',
        origin_gap_index: 0,
      },
      {
        instruction:
          'Stand in the doorway and film the front desk as a guest is welcomed. Hands, counter and the greeting gesture; no faces needed.',
        shot_type: 'medium',
        room: 'reception',
        subjects: ['hands', 'therapist'],
        min_takes: 2,
        why: 'Editors keep searching for the welcome moment and finding an empty lobby.',
        feasibility_doubt: 'Depends on a guest arriving during the visit, which cannot be scheduled.',
        origin_gap_index: 1,
      },
      {
        instruction: 'Close on two hands working oil across a shoulder, held for a slow count of eight.',
        shot_type: 'closeup',
        room: 'treatment_room',
        subjects: ['hands', 'oil', 'client'],
        min_takes: 3,
        why: 'The most used shot type in the library, and the current takes are all from one visit.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
      {
        instruction: 'Macro on a stack of folded towels, side light, close enough that the weave reads.',
        shot_type: 'macro',
        room: 'studio',
        subjects: ['towels'],
        min_takes: 2,
        why: 'Texture cutaways are asked for constantly and the two we hold are both front lit and flat.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
      {
        instruction: 'Frame the sauna doors from the corridor, wide enough to include the brick and the floor.',
        shot_type: 'medium',
        room: 'sauna',
        subjects: ['none_visible'],
        min_takes: 1,
        why: 'The sauna reads as a closed door in every clip we have, so nothing sells the room.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
      {
        instruction: 'One wide of the lounge with the chairs empty, shot from the low corner so the ceiling shows.',
        shot_type: 'wide',
        room: 'lounge',
        subjects: ['plants'],
        min_takes: 1,
        why: 'The lounge has one clip and it is used in everything, which is the reuse problem this fixes.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
      {
        instruction: 'Film the treatment room late in the visit, when the light through the curtain has gone warm.',
        shot_type: 'wide',
        room: 'treatment_room',
        subjects: ['none_visible'],
        min_takes: 2,
        why: 'Every treatment room clip we hold is flat midday light, and warm is what editors keep asking for.',
        feasibility_doubt: 'Depends entirely on the time of the visit and the weather that afternoon.',
        origin_gap_index: null,
      },
      {
        instruction: 'Overhead flatlay of two product bottles and a sprig on dark cloth, hard side light, no labels facing camera.',
        shot_type: 'overhead',
        room: 'studio',
        subjects: ['product', 'plants'],
        min_takes: 2,
        why: 'Product cutaways in the library are all bright and clean, and the darker campaigns have nothing.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
      {
        instruction: 'Walk the corridor once at a steady pace, phone held level at chest height, ending at the treatment room door.',
        shot_type: 'wide',
        room: 'corridor',
        subjects: ['none_visible'],
        min_takes: 2,
        why: 'A transition shot the editors improvise every time because we have none.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
      // Deliberately inside the first ten, so a ten item ask really does arrive with
      // a redundant pair in it. Pushing the duplicate past the trim point would have
      // hidden the exact thing the manager is supposed to catch.
      {
        instruction: 'Close on hands smoothing oil down a forearm, shot from directly above the table.',
        shot_type: 'closeup',
        room: 'treatment_room',
        subjects: ['hands', 'oil'],
        min_takes: 2,
        why: 'A second angle on the most searched subject in the library.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
      {
        instruction: 'Close on water running into the wet room tub, framed so steam is visible against the darker wall.',
        shot_type: 'closeup',
        room: 'wet_room',
        subjects: ['water'],
        min_takes: 3,
        why: 'Steam detail is a repeated zero result search and nothing in the library shows moving water.',
        feasibility_doubt: 'Steam fogs a phone lens within seconds, so this may need several attempts or none will be usable.',
        origin_gap_index: null,
      },
      {
        instruction: 'Find the greenery by the window and film it with the room soft behind, holding still.',
        shot_type: 'closeup',
        room: 'corridor',
        subjects: ['plants'],
        min_takes: 1,
        why: 'Plants carry the calm the brand voice keeps asking for and we have three usable frames of them.',
        feasibility_doubt: null,
        origin_gap_index: null,
      },
    ],
    caption_angles: [
      'The five minutes before a treatment starts, told without a single face.',
      'What the room sounds like, shown in what it looks like.',
      'One pair of hands, one hour, no cuts.',
      'The building at the hour nobody photographs it.',
    ],
    possible_overlaps: [
      {
        a: 2,
        b: 9,
        note: 'Both are hands and oil in the treatment room. Keep one unless the two angles are genuinely wanted.',
      },
    ],
  },
}

export const BRIEF_GEN_FIXTURES: readonly AuthoredFixture<BriefGenOutputBody>[] = [BRIEF_GEN_SAN_JOSE]
