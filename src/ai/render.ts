/**
 * Capability input to prompt placeholder values, in one place.
 *
 * Live needs this to build the request. Mock needs it for a less obvious reason
 * that turns out to matter more: `renderTemplate` throws when a placeholder has
 * no value, so having the mock render the real prompt and discard it means a
 * template with a typo or a new slot fails in the only mode this build actually
 * runs. Without that, a broken prompt would sit undetected until the first live
 * call, which by decision U7 never happens.
 *
 * The list-shaped values are pre-rendered to text here rather than handed to the
 * template as objects, because `[object Object]` in a prompt is a silent quality
 * failure and `stringifyValue` can only guess. A gap, a candidate clip and a
 * missing brief item each have a shape a human would write out, so they are
 * written out.
 */

import type {
  BriefGenInput,
  BriefMatchInput,
  GapScanInput,
  NudgeDraftInput,
  SearchParseInput,
  VetInput,
  VisionTagInput,
} from './provider'
import type { CapabilityIo } from './provider'
import type { CapabilityKey } from './schemas'

export function promptValuesFor<K extends CapabilityKey>(
  kind: K,
  input: CapabilityIo[K]['input'],
): Record<string, unknown> {
  // The casts go through `unknown` because TypeScript cannot correlate a generic
  // capability key with its own input type inside a switch. The pairing is enforced
  // at every call site by `CapabilityIo`, which is where it is checkable.
  const value = input as unknown
  switch (kind) {
    case 'vet':
      return vetValues(value as VetInput)
    case 'brief_gen':
      return briefGenValues(value as BriefGenInput)
    case 'vision_tag':
      return visionTagValues(value as VisionTagInput)
    case 'brief_match':
      return briefMatchValues(value as BriefMatchInput)
    case 'search_parse':
      return searchParseValues(value as SearchParseInput)
    case 'gap_scan':
      return gapScanValues(value as GapScanInput)
    case 'nudge_draft':
      return nudgeDraftValues(value as NudgeDraftInput)
    default:
      throw new Error(`promptValuesFor: no renderer for capability "${String(kind)}"`)
  }
}

function vetValues(input: VetInput): Record<string, unknown> {
  return {
    branch_city: input.branch_city,
    prior_collabs: input.prior_collabs,
    scorecard_summary: input.scorecard_summary,
    allowed_tiers: input.allowed_tiers,
    display_name: input.display_name,
    primary_handle: input.primary_handle,
    platforms: input.platforms.map(
      (p) => `${p.network} ${p.handle}, self-reported followers ${p.followers ?? 'not stated'}`,
    ),
    application_note: input.application_note,
  }
}

function briefGenValues(input: BriefGenInput): Record<string, unknown> {
  return {
    target_item_count: input.target_item_count,
    branch_slug: input.branch_slug,
    branch_rooms: input.branch_rooms,
    do_not_shoot: input.do_not_shoot,
    vip_tier: input.vip_tier,
    gaps: input.gaps.map((g) => `${g.severity}: ${g.facets} (signature ${g.cell_signature})`),
    creator_style_note: input.creator_style_note,
  }
}

function visionTagValues(input: VisionTagInput): Record<string, unknown> {
  // The sheet itself is an image content block on the live path, never text, and
  // no filename is present here by design.
  return {
    frames_seen: input.frames_seen,
    duration_s: input.duration_s,
    orientation: input.orientation,
    branch_rooms: input.branch_rooms,
  }
}

function briefMatchValues(input: BriefMatchInput): Record<string, unknown> {
  return {
    brief_item_id: input.brief_item_id,
    brief_item_instruction: input.brief_item_instruction,
    brief_item_shot_type: input.brief_item_shot_type,
    brief_item_room: input.brief_item_room,
    candidates: input.candidates.map((c) => {
      const parts = [
        `clip ${c.asset_id}`,
        c.description,
        `shot_type ${c.shot_type ?? 'unknown'}`,
        `room ${c.room ?? 'unknown'}`,
        `subjects ${c.subjects.length > 0 ? c.subjects.join(', ') : 'none recorded'}`,
        `duration ${c.duration_s === null ? 'unknown' : `${c.duration_s}s`}`,
      ]
      return parts.join(' | ')
    }),
  }
}

function searchParseValues(input: SearchParseInput): Record<string, unknown> {
  return {
    branch_slugs: input.branch_slugs,
    query_text: input.query_text,
  }
}

function gapScanValues(input: GapScanInput): Record<string, unknown> {
  return {
    gap_scan_id: input.gap_scan_id,
    cells: input.cells.map(
      (c) => `signature ${c.cell_signature} | ${c.facets} | severity ${c.severity} | signals: ${c.signal_summary}`,
    ),
    unmapped_query_tokens: input.unmapped_query_tokens,
  }
}

function nudgeDraftValues(input: NudgeDraftInput): Record<string, unknown> {
  return {
    creator_display_name: input.creator_display_name,
    branch_city: input.branch_city,
    visit_date_text: input.visit_date_text,
    delivered_count: input.delivered_count,
    promised_count: input.promised_count,
    deadline_text: input.deadline_text,
    tone_hint: input.tone_hint,
    missing_items: input.missing_items.map((m) => `${m.brief_item_id}: ${m.instruction}`),
  }
}
