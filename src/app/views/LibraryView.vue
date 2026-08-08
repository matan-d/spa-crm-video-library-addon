<script setup lang="ts">
// The editor surface. One search box as the primary interaction, facet chips
// derived from the result set with counts (never a taxonomy tree), the grid,
// the clip sheet, the bin, and the zero-result ladder ending in "add to next
// brief", which writes a gap row: the first hop of the loop chain.
//
// Everything on screen came through the editor session's scope. Nothing here
// re-filters for visibility, and nothing here may touch IndexedDB directly.
import { computed, onMounted, ref, shallowRef } from 'vue'
import { signatureOf } from '@/data/seed'
import type { Asset, Tag } from '@/data/types'
import { useAppStore } from '../store'
import {
  gapFacetsFrom,
  runSearch,
  type MappedTerm,
  type SearchOutcome,
  type VocabularyEntry,
} from '../editor/search'
import ClipSheet from '../editor/ClipSheet.vue'
import BinPanel, { type BinEntry, type UsageReceipt } from '../editor/BinPanel.vue'

const store = useAppStore()

// ---- raw data, loaded once through the scope ------------------------------
const assets = shallowRef<Asset[]>([])
const tags = shallowRef<Tag[]>([])
const vocabulary = shallowRef<VocabularyEntry[]>([])
const loaded = ref(false)

onMounted(async () => {
  const repo = store.repo
  if (!repo) return
  assets.value = await repo.list<Asset>('asset')
  tags.value = await repo.list<Tag>('tag')
  vocabulary.value = await repo.list<VocabularyEntry>('tag_vocabulary')
  execute('', null)
  loaded.value = true
})

// ---- search state ---------------------------------------------------------
const queryText = ref('')
const executedText = ref('')
const outcome = shallowRef<SearchOutcome | null>(null)
const queryLogId = ref<string | null>(null)
const refinements = ref<Map<string, string>>(new Map())

function execute(text: string, logId: string | null) {
  executedText.value = text
  queryLogId.value = logId
  outcome.value = runSearch({
    text,
    assets: assets.value,
    tags: tags.value,
    vocabulary: vocabulary.value,
    refinements: refinements.value,
  })
}

async function submitSearch() {
  const text = queryText.value.trim()
  refinements.value = new Map()
  gapConfirmation.value = null

  // Compute first, then log what actually happened: outcome is a fact about
  // this search, not a hope.
  const previous = queryLogId.value
  execute(text, null)
  const results = outcome.value?.results ?? []

  if (text.length === 0) return
  const repo = store.repo
  if (!repo) return
  const id = await repo.create('search_query_log', {
    user_id: store.session?.user_id ?? null,
    text,
    tokens: text.toLowerCase().split(/\s+/).filter(Boolean),
    outcome: results.length === 0 ? 'zero_results' : 'results',
    result_count: results.length,
    clicked_ranks: [],
    refined_from_query_id: previous,
  })
  queryLogId.value = id
}

function clearSearch() {
  queryText.value = ''
  refinements.value = new Map()
  gapConfirmation.value = null
  execute('', null)
}

function removeTerm(term: MappedTerm) {
  // Removing a chip narrows the interpretation, not the log: the logged query
  // stays what the editor actually typed.
  const remaining = (outcome.value?.parsed.mapped ?? [])
    .filter((entry) => entry !== term)
    .map((entry) => entry.raw)
    .concat(outcome.value?.parsed.unmapped ?? [])
    .join(' ')
  queryText.value = remaining
  execute(remaining, queryLogId.value)
}

function toggleFacet(facet: string, value: string) {
  const next = new Map(refinements.value)
  if (next.get(facet) === value) next.delete(facet)
  else next.set(facet, value)
  refinements.value = next
  execute(executedText.value, queryLogId.value)
}

function clearFacets() {
  refinements.value = new Map()
  execute(executedText.value, queryLogId.value)
}

const results = computed(() => outcome.value?.results ?? [])
const facets = computed(() => outcome.value?.facets ?? [])
const parsed = computed(() => outcome.value?.parsed ?? { mapped: [], unmapped: [] })
const showZero = computed(
  () => loaded.value && executedText.value.length > 0 && results.value.length === 0,
)

const activeSummary = computed(() =>
  [...refinements.value.entries()].map(([facet, value]) => `${facet}: ${value}`).join(', '),
)

// ---- the clip sheet -------------------------------------------------------
const sheet = ref<{ asset: Asset; rank: number } | null>(null)

// ---- the bin and the usage signal -----------------------------------------
const bin = ref<BinEntry[]>([])
const receipts = ref<UsageReceipt[]>([])
const binOpen = ref(false)

function addToBin(asset: Asset, rank: number) {
  if (bin.value.some((entry) => entry.asset.id === asset.id)) return
  bin.value = [...bin.value, { asset, rankAtEvent: rank }]
  binOpen.value = true
}

function removeFromBin(assetId: string) {
  bin.value = bin.value.filter((entry) => entry.asset.id !== assetId)
}

async function writeUsage(kind: string): Promise<UsageReceipt[]> {
  const repo = store.repo
  if (!repo) return []
  const written: UsageReceipt[] = []
  for (const entry of bin.value) {
    const id = await repo.create('usage_event', {
      asset_id: entry.asset.id,
      user_id: store.session?.user_id ?? null,
      kind,
      rank_at_event: entry.rankAtEvent,
      query_id: queryLogId.value,
      dwell_ms: null,
    })
    written.push({ usageEventId: id, assetId: entry.asset.id, rankAtEvent: entry.rankAtEvent })
  }
  return written
}

/** A download is intent (D5). It is logged and it does not empty the bin. */
async function downloadBin() {
  await writeUsage('download')
}

/** One clip downloaded straight from the sheet, logged at the rank it held. */
async function downloadSingle(asset: Asset, rank: number) {
  const repo = store.repo
  if (!repo) return
  await repo.create('usage_event', {
    asset_id: asset.id,
    user_id: store.session?.user_id ?? null,
    kind: 'download',
    rank_at_event: rank,
    query_id: queryLogId.value,
    dwell_ms: null,
  })
}

/** The explicit confirmation moment for real use (D5). */
async function handoffBin() {
  receipts.value = await writeUsage('confirmed_use')
  bin.value = []
}

// ---- the zero-result ladder's last rung: request a shot -------------------
const requestNote = ref('')
const gapConfirmation = ref<{ gapId: string; signature: string } | null>(null)

async function requestShot() {
  const repo = store.repo
  if (!repo) return
  const mapped = parsed.value.mapped
  const facetsForGap = gapFacetsFrom(mapped)
  const signature = signatureOf(facetsForGap)
  const note = requestNote.value.trim()
  const gapId = await repo.create('gap', {
    gap_scan_id: null,
    branch_id: null,
    cell_signature: signature,
    facets: facetsForGap,
    // An explicit request outranks an inferred one.
    //
    // This was 0, which buried a named editor asking for a specific shot
    // underneath every gap the scan had merely guessed at, so brief generation
    // dropped it. A person who searched, found nothing, and took the trouble to
    // ask is the strongest demand signal this system can receive: it is a real
    // person's real intent rather than a statistical shadow of one. It is not 1,
    // because a scan seeing sustained demand across many editors plus a coverage
    // deficit should still be able to outrank one request.
    score: 0.75,
    severity: 'high',
    status: 'open',
    signals: [
      {
        source: 'editor_request',
        weight: 1,
        detail: note.length > 0 ? `${executedText.value} (${note})` : executedText.value,
      },
    ],
    closing_asset_ids: [],
  })
  gapConfirmation.value = { gapId, signature }
  requestNote.value = ''
}
</script>

<template>
  <div
    data-testid="library"
    class="library"
  >
    <!-- search -->
    <div class="search-row">
      <form
        class="search"
        @submit.prevent="submitSearch"
      >
        <input
          v-model="queryText"
          data-testid="library-search-input"
          class="search-input"
          type="search"
          placeholder="Describe the shot you need"
          aria-label="Search the library"
        >
        <button
          type="submit"
          data-testid="library-search-submit"
          class="search-submit"
        >
          Search
        </button>
        <button
          v-if="executedText"
          type="button"
          data-testid="library-search-clear"
          class="search-clear"
          @click="clearSearch"
        >
          Clear
        </button>
      </form>

      <button
        type="button"
        data-testid="bin-toggle"
        class="bin-toggle"
        :aria-pressed="binOpen"
        @click="binOpen = !binOpen"
      >
        Bin
        <span
          class="mono"
          :data-count="bin.length"
        >{{ bin.length }}</span>
      </button>
    </div>

    <!-- what we understood -->
    <div
      v-if="executedText && (parsed.mapped.length || parsed.unmapped.length)"
      data-testid="search-parsed-query"
      class="parsed"
      :data-search-query-log-id="queryLogId ?? undefined"
    >
      <span class="parsed-label">Understood as</span>
      <span
        v-for="term in parsed.mapped"
        :key="term.term"
        data-testid="search-term-chip"
        class="chip"
        :data-term="term.raw"
        :data-mapped-to="term.term"
      >
        {{ term.raw }} &rarr; {{ term.term }}
        <button
          type="button"
          data-testid="search-term-chip-remove"
          class="chip-remove"
          :aria-label="`Remove ${term.raw}`"
          @click="removeTerm(term)"
        >
          &times;
        </button>
      </span>
      <span
        v-for="word in parsed.unmapped"
        :key="word"
        data-testid="search-unmapped-term"
        class="chip chip-unmapped"
        :data-term="word"
      >
        {{ word }}: not in the vocabulary yet
      </span>
    </div>

    <div class="panes">
      <!-- facets -->
      <aside
        v-if="facets.length"
        data-testid="facet-panel"
        class="facet-panel"
        aria-label="Refine"
      >
        <div
          v-if="refinements.size"
          class="facet-active"
        >
          <span data-testid="facet-active-summary">{{ activeSummary }}</span>
          <button
            type="button"
            data-testid="facet-clear-all"
            class="facet-clear"
            @click="clearFacets"
          >
            Clear all
          </button>
        </div>
        <div
          v-for="facet in [...new Set(facets.map((entry) => entry.facet))]"
          :key="facet"
          data-testid="facet-group"
          :data-facet="facet"
          class="facet-group"
        >
          <h3 class="facet-title">
            {{ facet }}
          </h3>
          <button
            v-for="entry in facets.filter((candidate) => candidate.facet === facet)"
            :key="entry.value"
            type="button"
            data-testid="facet-chip"
            class="facet-chip"
            :data-facet="entry.facet"
            :data-value="entry.value"
            :aria-pressed="refinements.get(entry.facet) === entry.value"
            :class="{ active: refinements.get(entry.facet) === entry.value }"
            @click="toggleFacet(entry.facet, entry.value)"
          >
            {{ entry.value.replace(/_/g, ' ') }}
            <span
              data-testid="facet-chip-count"
              class="facet-count mono"
            >{{ entry.count }}</span>
          </button>
        </div>
      </aside>

      <!-- results -->
      <main class="results">
        <p
          v-if="loaded"
          data-testid="library-result-count"
          class="count mono"
          :data-count="results.length"
        >
          {{ results.length }} clips
        </p>

        <div
          v-if="results.length"
          data-testid="library-result-grid"
          class="grid"
        >
          <article
            v-for="entry in results"
            :key="entry.asset.id"
            data-testid="result-tile"
            :data-asset-id="entry.asset.id"
            :data-rank="entry.rank"
            :data-provenance="entry.asset.ai_provenance ?? 'none'"
            class="tile"
            @click="sheet = { asset: entry.asset, rank: entry.rank }"
          >
            <img
              v-if="entry.asset.poster_key"
              data-testid="result-tile-poster"
              class="poster"
              :src="entry.asset.poster_key"
              :alt="entry.asset.ai_description ?? entry.asset.filename"
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
              >{{ Math.floor((entry.asset.duration_s ?? 0) / 60) }}:{{ String(Math.round(entry.asset.duration_s ?? 0) % 60).padStart(2, '0') }}</span>
              <span
                v-if="entry.asset.creator_credit"
                data-testid="result-tile-creator-credit"
                class="credit"
              >{{ entry.asset.creator_credit }}</span>
              <button
                type="button"
                data-testid="result-tile-add-to-bin"
                class="tile-add"
                :aria-label="`Add ${entry.asset.filename} to bin`"
                @click.stop="addToBin(entry.asset, entry.rank)"
              >
                +
              </button>
            </footer>
          </article>
        </div>

        <!-- the zero-result ladder -->
        <section
          v-if="showZero"
          data-testid="zero-result-state"
          class="zero"
        >
          <h2>Nothing matches all of that yet</h2>
          <p
            v-if="outcome?.relaxed"
            data-testid="zero-result-relaxed-note"
            class="relaxed-note"
            :data-term="outcome.relaxed.dropped.raw"
          >
            Ignoring <strong>{{ outcome.relaxed.dropped.raw }}</strong> finds close matches:
          </p>
          <div
            v-if="outcome?.relaxed"
            data-testid="zero-result-near-matches"
            class="near"
          >
            <p
              data-testid="zero-result-near-match-count"
              class="mono count"
              :data-count="outcome.relaxed.results.length"
            >
              {{ outcome.relaxed.results.length }} near matches
            </p>
            <div class="grid grid-near">
              <article
                v-for="entry in outcome.relaxed.results.slice(0, 6)"
                :key="entry.asset.id"
                data-testid="result-tile"
                :data-asset-id="entry.asset.id"
                :data-rank="entry.rank"
                :data-provenance="entry.asset.ai_provenance ?? 'none'"
                class="tile"
                @click="sheet = { asset: entry.asset, rank: entry.rank }"
              >
                <img
                  v-if="entry.asset.poster_key"
                  data-testid="result-tile-poster"
                  class="poster"
                  :src="entry.asset.poster_key"
                  :alt="entry.asset.ai_description ?? entry.asset.filename"
                >
              </article>
            </div>
          </div>

          <div
            data-testid="request-shot"
            class="request"
          >
            <h3>Add it to the next brief</h3>
            <p class="request-note-copy">
              Nobody has shot this yet. Request it and the next creator brief
              will ask for it.
            </p>
            <form
              data-testid="request-shot-form"
              class="request-form"
              @submit.prevent="requestShot"
            >
              <input
                v-model="requestNote"
                data-testid="request-shot-note"
                class="request-input"
                type="text"
                placeholder="Anything the creator should know (optional)"
                aria-label="Note for the brief"
              >
              <button
                type="submit"
                data-testid="request-shot-submit"
                class="request-submit"
              >
                Request this shot
              </button>
            </form>
            <p
              v-if="gapConfirmation"
              data-testid="request-shot-confirmation"
              class="request-confirmation"
              :data-gap-id="gapConfirmation.gapId"
              :data-cell-signature="gapConfirmation.signature"
            >
              Requested. This is now a tracked gap for the next brief.
            </p>
          </div>
        </section>
      </main>

      <!-- side panel: clip sheet wins over bin -->
      <ClipSheet
        v-if="sheet"
        :asset="sheet.asset"
        :rank="sheet.rank"
        class="side"
        @close="sheet = null"
        @add-to-bin="addToBin"
        @download="downloadSingle"
      />
      <BinPanel
        v-else-if="binOpen"
        :entries="bin"
        :receipts="receipts"
        class="side"
        @remove="removeFromBin"
        @download="downloadBin"
        @handoff="handoffBin"
        @clear="bin = []"
      />
    </div>
  </div>
</template>

<style scoped>
.library {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
}

.search-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.search {
  display: flex;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.search-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
}

.search-submit,
.search-clear,
.bin-toggle {
  appearance: none;
  font: inherit;
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
}

.search-submit {
  background: var(--human);
  border-color: var(--human);
  color: var(--surface);
}

.parsed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  font-size: 0.8rem;
}

.parsed-label {
  color: var(--muted);
  margin-right: var(--space-1);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--surface);
  padding: 2px var(--space-2);
}

.chip-unmapped {
  color: var(--warn);
  border-style: dashed;
}

.chip-remove {
  appearance: none;
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  font-size: 0.9rem;
  line-height: 1;
}

.panes {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.panes:has(.side) {
  grid-template-columns: 190px minmax(0, 1fr) 320px;
}

.facet-panel {
  display: grid;
  gap: var(--space-3);
  align-content: start;
}

.facet-active {
  display: grid;
  gap: var(--space-1);
  font-size: 0.75rem;
  color: var(--muted);
}

.facet-clear {
  appearance: none;
  border: none;
  background: none;
  color: var(--human);
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  padding: 0;
  cursor: pointer;
}

.facet-title {
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 var(--space-1);
}

.facet-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
}

.facet-chip {
  appearance: none;
  font: inherit;
  font-size: 0.78rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--ink);
  padding: 2px var(--space-2);
  cursor: pointer;
  display: inline-flex;
  gap: var(--space-1);
  align-items: baseline;
}

.facet-chip.active {
  background: var(--human-soft);
  border-color: var(--human);
  color: var(--human);
}

.facet-count {
  font-size: 0.68rem;
  color: var(--muted);
}

.results {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.count {
  color: var(--muted);
  font-size: 0.78rem;
  margin: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
}

.tile {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
}

.poster {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  background: var(--surface-2);
}

.poster-absent {
  width: 100%;
  aspect-ratio: 3 / 4;
  background: var(--surface-2);
}

.tile-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  font-size: 0.72rem;
  color: var(--muted);
}

.credit {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.tile-add {
  appearance: none;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink);
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1;
  padding: 2px var(--space-1);
}

.zero {
  display: grid;
  gap: var(--space-3);
  max-width: 46rem;
}

.zero h2 {
  font-size: 1.1rem;
  font-weight: 640;
  margin: 0;
}

.relaxed-note {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.near {
  display: grid;
  gap: var(--space-2);
}

.grid-near {
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
}

.request {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-2);
}

.request h3 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 640;
}

.request-note-copy {
  margin: 0;
  color: var(--muted);
  font-size: 0.82rem;
}

.request-form {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.request-input {
  flex: 1;
  min-width: 200px;
  font: inherit;
  font-size: 0.85rem;
  padding: var(--space-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
}

.request-submit {
  appearance: none;
  font: inherit;
  font-size: 0.85rem;
  border: 1px solid var(--human);
  border-radius: var(--radius);
  background: var(--human);
  color: var(--surface);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
}

.request-confirmation {
  margin: 0;
  font-size: 0.82rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: var(--space-2);
}

.side {
  min-height: 200px;
  border-radius: var(--radius);
}

@media (max-width: 900px) {
  .panes,
  .panes:has(.side) {
    grid-template-columns: minmax(0, 1fr);
  }

  .facet-panel {
    grid-auto-flow: row;
  }

  .facet-group {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .side {
    position: fixed;
    inset: auto 0 0 0;
    max-height: 70dvh;
    z-index: 10;
    border-top: 1px solid var(--line);
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.12);
  }
}
</style>
