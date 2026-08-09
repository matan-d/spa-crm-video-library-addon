/**
 * MANAGER RUN.
 *
 * Source cases: `qa/PLAN.md` "Manager run".
 *
 * Given the seeded hero delivery and the manager role
 * When the manager opens the triage inbox, the deal drawer, and the review
 *      queue, decides clips and publishes
 * Then deliveries are bucketed by what is actionable, the diff shows the true
 *      seven of ten with the extras bucket and the corrected AI over-claim,
 *      the queue is a frozen ordered list where decided rows dim in place, and
 *      publish is an explicit second step that makes work visible to editors.
 */
import {
  BASE_URL, DESKTOP, assert, assertEqual, exists,
  finish, launch, note, openPage, run, startServer, stopServer,
} from './_support/harness.mjs'
import {
  ACTIVE_ROLE, ATTR_ROLE,
  CREATORS_ROOT, CREATOR_ROW, CREATOR_FIT_SCORE, CREATOR_OVERRIDE, CREATOR_OVERRIDE_FORM,
  CREATOR_OVERRIDE_NOTE, CREATOR_VET, CREATOR_VET_RECEIPT,
  OVERRIDE_ERROR, OVERRIDE_REASON, OVERRIDE_SAVE, OVERRIDE_SCORE,
  SCORECARD_APPROVAL_RATE,
  DEAL_DRAWER, DIFF_BUCKET_EXTRAS, DIFF_COVERAGE_PCT, DIFF_ITEM_ROW,
  PUBLISH_CONFIRMATION, PUBLISH_TO_LIBRARY,
  RESULT_GRID, REVIEW_APPROVE, REVIEW_DECIDED_BADGE, REVIEW_ORDERED_LIST,
  REVIEW_PROGRESS, REVIEW_ROW, ROLE_MANAGER, ROLE_OPTION,
  TRIAGE_BUCKET, TRIAGE_DELIVERY_ROW, TRIAGE_OPEN_DELIVERY, TRIAGE_ROOT,
  TRIAGE_START_REVIEW,
  sel, testid,
} from './_support/testids.mjs'

async function boot(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector(testid(RESULT_GRID), { timeout: 30_000 })
  await page.click(sel(ROLE_OPTION, { [ATTR_ROLE]: ROLE_MANAGER }))
  await page.waitForSelector(sel(ACTIVE_ROLE, { [ATTR_ROLE]: ROLE_MANAGER }), { timeout: 10_000 })
}

async function managerChecks(browser, deviceProfile) {
  const { context, page, watcher } = await openPage(browser, deviceProfile)
  try {
    await boot(page)

    // The triage inbox groups by what is actionable.
    await page.click(testid('nav-triage'))
    await page.waitForSelector(testid(TRIAGE_ROOT), { timeout: 15_000 })
    const buckets = await page.$$eval(testid(TRIAGE_BUCKET), (nodes) =>
      nodes.map((node) => node.getAttribute('data-bucket')),
    )
    assertEqual(
      buckets.join(','),
      'needs_review,awaiting_derivatives,blocked,done',
      `${deviceProfile.name}: buckets render in actionability order`,
    )
    const rows = await page.$$(testid(TRIAGE_DELIVERY_ROW))
    assert(rows.length > 0, `${deviceProfile.name}: the inbox holds ${rows.length} deliveries`)

    // The hero delivery's drawer: the diff tells the truth.
    const heroRow = await page.$(sel(TRIAGE_DELIVERY_ROW, { 'data-delivery-id': 'delivery-hero' }))
    assert(!!heroRow, `${deviceProfile.name}: the hero delivery is in the inbox`)
    await heroRow.$eval(testid(TRIAGE_OPEN_DELIVERY), (button) => button.click())
    await page.waitForSelector(testid(DEAL_DRAWER), { timeout: 8_000 })

    const coveragePct = Number(await page.getAttribute(testid(DIFF_COVERAGE_PCT), 'data-coverage-pct'))
    assertEqual(coveragePct, 70, `${deviceProfile.name}: coverage reads the true 7 of 10 (70%)`)

    const itemStatuses = await page.$$eval(testid(DIFF_ITEM_ROW), (nodes) =>
      nodes.map((node) => node.getAttribute('data-status')),
    )
    assertEqual(itemStatuses.length, 10, `${deviceProfile.name}: all ten brief items render`)
    // The hero delivery contains the sheetless HEVC clip, so unmet items read
    // indeterminate rather than missing: while an unjudgeable clip exists,
    // "missing" is a claim the evidence cannot support. That downgrade is the
    // three-bucket design working, and this asserts it.
    assert(
      itemStatuses.includes('met') && itemStatuses.includes('indeterminate'),
      `${deviceProfile.name}: the diff shows met and indeterminate states (${itemStatuses.join(',')})`,
    )
    assert(
      !itemStatuses.includes('missing'),
      `${deviceProfile.name}: nothing reads missing while a sheetless clip could still cover it`,
    )

    const extrasCount = Number(await page.getAttribute(testid(DIFF_BUCKET_EXTRAS), 'data-count'))
    assert(extrasCount >= 3, `${deviceProfile.name}: the extras bucket is real (${extrasCount} clips)`)

    const corrected = await page.$$('[data-provenance="ai-corrected"]')
    assert(
      corrected.length >= 1,
      `${deviceProfile.name}: the corrected AI over-claim is visible, not silently gone`,
    )

    // The review queue: frozen order, decisions dim in place, publish works.
    await page.click(testid('nav-triage'))
    await page.waitForSelector(testid(TRIAGE_ROOT), { timeout: 8_000 })
    const reviewRow = await page.$(sel(TRIAGE_DELIVERY_ROW, { 'data-delivery-id': 'delivery-hero' }))
    await reviewRow.$eval(testid(TRIAGE_START_REVIEW), (button) => button.click())
    await page.waitForSelector(testid(REVIEW_ORDERED_LIST), { timeout: 8_000 })

    const total = Number(await page.getAttribute(testid(REVIEW_PROGRESS), 'data-total'))
    assert(total > 0, `${deviceProfile.name}: the frozen queue holds ${total} clips`)
    const orderBefore = await page.$$eval(testid(REVIEW_ROW), (nodes) =>
      nodes.map((node) => node.getAttribute('data-asset-id')),
    )

    await page.click(testid(REVIEW_APPROVE))
    await page.waitForSelector(testid(REVIEW_DECIDED_BADGE), { timeout: 8_000 })
    const decidedBadge = await page.getAttribute(testid(REVIEW_DECIDED_BADGE), 'data-decision')
    assertEqual(decidedBadge, 'approved', `${deviceProfile.name}: the decision is recorded on the row`)

    const orderAfter = await page.$$eval(testid(REVIEW_ROW), (nodes) =>
      nodes.map((node) => node.getAttribute('data-asset-id')),
    )
    assertEqual(
      orderAfter.join(','),
      orderBefore.join(','),
      `${deviceProfile.name}: the decided row dimmed in place, the order never changed`,
    )

    await page.click(testid(PUBLISH_TO_LIBRARY))
    await page.waitForSelector(testid(PUBLISH_CONFIRMATION), { timeout: 8_000 })
    const publishedCount = Number(await page.getAttribute(testid(PUBLISH_CONFIRMATION), 'data-count'))
    assert(publishedCount >= 1, `${deviceProfile.name}: publish confirmed ${publishedCount} clip(s)`)

    // ---- the creator roster ------------------------------------------------
    //
    // The panel's whole argument is that a guess and a measurement sit next to
    // each other, so what is asserted is that the two never get confused: the
    // score says who decided it, and a rate with no denominator says so rather
    // than reading as zero.
    await page.click(testid('nav-creators'))
    await page.waitForSelector(testid(CREATORS_ROOT), { timeout: 15_000 })
    // The panel's shell renders before its rows: the roster is four awaited
    // reads plus a derivation. Counting rows without waiting would report zero
    // and call it a rendering bug.
    await page.waitForSelector(testid(CREATOR_ROW), { timeout: 15_000 })

    const roster = await page.$$(testid(CREATOR_ROW))
    assert(roster.length > 0, `${deviceProfile.name}: the roster rendered ${roster.length} creators`)

    // Provenance and the row's own score source agree. A score styled as a human
    // decision while the data says a model produced it is the exact defect the
    // colour rule exists to prevent, and it is invisible to a screenshot.
    const scores = await page.$$eval(testid(CREATOR_ROW), (rows) =>
      rows.map((row) => ({
        source: row.getAttribute('data-score-source'),
        provenance: row.querySelector('[data-testid="creator-fit-score"]')?.getAttribute('data-provenance'),
        lifecycle: row.getAttribute('data-lifecycle'),
      })),
    )
    const expectedProvenance = { human: 'human', model: 'ai', none: 'none' }
    assert(
      scores.every((row) => row.provenance === expectedProvenance[row.source]),
      `${deviceProfile.name}: every score's provenance matches its source (${scores.map((s) => s.source).join(',')})`,
    )

    // The seed carries one human override, and the model's number stays visible
    // underneath it. Hiding it would erase the disagreement.
    assert(
      scores.some((row) => row.source === 'human'),
      `${deviceProfile.name}: a human override is on the roster`,
    )
    assert(
      await exists(page, testid(CREATOR_OVERRIDE_NOTE)),
      `${deviceProfile.name}: the override names the model's number it replaced`,
    )

    // A creator with nothing to measure reads unknown, never 0%.
    const rates = await page.$$eval(testid(SCORECARD_APPROVAL_RATE), (nodes) =>
      nodes.map((node) => ({ status: node.getAttribute('data-status'), text: node.textContent.trim() })),
    )
    assert(
      rates.some((rate) => rate.status === 'unknown'),
      `${deviceProfile.name}: an unmeasurable approval rate exists in the seed`,
    )
    assert(
      rates.filter((rate) => rate.status === 'unknown').every((rate) => rate.text.startsWith('unknown')),
      `${deviceProfile.name}: an unknown rate says unknown rather than rendering as zero`,
    )

    // The model refuses to re-score a creator a human blocked. A second opinion
    // on a decision the model was never part of is worse than no opinion.
    const blocked = await page.$(sel(CREATOR_ROW, { 'data-lifecycle': 'blocked' }))
    assert(blocked != null, `${deviceProfile.name}: the seed carries a blocked creator, so the gate has data`)
    const blockedVet = await blocked.$(testid(CREATOR_VET))
    assertEqual(
      await blockedVet.isDisabled(),
      true,
      `${deviceProfile.name}: the blocked creator cannot be re-scored by a model`,
    )

    // Scoring an unblocked creator records a run and the receipt points at it.
    const openRow = await page.$(sel(CREATOR_ROW, { 'data-lifecycle': 'prospect' }))
      ?? await page.$(sel(CREATOR_ROW, { 'data-lifecycle': 'active' }))
    assert(openRow != null, `${deviceProfile.name}: found a creator the model may score`)
    await (await openRow.$(testid(CREATOR_VET))).click()
    await page.waitForSelector(testid(CREATOR_VET_RECEIPT), { timeout: 15_000 })
    assert(
      (await page.getAttribute(testid(CREATOR_VET_RECEIPT), 'data-ai-run-id')) != null,
      `${deviceProfile.name}: the vetting receipt points at a recorded ai_run`,
    )

    // An override needs a reason. A number with no explanation is not a decision.
    // The row is tracked by id, because saving re-sorts the roster and asserting
    // on "the first row" afterwards would be asserting about a different creator.
    const overrideRow = await page.$(sel(CREATOR_ROW, { 'data-score-source': 'model' }))
    assert(overrideRow != null, `${deviceProfile.name}: found a model-scored creator to override`)
    const overrideId = await overrideRow.getAttribute('data-creator-id')
    await (await overrideRow.$(testid(CREATOR_OVERRIDE))).click()
    await page.waitForSelector(testid(CREATOR_OVERRIDE_FORM), { timeout: 8_000 })
    await page.fill(testid(OVERRIDE_SCORE), '71')
    await page.fill(testid(OVERRIDE_REASON), '')
    await page.click(testid(OVERRIDE_SAVE))
    await page.waitForSelector(testid(OVERRIDE_ERROR), { timeout: 8_000 })
    assert(true, `${deviceProfile.name}: an override with no reason is refused`)

    await page.fill(testid(OVERRIDE_REASON), 'Met them at the branch; better fit than the score suggests.')
    await page.click(testid(OVERRIDE_SAVE))
    await page.waitForSelector(
      sel(CREATOR_ROW, { 'data-creator-id': overrideId, 'data-score-source': 'human' }),
      { timeout: 8_000 },
    )
    const savedRow = await page.$(sel(CREATOR_ROW, { 'data-creator-id': overrideId }))
    assertEqual(
      await savedRow.getAttribute('data-score-source'),
      'human',
      `${deviceProfile.name}: the saved override reads as a human decision on that creator's row`,
    )
    assertEqual(
      await savedRow.$eval(testid(CREATOR_FIT_SCORE), (node) => node.getAttribute('data-score')),
      '71',
      `${deviceProfile.name}: the number a manager sees is the one they typed, not the model's`,
    )

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
  assert(false, `chromium is required for the manager run: ${err.message}`)
  if (!server.reused) await stopServer()
  finish()
}

try {
  await run(DESKTOP.name, () => managerChecks(browser, DESKTOP))
} finally {
  await browser.close()
  if (!server.reused) await stopServer()
}

note('manager run complete')
finish()
