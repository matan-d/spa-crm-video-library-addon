/**
 * The fixture manifest is the contract every later media test asserts against,
 * so it gets its own test before any of that code exists.
 *
 * This suite reads the committed manifest and the committed bytes and nothing
 * else. It shells out to nothing, spawns nothing, and needs no network, because
 * a fixture check that only runs when ffmpeg happens to be installed is a check
 * the team will learn to skip.
 *
 * What it is really guarding is one failure mode: a manifest that quietly stops
 * describing its own files. If a fixture is regenerated, hand edited, or dropped
 * and the manifest still claims the old bytes, every downstream assertion
 * silently changes meaning while continuing to pass. So the byte length and the
 * sha256 are both asserted here, at the cheapest possible layer.
 *
 * It also guards the rule that governs the whole media pipeline: three real
 * states plus one for inapplicable, never two. A rule with no evidence must be
 * `unknown` with a named reason, and `unknown` must never block.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

// Vitest rewrites `import.meta.url` under the jsdom environment, so the path
// comes from the working directory, which vitest always sets to the project root.
const FIXTURE_DIR = join(cwd(), 'public', 'fixtures')
const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json')

const STATUSES = ['pass', 'fail', 'unknown', 'skipped'] as const
type Status = (typeof STATUSES)[number]

/** The seven deterministic Layer A rules. `brief_match` is Layer B and belongs to ai-contract. */
const RULES = [
  'orientation',
  'min_duration',
  'min_resolution',
  'capture_date',
  'near_branch',
  'duplicate',
  'codec_playable',
] as const

interface Rule {
  status: Status
  evidence: string
  reason?: string
  blocking?: boolean
  value?: unknown
  distance_m?: number | null
  duplicate_of_fixture_id?: string
  runtime_dependent?: boolean
}

interface Fixture {
  fixture_id: string
  path: string
  group: string
  kind: 'video' | 'photo'
  proves: string
  /** Present only on fixtures added beyond the set specified in review C2.D. */
  added_beyond_c2d?: boolean
  bytes: number
  sha256: string
  generator_version: number
  ffmpeg_args: string[]
  declared: Record<string, unknown> & {
    kind: string
    coded_width: number
    coded_height: number
    rotation_deg: number
    gps: { lat: number; lng: number } | null
    facts_verified: boolean
  }
  expected_preflight: {
    version: number
    producer: string
    reference_runtime: string
    rules: Record<string, Rule>
    rollup: Record<Status | 'blocking_fail', number>
  }
  expected_frames: {
    by_tier: Record<string, { count: number; t_seconds: number[] }>
    approximate: boolean
    reason: string | null
  }
  expected_derivatives: { contact_sheet: boolean; poster: boolean; reason: string | null }
  expected_phash_prefix: null
  tolerance: { duration_s: number; distance_m: number; dhash_hamming: number; frame_t_seconds: number }
}

interface Manifest {
  manifest_version: number
  generator_version: number
  generator: string
  built_at: string
  facts_verified: boolean
  reference_runtime: { id: string }
  context: {
    visit_date: string
    branch: { branch_id: string; lat: number; lng: number }
    rule_thresholds: Record<string, unknown>
    reason_codes: string[]
    blocking_rules: string[]
    preflight_version: number
  }
  duplicate_assumption: { comparison_set: string; expected_pairs: { later: string; earlier: string }[] }
  fixtures: Fixture[]
}

if (!existsSync(MANIFEST_PATH)) {
  throw new Error(
    `no fixture manifest at ${MANIFEST_PATH}. The fixtures are committed artefacts, so this means they were deleted rather than not yet built. Run \`npm run fixtures\`.`,
  )
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
const fixtures = manifest.fixtures
const engineered = fixtures.filter((f) => f.group === 'engineered')
const byId = new Map(fixtures.map((f) => [f.fixture_id, f]))

describe('fixture manifest shape', () => {
  it('parses and carries the top level fields the tests read', () => {
    expect(manifest.manifest_version).toBe(1)
    expect(manifest.generator_version).toBeGreaterThanOrEqual(1)
    expect(manifest.generator).toBe('scripts/build-fixtures.mjs')
    expect(Date.parse(manifest.built_at)).not.toBeNaN()
    expect(manifest.context.preflight_version).toBe(2)
    expect(manifest.context.visit_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(manifest.context.rule_thresholds).toBeTruthy()
    expect(manifest.context.reason_codes.length).toBeGreaterThan(0)
  })

  it('names the runtime its statuses assume, because codec_playable is not a pure function of the bytes', () => {
    expect(manifest.reference_runtime.id).toBeTruthy()
    for (const fixture of fixtures) {
      expect(fixture.expected_preflight.reference_runtime).toBe(manifest.reference_runtime.id)
    }
  })

  it('has a unique id and a unique path per fixture', () => {
    expect(new Set(fixtures.map((f) => f.fixture_id)).size).toBe(fixtures.length)
    expect(new Set(fixtures.map((f) => f.path)).size).toBe(fixtures.length)
  })

  it('covers every fixture named in the architecture review C2.D set', () => {
    for (const id of [
      'vertical_ok',
      'horizontal_fail',
      'short_fail',
      'lowres_fail',
      'rotated_90',
      'hevc',
      'no_metadata',
      'duplicate_of_vertical_ok',
      'prores',
    ]) {
      expect(byId.has(id), `C2.D requires a ${id} fixture`).toBe(true)
    }
    expect(fixtures.filter((f) => f.group === 'preview').length).toBeGreaterThanOrEqual(2)
  })
})

describe('every fixture file matches its manifest entry', () => {
  it.each(fixtures.map((f) => [f.fixture_id, f] as const))('%s exists with the recorded bytes and hash', (id, fixture) => {
    const file = join(FIXTURE_DIR, fixture.path.replace('/fixtures/', ''))
    expect(existsSync(file), `${id}: no file at ${fixture.path}`).toBe(true)

    const bytes = statSync(file).size
    expect(bytes, `${id}: byte length`).toBe(fixture.bytes)
    expect(bytes, `${id}: declared.bytes must agree with the entry`).toBe(fixture.declared.bytes)

    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
    expect(sha256, `${id}: sha256, so a regenerated fixture cannot silently redefine what a test means`).toBe(
      fixture.sha256,
    )
  })

  it('keeps every committed fixture small enough to live in git', () => {
    for (const fixture of fixtures) {
      expect(fixture.bytes, `${fixture.fixture_id} is ${(fixture.bytes / 1024).toFixed(0)}KB`).toBeLessThan(
        2 * 1024 * 1024,
      )
    }
  })

  it('records that the declared facts were read back by an independent tool', () => {
    expect(manifest.facts_verified).toBe(true)
    for (const fixture of fixtures) {
      expect(fixture.declared.facts_verified, `${fixture.fixture_id}`).toBe(true)
    }
  })

  it('records the real ffmpeg argv that produced each file', () => {
    for (const fixture of fixtures) {
      expect(Array.isArray(fixture.ffmpeg_args), `${fixture.fixture_id}`).toBe(true)
      expect(fixture.ffmpeg_args.length).toBeGreaterThan(0)
      for (const arg of fixture.ffmpeg_args) expect(typeof arg).toBe('string')
    }
  })
})

describe('expected_preflight is four valued and complete', () => {
  it.each(fixtures.map((f) => [f.fixture_id, f] as const))('%s has all seven rules with a legal status', (id, fixture) => {
    const rules = fixture.expected_preflight.rules
    expect(Object.keys(rules).sort()).toEqual([...RULES].sort())

    for (const name of RULES) {
      const rule = rules[name]
      expect(rule, `${id}.${name} is missing`).toBeTruthy()
      expect(STATUSES, `${id}.${name} status ${rule.status}`).toContain(rule.status)
      expect(typeof rule.evidence, `${id}.${name} has no evidence field`).toBe('string')
      expect(rule.evidence.length, `${id}.${name} evidence is empty`).toBeGreaterThan(0)
    }
  })

  it.each(fixtures.map((f) => [f.fixture_id, f] as const))(
    '%s names a reason wherever a rule is unknown or skipped',
    (id, fixture) => {
      for (const name of RULES) {
        const rule = fixture.expected_preflight.rules[name]
        if (rule.status !== 'unknown' && rule.status !== 'skipped') continue
        expect(typeof rule.reason, `${id}.${name} is ${rule.status} with no reason`).toBe('string')
        expect(rule.reason, `${id}.${name} reason is empty`).toBeTruthy()
        expect(
          manifest.context.reason_codes,
          `${id}.${name} reason ${rule.reason} is not in the enumerated set`,
        ).toContain(rule.reason)
        expect(rule.evidence, `${id}.${name} claims evidence while being ${rule.status}`).toBe('none')
      }
    },
  )

  it('never lets an unknown or a skipped rule block the upload', () => {
    for (const fixture of fixtures) {
      for (const name of RULES) {
        const rule = fixture.expected_preflight.rules[name]
        if (rule.status === 'unknown' || rule.status === 'skipped') {
          expect(rule.blocking, `${fixture.fixture_id}.${name} is ${rule.status} and blocking`).toBe(false)
        }
      }
    }
  })

  it('only ever blocks on a fail, and only on the three blocking rules', () => {
    for (const fixture of fixtures) {
      for (const name of RULES) {
        const rule = fixture.expected_preflight.rules[name]
        if (!rule.blocking) continue
        expect(rule.status, `${fixture.fixture_id}.${name} blocks without failing`).toBe('fail')
        expect(
          manifest.context.blocking_rules,
          `${fixture.fixture_id}.${name} blocks but is not a blocking rule`,
        ).toContain(name)
      }
    }
  })

  it('keeps codec_playable out of the blocking set, because uploading is the only way forward', () => {
    expect(manifest.context.blocking_rules).not.toContain('codec_playable')
    for (const fixture of fixtures) {
      expect(fixture.expected_preflight.rules.codec_playable.blocking).toBe(false)
    }
  })

  it('has a rollup that agrees with its own rules', () => {
    for (const fixture of fixtures) {
      const counted: Record<string, number> = { pass: 0, fail: 0, unknown: 0, skipped: 0, blocking_fail: 0 }
      for (const name of RULES) {
        const rule = fixture.expected_preflight.rules[name]
        counted[rule.status] += 1
        if (rule.blocking) counted.blocking_fail += 1
      }
      expect(fixture.expected_preflight.rollup, `${fixture.fixture_id} rollup`).toEqual(counted)
      expect(
        Object.values(fixture.expected_preflight.rollup).slice(0, 4).reduce((a, b) => a + b, 0),
      ).toBe(RULES.length)
    }
  })

  it('makes all four states real somewhere in the engineered set, not just legal', () => {
    const seen = new Set<Status>()
    for (const fixture of engineered) {
      for (const name of RULES) seen.add(fixture.expected_preflight.rules[name].status)
    }
    for (const status of STATUSES) {
      expect(seen.has(status), `no engineered fixture exercises \`${status}\`, so its render path is untested`).toBe(
        true,
      )
    }
  })
})

describe('the rule that governs the whole pipeline: absent evidence is never a failure', () => {
  it('never reports near_branch as fail on a file with no location atom', () => {
    for (const fixture of fixtures) {
      const rule = fixture.expected_preflight.rules.near_branch
      if (fixture.declared.gps) continue
      expect(
        rule.status,
        `${fixture.fixture_id}: no GPS atom must read unknown, never fail. A red cross here fails a creator for owning a camera with no GPS receiver.`,
      ).toBe('unknown')
      expect(rule.distance_m ?? null).toBeNull()
    }
  })

  it('never reports capture_date as pass on a file with no capture instant', () => {
    for (const fixture of fixtures) {
      const rule = fixture.expected_preflight.rules.capture_date
      if (fixture.declared.captured_at) continue
      expect(rule.status, `${fixture.fixture_id}: no creation atom must not read as a pass`).toBe('unknown')
      expect(rule.value ?? null).toBeNull()
    }
  })

  it('records a filesystem fallback without ever promoting it to a capture date', () => {
    const withFallback = fixtures.filter(
      (f) => (f.expected_preflight.rules.capture_date as Rule & { fallback?: string }).fallback,
    )
    expect(withFallback.length, 'at least one fixture must exercise the file_mtime fallback').toBeGreaterThan(0)
    for (const fixture of withFallback) {
      const rule = fixture.expected_preflight.rules.capture_date as Rule & {
        fallback?: string
        fallback_never_promoted?: boolean
        captured_at_source?: string
      }
      expect(rule.fallback).toBe('file_mtime')
      expect(rule.fallback_never_promoted).toBe(true)
      expect(rule.captured_at_source).toBe('unknown')
    }
  })

  it('has at least one fixture whose only defect is missing evidence, so `unknown` is not always a co-symptom', () => {
    const cameraOffload = byId.get('prores')!
    expect(cameraOffload.expected_preflight.rules.near_branch.status).toBe('unknown')
    expect(cameraOffload.expected_preflight.rules.near_branch.status).not.toBe('fail')
    expect(cameraOffload.expected_preflight.rollup.unknown).toBeGreaterThanOrEqual(3)
  })
})

describe('rotated_90, the fixture the whole orientation rule rests on', () => {
  const rotated = byId.get('rotated_90')!

  it('is coded landscape with a 90 degree matrix and expected to read as vertical', () => {
    expect(rotated.declared.coded_width).toBeGreaterThan(rotated.declared.coded_height)
    expect(rotated.declared.rotation_deg).toBe(90)
    const rule = rotated.expected_preflight.rules.orientation
    expect(rule.status).toBe('pass')
    expect(rule.value).toBe('vertical')
    expect((rule as Rule & { coded: string; display: string }).coded).toBe('1920x1080')
    expect((rule as Rule & { coded: string; display: string }).display).toBe('1080x1920')
  })

  it('records the tkhd matrix words, so a misread matrix is a diff and not a mystery', () => {
    expect(rotated.declared.tkhd_matrix).toEqual([0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824])
  })

  it('passes every rule, so a failure on this fixture can only be the matrix', () => {
    expect(rotated.expected_preflight.rollup.pass).toBe(RULES.length)
    expect(rotated.expected_preflight.rollup.blocking_fail).toBe(0)
  })
})

describe('the undecodable assets have no derivatives and claim none', () => {
  const undecodable = fixtures.filter((f) => f.expected_derivatives.contact_sheet === false)

  it('names hevc and prores as the two fixtures with no pixels', () => {
    expect(undecodable.map((f) => f.fixture_id).sort()).toEqual(['hevc', 'prores'])
  })

  it.each(undecodable.map((f) => [f.fixture_id, f] as const))('%s expects zero frames and no poster', (id, fixture) => {
    expect(fixture.expected_derivatives.poster).toBe(false)
    expect(fixture.expected_derivatives.reason).toBeTruthy()
    for (const tier of Object.keys(fixture.expected_frames.by_tier)) {
      expect(fixture.expected_frames.by_tier[tier].count, `${id} at ${tier}`).toBe(0)
      expect(fixture.expected_frames.by_tier[tier].t_seconds).toEqual([])
    }
    expect(fixture.expected_preflight.rules.duplicate.status, `${id}: no frames means no perceptual hash`).toBe(
      'unknown',
    )
    expect(fixture.expected_preflight.rules.codec_playable.status).toBe('fail')
  })

  it('still expects the full metadata layer, because atom parsing needs no decoder', () => {
    for (const fixture of undecodable) {
      const rules = fixture.expected_preflight.rules
      for (const name of ['orientation', 'min_duration', 'min_resolution'] as const) {
        expect(rules[name].status, `${fixture.fixture_id}.${name} must be decided from the container`).not.toBe(
          'unknown',
        )
      }
    }
  })
})

describe('expected_frames and tolerances', () => {
  it('gives every fixture a per tier frame plan', () => {
    for (const fixture of fixtures) {
      for (const tier of ['constrained', 'standard', 'ample']) {
        const plan = fixture.expected_frames.by_tier[tier]
        expect(plan, `${fixture.fixture_id} has no plan for ${tier}`).toBeTruthy()
        expect(plan.t_seconds.length).toBe(fixture.kind === 'photo' ? 0 : plan.count)
      }
    }
  })

  it('has at least one fixture long enough to reach the five frame layout', () => {
    const fiveFrame = fixtures.filter((f) => f.expected_frames.by_tier.standard.count === 5)
    expect(
      fiveFrame.length,
      'the 1x5 sheet layout needs at least one fixture that reaches 5 frames at the standard tier, or the layout has nothing to assert against',
    ).toBeGreaterThan(0)
    expect(fiveFrame.some((f) => f.expected_frames.by_tier.constrained.count === 3)).toBe(true)
  })

  it('marks extracted frame times as approximate wherever frames exist', () => {
    for (const fixture of fixtures) {
      if (fixture.expected_frames.by_tier.standard.count === 0) continue
      if (fixture.kind === 'photo') continue
      expect(fixture.expected_frames.approximate, `${fixture.fixture_id}`).toBe(true)
      expect(fixture.expected_frames.reason).toBeTruthy()
    }
  })

  it('carries mandatory tolerances on every entry', () => {
    for (const fixture of fixtures) {
      const t = fixture.tolerance
      expect(t, `${fixture.fixture_id} has no tolerance block`).toBeTruthy()
      expect(t.duration_s).toBeGreaterThan(0)
      expect(t.distance_m).toBeGreaterThan(0)
      expect(t.dhash_hamming).toBeGreaterThan(0)
      expect(t.frame_t_seconds).toBeGreaterThan(0)
    }
  })

  it('leaves expected_phash_prefix null rather than inventing one', () => {
    for (const fixture of fixtures) {
      expect(
        fixture.expected_phash_prefix,
        `${fixture.fixture_id}: no perceptual hasher exists yet, and an invented prefix would be asserted against forever`,
      ).toBeNull()
    }
  })
})

describe('the duplicate rule states the set it was evaluated against', () => {
  it('records the comparison set on every duplicate rule', () => {
    expect(manifest.duplicate_assumption.comparison_set).toBeTruthy()
    for (const fixture of fixtures) {
      expect(
        (fixture.expected_preflight.rules.duplicate as Rule & { comparison_set?: string }).comparison_set,
      ).toBe(manifest.duplicate_assumption.comparison_set)
    }
  })

  it('points each expected duplicate at a fixture that exists and comes earlier', () => {
    expect(manifest.duplicate_assumption.expected_pairs.length).toBeGreaterThan(0)
    for (const pair of manifest.duplicate_assumption.expected_pairs) {
      const later = byId.get(pair.later)
      const earlier = byId.get(pair.earlier)
      expect(later, `${pair.later} is not in the manifest`).toBeTruthy()
      expect(earlier, `${pair.earlier} is not in the manifest`).toBeTruthy()
      expect(fixtures.indexOf(later!)).toBeGreaterThan(fixtures.indexOf(earlier!))
      expect(later!.expected_preflight.rules.duplicate.status).toBe('fail')
      expect(later!.expected_preflight.rules.duplicate.duplicate_of_fixture_id).toBe(pair.earlier)
      expect(later!.sha256, 'a perceptual duplicate must not be a byte duplicate').not.toBe(earlier!.sha256)
    }
  })
})

describe('each fixture says what it proves', () => {
  it('carries a non trivial `proves` line, because an unexplained fixture gets deleted by the next person', () => {
    for (const fixture of fixtures) {
      expect(typeof fixture.proves).toBe('string')
      expect(fixture.proves.length, `${fixture.fixture_id}`).toBeGreaterThan(40)
    }
  })

  it('flags the fixtures added beyond the C2.D set so the addition is reviewable', () => {
    const added = fixtures.filter((f) => f.added_beyond_c2d === true).map((f) => f.fixture_id)
    expect(added.sort()).toEqual(['largesize_mdat', 'long_ok', 'offdate_fail', 'photo_still'])
  })
})
