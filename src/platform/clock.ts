/**
 * The only place in the application allowed to read wall-clock time.
 *
 * Everything else takes a Clock. That is what makes the demo reproducible and
 * the tests deterministic: the same seed must produce byte-identical ids,
 * hashes and ordering on every run. See docs/01-architecture-review.md C2.B.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
}

/** Production. The one sanctioned call to Date.now in the codebase. */
export class SystemClock implements Clock {
  now(): number {
    // The sanctioned boundary: src/platform is where the ban is lifted.
    return Date.now()
  }
}

export interface SeededClockOptions {
  /** Starting instant in epoch milliseconds. */
  startMs: number
  /**
   * Milliseconds to advance on every now() call.
   *
   * A non-zero value keeps a bulk seed from exhausting the 4,096-slot
   * sub-millisecond counter in the id factory, which would otherwise force
   * synthetic timestamp advances. Zero gives a genuinely frozen clock, which is
   * what most tests want.
   */
  autoAdvanceMs?: number
}

/** Demo and test. Advances only when told to. */
export class SeededClock implements Clock {
  private current: number
  private readonly autoAdvanceMs: number

  constructor(options: SeededClockOptions) {
    this.current = options.startMs
    this.autoAdvanceMs = options.autoAdvanceMs ?? 0
  }

  now(): number {
    const value = this.current
    this.current += this.autoAdvanceMs
    return value
  }

  /** Move time forward explicitly, for tests that assert on elapsed behaviour. */
  tick(ms: number): void {
    if (ms < 0) throw new Error('SeededClock.tick: time does not go backwards')
    this.current += ms
  }

  /** Current instant without consuming an auto-advance step. */
  peek(): number {
    return this.current
  }
}

/** The instant the seeded dataset is built at, so seed output is stable. */
export const SEED_EPOCH_MS = 1785661800000 // 2026-08-01T09:10:00.000Z
