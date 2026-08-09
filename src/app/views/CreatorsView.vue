<script setup lang="ts">
// The creator roster: vetting on the left of each row, what actually happened on
// the right. That layout is the argument. A fit score is a guess made before any
// work; the scorecard is measured from rows after it, and putting them side by
// side is what lets a manager notice the guess was wrong.
//
// Colour carries the responsibility, per docs/05-design-system.md. Amber is the
// model's score, deep green is a human's override, and the scorecard is neutral
// because it is arithmetic over rows nobody chose.
import { computed, onMounted, ref, shallowRef } from 'vue'
import type { Asset, Brief, BriefItem, Branch, Collab, Creator, Delivery } from '@/data/types'
import { useAppStore } from '../store'
import { computeScorecards, rosterOrder, type ScoredCreator } from '@/data/scorecard'
import { allowedTiers, overrideFitScore, vetCreator, type VettingOutcome } from '../manager/vetting'

const store = useAppStore()

const rows = shallowRef<ScoredCreator[]>([])
const branches = shallowRef<Map<string, Branch>>(new Map())
const collabsByCreator = shallowRef<Map<string, Collab[]>>(new Map())
const loaded = ref(false)

const busyId = ref<string | null>(null)
const outcomes = ref<Map<string, VettingOutcome>>(new Map())
const overrideFor = ref<string | null>(null)
const overrideScore = ref('')
const overrideReason = ref('')
const overrideError = ref<string | null>(null)

async function reload() {
  const repo = store.repo
  if (!repo) return
  // A manager-only surface. On a role switch the tree remounts before the
  // router's redirect settles, so for one tick this view can hold a session
  // that may not read these stores.
  if (store.session?.kind !== 'manager') return

  const [creators, collabs, deliveries, assets, briefs, briefItems, branchRows] = await Promise.all([
    repo.list<Creator>('creator'),
    repo.list<Collab>('collab'),
    repo.list<Delivery>('delivery'),
    repo.list<Asset>('asset'),
    repo.list<Brief>('brief'),
    repo.list<BriefItem>('brief_item'),
    repo.list<Branch>('branch'),
  ])

  rows.value = computeScorecards({ creators, collabs, deliveries, assets, briefs, briefItems }).sort(
    rosterOrder,
  )
  branches.value = new Map(branchRows.map((row) => [row.id, row]))

  const grouped = new Map<string, Collab[]>()
  for (const collab of collabs) {
    const list = grouped.get(collab.creator_id) ?? []
    list.push(collab)
    grouped.set(collab.creator_id, list)
  }
  collabsByCreator.value = grouped
  loaded.value = true
}

onMounted(reload)

const scored = computed(() => rows.value.filter((row) => row.effective_score != null).length)
const drifting = computed(() => rows.value.filter((row) => row.drift.length > 0).length)

/**
 * The outcome for a row, narrowed for the template.
 *
 * A template cannot carry a type assertion, and it should not have to: a
 * refusal and a failure both have a reason, and asking for it by name here keeps
 * the discriminated union honest in one place rather than in three v-ifs.
 */
function outcomeOf(id: string): VettingOutcome | null {
  return outcomes.value.get(id) ?? null
}

function outcomeReason(id: string): string {
  const outcome = outcomeOf(id)
  return outcome && outcome.status !== 'vetted' ? outcome.reason : ''
}

function outcomeRunId(id: string): string | undefined {
  const outcome = outcomeOf(id)
  return outcome?.status === 'vetted' ? outcome.runId : undefined
}

function pct(value: number | null): string {
  return value == null ? 'unknown' : `${Math.round(value * 100)}%`
}

async function runVet(row: ScoredCreator) {
  const repo = store.repo
  if (!repo || busyId.value) return
  busyId.value = row.creator.id
  try {
    const collabs = collabsByCreator.value.get(row.creator.id) ?? []
    const branch = collabs[0] ? (branches.value.get(collabs[0].branch_id) ?? null) : null
    const outcome = await vetCreator({ repo }, row.creator, collabs, branch)
    outcomes.value = new Map(outcomes.value).set(row.creator.id, outcome)
    if (outcome.status === 'vetted') await reload()
  } finally {
    busyId.value = null
  }
}

function startOverride(row: ScoredCreator) {
  overrideFor.value = row.creator.id
  overrideScore.value = row.creator.fit_score_override?.toString() ?? ''
  overrideReason.value = row.creator.override_reason ?? ''
  overrideError.value = null
}

async function saveOverride(row: ScoredCreator) {
  const repo = store.repo
  if (!repo) return
  const raw = overrideScore.value.trim()
  const score = raw.length === 0 ? null : Number(raw)
  if (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) {
    overrideError.value = 'A fit score is 0 to 100. Leave it empty to withdraw the override.'
    return
  }
  try {
    await overrideFitScore(repo, row.creator.id, score, overrideReason.value)
    overrideFor.value = null
    await reload()
  } catch (error) {
    overrideError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div
    data-testid="creators"
    class="creators"
  >
    <header class="head">
      <h1>Creators</h1>
      <p
        v-if="loaded"
        class="muted"
        data-testid="creators-summary"
        :data-count="rows.length"
      >
        {{ rows.length }} on the roster, {{ scored }} scored.
        <span v-if="drifting">{{ drifting }} with a stale stored scorecard.</span>
      </p>
    </header>

    <p class="muted note">
      The score on the left was a guess made before any work. The scorecard on the right is counted
      from rows after it. They are next to each other so a guess that was wrong is visible.
    </p>

    <section class="list">
      <article
        v-for="row in rows"
        :key="row.creator.id"
        data-testid="creator-row"
        class="creator"
        :data-creator-id="row.creator.id"
        :data-lifecycle="row.creator.lifecycle"
        :data-score-source="row.effective_source"
      >
        <div class="identity">
          <span class="name">{{ row.creator.display_name }}</span>
          <span class="mono handle">{{ row.creator.primary_handle }}</span>
          <span
            class="lifecycle"
            :data-lifecycle="row.creator.lifecycle"
          >
            {{ row.creator.lifecycle }}
          </span>
        </div>

        <!-- the guess -->
        <div class="vetting">
          <span
            v-if="row.effective_source === 'human'"
            data-testid="creator-fit-score"
            class="score human"
            :data-provenance="'human'"
            :data-score="row.effective_score ?? undefined"
          >
            {{ row.effective_score }}
            <span class="score-label">decided by a person</span>
          </span>
          <span
            v-else-if="row.effective_source === 'model'"
            data-testid="creator-fit-score"
            class="score ai"
            :data-provenance="'ai'"
            :data-score="row.effective_score ?? undefined"
          >
            {{ row.effective_score }}
            <span class="score-label">proposed by a model</span>
          </span>
          <span
            v-else
            data-testid="creator-fit-score"
            class="score none"
            :data-provenance="'none'"
          >
            not scored
            <span class="score-label">no run, and no guess invented</span>
          </span>

          <!-- The model's number stays visible under a human override. Hiding it
               would erase the disagreement, which is the only reason the two are
               separate columns. -->
          <p
            v-if="row.effective_source === 'human' && row.creator.fit_score != null"
            data-testid="creator-override-note"
            class="override-note"
          >
            overrides the model's {{ row.creator.fit_score }}:
            {{ row.creator.override_reason || 'no reason recorded' }}
          </p>

          <ul
            v-if="row.creator.fit_reasons.length"
            class="reasons"
          >
            <li
              v-for="reason in row.creator.fit_reasons"
              :key="reason"
            >
              {{ reason }}
            </li>
          </ul>
          <ul
            v-if="row.creator.risk_flags.length"
            class="risks"
            data-testid="creator-risk-flags"
          >
            <li
              v-for="flag in row.creator.risk_flags"
              :key="flag"
            >
              {{ flag }}
            </li>
          </ul>
          <p
            v-if="row.creator.suggested_tier"
            class="muted tiny"
          >
            suggested visit: {{ row.creator.suggested_tier }}
            <span class="mono">(band: {{ allowedTiers(row.creator.reliability_tier).join(', ') }})</span>
          </p>
        </div>

        <!-- what happened -->
        <div
          class="scorecard"
          data-testid="creator-scorecard"
        >
          <span
            class="tier"
            :data-tier="row.creator.reliability_tier"
          >
            {{ row.creator.reliability_tier }}
          </span>
          <dl class="figures">
            <div>
              <dt>completed</dt>
              <dd
                data-testid="scorecard-completed"
                :data-count="row.computed.completed_collabs"
              >
                {{ row.computed.completed_collabs }}
              </dd>
            </div>
            <div>
              <dt>approved</dt>
              <dd
                data-testid="scorecard-approval-rate"
                :data-status="row.computed.approval_rate == null ? 'unknown' : 'known'"
              >
                {{ pct(row.computed.approval_rate) }}
                <span class="mono denom">{{ row.computed.assets_approved }}/{{ row.computed.assets_ruled_on }}</span>
              </dd>
            </div>
            <div>
              <dt>promise kept</dt>
              <dd
                data-testid="scorecard-promise-kept"
                :data-status="row.computed.promise_kept_rate == null ? 'unknown' : 'known'"
              >
                {{ pct(row.computed.promise_kept_rate) }}
                <span class="mono denom">
                  {{ row.computed.brief_items_delivered }}/{{ row.computed.brief_items_promised }}
                </span>
              </dd>
            </div>
            <div v-if="row.computed.ghosted">
              <dt>ghosted</dt>
              <dd data-testid="scorecard-ghosted">
                {{ row.computed.ghosted }}
              </dd>
            </div>
          </dl>
          <p
            v-if="row.drift.length"
            data-testid="scorecard-drift"
            class="drift"
          >
            stored scorecard is stale: {{ row.drift.join('; ') }}
          </p>
        </div>

        <div class="actions">
          <button
            type="button"
            data-testid="creator-vet"
            class="action"
            :disabled="busyId === row.creator.id || row.creator.lifecycle === 'blocked'"
            @click="runVet(row)"
          >
            {{ busyId === row.creator.id ? 'Scoring...' : 'Score with the model' }}
          </button>
          <button
            type="button"
            data-testid="creator-override"
            class="action quiet"
            @click="startOverride(row)"
          >
            Override
          </button>
        </div>

        <p
          v-if="outcomeOf(row.creator.id)?.status === 'refused'"
          data-testid="creator-vet-refusal"
          class="refusal"
        >
          {{ outcomeReason(row.creator.id) }}
        </p>
        <p
          v-else-if="outcomeOf(row.creator.id)?.status === 'failed'"
          data-testid="creator-vet-failure"
          class="refusal"
        >
          {{ outcomeReason(row.creator.id) }}
        </p>
        <p
          v-else-if="outcomeOf(row.creator.id)?.status === 'vetted'"
          data-testid="creator-vet-receipt"
          class="receipt"
          :data-ai-run-id="outcomeRunId(row.creator.id)"
        >
          scored, run recorded
        </p>

        <form
          v-if="overrideFor === row.creator.id"
          data-testid="creator-override-form"
          class="override"
          @submit.prevent="saveOverride(row)"
        >
          <label>
            <span>Score</span>
            <input
              v-model="overrideScore"
              data-testid="override-score"
              inputmode="numeric"
              placeholder="0 to 100"
            >
          </label>
          <label>
            <span>Why</span>
            <input
              v-model="overrideReason"
              data-testid="override-reason"
              placeholder="What the model could not see"
            >
          </label>
          <p
            v-if="overrideError"
            data-testid="override-error"
            class="refusal"
          >
            {{ overrideError }}
          </p>
          <div class="override-actions">
            <button
              type="submit"
              data-testid="override-save"
              class="action"
            >
              Save
            </button>
            <button
              type="button"
              class="action quiet"
              @click="overrideFor = null"
            >
              Cancel
            </button>
          </div>
        </form>
      </article>
    </section>
  </div>
</template>

<style scoped>
.creators {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
  max-width: 62rem;
}

.head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  margin: 0;
}

.muted {
  color: var(--muted);
  font-size: 0.8rem;
  margin: 0;
}

.note {
  max-width: 44rem;
}

.tiny {
  font-size: 0.72rem;
}

.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.list {
  display: grid;
  gap: var(--space-2);
}

.creator {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-3);
  display: grid;
  grid-template-columns: minmax(11rem, 1fr) minmax(14rem, 1.4fr) minmax(12rem, 1.2fr) auto;
  gap: var(--space-3);
  align-items: start;
}

.creator[data-lifecycle='blocked'] {
  opacity: 0.72;
  border-left: 3px solid var(--critical);
}

.identity {
  display: grid;
  gap: 2px;
}

.name {
  font-weight: 620;
  font-size: 0.92rem;
}

.handle,
.lifecycle {
  color: var(--muted);
  font-size: 0.74rem;
}

.lifecycle[data-lifecycle='blocked'] {
  color: var(--critical);
}

.vetting,
.scorecard {
  display: grid;
  gap: var(--space-1);
}

.score {
  font-size: 1.15rem;
  font-weight: 660;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.score-label {
  font-size: 0.68rem;
  font-weight: 400;
}

/* Amber is a model's output and deep green is a human's decision. There is no
   third colour for "unscored", because a missing number is not a claim. */
.score.ai {
  color: var(--ai);
}

.score.human {
  color: var(--good);
}

.score.none {
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 500;
}

.override-note {
  margin: 0;
  font-size: 0.72rem;
  color: var(--muted);
}

.reasons,
.risks {
  margin: 0;
  padding-left: 1rem;
  font-size: 0.74rem;
  color: var(--muted);
}

.risks {
  color: var(--warn);
}

.tier {
  font-size: 0.72rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.figures {
  margin: 0;
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.figures div {
  display: grid;
  gap: 1px;
}

.figures dt {
  font-size: 0.66rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.figures dd {
  margin: 0;
  font-size: 0.86rem;
  font-weight: 600;
}

/* Absent evidence reads as absent, never as a pass and never as a zero. */
.figures dd[data-status='unknown'] {
  color: var(--muted);
  font-weight: 500;
}

.denom {
  font-size: 0.66rem;
  font-weight: 400;
  color: var(--muted);
}

.drift {
  margin: 0;
  font-size: 0.7rem;
  color: var(--warn);
}

.actions {
  display: grid;
  gap: var(--space-1);
  justify-items: stretch;
}

.action {
  appearance: none;
  font: inherit;
  font-size: 0.76rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  white-space: nowrap;
}

.action.quiet {
  background: var(--surface);
  color: var(--muted);
}

.action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refusal {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 0.76rem;
  color: var(--warn);
}

.receipt {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 0.74rem;
  color: var(--good);
}

.override {
  grid-column: 1 / -1;
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  align-items: flex-end;
  border-top: 1px solid var(--line);
  padding-top: var(--space-2);
}

.override label {
  display: grid;
  gap: 2px;
  font-size: 0.7rem;
  color: var(--muted);
}

.override input {
  font: inherit;
  font-size: 0.82rem;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink);
}

.override-actions {
  display: flex;
  gap: var(--space-2);
}

@media (max-width: 860px) {
  .creator {
    grid-template-columns: 1fr;
  }

  .actions {
    grid-auto-flow: column;
    justify-content: start;
  }
}
</style>
