/**
 * The manager's triage logic: bucketing deliveries by what is actionable, and
 * the promise-versus-delivered diff. Pure functions, so the views stay thin
 * and the rules are testable without a DOM.
 *
 * The diff has three buckets, not two, per the architecture review's
 * correction to screen 2: matched, extras (no confirmed item and a vision run
 * exists), and awaiting derivatives (no sheet, so no vision run, so counting
 * the clip as met or missed would be wrong in both directions). Items get a
 * fourth status for the same reason: indeterminate.
 *
 * Coverage arithmetic is where the AI over-claim lives. An AI-proposed match
 * counts only while the clip is still undecided: it renders amber and is
 * labelled provisional. The moment a human decides the clip, the human's
 * confirmation (or its absence) is the truth and the AI claim stops counting.
 * The seed contains a clip whose AI match points at a brief item nothing
 * covers, so the diff genuinely moves from 8 of 10 to 7 of 10 as the human
 * works through the queue. That movement is the feature.
 */

import type { Asset, BriefItem, Delivery } from '@/data/types'

export type TriageBucket = 'needs_review' | 'awaiting_derivatives' | 'blocked' | 'done'

export interface TriagedDelivery {
  delivery: Delivery
  bucket: TriageBucket
  /** Clips still awaiting a human decision. */
  pendingCount: number
  assetCount: number
}

/** True when a blocking pre-flight rule failed. Advisory fails do not block. */
function hasBlockingFail(asset: Asset): boolean {
  return Object.values(asset.preflight ?? {}).some(
    (rule) => rule.blocking && rule.status === 'fail',
  )
}

function isAwaitingDerivatives(asset: Asset): boolean {
  return asset.derivative_state === 'none'
}

/**
 * One bucket per delivery, by the most actionable state it contains.
 * Blocked outranks review because a blocked clip needs a different human than
 * the reviewer; awaiting derivatives outranks done because "nothing to do YET"
 * and "nothing to do" must not look alike.
 */
export function triageDelivery(delivery: Delivery, assets: Asset[]): TriagedDelivery {
  const own = assets.filter((asset) => asset.delivery_id === delivery.id)
  const pending = own.filter((asset) => asset.review_status === 'pending')

  let bucket: TriageBucket = 'done'
  if (pending.some((asset) => asset.ai_brand_safety === 'blocked' || hasBlockingFail(asset))) {
    bucket = 'blocked'
  } else if (pending.some((asset) => !isAwaitingDerivatives(asset))) {
    bucket = 'needs_review'
  } else if (pending.length > 0) {
    bucket = 'awaiting_derivatives'
  }

  return { delivery, bucket, pendingCount: pending.length, assetCount: own.length }
}

export const TRIAGE_BUCKET_ORDER: TriageBucket[] = [
  'needs_review',
  'awaiting_derivatives',
  'blocked',
  'done',
]

// ---------------------------------------------------------------------------
// the promise versus delivered diff
// ---------------------------------------------------------------------------

export type DiffItemStatus = 'met' | 'missing' | 'indeterminate'

export interface DeliveredEntry {
  asset: Asset
  /** 'human' for a confirmed match, 'ai' for a provisional one. */
  provenance: 'human' | 'ai'
}

export interface DiffItem {
  item: BriefItem
  status: DiffItemStatus
  delivered: DeliveredEntry[]
  /**
   * Model matches a human has already overruled: the clip's confirmation went
   * elsewhere, or the clip was decided without confirming this item. Rendered
   * struck through in amber, because an over-claim that silently vanishes
   * teaches nobody that the model over-claims.
   */
  overClaims: Asset[]
}

export interface DeliveryDiff {
  items: DiffItem[]
  /** Met items over total items, as a rounded percentage. */
  coveragePct: number
  metCount: number
  totalCount: number
  extras: Asset[]
  awaitingDerivatives: Asset[]
}

/**
 * An AI match is provisional evidence exactly while the clip is undecided.
 * A sheetless clip can make no claim at all: without derivatives there was no
 * vision run, so a match field on such a row is a defect, not evidence.
 */
function aiMatchStands(asset: Asset): boolean {
  return (
    asset.review_status === 'pending' &&
    asset.confirmed_brief_item_id == null &&
    !isAwaitingDerivatives(asset)
  )
}

export function computeDiff(items: BriefItem[], assets: Asset[]): DeliveryDiff {
  const ordered = items.slice().sort((a, b) => a.seq - b.seq)

  const diffItems: DiffItem[] = ordered.map((item) => {
    const confirmed = assets.filter((asset) => asset.confirmed_brief_item_id === item.id)
    const provisional = assets.filter(
      (asset) => asset.ai_matched_brief_item_id === item.id && aiMatchStands(asset),
    )
    const delivered: DeliveredEntry[] = [
      ...confirmed.map((asset) => ({ asset, provenance: 'human' as const })),
      ...provisional.map((asset) => ({ asset, provenance: 'ai' as const })),
    ]
    // A correction, not just a lapsed claim: the human confirmed the same
    // clip to a DIFFERENT item. A clip rejected for quality does not belong
    // here, because its match was never judged wrong.
    const overClaims = assets.filter(
      (asset) =>
        asset.ai_matched_brief_item_id === item.id &&
        asset.confirmed_brief_item_id != null &&
        asset.confirmed_brief_item_id !== item.id,
    )
    return {
      item,
      status: delivered.length > 0 ? ('met' as const) : ('missing' as const),
      delivered,
      overClaims,
    }
  })

  const awaitingDerivatives = assets.filter(isAwaitingDerivatives)

  // An unmet item stays honest: while clips without sheets exist in this
  // delivery, "missing" is a claim the evidence cannot support yet.
  if (awaitingDerivatives.length > 0) {
    for (const diffItem of diffItems) {
      if (diffItem.status === 'missing') diffItem.status = 'indeterminate'
    }
  }

  const extras = assets.filter(
    (asset) =>
      !isAwaitingDerivatives(asset) &&
      asset.confirmed_brief_item_id == null &&
      (asset.review_status !== 'pending' || asset.ai_matched_brief_item_id == null),
  )

  const metCount = diffItems.filter((diffItem) => diffItem.status === 'met').length
  const totalCount = diffItems.length

  return {
    items: diffItems,
    metCount,
    totalCount,
    coveragePct: totalCount === 0 ? 0 : Math.round((metCount / totalCount) * 100),
    extras,
    awaitingDerivatives,
  }
}
