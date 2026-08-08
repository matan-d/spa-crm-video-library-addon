<script setup lang="ts">
// The triage inbox: the real product surface, built before the kanban on
// purpose. Deliveries are grouped by what is actionable, never by arrival
// order, and each row opens the deal drawer whose centrepiece is the promise
// versus delivered diff.
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import type { Asset, Branch, BriefItem, Collab, Creator, Delivery } from '@/data/types'
import { useAppStore } from '../store'
import {
  computeDiff,
  triageDelivery,
  TRIAGE_BUCKET_ORDER,
  type DeliveryDiff,
  type TriagedDelivery,
} from '../manager/triage'

const store = useAppStore()
const router = useRouter()

const deliveries = shallowRef<Delivery[]>([])
const assets = shallowRef<Asset[]>([])
const collabs = shallowRef<Map<string, Collab>>(new Map())
const creators = shallowRef<Map<string, Creator>>(new Map())
const branches = shallowRef<Map<string, Branch>>(new Map())
const loaded = ref(false)

onMounted(async () => {
  const repo = store.repo
  if (!repo) return
  deliveries.value = await repo.list<Delivery>('delivery')
  assets.value = await repo.list<Asset>('asset')
  collabs.value = new Map((await repo.list<Collab>('collab')).map((row) => [row.id, row]))
  creators.value = new Map((await repo.list<Creator>('creator')).map((row) => [row.id, row]))
  branches.value = new Map((await repo.list<Branch>('branch')).map((row) => [row.id, row]))
  loaded.value = true
})

const triaged = computed<TriagedDelivery[]>(() =>
  deliveries.value.map((delivery) => triageDelivery(delivery, assets.value)),
)

const byBucket = computed(() => {
  const groups = new Map<string, TriagedDelivery[]>()
  for (const bucket of TRIAGE_BUCKET_ORDER) groups.set(bucket, [])
  for (const entry of triaged.value) groups.get(entry.bucket)!.push(entry)
  // Within a bucket, the most recently submitted first: freshest work on top.
  for (const list of groups.values()) {
    list.sort((a, b) => (b.delivery.submitted_at ?? 0) - (a.delivery.submitted_at ?? 0))
  }
  return groups
})

function creatorOf(delivery: Delivery): string {
  const collab = collabs.value.get(delivery.collab_id)
  const creator = collab ? creators.value.get(collab.creator_id ?? '') : undefined
  return creator?.display_name ?? 'Unknown creator'
}

function branchOf(delivery: Delivery): string {
  const collab = collabs.value.get(delivery.collab_id)
  const branch = collab ? branches.value.get(collab.branch_id) : undefined
  return branch?.name ?? ''
}

// ---- the deal drawer ------------------------------------------------------
const drawer = ref<{ delivery: Delivery; diff: DeliveryDiff; briefId: string | null } | null>(null)

async function openDrawer(delivery: Delivery) {
  const repo = store.repo
  if (!repo) return
  const briefs = await repo.list<{ id: string; collab_id: string; status: string }>('brief', {
    where: (row) => row.collab_id === delivery.collab_id,
  })
  const brief = briefs.find((row) => row.status === 'locked') ?? briefs[0] ?? null
  const items = brief
    ? await repo.list<BriefItem>('brief_item', { where: (row) => row.brief_id === brief.id })
    : []
  const own = assets.value.filter((asset) => asset.delivery_id === delivery.id)
  drawer.value = { delivery, diff: computeDiff(items, own), briefId: brief?.id ?? null }
}

function startReview(delivery: Delivery) {
  router.push(`/review/${delivery.id}`)
}

const bucketLabels: Record<string, string> = {
  needs_review: 'Needs review',
  awaiting_derivatives: 'Awaiting derivatives',
  blocked: 'Blocked',
  done: 'Done',
}
</script>

<template>
  <div
    data-testid="triage-inbox"
    class="triage"
  >
    <h1>Triage</h1>

    <p
      v-if="loaded && triaged.length === 0"
      data-testid="triage-empty"
      class="empty"
    >
      Nothing to triage. Deliveries appear here the moment a creator submits.
    </p>

    <section
      v-for="bucket in TRIAGE_BUCKET_ORDER"
      :key="bucket"
      data-testid="triage-bucket"
      :data-bucket="bucket"
      class="bucket"
    >
      <header class="bucket-head">
        <h2>{{ bucketLabels[bucket] }}</h2>
        <span
          data-testid="triage-bucket-count"
          class="mono count"
          :data-count="byBucket.get(bucket)!.length"
        >{{ byBucket.get(bucket)!.length }}</span>
      </header>

      <ul class="rows">
        <li
          v-for="entry in byBucket.get(bucket)"
          :key="entry.delivery.id"
          data-testid="triage-delivery-row"
          :data-delivery-id="entry.delivery.id"
          :data-collab-id="entry.delivery.collab_id"
          :data-count="entry.pendingCount"
          class="row"
        >
          <div class="row-main">
            <span data-testid="triage-delivery-creator">{{ creatorOf(entry.delivery) }}</span>
            <span
              data-testid="triage-delivery-branch"
              class="muted"
            >{{ branchOf(entry.delivery) }}</span>
            <span class="muted mono">{{ entry.pendingCount }} of {{ entry.assetCount }} awaiting a decision</span>
          </div>
          <div class="row-actions">
            <button
              type="button"
              data-testid="triage-open-delivery"
              class="action"
              @click="openDrawer(entry.delivery)"
            >
              Open
            </button>
            <button
              v-if="entry.pendingCount > 0"
              type="button"
              data-testid="triage-start-review"
              class="action primary"
              @click="startReview(entry.delivery)"
            >
              Review
            </button>
          </div>
        </li>
      </ul>
    </section>

    <!-- the deal drawer -->
    <aside
      v-if="drawer"
      data-testid="deal-drawer"
      class="drawer"
      :data-delivery-id="drawer.delivery.id"
      aria-label="Delivery detail"
    >
      <header class="drawer-head">
        <h2>Promise versus delivered</h2>
        <button
          type="button"
          class="close"
          aria-label="Close"
          @click="drawer = null"
        >
          &times;
        </button>
      </header>

      <div
        data-testid="promised-vs-delivered"
        class="diff"
        :data-brief-id="drawer.briefId ?? undefined"
      >
        <p
          data-testid="diff-coverage-pct"
          class="coverage mono"
          :data-coverage-pct="drawer.diff.coveragePct"
        >
          {{ drawer.diff.metCount }} of {{ drawer.diff.totalCount }} brief items covered
          ({{ drawer.diff.coveragePct }}%)
        </p>

        <ol class="diff-items">
          <li
            v-for="entry in drawer.diff.items"
            :key="entry.item.id"
            data-testid="diff-item-row"
            :data-brief-item-id="entry.item.id"
            :data-seq="entry.item.seq"
            :data-status="entry.status"
            class="diff-item"
            :class="`status-${entry.status}`"
          >
            <div
              data-testid="diff-item-promised"
              class="promised"
            >
              {{ entry.item.instruction }}
              <span
                v-if="entry.item.origin_gap_id"
                data-testid="diff-item-origin-gap"
                class="origin-gap mono"
                :data-gap-id="entry.item.origin_gap_id"
              >closes a tracked gap</span>
            </div>
            <div
              data-testid="diff-item-delivered"
              class="delivered"
            >
              <span
                v-if="entry.delivered.length === 0"
                class="muted"
              >{{ entry.status === 'indeterminate' ? 'cannot judge yet' : 'nothing yet' }}</span>
              <span
                v-for="delivered in entry.delivered"
                :key="delivered.asset.id"
                class="delivered-chip"
                :class="delivered.provenance === 'ai' ? 'chip-ai' : 'chip-human'"
                :data-asset-id="delivered.asset.id"
                :data-provenance="delivered.provenance"
              >
                {{ delivered.asset.filename }}
                <em v-if="delivered.provenance === 'ai'">model match, unconfirmed</em>
              </span>
              <span
                v-for="claim in entry.overClaims"
                :key="`over-${claim.id}`"
                class="delivered-chip chip-ai chip-corrected"
                :data-asset-id="claim.id"
                data-provenance="ai-corrected"
              >
                {{ claim.filename }}
                <em>model claimed this, human corrected</em>
              </span>
            </div>
          </li>
        </ol>

        <section
          data-testid="diff-bucket-extras"
          class="diff-bucket"
          :data-count="drawer.diff.extras.length"
        >
          <h3>Extras: matched no brief item</h3>
          <p
            v-if="drawer.diff.extras.length === 0"
            class="muted"
          >
            None.
          </p>
          <ul>
            <li
              v-for="extra in drawer.diff.extras"
              :key="extra.id"
              data-testid="diff-extra-asset"
              :data-asset-id="extra.id"
            >
              {{ extra.filename }}
            </li>
          </ul>
        </section>

        <section
          data-testid="diff-bucket-awaiting-derivatives"
          class="diff-bucket"
          :data-count="drawer.diff.awaitingDerivatives.length"
        >
          <h3>Awaiting derivatives: no sheet, so no judgement</h3>
          <p
            v-if="drawer.diff.awaitingDerivatives.length === 0"
            class="muted"
          >
            None.
          </p>
          <ul>
            <li
              v-for="waiting in drawer.diff.awaitingDerivatives"
              :key="waiting.id"
              :data-asset-id="waiting.id"
            >
              {{ waiting.filename }}
            </li>
          </ul>
        </section>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.triage {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-4);
  max-width: 60rem;
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  margin: 0;
}

.empty {
  color: var(--muted);
}

.bucket {
  display: grid;
  gap: var(--space-2);
}

.bucket-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

h2 {
  font-size: 0.95rem;
  font-weight: 640;
  margin: 0;
}

.count {
  color: var(--muted);
  font-size: 0.78rem;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  flex-wrap: wrap;
}

.row-main {
  display: flex;
  gap: var(--space-3);
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 0.88rem;
}

.muted {
  color: var(--muted);
  font-size: 0.78rem;
}

.row-actions {
  display: flex;
  gap: var(--space-2);
}

.action {
  appearance: none;
  font: inherit;
  font-size: 0.8rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}

.action.primary {
  background: var(--human);
  border-color: var(--human);
  color: var(--surface);
}

.drawer {
  position: fixed;
  inset: 0 0 0 auto;
  width: min(560px, 100%);
  background: var(--surface);
  border-left: 1px solid var(--line);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.14);
  padding: var(--space-4);
  overflow-y: auto;
  z-index: 20;
  display: grid;
  gap: var(--space-3);
  align-content: start;
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.close {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  border-radius: var(--radius);
  font-size: 1rem;
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
}

.diff {
  display: grid;
  gap: var(--space-3);
}

.coverage {
  margin: 0;
  font-size: 0.85rem;
}

.diff-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
  counter-reset: diff;
}

.diff-item {
  display: grid;
  gap: var(--space-1);
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font-size: 0.85rem;
}

.status-met {
  border-left-color: var(--good);
}

.status-missing {
  border-left-color: var(--critical);
}

.status-indeterminate {
  border-left-color: var(--line);
}

.origin-gap {
  font-size: 0.68rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: 1px var(--space-1);
  margin-left: var(--space-1);
}

.delivered {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.delivered-chip {
  font-size: 0.75rem;
  border-radius: var(--radius);
  padding: 2px var(--space-2);
  display: inline-flex;
  gap: var(--space-1);
  align-items: baseline;
}

.delivered-chip em {
  font-style: normal;
  font-size: 0.68rem;
  opacity: 0.85;
}

.chip-ai {
  color: var(--ai);
  background: var(--ai-soft);
  border: 1px solid var(--ai-line);
}

.chip-corrected {
  text-decoration: line-through;
  opacity: 0.8;
}

.chip-corrected em {
  text-decoration: none;
}

.chip-human {
  color: var(--human);
  background: var(--human-soft);
  border: 1px solid var(--human);
}

.diff-bucket h3 {
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 var(--space-1);
}

.diff-bucket ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
  font-size: 0.8rem;
}
</style>
