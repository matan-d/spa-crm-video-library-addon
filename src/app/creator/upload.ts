/**
 * The creator upload orchestration: real local pre-flight before anything
 * transfers, then the record and its derivatives.
 *
 * The order is the product's promise, not an implementation detail. Nothing is
 * uploaded, and nothing is even written as an asset row, until the file has
 * been parsed, measured and judged locally. A creator on a train learns that a
 * clip is landscape before spending their data on it.
 *
 * What "upload" means in this build: there is no server (U2), so the transfer
 * step writes the original bytes to OPFS through the platform's byte store and
 * the derivatives to the blob store. Every byte the real product would send to
 * R2 goes through the same `ByteStore` interface, so the adapter swaps and this
 * file does not.
 */

import type { ScopedRepo } from '@/data/repo'
import type { PlatformPort } from '@/platform/port'
import type { IngestPolicy } from '@/platform/capability'
import { ingestFileInput, ingestMedia, decodeSupportFromReport, type IngestResult } from '@/media/ingest'
import type { CapabilityReport } from '@/platform/capability'
import type { ExtractionHost } from '@/media/extract'
import type { PreflightContext } from '@/media/preflight'
import type { HashedAsset } from '@/media/phash'

/**
 * Files a creator's folder always contains and nobody meant to send.
 *
 * Filtered, never failed. A creator who drags their whole camera folder has not
 * made a mistake, and a wall of red rows for sidecars would tell them they had.
 */
const FILTERED_PATTERNS = [
  /^\._/, // macOS resource forks
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^__MACOSX/i,
  /\.(xmp|thm|lrv|aae|sqlite|plist|ini|log)$/i, // sidecars, proxies, app droppings
  // RAW stills. Real cameras write these beside the clips, and we cannot read
  // them: there is no RAW decoder here and inventing dimensions for one would be
  // fabrication. Filtering says "not this one" instead of "you did it wrong".
  /\.(dng|cr2|cr3|nef|arw|orf|rw2|raf|srw|pef|heic|heif)$/i,
]

/**
 * Extensions we will actually attempt. Anything else is filtered rather than
 * ingested and failed, because `notes.txt` in a camera folder is not a delivery
 * attempt and should not occupy a row explaining that it is not a video.
 */
const ACCEPTED_EXTENSIONS = /\.(mp4|m4v|mov|qt|webm|mkv|avi|jpg|jpeg|png|webp|gif|avif)$/i

export function isFilteredFile(name: string): boolean {
  if (FILTERED_PATTERNS.some((pattern) => pattern.test(name))) return true
  // No recognised media extension. The bytes still decide `kind` once a file is
  // accepted (an iPhone writes .MOV for two codecs, so an extension is never
  // evidence about content), but it is a reasonable signal about intent.
  return !ACCEPTED_EXTENSIONS.test(name)
}

export type UploadState =
  | 'preflighting'
  | 'blocked'
  | 'ready'
  | 'storing'
  | 'stored'
  | 'failed'

export interface UploadRow {
  /** Stable per picked file, so a row can be found again after a re-render. */
  key: string
  filename: string
  bytes: number
  state: UploadState
  ingest: IngestResult | null
  /** The asset row, once one exists. Null while pre-flight is still deciding. */
  assetId: string | null
  /** Object URL for the poster or sheet, so the row can show what we derived. */
  previewUrl: string | null
  /** Bytes actually written, for the progress attribute. */
  offsetBytes: number
  error: string | null
}

export interface UploadDeps {
  repo: ScopedRepo
  port: PlatformPort
  report: CapabilityReport
  policy: IngestPolicy
  host: ExtractionHost
  context: PreflightContext
  collabId: string
  deliveryId: string
  branchId: string
  /** Earlier assets in this delivery, for the duplicate rule. */
  priors: HashedAsset[]
  creatorCredit: string
  now: () => number
}

/**
 * Runs pre-flight on one file. Writes nothing: a verdict is a fact about a
 * file, and a file the creator immediately removes should leave no trace.
 */
export async function preflightOne(
  file: File,
  deps: Pick<UploadDeps, 'policy' | 'host' | 'context' | 'priors' | 'report'>,
  creatorStatedCapturedAtMs?: number | null,
): Promise<IngestResult> {
  return ingestMedia(ingestFileInput(file), {
    policy: deps.policy,
    host: deps.host,
    context: deps.context,
    priors: deps.priors,
    decodeSupport: decodeSupportFromReport(deps.report),
    creator_stated_captured_at_ms: creatorStatedCapturedAtMs ?? null,
  })
}

/** The four-valued verdict, as the row's machine readable state. */
export function verdictOf(result: IngestResult | null): 'ok' | 'advisory' | 'blocked' | 'unknown' {
  return result?.preflight?.verdict ?? 'unknown'
}

export function blockingFailCount(result: IngestResult | null): number {
  return result?.preflight?.rollup.blocking_fail ?? 0
}

/**
 * Commits one pre-flighted file: writes the asset row, stores the original
 * bytes, and stores whatever derivatives the extraction actually produced.
 *
 * Refuses a blocked file. A blocked clip that got stored anyway would mean the
 * gate was decoration, and the manager would later find work in the library
 * that never passed the rules.
 */
export async function commitOne(
  file: File,
  result: IngestResult,
  deps: UploadDeps,
): Promise<{ assetId: string; previewUrl: string | null; storedBytes: number }> {
  if (verdictOf(result) === 'blocked') {
    throw new Error('commitOne refused: this file is blocked by pre-flight')
  }

  const container = result.container
  const extraction = result.extraction
  const preflight = result.preflight

  // Derivative state is the honest answer about pixels, decided by whether an
  // extraction produced a sheet, never by whether we hoped it would.
  const hasSheet = !!extraction?.sheet

  const assetId = await deps.repo.create('asset', {
    kind: result.kind,
    delivery_id: deps.deliveryId,
    collab_id: deps.collabId,
    branch_id: deps.branchId,

    filename: result.file.filename,
    bytes: result.file.bytes,
    duration_s: container?.duration_s?.value ?? extraction?.measured?.duration_s ?? null,
    coded_width: container?.coded?.value?.width ?? null,
    coded_height: container?.coded?.value?.height ?? null,
    rotation_deg: container?.rotation_deg?.value ?? 0,
    codec_video: container?.codec_video?.value ?? null,
    has_audio: container?.has_audio?.value ?? null,
    captured_at: preflight?.captured_at_ms ?? null,
    captured_at_source: preflight?.captured_at_source ?? 'unknown',
    gps: container?.gps?.value ?? null,

    client_decodable: hasSheet ? true : extraction?.reason === 'decode_unsupported' ? false : null,
    needs_transcode: extraction?.reason === 'decode_unsupported',
    probe_result: extraction?.reason ?? null,

    preflight_version: preflight?.version ?? 2,
    preflight: preflight?.rules ?? {},

    // Band 3 stays null: no model has looked at this clip. The AI enqueue is a
    // separate step and it refuses without a sheet, which is the no-fabrication
    // rule holding at the only place it can be broken.
    ai_description: null,
    ai_shot_type: null,
    ai_room: null,
    ai_subjects: [],
    ai_quality_score: null,
    ai_framing_score: null,
    ai_confidence: null,
    ai_brand_safety: null,
    ai_matched_brief_item_id: null,
    ai_provenance: 'none',

    review_status: 'pending',
    is_published: false,
    confirmed_brief_item_id: null,
    creator_claimed_brief_item_id: null,
    is_hero: false,
    reject_reason_text: null,
    creator_facing_note: null,
    is_exemplar: false,
    exemplar_note: null,

    media_state: 'bytes_absent',
    derivative_state: hasSheet ? 'ready' : 'none',
    bytes_key: null,
    poster_key: null,
    sheet_key: null,
    phash_primary: extraction?.frame_hashes?.[0] ?? null,
    frame_hashes: extraction?.frame_hashes ?? [],
    used_count: 0,
    download_count: 0,

    creator_credit: deps.creatorCredit,
    usage_scope: null,
  })

  // Derivatives first: they are small, and a record with a poster and no
  // original is a better intermediate state than the reverse.
  let previewUrl: string | null = null
  const patch: Record<string, unknown> = {}

  if (extraction?.sheet) {
    const sheetKey = `sheet/${assetId}.jpg`
    await deps.port.blobs.put(sheetKey, extraction.sheet.blob)
    patch.sheet_key = sheetKey
    await deps.repo.create('contact_sheet', {
      asset_id: assetId,
      blob_key: sheetKey,
      width: extraction.sheet.width,
      height: extraction.sheet.height,
      layout: extraction.sheet.layout,
      frame_count: extraction.sheet.frame_count,
      jpeg_quality: extraction.sheet.jpeg_quality,
      policy_tier: extraction.sheet.policy_tier,
      extractor_path: extraction.sheet.extractor_path,
      generator_version: extraction.sheet.extractor_version,
      phash_version: extraction.sheet.phash_version,
    })
    for (const frame of extraction.frames) {
      await deps.repo.create('asset_frame', {
        asset_id: assetId,
        seq: frame.index,
        planned_t_seconds: frame.planned_t_seconds,
        actual_t_seconds: frame.actual_t_seconds,
        width: frame.width,
        height: frame.height,
        dhash: frame.dhash,
      })
    }
  }

  if (extraction?.poster) {
    const posterKey = `poster/${assetId}.jpg`
    await deps.port.blobs.put(posterKey, extraction.poster.blob)
    patch.poster_key = posterKey
    previewUrl = URL.createObjectURL(extraction.poster.blob)
  } else if (extraction?.sheet) {
    previewUrl = URL.createObjectURL(extraction.sheet.blob)
  }

  // Then the original bytes. A runtime with no OPFS reports unavailable and the
  // record stays `bytes_absent`, which is the same state every record reaches
  // once bytes live in object storage, so nothing downstream is special-cased.
  let storedBytes = 0
  const bytesKey = `original/${assetId}`
  try {
    await deps.port.bytes.put(bytesKey, file)
    patch.bytes_key = bytesKey
    patch.media_state = 'bytes_local'
    storedBytes = file.size
  } catch {
    // Deliberately not fatal, and deliberately not silent: the row says the
    // bytes are absent, and the panel says why.
    patch.media_state = 'bytes_absent'
  }

  if (Object.keys(patch).length > 0) {
    await deps.repo.patch('asset', assetId, patch)
  }

  return { assetId, previewUrl, storedBytes }
}

// ---------------------------------------------------------------------------
// the live checklist against the locked brief
// ---------------------------------------------------------------------------

export interface ChecklistLine {
  briefItemId: string
  seq: number
  instruction: string
  /** How many delivered clips the creator has attributed to this item. */
  deliveredCount: number
  status: 'met' | 'missing'
}

/**
 * The checklist a creator watches while uploading.
 *
 * It counts what the CREATOR said each clip is for, never what a model
 * guessed, because the model has not run and saying otherwise would be
 * fabrication. The manager's diff is the one that later reconciles the two.
 */
export function buildChecklist(
  items: { id: string; seq: number; instruction: string; min_takes: number }[],
  attributions: Map<string, string | null>,
): ChecklistLine[] {
  const counts = new Map<string, number>()
  for (const itemId of attributions.values()) {
    if (!itemId) continue
    counts.set(itemId, (counts.get(itemId) ?? 0) + 1)
  }
  return items
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((item) => {
      const deliveredCount = counts.get(item.id) ?? 0
      return {
        briefItemId: item.id,
        seq: item.seq,
        instruction: item.instruction,
        deliveredCount,
        status: deliveredCount > 0 ? ('met' as const) : ('missing' as const),
      }
    })
}
