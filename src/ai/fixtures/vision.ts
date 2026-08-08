/**
 * Authored vision responses, one per contact sheet that was actually opened.
 *
 * Every entry below was written by a model looking at the committed JPEG named in
 * its `provenance`, tile by tile. That is the rule from decision U8 and it is the
 * only reason a mock tag is worth anything: a description of an image nobody
 * opened is a sentence, not an observation.
 *
 * `frames_seen` is deliberately absent from these payloads. It is echoed from the
 * input at serve time, exactly as a real response would echo it, so a three frame
 * constrained tier sheet cannot be reported as five.
 *
 * ## What is deliberately imperfect here, and why each one earns its place
 *
 * - Confidences spread across the range, including the middle band. A sheet of
 *   uniform 0.95 tells a human nothing and trains the UI to render one state.
 * - Two low confidence tags (`towels` 0.44, `water` 0.30) that a human is meant
 *   to reject. The rejection is the eval signal the product gets for free.
 * - Two fixtures disagree with the seeded metadata for the same clip on purpose.
 *   `sauna-doors-01` is filed as a sauna and reads as a corridor. Every product
 *   fixture is filed in `studio` and no room is visible in the frames at all.
 *   A mock that agrees with the seed everywhere proves nothing about disagreement
 *   handling, which is the case the review queue exists for.
 * - Three fixtures say a taxonomy term is missing rather than picking the nearest
 *   wrong member. That is the `other` rate doing its job as a vocabulary growth
 *   signal, in the model's own voice.
 * - One fixture flags an authenticity doubt nobody asked about, because real
 *   output volunteers things and template output never does.
 */

import type { VisionTagOutput } from '../provider'
import type { AuthoredFixture } from './types'

/** The authored part of a vision response: everything except the echoed frame count. */
export type VisionOutputBody = Omit<VisionTagOutput, 'frames_seen'>

export interface VisionFixture extends AuthoredFixture<VisionOutputBody> {
  /**
   * Seeded assets whose `sheet_key` is this image.
   *
   * Asserted against `buildSeed` in tests/ai/fixtures.spec.ts rather than trusted,
   * because this mapping is derived from how the seed walks the media manifest and
   * would otherwise drift in silence the first time that walk changes.
   */
  asset_ids: string[]
}

const SHEET_DIR = '/seed/sheets'

export const VISION_FIXTURES: readonly VisionFixture[] = [
  {
    id: 'vision.hands-back-oil-01',
    provenance: {
      artefact: `${SHEET_DIR}/hands-back-oil-01.jpg`,
      sha256: '3769f9a6ea6cf104b25f246a73b1b21e0e575a2e090ef1d8a5647ab6a6dd0dd5',
    },
    asset_ids: ['asset-lib-1'],
    latency_ms: 1_450,
    imperfection:
      'towels at 0.44 is the low confidence tag a human is expected to reject: only a corner of white cloth is visible and it could be the table dressing.',
    output: {
      description:
        'Two hands resting flat on a bare back on a treatment table, warm skin tones, a white towel at the lower left of frame.',
      shot_type: 'closeup',
      room: 'treatment_room',
      subjects: ['hands', 'client'],
      light: 'warm_light',
      vibe: 'calm',
      tags: [
        { term: 'hands', confidence: 0.94 },
        { term: 'client', confidence: 0.86 },
        { term: 'closeup', confidence: 0.9 },
        { term: 'warm_light', confidence: 0.78 },
        { term: 'calm', confidence: 0.71 },
        { term: 'treatment_room', confidence: 0.62 },
        { term: 'towels', confidence: 0.44 },
      ],
      framing: 'good',
      framing_reason: 'Both hands and the full width of the back are held in frame with the spine roughly centred.',
      light_quality: 'good',
      light_reason: 'Soft directional light from the left, no clipped highlights on the skin.',
      review_flags: [
        {
          flag: 'possible_third_party',
          note: "A client's bare back fills the frame and no face is visible, so consent status cannot be read from the image.",
        },
      ],
      text_on_screen: false,
      overall_confidence: 0.72,
      uncertainty:
        'The frames are near duplicates, so this is one moment rather than five. The room beyond the table is not visible, so treatment_room is inferred from the table and the linen rather than seen.',
    },
  },

  {
    id: 'vision.facial-massage-01',
    provenance: {
      artefact: `${SHEET_DIR}/facial-massage-01.jpg`,
      sha256: '09aead7e731458e2f6c1ce70cf6785a25bc89851311eda91359835b8c9ef0bc9',
    },
    asset_ids: ['asset-lib-4', 'asset-hero-1'],
    latency_ms: 1_720,
    imperfection:
      'Two review flags on the first clip of the hero delivery, so the reviewer meets the consent path immediately rather than after twelve clean tiles.',
    output: {
      description:
        'A client lying back with eyes closed and a towel wrapped at the hairline, a second pair of hands on her neck and collarbone.',
      shot_type: 'closeup',
      room: 'treatment_room',
      subjects: ['face', 'hands', 'client', 'therapist'],
      light: 'warm_light',
      vibe: 'calm',
      tags: [
        { term: 'face', confidence: 0.95 },
        { term: 'client', confidence: 0.93 },
        { term: 'hands', confidence: 0.9 },
        { term: 'closeup', confidence: 0.87 },
        { term: 'warm_light', confidence: 0.86 },
        { term: 'calm', confidence: 0.72 },
        { term: 'therapist', confidence: 0.7 },
        { term: 'treatment_room', confidence: 0.5 },
      ],
      framing: 'good',
      framing_reason: 'Face and hands both held, with the second person cropped at the chin, which reads as deliberate.',
      light_quality: 'usable',
      light_reason: 'Very warm cast: skin runs orange and the towel whites are tinted with it.',
      review_flags: [
        {
          flag: 'identifiable_client',
          note: "The client's face is fully visible and recognisable in every frame.",
        },
        {
          flag: 'possible_third_party',
          note: 'A second person, presumably staff, is visible from the chin down and could be identifiable to a colleague.',
        },
      ],
      text_on_screen: false,
      overall_confidence: 0.78,
      uncertainty:
        'The frames are near duplicates, so whether the hands move at all is not visible. The warmth could be the room light or a grade applied afterwards and I cannot separate the two.',
    },
  },

  {
    id: 'vision.foot-massage-01',
    provenance: {
      artefact: `${SHEET_DIR}/foot-massage-01.jpg`,
      sha256: '41df687f7fa83e9644c2fc1b6ad6840e491cf90c3a7664b4a0cdd403585f0a4d',
    },
    asset_ids: ['asset-lib-6', 'asset-hero-3'],
    latency_ms: 1_260,
    imperfection:
      'overall_confidence 0.55 with a null room. This is the honest low confidence case, and the grid has to render it as thin evidence rather than as an answer.',
    output: {
      description:
        'Bare feet resting on a rolled towel on a dark stone surface, a hand and forearm reaching in from the left.',
      shot_type: 'closeup',
      room: null,
      subjects: ['feet', 'towels', 'hands'],
      light: 'low_light',
      vibe: 'moody',
      tags: [
        { term: 'feet', confidence: 0.92 },
        { term: 'towels', confidence: 0.85 },
        { term: 'low_light', confidence: 0.9 },
        { term: 'closeup', confidence: 0.88 },
        { term: 'hands', confidence: 0.7 },
        { term: 'moody', confidence: 0.52 },
      ],
      framing: 'usable',
      framing_reason: 'The subject sits in the upper third and the lower half of every frame is unlit stone.',
      light_quality: 'usable',
      light_reason: 'Very low key, and the shadow side of the feet is crushed to black.',
      review_flags: [
        {
          flag: 'possible_third_party',
          note: "A client's bare feet are the subject. No face is visible in any frame.",
        },
      ],
      text_on_screen: false,
      overall_confidence: 0.55,
      uncertainty:
        'Nothing here shows the space, so the room stays null rather than a guess from the stone. Whether the standing person is staff or the client is not visible either: white trousers and one forearm.',
    },
  },

  {
    id: 'vision.therapist-working-01',
    provenance: {
      artefact: `${SHEET_DIR}/therapist-working-01.jpg`,
      sha256: 'afc2d243b76fd812d2d3efc89648c3bf94cda21377c60e88de3c8393a3626321',
    },
    asset_ids: ['asset-lib-7', 'asset-hero-4'],
    latency_ms: 1_880,
    imperfection:
      'light_quality poor. A clip the model itself says is underexposed still reaches review, because publishing is a human decision and a bucket is not a gate.',
    output: {
      description:
        'A therapist in a red uniform leaning over a client on a table, holding cloth compresses, dark tiled wall behind.',
      shot_type: 'medium',
      room: 'treatment_room',
      subjects: ['therapist', 'client', 'hands'],
      light: 'low_light',
      vibe: 'calm',
      tags: [
        { term: 'therapist', confidence: 0.93 },
        { term: 'client', confidence: 0.9 },
        { term: 'low_light', confidence: 0.91 },
        { term: 'medium', confidence: 0.82 },
        { term: 'hands', confidence: 0.66 },
        { term: 'treatment_room', confidence: 0.58 },
        { term: 'calm', confidence: 0.5 },
      ],
      framing: 'usable',
      framing_reason: "The therapist's head sits close to the top edge and the client is cropped at the waist.",
      light_quality: 'poor',
      light_reason: 'Underexposed: the wall behind loses all detail and the skin carries most of the light.',
      review_flags: [
        {
          flag: 'possible_third_party',
          note: "The therapist's face is fully visible and identifiable in every frame.",
        },
        {
          flag: 'nudity_or_underwear',
          note: "The client's midriff is bare. Ordinary for a massage, still a placement question before this is published.",
        },
      ],
      text_on_screen: false,
      overall_confidence: 0.66,
      uncertainty:
        'The dark tile and low light would fit a wet room as easily as a treatment room; the table is what tips it, not the room. What is in her hands reads as cloth compresses and no more.',
    },
  },

  {
    id: 'vision.treatment-table-drapes-01',
    provenance: {
      artefact: `${SHEET_DIR}/treatment-table-drapes-01.jpg`,
      sha256: '08ad8cb5316686d2455de30b23be79e93e3774c28c3e3f58f2124d6d95aefe0c',
    },
    asset_ids: ['asset-lib-8', 'asset-hero-5'],
    latency_ms: 1_340,
    imperfection:
      'subjects is [other] and the uncertainty says why: the taxonomy has no term for furniture. An honest other beats a wrong towels, and the other rate is the signal the vocabulary needs a word.',
    output: {
      description:
        'An empty treatment table dressed in pale linen with a small cushion, sheer white curtains filling the background.',
      shot_type: 'medium',
      room: 'treatment_room',
      subjects: ['other'],
      light: 'daylight',
      vibe: 'clean',
      tags: [
        { term: 'daylight', confidence: 0.84 },
        { term: 'treatment_room', confidence: 0.8 },
        { term: 'clean', confidence: 0.76 },
        { term: 'medium', confidence: 0.66 },
        { term: 'other', confidence: 0.55 },
        { term: 'wide', confidence: 0.38 },
      ],
      framing: 'good',
      framing_reason: 'The table runs diagonally out of frame at the lower left, which reads as intentional.',
      light_quality: 'good',
      light_reason: 'Curtain diffused daylight, even across the linen, slightly flat.',
      review_flags: [
        {
          flag: 'other',
          note: 'A red embroidered motif appears on the cushion and again on the linen. Not legible as text, and whose mark it is cannot be told from here.',
        },
      ],
      text_on_screen: false,
      overall_confidence: 0.7,
      uncertainty:
        'The subject is the table itself and the supplied subject list has no term for furniture, so this is other. A table or linen term would carry it better than other does.',
    },
  },

  {
    id: 'vision.reception-waiting-01',
    provenance: {
      artefact: `${SHEET_DIR}/reception-waiting-01.jpg`,
      sha256: '1ddfde31c64437c5b259567942b355bb2408acb010d3b28db3308c1d1db3b127',
    },
    asset_ids: ['asset-lib-12', 'asset-hero-9', 'asset-hero-extra-1'],
    latency_ms: 1_510,
    imperfection:
      'The text_on_screen case, and the reason asset-hero-9 sits on a brand safety hold in the seed. Legible signage in frame is both a b-roll problem and the prompt injection surface, and it turns itself into a flag.',
    output: {
      description:
        'A cream sofa under an arched mirror with a hanging plant and a low table of small vases, shot from a high angle.',
      shot_type: 'wide',
      room: 'reception',
      subjects: ['plants', 'signage', 'other'],
      light: 'daylight',
      vibe: 'clean',
      tags: [
        { term: 'wide', confidence: 0.85 },
        { term: 'plants', confidence: 0.8 },
        { term: 'reception', confidence: 0.74 },
        { term: 'clean', confidence: 0.7 },
        { term: 'daylight', confidence: 0.66 },
        { term: 'signage', confidence: 0.58 },
      ],
      framing: 'usable',
      framing_reason: 'Shot from high up, so the sofa is foreshortened and almost none of the floor is in frame.',
      light_quality: 'good',
      light_reason: 'Bright and even, with the mirror bouncing fill onto the seat.',
      review_flags: [
        {
          flag: 'text_on_screen',
          note: 'Partial signage across the top of every frame, legible as "The S" before it leaves frame. It reads as a business name, not an instruction.',
        },
      ],
      text_on_screen: true,
      overall_confidence: 0.61,
      uncertainty:
        "The signage is cut off, so the full wording is unreadable. Whether it is this branch's own name or a neighbouring business is not something these frames can settle.",
    },
  },

  {
    id: 'vision.sauna-doors-01',
    provenance: {
      artefact: `${SHEET_DIR}/sauna-doors-01.jpg`,
      sha256: 'acc0cb14512954f089abf37a018dd345a9165290402fc3df4621b5a196f3e1e8',
    },
    asset_ids: ['asset-lib-15', 'asset-hero-12'],
    latency_ms: 1_190,
    imperfection:
      'Disagrees with the seeded room on purpose: filed as sauna, and the frames show a passage with doors. Also says out loud that none of the three light terms fit, which is a real taxonomy gap rather than a hedge.',
    output: {
      description:
        'A blue painted door in an exposed brick wall beside two frosted glass doors, wood-look floor, a ring pendant above.',
      shot_type: 'medium',
      room: 'corridor',
      subjects: ['none_visible'],
      light: 'daylight',
      vibe: 'other',
      tags: [
        { term: 'medium', confidence: 0.78 },
        { term: 'corridor', confidence: 0.66 },
        { term: 'other', confidence: 0.5 },
        { term: 'daylight', confidence: 0.4 },
        { term: 'sauna', confidence: 0.31 },
      ],
      framing: 'good',
      framing_reason: 'The brick pier splits the frame near the third, and both doorways stay readable.',
      light_quality: 'good',
      light_reason: 'Even interior light, no hot spots, shadows soft under the pendant.',
      review_flags: [],
      text_on_screen: false,
      overall_confidence: 0.58,
      uncertainty:
        'This is a passage with doors, not the inside of a room, so corridor. The frosted doors could be sauna, steam or changing rooms. The light is even and artificial; daylight is only the closest of three.',
    },
  },

  {
    id: 'vision.bath-plants-01',
    provenance: {
      artefact: `${SHEET_DIR}/bath-plants-01.jpg`,
      sha256: '051c3f11756d7558f46fa6ca49852c1c25ba3dec249a64ef94f13d09a8012805',
    },
    asset_ids: ['asset-lib-17', 'asset-hero-14'],
    latency_ms: 1_620,
    imperfection:
      'water at 0.30 is tagged from the fittings, not from visible water, and the flag raises an authenticity doubt nobody asked for. Both are things real output volunteers.',
    output: {
      description:
        'A built-in tub under a glazed pitched roof, a mustard wall, a hanging basket of greenery, trees through the window.',
      shot_type: 'wide',
      room: 'wet_room',
      subjects: ['plants', 'water'],
      light: 'daylight',
      vibe: 'lush',
      tags: [
        { term: 'plants', confidence: 0.9 },
        { term: 'daylight', confidence: 0.9 },
        { term: 'wide', confidence: 0.87 },
        { term: 'lush', confidence: 0.82 },
        { term: 'wet_room', confidence: 0.48 },
        { term: 'water', confidence: 0.3 },
      ],
      framing: 'good',
      framing_reason: 'Roof line leads into the tub, and the hanging basket sits off centre without cutting the window.',
      light_quality: 'good',
      light_reason: 'Strong daylight through the glazing; the tub rim clips to white in two frames.',
      review_flags: [
        {
          flag: 'other',
          note: 'The mustard wall, the domestic tiling and the conservatory roof do not look like the rest of this branch. Worth checking it was shot on site.',
        },
      ],
      text_on_screen: false,
      overall_confidence: 0.6,
      uncertainty:
        'The tub is empty, so water is tagged low from the fittings rather than from anything visible. Called a wet room because of the tub, but it reads domestic rather than like a treatment space.',
    },
  },

  {
    id: 'vision.product-guasha-dark-01',
    provenance: {
      artefact: `${SHEET_DIR}/product-guasha-dark-01.jpg`,
      sha256: 'cf78867163d37de4a110b47b50c1ce2e87ff57be4be3426e87e2134dfce4c2c5',
    },
    // No seeded asset carries this sheet: the seed only reaches manifest items 0
    // to 19. It is authored anyway because it is the only moody macro in the set,
    // which is the cell the seeded gap gap-product-dark keys on, so the loop has
    // an answer ready the first time that gap is filled.
    asset_ids: [],
    latency_ms: 1_400,
    imperfection:
      'The file is named for a gua sha tool and the frames show two dropper bottles. The fixture describes what is there, which is how a mock stays honest when the metadata is wrong.',
    output: {
      description:
        'Two amber dropper bottles with blank white labels on a speckled ceramic dish, an olive sprig alongside, on dark cloth.',
      shot_type: 'overhead',
      room: null,
      subjects: ['product', 'plants'],
      light: 'low_light',
      vibe: 'moody',
      tags: [
        { term: 'product', confidence: 0.95 },
        { term: 'low_light', confidence: 0.88 },
        { term: 'overhead', confidence: 0.83 },
        { term: 'moody', confidence: 0.8 },
        { term: 'plants', confidence: 0.71 },
        { term: 'macro', confidence: 0.41 },
      ],
      framing: 'good',
      framing_reason: 'Dish and bottle sit on opposing thirds, and the sprig leads the eye between them.',
      light_quality: 'usable',
      light_reason: 'Hard single source: deep shadow on the right loses the second bottle outline.',
      review_flags: [],
      text_on_screen: false,
      overall_confidence: 0.68,
      uncertainty:
        'The labels are blank, so the products are not named. Nothing indicates a room: this is a styled flatlay that could have been shot anywhere, and the dish and sprig are props.',
    },
  },

  {
    id: 'vision.towels-bottles-01',
    provenance: {
      artefact: `${SHEET_DIR}/towels-bottles-01.jpg`,
      sha256: '1886cab67c2e84890f80a41b65abe73058dddcd71f280910ed0cd3bb11be3542',
    },
    asset_ids: [],
    latency_ms: 980,
    // The one clean, high confidence, null uncertainty entry in the set. If every
    // fixture hedged, "hedged" would be the only state the UI ever renders, which
    // is the same failure as never hedging.
    imperfection: null,
    output: {
      description:
        'A grey waffle-weave towel and two unlabelled white bottles on a seamless white surface, lit from the upper left.',
      shot_type: 'overhead',
      room: null,
      subjects: ['towels', 'product'],
      light: 'daylight',
      vibe: 'clean',
      tags: [
        { term: 'towels', confidence: 0.96 },
        { term: 'product', confidence: 0.93 },
        { term: 'overhead', confidence: 0.9 },
        { term: 'clean', confidence: 0.88 },
        { term: 'daylight', confidence: 0.72 },
        { term: 'macro', confidence: 0.35 },
      ],
      framing: 'good',
      framing_reason: 'Subjects in the upper two thirds with clean empty space below, which crops well to vertical.',
      light_quality: 'good',
      light_reason: 'High key and soft, with one long shadow giving the towel some form.',
      review_flags: [],
      text_on_screen: false,
      overall_confidence: 0.85,
      uncertainty: null,
    },
  },
]

/** Fixture by seeded asset id. Built once, so selection is a lookup rather than a scan. */
export const VISION_BY_ASSET: ReadonlyMap<string, VisionFixture> = new Map(
  VISION_FIXTURES.flatMap((fixture) => fixture.asset_ids.map((id) => [id, fixture] as const)),
)
