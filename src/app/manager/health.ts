/**
 * Data health: the direct answer to "is any of this real".
 *
 * Each row is an invariant the product claims to keep, computed from the rows
 * actually on disk, never from what the code intended. A failing row here is a
 * defect by definition, which is the point: the panel is the standing audit a
 * reviewer can read as data.
 */

import type { AiRun, Asset } from '@/data/types'

export interface HealthRow {
  id: string
  label: string
  status: 'pass' | 'fail'
  count: number
  reason: string | null
}

export interface ProviderCount {
  provider: string
  count: number
}

export function computeHealth(input: {
  assets: Asset[]
  aiRuns: AiRun[]
  outboxDepth: number
}): { rows: HealthRow[]; providers: ProviderCount[] } {
  const { assets, aiRuns } = input
  const rows: HealthRow[] = []

  // No fabrication: an AI field on a clip without a contact sheet is the least
  // detectable and most damaging failure in this product.
  const fabricated = assets.filter(
    (asset) =>
      asset.sheet_key == null &&
      (asset.ai_description != null ||
        asset.ai_shot_type != null ||
        asset.ai_quality_score != null ||
        asset.ai_matched_brief_item_id != null ||
        asset.ai_provenance !== 'none'),
  )
  rows.push({
    id: 'no_fabrication',
    label: 'No AI output on clips without a contact sheet',
    status: fabricated.length === 0 ? 'pass' : 'fail',
    count: fabricated.length,
    reason: fabricated.length ? `${fabricated.length} clip(s) carry AI fields with no sheet` : null,
  })

  // Provenance cannot lie: a mock run may never record a model id.
  const lyingMocks = aiRuns.filter((run) => run.provider === 'mock' && run.model_id != null)
  rows.push({
    id: 'mock_never_claims_model',
    label: 'No mock run claims a model id',
    status: lyingMocks.length === 0 ? 'pass' : 'fail',
    count: lyingMocks.length,
    reason: lyingMocks.length ? `${lyingMocks.length} mock run(s) carry a model_id` : null,
  })

  // Published implies approved: the library is reviewed work only.
  const unreviewed = assets.filter(
    (asset) => asset.is_published === true && asset.review_status !== 'approved',
  )
  rows.push({
    id: 'published_implies_approved',
    label: 'Everything published passed review',
    status: unreviewed.length === 0 ? 'pass' : 'fail',
    count: unreviewed.length,
    reason: unreviewed.length ? `${unreviewed.length} published clip(s) not approved` : null,
  })

  // The boolean mirrors the indexes rely on must agree with their booleans.
  const brokenMirrors = assets.filter(
    (asset) =>
      (asset.is_published ? 1 : 0) !== asset.is_published_i ||
      (asset.is_exemplar ? 1 : 0) !== asset.is_exemplar_i,
  )
  rows.push({
    id: 'boolean_mirrors',
    label: 'Indexed boolean mirrors agree with their booleans',
    status: brokenMirrors.length === 0 ? 'pass' : 'fail',
    count: brokenMirrors.length,
    reason: brokenMirrors.length ? `${brokenMirrors.length} row(s) with a stale _i mirror` : null,
  })

  // Informational: pending outbox depth, so "unsynced work" is a number.
  rows.push({
    id: 'outbox_pending',
    label: 'Outbox entries awaiting sync',
    status: 'pass',
    count: input.outboxDepth,
    reason: null,
  })

  const providerCounts = new Map<string, number>()
  for (const run of aiRuns) {
    providerCounts.set(run.provider, (providerCounts.get(run.provider) ?? 0) + 1)
  }
  const providers = ['live', 'replay', 'mock'].map((provider) => ({
    provider,
    count: providerCounts.get(provider) ?? 0,
  }))

  return { rows, providers }
}
