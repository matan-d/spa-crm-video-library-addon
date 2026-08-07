import { describe, expect, it } from 'vitest'
import { SeededClock, SEED_EPOCH_MS, SystemClock } from '@/platform/clock'
import { CryptoRng, SeededRng, SEED_STRING } from '@/platform/rng'
import { counterOf, createIdFactory, timestampOf } from '@/platform/id'

function seededFactory(startMs = SEED_EPOCH_MS, autoAdvanceMs = 0) {
  return createIdFactory(
    new SeededClock({ startMs, autoAdvanceMs }),
    new SeededRng(SEED_STRING),
  )
}

describe('uuidv7', () => {
  it('is byte identical across runs with the same seed', () => {
    const a = Array.from({ length: 50 }, seededFactory())
    const b = Array.from({ length: 50 }, seededFactory())
    expect(a).toEqual(b)
  })

  it('produces different ids for a different seed', () => {
    const withSeedA = createIdFactory(
      new SeededClock({ startMs: SEED_EPOCH_MS }),
      new SeededRng('seed-a'),
    )()
    const withSeedB = createIdFactory(
      new SeededClock({ startMs: SEED_EPOCH_MS }),
      new SeededRng('seed-b'),
    )()
    expect(withSeedA).not.toEqual(withSeedB)
  })

  it('carries version 7 and the RFC 9562 variant bits', () => {
    const id = seededFactory()()
    expect(id[14]).toBe('7')
    // Variant is 0b10xxxxxx, so the first hex digit of the fourth group is 8..b.
    expect('89ab').toContain(id[19])
  })

  it('matches the canonical uuid shape', () => {
    const id = seededFactory()()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('encodes the clock instant in the timestamp field', () => {
    const id = seededFactory(SEED_EPOCH_MS)()
    expect(timestampOf(id)).toBe(SEED_EPOCH_MS)
  })

  it('sorts lexicographically in generation order under a frozen clock', () => {
    // This is the property the whole design hangs on: a seeded clock returns the
    // same millisecond hundreds of times, and ids must still sort by insertion.
    const next = seededFactory()
    const ids = Array.from({ length: 500 }, next)
    expect([...ids].sort()).toEqual(ids)
  })

  it('advances the sub-millisecond counter within one millisecond', () => {
    const next = seededFactory()
    const ids = [next(), next(), next()]
    expect(ids.map(counterOf)).toEqual([0, 1, 2])
    expect(new Set(ids.map(timestampOf)).size).toBe(1)
  })

  it('resets the counter when the millisecond changes', () => {
    const clock = new SeededClock({ startMs: SEED_EPOCH_MS })
    const next = createIdFactory(clock, new SeededRng(SEED_STRING))
    const first = next()
    clock.tick(5)
    const second = next()
    expect(counterOf(first)).toBe(0)
    expect(counterOf(second)).toBe(0)
    expect(timestampOf(second) - timestampOf(first)).toBe(5)
    expect(second > first).toBe(true)
  })

  it('borrows the next millisecond when the counter is exhausted, without breaking order', () => {
    const next = seededFactory()
    // 4,097 ids inside one frozen millisecond forces exactly one borrow.
    const ids = Array.from({ length: 4098 }, next)
    expect([...ids].sort()).toEqual(ids)
    expect(counterOf(ids[4095])).toBe(4095)
    expect(counterOf(ids[4096])).toBe(0)
    expect(timestampOf(ids[4096])).toBe(SEED_EPOCH_MS + 1)
  })

  it('stays monotonic when the clock jumps backwards', () => {
    // A real NTP correction, or a demo profile switching between saved states.
    let current = SEED_EPOCH_MS
    const jumpy = { now: () => current }
    const next = createIdFactory(jumpy, new SeededRng(SEED_STRING))
    const before = next()
    current = SEED_EPOCH_MS - 10_000
    const after = next()
    expect(after > before).toBe(true)
    expect(timestampOf(after)).toBe(SEED_EPOCH_MS)
  })

  it('keeps sortability with a real clock and real randomness', () => {
    const next = createIdFactory(new SystemClock(), new CryptoRng())
    const ids = Array.from({ length: 200 }, next)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(200)
  })

  it('auto advancing the seeded clock keeps ids unique without the counter', () => {
    const next = seededFactory(SEED_EPOCH_MS, 1)
    const ids = Array.from({ length: 100 }, next)
    expect(new Set(ids.map(timestampOf)).size).toBe(100)
    expect(ids.every((id) => counterOf(id) === 0)).toBe(true)
  })
})
