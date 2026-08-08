/**
 * Assembles the browser platform.
 *
 * The only exercised implementation in this build. Electron and Capacitor native
 * are designed and unbuilt, per docs/06-decisions.md U4 and U6, and they slot in
 * here as alternative factories returning the same `PlatformPort`.
 */

import { probeCapabilities, type CapabilityReport } from '../capability'
import type { PlatformPort } from '../port'
import { browserProbeEnvironment } from './environment'
import { createOpfsByteStore, createUnavailableByteStore, openOpfsDirectory } from './bytes'
import {
  createBrowserFilePicker,
  createBrowserMediaCodecs,
  createBrowserQuotaMonitor,
  createBrowserSecretStore,
  createIndexedDbBlobStore,
} from './runtime'

export interface BrowserPlatformDeps {
  /** The already-open database for the active profile. */
  db: IDBDatabase
  /** OPFS subdirectory for this profile, so demo bytes cannot reach a live store. */
  bytesSubdirectory: string
  /** Injected, because the platform layer may not read ambient time either. */
  now: () => number
  /** Supplied by tests. Production probes the real runtime. */
  report?: CapabilityReport
}

export interface BrowserPlatform {
  port: PlatformPort
  report: CapabilityReport
}

export async function createBrowserPlatform(deps: BrowserPlatformDeps): Promise<BrowserPlatform> {
  const report = deps.report ?? (await probeCapabilities(browserProbeEnvironment()))

  // A runtime without OPFS still gets a working app: records, sheets and posters
  // all live in IndexedDB, and originals simply cannot be kept locally. That is
  // the `bytes_absent` state every record reaches anyway once bytes live in object
  // storage, so the render path is shared rather than special-cased.
  const bytes = report.storage.opfs
    ? createOpfsByteStore(await openOpfsDirectory(deps.bytesSubdirectory))
    : createUnavailableByteStore()

  return {
    report,
    port: {
      shell: report.shell,
      bytes,
      blobs: createIndexedDbBlobStore(deps.db, deps.now),
      media: createBrowserMediaCodecs(report),
      picker: createBrowserFilePicker(report.input.directoryDrop),
      quota: createBrowserQuotaMonitor(),
      secrets: createBrowserSecretStore('proxy'),
    },
  }
}

export { browserProbeEnvironment } from './environment'
export { createOpfsByteStore, openOpfsDirectory } from './bytes'
export type { DirectoryHandleLike, FileHandleLike, WritableStreamLike } from './bytes'
