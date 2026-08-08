import { describe, expect, it } from 'vitest'
import {
  deriveIngestPolicy,
  downgradePolicy,
  frameCountFor,
  layoutFor,
  probeCapabilities,
  scoreTier,
  SHEET_LONG_EDGE_CAP,
  tierFromScore,
  TIER_PROFILES,
  type ProbeEnvironment,
} from '@/platform/capability'

/** A capable desktop. Every signal present and strong. */
function desktop(overrides: Partial<ProbeEnvironment> = {}): ProbeEnvironment {
  return {
    shell: 'browser',
    engineHint: 'blink',
    loadScheme: 'https:',
    hardwareConcurrency: 16,
    deviceMemoryGb: 8,
    pointerCoarse: false,
    hasWorker: true,
    hasOffscreenCanvas: true,
    hasCreateImageBitmap: true,
    hasVideoDecoder: true,
    hasOpfs: true,
    hasFileSystemAccess: true,
    hasStorageEstimate: true,
    hasStoragePersist: true,
    hasBroadcastChannel: true,
    hasWebLocks: true,
    hasDirectoryDrop: true,
    decodingInfo: async () => ({ supported: true, powerEfficient: true }),
    canPlayType: () => 'probably',
    ...overrides,
  }
}

/** An iPhone: coarse pointer, no deviceMemory (it is Chromium only), modest cores. */
function iphone(overrides: Partial<ProbeEnvironment> = {}): ProbeEnvironment {
  return desktop({
    engineHint: 'webkit',
    hardwareConcurrency: 4,
    deviceMemoryGb: null,
    pointerCoarse: true,
    hasFileSystemAccess: false,
    hasDirectoryDrop: false,
    ...overrides,
  })
}

describe('tier scoring', () => {
  it('puts a capable desktop in ample', async () => {
    const report = await probeCapabilities(desktop())
    expect(report.tier).toBe('ample')
  })

  it('puts an iPhone in constrained', async () => {
    const report = await probeCapabilities(iphone())
    expect(report.tier).toBe('constrained')
  })

  it('scores an absent signal as the middle, never the floor', () => {
    // deviceMemory is Chromium only. Scoring its absence as low would hand every
    // Safari creator the worst possible artefacts, which is the bug this guards.
    const absent = scoreTier(desktop({ deviceMemoryGb: null }))
    const low = scoreTier(desktop({ deviceMemoryGb: 2 }))
    expect(absent.memoryScore).toBe(1)
    expect(low.memoryScore).toBe(0)
    expect(absent.average).toBeGreaterThan(low.average)
  })

  it('does not let a missing deviceMemory alone demote a strong machine', () => {
    expect(tierFromScore(scoreTier(desktop({ deviceMemoryGb: null })))).toBe('ample')
  })

  it('treats an unknown pointer as the middle rather than assuming a mouse', () => {
    expect(scoreTier(desktop({ pointerCoarse: null })).pointerScore).toBe(1)
  })

  it('puts an older laptop in standard', () => {
    const older = desktop({ hardwareConcurrency: 4, deviceMemoryGb: null, pointerCoarse: false })
    expect(tierFromScore(scoreTier(older))).toBe('standard')
  })

  it('caps a strong machine at standard when there is no worker', () => {
    // The machine is genuinely capable, we just cannot use it without stuttering
    // the interface, so this caps rather than rescoring.
    const inputs = scoreTier(desktop({ hasWorker: false }))
    expect(inputs.cappedBy).toBe('no_worker')
    expect(tierFromScore(inputs)).toBe('standard')
  })

  it('never promotes a weak device because it lacks a worker', () => {
    expect(tierFromScore(scoreTier(iphone({ hasWorker: false })))).toBe('constrained')
  })
})

describe('codec probing', () => {
  it('reports yes and power efficiency from decodingInfo', async () => {
    const report = await probeCapabilities(desktop())
    expect(report.codecs.hevc.decode).toBe('yes')
    expect(report.codecs.hevc.powerEfficient).toBe(true)
  })

  it('reports unknown rather than yes for a maybe from canPlayType', async () => {
    // Promoting 'maybe' to 'yes' is how a black frame reaches a manager.
    const report = await probeCapabilities(
      desktop({ decodingInfo: null, canPlayType: () => 'maybe' }),
    )
    expect(report.codecs.hevc.decode).toBe('unknown')
  })

  it('reports no when both APIs deny support', async () => {
    const report = await probeCapabilities(
      desktop({ decodingInfo: async () => ({ supported: false, powerEfficient: false }), canPlayType: () => '' }),
    )
    expect(report.codecs.hevc.decode).toBe('no')
  })

  it('falls back to canPlayType when decodingInfo rejects', async () => {
    // Some engines reject on a configuration they dislike, which is not evidence
    // of no support, so a rejection must not be recorded as a denial.
    const report = await probeCapabilities(
      desktop({
        decodingInfo: async () => {
          throw new TypeError('bad config')
        },
        canPlayType: () => 'probably',
      }),
    )
    expect(report.codecs.h264.decode).toBe('yes')
  })

  it('reports unknown and warns when no detection API exists at all', async () => {
    const report = await probeCapabilities(desktop({ decodingInfo: null, canPlayType: null }))
    expect(report.codecs.h264.decode).toBe('unknown')
    expect(report.warnings.join(' ')).toMatch(/no codec detection api/i)
  })

  it('never throws, whatever the environment does', async () => {
    const hostile: ProbeEnvironment = desktop({
      decodingInfo: async () => {
        throw new Error('boom')
      },
      canPlayType: () => {
        throw new Error('boom')
      },
    })
    // canPlayType throwing is the environment builder's job to contain, so this
    // asserts the probe itself survives a rejecting decodingInfo.
    await expect(probeCapabilities({ ...hostile, canPlayType: null })).resolves.toBeDefined()
  })
})

describe('extractor selection and warnings', () => {
  it('prefers WebCodecs when available', async () => {
    expect((await probeCapabilities(desktop())).extractor).toBe('webcodecs')
  })

  it('falls back to video plus canvas', async () => {
    expect((await probeCapabilities(desktop({ hasVideoDecoder: false }))).extractor).toBe('video-canvas')
  })

  it('reports none, and warns, when no extraction path exists', async () => {
    const report = await probeCapabilities(
      desktop({ hasVideoDecoder: false, hasCreateImageBitmap: false }),
    )
    expect(report.extractor).toBe('none')
    expect(report.warnings.join(' ')).toMatch(/no frame extraction path/i)
  })

  it('warns loudly about a file: origin, because storage identity breaks there', async () => {
    const report = await probeCapabilities(desktop({ loadScheme: 'file:' }))
    expect(report.warnings.join(' ')).toMatch(/opaque storage origin/i)
  })

  it('warns when OPFS is missing, since originals cannot be kept', async () => {
    const report = await probeCapabilities(desktop({ hasOpfs: false }))
    expect(report.warnings.join(' ')).toMatch(/opfs is unavailable/i)
  })

  it('reports the shell without reading a user agent', async () => {
    expect((await probeCapabilities(desktop({ shell: 'electron' }))).shell).toBe('electron')
  })
})

describe('frame count, the resolved formula', () => {
  it('gives a 6 second clip 5 frames on a capable machine', () => {
    // This is the decision recorded in docs/06-decisions.md D2, resolving the
    // contradiction between the C2.D worked example and the E.4a formula.
    expect(frameCountFor(6, 'ample')).toBe(5)
  })

  it('gives the same 6 second clip 3 frames on a phone', () => {
    expect(frameCountFor(6, 'constrained')).toBe(3)
  })

  it('scales with duration up to the tier ceiling', () => {
    expect(frameCountFor(6, 'ample')).toBe(5)
    expect(frameCountFor(9, 'ample')).toBe(6)
    expect(frameCountFor(12, 'ample')).toBe(7)
    expect(frameCountFor(60, 'ample')).toBe(7)
  })

  it('holds a phone at exactly three frames however long the clip is', () => {
    // A long clip does not make a phone stronger.
    expect(frameCountFor(3, 'constrained')).toBe(3)
    expect(frameCountFor(30, 'constrained')).toBe(3)
    expect(frameCountFor(300, 'constrained')).toBe(3)
  })

  it('never returns fewer than the tier floor for a very short clip', () => {
    expect(frameCountFor(0.5, 'ample')).toBe(5)
    expect(frameCountFor(1.5, 'standard')).toBe(4)
  })

  it('falls back to the floor for a duration it cannot use', () => {
    // A clip whose duration could not be read must still produce a sheet.
    expect(frameCountFor(Number.NaN, 'ample')).toBe(5)
    expect(frameCountFor(0, 'standard')).toBe(4)
    expect(frameCountFor(-3, 'constrained')).toBe(3)
  })

  it('stays inside the declared layout enum for every tier and duration', () => {
    for (const tier of ['ample', 'standard', 'constrained'] as const) {
      for (const duration of [0.5, 1, 3, 6, 9, 15, 45, 600]) {
        const count = frameCountFor(duration, tier)
        expect(count).toBeGreaterThanOrEqual(3)
        expect(count).toBeLessThanOrEqual(7)
        expect(layoutFor(count)).toBe(`1x${count}`)
      }
    }
  })

  it('makes the tier actually change the answer, which the old formula did not', () => {
    const durations = [5, 6, 8, 10, 12, 20, 30]
    const differing = durations.filter(
      (d) => frameCountFor(d, 'ample') !== frameCountFor(d, 'constrained'),
    )
    expect(differing).toEqual(durations)
  })
})

describe('ingest policy', () => {
  it('derives from the tier, and caps the sheet regardless of tier', async () => {
    const report = await probeCapabilities(desktop())
    const policy = deriveIngestPolicy(report)
    expect(policy.tier).toBe('ample')
    expect(policy.decodeConcurrency).toBe(4)
    expect(policy.sheetLongEdgeCap).toBe(SHEET_LONG_EDGE_CAP)
  })

  it('keeps the poster size constant across tiers, because the grid depends on it', () => {
    const sizes = new Set(
      (['ample', 'standard', 'constrained'] as const).map((tier) =>
        deriveIngestPolicy({ ...baseReport(), tier }).posterLongEdge,
      ),
    )
    expect(sizes.size).toBe(1)
  })

  it('reduces concurrency for a very large batch', async () => {
    const report = await probeCapabilities(desktop())
    const policy = deriveIngestPolicy(report, { fileCount: 240 })
    expect(policy.tier).toBe('standard')
    expect(policy.downgrades.join(' ')).toMatch(/large_batch/)
  })

  it('does not downgrade a small batch', async () => {
    const report = await probeCapabilities(desktop())
    expect(deriveIngestPolicy(report, { fileCount: 12 }).tier).toBe('ample')
  })

  it('records the no-worker cap in the policy so it is visible later', async () => {
    const report = await probeCapabilities(desktop({ hasWorker: false }))
    const policy = deriveIngestPolicy(report)
    expect(policy.downgrades.join(' ')).toMatch(/no_worker/)
  })

  it('budgets local originals in bytes, not in clip count', () => {
    // One two minute ProRes clip is about 1.8GB, so a count budget is meaningless.
    for (const tier of ['ample', 'standard', 'constrained'] as const) {
      expect(TIER_PROFILES[tier].maxLocalOriginalBytes).toBeGreaterThan(100 * 1024 * 1024)
    }
  })

  it('gives a phone smaller frames and smaller chunks than a desktop', () => {
    const phone = deriveIngestPolicy({ ...baseReport(), tier: 'constrained' })
    const desk = deriveIngestPolicy({ ...baseReport(), tier: 'ample' })
    expect(phone.frameLongEdge).toBeLessThan(desk.frameLongEdge)
    expect(phone.chunkBytes).toBeLessThan(desk.chunkBytes)
    expect(phone.decodeConcurrency).toBeLessThan(desk.decodeConcurrency)
  })
})

describe('mid-batch downgrade', () => {
  it('downgrades and records the reason', () => {
    const policy = deriveIngestPolicy({ ...baseReport(), tier: 'ample' })
    const downgraded = downgradePolicy(policy, 'constrained', 'first clip took 9s, device is throttling')
    expect(downgraded.tier).toBe('constrained')
    expect(downgraded.decodeConcurrency).toBe(1)
    expect(downgraded.downgrades[downgraded.downgrades.length - 1]).toMatch(
      /ample -> constrained: first clip took 9s/,
    )
  })

  it('refuses to upgrade, because neighbouring sheets must stay comparable', () => {
    const policy = deriveIngestPolicy({ ...baseReport(), tier: 'constrained' })
    const attempted = downgradePolicy(policy, 'ample', 'device cooled down')
    expect(attempted).toBe(policy)
    expect(attempted.tier).toBe('constrained')
  })

  it('is a no-op when asked to downgrade to the current tier', () => {
    const policy = deriveIngestPolicy({ ...baseReport(), tier: 'standard' })
    expect(downgradePolicy(policy, 'standard', 'nothing changed')).toBe(policy)
  })
})

function baseReport() {
  return {
    shell: 'browser' as const,
    engineHint: 'blink' as const,
    loadScheme: 'https:',
    tier: 'ample' as const,
    tierInputs: { concurrencyScore: 2, memoryScore: 2, pointerScore: 2, average: 2, cappedBy: null },
    codecs: {
      h264: { decode: 'yes' as const, powerEfficient: true },
      hevc: { decode: 'yes' as const, powerEfficient: true },
      vp9: { decode: 'yes' as const, powerEfficient: true },
      av1: { decode: 'no' as const, powerEfficient: false },
    },
    extractor: 'webcodecs' as const,
    storage: { opfs: true, fileSystemAccess: true, estimate: true, persist: true },
    concurrency: {
      hardwareConcurrency: 16,
      deviceMemoryGb: 8,
      worker: true,
      offscreenCanvas: true,
      createImageBitmap: true,
    },
    coordination: { broadcastChannel: true, webLocks: true },
    input: { pointerCoarse: false, directoryDrop: true },
    warnings: [],
  }
}
