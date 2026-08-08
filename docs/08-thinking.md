# The thinking

Two pages. Everything here links out rather than summarising, because the reasoning is already written down at length and compressing it would only make it less checkable.

## The problem, restated as I understood it

Astolia's editors need a growing library of authentic raw footage. One way to get it is collaborations: a creator receives a free VIP visit and delivers agreed footage in return. The brief asked for a CRM add-on to run that.

The thing I decided the brief was really asking is narrower and harder than "track collabs". A pipeline that moves cards from `source` to `library` is a week of work and solves nothing, because the failure it does not touch is this: **the studio has no idea what footage it is missing until an editor needs it and cannot find it, and by then the creator has gone home.** A CRM that tracks collabs beautifully and never learns from its own library is a filing cabinet.

So the product I built closes that circuit. What an editor searches for and cannot find becomes a tracked gap; the gap becomes an item on the next creator's brief; the delivered clip closes the gap measurably, and the closure names the clip that closed it. That chain is the product, and it is the one thing I made automatically provable: `e2e/loop.e2e.mjs` drives it in a real browser and prints the id chain from failed search to closed gap. If that run cannot pass, this is a pipeline with AI in it rather than a closed loop.

## The four decisions that shaped everything

**1. The measurements are code, and the model does only what code cannot.** Every pre-flight fact is deterministic: duration, coded dimensions, orientation, rotation, capture time, GPS distance, duplicate detection by perceptual hash, and whether this browser can decode the file. A model is never asked whether a clip is vertical, because a parser knows and a model can only guess. The model is used for three things: classifying unstructured content from a contact sheet, translating human language into structure, and judging fit under genuine ambiguity. All three are advisory, and none of them changes state on its own.

**2. Provenance is structural, not a convention.** `ai_run` is the spine: provider, prompt version and hash, input hash, schema version, the verbatim output. A `mock` run cannot record a `model_id`, so simulated output is incapable of claiming a model produced it. The "simulated" badge reads the asset's stored provenance, never the app's current mode, because a badge driven by mode lies the moment one library holds both mock and real rows. Where no contact sheet exists, there is no run, no tags and no AI fields at all: a plausible tag on footage nobody could decode is the least detectable and most damaging failure this product can have, so the `e2e/ai.e2e.mjs` refusal path is asserted harder than the success path.

**3. Absent evidence is not failure.** Pre-flight is four-valued: `pass`, `fail`, `unknown`, `skipped`. A camera has no GPS receiver, so "we cannot tell where this was shot" is `unknown`, it never blocks, and it is never rendered as a pass. Failing a creator for arriving with better equipment would be a real product bug, and a boolean cannot express the difference between "shot 8km away" and "this body has no receiver". This one shape propagates into the gate logic, the review UI, the creator checklist and the seed, which is why it was worth getting right before anything was built on it.

**4. Visibility lives in one layer.** A scoped repository with three session factories, a table allowlist, a mandatory predicate and a field projection per role. No component reads storage. The editor cannot read `creator` or `collab` at all: table invisibility beats column filtering because there is no policy left to get wrong. Those same allowlists are the written specification the future Postgres row level security implements, so the two cannot drift. A row a session may not see reads as absent rather than forbidden, because distinguishing the two leaks existence.

## Where AI is deliberately absent

Vetting proposes a fit score and never gates. Brief matching proposes a match and the human confirms or corrects it, in a different column, so match accuracy stays measurable. Gap phrasing writes an instruction; the gap itself is computed from real signals. Search parsing maps words to taxonomy terms shown as removable chips, and an unmapped term is surfaced rather than silently dropped, because "editors say words the taxonomy lacks" and "the library lacks footage" are different problems with different owners and conflating them would poison the gap scan with vocabulary noise.

A single model tier was chosen over routing by task. It was considered: the honest reason not to route is that this product's hard calls are judgement under ambiguity, and the cheap tier's failure mode there is confident wrongness, which is the most expensive failure available in a system whose whole claim is that it does not fabricate.

## What the seed proves, and why it is ugly on purpose

The demo dataset is generated deterministically at runtime and is deliberately imperfect: seven of ten brief items covered, three clips matching no brief item, a rejected clip whose blunt internal note is redacted for the creator, a duplicate pair caught by frame hash rather than bytes, a camera offload with no GPS reading `unknown`, an HEVC clip nothing here can decode, and an AI match a human corrected. A seed where every delivery is complete produces an interface that has never had to express ambiguity, and the first real delivery then produces states the UI cannot render.

The demo's visit date and branch coordinates are the fixture manifest's, so the sixteen engineered test clips pre-flight in the demo exactly as the committed contract says they must. The demo world and the test world are one world.

## What is not built, and why that is the honest answer

No server is deployed. No model is called. The WebCodecs decode path declines out loud instead of half-working. The desktop shell and mobile native are configured and never built. The persistent search index and the AI query parser are specified and not built; the deterministic search underneath them is real and tested. Each of these is listed in the README with its reasoning, and everything that needs a human or a device this build does not have is in `qa/manual-checklist.md`, so coverage is never implied.

Two decisions were reversed during the build, and the reversals are recorded with the evidence rather than quietly applied. The decode adapters were deferred on the grounds that no automated coverage was possible; that was true of the unit runner and had been over-generalised into a claim about the project, because the repository drives a real browser (D25). And the pre-flight thresholds were briefly hardcoded in a component, which would have accepted footage the agreed spec rejects; they now resolve from the spec key the brief names (D26 and `src/app/creator/tech-specs.ts`).

## What I would do next, in order

1. The persistent search index and the reindex queue, then the AI query parser on top of the deterministic floor that already exists.
2. The loopback sync adapter, which is where the conflict rules get exercised for real. The merge policy is already written as data rather than as `if` statements, and the band that matters is human curation: a stale device flipping a rejected clip back to approved and republishing footage a human killed for consent reasons is the worst bug this system can have.
3. Transcode, so the HEVC hole closes. Desktop shell first, because the bytes are already local.
4. The creator scorecard feeding vetting, which is the second feedback loop and the one that makes reliability a number rather than a memory.

## Where to read more

[docs/01-architecture-review.md](01-architecture-review.md) for the data model, storage tiering, the Postgres schema with row level security, and sync mechanics. [docs/02-caveats-review.md](02-caveats-review.md) for failure modes per surface, AI capability and device, sourced and dated, each claim marked verified or inferred. [docs/04-cross-check.md](04-cross-check.md) for what survived independent verification and what it changed. [docs/06-decisions.md](06-decisions.md) for every decision with its reasoning. [docs/platform-matrix.md](platform-matrix.md) for what each runtime actually supports, with a source and date per cell. [qa/PLAN.md](../qa/PLAN.md) for the test layers and what is honestly untestable here.
