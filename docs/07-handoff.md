# Handoff: where this is and what happens next

Read `CLAUDE.md` first. This file is the ordered task list, so the sequence cannot be mistaken.

Last pushed commit: the app shell (see git log).
Gates at that commit: 285 tests passing, clean typecheck, clean lint, 16 fixtures verified, boot e2e 44 passed with 0 pending.

## Resume in one line

> Read `CLAUDE.md` and `docs/07-handoff.md`, then continue at the first task marked NEXT. Do not ask questions: every decision is closed in `docs/06-decisions.md`.

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

## Possibly in flight, check before starting

Three specialist agents were working when this was written. Their output may or may not be in the commit you are reading. **Check `git log` and the tree before assuming any of it is missing or present:**

- `src/ai/**`: provider interface, the seven JSON schemas, the shared validator, the deterministic mock, the `replay` reader, the unexercised `live` adapter, and the `ai_run` writer whose enqueue guard refuses vision tagging without a `sheet_key`.
- `src/media/**`: the MP4 and MOV atom parser, the extraction capability chain, and the four-state pre-flight rule engine.
- `e2e/**`: the browser harness on the 432 Player convention, plus `e2e/_support/testids.mjs`, which is the selector contract the UI must implement.

If any of those directories is missing, that track was not finished and is yours to complete. The briefs are in this file's task list below.

## The task list, in dependency order

### 1. DONE: the app shell

`src/app/` exists: bootstrap (`bootstrap.ts`), the Pinia store (`store.ts`), the router with role guards and the `/#/c/:token` route (`router.ts`), session construction and the creator token resolver (`session.ts`), the demo tools strip, and a first honest library grid at `/library` that reads published assets through the editor scope and renders the committed posters.
The remount-on-role-switch rule is enforced by keying the router view on `store.viewKey` and asserted by a test that checks DOM element identity changes across a switch.
The seeded token hashes are now the real sha256 of `DEMO_CREATOR_TOKEN` and `DEMO_EXPIRED_TOKEN` (see D13), so `/#/c/demo-creator-token` resolves through the production lookup.
Staff roles land on `/library` until the triage inbox is real (D15).

### 2. NEXT: the editor surface, the most demoable one

Library grid reading published assets through the repository, with real posters from `/seed/posters/`. One search box as the primary interaction, facets as results-derived chips with counts (never a taxonomy tree), a clip sheet, bins, and the zero-result ladder ending in "add to next brief" which writes a `gap` row.

Desktop is a three pane layout, mobile is search plus grid plus sheet. Use the testids from `e2e/_support/testids.mjs`.

### 3. The manager surface

Triage inbox FIRST, then the kanban. The inbox is the real product and the kanban demos well, so building the kanban first is optimising for the demo over the user. Then the review queue: a frozen ordered list, keyboard driven on desktop, stale-row refusal, and `review_action` as the log that `asset.review_status` projects from.

The promise-versus-delivered diff must show the extras bucket, and it must show the AI over-claim the seed contains: the model matches a clip to an eighth brief item nothing covers, and the human correction reveals the true seven of ten.

### 4. The creator surface

Invite page with the brief as a checklist and consent acceptance (immutable, versioned, terms snapshotted). Upload page running local pre-flight before anything transfers, with a per-file verdict in plain language, and the live checklist against the locked brief. The HEVC case must degrade visibly: no sheet, no AI, approval disabled with a stated reason.

### 5. Search: D1 to D4

Index writers and the `reindex_queue` with an incremental worker, then retrieval and ranking, then the AI query parser producing a filter and ranking spec. The model's job is term-to-taxonomy mapping shown as removable chips (`golden hour` to `warm_light`), with unmapped terms surfaced explicitly. An unmapped term is a vocabulary gap and must never be counted as a content gap.

### 6. The loop: E1 to E5

Gap scan from real signals, gap-fed brief generation writing `origin_gap_id`, brief lock, the delivery diff, and gap close detection with a before-and-after count. **Do not leave this to the end by accident.** It looks like a reporting feature and it is the product thesis. If it slips, the submission is a pipeline with AI in it rather than a closed loop.

### 7. The rest

Loopback sync adapter and sync panel, then the env-gated Supabase adapter. Export and import snapshot. Data Health panel counting `ai_run` by provider, which is the direct answer to "is any of this real". Storage panel. Capacitor config and platform notes, no device build. Then the two page thinking doc and a demo script.

Also outstanding: `docs/platform-matrix.md` was commissioned and never delivered, so the platform capability matrix with a source and date per cell still needs writing by `platform-matrix`.

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
