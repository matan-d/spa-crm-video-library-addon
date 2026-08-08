/**
 * A4: the perceptual hash, and the two judgements built on it.
 *
 * The job is narrow: decide whether two clips are the same shot when their bytes
 * differ. `duplicate_of_vertical_ok.mp4` is `vertical_ok.mp4` re-encoded at a
 * different quantiser, so its sha256 differs and its pixels do not. A byte hash
 * cannot see that and a perceptual hash must.
 *
 * dHash rather than an average hash or a DCT hash, for three reasons that all
 * matter here. It compares each pixel with its right neighbour, so it keys on
 * horizontal structure rather than on absolute brightness, which makes it robust
 * to the exposure and quantiser differences a re-encode introduces. It needs no
 * DCT, so it is a few hundred arithmetic operations per frame on a phone. And its
 * distances are interpretable: the manifest's `tolerance.dhash_hamming` of 4 out
 * of 64 bits is a number a human can reason about, which an eigenvalue based
 * distance is not.
 *
 * Everything here is a pure function over pixels. No canvas, no decoder, no
 * platform. That is what lets the duplicate rule be unit tested rather than only
 * observed in a browser.
 */

export const PHASH_VERSION = 1

/** Grid the hash is computed on. 9 columns produce 8 horizontal comparisons per row. */
const HASH_COLUMNS = 9
const HASH_ROWS = 8
export const PHASH_BITS = (HASH_COLUMNS - 1) * HASH_ROWS

export interface RgbaImage {
  width: number
  height: number
  /** Row major RGBA, four bytes per pixel. */
  data: Uint8ClampedArray | Uint8Array
}

/**
 * Rec. 601 luma. The coefficients matter less than using the same ones
 * everywhere: a hash computed with two different weightings is two different
 * hashes, and the duplicate rule would silently stop matching.
 */
function lumaAt(image: RgbaImage, x: number, y: number): number {
  const index = (y * image.width + x) * 4
  const r = image.data[index] ?? 0
  const g = image.data[index + 1] ?? 0
  const b = image.data[index + 2] ?? 0
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Box averages the image down to `columns` by `rows` luma cells.
 *
 * Area averaging rather than nearest neighbour sampling, because nearest
 * neighbour on a 480px frame lands on individual pixels and makes the hash
 * sensitive to a one pixel shift, which is exactly the instability the tolerance
 * would then have to absorb.
 */
export function lumaGrid(image: RgbaImage, columns = HASH_COLUMNS, rows = HASH_ROWS): Float64Array {
  const grid = new Float64Array(columns * rows)
  if (image.width <= 0 || image.height <= 0) return grid

  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row * image.height) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * image.height) / rows))
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.floor((column * image.width) / columns)
      const x1 = Math.max(x0 + 1, Math.floor(((column + 1) * image.width) / columns))
      let total = 0
      let count = 0
      for (let y = y0; y < y1 && y < image.height; y += 1) {
        for (let x = x0; x < x1 && x < image.width; x += 1) {
          total += lumaAt(image, x, y)
          count += 1
        }
      }
      grid[row * columns + column] = count > 0 ? total / count : 0
    }
  }
  return grid
}

/**
 * The 64 bit difference hash, as 16 lowercase hex characters.
 *
 * Bit order is row major, most significant bit first, so the string is stable
 * across engines and comparable as text. Ties (two adjacent cells with identical
 * luma) resolve to 0, which keeps a flat frame's hash all zeroes rather than
 * dependent on floating point noise.
 */
export function dHash(image: RgbaImage): string {
  const grid = lumaGrid(image)
  const bits: number[] = []
  for (let row = 0; row < HASH_ROWS; row += 1) {
    for (let column = 0; column < HASH_COLUMNS - 1; column += 1) {
      const left = grid[row * HASH_COLUMNS + column] ?? 0
      const right = grid[row * HASH_COLUMNS + column + 1] ?? 0
      bits.push(left > right ? 1 : 0)
    }
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = ((bits[i] ?? 0) << 3) | ((bits[i + 1] ?? 0) << 2) | ((bits[i + 2] ?? 0) << 1) | (bits[i + 3] ?? 0)
    hex += nibble.toString(16)
  }
  return hex
}

const POPCOUNT = new Uint8Array(16)
for (let i = 0; i < 16; i += 1) {
  POPCOUNT[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1)
}

/**
 * Hamming distance between two hex hashes, or null when they are not comparable.
 *
 * Null rather than a large number for a length mismatch, because a mismatch means
 * one of them was produced by a different hasher version, and reporting that as
 * "very different" would silently turn a version skew into a stream of false
 * negatives on the duplicate rule.
 */
export function hammingHex(a: string, b: string): number | null {
  if (a.length !== b.length || a.length === 0) return null
  let distance = 0
  for (let i = 0; i < a.length; i += 1) {
    const left = Number.parseInt(a[i] ?? '', 16)
    const right = Number.parseInt(b[i] ?? '', 16)
    if (Number.isNaN(left) || Number.isNaN(right)) return null
    distance += POPCOUNT[(left ^ right) & 0xf] ?? 0
  }
  return distance
}

export interface FrameSetComparison {
  /** Median of the per position distances. The headline number. */
  median: number
  worst: number
  best: number
  /** How many frame positions were compared. Fewer than 3 is thin evidence. */
  compared: number
}

/**
 * Compares two clips frame position by frame position.
 *
 * Position by position rather than best match, because both sheets are planned by
 * the same formula at proportional times, so frame 3 of one clip and frame 3 of
 * the same clip re-encoded are the same moment. Best-match across positions would
 * declare a duplicate for any two clips that happen to share one similar frame,
 * which on a set of static colour bar fixtures is nearly all of them.
 *
 * The median rather than the mean, because one badly timed frame near a cut
 * should not decide the answer either way.
 */
export function compareFrameSets(a: string[], b: string[]): FrameSetComparison | null {
  const count = Math.min(a.length, b.length)
  if (count === 0) return null

  const distances: number[] = []
  for (let i = 0; i < count; i += 1) {
    const distance = hammingHex(a[i] ?? '', b[i] ?? '')
    if (distance === null) return null
    distances.push(distance)
  }
  const sorted = [...distances].sort((x, y) => x - y)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2

  return {
    median,
    worst: sorted[sorted.length - 1] ?? 0,
    best: sorted[0] ?? 0,
    compared: count,
  }
}

export interface HashedAsset {
  asset_id: string
  frame_hashes: string[]
}

export interface DuplicateMatch {
  asset_id: string
  comparison: FrameSetComparison
}

/**
 * The earliest asset in the comparison set that this one duplicates, or null.
 *
 * Earliest rather than closest, because the duplicate rule's job is to point at
 * the delivery the creator already made, and pointing at the second copy of three
 * would read as arbitrary. Ties therefore resolve by set order, which is why the
 * caller must pass the set in a defined order and why the verdict records which
 * set it was computed over.
 */
export function findDuplicate(
  frameHashes: string[],
  priors: readonly HashedAsset[],
  hammingThreshold: number,
): DuplicateMatch | null {
  if (frameHashes.length === 0) return null
  for (const prior of priors) {
    const comparison = compareFrameSets(frameHashes, prior.frame_hashes)
    if (!comparison) continue
    if (comparison.median <= hammingThreshold) return { asset_id: prior.asset_id, comparison }
  }
  return null
}

/**
 * Whether a decoded frame is blank, which is the one case where a real draw is
 * worse than no draw at all.
 *
 * A fully black or fully transparent tile looks like a frame, becomes a contact
 * sheet, and gets described by a model. So a frame with no alpha anywhere, or no
 * luma variance anywhere, is a failed draw and is reported as one.
 *
 * The variance floor is deliberately tiny. A genuinely near black night shot is
 * legitimate footage and must not be discarded, so this catches "the decoder gave
 * us nothing" rather than "this shot is dark".
 */
export function isBlankFrame(image: RgbaImage): boolean {
  if (image.width <= 0 || image.height <= 0) return true

  let anyAlpha = false
  let sum = 0
  let sumSquares = 0
  let samples = 0

  const stepX = Math.max(1, Math.floor(image.width / 32))
  const stepY = Math.max(1, Math.floor(image.height / 32))

  for (let y = 0; y < image.height; y += stepY) {
    for (let x = 0; x < image.width; x += stepX) {
      const index = (y * image.width + x) * 4
      if ((image.data[index + 3] ?? 0) > 0) anyAlpha = true
      const luma = lumaAt(image, x, y)
      sum += luma
      sumSquares += luma * luma
      samples += 1
    }
  }

  if (!anyAlpha) return true
  if (samples === 0) return true
  const mean = sum / samples
  const variance = sumSquares / samples - mean * mean
  return variance < 0.5
}
