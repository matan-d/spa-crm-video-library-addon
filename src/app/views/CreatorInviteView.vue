<script setup lang="ts">
// The creator's front door. The route guard has already resolved the token by
// the time this renders, so this view only ever sees a settled gate: ok,
// expired, or invalid. Consent capture and the upload page land with the
// creator surface task; the brief a creator is being asked for is already real
// and already scoped, because it is read through the token session.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
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
  usage_terms_text: string | null
  consent_text_version: string | null
}
interface ConsentRow {
  id: string
  collab_id: string
  consent_text_version: string
  accepted_at: number
  created_at: number
}
interface BranchRow {
  id: string
  name: string
  city: string
}

const store = useAppStore()
const router = useRouter()
const gate = computed(() => store.creatorGate)

function continueToUpload() {
  router.push(`/c/${store.creatorToken}/upload`)
}

const branch = ref<BranchRow | null>(null)
const collab = ref<CollabRow | null>(null)
const visitAt = ref<number | null>(null)
const items = ref<BriefItemRow[]>([])
const consent = ref<ConsentRow | null>(null)
const declined = ref(false)
const loaded = ref(false)

onMounted(async () => {
  const repo = store.repo
  const session = store.session
  if (!repo || !session || session.kind !== 'creator_token') return

  const collabRow = session.collab_id
    ? await repo.get<CollabRow>('collab', session.collab_id)
    : undefined
  if (collabRow) {
    collab.value = collabRow
    visitAt.value = collabRow.visit_at
    branch.value = (await repo.get<BranchRow>('branch', collabRow.branch_id)) ?? null
  }

  // The consent record is the source of truth for whether THIS creator
  // accepted, queried directly rather than trusting the denormalised fields on
  // the collab: those are a projection sync maintains, and a projection must
  // never be what gates a legal record's creation.
  const records = await repo.list<ConsentRow>('consent_record', {
    where: (row) => row.collab_id === session.collab_id,
  })
  consent.value = records.sort((a, b) => b.created_at - a.created_at)[0] ?? null

  // A creator who already agreed does not get asked again. Re-presenting a
  // signed agreement invites a second record for the same consent, and the
  // record is supposed to be immutable and singular. They go straight to the
  // page that shows what they have already sent.
  if (consent.value) {
    void router.replace(`/c/${store.creatorToken}/upload`)
    return
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

/**
 * Acceptance writes an immutable, versioned record.
 * ip hash and user agent belong to the server in the real product; this build
 * has no server, so they are stored as null rather than read from the browser,
 * because reading them here would both break the determinism rule and imply a
 * verification the demo cannot perform.
 */
async function acceptConsent() {
  const repo = store.repo
  const session = store.session
  const clock = store.ctx?.clock
  if (!repo || !session || !clock || !collab.value || consent.value) return
  const id = await repo.create('consent_record', {
    collab_id: session.collab_id,
    token_id: session.token_id,
    consent_text_version: collab.value.consent_text_version ?? 'consent-v1',
    terms_text_snapshot: collab.value.usage_terms_text,
    accepted_at: clock.now(),
    consent_ip_hash: null,
    consent_user_agent: null,
  })
  consent.value = (await repo.get<ConsentRow>('consent_record', id)) ?? null
}

function declineConsent() {
  declined.value = true
}

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

    <section
      data-testid="invite-how-to-shoot"
      class="how-to"
    >
      <h2>How to shoot it</h2>
      <ul>
        <li>Vertical, at the highest resolution your phone offers.</li>
        <li
          data-testid="invite-most-compatible-instruction"
        >
          iPhone: in Settings, Camera, Formats, choose <strong>Most Compatible</strong>
          before shooting. It is required, not a nicety: the other setting
          produces files we cannot preview in the browser.
        </li>
        <li>Natural light where you can, and steady hands over fancy moves.</li>
      </ul>
    </section>

    <section
      v-if="collab?.usage_terms_text"
      data-testid="consent-panel"
      class="consent"
      :data-consent-version="collab.consent_text_version ?? 'consent-v1'"
    >
      <h2>Usage agreement</h2>
      <p
        data-testid="consent-text"
        class="consent-text"
        :data-consent-version="collab.consent_text_version ?? 'consent-v1'"
      >
        {{ collab.usage_terms_text }}
      </p>

      <p
        v-if="consent"
        data-testid="consent-recorded"
        class="consent-recorded"
        :data-consent-id="consent.id"
        :data-consent-version="consent.consent_text_version"
        :data-accepted-at="consent.accepted_at"
      >
        Accepted. Your agreement is recorded and versioned, and it will not
        change underneath you.
      </p>
      <p
        v-else-if="declined"
        class="consent-declined"
      >
        No problem, nothing is recorded. If you change your mind this page will
        be here, and if not, just let your contact at the studio know.
      </p>
      <div
        v-else
        class="consent-actions"
      >
        <button
          type="button"
          data-testid="consent-decline"
          class="consent-button"
          @click="declineConsent"
        >
          Not now
        </button>
        <button
          type="button"
          data-testid="consent-accept"
          class="consent-button primary"
          @click="acceptConsent"
        >
          I agree
        </button>
      </div>
    </section>

    <button
      v-if="consent"
      type="button"
      data-testid="invite-continue"
      class="continue"
      @click="continueToUpload"
    >
      Continue to sending your clips
    </button>
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

.how-to ul {
  margin: 0;
  padding-left: 1.2rem;
  display: grid;
  gap: var(--space-1);
  font-size: 0.88rem;
}

.consent {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-4);
  margin-top: var(--space-5);
  display: grid;
  gap: var(--space-3);
}

.consent h2 {
  margin: 0;
}

.consent-text {
  margin: 0;
  font-size: 0.85rem;
}

.consent-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.consent-button {
  appearance: none;
  font: inherit;
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
}

.consent-button.primary {
  background: var(--human);
  border-color: var(--human);
  color: var(--surface);
}

.consent-recorded {
  margin: 0;
  font-size: 0.85rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: var(--space-2);
}

.consent-declined {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
}

.continue {
  margin-top: var(--space-4);
  appearance: none;
  font: inherit;
  font-size: 0.95rem;
  border: 1px solid var(--human);
  border-radius: var(--radius);
  background: var(--human);
  color: var(--surface);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
}
</style>
