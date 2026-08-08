/**
 * A read-only, range-addressed view over bytes, and the two ways we get one.
 *
 * Everything in the media pipeline reads through this interface rather than
 * taking an `ArrayBuffer`, for one reason: a 4GB camera file must never be
 * materialised in memory to answer a question about its header. The container
 * parser asks for a few 16 byte windows and one `moov` sized window, and on a
 * `File` those become `File.slice()` calls that the browser serves from disk.
 *
 * `bytesRead` is counted rather than estimated, because "we never read `mdat`" is
 * a claim a test has to be able to check.
 */

export interface ByteSource {
  /** Total bytes available. */
  readonly size: number
  /** Bytes actually pulled so far, across every read. */
  readonly bytesRead: number
  /** Number of read calls, so a pathological hop pattern is visible. */
  readonly readCount: number
  /**
   * Reads `[start, end)`, clamped to the source. A read entirely past the end
   * returns an empty array rather than throwing, because a truncated download is
   * a normal input rather than an error.
   */
  read(start: number, end: number): Promise<Uint8Array>
}

/** Wraps bytes already in memory. Used for synthesised inputs and for tests. */
export function bufferSource(input: ArrayBuffer | Uint8Array): ByteSource {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let bytesRead = 0
  let readCount = 0

  return {
    size: bytes.byteLength,
    get bytesRead() {
      return bytesRead
    },
    get readCount() {
      return readCount
    },
    async read(start, end) {
      const from = clamp(start, 0, bytes.byteLength)
      const to = clamp(end, from, bytes.byteLength)
      readCount += 1
      bytesRead += to - from
      return bytes.subarray(from, to)
    },
  }
}

/**
 * The shape of `Blob` this module actually depends on.
 *
 * Declared narrowly on purpose. jsdom's `Blob` implements `slice()` but not
 * `arrayBuffer()`, `text()` or `stream()`, so depending on the full lib.dom
 * `Blob` would make every parser test require a real browser engine. Narrowing
 * the dependency is also what lets a test hand in a fake slice-able object.
 */
export interface SliceableBlob {
  readonly size: number
  slice(start?: number, end?: number): SliceableBlob
  arrayBuffer?: () => Promise<ArrayBuffer>
}

/**
 * Wraps a `Blob` or a `File`. Reads are `slice()` plus one buffer materialisation
 * of the slice, never of the whole blob.
 *
 * The `FileReader` branch exists because jsdom has no `Blob.arrayBuffer()`. It is
 * also the correct fallback for older engines, so it is a real code path rather
 * than a test affordance.
 */
export function blobSource(blob: SliceableBlob): ByteSource {
  let bytesRead = 0
  let readCount = 0

  return {
    size: blob.size,
    get bytesRead() {
      return bytesRead
    },
    get readCount() {
      return readCount
    },
    async read(start, end) {
      const from = clamp(start, 0, blob.size)
      const to = clamp(end, from, blob.size)
      readCount += 1
      if (to === from) return new Uint8Array(0)
      const slice = blob.slice(from, to)
      const bytes = await materialise(slice)
      bytesRead += bytes.byteLength
      return bytes
    },
  }
}

/** Accepts whatever a caller happens to hold and returns a source. */
export function toByteSource(input: ByteSource | ArrayBuffer | Uint8Array | SliceableBlob): ByteSource {
  if (isByteSource(input)) return input
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) return bufferSource(input)
  return blobSource(input)
}

function isByteSource(value: unknown): value is ByteSource {
  return typeof value === 'object' && value !== null && typeof (value as ByteSource).read === 'function'
}

async function materialise(slice: SliceableBlob): Promise<Uint8Array> {
  if (typeof slice.arrayBuffer === 'function') return new Uint8Array(await slice.arrayBuffer())

  const reader = typeof FileReader === 'function' ? new FileReader() : null
  if (!reader) {
    throw new Error(
      'blobSource: this runtime has neither Blob.arrayBuffer nor FileReader, so blob bytes cannot be read',
    )
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('blobSource: FileReader failed'))
    reader.readAsArrayBuffer(slice as unknown as Blob)
  })
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
