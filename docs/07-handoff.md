# Handoff: where this is and what happens next

Read `CLAUDE.md` first. This file is the ordered task list, so the sequence cannot be mistaken.

Last commit at the time of writing: `8ebece5`, "F6: the platform port, the capability probe, and the ingest tiers".
Gates at that commit: 198 tests passing, clean typecheck, clean lint, 16 fixtures verified.

## Resume in one line

> Read `CLAUDE.md` and `docs/07-handoff.md`, then continue at the first task marked NEXT.

## Done

| id | what | evidence |
|---|---|---|
| F1 | Injected `Clock` and `Rng`, one UUIDv7 generator with the 12-bit `rand_a` field as a monotonic sub-millisecond counter | `src/platform/{clock,rng,id}.ts`, `tests/platform/id.spec.ts`. The load-bearing test is that 500 ids under a frozen clock still sort in generation order |
| F5 | Canonical JSON with sorted keys, plus sha256. Throws on `NaN`, `Date`, `Map`, `Set` rather than guessing | `src/platform/hash.ts`, `tests/platform/hash.spec.ts` |
| F2 | Store and index schema, migration runner, profile namespacing. Demo and live are separate databases | `src/data/{schema,db,profile}.ts`, `tests/data/db.spec.ts` |
| B1 | 16 engineered fixtures plus a manifest separating `declared` from `expected_preflight`, with tolerances, and a verifier that re-reads the bytes | `public/fixtures/`, `scripts/{build-fixtures,verify-fixtures}.mjs`, `tests/fixtures/manifest.spec.ts`, `docs/media-pipeline.md` |
| Seed media | 27 real stock items. Contact sheets are genuine frame extractions from rendered clips, not five crops of one photo | `public/seed/`, `scripts/build-seed-media.mjs`, `docs/MEDIA-CREDITS.md` |
| F6 | `PlatformPort` with seven sub-interfaces, the capability probe, three ingest tiers, `deriveIngestPolicy`, and the browser implementation | `src/platform/{port,capability}.ts`, `src/platform/browser/`, `tests/platform/{capability,bytes}.spec.ts` |

Two things inside F6 worth knowing before you touch anything media related:

- `MediaCodecs.transcode()` throws `Unsupported('no_transcoder_in_browser')`. That is the design, not a stub to fill in. It is the single line where this build's known open hole lives.
- Frame count is settled: `clamp(3 + round(duration_s / 3), tier.floor, tier.ceiling)`, tiers `ample` 5 to 7, `standard` 4 to 6, `constrained` 3 to 3. Reasoning in `docs/06-decisions.md` D2.

## The task list, in dependency order

### 1. DONE: the fixture manifest is aligned to the resolved frame count formula

`public/fixtures/manifest.json` now carries `expected_frames.by_tier` for all three tiers, recomputed from `frameCountFor()`. `scripts/fixtures.config.mjs` restates the formula (Node cannot import a TypeScript module) and `assertFrameFormulaMatchesSource()` reads `src/platform/capability.ts` as text on every build, failing with a named diff if the two ever drift. `docs/media-pipeline.md` 4.5 records the resolution, and QC-MEDIA-100, 101, 103 and 104 assert it.

One consequence worth carrying forward into A2: at the `ample` floor of 5 frames, a 1.5 second clip plans frames a quarter second apart while every fixture has a half second GOP. On the `<video>` plus canvas path two planned times can legitimately snap to the same decoded frame, so the extractor must record the times it actually reached rather than the times it planned, and must not present near identical tiles as five distinct moments. See QC-MEDIA-104.

### 2. F3 plus F4, together, and this ordering matters more than any other in the build

The scoped repository and the outbox must be built in the same pass. The outbox is fed by every mutation, so adding it afterwards means reopening every write path in the application. Built together, the repository is the only writer and the outbox append is one line inside it.

Deliver:
- `createScopedRepo(session)` with exactly three session factories: `managerSession(user)`, `editorSession(user)`, `creatorTokenSession(token)`.
- Per role, on every read: a table allowlist, a mandatory predicate, and a field projection. The editor never reads `creator` or `collab` at all, and `asset.creator_credit` is the denormalised credit line that replaces a column-level policy.
- Writes go through the same layer, which is also the only thing that appends to the outbox.
- The boolean `_i` mirrors are written here, by the repository, never by callers.
- A scope test asserting per role that forbidden tables throw and forbidden field names are absent from projection output, so a field added later fails unless somebody deliberately allowlists it.

Read `docs/01-architecture-review.md` A2.3 and C.2, and use `tenancy-guard` to review the projections against the visibility matrix.

### 3. A1 to A3, the media pipeline

- A1 MP4 and MOV atom parser: `moov/mvhd` (note the 1904 epoch), the `tkhd` display matrix for rotation, `udta/©day`, the Apple `com.apple.quicktime.creationdate` and `location.ISO6709` keys, `stsd` codec fourcc, 64-bit atom sizes, and tolerance for a `moov` that follows `mdat`. A pure function over an `ArrayBuffer` returning facts with per-field confidence.
- A2 frame extraction as a capability chain: WebCodecs `VideoDecoder` first, then `<video>` plus canvas (muted, `playsInline`, awaiting `seeked`, keyframe snapping means frames are approximate), then a generated placeholder tile so the UI never breaks on an undecodable file. Record which path produced each sheet and version the extractor.
- A3 the four-state pre-flight rule engine as a pure function over facts plus the locked brief item plus the branch.

Every rule asserts against `expected_preflight` in the fixture manifest, within its tolerance. Never assert against `declared`, because that tests ffmpeg rather than our parser.

Owner: `media-pipeline`, with `platform-matrix` reviewing the runtime branches.

### 4. C1 plus C2, the AI contract

One provider interface, seven capabilities (`vet`, `brief_gen`, `vision_tag`, `brief_match`, `search_parse`, `gap_scan`, `nudge_draft`), one JSON schema each, and a validator shared by every implementation and by the tests. Then the deterministic `mock`, the `replay` reader, and the `live` adapter that is built and never exercised.

Owner: `ai-contract`. It must load the `claude-api` skill before writing any model call and never state a model fact from memory.

### 5. Everything after that, in order

1. `ai_run` writer with the provenance guard, `is_current` maintenance, and the projection step. This blocks every AI-derived field in the UI.
2. D1 search index writers, `reindex_queue` with its incremental worker.
3. Seed generator (`scripts/build-seed.mjs`) under the seeded clock and RNG, producing `public/seed/seed.json`, plus hydration, reset, and profile switch.
4. Authored mock fixtures, deliberately imperfect. See `.claude/agents/ai-contract.md` for the authoring rules; uniformly clean fixtures are a failure even when every schema validates.
5. Creator surface: invite page with consent, upload page with the live checklist against the locked brief.
6. Manager surface: triage inbox first, then the kanban. The inbox is the real product and the kanban demos well; building the kanban first is optimising for the demo over the user.
7. Manager review queue: frozen ordered list, keyboard driven on desktop, stale-row refusal, `review_action` as the log that `asset.review_status` projects from.
8. Editor surface: search, facets derived from results, the clip sheet, bins, the zero-result ladder ending in "add to next brief".
9. D2 to D4 retrieval, scoring, the AI query parser producing a filter and ranking spec, and the term-to-taxonomy mapping shown as removable chips with unmapped terms surfaced.
10. E1 to E5 the loop: gap scan, gap-fed brief generation with `origin_gap_id`, brief lock, the promise versus delivered diff including extras, and gap close detection.
11. G2 loopback sync adapter and the sync panel, then G3 the Supabase adapter, env-gated and never pointed at anything.
12. Export and import snapshot, the Data Health panel, the storage panel.
13. Capacitor config plus the platform notes. No device build.
14. The two page thinking doc, and a demo script.

Do not leave the gap scan to the end by accident. It looks like a reporting feature and it is the product thesis. If it slips, the submission is a pipeline with AI in it rather than a closed loop.

## Things that will bite, recorded so they only bite once

- `vitest` 2.x pins vite 5, so with vite 6 there are two copies of vite and their plugin types collide. This project uses vitest 4. Do not downgrade.
- jsdom's `Blob` has no `.text()`. `tests/platform/bytes.spec.ts` has a `readText` helper for this.
- jsdom has no OPFS at all, so the byte store is tested against an in-memory fake directory in the same file. Reuse it rather than writing another.
- `ffmpeg-static` ships no ffprobe. `ffprobe-static` is installed separately and both generators use it.
- Fixtures and seed media are committed, so a fresh clone needs no media build and no network.
- The mission PDF is gitignored. `docs/00-context-brief.md` carries everything it said.
- `git` remote may contain a personal access token in its URL on the original machine. Nothing in the repo contains one, and none should ever be committed.

## Definition of done for the submission

1. A working prototype a reviewer can feel, not static screens, opening on a non-empty library within a few seconds with no key and no setup.
2. A public repo with run instructions that work from a fresh clone.
3. A thinking doc of at most two pages: the problem, the solution, where AI was used and where it deliberately was not, the decisions, the prioritisation, and the next steps. It links to the reviews rather than compressing them.
4. The AI session history, which the account owner exports.
