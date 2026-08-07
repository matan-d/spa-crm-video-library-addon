/**
 * The only place in the application allowed to produce randomness.
 *
 * Production uses the platform CSPRNG so ids are unguessable. Demo and test use
 * a seeded PRNG so a run is byte-identical every time.
 * See docs/01-architecture-review.md C2.B.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** n random bytes. */
  bytes(n: number): Uint8Array
}

/** Production. The one sanctioned use of the platform CSPRNG. */
export class CryptoRng implements Rng {
  next(): number {
    const b = this.bytes(4)
    const int = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
    return int / 0x100000000
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n)
    globalThis.crypto.getRandomValues(out)
    return out
  }
}

/**
 * Demo and test. sfc32, seeded via cyrb128.
 *
 * sfc32 is chosen over a one-liner LCG because it has a long period and passes
 * PractRand, so seeded fixtures do not develop visible patterns across the
 * thousands of values a full dataset build consumes.
 */
export class SeededRng implements Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed: string) {
    const [a, b, c, d] = cyrb128(seed)
    this.a = a
    this.b = b
    this.c = c
    this.d = d
    // Discard the first few outputs so closely-related seed strings diverge.
    for (let i = 0; i < 12; i += 1) this.next()
  }

  next(): number {
    this.a >>>= 0
    this.b >>>= 0
    this.c >>>= 0
    this.d >>>= 0
    let t = (this.a + this.b) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.d = (this.d + 1) | 0
    t = (t + this.d) | 0
    this.c = (this.c + t) | 0
    return (t >>> 0) / 0x100000000
  }

  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) out[i] = Math.floor(this.next() * 256) & 0xff
    return out
  }
}

/** Seed string for the committed demo dataset. Changing it changes every id. */
export const SEED_STRING = 'astolia-seed-v1'

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < str.length; i += 1) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
}
