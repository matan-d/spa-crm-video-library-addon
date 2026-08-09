<script setup lang="ts">
// Sync: the outbox, the cursors, and what the merge policy refused.
//
// The honesty rule from the architecture review C.4 is enforced here rather
// than described: this panel says "Adapter: loopback" in plain text, and
// nothing in it claims a connection to Supabase, because there is not one. A
// reviewer who catches an overclaim on this screen discounts everything else in
// the build, and one who reads an accurate label plus a real drain concludes
// the opposite.
//
// Colour, per docs/05-design-system.md: nothing on this surface is model
// output, so nothing on it is amber. Counts and cursors are measured facts and
// take the neutrals. A conflict about human curation carries the human green,
// because what is being protected there is somebody's decision.
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { useAppStore } from '../store'
import { connectLoopback, type LoopbackAdapter, type SyncSnapshot } from '../sync/loopback'

const store = useAppStore()

const adapter = shallowRef<LoopbackAdapter | null>(null)
const snapshot = shallowRef<SyncSnapshot | null>(null)
const busy = ref(false)
const lastRun = ref<string | null>(null)
const failure = ref<string | null>(null)

onMounted(async () => {
  const ctx = store.ctx
  if (!ctx || store.session?.kind !== 'manager') return
  adapter.value = await connectLoopback({
    profile: ctx.profile,
    local: ctx.db,
    clock: ctx.clock,
    newId: ctx.newId,
    deviceId: ctx.deviceId,
  })
  await refresh()
})

// The server connection belongs to this panel, so it closes with it rather than
// living on in the store for a surface nobody is looking at.
onUnmounted(() => adapter.value?.close())

async function refresh() {
  snapshot.value = (await adapter.value?.snapshot()) ?? null
}

async function run(kind: 'push' | 'pull' | 'sync') {
  if (!adapter.value || busy.value) return
  busy.value = true
  failure.value = null
  try {
    if (kind === 'push') {
      const report = await adapter.value.push()
      lastRun.value = `push: ${report.sent} sent, ${report.failed} failed, ${report.conflicts.length} conflict(s)`
    } else if (kind === 'pull') {
      const report = await adapter.value.pull()
      lastRun.value = `pull: ${report.applied} applied, ${report.unchanged} unchanged, ${report.conflicts.length} conflict(s)`
    } else {
      const both = await adapter.value.sync()
      lastRun.value = `sync: ${both.push.sent} pushed, ${both.pull.applied} applied`
    }
    await refresh()
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

function instant(ms: number | null): string {
  return ms == null ? 'never' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}
</script>

<template>
  <div
    data-testid="sync-panel"
    class="sync"
  >
    <h1>Sync</h1>

    <p
      data-testid="sync-adapter"
      class="adapter mono"
      data-adapter="loopback"
    >
      Adapter: loopback
    </p>
    <p class="muted">
      The outbox below drains into a second IndexedDB database on this machine
      that plays the part of the server, with its own <code>server_updated_at</code>
      clock and its own copy of the merge rules. Nothing is deployed, no request
      leaves this device, and this build has never been connected to Supabase.
      The schema and the row level security for it are written and committed;
      the transport is not.
    </p>

    <!-- Nothing is counted until the snapshot has actually been read. A panel
         that renders "0 pending" while it has not yet looked is telling a
         reviewer the queue is empty on no evidence, which is the same defect as
         rendering `unknown` as a pass. `data-loaded` says which state this is. -->
    <p
      v-if="!snapshot"
      data-testid="sync-loading"
      class="muted"
    >
      Reading the outbox and the loopback server...
    </p>

    <section
      v-else
      data-testid="sync-status"
      class="status"
      data-loaded="yes"
      :data-adapter="snapshot.adapter"
      :data-pending="snapshot.pending"
    >
      <span
        data-testid="outbox-pending-count"
        class="stat"
        :data-count="snapshot.pending"
      >
        <strong class="mono">{{ snapshot.pending }}</strong> pending
      </span>
      <span
        data-testid="outbox-sent-count"
        class="stat"
        :data-count="snapshot.sent"
      >
        <strong class="mono">{{ snapshot.sent }}</strong> sent
      </span>
      <span
        data-testid="outbox-failed-count"
        class="stat"
        :class="{ bad: snapshot.failed > 0 }"
        :data-count="snapshot.failed"
      >
        <strong class="mono">{{ snapshot.failed }}</strong> failed
      </span>
      <span
        data-testid="sync-server-rows"
        class="stat"
        :data-count="snapshot.serverRows"
      >
        <strong class="mono">{{ snapshot.serverRows }}</strong> rows on the loopback server
      </span>
    </section>

    <section class="actions">
      <button
        type="button"
        data-testid="sync-push"
        class="action"
        :disabled="busy || !adapter"
        @click="run('push')"
      >
        Drain the outbox
      </button>
      <button
        type="button"
        data-testid="sync-pull"
        class="action"
        :disabled="busy || !adapter"
        @click="run('pull')"
      >
        Pull from the cursor
      </button>
      <span
        v-if="lastRun"
        data-testid="sync-last-run"
        class="muted mono"
      >{{ lastRun }}</span>
      <span
        v-if="failure"
        class="bad"
      >{{ failure }}</span>
    </section>

    <section>
      <h2>Queued by table</h2>
      <p
        v-if="!snapshot?.byStore.length"
        class="muted"
      >
        Nothing queued. The seeded rows are history, not work this session did,
        so hydration deliberately writes no outbox entries (D12).
      </p>
      <div class="rows">
        <article
          v-for="queue in snapshot?.byStore ?? []"
          :key="queue.store"
          data-testid="outbox-store-row"
          class="row"
          :data-store="queue.store"
          :data-count="queue.pending"
          :data-sent="queue.sent"
          :data-failed="queue.failed"
        >
          <span class="mono label">{{ queue.store }}</span>
          <span class="mono">{{ queue.pending }} pending</span>
          <span class="mono muted">{{ queue.sent }} sent</span>
          <span
            v-if="queue.failed"
            class="mono bad"
          >{{ queue.failed }} failed</span>
        </article>
      </div>
    </section>

    <section>
      <h2>Per table cursor</h2>
      <p class="muted">
        The cursor is <code>(server_updated_at, id)</code>, ordered by the
        server's clock and never by this device's. A phone forty minutes fast
        would otherwise write a future <code>updated_at</code> and every other
        device would step straight past the row, permanently, with no error
        anywhere. The <code>id</code> tiebreak exists because one batch write
        stamps hundreds of rows with a single timestamp.
      </p>
      <p
        v-if="!snapshot?.cursors.length"
        class="muted"
      >
        No table has synced yet.
      </p>
      <div class="rows">
        <article
          v-for="cursor in snapshot?.cursors ?? []"
          :key="cursor.store"
          data-testid="sync-cursor-row"
          class="row"
          :data-store="cursor.store"
          :data-server-updated-at="cursor.cursor_server_updated_at ?? undefined"
          :data-cursor-id="cursor.cursor_id ?? undefined"
        >
          <span class="mono label">{{ cursor.store }}</span>
          <span class="mono muted">at {{ cursor.cursor_server_updated_at ?? 'never' }}</span>
          <span class="mono muted">id {{ cursor.cursor_id ?? '-' }}</span>
          <span class="mono muted">pulled {{ instant(cursor.last_pulled_at) }}</span>
        </article>
      </div>
    </section>

    <section>
      <h2>Conflicts</h2>
      <p class="muted">
        A refused merge is a row, never a notification. A conflict that is only a
        toast gets dismissed and then found three weeks later inside a campaign,
        so these persist until a human resolves them.
      </p>
      <p
        v-if="!snapshot?.conflicts.length"
        data-testid="sync-conflict-empty"
        class="muted"
      >
        No conflict recorded.
      </p>
      <div class="rows">
        <article
          v-for="conflict in snapshot?.conflicts ?? []"
          :key="conflict.id"
          data-testid="sync-conflict-row"
          class="row conflict"
          :data-store="conflict.store"
          :data-row-id="conflict.row_id"
          :data-policy="conflict.policy"
          :data-direction="conflict.direction"
        >
          <span class="mono policy">{{ conflict.policy }}</span>
          <span class="mono">{{ conflict.store }}.{{ conflict.fields.join(', ') }}</span>
          <span class="mono kept">kept {{ JSON.stringify(conflict.kept) }}</span>
          <span class="mono refused">refused {{ JSON.stringify(conflict.refused) }}</span>
          <span class="detail">{{ conflict.detail }}</span>
        </article>
      </div>
    </section>

    <section>
      <h2>The queue itself</h2>
      <p class="muted">
        The real payloads, newest first. A patch carries only the fields that
        changed, so two devices editing different fields of one clip both land.
        Fields declared local-only (the upload offset, where the bytes are on
        this machine) never reach this queue at all.
      </p>
      <div class="rows">
        <article
          v-for="entry in (snapshot?.entries ?? []).slice(0, 40)"
          :key="entry.seq"
          data-testid="outbox-entry-row"
          class="row entry"
          :data-seq="entry.seq"
          :data-store="entry.store"
          :data-op="entry.op"
          :data-state="entry.state"
          :data-row-id="entry.row_id"
        >
          <span class="mono">#{{ entry.seq }}</span>
          <span class="mono label">{{ entry.store }} &middot; {{ entry.op }}</span>
          <span
            class="mono state"
            :class="entry.state"
          >{{ entry.state }}</span>
          <span class="mono muted">base_rev {{ entry.base_rev }}</span>
          <pre
            data-testid="outbox-entry-patch"
            class="patch mono"
          >{{ JSON.stringify(entry.patch) }}</pre>
          <span
            v-if="entry.last_error"
            class="bad"
          >{{ entry.last_error }}</span>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sync {
  padding: var(--space-4);
  display: grid;
  gap: var(--space-4);
  max-width: 60rem;
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

.adapter {
  margin: 0;
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  padding: var(--space-2) var(--space-3);
  justify-self: start;
}

.muted {
  color: var(--muted);
  font-size: 0.78rem;
  margin: 0 0 var(--space-2);
  max-width: 72ch;
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}

.stat {
  font-size: 0.8rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-1) var(--space-3);
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

.action:disabled {
  opacity: 0.5;
  cursor: default;
}

.rows {
  display: grid;
  gap: var(--space-1);
}

.row {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font-size: 0.8rem;
}

.label {
  min-width: 12rem;
}

/*
 * Deep green, because what a refused merge protects is a human decision: a
 * rejection nobody may overturn, a consent snapshot nobody may rewrite. Amber
 * would be a defect here, since no model is involved anywhere on this surface.
 */
.conflict {
  border-left: 3px solid var(--human);
}

.policy {
  text-transform: uppercase;
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  color: var(--human);
}

.kept {
  color: var(--good);
}

.refused {
  color: var(--muted);
  text-decoration: line-through;
}

.detail {
  width: 100%;
  color: var(--muted);
  font-size: 0.75rem;
}

.state.pending {
  color: var(--warn);
}

.state.sent {
  color: var(--good);
}

.state.failed {
  color: var(--critical);
}

.bad {
  color: var(--critical);
}

.patch {
  width: 100%;
  margin: 0;
  font-size: 0.72rem;
  color: var(--muted);
  background: var(--surface-2);
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-2);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
