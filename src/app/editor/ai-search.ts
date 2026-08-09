/**
 * The AI query parser, layered on top of the deterministic search.
 *
 * The floor underneath it (`./search.ts`) maps words to taxonomy terms by exact
 * and underscore-joined lookup, and refuses to guess. That floor is what runs
 * when the model is not asked, and it is what the whole editor surface was built
 * and tested against.
 *
 * What the model adds is exactly one thing: the synonym hop the floor will not
 * make. "golden hour" is not in the vocabulary and never will be, because a
 * taxonomy that grows a term for every phrase an editor might type stops being a
 * taxonomy. A model can say that phrase means `warm_light`, and that is a
 * genuine translation problem rather than a lookup.
 *
 * Three rules this module keeps, all of which exist because the alternative is a
 * search box that lies:
 *
 * 1. Every mapping the model proposes is shown as a removable chip with the
 *    original words on it. An editor who typed "golden hour" and got clips of
 *    warm light must be able to see WHY, and to undo it in one click.
 * 2. A term the model could not map stays unmapped and filters nothing, exactly
 *    as on the floor. An unmapped term is a vocabulary gap, and letting it
 *    filter would turn "we lack the word" into "we lack the footage", which is
 *    the one confusion that would poison the gap scan.
 * 3. If the model fails, is slow, or returns something that does not validate,
 *    the floor's answer is used and the surface says the parse was deterministic.
 *    A search box that breaks when a model is unavailable is worse than one that
 *    never had a model.
 */

import {
  createAiProvider,
  writeAiRun,
  type AiMode,
  type AiProvider,
  type SearchParseOutput,
} from '@/ai'
import type { AiProvider as AiProviderKind } from '@/data/types'
import type { ScopedRepo } from '@/data/repo'
import { parseQuery, type MappedTerm, type ParsedQuery, type VocabularyEntry } from './search'

export interface AiParseResult {
  parsed: ParsedQuery
  /** Where the interpretation came from, for the provenance line on the chips. */
  source: 'deterministic' | 'model'
  /** Present only for a model parse: what it suggested and how sure it was. */
  mappings: { raw: string; term: string; facet: string; confidence: number }[]
  ranking: SearchParseOutput['ranking'] | null
  /** Set when a model parse was attempted and could not be used. */
  fellBackBecause: string | null
  /** The run row, so the chips can point at the evidence. */
  runId: string | null
  /**
   * Which provider actually answered, read off the run's own meta.
   *
   * The chip's "simulated" styling reads this, never the app's current mode,
   * for the same reason the asset badge does: a badge driven by mode lies the
   * moment one session mixes a mock parse with a real one.
   */
  provider: AiProviderKind | null
}

/** Confidence below which a proposed mapping is dropped rather than shown. */
const MAPPING_FLOOR = 0.55

export interface AiParseDeps {
  repo: ScopedRepo
  vocabulary: VocabularyEntry[]
  knownRooms: Set<string>
  branchSlugs: string[]
  mode?: AiMode
  provider?: AiProvider
}

/**
 * Parses a query, using the model where it helps and the floor where it does not.
 *
 * The deterministic parse runs FIRST and always. The model is asked only to
 * explain what the floor could not map, and its answer is merged in rather than
 * replacing anything: a term the floor mapped by exact lookup is already correct,
 * and letting a model overrule a lookup would be trading certainty for a guess.
 */
export async function parseWithAi(text: string, deps: AiParseDeps): Promise<AiParseResult> {
  const floor = parseQuery(text, deps.vocabulary, deps.knownRooms)

  const base: AiParseResult = {
    parsed: floor,
    source: 'deterministic',
    mappings: [],
    ranking: null,
    fellBackBecause: null,
    runId: null,
    provider: null,
  }

  // Nothing left to translate: the floor understood every word, so asking a
  // model would spend a call to be told what we already know.
  if (floor.unmapped.length === 0) return base

  const ai = deps.provider ?? createAiProvider({ mode: deps.mode ?? 'mock' })

  try {
    const result = await ai.search_parse({
      query_text: text,
      branch_slugs: deps.branchSlugs,
    })

    const known = new Set(floor.mapped.map((term) => term.term))
    const stillUnmapped = new Set(floor.unmapped.map((word) => word.toLowerCase()))
    const added: MappedTerm[] = []
    const shown: AiParseResult['mappings'] = []

    for (const mapping of result.output.mappings) {
      // Only accept a mapping for words the floor actually failed on. A model
      // "correcting" a term that resolved by exact lookup is a regression, not
      // an improvement.
      const raw = mapping.raw.toLowerCase()
      const coversUnmapped = raw
        .split(/[^a-z0-9_]+/)
        .some((word) => word.length > 0 && stillUnmapped.has(word))
      if (!coversUnmapped) continue
      if (mapping.confidence < MAPPING_FLOOR) continue
      if (known.has(mapping.term)) continue

      known.add(mapping.term)
      added.push({ raw: mapping.raw, term: mapping.term, kind: mapping.facet })
      shown.push({
        raw: mapping.raw,
        term: mapping.term,
        facet: mapping.facet,
        confidence: mapping.confidence,
      })
      for (const word of raw.split(/[^a-z0-9_]+/)) stillUnmapped.delete(word)
    }

    // Record the run so the chips can point at real evidence, and so the Data
    // Health panel counts this call like any other.
    let runId: string | null = null
    try {
      runId = await writeAiRun(deps.repo, {
        subject_type: 'search_query',
        subject_id: result.meta.input_hash,
        meta: result.meta,
        output_json: result.output,
      })
    } catch {
      // A run we could not record is not a reason to refuse the editor their
      // results. The parse still happened and the chips still say it was a model.
    }

    return {
      parsed: {
        mapped: [...floor.mapped, ...added],
        // Whatever neither the floor nor the model could place stays unmapped
        // and visible, because that list is the vocabulary's to-do list.
        unmapped: floor.unmapped.filter((word) => stillUnmapped.has(word.toLowerCase())),
      },
      source: added.length > 0 ? 'model' : 'deterministic',
      mappings: shown,
      ranking: result.output.ranking,
      fellBackBecause: null,
      runId,
      provider: result.meta.provider,
    }
  } catch (error) {
    return {
      ...base,
      fellBackBecause: error instanceof Error ? error.message : String(error),
    }
  }
}
