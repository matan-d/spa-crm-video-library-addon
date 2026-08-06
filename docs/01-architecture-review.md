# Architecture review and data design: Astolia / Willow Glow creator collab add-on

Reviewed Aug 6 2026.
Method: db-architect skill, review mode plus design mode.
Nothing is coded yet, so every finding here is cheap to act on and expensive to ignore.

**Scoping note.** Build effort is not a design criterion in this document.
Where something is excluded, it is excluded because it is the wrong engineering call, and the reason is stated (see G.4).
Three constraints do bind: the **Aug 10 2026 deadline** (so section G is a dependency-ordered build sequence, not a triage list), **no server and no server storage** in the prototype with the Supabase path fully designed (a product decision), and **creator visibility stays narrow** (own submissions plus a manager-curated exemplar strip, which is feature discipline rather than a cut).

**Target matrix.** All three roles get a full featured interface on desktop and on mobile.
Shells, all running the same Vite bundle:

| shell | roles | status for this submission |
|---|---|---|
| **Browser** (desktop and mobile) | manager, editor, **creator** | **the only runtime.** Built, exercised, demoed |
| **Desktop app** (Capacitor Electron) | manager, editor | **designed and committed, not built.** Platform port, Electron config, and platform notes written blind. No packaged app, no verification |
| **Mobile native** (Capacitor iOS and Android) | manager, editor | designed and committed, not built. Same honesty rule |

**The browser is the only runtime for this submission, so nothing in the shipped prototype may be resolved by a desktop capability.**
Section B stays exactly as strict as it would be if the browser were the only target forever: the iOS Safari quota, ITP eviction, `media_state='bytes_absent'`, the originals cap, the eviction ladder, and export/import are all mandatory and load-bearing, not transitional.
Desktop relaxations appear only as a per-platform capability table (B.4) describing what a future shell would unlock, marked as not exercised.

**Two constraints are now stated product decisions rather than assumptions.**

1. **The creator surface is browser only, forever.** No install, no account, both form factors, a token link in whatever browser they happen to have. There is no creator desktop client and no creator deep link into an app. Creators are external people, and a flow that needs them to install something is a flow that does not get footage.
2. **The HEVC-with-no-decoder hole is open in this build, not solved.** A creator on a Windows laptop with iPhone HEVC files produces an asset with real metadata and no contact sheet, and nothing in this prototype can produce one. It degrades visibly and honestly (E.4), and local desktop transcode plus server-side transcode are documented as the two resolution paths, as specification rather than demonstration.

The honesty rule for both untested shells matches the one the brief already sets for iOS: written at the code level, degrades visibly, and the thinking doc states plainly that it is untested.

---

## 0. Decisions first

1. **`localStorage` is the wrong store for this dataset and I am overriding that instruction.** It holds about 5 to 10MB, it is strings only, it is synchronous, and it has no indexes. It caps the demo at roughly 40 clips and stalls the main thread. The user's actual intent (no server, everything on device) is preserved: IndexedDB for records, thumbnails and the search index, OPFS for original video bytes, memory only for decoded frames, `localStorage` restricted to about 50KB of preferences.
2. **The top-level media noun is `asset`, not `clip`, with `kind` in ('video','photo','audio','doc').** Twenty minute decision now, painful migration later.
3. **AI tags and human tags never share a column.** Tag assignments are append-only edge rows carrying `source` ('ai','human','rule','import'). An AI re-run may only touch its own rows. This is the single highest-rework item in the whole review.
4. **`ai_run` is the provenance spine.** Every AI-derived field on any record is a projection of a current `ai_run`, versioned by `model_id` plus `prompt_key` plus `prompt_version` plus `prompt_hash`. Raw `output_json` is stored verbatim, always. Wiping every AI projection and replaying runs must rebuild the app exactly.
5. **The sync envelope ships on day one**, on every record: UUIDv7 id, `created_at`, `updated_at`, `deleted_at`, `rev`, `origin_device`. Plus a real append-only outbox and a per-table pull cursor. Adding Supabase later is then additive, not a rewrite.
6. **Pull cursors use a server clock column (`server_updated_at`), never the client's `updated_at`.** A device with a skewed clock otherwise makes rows permanently invisible. Silent data loss, cheap to prevent now.
7. **Cloudflare R2 for media bytes in the real version**, Supabase Postgres for rows. Zero egress at any volume is the only pricing that survives an editor scrubbing previews all day. About $12/month at 5k clips, flat.
8. **The manager will not review every clip past roughly 150 to 250 clips per week.** The review unit becomes the brief item, not the clip, plus earned creator trust tiers plus a narrow auto-approve rule plus a forced 10% QA sample.
9. **Free text search is the primary editor interaction**, facets are results-derived refinements, and the tag vocabulary is infrastructure for ranking and brief generation rather than the editor's front door. Do not build a tag browser tree.
10. **The creator uploads contact sheet plus metadata first, full bytes only after the manager wants the clip.** Roughly 8MB instead of 6GB for the review round trip. This is the best idea in the plan and the one most likely to get watered down under time pressure.
11. **Sync merge is patch-level outbox plus written per-table rules. CRDTs are explicitly rejected** as over-engineered for this product.
12. **The demo ships seeded**: `seed.json` plus real contact sheets plus two or three short H.264 MP4s, hydrated into IndexedDB on first load. No setup, no keys, no server, reviewable by a hiring panel in one click.

---

## A. Data model

### A.0 The sync envelope, on every table

Present from the first commit, locally and on the server, or section C becomes a rewrite.

| field | type | owner | notes |
|---|---|---|---|
| `id` | uuid (v7) | system | client generated, time-sortable, no coordination |
| `org_id` | uuid | system | one org today, multi-tenant RLS later without a rewrite |
| `created_at` | timestamptz | system | |
| `updated_at` | timestamptz | system | writer's clock, used for merge decisions only |
| `server_updated_at` | timestamptz | system | server trigger, the only valid pull cursor |
| `deleted_at` | timestamptz null | system | soft delete, always |
| `rev` | int | system | bumped locally per mutation, base for patch conflict checks |
| `origin_device` | text | system | which device wrote it last |

Ownership legend used throughout: **H** = human writes it, **AI** = a model writes it, **S** = system or deterministic code writes it.
Derived legend: **D** = derived and regenerable (safe to throw away), **R** = durable record (the only copy of a fact, must be exportable).

### A.1 `org`, `app_user`

`app_user` is **missing from the requested list and required**, because `saved_collection.owner_user_id`, `asset.reviewed_by`, and every per-user signal need a subject.

| field | owner | kind | notes |
|---|---|---|---|
| `id` | S | R | equals `auth.users.id` later |
| `role` | H | R | 'manager' \| 'editor' \| 'admin' |
| `display_name` | H | R | |
| `is_demo` | S | R | seeded users |

### A.2 `branch`

| field | owner | kind | notes |
|---|---|---|---|
| `name`, `address`, `city`, `timezone` | H | R | 'San Jose' |
| `geo_lat`, `geo_lng`, `geo_radius_m` | H | R | drives the preflight "near the branch" check |
| `rooms` jsonb `[{room_key,label,light_notes}]` | H | R | AI may propose additions, never overwrite |
| `brand_palette`, `signature_treatments` | H | R | brief generator input |
| `do_not_shoot` jsonb | H | R | internal, never exposed to a creator token |
| `target_coverage` jsonb | H/AI | R | expected cell list, bootstraps the gap scan before any search logs exist |

### A.3 `creator`

The vetting override is the first place a human and a model collide, so precedence is explicit.

| field | owner | kind | notes |
|---|---|---|---|
| `handle`, `display_name`, `contact_email`, `contact_phone`, `city`, `notes` | H | R | |
| `platforms` jsonb `[{platform,handle,followers,url}]` | H | R | |
| `source` | H | R | 'inbound' \| 'scout' \| 'referral' |
| `lifecycle` | H | R | 'lead' \| 'active' \| 'blocked'. `blocked` is sticky, see C |
| `style_summary`, `niche_tags` | AI | D | |
| `fit_score` 0-100 | AI | D | projection of `latest_vet_run_id` |
| `fit_reasons` jsonb (3 plain reasons) | AI | D | |
| `risk_flags` jsonb | AI | D | |
| `suggested_tier` | AI | D | |
| `latest_vet_run_id` | S | D | FK `ai_run` |
| `fit_score_override` | H | **R** | never LWW, never AI-writable |
| `override_reason`, `overridden_by`, `overridden_at` | H | **R** | audit trail for the override |
| `scorecard` jsonb | S | D | `{deals_completed,on_time_rate,promise_kept_rate,approval_rate,clips_delivered,clips_approved,clips_used,avg_quality}` |
| `reliability_tier` | S | D | 'new' \| 'proven' \| 'trusted', computed, see E1 for the exact thresholds |

`scorecard` is a denormalized projection with a `recomputeCreatorScorecard(id)` function.
Computing it on the fly per row would scan every collab and every asset per creator, which the creators list cannot afford.

### A.4 `collab` (the deal)

Named `collab` rather than `deal` because their existing CRM already owns the word "deal".

| field | owner | kind | notes |
|---|---|---|---|
| `creator_id`, `branch_id`, `owner_user_id` | H | R | |
| `stage` | H | R | 'source' \| 'vet' \| 'book' \| 'brief' \| 'visit' \| 'delivered' \| 'library'. Monotonic ladder, never LWW |
| `stage_entered_at` | S | R | drives "stalled past SLA" |
| `stage_history` jsonb append-only | S | R | |
| `vip_tier`, `visit_date`, `visit_window`, `comp_value_usd`, `notes` | H | R | `comp_value_usd` never exposed to a creator token |
| `brief_id` | S | R | current locked brief |
| `consent_accepted_at`, `consent_text_version`, `consent_ip_hash`, `consent_user_agent` | H/S | **R** | immutable once written, this is a legal record |
| `usage_terms_text` snapshot | H | **R** | snapshot, not a pointer, so later term edits do not retroactively change what a creator agreed to |
| `outcome` | H | R | 'completed' \| 'partial' \| 'ghosted' \| 'cancelled' |
| `counters` jsonb | S | D | `{promised,delivered,approved,pending_review,coverage_pct}` |
| `creator_display_name`, `branch_name` | S | D | denormalized for the kanban, IndexedDB has no joins |

### A.5 `brief` and `brief_item`

The locked brief is the contract and the QC yardstick, so it is immutable by construction rather than by convention.

`brief`

| field | owner | kind | notes |
|---|---|---|---|
| `collab_id`, `version` int | S | R | |
| `status` | H | R | 'draft' \| 'locked' \| 'superseded' |
| `locked_at`, `locked_by` | H | **R** | once non-null, content columns reject updates (DB trigger). Edits create version+1 |
| `generated_by_ai_run_id` | S | D | |
| `gap_scan_id` | S | **R** | which gap snapshot fed generation, the provenance half of the closed loop |
| `intro_text`, `do_list`, `dont_list`, `tech_specs`, `usage_terms_text`, `caption_angles` | AI then H | R | |
| `source` | S | R | 'ai' \| 'human' \| 'ai_edited' |
| `edited_fields` jsonb | S | D | which AI fields the human changed, this is free eval data for the brief prompt |

`brief_item` (the individual shot, the atomic contract unit)

| field | owner | kind | notes |
|---|---|---|---|
| `brief_id`, `seq` int (1..12) | S | R | |
| `title`, `instruction_text` | AI then H | R | |
| `required_shot_type`, `required_room`, `required_subjects` jsonb | AI then H | R | vocabulary slugs, not free text |
| `required_orientation` | AI then H | R | 'vertical' \| 'horizontal' \| 'either' |
| `time_of_day` | AI then H | R | 'morning' \| 'midday' \| 'evening' \| 'any' |
| `min_duration_s`, `min_width`, `min_height` | S default, H editable | R | preflight thresholds |
| `quantity_required` int, `priority` | AI then H | R | 'must' \| 'nice' |
| `origin` | S | R | 'ai' \| 'human' |
| **`origin_gap_id`** | S | **R** | which gap this shot closes. Without this field the closed loop cannot be measured later, at all |
| `edited_from_ai` bool, `edit_note` | H | R | |
| `fulfilled_count`, `status` | S | D | 'unmet' \| 'partial' \| 'met' |

### A.6 `delivery`

Multiple deliveries per collab, deliberately.
A real creator on poor signal will upload in three sessions, and a single-delivery model forces either data loss or a fake resume.

| field | owner | kind | notes |
|---|---|---|---|
| `collab_id`, `token_id` | S | R | |
| `started_at`, `submitted_at` | S | R | |
| `device_hint`, `app_version` | S | R | |
| `clip_count`, `total_bytes` | S | D | recompute, never sync-merge |
| `preflight_summary` jsonb | S | D | pass/fail counts |
| `ai_match_run_id` | S | D | FK `ai_run`, kind 'brief_match' |
| `nudge_draft_text` | AI | D | |
| `nudge_sent_at`, `nudge_channel` | H | R | sending is a human act |
| `status` | S/H | R | 'open' \| 'submitted' \| 'reviewed' \| 'closed' |

### A.7 `asset` (was `clip`)

The most important table, and the one where field ownership must be strict.
Four bands, and they must not be mixed into one flat blob.

**Band 1, origin facts, write-once, durable, not regenerable without the bytes** (owner S, kind R)

`kind` ('video','photo','audio','doc'), `collab_id`, `delivery_id`, `creator_id`, `branch_id`, `original_filename`, `size_bytes`, `mime`, `container` ('mp4' | 'mov' | 'mts' | 'mxf' | 'other'), `codec_video` (fourcc as found: 'avc1' | 'hvc1' | 'hev1' | 'apcn'/'apcs' ProRes | 'mp4v' | unknown), `codec_audio` ('mp4a' | 'lpcm' | ...), `duration_s` (null for photo), `width`, `height`, `rotation_deg`, `orientation` ('vertical' | 'horizontal' | 'square'), `fps`, `bitrate_bps`, `captured_at`, `captured_at_source` ('atom' | 'exif' | 'filesystem' | 'creator_stated' | 'unknown'), `gps_lat`, `gps_lng`, `gps_source` ('atom' | 'exif' | 'none'), `frame_hashes` jsonb (dHash per sampled frame, null when no decoder was available), `phash_primary`.

`captured_at_source` matters: a date from `File.lastModified` is not evidence, a date from `com.apple.quicktime.creationdate` is, and a date the creator typed in is a third thing (`'creator_stated'`) that is better than a filesystem guess and worse than an atom.
The UI must not present any of them as the same kind of fact.

The codec and container lists are open rather than closed because desktop offload is a first-class path now.
A creator uploading from a mirrorless body at the VIP location can hand us ProRes in MOV, AVCHD in MTS, or H.265 in MP4, and none of those are browser-decodable.
Storing the fourcc as found, rather than coercing it into a known enum, is what lets an unrecognised format be routed rather than rejected.

**Band 1b, decode capability, written by the probe** (owner S, kind D)

`client_decodable` bool (did a decoder exist in the shell that ingested this), `probe_result` jsonb (`{webcodecs: 'supported'|'unsupported'|'absent', canPlayType: ''|'maybe'|'probably', shell: 'browser'|'electron'|'native', probed_at}`), `needs_transcode` bool.

These are per-ingest facts, not per-asset truths: the same file is undecodable in Windows Chrome and decodable by a shell that ships its own ffmpeg.
So `client_decodable` records what the ingesting shell could do, and `derivative_state` in band 5 records what actually got produced.
Keeping those separate is what makes later enrichment by a more capable shell or by a server worker a normal state transition rather than a contradiction, and it is why the open HEVC hole in this build is a **pending** state rather than a corrupt one.

**Band 2, deterministic derived, regenerable from bytes** (owner S, kind D)

`preflight` jsonb, tri-state per rule, full shape in **A.19**.
Plus `preflight_version` int (now 2), `preflight_policy_tier`, and the indexable mirrors `preflight_blocking_fail_num` and `preflight_unknown_num`.

Booleans are the wrong shape here and were a defect in the original design: they cannot distinguish "this camera has no GPS chip" from "this was shot 8km from the branch".
See A.19.

**Band 3, AI derived, regenerable by replaying `ai_run`** (owner AI, kind D)

`ai_shot_type`, `ai_room`, `ai_subjects` jsonb, `ai_light`, `ai_framing_score`, `ai_quality_score`, `ai_description`, `ai_brand_safety` ('clear' | 'review' | 'block'), `ai_confidence`, `ai_matched_brief_item_id`, `latest_vision_run_id`, `latest_match_run_id`.
AI tags are **not** here, they are rows in `tag`.

**Band 4, human curation, never LWW, never AI-writable** (owner H, kind R)

`review_status` ('pending' | 'approved' | 'rejected' | 'needs_fix'), `reviewed_by`, `reviewed_at`, `reject_reason_code`, `reject_reason_text`, `confirmed_brief_item_id`, `is_hero` bool, `human_description_override`, `is_published` bool, `published_at`.

`ai_matched_brief_item_id` versus `confirmed_brief_item_id` is deliberate.
The AI proposes a match, the human confirms it, and the disagreement between the two columns is the accuracy metric for the matching prompt.
Collapsing them into one column destroys that measurement permanently.

**Band 5, storage and usage** (owner S)

`media_state` ('bytes_absent' | 'bytes_local' | 'bytes_remote'), `local_file_key` (OPFS path or, in a future desktop shell, an absolute fs path, `_local` namespace, never synced), `remote_object_key`, `poster_key`, `preview_key`, `sheet_key`, `upload_state` ('local_only' | 'queued' | 'uploading' | 'uploaded' | 'failed' | 'abandoned'), `upload_offset_bytes`, `used_count`, `download_count`, `last_used_at`, `review_conflict` bool.

Plus three fields that carry the derivative story, and they are **orthogonal to `media_state` on purpose**:

`derivative_state` ('none' | 'client_derived' | 'server_derived' | 'failed'), `derivative_producer` ('browser' | 'electron' | 'native' | 'server' | null), `transcode_priority` smallint, `derive_error` text.

"Where are the bytes" and "do we have pixels" are different questions, and collapsing them into `media_state` would be the modelling mistake that makes the open HEVC case unrepresentable.
An asset can legitimately be `media_state='bytes_local'` with `derivative_state='none'`, which is exactly the Windows-Chrome-plus-iPhone-HEVC case: we hold the file, we know its dimensions and duration and capture date, and we have no frame from it and no way to get one in this build.

`derivative_producer` matters for a reason beyond bookkeeping: a browser-derived sheet and a server-derived sheet are different inputs to the vision model, so `ai_run.input_ref` must name the sheet and `input_hash` must cover its shape, or a re-derivation will silently reuse a cached run computed from a worse sheet.

Every screen must render correctly at `media_state = 'bytes_absent'` using the poster alone.
That is not a degraded mode, it is the normal mode both locally (quota) and remotely (bytes live in R2).

### A.8 `contact_sheet` and `asset_frame`

Fully derived, fully regenerable, and the only thing ever sent to a vision model.

`contact_sheet`: `asset_id`, `layout` ('1x5' | '1x3'), `width_px`, `height_px`, `jpeg_quality`, `blob` (Blob in IndexedDB), `bytes`, `sheet_hash`, `generator_version`, `generated_at`.
`asset_frame`: `asset_id`, `sheet_id`, `seq`, `t_seconds`, `dhash`, `is_poster`.

The poster is stored as its own small Blob, separate from the sheet, because the grid loads posters at 40 per screen and must not decode a 1350px strip to show a tile.

### A.9 `tag_vocabulary` and `tag`

Two tables, and this split is non-negotiable.

`tag_vocabulary` (the curated term)

| field | owner | notes |
|---|---|---|
| `slug` | S | stable identity, never changes |
| `label` | H | display only, renames touch this and nothing else |
| `facet` | H | 'shot_type' \| 'room' \| 'subject' \| 'light' \| 'motion' \| 'mood' \| 'season' \| 'treatment' \| 'orientation' \| 'freeform' |
| `parent_id` | H | shallow hierarchy |
| `status` | H | 'proposed' \| 'active' \| 'deprecated' \| 'merged' |
| `merged_into_id` | H | merge follows the pointer at read time, no mass row rewrite |
| `aliases` jsonb | H/AI | search index reads these |
| `created_by` | S | 'human' \| 'ai' \| 'rule' |
| `definition_text` | H | what this tag means, so two people tag the same way |
| `usage_count` | S | derived |
| `embedding` | AI | reserved, unused in v1 |

`tag` (the assignment, an append-only edge)

| field | owner | notes |
|---|---|---|
| `subject_type`, `subject_id` | S | 'asset' \| 'brief_item' \| 'creator' |
| `vocab_id` nullable | S | null means an unmapped free tag |
| `raw_text` | AI/H | the literal string when unmapped, this is vocabulary growth input |
| `source` | S | 'ai' \| 'human' \| 'rule' \| 'import' |
| `ai_run_id` | S | which run produced it |
| `confidence` | AI | |
| `created_by_user_id` | H | |
| `removed_at` | H | soft removal, so a removal is a signal not an absence |
| `rejected_by_human` bool | H | **the highest-value training signal in the system** |

`rejected_by_human` means: a model proposed this tag, a human deleted it, and the next run must not re-add it.
Most designs drop this and then wonder why the model keeps making the same mistake.

### A.10 `ai_run` (the provenance spine)

| field | owner | notes |
|---|---|---|
| `kind` | S | 'vet' \| 'brief_gen' \| 'vision_tag' \| 'brief_match' \| 'search_parse' \| 'gap_scan' \| 'nudge_draft' |
| `subject_type`, `subject_id` | S | |
| `model_id` | S | e.g. 'claude-sonnet-4-5' |
| `model_params` jsonb | S | temperature, max_tokens |
| `prompt_key`, `prompt_version`, `prompt_hash` | S | 'vision_tag', '2.1', sha256 of the rendered template |
| `input_ref` jsonb | S | sheet ids, brief id, gap_scan id. References, not payloads |
| `input_hash` | S | dedupe key: same input plus prompt plus model means reuse the cached run |
| `output_json` | AI | **verbatim, always kept** |
| `status`, `error_text` | S | 'ok' \| 'error' \| 'refused' \| 'timeout' |
| `tokens_in`, `tokens_out`, `cost_usd`, `latency_ms` | S | |
| `is_current` | S | derived: max(`created_at`) per (subject, kind) |
| `superseded_by_run_id` | S | |

Immutable and append-only.
Re-running never overwrites, it inserts and flips `is_current`.
Keeping `output_json` verbatim is the trick that makes "add a new AI field later without migrating" free: a later prompt version's extra field is available retroactively for old runs without re-calling the model.

### A.11 `search_query_log`

| field | owner | notes |
|---|---|---|
| `user_id`, `role`, `session_id` | S | |
| `raw_query_text` | H | exactly what they typed, unnormalized |
| `parsed_filters` jsonb | AI | the query parser's output |
| `result_count`, `top_result_ids` jsonb (first 10), `latency_ms` | S | |
| `outcome` | S | 'clicked' \| 'zero_results' \| 'abandoned' \| 'refined' \| 'saved' \| 'downloaded' |
| `clicked_asset_ids` jsonb, `clicked_ranks` jsonb | S | **`clicked_ranks` is the relevance label** |
| `refined_from_query_id` | S | the refinement chain, a chain ending in abandonment is the strongest gap signal |
| `unmet_facets` jsonb | AI | which parts of the request had no coverage, both shown to the user and persisted |
| `branch_context` | S | |

Absence is tracked explicitly.
"No results for X" is a product signal, not an empty state.

### A.12 `saved_collection`, `collection_item`, `usage_event`

`saved_collection`: `owner_user_id`, `name`, `kind` ('manual' | 'saved_search' | 'ai_auto'), `query_text`, `query_filters` jsonb, `is_pinned`, `is_shared`, `last_opened_at`, `open_count`.
`collection_item`: `collection_id`, `asset_id`, `added_by` ('human' | 'ai'), `rank`, `note`, `removed_at`.
`usage_event` (**missing from the requested list and required**): `user_id`, `event` ('view_asset' | 'preview_play' | 'download' | 'copy_link' | 'add_to_collection' | 'reject_result' | 'pin' | 'dwell'), `asset_id`, `query_id`, `rank_at_event`, `dwell_ms`.

AI-4's auto collection is `kind='ai_auto'` with materialized items, so the result set is reproducible and citable rather than a transient render.

### A.13 `gap`, `gap_scan`, `gap_dismissal`

`gap_scan`: `ran_at`, `window_days`, `params` jsonb, `ai_run_id`. Gaps are an immutable snapshot per scan.
`gap`: `scan_id`, `branch_id` (null = global), `cell` jsonb `{shot_type,room,subject,time_of_day,season,orientation}` with null = wildcard, `cell_signature` (normalized hash), `demand_score`, `supply_effective`, `deficit_score`, `severity`, `signals` jsonb, `evidence` jsonb (real query ids and asset ids), `status` ('open' | 'assigned' | 'closing' | 'closed' | 'dismissed'), `assigned_brief_item_ids` jsonb, `closed_at`, `closing_asset_ids` jsonb, `computed_by_run_id`.
`gap_dismissal` (**missing from the requested list and required**): `cell_signature`, `reason`, `dismissed_by`, `dismissed_at`, `expires_at`.

Dismissal is keyed by `cell_signature`, not by `gap.id`.
Otherwise every new scan resurrects the gaps the manager already killed, and the feature becomes nagware that gets switched off in week two.

`evidence` is what makes a manager believe the number.
A gap with no "show me why" is a horoscope.

### A.14 `access_token` (missing from the requested list and required)

`collab_id`, `scope` ('invite' | 'upload'), `token_hash` (sha256, the raw token is never stored), `expires_at`, `max_uses`, `uses`, `revoked_at`, `created_by`, `last_used_at`, `last_used_ip_hash`.

### A.15 `review_action` (missing from the requested list and required)

`actor_user_id`, `scope` ('asset' | 'brief_item' | 'delivery'), `scope_id`, `decision`, `asset_ids` jsonb, `method` ('manual' | 'batch' | 'auto_threshold' | 'sampled_qa'), `note`, `created_at`.

`method` is load-bearing.
The moment batch approve or auto-approve exists, creator scorecards computed from `review_status` alone become garbage, and nobody will know why.
Recording how a decision was made is what keeps the quality metrics honest.

### A.16 `insight` (the generalization)

`subject_type`, `subject_id`, `kind`, `title`, `body`, `severity`, `score`, `evidence` jsonb, `ai_run_id`, `scan_id`, `status`, `dismissed_reason`.

New AI insight types later become new `kind` values with zero migration.
`gap` is a specialization of this pattern with its own indexes because it is queried differently.

### A.17 Local-only search structures

IndexedDB has no full-text index, so it is built explicitly.

`search_token`: `token`, `asset_id`, `field` ('description' | 'tag' | 'alias' | 'filename' | 'room' | 'shot_type'), `weight`. Built at write time from `ai_description` plus `human_description_override` plus vocabulary labels and aliases plus filename.
`asset_facet`: `asset_id`, `facet`, `value`. Denormalized for cheap exact intersection.
`reindex_queue`: `asset_id`, `reason`. Needed because a tag merge or alias change alters search results, and without invalidation merges appear not to work.

---

## A.18 Screen dry run, one query at a time

Every screen from the brief, with the actual access path.

**1. Manager kanban, 6 columns.**
`collab` cursor on index `by_stage_updated` (`stage`, `server_updated_at`), filter `deleted_at is null`.
Card renders from denormalized `creator_display_name`, `branch_name`, `visit_date`, `stage_entered_at`, `counters.coverage_pct`.
Answerable in one cursor.
Without the denormalized fields it is N+1 per card in a store with no joins.
**Note: the kanban is not where daily work happens, see E1.**

**2. Deal drawer, promise versus delivered diff.**
Query 1: `brief_item` on index `by_brief_seq` (`brief_id`, `seq`).
Query 2: `asset` on index `by_confirmed_item` (`confirmed_brief_item_id`).
Query 3: `asset` on index `by_collab_unmatched` (`collab_id`, `confirmed_brief_item_id`) for the extras bucket, because clips matching nothing are a real and common case the diff must show.
Query 4: `brief_item.origin_gap_id` to render "this shot closes gap: hands / San Jose".
Answerable in three cursors plus one lookup.
The unmatched bucket is the shape most diff designs forget.

**3. Library search grid.**
Tokenize the query, intersect `search_token` by `token`, score by weight and by `asset` priors, filter through `asset_facet` for orientation / branch / shot_type, and require `review_status='approved'` and `is_published`.
Loads posters only, at about 50KB each, never video.
At the thousand item state: cursor pagination at 60 tiles, IntersectionObserver for the rest, and `URL.revokeObjectURL` on unmount or the tab will grow until it dies.
Answerable.

**4. Clip sheet.**
`asset` by id, `contact_sheet` on `by_asset`, `tag` on `by_subject` (`subject_type`, `subject_id`) split into AI and human groups, `ai_run` on `by_subject_kind_current` for the "why did the AI say this" panel, `usage_event` on `by_asset` for used-in.
Answerable in five lookups.

**5. Creators list with scorecard.**
`creator` cursor on `by_reliability` reading the denormalized `scorecard` jsonb.
Answerable only because the scorecard is a maintained projection.
Computing it live would scan all collabs and all assets per row.

**6. Gaps tab.**
`gap` on index `by_scan_severity` (`scan_id`, `severity`, `deficit_score` desc), then `by_branch_status` for the per-branch view, minus anything whose `cell_signature` appears in `gap_dismissal`.
Answerable.

**7. Creator invite page.**
`access_token` by `token_hash` then `collab` then the locked `brief` then `brief_item` list then `branch`.
**This screen needs a shape we do not have: a redacted projection.** Raw records here would show a creator their own `fit_score`, their `risk_flags`, `comp_value_usd`, internal branch notes, and gap reasoning.
Decision: define `collabPublicView(token)` now as a pure allowlist function locally, so the future Supabase RPC has an exact contract to match.
Skipping this is the highest-rework item in the token area, because a leak here is a real incident, not a bug.

**8. Creator upload page.**
`access_token` then `delivery` (existing and open, so the session resumes) then `brief_item` checklist then `asset` on `by_delivery` with `preflight` and `upload_state`.
Answerable, and only because `delivery` is one-to-many and `upload_state` plus `upload_offset_bytes` exist.

**Screens needing shapes not in the requested list:** `app_user`, `access_token`, `usage_event`, `review_action`, `gap_scan`, `gap_dismissal`, `search_token` plus `asset_facet` plus `reindex_queue`, the `collabPublicView` projection, `contact_sheet` as a real Blob store, and `review_session` (A.20).
All are named above.

**Correction to screen 2, the deal drawer diff: it needs a third bucket, not two.**
The original design had matched items plus unmatched extras.
Desktop offload and undecodable codecs add a state where coverage is genuinely unknown rather than met or missed: an asset with `derivative_state='none'` has no sheet, so no vision run, so no proposed brief-item match, and counting it as either unmet or extra is wrong in both directions.
So the drawer has three buckets: **matched**, **extras** (`confirmed_brief_item_id is null` and a vision run exists), and **awaiting derivatives** (`derivative_state='none'`), plus a fourth value on `brief_item.status`: `'indeterminate'`.
Without that, an HEVC-heavy delivery from a Windows laptop reads as a total failure when it may be a perfect delivery nobody can see yet.

### A.19 Preflight as a tri-state, not a set of booleans

The original `preflight` shape was booleans, and that is a defect: a boolean cannot distinguish **"this was shot 8km from the branch"** from **"this camera has no GPS chip"**.
The first is a rule violation, the second is an absence of evidence, and showing a manager a red cross for the second is telling them a mirrorless body did something wrong by existing.

Desktop offload makes this the common case rather than an edge case.
A creator emptying a card from a mirrorless or DSLR at the VIP location hands us: **no GPS atom at all** (most bodies have no GPS receiver), **landscape by default**, files ten to a hundred times larger, camera-local timestamps with no UTC offset or no creation metadata whatsoever, and codecs outside the browser's reach entirely.

**Status is four-valued.**

| status | meaning | rendered as |
|---|---|---|
| `pass` | evidence exists and satisfies the requirement | green check |
| `fail` | evidence exists and **contradicts** the requirement | red cross, with the specific contradiction. **Only this** |
| `unknown` | the evidence does not exist | grey dash, with the reason in one clause. Never red |
| `skipped` | the rule does not apply to this `kind` | not rendered at all |

`unknown` versus `skipped` is a real distinction: "we could not tell" and "this does not apply" read differently to a human, and a photo has no duration to check while a DSLR clip has no location to check, and those are not the same situation.

**The shape:**

```json
{
  "version": 2,
  "policy_tier": "ample",
  "producer": "browser",
  "rules": {
    "orientation":    { "status":"fail",    "evidence":"coded_dims+tkhd_matrix",
                        "value":"horizontal", "required":"vertical" },
    "min_duration":   { "status":"pass",    "evidence":"mvhd", "value":18.4 },
    "min_resolution": { "status":"pass",    "evidence":"tkhd", "value":"3840x2160" },
    "capture_date":   { "status":"unknown", "evidence":"none",
                        "reason":"no_creation_atom",
                        "fallback":"file_mtime",
                        "fallback_value":"2026-08-04T18:22:00Z" },
    "near_branch":    { "status":"unknown", "evidence":"none",
                        "reason":"no_gps_atom_camera_has_no_receiver" },
    "duplicate":      { "status":"unknown", "evidence":"none",
                        "reason":"no_frames_no_decoder" },
    "codec_playable": { "status":"fail",    "evidence":"stsd+isConfigSupported",
                        "value":"hvc1", "reason":"no_decoder_in_shell",
                        "routes_to":"transcode" }
  },
  "rollup": { "pass":2, "fail":2, "unknown":3, "skipped":0, "blocking_fail":1 }
}
```

**Per rule, what happens when the evidence does not exist.**

| rule | evidence | absent means | status when absent | gate |
|---|---|---|---|---|
| `orientation` | coded w/h plus `tkhd` display matrix | dimensions are present in any parseable container, so absence implies the file is unparseable | `unknown`, and escalate a container-level `fail` instead | **blocking** on `fail` |
| `min_duration` | `mvhd` duration over timescale, or `HTMLMediaElement.duration` | fragmented MP4 sometimes reports 0 or `Infinity` | `unknown`, and prefer the decode-pass duration over the atom | **blocking** on `fail` |
| `min_resolution` | `tkhd` and `stsd` | as orientation | `unknown` | **blocking** on `fail` |
| `capture_date` | `mvhd` creation, `udta/©day`, `com.apple.quicktime.creationdate` | **common on camera offload.** Many bodies write no creation atom, or write camera-local time with no offset | `unknown`, `fallback:'file_mtime'` recorded but **never promoted** into `captured_at` | advisory, plus a creator prompt |
| `near_branch` | `com.apple.quicktime.location.ISO6709` | **the normal case for any dedicated camera.** No GPS receiver, no atom | **`unknown`, never `fail`** | **never blocking** |
| `duplicate` | pHash across the delivery and collab | needs a decoded frame, so absent whenever extraction was impossible | `unknown` | advisory |
| `codec_playable` | `stsd` fourcc plus `VideoDecoder.isConfigSupported()` plus `canPlayType` | could not determine support | `unknown`, treated as needs-transcode | **routes, never rejects** |
| `brief_match` (AI) | a vision run over the sheet | no sheet, no run | `unknown` | advisory, feeds `'indeterminate'` |

**Three rules that follow, and they are the point of the exercise.**

1. **`unknown` never blocks.** Only a `fail` on a blocking rule gates the original upload. A legitimate camera delivery from the VIP location must not be refused by a rule about a GPS chip that does not exist.
2. **`codec_playable: fail` is excluded from the blocking set**, and instead sets `upload_priority='required_for_transcode'`. This is the one failure where uploading the original is the only way to make progress, because nothing local can decode it. This is a direct correction to the E.4 gate as originally written.
3. **Never render `unknown` as a pass.** A grey dash reading "location not verifiable, camera has no GPS" is trustworthy. A green check that silently means "we did not check" is a lie that will matter the day somebody asks whether footage was really shot at the branch.

**The honest consequence, which is a product finding not a schema finding.**
`near_branch` was doing verification work that it can no longer be relied on to do.
For iPhone deliveries it is genuine evidence; for camera deliveries it is silent.
So the "was this really shot at our branch on the day" story has to rest on other things: the collab-scoped time-boxed token, `captured_at` where it exists, and (better than GPS ever was) the AI room classification checked against `branch.rooms`, because a treatment room is recognisable and a coordinate is only a coordinate.
State that in the UI rather than implying a verification that did not happen.

**What the creator sees versus what the manager sees, and the asymmetry is deliberate.**
The manager sees all four states.
The creator's checklist shows **only actionable items**: a `fail` gets "this is landscape, we need vertical"; `near_branch: unknown` gets **nothing at all**, because there is no action available and surfacing it would read as a problem they caused.
The one `unknown` worth surfacing to a creator is `capture_date`, because that they can answer: prompt "when did you shoot this?", default to the visit date, and write `captured_at` with `captured_at_source='creator_stated'`.

**Storage and indexing.**
`preflight_version` goes 1 to 2, with a real migration: map each old boolean to `{status: b ? 'pass' : 'fail'}`, except `near_branch: false` where `gps_source` is null or `'none'`, which becomes `{status:'unknown', reason:'no_gps_atom'}`.
That migration is the concrete example of the C.5 rule about writing the migration in the same commit as the field.
Indexable mirrors, per the IndexedDB no-boolean-keys constraint in C.5: `preflight_blocking_fail_num` and `preflight_unknown_num` (0/1), so the review queue can index "has a blocking failure" and "needs a judgement call" without a full scan.
In Postgres these are generated columns plus a partial index.

**Byte-budget correction to B.2.**
ProRes 422 at 1080p runs about 120 Mbps, roughly 900MB per minute, so a two minute clip is 1.8GB.
The originals cap must therefore be **byte-budgeted, not count-budgeted**: `maxLocalOriginalBytes` (default 2GB) replaces `maxLocalOriginals: 3`.
A count-based cap that was safe for three phone clips is not safe for one card offload.

### A.20 `review_session`, and `review_status` as a projection

Desktop review is keyboard driven, and that changes a data requirement rather than only a layout.

A tap-driven list can reorder between renders because the user re-picks visually every time.
A keyboard-driven queue has an **implicit cursor**: `j` and `k` to move, `a` to approve, and "next" must be well defined.
If a background sync lands three assets, or if approving one mutates the field the list is sorted by, the list reorders under the cursor and the reviewer approves the wrong clip.
That is a data-integrity bug caused by an interaction affordance, and the fix belongs in the model.

`review_session` (syncs, owner-scoped):

| field | owner | notes |
|---|---|---|
| `actor_user_id` | S | |
| `scope`, `scope_id` | S | 'delivery' \| 'brief_item' \| 'queue' |
| `ordered_asset_ids` jsonb | S | **frozen at session start**, write-once |
| `cursor_index` int | H | merges as `max` |
| `skipped_asset_ids` jsonb | H | set union on merge. Skips are not decisions, so they produce no `review_action` and are otherwise lost |
| `sort_key_used` | S | which ordering produced the frozen order |
| `pending_additions` jsonb | S | assets that arrived mid-session, offered explicitly, never injected |
| `device_started`, `device_last` | S | |
| `completed_at` | H | sticky |

**Four requirements this satisfies.**

1. **The order is frozen and stored.** Assets arriving mid-session go to `pending_additions` and are offered ("4 new clips arrived, add to queue?"), never spliced into a list somebody is walking. Impossible without persisting the order.
2. **The order needs a guaranteed-unique final tiebreak.** Sort by `(brief_item.seq, ai_quality_score desc, id)`. `id` is UUIDv7, so it is unique and time-ordered, and without it two assets with identical quality scores can swap between renders. This is the same tiebreak argument as the sync cursor in C.3, and it is the third distinct place UUIDv7 pays for itself.
3. **Never sort by the field being mutated.** Do not sort by `review_status`, because deciding an item would move it. Sort by the frozen order, and **dim decided rows in place rather than removing them**. Removing a row on decision is the worst thing a keyboard review UI can do, because everything below the cursor shifts by one.
4. **Decisions are idempotent.** A keyboard user will double-tap `a`. `review_action` gains `session_id`, with uniqueness on `(session_id, scope_id, actor_user_id)` for `scope='asset'`, so a repeated keystroke is a no-op rather than a second audit row skewing the `method` statistics.

**The model change this forces, and it is a genuine improvement:**
**`asset.review_status` becomes a projection of the `review_action` log rather than a directly written column.**
Undo then works by writing a compensating action (`decision='revert'`, `reverts_action_id`) and re-projecting, which a keyboard reviewer will need within the first minute.
It also simplifies C.3: merging an append-only log is trivial where merging a contested scalar is not, so the never-LWW rule for band 4 gets easier to honour rather than harder.

**Cross-device resumption: `review_action` alone is not sufficient, and the gap is precise.**
`review_action` records **what was decided**, not **where you were**.
Resuming a review started on a desktop and finished on a phone needs three things it does not carry: the frozen order, the cursor position, and the deliberately skipped set.
Hence `review_session` syncs.
The phone opens it and shows "resuming: 12 of 22 reviewed, 3 skipped", landing on `cursor_index`.

**Do not re-sort a live session across devices.**
A desktop queue wants density and brief-item grouping, a phone wants one hero at a time, but the order must stay frozen for the cursor to mean anything.
`sort_key_used` records which ordering was chosen, the device adapts **density only**, and a reviewer who genuinely wants a different order starts a new session, which is cheap.
Re-sorting on device switch would reintroduce exactly the cursor-drift bug the session exists to prevent.

---

## A2. Visibility scoping and multi tenancy

### A2.1 Is a branch a tenant? (answering D first, because it frames everything else)

**Decision: one organisation with roles plus an optional branch filter on the user. Not branch-scoped tenancy.**

Reasons, in order of weight:

1. The product's whole value is cross-branch. The library is deliberately pooled (editors search all branches), and the gap scan's most useful comparison is "San Jose has no morning reception footage but Palo Alto has twelve". Branch-as-tenant fights the product thesis directly.
2. A creator visits more than one branch over time. Org-per-branch duplicates the creator row, and then the scorecard and the vetting history fragment, which is the one thing that must accumulate.
3. Cost of being wrong later is one nullable column, not a migration.

The hook is modelled now and costs nothing: `app_user.branch_scope` jsonb, null meaning all branches, or an array of `branch_id`.
A branch manager later is `role='manager'` with `branch_scope=['<san-jose-id>']`, and the repository layer already applies it as a predicate.
Zero schema change, zero new role.

`org_id` stays on every row (it is already in the envelope from A.0), so genuine multi-tenant SaaS later is additive too.
For the 96 hour prototype: seed one org, three users (manager, editor, plus one branch-scoped manager to prove the mechanism), `branch_scope` null on two of them.
That is architecturally credible without building anything.

Reject explicitly: separate Supabase projects or schemas per branch, and a `tenant_id` distinct from `org_id`.
Both are real patterns and both are wrong here.

### A2.2 Visibility matrix

R = read, W = write, RW = both, `-` = no access to the table at all.
"own" for a creator means "reachable from the collab their token resolves to".

| record | manager | editor | creator (token) |
|---|---|---|---|
| `org` | R | R | - |
| `app_user` | RW | R self, plus reviewer `display_name` | - |
| `branch` | RW | R `name`, `city`, `timezone`, `rooms[].label` | R `name`, `address`, `city`, `timezone` (own collab's branch only) |
| `creator` | RW | **-** | R self, redacted (see below) |
| `collab` | RW | **-** | R own, redacted |
| `brief` | RW | - | R own, **locked version only** |
| `brief_item` | RW | - | R own |
| `delivery` | RW | - | RW own (create and append) |
| `asset` | RW | R where `is_published` and `review_status='approved'`, all branches and all creators, projected | R own submissions, plus R where `is_exemplar` |
| `contact_sheet`, `asset_frame` | RW | R for readable assets | R for own assets |
| `tag_vocabulary` | RW | R `status='active'`, W insert `status='proposed'` only | - |
| `tag` | RW | R all on readable assets, W own rows with `source='human'` | - |
| `ai_run` | RW | R only `kind in ('vision_tag','search_parse')` for readable assets | - |
| `search_query_log` | R all (the gap scan needs it), W own | RW own only | - |
| `saved_collection`, `collection_item` | RW own, R `is_shared` | RW own, R `is_shared` | - |
| `usage_event` | R all | W own, R own | - |
| `gap`, `gap_scan` | RW | R, plus W insert of an editor gap request | - |
| `gap_dismissal` | RW | - | - |
| `insight` | RW | R only where `subject_type='library'` | - |
| `access_token` | RW | - | - (the token authenticates, it never reads itself) |
| `review_action` | RW | - | - |

**Fields an editor must never see.**
The thin way to enforce this is not column filtering, it is table invisibility: **the editor never reads `creator` or `collab` at all.**
That removes `fit_score`, `fit_reasons`, `risk_flags`, `suggested_tier`, `fit_score_override`, `override_reason`, `scorecard`, `reliability_tier`, `creator.notes`, `contact_email`, `contact_phone`, `platforms[].followers`, `collab.comp_value_usd`, `vip_tier`, `collab.notes`, `outcome`, and all `consent_*` in one stroke, with no policy to get wrong.
The library does need a creator credit, so add **`asset.creator_credit`** (S, derived: display name plus handle, nothing else).
One denormalized string replaces a column-level policy, which is the correct trade at this size.
Still explicitly denied to editors even though the table is readable: `ai_run` where `kind='vet'` (that run *is* the creator score), `delivery.nudge_draft_text`, `review_action.*`, `branch.do_not_shoot`, and `asset.reject_reason_text` (internal bluntness).

**Fields a creator must never see.**
Their own `fit_score`, `fit_reasons`, `risk_flags`, `suggested_tier`, `scorecard`, `reliability_tier`, and `creator.notes`.
`collab.comp_value_usd`, `collab.notes`, `outcome`, `owner_user_id`.
Any other creator's row, any `gap`, any `ai_run`, any `review_action`, any asset outside their own delivery except `is_exemplar` ones.
And `asset.reject_reason_text` on their own clips: add **`asset.creator_facing_note`** (H, optional, manager-written) and show that instead.
"Framing sloppy, creator rushed it" is an internal note, and piping raw reject reasons to a stranger's phone is a real product mistake.

**Exemplar sharing, kept deliberately thin.**
Two fields on `asset`: **`is_exemplar`** bool (H, manager only) and **`exemplar_note`** (H).
Surface: one read-only strip on the invite page, max six items, poster plus preview, no creator credit, no tags, no branch internals, no search, no collections.
Reason for a boolean rather than a share table: a table invites a permissions UI, a boolean cannot leak by accident and cannot grow scope.
That is the entire creator-sees-others feature.

### A2.3 Where enforcement sits in the local prototype (answering B)

**Confirmed, with one correction.**
A role switch that "changes which views and fields render" is correct in intent and wrong in placement.
If the filtering lives in components it will leak, because the next component to be written will forget, and on a 96 hour build there will be a next component written at 3am.

**Decision: enforcement sits in exactly one layer, a scoped repository between the UI and IndexedDB. No component ever touches IDB directly.**

- `createScopedRepo(session)`, where `session = {role, user_id, branch_scope, collab_id?, token_scope?}`.
- Three session factories and only three: `managerSession(user)`, `editorSession(user)`, `creatorTokenSession(token)`.
- The repo applies three things on every read, in order: a **table allowlist** per role, a **mandatory predicate** per table per role (for example editor assets get `is_published && review_status==='approved'`, creator assets get `delivery.collab_id === session.collab_id || is_exemplar`), and a **field projection** per role (`projectAssetForEditor`, `projectAssetForCreator`, `collabPublicView`, `creatorSelfView`).
- Writes go through the same layer, which is also the only thing that appends to the outbox. One choke point for both scope and sync.
- The projection functions are the written specification that the future RLS policies and RPCs implement. Same allowlists, two runtimes. Write them once, reference from both, and the migration to real enforcement is a config change rather than a refactor.
- The creator route is a separate entry (`/#/c/<token>`) whose loader can only construct a `creatorTokenSession`, so there is no reachable code path from creator UI to a manager repo.
- One test file, about 40 lines, asserting per role that forbidden tables throw and that forbidden field names are absent from projection output. That test is the enforcement. Keys added to `asset` later fail the test unless someone deliberately allowlists them, which is exactly the behaviour you want.

**The honest statement for the thinking doc, confirmed as the user framed it:** in the prototype this is a client-side scope, bypassable by anyone who opens devtools, and it is not security.
Its value now is that the boundary exists in one file with a written contract, so Supabase RLS replaces it rather than being retrofitted around it.
Say that plainly in the doc, do not imply the prototype is secure, and do not build a permissions admin UI.
Role switching in the demo is a dev-only header control with three buttons, which also happens to be the fastest way to show a panel all three products in ninety seconds.

---

## B. Storage tiering for the prototype

### B.1 Translating "we will use local storage, not server storage"

The intent is right: nothing leaves the device, no backend to deploy.
The literal store named is wrong for almost everything in this app, so here is the per-kind assignment.

| data kind | store | why |
|---|---|---|
| active role, current user id, last route, theme, onboarding seen, seed version marker | **`localStorage`** | tiny, synchronous read on boot is actually desirable, about 50KB total |
| all records (`asset`, `collab`, `brief`, `tag`, `ai_run`, logs, gaps) | **IndexedDB** | needs indexes, cursors, hundreds of MB, structured values |
| contact sheets, poster frames, waveform peaks | **IndexedDB as `Blob`** | binary without base64 inflation, and they are cache-like |
| search index (`search_token`, `asset_facet`) | **IndexedDB** | needs a compound index and cursor intersection |
| original video bytes | **OPFS** (`navigator.storage.getDirectory()`), File System Access as a desktop-only alternative | streaming reads, no base64, no 33% inflation, no main-thread stalls |
| decoded frames, canvases, `ImageBitmap`, object URLs | **memory only** | expensive, must be released |
| nothing | server | there is no server in this version |

**Where plain `localStorage` is plainly the wrong tool, with the number:**
It is string-only, so a JPEG must be base64'd, which inflates it by about 33%.
A single 5-frame contact sheet at 480px is roughly 110KB as JPEG, so about 147KB as base64.
At a 5MB budget that is **about 34 clips**, at 10MB about 68, before the origin simply throws `QuotaExceededError` with no negotiation and no recovery.
It is also synchronous, so every read and write blocks the main thread, and a 5MB `JSON.parse` on boot is a visible freeze on a phone.
It has no indexes, so "vertical clips of hands at San Jose that nobody has used" means parsing the entire blob into memory on every keystroke.
A hiring panel scrolling a 40-clip demo would feel all three problems.

### B.2 Size math

**Per `asset` record, IndexedDB structured clone:**

| part | bytes |
|---|---|
| ids, envelope, timestamps | ~350 |
| band 1 media technical facts | ~300 |
| band 2 preflight jsonb | ~250 |
| band 3 AI scalars (description about 120 chars, scores, shot type, room, subjects) | ~700 |
| band 4 human curation | ~200 |
| band 5 storage keys plus usage counters | ~150 |
| `frame_hashes` (5 x 16 hex) | ~200 |
| structured clone overhead | ~350 |
| **total per asset row** | **~2.5KB, budget 3KB** |

**Per asset, everything else:**

| part | count | bytes each | total |
|---|---|---|---|
| `tag` rows | 12 | ~180 | 2.2KB |
| `search_token` rows | ~45 | ~90 | 4.0KB |
| `ai_run` rows (vision_tag plus brief_match, with verbatim `output_json`) | 2 | ~1.5KB | 3.0KB |
| `asset_frame` rows | 5 | ~120 | 0.6KB |
| `asset_facet` rows | 8 | ~80 | 0.6KB |
| **contact sheet JPEG** (5 frames at 270x480 tiled to 1350x480, q0.70) | 1 | ~110KB | 110KB |
| **poster JPEG** (480px long edge, q0.75) | 1 | ~45KB | 45KB |
| **non-video total per asset** | | | **~169KB, call it 170KB** |

The two blobs are 92% of it.
That ratio is the reason the metadata-first upload strategy in E4 works: the reviewable payload per clip is about 170KB, not 150MB.

**How many clips fit before quota pressure (metadata plus blobs, no originals):**

| clips | footprint |
|---|---|
| 100 | 17MB |
| 500 | 85MB |
| 1,000 | 170MB |
| 5,000 | 850MB |
| 10,000 | 1.7GB |

Desktop Chrome and Edge grant roughly 60% of free disk per origin, so 5,000 clips is uneventful.
Desktop Firefox is similar with a 10GB group cap.
**iOS Safari is the constraint**: historically about 1GB per origin, with the browser prompting or refusing beyond it, and a home-screen-installed PWA getting materially more headroom than a tab.
So the design target is: comfortable to 1,000 clips on any device, honest degradation beyond that.

**Originals, and why they cannot all be local.**
Average 150MB per clip.
40 clips is **6GB**, which will fail on a phone and is antisocial on a laptop.
One two-minute ProRes clip from a mirrorless body is **1.8GB** on its own, so the cap must be byte-budgeted rather than count-budgeted (see A.19).
Decision: `asset.media_state` is authoritative, the prototype keeps originals in OPFS up to **`maxLocalOriginalBytes`, default 2GB**, for the live preview demo, and everything else is `bytes_absent` and renders from its poster.
This is not a workaround: `bytes_absent` plus poster plus preview key is exactly the state every record will be in once bytes live in R2, so the local prototype and the real system share one render path.

**Quota management, concretely.**
Call `navigator.storage.persist()` on first meaningful interaction and store the boolean result.
Call `navigator.storage.estimate()` and surface `usage / quota` in a Settings panel with a real progress bar.
At 80% of quota, stop writing new contact sheets and start evicting them oldest-first, because they are regenerable from bytes and are the largest regenerable thing.
Eviction order when pressure hits: contact sheets, then `search_token` (rebuildable), then `ai_run.output_json` for non-current runs, then OPFS originals.
Never evict: `asset` band 1 and band 4, `review_action`, `consent_*`, `tag` rows with `source='human'`, `gap_dismissal`.

**What happens when the browser evicts storage.**
Without `persist()` granted, the origin's storage is "best effort" and the browser may clear IndexedDB and OPFS together under disk pressure, and Safari's tracking prevention clears script-writable storage for sites without recent user interaction (historically a seven-day window for non-installed sites).
So the failure mode is total, silent, and not hypothetical.
Two mitigations, both required:

1. **`persist()`** plus a visible storage panel, so the state is at least known.
2. **Export and import, one click each.** "Export snapshot" writes one JSON file containing every record (no blobs), plus a zip variant including sheets and posters. "Import snapshot" restores it, running it through the migration chain so an older snapshot still loads. This is the only thing that makes the durable record actually durable in a no-server build, and it is the same code path as seeding, so it is exercised on every cold start rather than only when someone clicks it. Build it.

The rule this enforces: derived data may be lost freely, durable record must be exportable.
If `output_json` is dropped to save space you lose the ability to re-project AI fields without re-calling the model, so `ai_run` for current runs is durable, superseded runs are evictable.

### B.3 How seeded demo data ships

The panel must see a full library in one click, with no keys, no upload, no server, no build step beyond `npm i && npm run dev` (or just the deployed static URL).

Ship in the repo under `/public/seed/`:

- `seed.json`, about **40 to 60 assets** across two branches plus 6 creators plus 5 collabs at different stages plus 3 briefs (one draft, one locked, one superseded) plus **200 to 400 `search_query_log` rows including real zero-result and refine-then-abandon chains** plus the `ai_run` rows that produced every AI field. Roughly 1.5 to 2.5MB of JSON, gzipped by the host to a few hundred KB.
- `sheets/*.jpg` and `posters/*.jpg`, real images, 40 to 60 of each, about **6 to 9MB total**.
- `video/*.mp4`, **two or three clips, 6 to 10 seconds, H.264 baseline plus AAC, faststart**, about 1 to 3MB each. H.264 specifically so Safari plays them without a transcode. These are the only clips with `media_state='bytes_local'`.

Boot behaviour: if IndexedDB is empty or `localStorage.seed_version` is behind, fetch and hydrate, writing blobs from the fetched JPEGs.
Takes a couple of seconds, shows a progress line, and is idempotent.
Add a **"Reset demo data"** button and a **"Load extra 500 synthetic clips"** button, the second one generating records with recoloured posters so the thousand-item grid state is demonstrable without shipping 500 real images.

Total repo weight lands near 15 to 25MB, which is fine for GitHub and for a static host.
Do not commit 150MB source videos.
Do not require the panel to upload anything before the library has content, and do not gate the AI features behind an API key: the seeded `ai_run` rows include real cached model output, and the cache key is `(sheet_hash, prompt_hash, model_id)` so a live call still happens when a key is present and is skipped when it is not.
That single decision is what makes the demo survive bad conference wifi.

### B.4 Per-platform capability table

**Everything in B.1 through B.3 is the browser answer, and the browser is the only runtime for this submission.**
Nothing in this table relaxes any decision above.
It exists because the platform port (C3) needs a written contract for what each implementation provides, and because a reader should be able to see which constraints are inherent and which are the browser's.

| capability | browser (built and exercised) | desktop shell, Capacitor Electron (designed, not built) | mobile native, Capacitor iOS and Android (designed, not built) |
|---|---|---|---|
| record store | IndexedDB, quota-negotiated | IndexedDB in the renderer, unchanged | IndexedDB in the WebView, unchanged |
| large binary | OPFS, counts against origin quota | Node `fs` under `app.getPath('userData')`, or **referenced in place** with no copy at all | Capacitor Filesystem, app sandbox |
| quota ceiling | desktop about 60% of free disk, **iOS Safari about 1GB** | free disk, no origin quota | app sandbox, OS-managed |
| eviction | **yes, and total.** Best-effort storage clears under pressure, and Safari's tracking prevention clears script-writable storage for sites without recent interaction | none | only on app deletion |
| `navigator.storage.persist()` | required, may be refused | not applicable | not applicable |
| originals policy | **`bytes_absent` by default, capped at `maxLocalOriginalBytes`** | originals stay where the user already keeps them, no copy, path recorded | sandbox copy, capped |
| decode and transcode | WebCodecs where supported, else `<video>` plus canvas, else **nothing** | bundled ffmpeg, decodes everything the browser cannot | platform decoders plus optional bundled ffmpeg |
| HEVC from a foreign device | **open hole, see E.4** | resolvable locally | resolvable on iOS via VideoToolbox |
| file picking | `<input type="file">`, drag and drop, `showOpenFilePicker` where available | native dialogs, folder trees, watched directories | native pickers, Photos library |
| durability mechanism | **export and import snapshot, mandatory** | real files on a real disk, still worth having export | app backup, still worth having export |
| secrets | never in the bundle, model calls proxied (D below) | main process can hold a key directly | Keychain and Keystore |

**Which browser mitigations become unnecessary on desktop, stated plainly for the record:**
the originals byte cap, the eviction ladder, `persist()`, `bytes_absent` as the default state, and export-as-durability all become optional rather than required.

**Which stay mandatory regardless:** soft delete, `derivative_state`, the tri-state preflight, the sync envelope, and export-import as a portability and demo-seeding mechanism.
Those are product requirements, not workarounds for a quota.

**And the rule that keeps the two honest:** no record may be producible *only* on desktop.
The desktop shell may produce a derivative **sooner** or **at all** where the browser cannot, but the record's shape, its states, and its transitions are identical in every shell.
That is what makes `derivative_state='none'` a legitimate resting state rather than an error, and it is why the open HEVC hole is representable rather than a crash.

---

## C. Local first now, Supabase later

### C.0 The additive rule

Local IndexedDB object store names equal future Postgres table names, snake_case, one to one.
Local record field names equal column names, one to one.
Local-only fields (OPFS paths, upload offsets, dirty flags) live under a single `_local` key per record, and the sync layer strips `_local` on the way out and never expects it on the way in.
That one convention is what makes "add Supabase later" additive rather than a rewrite, and it costs nothing to adopt on day one.

### C.1 Future Postgres schema (DDL)

Committed at `/supabase/migrations/0001_init.sql` from the first week, even though nothing is deployed.

```sql
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
-- create extension if not exists vector;   -- reserved, unused in v1

create type collab_stage    as enum ('source','vet','book','brief','visit','delivered','library');
create type review_status   as enum ('pending','approved','rejected','needs_fix');
create type asset_kind      as enum ('video','photo','audio','doc');
create type media_state     as enum ('bytes_absent','bytes_local','bytes_remote');
create type upload_state    as enum ('local_only','queued','uploading','uploaded','failed','abandoned');
create type derivative_state as enum ('none','client_derived','server_derived','failed');
create type shell_id         as enum ('browser','electron','native','server');
create type tag_source      as enum ('ai','human','rule','import');
create type vocab_status    as enum ('proposed','active','deprecated','merged');
create type ai_run_kind     as enum ('vet','brief_gen','vision_tag','brief_match','search_parse','gap_scan','nudge_draft');
create type brief_status    as enum ('draft','locked','superseded');
create type gap_status      as enum ('open','assigned','closing','closed','dismissed');
create type review_method   as enum ('manual','batch','auto_threshold','sampled_qa');

-- ---------------------------------------------------------------- tenancy
create table org (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table app_user (
  id                uuid primary key,                       -- = auth.users.id
  org_id            uuid not null references org(id),
  role              text not null check (role in ('manager','editor','admin')),
  display_name      text not null,
  branch_scope      jsonb,                                  -- null = all branches
  is_demo           boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  deleted_at        timestamptz,
  rev               integer not null default 1,
  origin_device     text
);

-- Every table below carries the same envelope tail:
--   org_id uuid not null references org(id),
--   created_at timestamptz not null default now(),
--   updated_at timestamptz not null default now(),
--   server_updated_at timestamptz not null default now(),
--   deleted_at timestamptz,
--   rev integer not null default 1,
--   origin_device text
-- It is written out in full on `asset` and abbreviated as `<envelope>` elsewhere
-- purely to keep this document readable. In the real file it is expanded.

-- ---------------------------------------------------------------- core
create table branch (
  id uuid primary key,
  name text not null,
  address text, city text, timezone text not null default 'America/Los_Angeles',
  geo_lat double precision, geo_lng double precision,
  geo_radius_m integer not null default 400,
  rooms jsonb not null default '[]',            -- [{room_key,label,light_notes}]
  brand_palette jsonb, signature_treatments jsonb,
  do_not_shoot jsonb not null default '[]',     -- manager only, never exposed
  target_coverage jsonb not null default '[]',  -- bootstraps gap scan
  <envelope>
);

create table creator (
  id uuid primary key,
  handle text, display_name text not null,
  contact_email text, contact_phone text, city text, notes text,
  platforms jsonb not null default '[]',
  source text check (source in ('inbound','scout','referral')),
  lifecycle text not null default 'lead' check (lifecycle in ('lead','active','blocked')),
  -- AI projection, regenerable from ai_run
  style_summary text, niche_tags jsonb,
  fit_score smallint check (fit_score between 0 and 100),
  fit_reasons jsonb, risk_flags jsonb, suggested_tier text,
  latest_vet_run_id uuid,
  -- human curation, never LWW, never AI-writable
  fit_score_override smallint check (fit_score_override between 0 and 100),
  override_reason text, overridden_by uuid references app_user(id), overridden_at timestamptz,
  -- system projection
  scorecard jsonb not null default '{}',
  reliability_tier text not null default 'new'
    check (reliability_tier in ('new','proven','trusted')),
  <envelope>
);

create table collab (
  id uuid primary key,
  creator_id uuid not null references creator(id),
  branch_id  uuid not null references branch(id),
  owner_user_id uuid references app_user(id),
  stage collab_stage not null default 'source',
  stage_entered_at timestamptz not null default now(),
  stage_history jsonb not null default '[]',
  vip_tier text, visit_date date, visit_window text,
  comp_value_usd numeric(10,2), notes text,
  brief_id uuid,
  consent_accepted_at timestamptz, consent_text_version text,
  consent_ip_hash text, consent_user_agent text,
  usage_terms_text text,                        -- snapshot, not a pointer
  outcome text check (outcome in ('completed','partial','ghosted','cancelled')),
  counters jsonb not null default '{}',
  creator_display_name text, branch_name text,  -- denormalized for the kanban
  <envelope>
);

create table brief (
  id uuid primary key,
  collab_id uuid not null references collab(id),
  version integer not null default 1,
  status brief_status not null default 'draft',
  locked_at timestamptz, locked_by uuid references app_user(id),
  generated_by_ai_run_id uuid,
  gap_scan_id uuid,                             -- provenance half of the closed loop
  intro_text text, do_list jsonb, dont_list jsonb, tech_specs jsonb,
  usage_terms_text text, caption_angles jsonb,
  source text not null default 'human' check (source in ('ai','human','ai_edited')),
  edited_fields jsonb not null default '[]',
  <envelope>,
  unique (collab_id, version)
);

create table brief_item (
  id uuid primary key,
  brief_id uuid not null references brief(id) on delete cascade,
  seq smallint not null,
  title text not null, instruction_text text,
  required_shot_type text, required_room text, required_subjects jsonb,
  required_orientation text check (required_orientation in ('vertical','horizontal','either')),
  time_of_day text check (time_of_day in ('morning','midday','evening','any')),
  min_duration_s numeric(6,2) default 3, min_width int default 1080, min_height int default 1920,
  quantity_required smallint not null default 1,
  priority text not null default 'must' check (priority in ('must','nice')),
  origin text not null default 'ai' check (origin in ('ai','human')),
  origin_gap_id uuid,                           -- which gap this shot closes
  edited_from_ai boolean not null default false, edit_note text,
  fulfilled_count smallint not null default 0,
  status text not null default 'unmet' check (status in ('unmet','partial','met')),
  <envelope>,
  unique (brief_id, seq)
);

create table delivery (
  id uuid primary key,
  collab_id uuid not null references collab(id),
  token_id uuid,
  started_at timestamptz not null default now(), submitted_at timestamptz,
  device_hint text, app_version text,
  clip_count int not null default 0, total_bytes bigint not null default 0,
  preflight_summary jsonb not null default '{}',
  ai_match_run_id uuid,
  nudge_draft_text text, nudge_sent_at timestamptz, nudge_channel text,
  status text not null default 'open' check (status in ('open','submitted','reviewed','closed')),
  <envelope>
);

-- ---------------------------------------------------------------- asset
create table asset (
  id uuid primary key,
  kind asset_kind not null default 'video',
  collab_id   uuid references collab(id),
  delivery_id uuid references delivery(id),
  creator_id  uuid references creator(id),
  branch_id   uuid references branch(id),

  -- band 1: origin facts, write-once
  original_filename text, size_bytes bigint, mime text, container text,
  codec_video text, codec_audio text,
  duration_s numeric(8,2), width int, height int, rotation_deg smallint,
  orientation text check (orientation in ('vertical','horizontal','square')),
  fps numeric(6,3), bitrate_bps bigint,
  captured_at timestamptz,
  captured_at_source text check (captured_at_source in
    ('atom','exif','filesystem','creator_stated','unknown')),
  gps_lat double precision, gps_lng double precision,
  gps_source text check (gps_source in ('atom','exif','none')),
  frame_hashes jsonb, phash_primary text,

  -- band 1b: decode capability, per ingest, written by the probe
  client_decodable boolean,
  probe_result jsonb not null default '{}',   -- {webcodecs, canPlayType, shell, probed_at}
  needs_transcode boolean not null default false,

  -- band 2: deterministic derived, tri-state per rule (A.19)
  preflight jsonb not null default '{}',
  preflight_version smallint not null default 2,
  preflight_policy_tier text,
  -- generated columns so the review queue can index without scanning
  preflight_blocking_fail boolean generated always as
    (coalesce((preflight->'rollup'->>'blocking_fail')::int, 0) > 0) stored,
  preflight_unknown_count int generated always as
    (coalesce((preflight->'rollup'->>'unknown')::int, 0)) stored,

  -- band 3: AI projection (tags are NOT here, they are rows in tag)
  ai_shot_type text, ai_room text, ai_subjects jsonb, ai_light text,
  ai_framing_score numeric(4,3), ai_quality_score numeric(4,3),
  ai_description text,
  ai_brand_safety text check (ai_brand_safety in ('clear','review','block')),
  ai_confidence numeric(4,3),
  ai_matched_brief_item_id uuid references brief_item(id),
  latest_vision_run_id uuid, latest_match_run_id uuid,

  -- band 4: human curation, never LWW
  review_status review_status not null default 'pending',
  reviewed_by uuid references app_user(id), reviewed_at timestamptz,
  reject_reason_code text, reject_reason_text text,
  creator_facing_note text,                     -- what the creator is shown instead
  confirmed_brief_item_id uuid references brief_item(id),
  is_hero boolean not null default false,
  human_description_override text,
  is_published boolean not null default false, published_at timestamptz,
  is_exemplar boolean not null default false, exemplar_note text,
  review_conflict boolean not null default false,

  -- band 5: storage and usage
  media_state media_state not null default 'bytes_absent',
  -- orthogonal to media_state on purpose: "where are the bytes" vs "do we have pixels"
  derivative_state derivative_state not null default 'none',
  derivative_producer shell_id,
  transcode_priority smallint not null default 0,
  derive_error text,
  remote_object_key text, poster_key text, preview_key text, sheet_key text,
  upload_state upload_state not null default 'local_only',
  upload_offset_bytes bigint not null default 0,
  creator_credit text,                          -- display name + handle only
  used_count int not null default 0, download_count int not null default 0,
  last_used_at timestamptz,

  org_id uuid not null references org(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  rev integer not null default 1,
  origin_device text
);

create table contact_sheet (
  id uuid primary key,
  asset_id uuid not null references asset(id) on delete cascade,
  layout text not null default '1x5', width_px int, height_px int,
  jpeg_quality numeric(3,2), bytes int, sheet_hash text,
  storage_key text,                             -- blob lives in object storage, not in PG
  generator_version smallint not null default 1,
  generated_at timestamptz not null default now(),
  <envelope>
);

create table asset_frame (
  id uuid primary key,
  asset_id uuid not null references asset(id) on delete cascade,
  sheet_id uuid references contact_sheet(id) on delete cascade,
  seq smallint not null, t_seconds numeric(8,2),
  dhash text, is_poster boolean not null default false,
  <envelope>
);

-- ---------------------------------------------------------------- taxonomy
create table tag_vocabulary (
  id uuid primary key,
  slug text not null, label text not null,
  facet text not null check (facet in
    ('shot_type','room','subject','light','motion','mood','season','treatment','orientation','freeform')),
  parent_id uuid references tag_vocabulary(id),
  status vocab_status not null default 'proposed',
  merged_into_id uuid references tag_vocabulary(id),
  aliases jsonb not null default '[]',
  created_by text not null default 'human' check (created_by in ('human','ai','rule')),
  definition_text text, usage_count int not null default 0,
  curated_by uuid references app_user(id),
  -- embedding vector(1536),                    -- reserved
  <envelope>,
  unique (org_id, slug)
);

create table tag (
  id uuid primary key,
  subject_type text not null check (subject_type in ('asset','brief_item','creator')),
  subject_id uuid not null,
  vocab_id uuid references tag_vocabulary(id),
  raw_text text,                                -- set when vocab_id is null
  source tag_source not null,
  ai_run_id uuid, confidence numeric(4,3),
  created_by_user_id uuid references app_user(id),
  removed_at timestamptz,
  rejected_by_human boolean not null default false,
  <envelope>,
  check (vocab_id is not null or raw_text is not null)
);

-- ---------------------------------------------------------------- AI provenance
create table ai_run (
  id uuid primary key,
  kind ai_run_kind not null,
  subject_type text not null, subject_id uuid,
  model_id text not null, model_params jsonb not null default '{}',
  prompt_key text not null, prompt_version text not null, prompt_hash text not null,
  input_ref jsonb not null default '{}', input_hash text,
  output_json jsonb,
  status text not null default 'ok' check (status in ('ok','error','refused','timeout')),
  error_text text,
  tokens_in int, tokens_out int, cost_usd numeric(10,6), latency_ms int,
  is_current boolean not null default true, superseded_by_run_id uuid,
  <envelope>
);

-- ---------------------------------------------------------------- signals
create table search_query_log (
  id uuid primary key,
  user_id uuid references app_user(id), role text, session_id text,
  raw_query_text text not null, parsed_filters jsonb,
  result_count int not null default 0, top_result_ids jsonb, latency_ms int,
  outcome text check (outcome in ('clicked','zero_results','abandoned','refined','saved','downloaded')),
  clicked_asset_ids jsonb, clicked_ranks jsonb,
  refined_from_query_id uuid references search_query_log(id),
  unmet_facets jsonb, branch_context uuid references branch(id),
  <envelope>
);

create table usage_event (
  id uuid primary key,
  user_id uuid references app_user(id),
  event text not null check (event in
    ('view_asset','preview_play','download','copy_link','add_to_collection','reject_result','pin','dwell')),
  asset_id uuid references asset(id), query_id uuid references search_query_log(id),
  rank_at_event smallint, dwell_ms int,
  <envelope>
);

create table saved_collection (
  id uuid primary key,
  owner_user_id uuid not null references app_user(id),
  name text not null,
  kind text not null default 'manual' check (kind in ('manual','saved_search','ai_auto')),
  query_text text, query_filters jsonb,
  is_pinned boolean not null default false, is_shared boolean not null default false,
  last_opened_at timestamptz, open_count int not null default 0,
  <envelope>
);

create table collection_item (
  id uuid primary key,
  collection_id uuid not null references saved_collection(id) on delete cascade,
  asset_id uuid not null references asset(id),
  added_by text not null default 'human' check (added_by in ('human','ai')),
  rank int, note text, removed_at timestamptz,
  <envelope>
);

create table review_action (
  id uuid primary key,
  actor_user_id uuid references app_user(id),
  scope text not null check (scope in ('asset','brief_item','delivery')),
  scope_id uuid not null,
  decision text not null,                       -- 'approve'|'reject'|'needs_fix'|'revert'
  asset_ids jsonb not null default '[]',
  method review_method not null, note text,
  session_id uuid,                              -- A.20, makes keystrokes idempotent
  reverts_action_id uuid references review_action(id),
  ai_provenance_at_decision ai_provider,        -- was the evidence simulated (C2.A)
  <envelope>
);
-- a repeated keystroke is a no-op, not a second audit row
create unique index review_action_session_asset_idx
  on review_action (session_id, scope_id, actor_user_id)
  where scope = 'asset' and session_id is not null and decision <> 'revert';

create table review_session (
  id uuid primary key,
  actor_user_id uuid not null references app_user(id),
  scope text not null check (scope in ('delivery','brief_item','queue')),
  scope_id uuid,
  ordered_asset_ids jsonb not null,             -- frozen at creation, write-once
  cursor_index int not null default 0,          -- merges as max
  skipped_asset_ids jsonb not null default '[]',-- merges as set union
  sort_key_used text not null,
  pending_additions jsonb not null default '[]',
  device_started text, device_last text,
  completed_at timestamptz,                     -- sticky
  <envelope>
);
create index review_session_actor_idx
  on review_session (actor_user_id, updated_at desc) where completed_at is null;

-- ---------------------------------------------------------------- the loop
create table gap_scan (
  id uuid primary key,
  ran_at timestamptz not null default now(),
  window_days smallint not null default 90, params jsonb not null default '{}',
  ai_run_id uuid,
  <envelope>
);

create table gap (
  id uuid primary key,
  scan_id uuid not null references gap_scan(id) on delete cascade,
  branch_id uuid references branch(id),          -- null = global
  cell jsonb not null, cell_signature text not null,
  demand_score numeric(8,3) not null default 0,
  supply_effective numeric(8,3) not null default 0,
  deficit_score numeric(8,3) not null default 0,
  severity text not null check (severity in ('critical','high','medium','low')),
  signals jsonb not null default '{}', evidence jsonb not null default '{}',
  status gap_status not null default 'open',
  assigned_brief_item_ids jsonb not null default '[]',
  closed_at timestamptz, closing_asset_ids jsonb,
  computed_by_run_id uuid,
  <envelope>
);

create table gap_dismissal (
  id uuid primary key,
  cell_signature text not null,                  -- keyed by cell, NOT by gap.id
  reason text, dismissed_by uuid references app_user(id),
  dismissed_at timestamptz not null default now(), expires_at timestamptz,
  <envelope>,
  unique (org_id, cell_signature)
);

create table insight (
  id uuid primary key,
  subject_type text not null, subject_id uuid,
  kind text not null, title text not null, body text,
  severity text, score numeric(8,3), evidence jsonb,
  ai_run_id uuid, scan_id uuid,
  status text not null default 'open', dismissed_reason text,
  <envelope>
);

create table access_token (
  id uuid primary key,
  collab_id uuid not null references collab(id),
  scope text not null check (scope in ('invite','upload')),
  token_hash text not null unique,               -- sha256, raw token never stored
  expires_at timestamptz not null,
  max_uses int, uses int not null default 0,
  revoked_at timestamptz,
  created_by uuid references app_user(id),
  last_used_at timestamptz, last_used_ip_hash text,
  <envelope>
);
```

**Indexes, named, driven by the screen dry run in A.18:**

```sql
-- kanban
create index collab_stage_idx on collab (org_id, stage, server_updated_at desc)
  where deleted_at is null;
create index collab_stalled_idx on collab (org_id, stage_entered_at)
  where deleted_at is null and outcome is null;
-- deal drawer diff
create index brief_item_brief_seq_idx on brief_item (brief_id, seq);
create index asset_confirmed_item_idx on asset (confirmed_brief_item_id)
  where deleted_at is null;
create index asset_collab_unmatched_idx on asset (collab_id)
  where confirmed_brief_item_id is null and deleted_at is null;
create index asset_delivery_idx on asset (delivery_id, created_at);
-- library
create index asset_library_idx on asset (org_id, published_at desc)
  where is_published and review_status = 'approved' and deleted_at is null;
create index asset_branch_shot_idx on asset (org_id, branch_id, ai_shot_type)
  where is_published and deleted_at is null;
create index asset_desc_trgm_idx on asset using gin (
  (coalesce(human_description_override, ai_description)) gin_trgm_ops);
create index asset_review_queue_idx on asset (org_id, review_status, created_at)
  where deleted_at is null;
-- the review queue's real predicates: needs a judgement call, or has no pixels yet
create index asset_needs_judgement_idx on asset (org_id, created_at)
  where review_status = 'pending' and preflight_unknown_count > 0 and deleted_at is null;
create index asset_awaiting_derivatives_idx
  on asset (org_id, transcode_priority desc, created_at)
  where derivative_state = 'none' and deleted_at is null;
create index asset_exemplar_idx on asset (org_id) where is_exemplar and deleted_at is null;
-- tags
create index tag_subject_idx on tag (subject_type, subject_id) where removed_at is null;
create index tag_vocab_idx on tag (vocab_id) where removed_at is null;
create unique index tag_unique_live_idx on tag (subject_type, subject_id, vocab_id, source)
  where removed_at is null and vocab_id is not null;
create index vocab_facet_idx on tag_vocabulary (org_id, facet, status);
-- AI provenance
create index ai_run_subject_current_idx on ai_run (subject_type, subject_id, kind)
  where is_current;
create index ai_run_cache_idx on ai_run (input_hash, prompt_hash, model_id) where status = 'ok';
-- signals
create index sql_zero_idx on search_query_log (org_id, created_at desc)
  where result_count = 0;
create index sql_user_recent_idx on search_query_log (user_id, created_at desc);
create index usage_event_asset_idx on usage_event (asset_id, created_at desc);
create index usage_event_query_rank_idx on usage_event (query_id, rank_at_event);
-- gaps
create index gap_scan_severity_idx on gap (scan_id, severity, deficit_score desc);
create index gap_branch_status_idx on gap (org_id, branch_id, status, deficit_score desc);
create index gap_cell_idx on gap (org_id, cell_signature, scan_id desc);
-- sync cursors, one per table, this shape repeated
create index asset_pull_idx on asset (org_id, server_updated_at, id);
```

**Two triggers that carry real design weight:**

```sql
-- 1. the only valid sync cursor
create or replace function touch_server_updated_at() returns trigger as $$
begin new.server_updated_at := now(); return new; end $$ language plpgsql;
-- attached BEFORE INSERT OR UPDATE on every synced table.

-- 2. a locked brief is immutable by construction, not by convention
create or replace function brief_lock_guard() returns trigger as $$
begin
  if old.locked_at is not null and (
       new.intro_text is distinct from old.intro_text
    or new.do_list    is distinct from old.do_list
    or new.dont_list  is distinct from old.dont_list
    or new.tech_specs is distinct from old.tech_specs
    or new.usage_terms_text is distinct from old.usage_terms_text
  ) then
    raise exception 'brief % is locked, create version %', old.id, old.version + 1;
  end if;
  return new;
end $$ language plpgsql;
```

The lock guard is what turns "the locked brief is the contract" from a UI promise into a database fact.
Same for `brief_item`, guarded through its parent.

### C.2 RLS policy shape per role

`/supabase/migrations/0002_rls.sql`.
Three helper functions first, so no policy repeats a join.

```sql
create or replace function auth_org() returns uuid language sql stable security definer as $$
  select org_id from app_user where id = auth.uid()
$$;

create or replace function auth_role() returns text language sql stable security definer as $$
  select role from app_user where id = auth.uid()
$$;

-- null branch_scope means all branches; a branch manager gets a filtered list
create or replace function auth_sees_branch(p_branch uuid) returns boolean
language sql stable security definer as $$
  select case
    when (select branch_scope from app_user where id = auth.uid()) is null then true
    else p_branch = any (
      select (jsonb_array_elements_text(branch_scope))::uuid
      from app_user where id = auth.uid())
  end
$$;

alter table asset enable row level security;   -- and every other table
alter table asset force row level security;    -- so the table owner is not exempt
```

**Manager: full read and write inside the org, filtered by `branch_scope` where a branch column exists.**

```sql
create policy mgr_all_asset on asset for all to authenticated
  using      (auth_role() in ('manager','admin') and org_id = auth_org()
              and (branch_id is null or auth_sees_branch(branch_id)))
  with check (auth_role() in ('manager','admin') and org_id = auth_org());
-- repeated verbatim for creator, collab, brief, brief_item, delivery, gap,
-- gap_scan, gap_dismissal, review_action, tag, tag_vocabulary, ai_run, insight,
-- access_token, branch. `admin` is included so there is exactly one escape hatch.
```

**Editor: the library across all branches and all creators, and nothing commercial.**
The key move is table invisibility rather than column filtering: **there is no editor policy on `creator`, `collab`, `review_action`, `gap_dismissal`, or `access_token` at all**, so those tables simply do not exist for an editor.
RLS default-deny does the work, and there is no column list to get wrong later.

```sql
-- library reads: all branches, all creators, approved and published only
create policy ed_read_asset on asset for select to authenticated
  using (auth_role() = 'editor' and org_id = auth_org()
         and is_published and review_status = 'approved' and deleted_at is null);

-- the commercially sensitive columns are removed at the API surface too,
-- because select * would otherwise return them even if the UI ignores them
revoke select on asset from authenticated;
grant select (id, kind, collab_id, branch_id, original_filename, duration_s,
              width, height, orientation, fps, captured_at, preflight,
              ai_shot_type, ai_room, ai_subjects, ai_light, ai_framing_score,
              ai_quality_score, ai_description, ai_confidence,
              review_status, is_hero, human_description_override,
              is_published, published_at, creator_credit,
              media_state, remote_object_key, poster_key, preview_key, sheet_key,
              used_count, download_count, last_used_at,
              org_id, created_at, updated_at, server_updated_at, deleted_at, rev)
  on asset to authenticated;
-- deliberately NOT granted to editors: creator_id, reject_reason_text,
-- reject_reason_code, creator_facing_note, reviewed_by, exemplar_note,
-- review_conflict, ai_matched_brief_item_id, ai_brand_safety.

create policy ed_read_sheet on contact_sheet for select to authenticated
  using (auth_role() = 'editor'
         and exists (select 1 from asset a where a.id = asset_id
                     and a.is_published and a.review_status = 'approved'));

create policy ed_read_tag on tag for select to authenticated
  using (auth_role() = 'editor' and subject_type = 'asset'
         and exists (select 1 from asset a where a.id = subject_id and a.is_published));

-- editors may add human tags, and only human tags, and only their own
create policy ed_write_tag on tag for insert to authenticated
  with check (auth_role() = 'editor' and source = 'human'
              and created_by_user_id = auth.uid() and org_id = auth_org());
create policy ed_soft_remove_tag on tag for update to authenticated
  using (auth_role() = 'editor' and source in ('human','ai'))
  with check (removed_at is not null);   -- soft removal only, never a value rewrite

-- "why did this match" panel, but never the vetting run
create policy ed_read_ai_run on ai_run for select to authenticated
  using (auth_role() = 'editor' and org_id = auth_org()
         and kind in ('vision_tag','search_parse'));

-- own signals and own collections
create policy ed_own_queries on search_query_log for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy ed_own_events on usage_event for insert to authenticated
  with check (user_id = auth.uid());
create policy ed_collections on saved_collection for all to authenticated
  using (owner_user_id = auth.uid() or is_shared)
  with check (owner_user_id = auth.uid());

-- editors may see gaps and may file a gap request, nothing more
create policy ed_read_gap on gap for select to authenticated
  using (auth_role() = 'editor' and org_id = auth_org());
create policy ed_request_gap on gap for insert to authenticated
  with check (auth_role() = 'editor' and org_id = auth_org()
              and (signals->>'source') = 'editor_request');

-- editors may propose vocabulary, never activate it
create policy ed_read_vocab on tag_vocabulary for select to authenticated
  using (auth_role() = 'editor' and org_id = auth_org() and status = 'active');
create policy ed_propose_vocab on tag_vocabulary for insert to authenticated
  with check (auth_role() = 'editor' and status = 'proposed' and created_by = 'human');
```

**Creator with only a signed token: zero table policies, everything through `security definer` RPC.**

This is the decision, and the reason matters.
The alternative (grant `anon` narrow RLS policies that read the token out of `current_setting('request.headers')::json->>'x-collab-token'`) does work, and it is how a lot of people do it.
It is rejected here because the creator surface needs a **column allowlist across six tables**, and every future `alter table add column` silently widens that surface unless someone remembers to update a grant.
An RPC that returns a hand-built `jsonb` cannot leak a column that was added later, because nobody added it to the `jsonb`.
For a surface exposed to an unauthenticated stranger on the public internet, default-closed beats default-open.

```sql
revoke all on all tables in schema public from anon;   -- anon touches nothing directly

-- resolve and validate, one place
create or replace function _tok(p_token text, p_scope text)
returns access_token language plpgsql stable security definer as $$
declare t access_token;
begin
  select * into t from access_token
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and scope = p_scope
     and revoked_at is null
     and expires_at > now()
     and (max_uses is null or uses < max_uses);
  if not found then raise exception 'invalid token' using errcode = '42501'; end if;
  return t;
end $$;

-- READ: the redacted projection, the exact mirror of collabPublicView() in A2.3
create or replace function collab_public(p_token text)
returns jsonb language plpgsql stable security definer as $$
declare t access_token; out jsonb;
begin
  t := _tok(p_token, 'invite');
  select jsonb_build_object(
    'collab', jsonb_build_object(
        'id', c.id, 'visit_date', c.visit_date, 'visit_window', c.visit_window,
        'vip_tier', c.vip_tier, 'usage_terms_text', c.usage_terms_text,
        'consent_accepted_at', c.consent_accepted_at),
    'branch', jsonb_build_object(
        'name', b.name, 'address', b.address, 'city', b.city, 'timezone', b.timezone),
    'creator', jsonb_build_object('display_name', cr.display_name),
    'brief', jsonb_build_object('intro_text', br.intro_text, 'do_list', br.do_list,
        'dont_list', br.dont_list, 'tech_specs', br.tech_specs,
        'caption_angles', br.caption_angles, 'version', br.version),
    'items', (select jsonb_agg(jsonb_build_object(
        'id', bi.id, 'seq', bi.seq, 'title', bi.title,
        'instruction_text', bi.instruction_text,
        'required_orientation', bi.required_orientation,
        'time_of_day', bi.time_of_day, 'min_duration_s', bi.min_duration_s,
        'min_width', bi.min_width, 'min_height', bi.min_height,
        'quantity_required', bi.quantity_required, 'priority', bi.priority)
        order by bi.seq) from brief_item bi where bi.brief_id = br.id),
    'exemplars', (select jsonb_agg(jsonb_build_object(
        'poster_key', a.poster_key, 'preview_key', a.preview_key,
        'note', a.exemplar_note) ) from (
        select * from asset where org_id = c.org_id and is_exemplar
           and deleted_at is null order by published_at desc limit 6) a)
  ) into out
  from collab c
    join branch  b  on b.id  = c.branch_id
    join creator cr on cr.id = c.creator_id
    join brief   br on br.id = c.brief_id and br.status = 'locked'
  where c.id = t.collab_id;
  update access_token set uses = uses + 1, last_used_at = now() where id = t.id;
  return out;
end $$;
grant execute on function collab_public(text) to anon;
```

Note what that function structurally cannot return: `fit_score`, `fit_reasons`, `risk_flags`, `comp_value_usd`, `collab.notes`, `branch.do_not_shoot`, `target_coverage`, any gap, any `ai_run`, any other creator, and any asset that is not flagged `is_exemplar`.
The exemplar strip is the whole of "creators may see others' work", and it is six rows with two keys and a note.
It also proves the point about the RPC choice: adding a sensitive column to `asset` next month cannot widen this.

```sql
-- WRITE: append to my own delivery, idempotent, no account
create or replace function delivery_upsert_asset(p_token text, p_payload jsonb)
returns jsonb language plpgsql security definer as $$
declare t access_token; d_id uuid; a_id uuid := (p_payload->>'id')::uuid;
begin
  t := _tok(p_token, 'upload');
  select id into d_id from delivery
    where collab_id = t.collab_id and status = 'open' order by started_at desc limit 1;
  if d_id is null then
    insert into delivery (id, org_id, collab_id, token_id, status)
    select gen_random_uuid(), c.org_id, c.id, t.id, 'open' from collab c where c.id = t.collab_id
    returning id into d_id;
  end if;

  insert into asset (id, org_id, kind, collab_id, delivery_id, creator_id, branch_id,
                     original_filename, size_bytes, mime, container, codec_video,
                     duration_s, width, height, rotation_deg, orientation, fps,
                     captured_at, captured_at_source, gps_lat, gps_lng, gps_source,
                     frame_hashes, phash_primary, preflight, preflight_version,
                     upload_state, media_state, review_status, origin_device)
  select a_id, c.org_id, coalesce((p_payload->>'kind')::asset_kind,'video'),
         c.id, d_id, c.creator_id, c.branch_id,
         p_payload->>'original_filename', (p_payload->>'size_bytes')::bigint,
         p_payload->>'mime', p_payload->>'container', p_payload->>'codec_video',
         (p_payload->>'duration_s')::numeric, (p_payload->>'width')::int,
         (p_payload->>'height')::int, (p_payload->>'rotation_deg')::smallint,
         p_payload->>'orientation', (p_payload->>'fps')::numeric,
         (p_payload->>'captured_at')::timestamptz, p_payload->>'captured_at_source',
         (p_payload->>'gps_lat')::double precision, (p_payload->>'gps_lng')::double precision,
         p_payload->>'gps_source', p_payload->'frame_hashes', p_payload->>'phash_primary',
         coalesce(p_payload->'preflight','{}'), 1,
         'queued', 'bytes_absent', 'pending', 'creator-token'
  from collab c where c.id = t.collab_id
  on conflict (id) do update set
      preflight    = excluded.preflight,       -- re-running preflight is fine
      upload_state = excluded.upload_state,
      updated_at   = now()
  where asset.review_status = 'pending';       -- a reviewed asset is frozen to the creator
  update access_token set uses = uses + 1, last_used_at = now() where id = t.id;
  return jsonb_build_object('delivery_id', d_id, 'asset_id', a_id);
end $$;
grant execute on function delivery_upsert_asset(text, jsonb) to anon;
```

The client generates `asset.id` (UUIDv7), so retrying the same file on a flaky connection is idempotent rather than duplicating.
The `where asset.review_status = 'pending'` clause is the important one: once a manager has judged a clip, the creator's device cannot silently rewrite its facts.

Two more `anon`-executable functions, same pattern, described rather than spelled out: `delivery_submit(p_token)` (sets `submitted_at`, `status='submitted'`, recomputes `preflight_summary`) and `delivery_status(p_token)` (returns the live checklist: per `brief_item`, covered or not, plus the creator-facing note on anything rejected, never `reject_reason_text`).

**Token mechanics.**
32 random bytes, base64url, so 256 bits, generated client-side by the manager and placed in the link as `/#/c/<token>`.
Only `sha256(token)` is ever stored, so a database leak does not yield working links.
`invite` scope expires at `visit_date + 14 days`, `upload` scope at `visit_date + 21 days`, both with `max_uses` null (reads and appends must be repeatable) and a `revoked_at` the manager can set from the deal drawer.
Because the token is in the URL fragment it is not sent in the `Referer` header and does not land in server logs, which is a small but real reason to use `#/c/<token>` rather than `?token=`.
Rate limit at the edge by `token_hash`, not by IP, because a creator on mobile changes IP constantly.

**Storage writes for the creator, since bytes are the risky part.**
The creator never receives bucket credentials.
`delivery_upsert_asset` returns nothing that can write to storage.
A separate `anon` function `delivery_sign_upload(p_token, p_asset_id)` validates the token, confirms the asset belongs to that collab and is still `pending`, then returns a short-TTL signed upload URL scoped to exactly one object key (`orig/{asset_id}.{ext}`), 15 minute expiry, single use.
The bucket is private, reads always go through a signed path or the CDN worker.
That is the whole no-auth write story, and none of it needs an account.

### C.3 Sync mechanics

**Ids.** UUIDv7, generated client-side, for every table.
Time-sortable so `order by id` approximates `order by created_at`, native `uuid` in Postgres, no coordination, works fully offline, no collision risk worth modelling.
Chosen over ULID only because Postgres stores `uuid` in 16 bytes and indexes it natively, and over autoincrement because autoincrement cannot exist offline.

**Envelope.** As in A.0: `created_at`, `updated_at`, `deleted_at`, `rev`, `origin_device`, plus the server-only `server_updated_at`.

**The cursor rule, stated as a finding because it is the one that silently loses data.**
Pull cursors must order by `server_updated_at`, never by the client's `updated_at`.
A phone with a clock 40 minutes fast writes `updated_at` in the future, and every other device's cursor steps past it, so the row becomes permanently invisible with no error anywhere.
`server_updated_at` is set by a `before insert or update` trigger and is the only column the sync layer is allowed to sort on.
`updated_at` survives purely as a merge input.

**Outbox, append-only, patch-level.**

```
outbox (local only, never synced)
  seq            integer autoincrement   -- local ordering
  id             uuid
  table_name     text
  record_id      uuid
  op             'put' | 'patch' | 'delete'
  changed_fields jsonb        -- the patch, NOT the whole row
  base_rev       integer      -- what the writer believed when it wrote
  client_ts      timestamptz
  attempts       integer
  status         'pending' | 'sent' | 'conflict' | 'failed'
  last_error     text
```

Patch-level rather than row-level is a deliberate cost: it means two devices editing different fields of the same asset both land, instead of the later one erasing the earlier one's field.
`base_rev` is what lets the server detect that a patch was written against stale data and apply the per-table rule instead of blindly writing.

**Pull cursor per table.**

```
sync_state (local only)
  table_name              text primary key
  last_server_updated_at  timestamptz
  last_id                 uuid          -- tiebreak within the same timestamp
  last_pulled_at          timestamptz
  full_resync_needed      boolean
```

Pull is `where org_id = $org and (server_updated_at, id) > ($ts, $id) order by server_updated_at, id limit 500`.
The `id` tiebreak matters because `now()` is per-transaction and a batch write can produce hundreds of rows at an identical timestamp, and a timestamp-only cursor will either skip or loop on them.
Soft-deleted rows come down the same cursor (that is the point of soft delete), and the client applies `deleted_at` locally.

**Written conflict rule per table.**

| table | rule |
|---|---|
| `branch` | LWW per field by `server_updated_at`. Low risk. |
| `tag_vocabulary` | LWW on `label`, `aliases`, `definition_text`. `status='merged'` plus `merged_into_id` is **monotonic**: once merged, an older write cannot un-merge it. |
| `creator` | LWW per field, **except**: `fit_score_override` plus `override_reason` plus `overridden_at` merge as a unit and the later `overridden_at` wins, never an AI projection. `lifecycle='blocked'` is **sticky**, block beats unblock from any lower `rev`. `scorecard` and `reliability_tier` are recomputed locally, never merged. |
| `collab` | `stage` is a **monotonic ladder**, `max(stage)` wins, except `outcome='cancelled'` which beats everything. LWW on the rest. `consent_*` and `usage_terms_text` are **write-once**, a second differing value is an error to surface, not a merge. |
| `brief` | **No conflicts possible.** Locked briefs are immutable (DB trigger), edits produce `version+1`. Pre-lock: LWW per field. |
| `brief_item` | Same, immutable once the parent brief is locked. |
| `delivery` | LWW on metadata. `clip_count` and `total_bytes` and `preflight_summary` are derived, recompute rather than merge. `nudge_sent_at` is write-once. |
| `asset` band 1 (origin facts) | **Write-once.** A conflicting value is a bug, not a merge: flag `review_conflict` and log it, do not pick a winner. |
| `asset` band 2 (preflight) | Derived. Recompute-wins, never merged. |
| `asset` band 3 (AI projection) | **Never LWW.** Sync the `ai_run` rows (append-only, immutable) and re-project locally from `max(created_at)` where `is_current`. This eliminates the entire class of "stale device overwrote a fresh AI result". |
| `asset` band 4 (curation) | **Never LWW.** Safety-biased monotonic: `rejected` beats `needs_fix` beats `approved` beats `pending`. If two humans disagree inside one sync window, keep both in `review_action`, set `review_conflict = true`, and surface a banner. `is_published` can only be set true by the same actor whose `review_status='approved'` won. |
| `asset` band 5 (storage keys) | `remote_object_key`, `poster_key`, `preview_key`, `sheet_key` are **write-once and never merged toward null**. `upload_state` and `upload_offset_bytes` are per-device local state, excluded from sync entirely. `used_count` and `download_count` are counters: **recompute from `usage_event`**, never sum-merge, or two devices double-count. |
| `tag` | Append-only edges, so no field conflicts. `removed_at` is **sticky**: a human removal beats a re-add from a stale device. `rejected_by_human` is sticky true. |
| `ai_run` | Insert-only, immutable, never updated. `is_current` is derived, so it cannot conflict. |
| `search_query_log`, `usage_event` | Insert-only, no updates, no conflicts. Highest volume, so batch them and sync last. **Explicitly lossy-tolerant**: dropping some degrades ranking and nothing else. |
| `saved_collection` | Owner-scoped, LWW is fine. `collection_item` is append-only with `removed_at`. |
| `review_action` | Insert-only, immutable. This is the audit log, it must never be mutated. **And it is now the source of truth for `asset.review_status`**, which is a projection over it (A.20), so merging approvals became merging an append-only log rather than merging a contested scalar. That makes band 4 easier to honour, not harder. |
| `review_session` | `ordered_asset_ids` and `sort_key_used` are **write-once** (a differing order is a defect, not a conflict). `cursor_index` merges as **max**, so two devices never walk the cursor backwards. `skipped_asset_ids` merges as **set union**, because a skip on either device is a skip. `completed_at` is **sticky**. `pending_additions` merges as set union. All four map onto existing primitives, which is a good sign the primitive set was right. |
| `asset.derivative_state` | **Ordinal, not LWW**: `none < failed < client_derived < server_derived`. A more capable producer's result wins regardless of clock, and a stale `none` from the browser that ingested the file can never erase a sheet a desktop shell or the server later produced. `derivative_producer` and the derivative keys travel coupled with it. |
| `gap`, `gap_scan` | Immutable outputs of a scan. Never merged, only inserted. |
| `gap_dismissal` | Keyed by `cell_signature`, upsert with the later `dismissed_at` winning, and **surviving every future scan**. |
| `access_token` | `revoked_at` is **sticky**. `uses` is server-incremented only, never client-merged. |

**The never-LWW list, stated plainly in one place**, because this is the question that matters:
`asset.review_status`, `asset.reviewed_by`, `asset.reject_reason_*`, `asset.is_published`, `asset.is_exemplar`, all of `asset` band 1, all `asset` storage keys, `asset.deleted_at` as a trigger for byte deletion, `creator.fit_score_override` plus `override_reason`, `creator.lifecycle='blocked'`, `collab.stage`, `collab.consent_*`, `collab.usage_terms_text`, locked `brief` and `brief_item` content, `tag` rows with `source='human'`, `tag.removed_at`, `tag.rejected_by_human`, `gap_dismissal`, `access_token.revoked_at`, and every row of `review_action`.

The single worst bug available in this system is a stale device flipping a `rejected` clip back to `approved` and republishing footage a human killed for consent or brand-safety reasons.
That is why band 4 is monotonic and safety-biased rather than last-write-wins.

**Media deletion is never a sync operation.**
`asset.deleted_at` hides a record.
Deleting bytes is a separate, explicit, manager-only `purge` action that writes a `review_action` row and only then removes the object.
No sync path, no cascade, and no automated job may delete media.
A sync bug should cost a UI glitch, not somebody's footage.

**How a merge actually executes, because a table of rules is not an implementation.**

Every table declares a merge policy as data, not as scattered `if` statements:

```
mergePolicy = {
  asset: {
    writeOnce:  ['original_filename','size_bytes','mime','container','codec_video',
                 'duration_s','width','height','rotation_deg','fps','captured_at',
                 'captured_at_source','gps_lat','gps_lng','frame_hashes','phash_primary',
                 'remote_object_key','poster_key','preview_key','sheet_key'],
    recompute:  ['preflight','preflight_version','used_count','download_count',
                 'ai_shot_type','ai_room','ai_quality_score','ai_description', ...],
    localOnly:  ['upload_state','upload_offset_bytes','media_state','local_file_key'],
    ordinal:    { review_status: ['pending','approved','needs_fix','rejected'] },
    coupled:    [['review_status','reviewed_by','reviewed_at',
                  'reject_reason_code','reject_reason_text']],
    lww:        ['human_description_override','is_hero','creator_facing_note',
                 'exemplar_note','creator_credit'],
    conflictFlag: 'review_conflict'
  },
  collab:  { ordinal: { stage: [...] }, override: { outcome: { cancelled: 'wins' } },
             writeOnce: ['consent_accepted_at','consent_text_version','usage_terms_text'], ... },
  creator: { coupled: [['fit_score_override','override_reason','overridden_by','overridden_at']],
             sticky:  { lifecycle: 'blocked' }, recompute: ['scorecard','reliability_tier'], ... },
  tag:     { appendOnly: true, sticky: { removed_at: 'set', rejected_by_human: true } },
  ai_run:  { immutable: true },
  ...
}
```

Six merge primitives cover every row in the conflict table, which is why the table is implementable rather than aspirational:

| primitive | behaviour |
|---|---|
| `writeOnce` | first non-null value wins. A differing second value is a **defect**, not a conflict: log it and raise `conflictFlag`, do not pick a side |
| `recompute` | never merged at all. Discard both sides and re-derive locally from `ai_run` or from source rows |
| `localOnly` | stripped from the outbox on the way out, ignored on the way in |
| `ordinal` | the value later in the declared array wins, regardless of timestamp. This is what makes `rejected` beat `approved` and `library` beat `source` |
| `coupled` | a field group merges as one unit, keyed off the group's own timestamp. This is what stops "reviewer A's name" landing next to "reviewer B's decision", which is the failure that makes an audit log lie |
| `sticky` | once set to the named value, it cannot be unset by any incoming patch |

`coupled` is the one most designs miss.
Field-level LWW without it produces records where `review_status='rejected'`, `reviewed_by` is a different person, and `reject_reason_text` belongs to a third decision.
Each field individually took the latest write and the row as a whole is fiction.

**Conflicts are records, not toasts.**
When a merge raises `conflictFlag`, write a `sync_conflict` row (local only: `table_name`, `record_id`, `field_group`, `local_value`, `remote_value`, `policy`, `resolved_by`, `resolved_at`).
The Sync panel lists them, the deal drawer and clip sheet show an inline banner for the affected record, and a human resolves it explicitly.
A conflict that is only a transient notification is a conflict that gets dismissed and then discovered three weeks later in a campaign.

**Rejected: CRDTs.**
Automerge or Yjs would remove the need for most of the table above, and they are the wrong tool here.
The conflicts in this product are semantic (an approval against a rejection), not textual, and a CRDT converges on a state that is mathematically consistent and can be a state no human intended.
The six primitives above encode the domain's actual precedence rules, they are inspectable as data, and the `LoopbackAdapter` executes and tests them without a server.

### C.4 What we build now versus what we stub

**Built now, real code, no server required:**

- The full IndexedDB schema with the envelope on every record, UUIDv7 ids, soft delete, `rev`, and `_local` namespacing.
- The scoped repository from A2.3, with three session factories and the projection allowlists. This is the same file that becomes the RLS contract.
- The outbox, genuinely written to by every mutation, with a Dev / Sync panel showing depth, per-table counts, and the actual patch payloads.
- `sync_state` with per-table cursors, and the pull loop written against an adapter interface.
- **`SyncAdapter` with three implementations.** `LocalOnlyAdapter` (drains to nothing but records that it drained). `SupabaseAdapter` (real `supabase-js` calls, real table names, gated behind `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, never invoked in the demo). And **`LoopbackAdapter`**, which drains the outbox into a *second* IndexedDB database that plays the role of the server, complete with its own `server_updated_at` clock and its own conflict-rule application.
- The migrations themselves: `0001_init.sql`, `0002_rls.sql`, `0003_functions.sql`, committed and readable.
- `collabPublicView()` as a pure local function, byte-for-byte the same allowlist as `collab_public()` in SQL.
- The 40-line scope test asserting forbidden tables throw and forbidden fields are absent.

The `LoopbackAdapter` is the piece that makes "a planned working connection" real instead of a claim.
Open two browser tabs, mutate a clip's review status in one, pull in the other, watch the written rule resolve a deliberate conflict, and read the outbox that carried it.
That is a genuine demonstration of the sync design with zero deployment, and because the adapter interface has to exist regardless, the loopback implementation is also where the per-table conflict rules from C.3 get executed and tested rather than merely written down.
It is the test harness for the merge logic, which is the part of a sync design most likely to be wrong and least likely to be exercised before it matters.

**Stubbed, documented, honestly labelled:**

- An actual Supabase project, buckets, and deployed edge functions.
- Supabase Auth. The prototype uses the dev role switcher, and the RLS is written as though `auth.uid()` exists, which it will.
- Realtime subscriptions. The pull loop is polling-shaped, and a `postgres_changes` subscription later just calls the same pull.
- Signed upload URL minting. Interface plus fake implementation returning a local OPFS handle.
- Server-side transcoding. Described in D, not built.

**The honesty rule:** the Sync panel displays `Adapter: loopback` in plain text.
Nothing in the UI or the README says "connected to Supabase".
A panel that catches an overclaim discounts everything else, and a panel that sees an accurate label plus a committed RLS file concludes the opposite.

### C.5 Local schema: object stores, indexes, and migration mechanics

**Object stores**, one per Postgres table, same names, `keyPath: 'id'`, plus five local-only stores that never sync.

| store | indexes (name: keyPath) | notes |
|---|---|---|
| `branch` | `by_pull: [server_updated_at, id]` | |
| `creator` | `by_lifecycle: lifecycle`, `by_reliability: [reliability_tier, display_name]`, `by_pull` | creators list sorts on the second one |
| `collab` | `by_stage: [stage, stage_entered_at]`, `by_creator: creator_id`, `by_branch_stage: [branch_id, stage]`, `by_pull` | the kanban and the stalled-SLA list |
| `brief` | `by_collab_version: [collab_id, version]`, `by_pull` | |
| `brief_item` | `by_brief_seq: [brief_id, seq]`, `by_origin_gap: origin_gap_id`, `by_pull` | `by_origin_gap` is what makes close detection a lookup |
| `delivery` | `by_collab: [collab_id, started_at]`, `by_status: status`, `by_pull` | |
| `asset` | `by_delivery: [delivery_id, created_at]`, `by_collab: collab_id`, `by_confirmed_item: confirmed_brief_item_id`, `by_collab_unmatched: [collab_id, has_match]`, `by_review: [review_status, created_at]`, `by_library: [is_published_num, published_at]`, `by_branch_shot: [branch_id, ai_shot_type]`, `by_phash: phash_primary`, `by_exemplar: is_exemplar_num`, `by_derivative: [derivative_state, transcode_priority]`, `by_needs_judgement: [review_status, preflight_unknown_num]`, `by_pull` | see the boolean note below |
| `contact_sheet` | `by_asset: asset_id` | holds the Blob |
| `asset_frame` | `by_asset_seq: [asset_id, seq]`, `by_sheet: sheet_id` | |
| `tag_vocabulary` | `by_slug: slug` (unique), `by_facet_status: [facet, status]`, `by_merged: merged_into_id`, `by_pull` | |
| `tag` | `by_subject: [subject_type, subject_id]`, `by_subject_live: [subject_type, subject_id, removed_flag]`, `by_vocab: vocab_id`, `by_run: ai_run_id`, `by_pull` | `by_run` is what makes a mock purge a single cursor |
| `ai_run` | `by_subject_kind: [subject_type, subject_id, kind]`, `by_current: [subject_type, subject_id, kind, current_flag]`, `by_cache: [input_hash, prompt_hash, model_id]`, `by_provider: [provider, kind]`, `by_pull` | |
| `search_query_log` | `by_created: created_at`, `by_user_created: [user_id, created_at]`, `by_zero: [zero_flag, created_at]`, `by_refined_from: refined_from_query_id`, `by_pull` | the gap scan reads `by_zero` and walks `by_refined_from` |
| `usage_event` | `by_asset: [asset_id, created_at]`, `by_query: query_id`, `by_user: [user_id, created_at]`, `by_event: [event, created_at]`, `by_pull` | |
| `saved_collection` | `by_owner: [owner_user_id, last_opened_at]`, `by_pull` | |
| `collection_item` | `by_collection: [collection_id, rank]`, `by_asset: asset_id`, `by_pull` | |
| `review_action` | `by_scope: [scope, scope_id]`, `by_actor: [actor_user_id, created_at]`, `by_method: method`, `by_session: [session_id, scope_id]`, `by_pull` | `by_session` enforces keystroke idempotency and drives the `review_status` projection |
| `review_session` | `by_actor_open: [actor_user_id, open_flag, updated_at]`, `by_scope: [scope, scope_id]`, `by_pull` | `open_flag` is the 0/1 mirror of `completed_at is null` |
| `gap_scan` | `by_ran: ran_at`, `by_pull` | |
| `gap` | `by_scan_severity: [scan_id, severity, deficit_score]`, `by_branch_status: [branch_id, status]`, `by_cell: cell_signature`, `by_pull` | |
| `gap_dismissal` | `by_cell: cell_signature` (unique), `by_pull` | |
| `insight` | `by_subject: [subject_type, subject_id]`, `by_kind_status: [kind, status]`, `by_pull` | |
| `access_token` | `by_hash: token_hash` (unique), `by_collab: collab_id`, `by_pull` | |
| `app_user` | `by_role: role`, `by_pull` | |
| `search_token` | `by_token: token`, `by_token_asset: [token, asset_id]`, `by_asset: asset_id` | local only, rebuildable |
| `asset_facet` | `by_facet_value: [facet, value]`, `by_asset: asset_id` | local only, rebuildable |
| `reindex_queue` | `by_asset: asset_id` (unique, so enqueues coalesce) | local only |
| `outbox` | `by_seq: seq`, `by_status: [status, seq]`, `by_record: [table_name, record_id]` | local only, never synced |
| `sync_state` | keyPath `table_name` | local only |
| `meta` | keyPath `key` | holds `schema_version`, `seed_version`, `persist_granted` |

**Two IndexedDB constraints that shape this, worth stating because they catch people:**

1. **Booleans are not indexable in IndexedDB.** `IDBKeyRange` cannot use `true` or `false` as a key. So every boolean that needs an index is mirrored as a `0`/`1` integer alongside it: `is_published_num`, `is_exemplar_num`, `removed_flag`, `current_flag`, `zero_flag`, `has_match`, `preflight_unknown_num`, `preflight_blocking_fail_num`, `open_flag`. These are system-owned derived mirrors, written by the repository on every put, and they are the local counterpart to Postgres partial indexes and generated columns (`where is_published`, `preflight_blocking_fail`). Same intent, different mechanism, and if you skip them the library query degrades to a full store scan.
2. **`null` is not a valid index key either.** A record with `confirmed_brief_item_id = null` is simply absent from `by_confirmed_item`, which is usually what you want. It is not what you want for the unmatched-extras bucket, which is exactly why `by_collab_unmatched` uses the `has_match` 0/1 mirror rather than testing the nullable field.

**Migration mechanics, in full.**

```
migrations = [
  { v: 1, structural(db, tx) {...}, data: null },
  { v: 2, structural(db, tx) {...}, data: async (repo) => {...} },
  ...
]
```

- **Structural changes** (`createObjectStore`, `createIndex`, `deleteIndex`) can only run inside `onupgradeneeded`, so `structural(db, tx)` runs there and must be synchronous. No awaits, no fetches, no model calls.
- **Data changes** run after open, in `data(repo)`, chunked by cursor in batches of 500 inside their own transactions, with progress reported to a splash indicator. This is what keeps a 5,000-row backfill from blocking the main thread and from dying inside a single long IDB transaction (IndexedDB auto-commits a transaction the moment the event loop goes idle, so a long `await` inside one is a bug, not slowness).
- **`meta.schema_version` is written only after both phases succeed.** A crash mid-migration re-runs it, so every `data` step must be **idempotent**. Write them as "set the field if absent", never "increment the field".
- **Renames are expand then contract, across three releases**: (1) add the new field and dual-write both, (2) backfill the new field and switch all reads, (3) stop writing and drop the old. Never rename in place, because IndexedDB has no `ALTER` and the only way to do it atomically is a full store rewrite.
- **Never write a migration that needs the network.** The app must open successfully on a plane, and a migration that fetches is an app that will not start.
- **Version bump discipline:** the migration lands in the same commit as the field. Not the next commit, because by then there is data.
- **Forward only.** No down migrations. Recovery is delete-and-reseed for the demo profile, and export-then-import for a live profile, which is one more reason B.2's export exists.
- **The migration test:** for every version N, open a database seeded at version N-1 and assert the upgrade produces the expected shape. The committed `seed.json` diffed in PRs is the cheap version of this, and it catches most of what matters.

**The Postgres side mirrors this exactly**: numbered forward-only files, additive, expand-then-contract for renames, and a `supabase/migrations/README` noting which local `schema_version` each SQL file corresponds to.
That mapping is what keeps "the local model and the future Supabase schema match one to one" true over time rather than only on day one.

---

## C2. Demo and mock mode: provenance, determinism, seed, fixtures, namespacing

The AI engines will not be called for this submission, every AI capability is simulated, and the production code path must be exactly what ships.
Mock is a swappable implementation behind one interface, never a fork.
The data layer's job is to make that safe, which means: a mock output can never masquerade as a real one, and a demo can never contaminate real data.

### C2.A Provenance on `ai_run`

**The design rule: provenance is a database constraint, not a convention.**
A mock run must be structurally incapable of claiming a model produced it.

Delta to the `ai_run` DDL from C.1:

```sql
create type ai_provider as enum ('live','replay','mock');
--  live   = real API call to Claude through the Netlify function
--  replay = a captured REAL model response, replayed from a committed fixture, no network
--  mock   = synthetic output generated by local deterministic code, never seen by a model

alter table ai_run
  add column provider          ai_provider not null default 'live',
  add column provider_detail   text,          -- 'claude-via-netlify' | 'fixture' | 'synthetic-v1'
  add column simulated_model_id text,         -- what a mock IMITATES, never what produced it
  add column fixture_id         text,         -- which committed fixture supplied the response
  add column fixture_hash       text,         -- sha256 of that fixture file
  add column effort             text check (effort in ('low','medium','high')),
  add column schema_key         text,         -- which JSON schema validated the output
  add column schema_version     text,
  add column schema_valid       boolean not null default true,
  add column latency_source     text not null default 'measured'
      check (latency_source in ('measured','simulated')),
  add column replayed_from_run_id uuid,       -- when a captured live run is replayed
  add column is_synthetic       boolean generated always as (provider <> 'live') stored;

alter table ai_run add constraint ai_run_provenance_ck check (
     (provider = 'live'   and model_id is not null and fixture_id is null
                          and simulated_model_id is null)
  or (provider = 'replay' and model_id is not null and fixture_id is not null)
  or (provider = 'mock'   and model_id is null     and fixture_id is null
                          and simulated_model_id is not null)
);

create index ai_run_provider_idx on ai_run (org_id, provider, kind) where is_current;
```

`model_id` is null for mock, always.
`simulated_model_id` holds `'claude-opus-5'` so the UI can say "simulated Claude Opus 5 output" without the row ever asserting that Claude produced it.
The check constraint makes the dishonest state unrepresentable, and the same invariant is asserted in the local IndexedDB write path (one guard function in the repository layer, about eight lines).

`latency_source` matters more than it looks: a demo applying a fake 1,200ms delay for realism must not have that number averaged into real performance statistics later.
`schema_key` plus `schema_version` plus `schema_valid` record that mock output was validated against **the same JSON schema as the live path**, which is the whole claim of "mock is not a fork" made checkable rather than asserted.

**Can the app tell, for any clip, whether its tags came from a real model call or a mock? Yes, at three levels.**

1. **Per individual tag**, exactly: `tag.ai_run_id` to `ai_run.provider`. One AI tag can be live while another on the same clip is mock, and the model represents that correctly.
2. **Per asset, without a join**, for the grid: a denormalized `asset.ai_provenance` enum (`'live' | 'replay' | 'mock' | 'mixed' | 'none'`), written by the same projection step that writes the `ai_*` fields. Cheap, and it means the library grid can badge simulated clips at 40 tiles per screen with no lookup.
3. **Per dataset**: a Data Health panel counting `ai_run` grouped by `provider` and `kind`, so "is any of this real" is answerable in one glance.

**UI consequence, stated because it is a data decision not a cosmetic one:** the "simulated" badge is driven by `asset.ai_provenance`, never by the build flag or the current mode.
A badge driven by mode lies the instant the data is mixed, which is exactly the situation the badge exists for.

**Purging or re-running the mock runs when a real key arrives.**

The operation is already available because `ai_run` is append-only and every AI field is a projection:

1. `select subject_type, subject_id, kind from ai_run where is_current and provider <> 'live'` gives the exact work list.
2. Enqueue a live run per row, insert the new `ai_run`, set `superseded_by_run_id` on the old one, flip `is_current`.
3. Re-project. Done.

**Mock runs are superseded, never deleted.**
Keeping them means you can diff what the mock predicted against what the real model produced on the same input, which is a genuinely useful artifact and costs nothing but rows.

The proof mechanism, and this is the part that answers "a demo silently poisons the dataset":
**`rebuildDerived({ sources: ['live'] })`** wipes every AI projection and re-projects using only `provider='live'` current runs.
Anything with no live run comes back visibly un-enriched.
Flip that switch and you can see precisely what the demo contributed, with no guessing.

**What a mock purge must never touch**, and the predicate must be written this narrowly:
`tag` rows with `source='human'`, any row with `rejected_by_human = true`, every `review_action`, `asset` band 1 and band 4, and all `consent_*`.
The purge predicate is `tag.source = 'ai' and tag.ai_run_id in (<mock run ids>)`, never "delete the tags on this asset".
A blanket delete here would destroy the human curation that is the most expensive data in the system.

*Nice-to-have:* `review_action.ai_provenance_at_decision`, one column recording whether a human approval was made while looking at simulated AI evidence.
It answers "which of these approvals rest on fake scores", it is one column, and it is not needed to pass.

### C2.B Determinism

**Two injected services, and no ambient access to either, anywhere in the data or id layer.**

- `Clock`: `now(): number`. Production `SystemClock` wraps `Date.now()`. Demo and test `SeededClock` starts at a fixed epoch (`2026-08-01T09:00:00.000Z`) and advances only by explicit tick or by a fixed delta per operation.
- `Rng`: `next(): number` plus `bytes(n): Uint8Array`. Production `CryptoRng` wraps `crypto.getRandomValues`. Demo and test `SeededRng` is a small deterministic PRNG (sfc32 or xoshiro128\*\*) seeded from a string like `'astolia-seed-v1'`.

**Enforced, not just intended**, with an eslint rule rather than a code review habit:
`no-restricted-globals` and `no-restricted-properties` banning `Date.now`, `new Date()`, `Math.random`, `crypto.randomUUID`, and `performance.now` everywhere except `src/platform/clock.ts` and `src/platform/rng.ts`.
About ten lines of config, and it is the difference between determinism holding and determinism decaying by hour 60.

**The id question, which is the real one here.**

UUIDv7 layout (RFC 9562): 48 bits of Unix milliseconds, 4 version bits, 12 bits `rand_a`, 2 variant bits, 62 bits `rand_b`.
Both of its inputs are exactly the two services above.

**So: one id scheme, not two. `uuidv7(clock, rng)`.**

- **Production**: real milliseconds plus CSPRNG bits, so ids sort by real time and are unguessable.
- **Demo and test**: seeded-clock milliseconds plus seeded-PRNG bits, so the same run produces byte-identical ids every time, and they still sort by their (synthetic) time.

The one wrinkle worth solving properly: a seeded clock can return the same millisecond for hundreds of consecutive ids, and pure random `rand_a` would make them sort arbitrarily within that millisecond.
**Use the 12-bit `rand_a` field as a monotonic sub-millisecond counter** (this is RFC 9562's own "method 1"), reset whenever the millisecond changes.
That gives strict, stable sort order even under a frozen clock, which is the demo case, and it is also the correct production behaviour for burst inserts.
Belt: have `SeededClock` auto-advance 1ms per id request as well, so a 5,000-row bulk seed cannot exhaust the 4,096-slot counter.

No second id scheme, no `if (demo)` branch in the generator, and sortability preserved in both worlds.

**Three other determinism traps in the data layer, all worth naming:**

1. **Hash inputs must be canonicalised.** `prompt_hash`, `input_hash`, `fixture_hash`, and `cell_signature` are all sha256 over JSON. Serialise with **sorted keys** before hashing, or two runs with the same logical input produce different hashes and the `ai_run` cache never hits. This is a quiet, expensive bug.
2. **Never format with the device timezone.** Render dates in `branch.timezone` explicitly. Otherwise the same seed renders different day labels on a reviewer's machine than in the README screenshots, and "the demo looks wrong" is the conclusion.
3. **Latency is data, not a measurement, in replay and mock.** It comes from the fixture and is stamped `latency_source='simulated'`.

IndexedDB cursor order is deterministic for identical data and index, so retrieval needs nothing extra.

### C2.C The seeded demo dataset

**Shape**, concrete counts:

| entity | count | notes |
|---|---|---|
| `org` | 1 | |
| `branch` | 2 | San Jose (primary, full data), Palo Alto (thin, 2 assets, proves multi-branch and gap-scan cold start) |
| `app_user` | 3 | manager, editor, plus one manager with `branch_scope=['san-jose']` to prove the scope mechanism |
| `creator` | 8 | 2 `trusted`, 2 `proven`, 3 `new`, 1 `blocked` |
| `collab` | 8 | one in **every** stage, plus a ghosted one, see below |
| `brief` | 6 | one draft, four locked, one superseded (so versioning is visible) |
| `brief_item` | ~58 | 8 to 12 per brief |
| `delivery` | 6 | one collab has **2** deliveries, so the resumable multi-session case is real data |
| `asset` | ~55 | ~33 published to the library, 22 pending in the hero delivery |
| `contact_sheet` / `asset_frame` | 55 / ~275 | |
| `tag` | ~660 | ~9 AI, ~2 human, per asset |
| `tag_vocabulary` | ~50 | 45 active, 4 `proposed` (rule-created from query tokens), 1 completed merge with aliases |
| `ai_run` | ~90 | all `replay` or `mock`, including 2 with `status='error'` |
| `search_query_log` | 240 | composition below |
| `usage_event` | ~600 | `rank_at_event` populated, concentrated on ~12 assets |
| `saved_collection` | 4 | 2 saved searches, 1 manual project bucket (6 items), 1 `ai_auto`, one of them pinned |
| `gap_scan` | 2 | an older scan and a current one, so "found last month, closed since" is real |
| `gap` | 12 | 9 open (2 critical, 3 high, 4 medium), 2 `closed` with `closing_asset_ids`, 1 `dismissed` |
| `gap_dismissal` | 1 | keyed by `cell_signature`, survives the newer scan, which is the point |
| `review_action` | ~30 | mixed `method`: manual, 4 `batch`, 3 `auto_threshold`, 1 `sampled_qa` |
| `access_token` | 4 | 2 live (invite + upload), 1 expired, 1 revoked |

`search_query_log` composition matters more than the count: about 150 with clicks (with realistic `clicked_ranks` including several at rank 5 to 9, so the ranking signal is not trivially "always rank 1"), about 45 zero-result, about 25 refine-then-abandon chains of 2 to 3 queries, about 20 explicit editor gap requests.
The zero-result and abandoned rows must **cluster on 3 or 4 specific cells**, so the gap scan produces a handful of believable gaps rather than forty noisy ones.
A gap scan that outputs forty gaps is indistinguishable from a random number generator, and a reviewer will read it that way.

**The eight collabs, one per stage:**

1. `source`: raw inbound, not yet vetted. Shows the pre-AI empty state.
2. `vet`: AI fit score 78, **human override to 62 with a stored reason**, so the precedence rule is visible in the UI rather than only in this document.
3. `book`: booked, no brief yet.
4. `brief`: AI-generated brief, human-edited, still `draft`, with `edited_fields` populated.
5. `visit`: brief locked, visit is today, nothing delivered. This is the collab whose live token the reviewer opens.
6. `delivered`: **the hero record.** 22 assets against a 10-item locked brief, across 2 deliveries, deliberately imperfect.
7. `library`: fully closed, 14 approved and published assets.
8. `ghosted`: brief locked, visit 3 weeks past, zero deliveries, `outcome='ghosted'`, nudge drafted and sent. Without this the creator scorecard is meaningless because nothing ever went wrong.

**Deliberately imperfect cases, all required in seed:**

1. **Short delivery**: collab 6 covers 7 of 10 brief items, so the diff shows 3 unmet and a nudge draft exists.
2. **Clips matching no brief item**: 3 assets with both `ai_matched_brief_item_id` and `confirmed_brief_item_id` null, landing in the extras bucket. Creators always shoot extra, and a diff that cannot show extras is wrong.
3. **Duplicate**: 2 assets with matching `phash_primary`, one carrying `preflight.duplicate_of_asset_id`.
4. **Rejected clips**: 2, each with a blunt internal `reject_reason_text` and a softer `creator_facing_note`, so the redaction from A2.2 is demonstrable.
5. **Preflight, one asset per status per rule**, so the tri-state in A.19 is visible in data rather than only in prose: 1 horizontal (`orientation: fail`), 1 shot 2 days before the visit date (`capture_date: fail`), 1 with GPS 8km from the branch (`near_branch: fail`), and critically **1 camera-offload asset with no GPS atom at all** (`near_branch: unknown`, `capture_date: unknown`, `captured_at_source: 'filesystem'`) plus **1 where the creator supplied the date** (`captured_at_source: 'creator_stated'`). Without the `unknown` rows, the grey-dash rendering path is untested and somebody will ship a red cross for a camera with no GPS receiver.
5b. **A camera-offload delivery**: 3 assets with ProRes or H.265 in MOV, landscape, 800MB+, no GPS, `derivative_state` varying, so the desktop upload path is real data and not a hypothetical.
5c. **The open HEVC case**: 1 asset with `codec_video='hvc1'`, `client_decodable=false`, `derivative_state='none'`, **no `contact_sheet` row**, no `ai_run`, no AI tags, and `brief_item.status='indeterminate'` on its intended item. This is the E.4b state, and it must be in seed or the honest-degradation path is untested and the "awaiting derivatives" bucket renders empty.
6. **Ghosted creator**: collab 8.
7. **AI and human disagreement**: 2 assets where `ai_matched_brief_item_id != confirmed_brief_item_id`, so match accuracy is a real number rather than 100%.
8. **A sync conflict**: 1 asset with `review_conflict = true`, to show the banner.
9. **Cold start for the gap scan**: Palo Alto has 2 assets plus a populated `target_coverage` and almost no search history, so the coverage-only gap mode from F produces gaps with no demand signal at all. If this is not in seed, the cold-start path is untestable and will be broken.
10. **HEVC**: 1 asset with `codec_video='hvc1'` and `media_state='bytes_absent'`, so the poster-only-pending-transcode card renders.
11. **Brand safety hold**: 1 asset with `ai_brand_safety='review'`, so the hard gate from E.1 is visible.

**How the seed ships: a committed artifact, generated by a committed script.**

`scripts/build-seed.mjs` runs under `SeededClock` plus `SeededRng` and writes `/public/seed/seed.json` plus `/public/seed/img/*.jpg`.
Both the script and its output are committed.

Reasons for committing the artifact rather than generating at runtime:
the reviewer sees byte-identical data to the README screenshots, the JSON is diffable in a PR so a schema change that breaks the seed surfaces in review, and boot is a fetch plus a bulk `put` instead of seconds of generation on a phone.
Keeping the generator committed means the seed stays reproducible and regenerable, which is the best of both and costs nothing.

**Reset**: a "Reset demo data" button that calls `indexedDB.deleteDatabase(<demo db>)`, removes the OPFS `demo/` directory, and re-hydrates.
Deleting the whole database rather than clearing stores also resets the schema version, which is what you actually want after a migration change.

**Non-empty library within 15 seconds**, which is a hard requirement for a hiring panel:
hydration runs during the splash, in one IndexedDB transaction per store.
About 2,000 rows total, comfortably under a second.
The app opens **directly on the library grid with 33 published assets already visible**, posters read from `/seed/img/` and written into IndexedDB as Blobs in the background.
Target: interactive in under 3 seconds cold, no click, no scenario to choose first.
The scenario picker is for the reviewer's *second* action, never their first.

### C2.D Fixture media and the manifest

Generated once by `scripts/build-fixtures.mjs` using `ffmpeg-static` as a devDependency, output committed to `/public/fixtures/`.
The binary never ships (devDependency), the outputs are small, and the repo clones and runs with zero setup.

**Fixture set: about 8 clips of 4 to 8 seconds, each engineered to hit exactly one preflight branch.**

| fixture | what it proves |
|---|---|
| `vertical_ok.mp4` (1080x1920, H.264, 6s, correct date, GPS at branch) | the happy path |
| `horizontal_fail.mp4` (1920x1080) | `is_vertical` fails |
| `short_fail.mp4` (1.5s) | `meets_min_duration` fails |
| `lowres_fail.mp4` (480x854) | `meets_min_res` fails |
| `rotated_90.mp4` (1920x1080 coded, `tkhd` rotation matrix 90) | **the most valuable fixture in the set**: display orientation is vertical while coded dimensions are horizontal, which is exactly what naive implementations get wrong on every iPhone clip |
| `hevc.mov` (`hvc1` in MOV) | codec detection plus **the open hole in E.4b, live.** On a Windows reviewer's machine without the HEVC extension this genuinely will not decode, and the demo shows honest degradation rather than a simulation of it. Note it in the README so the behaviour reads as intentional |
| `prores.mov` (`apcn`, landscape, no GPS atom, no creation atom) | the camera-offload path: `near_branch: unknown`, `capture_date: unknown`, `codec_playable: fail`, and a file large enough to exercise the byte budget |
| `no_metadata.mp4` (atoms stripped) | `captured_at_source='unknown'`, honest degradation |
| `duplicate_of_vertical_ok.mp4` (same frames, re-encoded) | perceptual dedupe, since the bytes differ but the frames match |

Plus 2 or 3 pleasant vertical b-roll clips purely for the preview player demo.

**Manifest record**, `/public/fixtures/manifest.json`, one entry per fixture:

```json
{
  "fixture_id": "rotated_90",
  "path": "/fixtures/rotated_90.mp4",
  "bytes": 412388,
  "sha256": "9f3c8a...",
  "generator_version": 1,
  "ffmpeg_args": ["-f","lavfi","-i","testsrc2=size=1920x1080:rate=30:duration=6","..."],
  "declared": {
    "container": "mp4", "codec_video": "avc1", "codec_audio": "aac",
    "coded_width": 1920, "coded_height": 1080, "rotation_deg": 90,
    "duration_s": 6.0, "fps": 30,
    "captured_at": "2026-08-04T10:12:00Z",
    "gps": { "lat": 37.3382, "lng": -121.8863 }
  },
  "expected_preflight": {
    "orientation": "vertical", "is_vertical": true,
    "meets_min_duration": true, "meets_min_res": true,
    "on_visit_date": true, "near_branch": true, "distance_m": 120,
    "duplicate_of_asset_id": null
  },
  "expected_frames": { "count": 5, "t_seconds": [0.5, 1.6, 3.0, 4.4, 5.5] },
  "expected_phash_prefix": "9f3c",
  "tolerance": { "duration_s": 0.05, "distance_m": 30, "dhash_hamming": 4 }
}
```

Three things about that shape carry the weight:

- **`declared` versus `expected_preflight` are separate on purpose.** `declared` is what ffmpeg was instructed to produce, so it is ground truth by construction. `expected_preflight` is what our client code must independently derive from the bytes. A test asserting against `declared` tests ffmpeg. A test asserting `expected_preflight` tests our parser, which is the only interesting assertion.
- **`tolerance` is mandatory, not defensive.** Frame extraction timing and perceptual hashes are not bit-exact across browsers and codec builds, so exact equality is the wrong assertion, not a stricter one. Assert dHash within Hamming distance 4, duration within 50ms, distance within 30m. A test that fails for reasons unrelated to correctness teaches the team to ignore it, and an ignored test is worse than a tolerant one.
- **`sha256`** so a regenerated fixture that differs from the committed one fails loudly instead of quietly changing what the tests mean.

**Where fixture media and derived sheets live across the storage tiers, and why it matters.**

- **Fixture video bytes**: bundled static assets under `/public/fixtures/`, served over HTTP.
- **Demo load path**: `fetch(url)` then `Response.blob()` then `new File([blob], name, { type })`, and that `File` goes into **the exact same `ingestFile(file)` entry point the real `<input type="file">` handler calls**.
- Therefore the demo exercises real MP4 atom parsing, real `<video>` decode, real canvas frame extraction, real dHash, real contact sheet JPEG encoding, real OPFS write, real IndexedDB write.
- **Derived contact sheets and posters for fixtures are generated live at demo time** into IndexedDB as Blobs. Not pre-baked.
- **Fixture originals are written to OPFS** exactly as an upload would write them, so `media_state='bytes_local'` is genuinely true and the preview player reads from OPFS rather than from a bundle URL.

The only difference between demo ingest and real ingest is where the `File` came from, and a `File` from `fetch` is indistinguishable from a `File` from a file input.
One function, two callers, no bypass.

**One honest asymmetry, stated deliberately so nobody "optimises" it away later:**

- The **55-asset seed library** ships **pre-baked** posters and sheets, `media_state='bytes_absent'`. Reason: generating 55 contact sheets on boot would cost 30-plus seconds and break the 15-second requirement.
- The **8-clip fixture set** runs the **real pipeline live** when the reviewer clicks "Load demo delivery". Slower by design, and it is the thing that proves the pipeline works.

Two mechanisms, two different jobs.
Write that down in the README, because pre-baking the fixture derivatives looks like an obvious optimisation and would delete the only proof that the ingest code actually runs.
The slowness of the fixture path is the feature.

### C2.E Mode switching at runtime

**Decision: separate namespaced IndexedDB databases per profile, not a flag on rows in a shared database.**

`astolia_demo_v{schema}` and `astolia_live_v{schema}`, plus separate OPFS subdirectories `demo/` and `live/`, plus `localStorage.active_profile`.

**Defence, taking the hard case directly: someone demos, enters a real key, then keeps working.**

1. **A row flag requires every query in the app to filter on it, forever.** That is the identical failure mode to scattered visibility scoping: one forgotten query and demo data appears in a real library. A separate database makes the leak physically impossible, because the open connection does not contain the other data at all.
2. **Reset becomes total and trivial.** `deleteDatabase` plus removing the OPFS directory. With a shared store, reset is a scan-and-delete across twenty object stores that will miss something (a `usage_event` here, a `search_token` there) and leave orphans that quietly break counters and search results.
3. **The mixed case resolves correctly and honestly.** The reviewer demos, likes it, adds a real key, and lands in the `live` profile, which is **empty**. That is the truth: they have no real data because they have done no real work. The demo profile is intact and one switch away. Nothing is corrupted because nothing was ever shared.
4. **Sync safety, which settles the argument on its own.** The outbox lives inside its database. The demo profile's outbox is bound to the `LoopbackAdapter` and structurally cannot target a real Supabase project. With a shared store plus a flag, a single bug in the outbox drain pushes 55 fabricated creators and 8 fake collabs into a production database. That is an unrecoverable, embarrassing failure, and namespacing removes the possibility rather than reducing the odds.
5. **Migrations are independently testable**, and a broken demo seed cannot corrupt a live schema.

The real cost: a reviewer cannot view demo and live data side by side, and cannot promote demo data into live.
Both are correct behaviours rather than limitations.
Demo data must never graduate.

**Two rules that keep the switch safe:**

- **The AI key does not define the profile.** Profile and AI provider are two separate, explicitly shown switches. A real key present while in the demo profile still routes through `provider='replay'` or `'mock'` until the provider switch is also flipped. Conflating them is how you get either a demo that silently spends money or a real session that silently writes fake tags.
- **Switching profile tears down and reopens the store through the repository factory.** On a prototype the correct implementation is: write `localStorage.active_profile`, then reload the page. A reload eliminates an entire class of stale-connection bug for zero code, and nobody will ever notice the reload.

Demo-only UI (scenario picker, "load demo delivery", reset, role switch) sits behind `import.meta.env.VITE_DEMO_TOOLS` so it is tree-shaken out of a production build, per the stack decision already made.

**Net effect: provenance is enforced twice, at two different layers.** An AI record cannot lie about being mock (the check constraint plus the local guard), and a demo record cannot reach the live store (the namespace).
Both are close to free.

**All three of the following are in scope**, and each earns its place:
the **mock-versus-live diff view** (compare a mock run to a later live run on the same subject, which is how you find out whether the mock was a fair stand-in), **`review_action.ai_provenance_at_decision`** (once mock and live coexist, this is the only way to audit which human approvals rested on simulated scores), and the **Data Health panel** counting runs by provider and kind (the direct answer to "is any of this real", which a simulated-AI submission should volunteer rather than wait to be asked).

**Fixture generation in CI is the one thing to skip, and not for effort:** committed fixtures are the point. CI-generated fixtures would differ byte for byte across ffmpeg builds, which breaks the reproducibility the manifest hashes exist to guarantee. Generate locally, verify the sha256, commit.

---

## C3. The platform port

The codebase already has three seams: a **provider interface** for AI, a **`SyncAdapter`** for sync, and a **scoped repository** for visibility.
Platform capability is the fourth, and it needs the same treatment for the same reason: one implementation is exercised and the others must be swappable without touching callers.

**Interface name: `PlatformPort`.** One object, resolved once at startup by `resolvePlatform()`, injected exactly like `Clock` and `Rng`.

```
PlatformPort {
  id: 'browser' | 'electron' | 'native'
  blobs:      BlobStore        // small binaries: sheets, posters
  bytes:      ByteStore        // large binaries: originals
  media:      MediaCodec       // probe, decode, extract, transcode
  picker:     FilePicker       // choose files, folder drop, directory watch
  quota:      QuotaReporter    // usage, limits, persistence, eviction risk
  secrets:    SecretStore      // model key custody
  capability: CapabilityProbe  // feeds deriveIngestPolicy (E.4a)
}
```

**The seven sub-interfaces, and what each implementation does.**

| seam | `browser` (built, exercised) | `electron` (designed, not built) | `native` (designed, not built) |
|---|---|---|---|
| `BlobStore` | IndexedDB `Blob` values | same (renderer IndexedDB) | same (WebView IndexedDB) |
| `ByteStore` | OPFS via `navigator.storage.getDirectory()`, `createSyncAccessHandle` in a worker | Node `fs` streams, **or a recorded absolute path with no copy at all** | Capacitor Filesystem in the app sandbox |
| `MediaCodec` | `probe()` via `VideoDecoder.isConfigSupported` plus `canPlayType`; `extractFrames()` via WebCodecs then `<video>`+canvas; **`transcode()` throws `Unsupported`** | probe via `ffprobe`; extract and transcode via bundled ffmpeg; **nothing throws** | platform decoders, optional bundled ffmpeg |
| `FilePicker` | `<input type="file">`, drag and drop, `webkitGetAsEntry()` for folder drops, `showOpenFilePicker` where present | native dialogs, directory trees, optional watched folders | native picker plus Photos library |
| `QuotaReporter` | `navigator.storage.estimate()` and `persist()`, plus an eviction-risk flag | free disk, `evictionRisk: false` | sandbox space |
| `SecretStore` | **never holds a key.** Returns `{mode:'proxy', endpoint:'/api/ai'}` | main process holds the key, IPC-gated | Keychain or Keystore |
| `CapabilityProbe` | the E.4a input set | same, plus real core and memory counts | same |

**`MediaCodec.transcode()` throwing `Unsupported` in the browser is the design, not a gap.**
It is the single line where the open hole in E.4b lives, it is explicit, and it is why `derivative_state='none'` is a legitimate resting state.
A browser implementation that silently returned a black frame instead would be the actual defect.

**What already sits behind this seam in the existing design**, because most of it was written platform-neutral for other reasons:

- `asset.local_file_key` was always an opaque key, never an OPFS-specific path, so a Node absolute path fits without a schema change.
- `media_state` and `derivative_state` are already about states rather than mechanisms.
- `ingestFile(file, policy)` takes a `File`, and a `File` from a fetch, a file input, a drag-drop, or a Node read stream wrapper are indistinguishable to it (C2.D established this for fixtures, and it pays off again here).
- The `DeriveJob` contract in E.4b already abstracts `ByteSource`, which is `ByteStore` under another name.
- `Clock`, `Rng`, and the capability probe are all injected already, with the eslint ban enforcing it.
- The `SyncAdapter` and AI provider interfaces are untouched by platform: an Electron shell syncs and calls models exactly as the browser does.

**What currently assumes a browser and must move behind the port:**

1. Direct `navigator.storage.*` calls in the quota watcher and the eviction ladder (B.2). These are the most browser-shaped code in the design and they need to become `quota.report()` and a no-op eviction policy on desktop.
2. The frame extractor's fallback chain, which is written in terms of `<video>` and `HTMLCanvasElement`. It becomes `media.extractFrames(source, policy)`.
3. `showOpenFilePicker` and `webkitGetAsEntry` usage in the upload page.
4. The `/api/ai` fetch in the AI provider's live implementation, which becomes `secrets.mode`-driven.
5. OPFS directory naming for the demo and live profile namespaces (C2.E), which needs a filesystem equivalent.

Five places, all narrow, and naming them now is what keeps the Electron config from becoming a fork later.

**Honesty rule.** Only `browser` is exercised.
`electron` and `native` are written, committed, and unverified, and the thinking doc says so in the same sentence it says so about iOS.
`resolvePlatform()` logs which implementation it picked, the Data Health panel displays it, and any capability that resolves to `Unsupported` degrades visibly rather than throwing into a blank screen.

### C3.1 Secrets, and why provenance is unaffected

In the browser the model key can never be in the bundle, so live calls go through the Netlify function at `/api/ai` (the redirect already exists in `netlify.toml`).
In an Electron shell the main process can hold the key directly and the renderer calls it over IPC, so **the proxy is a browser requirement, not an architecture requirement.**

`SecretStore` is the seam, and it returns a mode rather than a key:

```
{ mode: 'proxy',  endpoint: '/api/ai' }        // browser
{ mode: 'ipc',    channel: 'ai:invoke' }      // electron
{ mode: 'native', keyRef: 'keychain://…' }     // native
```

The AI provider's `live` implementation reads `mode` and picks a transport.
**Nothing above the transport changes**: the same prompt files, the same JSON schemas, the same validator, the same request shape, the same `ai_run` write.

**`ai_run.provider` semantics are identical regardless of which shell made the call, and that is deliberate.**
`provider` answers "was this output produced by a model, replayed from a captured response, or synthesised locally", which is a question about the **origin of the output**, not about the **route the bytes took**.
A live Claude call is `provider='live'` whether it went through a Netlify function, an Electron IPC channel, or a native bridge.
Collapsing transport into `provider` would break the one guarantee the field exists to give, and the check constraint in C2.A would start rejecting legitimate rows.

Transport is recorded separately and cheaply: `ai_run.provider_detail` already exists for exactly this, taking `'claude-via-netlify'`, `'claude-via-ipc'`, or `'claude-via-native'`.
So the question "which shell made this call" is answerable, and the question "is this output real" stays answerable independently.
Those are two different audits and they must not share a column.

One security note that survives every shell: the creator surface is browser only and never makes model calls at all.
Vision tagging, matching, and nudge drafting are manager-side operations on data the creator has already submitted, so no creator path needs a key, a proxy, or an IPC channel.

---

## D. Video storage decision for the real version

### D.1 Verified published prices, retrieved Aug 6 2026

All four checked against vendor documentation on Aug 6 2026, US regions.

| vendor | storage | egress to internet | operations | notes |
|---|---|---|---|---|
| **Cloudflare R2** | Standard **$0.015 / GB-month**, Infrequent Access **$0.01 / GB-month** | **Free**, both classes, via Workers API, S3 API, or public domains | Class A **$4.50 / million**, Class B **$0.36 / million** (IA: $9.00 and $0.90) | Free tier 10 GB-month, 1M Class A, 10M Class B. IA retrieval $0.01/GB |
| **Backblaze B2** | from **$6.95 / TB-month** (about **$0.00695 / GB-month**) | **Free up to 3x average monthly stored bytes**, then **$0.01 / GB** | most transaction types free | First 10GB free. Unlimited free egress via partner CDNs (Cloudflare, Fastly, bunny.net) or B2 Overdrive at $15/TB-month |
| **AWS S3 Standard** | **$0.023 / GB-month** first 50TB, $0.022 next 450TB, $0.021 above 500TB | **$0.09 / GB** first 10TB/month, $0.085 next 40TB, $0.07 next 100TB | GET $0.0004/1k, PUT $0.005/1k | us-east-1 |
| **Supabase Storage** | **$0.0213 / GB-month** overage ($0.00002919 / GB-hour) | **$0.09 / GB uncached**, **$0.03 / GB cached** | included | Free plan 1GB storage and 5GB egress, Pro plan 100GB storage and 250GB egress included |

### D.2 Recommendation: Cloudflare R2 for bytes, Supabase Postgres for rows

**Reasons, in order:**

1. **Egress is the bill that kills read-heavy media apps, and R2's is zero at any volume.** An editor scrubbing previews all afternoon generates unbounded reads, and the whole point of this product is that editors browse constantly. Every other option prices that browsing. R2 removes the variable that is hardest to forecast and easiest to get wrong.
2. **S3-compatible API**, so the code is portable and B2 or S3 remain drop-in replacements. Choosing R2 is not a lock-in decision, which matters for a recommendation made before anyone has measured real traffic.
3. **Native CDN**, so edge-cached previews need no second product and no second vendor relationship. One bucket, one custom domain (`media.astolia.app`), signed URLs via a small Worker.
4. It composes cleanly with the row decision: Supabase for Postgres, auth, RLS, and RPC, R2 for bytes. Two products, each doing what it is best at.

**Why not the others, honestly:**

**Backblaze B2** is genuinely cheaper per GB stored: $6.95/TB against R2's $15/TB, roughly half.
At our scale that is a difference of about $6 per month, and it comes with a cliff: free egress caps at 3x average stored bytes, which for a 770GB library is about 2.3TB per month.
That sounds ample until four editors browse a poster-heavy grid all quarter, and the failure mode is a bill rather than an error.
The fix is to front B2 with Cloudflare for unlimited free egress, at which point you are operating two vendors to save six dollars.
B2 is the right answer when the archive gets genuinely large and cold, say past 20TB, and it is worth revisiting then.
It is not the right answer at 770GB.

**Supabase Storage** is the tempting one-vendor answer and it is the worst fit for this exact workload.
$0.09/GB uncached egress is S3-class pricing on the single dimension this app consumes most.
Cached egress at $0.03/GB helps, but preview scrubbing and range requests cache unevenly.
Use Supabase for rows, auth, and RPC where it is excellent.
Do not put hot video bytes behind it.

**AWS S3** is rejected on egress, $0.09/GB, full stop.
It is also the reason media startups post surprise-bill incident write-ups.
Keep S3 in mind only as a Glacier Deep Archive tier for a cold master copy, where $0.00099/GB-month for genuinely never-read originals is unbeatable, and accept the retrieval latency because nobody is retrieving them.

### D.3 Derivative strategy

Generated once on ingest by a queued server-side ffmpeg worker, never overwritten in place.

| artifact | spec | size (20s vertical clip) | who loads it |
|---|---|---|---|
| `thumb.jpg` | 160px long edge, q0.60 | ~8KB | dense list views, hover previews in the kanban |
| `poster.jpg` | 480px long edge, q0.72 | ~45KB | **the library grid**, clip sheet first paint, creator checklist rows |
| `sheet.jpg` | 5 frames, 1350x480, q0.70 | ~110KB | **the vision model**, plus hover-scrub in the grid |
| `preview.mp4` | H.264 High, yuv420p, 720x1280, ~1.4 Mbps, AAC 64k, `+faststart`, GOP 2s | ~3.5MB | **the clip sheet preview player** |
| `hls/` | 3 renditions (360/720/1080), fMP4, 4s segments | n/a | **only for `duration_s > 60`**, see below |
| `orig` | untouched source | ~150MB | **final download only** |

**H.264 plus AAC in MP4 with `faststart` is the whole HEVC answer.**
iPhones capture HEVC (`hvc1`) in `.MOV` by default.
iOS Safari usually decodes that in hardware, so local frame extraction on the creator's own phone works, but the same file will not decode in the manager's Chrome on Windows.
So the transcode to H.264 happens on ingest and no browser is ever asked to decode HEVC.
`codec_video` is stored on the asset precisely so the UI knows to show poster-only until the transcode lands, rather than presenting a broken player.

**HLS is conditional on duration, not deferred, and the condition is the design.**
B-roll clips are 5 to 30 seconds.
A progressive MP4 with `faststart` begins playing on the first range response, in a couple of hundred milliseconds, and the whole file is 3.5MB.
An HLS ladder inserts a master playlist fetch plus a media playlist fetch before the first segment request, so for a 6 second clip it is **strictly slower to first frame** while adding two more derivative sets to generate, store, and invalidate.
That is not a saving, it is a regression.

So the rule is per asset, evaluated at ingest: **generate the ladder when `kind='video'` and `duration_s > 60`**, set `asset.hls_ready = true`, write to `drv/v1/{asset_id}/hls/`, and let the player pick HLS when the flag is set and progressive MP4 otherwise.
Because it is a per-asset flag rather than a platform mode, longer-form content (tutorials, full treatment walkthroughs) can arrive later without any migration and without changing how b-roll is served.
The `asset.kind` plus `duration_s` design already carries everything this needs.

**Load budget, so the numbers are explicit:**

- Library grid, 40 tiles: 40 x 45KB = **1.8MB**, all edge-cached, all `immutable`.
- Clip sheet open: 1 poster plus the first 2 seconds of preview, about **0.4MB** to first frame, **3.5MB** for the full preview.
- Final download: the original, **~150MB**, signed URL, counted in `download_count`.

An editor who opens 200 clip sheets in a day pulls roughly 700MB.
On S3 that is $0.06 per editor-day, or about $50/month across four editors just for browsing.
On R2 it is zero, forever.
That is the entire argument in one line.

### D.4 Realistic monthly cost at 5,000 clips averaging 150MB

Originals: 5,000 x 150MB = **750GB**.
Derivatives: 8KB + 45KB + 110KB + ~3.5MB preview = about **3.67MB per clip**, so 5,000 x 3.67MB = **18GB**.
Total **768GB**, call it **770GB**.

| option | storage | egress (assume 500GB/month of preview and poster traffic) | monthly total |
|---|---|---|---|
| **R2 Standard** | 770 x $0.015 = **$11.55** | **$0** | **~$12** |
| **R2, originals to Infrequent Access after 60 days** | 750 x $0.01 + 18 x $0.015 = **$7.77** | $0, plus ~$0.0015 per 150MB final download | **~$8** |
| B2 (no CDN) | 770 x $0.00695 = **$5.35** | free (500GB is under the 2.3TB allowance) | **~$5**, with a cliff |
| S3 Standard | 770 x $0.023 = **$17.71** | 500 x $0.09 = **$45.00** | **~$63**, and unbounded |
| Supabase Storage Pro | (770 - 100) x $0.0213 = **$14.27** | 250GB billable, mixed cache, $7.50 to $22.50 | **$22 to $37** |

Operations on R2 at this scale are effectively free: four editors at 200 grid pages a month is about 32,000 Class B reads plus preview requests, against a 10M free allowance, and writes are 5,000 originals plus 20,000 derivatives which is 25,000 Class A against 1M free.

**Recommendation stands: R2, with a lifecycle rule moving originals to Infrequent Access at 60 days.**
About **$8 to $12 per month**, flat with respect to how hard the editors work, on an S3-compatible API that keeps every alternative open.
Add S3 Glacier Deep Archive as a second cold copy later if the business wants belt-and-braces on the masters, at roughly $0.75/month for 750GB.

### D.5 Key layout and two operational rules

```
r2://astolia-media/
  orig/{asset_id}.{ext}
  drv/v1/{asset_id}/thumb.jpg
  drv/v1/{asset_id}/poster.jpg
  drv/v1/{asset_id}/sheet.jpg
  drv/v1/{asset_id}/preview.mp4
```

**Rule 1: key by `asset_id`, never by filename.**
Phone filenames collide constantly (`IMG_0001.MOV` from every creator), they leak nothing useful, and they make idempotent retry impossible.

**Rule 2: never overwrite a derivative in place, version the prefix.**
A regenerated poster goes to `drv/v2/...` and the asset's `poster_key` is updated.
Posters are then safely served `Cache-Control: public, max-age=31536000, immutable` through the CDN, and there is no invalidation problem to debug, ever.
Overwriting in place is the single most common cause of "why is the old thumbnail still showing" and it costs an afternoon every time.

The bucket is private.
Reads go through a Worker on `media.astolia.app` that validates a short-lived signed path and sets the cache headers.
Posters and sheets are cacheable for a year, previews for a week, originals are never cached and always require a fresh signature.

### D.6 The ingest and transcode pipeline, specified

Nothing here is deployed for the submission (no server), but the client honours this contract exactly, so `remote_object_key`, `poster_key`, `preview_key`, `sheet_key`, and `upload_state` mean the same thing locally and remotely.
That is what makes the storage path additive rather than a rewrite.

**Buckets and lifecycle.**

Two R2 buckets, not one:

| bucket | contents | lifecycle |
|---|---|---|
| `astolia-media` | `orig/` and `drv/v*/` | `orig/` transitions to Infrequent Access at 60 days. Derivatives stay Standard (small, hot, and IA retrieval fees would defeat the purpose) |
| `astolia-intake` | `intake/{delivery_id}/{asset_id}.{ext}` | objects auto-delete at 14 days |

The separate intake bucket matters: creator uploads land in a quarantine namespace that the library can never read from, and promotion into `astolia-media` happens only after preflight passes and transcode succeeds.
One bucket with a prefix convention would work right up until a bug serves an unreviewed, unvetted file to an editor.

**Pipeline stages, with the state on `asset` at each step.**

| stage | trigger | writes | `upload_state` |
|---|---|---|---|
| 1. reserve | client calls `delivery_sign_upload(token, asset_id)` | `asset` row already exists from `delivery_upsert_asset` | `queued` |
| 2. transfer | client PUTs to the signed URL, chunked, resumable via offset | `upload_offset_bytes` locally | `uploading` |
| 3. verify | R2 event notification enqueues a job | `size_bytes` and `etag` checked against the client-declared values | `uploaded` |
| 4. probe | worker runs `ffprobe` | server-side truth for duration, dimensions, rotation, codecs, and it is **compared** against the client's declared facts | |
| 5. derive | worker runs ffmpeg | `thumb`, `poster`, `sheet`, `preview`, plus `hls/` when `duration_s > 60` | |
| 6. promote | all derivatives written | copy `orig` into `astolia-media`, set `remote_object_key` plus the derivative keys, `media_state='bytes_remote'` | `uploaded` |
| 7. index | promotion completes | enqueue vision tagging, then `reindex_queue` | |

**Stage 4 is the one worth arguing for.**
The client already computed duration, dimensions, and rotation locally (that is the whole two-layer intake design), so re-probing looks redundant.
It is not: the client's numbers came from an untrusted device over a public token link, and `ffprobe` is the authority.
Store both, and on disagreement keep the server value in band 1 and record the client value plus a `probe_mismatch` flag.
A systematic mismatch is a bug in the atom parser, and this is the only place it would ever be visible.

**The contract must accept an asset with no client-derived sheet at all.**
This is the E.4b input, and it is the normal case rather than an exception:

- **`derive` takes the original object as its only input.** Client artifacts are never inputs to the pipeline. That is what makes the three executors in E.4b interchangeable, and it is why an asset ingested by a browser that could not decode it needs no special handling here.
- **If a client sheet exists, the server sheet supersedes it** rather than being skipped: write `drv/v1/{asset_id}/sheet.jpg`, set `sheet_key`, set `derivative_state='server_derived'` and `derivative_producer='server'`, and mark the client `contact_sheet` row `superseded_at`. **Do not delete it.** The client sheet is what the manager may already have reviewed, and the diff between the two is diagnostic: a systematic difference means the client extractor is picking bad frames, and this is the only place that would ever be visible.
- **If no client sheet exists, nothing special happens.** The only difference is ordering: the vision run fires after transcode instead of before.
- **The vision run must be re-triggerable on the new sheet.** A fresh `ai_run` with `input_ref.sheet_id` pointing at the server sheet, `is_current` flipping to it. Already supported by the provenance design, but it means stage 7 must enqueue `reindex_queue` with `reason:'sheet_available'` for exactly these assets, or an asset that finally got pixels never gets tagged.
- **`transcode_priority` exists for this case.** An asset with `derivative_state='none'` is blocking a human review, so it jumps ahead of routine derivative work. A plain FIFO queue would put a manager's unviewable clip behind five hundred routine posters.

**Idempotency and retries.**
The job key is `(asset_id, pipeline_version)`, so a redelivered R2 event or a retried job is a no-op rather than a duplicate transcode, and it is idempotent across executors: a desktop run followed by a server run for the same version is a no-op, not a duplicate.
`pipeline_version` bumping is how derivatives get regenerated for every asset: bump it, enqueue the backlog, write to `drv/v2/`, update keys, and never touch `drv/v1/` until the new keys are live.
Failures write `asset.derive_error` plus an attempt count, retry with backoff three times, then surface in the manager's triage inbox as a real item, because a clip stuck without a preview is invisible in the library and will otherwise never be noticed.

**Encoding commands, so the spec is concrete.**

```
# poster (480px long edge), seek before input for speed
ffmpeg -ss 00:00:01 -i in -vf "scale='if(gt(a,1),480,-2)':'if(gt(a,1),-2,480)'" \
       -frames:v 1 -q:v 4 poster.jpg

# contact sheet, 5 evenly spaced frames, 1350x480
ffmpeg -i in -vf "select='not(mod(n\,FRAMEINT))',scale=270:480,tile=5x1" \
       -frames:v 1 -q:v 5 sheet.jpg

# preview: H.264 High + AAC, faststart, 2s GOP, capped bitrate
ffmpeg -i in -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:-1:-1" \
       -c:v libx264 -profile:v high -pix_fmt yuv420p -preset medium \
       -b:v 1400k -maxrate 1800k -bufsize 3000k -g 60 -keyint_min 60 -sc_threshold 0 \
       -c:a aac -b:a 64k -movflags +faststart preview.mp4
```

`-pix_fmt yuv420p` is not optional: iPhone HEVC is often 10-bit `yuv420p10le`, and Safari plus most browsers will refuse or fall back badly on 10-bit H.264.
`-movflags +faststart` moves `moov` ahead of `mdat`, which is the difference between playback starting on the first range request and the browser downloading the whole file first.
Fixed GOP with `-sc_threshold 0` is what makes range-request seeking predictable, and it is also the precondition for adding HLS later without re-encoding decisions changing.

**The read path Worker.**

```
GET media.astolia.app/{key}?exp={unix}&sig={hmac}
  sig = HMAC-SHA256(secret, key + "|" + exp)
```

The Worker verifies `exp` and `sig`, then fetches from the private bucket via an R2 binding (no S3 credentials in the edge at all) and sets cache headers by prefix:

| prefix | `Cache-Control` | signature TTL |
|---|---|---|
| `drv/*/poster.jpg`, `thumb.jpg`, `sheet.jpg` | `public, max-age=31536000, immutable` | 7 days |
| `drv/*/preview.mp4` | `public, max-age=604800` | 24 hours |
| `drv/*/hls/*` | `public, max-age=604800` | 24 hours |
| `orig/*` | `private, no-store` | 5 minutes, single use |

Long signature TTLs on posters are safe precisely because of the versioned-prefix rule: a key never changes meaning, so a leaked poster URL exposes one already-approved thumbnail and nothing else.
Originals get a 5 minute single-use signature because they are the asset with real value.

**Why this composes with Supabase rather than fighting it.**
Postgres holds only keys and metadata, never bytes.
The R2 event notification is the only server-side moving part, and it can be a Cloudflare Queue consumer plus a container running ffmpeg, or a Supabase Edge Function enqueuing to any worker.
Either way the database contract is identical, which is the point: the pipeline is replaceable and the schema is not.

---

## E. Three role reality check

### E.1 Will the manager really review everything manually?

**Yes for about the first month, then no, and the design has to plan the transition now rather than discover it.**

The volume math, honestly.
Reviewing a clip is not a click.
It is: watch 3 to 8 seconds, judge framing and brand fit, decide which brief item it satisfies, decide whether it beats the other take of the same shot.
With a good UI that is 20 to 40 seconds per clip, so 100 to 150 clips per hour at genuine attention, and attention degrades sharply after about 30 minutes of it.

One collab produces 8 to 12 brief items x 2 to 4 takes = **25 to 45 clips**, so roughly **20 to 30 minutes of review per collab**.
That is fine and the manager will happily do it.

- 2 collabs/week, about 70 clips: 40 minutes. Fine.
- 4 collabs/week, about 140 clips: 1.5 hours. Tolerable, mildly resented.
- 7 collabs/week, about 250 clips: 3 hours. **This is where it collapses.**
- 10 collabs/week, about 350 clips: 4+ hours. Will not happen.

**Collapse point: 150 to 250 clips per week, which is 5 to 7 collabs.**
Sooner if the same person also sources, vets, books, and chases nudges, which they do, because this is one person at a growing multi-branch business, not a review team.

The failure mode is not "the manager reviews slowly".
It is that review gets skipped, unreviewed clips pile up, and the library's quality promise quietly dies while the dashboard still looks green.

**The specific rule I recommend, in four parts.**

**Part 1, change the review unit from the clip to the brief item.**
This is the highest-leverage change available and it costs one UI decision.
The drawer shows one row per brief item with its 2 to 4 candidate clips, posters side by side, ranked by `ai_framing_score` and `ai_quality_score`.
The primary action is "pick the hero, keep the rest as alternates" or "reject all and nudge".
Decisions per collab drop from about 35 to about 10, and crucially it is the decision the manager was already making, because they only need one great clip per brief item.
Everything else is an alternate whose approval is low-stakes.

**Part 2, a hard gate that stays manual forever.**
Never auto-approve a clip where any of these is true:
`ai_brand_safety != 'clear'`, any preflight rule failed (wrong date, off-location, duplicate, wrong orientation), the collab has no `consent_accepted_at`, or `creator.lifecycle = 'blocked'`.
These stay human because the downside is a legal or brand incident, not a mediocre clip.
Non-negotiable, and the DB should enforce it rather than the UI.

**Part 3, trust tiers that are earned from data we already store, with stated thresholds.**
`creator.reliability_tier`:
- `new`: default.
- `proven`: >= 2 completed collabs, `approval_rate >= 0.70` across >= 20 reviewed clips, `promise_kept_rate >= 0.80`, zero brand-safety hits.
- `trusted`: >= 3 completed collabs, `approval_rate >= 0.80` across >= 30 reviewed clips, `promise_kept_rate >= 0.90`, zero brand-safety hits, zero consent problems.
Numbers rather than a vibe, computed nightly, visible on the creator card with the inputs shown so the manager can see why someone is or is not trusted.

**Part 4, the auto-approve rule, stated exactly.**

> Auto-approve an asset if and only if:
> `creator.reliability_tier = 'trusted'`
> AND all preflight checks pass
> AND `ai_brand_safety = 'clear'`
> AND `ai_quality_score >= 0.75`
> AND `ai_confidence >= 0.70`
> AND the asset is **not** the hero for its brief item.

Heroes are always human-picked, because the hero is the clip that actually ships and it is the one decision worth a human's 30 seconds.
Auto-approved assets land as `review_status='approved'`, `is_published=true`, with a `review_action` row carrying `method='auto_threshold'`, and a visible **"auto" badge** in the library so an editor knows which clips no human blessed.

**Plus the part most designs skip: a forced 10% random sample.**
Auto-approved clips get a 10% random draw pushed into a manual QA queue with `method='sampled_qa'`.
Without the sample there is no way to detect that the threshold drifted, or that a "trusted" creator changed their shooting style, and quality degrades silently until someone notices in a campaign.
The sample is what earns the right to keep trusting the model.
It costs the manager about 3 clips per collab instead of 35.

**Batch approve by brief item: yes, and record the method.**
`review_action.method='batch'` with the `asset_ids` list.
If the method is not recorded, then the moment batch approve exists, every creator scorecard computed from `review_status` becomes meaningless, and nobody will know why the numbers stopped correlating with reality.
This is a two-column decision with a six-month consequence.

**Where our design assumes too much about the manager.**
The kanban implies the manager watches the pipeline.
They will not.
They will live in one screen that answers "what needs me right now", and they will open the kanban weekly, or when a colleague asks about a specific creator.

**Recommendation: the manager's home is a single triage inbox, and the kanban is the secondary tab.**
The inbox is three grouped lists: deliveries awaiting review (with counts), deals stalled past their stage SLA (`stage_entered_at` older than N days per stage), and nudges drafted but not sent.
The kanban stays, because it demos beautifully and it is genuinely useful for the weekly glance, but building it first is optimising for the demo over the user.
Build the inbox first, then the kanban, and say in the thinking doc that you know which one is the real product.

**And the volume math changes on desktop, which shifts the collapse point rather than removing it.**
A keyboard-driven review at a desk is materially faster than thumb review: `j` and `k` to move, `a` to approve, `x` to reject, `s` to skip, space to preview, with four candidate posters visible at once for a single brief item.
Realistically that is 8 to 15 seconds per decision instead of 20 to 40, so the collapse point moves from roughly 150-250 clips per week to roughly **400-600**.

Three things follow, and only the third is comfortable.

1. The escalation ladder in this section is still required, just later. Trust tiers, the auto-approve rule, and the QA sample all stand.
2. **A faster interaction makes a wrong decision cheaper to make**, which is why A.20's frozen ordering, in-place dimming, keystroke idempotency, and undo are not polish. A reviewer who can approve six clips per minute can approve the wrong six clips per minute, and a list that reorders under the cursor while a sync lands will let them.
3. The realistic pattern is **triage on the phone, decide at the desk**: a manager glances at a delivery on a phone between appointments, then does the real pass on a desktop. That is precisely why `review_session` syncs and why the cursor and the skip set have to survive the device switch. Without it the phone glance is wasted work rather than a head start.

### E.2 Will the editor use tags, free text, or both?

**Free text, first, always. Tags get reached for only after free text fails twice.**

The reason is about where the editor is standing.
They are in a timeline, they have a 4 second hole to fill, and they are thinking in the language of the edit: "I need a hands-on-neck close up, warm".
They are not thinking "let me navigate to Subjects > Body > Hands".
A taxonomy asks them to translate their intent into someone else's structure, and translation is friction at exactly the moment they have the least patience.

**What they actually type, and this is where the design has an assumption worth correcting.**
Real editor queries are short: **2 to 4 words, mostly nouns plus at most one adjective**, and heavily shot-language.
Realistic examples: `hands`, `hands closeup`, `product on marble`, `towels`, `smiling client vertical`, `morning light window`, `reception wide`, `san jose lobby`, `slow pan`, `empty room`, `before after`, `steam`.

Note what is absent: sentences.
**Our own demo query, "calm morning light, hands, vertical, San Jose", is a demo query, not an editor query.**
It is four facets in a trench coat.
It is great for showing a panel what the parser does, and it is not what anyone types on a Tuesday.
Design the ranking for **1 to 3 tokens**, often a single word, and make single-word queries excellent rather than treating them as the degenerate case.

**Decision: one text box is the primary interaction, results update as you type, and facets appear as results-derived refinement chips.**
The chips show only the facets present in the current result set, with counts: `vertical (18)`, `San Jose (11)`, `morning (4)`.
That is a completely different thing from a taxonomy tree, because it teaches the editor the shape of what they already found instead of asking them to guess what exists.
**Do not build a tag browser tree.** It inverts the interaction: it asks the editor to learn a taxonomy in order to find something they can already describe in two words.

**The fallback ladder when free search fails, in order.**

1. **Never show a bare empty state.** Show "0 exact matches, here are 12 near matches", produced by progressively dropping the most restrictive term, and **label what was dropped**: "ignoring: morning". An editor who can see what was relaxed can steer. An editor staring at zero results just leaves.
2. **Offer the query as a saved search** that will surface new matches later. This converts a dead end into a standing request, and it is simultaneously a first-class gap signal.
3. **"Add this to the next brief", one tap.** Writes a `gap` row with `signals.source='editor_request'`, weighted highest in the scan because a human explicitly asked. This is the shortest possible path from editor frustration to a creator's shot list, and it is the product's entire thesis compressed into one button. It belongs in the zero-result state, prominently.
4. **Show adjacent coverage honestly**: "San Jose has 4 hands clips, all evening light". Now the editor is learning the library instead of guessing at it, and the honesty builds more trust than a padded result set does.

**Plus: a match explanation on every tile.**
A single small line: `matched: tag hands (0.86), description`.
It costs almost nothing, it makes the ranking legible instead of magical, and it is what makes an editor willing to trust result #1.
It is also how you earn the click signal in E.3, because a click on an explained result is a much cleaner label than a click on a mystery.

**Where the tag vocabulary actually earns its keep**: ranking features, the brief generator's shot vocabulary, and the gap scan's cell definitions.
It is infrastructure, not the editor's front door.
That distinction is what keeps it from becoming a maintenance burden nobody uses.

### E.3 Personal digging habits worth capturing now

**Yes, and this is the cheapest personalisation available, but only if the records exist from the first commit.**
Behavioural data cannot be backfilled.
You cannot recover a signal you did not log, and the value compounds with age, so day one is the only cheap moment.

Real editors have visible habits, and they are consistent enough to design for:
- They re-run the same 4 or 5 searches for the duration of a campaign.
- They keep a "current project" bucket and drag candidates into it all week.
- They have 3 clips they reuse constantly and would rather pin than search for.
- Their default browse is "newest, this branch", not a query at all.
- They remember clips visually, by the poster, not by name or tag.

**First-class records, all already in the model:**
`saved_collection` with `kind='saved_search'` (query text plus filters), `kind='manual'` (project buckets), `kind='ai_auto'` (search-generated), plus `is_pinned`, `last_opened_at`, `open_count`.
`collection_item` with `rank` and `note`.
`search_query_log` with the full refinement chain via `refined_from_query_id`, plus `outcome`.
`usage_event` for `view_asset`, `preview_play`, `download`, `copy_link`, `add_to_collection`, `reject_result`, `pin`, `dwell`.

**The one field most teams forget: `usage_event.rank_at_event`.**
Knowing an editor clicked result #7 and scrolled past #1 through #6 is worth more than any amount of tag tuning, because it is a direct, unambiguous relevance label produced for free by someone doing their job.
Log it from the first version even though nothing consumes it yet.
Same for `reject_result`, an explicit "not this" affordance on a tile, which gives you negative labels that are otherwise almost impossible to collect.

**How these signals later improve ranking, concretely and without ML infrastructure:**

- **Usage prior.** Boost by `used_count` and `download_count`, decayed by recency. Clips real editors actually shipped are the ground truth for "good", and they beat any AI quality score, because the AI is guessing at what a human values and this is a record of it.
- **Query-token to asset co-click counters.** A tiny table `(query_token, asset_id, clicks, impressions)` that re-ranks known query shapes. It is a counter, not a model, and it makes the top 3 results for the 20 most common queries excellent within a week of real use.
- **Negative demotion.** An asset shown many times for a token and never clicked gets demoted for that token. This quietly fixes the "one irrelevant clip always ranks first" problem that otherwise erodes trust fast.
- **Per-user boost.** Weight the tags, branches, and shot types this specific editor historically clicks. Two editors on the same query should not get identical results after a month, because they do not want the same thing.

**How these signals later improve the tag vocabulary, which is the less obvious half:**

- **Demand-driven vocabulary growth.** Query tokens with real volume and no matching `tag_vocabulary` entry become rows with `status='proposed'`, `created_by='rule'`. The vocabulary then grows from what editors actually ask for, instead of from a taxonomy meeting where nobody remembers what they search for.
- **Alias detection.** Two tokens that consistently retrieve the same asset set are alias candidates. Propose the merge, let a human confirm, write it into `aliases`.
- **Low-precision tag detection.** An AI tag whose assets are consistently rejected or never clicked is a bad tag. Trace it back: `tag.ai_run_id` to `ai_run.prompt_key` and `prompt_version`, tighten that prompt, bump the version, re-run, compare. That is a closed feedback loop on the AI itself, using data the product generates anyway.
- **The eval set, for free.** Human tags added to assets that already had AI tags are a labelled diff: what the model missed and what it got wrong. This is precisely why `tag` rows carry `source` and `rejected_by_human` and are never merged into one flat list. Merging them destroys the only eval set you will ever get for free.

That last point is worth stating as the design rule: **the human-versus-AI disagreement is not noise to be reconciled, it is the product's most valuable dataset.**
Every place the model proposes and a human corrects, store both.

### E.4 Does the creator side survive a real human, in a browser, on a phone or a laptop, no login, poor signal, and 40 clips?

**Reframed: the creator arrives on a phone or on a desktop, always in a browser, and the design must not know which.**

**The creator surface is browser only, forever.** No install, no account, both form factors, a token link in whatever browser they have.
A creator at the VIP location may well be offloading a mirrorless card into a laptop rather than uploading from a phone, and both paths are first-class.

**Not as originally described. Four things break it.**

**Problem 1: a single "drop 40 files, process them all, then upload" flow will die on a constrained device.**
iOS Safari will suspend or discard a backgrounded tab, and 40 x 150MB is **6GB** of upload, which on hotel or salon wifi is hours.
Frame extraction is also much slower than a spec sheet suggests: seeking a `<video>` element and drawing to canvas costs roughly 0.5 to 2 seconds per frame on a mid-range phone, so 5 frames x 40 clips is **100 to 400 seconds of pure decoding**, with real memory pressure, on a device that will thermally throttle partway through.
On a desktop the same batch is comfortable.
**So this is a capability problem, not a mobile problem**, and it must be solved by a derived policy rather than a device check (see the policy below).

**Problem 2: desktop uploads are frequently not phone footage**, which is what A.19 exists to handle: no GPS atom, landscape by default, files ten to a hundred times larger, missing or offset-less capture metadata, and codecs the browser cannot touch.

**Problem 3: HEVC, and the original claim in this plan was too strong.**

The plan said extraction must happen on the creator's device because that is the only place the codec is guaranteed decodable.
**That is true for an iPhone creator and false in general.**
Three cases, and they are distinguished by a probe, not by a platform:

| case | decoder present | outcome |
|---|---|---|
| iPhone or iPad Safari, HEVC in MOV | hardware, via VideoToolbox | extraction works, sheet produced |
| macOS Safari or Chrome, HEVC | system decoder | extraction works, sheet produced |
| **Windows or Linux Chrome or Firefox, HEVC in MOV** | **often none** | **extraction impossible, no sheet, ever, in this build** |

The third case is the one that matters, and it is not answerable from the user agent: Chrome 107 and later will use a platform HEVC decoder when the OS provides one (on Windows that means the HEVC Video Extension being installed), so the same browser version on two Windows machines can differ.
**So probe, never assume:** `VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L93.B0'})` plus `canPlayType('video/mp4; codecs="hvc1"')`, and record the result in `asset.probe_result`.

**This is the one place the no-server prototype genuinely cannot produce the artifact, and it stays open.**
The full state machine and the honest degradation are in E.4a below.
Local pre-flight is still where the work happens whenever a decoder exists, which is most of the time, and the invite page should still tell the creator to switch Settings > Camera > Formats > Most Compatible before the shoot, because one sentence in the brief prevents the whole class of problem for iPhone shooters.
It does nothing for a mirrorless body, which is why E.4a has to exist.

**Problem 4: no login plus poor signal means the session must be resumable with no account.**
The token in the URL is the identity, all in-progress state lives in IndexedDB and OPFS on the creator's own machine, and every server write must be idempotent on a client-generated id (which `delivery_upsert_asset` in C.2 already is).

**Minimum viable creator interaction, concretely.**

1. **Open the link.** See the VIP day, the branch and address, and the numbered shot list as a checklist. One tap to accept and consent, which writes `consent_accepted_at` plus `consent_text_version`. No account, no app install, no password.
2. **Upload page: pick files** from Photos, multiple selection.
3. **For each file, locally and immediately**: read `size`, `duration`, `videoWidth`, `videoHeight`, rotation, parse MP4/MOV atoms for creation date and GPS, extract frames, build the sheet, hash the frames. Write the `asset` row and the sheet to IndexedDB **before anything leaves the phone**. Show a per-file row with either a green check or a **specific** fix: "this is horizontal, we need vertical", "this was shot Aug 2, your visit was Aug 4", "we already have this one".
4. **Size the work from a derived capability policy, never from a device category.** One function resolves a tier once per batch, and every downstream step takes the resolved policy as a parameter. Details immediately below. Always release `ImageBitmap`s and revoke object URLs immediately, at every tier.
5. **Upload only what passes preflight**, chunked, 2 concurrent, with `upload_offset_bytes` persisted per file so a dropped connection resumes rather than restarts. One overall progress bar plus the sentence that actually matters: **"you can close this and come back"**.
6. **The live checklist against the brief**: "7 of 10 shots covered, missing: #3 hands closeup, #8 reception wide". This is the single highest-value screen in the entire product, because it closes the delivery gap **while the creator is still in the building**, which is roughly 100x cheaper than a nudge two days later when they have already gone home and deleted the footage.
7. **Submit**, then a short thank-you that still names what is missing, on a link that keeps working.

**The design change I would insist on, and it is already half-present in the plan.**
The brief says "heavy originals only upload after local rules pass and the manager approves".
**Make that literal and enforced in the state machine, not a convention in the UI**, because it is the best architectural idea in the plan and a convention will be violated by the first code path that wants to be simpler.
Concretely: `upload_state` cannot legally move to `queued` for the original bytes until `preflight` passes and `review_status` leaves `pending`, and the transport refuses the transition rather than trusting the caller.

Concretely: the creator uploads **contact sheet plus metadata first**, about **170KB per clip**, so 40 clips is about **7MB** and completes in seconds even on bad signal.
The manager reviews and the AI matches on that alone.
Full bytes upload only for clips the manager actually wants, which is realistically 10 to 15 of the 40.
That is **7MB instead of 6GB for the review round trip**, the manager reviews within minutes instead of hours, and the whole loop works from a phone in a parking lot.

**And cap the ask.**
Do not ask for 40 clips.
Ask for brief items x 2 takes, so **16 to 24**, and let the checklist enforce it.
A creator who uploads 40 is a creator who did not read the brief, and the checklist UI is precisely what prevents that from happening.
Fewer, better-targeted clips is also a better outcome for the library, so this is not a compromise.

### E.4a The capability derived ingest policy

**One function, one call site, no scattered conditionals.**
`src/platform/capability.ts` exports `probeCapabilities()` (run once per session, cached) and `deriveIngestPolicy(probe, batchHints)`.
`ingestBatch(files)` calls it exactly once and passes the resolved `IngestPolicy` down into `ingestFile(file, policy)`.
**No component and no worker reads `navigator.*` directly**, and the eslint ban list from C2.B is extended to `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `navigator.connection`, and `matchMedia`, exactly as it already bans `Date.now` and `Math.random`.
That makes the policy testable, overridable, and demonstrable: a "simulate constrained device" control in the demo tools shows the tiering to a reviewer who does not have a phone to hand.

**Inputs, all real APIs, none required.**

| input | API | note |
|---|---|---|
| logical cores | `navigator.hardwareConcurrency` | widely available, defaults to 4 when absent |
| memory class | `navigator.deviceMemory` | **Chromium only**, coarse (0.25 to 8), so absence must not be read as "low" |
| pointer class | `matchMedia('(any-pointer: fine)')` and `('hover: hover')` | capability, not a device name, and far better than UA sniffing |
| input provenance | `DataTransfer.items[].webkitGetAsEntry()` returning a directory | a folder drop is a strong desktop signal |
| batch shape | median `File.size` | a 300MB+ median is a camera-offload signature |
| network | `navigator.connection.effectiveType`, `saveData` | Chromium only, and it governs **upload** concurrency, never decode |
| decoder | `'VideoDecoder' in window`, `VideoDecoder.isConfigSupported(cfg)` | the only reliable codec answer |
| headroom | `navigator.storage.estimate()` | feeds `maxLocalOriginalBytes` |

**Scoring, and the two rules that keep it honest:**

```
cores = navigator.hardwareConcurrency ?? 4
score  = cores >= 8 ? 2 : cores >= 4 ? 1 : 0
score += mem === undefined ? 1                       // unknown means middle, never worst
       : mem >= 8 ? 2 : mem >= 4 ? 1 : 0
score += (anyPointerFine && hover) ? 1 : 0
score += folderDrop ? 1 : 0
score += medianFileBytes > 300_000_000 ? 1 : 0

tier = score >= 5 ? 'ample' : score >= 3 ? 'standard' : 'constrained'
```

Rule one: **an absent signal scores as the middle, never as the floor.** Safari does not implement `deviceMemory`, and treating every Safari user as a constrained device would give the largest group of real creators the worst artifacts.
Rule two: **a static probe cannot see thermal state.** So measure the wall time of the first clip's extraction and, if it exceeds a budget (about 2.5s for five frames), drop one tier and continue. Downgrade only mid-batch, and re-evaluate upward only at batch boundaries, so artifacts stay consistent within a batch.

**The three tiers, explicitly, including desktop:**

| setting | `constrained` | `standard` | `ample` (desktop) |
|---|---|---|---|
| decode concurrency | 1 | 2 | **4** |
| frames per sheet | 3 (`layout='1x3'`) | 5 (`1x5`) | **5, or 7 for `duration_s > 60`** |
| frame long edge | 360px | 480px | **480px** |
| sheet JPEG quality | 0.68 | 0.72 | **0.72** |
| upload concurrency | 1 | 2 | **4** |
| chunk size | 1MB | 4MB | **8MB** |
| `maxLocalOriginalBytes` | 256MB | 1GB | **2GB** |
| eager bitmap release | yes | yes | yes |
| extractor preference | WebCodecs, else video+canvas, else none | same | same |

`posterLongEdge` stays **480px at every tier**, because the poster is a stored artifact the library grid depends on and it must not vary by whoever happened to upload.

**Frame count scales with duration, not just tier**: `frameCount = clamp(round(duration_s / 4), 3, tierMax)`, which is why `contact_sheet.layout` is an enum (`1x3`, `1x5`, `1x7`) rather than a constant.
A 6 second clip and a 5 minute clip should not both get five frames.

**The policy is recorded, because it shapes stored artifacts.**
`delivery.ingest_policy` jsonb holds the resolved policy for that session, and `contact_sheet.policy_tier` plus `generator_version` records what produced each sheet.
Two consequences worth having:

1. A phone-ingested 3-frame 360px sheet and a desktop-ingested 5-frame 480px sheet are **different inputs to the vision model**, so `ai_run.input_ref` names the sheet and `input_hash` covers its shape. Without that, a re-derivation reuses a cached run computed from a worse sheet.
2. Sheets produced at `constrained` tier are **identifiable and re-derivable**: once the bytes are available to a more capable environment, `reindex_queue` with `reason:'better_tier_available'` can regenerate them, and `policy_tier` is how you find the ones worth redoing. That is the same mechanism the extractor-version upgrade in G.5 uses.

### E.4b The undecodable asset: the open hole, stated honestly

**In this build there is no resolution for this case.** Browser is the only runtime, so a creator on a Windows laptop with iPhone HEVC files produces an asset with real metadata and no pixels, permanently, until a desktop shell or a server exists.
What follows is what the system does instead of pretending otherwise.

**What survives, and this is the saving grace: the metadata layer does not need a decoder.**
Atom parsing reads bytes, so A1 still yields container, `stsd` fourcc, coded dimensions, `tkhd` rotation, duration, creation date, and GPS where present.
**All of band 1 except the frame-derived facts.** Only the pixel layer fails.

**The state machine at ingest:**

1. `codec_playable` probe returns `fail`, `reason:'no_decoder_in_shell'`. `asset.client_decodable = false`, `needs_transcode = true`, `probe_result` records the raw answers and the shell.
2. **Frame extraction is not attempted.** Do not try-and-catch into a black frame: a black frame that silently becomes a contact sheet is far worse than no sheet, because it will be tagged.
3. **No `contact_sheet` row is created.** Not an empty row, not a placeholder blob. Absence is the correct representation, and every consumer already handles absence because `bytes_absent` assets exist. No `asset_frame` rows. `frame_hashes = null`, `phash_primary = null`.
4. `preflight.rules.duplicate = {status:'unknown', reason:'no_frames_no_decoder'}`. **Perceptual dedupe genuinely cannot run for this asset**, which is a real capability loss and is recorded as `unknown` rather than as a pass.
5. **`media_state`** describes bytes only: `'bytes_local'` if the original was written to OPFS within the byte budget, otherwise `'bytes_absent'`. **`derivative_state = 'none'`**, `derivative_producer = null`. Those two fields being orthogonal is what makes this state expressible at all.
6. `upload_state` may proceed to `queued`. `codec_playable: fail` is **excluded from the blocking set** and instead sets `upload_priority='required_for_transcode'`, because shipping the original is the only path forward.

**What the AI layer does, and it must not fabricate.**
No sheet means **no `vision_tag` run is created at all.** Not a run with empty output, not a low-confidence guess from the filename, not tags inferred from the brief item it was probably meant for.
`ai_shot_type`, `ai_room`, `ai_description`, `ai_quality_score`, `ai_brand_safety`, and `ai_matched_brief_item_id` all stay null, and **no `tag` rows with `source='ai'` are written**.

This is worth being emphatic about because the temptation is real and the failure is invisible: a model asked to tag a clip it cannot see will produce plausible tags from the filename and the brief context, those tags will enter the search index, and an editor will one day search `hands closeup` and be served a clip nobody has ever looked at.
The provenance design already forbids it structurally, since every AI field must be a projection of an `ai_run` and there is no run, but the guard belongs in the enqueue step too: **vision tagging requires a `sheet_id`, and refuses to run without one.**

Where the absence surfaces: `brief_item.status = 'indeterminate'` and the drawer's third bucket from A.18.
Coverage is unknown, not missing.

**What the manager sees on the card.**

- A grey placeholder tile, not a broken `<video>` and not a spinner that never resolves.
- The real facts we do have, because they are genuinely useful: filename, duration, resolution, orientation, capture date, file size, and codec.
- A status chip reading **"no preview: HEVC, this browser has no decoder"**, plus one line of what would fix it.
- It sits in the **"awaiting derivatives"** bucket in the deal drawer, not in extras and not counted as an unmet brief item.
- **Approve is disabled**, with the reason shown. `review_status` stays `pending`. Approving footage nobody has looked at is precisely what a one-tap publish flow would let a tired manager do by accident, and the disabled state is the guard.
- The one action offered instead: **"request an H.264 version"**, which drafts a creator-facing message (reusing the nudge draft path) explaining the format and how to export it. That is the only resolution available inside this build, and it is a human one.

**The two real resolution paths, documented as specification.**

| path | status | mechanism |
|---|---|---|
| **local desktop transcode** | designed, not built | the desktop shell bundles ffmpeg, picks up assets where `derivative_state='none'` and bytes are reachable, produces poster, sheet, and preview, sets `derivative_state='client_derived'`, `derivative_producer='electron'`, then enqueues the vision run |
| **server-side transcode** | designed, not deployed | D.6 stages 4 to 7, `derivative_state='server_derived'`, `derivative_producer='server'` |

Both are enrichment of an existing record.
Neither creates the asset, neither changes its identity, and both flip the same two fields plus write the same derivative keys.
An asset can therefore arrive from a browser with no sheet and be enriched later by either, which is a genuinely useful path rather than a repair.

**Can the desktop client and the future server worker implement the same job contract? Yes, and it is worth writing down even though neither is deployed.**

```
DeriveJob  { asset_id, pipeline_version, source: ByteSource, wants: ['poster','sheet','preview','hls'?] }
DeriveResult { asset_id, pipeline_version, artifacts: [{ kind, bytes|key, width, height, sha256 }],
               probe: { duration_s, width, height, rotation_deg, codec_video, codec_audio, fps },
               producer, error? }
```

The contract closes cleanly because of four properties the design already has:

1. **The job key is `(asset_id, pipeline_version)`**, so it is idempotent regardless of who runs it, and a desktop run followed by a server run is a no-op rather than a duplicate.
2. **The only input is the original bytes.** Client artifacts are never inputs (D.6), so the executor needs nothing from the environment that produced the asset.
3. **Both executors run the same ffmpeg command set** from D.6, so the artifacts are byte-comparable and `sha256` in the result makes that checkable.
4. **`ByteSource` is the one abstraction that differs**: a local file handle on desktop, a signed object URL on the server. That is exactly the `BlobStore` seam in the platform port (C3), so it is already abstracted for other reasons.

So `DeriveJob` has **three interchangeable executors**: `BrowserDeriveExecutor` (built, WebCodecs or video-plus-canvas, refuses undecodable input), `ElectronDeriveExecutor` (designed, bundled ffmpeg, refuses nothing), `ServerDeriveExecutor` (designed, ffmpeg in a queue consumer).
`derivative_producer` records which one ran.
That is the strong result: **the transcode station is a deployment choice, not an architectural one.**

**And the failure branch neither path can escape.** ProRes is fine for ffmpeg; BRAW and R3D need vendor SDKs and will fail everywhere. Then `derive_error='unsupported_codec'`, `derivative_state='failed'`, and the manager gets an explicit "we cannot process this format, please export H.264" rather than an asset that sits pending forever.
A permanent pending state with no explanation is the one outcome worse than an honest failure.

**What breaks if the creator-browser-only constraint is ever reversed**, flagged as asked:
very little, and that is by design.
The creator flow depends on exactly three things a shell would change: the ingest policy would resolve to `ample` more often, `maxLocalOriginalBytes` would stop mattering, and E.4b would stop happening because a bundled ffmpeg would decode anything.
Nothing in the data model, the token mechanics, the redacted projection, or the delivery state machine assumes a browser.
The one thing that would need real thought is **identity**: a token in a URL is the right identity for a browser with no account, and an installed creator app would want something more durable, at which point the `access_token` model would need a device-binding concept it currently does not have.
Everything else is additive.

---

## F. Dynamic and expandable data

### F.1 Confirm or reject, per growth axis

**More tags over time: CONFIRMED.**
`tag_vocabulary` is separate from `tag` assignments, carries `aliases`, `status`, `merged_into_id`, `parent_id`, and every assignment carries `source`.
- **Merge**: set `status='merged'` plus `merged_into_id`, and resolve through the pointer at read time. No mass rewrite of assignment rows, ever.
- **Rename**: change `label` only. `slug` is the stable identity, `label` is display. This is why they are two columns.
- **Alias**: append to `aliases`, and the search index picks it up on the next reindex of affected assets.
- **One gap to close**: a merge or alias change alters search results, so affected assets must be reindexed. Without `reindex_queue` from A.17, merges appear not to work and someone spends an hour debugging the search scorer instead of the invalidation. Small fix, named now.

**More content types: PARTIALLY, and fix it now.**
`clip` as designed is video-shaped (`duration_s`, `fps`, `orientation`).
Already corrected in A.7: the noun is `asset` with `kind` in `('video','photo','audio','doc')`, `duration_s` and `fps` nullable.
- Photos reuse the poster path and the sheet is the photo itself.
- Audio replaces `frame_hashes` with a waveform peaks array in the same jsonb slot.
- Longer form is just a video with `duration_s > 60`, and `hls_ready` becomes relevant.
- Everything else, tags, review, brief-item matching, search, gaps, is already `kind`-agnostic.
This is a twenty minute decision today and a genuinely painful migration in three months, which is exactly the kind of thing this review exists to catch.

**More branches: CONFIRMED.**
`branch_id` is on `collab`, `asset`, and `gap`, gap cells are branch-scoped with null meaning global, `app_user.branch_scope` handles a future branch manager with no new role, and `org_id` is on every row from day one.
Per A2.1 the tenancy model is one org with roles plus a branch filter, which is the shape that lets the library stay pooled while visibility narrows.

**More insight types on creators and on the library: CONFIRMED, but only because insights are records.**
The `insight` table from A.16 (`subject_type`, `subject_id`, `kind`, `title`, `body`, `severity`, `score`, `evidence`, `ai_run_id`, `status`) means a new insight type is a new `kind` value and zero migration.
The alternative, a column per insight (`creator.churn_risk`, `library.staleness_score`, and so on), is the trap: it looks tidier for the first three and becomes a migration per idea after that.
`gap` stays a specialisation with its own table because it is queried differently (by scan, by cell, by severity) and it has a lifecycle that generic insights do not.

**New AI outputs added later without migrating everything: CONFIRMED, on two conditions.**

1. **Every AI-derived scalar must be reconstructible by replaying `ai_run`.** The test is a `rebuildDerived()` action that wipes all `ai_*` projections and replays. If that button works, the claim is true. If it does not exist, the claim is a hope, and the first schema change will prove it.
2. **`output_json` is stored verbatim and never dropped for current runs.** This is the mechanism that makes it free: when prompt v2.1 starts returning `ai_motion`, that field is already present in every v2.1 run's raw output, so adding the column and re-projecting costs no model calls at all. Store only the projection and the same change costs a full re-run of the library.

### F.2 Versioning and migration mechanics

**Local (IndexedDB).**
A `meta` store holding `schema_version`.
Migrations are an ordered array of pure functions `v(n) -> v(n+1)`.
Structural changes (new object stores, new indexes) run inside `onupgradeneeded`, because that is the only place IndexedDB permits them.
Row rewrites run in a post-open data pass, chunked by cursor so a 5,000-row migration does not block the UI thread.
Two hard rules: **never write a migration that needs the network**, and **never rename in place**.
Renames are expand-then-contract across separate versions: add the new field, backfill, stop reading the old one, drop it later.
Write the migration in the same commit that adds the field, not "later", because later is after the demo has data in it.

**Server (Postgres).**
Numbered forward-only files in `/supabase/migrations`, additive, same expand-and-contract discipline for renames.

**AI prompts, which is the interesting half.**
Prompt templates are files with a key and a semantic version: `prompts/vision_tag.v2.1.md`.
A build step hashes each rendered template into `prompt_hash`.
Every `ai_run` records `model_id`, `prompt_key`, `prompt_version`, `prompt_hash`, `model_params`, and `effort`.
Re-running never overwrites: it inserts a new `ai_run` and flips `is_current`, with `superseded_by_run_id` pointing back.

That gives a real eval harness almost for free: **run prompt v2.1 against the same 30 contact sheets that v2.0 saw, and diff the two projections side by side.**
Precision and recall per tag facet, how often the shot type changed, how often the brief match changed, cost and latency delta.
It is a diff of two sets of rows and it needs no new infrastructure, which is why having prompt versions without this view is having version numbers rather than versioning.
The seeded `ai_run` rows should include one subject that has both a v1 and a v2 run precisely so this view has content in the demo.

Combined with C2.A, the same view answers the mock question: a mock run and a later live run on the same subject diff through the identical mechanism.

### F.3 The gap scan, computed from real data

This is the loop that makes the system closed rather than linear, so it gets the most detail.

**What a gap is, precisely.**
A gap is a **cell of the coverage cube where editor demand exceeds usable supply.**

`cell = (branch_id, shot_type, room, subject, time_of_day, season, orientation)`, with `null` meaning wildcard.
`cell_signature` is a sha256 over the canonicalised (sorted-key) cell, which is what `gap_dismissal` keys on.

Run the scan at **three granularities only**, not the full cross product:
`branch x shot_type`, `branch x shot_type x room`, `branch x shot_type x time_of_day`.
Keep the most specific cell that clears the evidence bar, and suppress its parents when a child is kept.
The full cube would yield thousands of meaningless micro-gaps, and a gaps tab with 400 rows is the same product as a gaps tab with zero.

**Demand signals, over a rolling 90 day window (30 day also computed, for trend):**

| id | signal | source | weight |
|---|---|---|---|
| D1 | zero-result queries | `search_query_log` where `result_count = 0`, mapped to cells via `parsed_filters` | **3.0** |
| D2 | refine-then-abandon chains | chains via `refined_from_query_id` ending in `outcome='abandoned'` with no clicks | **2.5** |
| D3 | low-engagement searches | `result_count > 0` but zero clicks, or clicks only at rank > 10 | 1.0 |
| D4 | raw search volume touching the cell | count of all queries mapping to the cell | 0.5 x ln(1+n) |
| D5 | explicit editor requests | the "add to next brief" button, `signals.source='editor_request'` | **4.0** |
| D6 | rejected results | `usage_event` where `event='reject_result'` | 1.5 |

D1 is weighted high because it is unambiguous unmet demand.
D2 is weighted nearly as high and is the signal most systems ignore: results existed and none were good enough, which is a worse product failure than zero results because the editor wasted time before giving up.
D5 is highest because a human explicitly asked, and a system that does not obey an explicit human request loses trust immediately.
D4 is deliberately logarithmic and low: volume is a plausibility check, not the point.

**The guard that makes D4 necessary at all:** a cell nobody searches is not a gap even at zero supply.
Without that guard the scan generates busywork briefs for footage no editor will ever want, which is the fastest way to make the feature look stupid.

**Supply signals:**

| id | signal | definition |
|---|---|---|
| S1 | usable supply | count of `asset` where `review_status='approved'` and `is_published` and `deleted_at is null` in the cell. **Only approved counts**, a pile of pending clips is not coverage |
| S2 | quality-weighted supply | `sum(min(1, ai_quality_score))`, plus a bonus for `is_hero`, so eight mediocre clips do not mask a gap |
| S3 | freshness | days since the newest approved asset in the cell |
| S4 | rejection rate in the cell | high rejection means creators keep trying and failing here, which is a **briefing** problem, not a quantity problem |
| S5 | usage concentration | if one asset has `used_count = 20` and the rest are 0, the cell is effectively depth-1 |

S4 and S5 are the two that change what the system should *do*, not just what it reports.
S4 high means rewrite the brief item's wording, not order more clips.
S5 high means the cell looks covered and is not, because editors keep reaching for the same one clip, and reusing one clip across a whole campaign is exactly the authenticity failure this product exists to fix.

**Scoring, concretely:**

```
demand            = 3.0*D1 + 2.5*D2 + 1.0*D3 + 0.5*ln(1+D4) + 4.0*D5 + 1.5*D6

freshness_factor  = clamp(1 - days_since_newest/180, 0.3, 1.0)
                    (seasonal cells use the season window instead of 180 days)

effective_count   = count(used_count > 0) + 0.5 * count(approved and used_count = 0)
supply_effective  = S2 * freshness_factor * min(1, effective_count / 3)

deficit           = demand / (1 + supply_effective)

severity          = critical  if deficit >= 8 and demand >= 5
                    high      if deficit >= 4
                    medium    if deficit >= 2
                    low       otherwise  (low gaps are stored but never shown)
```

**The minimum evidence bar, which is the single most important guard in the whole feature:**
require at least **2 distinct signals from at least 2 distinct sessions**, or **one D5**.
Without it, one curious search on a Tuesday afternoon generates a shot in a creator's brief, the manager notices it is nonsense, and the feature is never trusted again.
A gap scan's credibility is spent once.

**The computation pipeline, in execution order.**
This is deterministic aggregation over local records, not a model call.
The model's only job in the scan is naming and phrasing, which is why `gap_scan.ai_run_id` is nullable and why a gap is still computable with the AI layer switched off entirely.

**Step 1: map queries to cells.**
Each `search_query_log` row already carries `parsed_filters` from the query parser (`search_parse`), which is where the model does its work: turning `hands closeup san jose` into `{shot_type:'hands_closeup', branch:'san-jose'}`.
For rows where `parsed_filters` is absent or the parse failed, fall back to token matching against `tag_vocabulary.slug` plus `aliases`, and mark the mapping `confidence:'low'`.
Unmappable queries are not discarded: they accumulate in a `unmapped_query_tokens` roll-up, which is itself a vocabulary-growth signal per E.3.
A query maps to **one cell per granularity level**, so `hands closeup san jose morning` contributes to `(sj, hands_closeup)`, `(sj, hands_closeup, room:*)`, and `(sj, hands_closeup, morning)`.

**Step 2: aggregate demand.**
One cursor over `search_query_log.by_created` within the window, incrementing per-cell counters for D1 to D6, and a walk of `by_refined_from` to detect chains (a chain is scored once, on its terminal query, not once per hop, or a three-step refinement counts triple).
`usage_event.by_event` supplies D6.
Chains are the only part needing two passes: build a child-to-parent map first, then classify terminals.

**Step 3: aggregate supply.**
One cursor over `asset.by_library` (published and approved only), bucketing into the same cells via `ai_shot_type`, `ai_room`, `branch_id`, `orientation`, plus `captured_at` mapped to `time_of_day` and `season`.
Accumulate S1, S2, `max(published_at)` for S3, and `count(used_count > 0)` for S5.
S4 needs a second cursor over `asset.by_review` filtered to `rejected`, because rejected assets are excluded from supply but their count is a signal.

**Step 4: merge target coverage.**
For every cell in `branch.target_coverage` with no demand signal at all, synthesise `demand = 2.0` with `signals.source='target_coverage'`.
This is the cold-start path, and keeping it as a synthetic demand contribution rather than a separate code path means one scoring function handles both modes and the UI shows why each gap exists.

**Step 5: score, then prune.**
Apply the formulas above.
Then the pruning, which is what turns 400 candidate cells into 9 usable gaps, in this order:
1. Drop cells failing the evidence bar (2 signals from 2 sessions, or one D5, or `target_coverage`).
2. Drop `severity='low'`.
3. **Suppress parents whose child survived**: if `(sj, hands_closeup, morning)` is kept, drop `(sj, hands_closeup)`, because reporting both is reporting the same hole twice at two zoom levels and it makes the tab look padded.
4. Drop cells whose `cell_signature` is in `gap_dismissal` and not expired.
5. Cap at the top 12 by `deficit_score` per branch, and record the count suppressed so the UI can say "plus 6 lower-priority gaps".

**Step 6: carry status forward, then write.**
For each surviving cell, look up the previous scan's gap by `cell_signature` (`gap.by_cell`).
Carry `status` forward when it was `assigned` (a brief item already references it) and recompute otherwise.
Detect closure: if the previous gap was `open` or `assigned` and `supply_effective` now exceeds the threshold that created it, write it as `closed` with `closed_at` and `closing_asset_ids` (the assets in the cell whose `published_at` is after the previous scan, joined via `brief_item.by_origin_gap` where available so attribution is exact rather than inferred).
Then insert the `gap_scan` row plus its immutable `gap` rows in one transaction.

**Cost and scheduling.**
The whole scan is three cursors plus two hash-map passes over roughly 240 queries, 600 events, and 5,000 assets, which is single-digit milliseconds locally and a handful of `group by` statements in Postgres later.
There is no reason to make it incremental, and making it incremental would be a mistake: a full recompute per scan is what lets the scoring weights change without a backfill, and it is what makes `gap_scan` a genuinely comparable snapshot.
Run it on demand from the Gaps tab, automatically after any batch of approvals, and on a nightly schedule once a server exists.
Store every scan, never overwrite, because "what did we think the gaps were last month" is the question that proves the loop worked.

**Storage.**
`gap_scan` per run (window, params, `ai_run_id`), plus immutable `gap` rows referencing it.
`signals` jsonb holds the raw counts.
`evidence` jsonb holds **actual query ids and asset ids**, so the UI can render "3 editors searched this 7 times, here are the queries, and here are the 2 clips you do have".
Evidence is what turns a number into something a manager will act on.
A gap with no "show me why" is a horoscope, and it will be dismissed on sight.

**Human control**: `gap_dismissal`, keyed by `cell_signature` and not by `gap.id`, with a reason and an optional expiry, surviving every future scan.
Skip this and every scan resurrects the gaps the manager already killed, which turns the most important feature in the product into nagware that gets switched off in week two.

**How it feeds the next brief, and this is the demo.**
Brief generation takes the top N open gaps for the target branch, ordered by `deficit_score`, as explicit prompt input, and **every generated `brief_item` carries `origin_gap_id`**.
`brief.gap_scan_id` records which snapshot fed it.
That pair of links is the entire closed loop, and neither can be reconstructed after the fact, so both must exist in the first commit.

The demonstrable path, end to end:

1. An editor searches `hands closeup san jose`, gets 0 results.
2. The query is logged with `result_count=0` and `unmet_facets`, and the editor taps "add this to the next brief".
3. The gap scan produces a `critical` gap on cell `(san_jose, hands_closeup, *, *)` with evidence naming those queries.
4. The next San Jose brief contains item #3, "hands closeup, treatment room, morning light", badged **"closes gap: hands closeup / San Jose"** via `origin_gap_id`.
5. The creator delivers, the checklist confirms coverage before they leave, the manager approves.
6. The same search now returns 4 clips.
7. The next scan flips the gap to `closed` with `closed_at` and `closing_asset_ids`, and the UI shows the before-and-after count.

**Close detection**: a gap closes when `supply_effective` in its cell crosses the threshold that created it, recorded on the following scan.
That "we found this hole and filled it, here are the clips that filled it" number is the single most persuasive thing in the whole demo, and it is computable only because `origin_gap_id` and `closing_asset_ids` exist.

**The bootstrapping problem, stated honestly because it will otherwise be discovered on demo day.**
On day one there are no search logs, so demand is zero and the scan produces nothing.
Two fixes, and both are needed:

1. **Seed real search history**: 240 `search_query_log` rows including clustered zero-result and abandoned chains, per C2.C. This is what makes the demand-driven scan demonstrable at all.
2. **A coverage-only mode**: gaps derived from `branch.target_coverage`, an expected cell list per branch, defined by the manager or generated once from the branch profile. This lets the system say "you have no morning-light reception footage at all" without any editor having failed first, and it is the honest answer for a brand new branch.

Ship both.
Lead the demo with the demand-driven one because it is the better story, and keep coverage-only as the answer to "what about a brand new branch", which a panel will ask.
Palo Alto in the seed exists precisely to make that answer live rather than hypothetical.

---

## G. The complete build, dependency ordered

Effort is not the constraint.
Two real constraints remain: the submission deadline of **Aug 10 2026**, and **no server plus no server storage** in the prototype (a product decision, with the Supabase path fully designed).
One thing stays deliberately narrow for product reasons rather than effort reasons: **creator visibility**, per A2.2, is own submissions plus a small manager-curated exemplar strip. No creator browsing, no creator social surface, no discovery. That is feature discipline, not a cut.

So this section is a dependency graph and a build order, not a triage list.

### G.1 The dependency graph

**Foundation, blocks everything downstream. Must be correct before anything is built on it.**

| id | piece | blocked by | blocks |
|---|---|---|---|
| F1 | `platform/clock.ts`, `platform/rng.ts`, `uuidv7(clock, rng)` with the monotonic `rand_a` counter, plus the eslint ban on ambient time and randomness | nothing | every record write in the system |
| F2 | Schema definition, IndexedDB open, migration runner, `meta.schema_version`, profile namespacing (`astolia_demo_v*` / `astolia_live_v*`) | F1 | all persistence |
| F3 | Scoped repository, three session factories, projection allowlists, the scope test | F2 | every UI read and write |
| F4 | Outbox, `sync_state`, and the `SyncAdapter` interface | F2 | sync, and nothing else can be retrofitted |
| F5 | Canonical JSON (sorted keys) plus sha256 helpers | nothing | `ai_run` cache keys, `cell_signature`, `fixture_hash`, `prompt_hash` |
| F6 | `PlatformPort` plus `resolvePlatform()` plus `probeCapabilities()` and `deriveIngestPolicy()` (C3, E.4a) | nothing | the media pipeline, the quota watcher, the file picker, and the AI transport |

**F6 belongs in the foundation, not in a later platform phase.**
Only the `browser` implementation is exercised, but the seam has to exist before Track A is written, because retrofitting `navigator.storage.*` and `<video>`-shaped extraction behind an interface afterwards means reopening the media pipeline.
`electron` and `native` are written as unexercised implementations against the same interface and committed alongside the Electron config, per the honesty rule in section 0.

**F4 must be built at the same time as F3, not after it.**
This is the single most important sequencing decision in the whole build.
The outbox is fed by every mutation, so adding it later means reopening every write path in the application.
Built together, the repository is the only writer and the outbox append is one line inside it.

F1 and F5 are pure functions with no dependencies and can be written first, in parallel with each other.

**Track A: media pipeline.** Independent of AI and of UI.

| id | piece | blocked by |
|---|---|---|
| A1 | MP4/MOV atom parser: `moov/mvhd` (timescale, creation time), `tkhd` display matrix, `udta/©day`, `com.apple.quicktime.creationdate`, `com.apple.quicktime.location.ISO6709`, `stsd` codec fourcc, 64-bit atom sizes, fragmented MP4 tolerance | F5 |
| A2 | Frame extraction with the capability chain in G.4, contact sheet JPEG encoder, dHash, poster encoder | nothing |
| A3 | Preflight rule engine: a pure function `(fileFacts, briefItem, branch, existingHashes) -> preflight` | A1 |
| A4 | OPFS writer and reader, `media_state` transitions, quota watcher, eviction ladder | F2 |
| A5 | `ingestFile(file)` composing A1 to A4, the single entry point for both real uploads and fixture loads | A1..A4, F2, F3 |

**Track B: fixtures and seed.** B1 has no dependencies at all and should be the very first thing built, because everything else can be tested against it.

| id | piece | blocked by |
|---|---|---|
| B1 | `scripts/build-fixtures.mjs` with `ffmpeg-static`, the 8 engineered clips, `manifest.json` with `declared` plus `expected_preflight` plus `tolerance` | nothing |
| B2 | Fixture tests asserting `expected_preflight` against the real parser | A1, A2, A3, B1 |
| B3 | `scripts/build-seed.mjs` under seeded clock and RNG, producing `seed.json` plus `img/` | F1, F2 |
| B4 | Seed hydration, reset, profile switch | F2, B3 |

**Track C: AI layer.** Parallel with A and B.

| id | piece | blocked by |
|---|---|---|
| C1 | Provider interface plus the five JSON schemas (vet, brief_gen, vision_tag, brief_match, search_parse), plus gap_scan and nudge_draft | nothing |
| C2 | Schema validator, shared by every implementation | C1 |
| C3 | Deterministic mock implementations, validated by C2 | C1, C2, F1 |
| C4 | Replay implementation plus the captured-response fixture format and the `(input_hash, prompt_hash, model_id)` cache | C1, C2, F5 |
| C5 | Live implementation plus the Netlify function (built and correct, not exercised for this submission) | C1, C2 |
| C6 | `ai_run` writer, the provenance check guard, `is_current` maintenance, and the projection step | C1..C5, F2 |
| C7 | Prompt files with key plus semver plus build-time hash, and the eval harness that diffs two prompt versions or a mock against a live run | C6 |

C6 blocks every AI-derived field in the UI, so it is on the critical path.
C7 depends only on C6 and can be built at any time after it.

**Track D: search.** Parallel with C, joins it at D3.

| id | piece | blocked by |
|---|---|---|
| D1 | Tokenizer, `search_token` and `asset_facet` writers, `reindex_queue` plus its incremental worker | F2, F3 |
| D2 | Retrieval, scoring, ranking priors, per-tile match explanation | D1 |
| D3 | AI query parser producing a filter and ranking spec | D2, C3 |
| D4 | Zero-result ladder, `unmet_facets`, term-relaxation labelling, the "add to next brief" gap write | D3 |

**Track E: the closed loop.** The longest chain in the build.

| id | piece | blocked by |
|---|---|---|
| E1 | Gap scan: cell mapping, demand and supply aggregation, scoring, evidence assembly, dismissal filtering | D1, C6, and real `search_query_log` data (which B3 supplies) |
| E2 | Brief generation taking gap input, writing `origin_gap_id` and `brief.gap_scan_id` | E1, C6 |
| E3 | Brief lock, versioning, immutability guard | E2 |
| E4 | Brief match plus the promise-versus-delivered diff including the extras bucket | E3, A5, C6 |
| E5 | Gap close detection and the before-and-after count | E1, E4, review |

**Track F: UI surfaces.** All blocked by F3, and independent of each other, so they parallelise cleanly.

Manager: triage inbox, kanban, deal drawer, creators list with scorecard, gaps tab, review queue with brief-item grouping.
Editor: library grid, clip sheet, collections, saved searches.
Creator: invite page with consent plus the exemplar strip, upload page with the live checklist.
Plus: Sync panel, Data Health panel, storage panel.

**Track G: sync.**

| id | piece | blocked by |
|---|---|---|
| G1 | `SyncAdapter` interface | part of F4 |
| G2 | `LoopbackAdapter`: second IndexedDB acting as server, own `server_updated_at` clock, real per-table conflict rule application | F4, G1 |
| G3 | `SupabaseAdapter`: real `supabase-js` code, real table names, env-gated | G1 |
| G4 | Sync panel: outbox depth, cursors, adapter name, conflict list | G2 |

**Track H: Supabase and object storage artifacts.** Completely independent of the app code, so this track can run from day one in parallel with everything.

H1 `0001_init.sql`, H2 `0002_rls.sql`, H3 `0003_functions.sql`, H4 the storage and transcode specification from D.6, H5 the Worker signing specification.

**The critical path**, which is what actually determines whether the loop demos:

`F1 → F2 → F3+F4 → A1..A5 → creator upload → delivery → C6 → E4 review → library publish → D1..D2 search → E1 gap scan → E2 brief with origin_gap_id → E5 close`

Everything else hangs off that spine.
B1 should be built before F1 so that A1 to A3 have something to assert against from their first line of code.

### G.2 Suggested phase order given the Aug 10 deadline

Phases, not days, and the parallel tracks are marked.

**Phase 0.** B1 fixtures plus manifest. F1 clock, RNG, uuidv7. F5 canonical hashing. All three are independent and have no upstream.

**Phase 1.** F2 schema plus migration runner plus profile namespacing. Then F3 and F4 together. In parallel: C1 and C2 (schemas plus validator), H1 to H3 (the SQL).

**Phase 2.** A1 to A5 media pipeline with B2 fixture tests going green as each lands. In parallel: C3 and C4 (mock plus replay), B3 seed generator, D1 index writers.

**Phase 3.** A5 wired into the creator upload page and the delivery flow. C6 `ai_run` writer plus projection. B4 seed hydration, so the library is non-empty. In parallel: D2 retrieval plus scoring, F-track manager triage inbox and review queue.

**Phase 4.** E3 brief lock, E4 brief match plus the diff. D3 and D4 query parser plus zero-result ladder. In parallel: editor library grid and clip sheet, G2 loopback adapter.

**Phase 5.** E1 gap scan, E2 gap-fed brief generation, E5 close detection. This is the phase that makes the product a loop rather than a pipeline, and it depends on almost everything above it, which is exactly why it is scheduled here and not earlier.

**Phase 6.** C7 eval harness, G3 and G4, Data Health panel, export and import, consent surface, Capacitor config plus the iOS notes. Then the thinking doc, README, and the recording.

The one ordering warning: **do not leave E1 to the end by accident.** It looks like a reporting feature and it is the product thesis. If it slips, the submission is a pipeline with AI in it rather than a closed loop, which is a materially weaker product story.

### G.3 What the complete build includes that a trimmed one would not

Everything below is in scope, and each line says why it belongs rather than what it costs.

- **Auto-approve, actually executing.** Trust tier computation, the threshold rule from E.1, the hard gate, the forced 10% QA sample, the "auto" badge driven by `review_action.method`. A preview-only toggle would demonstrate the thinking, but the sampling loop is the part that makes the rule safe, and a rule without its safety mechanism is not the design.
- **The full server-side transcode and ingest pipeline, specified to implementation detail** (D.6 below), including the queue, the idempotency key, the derivative manifest, and the failure and retry semantics. Nothing is deployed because there is no server, but the client honours the exact contract, so the spec is load-bearing rather than decorative.
- **`reindex_queue` with a real incremental worker**, coalescing by `asset_id`, running in an idle callback, with a visible backlog count. A manual rebuild button would hide the fact that merges and alias edits must invalidate.
- **The prompt-version eval harness and the mock-versus-live diff** (C7). This is how you know a prompt change improved anything, and it is the difference between having prompt versions and using them.
- **Data Health panel**, counting `ai_run` by provider and kind, plus projection coverage. It answers "is any of this real" directly, which is the correct thing for a simulated-AI submission to answer proactively.
- **`review_action.ai_provenance_at_decision`.** Records which human approvals were made while looking at simulated evidence. Once mock and live data coexist, this is the only way to audit that.
- **Export and import snapshot.** The only thing that makes the durable record survive browser eviction in a no-server build, and it doubles as demo-state save and as the seeding path.
- **Consent and usage rights, complete.** Versioned consent text, immutable acceptance record, snapshotted terms, and a clip sheet that shows what each asset is cleared for and until when. See G.5.
- **Photo and audio kinds, working through ingest**, not just as an enum value: photos take the sheet-is-the-photo path, audio takes a waveform-peaks path in place of `frame_hashes`. The UI can stay minimal, but the pipeline branch should be real, because that is where the design claim actually gets tested.
- **Creator scorecard in full**, including per-branch breakdown and a trend across collabs, since the whole point of the scorecard is feeding vetting, and a single aggregate number cannot show that a creator got worse.
- **The chunked resumable upload state machine complete**, with the transport behind the adapter interface. Locally the transport writes to OPFS, and the state machine (offsets, retries, resume after tab death) is exercised for real by the fixture loads.
- **Palo Alto with genuine depth.** Enough assets, queries, and target coverage that cross-branch gap comparison is a real computation rather than a placeholder. The cold-start path and the comparison path are two different behaviours and both need data.
- **Capacitor config plus the iOS platform notes** (HEVC, OPFS behaviour, quota, `playsInline`, ITP eviction). No device build, because the brief explicitly scopes device verification out.
- **The platform port with all three implementations written** (C3), the Capacitor Electron configuration, and the desktop platform notes. Committed, unexercised, and stated as untested in the thinking doc. The browser implementation is the only one that runs, and `MediaCodec.transcode()` throwing `Unsupported` in it is the design rather than an omission.
- **The tri-state preflight** (A.19) and **`review_session`** (A.20). Both are consequences of desktop being a first-class surface, and both are model-level rather than cosmetic: booleans cannot express "this camera has no GPS chip", and a keyboard cursor cannot be well defined over a list that reorders.

### G.4 Still rejected, because they are the wrong engineering call

Not one of these is excluded for effort.

1. **A vector database or an embeddings service.** At 5,000 assets with roughly 12 tags each over about 50 vocabulary terms, an inverted index in IndexedDB answers in single-digit milliseconds, and the answer is exact. Embeddings would add a 1,536-float vector per asset (about 6KB, which is larger than the entire asset record), a re-embed on every description or tag edit, and an ANN index to build and maintain. Worse, they degrade precisely where our queries live: E.2 established that real queries are 1 to 3 nominal tokens like `hands` or `towels`, where lexical match is already exact and semantic neighbourhood actively hurts, because `hands ≈ arms ≈ fingers` is sometimes what you want and sometimes completely wrong, and the user cannot tell which happened. The model parsing the query into an inspectable filter and ranking spec is strictly better here, because a wrong filter is visible and correctable while a wrong embedding neighbourhood is not. Revisit at roughly 50,000 assets with genuinely descriptive multi-clause queries. The model already reserves the slots (`tag_vocabulary.embedding`, `asset.embedding`, `pgvector` commented in the DDL) so this is a decision that stays reversible.
2. **CRDTs.** The conflicts in this product are semantic, an approval against a rejection, not textual. A CRDT converges on a state that is mathematically consistent and can be a state no human intended, which is worse than a surfaced conflict. The patch-level outbox plus the written per-table rules in C.3 produces the correct answer and can be explained to a colleague.
3. **Event sourcing the whole application.** We already use append-only logs exactly where they earn their keep: `ai_run`, `review_action`, `tag` edges, `usage_event`, and the outbox. Making everything else event-sourced would turn the eight screens' read paths from "one cursor over one index" (A.18) into projections that have to be maintained and rebuilt, for no gain, and it would put a rebuild job between a manager and their review queue.
4. **A permissions admin UI.** There are three roles plus a branch filter. A permissions editor is the right product for a customer whose role structure is genuinely variable, and this one's is not. Adding it would create a surface where somebody can misconfigure their way into the leaks that A2 exists to prevent.
5. **HLS at the current content length.** A 6 second clip at 1.4Mbps is about 1MB. An HLS ladder inserts a master playlist fetch plus a media playlist fetch before the first segment request, so it is strictly slower to first frame than a faststart MP4 that begins playing on the first range response. The correct design is the trigger, not the ladder: generate HLS when `kind='video'` and `duration_s > 60`, keyed per asset (`hls_ready` flag, `drv/v1/{asset_id}/hls/`), so it is a per-asset decision rather than a platform migration. Written that way in D.6.
6. **Six kanban implementations.** The stages are data in `collab.stage`. The board is one component rendered per stage.
7. **A tag browser tree.** Rejected on the evidence in E.2: editors reach for free text and facets are only useful when derived from the current result set. A tree asks the user to learn a taxonomy in order to search, which inverts the interaction.
8. **Hard deletes anywhere.** Soft delete plus an explicit, audited purge. A sync bug should cost a UI glitch, never footage.
9. **A service or endpoint per AI capability.** One provider interface, one Netlify function, one model with varying `effort`, per the stack decision. Seven capabilities behind one seam is simpler to reason about and simpler to swap.
10. **Schema-per-branch or project-per-branch tenancy.** Rejected in A2.1 on product grounds: it would fragment the pooled library and the creator history, which are the two things that must accumulate.

### G.5 Correctness risks that need real engineering, not a time box

These are the places where the implementation is genuinely hard, so here is the right way to do each rather than a budget for it.

**1. The MP4/MOV atom parser: build it properly, and test it per gotcha.**
What must be parsed: `moov/mvhd` (timescale plus creation time, noting the 1904 epoch), the `tkhd` display matrix for rotation, `udta/©day`, the Apple metadata keys `com.apple.quicktime.creationdate` and `com.apple.quicktime.location.ISO6709`, `stsd` sample entry fourcc for `hvc1`/`hev1`/`avc1`, 64-bit atom sizes (`size == 1`, then a 64-bit largesize), and tolerance for fragmented MP4 where `moov` may follow `mdat`.
The right shape is a pure function over an `ArrayBuffer` returning a partial facts object with per-field confidence, which is precisely why B1 and B2 exist as a track: one engineered fixture per gotcha, asserted independently.
Where metadata is genuinely absent (`no_metadata.mp4`), the honest answer is already in the model: `captured_at_source='unknown'`, and the UI presents it as unknown rather than guessing, with a creator-facing "when did you shoot this" input as the fallback.
Never present `File.lastModified` as a capture date without marking the source.

**2. Frame extraction: use a capability chain, and version the extractor.**
`video.currentTime = t` then awaiting `seeked` then `drawImage` is flaky across engines: it yields black frames on Safari without `playsInline` and `muted`, sometimes needs an initial `play()`, and seek accuracy varies with GOP structure.
Since effort is not the limiter, build the better path first and fall back:
`WebCodecs VideoDecoder` plus an MP4 demux where available (Safari 17+, Chrome, Edge) gives deterministic, frame-accurate extraction with no seek flakiness at all, then `<video>` plus canvas as the fallback, then a generated placeholder tile (filename plus duration) so the UI never breaks on an undecodable file.
`contact_sheet.generator_version` and `asset_frame` existing as records is what makes this safe to improve later: a better extractor bumps the version and re-derives old sheets from bytes, and the `reindex_queue` carries the work.
Probe capability once at startup and record which path produced each sheet.

**3. The live-key dependency.**
Solved by design (replay plus the `(input_hash, prompt_hash, model_id)` cache), and the sequencing matters: C4 belongs in Phase 2 alongside C3, not appended at the end. A demo that needs working wifi is a demo that fails in a conference room.

**4. Editor surface scope.**
One search box, one grid, one clip sheet, collections, saved searches. No timeline, no trimming, no NLE export. Not because it is expensive: because a half-built editing surface competes with the tools editors already use and loses, while a great retrieval surface is something they do not have.

**Architecturally wrong as originally described, and corrected in this document:**

5. **`localStorage` for the dataset.** Corrected in B. It would cap the library near 40 clips and stall the main thread. IndexedDB plus OPFS.
6. **A single `tags` array on the clip.** An AI re-run would silently erase the manager's curation. **This is the highest-rework item in the review**, because it corrupts the exact data the product's future ranking and prompt evaluation depend on, and the corruption is invisible until you go looking for it.
7. **`clip` as the top-level noun.** Make it `asset` with `kind`.
8. **Client `updated_at` as the sync cursor.** Use `server_updated_at`. A skewed device clock otherwise makes rows permanently invisible with no error anywhere.
9. **Gaps keyed by id rather than by `cell_signature`.** Dismissals would not survive a rescan and the flagship feature becomes nagware.
10. **Raw records on the creator token surface.** Needs the redacted projection from A2.3 and C.2, or the Supabase version leaks vetting scores and comp values to the creator whose score it is.

### G.6 Consent and usage rights

Absent from the original plan, and it belongs in the build.

The creator accepts usage terms on the invite page, and that acceptance is a stored, versioned, immutable record tied to the collab, with the agreed terms **snapshotted** into `collab.usage_terms_text` rather than referenced by pointer, so a later edit to the standard terms cannot retroactively change what somebody agreed to.
`consent_text_version`, `consent_accepted_at`, `consent_ip_hash`, and `consent_user_agent` are all write-once, and all on the never-LWW list.

The clip sheet then shows what each asset is cleared for and until when: "cleared for paid social and organic, until 2027-08-04", derived from the collab's snapshotted terms.
The library search should be able to filter on it, because an editor building a paid campaign needs to know that a clip is organic-only **before** they cut with it, not after legal asks.
Add `asset.usage_scope` as a projection of the parent collab's terms so that filter is a facet rather than a join.

This is the difference between a demo and something a real business would put a stranger's face into a paid ad with.
A multi-branch wellness brand has exactly this question, and answering it before being asked is worth more than another screen.

---

## Findings, ordered by how much rework they cause if ignored

1. **A single `tags` array instead of source-tagged edge rows.** An AI re-run erases human curation silently. Destroys the eval set and the ranking signal, and the loss is invisible until you look for it. Fix: `tag` rows with `source`, `removed_at`, `rejected_by_human`, and `ai_run_id`. Cost now: near zero. Cost later: unrecoverable, because the deleted data is gone.
2. **No `ai_run` provenance, or AI fields written directly onto records.** Without `model_id`, `prompt_version`, `prompt_hash`, `provider`, and verbatim `output_json`, you cannot re-run, compare, or tell mock from live, and a demo silently poisons the dataset. Fix: `ai_run` as the spine, all AI fields as projections, plus the check constraint that makes a mock run unable to claim a model.
3. **Missing `origin_gap_id` on `brief_item` and `gap_scan_id` on `brief`.** These two links are the closed loop. They cannot be reconstructed retroactively, so the product's headline claim becomes unmeasurable forever. Two columns.
4. **`localStorage` as the dataset store.** Caps the demo at about 40 clips and stalls the UI. Fix: IndexedDB plus OPFS, `localStorage` for about 50KB of preferences.
5. **Human curation fields under last-write-wins.** A stale device republishes a clip a human rejected for consent or brand safety. Worst available bug in the system. Fix: band 4 is monotonic and safety-biased, `rejected` beats `approved`, conflicts surface a banner.
6. **Client `updated_at` as the sync cursor.** Silent, permanent row invisibility from one skewed clock. Fix: `server_updated_at` via trigger, `(server_updated_at, id)` cursor.
7. **Visibility scoping in components rather than one layer.** Guarantees a leak as the app grows, and the leak is a creator seeing their own fit score. Fix: one scoped repository, three session factories, projection allowlists shared with the future RLS, one 40-line test.
8. **No redacted projection for the creator token surface.** Raw records expose `fit_score`, `risk_flags`, `comp_value_usd`, and internal branch notes to an unauthenticated stranger. Fix: `collabPublicView()` locally, `security definer` RPC on the server, `anon` granted zero table access.
9. **Boolean preflight instead of a tri-state.** A boolean cannot distinguish "shot 8km from the branch" from "this camera has no GPS receiver", so a legitimate mirrorless delivery from the VIP location gets a red cross and, worse, can be gated out of uploading. Desktop offload makes this the common case, not an edge case. Fix: `pass` / `fail` / `unknown` / `skipped` per rule with the evidence named, `unknown` never blocking, and `unknown` never rendered as a pass (A.19). High rework because the gate logic, the review UI, the creator checklist, and the seed all read this field.
10. **Collapsing "where are the bytes" into "do we have pixels".** Without `derivative_state` orthogonal to `media_state`, the undecodable asset is unrepresentable, and the enrichment path (a browser ingests with no sheet, a desktop shell or server produces one later) becomes a repair job instead of a state transition. Fix: `derivative_state` plus `derivative_producer`, merged as an ordinal so a stale `none` can never erase a sheet somebody produced.
11. **A keyboard review queue over an unfrozen list.** The cursor is implicit, so a background sync landing or a decision mutating the sort key reorders rows under it and the reviewer approves the wrong clip. Fix: `review_session` with a frozen `ordered_asset_ids`, a UUIDv7 final tiebreak, dim-in-place rather than remove, keystroke idempotency via `session_id`, and `review_status` as a projection of `review_action` so undo works (A.20). This is a data-integrity bug produced by an interaction affordance, which is why the fix is in the model.
12. **Branching processing on device category rather than derived capability.** "3 frames on mobile" is unimplementable correctly: `deviceMemory` is Chromium-only so every Safari user reads as constrained, and a static probe cannot see thermal throttling. Fix: one `deriveIngestPolicy()` with an absent-signal-scores-middle rule, a measured first-clip downgrade, and the tier recorded on the artifacts it shaped (E.4a).
13. **Letting the AI layer run without stills.** A model asked to tag a clip it cannot see will produce plausible tags from the filename and brief context, those tags enter the search index, and an editor is eventually served a clip nobody has ever looked at. Fix: vision tagging requires a `sheet_id` and refuses without one, no `ai_run` row is created, and coverage reports as `indeterminate` rather than met or missing.
14. **`clip` instead of `asset` with `kind`.** Twenty minutes now, a painful migration the moment photos or audio appear.
15. **Gaps keyed by id rather than `cell_signature`.** Dismissals do not survive a rescan, the flagship feature becomes nagware and gets turned off.
16. **Assuming the manager reviews every clip.** Collapses at 150 to 250 clips per week on touch, 400 to 600 on a desktop keyboard. Fix: brief-item review unit, earned trust tiers, the narrow auto-approve rule, the forced 10% QA sample, and `review_action.method` recorded from day one.
17. **A shared store for demo and live data with a flag.** One bug in the outbox drain pushes fabricated data into a real backend. Fix: separate namespaced databases per profile.
18. **Ambient `Date.now()` and `Math.random()` in the data layer.** Non-reproducible demos and flaky tests. Fix: injected `Clock` and `Rng`, one UUIDv7 generator taking both, `rand_a` as a monotonic sub-millisecond counter, plus an eslint ban. Extend the same ban to `navigator.hardwareConcurrency`, `deviceMemory`, `connection`, and `matchMedia`, so capability reads go through the platform port instead of leaking into components.
19. **No platform port.** Retrofitting `navigator.storage.*` and `<video>`-shaped extraction behind an interface after the media pipeline is written means reopening the media pipeline. Fix: `PlatformPort` in the foundation (C3), browser exercised, electron and native written and unverified.
20. **No `reindex_queue`.** Tag merges, alias changes, and newly available sheets appear not to take effect, and the debugging goes to the wrong place.
21. **Designing search around the polished demo query.** Real editors type 1 to 3 tokens. Fix: optimise single-word queries, results-derived facet chips, and a zero-result ladder ending in "add to next brief".
22. **Media deletion reachable from a sync path.** A sync bug should cost a UI glitch, not footage. Fix: soft delete only, purge is a separate manual action that writes `review_action`.
23. **Overwriting derivatives in place in object storage.** Permanent stale-cache debugging. Fix: version the prefix (`drv/v1/`, `drv/v2/`), serve `immutable`.
24. **No export and import.** In a no-server build, browser eviction is total and silent, and the browser is the only runtime here. Fix: one-click snapshot export and import, which doubles as the seeding and demo-save mechanism.
25. **Consent and usage rights missing entirely.** Terms must be snapshotted at acceptance, not referenced, or editing the standard terms retroactively changes what people agreed to. Plus `asset.usage_scope` as a facet, so an editor filters by clearance before cutting rather than after legal asks.
26. **No `usage_event.rank_at_event`.** The cleanest relevance label available, free to collect, impossible to backfill. Log it before anything consumes it.
27. **A count-based cap on locally held originals.** Safe for three phone clips, unsafe for one card offload, since a two-minute ProRes clip is 1.8GB on its own. Fix: `maxLocalOriginalBytes`, tier-scaled.

**Sources for section D pricing, all retrieved Aug 6 2026:**
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing),
[Supabase storage pricing](https://supabase.com/docs/guides/storage/pricing),
[Supabase egress pricing](https://supabase.com/docs/guides/platform/manage-your-usage/egress),
[AWS S3 pricing 2026 breakdown](https://www.cloudzero.com/blog/s3-pricing/).
