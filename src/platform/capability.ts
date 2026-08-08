/**
 * The capability probe, the ingest tiers, and the policy derived from them.
 *
 * The governing rule, from docs/06-decisions.md and the caveats review: nothing in
 * this product branches on a device category or a user agent string. Every
 * decision is made from an observed capability, because "mobile" as a code branch
 * is wrong on a 2019 laptop and wrong on a current iPad, and a user agent lies on
 * request.
 *
 * Two subtler rules, both learned the hard way in the reviews:
 *
 * 1. An absent signal scores as the MIDDLE, never the floor. `deviceMemory` is
 *    Chromium-only, so treating its absence as "low" would hand every Safari
 *    creator the worst possible artefacts.
 *
 * 2. A static probe cannot see thermal state. A phone that starts strong will
 *    throttle partway through a batch, so a measured extraction time may downgrade
 *    a tier mid-batch. Downgrades only: never upgrade mid-batch, or a cooling
 *    device produces a sheet at a different resolution than its neighbours.
 */

import type { CodecKey, ShellId, Support } from './port'

export type IngestTier = 'ample' | 'standard' | 'constrained'

/** Diagnostics only. Nothing in this product branches on the engine. */
export type EngineHint = 'blink' | 'gecko' | 'webkit' | 'unknown'

export type ExtractorKind = 'webcodecs' | 'video-canvas' | 'none'

/**
 * Everything the probe is allowed to look at, injected rather than read from
 * globals. This is what makes the probe testable, and it is also what stops a
 * platform read leaking into application code: if it is not in here, the app
 * cannot see it.
 */
export interface ProbeEnvironment {
  shell: ShellId
  engineHint: EngineHint
  /** The scheme the document was loaded from. `file:` breaks storage identity. */
  loadScheme: string
  hardwareConcurrency: number | null
  deviceMemoryGb: number | null
  /** True for touch, false for a mouse, null when the platform will not say. */
  pointerCoarse: boolean | null
  hasWorker: boolean
  hasOffscreenCanvas: boolean
  hasCreateImageBitmap: boolean
  hasVideoDecoder: boolean
  hasOpfs: boolean
  hasFileSystemAccess: boolean
  hasStorageEstimate: boolean
  hasStoragePersist: boolean
  hasBroadcastChannel: boolean
  hasWebLocks: boolean
  hasDirectoryDrop: boolean
  /** Async and authoritative where present. */
  decodingInfo: ((mimeWithCodecs: string) => Promise<{ supported: boolean; powerEfficient: boolean }>) | null
  /** Returns '', 'maybe' or 'probably'. Weaker than decodingInfo but widely available. */
  canPlayType: ((mimeWithCodecs: string) => string) | null
}

export interface CapabilityReport {
  shell: ShellId
  engineHint: EngineHint
  loadScheme: string
  tier: IngestTier
  tierInputs: TierInputs
  codecs: Record<CodecKey, { decode: Support; powerEfficient: boolean }>
  extractor: ExtractorKind
  storage: {
    opfs: boolean
    fileSystemAccess: boolean
    estimate: boolean
    persist: boolean
  }
  concurrency: {
    hardwareConcurrency: number | null
    deviceMemoryGb: number | null
    worker: boolean
    offscreenCanvas: boolean
    createImageBitmap: boolean
  }
  coordination: {
    broadcastChannel: boolean
    webLocks: boolean
  }
  input: {
    pointerCoarse: boolean | null
    directoryDrop: boolean
  }
  /** Populated when something is genuinely wrong rather than merely absent. */
  warnings: string[]
}

export interface TierInputs {
  concurrencyScore: number
  memoryScore: number
  pointerScore: number
  average: number
  cappedBy: string | null
}

// The codec strings the probe asks about. iPhone footage is tagged `hvc1`, not
// `hev1`, so both are asked and either answering yes counts as HEVC support.
const CODEC_QUERIES: Record<CodecKey, string[]> = {
  h264: ['video/mp4; codecs="avc1.42E01E"'],
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  vp9: ['video/webm; codecs="vp09.00.10.08"'],
  av1: ['video/mp4; codecs="av01.0.05M.08"'],
}

/**
 * Probes the runtime. Never throws: a probe that fails is a probe that reports
 * `unknown`, because a thrown probe takes the whole app down at boot on exactly
 * the unusual runtime we most needed to learn about.
 */
export async function probeCapabilities(env: ProbeEnvironment): Promise<CapabilityReport> {
  const warnings: string[] = []

  const codecs = {} as CapabilityReport['codecs']
  for (const codec of Object.keys(CODEC_QUERIES) as CodecKey[]) {
    codecs[codec] = await probeCodec(env, CODEC_QUERIES[codec], warnings)
  }

  const tierInputs = scoreTier(env)
  const tier = tierFromScore(tierInputs)

  const extractor: ExtractorKind = env.hasVideoDecoder
    ? 'webcodecs'
    : env.hasCreateImageBitmap
      ? 'video-canvas'
      : 'none'

  if (extractor === 'none') {
    warnings.push(
      'No frame extraction path is available in this runtime, so contact sheets cannot be produced locally.',
    )
  }
  if (!env.hasOpfs) {
    warnings.push('OPFS is unavailable, so original media bytes cannot be kept on this device.')
  }
  if (env.loadScheme === 'file:') {
    warnings.push(
      'Loaded over file:, which gives an opaque storage origin. IndexedDB and OPFS data will not be reachable from an http origin, and may not persist at all.',
    )
  }
  if (!env.hasStorageEstimate) {
    warnings.push('Storage estimates are unavailable, so quota pressure cannot be anticipated, only hit.')
  }

  return {
    shell: env.shell,
    engineHint: env.engineHint,
    loadScheme: env.loadScheme,
    tier,
    tierInputs,
    codecs,
    extractor,
    storage: {
      opfs: env.hasOpfs,
      fileSystemAccess: env.hasFileSystemAccess,
      estimate: env.hasStorageEstimate,
      persist: env.hasStoragePersist,
    },
    concurrency: {
      hardwareConcurrency: env.hardwareConcurrency,
      deviceMemoryGb: env.deviceMemoryGb,
      worker: env.hasWorker,
      offscreenCanvas: env.hasOffscreenCanvas,
      createImageBitmap: env.hasCreateImageBitmap,
    },
    coordination: {
      broadcastChannel: env.hasBroadcastChannel,
      webLocks: env.hasWebLocks,
    },
    input: {
      pointerCoarse: env.pointerCoarse,
      directoryDrop: env.hasDirectoryDrop,
    },
    warnings,
  }
}

async function probeCodec(
  env: ProbeEnvironment,
  queries: string[],
  warnings: string[],
): Promise<{ decode: Support; powerEfficient: boolean }> {
  if (env.decodingInfo) {
    let sawAnswer = false
    for (const mime of queries) {
      try {
        const result = await env.decodingInfo(mime)
        sawAnswer = true
        if (result.supported) return { decode: 'yes', powerEfficient: result.powerEfficient }
      } catch {
        // decodingInfo rejects on a malformed configuration on some engines, so a
        // rejection is not evidence of no support. Fall through to canPlayType.
      }
    }
    // A clean denial from decodingInfo is authoritative and final. Only a
    // REJECTION falls through to canPlayType; letting a 'probably' overrule an
    // explicit "not supported" answered the question with the weaker witness.
    // See docs/platform-matrix.md P-2.
    if (sawAnswer) return { decode: 'no', powerEfficient: false }
  }

  if (env.canPlayType) {
    for (const mime of queries) {
      const answer = env.canPlayType(mime)
      // 'probably' is the strongest a media element will ever claim.
      if (answer === 'probably') return { decode: 'yes', powerEfficient: false }
      // 'maybe' genuinely means maybe, so it is reported as unknown rather than
      // promoted to yes. Promoting it is how a black frame reaches a manager.
      if (answer === 'maybe') return { decode: 'unknown', powerEfficient: false }
    }
    return { decode: 'no', powerEfficient: false }
  }

  warnings.push('No codec detection API is available, so decode support is unknown rather than assumed.')
  return { decode: 'unknown', powerEfficient: false }
}

/**
 * Scores the three graded signals, in descending order of how much they can be
 * trusted. Absence scores 1, the middle, never 0.
 */
export function scoreTier(env: ProbeEnvironment): TierInputs {
  const concurrencyScore = gradeConcurrency(env.hardwareConcurrency)
  const memoryScore = gradeMemory(env.deviceMemoryGb)
  const pointerScore = gradePointer(env.pointerCoarse)

  const average = (concurrencyScore + memoryScore + pointerScore) / 3

  // No worker means every extraction runs on the main thread, so the interface
  // stutters under load regardless of how strong the machine is. Cap rather than
  // rescore, because the machine really is capable, we just cannot use it well.
  const cappedBy = env.hasWorker ? null : 'no_worker'

  return { concurrencyScore, memoryScore, pointerScore, average, cappedBy }
}

function gradeConcurrency(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 1
  if (value >= 8) return 2
  if (value >= 4) return 1
  return 0
}

function gradeMemory(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 1
  if (value >= 8) return 2
  if (value >= 4) return 1
  return 0
}

function gradePointer(coarse: boolean | null): number {
  if (coarse === null) return 1
  return coarse ? 0 : 2
}

export function tierFromScore(inputs: TierInputs): IngestTier {
  const raw: IngestTier = inputs.average >= 1.6 ? 'ample' : inputs.average >= 0.9 ? 'standard' : 'constrained'
  if (inputs.cappedBy === 'no_worker' && raw === 'ample') return 'standard'
  return raw
}

// ---------------------------------------------------------------------------
// the policy
// ---------------------------------------------------------------------------

export interface IngestPolicy {
  tier: IngestTier
  extractor: ExtractorKind
  /** How many clips are decoded at once. */
  decodeConcurrency: number
  /** Long edge of each extracted frame, before tiling. */
  frameLongEdge: number
  /** Hard cap on the tiled sheet's long edge. Not a cost preference, see D3. */
  sheetLongEdgeCap: number
  jpegQuality: number
  /** The poster is a stored artefact the grid depends on, so it does not vary by tier. */
  posterLongEdge: number
  uploadConcurrency: number
  chunkBytes: number
  /** Byte budget for originals kept locally. Budgeted in bytes, not in clip count, because one ProRes clip is 1.8GB. */
  maxLocalOriginalBytes: number
  /** Every downgrade that has been applied, for the record. */
  downgrades: string[]
}

interface TierProfile {
  frameFloor: number
  frameCeiling: number
  decodeConcurrency: number
  frameLongEdge: number
  jpegQuality: number
  uploadConcurrency: number
  chunkBytes: number
  maxLocalOriginalBytes: number
}

const MB = 1024 * 1024

/**
 * Frame counts per tier, resolving the contradiction the fixtures surfaced.
 * See docs/06-decisions.md D2 for the full reasoning.
 *
 * Capability sets the ceiling, duration sets the count within it. A weak phone
 * does exactly three frames whatever the clip length, because a long clip does
 * not make a phone stronger.
 */
const TIERS: Record<IngestTier, TierProfile> = {
  ample: {
    frameFloor: 5,
    frameCeiling: 7,
    decodeConcurrency: 4,
    frameLongEdge: 480,
    jpegQuality: 0.72,
    uploadConcurrency: 4,
    chunkBytes: 8 * MB,
    maxLocalOriginalBytes: 2048 * MB,
  },
  standard: {
    frameFloor: 4,
    frameCeiling: 6,
    decodeConcurrency: 2,
    frameLongEdge: 480,
    jpegQuality: 0.7,
    uploadConcurrency: 2,
    chunkBytes: 4 * MB,
    maxLocalOriginalBytes: 1024 * MB,
  },
  constrained: {
    frameFloor: 3,
    frameCeiling: 3,
    decodeConcurrency: 1,
    frameLongEdge: 360,
    jpegQuality: 0.66,
    uploadConcurrency: 2,
    chunkBytes: 2 * MB,
    maxLocalOriginalBytes: 512 * MB,
  },
}

export const SHEET_LONG_EDGE_CAP = 1024
export const POSTER_LONG_EDGE = 480

/** Layouts a contact sheet may take. Frame count is always within this range. */
export type SheetLayout = '1x3' | '1x4' | '1x5' | '1x6' | '1x7'

/**
 * Frames for a clip of this length at this tier.
 *
 * `clamp(3 + round(duration / 3), floor, ceiling)`, so a 6 second clip gets 5
 * frames on a capable machine and 3 on a phone.
 */
export function frameCountFor(durationSeconds: number, tier: IngestTier): number {
  const profile = TIERS[tier]
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return profile.frameFloor
  const scaled = 3 + Math.round(durationSeconds / 3)
  return Math.min(profile.frameCeiling, Math.max(profile.frameFloor, scaled))
}

export function layoutFor(frameCount: number): SheetLayout {
  const clamped = Math.min(7, Math.max(3, frameCount))
  return `1x${clamped}` as SheetLayout
}

export interface BatchHints {
  /** Number of files in this batch, if known. A large batch is itself a load signal. */
  fileCount?: number
  /** Largest file in bytes, if known. */
  largestBytes?: number
}

/**
 * Derives the policy once per batch, not once per file.
 *
 * Per batch rather than per file so every sheet in one delivery is produced at
 * the same resolution and quality, which matters because those artefacts are
 * stored and later compared against each other.
 */
export function deriveIngestPolicy(report: CapabilityReport, hints: BatchHints = {}): IngestPolicy {
  let tier = report.tier
  const downgrades: string[] = []

  if (report.tierInputs.cappedBy === 'no_worker') {
    downgrades.push('no_worker: extraction runs on the main thread, so concurrency is capped')
  }

  // A very large batch is a load signal in its own right: a folder drop of a
  // camera card can be hundreds of files, and holding ample concurrency across
  // it is how a tab dies with no diagnostics.
  if ((hints.fileCount ?? 0) > 60 && tier === 'ample') {
    tier = 'standard'
    downgrades.push(`large_batch: ${hints.fileCount} files, so concurrency is reduced`)
  }

  const profile = TIERS[tier]

  return {
    tier,
    extractor: report.extractor,
    decodeConcurrency: profile.decodeConcurrency,
    frameLongEdge: profile.frameLongEdge,
    sheetLongEdgeCap: SHEET_LONG_EDGE_CAP,
    jpegQuality: profile.jpegQuality,
    posterLongEdge: POSTER_LONG_EDGE,
    uploadConcurrency: profile.uploadConcurrency,
    chunkBytes: profile.chunkBytes,
    maxLocalOriginalBytes: profile.maxLocalOriginalBytes,
    downgrades,
  }
}

const TIER_ORDER: IngestTier[] = ['constrained', 'standard', 'ample']

/**
 * Applies a mid-batch downgrade, for example after the first clip's measured
 * extraction time comes in far above expectation because the device is throttling.
 *
 * Downgrade only. Upgrading mid-batch would produce neighbouring sheets at
 * different resolutions, which makes them incomparable for no benefit.
 */
export function downgradePolicy(policy: IngestPolicy, to: IngestTier, reason: string): IngestPolicy {
  const current = TIER_ORDER.indexOf(policy.tier)
  const next = TIER_ORDER.indexOf(to)
  if (next >= current) return policy

  const profile = TIERS[to]
  return {
    ...policy,
    tier: to,
    decodeConcurrency: profile.decodeConcurrency,
    frameLongEdge: profile.frameLongEdge,
    jpegQuality: profile.jpegQuality,
    uploadConcurrency: profile.uploadConcurrency,
    chunkBytes: profile.chunkBytes,
    maxLocalOriginalBytes: profile.maxLocalOriginalBytes,
    downgrades: [...policy.downgrades, `${policy.tier} -> ${to}: ${reason}`],
  }
}

/** Tier profiles, exported so tests and the storage panel can read them without duplicating numbers. */
export const TIER_PROFILES: Readonly<Record<IngestTier, Readonly<TierProfile>>> = TIERS
