/**
 * Authored query parses, plus the local synonym table that serves everything else.
 *
 * Search is the one capability whose input space is genuinely unbounded: an editor
 * can type anything. Reusing an authored answer for an unseen query would produce
 * a filter unrelated to what was typed, and a search box that visibly ignores its
 * own input is worse than no search box. So this capability has two mock paths and
 * they are recorded differently on the run:
 *
 * - an authored parse (`authored-fixture-v1`) for the queries in the seeded search
 *   history, where the interesting part is paraphrase resolution and a fixture can
 *   show judgement
 * - a synonym and taxonomy lookup in local code (`synthetic-v1`) for anything else,
 *   which is exactly the warm path docs/02-caveats-review.md B4.6 recommends
 *   persisting: over time the table answers and the model becomes the cold path
 *
 * Both are `provider: 'mock'`. The difference between "a model wrote this" and
 * "a table matched this" is real and is recorded, not blurred.
 *
 * ## Deliberate imperfection
 *
 * Two fixtures leave a term unmapped rather than forcing it into the nearest
 * member, and one maps nothing at all. An unmapped term is a vocabulary gap, never
 * a content gap, and conflating the two puts a nonsense shot into a real
 * creator's brief. The zero-mapping case is the state the UI is least likely to
 * have been built for, which is why it is in the set.
 */

import type { SearchParseOutput } from '../provider'
import { LIGHT_TERMS, ROOMS, SHOT_TYPES, SUBJECTS, VIBES, type SearchOrdering } from '../taxonomy'
import type { AuthoredFixture } from './types'

export interface SearchParseFixture extends AuthoredFixture<SearchParseOutput> {
  /** Normalised query strings this answer was authored for. */
  queries: string[]
}

/** Lowercase, collapse whitespace, drop punctuation. The cache and the fixtures key on this. */
export function normaliseQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const EMPTY_FILTERS: SearchParseOutput['filters'] = {
  subjects: [],
  shot_types: [],
  rooms: [],
  light: [],
  vibes: [],
  orientation: null,
  branch_slug: null,
  duration_min_s: null,
  duration_max_s: null,
}

export const SEARCH_PARSE_FIXTURES: readonly SearchParseFixture[] = [
  {
    id: 'search_parse.golden-hour-window',
    provenance: { artefact: 'src/data/seed.ts ZERO_RESULT_QUERIES "golden hour window"', sha256: null },
    queries: ['golden hour window'],
    latency_ms: 640,
    imperfection:
      'Leaves "window" unmapped rather than reaching for a room. This is the canonical mapping the search chip exists to show, and the leftover word is the vocabulary signal.',
    output: {
      filters: { ...EMPTY_FILTERS, light: ['warm_light'] },
      mappings: [{ raw: 'golden hour', facet: 'light', term: 'warm_light', confidence: 0.82 }],
      unmapped: ['window'],
      ranking: { order_by: 'relevance', boost_terms: ['warm_light'] },
    },
  },

  {
    id: 'search_parse.calm-morning-light-hands',
    provenance: { artefact: 'src/data/seed.ts HIT_QUERIES "calm morning light hands"', sha256: null },
    queries: ['calm morning light hands'],
    latency_ms: 710,
    imperfection:
      'Maps "morning light" to daylight at 0.58. Morning is a time of day and daylight is a quality, so this is the mapping most likely to be wrong and the chip has to be removable.',
    output: {
      filters: { ...EMPTY_FILTERS, subjects: ['hands'], light: ['daylight'], vibes: ['calm'] },
      mappings: [
        { raw: 'hands', facet: 'subject', term: 'hands', confidence: 0.96 },
        { raw: 'calm', facet: 'vibe', term: 'calm', confidence: 0.9 },
        { raw: 'morning light', facet: 'light', term: 'daylight', confidence: 0.58 },
      ],
      unmapped: [],
      ranking: { order_by: 'relevance', boost_terms: ['hands', 'calm', 'daylight'] },
    },
  },

  {
    id: 'search_parse.arriving-at-the-door',
    provenance: { artefact: 'src/data/seed.ts ZERO_RESULT_QUERIES "arriving at the door"', sha256: null },
    queries: ['arriving at the door', 'exterior arrival', 'exterior arrival wide'],
    latency_ms: 690,
    imperfection:
      'One mapping at 0.52. Arriving is an action and exterior is a place, and the whole query is a request for a shot the library has never held.',
    output: {
      filters: { ...EMPTY_FILTERS, rooms: ['exterior'], shot_types: ['wide'] },
      mappings: [
        { raw: 'arriving at the door', facet: 'room', term: 'exterior', confidence: 0.52 },
        { raw: 'arriving', facet: 'shot_type', term: 'wide', confidence: 0.41 },
      ],
      unmapped: [],
      ranking: { order_by: 'relevance', boost_terms: ['exterior'] },
    },
  },

  {
    id: 'search_parse.reception-greeting',
    provenance: { artefact: 'src/data/seed.ts ZERO_RESULT_QUERIES "reception greeting"', sha256: null },
    queries: ['reception greeting', 'reception welcome'],
    latency_ms: 580,
    imperfection:
      'Leaves "greeting" unmapped. The seeded vocabulary already carries greeting as a proposed term created by the rule that watches unmapped tokens, so this is that loop with its first half visible.',
    output: {
      filters: { ...EMPTY_FILTERS, rooms: ['reception'] },
      mappings: [{ raw: 'reception', facet: 'room', term: 'reception', confidence: 0.94 }],
      unmapped: ['greeting'],
      ranking: { order_by: 'relevance', boost_terms: ['reception'] },
    },
  },

  {
    id: 'search_parse.steam-room-detail',
    provenance: { artefact: 'src/data/seed.ts ZERO_RESULT_QUERIES "steam room detail"', sha256: null },
    queries: ['steam room detail'],
    latency_ms: 620,
    imperfection: null,
    output: {
      filters: { ...EMPTY_FILTERS, rooms: ['wet_room'], shot_types: ['macro'] },
      mappings: [
        { raw: 'steam room', facet: 'room', term: 'wet_room', confidence: 0.66 },
        { raw: 'detail', facet: 'shot_type', term: 'macro', confidence: 0.58 },
      ],
      unmapped: [],
      ranking: { order_by: 'relevance', boost_terms: ['wet_room'] },
    },
  },

  {
    id: 'search_parse.nothing-mappable',
    provenance: { artefact: 'authored for the zero mapping state', sha256: null },
    queries: ['liminal in between moments'],
    latency_ms: 540,
    imperfection:
      'Maps nothing. Every filter is empty and every word is a vocabulary candidate. This is the state the search UI is least likely to have been built for and the one that must never be logged as a content gap.',
    output: {
      filters: { ...EMPTY_FILTERS },
      mappings: [],
      unmapped: ['liminal', 'in between moments'],
      ranking: { order_by: 'relevance', boost_terms: [] },
    },
  },
]

export const SEARCH_PARSE_BY_QUERY: ReadonlyMap<string, SearchParseFixture> = new Map(
  SEARCH_PARSE_FIXTURES.flatMap((fixture) => fixture.queries.map((q) => [normaliseQuery(q), fixture] as const)),
)

// ---------------------------------------------------------------------------
// the synonym table: the warm path, and the synthetic fallback for unseen queries
// ---------------------------------------------------------------------------

export type Facet = 'subject' | 'shot_type' | 'room' | 'light' | 'vibe' | 'orientation' | 'branch' | 'duration'

export interface SynonymEntry {
  /** Multi-word phrases are matched before single words, longest first. */
  phrase: string
  facet: Facet
  term: string
  confidence: number
}

/**
 * Hand written synonyms, the artefact B4.6 argues for over an embedding index.
 *
 * It is inspectable, correctable, and it answers instantly with no call. Every
 * entry is a mapping a human can disagree with in one glance, which is the whole
 * argument for doing it this way.
 */
export const SYNONYMS: readonly SynonymEntry[] = [
  { phrase: 'golden hour', facet: 'light', term: 'warm_light', confidence: 0.82 },
  { phrase: 'warm light', facet: 'light', term: 'warm_light', confidence: 0.95 },
  { phrase: 'morning light', facet: 'light', term: 'daylight', confidence: 0.58 },
  { phrase: 'natural light', facet: 'light', term: 'daylight', confidence: 0.72 },
  { phrase: 'low light', facet: 'light', term: 'low_light', confidence: 0.95 },
  { phrase: 'dark', facet: 'light', term: 'low_light', confidence: 0.6 },
  { phrase: 'moody', facet: 'vibe', term: 'moody', confidence: 0.9 },
  { phrase: 'spa lobby', facet: 'room', term: 'reception', confidence: 0.7 },
  { phrase: 'front desk', facet: 'room', term: 'reception', confidence: 0.74 },
  { phrase: 'waiting area', facet: 'room', term: 'lounge', confidence: 0.62 },
  { phrase: 'steam room', facet: 'room', term: 'wet_room', confidence: 0.66 },
  { phrase: 'shower', facet: 'room', term: 'wet_room', confidence: 0.6 },
  { phrase: 'entrance', facet: 'room', term: 'exterior', confidence: 0.6 },
  { phrase: 'arrival', facet: 'room', term: 'exterior', confidence: 0.55 },
  { phrase: 'outside', facet: 'room', term: 'exterior', confidence: 0.62 },
  { phrase: 'treatment room', facet: 'room', term: 'treatment_room', confidence: 0.95 },
  { phrase: 'wet room', facet: 'room', term: 'wet_room', confidence: 0.95 },
  { phrase: 'close up', facet: 'shot_type', term: 'closeup', confidence: 0.9 },
  { phrase: 'detail', facet: 'shot_type', term: 'macro', confidence: 0.58 },
  { phrase: 'flatlay', facet: 'shot_type', term: 'overhead', confidence: 0.8 },
  { phrase: 'flat lay', facet: 'shot_type', term: 'overhead', confidence: 0.8 },
  { phrase: 'top down', facet: 'shot_type', term: 'overhead', confidence: 0.76 },
  { phrase: 'establishing', facet: 'shot_type', term: 'wide', confidence: 0.7 },
  { phrase: 'oil pour', facet: 'subject', term: 'oil', confidence: 0.85 },
  { phrase: 'massage', facet: 'subject', term: 'hands', confidence: 0.5 },
  { phrase: 'staff', facet: 'subject', term: 'therapist', confidence: 0.7 },
  { phrase: 'guest', facet: 'subject', term: 'client', confidence: 0.7 },
  { phrase: 'greenery', facet: 'subject', term: 'plants', confidence: 0.85 },
  { phrase: 'vertical', facet: 'orientation', term: 'vertical', confidence: 0.98 },
  { phrase: 'portrait', facet: 'orientation', term: 'vertical', confidence: 0.8 },
  { phrase: 'horizontal', facet: 'orientation', term: 'horizontal', confidence: 0.98 },
  { phrase: 'landscape', facet: 'orientation', term: 'horizontal', confidence: 0.8 },
]

/** Words carrying no facet signal, dropped before anything is reported as unmapped. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with',
  'some', 'any', 'show', 'me', 'find', 'need', 'want', 'clip', 'clips', 'shot', 'shots', 'footage', 'video',
])

/**
 * Exact taxonomy members, so a query that already speaks the vocabulary needs no
 * synonym.
 *
 * The escape members are excluded on purpose. An editor typing "other" is not
 * asking for the `other` bucket, and mapping the word would turn a stray token
 * into a filter that quietly excludes most of the library.
 */
const ESCAPES: ReadonlySet<string> = new Set(['other', 'none_visible'])

// The per-facet term unions differ, so the constructor needs the widened
// element type named or the tuple inference from each spread arm collides.
export const TAXONOMY_LOOKUP: ReadonlyMap<string, { facet: Facet; term: string }> = new Map<
  string,
  { facet: Facet; term: string }
>([
  ...SUBJECTS.filter((t) => !ESCAPES.has(t)).map(
    (t) => [t.replace(/_/g, ' '), { facet: 'subject' as Facet, term: t }] as const,
  ),
  ...SHOT_TYPES.filter((t) => !ESCAPES.has(t)).map(
    (t) => [t.replace(/_/g, ' '), { facet: 'shot_type' as Facet, term: t }] as const,
  ),
  ...ROOMS.filter((t) => !ESCAPES.has(t)).map(
    (t) => [t.replace(/_/g, ' '), { facet: 'room' as Facet, term: t }] as const,
  ),
  ...LIGHT_TERMS.map((t) => [t.replace(/_/g, ' '), { facet: 'light' as Facet, term: t }] as const),
  ...VIBES.filter((t) => !ESCAPES.has(t)).map(
    (t) => [t.replace(/_/g, ' '), { facet: 'vibe' as Facet, term: t }] as const,
  ),
])

/** Explicitly typed rather than indexed off the array, so a reorder cannot change it. */
export const DEFAULT_ORDERING: SearchOrdering = 'relevance'
