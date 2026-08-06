# Double pass: verification, cross-check, and what it changed

The two reviews were produced independently. This is what survived checking them against outside sources, against each other, and against every instruction in the thread.

## 1. Claims I verified independently

**Storage pricing, all four vendors, fetched 2026-08-06 from the vendors themselves rather than from the review:**

| vendor | storage | egress | verdict |
|---|---|---|---|
| Cloudflare R2 | $0.015/GB-mo standard, $0.01 infrequent access | free | matches the review |
| Amazon S3 | $0.023/GB-mo first 50TB | $0.09/GB first 10TB | matches the review |
| Backblaze B2 | $6.95/TB-mo | free to 3x stored, then $0.01/GB | matches the review |
| Supabase Storage | $0.0213/GB-mo | $0.09/GB uncached | matches, and cached egress is $0.03/GB, which the review did not mention and which slightly improves Supabase for preview assets without changing the outcome |

One nuance the review's "$8 with originals on infrequent access" figure should carry: R2 infrequent access adds a $0.01/GB retrieval charge and higher operation prices, which is still correct for archived originals but is not free.
**Recommendation stands: R2 for bytes, Postgres for rows.**

**Codec claims.** The caveats review tagged its own confidence per claim (`[V]` verified, `[V-]` partly, `[I]` inference), which is the discipline I wanted. Spot checking the load bearing one: Chromium ships no built in software HEVC decoder and relies on platform hardware decode from Chrome 107, which my own search corroborates. The precise Electron version boundary (hardware decode at 22.0.0, encoding at 33.0.0) I could confirm only for the encoding half, and since the desktop shell is designed and not built, the exposure is low. Marked as partly verified rather than repeated as fact.

**Honest limits of this pass.** Section I on shells is largely inference by the reviewer's own admission, and the ffmpeg patent position is an open legal question nobody in this project is deciding. Both are flagged in place rather than smoothed over.

## 2. Reconciliations between the two reviews

Two vocabularies for the same idea, and one weighting disagreement. No substantive contradiction, which is a good signal.

**Pre-flight states.** Architecture specifies four (`pass`, `fail`, `unknown`, `skipped`). Caveats specifies three (`pass`, `fail`, `not_evaluated`).
Resolution: **adopt the four state form**, because it separates "the evidence does not exist" (a camera has no GPS chip) from "the rule could not run" (frames could not be extracted), which are different facts with different UI. Map `not_evaluated` to `skipped`.
Caveats additionally contributes the enumerated failure reasons (`decode_unsupported`, `zero_duration`, `zero_dimensions`, `blank_frame`, `seek_timeout`, `metadata_timeout`), which slot into the architecture's per rule `reason` field. Complementary, both adopted.

**Download as the usage signal.** This is the one place the reviews pull in different directions, and the caveats side is right.
Architecture treats download plus `rank_at_event` as the usage signal feeding the scorecard and the gap scan. Caveats ranks download-as-usage in Tier 1: the inference's errors are not random (it measures thumbnail appeal, it is dominated by bulk hand-offs, it misses proxy workflows entirely), and it feeds a number attached to a real person's name which then feeds vetting.
Resolution: **download is evidence of intent, not evidence of use.** Keep logging it, with `rank_at_event`, as a weak signal with its own weight. Add an explicit confirmation moment so a real "used it" exists, and never let the scorecard treat the two as the same fact. This corrects something I told the user earlier in plainer terms than I said it.

## 3. Gaps that only the cross-check found

Neither review closes these alone, because each sits in the seam between them.

1. **The scoped repository stops data access, not retained rendered state.** Caveats ranks a cached view leaking the previous role's data as the highest probability leak in the product, caused by the standard fix for preserving grid scroll position. The architecture's single enforcement layer does not cover a component that is still mounted with data it legitimately fetched a moment ago. Fix: a role change nonce keyed into the view tree so a switch remounts rather than restores, plus a test asserting no previous role data is present after a switch.
2. **Provenance stops at the asset.** Architecture makes an AI record unable to lie about being mock, and tracks provenance per tag, per asset, and per dataset. Caveats points out that derived aggregates, gaps and scorecards, do not carry the provenance of their inputs. So a gap computed from mock tags looks identical to one computed from real tags. Fix: carry an input provenance summary on `gap_scan` and on the scorecard, so a simulated derived artefact is identifiable as such.
3. **The open relay has a cleaner answer than either review gave.** Caveats correctly ranks the unauthenticated function as unbounded spend that looks like legitimate traffic, and lists five layered controls. The simpler resolution, available because of a decision made after both briefs: **the function ships with no key configured**, so there is nothing to relay, and the layered controls are documented for whenever a key exists. State both halves in the thinking doc.

## 4. What this changes in decisions I had already stated

1. **Effort settings.** Do not disable thinking on this model. Adaptive thinking stays on with `effort: low` for the classification shaped calls, `high` for brief matching and vetting, and nothing uses `xhigh`. Disabling thinking has three separate documented failure modes here, including a 400 when paired with higher effort and leaked thinking tags in visible output. Also worth one line in the thinking doc: model tiering was considered and rejected in favour of a single model architecture, so a reviewer does not assume it was never thought about.
2. **Contact sheet resolution is a hard requirement, not a cost preference.** One composite tiled image per clip, capped near 1024px on the long edge. Current Opus tier vision goes to 2576px and thousands of visual tokens per image, which is exactly what this task does not want, and the platform payload ceiling makes it a correctness constraint rather than an optimisation.
3. **No embeddings became a better design, not just a cheaper one.** The model's job is explicitly term to taxonomy mapping, shown to the editor as removable chips (`golden hour` to `warm_light`), with unmapped terms surfaced rather than silently dropped, and accepted mappings persisted as a synonym table so the second occurrence needs no model call at all. Two consequences worth naming: an unmapped term is evidence of a vocabulary gap and must never be counted as a content gap, and the artefact this produces is auditable by a human in a way an embedding neighbourhood is not.
4. **Which AI capability to make excellent.** The reviewer argues for intake (AI-3) over the gap scan (AI-0), not by dropping the gap scan but because the gap scan's correctness is a function of intake quality: mislabelled clips produce a gap that is already filled, and a real creator gets asked to shoot footage that exists. Build both fully, and treat intake as the thing that has to be trustworthy first. The ordering is forced rather than chosen.
5. **Manager review collapse point moved.** Keyboard driven desktop review is 8 to 15 seconds per decision, so the collapse moves from 150 to 250 clips a week up to 400 to 600. The trust tier ladder is still required, just later. And a faster interaction makes a wrong decision cheaper to make, which is why the frozen review session and stale row refusal are correctness features rather than polish.

## 5. Instruction coverage

Every instruction given in the thread is tracked in `03-thread-audit.md` with a status. Two items remain open and both need the user rather than more analysis:

1. Whether we spend a small amount on one real capture run, so the demo replays genuine model output instead of synthetic output. The infrastructure is identical either way.
2. The pipeline stage label: `delivered` is what both reviews and the schema now use, after I suggested renaming it from "Footage In" and never got an answer. Zero cost to change.
