/**
 * The seeded demo dataset.
 *
 * Generated at runtime from the injected `SeededClock` and `SeededRng`, not
 * committed as JSON. The architecture review proposed committing the artefact, and
 * this deviates deliberately: Node cannot import a TypeScript module, so a build
 * time generator would need its own copy of the seeded RNG, and two copies of a
 * PRNG that can silently drift from the one the tests assert against is a worse
 * problem than a second of boot time. Recorded in docs/06-decisions.md D11.
 *
 * Determinism still holds completely: same seed, byte identical ids, timestamps
 * and ordering, every run, asserted by a test.
 *
 * The real media comes from `public/seed/media-manifest.json`, which the committed
 * stock stills and their frame-extracted contact sheets are described by. So the
 * library a reviewer opens contains real footage with real posters, and the
 * authored AI fixtures were written against those same images.
 *
 * The dataset is deliberately imperfect. A seed where every delivery is complete
 * and every match is correct produces an interface that has never had to express
 * ambiguity, and the first real run then produces states the UI cannot render.
 */

import type { Clock } from '@/platform/clock'
import type { Rng } from '@/platform/rng'
import type { IdFactory } from '@/platform/id'
import type { StoreName } from './schema'

export interface MediaManifestItem {
  slug: string
  orientation: 'vertical' | 'horizontal'
  meta: {
    shot_type: string
    room: string
    subjects: string[]
    vibe: string
    light: string
  }
  derived_clip: {
    width: number
    height: number
    duration_s: number
    committed: boolean
    path: string | null
    bytes: number
  }
  poster: { path: string; bytes: number }
  contact_sheet: { path: string; bytes: number; frames: number; layout: string }
}

export interface MediaManifest {
  items: MediaManifestItem[]
}

export interface SeedRows {
  [store: string]: Record<string, unknown>[]
}

export interface SeedResult {
  rows: SeedRows
  summary: {
    counts: Record<string, number>
    publishedAssets: number
    imperfectCases: string[]
  }
}

export const SEED_ORG_ID = 'org-astolia'
const ORG_ID = SEED_ORG_ID
const DAY = 86_400_000

/** The seeded accounts the demo role switcher signs in as. */
export const SEED_USERS = {
  manager: 'user-manager',
  editor: 'user-editor',
} as const

/**
 * The raw demo tokens, exported because the demo must be able to render an
 * invite link a reviewer can actually open.
 * In the real product a raw token is minted once, shown once and never stored;
 * only its sha256 lands in `access_token.token_hash`.
 * The seed is the one place that rule bends, because seeded history has no
 * "shown once" moment, and a demo whose token link cannot be opened
 * demonstrates nothing.
 * The stored hashes below are the genuine sha256 of these strings, so the
 * resolver exercises the same lookup the Supabase RPC would.
 */
export const DEMO_CREATOR_TOKEN = 'demo-creator-token'
export const DEMO_EXPIRED_TOKEN = 'demo-expired-token'
export const DEMO_CREATOR_TOKEN_HASH =
  '3ebfee4e56c29a9540239c97f9aef640d891c54f12fb04405fc1a2f6acb4274b'
export const DEMO_EXPIRED_TOKEN_HASH =
  '6c2a0e6e5e66c501069679f7ced40c949951b3fb3d237303c7c0178ef248cd76'

const BRANCHES = [
  {
    id: 'branch-san-jose',
    name: 'Astolia San Jose',
    city: 'San Jose',
    address: '1180 Lincoln Ave, San Jose, CA',
    lat: 37.3082,
    lng: -121.9046,
    rooms: ['treatment_room', 'reception', 'corridor', 'sauna', 'wet_room', 'lounge', 'studio'],
    primary: true,
  },
  {
    id: 'branch-palo-alto',
    name: 'Astolia Palo Alto',
    city: 'Palo Alto',
    address: '440 University Ave, Palo Alto, CA',
    lat: 37.4471,
    lng: -122.1601,
    rooms: ['treatment_room', 'reception'],
    primary: false,
  },
]

const CREATORS = [
  { handle: '@maya.k', name: 'Maya Kessler', tier: 'trusted', lifecycle: 'active', fit: 86 },
  { handle: '@r.oliveira', name: 'Rafa Oliveira', tier: 'trusted', lifecycle: 'active', fit: 81 },
  { handle: '@j.rivera', name: 'Jules Rivera', tier: 'proven', lifecycle: 'active', fit: 74 },
  { handle: '@tal.b', name: 'Tal Berger', tier: 'proven', lifecycle: 'active', fit: 69 },
  { handle: '@nina.w', name: 'Nina Wu', tier: 'new', lifecycle: 'active', fit: 63 },
  { handle: '@dev.p', name: 'Dev Patel', tier: 'new', lifecycle: 'active', fit: 58 },
  { handle: '@sam.h', name: 'Sam Hollis', tier: 'new', lifecycle: 'prospect', fit: null },
  { handle: '@old.acct', name: 'Casey Lin', tier: 'new', lifecycle: 'blocked', fit: 31 },
]

/** One collab per stage, plus the two that make the scorecard mean anything. */
const COLLAB_PLAN = [
  { key: 'source', stage: 'source', creator: 6, branch: 0, outcome: 'open' },
  { key: 'vet', stage: 'vet', creator: 5, branch: 0, outcome: 'open' },
  { key: 'book', stage: 'book', creator: 4, branch: 1, outcome: 'open' },
  { key: 'brief', stage: 'brief', creator: 3, branch: 0, outcome: 'open' },
  { key: 'visit', stage: 'visit', creator: 2, branch: 0, outcome: 'open' },
  { key: 'delivered', stage: 'delivered', creator: 0, branch: 0, outcome: 'open' },
  { key: 'library', stage: 'library', creator: 1, branch: 0, outcome: 'completed' },
  { key: 'ghosted', stage: 'visit', creator: 7, branch: 1, outcome: 'ghosted' },
] as const

const SHOT_VOCABULARY = [
  { term: 'hands', kind: 'subject' },
  { term: 'oil', kind: 'subject' },
  { term: 'towels', kind: 'subject' },
  { term: 'product', kind: 'subject' },
  { term: 'plants', kind: 'subject' },
  { term: 'client', kind: 'subject' },
  { term: 'therapist', kind: 'subject' },
  { term: 'closeup', kind: 'shot' },
  { term: 'macro', kind: 'shot' },
  { term: 'wide', kind: 'shot' },
  { term: 'medium', kind: 'shot' },
  { term: 'warm_light', kind: 'light' },
  { term: 'daylight', kind: 'light' },
  { term: 'low_light', kind: 'light' },
  { term: 'calm', kind: 'vibe' },
  { term: 'clean', kind: 'vibe' },
  { term: 'lush', kind: 'vibe' },
]

/** Queries that found nothing, clustered on a few cells so the gap scan produces believable gaps. */
const ZERO_RESULT_QUERIES = [
  'exterior arrival',
  'exterior arrival wide',
  'arriving at the door',
  'reception greeting',
  'reception welcome',
  'golden hour window',
  'steam room detail',
]

const HIT_QUERIES = [
  'hands',
  'hands closeup',
  'oil pour',
  'towels',
  'product on marble',
  'treatment room wide',
  'sauna',
  'plants',
  'calm morning light hands',
]

export function buildSeed(deps: {
  clock: Clock
  rng: Rng
  newId: IdFactory
  media: MediaManifest
  deviceId?: string
}): SeedResult {
  const { clock, rng, newId, media } = deps
  const deviceId = deps.deviceId ?? 'seed'
  const t0 = clock.now()
  const rows: SeedRows = {}
  const imperfectCases: string[] = []

  const push = (store: StoreName, value: Record<string, unknown>): Record<string, unknown> => {
    const row = {
      id: typeof value.id === 'string' ? value.id : newId(),
      org_id: ORG_ID,
      created_at: value.created_at ?? t0,
      updated_at: value.updated_at ?? t0,
      // Seeded rows are treated as already synced, so the demo does not open with
      // a full outbox implying work nobody did.
      server_updated_at: t0,
      deleted_at: null,
      rev: 1,
      origin_device: deviceId,
      ...value,
    }
    ;(rows[store] ??= []).push(row)
    return row
  }

  const pickOne = <T>(items: readonly T[]): T => items[Math.floor(rng.next() * items.length)] as T

  // ---- org, branches, users -------------------------------------------------
  push('org', { id: ORG_ID, name: 'Astolia', timezone: 'America/Los_Angeles' })

  for (const branch of BRANCHES) {
    push('branch', {
      id: branch.id,
      name: branch.name,
      city: branch.city,
      address: branch.address,
      timezone: 'America/Los_Angeles',
      lat: branch.lat,
      lng: branch.lng,
      rooms: branch.rooms.map((key) => ({ key, label: key.replace(/_/g, ' ') })),
      do_not_shoot: branch.primary ? ['staff room', 'stock cupboard'] : [],
      target_coverage: Object.fromEntries(branch.rooms.map((room) => [room, branch.primary ? 6 : 3])),
    })
  }

  push('app_user', {
    id: 'user-manager',
    role: 'manager',
    display_name: 'Dana Alvarez',
    email: 'dana@astolia.example',
    branch_scope: null,
  })
  push('app_user', {
    id: 'user-editor',
    role: 'editor',
    display_name: 'Eli Ross',
    email: 'eli@astolia.example',
    branch_scope: null,
  })
  // A branch scoped manager, to prove the mechanism exists without building a role.
  push('app_user', {
    id: 'user-manager-sj',
    role: 'manager',
    display_name: 'Priya Raman',
    email: 'priya@astolia.example',
    branch_scope: ['branch-san-jose'],
  })

  // ---- vocabulary ----------------------------------------------------------
  for (const entry of SHOT_VOCABULARY) {
    push('tag_vocabulary', {
      id: `vocab-${entry.term}`,
      term: entry.term,
      kind: entry.kind,
      status: 'active',
      aliases: [],
      created_by: 'seed',
    })
  }
  // Proposed terms created by the rule that watches query tokens with no vocabulary
  // entry. This is the vocabulary growing from demand rather than from a meeting.
  for (const term of ['exterior', 'arrival', 'greeting', 'steam']) {
    push('tag_vocabulary', {
      id: `vocab-${term}`,
      term,
      kind: 'subject',
      status: 'proposed',
      aliases: [],
      created_by: 'rule',
    })
  }

  // ---- creators ------------------------------------------------------------
  const creatorIds: string[] = []
  CREATORS.forEach((creator, index) => {
    const id = `creator-${index + 1}`
    creatorIds.push(id)
    const completed = creator.tier === 'trusted' ? 4 : creator.tier === 'proven' ? 2 : 0
    push('creator', {
      id,
      display_name: creator.name,
      primary_handle: creator.handle,
      lifecycle: creator.lifecycle,
      platforms: [{ network: 'instagram', handle: creator.handle, followers: 4000 + index * 2300 }],
      contact_email: `${creator.handle.replace('@', '')}@example.com`,
      contact_phone: null,
      fit_score: creator.fit,
      fit_reasons: creator.fit
        ? ['audience overlaps wellness and local lifestyle', 'shoots vertical natively', 'clean brand history']
        : [],
      risk_flags: creator.lifecycle === 'blocked' ? ['prior usage dispute'] : [],
      suggested_tier: creator.fit && creator.fit > 75 ? 'full_day' : 'half_day',
      fit_score_override: index === 5 ? 62 : null,
      override_reason: index === 5 ? 'Audience is younger than the branch demographic.' : null,
      reliability_tier: creator.tier,
      scorecard: {
        completed_collabs: completed,
        approval_rate: completed ? 0.62 + index * 0.04 : null,
        promise_kept_rate: completed ? 0.7 + index * 0.03 : null,
        brand_safety_hits: 0,
        consent_problems: 0,
      },
      notes: index === 3 ? 'Slow to reply, delivers well once on site.' : null,
    })
  })
  imperfectCases.push('a human override of an AI fit score, with the reason stored')
  imperfectCases.push('a blocked creator, so the hard gate has data')

  // ---- collabs, briefs, brief items ---------------------------------------
  const collabIds: Record<string, string> = {}
  const briefItemsByCollab: Record<string, Record<string, unknown>[]> = {}

  COLLAB_PLAN.forEach((plan, index) => {
    const id = `collab-${plan.key}`
    collabIds[plan.key] = id
    const branch = BRANCHES[plan.branch]!
    const visitOffset = plan.key === 'ghosted' ? -21 * DAY : plan.key === 'visit' ? 0 : -(index + 2) * DAY

    push('collab', {
      id,
      creator_id: creatorIds[plan.creator],
      branch_id: branch.id,
      owner_user_id: 'user-manager',
      stage: plan.stage,
      stage_entered_at: t0 - (index + 1) * DAY,
      visit_at: plan.stage === 'source' || plan.stage === 'vet' ? null : t0 + visitOffset,
      vip_tier: plan.stage === 'source' ? null : 'half_day',
      comp_value_usd: plan.stage === 'source' ? null : 240 + index * 40,
      outcome: plan.outcome,
      usage_terms_text:
        plan.stage === 'source' || plan.stage === 'vet'
          ? null
          : 'Astolia may use delivered footage on organic and paid social for 12 months from delivery. Creator retains the right to post the same footage. No use in print without written agreement.',
      consent_text_version: plan.stage === 'source' || plan.stage === 'vet' ? null : 'consent-v1',
      consent_accepted_at: plan.stage === 'source' || plan.stage === 'vet' ? null : t0 + visitOffset - DAY,
      notes: null,
    })

    // Briefs exist from the brief stage onwards.
    if (['brief', 'visit', 'delivered', 'library', 'ghosted'].includes(plan.key)) {
      const briefId = `brief-${plan.key}`
      const locked = plan.key !== 'brief'
      push('brief', {
        id: briefId,
        collab_id: id,
        status: locked ? 'locked' : 'draft',
        version: 1,
        locked_at: locked ? t0 + visitOffset - DAY : null,
        // The loop link, only on the briefs that came from a scan.
        gap_scan_id: plan.key === 'delivered' || plan.key === 'visit' ? 'gap-scan-current' : null,
        tech_specs_key: 'tech-v1',
        usage_terms_key: 'terms-v1',
        edited_fields: plan.key === 'brief' ? ['item-3.instruction'] : [],
      })

      const itemCount = 10
      const items: Record<string, unknown>[] = []
      for (let seq = 1; seq <= itemCount; seq += 1) {
        const room = branch.rooms[seq % branch.rooms.length]!
        const shot = pickOne(['closeup', 'macro', 'wide', 'medium'])
        // Two items on the hero brief trace back to a real gap, which is what makes
        // the loop measurable rather than merely claimed.
        const originGap =
          plan.key === 'delivered' && seq <= 2 ? (seq === 1 ? 'gap-exterior-arrival' : 'gap-reception-greeting') : null
        items.push(
          push('brief_item', {
            id: `${briefId}-item-${seq}`,
            brief_id: briefId,
            seq,
            instruction: `${shot} of ${room.replace(/_/g, ' ')}, vertical, natural light`,
            shot_type: shot,
            room,
            min_takes: 2,
            origin_gap_id: originGap,
          }),
        )
      }
      briefItemsByCollab[plan.key] = items
    }
  })

  // ---- deliveries and assets ----------------------------------------------
  const items = media.items
  let published = 0
  const assetRows: Record<string, unknown>[] = []

  /** Library assets: the closed collab's work, published and searchable. */
  const libraryDelivery = push('delivery', {
    id: 'delivery-library',
    collab_id: collabIds.library,
    state: 'reviewed',
    submitted_at: t0 - 5 * DAY,
    ingest_policy: { tier: 'ample', frame_long_edge: 480, jpeg_quality: 0.72 },
    nudge_draft_text: null,
    nudge_sent_at: null,
  })

  items.forEach((item, index) => {
    const isLibrary = index < 20
    const delivery = isLibrary ? libraryDelivery : null
    if (!delivery) return

    const branch = index % 7 === 6 ? BRANCHES[1]! : BRANCHES[0]!
    const asset = makeAsset({
      id: `asset-lib-${index + 1}`,
      item,
      collabId: collabIds.library!,
      deliveryId: delivery.id as string,
      branchId: branch.id,
      briefItemId: briefItemsByCollab.library?.[index % 10]?.id as string | undefined,
      creatorCredit: `${CREATORS[1]!.name} (${CREATORS[1]!.handle})`,
      t0,
      published: true,
      rng,
    })
    published += 1
    assetRows.push(push('asset', asset))
  })

  /** The hero delivery: deliberately imperfect, and the record the demo opens on. */
  const heroDelivery = push('delivery', {
    id: 'delivery-hero',
    collab_id: collabIds.delivered,
    state: 'submitted',
    submitted_at: t0 - 2 * 3600_000,
    ingest_policy: { tier: 'constrained', frame_long_edge: 360, jpeg_quality: 0.66 },
    nudge_draft_text:
      'Thanks for today. We are missing three shots from the list: the exterior arrival, the reception greeting, and one more take of the hands closeup. Anything you can grab before you leave would be ideal.',
    nudge_sent_at: null,
  })

  const heroItems = briefItemsByCollab.delivered ?? []
  // 7 of 10 brief items covered, so the diff has something real to show.
  const coveredItemIndexes = [0, 2, 3, 4, 6, 7, 9]
  let heroIndex = 0
  for (const itemIndex of coveredItemIndexes) {
    const takes = itemIndex === 2 ? 3 : 2
    for (let take = 0; take < takes; take += 1) {
      const media_item = items[(heroIndex + 3) % items.length]!
      const asset = makeAsset({
        id: `asset-hero-${heroIndex + 1}`,
        item: media_item,
        collabId: collabIds.delivered!,
        deliveryId: heroDelivery.id as string,
        branchId: BRANCHES[0]!.id,
        briefItemId: heroItems[itemIndex]?.id as string | undefined,
        creatorCredit: `${CREATORS[0]!.name} (${CREATORS[0]!.handle})`,
        t0,
        published: false,
        rng,
      })
      assetRows.push(push('asset', asset))
      heroIndex += 1
    }
  }

  // Extras: clips matching no brief item at all. Creators always shoot extra, and
  // a diff that cannot show extras is wrong.
  for (let extra = 0; extra < 3; extra += 1) {
    const asset = makeAsset({
      id: `asset-hero-extra-${extra + 1}`,
      item: items[(extra + 11) % items.length]!,
      collabId: collabIds.delivered!,
      deliveryId: heroDelivery.id as string,
      branchId: BRANCHES[0]!.id,
      briefItemId: undefined,
      creatorCredit: `${CREATORS[0]!.name} (${CREATORS[0]!.handle})`,
      t0,
      published: false,
      rng,
    })
    assetRows.push(push('asset', asset))
  }
  imperfectCases.push('7 of 10 brief items covered, so the promise versus delivered diff is real')
  imperfectCases.push('3 clips matching no brief item, landing in the extras bucket')

  // A rejected clip, with a blunt internal reason and a softer creator facing note.
  const rejected = assetRows.find((a) => a.id === 'asset-hero-2')
  if (rejected) {
    rejected.review_status = 'rejected'
    rejected.reject_reason_text = 'Framing is sloppy and the towel is stained. Creator rushed it.'
    rejected.creator_facing_note = 'Could we get one more of this with a fresh towel in frame?'
  }
  imperfectCases.push('a rejected clip whose internal reason is redacted for the creator')

  // A duplicate pair, bytes differ and frames match.
  const dupA = assetRows.find((a) => a.id === 'asset-hero-3')
  const dupB = assetRows.find((a) => a.id === 'asset-hero-4')
  if (dupA && dupB) {
    dupB.phash_primary = dupA.phash_primary
    const preflight = dupB.preflight as Record<string, unknown>
    preflight.duplicate = {
      status: 'fail',
      evidence: 'phash',
      reason: null,
      blocking: false,
      value: dupA.id,
    }
  }
  imperfectCases.push('a duplicate pair detected by frame hash rather than by bytes')

  // The open HEVC hole: no sheet, no AI, nothing invented.
  const hevc = assetRows.find((a) => a.id === 'asset-hero-6')
  if (hevc) {
    hevc.codec_video = 'hvc1'
    hevc.client_decodable = false
    hevc.needs_transcode = true
    hevc.derivative_state = 'none'
    hevc.sheet_key = null
    hevc.poster_key = null
    hevc.ai_description = null
    hevc.ai_shot_type = null
    hevc.ai_room = null
    hevc.ai_subjects = []
    hevc.ai_quality_score = null
    hevc.ai_framing_score = null
    hevc.ai_confidence = null
    hevc.ai_brand_safety = null
    hevc.ai_provenance = 'none'
    ;(hevc.preflight as Record<string, unknown>).codec_playable = {
      status: 'fail',
      evidence: 'probe',
      reason: 'no_decoder_in_shell',
      blocking: false,
      value: 'hvc1',
    }
  }
  imperfectCases.push('an HEVC clip no runtime here can decode: no sheet, no AI, nothing guessed')

  // A camera offload: no GPS chip, so near_branch is unknown rather than failed.
  const camera = assetRows.find((a) => a.id === 'asset-hero-8')
  if (camera) {
    camera.filename = 'A001_C012_0804XY.mov'
    camera.codec_video = 'apcn'
    camera.gps = null
    camera.captured_at_source = 'mvhd'
    ;(camera.preflight as Record<string, unknown>).near_branch = {
      status: 'unknown',
      evidence: null,
      reason: 'no_gps_in_container',
      blocking: false,
    }
    ;(camera.preflight as Record<string, unknown>).orientation = {
      status: 'fail',
      evidence: 'coded_dims',
      reason: null,
      blocking: true,
      value: 'horizontal',
    }
  }
  imperfectCases.push('a camera offload with no GPS: unknown, never a failure')

  // AI and human disagreement, so match accuracy is a real number rather than 100%.
  const disagree = assetRows.find((a) => a.id === 'asset-hero-5')
  if (disagree && heroItems[8]) {
    disagree.ai_matched_brief_item_id = heroItems[8].id
    disagree.confirmed_brief_item_id = heroItems[4]?.id ?? null
  }
  imperfectCases.push('an AI match a human corrected, so match accuracy is measurable')

  // A brand safety hold, so the hard gate is visible.
  const hold = assetRows.find((a) => a.id === 'asset-hero-9')
  if (hold) hold.ai_brand_safety = 'review'
  imperfectCases.push('a brand safety hold that can never be auto approved')

  // ---- tags ---------------------------------------------------------------
  for (const asset of assetRows) {
    if (asset.ai_provenance === 'none') continue // nothing was seen, so nothing is tagged
    const subjects = (asset.ai_subjects as string[]) ?? []
    const terms = [...subjects, asset.ai_shot_type as string, asset.ai_room as string].filter(Boolean)
    for (const term of terms) {
      push('tag', {
        asset_id: asset.id,
        term,
        source: 'ai',
        confidence: 0.55 + rng.next() * 0.4,
        ai_run_id: null,
        removed_at: null,
        rejected_by_human: false,
      })
    }
    // A human correction on some assets: the disagreement is the eval set.
    if (rng.next() < 0.25) {
      push('tag', {
        asset_id: asset.id,
        term: pickOne(['towels', 'plants', 'warm_light', 'calm']),
        source: 'human',
        confidence: null,
        ai_run_id: null,
        removed_at: null,
        rejected_by_human: false,
      })
    }
  }

  // ---- search history, which the gap scan reads ---------------------------
  let queryIndex = 0
  const logQuery = (text: string, outcome: string, clickedRank: number | null) => {
    queryIndex += 1
    const id = `query-${queryIndex}`
    push('search_query_log', {
      id,
      user_id: 'user-editor',
      text,
      tokens: text.toLowerCase().split(/\s+/),
      outcome,
      result_count: outcome === 'zero_results' ? 0 : 4 + Math.floor(rng.next() * 12),
      clicked_ranks: clickedRank === null ? [] : [clickedRank],
      refined_from_query_id: null,
      created_at: t0 - Math.floor(rng.next() * 30) * DAY,
    })
    return id
  }

  for (let i = 0; i < 90; i += 1) {
    const text = pickOne(HIT_QUERIES)
    // Clicks land beyond rank one often enough that the ranking signal is not
    // trivially "always the first result".
    logQuery(text, 'clicked', 1 + Math.floor(rng.next() * 8))
  }
  for (let i = 0; i < 28; i += 1) {
    logQuery(pickOne(ZERO_RESULT_QUERIES), 'zero_results', null)
  }
  for (let i = 0; i < 12; i += 1) {
    logQuery(pickOne(HIT_QUERIES), 'abandoned', null)
  }

  // ---- usage events -------------------------------------------------------
  const publishedAssets = assetRows.filter((a) => a.is_published === true)
  for (let i = 0; i < 140; i += 1) {
    const asset = pickOne(publishedAssets)
    const kind = pickOne(['view_asset', 'preview_play', 'download', 'add_to_collection', 'copy_link'])
    push('usage_event', {
      asset_id: asset.id,
      user_id: 'user-editor',
      kind,
      // The cleanest relevance label available, and impossible to backfill.
      rank_at_event: 1 + Math.floor(rng.next() * 9),
      query_id: `query-${1 + Math.floor(rng.next() * queryIndex)}`,
      created_at: t0 - Math.floor(rng.next() * 21) * DAY,
    })
  }

  // ---- collections --------------------------------------------------------
  push('saved_collection', {
    id: 'collection-spring',
    owner_user_id: 'user-editor',
    kind: 'manual',
    name: 'SJ Spring Promo',
    query_text: null,
    is_pinned: true,
    is_shared: false,
    last_opened_at: t0 - DAY,
    open_count: 11,
  })
  push('saved_collection', {
    id: 'collection-hands',
    owner_user_id: 'user-editor',
    kind: 'saved_search',
    name: 'hands, warm light',
    query_text: 'hands warm light',
    is_pinned: false,
    is_shared: false,
    last_opened_at: t0 - 3 * DAY,
    open_count: 4,
  })
  publishedAssets.slice(0, 6).forEach((asset, rank) => {
    push('collection_item', {
      collection_id: 'collection-spring',
      asset_id: asset.id,
      rank,
      note: null,
    })
  })

  // ---- the gap scan and its gaps -----------------------------------------
  push('gap_scan', {
    id: 'gap-scan-previous',
    ran_at: t0 - 30 * DAY,
    window_days: 30,
    cells_examined: 84,
    gaps_found: 5,
  })
  push('gap_scan', {
    id: 'gap-scan-current',
    ran_at: t0 - DAY,
    window_days: 30,
    cells_examined: 84,
    gaps_found: 9,
  })

  interface GapPlan {
    id: string
    /** A coverage cell. Keys vary by cell, which is why the signature is derived rather than fixed. */
    facets: Record<string, string>
    score: number
    severity: string
    status: string
  }

  const gapPlan: GapPlan[] = [
    { id: 'gap-exterior-arrival', facets: { room: 'exterior', shot_type: 'wide' }, score: 0.91, severity: 'critical', status: 'open' },
    { id: 'gap-reception-greeting', facets: { room: 'reception', shot_type: 'medium' }, score: 0.84, severity: 'critical', status: 'open' },
    { id: 'gap-steam-detail', facets: { room: 'wet_room', shot_type: 'macro' }, score: 0.71, severity: 'high', status: 'open' },
    { id: 'gap-golden-hour', facets: { light: 'warm_light', room: 'treatment_room' }, score: 0.66, severity: 'high', status: 'open' },
    { id: 'gap-pa-treatment', facets: { room: 'treatment_room', branch: 'branch-palo-alto' }, score: 0.63, severity: 'high', status: 'open' },
    { id: 'gap-lounge-wide', facets: { room: 'lounge', shot_type: 'wide' }, score: 0.44, severity: 'medium', status: 'open' },
    { id: 'gap-sauna-medium', facets: { room: 'sauna', shot_type: 'medium' }, score: 0.41, severity: 'medium', status: 'open' },
    { id: 'gap-product-dark', facets: { vibe: 'moody', shot_type: 'macro' }, score: 0.38, severity: 'medium', status: 'open' },
    { id: 'gap-towels-macro', facets: { subject: 'towels', shot_type: 'macro' }, score: 0.35, severity: 'medium', status: 'open' },
    { id: 'gap-closed-hands', facets: { subject: 'hands', shot_type: 'closeup' }, score: 0.2, severity: 'low', status: 'closed' },
    { id: 'gap-dismissed-parking', facets: { room: 'parking', shot_type: 'wide' }, score: 0.3, severity: 'low', status: 'dismissed' },
  ]

  for (const gap of gapPlan) {
    const signature = signatureOf(gap.facets)
    push('gap', {
      id: gap.id,
      gap_scan_id: 'gap-scan-current',
      branch_id: (gap.facets as { branch?: string }).branch ?? 'branch-san-jose',
      cell_signature: signature,
      facets: gap.facets,
      score: gap.score,
      severity: gap.severity,
      status: gap.status,
      signals: [
        { source: 'zero_result_queries', weight: 0.6, detail: '7 in the last 30 days' },
        { source: 'coverage_target', weight: 0.3, detail: '0 of 6 target clips' },
        { source: 'editor_request', weight: 0.1 },
      ],
      closing_asset_ids: gap.status === 'closed' ? [publishedAssets[0]?.id as string] : [],
    })
    if (gap.status === 'dismissed') {
      // Keyed by signature, not by id, so it survives the next scan.
      push('gap_dismissal', {
        cell_signature: signature,
        dismissed_by: 'user-manager',
        reason: 'There is no parking area at this branch.',
      })
    }
  }
  imperfectCases.push('a dismissal keyed by cell signature, so a rescan does not resurrect it')
  imperfectCases.push('Palo Alto is thin on purpose, so the gap scan cold start path has data')

  // ---- review actions -----------------------------------------------------
  for (const asset of publishedAssets.slice(0, 14)) {
    push('review_action', {
      asset_id: asset.id,
      session_id: 'review-session-1',
      actor_user_id: 'user-manager',
      decision: 'approved',
      // Recorded from day one, because the moment batch approve exists every
      // scorecard computed from review_status becomes meaningless without it.
      method: rng.next() < 0.25 ? 'batch' : 'manual',
      ai_provenance_at_decision: 'mock',
      note: null,
    })
  }

  // ---- access tokens ------------------------------------------------------
  push('access_token', {
    id: 'token-visit',
    collab_id: collabIds.visit,
    token_hash: DEMO_CREATOR_TOKEN_HASH,
    purpose: 'upload',
    expires_at: t0 + 14 * DAY,
    revoked_at: null,
  })
  push('access_token', {
    id: 'token-expired',
    collab_id: collabIds.library,
    token_hash: DEMO_EXPIRED_TOKEN_HASH,
    purpose: 'upload',
    expires_at: t0 - 3 * DAY,
    revoked_at: null,
  })

  const counts = Object.fromEntries(Object.entries(rows).map(([store, list]) => [store, list.length]))

  return { rows, summary: { counts, publishedAssets: published, imperfectCases } }
}

function makeAsset(input: {
  id: string
  item: MediaManifestItem
  collabId: string
  deliveryId: string
  branchId: string
  briefItemId: string | undefined
  creatorCredit: string
  t0: number
  published: boolean
  rng: Rng
}): Record<string, unknown> {
  const { item, rng } = input
  const vertical = item.orientation === 'vertical'
  const confidence = 0.5 + rng.next() * 0.45

  return {
    id: input.id,
    kind: 'video',
    delivery_id: input.deliveryId,
    collab_id: input.collabId,
    branch_id: input.branchId,
    filename: `${item.slug}.mp4`,
    bytes: item.derived_clip.bytes,
    duration_s: item.derived_clip.duration_s,
    coded_width: item.derived_clip.width,
    coded_height: item.derived_clip.height,
    rotation_deg: 0,
    codec_video: 'avc1',
    has_audio: false,
    captured_at: input.t0 - 3 * DAY,
    captured_at_source: 'mvhd',
    gps: { lat: 37.3082, lng: -121.9046 },
    client_decodable: true,
    needs_transcode: false,
    probe_result: 'h264:yes',
    preflight_version: 2,
    preflight: {
      orientation: {
        status: vertical ? 'pass' : 'fail',
        evidence: 'coded_dims',
        reason: null,
        blocking: true,
        value: vertical ? 'vertical' : 'horizontal',
      },
      min_duration: { status: 'pass', evidence: 'mvhd', reason: null, blocking: true, value: item.derived_clip.duration_s },
      min_resolution: { status: 'pass', evidence: 'coded_dims', reason: null, blocking: true },
      capture_date: { status: 'pass', evidence: 'mvhd', reason: null, blocking: false },
      near_branch: { status: 'pass', evidence: 'gps', reason: null, blocking: false, value: 120 },
      duplicate: { status: 'pass', evidence: 'phash', reason: null, blocking: false },
      codec_playable: { status: 'pass', evidence: 'probe', reason: null, blocking: false, value: 'avc1' },
    },
    ai_description: describeItem(item),
    ai_shot_type: item.meta.shot_type,
    ai_room: item.meta.room,
    ai_subjects: item.meta.subjects,
    ai_quality_score: 0.55 + rng.next() * 0.4,
    ai_framing_score: 0.5 + rng.next() * 0.45,
    ai_confidence: confidence,
    ai_brand_safety: 'clear',
    ai_matched_brief_item_id: input.briefItemId ?? null,
    // Every AI field here came from an authored mock, and the record says so.
    ai_provenance: 'mock',
    review_status: input.published ? 'approved' : 'pending',
    is_published: input.published,
    is_published_i: input.published ? 1 : 0,
    confirmed_brief_item_id: input.published ? (input.briefItemId ?? null) : null,
    is_hero: false,
    reject_reason_text: null,
    creator_facing_note: null,
    is_exemplar: false,
    is_exemplar_i: 0,
    exemplar_note: null,
    media_state: item.derived_clip.committed ? 'bytes_local' : 'bytes_absent',
    derivative_state: 'ready',
    bytes_key: item.derived_clip.committed ? item.derived_clip.path : null,
    poster_key: item.poster.path,
    sheet_key: item.contact_sheet.path,
    phash_primary: `p-${item.slug}`,
    frame_hashes: [`f1-${item.slug}`, `f2-${item.slug}`],
    used_count: 0,
    download_count: 0,
    creator_credit: input.creatorCredit,
    usage_scope: 'organic_and_paid_social',
  }
}

function describeItem(item: MediaManifestItem): string {
  const subjects = item.meta.subjects.join(' and ')
  return `${item.meta.shot_type} of ${subjects} in the ${item.meta.room.replace(/_/g, ' ')}, ${item.meta.light.replace(/_/g, ' ')}, ${item.meta.vibe} feel`
}

/** Stable signature for a coverage cell, so a dismissal survives a rescan. */
export function signatureOf(facets: Record<string, string>): string {
  return Object.keys(facets)
    .sort()
    .map((key) => `${key}=${facets[key]}`)
    .join('|')
}
