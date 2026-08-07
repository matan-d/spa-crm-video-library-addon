/**
 * Canonical JSON and sha256.
 *
 * Every hash in this system is taken over JSON: `prompt_hash`, `input_hash`,
 * `fixture_hash`, and the gap scan's `cell_signature`. If the serialisation is
 * not canonical then two logically identical inputs produce different hashes,
 * the AI response cache never hits, and a dismissed gap reappears after a
 * rescan. Both failures are quiet and expensive, so the serialiser is strict:
 * it sorts keys, omits undefined, and throws on anything it cannot represent
 * reproducibly rather than guessing.
 */

/**
 * Deterministic JSON: object keys sorted, array order preserved, undefined
 * properties omitted, and no whitespace.
 */
export function canonicalJson(value: unknown): string {
  return write(value, [])
}

/** sha256 of a string or bytes, lowercase hex. */
export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input)
  // A fresh copy so the digest never sees a view into a larger, mutable buffer.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** sha256 over the canonical form of a value. This is the hash used everywhere. */
export async function hashOf(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value))
}

function write(value: unknown, path: string[]): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'

    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: ${describe(path)} is ${String(value)}, which has no stable JSON form`)
      }
      // Negative zero would serialise as "0" and compare equal to positive zero,
      // so normalise it rather than letting two inputs collide silently.
      return Object.is(value, -0) ? '0' : JSON.stringify(value)

    case 'string':
      return JSON.stringify(value)

    case 'bigint':
      throw new Error(`canonicalJson: ${describe(path)} is a bigint, which JSON cannot represent`)

    case 'function':
    case 'symbol':
    case 'undefined':
      throw new Error(`canonicalJson: ${describe(path)} is ${typeof value}, which is not serialisable`)

    case 'object':
      break

    default:
      throw new Error(`canonicalJson: ${describe(path)} has unsupported type ${typeof value}`)
  }

  if (Array.isArray(value)) {
    // Array order is meaningful, so it is preserved. Holes and undefined
    // elements become null, matching JSON.stringify.
    const items = value.map((item, i) =>
      item === undefined ? 'null' : write(item, [...path, String(i)]),
    )
    return `[${items.join(',')}]`
  }

  if (value instanceof Date) {
    throw new Error(
      `canonicalJson: ${describe(path)} is a Date. Pass an ISO string from the injected Clock instead, so hashing cannot depend on ambient time.`,
    )
  }

  if (value instanceof Map || value instanceof Set) {
    throw new Error(
      `canonicalJson: ${describe(path)} is a ${value.constructor.name}. Convert it to a plain object or array with an explicit order first.`,
    )
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    const item = record[key]
    if (item === undefined) continue // omitted, so adding an explicit undefined never changes a hash
    parts.push(`${JSON.stringify(key)}:${write(item, [...path, key])}`)
  }
  return `{${parts.join(',')}}`
}

function describe(path: string[]): string {
  return path.length === 0 ? 'the root value' : `property "${path.join('.')}"`
}
