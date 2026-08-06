# Review roster, boundaries, and how findings become tests

Six specialist agents, each owning one question, with boundaries drawn so no two own the same thing.
Definitions live in `.claude/agents/`.

## The roster

| agent | owns the question | boundary |
|---|---|---|
| `platform-matrix` | Does this work, and degrade honestly, on every runtime we claim to support, in both interface and logic? | where code runs, not whether a derivation is correct |
| `tenancy-guard` | Can any role see, infer, or write something it must not, and do our specs agree about that? | who sees what, not storage or sync |
| `qa-runner` | Is this actually true right now on this machine, and can I prove it repeatably? | implements cases, does not invent the spec |
| `ai-contract` | Is every AI capability honest, swappable, versioned, and identically shaped across live, replay and mock? | the AI seam, not the media that feeds it |
| `media-pipeline` | Given these bytes, is everything we claim true, and everything unknown marked unknown? | correctness of derivation, not per runtime behaviour |
| `loop-integrity` | Can we still prove, from the data alone, that the loop closed? | traceability, not the schema itself |

Deliberately **not** created yet: a submission reviewer for the deliverables (public repo, run instructions, two page thinking doc, AI session history, demo recording).
It only earns its place in the final phase, and adding it now would be a seventh voice with nothing to review.

## The overlap rules

The two places these agents could collide, settled in advance:

1. **Codecs and media APIs.** `media-pipeline` owns whether the derived facts and frames are correct. `platform-matrix` owns whether the technique is available on a given runtime and what happens when it is not. Media hands every "is this supported here" question to platform rather than answering it.
2. **Fabricated data.** `media-pipeline` guarantees a contact sheet is real or absent. `ai-contract` guarantees the model is never asked to describe a clip it could not see, and never invents tags for one. Both must hold for the HEVC hole to stay honest.

## Standing sources

Every agent reads these before reviewing anything, and may not contradict a verified finding in them without naming the source that overrides it:

- `docs/00-context-brief.md`, the product and the hard constraints.
- `docs/01-architecture-review.md`, the data model, storage, Supabase path, sync, demo mode, storage vendor, three role reality check, and the dependency ordered build.
- `docs/02-caveats-review.md`, failure by failure per UX surface, per AI capability, and per device.
- `docs/03-thread-audit.md`, every instruction given and where it landed.

## How a finding becomes a test

This is the part that makes the roster worth having rather than a pile of opinions.

Each reviewer writes findings to `docs/<domain>-findings.md`, and writes QA cases to `qa/cases/<domain>.md` in one shared format:

```
### QC-<DOMAIN>-<n> <title>
- Given: starting state, target runtime, fixture
- When: the action
- Then: the observable assertion
- Layer: unit | integration | e2e | manual-only
- Blocked-by: what makes it unrunnable here, or "none"
```

`qa-runner` implements every case that is not `manual-only`, and moves the rest into `qa/manual-checklist.md` with what a human would have to do.

Two rules:

1. A finding without a QA case is incomplete. If a failure mode cannot be asserted, say why in the case rather than omitting it.
2. Coverage is never implied. Anything untestable in this build (a real iPhone, a packaged Electron app, a live model call) is written down as a gap, not left silent.

## Hard constraints every agent inherits

- The prototype has no server and no server storage. Everything on device, with the Supabase path fully designed and a loopback adapter so sync is genuinely exercised.
- All three roles are fully capable in the browser on desktop and mobile.
- The creator surface is browser only, forever. No install, no account.
- The desktop shell (Electron via Capacitor) is designed and configured, never built or run, and documented as untested.
- iOS and Android handling is written blind, never device verified, and must degrade visibly.
- Creator visibility stays thin: own submissions plus a small manager flagged exemplar set.
- Effort is not a constraint. Recommend the correct build, not the cheap one, and reject things because they are wrong rather than because they are expensive.

## Style, all agents

No em dashes and no en dashes as punctuation.
In prose, start a new line after each sentence ending period.
