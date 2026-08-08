<script setup lang="ts">
// The pre-flight panel, shared by the creator upload row and the manager
// review. One component so both surfaces can never disagree about what a rule
// state means, and so both e2e runs assert against one set of ids.
//
// The four states are rendered as four visibly different things, and the state
// is in `data-status` rather than in colour or in text, because a test that
// reads colour is a test that breaks on a redesign.
//
// Two rules the component enforces rather than trusts its caller for:
// - a `skipped` rule is not rendered at all. "Does not apply to this file" is
//   not a result, and showing it as one turns a clean upload into a wall of
//   irrelevant rows (QC-MEDIA-110).
// - an `unknown` never renders as a pass. It gets its own grey dash mark, so
//   absent evidence can never read as verified evidence.
import { computed } from 'vue'
import type { PreflightResult, PreflightRuleResult } from '@/media/preflight'

const props = defineProps<{
  preflight: PreflightResult
  /** Plain-language sentence per rule, in the creator's terms. */
  audience: 'creator' | 'manager'
}>()

/** Rendered rules, in a stable order, minus everything skipped. */
const rules = computed<PreflightRuleResult[]>(() =>
  Object.values(props.preflight.rules).filter((rule) => rule.status !== 'skipped'),
)

const CREATOR_LABELS: Record<string, string> = {
  orientation: 'Filmed vertically',
  min_duration: 'Long enough to use',
  min_resolution: 'Sharp enough to use',
  capture_date: 'Filmed around your visit',
  near_branch: 'Filmed at the studio',
  duplicate: 'Not a repeat of another clip',
  codec_playable: 'We can preview it here',
}

const MANAGER_LABELS: Record<string, string> = {
  orientation: 'Orientation',
  min_duration: 'Duration',
  min_resolution: 'Resolution',
  capture_date: 'Capture date',
  near_branch: 'Near branch',
  duplicate: 'Duplicate',
  codec_playable: 'Codec playable',
}

/**
 * Plain language per reason code, in the creator's terms.
 *
 * Written as sentences a person can act on, because "no_gps_atom_camera" is a
 * diagnostic and "your camera does not record location" is an explanation.
 */
const CREATOR_REASONS: Record<string, string> = {
  wrong_orientation: 'This one is landscape. We need vertical for the feed.',
  too_short: 'This one is very short. A couple of seconds more gives the editors something to cut with.',
  too_small: 'The resolution is below what we can use. Check the camera is not set to a low quality mode.',
  no_creation_time: 'The file does not say when it was filmed, so we cannot check the date. Tell us below.',
  no_gps_atom_phone: 'No location in the file. Nothing to fix, and nothing is wrong.',
  no_gps_atom_camera: 'Cameras usually do not record location. Nothing to fix.',
  no_gps_atom_stripped: 'The location was removed from the file, which many apps do. Nothing to fix.',
  no_decoder_in_shell: 'We cannot preview this format in the browser. Your clip is fine and we still received it.',
  outside_visit_window: 'The date on this file is well outside your visit.',
  duplicate_of_earlier: 'This looks like a clip you already sent.',
}

function label(rule: PreflightRuleResult): string {
  const table = props.audience === 'creator' ? CREATOR_LABELS : MANAGER_LABELS
  return table[rule.rule] ?? rule.rule.replace(/_/g, ' ')
}

function sentence(rule: PreflightRuleResult): string | null {
  if (rule.status === 'pass') return null
  if (props.audience === 'manager') return rule.reason ?? null
  return rule.reason ? (CREATOR_REASONS[rule.reason] ?? null) : null
}

/** The numeric facts the e2e run reads back, exposed as data rather than prose. */
function durationOf(rule: PreflightRuleResult): string | undefined {
  return rule.rule === 'min_duration' && typeof rule.value === 'number' ? String(rule.value) : undefined
}

function distanceOf(rule: PreflightRuleResult): string | undefined {
  if (rule.rule !== 'near_branch') return undefined
  const distance = (rule as PreflightRuleResult & { distance_m?: number | null }).distance_m
  return typeof distance === 'number' ? String(distance) : undefined
}

function valueOf(rule: PreflightRuleResult): string | undefined {
  if (rule.value == null) return undefined
  if (typeof rule.value === 'object') return undefined
  return String(rule.value)
}
</script>

<template>
  <div
    data-testid="preflight-panel"
    class="panel"
  >
    <p
      data-testid="preflight-rollup"
      class="rollup mono"
      :data-verdict="preflight.verdict"
      :data-count="preflight.rollup.blocking_fail"
    >
      {{ preflight.rollup.pass }} checked
      <template v-if="preflight.rollup.fail">
        &middot; {{ preflight.rollup.fail }} to look at
      </template>
      <template v-if="preflight.rollup.unknown">
        &middot; {{ preflight.rollup.unknown }} we cannot tell
      </template>
    </p>

    <ul class="rules">
      <li
        v-for="rule in rules"
        :key="rule.rule"
        data-testid="preflight-rule"
        class="rule"
        :data-rule="rule.rule"
        :data-status="rule.status"
        :data-blocking="String(rule.blocking)"
        :data-reason="rule.reason ?? undefined"
        :data-value="valueOf(rule)"
        :data-duration-s="durationOf(rule)"
        :data-distance-m="distanceOf(rule)"
      >
        <!-- The mark. Four states, four distinct glyphs, never colour alone. -->
        <span
          v-if="rule.status === 'unknown'"
          data-testid="preflight-unknown-mark"
          class="mark unknown"
          aria-label="cannot tell"
        >&ndash;</span>
        <span
          v-else-if="rule.status === 'pass'"
          class="mark pass"
          aria-label="ok"
        >&check;</span>
        <span
          v-else
          class="mark fail"
          :class="{ blocking: rule.blocking }"
          :aria-label="rule.blocking ? 'must be fixed' : 'worth a look'"
        >{{ rule.blocking ? '&times;' : '!' }}</span>

        <span class="rule-label">{{ label(rule) }}</span>

        <span
          v-if="rule.rule === 'capture_date' && rule.captured_at_source"
          data-testid="capture-date-source"
          class="source mono"
          :data-captured-at-source="rule.captured_at_source"
        >{{ rule.captured_at_source }}</span>

        <span
          v-if="sentence(rule)"
          data-testid="preflight-rule-reason"
          class="reason"
        >{{ sentence(rule) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.panel {
  display: grid;
  gap: var(--space-1);
}

.rollup {
  margin: 0;
  font-size: 0.7rem;
  color: var(--muted);
}

.rules {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}

.rule {
  display: grid;
  grid-template-columns: 1.1rem 1fr auto;
  align-items: baseline;
  gap: var(--space-2);
  font-size: 0.78rem;
}

.mark {
  font-family: var(--mono);
  text-align: center;
  font-size: 0.8rem;
}

/* Neutral: a measured fact that came out fine. */
.mark.pass {
  color: var(--good);
}

/* Grey, and a dash rather than a tick or a cross, so absent evidence cannot
   be mistaken for either verified or refused. */
.mark.unknown {
  color: var(--muted);
}

.mark.fail {
  color: var(--warn);
}

.mark.fail.blocking {
  color: var(--critical);
}

.rule-label {
  color: var(--ink);
}

.source {
  font-size: 0.62rem;
  color: var(--muted);
}

.reason {
  grid-column: 2 / -1;
  color: var(--muted);
  font-size: 0.74rem;
}
</style>
