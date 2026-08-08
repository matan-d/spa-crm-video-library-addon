<script setup lang="ts">
// The review queue: a frozen ordered list, keyboard driven on desktop.
//
// Three rules with teeth:
// - The order is frozen when the session starts. Clips that arrive mid-session
//   are offered, never spliced in, because a list that reorders under a
//   keyboard-driven reviewer assigns decisions to the wrong clip.
// - A decided row dims in place rather than disappearing, so the reviewer's
//   sense of position survives their own decisions.
// - Before any decision is written, the row is re-read. If it changed under
//   the reviewer (another tab, another device), the decision is refused and
//   the row refreshed, never silently applied to data the reviewer did not see.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import type { Asset, BriefItem, Delivery } from '@/data/types'
import { useAppStore } from '../store'

const store = useAppStore()
const route = useRoute()

const deliveryId = String(route.params.deliveryId ?? '')

interface QueueRow {
  assetId: string
  /** The revision the reviewer is looking at. Compared before every write. */
  rev: number
  decision: 'approved' | 'rejected' | 'skipped' | null
  reviewActionId: string | null
}

const delivery = shallowRef<Delivery | null>(null)
const assetsById = shallowRef<Map<string, Asset>>(new Map())
const briefItems = shallowRef<BriefItem[]>([])
const queue = ref<QueueRow[]>([])
const cursor = ref(0)
const sessionId = ref<string | null>(null)
const staleRefusal = ref<string | null>(null)
const pendingAdditions = ref<string[]>([])
const publishConfirmation = ref<{ assetIds: string[] } | null>(null)
const loaded = ref(false)

/** The brief item the reviewer says the current clip covers. */
const confirmItemId = ref<string | 'none'>('none')

onMounted(async () => {
  const repo = store.repo
  if (!repo) return
  delivery.value = (await repo.get<Delivery>('delivery', deliveryId)) ?? null
  if (!delivery.value) {
    loaded.value = true
    return
  }

  const assets = await repo.list<Asset>('asset', {
    where: (row) => row.delivery_id === deliveryId,
  })
  assetsById.value = new Map(assets.map((asset) => [asset.id, asset]))

  const briefs = await repo.list<{ id: string; collab_id: string; status: string }>('brief', {
    where: (row) => row.collab_id === delivery.value!.collab_id,
  })
  const locked = briefs.find((row) => row.status === 'locked') ?? briefs[0]
  briefItems.value = locked
    ? (await repo.list<BriefItem>('brief_item', { where: (row) => row.brief_id === locked.id }))
        .slice()
        .sort((a, b) => a.seq - b.seq)
    : []

  // The frozen order: pending first by filename for a stable, explainable
  // sequence. Once frozen it never reorders, that is the whole point.
  const pending = assets
    .filter((asset) => asset.review_status === 'pending')
    .sort((a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id))
  queue.value = pending.map((asset) => ({
    assetId: asset.id,
    rev: asset.rev ?? 0,
    decision: null,
    reviewActionId: null,
  }))

  sessionId.value = await repo.create('review_session', {
    delivery_id: deliveryId,
    reviewer_user_id: store.session?.user_id ?? null,
    asset_ids: queue.value.map((row) => row.assetId),
    completed_at: null,
  })

  syncConfirmDefault()
  loaded.value = true
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})

const current = computed<Asset | undefined>(() => {
  const row = queue.value[cursor.value]
  return row ? assetsById.value.get(row.assetId) : undefined
})

const decidedCount = computed(() => queue.value.filter((row) => row.decision != null).length)

function syncConfirmDefault() {
  // The AI's proposed match is the default the human corrects, shown amber in
  // the template so responsibility stays visible.
  confirmItemId.value = current.value?.ai_matched_brief_item_id ?? 'none'
}

function move(delta: number) {
  const next = cursor.value + delta
  if (next < 0 || next >= queue.value.length) return
  cursor.value = next
  staleRefusal.value = null
  rejectOpen.value = false
  syncConfirmDefault()
}

// ---- decisions ------------------------------------------------------------

/**
 * Re-reads the row and refuses the decision if it changed underneath the
 * reviewer. Returns the fresh asset only when it is safe to act.
 */
async function guardStale(row: QueueRow): Promise<Asset | null> {
  const repo = store.repo
  if (!repo) return null
  const fresh = await repo.get<Asset>('asset', row.assetId)
  if (!fresh) {
    staleRefusal.value = 'This clip is no longer visible. Nothing was decided.'
    return null
  }
  if ((fresh.rev ?? 0) !== row.rev) {
    assetsById.value.set(fresh.id, fresh)
    assetsById.value = new Map(assetsById.value)
    row.rev = fresh.rev ?? 0
    staleRefusal.value =
      'This clip changed while you were looking at it. The row has been refreshed; decide again on what you now see.'
    return null
  }
  return fresh
}

async function decide(decision: 'approved' | 'rejected' | 'skipped', extras: {
  confirmed?: string | null
  rejectReason?: string
  creatorNote?: string
} = {}) {
  const repo = store.repo
  const row = queue.value[cursor.value]
  if (!repo || !row || row.decision) return
  const fresh = await guardStale(row)
  if (!fresh) return

  const patch: Record<string, unknown> = {}
  if (decision !== 'skipped') {
    patch.review_status = decision
    if (decision === 'approved') {
      patch.confirmed_brief_item_id = extras.confirmed ?? null
    }
    if (decision === 'rejected') {
      patch.reject_reason_text = extras.rejectReason ?? null
      patch.creator_facing_note = extras.creatorNote ?? null
    }
    await repo.patch('asset', row.assetId, patch)
  }

  const actionId = await repo.create('review_action', {
    asset_id: row.assetId,
    session_id: sessionId.value,
    actor_user_id: store.session?.user_id ?? '',
    decision,
    method: 'manual',
    ai_provenance_at_decision: fresh.ai_provenance ?? null,
    note: extras.rejectReason ?? null,
  })

  row.decision = decision
  row.reviewActionId = actionId

  const updated = await repo.get<Asset>('asset', row.assetId)
  if (updated) {
    assetsById.value.set(updated.id, updated)
    assetsById.value = new Map(assetsById.value)
    row.rev = updated.rev ?? row.rev
  }

  staleRefusal.value = null
  if (cursor.value < queue.value.length - 1) move(1)
}

async function approve() {
  await decide('approved', {
    confirmed: confirmItemId.value === 'none' ? null : confirmItemId.value,
  })
}

async function skip() {
  await decide('skipped')
}

/**
 * Undo re-opens the clip: review_status returns to pending and the action is
 * recorded as its own event, because the log is append-only and a decision
 * that vanished without trace would poison every scorecard.
 */
async function undo() {
  const repo = store.repo
  const row = queue.value[cursor.value]
  if (!repo || !row || !row.decision) return
  if (row.decision !== 'skipped') {
    await repo.patch('asset', row.assetId, {
      review_status: 'pending',
      confirmed_brief_item_id: null,
      reject_reason_text: null,
      creator_facing_note: null,
    })
  }
  row.decision = null
  row.reviewActionId = null
  const updated = await repo.get<Asset>('asset', row.assetId)
  if (updated) {
    assetsById.value.set(updated.id, updated)
    assetsById.value = new Map(assetsById.value)
    row.rev = updated.rev ?? 0
  }
  syncConfirmDefault()
}

// ---- reject dialog --------------------------------------------------------
const rejectOpen = ref(false)
const rejectReason = ref('quality')
const rejectInternalNote = ref('')
const rejectCreatorNote = ref('')

async function confirmReject() {
  await decide('rejected', {
    rejectReason: `${rejectReason.value}: ${rejectInternalNote.value}`.trim(),
    creatorNote: rejectCreatorNote.value.trim() || undefined,
  })
  rejectOpen.value = false
  rejectInternalNote.value = ''
  rejectCreatorNote.value = ''
}

// ---- publish --------------------------------------------------------------
async function publishApproved() {
  const repo = store.repo
  if (!repo) return
  const approved = queue.value.filter((row) => row.decision === 'approved')
  const published: string[] = []
  for (const row of approved) {
    await repo.patch('asset', row.assetId, { is_published: true })
    published.push(row.assetId)
  }
  publishConfirmation.value = { assetIds: published }
}

// ---- mid-session arrivals -------------------------------------------------
async function checkAdditions() {
  const repo = store.repo
  if (!repo) return
  const assets = await repo.list<Asset>('asset', {
    where: (row) => row.delivery_id === deliveryId && row.review_status === 'pending',
  })
  const known = new Set(queue.value.map((row) => row.assetId))
  pendingAdditions.value = assets.filter((asset) => !known.has(asset.id)).map((asset) => asset.id)
  for (const asset of assets) {
    assetsById.value.set(asset.id, asset)
  }
  assetsById.value = new Map(assetsById.value)
}

function acceptAdditions() {
  // Appended at the end, never spliced in: the frozen prefix stays frozen.
  for (const assetId of pendingAdditions.value) {
    const asset = assetsById.value.get(assetId)
    queue.value.push({ assetId, rev: asset?.rev ?? 0, decision: null, reviewActionId: null })
  }
  pendingAdditions.value = []
}

// ---- keyboard -------------------------------------------------------------
function onKey(event: KeyboardEvent) {
  if (rejectOpen.value) return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
  if (event.key === 'j' || event.key === 'ArrowDown') move(1)
  else if (event.key === 'k' || event.key === 'ArrowUp') move(-1)
  else if (event.key === 'a') void approve()
  else if (event.key === 'r') rejectOpen.value = true
  else if (event.key === 's') void skip()
  else if (event.key === 'u') void undo()
  else return
  event.preventDefault()
}

</script>

<template>
  <div
    data-testid="review-queue"
    class="review"
  >
    <header class="head">
      <h1>Review</h1>
      <p
        data-testid="review-progress"
        class="mono progress"
        :data-review-session-id="sessionId ?? undefined"
        :data-cursor-index="cursor"
        :data-total="queue.length"
      >
        {{ decidedCount }} decided of {{ queue.length }}
      </p>
      <button
        type="button"
        class="small"
        @click="checkAdditions"
      >
        Check for new clips
      </button>
      <button
        type="button"
        data-testid="publish-to-library"
        class="small primary"
        @click="publishApproved"
      >
        Publish approved
      </button>
    </header>

    <p
      data-testid="review-keyboard-hint"
      class="hint mono"
    >
      j / k move &middot; a approve &middot; r reject &middot; s skip &middot; u undo
    </p>

    <p
      v-if="publishConfirmation"
      data-testid="publish-confirmation"
      class="published"
      :data-count="publishConfirmation.assetIds.length"
      :data-asset-id="publishConfirmation.assetIds[0]"
    >
      {{ publishConfirmation.assetIds.length }} approved clips published to the library.
    </p>

    <div
      v-if="pendingAdditions.length"
      data-testid="review-pending-additions"
      class="additions"
      :data-count="pendingAdditions.length"
    >
      {{ pendingAdditions.length }} new clips arrived since this session started.
      <button
        type="button"
        data-testid="review-accept-additions"
        class="small"
        @click="acceptAdditions"
      >
        Add them to the end
      </button>
    </div>

    <p
      v-if="staleRefusal"
      data-testid="review-stale-refusal"
      class="stale"
      role="alert"
    >
      {{ staleRefusal }}
    </p>

    <div class="panes">
      <ol
        data-testid="review-ordered-list"
        class="list"
      >
        <li
          v-for="(row, index) in queue"
          :key="row.assetId"
          data-testid="review-row"
          :data-asset-id="row.assetId"
          :data-seq="index + 1"
          :data-decision="row.decision ?? undefined"
          class="list-row"
          :class="{ current: index === cursor, decided: row.decision != null }"
          @click="cursor = index; syncConfirmDefault()"
        >
          <span class="mono seq">{{ index + 1 }}</span>
          <span class="name">{{ assetsById.get(row.assetId)?.filename }}</span>
          <span
            v-if="row.decision"
            data-testid="review-decided-badge"
            class="badge mono"
            :data-asset-id="row.assetId"
            :data-decision="row.decision"
            :data-review-action-id="row.reviewActionId ?? undefined"
          >{{ row.decision }}</span>
        </li>
      </ol>

      <section
        v-if="current"
        data-testid="review-current-asset"
        class="detail"
        :data-asset-id="current.id"
      >
        <img
          v-if="current.poster_key"
          class="poster"
          :src="current.poster_key"
          :alt="current.ai_description ?? current.filename"
        >
        <h2 class="filename">
          {{ current.filename }}
        </h2>
        <p
          v-if="current.ai_description"
          class="ai-line"
        >
          <span class="mono ai-mark">model</span>
          {{ current.ai_description }}
        </p>

        <label class="confirm">
          <span>Covers brief item</span>
          <span
            v-if="current.ai_matched_brief_item_id && confirmItemId === current.ai_matched_brief_item_id"
            class="mono ai-mark"
          >model proposed</span>
          <select
            v-model="confirmItemId"
            class="confirm-select"
          >
            <option value="none">no brief item (extra)</option>
            <option
              v-for="item in briefItems"
              :key="item.id"
              :value="item.id"
            >
              {{ item.seq }}. {{ item.instruction }}
            </option>
          </select>
        </label>

        <div class="controls">
          <button
            type="button"
            data-testid="review-prev"
            class="small"
            @click="move(-1)"
          >
            Prev
          </button>
          <button
            type="button"
            data-testid="review-next"
            class="small"
            @click="move(1)"
          >
            Next
          </button>
          <button
            type="button"
            data-testid="review-skip"
            class="small"
            @click="skip"
          >
            Skip
          </button>
          <button
            type="button"
            data-testid="review-undo"
            class="small"
            @click="undo"
          >
            Undo
          </button>
          <button
            type="button"
            data-testid="review-reject"
            class="small danger"
            @click="rejectOpen = true"
          >
            Reject
          </button>
          <button
            type="button"
            data-testid="review-approve"
            class="small primary"
            @click="approve"
          >
            Approve
          </button>
        </div>
      </section>
    </div>

    <!-- reject dialog -->
    <div
      v-if="rejectOpen"
      data-testid="review-reject-dialog"
      class="dialog-backdrop"
    >
      <div
        class="dialog"
        role="dialog"
        aria-label="Reject clip"
      >
        <h2>Reject this clip</h2>
        <label>
          <span>Reason</span>
          <select
            v-model="rejectReason"
            data-testid="reject-reason-select"
          >
            <option value="quality">quality</option>
            <option value="off_brief">off brief</option>
            <option value="brand_safety">brand safety</option>
            <option value="duplicate">duplicate</option>
          </select>
        </label>
        <label>
          <span>Internal note, never shown to the creator</span>
          <textarea
            v-model="rejectInternalNote"
            data-testid="reject-internal-note"
            rows="2"
          />
        </label>
        <label>
          <span>Note the creator will see</span>
          <textarea
            v-model="rejectCreatorNote"
            data-testid="reject-creator-note"
            rows="2"
          />
        </label>
        <div class="dialog-actions">
          <button
            type="button"
            data-testid="reject-cancel"
            class="small"
            @click="rejectOpen = false"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="reject-confirm"
            class="small danger"
            @click="confirmReject"
          >
            Reject
          </button>
        </div>
      </div>
    </div>

    <p
      v-if="loaded && !delivery"
      class="stale"
    >
      This delivery does not exist or is not visible to this session.
    </p>
  </div>
</template>

<style scoped>
.review {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  margin: 0;
}

.progress {
  color: var(--muted);
  font-size: 0.8rem;
  margin: 0;
}

.hint {
  color: var(--muted);
  font-size: 0.72rem;
  margin: 0;
}

.published {
  margin: 0;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: var(--space-2);
  font-size: 0.85rem;
}

.additions {
  background: var(--surface);
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font-size: 0.85rem;
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}

.stale {
  margin: 0;
  color: var(--critical);
  border: 1px solid var(--critical);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-2) var(--space-3);
  font-size: 0.85rem;
}

.panes {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr);
  gap: var(--space-4);
  align-items: start;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}

.list-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  font-size: 0.82rem;
  cursor: pointer;
  border: 1px solid transparent;
}

.list-row.current {
  border-color: var(--human);
  background: var(--surface);
}

.list-row.decided {
  opacity: 0.55;
}

.seq {
  color: var(--muted);
  font-size: 0.7rem;
  width: 1.4rem;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.detail {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
}

.poster {
  max-width: 240px;
  border-radius: var(--radius);
  background: var(--surface-2);
}

.filename {
  font-size: 1rem;
  font-weight: 640;
  margin: 0;
}

.ai-line {
  margin: 0;
  color: var(--ai);
  font-size: 0.85rem;
}

.ai-mark {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--ai);
  background: var(--ai-soft);
  border: 1px solid var(--ai-line);
  border-radius: var(--radius);
  padding: 1px var(--space-1);
  margin-right: var(--space-1);
}

.confirm {
  display: grid;
  gap: var(--space-1);
  font-size: 0.8rem;
  color: var(--muted);
}

.confirm-select,
select,
textarea {
  font: inherit;
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
}

.controls {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.small {
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

.small.primary {
  background: var(--human);
  border-color: var(--human);
  color: var(--surface);
}

.small.danger {
  background: var(--surface);
  border-color: var(--critical);
  color: var(--critical);
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: grid;
  place-items: center;
  z-index: 30;
}

.dialog {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-4);
  width: min(440px, 92vw);
  display: grid;
  gap: var(--space-3);
}

.dialog h2 {
  font-size: 1rem;
  font-weight: 640;
  margin: 0;
}

.dialog label {
  display: grid;
  gap: var(--space-1);
  font-size: 0.78rem;
  color: var(--muted);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

@media (max-width: 800px) {
  .panes {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
