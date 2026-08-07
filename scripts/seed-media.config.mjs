/**
 * Curated source stills for the seeded library.
 *
 * These are real photographs under the Pexels license, which permits free use
 * including commercially, with modification, and without attribution. We record
 * attribution anyway in docs/MEDIA-CREDITS.md, because a media manifest that
 * cannot say where a file came from is a liability in a product about usage
 * rights.
 *
 * Why real photographs at all: the library grid is the first thing a reviewer
 * sees, and colour bars would make a considered product look unfinished. It also
 * means the authored AI fixtures get written against real imagery rather than
 * against test patterns, which is the difference between plausible tags and
 * invented ones.
 *
 * The `meta` block on each entry is ground truth for the seed dataset. It is
 * what a correct AI tagging pass should approximately produce, so it doubles as
 * the yardstick for judging whether the authored fixtures are honest.
 */

export const SOURCE_WIDTH = 1600

/** 9:16 for the vertical b-roll the briefs ask for, 16:9 for the deliberate misses. */
export const ORIENTATIONS = {
  vertical: { w: 1080, h: 1920 },
  horizontal: { w: 1920, h: 1080 },
}

export const SEED_MEDIA = [
  // --- hands and treatment detail: the shot type editors ask for most ---
  { id: 6628701, slug: 'hands-back-oil-01', orientation: 'vertical', meta: { shot_type: 'closeup', room: 'treatment_room', subjects: ['hands', 'back'], vibe: 'calm', light: 'soft_indoor' } },
  { id: 38407789, slug: 'hands-oil-pour-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'treatment_room', subjects: ['hands', 'oil'], vibe: 'calm', light: 'warm' } },
  { id: 14187888, slug: 'hands-arm-massage-01', orientation: 'vertical', meta: { shot_type: 'closeup', room: 'treatment_room', subjects: ['hands', 'arm'], vibe: 'clinical', light: 'soft_indoor' } },
  { id: 37229288, slug: 'facial-massage-01', orientation: 'vertical', meta: { shot_type: 'closeup', room: 'treatment_room', subjects: ['hands', 'face', 'client'], vibe: 'calm', light: 'soft_indoor' } },
  { id: 19666192, slug: 'neck-massage-aroma-01', orientation: 'vertical', meta: { shot_type: 'medium', room: 'treatment_room', subjects: ['hands', 'neck', 'client'], vibe: 'calm', light: 'warm' } },
  { id: 9146381, slug: 'foot-massage-01', orientation: 'vertical', meta: { shot_type: 'closeup', room: 'treatment_room', subjects: ['hands', 'feet'], vibe: 'calm', light: 'soft_indoor' } },
  { id: 6187418, slug: 'therapist-working-01', orientation: 'vertical', meta: { shot_type: 'medium', room: 'treatment_room', subjects: ['therapist', 'client'], vibe: 'professional', light: 'soft_indoor' } },

  // --- rooms and interiors: establishing shots and the empty-room coverage cell ---
  { id: 35546238, slug: 'treatment-table-drapes-01', orientation: 'vertical', meta: { shot_type: 'wide', room: 'treatment_room', subjects: ['table', 'linen'], vibe: 'calm', light: 'soft_indoor' } },
  { id: 7598363, slug: 'treatment-room-wood-01', orientation: 'vertical', meta: { shot_type: 'wide', room: 'treatment_room', subjects: ['interior'], vibe: 'warm', light: 'ambient' } },
  { id: 17570403, slug: 'treatment-room-daylight-01', orientation: 'vertical', meta: { shot_type: 'wide', room: 'treatment_room', subjects: ['interior'], vibe: 'minimal', light: 'daylight' } },
  { id: 17640383, slug: 'interior-greenery-01', orientation: 'vertical', meta: { shot_type: 'wide', room: 'corridor', subjects: ['interior', 'plants'], vibe: 'minimal', light: 'daylight' } },
  { id: 17640381, slug: 'reception-waiting-01', orientation: 'horizontal', meta: { shot_type: 'wide', room: 'reception', subjects: ['furniture', 'plants'], vibe: 'welcoming', light: 'daylight' } },
  { id: 7031704, slug: 'lounge-chairs-01', orientation: 'horizontal', meta: { shot_type: 'wide', room: 'lounge', subjects: ['furniture'], vibe: 'spacious', light: 'ambient' } },
  { id: 36420270, slug: 'sauna-wood-01', orientation: 'vertical', meta: { shot_type: 'wide', room: 'sauna', subjects: ['interior', 'stone'], vibe: 'warm', light: 'low' } },
  { id: 7587822, slug: 'sauna-doors-01', orientation: 'vertical', meta: { shot_type: 'medium', room: 'sauna', subjects: ['door', 'brick'], vibe: 'rustic', light: 'ambient' } },
  { id: 26729558, slug: 'corridor-marble-01', orientation: 'vertical', meta: { shot_type: 'wide', room: 'corridor', subjects: ['interior', 'marble'], vibe: 'elegant', light: 'ambient' } },
  { id: 8449824, slug: 'bath-plants-01', orientation: 'vertical', meta: { shot_type: 'wide', room: 'wet_room', subjects: ['bath', 'plants'], vibe: 'lush', light: 'daylight' } },
  { id: 32203052, slug: 'bath-greenery-01', orientation: 'vertical', meta: { shot_type: 'medium', room: 'wet_room', subjects: ['bath', 'plants'], vibe: 'lush', light: 'daylight' } },

  // --- product and still life: the marble-and-serum shots a marketing team always needs ---
  { id: 6682950, slug: 'product-marble-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['product', 'marble'], vibe: 'clean', light: 'soft_indoor' } },
  { id: 8101673, slug: 'product-fabric-serum-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['product', 'fabric'], vibe: 'natural', light: 'soft_indoor' } },
  { id: 8102021, slug: 'product-guasha-dark-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['product', 'tool'], vibe: 'moody', light: 'low' } },
  { id: 5240623, slug: 'oil-pipette-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['oil', 'pipette'], vibe: 'clean', light: 'soft_indoor' } },
  { id: 8100776, slug: 'product-dropper-dark-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['product'], vibe: 'moody', light: 'low' } },
  { id: 10712765, slug: 'product-jade-roller-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['product', 'tool'], vibe: 'clean', light: 'soft_indoor' } },
  { id: 8015807, slug: 'towels-bottles-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['towels', 'product'], vibe: 'minimal', light: 'soft_indoor' } },
  { id: 7691165, slug: 'cotton-pads-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['product', 'cotton'], vibe: 'clean', light: 'bright' } },
  { id: 8101134, slug: 'product-linen-plant-01', orientation: 'vertical', meta: { shot_type: 'macro', room: 'studio', subjects: ['product', 'plant', 'linen'], vibe: 'natural', light: 'soft_indoor' } },
]

/**
 * Which slugs ship as playable video in the repo.
 *
 * Everything else ships as a poster plus a contact sheet with
 * `media_state='bytes_absent'`, which is not a shortcut: it is exactly the state
 * every record will be in once bytes live in object storage, so the local
 * prototype and the real system share one render path.
 */
export const COMMITTED_CLIPS = ['hands-back-oil-01', 'treatment-table-drapes-01', 'product-marble-01']
