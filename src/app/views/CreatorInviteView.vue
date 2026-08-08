<script setup lang="ts">
// The creator's front door. The route guard has already resolved the token by
// the time this renders, so this view only ever sees a settled gate: ok,
// expired, or invalid. Consent capture and the upload page land with the
// creator surface task; the brief a creator is being asked for is already real
// and already scoped, because it is read through the token session.
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../store'

interface BriefRow {
  id: string
  collab_id: string
  status: string
}
interface BriefItemRow {
  id: string
  brief_id: string
  seq: number
  instruction: string
}
interface CollabRow {
  id: string
  branch_id: string
  visit_at: number | null
}
interface BranchRow {
  id: string
  name: string
  city: string
}

const store = useAppStore()
const gate = computed(() => store.creatorGate)

const branch = ref<BranchRow | null>(null)
const visitAt = ref<number | null>(null)
const items = ref<BriefItemRow[]>([])
const loaded = ref(false)

onMounted(async () => {
  const repo = store.repo
  const session = store.session
  if (!repo || !session || session.kind !== 'creator_token') return

  const collab = session.collab_id ? await repo.get<CollabRow>('collab', session.collab_id) : undefined
  if (collab) {
    visitAt.value = collab.visit_at
    branch.value = (await repo.get<BranchRow>('branch', collab.branch_id)) ?? null
  }

  const briefs = await repo.list<BriefRow>('brief')
  const locked = briefs.find((brief) => brief.status === 'locked') ?? briefs[0]
  if (locked) {
    const rows = await repo.list<BriefItemRow>('brief_item', {
      where: (row) => row.brief_id === locked.id,
    })
    items.value = rows.slice().sort((a, b) => a.seq - b.seq)
  }
  loaded.value = true
})

function visitDate(ms: number | null): string {
  if (ms == null) return 'to be scheduled'
  // A fixed locale and UTC keep this deterministic; the visit date is a day,
  // not a moment, so the timezone subtleties belong to the branch record.
  return new Date(ms).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}
</script>

<template>
  <section
    v-if="gate === 'invalid'"
    data-testid="invite-token-invalid"
    class="gate"
  >
    <h1>This link is not valid</h1>
    <p class="note">
      The link may have been mistyped, or it may have been replaced. Ask your
      contact at the studio for a fresh one.
    </p>
  </section>

  <section
    v-else-if="gate === 'expired'"
    data-testid="invite-token-expired"
    class="gate"
  >
    <h1>This link has expired</h1>
    <p class="note">
      Invitation links stop working after the agreed window. Ask your contact at
      the studio to send a new link, and everything you were promised stays as
      agreed.
    </p>
  </section>

  <section
    v-else-if="gate === 'ok'"
    data-testid="creator-invite"
    class="invite"
  >
    <p class="eyebrow mono">
      Your visit
    </p>
    <h1
      v-if="branch"
      data-testid="invite-branch"
    >
      {{ branch.name }}, {{ branch.city }}
    </h1>
    <p
      data-testid="invite-visit-date"
      class="visit"
    >
      {{ visitDate(visitAt) }}
    </p>

    <h2>What we would love you to capture</h2>
    <ol
      v-if="loaded"
      data-testid="invite-brief-list"
      class="brief-list"
    >
      <li
        v-for="item in items"
        :key="item.id"
        data-testid="invite-brief-item"
        :data-brief-item-id="item.id"
        :data-seq="item.seq"
      >
        {{ item.instruction }}
      </li>
    </ol>

    <p class="note">
      Consent and the upload page land with the creator surface task. The brief
      above is already read through your token, and nothing else is.
    </p>
  </section>
</template>

<style scoped>
.gate,
.invite {
  max-width: 34rem;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.eyebrow {
  font-size: 0.68rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0;
}

h1 {
  font-size: 1.5rem;
  font-weight: 640;
  letter-spacing: -0.02em;
  margin: var(--space-2) 0 var(--space-1);
}

h2 {
  font-size: 1rem;
  font-weight: 620;
  margin: var(--space-5) 0 var(--space-2);
}

.visit {
  color: var(--muted);
  margin: 0;
}

.brief-list {
  margin: 0;
  padding-left: 1.2rem;
  display: grid;
  gap: var(--space-2);
}

.note {
  color: var(--muted);
  font-size: 0.85rem;
  max-width: 62ch;
  margin: var(--space-5) 0 0;
}
</style>
