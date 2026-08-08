/**
 * The pre-flight rule engine, against the committed contract.
 *
 * Every assertion here is against `expected_preflight` in
 * `public/fixtures/manifest.json`, never against `declared`, because `declared` is
 * what ffmpeg was told to make and `expected_preflight` is what our code must derive
 * for itself. Numeric comparisons use the `tolerance` block on the same entry.
 *
 * What is real in these runs and what is a double, stated plainly:
 *
 * - The container facts are derived from the real committed bytes by the real parser.
 * - The codec support answer is the reference runtime's codec table, written out in
 *   `_support.ts` rather than read back from the expectations, so `codec_playable` is
 *   derived from an input.
 * - The frame hashes are deterministic doubles, because jsdom cannot decode a frame.
 *   That is enough for the duplicate rule's four states and its set dependence, and
 *   it is NOT evidence that the two committed duplicate fixtures hash alike. That
 *   claim needs a browser and is recorded in `qa/manual-checklist.md`.
 */

import { describe, expect, it } from 'vitest'
import { codecFamilyOf, parseContainer, type ContainerFacts } from '@/media/atoms'
import { parseStill, type StillFacts } from '@/media/still'
import {
  BLOCKING_RULES,
  PREFLIGHT_REASON_CODES,
  PREFLIGHT_RULES,
  PREFLIGHT_VERSION,
  distanceMetres,
  evaluatePreflight,
  isoSeconds,
  orientationOf,
  toAssetCapturedAtSource,
  toStoredPreflight,
  verdictFor,
  visitWindow,
  type PreflightSubject,
} from '@/media/preflight'
import type { HashedAsset } from '@/media/phash'
import {
  contextFromManifest,
  fixtureBytes,
  fixtures,
  manifest,
  nearDuplicateHashes,
  referenceCodecSupport,
  requireFixture,
  syntheticHashes,
  type ManifestFixture,
} from './_support'

/**
 * Builds the subject for one fixture from its real bytes.
 *
 * Frames exist exactly where the manifest says derivatives exist, and the content
 * key is the fixture id except for the duplicate, which deliberately shares the key
 * of the clip it was re-encoded from.
 */
async function subjectFor(
  fixture: ManifestFixture,
  options: { priors?: readonly HashedAsset[]; frames?: string[] } = {},
): Promise<PreflightSubject> {
  let container: ContainerFacts | null = null
  let still: StillFacts | null = null
  let parseFailure: PreflightSubject['parse_failure'] = null

  if (fixture.kind === 'photo') {
    still = await parseStill(fixtureBytes(fixture))
    parseFailure = 'not_isobmff'
  } else {
    const parsed = await parseContainer(fixtureBytes(fixture), { sampleTables: true })
    container = parsed.ok ? parsed : null
    parseFailure = parsed.reason
  }

  const family = codecFamilyOf(container?.codec_video.value ?? null)
  const frameCount = fixture.kind === 'photo' ? 1 : fixture.expected_frames.by_tier.standard.count
  const hashes =
    options.frames ??
    (fixture.expected_derivatives.contact_sheet
      ? fixture.fixture_id === 'duplicate_of_vertical_ok'
        ? nearDuplicateHashes('vertical_ok', frameCount)
        : syntheticHashes(fixture.fixture_id, frameCount)
      : [])

  return {
    kind: fixture.kind,
    file: {
      filename: fixture.path.split('/').at(-1) ?? fixture.fixture_id,
      bytes: fixture.bytes,
      // A real File carries one, and it must never be promoted to a capture date.
      last_modified_ms: Date.UTC(2026, 7, 6, 9, 0, 0),
      mime_type: fixture.kind === 'photo' ? 'image/jpeg' : 'video/mp4',
    },
    container,
    still,
    parse_failure: parseFailure,
    decode: null,
    codec_support: fixture.kind === 'photo' ? 'yes' : referenceCodecSupport(family),
    codec_unsupported_everywhere: family === 'prores',
    frames: { hashes, failure: hashes.length === 0 ? 'decode_unsupported' : null },
    priors: options.priors ?? [],
  }
}

/** The comparison set the manifest names: engineered fixtures, in manifest order. */
function priorsBefore(fixture: ManifestFixture): HashedAsset[] {
  const priors: HashedAsset[] = []
  for (const candidate of fixtures) {
    if (candidate.fixture_id === fixture.fixture_id) break
    if (candidate.group !== 'engineered') continue
    if (!candidate.expected_derivatives.contact_sheet) continue
    const count =
      candidate.kind === 'photo' ? 1 : candidate.expected_frames.by_tier.standard.count
    priors.push({ asset_id: candidate.fixture_id, frame_hashes: syntheticHashes(candidate.fixture_id, count) })
  }
  return priors
}

describe('the reason code enumeration', () => {
  it('is a superset of the manifest enumeration, so the two cannot drift', () => {
    for (const code of manifest.context.reason_codes) {
      expect(PREFLIGHT_REASON_CODES as readonly string[], `${code} is in the manifest but not in the engine`).toContain(
        code,
      )
    }
  })

  it('agrees with the manifest about the version, the rule set and the blocking set', () => {
    expect(PREFLIGHT_VERSION).toBe(manifest.context.preflight_version)
    expect([...PREFLIGHT_RULES].sort()).toEqual([...Object.keys(requireFixture('vertical_ok').expected_preflight.rules)].sort())
    expect([...BLOCKING_RULES].sort()).toEqual([...manifest.context.blocking_rules].sort())
    expect(BLOCKING_RULES).not.toContain('codec_playable')
  })
})

describe('every fixture, every rule, against expected_preflight', () => {
  it.each(fixtures.map((fixture) => [fixture.fixture_id, fixture] as const))(
    '%s matches the committed verdict on all seven rules',
    async (id, fixture) => {
      const subject = await subjectFor(fixture, { priors: priorsBefore(fixture) })
      const result = evaluatePreflight(subject, contextFromManifest())

      for (const name of PREFLIGHT_RULES) {
        const want = fixture.expected_preflight.rules[name]
        const got = result.rules[name]
        expect(want, `${id}: the manifest has no ${name} rule`).toBeTruthy()
        if (!want) continue

        expect(got.status, `${id}.${name} status`).toBe(want.status)
        expect(got.blocking, `${id}.${name} blocking`).toBe(want.blocking === true)
        expect(got.evidence, `${id}.${name} evidence`).toBe(want.evidence)
        if (want.reason) expect(got.reason, `${id}.${name} reason`).toBe(want.reason)
        if (want.status === 'unknown' || want.status === 'skipped') {
          expect(got.evidence, `${id}.${name} claims evidence while being ${want.status}`).toBe('none')
          expect(got.reason, `${id}.${name} is ${want.status} with no reason`).toBeTruthy()
        }
      }

      expect(result.rollup, `${id} rollup`).toEqual(fixture.expected_preflight.rollup)
      expect(result.version).toBe(fixture.expected_preflight.version)
    },
  )

  it.each(fixtures.map((fixture) => [fixture.fixture_id, fixture] as const))(
    '%s matches the committed values, within the manifest tolerances',
    async (id, fixture) => {
      const subject = await subjectFor(fixture, { priors: priorsBefore(fixture) })
      const result = evaluatePreflight(subject, contextFromManifest())
      const rules = fixture.expected_preflight.rules

      // orientation: the display size decides, and the coded size is reported too.
      const orientation = rules.orientation
      if (orientation && orientation.status !== 'unknown') {
        expect(result.rules.orientation.value, `${id} orientation`).toBe(orientation.value)
        expect(result.rules.orientation.display, `${id} display`).toBe(orientation.display)
        if (orientation.coded) expect(result.rules.orientation.coded, `${id} coded`).toBe(orientation.coded)
        if (orientation.rotation_deg !== undefined) {
          expect(result.rules.orientation.rotation_deg, `${id} rotation`).toBe(orientation.rotation_deg)
        }
      }

      // min_duration: within tolerance, never exact equality.
      const duration = rules.min_duration
      if (duration && typeof duration.value === 'number') {
        expect(
          Math.abs((result.rules.min_duration.value as number) - duration.value),
          `${id} duration`,
        ).toBeLessThanOrEqual(fixture.tolerance.duration_s)
        expect(result.rules.min_duration.required).toBe(manifest.context.rule_thresholds.min_duration_s)
      }

      const resolution = rules.min_resolution
      if (resolution && resolution.status !== 'unknown') {
        expect(result.rules.min_resolution.value, `${id} resolution`).toBe(resolution.value)
      }

      const capture = rules.capture_date
      if (capture) {
        expect(result.rules.capture_date.captured_at_source, `${id} capture source`).toBe(
          capture.captured_at_source ?? 'unknown',
        )
        if (typeof capture.value === 'string') {
          expect(result.rules.capture_date.value, `${id} capture instant`).toBe(capture.value)
        } else {
          expect(result.rules.capture_date.value ?? null, `${id} capture instant`).toBeNull()
        }
        if (capture.mvhd_creation_time_raw !== undefined) {
          expect(result.rules.capture_date.mvhd_creation_time_raw).toBe(capture.mvhd_creation_time_raw)
        }
        if (capture.fallback) {
          // The fallback appears in the record and never in the capture date.
          expect(result.rules.capture_date.fallback).toBe('file_mtime')
          expect(result.rules.capture_date.fallback_never_promoted).toBe(true)
          expect(result.rules.capture_date.fallback_value).not.toBeNull()
          expect(result.captured_at_ms).toBeNull()
        }
        if (capture.also) expect(result.rules.capture_date.also).toEqual(capture.also)
      }

      const near = rules.near_branch
      if (near) {
        expect(result.rules.near_branch.never_blocking, `${id} near_branch never blocks`).toBe(true)
        expect(result.rules.near_branch.radius_m).toBe(manifest.context.rule_thresholds.near_branch_radius_m)
        if (typeof near.distance_m === 'number') {
          expect(
            Math.abs((result.rules.near_branch.distance_m as number) - near.distance_m),
            `${id} distance to the branch`,
          ).toBeLessThanOrEqual(fixture.tolerance.distance_m)
          // A parser that returns 0m has read the branch coordinate, not the file's.
          expect(result.rules.near_branch.distance_m).toBeGreaterThan(0)
          expect(result.rules.near_branch.gps_atom).toBe(near.gps_atom)
        } else {
          expect(result.rules.near_branch.distance_m ?? null).toBeNull()
        }
      }

      const duplicate = rules.duplicate
      expect(result.rules.duplicate.comparison_set, `${id} names its comparison set`).toBe(
        manifest.duplicate_assumption.comparison_set,
      )
      if (duplicate?.duplicate_of_fixture_id) {
        expect(result.rules.duplicate.duplicate_of_asset_id, `${id} duplicate target`).toBe(
          duplicate.duplicate_of_fixture_id,
        )
      }

      const codec = rules.codec_playable
      if (codec) {
        expect(result.rules.codec_playable.value, `${id} codec`).toBe(codec.value)
        if (codec.routes_to) {
          expect(result.rules.codec_playable.routes_to).toBe('transcode')
          expect(result.rules.codec_playable.upload_priority).toBe('required_for_transcode')
        }
        if (codec.runtime_dependent !== undefined) {
          expect(result.rules.codec_playable.runtime_dependent, `${id} runtime dependence`).toBe(
            codec.runtime_dependent,
          )
        }
      }
    },
  )
})

describe('the rule that governs everything: absent evidence is never a failure', () => {
  it('never blocks on an unknown or a skipped rule, on any fixture', async () => {
    for (const fixture of fixtures) {
      const result = evaluatePreflight(await subjectFor(fixture), contextFromManifest())
      for (const name of PREFLIGHT_RULES) {
        const rule = result.rules[name]
        if (rule.status === 'unknown' || rule.status === 'skipped') {
          expect(rule.blocking, `${fixture.fixture_id}.${name} is ${rule.status} and blocking`).toBe(false)
        }
        if (rule.blocking) {
          expect(rule.status).toBe('fail')
          expect(BLOCKING_RULES).toContain(name)
        }
      }
    }
  })

  it('reports near_branch as unknown on a camera with no GPS receiver, never as a failure', async () => {
    const result = evaluatePreflight(await subjectFor(requireFixture('prores')), contextFromManifest())
    const rule = result.rules.near_branch
    expect(rule.status).toBe('unknown')
    expect(rule.status).not.toBe('fail')
    expect(rule.reason).toBe('no_gps_atom_camera_has_no_receiver')
    expect(rule.never_blocking).toBe(true)
    expect(rule.distance_m).toBeNull()
    // A red cross here fails a creator for owning better equipment.
    expect(result.rollup.blocking_fail).toBe(2)
    expect(result.blocked_by).toEqual(['orientation', 'min_resolution'])
  })

  it('reports the three GPS absences with different sentences and the same consequence', async () => {
    const cases: [string, string][] = [
      ['prores', 'no_gps_atom_camera_has_no_receiver'],
      ['no_metadata', 'no_gps_atom_metadata_stripped'],
      ['photo_still', 'no_gps_atom_not_written_by_encoder'],
    ]
    for (const [id, reason] of cases) {
      const result = evaluatePreflight(await subjectFor(requireFixture(id)), contextFromManifest())
      expect(result.rules.near_branch.reason, id).toBe(reason)
      // The three differ only in what a human reads. Status and blocking are identical,
      // because the bytes cannot distinguish stripped from never written.
      expect(result.rules.near_branch.status, id).toBe('unknown')
      expect(result.rules.near_branch.blocking, id).toBe(false)
    }
  })

  it('does not distinguish a stripped creation time from one never written', async () => {
    const stripped = evaluatePreflight(await subjectFor(requireFixture('no_metadata')), contextFromManifest())
    const neverWritten = evaluatePreflight(await subjectFor(requireFixture('prores')), contextFromManifest())
    expect(stripped.rules.capture_date.reason).toBe('mvhd_creation_time_zero')
    expect(neverWritten.rules.capture_date.reason).toBe(stripped.rules.capture_date.reason)
    expect(stripped.rules.capture_date.also).toEqual(['no_udta_day_atom'])
  })

  it('never presents File.lastModified as a capture date', async () => {
    const subject = await subjectFor(requireFixture('no_metadata'))
    const result = evaluatePreflight(subject, contextFromManifest())
    expect(result.captured_at_ms).toBeNull()
    expect(result.captured_at_source).toBe('unknown')
    expect(result.rules.capture_date.fallback_value).toBe(subject.file.last_modified_ms)
    expect(result.rules.capture_date.value).toBeNull()
  })

  it('lets a creator answer the one unknown they can, and records who said so', async () => {
    const base = await subjectFor(requireFixture('no_metadata'))
    const stated = Date.UTC(2026, 7, 4, 17, 30, 0)
    const result = evaluatePreflight({ ...base, creator_stated_captured_at_ms: stated }, contextFromManifest())
    expect(result.rules.capture_date.status).toBe('pass')
    expect(result.captured_at_source).toBe('creator_stated')
    expect(result.rules.capture_date.evidence).toBe('creator_stated')
  })
})

describe('rotated_90, where the whole orientation rule is decided', () => {
  it('passes orientation on display dimensions although the coded dimensions are landscape', async () => {
    const fixture = requireFixture('rotated_90')
    const result = evaluatePreflight(await subjectFor(fixture), contextFromManifest())
    const rule = result.rules.orientation
    expect(rule.status).toBe('pass')
    expect(rule.value).toBe('vertical')
    expect(rule.coded).toBe('1920x1080')
    expect(rule.display).toBe('1080x1920')
    expect(rule.rotation_deg).toBe(90)
    expect(rule.evidence).toBe('coded_dims+tkhd_matrix')
    // A parser that reads coded dimensions and stops rejects correct footage.
    expect(result.rollup).toEqual({ pass: 7, fail: 0, unknown: 0, skipped: 0, blocking_fail: 0 })
  })

  it('evaluates min_resolution on the display size too', async () => {
    const result = evaluatePreflight(await subjectFor(requireFixture('rotated_90')), contextFromManifest())
    expect(result.rules.min_resolution.value).toBe('1080x1920')
    expect(result.rules.min_resolution.status).toBe('pass')
  })
})

describe('one defect trips one rule', () => {
  it('fails orientation alone on a landscape clip, because resolution is judged on edges', async () => {
    const result = evaluatePreflight(await subjectFor(requireFixture('horizontal_fail')), contextFromManifest())
    expect(result.rules.orientation.status).toBe('fail')
    expect(result.rules.orientation.blocking).toBe(true)
    // 1920x1080 has a 1080 short edge and a 1920 long edge, so it passes resolution.
    expect(result.rules.min_resolution.status).toBe('pass')
    expect(result.rollup.blocking_fail).toBe(1)
  })

  it('fails resolution alone on a small vertical clip', async () => {
    const result = evaluatePreflight(await subjectFor(requireFixture('lowres_fail')), contextFromManifest())
    expect(result.rules.min_resolution.status).toBe('fail')
    expect(result.rules.orientation.status).toBe('pass')
    expect(result.rules.orientation.value).toBe('vertical')
  })

  it('judges resolution on edges rather than on width against height', () => {
    expect(orientationOf({ width: 1080, height: 1920 })).toBe('vertical')
    expect(orientationOf({ width: 1920, height: 1080 })).toBe('horizontal')
    expect(orientationOf({ width: 1080, height: 1080 })).toBe('square')
  })
})

describe('the visit window', () => {
  const hours = manifest.context.rule_thresholds.visit_window_hours

  it('is arithmetic on an instant rather than a calendar day comparison', () => {
    const window = visitWindow(manifest.context.visit_date, hours)
    expect(window).not.toBeNull()
    // The evening before the visit is inside the window and is a different date.
    const eveningBefore = Date.UTC(2026, 7, 3, 18, 0, 0)
    expect(eveningBefore).toBeGreaterThanOrEqual(window!.from_ms)
    expect(eveningBefore).toBeLessThan(window!.to_ms)
    // Two days before is outside it.
    expect(Date.UTC(2026, 7, 2, 9, 40, 0)).toBeLessThan(window!.from_ms)
  })

  it('passes inside the window and fails 48 hours out, on the two committed fixtures', async () => {
    const inside = evaluatePreflight(await subjectFor(requireFixture('vertical_ok')), contextFromManifest())
    const outside = evaluatePreflight(await subjectFor(requireFixture('offdate_fail')), contextFromManifest())
    expect(inside.rules.capture_date.status).toBe('pass')
    expect(outside.rules.capture_date.status).toBe('fail')
    expect(outside.rules.capture_date.reason).toBe('capture_date_outside_visit_window')
    // Advisory: a container timestamp is editable bytes, so the clip still uploads.
    expect(outside.rules.capture_date.blocking).toBe(false)
    expect(outside.rollup.blocking_fail).toBe(0)
    expect(outside.rules.capture_date.hours_outside_window).toBeGreaterThan(0)
  })

  it('skips rather than passes when there is no visit to compare against', async () => {
    const result = evaluatePreflight(
      await subjectFor(requireFixture('vertical_ok')),
      contextFromManifest({ visit_date: null }),
    )
    expect(result.rules.capture_date.status).toBe('skipped')
    expect(result.rules.capture_date.reason).toBe('no_visit_date_in_brief')
  })

  it('refuses a malformed visit date rather than inventing a window', () => {
    expect(visitWindow('not-a-date', hours)).toBeNull()
    expect(visitWindow('2026-8-4', hours)).toBeNull()
  })

  it('formats an instant to seconds precision in UTC', () => {
    expect(isoSeconds(Date.UTC(2026, 7, 4, 10, 12, 0))).toBe('2026-08-04T10:12:00Z')
    expect(isoSeconds(Date.UTC(2026, 7, 4, 10, 12, 0, 250))).toBe('2026-08-04T10:12:00.250Z')
  })
})

describe('distance', () => {
  it('measures the committed fixture GPS against the branch within tolerance', () => {
    const branch = manifest.context.branch
    const fixture = requireFixture('vertical_ok')
    const gps = fixture.declared.gps
    const distance = distanceMetres(gps!.lat, gps!.lng, branch.lat, branch.lng)
    const expected = fixture.expected_preflight.rules.near_branch.distance_m as number
    expect(Math.abs(distance - expected)).toBeLessThanOrEqual(fixture.tolerance.distance_m)
  })

  it('is zero at the same point and symmetric', () => {
    expect(distanceMetres(37.3382, -121.8863, 37.3382, -121.8863)).toBe(0)
    expect(distanceMetres(37.3382, -121.8863, 37.4, -121.9)).toBeCloseTo(
      distanceMetres(37.4, -121.9, 37.3382, -121.8863),
      6,
    )
  })

  it('fails near_branch when a fix is genuinely far away, which no fixture covers', async () => {
    const subject = await subjectFor(requireFixture('vertical_ok'))
    const faraway = contextFromManifest({
      branch: { branch_id: 'far', lat: 37.7749, lng: -122.4194 },
    })
    const result = evaluatePreflight(subject, faraway)
    expect(result.rules.near_branch.status).toBe('fail')
    expect(result.rules.near_branch.reason).toBe('gps_outside_branch_radius')
    // Still not blocking, even as a failure.
    expect(result.rules.near_branch.blocking).toBe(false)
    expect(result.rollup.blocking_fail).toBe(0)
  })

  it('skips near_branch when the branch itself has no coordinates', async () => {
    const result = evaluatePreflight(
      await subjectFor(requireFixture('vertical_ok')),
      contextFromManifest({ branch: { branch_id: 'san-jose', lat: null, lng: null } }),
    )
    expect(result.rules.near_branch.status).toBe('skipped')
    expect(result.rules.near_branch.reason).toBe('no_branch_coordinates')
  })
})

describe('the duplicate rule is set dependent, and says so', () => {
  const duplicate = requireFixture('duplicate_of_vertical_ok')

  it('fails against a delivery that already contains the original', async () => {
    const result = evaluatePreflight(
      await subjectFor(duplicate, { priors: priorsBefore(duplicate) }),
      contextFromManifest(),
    )
    expect(result.rules.duplicate.status).toBe('fail')
    expect(result.rules.duplicate.reason).toBe('perceptual_hash_matches_earlier_asset')
    expect(result.rules.duplicate.duplicate_of_asset_id).toBe('vertical_ok')
    // Advisory: delivering the same shot twice is a nudge, not a rejection.
    expect(result.rules.duplicate.blocking).toBe(false)
    expect(result.rollup.blocking_fail).toBe(0)
  })

  it('passes when the same file is ingested alone, which is not a contradiction', async () => {
    const result = evaluatePreflight(await subjectFor(duplicate, { priors: [] }), contextFromManifest())
    expect(result.rules.duplicate.status).toBe('pass')
    expect(result.rules.duplicate.duplicate_of_asset_id).toBeNull()
    expect(result.rules.duplicate.comparison_set).toBe(manifest.duplicate_assumption.comparison_set)
  })

  it('is unknown, never a pass, when there are no frames to hash', async () => {
    for (const id of ['hevc', 'prores']) {
      const result = evaluatePreflight(await subjectFor(requireFixture(id)), contextFromManifest())
      expect(result.rules.duplicate.status, id).toBe('unknown')
      expect(result.rules.duplicate.reason, id).toBe('no_frames_no_decoder')
      expect(result.rules.duplicate.evidence, id).toBe('none')
    }
  })

  it('separates unrelated fixtures well beyond the tolerance, so the doubles are not vacuous', () => {
    // Guards the test doubles themselves: a generator that produced similar hashes
    // for every key would make every duplicate assertion above meaningless.
    const a = syntheticHashes('vertical_ok', 5)
    const b = syntheticHashes('long_ok', 5)
    const near = nearDuplicateHashes('vertical_ok', 5)
    const distanceOf = (left: string[], right: string[]): number => {
      let total = 0
      left.forEach((hash, index) => {
        let bits = 0
        for (let i = 0; i < hash.length; i += 1) {
          const x = Number.parseInt(hash[i] ?? '0', 16) ^ Number.parseInt(right[index]?.[i] ?? '0', 16)
          bits += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1)
        }
        total += bits
      })
      return total / left.length
    }
    expect(distanceOf(a, b)).toBeGreaterThan(manifest.fixtures[0]!.tolerance.dhash_hamming * 2)
    expect(distanceOf(a, near)).toBeLessThanOrEqual(manifest.fixtures[0]!.tolerance.dhash_hamming)
  })
})

describe('codec_playable routes rather than rejects', () => {
  it('fails HEVC on the reference runtime with a routing reason and a raised priority', async () => {
    const result = evaluatePreflight(await subjectFor(requireFixture('hevc')), contextFromManifest())
    const rule = result.rules.codec_playable
    expect(rule.status).toBe('fail')
    expect(rule.reason).toBe('no_decoder_in_shell')
    expect(rule.blocking).toBe(false)
    expect(rule.routes_to).toBe('transcode')
    expect(rule.upload_priority).toBe('required_for_transcode')
    expect(rule.runtime_dependent).toBe(true)
    expect(rule.value).toBe('hvc1')
  })

  it('fails ProRes everywhere, which is a stronger statement than "not here"', async () => {
    const result = evaluatePreflight(await subjectFor(requireFixture('prores')), contextFromManifest())
    const rule = result.rules.codec_playable
    expect(rule.reason).toBe('codec_unsupported_in_every_browser')
    expect(rule.runtime_dependent).toBe(false)
  })

  it('keeps the metadata layer complete with no decoder at all', async () => {
    // Atom parsing reads bytes, so only the pixel layer fails.
    const result = evaluatePreflight(await subjectFor(requireFixture('hevc')), contextFromManifest())
    for (const name of ['orientation', 'min_duration', 'min_resolution', 'capture_date', 'near_branch'] as const) {
      expect(result.rules[name].status, name).not.toBe('unknown')
    }
    expect(result.rules.capture_date.captured_at_source).toBe('udta_day')
  })

  it('reports a maybe as unknown rather than promoting it to a pass', async () => {
    const base = await subjectFor(requireFixture('vertical_ok'))
    const result = evaluatePreflight({ ...base, codec_support: 'unknown' }, contextFromManifest())
    expect(result.rules.codec_playable.status).toBe('unknown')
    expect(result.rules.codec_playable.reason).toBe('codec_support_unknown_in_this_runtime')
    expect(result.rules.codec_playable.blocking).toBe(false)
  })
})

describe('the photo path', () => {
  const fixture = requireFixture('photo_still')

  it('skips duration rather than reporting it unknown', async () => {
    const result = evaluatePreflight(await subjectFor(fixture), contextFromManifest())
    expect(result.rules.min_duration.status).toBe('skipped')
    expect(result.rules.min_duration.reason).toBe('rule_not_applicable_to_kind')
    expect(result.rules.min_duration.kind).toBe('photo')
  })

  it('reports capture_date unknown because we ship no EXIF parser', async () => {
    const result = evaluatePreflight(await subjectFor(fixture), contextFromManifest())
    expect(result.rules.capture_date.status).toBe('unknown')
    expect(result.rules.capture_date.reason).toBe('no_exif_parser_for_still_images')
  })

  it('still runs dedupe, because a still genuinely has a frame to hash', async () => {
    const result = evaluatePreflight(await subjectFor(fixture), contextFromManifest())
    expect(result.rules.duplicate.status).toBe('pass')
  })
})

describe('a file whose container could not be read at all', () => {
  it('reports every container rule as unknown rather than as a failure', async () => {
    const subject: PreflightSubject = {
      kind: 'video',
      file: { filename: 'truncated.mov', bytes: 1024, last_modified_ms: null, mime_type: 'video/quicktime' },
      container: null,
      still: null,
      parse_failure: 'moov_not_found',
      decode: null,
      codec_support: 'unknown',
      codec_unsupported_everywhere: false,
      frames: { hashes: [], failure: 'zero_duration' },
      priors: [],
    }
    const result = evaluatePreflight(subject, contextFromManifest())
    for (const name of PREFLIGHT_RULES) {
      if (name === 'min_duration' || name === 'orientation' || name === 'min_resolution') {
        expect(result.rules[name].status, name).toBe('unknown')
        expect(result.rules[name].reason, name).toBe('container_facts_unavailable')
      }
      expect(result.rules[name].blocking, name).toBe(false)
    }
    // Nothing was verifiable, which is the one case where the row reads unknown.
    expect(result.verdict).toBe('unknown')
    expect(result.rollup.pass).toBe(0)
  })

  it('uses what the decode pass measured when the container gave nothing', async () => {
    const subject: PreflightSubject = {
      kind: 'video',
      file: { filename: 'no-moov.mp4', bytes: 2048, last_modified_ms: null, mime_type: 'video/mp4' },
      container: null,
      still: null,
      parse_failure: 'moov_not_found',
      decode: { duration_s: 6.2, reported: { width: 1080, height: 1920 } },
      codec_support: 'yes',
      codec_unsupported_everywhere: false,
      frames: { hashes: syntheticHashes('no-moov', 5), failure: null },
      priors: [],
    }
    const result = evaluatePreflight(subject, contextFromManifest())
    expect(result.rules.min_duration.status).toBe('pass')
    expect(result.rules.min_duration.evidence).toBe('decode_pass')
    expect(result.rules.min_duration.value).toBe(6.2)
  })

  it('prefers the decode measurement over the container declaration when they disagree', async () => {
    const base = await subjectFor(requireFixture('vertical_ok'))
    const result = evaluatePreflight(
      { ...base, decode: { duration_s: 2.1, reported: { width: 1080, height: 1920 } } },
      contextFromManifest(),
    )
    // A container is a claim and a decoder is a measurement.
    expect(result.rules.min_duration.value).toBe(2.1)
    expect(result.rules.min_duration.status).toBe('fail')
    expect(result.rules.min_duration.evidence).toBe('decode_pass')
    expect(result.rules.min_duration.note).toMatch(/measurement was used/)
  })

  it('keeps the container evidence when the two agree inside tolerance', async () => {
    const base = await subjectFor(requireFixture('vertical_ok'))
    const result = evaluatePreflight(
      { ...base, decode: { duration_s: 6.02, reported: { width: 1080, height: 1920 } } },
      contextFromManifest(),
    )
    expect(result.rules.min_duration.evidence).toBe('mvhd')
  })
})

describe('the row verdict', () => {
  it('blocks only on a blocking failure, and an unknown never downgrades it', () => {
    expect(verdictFor({ pass: 7, fail: 0, unknown: 0, skipped: 0, blocking_fail: 0 })).toBe('ok')
    expect(verdictFor({ pass: 5, fail: 0, unknown: 2, skipped: 0, blocking_fail: 0 })).toBe('ok')
    expect(verdictFor({ pass: 6, fail: 1, unknown: 0, skipped: 0, blocking_fail: 0 })).toBe('advisory')
    expect(verdictFor({ pass: 6, fail: 1, unknown: 0, skipped: 0, blocking_fail: 1 })).toBe('blocked')
    expect(verdictFor({ pass: 0, fail: 0, unknown: 7, skipped: 0, blocking_fail: 0 })).toBe('unknown')
  })

  it('agrees with what the e2e harness computes from the manifest rollup', async () => {
    for (const fixture of fixtures) {
      const result = evaluatePreflight(await subjectFor(fixture, { priors: priorsBefore(fixture) }), contextFromManifest())
      const expected =
        fixture.expected_preflight.rollup.blocking_fail > 0
          ? 'blocked'
          : fixture.expected_preflight.rollup.fail > 0
            ? 'advisory'
            : 'ok'
      expect(result.verdict, fixture.fixture_id).toBe(expected)
    }
  })
})

describe('projections', () => {
  it('stores four fields per rule and drops the per rule extras', async () => {
    const result = evaluatePreflight(await subjectFor(requireFixture('prores')), contextFromManifest())
    const stored = toStoredPreflight(result)
    expect(Object.keys(stored).sort()).toEqual([...PREFLIGHT_RULES].sort())
    expect(Object.keys(stored.near_branch ?? {}).sort()).toEqual(['blocking', 'evidence', 'reason', 'status', 'value'])
    // `none` becomes null in the stored row, because the column is nullable and a
    // literal "none" string would read as evidence named none.
    expect(stored.near_branch?.evidence).toBeNull()
  })

  it('maps the capture source onto the narrower enum the asset column declares', () => {
    // The schema calls the ©day case `udta`, the manifest calls it `udta_day`, and
    // both are committed. This is the one place the two vocabularies meet.
    expect(toAssetCapturedAtSource('udta_day')).toBe('udta')
    expect(toAssetCapturedAtSource('mvhd')).toBe('mvhd')
    expect(toAssetCapturedAtSource('apple_quicktime')).toBe('apple_quicktime')
    expect(toAssetCapturedAtSource('creator_stated')).toBe('creator_stated')
    expect(toAssetCapturedAtSource('unknown')).toBe('unknown')
  })
})

describe('determinism', () => {
  it('produces an identical verdict from identical inputs, twice', async () => {
    for (const id of ['vertical_ok', 'hevc', 'prores', 'photo_still']) {
      const fixture = requireFixture(id)
      const first = evaluatePreflight(await subjectFor(fixture, { priors: priorsBefore(fixture) }), contextFromManifest())
      const second = evaluatePreflight(await subjectFor(fixture, { priors: priorsBefore(fixture) }), contextFromManifest())
      expect(JSON.stringify(second), id).toBe(JSON.stringify(first))
    }
  })
})
