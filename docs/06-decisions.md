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

**D10. The AI session history deliverable.**
That is the conversation itself, so exporting it belongs to the account owner. Nothing in the build depends on it.

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
