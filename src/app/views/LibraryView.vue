<script setup lang="ts">
// The library, in its first honest form: the published grid, read through the
// scoped repository, with real posters. Search, facets, the clip sheet and the
// zero-result ladder land in the editor surface task; what exists now already
// proves the wiring, because everything on screen came through a session that
// is only allowed to see published, approved work.
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../store'
import type { Asset } from '@/data/types'

const store = useAppStore()
const assets = ref<Asset[]>([])
const loaded = ref(false)

onMounted(async () => {
  const repo = store.repo
  if (!repo) return
  // The editor session's scope predicate already restricts this to published,
  // approved work; nothing here re-filters, because a view-level filter would
  // hide a scope bug instead of failing on it.
  const rows = await repo.list<Asset>('asset')
  // UUIDv7 ids sort in creation order, so this is deterministic without a
  // ranking layer. Ranking arrives with search.
  assets.value = rows.slice().sort((a, b) => (a.id < b.id ? 1 : -1))
  loaded.value = true
})

const count = computed(() => assets.value.length)

function duration(asset: Asset): string {
  const total = Math.round(asset.duration_s ?? 0)
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}
</script>

<template>
  <section
    data-testid="library"
    class="library"
  >
    <header class="library-head">
      <h1>Library</h1>
      <p
        v-if="loaded"
        data-testid="library-result-count"
        :data-count="count"
        class="count mono"
      >
        {{ count }} published clips
      </p>
    </header>

    <div
      v-if="loaded"
      data-testid="library-result-grid"
      class="grid"
    >
      <article
        v-for="(asset, index) in assets"
        :key="asset.id"
        data-testid="result-tile"
        :data-asset-id="asset.id"
        :data-rank="index + 1"
        :data-provenance="asset.ai_provenance ?? 'none'"
        class="tile"
      >
        <img
          v-if="asset.poster_key"
          data-testid="result-tile-poster"
          class="poster"
          :src="asset.poster_key"
          :alt="asset.ai_description ?? asset.filename"
        >
        <div
          v-else
          class="poster poster-absent"
          aria-hidden="true"
        />
        <footer class="tile-meta">
          <span
            data-testid="result-tile-duration"
            class="mono"
          >{{ duration(asset) }}</span>
          <span
            v-if="asset.creator_credit"
            data-testid="result-tile-creator-credit"
            class="credit"
          >{{ asset.creator_credit }}</span>
        </footer>
      </article>
    </div>

    <p class="note">
      Search, facets and the clip sheet land with the editor surface. This grid is
      already real: every tile came through the editor scope, so unpublished and
      unapproved clips cannot appear here.
    </p>
  </section>
</template>

<style scoped>
.library {
  padding: var(--space-5) var(--space-4);
}

.library-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  letter-spacing: -0.01em;
  margin: 0;
}

.count {
  color: var(--muted);
  font-size: 0.78rem;
  margin: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: var(--space-3);
}

.tile {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

.poster {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  background: var(--surface-2);
}

.poster-absent {
  /* A grey tile, never a broken image element. */
  width: 100%;
  aspect-ratio: 3 / 4;
  background: var(--surface-2);
}

.tile-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  font-size: 0.72rem;
  color: var(--muted);
}

.credit {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note {
  color: var(--muted);
  max-width: 62ch;
  font-size: 0.85rem;
  margin: var(--space-5) 0 0;
}
</style>
