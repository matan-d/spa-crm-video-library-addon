# spa-crm-video-library-addon

An add-on for a CRM where content creators can upload their latest content with ease, and content users can pull it in simple steps for video usage.

Concretely: it takes a creator from "possible collab" to "usable, tagged footage in the editors' library", and closes the loop, so what editors search for and cannot find becomes the next creator's shot list.

Built for the Astolia / Willow Glow AI Builder challenge.

> **Status: foundation.** The deterministic core, the local store, and the committed media are in place and tested. The role surfaces are not built yet. Progress is stated honestly here rather than implied.

## Run it

Requires Node 20 or newer.

```bash
npm install
npm run dev
```

Then open the printed local URL. No API key is needed, and none is included in this repository.

| command | what it does |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | typecheck then production build |
| `npm test` | unit and integration suite |
| `npm run lint` | eslint, including the determinism bans |
| `npm run typecheck` | `vue-tsc --noEmit` |
| `npm run fixtures` | regenerate the engineered media fixtures, no network needed |
| `npm run fixtures:verify` | re-verify committed fixtures against their manifest |
| `node scripts/build-seed-media.mjs` | re-fetch and rebuild the seeded library media, needs network |

Generated media is committed, so a fresh clone runs with no media build step.

## What this is

One tracked loop across eight stages, with four AI touch points and the feedback loop that closes it.

```
source -> vet -> book -> brief -> visit -> delivered -> library -> editor
           AI             AI                  AI                    AI
                           ^                                         |
                           +--- gap scan: unmet demand becomes the next shot list
```

Three roles share one dataset, each fully capable on desktop and mobile:

- **Manager** runs the pipeline, reviews deliveries against the locked brief, publishes to the library. Sees everything.
- **Editor** searches the library in plain language, collects clips, and turns a failed search into a shot request. Never sees creator scores or deal terms.
- **Creator** gets a token link, with no account and no install, and uploads against a checklist that says what is still missing while they are still on site.

## Decisions worth knowing before reading the code

**No server, and no server storage.** Records, tags, the search index and derived blobs live in IndexedDB. Original video bytes live in OPFS. `localStorage` holds about 50KB of preferences and nothing else. The Supabase schema, its row level security, and the sync mechanics are fully designed, and a loopback adapter exercises sync for real, but nothing is deployed.

**AI is simulated, and the seam is production shaped.** This is a proof of concept, so no model is called at runtime and there is no API spend. One provider interface has three implementations, `live`, `replay` of captured responses, and a deterministic `mock`, all validated against the same JSON schemas. Provenance is a database constraint rather than a convention: a mock run cannot record a `model_id`, so simulated output is structurally incapable of claiming a model produced it.

**Determinism is enforced by the linter, not by good intentions.** Ambient `Date.now()`, argument-less `new Date()`, `Math.random()`, `crypto.randomUUID()` and device-shaped reads such as `navigator.userAgent` are banned outside `src/platform`. Everything takes an injected `Clock` and `Rng`, so the seeded dataset and the tests are byte-identical on every run. One UUIDv7 generator serves both production and demo, using the 12-bit `rand_a` field as a monotonic sub-millisecond counter so ids still sort by insertion order under a completely frozen clock.

**Where AI is deliberately not used.** Every pre-flight measurement is deterministic code: duration, dimensions, orientation, rotation, capture date, location, duplicate detection. A model is never asked whether a clip is vertical. The model is used for three things only, and they are the three things code genuinely cannot do: classify unstructured content, translate between human language and structure, and judge fit under ambiguity, always advisory and never state-changing on its own.

**One thing is deliberately left broken, visibly.** iPhone HEVC copied to a Windows laptop cannot be decoded by any runtime this build ships, so that clip gets no contact sheet, no AI analysis, and no invented tags. It degrades to a labelled state with approval disabled and a stated reason, rather than to a black rectangle or a plausible guess. Local desktop transcode and server side transcode are both specified; neither is deployed.

## Layout

```
src/platform/     clock, rng, uuidv7, canonical hashing. The only place ambient time and randomness are allowed
src/data/         schema, migrations, profile namespacing. Demo and live are separate databases, not a row flag
public/fixtures/  engineered clips, one per container or codec gotcha, with a manifest of expected pre-flight results
public/seed/      the seeded library: real stock stills, frame-extracted contact sheets, three playable clips
scripts/          the fixture and seed media generators, plus their verifiers
docs/             the architecture review, the caveats review, the cross check, the design system
qa/               the QA plan and the case files the specialist reviewers write into
tests/            unit and integration suites
```

## Documentation

The thinking behind this is written down rather than summarised:

- [docs/01-architecture-review.md](docs/01-architecture-review.md), the data model, storage tiering, the future Postgres schema with row level security, sync mechanics, and the dependency ordered build.
- [docs/02-caveats-review.md](docs/02-caveats-review.md), failure modes per surface, per AI capability and per device, with sources and dates, and every claim marked verified or inferred.
- [docs/04-cross-check.md](docs/04-cross-check.md), what survived independent verification, where the two reviews disagreed, and what that changed.
- [docs/05-design-system.md](docs/05-design-system.md), where colour encodes who is responsible: amber for model output, green for human decisions, neutral for measured facts.
- [qa/PLAN.md](qa/PLAN.md), the test layers, the three role end to end runs, and an explicit list of what cannot be tested in this build.

## Media

Seeded library media comes from Pexels under a license permitting commercial use and modification with no attribution required. Attribution is recorded anyway in [docs/MEDIA-CREDITS.md](docs/MEDIA-CREDITS.md), because a product about usage rights should be able to say where its own media came from.
