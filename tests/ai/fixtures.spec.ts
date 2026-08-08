/**
 * The authored fixture set, checked against the artefacts it claims to describe.
 *
 * Decision U8 says the mock's answers were authored offline by a model looking at
 * the real contact sheets. That is a claim about how a file was written, which
 * normally means it cannot be tested at all. Three things here make it checkable:
 *
 * 1. every vision fixture records the sha256 of the sheet it was written against,
 *    and that hash has to be in the committed media manifest, so a fixture cannot
 *    describe an image that is no longer in the repository
 * 2. the seeded assets each fixture claims are asserted against `buildSeed`, so the
 *    mapping cannot drift when the seed changes how it walks the manifest
 * 3. every authored answer is validated against the same schema the live path would
 *    send, which is the whole claim that mock is not a fork
 *
 * The last block is the one that would be easiest to leave out and matters most: it
 * asserts the set is deliberately imperfect. A fixture set with no middle band, no
 * rejected tag, no refusal and no malformed response produces an interface that has
 * only ever rendered success.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'
import {
  checkBriefMatch,
  checkVet,
  checkVisionTag,
  COVERS_CONFIDENCE_FLOOR,
  createMockProvider,
  MATCH_SUGGESTION_FLOOR,
  schemaFor,
  TAG_TERM_ENUM,
  validate,
  type AiError,
} from '@/ai'
import {
  BRIEF_MATCH_FIXTURES,
  FAILURE_MANIFEST,
  FIXTURE_MANIFEST,
  GAP_SCAN_FIXTURES,
  NUDGE_FIXTURES,
  SEARCH_PARSE_FIXTURES,
  VET_FIXTURES,
  VISION_BY_ASSET,
  VISION_FIXTURES,
} from '@/ai/fixtures'
import { noSleep } from '@/ai/sleep'
import { buildSeed, type MediaManifest } from '@/data/seed'
import { SEED_EPOCH_MS, SeededClock } from '@/platform/clock'
import { createIdFactory } from '@/platform/id'
import { SEED_STRING, SeededRng } from '@/platform/rng'
import { briefGenInput, briefMatchInput, gapScanInput, nudgeInput, searchInput, vetInput, visionInput } from './_inputs'

const MANIFEST_PATH = join(cwd(), 'public', 'seed', 'media-manifest.json')

interface ManifestItem {
  slug: string
  contact_sheet: { path: string; sha256: string; frames: number }
}

function manifest(): { items: ManifestItem[] } {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { items: ManifestItem[] }
}

/** The seeded assets, built from the real committed manifest. */
function seededAssets(): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as unknown as MediaManifest
  const clock = new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: 1 })
  const rng = new SeededRng(SEED_STRING)
  const seed = buildSeed({ clock, rng, newId: createIdFactory(clock, rng), media: raw })
  return seed.rows.asset ?? []
}

function ai() {
  return createMockProvider({ sleep: noSleep })
}

describe('the fixture set describes artefacts that are still in the repository', () => {
  it('gives every fixture a unique id and a simulated think time', () => {
    const ids = FIXTURE_MANIFEST.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const fixture of FIXTURE_MANIFEST) {
      expect(fixture.latency_ms, fixture.id).toBeGreaterThan(0)
      expect(fixture.provenance.artefact, fixture.id).not.toBe('')
    }
  })

  it('matches every vision fixture hash to a committed contact sheet', () => {
    const bySha = new Map(manifest().items.map((item) => [item.contact_sheet.sha256, item]))
    for (const fixture of VISION_FIXTURES) {
      expect(fixture.provenance.sha256, `${fixture.id} has no artefact hash`).toBeTruthy()
      const item = bySha.get(fixture.provenance.sha256!)
      expect(item, `${fixture.id} names a sheet hash that is not in the media manifest`).toBeDefined()
      expect(fixture.provenance.artefact).toBe(item!.contact_sheet.path)
    }
  })

  it('was authored against five frame sheets, which is what the fixture prose assumes', () => {
    const bySha = new Map(manifest().items.map((item) => [item.contact_sheet.sha256, item]))
    for (const fixture of VISION_FIXTURES) {
      expect(bySha.get(fixture.provenance.sha256!)!.contact_sheet.frames, fixture.id).toBe(5)
    }
  })

  it('claims only seeded assets that really carry that sheet', () => {
    const assets = new Map(seededAssets().map((asset) => [asset.id as string, asset]))
    for (const fixture of VISION_FIXTURES) {
      for (const assetId of fixture.asset_ids) {
        const asset = assets.get(assetId)
        expect(asset, `${fixture.id} claims ${assetId}, which the seed does not produce`).toBeDefined()
        expect(
          asset!.sheet_key,
          `${fixture.id} claims ${assetId}, whose sheet is ${String(asset!.sheet_key)}`,
        ).toBe(fixture.provenance.artefact)
      }
    }
  })

  it('has no fixture keyed to an asset with no contact sheet', () => {
    // The HEVC hole. A fixture keyed to it could only ever be a fabrication, and the
    // refusal path is what that asset must reach instead.
    const withoutSheet = seededAssets().filter((asset) => asset.sheet_key === null)
    expect(withoutSheet.length, 'the seed no longer contains an undecodable clip').toBeGreaterThan(0)
    for (const asset of withoutSheet) {
      expect(VISION_BY_ASSET.has(asset.id as string), `a fixture is keyed to ${String(asset.id)}`).toBe(false)
    }
  })
})

describe('every authored answer validates the schema the live path would use', () => {
  it('validates each vision fixture, with the frame count echoed in', () => {
    const schema = schemaFor('vision_tag').schema
    for (const fixture of VISION_FIXTURES) {
      const check = validate(schema, { ...fixture.output, frames_seen: 5 })
      expect(check.ok, `${fixture.id}: ${JSON.stringify(check.errors)}`).toBe(true)
    }
  })

  it('draws every tag term from the closed taxonomy', () => {
    const known = new Set(TAG_TERM_ENUM)
    for (const fixture of VISION_FIXTURES) {
      for (const tag of fixture.output.tags) {
        expect(known.has(tag.term), `${fixture.id} used "${tag.term}"`).toBe(true)
      }
    }
  })

  it('validates every keyed vetting fixture through the provider', async () => {
    const schema = schemaFor('vet').schema
    for (const fixture of VET_FIXTURES) {
      for (const creatorId of fixture.creator_ids) {
        const result = await ai().vet(vetInput({ creator_id: creatorId }))
        const check = validate(schema, result.output)
        expect(check.ok, `${fixture.id} via ${creatorId}: ${JSON.stringify(check.errors)}`).toBe(true)
      }
    }
  })

  it('validates every keyed brief match fixture through the provider', async () => {
    const schema = schemaFor('brief_match').schema
    for (const fixture of BRIEF_MATCH_FIXTURES) {
      for (const itemId of fixture.brief_item_ids) {
        const result = await ai().brief_match(briefMatchInput({ brief_item_id: itemId }))
        const check = validate(schema, result.output)
        expect(check.ok, `${fixture.id} via ${itemId}: ${JSON.stringify(check.errors)}`).toBe(true)
      }
    }
  })

  it('validates every authored query parse through the provider', async () => {
    const schema = schemaFor('search_parse').schema
    for (const fixture of SEARCH_PARSE_FIXTURES) {
      for (const query of fixture.queries) {
        const result = await ai().search_parse(searchInput({ query_text: query }))
        const check = validate(schema, result.output)
        expect(check.ok, `${fixture.id} via "${query}": ${JSON.stringify(check.errors)}`).toBe(true)
      }
    }
  })

  it('validates every authored gap phrasing through the provider', async () => {
    const schema = schemaFor('gap_scan').schema
    for (const fixture of GAP_SCAN_FIXTURES) {
      const result = await ai().gap_scan(
        gapScanInput({
          cells: [
            {
              cell_signature: fixture.cell_signature,
              facets: fixture.cell_signature.replace(/\|/g, ', '),
              severity: 'high',
              signal_summary: '4 zero result queries in 30 days',
            },
          ],
        }),
      )
      const check = validate(schema, result.output)
      expect(check.ok, `${fixture.id}: ${JSON.stringify(check.errors)}`).toBe(true)
      expect(result.output.cells[0]!.title).toBe(fixture.output.title)
    }
  })

  it('validates every authored nudge draft through the provider', async () => {
    const schema = schemaFor('nudge_draft').schema
    for (const fixture of NUDGE_FIXTURES) {
      const result = await ai().nudge_draft(nudgeInput({ tone_hint: fixture.tone }))
      const check = validate(schema, result.output)
      expect(check.ok, `${fixture.id}: ${JSON.stringify(check.errors)}`).toBe(true)
      // No substitution token may survive into a message a human might send.
      expect(result.output.body_text).not.toMatch(/%[A-Z_]+%/)
      expect(result.output.subject_line).not.toMatch(/%[A-Z_]+%/)
    }
  })

  it('validates the brief generator at every item count it accepts', async () => {
    const schema = schemaFor('brief_gen').schema
    for (const count of [1, 4, 10, 12]) {
      const result = await ai().brief_gen(briefGenInput({ target_item_count: count }))
      const check = validate(schema, result.output)
      expect(check.ok, `count ${count}: ${JSON.stringify(check.errors)}`).toBe(true)
    }
  })
})

describe('the set is deliberately imperfect, which is the harder half of this job', () => {
  it('records what is wrong with most of its own fixtures', () => {
    const flawed = FIXTURE_MANIFEST.filter((f) => f.imperfection !== null)
    // Not all of them: one clean, confident, no-caveat answer has to exist too, or
    // "hedged" becomes the only state the interface ever renders.
    expect(flawed.length).toBeGreaterThan(FIXTURE_MANIFEST.length / 2)
    expect(flawed.length).toBeLessThan(FIXTURE_MANIFEST.length)
  })

  it('spreads vision confidence across the range including the middle band', () => {
    const confidences = VISION_FIXTURES.map((f) => f.output.overall_confidence)
    expect(confidences.some((c) => c >= 0.8)).toBe(true)
    expect(confidences.some((c) => c > 0.4 && c < 0.7)).toBe(true)
    expect(new Set(confidences).size).toBeGreaterThan(4)
  })

  it('includes low confidence tags a human is expected to reject', () => {
    const lowTags = VISION_FIXTURES.flatMap((f) => f.output.tags.filter((t) => t.confidence < 0.5))
    expect(lowTags.length).toBeGreaterThanOrEqual(2)
  })

  it('includes a fixture that admits the taxonomy has no word for what it saw', () => {
    const admits = VISION_FIXTURES.filter(
      (f) => f.output.uncertainty !== null && /no term for|closest of|would carry it better/.test(f.output.uncertainty),
    )
    expect(admits.length).toBeGreaterThanOrEqual(2)
  })

  it('includes both a hedged answer and one with nothing to hedge', () => {
    expect(VISION_FIXTURES.some((f) => f.output.uncertainty === null)).toBe(true)
    expect(VISION_FIXTURES.some((f) => f.output.uncertainty !== null)).toBe(true)
  })

  it('raises review flags on the clips that need a human, including the text on screen case', () => {
    const flagged = VISION_FIXTURES.filter((f) => f.output.review_flags.length > 0)
    expect(flagged.length).toBeGreaterThanOrEqual(4)
    expect(VISION_FIXTURES.some((f) => f.output.text_on_screen)).toBe(true)
    const flags = [...new Set(VISION_FIXTURES.flatMap((f) => f.output.review_flags.map((r) => r.flag)))]
    expect(flags).toContain('identifiable_client')
    expect(flags).toContain('possible_third_party')
  })

  it('has one clip matching two different brief items', () => {
    const byAsset = new Map<string, Set<string>>()
    for (const fixture of BRIEF_MATCH_FIXTURES) {
      for (const tuple of fixture.output.tuples) {
        const items = byAsset.get(tuple.asset_id) ?? new Set<string>()
        for (const id of fixture.brief_item_ids) items.add(id)
        byAsset.set(tuple.asset_id, items)
      }
    }
    expect([...byAsset.values()].some((items) => items.size > 1)).toBe(true)
  })

  it('has a covers claim below the floor, so the demotion post-check has a real case', async () => {
    const result = await ai().brief_match(
      briefMatchInput({
        brief_item_id: 'brief-delivered-item-7',
        candidates: [
          { asset_id: 'asset-hero-1', description: 'hands on a client', shot_type: 'closeup', room: 'treatment_room', subjects: ['hands'], duration_s: 6 },
          { asset_id: 'asset-hero-4', description: 'therapist over a client', shot_type: 'medium', room: 'treatment_room', subjects: ['therapist'], duration_s: 6 },
        ],
      }),
    )
    const raw = result.output.matches.find((m) => m.asset_id === 'asset-hero-4')!
    expect(raw.verdict).toBe('covers')
    expect(raw.confidence).toBeLessThan(COVERS_CONFIDENCE_FLOOR)

    const checked = checkBriefMatch(result.output)
    const demoted = checked.value.matches.find((m) => m.asset_id === 'asset-hero-4')!
    expect(demoted.verdict).toBe('possible')
    expect(checked.notes.map((n) => n.code)).toContain('low_confidence_covers_demoted')
  })

  it('has a match below the suggestion floor, so it is dropped rather than shown faintly', async () => {
    const result = await ai().brief_match(
      briefMatchInput({
        brief_item_id: 'brief-delivered-item-2',
        candidates: [
          { asset_id: 'asset-hero-12', description: 'a passage with doors', shot_type: 'medium', room: 'corridor', subjects: ['none_visible'], duration_s: 6 },
          { asset_id: 'asset-hero-5', description: 'an empty table and curtains', shot_type: 'medium', room: 'treatment_room', subjects: ['other'], duration_s: 6 },
        ],
      }),
    )
    expect(result.output.matches.some((m) => m.confidence < MATCH_SUGGESTION_FLOOR)).toBe(true)
    const checked = checkBriefMatch(result.output)
    expect(checked.value.matches.every((m) => m.confidence >= MATCH_SUGGESTION_FLOOR)).toBe(true)
    expect(checked.notes.map((n) => n.code)).toContain('below_suggestion_floor_dropped')
  })

  it('over-claims one match, which is the disagreement the manager surface exists to catch', async () => {
    // The seeded human confirmation puts asset-hero-5 on item 5. The model puts it on
    // item 9, confidently. Both halves of that disagreement are in the data.
    const result = await ai().brief_match(
      briefMatchInput({
        brief_item_id: 'brief-delivered-item-9',
        candidates: [
          { asset_id: 'asset-hero-5', description: 'an empty treatment table with sheer curtains', shot_type: 'medium', room: 'treatment_room', subjects: ['other'], duration_s: 6 },
        ],
      }),
    )
    const match = result.output.matches[0]!
    expect(match.verdict).toBe('covers')
    expect(match.confidence).toBeGreaterThan(COVERS_CONFIDENCE_FLOOR)
    // And it survives the post-checks, which is the point: no deterministic rule can
    // catch a confident wrong answer. Only a human looking at the frames can.
    expect(checkBriefMatch(result.output).value.matches[0]!.verdict).toBe('covers')
  })

  it('has a vetting fixture the boundary post-check demotes', async () => {
    const result = await ai().vet(vetInput({ creator_id: 'creator-5', prior_collabs: 0, scorecard_summary: null }))
    const checked = checkVet(result.output, ['half_day'])
    expect(checked.value.band).toBe('insufficient_evidence')
    expect(checked.value.score).toBeNull()
    expect(checked.notes.map((n) => n.code)).toContain('boundary_score_thin_evidence')
  })

  it('has a vetting fixture whose tier suggestion the band guard drops', async () => {
    const result = await ai().vet(vetInput({ creator_id: 'creator-4', allowed_tiers: ['half_day'] }))
    expect(result.output.suggested_tier).toBe('full_day')
    const checked = checkVet(result.output, ['half_day'])
    expect(checked.value.suggested_tier).toBeNull()
    expect(checked.value.tier_rationale).toBeNull()
    expect(checked.notes.map((n) => n.code)).toContain('tier_outside_band')
  })

  it('has a vetting fixture whose unevidenced flag is dropped before a human sees it', async () => {
    const result = await ai().vet(
      vetInput({ creator_id: 'creator-7', application_note: null, scorecard_summary: null, prior_collabs: 0 }),
    )
    expect(result.output.risk_flags.length).toBeGreaterThan(0)
    const checked = checkVet(result.output, ['half_day'])
    expect(checked.value.risk_flags).toHaveLength(0)
    expect(checked.notes.map((n) => n.code)).toContain('unevidenced_risk_flag_dropped')
  })

  it('keeps the text on screen flag and its boolean agreeing after the post-checks', async () => {
    const result = await ai().vision_tag(visionInput({ asset_id: 'asset-hero-9' }))
    const checked = checkVisionTag(result.output)
    expect(checked.value.text_on_screen).toBe(true)
    expect(checked.value.review_flags.some((f) => f.flag === 'text_on_screen')).toBe(true)
    // Which is why the seeded asset sits on a brand safety hold rather than clear.
    expect(checked.value.review_flags.length).toBeGreaterThan(0)
  })

  it('ships a refusal and a malformed response, and the malformed one really is malformed', () => {
    const reasons = FAILURE_MANIFEST.map((f) => f.failure.reason)
    expect(reasons).toContain('refused')
    expect(reasons).toContain('invalid_output')
    expect(reasons).toContain('rate_limited')
    expect(reasons).toContain('timeout')

    const malformed = FAILURE_MANIFEST.find((f) => f.failure.reason === 'invalid_output')!
    const check = validate(schemaFor('vision_tag').schema, malformed.failure.raw_output)
    expect(check.ok).toBe(false)
    // Two specific breakages, both of the kind structured outputs cannot enforce.
    const keywords = check.errors.map((e) => e.keyword)
    expect(keywords).toContain('maximum')
    expect(keywords).toContain('enum')
  })

  it('explains every failure it ships, because a reason nobody wrote down gets deleted later', () => {
    for (const entry of FAILURE_MANIFEST) {
      expect(entry.failure.note.length, entry.failure.id).toBeGreaterThan(40)
      expect(entry.failure.message.length, entry.failure.id).toBeGreaterThan(20)
    }
  })

  it('makes the seeded delivery carry exactly two permanent errors', async () => {
    // C2.C expects about ninety runs with two in an error state. A rate limit and a
    // timeout clear on retry; a refusal and a malformed response do not.
    const permanent: string[] = []
    for (const entry of FAILURE_MANIFEST) {
      const budget = entry.failure.failures ?? Number.POSITIVE_INFINITY
      if (budget === Number.POSITIVE_INFINITY) permanent.push(entry.failure.id)
    }
    expect(permanent).toHaveLength(3)

    // Two of them are on assets in the hero delivery; the third is a creator, which
    // the eligibility gate should have stopped before any call.
    const provider = ai()
    const reasons: string[] = []
    for (const id of ['asset-hero-2', 'asset-hero-7']) {
      try {
        await provider.vision_tag(visionInput({ asset_id: id }))
        reasons.push('no error')
      } catch (error) {
        reasons.push((error as AiError).reason)
      }
    }
    expect(reasons.sort()).toEqual(['invalid_output', 'refused'])
  })
})
