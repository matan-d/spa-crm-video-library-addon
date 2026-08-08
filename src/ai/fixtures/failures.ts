/**
 * The failures the mock can produce, keyed to specific seeded subjects.
 *
 * Rule five of the AI contract: a mock that only ever succeeds produces a UI that
 * has never failed, and the reviewer then sees a product where nothing has gone
 * wrong. So the seeded delivery contains a refusal, a malformed response, a rate
 * limit and a timeout, and each one has a different UI state and a different
 * correct next action.
 *
 * Two of these are permanent and two clear on retry, which lines up with
 * docs/01-architecture-review.md C2.C: about ninety `ai_run` rows, two of them
 * with `status='error'`.
 *
 * ## Two failures are not in this file, on purpose
 *
 * `no_stills` and `payload_too_large` are structural. The first fires whenever a
 * vision call arrives with no sheet, and it must not be attachable to a chosen
 * asset id, because then a clip could be given a sheet and still refuse, or worse,
 * be missing a sheet and still answer. The second fires on the encoded size of the
 * sheet, checked before anything is sent, exactly as the live path checks it.
 */

import type { AuthoredFailure } from './types'

/**
 * A malformed vision response, kept in the shape a real failure takes.
 *
 * It is not random noise: it is a plausible response that breaks two rules the
 * model does not enforce for us. `confidence: 1.4` breaks a numeric bound, which
 * structured outputs cannot express, and `light: 'soft_indoor'` is the term the
 * seeded media manifest uses rather than a taxonomy member. That second one is the
 * exact drift the closed enum exists to stop, so the malformed fixture is also a
 * demonstration of why the enum is there.
 */
const MALFORMED_VISION = {
  description: 'A treatment room in bright daylight with the bed made and the blind half drawn.',
  shot_type: 'wide',
  room: 'treatment_room',
  subjects: ['none_visible'],
  light: 'soft_indoor',
  vibe: 'minimal',
  tags: [
    { term: 'treatment_room', confidence: 1.4 },
    { term: 'wide', confidence: 0.81 },
  ],
  framing: 'good',
  framing_reason: null,
  light_quality: 'good',
  light_reason: null,
  review_flags: [],
  text_on_screen: false,
  frames_seen: 5,
  overall_confidence: 0.77,
  uncertainty: null,
}

/** Vision failures, by seeded asset id. */
export const VISION_FAILURES: ReadonlyMap<string, AuthoredFailure> = new Map([
  [
    'asset-hero-2',
    {
      id: 'vision.refused.neck-massage',
      reason: 'refused',
      message:
        'The safety classifiers declined this contact sheet. There is no partial answer to salvage, and this clip needs a human to look at it.',
      latency_ms: 1_050,
      note: 'A refusal is HTTP 200 with stop_reason refusal, so code that reads content[0] throws rather than branching. It maps to "could not analyse, needs manual review", never to a rejection and never to a retry: the same request refuses identically. The seeded human decision on this clip is a rejection with a blunt internal reason, which is the honest end state for it.',
    },
  ],
  [
    'asset-hero-7',
    {
      id: 'vision.malformed.treatment-room-daylight',
      reason: 'invalid_output',
      message:
        'The response did not validate against the vision schema: a tag confidence above 1 and a light term outside the taxonomy.',
      latency_ms: 1_390,
      raw_output: MALFORMED_VISION,
      note: 'Kept verbatim on the run row with schema_valid false, so the failure is inspectable six weeks later without a new call. Retryable exactly once at the caller, not here.',
    },
  ],
  [
    'asset-hero-10',
    {
      id: 'vision.rate-limited.lounge',
      reason: 'rate_limited',
      message: 'Rate limited. This one is queued and will be retried.',
      latency_ms: 320,
      failures: 1,
      note: 'Clears on the second attempt, so the batch surface has to show a per tile retry rather than failing the whole delivery. A batch of forty that dies on one 429 is the failure B3.7 predicts.',
    },
  ],
  [
    'asset-hero-13',
    {
      id: 'vision.timeout.corridor-marble',
      reason: 'timeout',
      message: 'The request did not come back inside the function timeout.',
      latency_ms: 26_000,
      failures: 1,
      note: 'The latency here is deliberately the Netlify synchronous ceiling, so a demo of this state shows the number that actually causes it. Clears on retry.',
    },
  ],
])

/** Vetting failures, by seeded creator id. */
export const VET_FAILURES: ReadonlyMap<string, AuthoredFailure> = new Map([
  [
    'creator-8',
    {
      id: 'vet.refused.blocked-creator',
      reason: 'refused',
      message: 'The classifiers declined to assess this person. No band, no score, and nothing to show as a verdict.',
      latency_ms: 890,
      note: 'This call should never have been made. The creator is on the blocklist, and the deterministic eligibility gate in docs/02-caveats-review.md B1.4 is supposed to stop the request before it costs anything. Until that gate exists the refusal is the safety net, and the UI must render it as "not assessed" rather than as a negative judgement about a named human.',
    },
  ],
])
