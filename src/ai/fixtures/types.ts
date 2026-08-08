/**
 * What an authored fixture is, and what it is allowed to claim.
 *
 * Decision U8: the mock's responses are authored offline by a model looking at
 * the real artefact, not emitted by template code. These types are what keeps
 * that claim checkable rather than stated:
 *
 * - `provenance.artefact` names the file or record the author actually opened,
 *   and `provenance.sha256` is that file's committed hash, so a test can assert
 *   the fixture was written against bytes that are still in the repository. A
 *   fixture whose artefact hash no longer matches the manifest is a fixture
 *   describing an image nobody can see any more.
 * - Identifiers are never authored. Every schema field that echoes an input
 *   (`cell_signature`, `brief_item_id`, `missing_item_ids`, `frames_seen`) is
 *   absent from the authored payload and supplied by the mock from the input at
 *   serve time. Authoring an identifier would let a fixture name a brief item
 *   the caller never asked about, which is the fabrication this whole layer is
 *   built to prevent.
 * - `imperfection` records, per fixture, what is deliberately wrong or thin about
 *   it. A fixture set with an empty column here is a fixture set that only
 *   demonstrates the happy path, and the interface then never grows the states
 *   real ambiguity needs.
 */

import type { ProviderDetail } from '../meta'
import type { AiErrorReason } from '../provider'

export interface FixtureProvenance {
  /** The committed file or seeded record the author read. */
  artefact: string
  /** sha256 of that file, when it is a committed file. Null for a seeded record. */
  sha256: string | null
}

export interface AuthoredFixture<T> {
  /** Recorded on `ai_run.fixture_id`. Stable, so a tag can be traced to an answer. */
  id: string
  provenance: FixtureProvenance
  /** Simulated think time. Data, never a measurement, and stamped as such. */
  latency_ms: number
  /**
   * What is deliberately imperfect here, or null when this one is a clean case.
   *
   * Most entries are non-null on purpose. See docs/02-caveats-review.md on mock
   * drift: fixtures written to look good produce a UI that has never failed.
   */
  imperfection: string | null
  output: T
}

/**
 * A failure a mock can be made to produce.
 *
 * The mock has to be able to fail in every way the live path can, or the UI grows
 * only the success state and the first real error is the first time anybody sees
 * a spinner that never resolves.
 */
export interface AuthoredFailure {
  id: string
  reason: AiErrorReason
  message: string
  latency_ms: number
  /**
   * How this failure was produced.
   *
   * Defaults to the authored detail, because the keyed failures below were written
   * out like the successes were. The two structural failures (no sheet, oversized
   * sheet) are code decisions rather than authored answers and say `synthetic-v1`,
   * because a run row claiming a model authored a refusal that a size check
   * produced would be the same class of lie as a mock naming a model.
   */
  detail?: ProviderDetail
  /**
   * The malformed payload, kept verbatim.
   *
   * A validation failure with no evidence is unresolvable after the fact, so the
   * raw response travels with the error and is written to `ai_run.output_json`
   * alongside `schema_valid: false`.
   */
  raw_output?: unknown
  /** How many consecutive calls fail before the fixture path succeeds. Infinity means always. */
  failures?: number
  note: string
}
