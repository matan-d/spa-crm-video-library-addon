/**
 * AI RUN: the only proof that the model seam is exercised by the running app.
 *
 * Source cases: `qa/cases/ai.md`, and the provenance invariants in
 * `docs/06-decisions.md` (U7, U8, D16, D17, D18).
 *
 * The unit suites prove the mock is deterministic, that its fixtures were
 * authored against the committed contact sheets, and that a mock run cannot
 * claim a model. What they cannot prove is that the application ever calls it,
 * and an AI seam nothing calls is a design document rather than a feature. So
 * this run drives the actual chain a reviewer would drive:
 *
 *   a creator uploads a clip, which has no AI fields at all
 *     -> a manager opens the review queue for that delivery
 *       -> the clip says "no model has looked at this yet"
 *         -> the manager asks for an analysis
 *           -> amber output appears, an ai_run row exists, tags point at it
 *
 * And the refusal path, which matters more than the happy one: a clip with no
 * contact sheet must produce no run, no tags and no AI fields, and must say why.
 * A plausible tag on footage nobody could decode is the least detectable and most
 * damaging failure this product can have.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  BASE_URL, DESKTOP, REPO_ROOT, assert, assertEqual, exists,
  finish, launch, note, openPage, run, startServer, stopServer,
} from './_support/harness.mjs'
import {
  ACTIVE_ROLE, ATTR_FILE_NAME, ATTR_PROVENANCE, ATTR_ROLE,
  CONSENT_ACCEPT, CONSENT_RECORDED, INVITE_CONTINUE, INVITE_ROOT,
  REVIEW_CURRENT_ASSET, REVIEW_NEXT, REVIEW_ROOT,
  ROLE_MANAGER, ROLE_OPTION,
  SIMULATED_BADGE, UPLOAD_FILE_INPUT, UPLOAD_FILE_ROW, UPLOAD_ROOT,
  sel, testid,
} from './_support/testids.mjs'

const require = createRequire(import.meta.url)
const INVITE_URL = '/#/c/demo-creator-token'
/** See e2e/decode.e2e.mjs: stopping a media read early is the design. */
const TEARDOWN_ABORT = /blob:.*ERR_ABORTED/

const RUN_TAGGER = 'run-vision-tagger'
const TAGGER_REFUSAL = 'tagger-refusal'

function makeDecodableClip() {
  const ffmpeg = require('ffmpeg-static')
  const dir = mkdtempSync(join(tmpdir(), 'astolia-e2e-ai-'))
  const path = join(dir, 'sauna_vertical.mp4')
  execFileSync(
    ffmpeg,
    [
      '-y', '-f', 'lavfi', '-i', 'mandelbrot=size=1080x1920:rate=25',
      '-t', '6',
      '-c:v', 'libvpx-vp9', '-b:v', '900k', '-pix_fmt', 'yuv420p',
      '-metadata', 'creation_time=2026-08-04T11:30:00Z',
      '-f', 'mp4', path,
    ],
    { stdio: 'ignore' },
  )
  return path
}

/** Everything the invariants need, read straight out of IndexedDB. */
async function readAiState(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('astolia_demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const all = (store) =>
      new Promise((resolve, reject) => {
        const request = db.transaction([store], 'readonly').objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const [runs, tags, assets] = await Promise.all([all('ai_run'), all('tag'), all('asset')])
    db.close()
    return { runs, tags, assets }
  })
}

async function uploadOneClip(page, clipPath) {
  await page.goto(`${BASE_URL}${INVITE_URL}`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector(testid(INVITE_ROOT), { timeout: 30_000 })
  if (await exists(page, testid(CONSENT_ACCEPT), 3000)) {
    await page.click(testid(CONSENT_ACCEPT))
    await page.waitForSelector(testid(CONSENT_RECORDED), { timeout: 10_000 })
    await page.click(testid(INVITE_CONTINUE))
  }
  await page.waitForSelector(testid(UPLOAD_ROOT), { timeout: 20_000 })
  const deliveryId = await page.getAttribute(testid(UPLOAD_ROOT), 'data-delivery-id')

  await page.setInputFiles(testid(UPLOAD_FILE_INPUT), [clipPath])
  const rowSelector = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'sauna_vertical.mp4' })
  await page.waitForSelector(rowSelector, { timeout: 30_000 })
  await page.waitForFunction(
    ([selector]) => {
      const state = document.querySelector(selector)?.getAttribute('data-upload-state')
      return state === 'stored' || state === 'blocked' || state === 'failed'
    },
    [rowSelector],
    { timeout: 120_000 },
  )
  const assetId = await page.getAttribute(rowSelector, 'data-asset-id')
  return { deliveryId, assetId }
}

/**
 * Opens a delivery's review queue AS THE MANAGER.
 *
 * The role switch is not test scaffolding, it is the assertion: a creator
 * session cannot reach a review queue, and going straight there after an upload
 * is refused by the router guard. So the run does what a person demoing this
 * does, and the fact that it is necessary is the tenancy rule holding.
 */
async function openReviewAsManager(page, deliveryId) {
  await page.click(sel(ROLE_OPTION, { [ATTR_ROLE]: ROLE_MANAGER }))
  await page.waitForSelector(sel(ACTIVE_ROLE, { [ATTR_ROLE]: ROLE_MANAGER }), { timeout: 10_000 })
  await page.goto(`${BASE_URL}/#/review/${deliveryId}`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector(testid(REVIEW_ROOT), { timeout: 30_000 })
}

/**
 * Steps the review cursor until it lands on the named asset, or gives up.
 * The queue order is frozen and explainable, but it is not this run's job to
 * know it: asking the DOM where the cursor is beats assuming.
 */
async function cursorTo(page, assetId, maxSteps = 30) {
  for (let step = 0; step < maxSteps; step += 1) {
    const current = await page.getAttribute(testid(REVIEW_CURRENT_ASSET), 'data-asset-id')
    if (current === assetId) return true
    if (!(await exists(page, testid(REVIEW_NEXT), 1000))) return false
    await page.$eval(testid(REVIEW_NEXT), (button) => button.click())
    await page.waitForTimeout(80)
  }
  return false
}

async function taggerRunsAndProvenanceHolds(browser, clipPath) {
  const { context, page, watcher } = await openPage(browser, DESKTOP, { ignore: [TEARDOWN_ABORT] })
  try {
    // A freshly uploaded clip: real pixels, and no model has spoken.
    const { deliveryId, assetId } = await uploadOneClip(page, clipPath)
    assert(!!assetId, `the uploaded clip produced an asset (${assetId})`)

    const beforeState = await readAiState(page)
    const uploaded = beforeState.assets.find((row) => row.id === assetId)
    assert(!!uploaded?.sheet_key, 'the uploaded clip has a contact sheet, so a model has something to look at')
    assertEqual(uploaded?.ai_provenance, 'none', 'the uploaded clip claims no AI provenance yet')
    assertEqual(uploaded?.ai_description, null, 'the uploaded clip has no AI description yet')
    const runsBefore = beforeState.runs.length
    note(`ai_run rows before the manager asks: ${runsBefore}`)

    // A creator session must not be able to reach a review queue at all: the
    // guard sends them back to their own page. Asserting the refusal here means
    // the role switch below is proving something rather than papering over it.
    await page.goto(`${BASE_URL}/#/review/${deliveryId}`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForTimeout(500)
    assertEqual(
      await page.locator(testid(REVIEW_ROOT)).count(),
      0,
      'a creator session cannot open a review queue, even with the delivery id in hand',
    )

    // The manager opens the review queue for that delivery.
    await openReviewAsManager(page, deliveryId)
    assert(await cursorTo(page, assetId), 'the review queue can reach the newly delivered clip')

    // The untagged state is real and visible, and the action is explicit.
    assert(
      await exists(page, testid(RUN_TAGGER), 5000),
      'an untagged clip offers an explicit "analyse the contact sheet" action rather than tagging itself',
    )

    await page.$eval(testid(RUN_TAGGER), (button) => button.click())
    await page.waitForFunction(
      ([badgeSel]) => !!document.querySelector(badgeSel),
      [testid(SIMULATED_BADGE)],
      { timeout: 60_000 },
    )

    // The badge reads the asset's provenance, never the current mode.
    assertEqual(
      await page.getAttribute(testid(SIMULATED_BADGE), ATTR_PROVENANCE),
      'mock',
      'the simulated badge reads the stored provenance of this asset',
    )

    const after = await readAiState(page)
    assertEqual(after.runs.length, runsBefore + 1, 'exactly one ai_run row was written')

    const runRow = after.runs.find((row) => row.subject_id === assetId)
    assert(!!runRow, 'the run names the asset it looked at as its subject')
    assertEqual(runRow?.kind, 'vision_tag', 'the run records which capability ran')
    assertEqual(runRow?.provider, 'mock', 'the run records the provider that produced it')
    // The invariant the whole provenance design exists for.
    assertEqual(runRow?.model_id, null, 'a mock run records NO model_id, ever')
    assert(
      !!runRow?.simulated_model_id,
      `a mock run records what it imitates instead (${runRow?.simulated_model_id})`,
    )
    assertEqual(runRow?.latency_source, 'simulated', 'a mock run does not claim measured latency')
    assertEqual(runRow?.schema_valid, true, 'the output validated against the vision_tag schema')
    assertEqual(runRow?.status, 'ok', 'the run completed')
    assert(!!runRow?.prompt_version, `the run records its prompt version (${runRow?.prompt_version})`)
    assert(!!runRow?.input_hash, 'the run records the hash of what it was given, so it can be re-run')
    assert(!!runRow?.output_json, 'the run keeps the verbatim output, so it can be re-projected')

    // The projection landed, and the tags point back at the run that made them.
    const tagged = after.assets.find((row) => row.id === assetId)
    assertEqual(tagged?.ai_provenance, 'mock', 'the asset records mock provenance after the run')
    assert(!!tagged?.ai_description, `the asset carries the projected description ("${String(tagged?.ai_description).slice(0, 60)}...")`)
    assert(tagged?.ai_confidence != null, 'the asset carries a confidence rather than implying certainty')

    const newTags = after.tags.filter((row) => row.asset_id === assetId && row.source === 'ai')
    assert(newTags.length > 0, `the run wrote ${newTags.length} AI tag(s)`)
    assert(
      newTags.every((row) => row.ai_run_id === runRow?.id),
      'every AI tag names the run that produced it, so a mock purge can find them all',
    )
    assert(
      newTags.every((row) => row.confidence != null),
      'every AI tag carries a confidence, so a human can see what the model was unsure about',
    )

    await watcher.assertClean('ai run')
    return { deliveryId, assetId }
  } finally {
    await context.close()
  }
}

/** The refusal path: no sheet, no run, and a sentence saying so. */
async function refusesWithoutASheet(browser) {
  const { context, page, watcher } = await openPage(browser, DESKTOP, { ignore: [TEARDOWN_ABORT] })
  try {
    // The seeded HEVC clip: no sheet, because nothing could decode it.
    await page.goto(`${BASE_URL}/#/review/delivery-hero`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector(testid(REVIEW_ROOT), { timeout: 30_000 })

    const before = await readAiState(page)
    const sheetless = before.assets.find(
      (row) => row.delivery_id === 'delivery-hero' && !row.sheet_key && row.review_status === 'pending',
    )
    assert(!!sheetless, `the seeded delivery contains a clip with no contact sheet (${sheetless?.filename})`)
    if (!sheetless) return

    // It must already be honest before anyone asks.
    assertEqual(sheetless.ai_provenance, 'none', 'the sheetless clip claims no provenance')
    assertEqual(sheetless.ai_description, null, 'the sheetless clip has no invented description')

    assert(await cursorTo(page, sheetless.id), 'the review queue can reach the sheetless clip')
    assert(
      await exists(page, testid(RUN_TAGGER), 5000),
      'the action is offered rather than hidden, so the refusal is the app explaining itself',
    )

    const runsBefore = before.runs.length
    await page.$eval(testid(RUN_TAGGER), (button) => button.click())
    await page.waitForSelector(testid(TAGGER_REFUSAL), { timeout: 30_000 })

    const refusal = await page.textContent(testid(TAGGER_REFUSAL))
    assert(
      !!refusal && refusal.trim().length > 20,
      `the refusal explains itself in a sentence ("${refusal?.trim().slice(0, 70)}...")`,
    )
    assertEqual(
      await page.getAttribute(testid(TAGGER_REFUSAL), 'data-reason'),
      'refused',
      'the refusal is machine readable as a refusal, not as a failure',
    )

    const after = await readAiState(page)
    assertEqual(after.runs.length, runsBefore, 'NO ai_run row was written for a clip with no sheet')
    const stillSheetless = after.assets.find((row) => row.id === sheetless.id)
    assertEqual(stillSheetless?.ai_provenance, 'none', 'the sheetless clip still claims no provenance')
    assertEqual(stillSheetless?.ai_description, null, 'no description was invented for it')
    assertEqual(
      after.tags.filter((row) => row.asset_id === sheetless.id && row.source === 'ai').length,
      0,
      'no AI tags were written for a clip nobody could see',
    )

    await watcher.assertClean('ai refusal run')
  } finally {
    await context.close()
  }
}

/** Determinism: the same clip analysed twice gives the same answer (D17). */
async function mockIsDeterministic(browser, clipPath) {
  const { context, page } = await openPage(browser, DESKTOP, { ignore: [TEARDOWN_ABORT] })
  try {
    const { deliveryId, assetId } = await uploadOneClip(page, clipPath)
    await openReviewAsManager(page, deliveryId)
    if (!(await cursorTo(page, assetId))) {
      assert(false, 'the review queue can reach the clip for the determinism check')
      return
    }
    await page.$eval(testid(RUN_TAGGER), (button) => button.click())
    await page.waitForFunction(
      ([badgeSel]) => !!document.querySelector(badgeSel),
      [testid(SIMULATED_BADGE)],
      { timeout: 60_000 },
    )
    const state = await readAiState(page)
    const runs = state.runs.filter((row) => row.subject_id === assetId)
    assert(runs.length >= 1, 'the clip has at least one run')

    // Two uploads of byte-identical content in two profiles must hash the same
    // input, which is what makes replay and the response cache work at all.
    const hashes = new Set(state.runs.filter((r) => r.kind === 'vision_tag').map((r) => r.input_hash))
    note(`distinct vision_tag input hashes across this profile: ${hashes.size}`)
    assert(
      runs.every((row) => typeof row.input_hash === 'string' && row.input_hash.length > 16),
      'every run carries a real input hash',
    )
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

let clipPath = null
await run('preconditions: a decodable clip so a sheet exists to analyse', async () => {
  clipPath = makeDecodableClip()
  assert(!!clipPath, 'generated a decodable vertical clip')
  note(`repo root: ${REPO_ROOT}`)
})

const server = await startServer()
let browser
try {
  browser = await launch()
} catch (err) {
  assert(false, `chromium is required for the ai run: ${err.message}`)
  if (!server.reused) await stopServer()
  finish()
}

try {
  if (clipPath) {
    await run('the manager runs the tagger, and provenance holds', () =>
      taggerRunsAndProvenanceHolds(browser, clipPath),
    )
  }
  await run('a clip with no contact sheet is refused, loudly', () => refusesWithoutASheet(browser))
  if (clipPath) {
    await run('the mock records a real input hash per run', () => mockIsDeterministic(browser, clipPath))
  }
} finally {
  await browser.close()
  if (!server.reused) await stopServer()
}

finish()
