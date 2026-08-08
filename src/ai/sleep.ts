/**
 * The injected delay, shared by all three implementations.
 *
 * It has its own module so the dependency direction stays sane: mock, replay and
 * live all need to wait, and none of them should have to import another
 * implementation to do it.
 *
 * `setTimeout` reads no clock and produces no value, so it is not an ambient time
 * read and does not belong behind the platform port. The reason this is injected at
 * all is that tests must not wait, and that a simulated delay has to be skippable
 * without touching the code path that produces the answer.
 */

import { AiError } from './provider'

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

/** Production and demo. Rejects with `cancelled` if the caller aborts mid wait. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AiError('cancelled', 'The caller aborted while a response was in flight.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Tests. Resolves immediately, so a fixture's simulated think time costs nothing. */
export const noSleep: Sleep = async () => {}
