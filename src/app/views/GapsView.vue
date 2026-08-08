<script setup lang="ts">
// The gaps panel: what the library cannot answer, with the evidence, and the
// two actions that move the loop: feed a gap into the next brief, or dismiss
// the cell so no rescan resurrects it.
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import type { Gap } from '@/data/types'
import { useAppStore } from '../store'
import { detectClosures, runGapScan, type ClosureResult } from '../loop/loop'

interface ScanRow {
  id: string
  ran_at: number
  window_days: number
  gaps_found: number
}

const store = useAppStore()
const router = useRouter()

const gaps = shallowRef<Gap[]>([])
const scans = shallowRef<ScanRow[]>([])
const closures = ref<Map<string, ClosureResult>>(new Map())
const vocabularyGaps = ref<string[]>([])
const loaded = ref(false)

async function reload() {
  const repo = store.repo
  if (!repo) return
  gaps.value = (await repo.list<Gap>('gap')).sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  )
  scans.value = (await repo.list<ScanRow>('gap_scan')).sort((a, b) => b.ran_at - a.ran_at)
  loaded.value = true
}

onMounted(reload)

const latestScan = computed(() => scans.value[0] ?? null)
const openGaps = computed(() => gaps.value.filter((gap) => gap.status === 'open'))
const closedGaps = computed(() => gaps.value.filter((gap) => gap.status === 'closed'))

async function scanNow() {
  const repo = store.repo
  const clock = store.ctx?.clock
  if (!repo || !clock) return
  const result = await runGapScan({ repo, now: clock.now() })
  vocabularyGaps.value = result.vocabularyGaps
  await reload()
}

async function closeNow() {
  const repo = store.repo
  if (!repo) return
  const results = await detectClosures(repo)
  const next = new Map(closures.value)
  for (const closure of results) next.set(closure.gapId, closure)
  closures.value = next
  await reload()
}

async function dismiss(gap: Gap) {
  const repo = store.repo
  if (!repo) return
  // The dismissal is keyed by signature, so the next scan skips the cell
  // instead of resurrecting it. The gap row itself just changes status.
  await repo.create('gap_dismissal', {
    cell_signature: gap.cell_signature,
    reason: 'manager_dismissed',
    dismissed_by: store.session?.user_id ?? '',
  })
  await repo.patch('gap', gap.id, { status: 'dismissed' })
  await reload()
}

function feedToBrief(gap: Gap) {
  router.push({ path: '/briefs', query: { gap: gap.id } })
}

function cellLabel(gap: Gap): string {
  return Object.entries(gap.facets)
    .map(([facet, value]) => `${facet}: ${value.replace(/_/g, ' ')}`)
    .join(', ')
}

function scanDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
</script>

<template>
  <div
    data-testid="gaps-panel"
    class="gaps"
  >
    <header
      data-testid="gap-scan-header"
      class="head"
      :data-gap-scan-id="latestScan?.id"
    >
      <h1>Gaps</h1>
      <p
        v-if="latestScan"
        class="muted"
      >
        Last scan {{ scanDate(latestScan.ran_at) }}, {{ latestScan.window_days }} day window,
        {{ latestScan.gaps_found }} gaps.
      </p>
      <button
        type="button"
        data-testid="gap-scan-run"
        class="action"
        @click="scanNow"
      >
        Scan now
      </button>
      <button
        type="button"
        class="action"
        @click="closeNow"
      >
        Detect closures
      </button>
    </header>

    <p
      v-if="vocabularyGaps.length"
      class="vocab"
    >
      Vocabulary gaps, not content gaps: {{ vocabularyGaps.join(', ') }}.
      Editors use these words and the taxonomy does not know them yet.
    </p>

    <section class="list">
      <article
        v-for="gap in openGaps"
        :key="gap.id"
        data-testid="gap-row"
        class="gap"
        :data-gap-id="gap.id"
        :data-cell-signature="gap.cell_signature"
        :data-severity="gap.severity"
        :data-source="gap.signals[0]?.source"
        :data-status="gap.status"
      >
        <div class="gap-main">
          <span class="cell">{{ cellLabel(gap) }}</span>
          <span
            data-testid="gap-deficit"
            class="mono severity"
            :data-severity="gap.severity"
          >{{ gap.severity }} &middot; {{ gap.score.toFixed(2) }}</span>
        </div>
        <ul
          data-testid="gap-evidence"
          class="evidence"
        >
          <li
            v-for="signal in gap.signals"
            :key="signal.source"
            :data-source="signal.source"
          >
            {{ signal.source.replace(/_/g, ' ') }}<template v-if="signal.detail">
              : {{ signal.detail }}
            </template>
          </li>
        </ul>
        <div class="gap-actions">
          <button
            type="button"
            data-testid="gap-dismiss"
            class="action quiet"
            @click="dismiss(gap)"
          >
            Dismiss
          </button>
          <button
            type="button"
            data-testid="gap-feed-to-brief"
            class="action"
            :data-gap-id="gap.id"
            @click="feedToBrief(gap)"
          >
            Feed to next brief
          </button>
        </div>
      </article>
    </section>

    <section
      v-if="closedGaps.length"
      class="list"
    >
      <h2>Closed</h2>
      <article
        v-for="gap in closedGaps"
        :key="gap.id"
        data-testid="gap-row"
        class="gap closed"
        :data-gap-id="gap.id"
        :data-cell-signature="gap.cell_signature"
        :data-status="gap.status"
      >
        <div class="gap-main">
          <span class="cell">{{ cellLabel(gap) }}</span>
          <span
            data-testid="gap-closed-badge"
            class="closed-badge mono"
            :data-gap-id="gap.id"
            :data-count="gap.closing_asset_ids.length"
          >closed by {{ gap.closing_asset_ids.length }} clip(s)</span>
        </div>
        <p
          v-if="closures.get(gap.id)"
          class="coverage-delta"
        >
          <span
            data-testid="gap-coverage-before"
            class="mono"
            :data-count="closures.get(gap.id)!.before"
          >before: {{ closures.get(gap.id)!.before }}</span>
          <span
            data-testid="gap-coverage-after"
            class="mono"
            :data-count="closures.get(gap.id)!.after"
          >after: {{ closures.get(gap.id)!.after }}</span>
        </p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.gaps {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-4);
  max-width: 54rem;
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

h2 {
  font-size: 0.95rem;
  font-weight: 640;
  margin: 0;
}

.muted {
  color: var(--muted);
  font-size: 0.8rem;
  margin: 0;
}

.vocab {
  margin: 0;
  font-size: 0.82rem;
  color: var(--warn);
  border: 1px dashed var(--warn);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}

.list {
  display: grid;
  gap: var(--space-2);
}

.gap {
  background: var(--surface);
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  display: grid;
  gap: var(--space-1);
}

.gap[data-severity='critical'] {
  border-left-color: var(--critical);
}

.gap[data-severity='high'] {
  border-left-color: var(--warn);
}

.gap.closed {
  border-left-color: var(--good);
}

.gap-main {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: baseline;
  flex-wrap: wrap;
}

.cell {
  font-size: 0.88rem;
  font-weight: 620;
}

.severity {
  color: var(--muted);
  font-size: 0.72rem;
}

.evidence {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 0.75rem;
}

.gap-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.action {
  appearance: none;
  font: inherit;
  font-size: 0.78rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
}

.action.quiet {
  background: var(--surface);
  color: var(--muted);
}

.closed-badge {
  color: var(--good);
  font-size: 0.72rem;
}

.coverage-delta {
  margin: 0;
  display: flex;
  gap: var(--space-3);
  color: var(--muted);
  font-size: 0.75rem;
}
</style>
