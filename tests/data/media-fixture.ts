/**
 * The committed media manifest, stood in for.
 *
 * Shared by every data test that hydrates, so the shape lives in one place: a
 * second copy drifting from the first is how a test starts passing against a
 * manifest the app no longer produces.
 */

import type { MediaManifest } from '@/data/seed'

/** A stand-in for the committed media manifest, so the test needs no network. */
export function media(count = 27): MediaManifest {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      slug: `item-${i + 1}`,
      orientation: i % 13 === 12 ? 'horizontal' : 'vertical',
      meta: {
        shot_type: ['closeup', 'macro', 'wide', 'medium'][i % 4]!,
        room: ['treatment_room', 'reception', 'sauna', 'studio'][i % 4]!,
        subjects: ['hands', 'oil'],
        vibe: 'calm',
        light: 'soft_indoor',
      },
      derived_clip: {
        width: 1080,
        height: 1920,
        duration_s: 6,
        committed: i < 3,
        path: i < 3 ? `/seed/clips/item-${i + 1}.mp4` : null,
        bytes: 400_000,
      },
      poster: { path: `/seed/posters/item-${i + 1}.jpg`, bytes: 10_000 },
      contact_sheet: { path: `/seed/sheets/item-${i + 1}.jpg`, bytes: 34_000, frames: 5, layout: '1x5' },
    })),
  }
}
