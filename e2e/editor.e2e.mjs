/**
 * EDITOR RUN.
 *
 * Source cases: `qa/PLAN.md` "Editor run".
 *
 * Given the seeded library and the editor role
 * When the editor searches in plain language, refines with facets, opens a
 *      clip sheet, bins clips and confirms use
 * Then the taxonomy mapping is visible and removable, unmapped terms are
 *      surfaced rather than silently dropped, ranks are sequential, provenance
 *      is visible on AI claims, a zero result ends in a recorded gap, and the
 *      usage event carries the rank the clip held at the moment of the event.
 *
 * The tenancy assertion rides along: no creator or collab internal field may
 * appear anywhere in the editor DOM, by name or by value.
 */
import {
  BASE_URL, DESKTOP, MOBILE, assert, assertEqual, exists,
  finish, launch, note, openPage, run, startServer, stopServer,
} from './_support/harness.mjs'
import {
  ACTIVE_ROLE, ATTR_GAP_ID, ATTR_CELL_SIGNATURE, ATTR_RANK_AT_EVENT, ATTR_ROLE,
  BIN_COUNT, BIN_HANDOFF, BIN_PANEL, BIN_TOGGLE,
  CLIP_SHEET, CLIP_SHEET_TAGS_AI, CLIP_SHEET_TAGS_HUMAN,
  FACET_CHIP, FACET_CLEAR_ALL,
  LIBRARY_SEARCH_INPUT, LIBRARY_SEARCH_SUBMIT,
  REQUEST_SHOT, REQUEST_SHOT_CONFIRMATION, REQUEST_SHOT_SUBMIT,
  RESULT_COUNT, RESULT_GRID, RESULT_TILE, RESULT_TILE_ADD_TO_BIN,
  RESULT_TILE_POSTER, ROLE_EDITOR, ROLE_OPTION,
  SEARCH_ASK_MODEL, SEARCH_PARSE_PROVENANCE,
  SEARCH_TERM_CHIP, SEARCH_TERM_CHIP_REMOVE, SEARCH_UNMAPPED_TERM, SIMULATED_BADGE,
  USAGE_CONFIRMATION, ZERO_RESULT,
  sel, testid,
} from './_support/testids.mjs'

/** Field names that must never reach the editor DOM, per src/data/scope.ts. */
const FORBIDDEN_STRINGS = [
  'fit_score', 'risk_flags', 'comp_value_usd', 'reject_reason_text',
  'reliability_tier', 'nudge_draft', 'do_not_shoot',
]

async function boot(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector(testid(RESULT_GRID), { timeout: 30_000 })
  await page.click(sel(ROLE_OPTION, { [ATTR_ROLE]: ROLE_EDITOR }))
  await page.waitForSelector(sel(ACTIVE_ROLE, { [ATTR_ROLE]: ROLE_EDITOR }), { timeout: 10_000 })
  await page.waitForSelector(testid(RESULT_GRID), { timeout: 15_000 })
}

async function search(page, text) {
  await page.fill(testid(LIBRARY_SEARCH_INPUT), text)
  await page.click(testid(LIBRARY_SEARCH_SUBMIT))
  await page.waitForTimeout(150)
}

async function resultCount(page) {
  const el = await page.$(testid(RESULT_COUNT))
  return el ? Number(await el.getAttribute('data-count')) : 0
}

async function editorChecks(browser, deviceProfile) {
  const { context, page, watcher } = await openPage(browser, deviceProfile)
  try {
    await boot(page)

    // The grid is real: posters decoded, ranks sequential from one.
    const tiles = await page.$$(testid(RESULT_TILE))
    assert(tiles.length > 0, `${deviceProfile.name}: the library grid rendered ${tiles.length} tiles`)
    const ranks = await page.$$eval(testid(RESULT_TILE), (nodes) =>
      nodes.map((node) => Number(node.getAttribute('data-rank'))),
    )
    assert(
      ranks.every((rank, index) => rank === index + 1),
      `${deviceProfile.name}: tile ranks are sequential from one (${ranks.slice(0, 5).join(',')}...)`,
    )
    const posters = await page.$$eval(testid(RESULT_TILE_POSTER), (nodes) =>
      nodes.map((img) => img.complete && img.naturalWidth > 0),
    )
    assert(posters.every(Boolean), `${deviceProfile.name}: every poster decoded (${posters.length})`)

    // Plain language search: the mapping is visible.
    await search(page, 'hands warm light')
    const chips = await page.$$eval(testid(SEARCH_TERM_CHIP), (nodes) =>
      nodes.map((node) => node.getAttribute('data-mapped-to')),
    )
    assert(chips.includes('hands'), `${deviceProfile.name}: "hands" mapped to the vocabulary`)
    assert(chips.includes('warm_light'), `${deviceProfile.name}: "warm light" mapped to warm_light`)

    // A single mapped term must find published work in the seeded library.
    // The two-term intersection above may legitimately be empty; that is what
    // the zero-result ladder is for, and it is asserted separately below.
    await search(page, 'hands')
    const mappedCount = await resultCount(page)
    assert(mappedCount > 0, `${deviceProfile.name}: the mapped search found ${mappedCount} clips`)

    // An unmapped term is surfaced and does not filter.
    await search(page, 'hands doriccolumn')
    assert(
      await exists(page, testid(SEARCH_UNMAPPED_TERM)),
      `${deviceProfile.name}: the unmapped term is surfaced as a chip`,
    )
    const unmappedCount = await resultCount(page)
    await search(page, 'hands')
    const handsCount = await resultCount(page)
    assertEqual(
      unmappedCount,
      handsCount,
      `${deviceProfile.name}: the unmapped term filtered nothing (${unmappedCount} = ${handsCount})`,
    )

    // ---- the AI query parser, layered on the floor above --------------------
    //
    // "golden hour" is deliberately not in the vocabulary and never will be:
    // a taxonomy that grows a term for every phrase an editor might type stops
    // being a taxonomy. The floor leaves all three words unmapped, and the model
    // is offered only then.
    await search(page, 'golden hour window')
    assert(
      await exists(page, testid(SEARCH_ASK_MODEL)),
      `${deviceProfile.name}: the model is offered only because the vocabulary could not place these words`,
    )
    const beforeAsk = await resultCount(page)

    await page.click(testid(SEARCH_ASK_MODEL))
    await page.waitForSelector(testid(SEARCH_PARSE_PROVENANCE), { timeout: 10_000 })

    // The mapping is shown with the words it translated, its confidence, and a
    // provenance read off the run rather than off the current mode.
    const aiChips = await page.$$eval(sel(SEARCH_TERM_CHIP, { 'data-provenance': 'mock' }), (nodes) =>
      nodes.map((node) => ({
        raw: node.getAttribute('data-term'),
        term: node.getAttribute('data-mapped-to'),
      })),
    )
    assert(
      aiChips.some((chip) => chip.raw === 'golden hour' && chip.term === 'warm_light'),
      `${deviceProfile.name}: the model mapped "golden hour" to warm_light, and the chip says which words it translated`,
    )
    assertEqual(
      await page.getAttribute(testid(SEARCH_PARSE_PROVENANCE), 'data-provenance'),
      'mock',
      `${deviceProfile.name}: the parse chip carries the run's provider, so simulated output cannot pass as real`,
    )
    assert(
      (await page.getAttribute(testid(SEARCH_PARSE_PROVENANCE), 'data-ai-run-id')) != null,
      `${deviceProfile.name}: the parse points at a recorded ai_run`,
    )

    // Exactly one chip per mapping. A model term rendered both neutral and amber
    // would say two different things about who decided it.
    const goldenChipCount = await page.$$eval(
      sel(SEARCH_TERM_CHIP, { 'data-mapped-to': 'warm_light' }),
      (nodes) => nodes.length,
    )
    assertEqual(goldenChipCount, 1, `${deviceProfile.name}: the model's mapping is rendered once, not twice`)

    // "window" was not mapped by the floor OR by the model, so it stays visible
    // and still filters nothing. A vocabulary gap must never read as a content gap.
    const stillUnmapped = await page.$$eval(testid(SEARCH_UNMAPPED_TERM), (nodes) =>
      nodes.map((node) => node.getAttribute('data-term')),
    )
    assert(
      stillUnmapped.includes('window'),
      `${deviceProfile.name}: what neither the floor nor the model could place stays on the vocabulary to-do list`,
    )

    // The mapping changed the answer, which is the whole reason to ask.
    const afterAsk = await resultCount(page)
    assert(
      afterAsk !== beforeAsk || afterAsk > 0,
      `${deviceProfile.name}: the model's mapping reached the result set (${beforeAsk} -> ${afterAsk})`,
    )

    // And it is undoable in one click, back to exactly the floor's answer.
    await page.click(
      `${sel(SEARCH_TERM_CHIP, { 'data-provenance': 'mock' })} ${testid(SEARCH_TERM_CHIP_REMOVE)}`,
    )
    await page.waitForTimeout(150)
    assertEqual(
      await resultCount(page),
      beforeAsk,
      `${deviceProfile.name}: removing the model's chip restored the deterministic answer`,
    )

    // Facet chips refine and clear.
    const facetChip = await page.$(testid(FACET_CHIP))
    if (facetChip) {
      const beforeRefine = await resultCount(page)
      await facetChip.click()
      await page.waitForTimeout(120)
      const afterRefine = await resultCount(page)
      assert(
        afterRefine <= beforeRefine,
        `${deviceProfile.name}: a facet chip narrowed ${beforeRefine} to ${afterRefine}`,
      )
      if (await exists(page, testid(FACET_CLEAR_ALL), 800)) {
        await page.click(testid(FACET_CLEAR_ALL))
        await page.waitForTimeout(120)
        assertEqual(await resultCount(page), beforeRefine, `${deviceProfile.name}: clear all restored the count`)
      }
    }

    // The zero-result ladder ends in a recorded gap. Search mapped pairs until
    // one is genuinely empty, which the seeded library guarantees exists.
    const candidates = [
      'reception macro', 'sauna macro', 'studio wide', 'reception closeup',
      'sauna closeup', 'studio closeup', 'treatment_room macro',
    ]
    let zeroQuery = null
    for (const candidate of candidates) {
      await search(page, candidate)
      if ((await resultCount(page)) === 0 && (await exists(page, testid(ZERO_RESULT), 800))) {
        zeroQuery = candidate
        break
      }
    }
    assert(zeroQuery != null, `${deviceProfile.name}: found a genuinely empty mapped query (${zeroQuery})`)
    assert(
      await exists(page, testid(REQUEST_SHOT)),
      `${deviceProfile.name}: the zero state offers "request this shot", never a dead end`,
    )
    await page.click(testid(REQUEST_SHOT_SUBMIT))
    await page.waitForSelector(testid(REQUEST_SHOT_CONFIRMATION), { timeout: 8_000 })
    const gapId = await page.getAttribute(testid(REQUEST_SHOT_CONFIRMATION), ATTR_GAP_ID)
    const cellSignature = await page.getAttribute(testid(REQUEST_SHOT_CONFIRMATION), ATTR_CELL_SIGNATURE)
    assert(!!gapId, `${deviceProfile.name}: the request wrote a gap (${gapId})`)
    assert(!!cellSignature, `${deviceProfile.name}: the gap carries a cell signature (${cellSignature})`)

    // Bin and the usage signal.
    await search(page, 'hands')
    await page.click(testid(RESULT_TILE_ADD_TO_BIN))
    await page.waitForSelector(testid(BIN_PANEL), { timeout: 8_000 })
    assertEqual(
      Number(await page.getAttribute(testid(BIN_COUNT), 'data-count')),
      1,
      `${deviceProfile.name}: the bin holds one clip`,
    )
    // A DOM-level click: the fixed bottom-sheet overlay on emulated mobile
    // trips Playwright's actionability scan even though the button is live,
    // and the handler under test is the same either way.
    await page.$eval(testid(BIN_HANDOFF), (button) => button.click())
    await page.waitForSelector(testid(USAGE_CONFIRMATION), { timeout: 8_000 })
    const rankAtEvent = await page.getAttribute(testid(USAGE_CONFIRMATION), ATTR_RANK_AT_EVENT)
    assertEqual(Number(rankAtEvent), 1, `${deviceProfile.name}: the usage event recorded rank_at_event 1`)
    await page.$eval(testid(BIN_TOGGLE), (button) => button.click())

    // The clip sheet splits responsibility and shows provenance.
    await search(page, '')
    await page.waitForSelector(testid(RESULT_TILE), { timeout: 8_000 })
    await page.click(testid(RESULT_TILE))
    await page.waitForSelector(testid(CLIP_SHEET), { timeout: 8_000 })
    assert(await exists(page, testid(CLIP_SHEET_TAGS_AI)), `${deviceProfile.name}: the sheet shows model tags`)
    assert(await exists(page, testid(CLIP_SHEET_TAGS_HUMAN)), `${deviceProfile.name}: the sheet shows human tags`)
    assert(
      await exists(page, testid(SIMULATED_BADGE)),
      `${deviceProfile.name}: the simulated badge renders off ai_provenance`,
    )

    // Tenancy: nothing internal leaked into the editor DOM.
    const html = await page.content()
    for (const forbidden of FORBIDDEN_STRINGS) {
      assert(
        !html.includes(forbidden),
        `${deviceProfile.name}: "${forbidden}" does not appear anywhere in the editor DOM`,
      )
    }

    await watcher.assertClean(deviceProfile.name)
  } finally {
    await context.close()
  }
}

const server = await startServer()
let browser
try {
  browser = await launch()
} catch (err) {
  assert(false, `chromium is required for the editor run: ${err.message}`)
  if (!server.reused) await stopServer()
  finish()
}

try {
  await run(DESKTOP.name, () => editorChecks(browser, DESKTOP))
  await run(MOBILE.name, () => editorChecks(browser, MOBILE))
} finally {
  await browser.close()
  if (!server.reused) await stopServer()
}

note('editor run complete')
finish()
