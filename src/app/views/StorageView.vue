<script setup lang="ts">
// Storage: what this machine holds, what tier it probed as, the quota numbers
// as data attributes so a test never parses prose, and the two things that make
// eviction survivable rather than silent: the sentinel verdict and the snapshot.
//
// Records live in IndexedDB by constraint (U2), and IndexedDB is evictable. The
// app cannot prevent that. What it can do is notice, say so by name, and hand
// the user a file. See `src/data/snapshot.ts`.
import { onMounted, ref } from 'vue'
import { useAppStore } from '../store'
import {
  countRecords,
  exportSnapshot,
  importSnapshot,
  verdictFrom,
  type ImportReport,
  type StorageVerdict,
} from '@/data/snapshot'

const store = useAppStore()

const usedBytes = ref<number | null>(null)
const totalBytes = ref<number | null>(null)
const persisted = ref<boolean | null>(null)

const verdict = ref<StorageVerdict | null>(null)
const recordCount = ref<number | null>(null)
const busy = ref(false)
const exported = ref<{ rows: number; at: number } | null>(null)
const imported = ref<ImportReport | null>(null)
const failure = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  const ctx = store.ctx
  if (ctx) {
    // Decided during boot, before hydration could re-seed over an eviction and
    // make the loss invisible. This panel reports it, it does not recompute it.
    verdict.value = ctx.storageVerdict
    recordCount.value = await countRecords(ctx.db)
  }

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

async function downloadSnapshot() {
  const ctx = store.ctx
  if (!ctx || busy.value) return
  busy.value = true
  failure.value = null
  try {
    const snapshot = await exportSnapshot(ctx.db, ctx.profile, ctx.clock.now())
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    // The profile is in the name because demo and live are separate databases,
    // and a snapshot restored into the wrong one is the mistake this prevents.
    anchor.download = `astolia-${ctx.profile}-${snapshot.manifest.exported_at}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    exported.value = { rows: snapshot.manifest.total_rows, at: snapshot.manifest.exported_at }
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

async function restoreSnapshot(event: Event) {
  const ctx = store.ctx
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!ctx || !file || busy.value) return
  busy.value = true
  failure.value = null
  imported.value = null
  try {
    imported.value = await importSnapshot(ctx.db, JSON.parse(await file.text()))
    recordCount.value = await countRecords(ctx.db)
    // A restore answers the eviction, so the banner must stop shouting about it.
    // The sentinel itself is refreshed on the next boot, from the real count.
    verdict.value = verdictFrom(
      { profile: ctx.profile, rows: recordCount.value, at: ctx.clock.now() },
      recordCount.value,
    )
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

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

    <!-- The verdict comes first, because if it says evicted then nothing else on
         this page is the thing the reader needs to know. -->
    <p
      v-if="verdict"
      data-testid="storage-verdict"
      class="verdict"
      :data-state="verdict.state"
    >
      <template v-if="verdict.state === 'evicted'">
        This browser reclaimed the local records for this profile. The last
        session left {{ verdict.expected }} rows and there are none now. This is
        storage pressure eviction, not a bug and not something the app can
        prevent: restore a snapshot below.
      </template>
      <template v-else-if="verdict.state === 'intact'">
        {{ verdict.rows }} records held locally, and the sentinel agrees with the
        database. Nothing has been reclaimed.
      </template>
      <template v-else>
        First run on this browser profile. There is nothing to have lost yet.
      </template>
    </p>

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

    <section class="snapshot">
      <h2>Snapshot</h2>
      <p class="muted">
        Records only, as one JSON file. Original video bytes are not in it: they
        live in OPFS, a real library is tens of gigabytes, and a backup that
        inlined them would be unopenable. The manifest states what it is not
        carrying, so a restore reads as "records back, originals to re-upload"
        rather than as a complete backup that quietly is not one.
      </p>
      <div class="actions">
        <button
          type="button"
          data-testid="storage-export"
          class="action"
          :disabled="busy"
          @click="downloadSnapshot"
        >
          Export a snapshot
        </button>
        <button
          type="button"
          data-testid="storage-import"
          class="action quiet"
          :disabled="busy"
          @click="fileInput?.click()"
        >
          Restore from a file
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          data-testid="storage-import-file"
          class="hidden-input"
          @change="restoreSnapshot"
        >
      </div>
      <p
        v-if="exported"
        data-testid="storage-export-receipt"
        class="receipt"
        :data-count="exported.rows"
      >
        exported {{ exported.rows }} records
      </p>
      <p
        v-if="imported"
        data-testid="storage-import-receipt"
        class="receipt"
        :data-count="imported.total"
      >
        restored {{ imported.total }} records across
        {{ Object.keys(imported.restored).length }} tables
        <span v-if="imported.skipped.length">({{ imported.skipped.length }} table(s) skipped)</span>
      </p>
      <p
        v-if="failure"
        data-testid="storage-snapshot-error"
        class="bad"
      >
        {{ failure }}
      </p>
    </section>

    <p class="muted">
      Original video bytes live in OPFS, records and derived images in
      IndexedDB, and about 50KB of preferences in localStorage.
      Originals are never evicted by the app, because a sync bug should cost a
      re-derive, never footage.
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

h2 {
  font-size: 0.95rem;
  font-weight: 640;
  margin: 0 0 var(--space-2);
}

.snapshot {
  display: grid;
  gap: var(--space-2);
}

/* Neutral: a row count is a measured fact. Eviction is a warning about state,
   not a model claim, so it takes the warn token and never the amber. */
.verdict {
  margin: 0;
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  max-width: 62ch;
}

.verdict[data-state='evicted'] {
  border-left-color: var(--critical);
  color: var(--critical);
}

.verdict[data-state='intact'] {
  border-left-color: var(--line);
  color: var(--muted);
}

.actions {
  display: flex;
  gap: var(--space-2);
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

.action.quiet {
  background: var(--surface);
  color: var(--muted);
}

.action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hidden-input {
  display: none;
}

.receipt {
  margin: 0;
  font-size: 0.78rem;
  color: var(--good);
}

.bad {
  margin: 0;
  font-size: 0.8rem;
  color: var(--critical);
}
</style>
