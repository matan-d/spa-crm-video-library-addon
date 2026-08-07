/**
 * One id scheme for the whole system: UUIDv7 (RFC 9562), built from the injected
 * Clock and Rng.
 *
 * Why one scheme rather than two: production needs ids that sort by real time
 * and are unguessable, and demo plus test need ids that are byte-identical on
 * every run. Both fall out of the same generator once its two inputs are
 * injected, so there is no `if (demo)` branch anywhere in the id path.
 *
 * The 12-bit rand_a field is used as a monotonic sub-millisecond counter, which
 * is RFC 9562's own "method 1". That matters here more than in most systems: a
 * seeded clock can return the same millisecond for hundreds of consecutive ids,
 * and random rand_a bits would make them sort arbitrarily within that
 * millisecond. The counter gives strict, stable ordering even under a frozen
 * clock, and it is also the correct production behaviour for burst inserts.
 *
 * Layout, 128 bits:
 *   48  unix_ts_ms       big-endian
 *    4  version          0b0111
 *   12  rand_a           monotonic counter within the millisecond
 *    2  variant          0b10
 *   62  rand_b           random
 */

import type { Clock } from './clock'
import type { Rng } from './rng'

const MAX_COUNTER = 0xfff
const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export type IdFactory = () => string

export function createIdFactory(clock: Clock, rng: Rng): IdFactory {
  let lastMs = -1
  let counter = 0

  return function uuidv7(): string {
    const observed = clock.now()

    if (observed > lastMs) {
      lastMs = observed
      counter = 0
    } else {
      // Same millisecond, or a clock that went backwards (NTP correction, or a
      // frozen SeededClock). Either way we stay monotonic by keeping the last
      // timestamp and advancing the counter.
      counter += 1
      if (counter > MAX_COUNTER) {
        // 4,096 ids inside one millisecond. Borrow from the next millisecond
        // rather than wrapping, which would break sort order.
        lastMs += 1
        counter = 0
      }
    }

    const bytes = new Uint8Array(16)

    // 48-bit timestamp. Written via division rather than bit shifts because
    // lastMs exceeds 32 bits and `>>>` would silently truncate it.
    bytes[0] = Math.floor(lastMs / 2 ** 40) & 0xff
    bytes[1] = Math.floor(lastMs / 2 ** 32) & 0xff
    bytes[2] = Math.floor(lastMs / 2 ** 24) & 0xff
    bytes[3] = Math.floor(lastMs / 2 ** 16) & 0xff
    bytes[4] = Math.floor(lastMs / 2 ** 8) & 0xff
    bytes[5] = lastMs & 0xff

    bytes[6] = 0x70 | ((counter >>> 8) & 0x0f)
    bytes[7] = counter & 0xff

    const random = rng.bytes(8)
    bytes[8] = 0x80 | (random[0] & 0x3f)
    for (let i = 1; i < 8; i += 1) bytes[8 + i] = random[i]

    return format(bytes)
  }
}

/** Epoch milliseconds encoded in a UUIDv7, for assertions and debugging. */
export function timestampOf(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12)
  return Number.parseInt(hex, 16)
}

/** Sub-millisecond counter encoded in a UUIDv7. */
export function counterOf(id: string): number {
  const hex = id.replace(/-/g, '')
  return Number.parseInt(hex.slice(13, 16), 16)
}

function format(b: Uint8Array): string {
  return (
    HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] +
    '-' + HEX[b[4]] + HEX[b[5]] +
    '-' + HEX[b[6]] + HEX[b[7]] +
    '-' + HEX[b[8]] + HEX[b[9]] +
    '-' + HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
  )
}
