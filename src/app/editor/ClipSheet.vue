<script setup lang="ts">
// The clip sheet: everything the editor may know about one clip, split by who
// is responsible for each claim. Neutral facts are measured, amber is a model,
// deep green is a human. The tenancy run asserts no creator or collab field is
// present on this surface at all, which is enforced upstream by the editor
// projection rather than by this component being careful.
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../store'
import type { Asset, Tag } from '@/data/types'

const props = defineProps<{
  asset: Asset
  rank: number
}>()

const emit = defineEmits<{
  close: []
  addToBin: [asset: Asset, rank: number]
  download: [asset: Asset, rank: number]
}>()

const store = useAppStore()
const tags = ref<Tag[]>([])
const usedCount = ref<number | null>(null)

onMounted(async () => {
  const repo = store.repo
  if (!repo) return
  tags.value = await repo.list<Tag>('tag', {
    where: (row) => row.asset_id === props.asset.id && row.removed_at == null,
  })
  usedCount.value = await repo.count('usage_event', {
    where: (row) => row.asset_id === props.asset.id,
  })
})

const aiTags = computed(() =>
  tags.value.filter((tag) => tag.source === 'ai' && !tag.rejected_by_human),
)
const humanTags = computed(() => tags.value.filter((tag) => tag.source === 'human'))

/** The badge reads provenance off the asset, never the current mode (see CLAUDE.md). */
const simulated = computed(() => props.asset.ai_provenance === 'mock')

function fact(value: unknown, unit = ''): string {
  if (value == null || value === '') return 'unknown'
  return `${value}${unit}`
}
</script>

<template>
  <aside
    data-testid="clip-sheet"
    class="sheet"
    :data-asset-id="asset.id"
    aria-label="Clip details"
  >
    <header class="sheet-head">
      <h2 class="sheet-title">
        {{ asset.filename }}
      </h2>
      <button
        type="button"
        data-testid="clip-sheet-close"
        class="close"
        aria-label="Close"
        @click="emit('close')"
      >
        &times;
      </button>
    </header>

    <img
      v-if="asset.poster_key"
      data-testid="clip-sheet-poster"
      class="poster"
      :src="asset.poster_key"
      :alt="asset.ai_description ?? asset.filename"
    >

    <p
      v-if="asset.ai_description"
      class="description ai-claim"
    >
      <span
        v-if="simulated"
        data-testid="simulated-badge"
        class="simulated mono"
        :data-provenance="asset.ai_provenance"
      >simulated</span>
      {{ asset.ai_description }}
    </p>

    <section
      v-if="asset.sheet_key"
      class="contact"
    >
      <h3>Contact sheet</h3>
      <img
        data-testid="clip-sheet-contact-sheet"
        class="contact-img"
        :src="asset.sheet_key"
        :alt="`Contact sheet for ${asset.filename}`"
      >
    </section>

    <section
      data-testid="clip-sheet-facts"
      class="facts"
    >
      <h3>Measured</h3>
      <dl>
        <div class="fact">
          <dt>Duration</dt>
          <dd>{{ fact(asset.duration_s, 's') }}</dd>
        </div>
        <div class="fact">
          <dt>Coded size</dt>
          <dd>{{ fact(asset.coded_width) }} &times; {{ fact(asset.coded_height) }}</dd>
        </div>
        <div class="fact">
          <dt>Codec</dt>
          <dd>{{ fact(asset.codec_video) }}</dd>
        </div>
        <div class="fact">
          <dt>Captured</dt>
          <dd>
            {{ asset.captured_at ? new Date(asset.captured_at).toISOString().slice(0, 10) : 'unknown' }}
            <span
              v-if="asset.captured_at_source"
              data-testid="capture-date-source"
              class="source mono"
              :data-captured-at-source="asset.captured_at_source"
            >{{ asset.captured_at_source }}</span>
          </dd>
        </div>
      </dl>
    </section>

    <section class="tag-groups">
      <div
        data-testid="clip-sheet-tags-ai"
        class="tag-group"
      >
        <h3 class="ai-heading">
          Model suggested
        </h3>
        <ul>
          <li
            v-for="tag in aiTags"
            :key="tag.id"
            data-testid="clip-sheet-tag"
            :data-provenance="'ai'"
            class="tag tag-ai"
          >
            {{ tag.term }}
          </li>
        </ul>
      </div>
      <div
        data-testid="clip-sheet-tags-human"
        class="tag-group"
      >
        <h3 class="human-heading">
          Human confirmed
        </h3>
        <ul>
          <li
            v-for="tag in humanTags"
            :key="tag.id"
            data-testid="clip-sheet-tag"
            :data-provenance="'human'"
            class="tag tag-human"
          >
            {{ tag.term }}
          </li>
        </ul>
      </div>
    </section>

    <p
      v-if="asset.creator_credit"
      data-testid="clip-sheet-creator-credit"
      class="credit"
    >
      {{ asset.creator_credit }}
    </p>

    <p
      v-if="usedCount != null"
      data-testid="clip-sheet-used-in"
      class="used mono"
      :data-count="usedCount"
    >
      {{ usedCount }} recorded uses
    </p>

    <footer class="actions">
      <button
        type="button"
        data-testid="clip-sheet-add-to-bin"
        class="action"
        @click="emit('addToBin', asset, rank)"
      >
        Add to bin
      </button>
      <button
        type="button"
        data-testid="clip-sheet-download"
        class="action"
        @click="emit('download', asset, rank)"
      >
        Download
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.sheet {
  background: var(--surface);
  border-left: 1px solid var(--line);
  padding: var(--space-4);
  overflow-y: auto;
  display: grid;
  gap: var(--space-4);
  align-content: start;
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.sheet-title {
  font-size: 0.95rem;
  font-weight: 640;
  margin: 0;
  overflow-wrap: anywhere;
}

.close {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  border-radius: var(--radius);
  font-size: 1rem;
  line-height: 1;
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
}

.poster {
  width: 100%;
  max-height: 300px;
  object-fit: contain;
  background: var(--surface-2);
  border-radius: var(--radius);
}

.description {
  margin: 0;
  font-size: 0.85rem;
}

.simulated {
  display: inline-block;
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ai);
  background: var(--ai-soft);
  border: 1px solid var(--ai-line);
  border-radius: var(--radius);
  padding: 1px var(--space-1);
  margin-right: var(--space-1);
}

.ai-claim {
  color: var(--ai);
}

h3 {
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 var(--space-2);
}

.contact-img {
  width: 100%;
  border-radius: var(--radius);
  border: 1px solid var(--line);
}

.facts dl {
  margin: 0;
  display: grid;
  gap: var(--space-1);
}

.fact {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: 0.82rem;
}

.fact dt {
  color: var(--muted);
}

.fact dd {
  margin: 0;
}

.source {
  font-size: 0.65rem;
  color: var(--muted);
  margin-left: var(--space-1);
}

.tag-groups {
  display: grid;
  gap: var(--space-3);
}

.tag-group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.tag {
  font-size: 0.75rem;
  border-radius: var(--radius-pill);
  padding: 2px var(--space-2);
}

.tag-ai {
  color: var(--ai);
  background: var(--ai-soft);
  border: 1px solid var(--ai-line);
}

.tag-human {
  color: var(--human);
  background: var(--human-soft);
  border: 1px solid var(--human);
}

.ai-heading {
  color: var(--ai);
}

.human-heading {
  color: var(--human);
}

.credit {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
}

.used {
  margin: 0;
  font-size: 0.72rem;
  color: var(--muted);
}

.actions {
  display: flex;
  gap: var(--space-2);
}

.action {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit;
  font-size: 0.82rem;
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}
</style>
