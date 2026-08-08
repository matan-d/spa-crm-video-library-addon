/**
 * Capability inputs for the AI suites, shaped like the seeded dataset.
 *
 * Not a `.spec.ts`, so vitest does not collect it. Every builder returns a fresh
 * object and takes overrides, because several suites mutate one field to prove a
 * branch and sharing a frozen literal across suites is how a test starts depending
 * on the order it ran in.
 */

import type {
  BriefGenInput,
  BriefMatchInput,
  GapScanInput,
  NudgeDraftInput,
  SearchParseInput,
  VetInput,
  VisionTagInput,
} from '@/ai'

/** Stand-in for an encoded contact sheet. Never empty, because empty means "no stills". */
export const SHEET_BASE64 = 'data-for-a-composite-contact-sheet'.repeat(8)

export function vetInput(overrides: Partial<VetInput> = {}): VetInput {
  return {
    creator_id: 'creator-1',
    display_name: 'Maya Kessler',
    primary_handle: '@maya.k',
    platforms: [{ network: 'instagram', handle: '@maya.k', followers: 4000 }],
    application_note: null,
    prior_collabs: 4,
    scorecard_summary: '4 completed visits, approval rate 0.66, promise kept 0.70',
    allowed_tiers: ['half_day', 'full_day'],
    branch_city: 'San Jose',
    ...overrides,
  }
}

export function briefGenInput(overrides: Partial<BriefGenInput> = {}): BriefGenInput {
  return {
    branch_slug: 'branch-san-jose',
    branch_rooms: ['treatment_room', 'reception', 'corridor', 'sauna', 'wet_room', 'lounge', 'studio'],
    do_not_shoot: ['staff room', 'stock cupboard'],
    target_item_count: 10,
    gaps: [
      { cell_signature: 'room=exterior|shot_type=wide', facets: 'room=exterior, shot_type=wide', severity: 'critical' },
      {
        cell_signature: 'room=reception|shot_type=medium',
        facets: 'room=reception, shot_type=medium',
        severity: 'critical',
      },
    ],
    creator_style_note: 'I shoot handheld, mostly natural light.',
    vip_tier: 'half_day',
    ...overrides,
  }
}

export function visionInput(overrides: Partial<VisionTagInput> = {}): VisionTagInput {
  return {
    asset_id: 'asset-lib-1',
    sheet_base64: SHEET_BASE64,
    sheet_media_type: 'image/jpeg',
    frames_seen: 5,
    duration_s: 6,
    orientation: 'vertical',
    branch_rooms: ['treatment_room', 'reception', 'corridor', 'sauna', 'wet_room', 'lounge', 'studio'],
    ...overrides,
  }
}

export function briefMatchInput(overrides: Partial<BriefMatchInput> = {}): BriefMatchInput {
  return {
    brief_item_id: 'brief-delivered-item-1',
    brief_item_instruction: 'medium of reception, vertical, natural light',
    brief_item_shot_type: 'medium',
    brief_item_room: 'reception',
    candidates: [
      {
        asset_id: 'asset-hero-9',
        description: 'A cream sofa under an arched mirror with a hanging plant, shot from a high angle.',
        shot_type: 'wide',
        room: 'reception',
        subjects: ['plants', 'signage'],
        duration_s: 6,
      },
      {
        asset_id: 'asset-hero-extra-1',
        description: 'Same reception space and framing.',
        shot_type: 'wide',
        room: 'reception',
        subjects: ['plants'],
        duration_s: 6,
      },
      {
        asset_id: 'asset-hero-3',
        description: 'Bare feet on a rolled towel on a dark stone surface.',
        shot_type: 'closeup',
        room: null,
        subjects: ['feet', 'towels'],
        duration_s: 6,
      },
    ],
    ...overrides,
  }
}

export function searchInput(overrides: Partial<SearchParseInput> = {}): SearchParseInput {
  return {
    query_text: 'golden hour window',
    branch_slugs: ['branch-san-jose', 'branch-palo-alto'],
    ...overrides,
  }
}

export function gapScanInput(overrides: Partial<GapScanInput> = {}): GapScanInput {
  return {
    gap_scan_id: 'gap-scan-current',
    cells: [
      {
        cell_signature: 'room=exterior|shot_type=wide',
        facets: 'room=exterior, shot_type=wide',
        severity: 'critical',
        signal_summary: '7 zero result queries in 30 days, 0 of 6 target clips',
      },
      {
        cell_signature: 'room=reception|shot_type=medium',
        facets: 'room=reception, shot_type=medium',
        severity: 'critical',
        signal_summary: '5 zero result queries in 30 days, 1 of 6 target clips',
      },
    ],
    unmapped_query_tokens: ['greeting', 'steam', 'greeting'],
    ...overrides,
  }
}

export function nudgeInput(overrides: Partial<NudgeDraftInput> = {}): NudgeDraftInput {
  return {
    collab_id: 'collab-delivered',
    creator_display_name: 'Maya Kessler',
    branch_city: 'San Jose',
    visit_date_text: 'Tuesday 4 August',
    missing_items: [
      { brief_item_id: 'brief-delivered-item-2', instruction: 'wide of corridor, vertical, natural light' },
      { brief_item_id: 'brief-delivered-item-6', instruction: 'macro of studio, vertical, natural light' },
    ],
    delivered_count: 7,
    promised_count: 10,
    deadline_text: null,
    tone_hint: null,
    ...overrides,
  }
}
