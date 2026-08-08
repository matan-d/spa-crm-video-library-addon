/**
 * The remaining browser platform pieces: derived blobs, codecs, file picking,
 * quota, and where a secret would live.
 */

import {
  Unsupported,
  type BlobStore,
  type CodecKey,
  type FilePicker,
  type MediaCodecs,
  type PickedFile,
  type QuotaMonitor,
  type QuotaReport,
  type SecretMode,
  type SecretStore,
} from '../port'
import type { CapabilityReport } from '../capability'

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

export interface BlobRow {
  key: string
  kind: string
  blob: Blob
  bytes: number
  created_at: number
}

/**
 * Derived blobs in IndexedDB, keyed by an opaque string.
 *
 * Takes the database handle as a parameter rather than importing the data layer,
 * so the platform module stays free of application dependencies.
 */
export function createIndexedDbBlobStore(
  db: IDBDatabase,
  now: () => number,
  storeName = 'blob',
): BlobStore {
  const request = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('blob store request failed'))
    })

  return {
    async put(key, blob) {
      const kind = key.includes('/') ? (key.split('/')[0] ?? 'unknown') : 'unknown'
      const row: BlobRow = { key, kind, blob, bytes: blob.size, created_at: now() }
      const tx = db.transaction([storeName], 'readwrite')
      tx.objectStore(storeName).put(row)
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('blob write aborted'))
      })
    },

    async get(key) {
      const row = await request<BlobRow | undefined>(
        db.transaction([storeName], 'readonly').objectStore(storeName).get(key),
      )
      return row?.blob
    },

    async delete(key) {
      const tx = db.transaction([storeName], 'readwrite')
      tx.objectStore(storeName).delete(key)
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => resolve()
      })
    },

    async keysByAge() {
      // Oldest first, which is the order the eviction ladder walks.
      const index = db.transaction([storeName], 'readonly').objectStore(storeName).index('by_created')
      const keys: string[] = []
      await new Promise<void>((resolve, reject) => {
        const cursorRequest = index.openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor) {
            resolve()
            return
          }
          keys.push((cursor.value as BlobRow).key)
          cursor.continue()
        }
        cursorRequest.onerror = () => reject(cursorRequest.error)
      })
      return keys
    },

    async totalBytes() {
      const store = db.transaction([storeName], 'readonly').objectStore(storeName)
      let total = 0
      await new Promise<void>((resolve, reject) => {
        const cursorRequest = store.openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor) {
            resolve()
            return
          }
          total += (cursor.value as BlobRow).bytes ?? 0
          cursor.continue()
        }
        cursorRequest.onerror = () => reject(cursorRequest.error)
      })
      return total
    },

    async clear() {
      const tx = db.transaction([storeName], 'readwrite')
      tx.objectStore(storeName).clear()
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => resolve()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// codecs
// ---------------------------------------------------------------------------

/**
 * What this browser can decode, and the one thing it cannot do at all.
 *
 * `transcode` throws. That is the design, and it is the single line where this
 * build's known open hole lives: iPhone HEVC copied to a Windows laptop cannot be
 * decoded by anything we ship, so the honest behaviour is a named refusal the UI
 * can explain rather than a black frame or an invented tag. Local desktop
 * transcode and server side transcode are both specified in the reviews; neither
 * is deployed.
 */
export function createBrowserMediaCodecs(report: CapabilityReport): MediaCodecs {
  return {
    support(codec: CodecKey) {
      return report.codecs[codec] ?? { decode: 'unknown', powerEfficient: false }
    },
    transcode() {
      return Promise.reject(
        new Unsupported(
          'transcode',
          'no_transcoder_in_browser',
          'A desktop shell with a bundled encoder, or a server side worker, is required. Both are specified and neither is deployed in this build.',
        ),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// picker
// ---------------------------------------------------------------------------

const MEDIA_EXTENSIONS = new Set([
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mts', 'm2ts',
  'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp',
  'wav', 'mp3', 'm4a', 'aac',
])

/**
 * Files a camera card contains that are not deliverables.
 *
 * Dragging a card folder is the natural desktop gesture, and it arrives with
 * sidecars, proxies, RAW stills and system files. Filtering these is not
 * fastidiousness: without it a creator sees hundreds of pre-flight failures on
 * files that were never clips, and proxy-original pairs double count takes in the
 * brief diff.
 */
const IGNORED_EXACT = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const IGNORED_EXTENSIONS = new Set([
  'xmp', 'thm', 'lrv', 'cpi', 'bdm', 'bin', 'ini', 'sqlite', 'db',
  'aae', 'plist', 'log', 'txt', 'pdf', 'zip',
])

function classify(name: string, relativePath: string | null): 'media' | 'ignored' {
  const base = name.split('/').pop() ?? name
  if (base.startsWith('.')) return 'ignored'
  if (IGNORED_EXACT.has(base)) return 'ignored'

  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (IGNORED_EXTENSIONS.has(extension)) return 'ignored'
  if (!MEDIA_EXTENSIONS.has(extension)) return 'ignored'

  // A proxy sitting beside its original would otherwise count as a second take.
  const path = (relativePath ?? base).toLowerCase()
  if (path.includes('/proxy/') || path.includes('/proxies/') || base.toLowerCase().includes('_proxy')) {
    return 'ignored'
  }

  return 'media'
}

export function createBrowserFilePicker(canReadDirectories: boolean): FilePicker {
  return {
    supportsFolders() {
      return canReadDirectories
    },

    async fromDrop(dataTransfer) {
      const files: PickedFile[] = []
      const ignored: string[] = []

      const entries = canReadDirectories ? collectEntries(dataTransfer) : []

      if (entries.length > 0) {
        for (const entry of entries) {
          await walkEntry(entry, '', files, ignored)
        }
        return { files, ignored }
      }

      // No directory support, so the flat file list is all there is.
      for (const file of Array.from(dataTransfer.files ?? [])) {
        if (classify(file.name, null) === 'media') files.push({ file, relativePath: null })
        else ignored.push(file.name)
      }
      return { files, ignored }
    },
  }
}

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (file: File) => void, err?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (cb: (entries: EntryLike[]) => void, err?: (e: unknown) => void) => void }
}

function collectEntries(dataTransfer: DataTransfer): EntryLike[] {
  const items = Array.from(dataTransfer.items ?? [])
  const entries: EntryLike[] = []
  for (const item of items) {
    const asEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry
    const entry = typeof asEntry === 'function' ? asEntry.call(item) : null
    if (entry) entries.push(entry)
  }
  return entries
}

async function walkEntry(
  entry: EntryLike,
  prefix: string,
  files: PickedFile[],
  ignored: string[],
): Promise<void> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => {
      entry.file?.(
        (f) => resolve(f),
        () => resolve(null),
      )
    })
    if (!file) {
      ignored.push(relativePath)
      return
    }
    if (classify(file.name, relativePath) === 'media') files.push({ file, relativePath })
    else ignored.push(relativePath)
    return
  }

  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    // readEntries returns at most 100 entries per call, so it must be drained in a
    // loop. Reading once is a bug that silently truncates a large camera card.
    for (;;) {
      const batch = await new Promise<EntryLike[]>((resolve) => {
        reader.readEntries(
          (result) => resolve(result),
          () => resolve([]),
        )
      })
      if (batch.length === 0) break
      for (const child of batch) await walkEntry(child, relativePath, files, ignored)
    }
  }
}

// ---------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------

export function createBrowserQuotaMonitor(): QuotaMonitor {
  return {
    async report(): Promise<QuotaReport> {
      const storage = navigator.storage as StorageManager | undefined
      if (!storage || typeof storage.estimate !== 'function') {
        return { usageBytes: null, quotaBytes: null, fraction: null, persisted: false, available: false }
      }
      try {
        const estimate = await storage.estimate()
        const usage = estimate.usage ?? null
        const quota = estimate.quota ?? null
        const persisted =
          typeof storage.persisted === 'function' ? await storage.persisted().catch(() => false) : false
        return {
          usageBytes: usage,
          quotaBytes: quota,
          fraction: usage !== null && quota !== null && quota > 0 ? usage / quota : null,
          persisted,
          available: true,
        }
      } catch {
        return { usageBytes: null, quotaBytes: null, fraction: null, persisted: false, available: false }
      }
    },

    async requestPersistence() {
      const storage = navigator.storage as StorageManager | undefined
      if (!storage || typeof storage.persist !== 'function') return false
      return storage.persist().catch(() => false)
    },
  }
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

/**
 * Where a model key would live, if one existed.
 *
 * None does in this build, and none is committed. The browser mode is `proxy`,
 * meaning any call would go through a serverless function so the key is never in
 * the bundle. A caller-supplied credential is held in memory for the session
 * only: never written to storage, never logged, and never placed in a diagnostics
 * blob, because Safari would silently discard it after seven days anyway and a
 * key in localStorage is a key in a backup.
 */
export function createBrowserSecretStore(mode: SecretMode = 'proxy'): SecretStore {
  let sessionCredential: string | null = null
  return {
    mode: () => mode,
    setSessionCredential: (value) => {
      sessionCredential = value && value.length > 0 ? value : null
    },
    hasSessionCredential: () => sessionCredential !== null,
  }
}
