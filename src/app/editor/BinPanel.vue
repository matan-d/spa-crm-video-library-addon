<script setup lang="ts">
// The bin: the editor's working selection. Download and handoff are separate
// actions writing separate usage kinds, per D5: a download is evidence of
// intent, the handoff is the explicit confirmation moment for real use, and
// the two must never be conflated into one number.
import type { Asset } from '@/data/types'

export interface BinEntry {
  asset: Asset
  /** The rank the clip held in the result list when it was added. */
  rankAtEvent: number
}

export interface UsageReceipt {
  usageEventId: string
  assetId: string
  rankAtEvent: number
}

defineProps<{
  entries: BinEntry[]
  receipts: UsageReceipt[]
}>()

const emit = defineEmits<{
  remove: [assetId: string]
  download: []
  handoff: []
  clear: []
}>()
</script>

<template>
  <aside
    data-testid="bin-panel"
    class="bin"
    aria-label="Bin"
  >
    <header class="bin-head">
      <h2>Bin</h2>
      <span
        data-testid="bin-count"
        class="mono count"
        :data-count="entries.length"
      >{{ entries.length }}</span>
    </header>

    <ul class="items">
      <li
        v-for="entry in entries"
        :key="entry.asset.id"
        data-testid="bin-item"
        :data-asset-id="entry.asset.id"
        :data-rank="entry.rankAtEvent"
        class="item"
      >
        <img
          v-if="entry.asset.poster_key"
          class="thumb"
          :src="entry.asset.poster_key"
          :alt="entry.asset.filename"
        >
        <span class="name">{{ entry.asset.filename }}</span>
        <button
          type="button"
          data-testid="bin-item-remove"
          class="remove"
          :aria-label="`Remove ${entry.asset.filename}`"
          @click="emit('remove', entry.asset.id)"
        >
          &times;
        </button>
      </li>
    </ul>

    <div
      v-if="entries.length"
      class="bin-actions"
    >
      <button
        type="button"
        data-testid="bin-download"
        class="action"
        @click="emit('download')"
      >
        Download
      </button>
      <button
        type="button"
        data-testid="bin-handoff"
        class="action primary"
        @click="emit('handoff')"
      >
        Confirm use
      </button>
      <button
        type="button"
        data-testid="bin-clear"
        class="action"
        @click="emit('clear')"
      >
        Clear
      </button>
    </div>

    <ul
      v-if="receipts.length"
      class="receipts"
    >
      <li
        v-for="receipt in receipts"
        :key="receipt.usageEventId"
        data-testid="usage-confirmation"
        :data-usage-event-id="receipt.usageEventId"
        :data-asset-id="receipt.assetId"
        :data-rank-at-event="receipt.rankAtEvent"
        class="receipt"
      >
        Recorded use of {{ receipt.assetId.slice(0, 8) }}&hellip; at rank {{ receipt.rankAtEvent }}
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.bin {
  background: var(--surface);
  border-left: 1px solid var(--line);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
  align-content: start;
  overflow-y: auto;
}

.bin-head {
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

.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 0.8rem;
}

.thumb {
  width: 34px;
  height: 44px;
  object-fit: cover;
  border-radius: var(--radius);
  background: var(--surface-2);
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove {
  appearance: none;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 0.9rem;
  cursor: pointer;
  padding: var(--space-1);
}

.bin-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.action {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink);
  font: inherit;
  font-size: 0.78rem;
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
}

.action.primary {
  background: var(--human);
  border-color: var(--human);
  color: var(--surface);
}

.receipts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
}

.receipt {
  font-size: 0.72rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-2);
}
</style>
