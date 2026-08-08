/**
 * Original media bytes, in the Origin Private File System.
 *
 * OPFS rather than IndexedDB for the large things, for three reasons: no base64
 * inflation, streaming writes so a 400MB clip never sits in memory, and a
 * separate eviction story from the derived blobs, so quota pressure can throw
 * away a regenerable contact sheet without touching an original.
 *
 * Written against the `FileSystemDirectoryHandle` interface rather than against
 * `navigator.storage`, so a test can supply a fake directory and a desktop shell
 * can supply a real one later.
 */

import { Unsupported, type ByteStore } from '../port'

/** The subset of OPFS this store needs, so tests can implement it in memory. */
export interface DirectoryHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>
  keys(): AsyncIterableIterator<string>
}

export interface FileHandleLike {
  getFile(): Promise<File | Blob>
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableStreamLike>
}

export interface WritableStreamLike {
  write(data: Blob | Uint8Array | ArrayBuffer): Promise<void>
  close(): Promise<void>
  abort?(reason?: unknown): Promise<void>
}

/**
 * Resolves the profile's byte directory, or explains why it cannot.
 *
 * Separate profiles get separate subdirectories for the same reason they get
 * separate databases: demo bytes must be unable to reach a live store.
 */
export async function openOpfsDirectory(subdirectory: string): Promise<DirectoryHandleLike> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>
  }
  if (typeof storage?.getDirectory !== 'function') {
    throw new Unsupported('open byte storage', 'no_opfs')
  }
  const root = (await storage.getDirectory()) as unknown as DirectoryHandleLike
  return root.getDirectoryHandle(subdirectory, { create: true })
}

/**
 * A key is one flat filename. Slashes are encoded rather than creating nested
 * directories, because a nested layout makes `list`, `totalBytes` and `clear` all
 * recursive for no benefit at this scale.
 */
function encodeKey(key: string): string {
  if (key.length === 0) throw new Error('ByteStore: an empty key is not addressable')
  return encodeURIComponent(key)
}

function decodeKey(name: string): string {
  return decodeURIComponent(name)
}

export function createOpfsByteStore(directory: DirectoryHandleLike): ByteStore {
  return {
    async put(key, data) {
      const handle = await directory.getFileHandle(encodeKey(key), { create: true })
      const writable = await handle.createWritable()
      try {
        if (data instanceof Blob) {
          await writable.write(data)
        } else {
          // Streamed in chunks so a large original is never fully resident.
          const reader = data.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) await writable.write(value)
          }
        }
        await writable.close()
      } catch (error) {
        // A half-written original must not look like a whole one, so the entry is
        // removed rather than left as a plausible truncation.
        await writable.abort?.(error).catch(() => undefined)
        await directory.removeEntry(encodeKey(key)).catch(() => undefined)
        throw error
      }
    },

    async get(key) {
      try {
        const handle = await directory.getFileHandle(encodeKey(key))
        const file = await handle.getFile()
        return file instanceof Blob ? file : new Blob([file])
      } catch {
        return undefined
      }
    },

    async has(key) {
      try {
        await directory.getFileHandle(encodeKey(key))
        return true
      } catch {
        return false
      }
    },

    async delete(key) {
      await directory.removeEntry(encodeKey(key)).catch(() => undefined)
    },

    async list() {
      const keys: string[] = []
      for await (const name of directory.keys()) keys.push(decodeKey(name))
      return keys
    },

    async totalBytes() {
      let total = 0
      for await (const name of directory.keys()) {
        try {
          const handle = await directory.getFileHandle(name)
          const file = await handle.getFile()
          total += file.size
        } catch {
          // A file that vanished between listing and reading contributes nothing,
          // which is the truth rather than an error worth propagating.
        }
      }
      return total
    },

    async clear() {
      const names: string[] = []
      for await (const name of directory.keys()) names.push(name)
      for (const name of names) await directory.removeEntry(name).catch(() => undefined)
    },
  }
}

/** A ByteStore that refuses every operation, for a runtime without OPFS. */
export function createUnavailableByteStore(): ByteStore {
  const refuse = (operation: string) => () => Promise.reject(new Unsupported(operation, 'no_opfs'))
  return {
    put: refuse('store bytes'),
    get: refuse('read bytes'),
    has: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
    totalBytes: () => Promise.resolve(0),
    list: () => Promise.resolve([]),
    clear: () => Promise.resolve(),
  }
}
