import { describe, expect, it } from 'vitest'
import { SeededClock, SEED_EPOCH_MS, SystemClock } from '@/platform/clock'
import { CryptoRng, SeededRng, SEED_STRING } from '@/platform/rng'

describe('SeededClock', () => {
  it('is frozen by default', () => {
    const clock = new SeededClock({ startMs: SEED_EPOCH_MS })
    expect([clock.now(), clock.now(), clock.now()]).toEqual([
      SEED_EPOCH_MS,
      SEED_EPOCH_MS,
      SEED_EPOCH_MS,
    ])
  })

  it('advances by autoAdvanceMs on every read when asked to', () => {
    const clock = new SeededClock({ startMs: 1000, autoAdvanceMs: 2 })
    expect([clock.now(), clock.now(), clock.now()]).toEqual([1000, 1002, 1004])
  })

  it('moves forward on an explicit tick', () => {
    const clock = new SeededClock({ startMs: 1000 })
    clock.tick(250)
    expect(clock.now()).toBe(1250)
  })

  it('peek does not consume an auto advance step', () => {
    const clock = new SeededClock({ startMs: 1000, autoAdvanceMs: 5 })
    expect(clock.peek()).toBe(1000)
    expect(clock.peek()).toBe(1000)
    expect(clock.now()).toBe(1000)
    expect(clock.peek()).toBe(1005)
  })

  it('refuses to run backwards', () => {
    const clock = new SeededClock({ startMs: 1000 })
    expect(() => clock.tick(-1)).toThrow(/does not go backwards/)
  })
})

describe('SystemClock', () => {
  it('returns a plausible current instant', () => {
    const now = new SystemClock().now()
    // Sanity only: after this project started, and not absurdly far ahead.
    expect(now).toBeGreaterThan(1750000000000)
    expect(Number.isInteger(now)).toBe(true)
  })

  it('is non decreasing across consecutive reads', () => {
    const clock = new SystemClock()
    const first = clock.now()
    const second = clock.now()
    expect(second).toBeGreaterThanOrEqual(first)
  })
})

describe('SeededRng', () => {
  it('reproduces the same sequence for the same seed', () => {
    const a = new SeededRng(SEED_STRING)
    const b = new SeededRng(SEED_STRING)
    const left = Array.from({ length: 20 }, () => a.next())
    const right = Array.from({ length: 20 }, () => b.next())
    expect(left).toEqual(right)
  })

  it('diverges for seeds that differ by one character', () => {
    const a = new SeededRng('astolia-seed-v1')
    const b = new SeededRng('astolia-seed-v2')
    expect(a.next()).not.toBe(b.next())
  })

  it('produces values in [0, 1)', () => {
    const rng = new SeededRng(SEED_STRING)
    for (let i = 0; i < 2000; i += 1) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('produces the requested number of bytes, all in range', () => {
    const bytes = new SeededRng(SEED_STRING).bytes(64)
    expect(bytes).toHaveLength(64)
    expect(bytes.every((b) => b >= 0 && b <= 255)).toBe(true)
  })

  it('does not immediately repeat itself over a long draw', () => {
    const rng = new SeededRng(SEED_STRING)
    const seen = new Set(Array.from({ length: 5000 }, () => rng.next()))
    // A weak generator collides quickly at this sample size.
    expect(seen.size).toBeGreaterThan(4990)
  })
})

describe('CryptoRng', () => {
  it('produces values in [0, 1)', () => {
    const rng = new CryptoRng()
    for (let i = 0; i < 500; i += 1) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('does not repeat across independent instances', () => {
    expect(new CryptoRng().bytes(16)).not.toEqual(new CryptoRng().bytes(16))
  })
})
