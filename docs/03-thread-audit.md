# Thread audit: every instruction the user gave, and where it landed

One row per message in order. Status is CLOSED, CARRIED (decided, must survive into code), or OPEN (needs the user).

## 1. "i have a mission for you, brainstorm first... we are going to use our regular stack... connected to the git repo of this empty project"

- Brainstorm first, no code: honoured for the entire thread. CLOSED.
- Regular stack: confirmed from sibling projects as Vue 3 + Vite + Pinia + vue-router + Capacitor + Vitest + Netlify + Node 20. CARRIED.
- Empty repo on `master` with zero commits: confirmed. Only three files exist so far, all infrastructure: `.claude/skills/db-architect/SKILL.md`, `netlify.toml`. CARRIED.

## 2. "Regular web + capacitor stack.. the mission is attached as pdf. Again, no code, i want you to first fully understand the mission! go over the text, the title, the bullets on bottom... come back to me with a very short summary of a few words"

- PDF read in full including the bottom bullets: deliverables, grading weights (product 25, AI 20, engineering 20, UX 15, execution 10, builder 10), 96 hours. CLOSED.
- Short summary delivered. CLOSED.

## 3. "lets say in one sentance what this addon should do first"

- One sentence delivered: possible collab to usable tagged footage in one tracked pipeline, AI doing vetting, brief, tagging and search. CLOSED, and it is still the product thesis.

## 4. "how would you imagine the ux in a few words?"

- Two doors into one dataset. CLOSED, later expanded to three roles plus the wide editor surface.

## 5. "whats Footage In?"

- Explained. I recommended renaming the stage to Delivered or In Review and asked which. The user never answered.
- Resolution: the architecture review adopted `collab.stage = 'delivered'` throughout, so DELIVERED is the de facto decision. OPEN only as a label preference, zero cost to change.

## 6. "do a map of it and place ai where needed in pipeline, then a map in smaller resolution of each ai part, then a ux map of it all. Do it very simple with a preview of all"

- Three maps delivered, first as text then as the visual artifact. CLOSED.

## 7. "do the maps more visual..this is hard to read"

- Rebuilt as a published visual page with real SVG and phone mockups. CLOSED, and kept current through every later change.

## 8. "Gaps are very important and actual AI usage here except filtering.. Is there a way to get a selected yet not uploaded video file from a web browser and get its thumb... so its done offline first"

- Answered yes, with the full mechanism and the restriction list. CLOSED.
- Gap scan promoted to first class: it is now section F.3 of the architecture review as a six step pipeline, with `cell_signature`, dismissals that survive a rescan, and `origin_gap_id` wiring so the loop is measurable. CARRIED, and finding 3 says the two link columns cannot be added retroactively.
- The offline pre-flight was promoted further by the review: because iPhone HEVC only decodes on the iPhone, local extraction is the only place the computation can happen at all. It is architecture, not optimisation. CARRIED.

## 9. The long message: db architect skill, agent review, three role reality, caveats, iPhone theory only, QA plan, local storage plus planned Supabase, video storage decision

- Skill installed at `.claude/skills/db-architect/SKILL.md`. CLOSED. Note: the Skill tool did not register it mid-session, so the agent read it directly. It will register on the next session start.
- Architecture agent run. CLOSED, 2,759 lines.
- Caveats agent run. In progress at time of writing.
- Manager reviewing everything manually: answered with the collapse point (150 to 250 clips a week, 5 to 7 collabs) and a four part rule. CARRIED.
- Editor tags versus free search: answered free text first, facets derived from results, no taxonomy tree. Includes the correction that our own demo query is not a real editor query. CARRIED.
- Personal favourite ways of digging, fed back into search and tagging: answered with saved searches, buckets, pins, recents, `usage_event` including `rank_at_event`, and the four ranking upgrades plus the four vocabulary upgrades they enable. CARRIED.
- Dynamic and expandable data: section F confirms per growth axis, with migration mechanics and versioned AI outputs. CARRIED.
- Caveats per UX part and per AI part: caveats agent.
- Creator experience including iPhone and Safari: caveats agent, plus E.4 in the architecture review which says the 40 clip flow as described does not survive and gives the fix.
- iPhone handled theoretically only, no native build, no device test: held as a hard constraint through both agent briefs. CARRIED.
- QA plan with three role e2e and ready made video and thumbnail artifacts: pending, next step, fixture set already specified (8 engineered clips plus manifest with `declared`, `expected_preflight`, `tolerance`).
- QA built alongside the code: CARRIED as a working rule.
- Local storage, no server: honoured, and corrected in substance. `localStorage` is for about 50KB of preferences, IndexedDB holds records and blobs, OPFS holds video bytes. The literal instruction was wrong (about 34 clips before quota) and the intent is fully preserved. CARRIED.
- Planned working Supabase connection: full DDL, RLS per role, `security definer` RPC for the token surface, sync mechanics, and a `LoopbackAdapter` so sync is genuinely exercised with no server. CARRIED.
- Where many videos live: Cloudflare R2, verified independently against all four vendors. CARRIED.

## 10. "how many apps do we have? is manager also selector and filter of videos? which ai engine to use for each task... always prefer same service... Assume the final product will run on netlify so prepare one"

- One app, one deploy, one Capacitor wrap, three role surfaces. CLOSED.
- Manager is also the selector and filter: yes, assumed as instructed. CARRIED.
- One AI service: Claude only, `claude-opus-5` for all capabilities, effort varied per task, structured outputs on every call, no embeddings service and no vector DB. The rejection of embeddings is now argued on the numbers, not on preference. CARRIED.
- Netlify: `netlify.toml` written, matching sibling conventions, plus the `/api/*` to functions redirect above the SPA catch-all. CLOSED.

## 11. "also take care of multi tenancy... (dont overfloat feature here..thin ux)"

- Full visibility matrix per record type per role. CARRIED.
- Editor never reads `creator` or `collab` at all, table invisibility instead of column policies, with `asset.creator_credit` denormalised for the credit line. CARRIED.
- Creator sees own submissions plus at most six manager flagged exemplars, as two boolean fields rather than a share table, specifically so the feature cannot grow. Honours "thin". CARRIED.
- Enforcement in one scoped repository with three session factories and a 40 line test, not per component. CARRIED.
- Tenancy: one org with roles plus `app_user.branch_scope`, not branch as tenant. CARRIED.

## 12. "i also want mock/demo mode... it should be another layer over the actual apps... BUT the code must be perfect as production"

- One provider interface, three implementations (live, replay, mock), one shared JSON schema validating all three. CARRIED.
- Provenance is a database constraint: a mock run cannot claim a model produced it. Readable per tag, per asset, per dataset. CARRIED.
- Demo and live are separate namespaced databases, so demo data physically cannot reach a real backend. CARRIED.
- Determinism: injected clock and RNG, one UUIDv7 generator, `rand_a` as a monotonic counter, eslint ban on ambient time and randomness. CARRIED.
- Fixture media generated once with `ffmpeg-static` and committed, loaded through the exact same `ingestFile()` entry point as a real upload. CARRIED.
- Demo only UI behind `VITE_DEMO_TOOLS` so it is absent from a production build. CARRIED.
- OPEN: whether we spend a few dollars on one real capture run so the demo replays genuine model output instead of synthetic output. Infra is identical either way.

## 13. "about the editor ux, im not sure its enough for him..think if he needs more"

- Answered: facets and sort, a project bin with hand off, download as the usage signal, request a shot from a failed search, usage rights on every clip, hover scrub, and a wide three pane desktop layout for the editor only. Artifact updated with Map 3b. CLOSED.
- The architecture review independently reached the same place and added the match explanation line per tile, the zero result ladder, and `usage_event.rank_at_event`. CARRIED.

## 14. "let me know when its all finished..go over every thread prompt... review your final summary... and wait!"

- This file is that audit. In progress.

## 15. "i dont care about the hours" and "the hours are theoretical for us"

- Both agents re-briefed. Triage removed, replaced with a dependency graph and a phase order. Rejections restated as wrong engineering rather than expensive. CLOSED.
- Aug 10 2026 kept as the one real date. CARRIED.

## 16. "review and double pass it all when finished huh?"

- Verification pass: all four storage prices independently confirmed against vendor pages. Cross-check of the two reports and the fresh adversarial pass on anything unverifiable still to run.
