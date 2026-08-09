# Handoff: where this is and what happens next

Read `CLAUDE.md` first. This file is the ordered task list, so the sequence cannot be mistaken.

Last pushed commit: every surface built, no placeholder routes left (see git log).
Gates at that commit: 819 unit tests, clean typecheck, clean lint, 16 fixtures verified, and `npm run test:e2e` at 625 passed, 0 failed, 0 pending across eight browser runs.

## Resume in one line

> Read `CLAUDE.md` and `docs/07-handoff.md`, then continue at the first task marked NEXT. Do not ask questions: every decision is closed in `docs/06-decisions.md`.

Nothing is marked NEXT.
The build is at the state described in the definition of done at the bottom of this file, and what remains is in "What is deliberately not built".

## Done

| id | what | evidence |
|---|---|---|
| F1 | Injected `Clock` and `Rng`, one UUIDv7 generator using the 12-bit `rand_a` field as a monotonic sub-millisecond counter | `src/platform/{clock,rng,id}.ts`. The load-bearing test: 500 ids under a frozen clock still sort in generation order |
| F5 | Canonical JSON with sorted keys plus sha256, throwing on `NaN`, `Date`, `Map`, `Set` rather than guessing | `src/platform/hash.ts` |
| F2 | Store and index schema, migration runner, profile namespacing | `src/data/{schema,db,profile}.ts`. Demo and live are separate databases, with a test proving a row in one is invisible from the other |
| F6 | `PlatformPort` (7 sub-interfaces), the capability probe, three ingest tiers, `deriveIngestPolicy`, the browser implementation | `src/platform/{port,capability}.ts`, `src/platform/browser/` |
| F3+F4 | The scoped repository and the outbox, in one layer | `src/data/{scope,repo}.ts`. Three session factories, table allowlist then predicate then projection, boolean `_i` mirrors, outbox appended in the same transaction as the row |
| B1 | 16 engineered fixtures, a manifest separating `declared` from `expected_preflight` with tolerances, a verifier, and a formula drift guard | `public/fixtures/`, `scripts/{build-fixtures,verify-fixtures}.mjs` |
| Seed media | 27 real stock items. Contact sheets are genuine frame extractions from rendered clips | `public/seed/`, `scripts/build-seed-media.mjs` |
| Seed data | The demo dataset, generated at runtime, deterministic, with 10 deliberate imperfections each covered by a test | `src/data/{seed,hydrate}.ts` |
| App shell | Bootstrap, Pinia store, router, role switcher, creator token resolution, and the first honest library grid | `src/app/`, `src/App.vue`. The load-bearing test: a role switch remounts the view tree (element identity changes), and the token route can only construct a `creatorTokenSession`. Boot e2e: 44 passed, 0 pending |

## The specialist tracks, now complete

- `src/ai/**` is finished: fixtures authored against the committed sheets (sha256 asserted), the deterministic mock, replay, the disabled live adapter, and the writer whose enqueue guard refuses vision without a sheet. See D16 to D19 and `qa/cases/ai.md`.
- `src/media/**` is finished except one named seam: WebCodecs sample feeding, which declines out loud (D25). The element path is written and proved in a real browser. All seven pre-flight rules are asserted per fixture against `expected_preflight`. See `docs/media-pipeline.md` and `qa/cases/media.md`.
- `docs/platform-matrix.md` exists with a source and date per cell; its top findings P-1, P-2 and P-11 are fixed in the probe and the platform assembly.
- `e2e/`: eight runs, all green, 625 assertions, 0 pending. Boot, editor, manager, sync, decode, ai, creator and the flagship loop run.

## The task list, in dependency order

### 1. DONE: the app shell

`src/app/` exists: bootstrap (`bootstrap.ts`), the Pinia store (`store.ts`), the router with role guards and the `/#/c/:token` route (`router.ts`), session construction and the creator token resolver (`session.ts`), the demo tools strip, and a first honest library grid at `/library` that reads published assets through the editor scope and renders the committed posters.
The remount-on-role-switch rule is enforced by keying the router view on `store.viewKey` and asserted by a test that checks DOM element identity changes across a switch.
The seeded token hashes are now the real sha256 of `DEMO_CREATOR_TOKEN` and `DEMO_EXPIRED_TOKEN` (see D13), so `/#/c/demo-creator-token` resolves through the production lookup.
Staff roles land on `/library` until the triage inbox is real (D15).

### 2. DONE: the editor surface

Search with visible term mapping (`src/app/editor/search.ts`), facet chips derived from results, the zero-result ladder writing gap rows, the bin with `rank_at_event`, and the clip sheet with the amber and green tag split.
An unmapped term never filters: a vocabulary gap must not masquerade as a content gap.

### 3. DONE: the manager surface

Triage inbox bucketed by actionability, the three-bucket diff whose provisional AI matches stop counting the moment a human decides (the seeded over-claim renders struck through), the frozen keyboard review queue with stale-row refusal and append-only additions, publish as an explicit step, and the read-only kanban.
`src/app/manager/{triage,health}.ts` hold the pure logic.

### 4. DONE: the creator surface

Invite, consent (immutable and versioned), and the upload page running real local pre-flight before anything is stored.
The browser decode adapters landed with it (D25 reverses D24 for the element path), so the app now derives real contact sheets: `e2e/decode.e2e.mjs` proves five frames at five distinct timestamps with distinct hashes.
Thresholds resolve from the spec key the brief names (`src/app/creator/tech-specs.ts`), and the demo's visit date and branch coordinates match the fixture manifest so the committed fixtures pre-flight in the demo exactly as the contract says.

### 5. DONE: the loop, E1 to E5, and it is proved in a browser

`src/app/loop/loop.ts`: the scan (zero-result clusters plus coverage targets, dismissals by signature, vocabulary gaps to insights), gap-fed brief generation writing `origin_gap_id`, the lock, invite token minting, and close detection with before and after counts.
`e2e/loop.e2e.mjs` drives the whole chain in one browser context across three role switches and prints the id chain: gap, brief item, asset, review action, published, usage event, gap closed.
Closure happens first on the paper trail (a human confirmed a published clip covers the item the gap produced) and only second on facet matching, so the flagship claim does not rest on model output.
An explicit editor request is never displaced by a scored gap during brief generation, because a request that vanishes without trace is worse than no request feature at all.

### 6. DONE: the AI query parser, on top of the deterministic floor

`src/app/editor/ai-search.ts` makes exactly one contribution: the synonym hop the floor refuses to guess at.
The floor runs first and always, the model is asked only about words it could not place, and a model mapping never overrules an exact lookup.
Asking is a button that only appears when something is unmapped, every mapping is a removable chip carrying the original words and the confidence, and what neither could place stays unmapped and still filters nothing.
See D27, and the editor run asserts the whole path including the undo.

The persistent index (`search_token`, `asset_facet`, `reindex_queue` with an incremental worker) is deliberately not built: the in-memory search is O(assets) over a library that fits in memory, and a persistent index whose invalidation is untested is slower to trust than a scan.
The stores exist in the schema for when the library outgrows that.

### 7. DONE: the rest

The creators roster (`src/app/views/CreatorsView.vue`, `src/data/scorecard.ts`, `src/app/manager/vetting.ts`): the vetting guess and the measured scorecard side by side, every rate showing its denominator, `unknown` where there is nothing to measure. See D32.
Snapshot export and import plus the eviction sentinel (`src/data/snapshot.ts`), which is the remedy for the one failure this product cannot design around. See D35.
Data health and the storage panel, the two page thinking doc (`docs/08-thinking.md`), the README demo walkthrough, and `e2e/run-all.mjs` so `npm run test:e2e` finally does what package.json always claimed.
The Capacitor config and the shell notes (`capacitor.config.ts`, `docs/09-shell-notes.md`), written blind and documented as untested. See D33 and D34.
The loopback sync adapter and the sync panel.
`src/app/sync/policy.ts` holds the merge rules from C.3 as data (seven primitives, one executor), `src/app/sync/loopback.ts` drains the outbox into a second IndexedDB database with its own `server_updated_at` clock and pulls back on a `(server_updated_at, id)` cursor, and `src/app/views/SyncView.vue` shows depth, per table counts, the real patch payloads, the cursors and the conflict list, labelled `Adapter: loopback`.
Local-only fields are now stripped at the outbox append, driven by `LOCAL_ONLY_FIELDS` in the schema.
`sync_conflict` is a new local-only store, so `SCHEMA_VERSION` is 2 and there is a second migration; see D29 to D31 and `qa/cases/sync.md`.
`/sync` and `/creators` are wired, so there are no placeholder routes left and the placeholder component is deleted.

## What is deliberately not built, and why

Each of these is a decision rather than a gap, and each is in the README with the same reasoning.

- **The Supabase transport.** The schema, the row level security and the merge policy are written; the loopback adapter exercises all of it for real against a second local database. What is missing is one HTTP client, and it is missing because U2 says nothing is deployed.
- **WebCodecs sample feeding.** The adapter calls `isConfigSupported` and then declines with `demux_unavailable`. A half written decoder that silently lands on the wrong frame is worse than one that declines out loud (D25).
- **The persistent search index.** See task 6.
- **The desktop shell and mobile native builds.** Configured, never run, and `docs/09-shell-notes.md` says so per claim with a source and a date. D34 gates any iOS build on export and import, which now exist.
- **Transcode.** The HEVC clip stays undecodable here and reads as such, with no sheet, no tags and no AI fields rather than a guess.

Findings filed by the tracks and not yet actioned: the seed vocabulary drift (manifest meta terms versus `src/ai/taxonomy.ts`), `ai_run.input_ref` missing from the local schema, seeded AI tags carrying `ai_run_id: null`, and the eligibility gate before vetting (QC-AI-061).

## Things that will bite, recorded so they only bite once

- `vitest` 2.x pins vite 5; with vite 6 you get two copies of vite and their plugin types collide. This project uses vitest 4. Do not downgrade.
- jsdom has no `Blob.text()`, no OPFS, no WebCodecs and no real video decode. `tests/platform/bytes.spec.ts` has a `readText` helper and an in-memory OPFS fake; reuse them rather than writing more.
- `Array.prototype.at` needs the ES2022 lib, already set in `tsconfig.json`.
- `ffmpeg-static` ships no ffprobe; `ffprobe-static` is installed separately and both generators use it.
- Fixtures and seed media are committed, so a fresh clone needs no media build and no network.
- The seed is generated at runtime, not committed as JSON. See D11 for why.
- Hydration deliberately bypasses the repository and writes no outbox entries. See D12.
- IndexedDB cannot index a boolean. Queryable booleans carry an `_i` mirror, written by the repository, and there is a test asserting no index touches a raw boolean.
- A row a session cannot see reads as absent, not forbidden, because distinguishing the two leaks existence.

## Definition of done for the submission

1. A working prototype a reviewer can feel, opening on a non-empty library in a few seconds with no key and no setup.
2. A public repo whose run instructions work from a fresh clone.
3. A thinking doc of at most two pages: the problem, the solution, where AI was used and where it deliberately was not, the decisions, the prioritisation, the next steps. It links to the reviews rather than compressing them.
4. The AI session history, which the account owner exports.
