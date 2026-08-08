# Working on this project

Read this first, then `docs/07-handoff.md` for exactly where to resume.

## What this is

A CRM add-on that takes a content creator from "possible collab" to "usable, tagged footage in the editors' library", and closes the loop: what editors search for and cannot find becomes the next creator's shot list.

Built for the Astolia / Willow Glow AI Builder hiring challenge. The business is a multi branch wellness studio with a named branch in San Jose. Their video editors need a growing library of authentic raw footage, and one way to get it is collaborations where a creator receives a free VIP visit and delivers agreed footage in return.

Graded on product thinking 25, AI thinking 20, engineering 20, UX 15, execution 10, builder approach 10. Product plus AI is 45 percent, so the reasoning matters at least as much as the code volume.

Full brief: `docs/00-context-brief.md`.

## Do not ask the user questions

Every open decision is closed in `docs/06-decisions.md`. Read it before proposing anything, because most "open questions" are already answered there with reasoning.

If something genuinely new comes up, decide it yourself, record it in `docs/06-decisions.md` with the reasoning, and carry on. The user has explicitly asked not to be asked. Stopping to ask is worse than making a defensible call and writing it down.

## Hard constraints, not negotiable

1. **No server and no server storage.** Records, tags, the search index and derived blobs live in IndexedDB. Original video bytes live in OPFS. `localStorage` holds about 50KB of preferences and nothing else. The Supabase schema, its row level security and the sync mechanics are fully designed, and a loopback adapter exercises sync for real, but nothing is deployed.
2. **No model is called at runtime, and there is no API spend.** `mock` is the only mode exercised. `replay` and `live` are implemented and unexercised, because the seam is the point. Mock fixtures are authored offline by a model looking at the real contact sheets, and must be deliberately imperfect.
3. **All three roles are fully capable in the browser on desktop and mobile.** Manager, editor, creator.
4. **The creator surface is browser only, forever.** No install, no account, token link.
5. **The desktop shell and mobile native are designed, configured, and never built or run.** Same honesty rule for both: written blind, must degrade visibly, documented as untested.
6. **English only.** No i18n layer, no RTL pass.
7. **Effort is not a constraint.** Build the correct thing. Reject things because they are wrong, never because they are expensive.

## Standing rules the code must keep

These are each enforced by a test, a lint rule, or a database constraint. If you break one, something fails rather than quietly rotting.

- **Determinism.** No ambient `Date.now()`, argument-less `new Date()`, `Math.random()`, `crypto.randomUUID()`, `performance.now()`, or device reads (`navigator.userAgent`, `hardwareConcurrency`, `deviceMemory`, `connection`) outside `src/platform`. Everything takes an injected `Clock` and `Rng`. Enforced by eslint.
- **Never branch on a device category or a user agent.** Branch on an observed capability from `probeCapabilities()`.
- **No fabrication.** A clip with no contact sheet produces no `ai_run` row, no tags, and null AI fields. The vision enqueue step refuses without a `sheet_id`. A plausible tag on a clip nobody could decode is the least detectable and most damaging failure in this product.
- **Provenance cannot lie.** `ai_run.provider` is `live`, `replay` or `mock`; a `mock` run cannot record a `model_id`. The "simulated" badge reads `asset.ai_provenance`, never the current mode, because a badge driven by mode lies the moment data is mixed.
- **Four-valued pre-flight.** `pass`, `fail`, `unknown`, `skipped`. Absent evidence is `unknown`, never a failure, because a camera has no GPS receiver and failing a creator for using better equipment is a real bug. `unknown` is never rendered as a pass.
- **Visibility in one layer.** A scoped repository with three session factories (`managerSession`, `editorSession`, `creatorTokenSession`), a table allowlist, a mandatory predicate and a field projection per role. No component touches IndexedDB directly. The editor never reads `creator` or `collab` at all.
- **Demo and live are separate databases**, not a flag on rows, so fabricated data cannot reach a real backend.
- **Never index a raw boolean.** IndexedDB cannot use `true` as a key and silently returns nothing. Queryable booleans carry an `_i` integer mirror. There is a test asserting this.
- **Soft delete only.** A sync bug should cost a UI glitch, never footage.
- **Never read coded dimensions from `tkhd`.** It holds the aspect-corrected presentation size, which matches coded size only at square pixels.
- **Colour encodes responsibility.** Amber means a model produced it, deep green means a human decided it, neutral means a measured fact. Amber on a human decision is a defect. See `docs/05-design-system.md`.

## Commands, and the gates

```bash
npm install
npm run dev              # dev server
npm test                 # vitest
npm run typecheck        # vue-tsc --noEmit
npm run lint             # eslint, includes the determinism bans
npm run build            # typecheck then build
npm run fixtures:verify  # committed fixtures against their manifest
```

**All four gates must pass before any commit: tests, typecheck, lint, and `fixtures:verify`.** Never commit on a red tree. Run the suite twice if you touched anything time or randomness adjacent, because a test that passes only once is a failure.

## Layout

```
src/platform/    clock, rng, uuidv7, canonical hashing, the platform port, the capability probe.
                 The ONLY place ambient time, randomness and platform globals may be read
src/data/        schema, migrations, profile namespacing. The scoped repository goes here
public/fixtures/ 16 engineered clips, one per container or codec gotcha, plus a manifest of
                 expected pre-flight results with tolerances
public/seed/     the seeded library: real stock stills, frame-extracted contact sheets, 3 clips
scripts/         fixture and seed media generators, plus their verifiers
docs/            the reviews, the decisions log, the design system, the handoff
qa/              the QA plan and the case files the specialist reviewers write into
tests/           unit and integration suites
```

## The specialist agents

Six are defined in `.claude/agents/` and travel with the repo. Use them for their domain rather than doing everything inline, and read `docs/AGENTS.md` for the boundary rules that stop them overlapping.

| agent | use it for |
|---|---|
| `media-pipeline` | atom parsing, frame extraction, contact sheets, hashes, pre-flight rules, fixtures |
| `platform-matrix` | every runtime, browser, OS and shell difference, in both interface and logic |
| `tenancy-guard` | role visibility, and contradictions between specs about who may see what |
| `ai-contract` | the provider interface, the schemas, prompt versions, and authoring the mock fixtures |
| `loop-integrity` | whether the closed loop is still provable from the data alone |
| `qa-runner` | turning the case files into real tests, running them, reporting reproductions |

There is also a `db-architect` skill for any schema, storage or sync design work.

A finding without a QA case is incomplete. Anything untestable in this build goes in `qa/manual-checklist.md` as a written gap, never left silently uncovered.

## Reference documents

- `docs/06-decisions.md` — every settled decision. Read before proposing anything.
- `docs/07-handoff.md` — the ordered task list and exactly where to resume.
- `docs/01-architecture-review.md` — data model, storage tiering, the future Postgres schema with RLS, sync mechanics, the dependency ordered build. 3,300 lines.
- `docs/02-caveats-review.md` — failure modes per surface, per AI capability and per device, sourced and dated, with each claim marked verified or inferred. 2,700 lines.
- `docs/04-cross-check.md` — what survived independent verification, and what it changed.
- `docs/05-design-system.md` — tokens and the colour-encodes-responsibility rule.
- `docs/media-pipeline.md` — fixture inventory and what the generator could not reproduce.
- `qa/PLAN.md` — test layers, the three role end to end runs, and what is honestly untestable.

## Writing style, everywhere

Never use em dashes or en dashes as punctuation. Use commas, colons, parentheses, or a plain hyphen.

In prose, start a new line after each sentence ending period. This applies to markdown, comments and commit messages.

Commit messages say what changed and why the choice was made, not just what was touched.
