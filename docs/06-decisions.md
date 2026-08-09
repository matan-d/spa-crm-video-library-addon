# Decisions log

Every open question is closed here, with the reasoning, so none of them come back as a question mid-build.
Anything in this file is settled. If a decision turns out to be wrong, it gets changed here first and the code follows.

## Resolved by the user

| # | decision | resolution |
|---|---|---|
| U1 | Stack | Vue 3, Vite, Pinia, TypeScript, Vitest, Capacitor, Netlify, Node 20 |
| U2 | Server | None, and no server storage. Everything on device. The Supabase path is fully designed and a loopback adapter exercises sync for real |
| U3 | Roles and form factors | All three roles fully capable in the browser on desktop and mobile |
| U4 | Desktop shell | Electron via Capacitor is designed, configured and documented, never built or run |
| U5 | Creator surface | Browser only, forever. No install, no account |
| U6 | Mobile native | Deferred. Capacitor config written, no device build, no device testing |
| U7 | AI at runtime | Never called. No API spend. `mock` is the only mode exercised; `replay` and `live` are implemented and unexercised |
| U8 | Mock authorship | Fixtures authored offline by a model looking at the real contact sheets, not emitted by template code, and deliberately imperfect |
| U9 | Seed media | Real free-licensed stock, re-encoded small and committed |
| U10 | Visual identity | The palette from the visual maps, where colour encodes responsibility. See `05-design-system.md` |
| U11 | Language | English only. No i18n layer, no RTL pass |
| U12 | Review docs in the public repo | They stay, and the thinking doc links to them |
| U13 | Storage vendor for the real version | Cloudflare R2 for bytes, Postgres for rows |
| U14 | Effort is not a constraint | Build the correct thing, reject only what is wrong rather than what is expensive |

## Resolved by me, with reasoning

**D1. Pipeline stage six is named `delivered`.**
"Footage In" read like a folder rather than a state. Both reviews and the schema already use `delivered`.

**D2. Frame count per contact sheet: capability sets the ceiling, duration sets the count within it.**

```
frameCount = clamp(3 + round(duration_s / 3), tier.frameFloor, tier.frameCeiling)
```

| tier | floor | ceiling | a 6s clip gets |
|---|---|---|---|
| `ample` (desktop, plenty of cores and memory) | 5 | 7 | 5 |
| `standard` | 4 | 6 | 5 |
| `constrained` (phone, low memory, thermally limited) | 3 | 3 | 3 |

This closes the contradiction the fixtures surfaced: the C2.D worked example showed 5 frames for a 6 second clip, while E.4a's `clamp(round(duration_s / 4), 3, tierMax)` gave 3 frames at *every* tier and only reached 5 above about 14 seconds.

Three reasons for resolving it this way rather than lengthening a fixture:

1. Real b-roll is mostly 5 to 30 seconds, so the old formula gave nearly every clip a 3 tile sheet. A tier system that never changes the answer is not a tier system.
2. Three frames is thin evidence for judging a clip against a brief item. Five gives beginning, middle, end and two intermediates, which is the minimum for "does this cover the shot".
3. The tier should express device capability, and capability is a ceiling on work, not a floor. A weak phone doing exactly three frames regardless of clip length is the honest behaviour; a long clip does not make a phone stronger.

`contact_sheet.layout` is therefore an enum over `1x3` through `1x7`, and `contact_sheet.policy_tier` records which tier produced a sheet so a constrained-tier sheet is identifiable and re-derivable later at a better tier.

**D3. The sheet is capped at roughly 1024px on the long edge, and this is a correctness requirement rather than a cost preference.**
Current Opus-tier vision reaches 2576px and thousands of visual tokens per image, which is the opposite of what a bounded classification task wants, and the serverless payload ceiling makes the cap a hard constraint. One composite tiled image per clip, never separate frames.

**D4. Effort per AI capability, and thinking stays on.**
`low` for classification-shaped calls (tagging, facet extraction, gap phrasing), `high` for the genuine judgement calls (vetting, brief matching), and nothing uses `xhigh`. Thinking is never disabled, because on this model disabling it has three separate documented failure modes including a 400 when paired with higher effort. Model tiering was considered and rejected in favour of a single-model architecture; that gets one line in the thinking doc so nobody assumes it was never considered.

**D5. Download is not usage.**
It is evidence of intent. Its errors are not random, so treating it as usage would bias a number attached to a real person's name and then feed vetting. Both signals are logged, with `rank_at_event`, and weighted separately, and there is an explicit confirmation moment for real use.

**D6. Pre-flight is four-valued: `pass`, `fail`, `unknown`, `skipped`.**
Absent evidence is `unknown`, never a failure, because a camera has no GPS receiver and failing a creator for using better equipment would be a real product bug. `unknown` never blocks, and it is never rendered as a pass. `skipped` means the rule could not run, which is a different fact with different UI.

**D7. Commit cadence.**
A commit at each completed track boundary, with all four gates green: tests, typecheck, lint, and any generator verifier. No commit on a red tree.

**D8. The parser never reads coded dimensions from `tkhd`.**
`tkhd` holds the aspect-corrected presentation size, which coincides with coded size only at square pixels. This surfaced as a real failure in `lowres_fail.mp4`, where a 480x854 encode wrote 478.88x854 into `tkhd`.

**D9. Netlify deployment.**
The build produces a static site that deploys with the committed `netlify.toml`. A live URL needs the account owner's Netlify auth, so if that never happens the submission still satisfies the brief: a fresh clone runs with `npm install && npm run dev`, no key and no network required. Not a blocker, and not a question.

**D10. The AI session history deliverable is committed raw, not summarised.**
It is in [docs/ai-session-history/](ai-session-history/README.md): the session log exactly as the tool wrote it, with one GitHub token redacted and the log truncated before the prompt that asked for the export. A written-up narrative would have been easier to read and worth less, because the deliverable's value is that the false starts and the four test failures that turned out to be bad tests are still in it. Nothing in the build depends on it.

## Standing rules that need no further discussion

- No fabrication: a clip with no contact sheet produces no `ai_run` row, no tags, and null AI fields. The enqueue guard refuses vision tagging without a `sheet_id`.
- Provenance cannot lie: a `mock` run cannot record a `model_id`, enforced by a check constraint and a local write guard.
- Determinism: no ambient time, randomness, or device reads outside `src/platform`, enforced by eslint.
- Visibility: enforced in one scoped repository with three session factories, never per component.
- Demo and live are separate databases, so fabricated data cannot reach a real backend.
- Soft delete only. A sync bug should cost a UI glitch, never footage.
- No index on a raw boolean, because IndexedDB silently returns nothing for one.

**D11. The seeded dataset is generated at runtime in TypeScript, not committed as JSON.**

The architecture review proposed committing the artefact so a reviewer sees byte-identical data to the README. That reasoning is sound, and this deviates for a stronger one: Node cannot import a TypeScript module, so a build time generator needs its own copy of the seeded PRNG, and two copies of a PRNG that can silently drift from the one the tests assert against is a worse problem than one second of boot time. The fixture generator hit exactly this and solved it with a text-comparison drift guard, which works for one small formula and would not scale to a whole dataset builder.

Determinism is unaffected, and is asserted: same seed, byte-identical rows every run. `tests/data/seed.spec.ts` compares two independent builds for equality.

**D12. Hydration is the one sanctioned bypass of the scoped repository.**

Seeded rows represent history, not work somebody did in this session, so they are written directly with `server_updated_at` already set and no outbox entries. Writing them through the repository would append about two thousand outbox entries and the app would open showing a large pending queue implying unsynced work that never happened. There is a test asserting the outbox is empty after hydration. Every write after boot goes through the repository.

**D13. The seeded access tokens store the real sha256 of two exported demo tokens.**

The rule is that a raw token is minted once, shown once and never stored; only its hash lands in `access_token.token_hash`.
Seeded history has no "shown once" moment, so the seed exports `DEMO_CREATOR_TOKEN` and `DEMO_EXPIRED_TOKEN` and stores their genuine sha256 hex.
The alternative was a placeholder hash, which would have forced the token resolver to special-case the demo, and a resolver with a demo branch is exactly the kind of lie this project bans.
With real hashes the resolver does one thing in one way: hash the URL token, look up `by_token_hash`, check expiry and revocation.
The e2e creator run and the demo invite link both open `/#/c/demo-creator-token` and exercise the production lookup.

**D14. The demo affordances ship enabled, defaulted in `vite.config.ts` rather than in a `.env` file.**

The role switcher and profile switcher are demo tools, not product features, so they are gated behind `VITE_DEMO_TOOLS` rather than compiled in unconditionally.
The default is true and lives in the committed vite config, because `.gitignore` bans every `.env` from the repository (the no-committed-keys rule) and a gate that depends on an uncommitted file fails closed for exactly the reviewer it exists for.
A real deployment sets `VITE_DEMO_TOOLS=false` in its build environment and the controls disappear.
The switcher is styled as a labelled demo strip, never as an account menu, so nobody mistakes it for evidence of access control that does not exist.

**D15. Until the triage inbox is a real surface, every staff role lands on the library.**

The definition of done says the app opens on a non-empty library in a few seconds.
Landing the manager on a placeholder triage page would fail that deliberately, so `roleHome('manager')` is `/library` for now and flips to `/triage` in the same commit that builds the inbox.

**D16. A mock `ai_run` may record `fixture_id`. The Postgres constraint in C2.A has to widen to match.**

The architecture review's check constraint requires `fixture_id is null` for a mock run.
That was written before U8 settled that the mock's responses are authored offline by a model looking at the real contact sheets and committed as fixtures.
Under U8 a mock run genuinely was served from a named committed fixture, and hiding which one removes the only route from a tag back to the answer that produced it, which is exactly the audit trail the rest of this design exists to keep.
So the local guard enforces the invariant that actually matters, `model_id is null` for mock, plus `simulated_model_id` present and `latency_source = 'simulated'`, and allows `fixture_id`.
The future `ai_run_provenance_ck` must be widened in the same way, or the first sync of a demo profile would be rejected by the database for telling the truth.
Recorded in `src/ai/meta.ts` at the guard itself, so nobody re-tightens it without reading why.

**D17. The mock takes no `Rng`. Every varying value is a pure function of `input_hash`.**

The obvious implementation is a seeded `Rng`, and it is wrong here.
An `Rng` advances with call order, so the same clip analysed second rather than first reports a different simulated think time, and a view that mounts twice produces two different `ai_run` rows for one input.
Deriving the think time from the input hash instead gives determinism that survives re-ordering, needs no injected state, and still varies enough that the UI is not built against one constant.
The one deliberate exception is the transient failure counter (a rate limit that clears on retry), which is per provider instance and documented, because "fails once and then succeeds" cannot be expressed as a pure function of the input and the UI has to handle it.

**D18. Mock has two honest paths, and the run row says which one answered.**

`authored-fixture-v1` is a fixture a model wrote while looking at the artefact.
`synthetic-v1` is output assembled by local code.
Both are `provider = 'mock'`, and the distinction is recorded in `provider_detail` rather than blurred, because they are different claims.
Query parsing needs it: the input space is every string an editor can type, and serving an authored parse for an unseen query would produce a filter unrelated to the words on screen, which is worse than no parse at all.
So the seeded queries get authored parses and everything else gets a synonym table lookup, which is also the warm path the caveats review recommends persisting.
Gap phrasing needs the same escape for a computed cell nobody authored, and a partly authored batch is recorded as `authored-fixture-v1-partial`.
A third value, `authored-fixture-v1-reused`, marks an authored answer served for a subject it was not written for: still a real answer in the right register, and honestly not an observation about that particular clip.

**D19. The live adapter ships constructed disabled, and the Netlify function is not in the repository.**

`createLiveProvider` defaults to `enabled: false` and throws `not_configured` before touching the network, so a demo cannot spend money by accident and the provider switch is a deliberate act rather than a consequence of a key existing.
The function itself is designed in the caveats review and is deliberately absent from this build: with no capture run and no live mode there is nothing to deploy, and a committed serverless function that has never run would be a fourth untested surface pretending to be a tested one.
The adapter's own error mapping is unit tested against an injected `fetch`, because an error map nobody has ever executed is a set of UI states nobody has ever seen.
`qa/cases/ai.md` QC-AI-056 and QC-AI-057 record what is therefore untested, blocked on the function and on API spend respectively.

**D20. The placeholder tile is a UI descriptor and never a stored artefact.**

The media charter asks for a generated placeholder tile as the third rung of the extraction chain, so the interface never breaks on an undecodable file.
The no fabrication rule and `expected_derivatives` in the fixture manifest require that `hevc.mov` has no contact sheet and no poster at all.
Both hold at once: `ExtractionResult.placeholder` carries a kind, a reason code, a headline, a remedy and the facts we do have, the interface renders that, and `derivative_state` stays `none` with no blob for anything to store.
A grey tile written into the blob store as a contact sheet would eventually be handed to a model, and a plausible tag on a clip nobody could decode is the least detectable and most damaging failure this product has.

**D21. The pre-flight reason code enumeration is a superset of the manifest's sixteen, and the GPS absence code is an inference.**

The sixteen codes in `manifest.context.reason_codes` are what the sixteen committed fixtures produce.
Eight more exist in the engine for inputs no committed file can be (an unparseable container, an unmeasurable duration, a runtime that answers "maybe", a brief with no visit date, a branch with no coordinates), because committing deliberately broken bytes is worse than synthesising them in a test.
A test asserts the manifest's set is a subset of the engine's, so the two cannot drift silently, and section 8.3 of `docs/media-pipeline.md` records that the eight belong in the committed enumeration when the schema owner next touches it.

Separately: the three `no_gps_atom_*` codes cannot be distinguished from the bytes, so the engine infers between them from the only signal available (a still, an all intra professional codec, or anything else).
They differ only in the sentence a human reads.
Status is `unknown` and blocking is false in all three, asserted by a test, and nothing in the interface may state which of the three actually happened.

**D22. The visit window is the visit day expanded by the window hours, interpreted in UTC.**

A visit is a day rather than an instant, so `visitWindow()` takes the whole visit day and expands it by `visit_window_hours` on each side, as arithmetic on an instant rather than a string comparison on a date.
A calendar day match would pass a clip shot at 23:59 on the visit day and fail one shot at 00:05 the next morning, which is the same shoot.
UTC rather than the branch's timezone, because the branch timezone is not available to the pre-flight layer and the consequence is bounded and stated: 23:00 local in San Jose is 06:00Z the next day, well inside a 24 hour window either way.
Recorded rather than hidden, with the closing move (pass the branch timezone into the context) written down in `qa/cases/media.md`.

**D23. Media kind is classified from the bytes, never from the extension or the MIME type.**

A PNG named `holiday.mov` with MIME `video/quicktime` is a still, and ingest treats it as one: `kind: 'photo'`, real dimensions from `IHDR`, and no video decode attempted.
The container walk's refusal is still recorded as its own true fact (`parse_failure: 'not_isobmff'`), because the two are different statements.
This is stricter than the QA case as originally written, which expected two failures, and the case was updated rather than the code weakened: an iPhone writes `.MOV` for two different codecs and Android writes `.mp4` for both, so a filename is never evidence.

**D24. The two decode adapters that touch the DOM are deliberately not written yet, and the seam is named.**

`DecodeAdapter` is the interface, the chain around it is complete and asserted against fakes (the frame plan, the fallback order, blank detection, tiling, the long edge cap, hashing, the memory discipline), and the `<video>` plus canvas and WebCodecs implementations are absent.
jsdom has neither video decode nor a canvas rasteriser, so writing them here would produce the least trustworthy code in the pipeline with no automated coverage at all, and the WebCodecs path is the one that claims frame accuracy.
The consequence is stated everywhere it matters rather than buried: **no contact sheet has been produced by this code yet**, `docs/media-pipeline.md` 7.6 says so, and every affected QA case now reads `Blocked-by: decode adapter` and is listed in `qa/manual-checklist.md`.

**D25. D24 is reversed for the element path, because the stated blocker turned out not to hold. The WebCodecs half stands.**

D24 deferred both adapters for one reason: no automated coverage was possible.
That reason was true of `vitest` and jsdom, and it is not true of this repository as a whole.
`e2e/_support/harness.mjs` drives a real Chromium, which has video decode, a canvas rasteriser and `VideoDecoder`, and `qa/manual-checklist.md` 1.1 already listed twelve cases as "automatable the moment the two decode adapters exist".
So the blocker was a statement about one test runner that had been generalised into a statement about the project.

What changes: the `<video>` plus canvas adapter, `encodeJpeg`, `decodeStill` and `probeMedia` are written in `src/media/browser/decode.ts` and exercised by `e2e/creator.e2e.mjs` against the committed fixtures, whose synthetic content is designed for exactly this (a travelling white box and a burned in timecode, so "five visibly different moments" is a checkable claim rather than a hopeful one).
The twelve cases in 1.1 move from the manual checklist into that run.

What does not change: the WebCodecs adapter still declines rather than decoding, and it records `demux_unavailable` when it does.
Sample feeding is a real body of work whose value is frame accuracy, the element path already produces correct sheets, and a half written decoder that silently lands on the wrong frame is worse than one that declines out loud.
`VideoDecoder.isConfigSupported` is still called, so the decline is informed rather than blind, and the diagnostic says the configuration was supported and the feeding is not implemented.

The consequence sentence in D24 is therefore now false in the browser and still true in `vitest`, which is the honest way to say it: **sheets are produced by this code in a real browser, asserted by the creator run, and no unit test produces one.**

**D26. The e2e runtime has no H.264 decoder, so the creator run asserts codec support against the runtime and everything else against the manifest.**

Measured, not assumed: the Playwright Chromium in this environment is the open source build without proprietary codecs.
`canPlayType('video/mp4; codecs="avc1.42E01E"')` returns the empty string and loading a committed H.264 fixture fails with `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`.
The fixture manifest's reference runtime is `chromium_desktop_windows_without_hevc_extension`, where H.264 decodes and only HEVC does not, so the two runtimes disagree about exactly one rule and about whether derivatives exist.

The creator run therefore splits its assertions by what each one depends on.
The six container derived rules (orientation, min duration, min resolution, capture date, near branch, duplicate) come from the bytes and are asserted against `expected_preflight` as before, because a parser is a parser on every runtime.
`codec_playable` and the presence of a sheet are asserted against the runtime's own probed answer, because they are statements about the machine rather than about the file.
This is the design the pre-flight engine already had: support is injected into the rule engine rather than computed inside it, and `runtime_dependent: true` on the manifest's HEVC entry said the same thing about one file that is now true of several.

The consequence for the decode proof is that H.264 cannot demonstrate the element path here, so `e2e/decode.e2e.mjs` generates a VP9 in MP4 clip at run time with the ffmpeg already in `devDependencies`.
VP9 in MP4 is a real ISOBMFF file, so it goes through our own atom parser rather than around it, and this Chromium decodes VP9, so the run exercises the same code path an iPhone clip takes on a Mac.
The clip is generated rather than committed because `public/fixtures/` is a sha256 verified contract about container gotchas, and a codec chosen to suit one CI machine does not belong in it.

**D27. The AI query parser is offered, never automatic, and it is asked only about the words the taxonomy could not place.**

The deterministic floor in `src/app/editor/search.ts` maps words to taxonomy terms by exact and underscore-joined lookup, and refuses to guess.
The model's contribution is exactly the synonym hop that floor will not make: "golden hour" is not in the vocabulary and never should be, because a taxonomy that grows a term for every phrase an editor might type stops being a taxonomy.

Three shapes follow from that, and each one exists because the alternative is a search box that lies.

The floor runs first and always, and the model is asked only about `unmapped`.
A term the floor resolved by exact lookup is already correct, and letting a model overrule a lookup trades a certainty for a guess.
`src/app/editor/ai-search.ts` therefore discards any proposed mapping whose words the floor had already placed, and there is a test that feeds it a provider deliberately trying to rewrite `hands` to `feet`.

Asking is a button, not a side effect of typing, and the button only appears when there is something unmapped.
An editor who types words the vocabulary knows gets a deterministic answer and no call at all, which is the overwhelmingly common case and the one where a model has nothing to add.

Whatever neither the floor nor the model can place stays unmapped, stays visible, and still filters nothing.
That list is the vocabulary's to-do list, and letting it filter would turn "we lack the word" into "we lack the footage", which is the one confusion that would poison the gap scan.

Below `MAPPING_FLOOR` (0.55) a proposed mapping is dropped rather than shown, because a chip an editor has to evaluate and reject is worse than no chip.
The seeded `morning light` to `daylight` fixture sits just above the floor at 0.58 on purpose: it is the mapping most likely to be wrong, it is shown, and it is removable in one click.

**D28. The scoped repository gains a write predicate, and the editor may create exactly one kind of `ai_run`.**

The allowlist could only say "this role touches this table", and the truth for the editor and `ai_run` is narrower: it writes exactly one kind of row.
Parsing a query through the AI seam has to leave a run row, or the provenance chip on the result points at nothing and Data Health undercounts the calls that were actually made.
But a `vet` run IS the creator's score, which the editor cannot even read, and a `vision_tag` run is the manager's curation record.

So `writable(session, store, row)` is added next to `visible`, called from `create` and from `patch`, and it throws a `ScopeError` rather than filtering.
Filtering is right on a read, because a row you may not see should read as absent.
A write has no such reading: there is no legitimate caller, so it fails loudly.
The `patch` check runs against the merged row, so a permitted row cannot be edited into a forbidden one.

This is the `WITH CHECK` half of the future row level security policy, written in the same place as the `USING` half, which is the whole reason visibility lives in one layer.
It is deliberately small: a predicate per table is a policy surface, and the point of one layer is that there is not much of it.

**D29. The loopback server is a second IndexedDB database per profile, and applying a pulled row is the second sanctioned bypass of the scoped repository.**

`src/app/sync/loopback.ts` drains the outbox into `astolia_<profile>_loopback_server`, which holds one object store per synced table plus a `server_meta` store carrying the server's own clock.
Per profile, because the profile is what makes a demo outbox structurally incapable of reaching anything real, and a shared loopback server would put fabricated rows one bug away from a live one.

The server clock is monotonic first and wall clock second: `max(previous + 1, clock.now())`.
A frozen `SeededClock` (every test) or a machine correcting NTP drift would otherwise reissue a timestamp, and a cursor built on a clock that can repeat a value silently loses every row written during the repeat.
One tick per push batch rather than per row, matching a Postgres transaction sharing one `now()`, which also means the `(server_updated_at, id)` tiebreak is exercised on every push instead of only in theory.

Pulled rows are written straight to their object store rather than through the repository.
Going through the repository would append an outbox entry per pulled row and echo every pull back at the server forever.
This is the same argument as D12 (hydration), and these two remain the only bypasses: everything a human does still goes through the front door.
`server_updated_at` and `rev` are copied across outside the merge, because `mergeRow` refuses those two fields from any patch, and a client that could write the pull cursor could hide its own rows from every other device with no error anywhere.

The ordinal ladders use the enum values that exist in `src/data/types.ts`, not the longer ones sketched in the architecture review C.3.
`review_status` is `pending < approved < rejected` (there is no `needs_fix` in this build) and `derivative_state` is `none < partial < ready` (there is no `failed` or `server_derived`).
The rule that matters survives both simplifications intact: rejected beats approved, and a more capable producer's derivatives cannot be erased by a device that has not made any.

**D30. A patch for a row the server has never seen is promoted to the whole local row, rather than failing.**

Seeded rows are history and hydration writes them with no outbox entries (D12), so the first thing the loopback server ever hears about a seeded clip is somebody approving it.
Sending only the changed field would create a server row that is one field and no clip.
Failing the entry instead would mean every action a reviewer takes on the demo dataset lands in the sync panel as an error, which teaches a reviewer that the sync design does not work when what it actually shows is that the seed predates the queue.
So the adapter reads the local row and sends that.
A patch with no row on the server and none on this device is a genuine defect and still fails loudly, with the entry marked `failed` and the reason on it.

**D31. Local-only fields are stripped at the outbox append, and a patch made only of them queues nothing at all.**

`LOCAL_ONLY_FIELDS` in `src/data/schema.ts` declares them per store (`upload_state`, `upload_offset_bytes`, `media_state`, `local_file_key` on `asset`), and `appendOutbox` applies it.
Stripping at the adapter instead would leave a per-device upload offset sitting in a queue labelled pending sync, which is a lie about what the device is doing even though nothing ever transmits it.
Outbox depth is a number a human reads to decide whether it is safe to close the tab, so an entry whose drain is a guaranteed no-op must not inflate it: a patch that carries nothing but local state is dropped before it is queued, while a create still queues because the row itself has to exist remotely.
The merge executor strips the same list again on the way in, because the two ends of a sync are written months apart and only one of them is ours in production.

Two consequences worth naming.
`sync_conflict` is a new local-only store, so `SCHEMA_VERSION` is 2 and there is a second migration.
Migration 1 was not edited to create it: `StoreSpec.since` records the version that introduced a store, each migration creates only its own, and a migration that rewrites its own history is one nobody can reason about on a database that already ran it.
And a conflict is a row rather than a toast, per C.3, because a notification gets dismissed and the disagreement is then found three weeks later inside a campaign.

**D32. The creators roster is built, and its argument is that the guess and the measurement sit next to each other.**

`/creators` was the last placeholder besides `/sync`, and the temptation was a contact list.
What it is instead is the second feedback loop's measured half: a fit score is a guess made before any work, reliability is what happened after, and putting them in the same row is what lets a manager notice the guess was wrong.

Every figure on the right is derived from rows by `src/data/scorecard.ts`, and every rate shows its denominator.
A rate with no denominator is `null` and renders `unknown`, never 0%, because a brand new creator scored zero would sort below one who genuinely delivers badly, which inverts the exact judgement the panel exists to support.
This is the same four-valued discipline as pre-flight, applied to a different absence.

Promise-kept counts only against a LOCKED brief, and only against `confirmed_brief_item_id`.
An unlocked brief is a draft, and holding a creator to a shot list that changed after they shot it is not a reliability signal.
Scoring off `ai_matched_brief_item_id` would spend the entire reason those are two columns.
Pending clips are excluded from the approval rate: counting an unreviewed clip as a rejection is the studio's backlog wearing a creator's name.

The panel keeps the stored `creator.scorecard` cache and flags where it disagrees, rather than silently preferring the derivation.
If the two differ then either the cache is stale or the derivation is wrong, and both are worth seeing.
The seed now computes the cache from the rows it seeded alongside, and leaves `creator-1` deliberately stale, so the drift path has data in the demo rather than only in a unit test.

Vetting itself never gates: `vetCreator` writes an advisory score and returns.
The visit tier band is computed in code from the reliability tier and passed as a closed list, and a suggestion outside the band is dropped rather than stored, because a model that can hand a full-day VIP visit to an unproven creator is a model with a budget.
A blocked creator is refused outright, since a model re-score reads as a second opinion on a decision the model was never part of.
And a re-vet never touches `fit_score_override`: a human decision is not something a later run revises.

`computeScorecards` lives in `src/data/scorecard.ts` rather than beside the view, because the seed writes the cache and the roster reads it, so both need the same arithmetic and a seed importing from `src/app` would invert the layering.
It is pure logic over row types, the same category as `signatureOf`.

**D33. The desktop shell keeps `@capacitor-community/electron`'s configuration shape, even though that project is now unmaintained.**

Discovered while writing `capacitor.config.ts` and verified on 2026-08-09: the package's own README states "This project is currently unmaintained" and recommends the Capawesome Electron platform instead.
Its latest published version is 5.0.1, it declares `@capacitor/cli >=5.4.0`, and the current CLI is 8.5.0, so it is also two majors behind.
U4 names Electron via Capacitor and does not name a package, so this is mine to settle.

We keep the community platform's shape, for three reasons.

1. What is being reviewed is a configuration and the thinking behind it, not a build. The `electron` key with `customUrlScheme`, deep linking off and no tray is the same set of decisions either way, and switching packages would change the file's location without changing a single judgement in it.
2. The alternative is not free of the same problem. Capawesome's platform puts its configuration in `electron/capacitor.electron.config.ts`, inside a generated project directory that does not exist here, so adopting it would leave this repository with no shell configuration at all to review.
3. Switching to a package we also cannot run would trade a documented unmaintained dependency for an undocumented untested one, which is worse: the first is a known risk and the second is an assumption.

What is recorded rather than hidden: P-14 above states the maintenance status, states that `npx cap add @capacitor-community/electron` on a Capacitor 8 project is unverified and may simply fail, and names exactly what changes on a move to Capawesome.
One thing does not change on that move and is worth repeating: that platform's context isolation and sandboxed renderer are documented as "enabled by default and not configurable", so the `contextBridge` preload contract in section 5.1 stops being the recommended route and becomes the only one.

**D34. No Capacitor iOS build ships before export and import plus the sentinel record exist.**

Capacitor's own storage guide says Local Storage "must be considered transient", that "the OS will reclaim local storage from Web Views if a device is running low on space", and that "The same can be said for IndexedDB at least on iOS (on Android, the persisted storage API is available to mark IndexedDB as persisted)".
The request to make `navigator.storage.persist()` work for a Capacitor app was closed as not planned.
Both checked 2026-08-09 and recorded as P-13 above.

This product keeps every record in IndexedDB by constraint, so on that one target the vendor documents our primary datastore as reclaimable, with no remedy available to us from the web layer.
An installed app that silently empties is worse than a browser tab that does, because a user has a mental model for "the browser cleared site data" and none at all for an app that forgets.

The decision is a gate rather than a redesign, because a redesign is not needed in order to be honest.
The gate is now met on the browser side: export, import and the sentinel are built (D35).
The sentinel record and snapshot export and import are already mandatory in `docs/01-architecture-review.md` B.2 for the browser's own eviction rules, and they turn total silent loss into a detected state with a recovery path.
So the gate costs nothing that was not already owed.
The longer term answer, if this target is ever taken seriously, is a native durable store behind the existing `ByteStore` and record seams, which is the platform port doing the job it was built for.

Nothing here changes U6: the config is written, the target stays deferred, and this is the condition attached to undeferring it.

**D35. Snapshot export and import exist, and a sentinel record makes eviction detectable rather than silent.**

Every record lives in IndexedDB by constraint (U2), and IndexedDB is evictable.
A browser under storage pressure clears it, and on iOS the vendor documents it as reclaimable with `navigator.storage.persist()` explicitly not planned (D34 and `docs/09-shell-notes.md` P-13).
There is nothing the web layer can do to stop that.
What it can do is refuse to lose the data silently, and that is the whole of `src/data/snapshot.ts`.

The sentinel is about 200 bytes in `localStorage` saying "this profile had a database, with this many rows, at this time".
localStorage and IndexedDB are cleared together by an origin data wipe but NOT by the storage pressure eviction that reclaims IndexedDB, so the pair separates three states that are otherwise identical on boot: a first visit, a normal return, and an eviction.
Without it the third is indistinguishable from the first, so the app would re-seed the demo over somebody's real work and call it a fresh start.

The verdict is computed in `bootApp` **before hydration**, and this ordering is the load-bearing part.
If the browser evicted the database and hydration then re-seeded the demo, a panel reading the row count afterwards would see a full database and report `intact`.
The loss would be real, complete and invisible.
There is a test that boots, discards the factory, boots again, and asserts `evicted` while `assetCount` is non-zero: if it ever fails, total silent data loss is back.

A rate of loss is not modelled, because IndexedDB eviction is all or nothing per origin.
Fewer rows than last time means somebody deleted things, and only "we had rows and now have none" is the browser's doing.
A sentinel recording an empty database never raises eviction either, because the live profile starts empty on purpose and a false alarm on the one profile holding real work is worse than a missed one on the demo.

The export carries records only.
Original bytes live in OPFS and a real library is tens of gigabytes, so a JSON snapshot inlining them would be unopenable; derived blobs are excluded because they are reproducible and a backup that doubles in size is a backup people stop taking.
The manifest states both exclusions in the file, so a restore reads as "records back, originals to re-upload" rather than as a complete backup that quietly is not one.

Import merges rather than clearing first.
A restore that emptied the database would turn a snapshot missing one table into data loss, after the point of no return.
Tombstones travel with the snapshot: dropping them would un-delete everything the moment two devices synced.
A file that is not a snapshot, or one from a newer schema, is refused before anything is written.
