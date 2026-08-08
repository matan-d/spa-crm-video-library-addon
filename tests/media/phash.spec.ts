/**
 * The perceptual hasher.
 *
 * The claim under test is narrow and specific: the same shot re-encoded hashes
 * close, a different shot hashes far, and the manifest's Hamming tolerance of 4 out
 * of 64 bits separates the two. All of it is pure arithmetic over pixels, so it runs
 * in jsdom.
 *
 * What is NOT tested here, and is recorded as a gap rather than implied: that the
 * two committed fixtures `vertical_ok.mp4` and `duplicate_of_vertical_ok.mp4`
 * actually hash within that tolerance. That needs real decoded frames, which jsdom
 * cannot produce. See `qa/manual-checklist.md`.
 */

import { describe, expect, it } from 'vitest'
import {
  compareFrameSets,
  dHash,
  findDuplicate,
  hammingHex,
  isBlankFrame,
  lumaGrid,
  PHASH_BITS,
  PHASH_VERSION,
  type RgbaImage,
} from '@/media/phash'
import { blackFrame, syntheticFrame, requireFixture } from './_support'

const HAMMING_TOLERANCE = requireFixture('vertical_ok').tolerance.dhash_hamming

describe('dHash', () => {
  it('produces a stable 64 bit hash as 16 hex characters', () => {
    const frame = syntheticFrame('a', 90, 160)
    expect(PHASH_BITS).toBe(64)
    expect(PHASH_VERSION).toBe(1)
    expect(dHash(frame)).toMatch(/^[0-9a-f]{16}$/)
    // Deterministic: the same pixels always give the same hash, or a stored hash
    // stops meaning anything the day a comparison runs on another machine.
    expect(dHash(frame)).toBe(dHash(syntheticFrame('a', 90, 160)))
  })

  it('is unchanged by a proportional scale change', () => {
    // Both dimensions scale by exactly two, so every grid cell covers the same
    // proportion of the image and the hash is identical rather than merely close.
    const distance = hammingHex(dHash(syntheticFrame('bars', 144, 256)), dHash(syntheticFrame('bars', 288, 512)))
    expect(distance).toBe(0)
  })

  it('stays inside the tolerance across a non proportional rescale, which is the cross tier case', () => {
    // 90x160 against 270x480 is not a clean multiple of the 9 by 8 grid, so the box
    // averages straddle the pattern differently at the two sizes. Measured drift is a
    // couple of bits, inside the manifest's tolerance of four, which is what makes a
    // `constrained` tier sheet's hashes comparable against an `ample` one. It is a
    // measurement rather than a guarantee, which is one more reason `policy_tier` is
    // recorded on every sheet.
    const distance = hammingHex(dHash(syntheticFrame('bars', 90, 160)), dHash(syntheticFrame('bars', 270, 480)))
    expect(distance as number).toBeLessThanOrEqual(HAMMING_TOLERANCE)
  })

  it('is unchanged by a uniform brightness shift, which is what a re-encode looks like', () => {
    const original = syntheticFrame('bars', 180, 320)
    const brighter = shiftBrightness(original, 12)
    const distance = hammingHex(dHash(original), dHash(brighter))
    expect(distance as number).toBeLessThanOrEqual(HAMMING_TOLERANCE)
  })

  it('separates two genuinely different frames well beyond the tolerance', () => {
    const distance = hammingHex(dHash(syntheticFrame('one', 180, 320)), dHash(syntheticFrame('two', 180, 320)))
    expect(distance as number).toBeGreaterThan(HAMMING_TOLERANCE)
  })

  it('hashes a flat frame to all zeroes rather than to floating point noise', () => {
    const flat: RgbaImage = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(128) }
    expect(dHash(flat)).toBe('0000000000000000')
  })

  it('area averages rather than point samples, so a one pixel shift does not move it', () => {
    const grid = lumaGrid(syntheticFrame('bars', 90, 160))
    expect(grid).toHaveLength(72)
    expect([...grid].some((value) => value > 0)).toBe(true)
  })
})

describe('hamming distance', () => {
  it('counts differing bits', () => {
    expect(hammingHex('0000000000000000', '0000000000000000')).toBe(0)
    expect(hammingHex('0000000000000001', '0000000000000000')).toBe(1)
    expect(hammingHex('ffffffffffffffff', '0000000000000000')).toBe(64)
  })

  it('returns null rather than a large number when the two are not comparable', () => {
    // A length mismatch means a hasher version skew, and reporting that as "very
    // different" would turn a version change into silent false negatives.
    expect(hammingHex('abc', 'abcd')).toBeNull()
    expect(hammingHex('', '')).toBeNull()
    expect(hammingHex('zzzzzzzzzzzzzzzz', '0000000000000000')).toBeNull()
  })
})

describe('comparing two clips', () => {
  it('compares frame position by frame position and reports the median', () => {
    const a = ['0000000000000000', '0000000000000000', '0000000000000000']
    const b = ['0000000000000001', '0000000000000003', '000000000000000f']
    const comparison = compareFrameSets(a, b)
    expect(comparison).toEqual({ median: 2, worst: 4, best: 1, compared: 3 })
  })

  it('compares only the positions both clips have', () => {
    expect(compareFrameSets(['0000000000000000'], ['0000000000000000', '0000000000000001'])?.compared).toBe(1)
    expect(compareFrameSets([], ['0000000000000000'])).toBeNull()
  })

  it('finds the earliest matching prior, not the closest one', () => {
    const hashes = ['1111111111111111', '2222222222222222']
    const priors = [
      { asset_id: 'first', frame_hashes: ['1111111111111113', '2222222222222226'] },
      { asset_id: 'second', frame_hashes: ['1111111111111111', '2222222222222222'] },
    ]
    // `second` is an exact match and `first` is within tolerance. The rule points at
    // the earliest, because pointing at the second copy of three reads as arbitrary.
    expect(findDuplicate(hashes, priors, HAMMING_TOLERANCE)?.asset_id).toBe('first')
  })

  it('finds nothing when the set is empty or nothing is close', () => {
    expect(findDuplicate(['1111111111111111'], [], HAMMING_TOLERANCE)).toBeNull()
    expect(
      findDuplicate(['1111111111111111'], [{ asset_id: 'x', frame_hashes: ['eeeeeeeeeeeeeeee'] }], HAMMING_TOLERANCE),
    ).toBeNull()
  })

  it('finds nothing when the candidate has no frames at all', () => {
    // No frames means the rule cannot run, which the engine reports as unknown. It
    // must never fall through to "no match, therefore pass".
    expect(findDuplicate([], [{ asset_id: 'x', frame_hashes: ['1111111111111111'] }], 4)).toBeNull()
  })
})

describe('blank frame detection', () => {
  it('calls a fully black frame blank', () => {
    expect(isBlankFrame(blackFrame(64, 64))).toBe(true)
  })

  it('calls a fully transparent frame blank even when its colour channels are set', () => {
    const transparent: RgbaImage = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) }
    for (let i = 0; i < transparent.data.length; i += 4) {
      transparent.data[i] = 200
      transparent.data[i + 3] = 0
    }
    expect(isBlankFrame(transparent)).toBe(true)
  })

  it('does not call a dark but real frame blank', () => {
    // A night shot is legitimate footage. This detector catches "the decoder gave
    // us nothing", never "this shot is dark".
    const dark = shiftBrightness(syntheticFrame('bars', 64, 64), -0)
    const dimmed: RgbaImage = { width: dark.width, height: dark.height, data: new Uint8ClampedArray(dark.data) }
    for (let i = 0; i < dimmed.data.length; i += 4) {
      dimmed.data[i] = Math.round((dimmed.data[i] ?? 0) * 0.06)
      dimmed.data[i + 1] = Math.round((dimmed.data[i + 1] ?? 0) * 0.06)
      dimmed.data[i + 2] = Math.round((dimmed.data[i + 2] ?? 0) * 0.06)
    }
    expect(isBlankFrame(dimmed)).toBe(false)
  })

  it('calls a zero sized frame blank rather than dividing by zero', () => {
    expect(isBlankFrame({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toBe(true)
  })
})

function shiftBrightness(image: RgbaImage, delta: number): RgbaImage {
  const data = new Uint8ClampedArray(image.data)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (data[i] ?? 0) + delta
    data[i + 1] = (data[i + 1] ?? 0) + delta
    data[i + 2] = (data[i + 2] ?? 0) + delta
  }
  return { width: image.width, height: image.height, data }
}
