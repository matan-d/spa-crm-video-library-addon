<script setup lang="ts">
// Storage: what this machine holds, what tier it probed as, and the quota
// numbers as data attributes so a test never parses prose.
import { onMounted, ref } from 'vue'
import { useAppStore } from '../store'

const store = useAppStore()

const usedBytes = ref<number | null>(null)
const totalBytes = ref<number | null>(null)
const persisted = ref<boolean | null>(null)

onMounted(async () => {
  const quota = store.ctx?.platform.port.quota
  if (!quota) return
  try {
    const report = await quota.report()
    if (report.available) {
      usedBytes.value = report.usageBytes
      totalBytes.value = report.quotaBytes
      persisted.value = report.persisted
    }
  } catch {
    // A runtime without an estimate stays honest: unknown, not zero.
  }
})

const tier = () => store.ctx?.platform.report.tier ?? 'unknown'

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'unknown'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}
</script>

<template>
  <div
    data-testid="storage-panel"
    class="storage"
  >
    <h1>Storage</h1>

    <dl class="facts">
      <div class="fact">
        <dt>Used</dt>
        <dd
          data-testid="storage-quota-used"
          class="mono"
          :data-bytes="usedBytes ?? undefined"
        >
          {{ formatBytes(usedBytes) }}
        </dd>
      </div>
      <div class="fact">
        <dt>Quota</dt>
        <dd
          data-testid="storage-quota-total"
          class="mono"
          :data-bytes="totalBytes ?? undefined"
        >
          {{ formatBytes(totalBytes) }}
        </dd>
      </div>
      <div class="fact">
        <dt>Ingest tier on this machine</dt>
        <dd
          data-testid="storage-policy-tier"
          class="mono"
          :data-tier="tier()"
        >
          {{ tier() }}
        </dd>
      </div>
      <div class="fact">
        <dt>Storage persisted</dt>
        <dd
          data-testid="storage-persisted-flag"
          class="mono"
          :data-status="persisted == null ? 'unknown' : String(persisted)"
        >
          {{ persisted == null ? 'unknown' : persisted ? 'yes' : 'no' }}
        </dd>
      </div>
    </dl>

    <p class="muted">
      Original video bytes live in OPFS, records and derived images in
      IndexedDB, and about 50KB of preferences in localStorage.
      Eviction of derivatives arrives with the media pipeline: originals are
      never evicted by the app, because a sync bug should cost a re-derive,
      never footage.
    </p>
  </div>
</template>

<style scoped>
.storage {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-4);
  max-width: 40rem;
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  margin: 0;
}

.facts {
  margin: 0;
  display: grid;
  gap: var(--space-2);
}

.fact {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font-size: 0.85rem;
}

.fact dt {
  color: var(--muted);
}

.fact dd {
  margin: 0;
}

.muted {
  color: var(--muted);
  font-size: 0.82rem;
  margin: 0;
  max-width: 62ch;
}
</style>
