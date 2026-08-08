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
