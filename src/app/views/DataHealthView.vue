<script setup lang="ts">
// Data health: the standing audit. Invariant rows computed from what is on
// disk, ai_run counts by provider (the direct answer to "is any of this
// real"), the reindex queue depth, and the snapshot export and import.
import { onMounted, ref, shallowRef } from 'vue'
import type { AiRun, Asset } from '@/data/types'
import { SEED_VERSION } from '@/data/hydrate'
import { STORES } from '@/data/schema'
import { useAppStore } from '../store'
import { computeHealth, type HealthRow, type ProviderCount } from '../manager/health'

const store = useAppStore()

const rows = shallowRef<HealthRow[]>([])
const providers = shallowRef<ProviderCount[]>([])
const aiRuns = shallowRef<AiRun[]>([])
const counts = shallowRef<Record<string, number>>({})
const reindexDepth = ref(0)
const loaded = ref(false)
const importReport = ref<string | null>(null)

async function reload() {
  const repo = store.repo
  if (!repo) return
  const [assets, runs] = await Promise.all([
    repo.list<Asset>('asset'),
    repo.list<AiRun>('ai_run'),
  ])
  aiRuns.value = runs
  const outboxDepth = await repo.outboxDepth()
  const health = computeHealth({ assets, aiRuns: runs, outboxDepth })
  rows.value = health.rows
  providers.value = health.providers
  reindexDepth.value = await repo.count('reindex_queue')

  const tally: Record<string, number> = {}
  for (const name of ['asset', 'creator', 'collab', 'brief', 'brief_item', 'gap', 'tag', 'usage_event', 'search_query_log', 'consent_record', 'review_action']) {
    tally[name] = await repo.count(name as never)
  }
  counts.value = tally
  loaded.value = true
}

onMounted(reload)

/**
 * Exports every synced store as one JSON snapshot. The manager session may
 * read everything, so this is a plain repository read, not a bypass.
 */
async function exportSnapshot() {
  const repo = store.repo
  if (!repo) return
  const snapshot: Record<string, unknown[]> = {}
  for (const storeDef of STORES) {
    snapshot[storeDef.name] = await repo.list(storeDef.name).catch(() => [])
  }
  const blob = new Blob([JSON.stringify({ seed_version: SEED_VERSION, stores: snapshot }, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'astolia-snapshot.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

async function importSnapshot(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const repo = store.repo
  if (!file || !repo) return
  try {
    const parsed = JSON.parse(await file.text()) as { stores?: Record<string, Record<string, unknown>[]> }
    if (!parsed.stores) throw new Error('not a snapshot: no stores key')
    let written = 0
    for (const [name, list] of Object.entries(parsed.stores)) {
      for (const row of list) {
        // Through the repository, so scope and mirrors still apply. An import
        // is new work, not history, and it goes through the front door.
        if (typeof row.id === 'string') {
          const existing = await repo.get(name as never, row.id)
          if (existing) continue
        }
        await repo.create(name as never, row).catch(() => undefined)
        written += 1
      }
    }
    importReport.value = `Imported ${written} new row(s).`
    await reload()
  } catch (error) {
    importReport.value = `Import failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    input.value = ''
  }
}

async function resetDemo() {
  const { clearSeedMarker } = await import('@/data/hydrate')
  if (store.ctx) {
    await clearSeedMarker(store.ctx.db)
    window.location.reload()
  }
}
</script>

<template>
  <div
    data-testid="data-health-panel"
    class="health"
  >
    <h1>Data health</h1>
    <p
      data-testid="seed-version-label"
      class="mono muted"
    >
      seed {{ SEED_VERSION }}
    </p>

    <section class="rows">
      <article
        v-for="row in rows"
        :key="row.id"
        data-testid="data-health-row"
        class="row"
        :data-status="row.status"
        :data-count="row.count"
        :data-reason="row.reason ?? undefined"
      >
        <span
          class="status mono"
          :class="row.status"
        >{{ row.status }}</span>
        <span class="label">{{ row.label }}</span>
        <span class="mono count">{{ row.count }}</span>
        <span
          v-if="row.reason"
          class="reason"
        >{{ row.reason }}</span>
      </article>
    </section>

    <section class="providers">
      <h2>AI runs by provider</h2>
      <p class="muted">
        Zero live runs is the design, not a gap: no model is called at runtime
        in this build (docs/06-decisions.md U7).
      </p>
      <div class="provider-row">
        <span
          v-for="entry in providers"
          :key="entry.provider"
          class="provider mono"
          :data-provider="entry.provider"
          :data-count="entry.count"
        >{{ entry.provider }}: {{ entry.count }}</span>
      </div>
      <ul
        v-if="aiRuns.length"
        class="run-list"
      >
        <li
          v-for="run in aiRuns.slice(0, 20)"
          :key="run.id"
          data-testid="ai-run-row"
          :data-ai-run-id="run.id"
          :data-provider="run.provider"
          :data-capability="run.kind"
          :data-is-current="run.is_current"
          class="run mono"
        >
          {{ run.kind }} &middot; {{ run.provider }}
          <template v-if="run.model_id">
            &middot; {{ run.model_id }}
          </template>
        </li>
      </ul>
    </section>

    <section
      data-testid="data-health-counts"
      class="counts"
    >
      <h2>Row counts</h2>
      <div class="count-grid">
        <span
          v-for="(count, name) in counts"
          :key="name"
          class="mono"
        >{{ name }}: {{ count }}</span>
        <span
          data-testid="reindex-queue-depth"
          class="mono"
          :data-count="reindexDepth"
        >reindex_queue: {{ reindexDepth }}</span>
      </div>
    </section>

    <section class="actions">
      <button
        type="button"
        data-testid="export-snapshot"
        class="action"
        @click="exportSnapshot"
      >
        Export snapshot
      </button>
      <label
        data-testid="import-snapshot"
        class="action file"
      >
        Import snapshot
        <input
          type="file"
          accept="application/json"
          class="sr-only"
          @change="importSnapshot"
        >
      </label>
      <button
        type="button"
        data-testid="reset-demo-profile"
        class="action danger"
        @click="resetDemo"
      >
        Reset demo data
      </button>
      <span
        v-if="importReport"
        class="muted"
      >{{ importReport }}</span>
    </section>
  </div>
</template>

<style scoped>
.health {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-4);
  max-width: 50rem;
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  margin: 0;
}

h2 {
  font-size: 0.95rem;
  font-weight: 640;
  margin: 0 0 var(--space-2);
}

.muted {
  color: var(--muted);
  font-size: 0.78rem;
  margin: 0;
}

.rows {
  display: grid;
  gap: var(--space-1);
}

.row {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font-size: 0.85rem;
  flex-wrap: wrap;
}

.status {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.status.pass {
  color: var(--good);
}

.status.fail {
  color: var(--critical);
}

.label {
  flex: 1;
}

.count {
  color: var(--muted);
}

.reason {
  width: 100%;
  color: var(--critical);
  font-size: 0.75rem;
}

.provider-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.provider {
  font-size: 0.8rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-2);
  background: var(--surface);
}

.run-list {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: grid;
  gap: 2px;
  font-size: 0.72rem;
  color: var(--muted);
}

.count-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  font-size: 0.75rem;
  color: var(--muted);
}

.actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
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

.action.file {
  display: inline-block;
}

.action.danger {
  border-color: var(--critical);
  color: var(--critical);
  background: var(--surface);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
