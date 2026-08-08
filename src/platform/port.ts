/**
 * The platform seam.
 *
 * Everything that differs between a browser tab, a desktop shell and a native
 * webview lives behind this port. The rest of the application takes a
 * `PlatformPort` and never touches a platform global, which is what makes the
 * Electron and native implementations additive later rather than a rewrite.
 *
 * Only the browser implementation is exercised in this build. The others are
 * designed and unbuilt, per docs/06-decisions.md U4 and U6.
 *
 * One line in this file is where the product's known open hole lives:
 * `MediaCodecs.transcode()` throws `Unsupported` in the browser. That is the
 * design, not an oversight. iPhone HEVC copied to a Windows laptop cannot be
 * decoded by anything we ship, so the honest behaviour is a named refusal that
 * the UI can explain, rather than a silent black frame or an invented tag.
 */

/** Which shell the code is running inside. Reported by the probe, never guessed from a user agent. */
export type ShellId = 'browser' | 'electron' | 'capacitor-ios' | 'capacitor-android'

export type CodecKey = 'h264' | 'hevc' | 'vp9' | 'av1'

/** How a capability answered. `unknown` means the probe could not determine it, which is not the same as no. */
export type Support = 'yes' | 'no' | 'unknown'

/**
 * Thrown when a platform genuinely cannot do something, as opposed to failing at
 * it. Callers branch on `reason` to explain the situation to a human, so the
 * reason codes are part of the contract rather than debug text.
 */
export class Unsupported extends Error {
  constructor(
    readonly operation: string,
    readonly reason: UnsupportedReason,
    detail?: string,
  ) {
    super(`${operation} is not supported here: ${reason}${detail ? ` (${detail})` : ''}`)
    this.name = 'Unsupported'
  }
}

export type UnsupportedReason =
  | 'no_transcoder_in_browser'
  | 'no_decoder_for_codec'
  | 'no_opfs'
  | 'no_file_system_access'
  | 'no_worker'
  | 'quota_unavailable'
  | 'secret_storage_unavailable'

// ---------------------------------------------------------------------------
// bytes: original media, the large things
// ---------------------------------------------------------------------------

/**
 * Original video bytes. OPFS in a browser, the real filesystem in a desktop
 * shell. Streaming rather than whole-buffer, because a 400MB clip must never be
 * held in memory to be written or read.
 */
export interface ByteStore {
  /** Writes bytes and returns the storage key. Overwrites an existing key. */
  put(key: string, data: Blob | ReadableStream<Uint8Array>): Promise<void>
  /** Reads bytes back as a Blob, suitable for an object URL or a File. */
  get(key: string): Promise<Blob | undefined>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  /** Total bytes held, for the storage panel. */
  totalBytes(): Promise<number>
  list(): Promise<string[]>
  /** Removes everything under this profile. Used by "reset demo data". */
  clear(): Promise<void>
}

// ---------------------------------------------------------------------------
// blobs: derived media, the small things
// ---------------------------------------------------------------------------

/**
 * Contact sheets and posters. Separate from `ByteStore` because these are
 * cache-like: they are regenerable from bytes, they are small, and they are
 * evicted first under quota pressure. Conflating the two would risk evicting an
 * original to keep a thumbnail.
 */
export interface BlobStore {
  put(key: string, blob: Blob): Promise<void>
  get(key: string): Promise<Blob | undefined>
  delete(key: string): Promise<void>
  /** Oldest first, for the eviction ladder. */
  keysByAge(): Promise<string[]>
  totalBytes(): Promise<number>
  clear(): Promise<void>
}

// ---------------------------------------------------------------------------
// media: what this runtime can decode, and what it cannot
// ---------------------------------------------------------------------------

export interface CodecSupport {
  decode: Support
  /** True when the platform reports the decode path as hardware accelerated. */
  powerEfficient: boolean
}

export interface MediaCodecs {
  /** Per codec decode support, answered by probe rather than assumed. */
  support(codec: CodecKey): CodecSupport
  /**
   * Turns a source file into something this runtime can decode.
   *
   * Throws `Unsupported('transcode', 'no_transcoder_in_browser')` in the
   * browser. This is the single place the open HEVC hole lives, and it is
   * deliberately a named throw so every caller has to decide what the user sees.
   */
  transcode(input: Blob, target: { container: 'mp4'; codec: 'h264' }): Promise<Blob>
}

// ---------------------------------------------------------------------------
// picker: getting files in
// ---------------------------------------------------------------------------

export interface PickedFile {
  file: File
  /** Path relative to a dropped folder, when the platform provides one. */
  relativePath: string | null
}

export interface FilePicker {
  /** True when the platform can enumerate a dropped directory. */
  supportsFolders(): boolean
  /**
   * Normalises a drop into a flat file list.
   *
   * A camera card folder arrives with sidecars, proxies, RAW stills and system
   * files, so this filters to plausible media and reports what it dropped, rather
   * than producing hundreds of pre-flight failures on files that were never clips.
   */
  fromDrop(dataTransfer: DataTransfer): Promise<{ files: PickedFile[]; ignored: string[] }>
}

// ---------------------------------------------------------------------------
// quota: how much room there is, and whether it will survive
// ---------------------------------------------------------------------------

export interface QuotaReport {
  usageBytes: number | null
  quotaBytes: number | null
  /** Fraction used, or null when the platform will not say. */
  fraction: number | null
  /** True when storage is exempt from routine eviction. */
  persisted: boolean
  /** The platform declined to report, which is different from reporting zero. */
  available: boolean
}

export interface QuotaMonitor {
  report(): Promise<QuotaReport>
  /** Requests exemption from eviction. Resolves to whether it was granted. */
  requestPersistence(): Promise<boolean>
}

// ---------------------------------------------------------------------------
// secrets: where a model key could live, if there were one
// ---------------------------------------------------------------------------

/**
 * How this runtime would reach a model, if a key existed. No key exists in this
 * build and none is committed, so this exists to keep the shape honest rather
 * than to hold anything.
 *
 * `proxy` means calls go through a serverless function so the key is never in the
 * bundle. `ipc` is a desktop main process. `native` is a platform keychain.
 */
export type SecretMode = 'proxy' | 'ipc' | 'native' | 'none'

export interface SecretStore {
  mode(): SecretMode
  /**
   * A session-only, caller-supplied credential, if the app offers one.
   *
   * Never written to localStorage by default, never logged, and never included in
   * a diagnostics blob.
   */
  setSessionCredential(value: string | null): void
  hasSessionCredential(): boolean
}

// ---------------------------------------------------------------------------
// the port
// ---------------------------------------------------------------------------

export interface PlatformPort {
  readonly shell: ShellId
  readonly bytes: ByteStore
  readonly blobs: BlobStore
  readonly media: MediaCodecs
  readonly picker: FilePicker
  readonly quota: QuotaMonitor
  readonly secrets: SecretStore
}
