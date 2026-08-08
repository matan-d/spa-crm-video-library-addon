/**
 * The AI layer's public surface, and the one place a provider is chosen.
 *
 * Nothing above this file may branch on which implementation is running. A view
 * that asks "are we in mock mode" is a view that will eventually render a badge
 * from the mode instead of from the data, and that badge lies the moment the data
 * is mixed. So the factory is here, the mode is a construction time argument, and
 * every consumer receives an `AiProvider`.
 *
 * `mock` is the default and the only mode exercised in this build (U7). `live` is
 * constructed disabled and refuses before it can spend anything. `replay` ships with
 * an empty bundle, because there has been no capture run and an empty bundle is the
 * honest way to say so.
 */

import type { Clock } from '@/platform/clock'
import { createLiveProvider, type LiveDeps } from './live'
import { createMockProvider, type MockDeps } from './mock'
import { createReplayProvider, type ReplayDeps } from './replay'
import type { AiProvider } from './provider'

export type AiMode = 'mock' | 'replay' | 'live'

export interface AiFactoryDeps {
  mode?: AiMode
  clock?: Clock
  mock?: MockDeps
  replay?: ReplayDeps
  live?: Omit<LiveDeps, 'clock'>
}

/**
 * Builds the provider for a mode.
 *
 * The live branch requires a clock, because a real call is the only one that
 * measures its own latency and `latency_source` has to be able to say `measured`
 * truthfully. Mock and replay never need one: their latency is a number on a
 * fixture.
 */
export function createAiProvider(deps: AiFactoryDeps = {}): AiProvider {
  const mode = deps.mode ?? 'mock'
  if (mode === 'live') {
    if (!deps.clock) {
      throw new Error(
        'createAiProvider: the live provider needs a Clock. Latency on a real call is measured, not read off a fixture, and there is no ambient time outside src/platform.',
      )
    }
    return createLiveProvider({ ...deps.live, clock: deps.clock })
  }
  if (mode === 'replay') return createReplayProvider(deps.replay)
  return createMockProvider(deps.mock)
}

export * from './provider'
export * from './clone'
export * from './schemas'
export * from './taxonomy'
export * from './validate'
export * from './postchecks'
export * from './prompts'
export * from './cache'
export * from './meta'
export * from './render'
export * from './sleep'
export * from './writer'
export { createMockProvider, MockAiProvider, type MockConditions, type MockDeps } from './mock'
export { createReplayProvider, ReplayAiProvider, captureFixture, EMPTY_REPLAY_BUNDLE } from './replay'
export type { ReplayBundle, ReplayFixture, ReplayDeps } from './replay'
export { createLiveProvider, LiveAiProvider } from './live'
export type { AiFunctionResponse, AiFunctionError, LiveDeps } from './live'
