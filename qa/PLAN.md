# QA plan

Built alongside the code, never after it.
Every claim in a QA report is backed by a command and its output.
Coverage is never implied: anything unverifiable in this build is written down as a gap.

## Layers, in order of preference

| layer | tool | what belongs here |
|---|---|---|
| unit | Vitest | pure functions: atom parser, pre-flight rule engine, dHash, tokenizer, taxonomy mapping, projections, merge primitives, `uuidv7` determinism, schema validation, ingest policy derivation |
| integration | Vitest + fake-indexeddb | scoped repository, outbox, migrations, seed hydration, reindex queue, `ai_run` provenance invariants, review session cursor |
| e2e | Playwright, three roles, two viewports | the real UI, the real `ingestFile()` path, the whole loop |
| visual | Playwright screenshots | the responsive matrix, which is the only verification available with no device testing |
| manual only | `qa/manual-checklist.md` | real iPhone, real Android, packaged Electron, live model calls |

## The three role end to end runs

Each runs at two viewports (1440x900 desktop, 390x844 mobile) and with pointer type forced, because a wide touch device must not get the desktop layout.

**Creator run.** Open a token link, accept consent (writes an immutable versioned record), load fixture clips through the real `ingestFile()` entry point, assert the per clip pre-flight verdict against `manifest.json.expected_preflight` within tolerance, see the live checklist against the locked brief, submit, reopen the same link and resume with persisted offsets.
Desktop variant adds a folder drop containing junk (sidecars, proxies, RAW stills, system files) and asserts non clips are filtered rather than failed.

**Manager run.** Open the triage inbox, review a delivery grouped by brief item, assert the promised versus delivered diff including the extras bucket, drive the queue by keyboard over a frozen ordered list, land a background change mid session and assert the stale row is refused rather than silently acted on, approve and reject, assert the creator facing note is shown rather than the internal reject text, publish.

**Editor run.** Search in plain language, assert the taxonomy mapping is visible as removable chips (`golden hour` to `warm_light`) and that an unmapped term is surfaced rather than dropped, refine with facets, hit a zero result and turn it into a gap request, add clips to a bin, hand off, confirm a usage record with `rank_at_event`, then confirm the gap reaches the manager.

**The loop run, which is the flagship.** One test from a zero result search to a closed gap, asserting the id chain at every hop: `search_query_log` to `gap.cell_signature` to `brief.gap_scan_id` to `brief_item.origin_gap_id` to the delivered asset to `review_action` to published to `usage_event` to gap closed with a before and after count.
It asserts ids, never screenshots.

## Fixtures

Generated once by `scripts/build-fixtures.mjs` with `ffmpeg-static`, committed under `public/fixtures/`, verified by sha256 before use.

| fixture | proves |
|---|---|
| `vertical_ok.mp4` | the happy path |
| `horizontal_fail.mp4` | orientation rule fails |
| `short_fail.mp4` | duration rule fails |
| `lowres_fail.mp4` | resolution rule fails |
| `rotated_90.mp4` | display orientation vertical, coded landscape. The most valuable fixture in the set |
| `hevc.mov` | codec detection, and genuine undecodable degradation on a Windows reviewer's machine |
| `no_metadata.mp4` | `unknown`, honest degradation, never coerced to pass |
| `duplicate_of_vertical_ok.mp4` | perceptual dedupe where bytes differ |
| `prores.mov` | camera offload: no GPS, landscape, large, log encoded |
| 2 to 3 pleasant clips | the preview player demo |

Three rules: assert `expected_preflight` and never `declared` (asserting `declared` tests ffmpeg, which is not interesting), tolerances are mandatory (dHash within a Hamming distance, duration within tens of milliseconds, distance within tens of metres), and a regenerated fixture that differs from its committed hash fails loudly.

Malformed input set, no fixture needed: zero byte file, `.mov` that is not a movie, truncated file, 4GB file, no `moov` atom, atoms in unexpected order.

## Standing invariants, asserted as tests

These are the ones where a regression is silent, so they get a test each:

1. **No fabrication.** A clip with no contact sheet produces no `ai_run` row, no AI tags, and all `ai_*` fields null. The enqueue guard refuses vision tagging without a `sheet_id`.
2. **Provenance cannot lie.** A `mock` run cannot be written with a `model_id`. `asset.ai_provenance` drives the simulated badge, never the current mode.
3. **Scope holds.** Per role, forbidden tables throw and forbidden field names are absent from projection output, so a field added later fails the test unless somebody deliberately allowlists it.
4. **No role bleed through a cached view.** After a role switch, no previous role's data is present in any mounted component or retained state.
5. **Determinism.** The suite runs twice and diffs clean. The seed produces byte identical output. No ambient `Date.now`, `Math.random`, `hardwareConcurrency`, `deviceMemory` outside the platform module, enforced by eslint and asserted by a lint test.
6. **Never coerce unknown.** A rule with no evidence is `unknown` in the record and rendered as unknown in the UI, never as pass and never as fail.
7. **Nothing waits forever.** Every media wait has a timeout, and each failure carries an enumerated reason code.
8. **Loop links exist.** `brief_item.origin_gap_id`, `brief.gap_scan_id`, `usage_event.rank_at_event`, `review_action.method`, and `gap_dismissal.cell_signature` are present and populated by the real flow, never hand written into the seed.

## The responsive matrix

With no device testing available, a screenshot matrix is the only verification we get.
Widths 390, 768, 1024, 1440, 1920, times three roles, times pointer coarse and fine.
Assert no horizontal body scroll, no clipped action, and that the desktop layout does not activate on a coarse pointer.
Diffed on every run so a layout regression in the form factor nobody is developing on is caught by the machine rather than by a reviewer.

## Where cases come from

Each specialist agent writes cases to `qa/cases/<domain>.md` in one shared format (Given, When, Then, Layer, Blocked-by).
`qa-runner` implements everything not marked `manual-only` and moves the rest to `qa/manual-checklist.md` with what a human would have to do.
A finding without a case is incomplete.

## Known untestable in this build, stated rather than implied

- Real iPhone and real Android behaviour, all of it. The iOS specific handling is written blind.
- A packaged Electron build, which is designed and not built.
- Live model calls, since the submission ships on simulated responses by default.
- HEVC decode on hardware we do not have.

Each of these has a manual checklist entry describing what a human with the device would do, so the gap is visible rather than pretended away.
