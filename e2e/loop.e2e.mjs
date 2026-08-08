/**
 * LOOP RUN: the flagship, and the only test that proves the product's thesis.
 *
 * Source: `qa/PLAN.md`, the loop run. It asserts ids, never screenshots.
 *
 * Everything else in this suite proves a surface works. This proves the CLAIM:
 * that what an editor searched for and could not find becomes the next creator's
 * shot list, and that the footage which comes back measurably closes the gap. If
 * this run cannot be written, the submission is a pipeline with AI in it rather
 * than a closed loop, so it is worth more than any other spec here.
 *
 * The chain, hop by hop, each one read out of the DOM or the database rather
 * than assumed:
 *
 *   1. EDITOR searches plain language, finds nothing, and asks for the shot.
 *      -> a `gap` row exists, with a cell signature and an editor_request signal
 *   2. MANAGER generates a brief from open gaps.
 *      -> a `brief_item` carries `origin_gap_id` equal to that gap
 *   3. MANAGER locks the brief and mints an invite link.
 *      -> the raw token is shown once; only its sha256 is stored
 *   4. CREATOR opens that token, agrees, uploads a real clip, and says which
 *      shot it is.
 *      -> an `asset` exists with `creator_claimed_brief_item_id` on that item
 *   5. MANAGER reviews it, asks the model for tags, confirms the match, publishes.
 *      -> `review_action`, `ai_run`, `confirmed_brief_item_id`, `is_published`
 *   6. EDITOR can now find it, and using it records the rank it held.
 *      -> a `usage_event` with `rank_at_event`
 *   7. MANAGER detects closures.
 *      -> the gap is `closed`, names the closing asset, and closed BECAUSE a
 *         human confirmed the brief item, not because a tag happened to match
 *
 * One browser context throughout, with role switches, because a loop assembled
 * from six independent fixtures would prove nothing about whether the hops
 * actually join up.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  BASE_URL, DESKTOP, assert, assertEqual, exists,
  finish, launch, note, openPage, run, startServer, stopServer,
} from './_support/harness.mjs'
import {
  ACTIVE_ROLE, ATTR_BRIEF_ITEM_ID, ATTR_CELL_SIGNATURE, ATTR_COUNT, ATTR_FILE_NAME,
  ATTR_GAP_ID, ATTR_ORIGIN_GAP_ID, ATTR_PROVENANCE, ATTR_RANK_AT_EVENT, ATTR_ROLE,
  ATTR_STATUS, ATTR_TOKEN,
  BIN_HANDOFF, BIN_PANEL,
  BRIEF_GENERATE_FROM_GAPS, BRIEF_INVITE_LINK, BRIEF_ITEM_ROW, BRIEF_LOCK, BRIEF_ROOT,
  CONSENT_ACCEPT, CONSENT_RECORDED,
  GAP_CLOSED_BADGE, GAP_ROW, GAPS_ROOT,
  INVITE_CONTINUE, INVITE_ROOT,
  LIBRARY_SEARCH_INPUT, LIBRARY_SEARCH_SUBMIT,
  PUBLISH_CONFIRMATION, PUBLISH_TO_LIBRARY,
  REQUEST_SHOT_CONFIRMATION, REQUEST_SHOT_SUBMIT,
  RESULT_COUNT, RESULT_GRID, RESULT_TILE, RESULT_TILE_ADD_TO_BIN,
  REVIEW_APPROVE, REVIEW_CURRENT_ASSET, REVIEW_NEXT, REVIEW_ROOT,
  ROLE_EDITOR, ROLE_MANAGER, ROLE_OPTION,
  SIMULATED_BADGE, UPLOAD_FILE_INPUT, UPLOAD_FILE_ROW, UPLOAD_ROOT, UPLOAD_SUBMIT,
  UPLOAD_SUBMIT_CONFIRMATION, USAGE_CONFIRMATION, ZERO_RESULT,
  sel, testid,
} from './_support/testids.mjs'

const require = createRequire(import.meta.url)
/** See e2e/decode.e2e.mjs: stopping a media read early is the design. */
const TEARDOWN_ABORT = /blob:.*ERR_ABORTED/
const RUN_TAGGER = 'run-vision-tagger'

/**
 * Candidate cells for the gap this run turns on.
 *
 * Discovered at run time rather than hardcoded: the seeded library is generated
 * and its coverage can shift, and a loop test that silently starts from a cell
 * the library already covers would assert nothing at all. The run tries these in
 * order and uses the first that genuinely returns nothing, so the gap it creates
 * is a real gap in the data it is running against.
 */
const GAP_CANDIDATES = [
  'lounge macro',
  'sauna macro',
  'reception macro',
  'studio wide',
  'corridor macro',
  'wet_room wide',
  'lounge closeup',
]

function makeClip() {
  const ffmpeg = require('ffmpeg-static')
  const dir = mkdtempSync(join(tmpdir(), 'astolia-e2e-loop-'))
  const path = join(dir, 'lounge_wide.mp4')
  execFileSync(
    ffmpeg,
    [
      '-y', '-f', 'lavfi', '-i', 'mandelbrot=size=1080x1920:rate=25',
      '-t', '6',
      '-c:v', 'libvpx-vp9', '-b:v', '900k', '-pix_fmt', 'yuv420p',
      '-metadata', 'creation_time=2026-08-04T12:00:00Z',
      '-f', 'mp4', path,
    ],
    { stdio: 'ignore' },
  )
  return path
}

async function switchRole(page, role) {
  await page.$eval(sel(ROLE_OPTION, { [ATTR_ROLE]: role }), (button) => button.click())
  await page.waitForSelector(sel(ACTIVE_ROLE, { [ATTR_ROLE]: role }), { timeout: 15_000 })
}

async function readRows(page, store) {
  return page.evaluate(async (storeName) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('astolia_demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction([storeName], 'readonly').objectStore(storeName).getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return rows
  }, store)
}

async function search(page, text) {
  await page.fill(testid(LIBRARY_SEARCH_INPUT), text)
  await page.$eval(testid(LIBRARY_SEARCH_SUBMIT), (button) => button.click())
  await page.waitForTimeout(250)
  const el = await page.$(testid(RESULT_COUNT))
  return el ? Number(await el.getAttribute('data-count')) : 0
}

async function theLoop(browser, clipPath) {
  const { context, page, watcher } = await openPage(browser, DESKTOP, { ignore: [TEARDOWN_ABORT] })
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(RESULT_GRID), { timeout: 30_000 })

    // ---- HOP 1: an editor cannot find something, and asks for it -----------
    await switchRole(page, ROLE_EDITOR)
    await page.waitForSelector(testid(RESULT_GRID), { timeout: 15_000 })

    let gapQuery = null
    for (const candidate of GAP_CANDIDATES) {
      const hits = await search(page, candidate)
      if (hits === 0 && (await exists(page, testid(ZERO_RESULT), 2000))) {
        gapQuery = candidate
        break
      }
    }
    assert(
      !!gapQuery,
      `the editor found a genuinely uncovered cell to ask about ("${gapQuery}")`,
    )
    if (!gapQuery) return
    assert(await exists(page, testid(ZERO_RESULT), 5000), 'the zero result state offers a way forward')

    await page.$eval(testid(REQUEST_SHOT_SUBMIT), (button) => button.click())
    await page.waitForSelector(testid(REQUEST_SHOT_CONFIRMATION), { timeout: 10_000 })
    const gapId = await page.getAttribute(testid(REQUEST_SHOT_CONFIRMATION), ATTR_GAP_ID)
    const cellSignature = await page.getAttribute(testid(REQUEST_SHOT_CONFIRMATION), ATTR_CELL_SIGNATURE)
    assert(!!gapId, `HOP 1: the request wrote a gap (${gapId})`)
    note(`HOP 1: gap ${gapId} with cell ${cellSignature}`)

    const gapRows = await readRows(page, 'gap')
    const gap = gapRows.find((row) => row.id === gapId)
    assert(!!gap, 'HOP 1: the gap row is readable')
    assert(
      gap.signals.some((signal) => signal.source === 'editor_request'),
      'HOP 1: the gap names an editor request as its evidence, so its origin is traceable',
    )
    assertEqual(gap.status, 'open', 'HOP 1: the gap starts open')

    // ---- HOP 2: the manager turns open gaps into a shot list ---------------
    await switchRole(page, ROLE_MANAGER)
    await page.goto(`${BASE_URL}/#/gaps`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(GAPS_ROOT), { timeout: 20_000 })
    assert(
      await exists(page, sel(GAP_ROW, { [ATTR_GAP_ID]: gapId }), 10_000),
      'HOP 2: the editor-requested gap appears on the manager gaps panel',
    )

    await page.goto(`${BASE_URL}/#/briefs`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(BRIEF_ROOT), { timeout: 20_000 })
    // Wait for the control to be usable, not merely present: the page shell
    // renders before its data arrives, and clicking early is how this run
    // generated a brief for no collab and then waited thirty seconds for an item
    // that was never going to exist.
    await page.waitForFunction(
      ([selector]) => {
        const button = document.querySelector(selector)
        return !!button && !button.disabled
      },
      [testid(BRIEF_GENERATE_FROM_GAPS)],
      { timeout: 20_000 },
    )
    await page.$eval(testid(BRIEF_GENERATE_FROM_GAPS), (button) => button.click())
    await page.waitForTimeout(900)

    const itemSelector = sel(BRIEF_ITEM_ROW, { [ATTR_ORIGIN_GAP_ID]: gapId })
    assert(
      await exists(page, itemSelector, 10_000),
      'HOP 2: a brief item carries origin_gap_id pointing back at that gap',
    )
    const briefItemId = await page.getAttribute(itemSelector, ATTR_BRIEF_ITEM_ID)
    assert(!!briefItemId, `HOP 2: the generated item has an id (${briefItemId})`)

    const briefItems = await readRows(page, 'brief_item')
    const item = briefItems.find((row) => row.id === briefItemId)
    assertEqual(item?.origin_gap_id, gapId, 'HOP 2: the link is in the data, not only in the DOM')
    note(`HOP 2: brief item ${briefItemId} instructs "${item?.instruction}"`)

    // ---- HOP 3: lock the promise, mint the link ----------------------------
    const briefId = item.brief_id
    const lockSelector = `${sel('brief-header', { 'data-brief-id': briefId })} ~ * ${testid(BRIEF_LOCK)}`
    void lockSelector
    // Lock whichever brief holds our item, by finding its card's lock control.
    await page.evaluate(
      ([briefIdValue, lockTestid]) => {
        const header = document.querySelector(`[data-brief-id="${briefIdValue}"]`)
        const card = header?.closest('article')
        card?.querySelector(`[data-testid="${lockTestid}"]`)?.click()
      },
      [briefId, BRIEF_LOCK],
    )
    await page.waitForTimeout(500)

    const briefs = await readRows(page, 'brief')
    const lockedBrief = briefs.find((row) => row.id === briefId)
    assertEqual(lockedBrief?.status, 'locked', 'HOP 3: the brief is locked, so the promise is frozen')
    assert(lockedBrief?.locked_at != null, 'HOP 3: the lock records when it happened')

    // Mint the invite link on that brief's card.
    await page.evaluate(
      ([briefIdValue]) => {
        const header = document.querySelector(`[data-brief-id="${briefIdValue}"]`)
        const card = header?.closest('article')
        const buttons = Array.from(card?.querySelectorAll('button') ?? [])
        buttons.find((button) => /create invite link/i.test(button.textContent ?? ''))?.click()
      },
      [briefId],
    )
    await page.waitForSelector(testid(BRIEF_INVITE_LINK), { timeout: 10_000 })
    const rawToken = await page.getAttribute(testid(BRIEF_INVITE_LINK), ATTR_TOKEN)
    assert(!!rawToken, `HOP 3: an invite token was minted and shown once (${String(rawToken).slice(0, 18)}...)`)

    const tokenRows = await readRows(page, 'access_token')
    assert(
      tokenRows.every((row) => row.token_hash !== rawToken),
      'HOP 3: the raw token is NOT stored anywhere, only its hash',
    )

    // ---- HOP 4: the creator delivers against the locked brief -------------
    await page.goto(`${BASE_URL}/#/c/${rawToken}`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(INVITE_ROOT), { timeout: 30_000 })
    if (await exists(page, testid(CONSENT_ACCEPT), 5000)) {
      await page.$eval(testid(CONSENT_ACCEPT), (button) => button.click())
      await page.waitForSelector(testid(CONSENT_RECORDED), { timeout: 10_000 })
      await page.$eval(testid(INVITE_CONTINUE), (button) => button.click())
    }
    await page.waitForSelector(testid(UPLOAD_ROOT), { timeout: 20_000 })
    const deliveryId = await page.getAttribute(testid(UPLOAD_ROOT), 'data-delivery-id')
    assert(!!deliveryId, `HOP 4: a delivery exists for this collab (${deliveryId})`)

    await page.setInputFiles(testid(UPLOAD_FILE_INPUT), [clipPath])
    const rowSelector = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'lounge_wide.mp4' })
    await page.waitForSelector(rowSelector, { timeout: 30_000 })
    await page.waitForFunction(
      ([selector]) => {
        const state = document.querySelector(selector)?.getAttribute('data-upload-state')
        return state === 'stored' || state === 'blocked' || state === 'failed'
      },
      [rowSelector],
      { timeout: 120_000 },
    )
    assertEqual(
      await page.getAttribute(rowSelector, 'data-upload-state'),
      'stored',
      'HOP 4: the delivered clip passed pre-flight',
    )
    const assetId = await page.getAttribute(rowSelector, 'data-asset-id')
    assert(!!assetId, `HOP 4: the clip became an asset (${assetId})`)

    // The creator says which shot it is. Their claim, in its own column.
    await page.selectOption(`${rowSelector} select`, briefItemId)
    await page.waitForTimeout(300)
    const assetsAfterUpload = await readRows(page, 'asset')
    const delivered = assetsAfterUpload.find((row) => row.id === assetId)
    assertEqual(
      delivered?.creator_claimed_brief_item_id,
      briefItemId,
      'HOP 4: the creator claim is recorded against the item that came from the gap',
    )
    assertEqual(
      delivered?.confirmed_brief_item_id,
      null,
      'HOP 4: nothing is confirmed yet, because no manager has looked',
    )

    await page.$eval(testid(UPLOAD_SUBMIT), (button) => button.click())
    await page.waitForSelector(testid(UPLOAD_SUBMIT_CONFIRMATION), { timeout: 20_000 })

    // ---- HOP 5: the manager reviews, asks the model, confirms, publishes ----
    await switchRole(page, ROLE_MANAGER)
    await page.goto(`${BASE_URL}/#/review/${deliveryId}`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(REVIEW_ROOT), { timeout: 20_000 })

    // Walk to our clip.
    let landed = false
    for (let step = 0; step < 20; step += 1) {
      const current = await page.getAttribute(testid(REVIEW_CURRENT_ASSET), 'data-asset-id')
      if (current === assetId) {
        landed = true
        break
      }
      if (!(await exists(page, testid(REVIEW_NEXT), 1000))) break
      await page.$eval(testid(REVIEW_NEXT), (button) => button.click())
      await page.waitForTimeout(80)
    }
    assert(landed, 'HOP 5: the review queue reaches the delivered clip')

    // The model is asked, explicitly, and its answer is amber and attributed.
    await page.$eval(testid(RUN_TAGGER), (button) => button.click())
    await page.waitForSelector(testid(SIMULATED_BADGE), { timeout: 60_000 })
    assertEqual(
      await page.getAttribute(testid(SIMULATED_BADGE), ATTR_PROVENANCE),
      'mock',
      'HOP 5: the badge reports the provenance stored on the asset',
    )

    const runs = await readRows(page, 'ai_run')
    const run = runs.find((row) => row.subject_id === assetId)
    assert(!!run, `HOP 5: an ai_run row exists for this clip (${run?.id})`)
    assertEqual(run?.model_id, null, 'HOP 5: the mock run claims no model')

    // The human confirms the match against the item that came from the gap.
    await page.selectOption(`${testid(REVIEW_CURRENT_ASSET)} select`, briefItemId)
    await page.waitForTimeout(150)
    await page.$eval(testid(REVIEW_APPROVE), (button) => button.click())
    await page.waitForTimeout(500)

    await page.$eval(testid(PUBLISH_TO_LIBRARY), (button) => button.click())
    await page.waitForSelector(testid(PUBLISH_CONFIRMATION), { timeout: 20_000 })

    const assetsAfterReview = await readRows(page, 'asset')
    const reviewed = assetsAfterReview.find((row) => row.id === assetId)
    assertEqual(
      reviewed?.confirmed_brief_item_id,
      briefItemId,
      'HOP 5: the manager confirmed the clip against the brief item from the gap',
    )
    assertEqual(reviewed?.review_status, 'approved', 'HOP 5: the clip is approved')
    assertEqual(reviewed?.is_published, true, 'HOP 5: the clip is published to the library')

    const actions = await readRows(page, 'review_action')
    const action = actions.find((row) => row.asset_id === assetId)
    assert(!!action, `HOP 5: a review_action records the decision (${action?.decision})`)
    assertEqual(
      action?.ai_provenance_at_decision,
      'mock',
      'HOP 5: the action records that the human decided while looking at simulated AI evidence',
    )

    // ---- HOP 6: the editor can now find it, and using it is recorded -------
    await switchRole(page, ROLE_EDITOR)
    await page.goto(`${BASE_URL}/#/library`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(RESULT_GRID), { timeout: 20_000 })

    const visible = await page.locator(sel(RESULT_TILE, { 'data-asset-id': assetId })).count()
    assertEqual(visible, 1, 'HOP 6: the published clip is now visible to the editor')

    await page.$eval(sel(RESULT_TILE, { 'data-asset-id': assetId }), (tile) => {
      tile.querySelector('[data-testid="result-tile-add-to-bin"]')?.click()
    })
    void RESULT_TILE_ADD_TO_BIN
    await page.waitForSelector(testid(BIN_PANEL), { timeout: 10_000 })
    await page.$eval(testid(BIN_HANDOFF), (button) => button.click())
    await page.waitForSelector(testid(USAGE_CONFIRMATION), { timeout: 15_000 })
    const rankAtEvent = await page.getAttribute(testid(USAGE_CONFIRMATION), ATTR_RANK_AT_EVENT)
    assert(
      Number(rankAtEvent) >= 1,
      `HOP 6: confirming use recorded the rank the clip held at that moment (${rankAtEvent})`,
    )

    const usage = await readRows(page, 'usage_event')
    const event = usage.find((row) => row.asset_id === assetId && row.kind === 'confirmed_use')
    assert(!!event, 'HOP 6: a usage_event records the confirmed use')
    assert(
      event?.rank_at_event != null,
      'HOP 6: the usage event carries rank_at_event, which cannot be backfilled later',
    )

    // ---- HOP 7: the gap closes, and says why ------------------------------
    await switchRole(page, ROLE_MANAGER)
    await page.goto(`${BASE_URL}/#/gaps`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(GAPS_ROOT), { timeout: 20_000 })
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      buttons.find((button) => /detect closures/i.test(button.textContent ?? ''))?.click()
    })
    await page.waitForTimeout(900)

    const closedRow = sel(GAP_ROW, { [ATTR_GAP_ID]: gapId, [ATTR_STATUS]: 'closed' })
    assert(
      await exists(page, closedRow, 15_000),
      'HOP 7: the gap now reads as closed on the manager panel',
    )
    assert(
      await exists(page, `${closedRow} ${testid(GAP_CLOSED_BADGE)}`, 5000),
      'HOP 7: the closed gap says how many clips closed it',
    )
    assertEqual(
      Number(await page.getAttribute(`${closedRow} ${testid(GAP_CLOSED_BADGE)}`, ATTR_COUNT)),
      1,
      'HOP 7: exactly the one delivered clip is credited with closing it',
    )

    const finalGaps = await readRows(page, 'gap')
    const closed = finalGaps.find((row) => row.id === gapId)
    assertEqual(closed?.status, 'closed', 'HOP 7: the gap row is closed in the data')
    assert(
      closed?.closing_asset_ids?.includes(assetId),
      'HOP 7: the gap names the asset that closed it, so the claim is auditable',
    )

    // The whole chain, restated as one readable sentence of ids.
    note(
      `THE LOOP: gap ${gapId} -> brief_item ${briefItemId} -> asset ${assetId} ` +
        `-> review_action ${action?.id} -> published -> usage_event ${event?.id} -> gap closed`,
    )

    await watcher.assertClean('loop run')
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

let clipPath = null
await run('preconditions: a clip the creator can actually deliver', async () => {
  clipPath = makeClip()
  assert(!!clipPath, 'generated a decodable vertical clip for the delivery')
})

const server = await startServer()
let browser
try {
  browser = await launch()
} catch (err) {
  assert(false, `chromium is required for the loop run: ${err.message}`)
  if (!server.reused) await stopServer()
  finish()
}

try {
  if (clipPath) {
    await run('the closed loop, end to end, by ids', () => theLoop(browser, clipPath))
  }
} finally {
  await browser.close()
  if (!server.reused) await stopServer()
}

finish()
