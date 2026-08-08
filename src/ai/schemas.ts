/**
 * One JSON schema per capability, shared by live, replay, mock and the tests.
 *
 * That sharing is the entire claim that mock is not a fork. A mock output that
 * does not validate against the schema the live path sends to the model is a
 * defect, and `tests/ai/schema-parity.spec.ts` is what turns that sentence into
 * something checkable.
 *
 * ## Two shapes, one schema
 *
 * Structured outputs (`output_config.format`) does not support every JSON Schema
 * keyword. Verified through the claude-api skill: `additionalProperties: false` is
 * required on every object, and numeric constraints (`minimum`, `maximum`),
 * string constraints (`minLength`, `maxLength`) and complex array constraints are
 * unsupported and must be validated client side. Recursive schemas are also out,
 * which is why nothing here references itself.
 *
 * So a confidence declared `minimum: 0, maximum: 1` is NOT enforced by the model.
 * If local validation is skipped, a confidence of 4.7 reaches the UI and renders
 * as a 470% bar. That is why `LOCAL_ONLY_KEYWORDS` exists: `wireSchema()` strips
 * those keywords before the schema is sent to the model, and `validate()` enforces
 * all of them on receipt. One schema object, two consumers, and the split is
 * visible rather than folklore.
 *
 * ## Every property is required
 *
 * Optionality is expressed as `anyOf: [{...}, {type: 'null'}]`, never by omitting
 * a key. Two reasons. The shape is then invariant across all three providers, so
 * a UI that renders `output.room` never has to distinguish absent from null. And
 * "no nulls where a value was expected" is one of the specific ways hand-written
 * fixtures diverge from real output (F1.4), which this removes by construction.
 */

import {
  MATCH_VERDICTS,
  NUDGE_TONES,
  ORIENTATIONS,
  QUALITY_BUCKETS,
  REVIEW_FLAGS,
  RISK_FLAG_CODES,
  ROOMS,
  SEARCH_ORDERINGS,
  SHOT_TYPES,
  SUBJECTS,
  TAG_TERM_ENUM,
  VET_BANDS,
  VET_CITABLE_FIELDS,
  VIBES,
  LIGHT_TERMS,
} from './taxonomy'

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** The subset of JSON Schema this system uses. Nothing here is recursive. */
export interface JsonSchema {
  type?: JsonType
  enum?: readonly (string | number | boolean | null)[]
  const?: string | number | boolean | null
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: false
  items?: JsonSchema
  anyOf?: readonly JsonSchema[]
  description?: string
  // Local-only from here down: stripped by wireSchema, enforced by validate.
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}

/**
 * Keywords the model will not enforce, so local validation is load-bearing rather
 * than belt-and-braces.
 */
export const LOCAL_ONLY_KEYWORDS = [
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const

export type CapabilityKey =
  | 'vet'
  | 'brief_gen'
  | 'vision_tag'
  | 'brief_match'
  | 'search_parse'
  | 'gap_scan'
  | 'nudge_draft'

export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  'vet',
  'brief_gen',
  'vision_tag',
  'brief_match',
  'search_parse',
  'gap_scan',
  'nudge_draft',
]

export interface CapabilitySchema {
  /** Recorded on every ai_run as `schema_key`. */
  schema_key: CapabilityKey
  /** Semantic. A breaking change to the shape is a major bump. */
  schema_version: string
  schema: JsonSchema
}

// ---------------------------------------------------------------------------
// small builders, so the schemas below read as intent rather than as noise
// ---------------------------------------------------------------------------

function obj(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return {
    type: 'object',
    properties,
    // Every key required. See the header note.
    required: Object.keys(properties),
    additionalProperties: false,
    description,
  }
}

function arr(
  items: JsonSchema,
  bounds?: { minItems?: number; maxItems?: number; uniqueItems?: boolean },
): JsonSchema {
  return { type: 'array', items, ...bounds }
}

function str(maxLength: number, description?: string): JsonSchema {
  return { type: 'string', maxLength, description }
}

function enumOf(values: readonly string[], description?: string): JsonSchema {
  return { type: 'string', enum: values, description }
}

/** Nullable, expressed the way structured outputs supports: anyOf with a null branch. */
function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] }
}

/** A 0..1 confidence. The bounds are local-only, which is exactly why they matter. */
function confidence(description: string): JsonSchema {
  return { type: 'number', minimum: 0, maximum: 1, description }
}

// ---------------------------------------------------------------------------
// 1. vet
// ---------------------------------------------------------------------------

/**
 * Creator fit, advisory forever.
 *
 * Four things in this shape are deliberate:
 *
 * - `band` is first and `score` is nullable. The band is what the UI shows,
 *   because a 0-100 number with three fluent reasons reads as authoritative no
 *   matter how thin the input was, and the input is usually a name and a handle.
 * - `insufficient_evidence` is a first-class band, not an error. It is the
 *   correct answer more often than any other single value.
 * - a reason must name the field it came from. `cited_field: 'none'` renders as
 *   "unsupported" instead of as evidence.
 * - a risk flag must carry `evidence_quote`. A free-floating adjective attached
 *   to a named human is the highest-damage output in this product, so the schema
 *   makes an unevidenced flag impossible to express.
 */
const VET: CapabilitySchema = {
  schema_key: 'vet',
  schema_version: '1.0.0',
  schema: obj({
    band: enumOf(VET_BANDS, 'The primary output. insufficient_evidence is expected to be common.'),
    score: nullable({
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Secondary detail only. Null whenever the band is insufficient_evidence.',
    }),
    reasons: arr(
      obj({
        claim: str(240, 'One clause. No adjectives about the person, only about the fit.'),
        cited_field: enumOf(VET_CITABLE_FIELDS, 'Which supplied field this rests on. none means unsupported.'),
        direction: enumOf(['for', 'against'], 'Whether this argues for or against the collab.'),
      }),
      { maxItems: 6 },
    ),
    risk_flags: arr(
      obj({
        code: enumOf(RISK_FLAG_CODES),
        evidence_quote: nullable(str(300, 'Verbatim from the supplied fields. Null means the flag is unevidenced and is dropped.')),
        severity: enumOf(['low', 'medium', 'high']),
      }),
      { maxItems: 5 },
    ),
    suggested_tier: nullable(
      str(40, 'Must be a member of allowed_tiers from the input. The band is computed in code; the model only picks inside it.'),
    ),
    tier_rationale: nullable(str(240)),
    /** Real model output hedges. The schema gives it somewhere to put the hedge. */
    caveat: nullable(str(300, 'What the model could not determine from the supplied fields.')),
  }),
}

// ---------------------------------------------------------------------------
// 2. brief_gen
// ---------------------------------------------------------------------------

/**
 * Shot items and caption angles. Nothing else.
 *
 * There is no `tech_specs` and no `usage_terms` field in this schema, and their
 * absence is the design decision. Technical specs come from a per-tier template
 * in code; usage terms come from fixed versioned legal text the model never sees
 * and never paraphrases. A model generating legal-sounding usage terms that a
 * real creator then accepts is the clearest "do not use AI here" line in the
 * product (B2.3), and the cheapest way to enforce it is to give the model no
 * field to write it into.
 */
const BRIEF_GEN: CapabilitySchema = {
  schema_key: 'brief_gen',
  schema_version: '1.0.0',
  schema: obj({
    items: arr(
      obj({
        seq: { type: 'integer', minimum: 1, maximum: 24 },
        instruction: str(200, 'Shootable in one take by one person with a phone. Imperative mood.'),
        shot_type: nullable(enumOf(SHOT_TYPES)),
        room: nullable(enumOf(ROOMS)),
        subjects: arr(enumOf(SUBJECTS), { maxItems: 4 }),
        min_takes: { type: 'integer', minimum: 1, maximum: 3 },
        /** The loop link. Null means the item came from the branch profile, not a gap. */
        origin_gap_signature: nullable(str(64)),
        why: str(200, 'Why this shot, in one clause, for the manager to sanity check.'),
        /** The model flags its own doubt; a deterministic gate decides. */
        feasibility_doubt: nullable(str(160, 'Anything that might make this unshootable on a normal visit.')),
      }),
      { minItems: 1, maxItems: 24 },
    ),
    caption_angles: arr(str(160), { maxItems: 5 }),
    /** Deliberate redundancy the manager can act on: overlapping items are a real failure mode (B2.2). */
    possible_overlaps: arr(
      obj({
        seq_a: { type: 'integer', minimum: 1 },
        seq_b: { type: 'integer', minimum: 1 },
        note: str(160),
      }),
      { maxItems: 6 },
    ),
  }),
}

// ---------------------------------------------------------------------------
// 3. vision_tag
// ---------------------------------------------------------------------------

/**
 * The clip tagger. The highest-volume capability and the one with the most ways
 * to be embarrassing.
 *
 * - every tag term is drawn from the closed taxonomy, so the model classifies
 *   rather than names, and the search index cannot fragment
 * - `description` is capped and single-line, because a description containing a
 *   newline breaks the layout it renders into
 * - light and framing are coarse buckets with a reason, never a score
 * - `frames_seen` is echoed back so the UI can say "analysed from 5 sampled
 *   frames" truthfully, and so a 3-frame constrained-tier sheet is visibly
 *   thinner evidence than a 7-frame one
 * - `text_on_screen` is both a quality signal and the injection tripwire
 * - `uncertainty` gives the model somewhere to say what it could not tell,
 *   which real output does unprompted and template output never does
 */
const VISION_TAG: CapabilitySchema = {
  schema_key: 'vision_tag',
  schema_version: '1.0.0',
  schema: obj({
    description: str(180, 'One line, no newline. Describes only what is visible in the supplied frames.'),
    shot_type: enumOf(SHOT_TYPES),
    room: nullable(enumOf(ROOMS, 'Null when the frames do not show enough of the space to tell.')),
    subjects: arr(enumOf(SUBJECTS), { minItems: 1, maxItems: 6, uniqueItems: true }),
    light: enumOf(LIGHT_TERMS),
    vibe: nullable(enumOf(VIBES)),
    tags: arr(
      obj({
        term: enumOf(TAG_TERM_ENUM),
        confidence: confidence('0..1. The middle band is expected and must not be rounded away.'),
      }),
      { minItems: 1, maxItems: 14 },
    ),
    framing: enumOf(QUALITY_BUCKETS),
    framing_reason: nullable(str(120, 'One clause, required whenever framing is not good.')),
    light_quality: enumOf(QUALITY_BUCKETS),
    light_reason: nullable(str(120)),
    review_flags: arr(
      obj({
        flag: enumOf(REVIEW_FLAGS),
        note: nullable(str(160)),
      }),
      { maxItems: 5 },
    ),
    text_on_screen: { type: 'boolean', description: 'True if any legible text appears in frame.' },
    frames_seen: { type: 'integer', minimum: 1, maximum: 12 },
    overall_confidence: confidence('How much the model would stand behind this whole reading.'),
    uncertainty: nullable(str(240, 'What these frames could not settle.')),
  }),
}

// ---------------------------------------------------------------------------
// 4. brief_match
// ---------------------------------------------------------------------------

/**
 * Clip to brief item, as tuples rather than as a winner.
 *
 * Matching is many-to-many, partial and often ambiguous. A shape that returns one
 * best item per clip produces a coverage number that is confidently wrong in both
 * directions, and that number drives the nudge sent to a real person. So:
 *
 * - the unit is a `(brief_item_id, asset_id, verdict, confidence, evidence)` tuple
 * - `possible` is a real verdict that renders as "confirm?" instead of resolving
 * - one clip may appear in several tuples, which is the normal case
 * - there is no coverage percentage in this schema. Coverage is arithmetic over
 *   human-confirmed matches, computed in code. Never let a model count (B9.3).
 */
const BRIEF_MATCH: CapabilitySchema = {
  schema_key: 'brief_match',
  schema_version: '1.0.0',
  schema: obj({
    matches: arr(
      obj({
        brief_item_id: str(64),
        asset_id: str(64),
        verdict: enumOf(MATCH_VERDICTS),
        confidence: confidence('0..1'),
        evidence: str(200, 'What in the clip summary supports this, quoted or paraphrased.'),
      }),
      { maxItems: 200 },
    ),
    /** Creators always shoot extra. A diff that cannot show extras is wrong. */
    unmatched_asset_ids: arr(str(64), { maxItems: 100 }),
    notes: nullable(str(300)),
  }),
}

// ---------------------------------------------------------------------------
// 5. search_parse
// ---------------------------------------------------------------------------

/**
 * Query text to an inspectable filter and ranking spec. There is no embeddings
 * service and no vector database in this product; the model does term-to-taxonomy
 * mapping and local code retrieves.
 *
 * The two fields that make this honest rather than magic:
 *
 * - `mappings` carries the raw phrase next to the taxonomy term it resolved to,
 *   so the UI can render `golden hour -> warm_light` as a removable chip. That
 *   chip is the most important trust affordance in the search.
 * - `unmapped` is explicit. An unmapped term is a vocabulary gap, not a content
 *   gap, and conflating the two puts a nonsense shot into a real creator's brief.
 */
const SEARCH_PARSE: CapabilitySchema = {
  schema_key: 'search_parse',
  schema_version: '1.0.0',
  schema: obj({
    filters: obj({
      subjects: arr(enumOf(SUBJECTS), { maxItems: 6 }),
      shot_types: arr(enumOf(SHOT_TYPES), { maxItems: 4 }),
      rooms: arr(enumOf(ROOMS), { maxItems: 4 }),
      light: arr(enumOf(LIGHT_TERMS), { maxItems: 3 }),
      vibes: arr(enumOf(VIBES), { maxItems: 3 }),
      orientation: nullable(enumOf(ORIENTATIONS)),
      /** A slug the caller supplied in the prompt context, never invented. */
      branch_slug: nullable(str(64)),
      duration_min_s: nullable({ type: 'number', minimum: 0, maximum: 3600 }),
      duration_max_s: nullable({ type: 'number', minimum: 0, maximum: 3600 }),
    }),
    mappings: arr(
      obj({
        raw: str(80, 'Exactly what the editor typed, so the chip can show it.'),
        facet: enumOf(['subject', 'shot_type', 'room', 'light', 'vibe', 'orientation', 'branch', 'duration']),
        term: str(64),
        confidence: confidence('0..1'),
      }),
      { maxItems: 12 },
    ),
    unmapped: arr(str(80, 'A phrase with no taxonomy member. A vocabulary candidate, never gap evidence.'), {
      maxItems: 8,
    }),
    ranking: obj({
      order_by: enumOf(SEARCH_ORDERINGS),
      boost_terms: arr(enumOf(TAG_TERM_ENUM), { maxItems: 6 }),
    }),
  }),
}

// ---------------------------------------------------------------------------
// 6. gap_scan
// ---------------------------------------------------------------------------

/**
 * The gap scan's model call, which is smaller than people expect.
 *
 * Every number in the gap feature is computed: demand from the query log, supply
 * from approved published assets, deficit, severity, the evidence bar. The model
 * does two things code cannot: it phrases a coverage cell as a shootable
 * instruction, and it clusters near-duplicate queries into one concept.
 *
 * So this schema has no score, no severity and no demand field. If the model
 * could write a severity the whole feature would become a horoscope, and a
 * reviewer asking "how is this computed" would get the bad answer.
 *
 * `cell_signature` is echoed back verbatim so local code can rejoin the phrasing
 * to the computed cell. A signature the model altered is a validation failure,
 * not a lookup miss.
 */
const GAP_SCAN: CapabilitySchema = {
  schema_key: 'gap_scan',
  schema_version: '1.0.0',
  schema: obj({
    cells: arr(
      obj({
        cell_signature: str(64, 'Echoed verbatim from the input. Not recomputed, not tidied.'),
        title: str(60, 'What an editor would call this, for the gaps list.'),
        shot_instruction: str(200, 'Phrased so it can be pasted into a brief item unchanged.'),
        rationale: str(200, 'Why this cell is worth a shot, in the language of the computed signals supplied.'),
        cluster_label: nullable(str(60, 'Set when several supplied cells are really one concept.')),
      }),
      { maxItems: 40 },
    ),
    /** Queries that mapped to nothing: a vocabulary signal, kept separate from gaps. */
    vocabulary_candidates: arr(str(60), { maxItems: 12 }),
  }),
}

// ---------------------------------------------------------------------------
// 7. nudge_draft
// ---------------------------------------------------------------------------

/**
 * A draft message about missing shots. A draft, emphatically.
 *
 * `body_text` is a draft a human edits and sends. Nothing in this schema sends
 * anything, and `delivery.nudge_sent_at` is set by the send action, not by this
 * output. A model deciding whether to chase a real person is not a decision a
 * model gets to make (B9.13).
 *
 * `missing_item_ids` must be echoed from the input, so the draft cannot name a
 * shot the diff did not actually find missing. That is the whole failure mode
 * here: a fluent message that asks a creator for footage they already delivered.
 */
const NUDGE_DRAFT: CapabilitySchema = {
  schema_key: 'nudge_draft',
  schema_version: '1.0.0',
  schema: obj({
    subject_line: str(90),
    body_text: str(900, 'Newlines allowed here, unlike a clip description. This one is a message.'),
    tone: enumOf(NUDGE_TONES),
    missing_item_ids: arr(str(64, 'Echoed from the input diff. Never invented.'), { maxItems: 24 }),
    mentions_deadline: { type: 'boolean' },
    /** Anything the drafter noticed that a human should check before sending. */
    warnings: arr(str(160), { maxItems: 4 }),
  }),
}

// ---------------------------------------------------------------------------

export const CAPABILITY_SCHEMAS: Record<CapabilityKey, CapabilitySchema> = {
  vet: VET,
  brief_gen: BRIEF_GEN,
  vision_tag: VISION_TAG,
  brief_match: BRIEF_MATCH,
  search_parse: SEARCH_PARSE,
  gap_scan: GAP_SCAN,
  nudge_draft: NUDGE_DRAFT,
}

export function schemaFor(key: CapabilityKey): CapabilitySchema {
  const found = CAPABILITY_SCHEMAS[key]
  if (!found) throw new Error(`schemaFor: no schema registered for capability "${key}"`)
  return found
}

/**
 * The schema as the model receives it: local-only keywords removed.
 *
 * Sending `maxLength` to a model that does not support it is at best ignored and
 * at worst a 400, and either way it creates the false impression that the bound is
 * enforced upstream. Strip it here, enforce it in validate.ts, and say so.
 */
export function wireSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if ((LOCAL_ONLY_KEYWORDS as readonly string[]).includes(key)) continue
    if (key === 'properties' && value) {
      const props: Record<string, JsonSchema> = {}
      for (const [name, child] of Object.entries(value as Record<string, JsonSchema>)) {
        props[name] = wireSchema(child)
      }
      out[key] = props
    } else if (key === 'items' && value) {
      out[key] = wireSchema(value as JsonSchema)
    } else if (key === 'anyOf' && value) {
      out[key] = (value as JsonSchema[]).map(wireSchema)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as JsonSchema
}

/**
 * Input schemas: what the browser is allowed to send to the Netlify function.
 *
 * These are the function's allowlist. A proxy that forwards whatever it is given
 * is a general-purpose Claude endpoint on a public URL; a proxy that accepts only
 * these seven shapes is not. The client cannot send a prompt at all, only
 * structured input, and the function renders the prompt from its own copy of the
 * template. See docs/02-caveats-review.md B10.1.
 *
 * Deliberately loose about the contents of names and notes (they are untrusted
 * text either way, and the fencing in the prompt is what handles that) and strict
 * about structure, size and the absence of any field that could steer the model.
 */
export const CAPABILITY_INPUT_SCHEMAS: Record<CapabilityKey, JsonSchema> = {
  vet: obj({
    creator_id: str(64),
    display_name: str(120),
    primary_handle: str(120),
    platforms: arr(
      obj({
        network: str(40),
        handle: str(120),
        followers: nullable({ type: 'integer', minimum: 0, maximum: 1_000_000_000 }),
      }),
      { maxItems: 6 },
    ),
    application_note: nullable(str(2000)),
    prior_collabs: { type: 'integer', minimum: 0, maximum: 500 },
    scorecard_summary: nullable(str(400)),
    allowed_tiers: arr(str(40), { minItems: 1, maxItems: 6 }),
    branch_city: str(80),
  }),
  brief_gen: obj({
    branch_slug: str(64),
    branch_rooms: arr(str(40), { maxItems: 20 }),
    do_not_shoot: arr(str(80), { maxItems: 20 }),
    target_item_count: { type: 'integer', minimum: 4, maximum: 16 },
    gaps: arr(
      obj({
        cell_signature: str(64),
        facets: str(240, 'Pre-rendered facet summary, so the function never has to interpret a cube.'),
        severity: str(20),
      }),
      { maxItems: 20 },
    ),
    creator_style_note: nullable(str(400)),
    vip_tier: nullable(str(40)),
  }),
  vision_tag: obj({
    asset_id: str(64),
    /** The one composite image. Base64, one per request, size-asserted before send. */
    sheet_base64: str(1_400_000),
    sheet_media_type: enumOf(['image/jpeg', 'image/png', 'image/webp']),
    frames_seen: { type: 'integer', minimum: 1, maximum: 12 },
    duration_s: nullable({ type: 'number', minimum: 0, maximum: 36_000 }),
    orientation: nullable(enumOf(ORIENTATIONS)),
    /** Rooms this branch actually has, so the model picks from reality. */
    branch_rooms: arr(str(40), { maxItems: 20 }),
    /**
     * Note what is NOT here: no filename, ever. Filenames are creator-controlled,
     * carry almost no signal, and are pure injection surface (B6.2).
     */
  }),
  brief_match: obj({
    brief_item_id: str(64),
    brief_item_instruction: str(400),
    brief_item_shot_type: nullable(str(40)),
    brief_item_room: nullable(str(40)),
    /** Chunked by brief item, never a 40-by-12 matrix in one call (B10.2). */
    candidates: arr(
      obj({
        asset_id: str(64),
        description: str(240),
        shot_type: nullable(str(40)),
        room: nullable(str(40)),
        subjects: arr(str(40), { maxItems: 8 }),
        duration_s: nullable({ type: 'number', minimum: 0, maximum: 36_000 }),
      }),
      { maxItems: 60 },
    ),
  }),
  search_parse: obj({
    query_text: str(400),
    branch_slugs: arr(str(64), { maxItems: 10 }),
  }),
  gap_scan: obj({
    gap_scan_id: str(64),
    cells: arr(
      obj({
        cell_signature: str(64),
        facets: str(240),
        severity: str(20),
        /** Pre-computed, passed in so the phrasing can cite it, never recomputed. */
        signal_summary: str(240),
      }),
      { minItems: 1, maxItems: 40 },
    ),
    unmapped_query_tokens: arr(str(60), { maxItems: 40 }),
  }),
  nudge_draft: obj({
    collab_id: str(64),
    creator_display_name: str(120),
    branch_city: str(80),
    visit_date_text: str(40),
    missing_items: arr(obj({ brief_item_id: str(64), instruction: str(240) }), { minItems: 1, maxItems: 24 }),
    delivered_count: { type: 'integer', minimum: 0, maximum: 1000 },
    promised_count: { type: 'integer', minimum: 0, maximum: 1000 },
    deadline_text: nullable(str(60)),
    tone_hint: nullable(enumOf(NUDGE_TONES)),
  }),
}
