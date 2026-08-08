/**
 * Shooting specs, resolved from the key a brief names.
 *
 * `brief.tech_specs_key` exists so a brief records WHICH spec was agreed rather
 * than copying numbers that later drift. This module is the resolver, and it is
 * the single source those numbers come from: the creator's local pre-flight, the
 * manager's review panel and the committed fixture manifest all read the same
 * spec, so a clip judged on a phone and the same clip judged in a test cannot
 * disagree.
 *
 * The values are deliberately identical to `public/fixtures/manifest.json`
 * `context.rule_thresholds`. That file is a sha256 verified contract asserting
 * what our parser must conclude about sixteen engineered files, and if the app
 * shipped different thresholds then every one of those assertions would describe
 * a product nobody runs.
 */

import type { PreflightThresholds } from '@/media/preflight'

export const TECH_SPEC_V1: PreflightThresholds = {
  required_orientation: 'vertical',
  min_duration_s: 3,
  // 1080 by 1920, which is what every phone shoots by default. Lower would
  // accept footage an editor cannot cut into a 4K timeline without upscaling.
  min_short_edge_px: 1080,
  min_long_edge_px: 1920,
  visit_window_hours: 24,
  near_branch_radius_m: 500,
}

const SPECS: Record<string, PreflightThresholds> = {
  'tech-v1': TECH_SPEC_V1,
}

/**
 * Resolves a spec key. An unknown key falls back to v1 rather than throwing,
 * because a creator holding a link to a brief whose spec we cannot resolve must
 * still be able to deliver: refusing the upload would punish them for our
 * data problem. The fallback is recorded by the caller as a warning.
 */
export function resolveTechSpec(key: string | null | undefined): {
  thresholds: PreflightThresholds
  resolved: boolean
} {
  if (key && SPECS[key]) return { thresholds: SPECS[key], resolved: true }
  return { thresholds: TECH_SPEC_V1, resolved: false }
}
