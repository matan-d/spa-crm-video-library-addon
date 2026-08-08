/**
 * The authored fixture set, in one place, with the honesty claims it has to keep.
 *
 * Nothing in this directory was produced by template code. Every entry was written
 * by a model offline, during the build, against the artefact its `provenance`
 * names, per decision U8. No model is called at runtime in this build and there was
 * no capture run, which is why these are `mock` and not `replay`: they are the
 * right shape and the right register, and they were never seen by a model at
 * runtime, so the row says `provider='mock'` and `model_id` is null.
 *
 * `FIXTURE_MANIFEST` exists so a test can walk every fixture without knowing the
 * per capability shapes, and so the Data Health surface can count what the demo is
 * actually serving.
 */

export * from './types'
export * from './vision'
export * from './vet'
export * from './brief-gen'
export * from './brief-match'
export * from './search-parse'
export * from './gap-scan'
export * from './nudge-draft'
export * from './failures'

import type { CapabilityKey } from '../schemas'
import { BRIEF_GEN_FIXTURES } from './brief-gen'
import { BRIEF_MATCH_FIXTURES } from './brief-match'
import { VISION_FAILURES, VET_FAILURES } from './failures'
import { GAP_SCAN_FIXTURES } from './gap-scan'
import { NUDGE_FIXTURES } from './nudge-draft'
import { SEARCH_PARSE_FIXTURES } from './search-parse'
import type { AuthoredFailure, FixtureProvenance } from './types'
import { VET_FIXTURES } from './vet'
import { VISION_FIXTURES } from './vision'

export interface FixtureManifestEntry {
  capability: CapabilityKey
  id: string
  provenance: FixtureProvenance
  latency_ms: number
  imperfection: string | null
  output: unknown
}

export const FIXTURE_MANIFEST: readonly FixtureManifestEntry[] = [
  ...VET_FIXTURES.map((f) => ({ capability: 'vet' as const, ...pick(f) })),
  ...BRIEF_GEN_FIXTURES.map((f) => ({ capability: 'brief_gen' as const, ...pick(f) })),
  ...VISION_FIXTURES.map((f) => ({ capability: 'vision_tag' as const, ...pick(f) })),
  ...BRIEF_MATCH_FIXTURES.map((f) => ({ capability: 'brief_match' as const, ...pick(f) })),
  ...SEARCH_PARSE_FIXTURES.map((f) => ({ capability: 'search_parse' as const, ...pick(f) })),
  ...GAP_SCAN_FIXTURES.map((f) => ({ capability: 'gap_scan' as const, ...pick(f) })),
  ...NUDGE_FIXTURES.map((f) => ({ capability: 'nudge_draft' as const, ...pick(f) })),
]

function pick(fixture: {
  id: string
  provenance: FixtureProvenance
  latency_ms: number
  imperfection: string | null
  output: unknown
}): Omit<FixtureManifestEntry, 'capability'> {
  return {
    id: fixture.id,
    provenance: fixture.provenance,
    latency_ms: fixture.latency_ms,
    imperfection: fixture.imperfection,
    output: fixture.output,
  }
}

/** Every authored failure, for the same reason: a test walks these too. */
export const FAILURE_MANIFEST: readonly { capability: CapabilityKey; subject_id: string; failure: AuthoredFailure }[] = [
  ...[...VISION_FAILURES].map(([subject_id, failure]) => ({
    capability: 'vision_tag' as const,
    subject_id,
    failure,
  })),
  ...[...VET_FAILURES].map(([subject_id, failure]) => ({ capability: 'vet' as const, subject_id, failure })),
]
