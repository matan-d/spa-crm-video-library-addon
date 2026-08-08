/**
 * Shared support for the media suites.
 *
 * Three things live here, and each exists because writing it per file would let
 * two copies drift:
 *
 * 1. The committed manifest, typed, plus fixture byte loading from disk.
 * 2. The reference runtime's codec table, stated explicitly rather than read back
 *    out of the expectations. Deriving the input from the expected output would make
 *    every `codec_playable` assertion circular.
 * 3. A fake extraction host. jsdom has no `VideoDecoder`, no real video decode, no
 *    canvas rasteriser and no `ImageBitmap`, so the decode adapters are doubles that
 *    produce deterministic synthetic rasters and count what they allocate and
 *    release. That is enough to assert the chain, the fallback order, the tiling, the
 *    caps and the memory discipline, and it is NOT enough to assert that two
 *    committed fixtures are perceptual duplicates. That claim needs real pixels and
 *    is recorded as a jsdom gap in `qa/manual-checklist.md`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { SeededRng } from '@/platform/rng'
import type { IngestPolicy, IngestTier } from '@/platform/capability'
import { deriveIngestPolicy, TIER_PROFILES } from '@/platform/capability'
import type { CapabilityReport } from '@/platform/capability'
import type { CodecKey, Support } from '@/platform/port'
import type {
  DecodeAdapter,
  DecodeOutcome,
  DecodeRequest,
  ExtractionHost,
  MediaInput,
} from '@/media/extract'
import type { RgbaImage } from '@/media/phash'
import type { PreflightContext } from '@/media/preflight'

export const FIXTURE_DIR = join(cwd(), 'public', 'fixtures')

export interface ManifestRule {
  status: 'pass' | 'fail' | 'unknown' | 'skipped'
  evidence: string
  reason?: string
  blocking?: boolean
  value?: unknown
  required?: unknown
  coded?: string
  display?: string
  rotation_deg?: number
  captured_at_source?: string
  visit_date?: string
  window_hours?: number
  mvhd_creation_time_raw?: number
  fallback?: string
  fallback_never_promoted?: boolean
  also?: string[]
  distance_m?: number | null
  radius_m?: number
  gps_atom?: string
  never_blocking?: boolean
  comparison_set?: string
  duplicate_of_fixture_id?: string
  routes_to?: string
  upload_priority?: string
  runtime_dependent?: boolean
  kind?: string
}

export interface ManifestFixture {
  fixture_id: string
  path: string
  group: 'engineered' | 'preview'
  kind: 'video' | 'photo'
  bytes: number
  sha256: string
  declared: {
    container: string
    ftyp_brand: string
    codec_video: string
    codec_audio: string | null
    has_audio: boolean
    coded_width: number
    coded_height: number
    sar: string
    tkhd_width: number
    tkhd_height: number
    rotation_deg: number
    tkhd_matrix: number[] | null
    duration_s: number | null
    fps: number | null
    captured_at: string | null
    captured_at_atom: string | null
    mvhd_creation_time_raw: number | null
    udta_day: string | null
    gps: { lat: number; lng: number; alt_m: number | null } | null
    gps_atom: string | null
    gps_iso6709: string | null
    moov_position: string
    mdat_size_field: string
  }
  expected_preflight: {
    version: number
    rules: Record<string, ManifestRule>
    rollup: { pass: number; fail: number; unknown: number; skipped: number; blocking_fail: number }
  }
  expected_frames: {
    by_tier: Record<IngestTier, { count: number; layout: string | null; t_seconds: number[] }>
  }
  expected_derivatives: {
    contact_sheet: boolean
    poster: boolean
    derivative_state: string
    reason: string | null
  }
  tolerance: { duration_s: number; distance_m: number; dhash_hamming: number; frame_t_seconds: number }
}

export interface Manifest {
  reference_runtime: { id: string }
  context: {
    visit_date: string
    branch: { branch_id: string; lat: number; lng: number }
    rule_thresholds: {
      required_orientation: 'vertical' | 'horizontal'
      min_duration_s: number
      min_short_edge_px: number
      min_long_edge_px: number
      visit_window_hours: number
      near_branch_radius_m: number
    }
    reason_codes: string[]
    blocking_rules: string[]
    preflight_version: number
  }
  duplicate_assumption: { comparison_set: string; expected_pairs: { later: string; earlier: string }[] }
  fixtures: ManifestFixture[]
}

export const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as Manifest

export const fixtures = manifest.fixtures
export const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixture_id, fixture]))

export function fixtureBytes(fixture: ManifestFixture): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, fixture.path.replace('/fixtures/', ''))))
}

export function requireFixture(id: string): ManifestFixture {
  const fixture = fixtureById.get(id)
  if (!fixture) throw new Error(`no fixture ${id} in the committed manifest`)
  return fixture
}

/**
 * The pre-flight context, entirely from the manifest.
 *
 * Nothing here is typed into a test: the thresholds, the branch, the visit date and
 * the duplicate tolerance are the committed contract, and a test that restated them
 * would keep passing after the contract changed.
 */
export function contextFromManifest(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return {
    thresholds: { ...manifest.context.rule_thresholds },
    visit_date: manifest.context.visit_date,
    branch: {
      branch_id: manifest.context.branch.branch_id,
      lat: manifest.context.branch.lat,
      lng: manifest.context.branch.lng,
    },
    comparison_set: manifest.duplicate_assumption.comparison_set,
    dhash_hamming_threshold: requireFixture('vertical_ok').tolerance.dhash_hamming,
    ...overrides,
  }
}

/**
 * `chromium_desktop_windows_without_hevc_extension`, stated as a codec table.
 *
 * This is the runtime every committed status assumes. It is written out here rather
 * than derived from `expected_preflight`, so `codec_playable` is genuinely derived
 * from an input in the test rather than copied from the answer.
 */
export const REFERENCE_RUNTIME_CODECS: Record<CodecKey, Support> = {
  h264: 'yes',
  hevc: 'no',
  vp9: 'yes',
  av1: 'yes',
}

export function referenceCodecSupport(family: string | null): Support {
  if (!family) return 'unknown'
  const key = family as CodecKey
  return REFERENCE_RUNTIME_CODECS[key] ?? 'no'
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

export function policyForTier(tier: IngestTier, overrides: Partial<IngestPolicy> = {}): IngestPolicy {
  const report = {
    tier,
    extractor: 'webcodecs',
    tierInputs: { concurrencyScore: 2, memoryScore: 2, pointerScore: 2, average: 2, cappedBy: null },
  } as unknown as CapabilityReport
  return { ...deriveIngestPolicy(report), ...overrides }
}

export const TIERS: IngestTier[] = ['constrained', 'standard', 'ample']

export function tierProfile(tier: IngestTier) {
  return TIER_PROFILES[tier]
}

// ---------------------------------------------------------------------------
// synthetic frames and hashes
// ---------------------------------------------------------------------------

/**
 * A deterministic RGBA raster keyed on a content string.
 *
 * Hard vertical edges rather than a smooth gradient, for the same reason the real
 * fixtures are colour bars: a smooth gradient produces a near degenerate dHash and
 * makes every duplicate assertion vacuous.
 */
export function syntheticFrame(content: string, width: number, height: number): RgbaImage {
  const rng = new SeededRng(`frame:${content}`)
  const bars = 8
  const palette: number[][] = []
  for (let i = 0; i < bars; i += 1) {
    palette.push([Math.floor(rng.next() * 256), Math.floor(rng.next() * 256), Math.floor(rng.next() * 256)])
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bar = palette[Math.floor((x / width) * bars)] ?? [0, 0, 0]
      const index = (y * width + x) * 4
      data[index] = bar[0] ?? 0
      data[index + 1] = bar[1] ?? 0
      data[index + 2] = bar[2] ?? 0
      data[index + 3] = 255
    }
  }
  return { width, height, data }
}

export function blackFrame(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(0) }
}

/**
 * A deterministic 64 bit hash for a content key, as the extractor would produce.
 *
 * Used where a test needs frames to exist without a decoder. Unrelated keys land
 * about 32 bits apart, and `nearDuplicateHashes` perturbs a few bits so the pair is
 * inside the manifest's Hamming tolerance. The separation is asserted in the suite
 * rather than assumed, because a generator that quietly produced similar hashes for
 * every key would make the duplicate rule look right while testing nothing.
 */
export function syntheticHashes(contentKey: string, count: number): string[] {
  const rng = new SeededRng(`hash:${contentKey}`)
  const out: string[] = []
  for (let frame = 0; frame < count; frame += 1) {
    let hex = ''
    for (let nibble = 0; nibble < 16; nibble += 1) hex += Math.floor(rng.next() * 16).toString(16)
    out.push(hex)
  }
  return out
}

/** The same shot, re-encoded: identical structure with a couple of bits moved. */
export function nearDuplicateHashes(contentKey: string, count: number, bitsToFlip = 2): string[] {
  const base = syntheticHashes(contentKey, count)
  return base.map((hash, index) => (index === 0 ? flipBits(hash, bitsToFlip) : hash))
}

function flipBits(hash: string, bits: number): string {
  const chars = hash.split('')
  for (let i = 0; i < bits; i += 1) {
    const position = i % chars.length
    const value = Number.parseInt(chars[position] ?? '0', 16)
    chars[position] = (value ^ (1 << i % 4)).toString(16)
  }
  return chars.join('')
}

// ---------------------------------------------------------------------------
// the fake extraction host
// ---------------------------------------------------------------------------

export interface FakeHostOptions {
  /** Which adapters exist, in the order the host offers them. */
  paths?: ('webcodecs' | 'video-canvas')[]
  /** Per path behaviour. Default: succeeds. */
  behaviour?: Partial<
    Record<
      'webcodecs' | 'video-canvas',
      | { kind: 'ok'; contentKey?: string; landOffsetS?: number; snapToGopS?: number }
      | { kind: 'fail'; reason: DecodeOutcome['reason'] }
      | { kind: 'blank' }
      | { kind: 'throw' }
    >
  >
  /** Null makes encoding fail, which is a real runtime outcome and not a crash. */
  encode?: 'ok' | 'unavailable'
  stillDecoder?: boolean
  probe?: { duration_s: number | null; reported: { width: number; height: number } | null } | null
  frameSize?: { width: number; height: number }
}

export interface FakeHostCounters {
  allocated: number
  released: number
  decodeCalls: { path: string; times: number[] }[]
  encodeCalls: { width: number; height: number; quality: number }[]
}

export interface FakeHost extends ExtractionHost {
  counters: FakeHostCounters
}

export function fakeExtractionHost(options: FakeHostOptions = {}): FakeHost {
  const counters: FakeHostCounters = { allocated: 0, released: 0, decodeCalls: [], encodeCalls: [] }
  const paths = options.paths ?? ['webcodecs', 'video-canvas']
  const size = options.frameSize ?? { width: 270, height: 480 }

  const adapters: DecodeAdapter[] = paths.map((path) => ({
    path,
    async decode(_input: MediaInput, request: DecodeRequest): Promise<DecodeOutcome> {
      counters.decodeCalls.push({ path, times: [...request.times] })
      const behaviour = options.behaviour?.[path] ?? { kind: 'ok' as const }

      if (behaviour.kind === 'throw') throw new Error(`fake ${path} adapter exploded`)

      const release = (): void => {
        counters.released += 1
      }

      if (behaviour.kind === 'fail') {
        counters.allocated += 1
        return {
          ok: false,
          reason: behaviour.reason,
          rotation_source: null,
          frames: [],
          diagnostics: [`fake ${path}: ${behaviour.reason}`],
          release,
        }
      }

      counters.allocated += 1
      const frames = request.times.map((time, index) => {
        // The element path snaps to the preceding keyframe, which is the whole
        // reason `t_seconds` is a target rather than a promise.
        const snap = behaviour.kind === 'ok' ? (behaviour.snapToGopS ?? 0) : 0
        const offset = behaviour.kind === 'ok' ? (behaviour.landOffsetS ?? 0) : 0
        const landed = snap > 0 ? Math.floor(time / snap) * snap : time + offset
        const content =
          behaviour.kind === 'ok' ? `${behaviour.contentKey ?? 'fake'}:${index}` : `blank:${index}`
        return {
          planned_t_seconds: time,
          actual_t_seconds: Number(landed.toFixed(6)),
          raster: behaviour.kind === 'blank' ? blackFrame(size.width, size.height) : syntheticFrame(content, size.width, size.height),
        }
      })

      return {
        ok: true,
        reason: null,
        rotation_source: request.rotation_deg === 0 ? 'not_needed' : 'we_applied',
        frames,
        measured_duration_s: request.duration_s,
        reported_size: request.coded,
        diagnostics: [],
        release,
      }
    },
  }))

  const host: FakeHost = {
    counters,
    adapters,
    async encodeJpeg(image: RgbaImage, quality: number) {
      counters.encodeCalls.push({ width: image.width, height: image.height, quality })
      if (options.encode === 'unavailable') return null
      // Not a real JPEG: the bytes stand in for one, and its length tracks the
      // pixel count so a size assertion is not meaningless.
      return new Blob([new Uint8Array(Math.max(1, Math.round((image.width * image.height) / 64)))], {
        type: 'image/jpeg',
      })
    },
  }

  if (options.stillDecoder) {
    host.decodeStill = async (_input, longEdge) => syntheticFrame('still', Math.round(longEdge * 0.5625), longEdge)
  }
  if (options.probe !== undefined) {
    host.probeMedia = async () => options.probe ?? null
  }

  return host
}
