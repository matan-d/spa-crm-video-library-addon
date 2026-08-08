/**
 * The response cache key, which is also the replay fixture key.
 *
 * Replay is not a separate code path. It is this cache, pre-seeded from committed
 * fixtures. That is why there is one key shape and one function that builds it: if
 * replay had its own key, a prompt version bump would invalidate the cache and
 * silently keep serving stale fixtures.
 *
 * ## The three parts
 *
 * `(input_hash, prompt_hash, model_key)`, matching the `by_cache_key` index on
 * `ai_run`.
 *
 * - `input_hash` is sha256 over the canonical JSON of the input, keys sorted. This
 *   has to be canonical or two logically identical inputs produce different hashes,
 *   the cache never hits, and the demo re-runs everything. `hashOf` sorts keys.
 * - `prompt_hash` covers the system text, the template, the effort and the
 *   max_tokens, so a prompt edit invalidates deliberately.
 * - `model_key` is the cache dimension, not the provenance claim. For live and
 *   replay it is the model id. For mock it is `simulated:<model>`, so a mock answer
 *   can never be served to a live request from the same cache, and `model_id` stays
 *   null on the row where it belongs.
 *
 * ## What is deliberately NOT in the key
 *
 * The image bytes are in `input_hash` (they are part of the input), but nothing
 * about the current mode, the profile, the device or the time is. A cache key that
 * varied by any of those would be a cache that never hits.
 */

import { hashOf } from '@/platform/hash'
import type { AiProvider as AiProviderKind } from '@/data/types'
import { MODEL_ID, SIMULATED_MODEL_ID } from './prompts'

export interface CacheKey {
  input_hash: string
  prompt_hash: string
  model_key: string
}

/** Stable string form, for a Map key or a fixture filename. */
export function cacheKeyString(key: CacheKey): string {
  return `${key.input_hash}.${key.prompt_hash}.${key.model_key}`
}

/**
 * The model key for a provider.
 *
 * Mock deliberately gets a different key from live even though it imitates the
 * same model, because the cache must not be able to hand a synthetic answer to a
 * caller that asked for a real one.
 */
export function modelKeyFor(provider: AiProviderKind): string {
  if (provider === 'mock') return `simulated:${SIMULATED_MODEL_ID}`
  return MODEL_ID
}

export async function inputHash(input: unknown): Promise<string> {
  return hashOf(input)
}

/**
 * A tiny in-memory response cache.
 *
 * Deliberately not persisted here: the persisted cache is `ai_run` itself, queried
 * through the `by_cache_key` index, and duplicating that in a second store would
 * create two caches that can disagree. This one exists so a single session does not
 * repeat identical work (the same query typed twice, a re-render of a gap list),
 * and so the mock's simulated think time is paid once per distinct input rather
 * than every time a view mounts.
 */
export class ResponseCache {
  private readonly entries = new Map<string, unknown>()

  constructor(private readonly limit = 200) {}

  get<T>(key: CacheKey): T | undefined {
    return this.entries.get(cacheKeyString(key)) as T | undefined
  }

  set(key: CacheKey, value: unknown): void {
    const stringKey = cacheKeyString(key)
    if (this.entries.has(stringKey)) this.entries.delete(stringKey)
    this.entries.set(stringKey, value)
    // Oldest-first eviction. Insertion order is Map's own guarantee.
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
