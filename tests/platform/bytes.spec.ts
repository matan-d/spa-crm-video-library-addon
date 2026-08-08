import { describe, expect, it } from 'vitest'
import { createOpfsByteStore, createUnavailableByteStore } from '@/platform/browser/bytes'
import type { DirectoryHandleLike, FileHandleLike, WritableStreamLike } from '@/platform/browser/bytes'
import { Unsupported } from '@/platform/port'

/**
 * jsdom's Blob does not implement `text()`, which a real browser does. Reading
 * through a helper keeps the assertions honest without pretending the environment
 * is a browser. Recorded rather than worked around silently, because it is a
 * standing limitation of testing blob paths outside a real engine.
 */
async function readText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  if (typeof blob.arrayBuffer === 'function') return new TextDecoder().decode(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

/**
 * An in-memory OPFS. jsdom has no OPFS at all, so without this the byte store
 * would be untested until someone opened a real browser, which is exactly the
 * kind of gap the QA plan refuses to leave implied.
 *
 * It models the two behaviours that actually bite: `getFileHandle` rejects for a
 * missing entry rather than returning null, and a writable that is aborted leaves
 * nothing behind.
 */
function fakeDirectory(): DirectoryHandleLike & { readonly files: Map<string, Blob> } {
  const files = new Map<string, Blob>()

  const directory: DirectoryHandleLike & { readonly files: Map<string, Blob> } = {
    files,

    async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
      if (!files.has(name) && !options?.create) {
        throw new DOMException(`A requested file could not be found: ${name}`, 'NotFoundError')
      }
      if (options?.create && !files.has(name)) files.set(name, new Blob([]))

      return {
        async getFile() {
          const blob = files.get(name)
          if (!blob) throw new DOMException('gone', 'NotFoundError')
          return blob
        },
        async createWritable(): Promise<WritableStreamLike> {
          const chunks: BlobPart[] = []
          let aborted = false
          return {
            async write(data) {
              if (data instanceof Blob) chunks.push(data)
              else chunks.push(data as ArrayBuffer)
            },
            async close() {
              if (!aborted) files.set(name, new Blob(chunks))
            },
            async abort() {
              aborted = true
            },
          }
        },
      }
    },

    async removeEntry(name: string) {
      files.delete(name)
    },

    async getDirectoryHandle() {
      return directory
    },

    async *keys() {
      for (const name of [...files.keys()]) yield name
    },
  }

  return directory
}

describe('OPFS byte store', () => {
  it('round trips a blob', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    await store.put('assets/a1.mp4', new Blob(['hello']))
    const out = await store.get('assets/a1.mp4')
    expect(out).toBeDefined()
    await expect(readText(out!)).resolves.toBe('hello')
  })

  it('writes a stream in chunks, so a large original is never fully resident', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('part-one:'))
        controller.enqueue(new TextEncoder().encode('part-two'))
        controller.close()
      },
    })
    await store.put('assets/streamed.mp4', stream)
    await expect(readText((await store.get('assets/streamed.mp4'))!)).resolves.toBe('part-one:part-two')
  })

  it('reports has() honestly for present and absent keys', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    await store.put('k', new Blob(['x']))
    await expect(store.has('k')).resolves.toBe(true)
    await expect(store.has('nope')).resolves.toBe(false)
  })

  it('returns undefined rather than throwing for a missing key', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    await expect(store.get('missing')).resolves.toBeUndefined()
  })

  it('deleting a key that was never there is not an error', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    await expect(store.delete('never')).resolves.toBeUndefined()
  })

  it('survives a key containing slashes and spaces', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    const key = 'deliveries/2026-08/IMG 4021.MOV'
    await store.put(key, new Blob(['v']))
    await expect(store.has(key)).resolves.toBe(true)
    await expect(store.list()).resolves.toEqual([key])
  })

  it('refuses an empty key rather than writing an unaddressable file', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    await expect(store.put('', new Blob(['x']))).rejects.toThrow(/not addressable/)
  })

  it('sums total bytes across entries', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    await store.put('a', new Blob(['12345']))
    await store.put('b', new Blob(['123']))
    await expect(store.totalBytes()).resolves.toBe(8)
  })

  it('clears everything', async () => {
    const directory = fakeDirectory()
    const store = createOpfsByteStore(directory)
    await store.put('a', new Blob(['1']))
    await store.put('b', new Blob(['2']))
    await store.clear()
    await expect(store.list()).resolves.toEqual([])
    expect(directory.files.size).toBe(0)
  })

  it('leaves nothing behind when a write fails partway', async () => {
    // A half-written original must not look like a whole one, because the next
    // reader cannot tell the difference and would treat a truncation as the clip.
    const directory = fakeDirectory()
    const store = createOpfsByteStore(directory)
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        controller.error(new Error('connection dropped'))
      },
    })
    await expect(store.put('assets/broken.mp4', failing)).rejects.toThrow(/connection dropped/)
    await expect(store.has('assets/broken.mp4')).resolves.toBe(false)
    expect(directory.files.size).toBe(0)
  })

  it('overwrites an existing key rather than appending to it', async () => {
    const store = createOpfsByteStore(fakeDirectory())
    await store.put('k', new Blob(['first']))
    await store.put('k', new Blob(['second']))
    await expect(readText((await store.get('k'))!)).resolves.toBe('second')
  })
})

describe('unavailable byte store', () => {
  it('refuses writes with a named reason the UI can explain', async () => {
    const store = createUnavailableByteStore()
    await expect(store.put('k', new Blob(['x']))).rejects.toBeInstanceOf(Unsupported)
    await expect(store.put('k', new Blob(['x']))).rejects.toMatchObject({ reason: 'no_opfs' })
  })

  it('reports empty rather than failing, so the app still boots', async () => {
    // A runtime without OPFS gets a working app in which originals simply cannot
    // be kept, which is the bytes_absent state every record reaches anyway.
    const store = createUnavailableByteStore()
    await expect(store.has('k')).resolves.toBe(false)
    await expect(store.list()).resolves.toEqual([])
    await expect(store.totalBytes()).resolves.toBe(0)
    await expect(store.clear()).resolves.toBeUndefined()
    await expect(store.delete('k')).resolves.toBeUndefined()
  })
})
