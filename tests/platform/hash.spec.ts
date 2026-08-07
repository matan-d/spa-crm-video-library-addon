import { describe, expect, it } from 'vitest'
import { canonicalJson, hashOf, sha256Hex } from '@/platform/hash'

describe('canonicalJson', () => {
  it('is insensitive to object key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('sorts keys at every depth', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}')
  })

  it('preserves array order, because array order is meaningful here', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']))
  })

  it('omits undefined properties so adding one cannot change a hash', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('turns undefined array elements into null, matching JSON semantics', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]')
  })

  it('normalises negative zero so it cannot collide silently', () => {
    expect(canonicalJson({ v: -0 })).toBe('{"v":0}')
    expect(canonicalJson({ v: -0 })).toBe(canonicalJson({ v: 0 }))
  })

  it('throws on non finite numbers rather than emitting null', () => {
    expect(() => canonicalJson({ v: Number.NaN })).toThrow(/no stable JSON form/)
    expect(() => canonicalJson({ v: Number.POSITIVE_INFINITY })).toThrow(/no stable JSON form/)
  })

  it('names the offending property in the error', () => {
    expect(() => canonicalJson({ outer: { inner: Number.NaN } })).toThrow(/"outer.inner"/)
  })

  it('rejects a Date, and says why', () => {
    // Accepting one would make a hash depend on ambient time formatting, which is
    // exactly what the injected Clock exists to prevent.
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/injected Clock/)
  })

  it('rejects Map and Set, which have no canonical order', () => {
    expect(() => canonicalJson({ m: new Map() })).toThrow(/explicit order/)
    expect(() => canonicalJson({ s: new Set([1]) })).toThrow(/explicit order/)
  })

  it('rejects functions, symbols and bigints', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/not serialisable/)
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow(/not serialisable/)
    expect(() => canonicalJson({ b: 1n })).toThrow(/bigint/)
  })

  it('handles null, empty objects and empty arrays', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson([])).toBe('[]')
  })

  it('escapes strings the same way JSON does', () => {
    expect(canonicalJson({ s: 'a"b\\c\nd' })).toBe('{"s":"a\\"b\\\\c\\nd"}')
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    return expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches the known digest of abc', () => {
    return expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('accepts bytes and a string interchangeably', async () => {
    const fromString = await sha256Hex('abc')
    const fromBytes = await sha256Hex(new TextEncoder().encode('abc'))
    expect(fromBytes).toBe(fromString)
  })

  it('digests a view into a larger buffer correctly', async () => {
    const backing = new Uint8Array([0, 0, 97, 98, 99, 0])
    const view = backing.subarray(2, 5)
    await expect(sha256Hex(view)).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('hashOf', () => {
  it('gives the same hash for logically identical inputs', async () => {
    const a = await hashOf({ prompt: 'tag', taxonomy: ['hands', 'towels'], effort: 'low' })
    const b = await hashOf({ effort: 'low', taxonomy: ['hands', 'towels'], prompt: 'tag' })
    expect(a).toBe(b)
  })

  it('gives a different hash when the input genuinely differs', async () => {
    const a = await hashOf({ taxonomy: ['hands', 'towels'] })
    const b = await hashOf({ taxonomy: ['towels', 'hands'] })
    expect(a).not.toBe(b)
  })
})
