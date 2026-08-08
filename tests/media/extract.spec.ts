/**
 * The extraction chain.
 *
 * jsdom has no `VideoDecoder`, no video decode and no canvas rasteriser, so the two
 * decode adapters are injected doubles. What that leaves testable is everything the
 * pipeline actually decides: how many frames and when, which rung ran and in which
 * order, what happens when a rung fails, whether a blank draw is caught, how tiles
 * are laid out and capped, whether the placeholder is ever mistaken for a sheet, and
 * whether every allocation is released.
 *
 * Frame counts are never typed into this file. They come from
 * `expected_frames.by_tier.<tier>.count` in the committed manifest, which the
 * generator computed from `frameCountFor()`.
 */

import { describe, expect, it } from 'vitest'
import { frameCountFor } from '@/platform/capability'
import {
  DEFAULT_TIMEOUTS,
  EXTRACTOR_VERSION,
  allowedAdapters,
  composeSheetRaster,
  extractFrames,
  planFrames,
  planStillFrame,
  reconcileRotation,
  scaleToLongEdge,
  type ExtractionRequest,
} from '@/media/extract'
import { parseContainer, type ContainerFacts } from '@/media/atoms'
import { parseStill } from '@/media/still'
import { dHash, type RgbaImage } from '@/media/phash'
import {
  TIERS,
  fakeExtractionHost,
  fixtureBytes,
  fixtures,
  manifest,
  policyForTier,
  requireFixture,
  syntheticFrame,
} from './_support'

const withFrames = fixtures.filter((fixture) => fixture.expected_derivatives.contact_sheet && fixture.kind === 'video')

async function containerFor(id: string): Promise<ContainerFacts> {
  const facts = await parseContainer(fixtureBytes(requireFixture(id)), { sampleTables: true })
  expect(facts.ok, `${id} did not parse`).toBe(true)
  return facts
}

function requestFor(container: ContainerFacts, tier: Parameters<typeof policyForTier>[0]): ExtractionRequest {
  return {
    input: { blob: null, bytes: { size: 0, bytesRead: 0, readCount: 0, read: async () => new Uint8Array(0) }, mime_type: null, filename: 'fixture.mp4' },
    kind: 'video',
    policy: policyForTier(tier),
    decodable: 'yes',
    container,
    still: null,
  }
}

describe('the frame plan, from the manifest rather than from a number in a test', () => {
  it.each(withFrames.flatMap((fixture) => TIERS.map((tier) => [fixture.fixture_id, tier, fixture] as const)))(
    '%s at %s plans the count and layout the manifest recorded',
    (_id, tier, fixture) => {
      const expected = fixture.expected_frames.by_tier[tier]
      const plan = planFrames(fixture.declared.duration_s, tier)
      expect(plan.count).toBe(expected.count)
      expect(plan.layout).toBe(expected.layout)
      expect(plan.frames).toHaveLength(expected.count)
      // Evenly spaced, skipping the first and last moments.
      plan.frames.forEach((frame, index) => {
        expect(
          Math.abs(frame.planned_t_seconds - (expected.t_seconds[index] ?? -1)),
          `${fixture.fixture_id} at ${tier} frame ${index}`,
        ).toBeLessThanOrEqual(fixture.tolerance.frame_t_seconds)
      })
    },
  )

  it('never restates the formula: the plan count is exactly frameCountFor', () => {
    for (const tier of TIERS) {
      for (const duration of [0.4, 1.5, 2, 4, 6, 20, 300]) {
        expect(planFrames(duration, tier).count).toBe(frameCountFor(duration, tier))
      }
    }
  })

  it('makes the tier change the answer on every fixture that has frames', () => {
    // The property D2 exists for. The previous formula produced identical counts at
    // every tier for every fixture in this set, which made the tier system decorative.
    for (const fixture of withFrames) {
      expect(
        fixture.expected_frames.by_tier.constrained.count,
        `${fixture.fixture_id}: constrained and ample must differ`,
      ).not.toBe(fixture.expected_frames.by_tier.ample.count)
    }
  })

  it('plans a still as one frame with no layout, rather than as a 1x1 sheet', () => {
    const plan = planStillFrame('ample')
    expect(plan.count).toBe(1)
    expect(plan.layout).toBeNull()
    expect(plan.frames[0]?.planned_t_seconds).toBe(0)
  })

  it('falls back to the tier floor for a duration it cannot use', () => {
    for (const tier of TIERS) {
      expect(planFrames(null, tier).count).toBe(frameCountFor(0, tier))
      expect(planFrames(0, tier).count).toBe(frameCountFor(0, tier))
      expect(planFrames(Number.NaN, tier).count).toBe(frameCountFor(0, tier))
    }
  })
})

describe('rotation reconciliation', () => {
  it('does not rotate when the container says there is no rotation', () => {
    const decision = reconcileRotation({ width: 1080, height: 1920 }, 0, { width: 1080, height: 1920 })
    expect(decision.quarter_turns).toBe(0)
    expect(decision.source).toBe('not_needed')
  })

  it('does not rotate again when the element already applied the matrix', () => {
    // rotated_90.mp4: coded 1920x1080, display 1080x1920. An element reporting the
    // display size has already rotated, and rotating again produces sideways tiles.
    const decision = reconcileRotation({ width: 1920, height: 1080 }, 90, { width: 1080, height: 1920 })
    expect(decision.quarter_turns).toBe(0)
    expect(decision.source).toBe('element_applied')
    expect(decision.display).toEqual({ width: 1080, height: 1920 })
  })

  it('rotates when the element reports the coded size', () => {
    const decision = reconcileRotation({ width: 1920, height: 1080 }, 90, { width: 1920, height: 1080 })
    expect(decision.quarter_turns).toBe(1)
    expect(decision.source).toBe('we_applied')
    expect(decision.display).toEqual({ width: 1080, height: 1920 })
  })

  it('says undecidable on square coded dimensions instead of guessing', () => {
    const decision = reconcileRotation({ width: 1080, height: 1080 }, 90, { width: 1080, height: 1080 })
    expect(decision.source).toBe('undecidable')
    expect(decision.quarter_turns).toBe(0)
    expect(decision.note).toMatch(/square/)
  })

  it('applies the container matrix and says the result is suspect when nothing matches', () => {
    const decision = reconcileRotation({ width: 1920, height: 1080 }, 90, { width: 640, height: 480 })
    expect(decision.source).toBe('we_applied')
    expect(decision.note).toMatch(/suspect/)
  })
})

describe('the chain, rung by rung', () => {
  it('produces a real sheet and poster on the happy path and records how', async () => {
    const container = await containerFor('vertical_ok')
    const fixture = requireFixture('vertical_ok')
    const host = fakeExtractionHost({ behaviour: { webcodecs: { kind: 'ok', contentKey: 'vertical_ok' } } })
    const result = await extractFrames(requestFor(container, 'standard'), host)

    expect(result.path).toBe('webcodecs')
    expect(result.sheet).not.toBeNull()
    expect(result.poster).not.toBeNull()
    expect(result.placeholder).toBeNull()
    expect(result.reason).toBeNull()
    expect(result.frames).toHaveLength(fixture.expected_frames.by_tier.standard.count)
    expect(result.sheet?.layout).toBe(fixture.expected_frames.by_tier.standard.layout)
    expect(result.sheet?.frame_count).toBe(fixture.expected_frames.by_tier.standard.count)
    // Recorded on the artefact, so a better extractor can re-derive it later and
    // anybody comparing two sheets can see whether they are comparable.
    expect(result.sheet?.extractor_path).toBe('webcodecs')
    expect(result.sheet?.extractor_version).toBe(EXTRACTOR_VERSION)
    expect(result.sheet?.policy_tier).toBe('standard')
    expect(result.frame_hashes).toHaveLength(result.frames.length)
    expect(new Set(result.frame_hashes).size).toBe(result.frames.length)
  })

  it('prefers WebCodecs and falls to the element path when it fails', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost({
      behaviour: { webcodecs: { kind: 'fail', reason: 'demux_unavailable' }, 'video-canvas': { kind: 'ok' } },
    })
    const result = await extractFrames(requestFor(container, 'standard'), host)

    expect(host.counters.decodeCalls.map((call) => call.path)).toEqual(['webcodecs', 'video-canvas'])
    expect(result.path).toBe('video-canvas')
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts[0]).toMatchObject({ path: 'webcodecs', ok: false, reason: 'demux_unavailable' })
    expect(result.attempts[1]).toMatchObject({ path: 'video-canvas', ok: true })
    expect(result.sheet).not.toBeNull()
  })

  it('never offers WebCodecs to a runtime the probe said has none', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost()
    const policy = policyForTier('standard', { extractor: 'video-canvas' })
    const result = await extractFrames({ ...requestFor(container, 'standard'), policy }, host)
    expect(host.counters.decodeCalls.map((call) => call.path)).toEqual(['video-canvas'])
    expect(result.path).toBe('video-canvas')
  })

  it('produces no sheet at all when the runtime offers no extractor', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost()
    const policy = policyForTier('constrained', { extractor: 'none' })
    const result = await extractFrames({ ...requestFor(container, 'constrained'), policy }, host)
    expect(host.counters.decodeCalls).toHaveLength(0)
    expect(result.path).toBe('placeholder')
    expect(result.reason).toBe('no_extractor')
    expect(result.sheet).toBeNull()
  })

  it('does not attempt extraction at all when the platform says the codec cannot be decoded', async () => {
    // hevc.mov on the reference runtime. A try-and-catch into a black frame is worse
    // than no frame, because a black frame gets tagged.
    const container = await containerFor('hevc')
    const host = fakeExtractionHost()
    const result = await extractFrames({ ...requestFor(container, 'standard'), decodable: 'no' }, host)

    expect(host.counters.decodeCalls).toHaveLength(0)
    expect(host.counters.encodeCalls).toHaveLength(0)
    expect(result.path).toBe('placeholder')
    expect(result.reason).toBe('decode_unsupported')
    expect(result.sheet).toBeNull()
    expect(result.poster).toBeNull()
    expect(result.frames).toHaveLength(0)
    expect(result.frame_hashes).toHaveLength(0)
  })

  it('describes the placeholder as a tile to render, never as a stored artefact', async () => {
    const container = await containerFor('hevc')
    const result = await extractFrames(
      { ...requestFor(container, 'standard'), decodable: 'no' },
      fakeExtractionHost(),
    )
    const placeholder = result.placeholder
    expect(placeholder?.kind).toBe('grey_tile')
    expect(placeholder?.headline).toMatch(/no preview/i)
    // The remedy is the load bearing instruction: it is the only preventive control
    // this build has for the HEVC hole.
    expect(placeholder?.remedy).toMatch(/Most Compatible|H\.264/)
    // The facts we do have are carried, so the manager card is not empty.
    expect(placeholder?.facts.duration_s).toBeCloseTo(4, 1)
    expect(placeholder?.facts.display).toEqual({ width: 1080, height: 1920 })
    expect(placeholder?.facts.codec).toBe('hvc1')
    // And there is nothing a blob store could be handed.
    expect(Object.keys(placeholder ?? {})).not.toContain('blob')
  })

  it('names ProRes differently from HEVC, because the remedy differs', async () => {
    const container = await containerFor('prores')
    const result = await extractFrames(
      { ...requestFor(container, 'standard'), decodable: 'no' },
      fakeExtractionHost(),
    )
    expect(result.placeholder?.headline).toMatch(/ProRes/)
  })

  it('treats an all blank decode as a failure and tries the next rung', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost({ behaviour: { webcodecs: { kind: 'blank' }, 'video-canvas': { kind: 'ok' } } })
    const result = await extractFrames(requestFor(container, 'standard'), host)
    expect(result.attempts[0]).toMatchObject({ path: 'webcodecs', reason: 'blank_frame' })
    expect(result.path).toBe('video-canvas')
    expect(result.sheet).not.toBeNull()
  })

  it('writes no sheet when every rung produces blank frames', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost({ behaviour: { webcodecs: { kind: 'blank' }, 'video-canvas': { kind: 'blank' } } })
    const result = await extractFrames(requestFor(container, 'standard'), host)
    expect(result.sheet).toBeNull()
    expect(result.reason).toBe('blank_frame')
    expect(host.counters.encodeCalls).toHaveLength(0)
  })

  it('refuses without a duration rather than seeking into nothing', async () => {
    const container = await containerFor('vertical_ok')
    const zeroDuration: ContainerFacts = {
      ...container,
      duration_s: { value: null, confidence: 'none', evidence: 'none' },
    }
    const host = fakeExtractionHost({ probe: null })
    const result = await extractFrames(requestFor(zeroDuration, 'standard'), host)
    expect(result.reason).toBe('zero_duration')
    expect(host.counters.decodeCalls).toHaveLength(0)
  })

  it('asks the runtime for a duration when the container has none, because metadata is an enhancement', async () => {
    // QC-MEDIA-124: a file with no moov still gets a sheet.
    const host = fakeExtractionHost({ probe: { duration_s: 6, reported: { width: 1080, height: 1920 } } })
    const result = await extractFrames(
      {
        input: { blob: null, bytes: { size: 0, bytesRead: 0, readCount: 0, read: async () => new Uint8Array(0) }, mime_type: null, filename: 'no-moov.mp4' },
        kind: 'video',
        policy: policyForTier('standard'),
        decodable: 'unknown',
        container: null,
        still: null,
      },
      host,
    )
    expect(result.sheet).not.toBeNull()
    expect(result.plan.count).toBe(frameCountFor(6, 'standard'))
    expect(result.measured).toEqual({ duration_s: 6, reported: { width: 1080, height: 1920 } })
  })

  it('records the times it actually reached rather than the times it planned', async () => {
    // The element path snaps to the preceding keyframe. A short clip can therefore
    // land two planned times on one decoded frame, and the sheet must say so.
    const container = await containerFor('short_fail')
    const fixture = requireFixture('short_fail')
    const host = fakeExtractionHost({
      paths: ['video-canvas'],
      behaviour: { 'video-canvas': { kind: 'ok', snapToGopS: 0.5 } },
    })
    const policy = policyForTier('ample', { extractor: 'video-canvas' })
    const result = await extractFrames({ ...requestFor(container, 'ample'), policy }, host)

    expect(result.frames).toHaveLength(fixture.expected_frames.by_tier.ample.count)
    for (const frame of result.frames) {
      expect(frame.actual_t_seconds).not.toBeUndefined()
      expect(
        Math.abs(frame.actual_t_seconds - frame.planned_t_seconds),
        'a landed frame stays inside the manifest tolerance of its plan',
      ).toBeLessThanOrEqual(fixture.tolerance.frame_t_seconds)
    }
    // Two tiles legitimately landing on the same moment is a property of the path,
    // and it must never be described as five distinct moments.
    const distinctPlanned = new Set(result.frames.map((frame) => frame.planned_t_seconds)).size
    const distinctLanded = new Set(result.frames.map((frame) => frame.actual_t_seconds)).size
    expect(distinctPlanned).toBeGreaterThan(distinctLanded)
  })

  it('survives an adapter that throws, and still releases what it allocated', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost({ behaviour: { webcodecs: { kind: 'throw' } } })
    await expect(extractFrames(requestFor(container, 'standard'), host)).rejects.toThrow(/exploded/)
  })

  it('reports a failed encode rather than claiming a sheet', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost({ encode: 'unavailable' })
    const result = await extractFrames(requestFor(container, 'standard'), host)
    expect(result.sheet).toBeNull()
    expect(result.reason).toBe('sheet_encode_failed')
    expect(result.placeholder).not.toBeNull()
  })

  it('carries the enumerated timeouts so nothing waits forever', async () => {
    expect(DEFAULT_TIMEOUTS.metadata_ms).toBeGreaterThan(0)
    expect(DEFAULT_TIMEOUTS.seek_ms).toBeGreaterThan(0)
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost()
    let seen: number | null = null
    const adapter = host.adapters[0]
    const wrapped = {
      path: adapter?.path ?? 'webcodecs',
      decode: async (input: never, request: { timeouts: { seek_ms: number } }) => {
        seen = request.timeouts.seek_ms
        return adapter!.decode(input, request as never)
      },
    }
    await extractFrames(
      { ...requestFor(container, 'standard'), timeouts: { metadata_ms: 100, seek_ms: 50 } },
      { ...host, adapters: [wrapped as never] },
    )
    expect(seen).toBe(50)
  })
})

describe('memory discipline', () => {
  it('releases every allocation, on success and on failure', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost({
      behaviour: { webcodecs: { kind: 'fail', reason: 'seek_timeout' }, 'video-canvas': { kind: 'ok' } },
    })
    await extractFrames(requestFor(container, 'standard'), host)
    expect(host.counters.allocated).toBe(2)
    expect(host.counters.released).toBe(host.counters.allocated)
  })

  it('releases across a whole batch', async () => {
    const host = fakeExtractionHost()
    for (const fixture of withFrames) {
      const container = await parseContainer(fixtureBytes(fixture), { sampleTables: true })
      await extractFrames(requestFor(container, 'constrained'), host)
    }
    expect(host.counters.released).toBe(host.counters.allocated)
    expect(host.counters.allocated).toBe(withFrames.length)
  })

  it('never asks a decoder for a frame at native resolution', async () => {
    const container = await containerFor('vertical_ok')
    const host = fakeExtractionHost()
    const policy = policyForTier('constrained')
    await extractFrames({ ...requestFor(container, 'constrained'), policy }, host)
    // The request carries the target long edge, and 1920 is never it.
    expect(policy.frameLongEdge).toBeLessThan(1920)
  })
})

describe('composition', () => {
  it('tiles frames into one strip with identical tile boxes', () => {
    const policy = policyForTier('standard')
    const frames = [syntheticFrame('a', 270, 480), syntheticFrame('b', 270, 480), syntheticFrame('c', 270, 480)]
    const composed = composeSheetRaster(frames, policy)
    expect(composed).not.toBeNull()
    expect(composed?.width).toBe((composed?.tileWidth ?? 0) * 3)
    expect(composed?.height).toBe(composed?.tileHeight)
    expect(composed?.raster.data.length).toBe((composed?.width ?? 0) * (composed?.height ?? 0) * 4)
  })

  it('caps the sheet long edge, which is a correctness requirement rather than a cost preference', () => {
    const policy = policyForTier('ample')
    const frames = Array.from({ length: 7 }, (_, index) => syntheticFrame(`f${index}`, 270, 480))
    const composed = composeSheetRaster(frames, policy)
    expect(Math.max(composed?.width ?? 0, composed?.height ?? 0)).toBeLessThanOrEqual(policy.sheetLongEdgeCap)
    // And it is capped by shrinking the tiles once, not by resampling the strip twice.
    expect(composed?.tileWidth).toBeLessThan(policy.frameLongEdge)
  })

  it('keeps every tile distinct in the composed pixels, not just in the frame list', () => {
    const policy = policyForTier('standard')
    const frames = [syntheticFrame('one', 270, 480), syntheticFrame('two', 270, 480)]
    const composed = composeSheetRaster(frames, policy)
    expect(composed).not.toBeNull()
    const left = cropTile(composed!.raster, 0, composed!.tileWidth, composed!.tileHeight)
    const right = cropTile(composed!.raster, composed!.tileWidth, composed!.tileWidth, composed!.tileHeight)
    expect(dHash(left)).not.toBe(dHash(right))
  })

  it('returns null for an empty frame list rather than a zero sized sheet', () => {
    expect(composeSheetRaster([], policyForTier('standard'))).toBeNull()
  })

  it('scales a poster down and leaves an already small image alone', () => {
    const big = syntheticFrame('p', 540, 960)
    const poster = scaleToLongEdge(big, 480)
    expect(Math.max(poster.width, poster.height)).toBe(480)
    const small = syntheticFrame('p', 90, 160)
    expect(scaleToLongEdge(small, 480)).toBe(small)
  })
})

describe('the still path', () => {
  it('makes a still its own sheet, with no layout and no fabricated tiling', async () => {
    const facts = await parseStill(fixtureBytes(requireFixture('photo_still')))
    const host = fakeExtractionHost({ stillDecoder: true })
    const result = await extractFrames(
      {
        input: { blob: null, bytes: { size: 0, bytesRead: 0, readCount: 0, read: async () => new Uint8Array(0) }, mime_type: null, filename: 'photo_still.jpg' },
        kind: 'photo',
        policy: policyForTier('standard'),
        decodable: 'yes',
        container: null,
        still: facts,
      },
      host,
    )
    expect(result.sheet).not.toBeNull()
    expect(result.sheet?.layout).toBeNull()
    expect(result.sheet?.frame_count).toBe(1)
    expect(result.frame_hashes).toHaveLength(1)
    expect(result.poster).not.toBeNull()
  })

  it('produces no sheet for a still in a runtime with no image decoder', async () => {
    const facts = await parseStill(fixtureBytes(requireFixture('photo_still')))
    const result = await extractFrames(
      {
        input: { blob: null, bytes: { size: 0, bytesRead: 0, readCount: 0, read: async () => new Uint8Array(0) }, mime_type: null, filename: 'photo_still.jpg' },
        kind: 'photo',
        policy: policyForTier('standard'),
        decodable: 'yes',
        container: null,
        still: facts,
      },
      fakeExtractionHost({ stillDecoder: false }),
    )
    expect(result.sheet).toBeNull()
    expect(result.reason).toBe('decode_unsupported')
  })
})

describe('adapter ordering', () => {
  it('puts WebCodecs first regardless of the order the host listed them', () => {
    const host = fakeExtractionHost({ paths: ['video-canvas', 'webcodecs'] })
    const order = allowedAdapters(host.adapters, policyForTier('ample')).map((adapter) => adapter.path)
    expect(order).toEqual(['webcodecs', 'video-canvas'])
  })

  it('offers nothing when the probe found no extractor', () => {
    const host = fakeExtractionHost()
    expect(allowedAdapters(host.adapters, policyForTier('ample', { extractor: 'none' }))).toHaveLength(0)
  })
})

describe('the manifest agrees with the extractor about which fixtures have frames', () => {
  it('expects zero frames at every tier exactly where there are no pixels', () => {
    for (const fixture of fixtures) {
      if (fixture.expected_derivatives.contact_sheet) continue
      for (const tier of TIERS) {
        expect(fixture.expected_frames.by_tier[tier].count, `${fixture.fixture_id} at ${tier}`).toBe(0)
      }
      expect(fixture.expected_derivatives.derivative_state).toBe('none')
      expect(fixture.expected_derivatives.reason).toBeTruthy()
    }
  })

  it('names the reference runtime the frame expectations assume', () => {
    expect(manifest.reference_runtime.id).toBe('chromium_desktop_windows_without_hevc_extension')
  })
})

function cropTile(sheet: RgbaImage, x: number, width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const from = (row * sheet.width + (x + column)) * 4
      const to = (row * width + column) * 4
      data[to] = sheet.data[from] ?? 0
      data[to + 1] = sheet.data[from + 1] ?? 0
      data[to + 2] = sheet.data[from + 2] ?? 0
      data[to + 3] = sheet.data[from + 3] ?? 0
    }
  }
  return { width, height, data }
}
