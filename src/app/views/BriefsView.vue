<script setup lang="ts">
// Briefs: where gaps become a shot list. Generation writes origin_gap_id on
// every generated item, the lock freezes what the creator is asked for, and a
// locked brief mints the token link the creator run opens. The raw token is
// shown once and only its hash is stored, exactly like production.
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import type { Brief, BriefItem, Collab, Creator } from '@/data/types'
import { sha256Hex } from '@/platform/hash'
import { useAppStore } from '../store'
import { generateBriefFromGaps, lockBrief } from '../loop/loop'

const store = useAppStore()
const route = useRoute()

const briefs = shallowRef<Brief[]>([])
const itemsByBrief = shallowRef<Map<string, BriefItem[]>>(new Map())
const collabs = shallowRef<Collab[]>([])
const creators = shallowRef<Map<string, Creator>>(new Map())
const selectedCollabId = ref<string | null>(null)
const inviteLinks = ref<Map<string, string>>(new Map())
const loaded = ref(false)

async function reload() {
  const repo = store.repo
  if (!repo) return
  // A manager-only surface. On a role switch the tree remounts before the
  // router's redirect settles, so for one tick this view can hold a session
  // that may not read these stores. Asking anyway throws a ScopeError out of
  // onMounted, which is the scope layer working and the caller misbehaving.
  if (store.session?.kind !== 'manager') return
  briefs.value = (await repo.list<Brief>('brief')).sort((a, b) => b.id.localeCompare(a.id))
  const allItems = await repo.list<BriefItem>('brief_item')
  const grouped = new Map<string, BriefItem[]>()
  for (const item of allItems) {
    const list = grouped.get(item.brief_id) ?? []
    list.push(item)
    grouped.set(item.brief_id, list)
  }
  for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq)
  itemsByBrief.value = grouped
  collabs.value = (await repo.list<Collab>('collab')).filter(
    (collab) => collab.outcome === 'open',
  )
  creators.value = new Map((await repo.list<Creator>('creator')).map((row) => [row.id, row]))
  if (!selectedCollabId.value) {
    selectedCollabId.value =
      collabs.value.find((collab) => collab.stage === 'brief')?.id ?? collabs.value[0]?.id ?? null
  }
  loaded.value = true
}

onMounted(reload)

const focusGapId = computed(() => (route.query.gap ? String(route.query.gap) : null))

function collabLabel(collab: Collab): string {
  const creator = creators.value.get(collab.creator_id)
  return `${creator?.display_name ?? 'Unknown'} (${collab.stage})`
}

async function generate() {
  const repo = store.repo
  if (!repo || !selectedCollabId.value) return
  await generateBriefFromGaps({
    repo,
    collabId: selectedCollabId.value,
    scanId: null,
  })
  await reload()
}

async function lock(brief: Brief) {
  const repo = store.repo
  const clock = store.ctx?.clock
  if (!repo || !clock) return
  await lockBrief(repo, brief.id, clock.now())
  await reload()
}

async function addItem(brief: Brief) {
  const repo = store.repo
  if (!repo) return
  const existing = itemsByBrief.value.get(brief.id) ?? []
  await repo.create('brief_item', {
    brief_id: brief.id,
    seq: existing.length + 1,
    instruction: 'New shot, edit me',
    shot_type: null,
    room: null,
    min_takes: 2,
    origin_gap_id: null,
  })
  await reload()
}

/**
 * Mints a real invite token: the raw value is shown once, only its sha256 is
 * stored, and the link resolves through the same lookup production uses.
 */
async function mintInvite(brief: Brief) {
  const repo = store.repo
  const clock = store.ctx?.clock
  const newId = store.ctx?.newId
  if (!repo || !clock || !newId) return
  const rawToken = `invite-${newId()}`
  const hash = await sha256Hex(rawToken)
  await repo.create('access_token', {
    collab_id: brief.collab_id,
    token_hash: hash,
    purpose: 'upload',
    expires_at: clock.now() + 14 * 86_400_000,
    revoked_at: null,
  })
  const next = new Map(inviteLinks.value)
  next.set(brief.id, rawToken)
  inviteLinks.value = next
}

async function copyInvite(brief: Brief) {
  const raw = inviteLinks.value.get(brief.id)
  if (!raw) return
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/#/c/${raw}`)
  } catch {
    // Clipboard can be blocked; the link stays visible for manual copy.
  }
}
</script>

<template>
  <div
    data-testid="brief"
    class="briefs"
  >
    <header class="head">
      <h1>Briefs</h1>
      <label class="pick">
        <span>Collab</span>
        <select v-model="selectedCollabId">
          <option
            v-for="collab in collabs"
            :key="collab.id"
            :value="collab.id"
          >
            {{ collabLabel(collab) }}
          </option>
        </select>
      </label>
      <!-- Disabled until there is actually a collab to generate for. A button
           that silently does nothing because the page had not finished loading
           is indistinguishable from a broken feature. -->
      <button
        type="button"
        data-testid="brief-generate-from-gaps"
        class="action primary"
        :disabled="!loaded || !selectedCollabId"
        @click="generate"
      >
        Generate from gaps
      </button>
    </header>

    <p
      v-if="focusGapId"
      class="focus mono"
      :data-gap-id="focusGapId"
    >
      Fed from gap {{ focusGapId }}: generation ranks open gaps by score, so it
      is included when it is still open.
    </p>

    <article
      v-for="brief in briefs"
      :key="brief.id"
      class="brief-card"
    >
      <header
        data-testid="brief-header"
        class="brief-head"
        :data-brief-id="brief.id"
        :data-gap-scan-id="brief.gap_scan_id ?? undefined"
        :data-status="brief.status"
      >
        <span class="brief-name mono">{{ brief.id.slice(0, 14) }}&hellip;</span>
        <span class="muted">{{ collabLabel(collabs.find((c) => c.id === brief.collab_id) ?? ({} as Collab)) }}</span>
        <span
          v-if="brief.status === 'locked'"
          data-testid="brief-locked-badge"
          class="locked mono"
        >locked</span>
        <button
          v-else
          type="button"
          data-testid="brief-lock"
          class="action"
          @click="lock(brief)"
        >
          Lock
        </button>
      </header>

      <ol class="items">
        <li
          v-for="item in itemsByBrief.get(brief.id) ?? []"
          :key="item.id"
          data-testid="brief-item-row"
          :data-brief-item-id="item.id"
          :data-seq="item.seq"
          :data-origin-gap-id="item.origin_gap_id ?? undefined"
          class="item"
        >
          {{ item.instruction }}
          <span
            v-if="item.origin_gap_id"
            class="origin mono"
          >from gap</span>
        </li>
      </ol>

      <footer class="brief-actions">
        <button
          v-if="brief.status !== 'locked'"
          type="button"
          data-testid="brief-item-add"
          class="action quiet"
          @click="addItem(brief)"
        >
          Add item
        </button>
        <template v-if="brief.status === 'locked'">
          <button
            v-if="!inviteLinks.get(brief.id)"
            type="button"
            class="action"
            @click="mintInvite(brief)"
          >
            Create invite link
          </button>
          <span
            v-else
            data-testid="brief-invite-link"
            class="invite mono"
            :data-token="inviteLinks.get(brief.id)"
          >/#/c/{{ inviteLinks.get(brief.id) }}</span>
          <button
            v-if="inviteLinks.get(brief.id)"
            type="button"
            data-testid="brief-invite-copy"
            class="action quiet"
            @click="copyInvite(brief)"
          >
            Copy
          </button>
        </template>
      </footer>
    </article>
  </div>
</template>

<style scoped>
.briefs {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
  max-width: 54rem;
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

.pick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 0.8rem;
  color: var(--muted);
}

select {
  font: inherit;
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
}

.focus {
  margin: 0;
  font-size: 0.75rem;
  color: var(--muted);
}

.brief-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-3);
  display: grid;
  gap: var(--space-2);
}

.brief-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.brief-name {
  font-size: 0.75rem;
  color: var(--muted);
}

.muted {
  color: var(--muted);
  font-size: 0.8rem;
}

.locked {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: 1px var(--space-1);
}

.items {
  margin: 0;
  padding-left: 1.4rem;
  display: grid;
  gap: var(--space-1);
  font-size: 0.85rem;
}

.origin {
  font-size: 0.66rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: 1px var(--space-1);
  margin-left: var(--space-1);
}

.brief-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
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

.action.primary {
  background: var(--human);
  border-color: var(--human);
  color: var(--surface);
}

.action:disabled {
  background: var(--surface-2);
  border-color: var(--line);
  color: var(--muted);
  cursor: not-allowed;
}

.action.quiet {
  background: var(--surface);
  color: var(--muted);
}

.invite {
  font-size: 0.75rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-2);
  overflow-wrap: anywhere;
}
</style>
