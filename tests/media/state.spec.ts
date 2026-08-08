/**
 * The state machine for bytes.
 *
 * Two claims are under test, and the second one is the product claim:
 *
 * 1. `media_state` and `derivative_state` are orthogonal, so "real metadata, no
 *    pixels, permanently" is expressible rather than being forced to read as broken
 *    or as ready.
 * 2. The transport refuses to move an original until pre-flight passes and review has
 *    moved on, and the refusal happens inside the transition rather than in a caller.
 */

import { describe, expect, it } from 'vitest'
import { TIER_PROFILES } from '@/platform/capability'
import { parseContainer } from '@/media/atoms'
import { extractFrames, type ExtractionResult } from '@/media/extract'
import { evaluatePreflight, type PreflightResult } from '@/media/preflight'
import {
  applyTransfer,
  canTransferOriginal,
  deriveDerivativeState,
  deriveMediaState,
  reviewTransferBytes,
  type TransferGateInputs,
} from '@/media/state'
import {
  contextFromManifest,
  fakeExtractionHost,
  fixtureBytes,
  fixtures,
  policyForTier,
  referenceCodecSupport,
  requireFixture,
  syntheticHashes,
} from './_support'
import { codecFamilyOf } from '@/media/atoms'

async function preflightFor(id: string, frames = true): Promise<PreflightResult> {
  const fixture = requireFixture(id)
  const container = await parseContainer(fixtureBytes(fixture), { sampleTables: true })
  const family = codecFamilyOf(container.codec_video.value)
  return evaluatePreflight(
    {
      kind: fixture.kind,
      file: { filename: id, bytes: fixture.bytes, last_modified_ms: null, mime_type: null },
      container: container.ok ? container : null,
      still: null,
      parse_failure: container.reason,
      decode: null,
      codec_support: referenceCodecSupport(family),
      codec_unsupported_everywhere: family === 'prores',
      frames: { hashes: frames ? syntheticHashes(id, 5) : [], failure: frames ? null : 'decode_unsupported' },
      priors: [],
    },
    contextFromManifest(),
  )
}

async function extractionFor(id: string, decodable: 'yes' | 'no'): Promise<ExtractionResult> {
  const container = await parseContainer(fixtureBytes(requireFixture(id)), { sampleTables: true })
  return extractFrames(
    {
      input: {
        blob: null,
        bytes: { size: 0, bytesRead: 0, readCount: 0, read: async () => new Uint8Array(0) },
        mime_type: null,
        filename: id,
      },
      kind: 'video',
      policy: policyForTier('standard'),
      decodable,
      container: container.ok ? container : null,
      still: null,
    },
    fakeExtractionHost(),
  )
}

describe('media_state: where the original bytes are', () => {
  const base = {
    file_bytes: 200_000,
    max_local_original_bytes: TIER_PROFILES.standard.maxLocalOriginalBytes,
    used_local_bytes: 0,
    byte_store_available: true,
    written_locally: true,
    present_remotely: false,
  }

  it('is bytes_local once a write completed', () => {
    expect(deriveMediaState(base)).toEqual({ state: 'bytes_local', reason: null, declined_bytes: null, note: null })
  })

  it('refuses to keep an original that would take storage past the tier budget', () => {
    // One ProRes clip is 1.8GB, which is why the budget is in bytes and not in clips.
    const decision = deriveMediaState({
      ...base,
      written_locally: false,
      file_bytes: 1_800_000_000,
    })
    expect(decision.state).toBe('bytes_absent')
    expect(decision.reason).toBe('over_local_byte_budget')
    expect(decision.declined_bytes).toBe(1_800_000_000)
    expect(decision.note).toMatch(/contact sheet was kept/)
  })

  it('counts what is already held rather than only the new file', () => {
    const decision = deriveMediaState({
      ...base,
      written_locally: false,
      used_local_bytes: TIER_PROFILES.standard.maxLocalOriginalBytes - 1000,
      file_bytes: 2000,
    })
    expect(decision.reason).toBe('over_local_byte_budget')
  })

  it('is bytes_remote rather than absent when the server already has it', () => {
    const decision = deriveMediaState({
      ...base,
      written_locally: false,
      byte_store_available: false,
      present_remotely: true,
    })
    expect(decision.state).toBe('bytes_remote')
    expect(decision.reason).toBe('no_local_byte_store')
  })

  it('keeps the app working in a runtime with no OPFS at all', () => {
    const decision = deriveMediaState({ ...base, written_locally: false, byte_store_available: false })
    expect(decision.state).toBe('bytes_absent')
    expect(decision.note).toMatch(/Derivatives still work/)
  })
})

describe('derivative_state: whether there are pixels', () => {
  it('is ready with a producer and an extractor path when a sheet and poster exist', async () => {
    const extraction = await extractionFor('vertical_ok', 'yes')
    const decision = deriveDerivativeState(extraction)
    expect(decision.state).toBe('ready')
    expect(decision.producer).toBe('browser')
    expect(decision.manifest_label).toBe('client_derived')
    expect(decision.extractor_path).toBe('webcodecs')
    expect(decision.extractor_version).toBe(extraction.extractor_version)
    expect(decision.policy_tier).toBe('standard')
    expect(decision.reason).toBeNull()
  })

  it('is none with a reason and no producer when there are no pixels', async () => {
    const extraction = await extractionFor('hevc', 'no')
    const decision = deriveDerivativeState(extraction)
    expect(decision.state).toBe('none')
    expect(decision.manifest_label).toBe('none')
    expect(decision.producer).toBeNull()
    expect(decision.reason).toBe('decode_unsupported')
    // The placeholder is a UI descriptor. Nothing here claims a derivative exists.
    expect(decision.extractor_path).toBeNull()
    expect(extraction.placeholder).not.toBeNull()
  })

  it('matches the manifest expectation for every fixture with and without derivatives', async () => {
    for (const fixture of fixtures.filter((entry) => entry.kind === 'video')) {
      const decodable = fixture.expected_derivatives.contact_sheet ? 'yes' : 'no'
      const extraction = await extractionFor(fixture.fixture_id, decodable)
      const decision = deriveDerivativeState(extraction)
      expect(decision.manifest_label, fixture.fixture_id).toBe(fixture.expected_derivatives.derivative_state)
    }
  })

  it('is partial rather than ready when the sheet encoded and the poster did not', async () => {
    const extraction = await extractionFor('vertical_ok', 'yes')
    const withoutPoster: ExtractionResult = { ...extraction, poster: null }
    const decision = deriveDerivativeState(withoutPoster)
    expect(decision.state).toBe('partial')
    expect(decision.reason).toBe('poster_encode_failed')
  })
})

describe('the transport gate', () => {
  const gate = (overrides: Partial<TransferGateInputs> = {}): TransferGateInputs => ({
    preflight: null,
    media_state: 'bytes_local',
    review_has_moved: false,
    needs_transcode: false,
    ...overrides,
  })

  it('refuses before pre-flight has run', () => {
    const decision = canTransferOriginal(gate())
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('preflight_not_run')
  })

  it('refuses a clip with a blocking failure, and names the rules', async () => {
    for (const id of ['horizontal_fail', 'lowres_fail', 'short_fail', 'prores']) {
      const preflight = await preflightFor(id, false)
      expect(preflight.rollup.blocking_fail, id).toBeGreaterThan(0)
      const decision = canTransferOriginal(gate({ preflight, review_has_moved: true }))
      expect(decision.allowed, id).toBe(false)
      expect(decision.reason, id).toBe('preflight_blocking_fail')
      expect(decision.blocked_by.length, id).toBeGreaterThan(0)
      expect(decision.note, id).toContain(decision.blocked_by[0] ?? '')
    }
  })

  it('does not refuse for an unknown, which is the whole point of the four states', async () => {
    // prores with its two blocking failures set aside: only the three unknowns remain,
    // and a legitimate camera delivery from the VIP visit must not be refused by a
    // rule about a GPS chip that does not exist.
    const preflight = await preflightFor('prores', false)
    const unblocked: PreflightResult = {
      ...preflight,
      rules: {
        ...preflight.rules,
        orientation: { ...preflight.rules.orientation, status: 'pass', blocking: false },
        min_resolution: { ...preflight.rules.min_resolution, status: 'pass', blocking: false },
      },
      rollup: { ...preflight.rollup, pass: 3, fail: 1, blocking_fail: 0 },
      blocked_by: [],
    }
    expect(unblocked.rollup.unknown).toBe(3)
    const decision = canTransferOriginal(gate({ preflight: unblocked, review_has_moved: true }))
    expect(decision.allowed).toBe(true)
  })

  it('holds the original back until review has moved on', async () => {
    const preflight = await preflightFor('vertical_ok')
    expect(preflight.rollup.blocking_fail).toBe(0)
    const held = canTransferOriginal(gate({ preflight }))
    expect(held.allowed).toBe(false)
    expect(held.reason).toBe('review_has_not_moved')
    expect(held.note).toMatch(/review happens on the contact sheet/)

    const released = canTransferOriginal(gate({ preflight, review_has_moved: true }))
    expect(released.allowed).toBe(true)
    expect(released.priority).toBe('normal')
  })

  it('lets an undecodable clip through with a raised priority, because nothing else can unblock it', async () => {
    // hevc.mov: no sheet, so review cannot move until the bytes do. Without this the
    // asset deadlocks, and the deadlock is invisible.
    const preflight = await preflightFor('hevc', false)
    expect(preflight.rollup.blocking_fail).toBe(0)
    const decision = canTransferOriginal(gate({ preflight, needs_transcode: true }))
    expect(decision.allowed).toBe(true)
    expect(decision.priority).toBe('required_for_transcode')
    expect(decision.note).toMatch(/only way this clip can ever be reviewed/)
  })

  it('still refuses an undecodable clip that also fails a blocking rule', async () => {
    // prores is landscape and small, so transcoding it would move bytes for footage
    // that fails the brief anyway.
    const preflight = await preflightFor('prores', false)
    const decision = canTransferOriginal(gate({ preflight, needs_transcode: true }))
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('preflight_blocking_fail')
  })

  it('refuses when there are no local bytes to send', async () => {
    const preflight = await preflightFor('vertical_ok')
    const decision = canTransferOriginal(
      gate({ preflight, review_has_moved: true, media_state: 'bytes_absent' }),
    )
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('no_bytes_to_send')
  })
})

describe('the transition, which is the only way the state changes', () => {
  it('evaluates the gate inside the transition rather than trusting the caller', async () => {
    const preflight = await preflightFor('horizontal_fail', false)
    const step = applyTransfer('not_queued', 'queue', {
      preflight,
      media_state: 'bytes_local',
      review_has_moved: true,
      needs_transcode: false,
    })
    expect(step.state).toBe('not_queued')
    expect(step.refused).toBe(true)
    expect(step.reason).toBe('preflight_blocking_fail')
    expect(step.decision?.blocked_by).toContain('orientation')
  })

  it('walks the happy path once the gate opens', async () => {
    const preflight = await preflightFor('vertical_ok')
    const inputs: TransferGateInputs = {
      preflight,
      media_state: 'bytes_local',
      review_has_moved: true,
      needs_transcode: false,
    }
    const queued = applyTransfer('not_queued', 'queue', inputs)
    expect(queued).toMatchObject({ state: 'queued', refused: false })
    const started = applyTransfer(queued.state, 'start', inputs)
    expect(started.state).toBe('in_flight')
    const done = applyTransfer(started.state, 'complete', inputs)
    expect(done.state).toBe('transferred')
  })

  it('refuses an illegal transition by name instead of ignoring it', async () => {
    const preflight = await preflightFor('vertical_ok')
    const inputs: TransferGateInputs = {
      preflight,
      media_state: 'bytes_local',
      review_has_moved: true,
      needs_transcode: false,
    }
    expect(applyTransfer('not_queued', 'complete', inputs)).toMatchObject({
      refused: true,
      reason: 'illegal_transition',
      state: 'not_queued',
    })
    expect(applyTransfer('transferred', 'queue', inputs)).toMatchObject({
      refused: true,
      reason: 'already_transferred',
    })
  })

  it('requeues a failed transfer only through the gate again', async () => {
    const preflight = await preflightFor('vertical_ok')
    const failed = applyTransfer('in_flight', 'fail', {
      preflight,
      media_state: 'bytes_local',
      review_has_moved: true,
      needs_transcode: false,
    })
    expect(failed.state).toBe('failed')
    const refused = applyTransfer('failed', 'requeue', {
      preflight,
      media_state: 'bytes_local',
      review_has_moved: false,
      needs_transcode: false,
    })
    expect(refused.refused).toBe(true)
    expect(refused.reason).toBe('review_has_not_moved')
  })
})

describe('what review costs in bytes', () => {
  it('counts the derivatives rather than estimating them', () => {
    const summary = reviewTransferBytes([
      { sheet_bytes: 150_000, poster_bytes: 20_000 },
      { sheet_bytes: 140_000, poster_bytes: 18_000 },
      // The undecodable clip contributes nothing, because it has nothing.
      { sheet_bytes: null, poster_bytes: null },
    ])
    expect(summary.total_bytes).toBe(328_000)
    expect(summary.assets_with_derivatives).toBe(2)
    expect(summary.per_asset_bytes).toBe(164_000)
  })

  it('reports zero rather than dividing by zero on a delivery with no derivatives', () => {
    expect(reviewTransferBytes([{ sheet_bytes: null, poster_bytes: null }])).toEqual({
      total_bytes: 0,
      per_asset_bytes: 0,
      assets_with_derivatives: 0,
    })
  })
})
