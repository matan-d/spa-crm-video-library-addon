/**
 * Builds a ProbeEnvironment from browser globals.
 *
 * This is the only file that reads platform globals directly, which is why it
 * lives under src/platform where the eslint ban on ambient reads is lifted.
 * Everything else in the application receives a CapabilityReport.
 *
 * Every read is defensive. A probe that throws takes the app down at boot on
 * exactly the unusual runtime we most needed to learn about, so an unreadable
 * signal becomes null and null means "the middle" in the tier scoring.
 */

import type { EngineHint, ProbeEnvironment } from '../capability'
import type { ShellId } from '../port'

export function browserProbeEnvironment(): ProbeEnvironment {
  return {
    shell: detectShell(),
    engineHint: detectEngine(),
    loadScheme: safe(() => globalThis.location?.protocol ?? 'unknown', 'unknown'),
    hardwareConcurrency: safe(() => {
      const value = navigator.hardwareConcurrency
      return typeof value === 'number' && value > 0 ? value : null
    }, null),
    deviceMemoryGb: safe(() => {
      // Chromium only. Absent elsewhere, and absence must score as the middle.
      const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      return typeof value === 'number' && value > 0 ? value : null
    }, null),
    pointerCoarse: safe(() => {
      if (typeof globalThis.matchMedia !== 'function') return null
      // Both queries are asked, because a device answering neither is telling us
      // it does not know, which is different from telling us it has a mouse.
      if (globalThis.matchMedia('(pointer: coarse)').matches) return true
      if (globalThis.matchMedia('(pointer: fine)').matches) return false
      return null
    }, null),
    hasWorker: has(() => typeof Worker === 'function'),
    hasOffscreenCanvas: has(() => typeof OffscreenCanvas === 'function'),
    hasCreateImageBitmap: has(() => typeof createImageBitmap === 'function'),
    hasVideoDecoder: has(() => typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === 'function'),
    // Both halves, deliberately: Safari shipped getDirectory in 15.2 but
    // createWritable only in 26, and a probe that answers from getDirectory
    // alone builds a byte store whose first put() is a TypeError on nine
    // Safari versions. See docs/platform-matrix.md P-1.
    hasOpfs: has(
      () =>
        typeof navigator.storage?.getDirectory === 'function' &&
        typeof FileSystemFileHandle !== 'undefined' &&
        'createWritable' in FileSystemFileHandle.prototype,
    ),
    hasFileSystemAccess: has(
      () => typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function',
    ),
    hasStorageEstimate: has(() => typeof navigator.storage?.estimate === 'function'),
    hasStoragePersist: has(() => typeof navigator.storage?.persist === 'function'),
    hasBroadcastChannel: has(() => typeof BroadcastChannel === 'function'),
    hasWebLocks: has(() => typeof navigator.locks?.request === 'function'),
    hasDirectoryDrop: has(() => 'webkitGetAsEntry' in DataTransferItem.prototype),
    decodingInfo: buildDecodingInfo(),
    canPlayType: buildCanPlayType(),
  }
}

function detectShell(): ShellId {
  // Feature presence only. Nothing here reads a user agent, because a user agent
  // lies on request and because branching on one is banned in this codebase.
  const g = globalThis as {
    process?: { versions?: { electron?: string } }
    Capacitor?: { getPlatform?: () => string; isNativePlatform?: () => boolean }
  }

  if (g.process?.versions?.electron) return 'electron'

  const platform = safe(() => g.Capacitor?.getPlatform?.() ?? null, null)
  const native = safe(() => g.Capacitor?.isNativePlatform?.() ?? false, false)
  if (native && platform === 'ios') return 'capacitor-ios'
  if (native && platform === 'android') return 'capacitor-android'

  return 'browser'
}

/**
 * Diagnostics only, and deliberately imprecise.
 *
 * Nothing in this product branches on the engine. It is reported so that a bug
 * report from a real device says something useful, and it is derived from feature
 * presence rather than a user agent so it cannot become a decision by accident.
 */
function detectEngine(): EngineHint {
  const g = globalThis as Record<string, unknown>
  if ('mozInnerScreenX' in g) return 'gecko'
  if ('chrome' in g && typeof (g as { chrome?: unknown }).chrome === 'object') return 'blink'
  if ('webkitConvertPointFromNodeToPage' in g) return 'webkit'
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    if (CSS.supports('-webkit-touch-callout', 'none')) return 'webkit'
    if (CSS.supports('-moz-appearance', 'none')) return 'gecko'
  }
  return 'unknown'
}

function buildDecodingInfo(): ProbeEnvironment['decodingInfo'] {
  const capabilities = safe(
    () => (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities ?? null,
    null,
  )
  if (!capabilities || typeof capabilities.decodingInfo !== 'function') return null

  return async (mimeWithCodecs: string) => {
    const info = await capabilities.decodingInfo({
      type: 'file',
      video: {
        contentType: mimeWithCodecs,
        // A representative vertical clip. The numbers matter: some engines answer
        // differently for resolutions above a hardware decoder's limit, and this
        // is the shape our creators actually deliver.
        width: 1080,
        height: 1920,
        bitrate: 4_000_000,
        framerate: 30,
      },
    })
    return { supported: info.supported, powerEfficient: info.powerEfficient }
  }
}

function buildCanPlayType(): ProbeEnvironment['canPlayType'] {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  const probe = safe(() => document.createElement('video'), null)
  if (!probe || typeof probe.canPlayType !== 'function') return null
  return (mimeWithCodecs: string) => safe(() => probe.canPlayType(mimeWithCodecs), '')
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    const value = read()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

function has(read: () => boolean): boolean {
  return safe(read, false)
}
