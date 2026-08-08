# spa-crm-video-library-addon

An add-on for a CRM where content creators can upload their latest content with ease, and content users can pull it in simple steps for video usage.

Concretely: it takes a creator from "possible collab" to "usable, tagged footage in the editors' library", and closes the loop, so what editors search for and cannot find becomes the next creator's shot list.

Built for the Astolia / Willow Glow AI Builder challenge.

> **Status: the loop runs.** All three role surfaces are built, the media pipeline derives real contact sheets in the browser, the simulated AI seam is exercised by the app itself, and the closed loop is proved end to end by an automated run that asserts the id chain from a failed search to a closed gap.
>
> Gates at the last commit: 742 unit and integration tests, clean typecheck, clean lint, 16 committed fixtures verified against their manifest, and 564 end to end assertions across seven browser runs with nothing pending.
>
> What is deliberately not built is listed under [Not built, on purpose](#not-built-on-purpose) rather than left for you to discover.

## Run it

Requires Node 20 or newer.

```bash
npm install
npm run dev
```

Then open the printed local URL. No API key is needed, and none is included in this repository. The demo database seeds itself on first load, so the library is already full when the page opens.

## See the loop in five minutes

The demo strip at the top right switches role. It is labelled `demo` and styled as a demo control on purpose: this build has no authentication, and a control that looked like an account menu would imply access control that does not exist.

1. **Editor.** Switch to `editor`. Search `hands warm light`: the chips under the box show what those words were understood as, `hands` and `warm_light`. Now search `lounge macro`. Nothing matches, and instead of an empty state you get the ladder: the term that was dropped to find near matches, the near matches themselves, and one button that turns the failure into a tracked request. Press it.
2. **Manager.** Switch to `manager`, open **Gaps**. Your request is there with its evidence. Open **Briefs**, press **Generate from gaps**, and the new brief's first item carries the note `from gap`. Press **Lock**, then **Create invite link**, and copy the link.
3. **Creator.** Open that link in the same browser. There is no account and no install. Agree to the usage terms, then choose a vertical clip from your phone or desktop. Everything is checked locally before anything is stored: orientation, duration, resolution, capture date, distance from the studio, whether it duplicates an earlier clip, and whether this browser can decode it at all. Say which shot it is, then send.
4. **Manager again.** Open **Triage**. The delivery is in `needs review`. Open it to see promise versus delivered, including the extras bucket. Press **Review**, then **Analyse the contact sheet**: the amber block is the simulated model's output, labelled `simulated` because the record says so, not because the app is in demo mode. Confirm which brief item it covers, approve, and publish.
5. **Editor again.** The clip is now in the library. Add it to the bin and press **Confirm use**: the receipt records the rank the clip held at that moment, which is the one relevance signal that cannot be reconstructed later.
6. **Manager, last step.** Back in **Gaps**, press **Detect closures**. Your gap is closed and names the clip that closed it.

That is the whole thesis: an unanswered search became a shot list, became footage, became a measurably closed gap.

If you would rather watch it happen without clicking, `npm run test:e2e` drives exactly that sequence in a real browser and prints the id chain.

| command | what it does |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | typecheck then production build |
| `npm test` | unit and integration suite |
| `npm run lint` | eslint, including the determinism bans |
| `npm run typecheck` | `vue-tsc --noEmit` |
| `npm run fixtures` | regenerate the engineered media fixtures, no network needed |
| `npm run fixtures:verify` | re-verify committed fixtures against their manifest |
| `npm run test:e2e` | every end to end run in a real Chromium: boot, editor, manager, decode, AI, creator, loop |
| `npm run test:e2e:boot` | just the boot smoke run |
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

## Not built, on purpose

Stated here rather than left to be discovered, because a proof of concept that hides its edges is not proving much.

- **No server.** Nothing is deployed. The Supabase schema, its row level security policies and the `security definer` RPC for creator tokens are fully written in the architecture review; the local scoped repository implements the same allowlists so the two cannot drift.
- **No live model call.** The `live` adapter is written and ships constructed disabled. `replay` is written and unexercised. `mock` is the only mode that runs, and it is exercised by the app rather than only by tests.
- **The WebCodecs decode path declines.** The `<video>` plus canvas path is built and produces real sheets. WebCodecs asks `isConfigSupported` and then declines out loud, because sample feeding buys frame accuracy and a half written decoder that lands on the wrong frame is worse than one that refuses.
- **The desktop shell and mobile native are configured and never built.** Written blind, documented as untested.
- **Search is deterministic, not yet indexed.** Term to taxonomy mapping, facets and ranking are real and tested; the persistent index and the AI query parser are the next track.
- **HEVC from an iPhone on a machine without a decoder gets no sheet, no AI and no invented tags.** It degrades to a labelled state with a stated reason. This is the one hole left visible on purpose.

## Layout

```
src/platform/     clock, rng, uuidv7, canonical hashing, the platform port, the capability probe.
                  The only place ambient time, randomness and platform globals are allowed
src/data/         schema, migrations, profile namespacing, the scoped repository and the outbox.
                  Demo and live are separate databases, not a row flag
src/media/        atom parsing, frame extraction, contact sheets, hashes, the four-state pre-flight engine.
                  src/media/browser/ holds the decode adapters that need a real browser
src/ai/           the provider interface, seven JSON schemas, the authored mock fixtures, replay, live, the ai_run writer
src/app/          the shell, the store, the router, and one directory per role surface
e2e/              seven browser runs, including the flagship loop run that asserts the id chain
public/fixtures/  engineered clips, one per container or codec gotcha, with a manifest of expected pre-flight results
public/seed/      the seeded library: real stock stills, frame-extracted contact sheets, three playable clips
scripts/          the fixture and seed media generators, plus their verifiers
docs/             the architecture review, the caveats review, the cross check, the design system
qa/               the QA plan and the case files the specialist reviewers write into
tests/            unit and integration suites
```

## Documentation

Start with [docs/08-thinking.md](docs/08-thinking.md), which is the two page version: the problem as I understood it, the four decisions that shaped the build, where AI is deliberately absent, and what I would do next.

The rest is written down rather than summarised:

- [docs/01-architecture-review.md](docs/01-architecture-review.md), the data model, storage tiering, the future Postgres schema with row level security, sync mechanics, and the dependency ordered build.
- [docs/02-caveats-review.md](docs/02-caveats-review.md), failure modes per surface, per AI capability and per device, with sources and dates, and every claim marked verified or inferred.
- [docs/04-cross-check.md](docs/04-cross-check.md), what survived independent verification, where the two reviews disagreed, and what that changed.
- [docs/05-design-system.md](docs/05-design-system.md), where colour encodes who is responsible: amber for model output, green for human decisions, neutral for measured facts.
- [docs/06-decisions.md](docs/06-decisions.md), every decision that was made and why, including the ones that were reversed and what evidence reversed them.
- [docs/platform-matrix.md](docs/platform-matrix.md), what each browser and shell actually supports, with a source and a date on every cell.
- [qa/PLAN.md](qa/PLAN.md), the test layers, the role end to end runs, and an explicit list of what cannot be tested in this build.
- [qa/manual-checklist.md](qa/manual-checklist.md), everything that needs a human, a device or a service this build does not have, so coverage is never implied.

## Media

Seeded library media comes from Pexels under a license permitting commercial use and modification with no attribution required. Attribution is recorded anyway in [docs/MEDIA-CREDITS.md](docs/MEDIA-CREDITS.md), because a product about usage rights should be able to say where its own media came from.
