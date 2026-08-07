# Context brief: Astolia / Willow Glow creator collab add-on

This is a 96 hour hiring challenge for an "AI Builder" role, due Aug 10 2026.
Nothing is built yet.
We are still in brainstorm and architecture.

## The business scenario (from the challenge PDF)

Astolia / Willow Glow is a growing multi branch wellness and beauty business, with a named branch in San Jose.
Their video editors need a constantly growing library of authentic raw footage (b-roll) for marketing.
One way they want to produce it: collaborations with content creators.
The creator gets a free VIP experience at one of the branches, and in return delivers agreed raw footage.
The goal is a repeatable process that lets the team run these collabs efficiently while continuously growing a quality raw content library.

## The challenge

Imagine joining as an AI Builder.
Their CRM already exists and is in use.
As a future roadmap item they want to explore adding a new capability to the CRM that helps manage the creator collaboration process.
Deliverable is a working prototype of how you would approach that capability.
No detailed spec is given on purpose.
The candidate decides: what the product does, who uses it, what gets recorded, what the workflow looks like, what is automatic, where humans matter, where AI creates real leverage, and how the produced content gets organized.

Explicit non goals stated in the brief: no need to build a full content management platform, no need to integrate with their existing CRM, no need to build production infrastructure.
Not production quality code.
AI must include at least one meaningful AI based capability.

Grading weights: product thinking 25%, AI thinking 20%, engineering 20%, UX 15%, execution 10%, builder approach 10%.

Deliverables: working prototype, public GitHub repo with run instructions, a max 2 page thinking doc, and the AI tool session history.

## Our chosen product concept

One tracked loop: takes a creator from "possible collab" to "usable, tagged footage in the editors' library".

Pipeline stages, with AI placement:

1. SOURCE (human): add creator or inbound application.
2. VET (AI-1): fit score 0 to 100, three plain language reasons, risk flags, suggested VIP tier. Human can override, override reason is stored.
3. BOOK (human): branch, date, VIP tier.
4. BRIEF (AI-2): generates 8 to 12 numbered shots, do and do not list, tech specs, usage terms, caption angles. Inputs include current library gaps, branch profile, creator style, deal tier. Human edits then LOCKS it. The locked brief is the contract and the QC yardstick.
5. VISIT (human): the VIP day happens.
6. DELIVERED (AI-3): creator uploads via public link, no login. Two layer intake:
   - Layer A, local pre flight, pure deterministic client code, no AI, no upload: read duration, videoWidth/videoHeight (orientation), file size, parse MP4/MOV atoms for creation date, rotation, and GPS when present, extract about 5 frames via video element plus canvas into a small contact sheet, hash frames for duplicate detection. Rule checks: vertical, min duration, min resolution, shot on the visit date, near the branch.
   - Layer B, AI on stills only: send the small contact sheet (not the video) to a vision model for shot type, room, subjects, light and framing quality score, one line description, tags, brand safety flag, then match delivered clips against the locked brief items and produce a promised versus delivered diff plus a draft nudge message for what is missing.
   Heavy originals only upload after local rules pass and the manager approves.
7. LIBRARY (human): approve or reject clip by clip, one tap publish into the library.
8. EDITOR (AI-4): plain language search over clip metadata, for example "calm morning light, hands, vertical, San Jose". Returns ranked clips, an auto collection, and an explicit note when the library has nothing for part of the request.

Feedback loops:
- AI-0 GAP SCAN: what editors search for and cannot find becomes the next creator's shot list. This is the loop that makes the system closed rather than linear, and the user considers it the most important AI usage in the product beyond filtering.
- Auto nudge when a delivery is short of the locked brief.
- Usage signal: clips actually used, plus the delivery record, become the creator scorecard which feeds back into vetting.

## UX so far

Mobile first, bottom tabs.
Manager app: PIPELINE kanban with 6 columns and a deal drawer (creator, brief, delivery review diff, actions), LIBRARY, CREATORS (score, past deals, reliability), GAPS/INSIGHTS (what to shoot next, per branch).
Editor: LIBRARY, one search bar plus clip grid, clip sheet with preview, tags, branch, used-in.
Creator: public link only, never sees the app. Invite page (VIP day, brief, accept and consent) and upload page (drop files, live checklist against the brief).

Three roles: collab manager, video editor, creator.

## Hard constraints from the user

- Stack: regular web stack plus Capacitor. The user's usual stack, plain web app wrapped with Capacitor.
- The prototype is a one pager with NO server and NO server storage. Local storage on device only.
- BUT: a fully planned, working-shaped connection path to Supabase for DB sync and multi device support must be designed now, even though nothing is deployed. The local model and the future Supabase schema should match one to one.
- Need a decision on where many videos would live in the real version (S3, Cloudflare R2, Backblaze B2, Supabase Storage), optimizing for cheap egress and easy fast preview on the editor side. Editors need quick preview, so cheap proxy/preview assets matter.
- iPhone and Safari and HEVC issues: implement everything needed end to end for iPhone nuances at the code level, but we will NOT test on iPhone and will NOT build a native iOS or Android app in this version. Theoretical coverage only, no device verification.
- Writing style rules for all output: never use em dashes or en dashes as punctuation, use commas, colons, parentheses or plain hyphens instead. In prose, start a new line after each sentence ending period.

## Later decisions (added during brainstorm)

- One app, one codebase, one Netlify deploy, one Capacitor wrap. Three role surfaces inside it: manager (sees everything, and is also the video selector/filter), editor (library across all creators plus editor tabs only, no deal terms or creator scores), creator (own submissions only, via a public token link, plus optionally a thin set of clips flagged shareable as good examples).
- Visibility scoping is enforced in ONE selector layer over the store, not scattered per component. In the prototype it is a UI level scope; it becomes Supabase RLS later. A role switch in the header doubles as the demo affordance.
- Tenancy model: one organisation with roles, plus a branch filter everywhere. Not branch scoped tenancy.
- AI: one vendor, one key, one model. Claude `claude-opus-5` for all five capabilities, varying `output_config.effort` per task rather than switching models. Structured outputs (JSON schema) on every call. Claude reads images natively and does not accept video, which is exactly why the local contact sheet design keeps us on a single service. No embeddings service and no vector DB: the model parses the query into a filter and ranking spec, and local code does retrieval over the tag index.
- Model calls go through a Netlify function so the key never ships in the bundle. netlify.toml already exists with the `/api/*` to functions redirect above the SPA catch-all.
- House stack confirmed from sibling projects: Vue 3 + Vite + Pinia + vue-router + Capacitor + Vitest, Netlify hosting, Node 20.
- DEMO / MOCK MODE: a layer over the real app. The AI engines will NOT be exercised for this submission, they will be simulated, but the production code path must be exactly as it would ship. So every AI capability sits behind one provider interface with interchangeable implementations (live Claude, replay of captured real responses, deterministic mock), the mock output is validated against the same JSON schema as the live path, and demo only UI (load demo delivery, scenario picker, role switch, reset) is behind a build flag so it is absent from a production build. Media fixtures (videos plus thumbnails) get generated once with ffmpeg-static and committed, so the repo clones and runs with zero setup and the same fixtures drive both the demo and the e2e tests.

## Settled after the reviews (2026-08-07)

- THIS IS A POC, not production, and it may become a real product later. So the code path is production shaped and the responses are simulated.
- NO API SPEND AT ALL. There is no capture run and no live call at runtime. `mock` is the only mode exercised. `replay` and `live` remain implemented and unexercised, because the seam is the point.
- The mock fixtures are AUTHORED OFFLINE BY A MODEL during the build (the `ai-contract` agent), looking at the real generated contact sheets, rather than produced by template code, so the output reads as a real model answering. Provenance is unaffected: `provider='mock'`, `model_id` null, `simulated_model_id` set, `provider_detail='authored-fixture-v1'`, and the UI badge still reads simulated.
- The authored fixtures must be deliberately imperfect: a spread of confidences including the middle band, a clip matching two brief items, an AI versus human disagreement, a rejected low confidence tag, a refusal, and a malformed response. Uniformly clean fixtures would produce a UI that cannot express real ambiguity.
- Pipeline stage 6 is named `delivered`, replacing the earlier "Footage In".
- Download is evidence of intent, not evidence of use. The usage signal that feeds the scorecard and the gap scan needs an explicit confirmation, and the two are never treated as the same fact.
- Pre-flight rules are four valued: pass, fail, unknown, skipped. Absent evidence is `unknown` and never rendered as a pass or a failure.
- Never disable thinking on `claude-opus-5`. Adaptive thinking stays on, `effort: low` for classification shaped calls, `high` for judgement, nothing uses `xhigh`.

## Settled 2026-08-07, second round

- SEED MEDIA: real free-licensed stock footage and stills (Pexels or equivalent, license permits commercial use with no attribution required), re-encoded small and committed. The library grid looks like an actual footage bank, and the authored AI fixtures are written against real imagery. Synthetic ffmpeg patterns are used ONLY for the 8 engineered pre-flight fixtures, where the content is irrelevant and the container is the point. Binary fetch from the sandbox is confirmed working, so no manual media drop is needed.
- VISUAL IDENTITY: the palette from the visual maps is the product palette, transcribed in `05-design-system.md`. Colour encodes responsibility: amber means a model produced it, deep green means a human decided it, neutral means a measured fact. Mis-coloured provenance is a defect, not a style choice.
- LANGUAGE: English only. No i18n layer, no RTL pass.
- The two large review documents stay in the public repo, and the two page thinking doc links to them rather than trying to compress them.
