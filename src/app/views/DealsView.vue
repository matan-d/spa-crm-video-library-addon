<script setup lang="ts">
// The collab kanban. Built after the inbox on purpose: the kanban demos well
// but the inbox is where daily work happens, and the build order says which
// one the product believes in. Cards are read-only in this pass; stage moves
// come with the loop work, where a stage change has consequences.
import { computed, onMounted, ref, shallowRef } from 'vue'
import type { Branch, Collab, CollabStage, Creator } from '@/data/types'
import { useAppStore } from '../store'

const store = useAppStore()

const collabs = shallowRef<Collab[]>([])
const creators = shallowRef<Map<string, Creator>>(new Map())
const branches = shallowRef<Map<string, Branch>>(new Map())
const loaded = ref(false)

onMounted(async () => {
  const repo = store.repo
  if (!repo) return
  // A manager-only surface. On a role switch the tree remounts before the
  // router's redirect settles, so for one tick this view can hold a session
  // that may not read these stores. Asking anyway throws a ScopeError out of
  // onMounted, which is the scope layer working and the caller misbehaving.
  if (store.session?.kind !== 'manager') return
  collabs.value = await repo.list<Collab>('collab')
  creators.value = new Map((await repo.list<Creator>('creator')).map((row) => [row.id, row]))
  branches.value = new Map((await repo.list<Branch>('branch')).map((row) => [row.id, row]))
  loaded.value = true
})

const STAGES: CollabStage[] = ['source', 'vet', 'book', 'brief', 'visit', 'delivered', 'library']

const byStage = computed(() => {
  const groups = new Map<CollabStage, Collab[]>()
  for (const stage of STAGES) groups.set(stage, [])
  for (const collab of collabs.value) {
    groups.get(collab.stage)?.push(collab)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.stage_entered_at - a.stage_entered_at)
  }
  return groups
})

function creatorName(collab: Collab): string {
  return creators.value.get(collab.creator_id)?.display_name ?? 'Unknown'
}

function branchName(collab: Collab): string {
  return branches.value.get(collab.branch_id)?.name ?? ''
}

function visitLabel(collab: Collab): string {
  if (collab.visit_at == null) return ''
  return new Date(collab.visit_at).toISOString().slice(0, 10)
}
</script>

<template>
  <div
    data-testid="deals-board"
    class="deals"
  >
    <h1>Deals</h1>
    <div
      v-if="loaded"
      class="board"
    >
      <section
        v-for="stage in STAGES"
        :key="stage"
        class="column"
        :data-stage="stage"
      >
        <header class="column-head">
          <h2>{{ stage }}</h2>
          <span class="mono count">{{ byStage.get(stage)!.length }}</span>
        </header>
        <ul class="cards">
          <li
            v-for="collab in byStage.get(stage)"
            :key="collab.id"
            class="card"
            :data-collab-id="collab.id"
            :data-outcome="collab.outcome"
            :class="{ ghosted: collab.outcome === 'ghosted' }"
          >
            <span class="card-name">{{ creatorName(collab) }}</span>
            <span class="card-meta">{{ branchName(collab) }}</span>
            <span
              v-if="visitLabel(collab)"
              class="card-meta mono"
            >{{ visitLabel(collab) }}</span>
            <span
              v-if="collab.outcome !== 'open'"
              class="card-outcome mono"
            >{{ collab.outcome }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.deals {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  margin: 0;
}

.board {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(180px, 1fr);
  gap: var(--space-3);
  overflow-x: auto;
  padding-bottom: var(--space-2);
}

.column {
  display: grid;
  gap: var(--space-2);
  align-content: start;
}

.column-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

h2 {
  font-size: 0.78rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0;
}

.count {
  color: var(--muted);
  font-size: 0.72rem;
}

.cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  display: grid;
  gap: 2px;
  font-size: 0.82rem;
}

.card.ghosted {
  opacity: 0.6;
}

.card-name {
  font-weight: 620;
}

.card-meta {
  color: var(--muted);
  font-size: 0.72rem;
}

.card-outcome {
  color: var(--warn);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
</style>
