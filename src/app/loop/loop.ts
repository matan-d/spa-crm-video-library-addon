/**
 * The closed loop, E1 to E5: unmet demand becomes a shot list, becomes
 * delivered footage, becomes a measurable closed gap.
 *
 * Everything here is deterministic and traceable from the data alone:
 * - a gap knows its signals, and each signal names its evidence
 * - a brief item born from a gap carries `origin_gap_id`
 * - a brief born from a scan carries `gap_scan_id`
 * - a closed gap names its `closing_asset_ids` and its before and after counts
 *
 * Two honesty rules with teeth:
 * - An unmapped query term is a vocabulary gap. It produces an insight row,
 *   never a content gap cell, because "editors say words the taxonomy lacks"
 *   and "the library lacks footage" are different problems with different
 *   owners.
 * - A dismissal is keyed by cell signature and suppresses the cell in every
 *   later scan, so a rescan cannot resurrect a gap a human already judged.
 */

import type { ScopedRepo } from '@/data/repo'
import { signatureOf } from '@/data/seed'
import type { Asset, Branch, BriefItem, Gap, Tag } from '@/data/types'
import { parseQuery, tagIndex, type VocabularyEntry } from '../editor/search'

interface QueryLogRow {
  id: string
  text: string
  outcome: string
  created_at: number
}

interface DismissalRow {
  cell_signature: string
}

export interface ScanResult {
  scanId: string
  gapsFound: number
  cellsExamined: number
  vocabularyGaps: string[]
  /** Signatures suppressed by a standing dismissal. */
  suppressed: string[]
}

export interface ScanDeps {
  repo: ScopedRepo
  now: number
  windowDays?: number
}

/** How many zero-result queries make a cell worth a manager's attention. */
const ZERO_RESULT_THRESHOLD = 2

export async function runGapScan(deps: ScanDeps): Promise<ScanResult> {
  const { repo, now } = deps
  const windowDays = deps.windowDays ?? 30
  const windowStart = now - windowDays * 86_400_000

  const [logs, assets, vocabulary, branches, existingGaps, dismissals] = await Promise.all([
    repo.list<QueryLogRow>('search_query_log', {
      where: (row) => (row.created_at as number) >= windowStart,
    }),
    repo.list<Asset>('asset'),
    repo.list<VocabularyEntry>('tag_vocabulary'),
    repo.list<Branch>('branch'),
    repo.list<Gap>('gap'),
    repo.list<DismissalRow>('gap_dismissal'),
  ])

  const dismissed = new Set(dismissals.map((row) => row.cell_signature))
  const openBySignature = new Map(
    existingGaps.filter((gap) => gap.status === 'open').map((gap) => [gap.cell_signature, gap]),
  )

  const knownRooms = new Set<string>()
  for (const branch of branches) {
    for (const room of branch.rooms ?? []) knownRooms.add(room.key)
  }
  for (const asset of assets) {
    if (asset.ai_room) knownRooms.add(asset.ai_room)
  }

  // ---- signal 1: zero-result query clusters -------------------------------
  interface CellDraft {
    facets: Record<string, string>
    zeroResultQueries: string[]
    coverageDeficit: { have: number; target: number; branch: string } | null
  }
  const cells = new Map<string, CellDraft>()
  const vocabularyGapTerms = new Map<string, number>()

  for (const log of logs) {
    if (log.outcome !== 'zero_results') continue
    const parsed = parseQuery(log.text, vocabulary, knownRooms)
    for (const term of parsed.unmapped) {
      vocabularyGapTerms.set(term, (vocabularyGapTerms.get(term) ?? 0) + 1)
    }
    if (parsed.mapped.length === 0) continue
    const facets: Record<string, string> = {}
    for (const term of parsed.mapped) {
      if (!(term.kind in facets)) facets[term.kind] = term.term
    }
    const signature = signatureOf(facets)
    let cell = cells.get(signature)
    if (!cell) {
      cell = { facets, zeroResultQueries: [], coverageDeficit: null }
      cells.set(signature, cell)
    }
    cell.zeroResultQueries.push(log.id)
  }

  // Below threshold, a lone failed query is noise, not demand.
  for (const [signature, cell] of [...cells]) {
    if (cell.zeroResultQueries.length < ZERO_RESULT_THRESHOLD) cells.delete(signature)
  }

  // ---- signal 2: coverage targets per branch room -------------------------
  const publishedByRoom = new Map<string, number>()
  for (const asset of assets) {
    if (!asset.is_published || asset.review_status !== 'approved' || !asset.ai_room) continue
    const key = `${asset.branch_id} ${asset.ai_room}`
    publishedByRoom.set(key, (publishedByRoom.get(key) ?? 0) + 1)
  }
  for (const branch of branches) {
    const targets = (branch as Branch & { target_coverage?: Record<string, number> }).target_coverage
    if (!targets) continue
    for (const [room, target] of Object.entries(targets)) {
      const have = publishedByRoom.get(`${branch.id} ${room}`) ?? 0
      if (have >= target) continue
      const facets = { room, branch: branch.id }
      const signature = signatureOf(facets)
      let cell = cells.get(signature)
      if (!cell) {
        cell = { facets, zeroResultQueries: [], coverageDeficit: null }
        cells.set(signature, cell)
      }
      cell.coverageDeficit = { have, target, branch: branch.id }
    }
  }

  // ---- write the scan and its gaps ----------------------------------------
  const scanId = await repo.create('gap_scan', {
    ran_at: now,
    window_days: windowDays,
    cells_examined: cells.size,
    gaps_found: 0,
  })

  let gapsFound = 0
  const suppressed: string[] = []

  for (const [signature, cell] of cells) {
    if (dismissed.has(signature)) {
      suppressed.push(signature)
      continue
    }

    const signals: Gap['signals'] = []
    if (cell.zeroResultQueries.length > 0) {
      signals.push({
        source: 'zero_result_queries',
        weight: 0.6,
        detail: `${cell.zeroResultQueries.length} in the last ${windowDays} days`,
      })
    }
    if (cell.coverageDeficit) {
      signals.push({
        source: 'coverage_target',
        weight: 0.3,
        detail: `${cell.coverageDeficit.have} of ${cell.coverageDeficit.target} target clips`,
      })
    }

    const score = Math.min(
      1,
      cell.zeroResultQueries.length * 0.12 +
        (cell.coverageDeficit
          ? (0.4 * (cell.coverageDeficit.target - cell.coverageDeficit.have)) /
            cell.coverageDeficit.target
          : 0),
    )
    const severity = score >= 0.8 ? 'critical' : score >= 0.55 ? 'high' : score >= 0.3 ? 'medium' : 'low'

    const existing = openBySignature.get(signature)
    if (existing) {
      // The cell is already an open gap: the rescan refreshes its evidence
      // rather than minting a twin, because the signature is the identity.
      await repo.patch('gap', existing.id, { gap_scan_id: scanId, score, severity, signals })
      gapsFound += 1
      continue
    }

    await repo.create('gap', {
      gap_scan_id: scanId,
      branch_id: cell.facets.branch ?? null,
      cell_signature: signature,
      facets: cell.facets,
      score,
      severity,
      status: 'open',
      signals,
      closing_asset_ids: [],
    })
    gapsFound += 1
  }

  await repo.patch('gap_scan', scanId, { gaps_found: gapsFound })

  // ---- vocabulary gaps become insights, never cells -----------------------
  const vocabularyGaps: string[] = []
  for (const [term, count] of vocabularyGapTerms) {
    if (count < ZERO_RESULT_THRESHOLD) continue
    vocabularyGaps.push(term)
    await repo.create('insight', {
      kind: 'vocabulary_gap',
      term,
      evidence_count: count,
      gap_scan_id: scanId,
      status: 'open',
    })
  }

  return { scanId, gapsFound, cellsExamined: cells.size, vocabularyGaps, suppressed }
}

// ---------------------------------------------------------------------------
// E2: gap-fed brief generation, and E3: the lock
// ---------------------------------------------------------------------------

/** Deterministic instruction phrasing from a cell, no model involved. */
export function instructionFor(facets: Record<string, string>): string {
  const shot = facets.shot_type ?? facets.shot ?? 'clip'
  const where = facets.room ? ` of the ${facets.room.replace(/_/g, ' ')}` : ''
  const subject = facets.subject ? ` featuring ${facets.subject.replace(/_/g, ' ')}` : ''
  const light = facets.light ? `, ${facets.light.replace(/_/g, ' ')}` : ''
  const vibe = facets.vibe ? `, ${facets.vibe.replace(/_/g, ' ')} feel` : ''
  return `${shot}${where}${subject}${light}${vibe}, vertical, natural light`
}

export interface GeneratedBrief {
  briefId: string
  itemIds: string[]
}

/**
 * Builds a draft brief for a collab from the top open gaps. Every generated
 * item carries `origin_gap_id`: the hop the loop's headline claim rests on.
 */
export async function generateBriefFromGaps(input: {
  repo: ScopedRepo
  collabId: string
  scanId: string | null
  maxItems?: number
}): Promise<GeneratedBrief> {
  const { repo, collabId } = input
  const maxItems = input.maxItems ?? 10

  const open = await repo.list<Gap>('gap', { where: (row) => row.status === 'open' })

  /**
   * Explicit requests come first, then inferred gaps fill the remaining slots.
   *
   * A top-N cut over one score list is how a named editor's request gets
   * silently dropped underneath gaps a scan merely inferred, and a request that
   * vanishes without trace is worse than no request feature at all: the editor
   * asked, nothing happened, and nobody can see why. So a gap carrying an
   * `editor_request` signal is never displaced by a scored one. Within each
   * group the order is score then id, which keeps it deterministic.
   */
  const byScore = (a: Gap, b: Gap) => b.score - a.score || a.id.localeCompare(b.id)
  const requested = open
    .filter((gap) => gap.signals.some((signal) => signal.source === 'editor_request'))
    .sort(byScore)
  const inferred = open
    .filter((gap) => !gap.signals.some((signal) => signal.source === 'editor_request'))
    .sort(byScore)

  const gaps = [...requested, ...inferred].slice(0, Math.max(maxItems, requested.length))

  const briefId = await repo.create('brief', {
    collab_id: collabId,
    status: 'draft',
    version: 1,
    locked_at: null,
    gap_scan_id: input.scanId,
    tech_specs_key: 'tech-v1',
    usage_terms_key: 'terms-v1',
    edited_fields: [],
  })

  const itemIds: string[] = []
  for (const [index, gap] of gaps.entries()) {
    const id = await repo.create('brief_item', {
      brief_id: briefId,
      seq: index + 1,
      instruction: instructionFor(gap.facets),
      shot_type: gap.facets.shot_type ?? null,
      room: gap.facets.room ?? null,
      min_takes: 2,
      origin_gap_id: gap.id,
    })
    itemIds.push(id)
  }

  return { briefId, itemIds }
}

export async function lockBrief(repo: ScopedRepo, briefId: string, now: number): Promise<void> {
  await repo.patch('brief', briefId, { status: 'locked', locked_at: now })
}

// ---------------------------------------------------------------------------
// E5: close detection
// ---------------------------------------------------------------------------

/** Does this published asset cover this cell? Facet by facet, all must hold. */
export function assetCoversCell(
  asset: Asset,
  facets: Record<string, string>,
  liveTags: Set<string> | undefined,
): boolean {
  for (const [facet, value] of Object.entries(facets)) {
    if (facet === 'room' && asset.ai_room !== value) return false
    if ((facet === 'shot_type' || facet === 'shot') && asset.ai_shot_type !== value) return false
    if (facet === 'branch' && asset.branch_id !== value) return false
    if (facet === 'subject' && !asset.ai_subjects?.includes(value) && !liveTags?.has(value)) {
      return false
    }
    if ((facet === 'light' || facet === 'vibe') && !liveTags?.has(value)) return false
  }
  return true
}

export interface ClosureResult {
  gapId: string
  before: number
  after: number
  closingAssetIds: string[]
  /**
   * How the closure was established.
   *
   * `confirmed_brief_item` means a human confirmed that a published clip covers
   * the brief item this gap produced, which is the traceable path and the
   * stronger claim. `facet_match` means published footage now matches the cell
   * even though nothing was briefed for it, which is a real way for a gap to
   * close and a weaker claim, because it rests on tags a model proposed.
   */
  via: 'confirmed_brief_item' | 'facet_match'
}

/**
 * Closes every open gap that published, approved footage now covers.
 * `before` is the count recorded in the gap's coverage signal at scan time,
 * `after` is what the library holds now, and the delta is the loop's receipt.
 */
export async function detectClosures(repo: ScopedRepo): Promise<ClosureResult[]> {
  const [gaps, assets, tags, briefItems] = await Promise.all([
    repo.list<Gap>('gap', { where: (row) => row.status === 'open' }),
    repo.list<Asset>('asset'),
    repo.list<Tag>('tag'),
    repo.list<BriefItem>('brief_item'),
  ])
  const byAsset = tagIndex(tags)
  const published = assets.filter(
    (asset) => asset.is_published === true && asset.review_status === 'approved',
  )

  /**
   * Brief items that exist because of a gap, grouped by that gap.
   *
   * This is the loop's own paper trail: a manager fed a gap into a brief, a
   * creator shot it, and a manager confirmed the result covers that item. When
   * that chain is complete the gap is closed by human confirmation, and no tag
   * needs to agree for it to be true. Relying on facet matching alone would
   * leave the flagship claim resting on model output, which is exactly the
   * dependency this product is built to avoid.
   */
  const itemsByGap = new Map<string, string[]>()
  for (const item of briefItems) {
    if (!item.origin_gap_id) continue
    const list = itemsByGap.get(item.origin_gap_id) ?? []
    list.push(item.id)
    itemsByGap.set(item.origin_gap_id, list)
  }

  const closures: ClosureResult[] = []
  for (const gap of gaps) {
    const briefedItems = itemsByGap.get(gap.id) ?? []
    const confirmed = published.filter(
      (asset) =>
        asset.confirmed_brief_item_id != null &&
        briefedItems.includes(asset.confirmed_brief_item_id),
    )

    if (confirmed.length > 0) {
      const closingAssetIds = confirmed.map((asset) => asset.id).sort()
      const coverageSignal = gap.signals.find((signal) => signal.source === 'coverage_target')
      const match = coverageSignal?.detail ? /^(\d+) of (\d+)/.exec(coverageSignal.detail) : null
      await repo.patch('gap', gap.id, { status: 'closed', closing_asset_ids: closingAssetIds })
      closures.push({
        gapId: gap.id,
        before: match ? Number(match[1]) : 0,
        after: confirmed.length,
        closingAssetIds,
        via: 'confirmed_brief_item',
      })
      continue
    }

    const covering = published.filter((asset) =>
      assetCoversCell(asset, gap.facets, byAsset.get(asset.id)),
    )
    if (covering.length === 0) continue

    // A gap with a stated coverage target closes at the target, not at the
    // first clip: one sauna clip against a target of six is progress, not done.
    // A demand-only gap (editor request, query cluster) closes at one, because
    // the demand was for anything at all.
    const coverageSignal = gap.signals.find((signal) => signal.source === 'coverage_target')
    const match = coverageSignal?.detail ? /^(\d+) of (\d+)/.exec(coverageSignal.detail) : null
    const before = match ? Number(match[1]) : 0
    const target = match ? Number(match[2]) : 1
    if (covering.length < target) continue

    const closingAssetIds = covering.map((asset) => asset.id).sort()
    await repo.patch('gap', gap.id, {
      status: 'closed',
      closing_asset_ids: closingAssetIds,
    })
    closures.push({
      gapId: gap.id,
      before,
      after: covering.length,
      closingAssetIds,
      via: 'facet_match',
    })
  }
  return closures
}
