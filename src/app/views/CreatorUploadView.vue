<script setup lang="ts">
// The creator upload page: the heart of the creator run.
//
// The order of operations is the product's promise, not an implementation
// detail. Every file is parsed, measured and judged LOCALLY first, and only
// then is anything stored. A creator on mobile data learns that a clip is
// landscape before spending their allowance on it, and a blocked clip is never
// stored at all.
//
// Nothing here talks to IndexedDB, OPFS or the media pipeline directly: the
// store hands over a scoped repository and the platform port, and
// `src/app/creator/upload.ts` owns the orchestration.
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { createBrowserExtractionHost } from '@/media/browser/decode'
import { deriveIngestPolicy } from '@/platform/capability'
import { resolveTechSpec } from '../creator/tech-specs'
import type { PreflightContext } from '@/media/preflight'
import type { HashedAsset } from '@/media/phash'
import type { Asset, Branch, BriefItem, Collab, Delivery } from '@/data/types'
import { useAppStore } from '../store'
import {
  blockingFailCount,
  buildChecklist,
  commitOne,
  isFilteredFile,
  preflightOne,
  verdictOf,
  type ChecklistLine,
  type UploadRow,
} from '../creator/upload'
import PreflightPanel from '../creator/PreflightPanel.vue'

const store = useAppStore()
const route = useRoute()

const collab = shallowRef<Collab | null>(null)
const branch = shallowRef<Branch | null>(null)
const delivery = shallowRef<Delivery | null>(null)
const briefItems = shallowRef<BriefItem[]>([])
const techSpecKey = shallowRef<string | null>(null)
const rows = ref<UploadRow[]>([])
const filteredCount = ref(0)
const submitted = ref<{ count: number } | null>(null)
const resumeState = ref<{ deliveryId: string; count: number } | null>(null)
const priors = shallowRef<HashedAsset[]>([])
const loaded = ref(false)
const busy = ref(false)

/** What the creator says each clip covers. The only honest source pre-review. */
const attributions = ref<Map<string, string | null>>(new Map())

/** The creator-stated capture date, per row, for the one unknown they can answer. */
const statedDates = ref<Map<string, string>>(new Map())

const host = createBrowserExtractionHost()

onMounted(async () => {
  const repo = store.repo
  const session = store.session
  const ctx = store.ctx
  if (!repo || !session || !ctx || session.kind !== 'creator_token') return

  collab.value = (await repo.get<Collab>('collab', session.collab_id!)) ?? null
  if (collab.value) {
    branch.value = (await repo.get<Branch>('branch', collab.value.branch_id)) ?? null
  }

  const briefs = await repo.list<{
    id: string
    collab_id: string
    status: string
    tech_specs_key: string | null
  }>('brief')
  const locked = briefs.find((row) => row.status === 'locked') ?? briefs[0]
  if (locked) {
    techSpecKey.value = locked.tech_specs_key ?? null
    briefItems.value = (
      await repo.list<BriefItem>('brief_item', { where: (row) => row.brief_id === locked.id })
    )
      .slice()
      .sort((a, b) => a.seq - b.seq)
  }

  // A delivery is one to many with the collab, so reopening the link resumes
  // the same delivery rather than starting a second one. That is the whole
  // reason the shape is one to many.
  const existing = await repo.list<Delivery>('delivery', {
    where: (row) => row.collab_id === session.collab_id,
  })
  const open = existing.find((row) => row.state !== 'reviewed') ?? existing[0]
  if (open) {
    delivery.value = open
    const already = await repo.list<Asset>('asset', {
      where: (row) => row.delivery_id === open.id,
    })
    priors.value = already.map((asset) => ({
      asset_id: asset.id,
      frame_hashes: asset.frame_hashes ?? [],
    }))
    if (already.length > 0) {
      resumeState.value = { deliveryId: open.id, count: already.length }
    }
    for (const asset of already) {
      const claimed = (asset as Asset & { creator_claimed_brief_item_id?: string | null })
        .creator_claimed_brief_item_id
      if (claimed) attributions.value.set(asset.id, claimed)
    }
  } else {
    const id = await repo.create('delivery', {
      collab_id: session.collab_id,
      state: 'open',
      submitted_at: null,
      ingest_policy: null,
      nudge_draft_text: null,
      nudge_sent_at: null,
    })
    delivery.value = (await repo.get<Delivery>('delivery', id)) ?? null
  }

  loaded.value = true
})

/**
 * The pre-flight context: the agreed spec, the visit, and the branch.
 *
 * Every value is read from the records rather than typed in here. The thresholds
 * come from the spec key the brief names, so what a creator is judged against is
 * what was agreed with them and not what a component author assumed. The branch
 * is null rather than a fallback coordinate when we cannot see one: a missing
 * branch must make `near_branch` unknown, and defaulting to 0,0 would instead
 * measure the distance to the Gulf of Guinea and fail every clip. That is not a
 * hypothetical, it is the bug this comment replaced.
 */
function preflightContext(): PreflightContext {
  const b = branch.value
  const spec = resolveTechSpec(techSpecKey.value)
  const hasCoordinates = !!b && typeof b.lat === 'number' && typeof b.lng === 'number'
  return {
    thresholds: spec.thresholds,
    visit_date: collab.value?.visit_at
      ? new Date(collab.value.visit_at).toISOString().slice(0, 10)
      : new Date(store.ctx!.clock.now()).toISOString().slice(0, 10),
    branch: hasCoordinates ? { branch_id: b!.id, lat: b!.lat as number, lng: b!.lng as number } : null,
    comparison_set: 'delivery',
    dhash_hamming_threshold: 4,
  } as PreflightContext
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  input.value = ''
  await ingest(picked)
}

/**
 * Runs pre-flight on each picked file, then stores the ones that are allowed.
 *
 * Sequential rather than parallel: a phone decoding five clips at once is a
 * phone that thermally throttles and produces worse sheets, and the ingest
 * policy's `decodeConcurrency` exists to be honoured rather than ignored here.
 */
async function ingest(picked: File[]) {
  const repo = store.repo
  const ctx = store.ctx
  if (!repo || !ctx || !delivery.value || !collab.value) return

  // Junk is filtered and counted, never failed. A creator who drags a folder
  // has not made a mistake, and a wall of red rows for sidecar files would say
  // they had.
  const filtered = picked.filter((file) => isFilteredFile(file.name))
  const candidates = picked.filter((file) => !isFilteredFile(file.name))
  if (filtered.length > 0) filteredCount.value += filtered.length

  busy.value = true
  const policy = deriveIngestPolicy(ctx.platform.report)
  const context = preflightContext()

  for (const file of candidates) {
    const key = `${file.name}:${file.size}:${rows.value.length}`
    const row: UploadRow = {
      key,
      filename: file.name,
      bytes: file.size,
      state: 'preflighting',
      ingest: null,
      assetId: null,
      previewUrl: null,
      offsetBytes: 0,
      error: null,
    }
    rows.value = [...rows.value, row]

    try {
      const result = await preflightOne(file, {
        policy,
        host,
        context,
        priors: priors.value,
        report: ctx.platform.report,
      })
      row.ingest = result

      if (verdictOf(result) === 'blocked') {
        // Stays listed, reads blocked, names the rule. Never silently dropped:
        // a creator who cannot see the refusal cannot fix it.
        row.state = 'blocked'
        rows.value = [...rows.value]
        continue
      }

      row.state = 'storing'
      rows.value = [...rows.value]

      const committed = await commitOne(file, result, {
        repo,
        port: ctx.platform.port,
        report: ctx.platform.report,
        policy,
        host,
        context,
        collabId: collab.value.id,
        deliveryId: delivery.value.id,
        branchId: collab.value.branch_id,
        priors: priors.value,
        creatorCredit: creatorCredit(),
        now: () => ctx.clock.now(),
      })

      row.assetId = committed.assetId
      row.previewUrl = committed.previewUrl
      row.offsetBytes = committed.storedBytes
      row.state = 'stored'

      // Each stored clip joins the comparison set, so the next file in this
      // same batch can be detected as its duplicate.
      priors.value = [
        ...priors.value,
        { asset_id: committed.assetId, frame_hashes: result.extraction?.frame_hashes ?? [] },
      ]
      rows.value = [...rows.value]
    } catch (error) {
      row.state = 'failed'
      row.error = error instanceof Error ? error.message : String(error)
      rows.value = [...rows.value]
    }
  }
  busy.value = false
}

function creatorCredit(): string {
  return collab.value ? 'Creator via invite link' : 'Unknown creator'
}

/** Only for the one unknown a creator can answer: the capture date. */
async function confirmDate(row: UploadRow) {
  const repo = store.repo
  const raw = statedDates.value.get(row.key)
  if (!repo || !raw || !row.assetId) return
  const ms = Date.parse(`${raw}T12:00:00Z`)
  if (Number.isNaN(ms)) return
  await repo.patch('asset', row.assetId, {
    captured_at: ms,
    // Labelled as the creator's word, never promoted to a verified source.
    captured_at_source: 'creator_stated',
  })
  statedDates.value.delete(row.key)
  statedDates.value = new Map(statedDates.value)
}

async function attribute(row: UploadRow, briefItemId: string) {
  const repo = store.repo
  if (!repo || !row.assetId) return
  const value = briefItemId === 'none' ? null : briefItemId
  attributions.value.set(row.assetId, value)
  attributions.value = new Map(attributions.value)
  // The creator's claim is recorded on the row so the manager's diff can
  // reconcile it later. It is their statement, not a confirmed match: the
  // manager's confirmation is a separate field and a separate decision.
  await repo.patch('asset', row.assetId, { creator_claimed_brief_item_id: value })
}

const checklist = computed<ChecklistLine[]>(() =>
  buildChecklist(briefItems.value, attributions.value),
)

const storedRows = computed(() => rows.value.filter((row) => row.state === 'stored'))

async function submit() {
  const repo = store.repo
  const ctx = store.ctx
  if (!repo || !ctx || !delivery.value) return
  await repo.patch('delivery', delivery.value.id, {
    state: 'submitted',
    submitted_at: ctx.clock.now(),
  })
  const total = await repo.count('asset', {
    where: (row) => row.delivery_id === delivery.value!.id,
  })
  submitted.value = { count: total }
}

const capturedDateUnknown = (row: UploadRow): boolean =>
  row.ingest?.preflight?.rules.capture_date?.status === 'unknown'

void route
</script>

<template>
  <section
    v-if="loaded"
    data-testid="creator-upload"
    class="upload"
    :data-delivery-id="delivery?.id"
  >
    <header class="head">
      <h1>Send us your clips</h1>
      <p class="note">
        Everything is checked on your phone first, before anything uploads. If a
        clip will not work we tell you here, not later.
      </p>
    </header>

    <p
      v-if="resumeState"
      data-testid="upload-resume-banner"
      class="resume"
      :data-delivery-id="resumeState.deliveryId"
      :data-count="resumeState.count"
    >
      You have already sent {{ resumeState.count }} clip(s). Anything you add now
      joins the same delivery.
    </p>

    <div
      data-testid="upload-dropzone"
      class="dropzone"
    >
      <label class="pick">
        <span class="pick-label">Choose clips</span>
        <input
          data-testid="upload-file-input"
          class="file-input"
          type="file"
          multiple
          accept="video/*,image/*"
          @change="onFiles"
        >
      </label>
      <p class="dropzone-note">
        Vertical clips, as filmed. We do not need you to edit anything.
      </p>
    </div>

    <p
      v-if="filteredCount > 0"
      data-testid="upload-filtered-notice"
      class="filtered"
      :data-count="filteredCount"
    >
      {{ filteredCount }} file(s) in that selection were not clips (sidecars,
      previews or system files). We left them out rather than failing them.
    </p>

    <ul
      data-testid="upload-file-list"
      class="file-list"
    >
      <li
        v-for="row in rows"
        :key="row.key"
        data-testid="upload-file-row"
        class="file-row"
        :class="`state-${row.state}`"
        :data-file-name="row.filename"
        :data-asset-id="row.assetId ?? undefined"
        :data-upload-state="row.state"
        :data-media-state="row.state === 'stored' ? 'bytes_local' : undefined"
      >
        <div class="row-head">
          <img
            v-if="row.previewUrl"
            data-testid="upload-file-thumb"
            class="thumb"
            :src="row.previewUrl"
            :alt="`Frames we pulled from ${row.filename}`"
          >
          <div
            v-else
            data-testid="placeholder-tile"
            class="thumb thumb-absent"
            aria-hidden="true"
          />

          <div class="row-main">
            <span class="filename">{{ row.filename }}</span>
            <span
              data-testid="upload-file-verdict"
              class="verdict mono"
              :data-verdict="verdictOf(row.ingest)"
              :data-count="blockingFailCount(row.ingest)"
            >{{ verdictOf(row.ingest) }}</span>
            <span
              data-testid="upload-file-progress"
              class="progress mono"
              :data-offset-bytes="row.offsetBytes"
            >{{ row.state }}</span>
          </div>
        </div>

        <p
          v-if="row.ingest?.extraction?.placeholder"
          data-testid="no-preview-chip"
          class="no-preview"
          :data-reason="row.ingest.extraction.placeholder.reason"
        >
          {{ row.ingest.extraction.placeholder.headline }}
          <template v-if="row.ingest.extraction.placeholder.remedy">
            {{ row.ingest.extraction.placeholder.remedy }}
          </template>
        </p>

        <PreflightPanel
          v-if="row.ingest?.preflight"
          :preflight="row.ingest.preflight"
          audience="creator"
        />

        <p
          v-if="row.state === 'blocked'"
          data-testid="upload-blocked-explanation"
          class="blocked-note"
        >
          We did not send this one. Nothing is wrong with your filming, it just
          does not fit what was agreed for this shoot.
        </p>

        <!-- The ONE unknown a creator can act on. Everything else unknown stays
             silent, because surfacing an unanswerable question reads as a
             problem they caused (QC-MEDIA-065). -->
        <div
          v-if="capturedDateUnknown(row) && row.assetId"
          data-testid="capture-date-prompt"
          class="date-prompt"
        >
          <label>
            <span>When did you film this?</span>
            <input
              data-testid="capture-date-input"
              type="date"
              :value="statedDates.get(row.key) ?? ''"
              @input="statedDates.set(row.key, ($event.target as HTMLInputElement).value)"
            >
          </label>
          <button
            type="button"
            data-testid="capture-date-confirm"
            class="small"
            @click="confirmDate(row)"
          >
            Save
          </button>
        </div>

        <label
          v-if="row.assetId && briefItems.length"
          class="attribute"
        >
          <span>Which shot is this?</span>
          <select
            :value="attributions.get(row.assetId) ?? 'none'"
            @change="attribute(row, ($event.target as HTMLSelectElement).value)"
          >
            <option value="none">Something extra</option>
            <option
              v-for="item in briefItems"
              :key="item.id"
              :value="item.id"
            >
              {{ item.seq }}. {{ item.instruction }}
            </option>
          </select>
        </label>
      </li>
    </ul>

    <section
      data-testid="creator-checklist"
      class="checklist"
    >
      <h2>The shot list</h2>
      <p
        data-testid="checklist-progress"
        class="mono progress-line"
        :data-count="checklist.filter((line) => line.status === 'met').length"
        :data-total="checklist.length"
      >
        {{ checklist.filter((line) => line.status === 'met').length }} of
        {{ checklist.length }} covered
      </p>
      <ol class="checklist-items">
        <li
          v-for="line in checklist"
          :key="line.briefItemId"
          data-testid="checklist-item"
          class="checklist-item"
          :data-brief-item-id="line.briefItemId"
          :data-status="line.status"
          :data-delivered-count="line.deliveredCount"
        >
          <span class="mark">{{ line.status === 'met' ? '&check;' : '&ndash;' }}</span>
          {{ line.instruction }}
          <span
            v-if="line.deliveredCount > 1"
            class="takes mono"
          >{{ line.deliveredCount }} takes</span>
        </li>
      </ol>
    </section>

    <footer class="submit-row">
      <button
        type="button"
        data-testid="upload-submit"
        class="submit"
        :disabled="busy || storedRows.length === 0"
        @click="submit"
      >
        Send {{ storedRows.length }} clip(s)
      </button>
      <p
        v-if="submitted"
        data-testid="upload-submit-confirmation"
        class="confirmation"
        :data-delivery-id="delivery?.id"
        :data-count="submitted.count"
      >
        Got them, thank you. We have {{ submitted.count }} clip(s) from you and
        the studio will take it from here.
      </p>
    </footer>
  </section>
</template>

<style scoped>
.upload {
  max-width: 34rem;
  margin: 0 auto;
  padding: var(--space-5) var(--space-4) var(--space-6);
  display: grid;
  gap: var(--space-4);
}

h1 {
  font-size: 1.4rem;
  font-weight: 640;
  letter-spacing: -0.01em;
  margin: 0 0 var(--space-2);
}

h2 {
  font-size: 0.95rem;
  font-weight: 640;
  margin: 0 0 var(--space-2);
}

.note,
.dropzone-note {
  color: var(--muted);
  font-size: 0.85rem;
  margin: 0;
}

.resume {
  margin: 0;
  font-size: 0.85rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}

.dropzone {
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-2);
  justify-items: start;
}

.pick {
  display: inline-block;
}

.pick-label {
  display: inline-block;
  background: var(--human);
  color: var(--surface);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-4);
  font-size: 0.9rem;
  cursor: pointer;
}

/* Kept in the layout rather than display:none, because a hidden input is not
   settable by some automation and not focusable by a screen reader. */
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.filtered {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
  border-left: 2px solid var(--line);
  padding-left: var(--space-2);
}

.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-3);
}

.file-row {
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-3);
  display: grid;
  gap: var(--space-2);
}

.file-row.state-stored {
  border-left-color: var(--good);
}

.file-row.state-blocked {
  border-left-color: var(--critical);
}

.file-row.state-preflighting,
.file-row.state-storing {
  border-left-color: var(--line);
}

.row-head {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.thumb {
  width: 92px;
  border-radius: var(--radius);
  background: var(--surface-2);
}

.thumb-absent {
  height: 60px;
}

.row-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.filename {
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

.verdict,
.progress {
  font-size: 0.68rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.no-preview {
  margin: 0;
  font-size: 0.78rem;
  color: var(--muted);
  background: var(--surface-2);
  border-radius: var(--radius);
  padding: var(--space-2);
}

.blocked-note {
  margin: 0;
  font-size: 0.8rem;
  color: var(--critical);
}

.date-prompt {
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
  flex-wrap: wrap;
  background: var(--surface-2);
  border-radius: var(--radius);
  padding: var(--space-2);
}

.date-prompt label {
  display: grid;
  gap: 2px;
  font-size: 0.78rem;
  color: var(--muted);
}

.attribute {
  display: grid;
  gap: 2px;
  font-size: 0.78rem;
  color: var(--muted);
}

input[type='date'],
select {
  font: inherit;
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
}

.small {
  appearance: none;
  font: inherit;
  font-size: 0.78rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
}

.checklist {
  border-top: 1px solid var(--line);
  padding-top: var(--space-3);
}

.progress-line {
  margin: 0 0 var(--space-2);
  font-size: 0.75rem;
  color: var(--muted);
}

.checklist-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
}

.checklist-item {
  display: grid;
  grid-template-columns: 1.1rem 1fr auto;
  gap: var(--space-2);
  align-items: baseline;
  font-size: 0.82rem;
}

.checklist-item[data-status='met'] .mark {
  color: var(--good);
}

.checklist-item[data-status='missing'] .mark {
  color: var(--muted);
}

.takes {
  font-size: 0.68rem;
  color: var(--muted);
}

.submit-row {
  display: grid;
  gap: var(--space-2);
}

.submit {
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

.submit:disabled {
  background: var(--surface-2);
  border-color: var(--line);
  color: var(--muted);
  cursor: not-allowed;
}

.confirmation {
  margin: 0;
  font-size: 0.85rem;
  color: var(--human);
  background: var(--human-soft);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}
</style>
