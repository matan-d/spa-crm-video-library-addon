/**
 * CREATOR RUN, pending.
 *
 * Source cases: `qa/PLAN.md` "Creator run", plus `qa/cases/media.md` QC-MEDIA-049
 * (Most Compatible instruction), QC-MEDIA-065 (prompt only for the unknown the
 * creator can answer), and the per fixture pre-flight expectations in groups 1 to 10.
 * `qa/cases/platform.md`, `tenancy.md`, `ai.md` and `loop.md` do not exist yet, so
 * anything they add later lands here as new run blocks rather than as a rewrite.
 *
 * Given a token link to a locked brief and the committed fixture set
 * When the creator accepts consent and loads clips through the real ingestFile()
 * Then each clip shows its own four valued pre-flight verdict matching
 *      `manifest.json.expected_preflight` within `tolerance`, the checklist tracks
 *      the locked brief, submit records the delivery, and reopening the same link
 *      resumes rather than restarting.
 * Layer: e2e, two viewports.
 * Blocked-by: the creator invite page and the upload page.
 *
 * Two things this run refuses to do, both on purpose:
 *   1. It asserts `expected_preflight`, never `declared`. Asserting `declared`
 *      tests ffmpeg, which is not interesting. Asserting `expected_preflight`
 *      tests our parser, which is the only interesting assertion.
 *   2. It compares numbers through the `tolerance` block on the same manifest
 *      entry. Frame timing, durations and distances are not bit exact, and a test
 *      that fails for reasons unrelated to correctness teaches everyone to ignore it.
 *
 * The fixture bytes are verified by sha256 BEFORE any of this runs, because a
 * regenerated fixture that differs must fail loudly rather than quietly change
 * what every assertion here means. That block runs today, pending or not.
 *
 * Un-skipping: set PENDING to false. Nothing else in this file changes.
 */
import { readFileSync, statSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  BASE_URL, DESKTOP, MOBILE, REPO_ROOT, assert, assertEqual, assertWithin, exists,
  finish, launch, note, openPage, pendingAssert, reportPending, run, startServer,
  stopServer,
} from './_support/harness.mjs'
import {
  ATTR_CONSENT_ID, ATTR_CONSENT_VERSION,
  ATTR_COUNT, ATTR_DELIVERY_ID, ATTR_FILE_NAME, ATTR_RULE, ATTR_STATUS,
  ATTR_VERDICT, CAPTURE_DATE_PROMPT, CHECKLIST_ITEM, CHECKLIST_ROOT,
  CONSENT_ACCEPT, CONSENT_PANEL, CONSENT_RECORDED, INVITE_BRIEF_ITEM,
  INVITE_CONTINUE, INVITE_MOST_COMPATIBLE_INSTRUCTION, INVITE_ROOT,
  NEAR_BRANCH_PROMPT_MUST_NOT_EXIST, PREFLIGHT_RULE, PREFLIGHT_RULES,
  UPLOAD_FILE_INPUT, UPLOAD_FILE_ROW, UPLOAD_FILE_VERDICT, UPLOAD_FILTERED_NOTICE,
  UPLOAD_RESUME_BANNER, UPLOAD_ROOT, UPLOAD_SUBMIT, UPLOAD_SUBMIT_CONFIRMATION,
  sel, testid,
} from './_support/testids.mjs'

/**
 * The invite page and the upload page have landed, and the browser decode
 * adapters they need landed with them (docs/06-decisions.md D25), so this run
 * is live. It is now also the only automated proof that a contact sheet can be
 * produced by our own code, which is why the sheet assertions below are not
 * optional extras.
 */
const PENDING = false

/**
 * The seed must publish one stable creator token for this run, and the loop run
 * reads a real one off BRIEF_INVITE_LINK instead. Recorded as a data contract in
 * `qa/status.md` rather than guessed at here.
 */
const CREATOR_TOKEN = process.env.E2E_CREATOR_TOKEN || 'demo-creator-token'
const INVITE_URL = `/#/c/${CREATOR_TOKEN}`

/**
 * An aborted blob fetch on media teardown is expected here for the same reason
 * as in `e2e/decode.e2e.mjs`: the extractor stops reading once it has its
 * frames, so revoking the object URL mid-buffer is the normal end of every
 * extraction. Scoped to this run rather than to the harness default.
 */
const TEARDOWN_ABORT = /blob:.*ERR_ABORTED/

/**
 * What THIS runtime can decode, asked once and used to split the assertions.
 *
 * `expected_preflight` in the manifest describes a reference runtime where H.264
 * decodes and only HEVC does not. A runtime that differs does not make the
 * parser wrong, so the container derived rules are still asserted against the
 * manifest and only `codec_playable` follows the machine. See D26.
 */
let RUNTIME_CODECS = null

async function readRuntimeCodecs(page) {
  return page.evaluate(() => {
    const v = document.createElement('video')
    const answer = (mime) => v.canPlayType(mime)
    return {
      h264: answer('video/mp4; codecs="avc1.42E01E"'),
      hevc: answer('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      vp9: answer('video/mp4; codecs="vp09.00.10.08"'),
    }
  })
}

/** The codec family a fixture's declared codec belongs to. */
function familyOf(codec) {
  if (!codec) return null
  if (codec.startsWith('avc')) return 'h264'
  if (codec.startsWith('hvc') || codec.startsWith('hev')) return 'hevc'
  if (codec.startsWith('vp09') || codec.startsWith('vp9')) return 'vp9'
  if (codec.startsWith('apc')) return 'prores'
  return null
}

/** Whether this runtime decodes that family, as a pass or fail expectation. */
function runtimeDecodes(codec) {
  const family = familyOf(codec)
  if (!family) return 'unknown'
  if (family === 'prores') return 'no'
  const answer = RUNTIME_CODECS?.[family]
  if (answer === undefined) return 'unknown'
  return answer === 'probably' || answer === 'maybe' ? 'yes' : 'no'
}

const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'public', 'fixtures', 'manifest.json'), 'utf8'))
const byId = new Map(MANIFEST.fixtures.map((f) => [f.fixture_id, f]))

/** The clips this run delivers, chosen so every rule state appears at least once. */
const DELIVERED = ['vertical_ok', 'rotated_90', 'horizontal_fail', 'no_metadata', 'hevc']

function fixturePath(id) {
  const entry = byId.get(id)
  return join(REPO_ROOT, 'public', entry.path.replace(/^\//, '').split('/').join('/'))
}

// ---------------------------------------------------------------------------
// Preconditions, runnable today: the bytes are what the manifest says they are.
// ---------------------------------------------------------------------------

function verifyFixtureBytes(ids) {
  for (const id of ids) {
    const entry = byId.get(id)
    assert(!!entry, `manifest carries an entry for ${id}`)
    if (!entry) continue
    const path = fixturePath(id)
    const bytes = readFileSync(path)
    assertEqual(statSync(path).size, entry.bytes, `${id}: committed size matches the manifest`)
    assertEqual(
      createHash('sha256').update(bytes).digest('hex'),
      entry.sha256,
      `${id}: committed sha256 matches the manifest, so this run means what the manifest says`,
    )
    assert(
      !!entry.tolerance && typeof entry.tolerance.duration_s === 'number',
      `${id}: carries a tolerance block, so no numeric assertion here is exact`,
    )
  }
}

// ---------------------------------------------------------------------------
// The run body
// ---------------------------------------------------------------------------

/** Junk a real creator's folder drop contains. Filtered, never failed. */
function makeJunkFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'astolia-e2e-junk-'))
  const files = ['.DS_Store', 'IMG_0001.xmp', 'proxy_IMG_0001.LRV', 'IMG_0002.DNG', 'notes.txt']
  for (const name of files) writeFileSync(join(dir, name), 'not a clip')
  return { dir, files: files.map((f) => join(dir, f)) }
}


/**
 * Waits for a file row to reach a settled state.
 *
 * A row appears as soon as a file is picked and only gets a verdict once the
 * bytes have been parsed and, where possible, decoded. Reading before that is
 * the one flake this run has produced twice, and it passes on a fast desktop
 * profile while failing on the throttled mobile one, which is the worst possible
 * combination to leave in place.
 */
async function waitForSettledRow(page, rowSelector, timeout = 120_000) {
  await page.waitForFunction(
    ([selector]) => {
      const state = document.querySelector(selector)?.getAttribute('data-upload-state')
      return state === 'stored' || state === 'blocked' || state === 'failed'
    },
    [rowSelector],
    { timeout },
  )
}

async function readRuleStatuses(page, fileName) {
  return page.evaluate(
    ([rowSel, ruleSel, ruleAttr, statusAttr]) => {
      const row = document.querySelector(rowSel)
      if (!row) return null
      const out = {}
      for (const el of row.querySelectorAll(ruleSel)) {
        out[el.getAttribute(ruleAttr)] = {
          status: el.getAttribute(statusAttr),
          blocking: el.getAttribute('data-blocking') === 'true',
          reason: el.getAttribute('data-reason'),
          value: el.getAttribute('data-value'),
          durationS: el.getAttribute('data-duration-s'),
          distanceM: el.getAttribute('data-distance-m'),
        }
      }
      return out
    },
    [sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: fileName }), testid(PREFLIGHT_RULE), ATTR_RULE, ATTR_STATUS],
  )
}

async function consentAndIngest(browser, deviceProfile) {
  const { context, page, watcher } = await openPage(
    browser,
    { ...deviceProfile, acceptDownloads: true },
    { ignore: [TEARDOWN_ABORT] },
  )
  try {
    // When: the creator opens the token link.
    await page.goto(`${BASE_URL}${INVITE_URL}`, { waitUntil: 'load', timeout: 45_000 })
    assert(await exists(page, testid(INVITE_ROOT)), `${deviceProfile.name}: the invite page loaded from a token link with no account`)
    assert(
      (await page.locator(testid(INVITE_BRIEF_ITEM)).count()) > 0,
      `${deviceProfile.name}: the locked brief items are listed on the invite`,
    )

    // QC-MEDIA-049: the only preventive control we have for the HEVC hole.
    assert(
      await exists(page, testid(INVITE_MOST_COMPATIBLE_INSTRUCTION)),
      `${deviceProfile.name}: the Most Compatible camera instruction is present on the invite`,
    )

    // Then: consent is an immutable versioned record, written on accept.
    assert(await exists(page, testid(CONSENT_PANEL)), `${deviceProfile.name}: consent is requested before anything is uploaded`)
    const consentVersion = await page.locator(testid(CONSENT_PANEL)).getAttribute(ATTR_CONSENT_VERSION)
    assert(!!consentVersion, `${deviceProfile.name}: the consent panel states its version (${consentVersion})`)
    await page.click(testid(CONSENT_ACCEPT))
    assert(await exists(page, testid(CONSENT_RECORDED)), `${deviceProfile.name}: accepting consent produced a record`)
    const consentId = await page.locator(testid(CONSENT_RECORDED)).getAttribute(ATTR_CONSENT_ID)
    assert(!!consentId, `${deviceProfile.name}: the consent record carries an id (${consentId})`)
    assertEqual(
      await page.locator(testid(CONSENT_RECORDED)).getAttribute(ATTR_CONSENT_VERSION),
      consentVersion,
      `${deviceProfile.name}: the recorded consent version matches the version shown`,
    )

    await page.click(testid(INVITE_CONTINUE))
    assert(await exists(page, testid(UPLOAD_ROOT)), `${deviceProfile.name}: the upload page opened`)
    const deliveryId = await page.locator(testid(UPLOAD_ROOT)).getAttribute(ATTR_DELIVERY_ID)
    assert(!!deliveryId, `${deviceProfile.name}: a delivery exists so the session can resume (${deliveryId})`)

    // Ask this runtime what it can decode, once, before anything depends on it.
    if (!RUNTIME_CODECS) {
      RUNTIME_CODECS = await readRuntimeCodecs(page)
      note(`runtime codecs: h264="${RUNTIME_CODECS.h264}" hevc="${RUNTIME_CODECS.hevc}" vp9="${RUNTIME_CODECS.vp9}"`)
    }

    // When: real files go in through the real entry point, not a mocked one.
    await page.setInputFiles(testid(UPLOAD_FILE_INPUT), DELIVERED.map(fixturePath))

    for (const id of DELIVERED) {
      const entry = byId.get(id)
      const fileName = entry.path.split('/').pop()
      const rowSelector = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: fileName })
      assert(await exists(page, rowSelector, 30_000), `${deviceProfile.name}: ${id}: a row appeared for ${fileName}`)

      await waitForSettledRow(page, rowSelector)

      const expected = entry.expected_preflight
      const statuses = await readRuleStatuses(page, fileName)
      assert(!!statuses, `${deviceProfile.name}: ${id}: the row rendered a pre-flight panel`)
      if (!statuses) continue

      // Then: every rule matches expected_preflight, four valued, never coerced.
      for (const rule of PREFLIGHT_RULES) {
        const want = expected.rules[rule]
        const got = statuses[rule]
        if (!want) continue
        if (want.status === 'skipped') {
          // "Does not apply" is not rendered at all (QC-MEDIA-110).
          assert(!got, `${deviceProfile.name}: ${id}: ${rule} is skipped and therefore not rendered`)
          continue
        }
        assert(!!got, `${deviceProfile.name}: ${id}: ${rule} is rendered`)
        if (!got) continue

        if (rule === 'duplicate') {
          // The duplicate rule compares per frame perceptual hashes, so it needs
          // pixels, so it needs a decoder. On a runtime that cannot decode the
          // file there is nothing to compare and `unknown` is the honest answer,
          // which is the four valued rule working rather than failing.
          const decodes = runtimeDecodes(entry.declared.codec_video)
          const expected = decodes === 'yes' ? want.status : 'unknown'
          assertEqual(
            got.status,
            expected,
            `${deviceProfile.name}: ${id}: duplicate is ${expected} on this runtime (decodes: ${decodes})`,
          )
          continue
        }

        if (rule === 'codec_playable') {
          // A statement about this machine, not about the file. See D26.
          const decodes = runtimeDecodes(entry.declared.codec_video)
          const expected = decodes === 'yes' ? 'pass' : decodes === 'no' ? 'fail' : 'unknown'
          assertEqual(
            got.status,
            expected,
            `${deviceProfile.name}: ${id}: codec_playable follows this runtime (${entry.declared.codec_video} decodes: ${decodes})`,
          )
          assert(
            got.blocking === false,
            `${deviceProfile.name}: ${id}: codec_playable never blocks, whatever the runtime answers`,
          )
          continue
        }

        assertEqual(got.status, want.status, `${deviceProfile.name}: ${id}: ${rule} status`)
        assertEqual(got.blocking, want.blocking === true, `${deviceProfile.name}: ${id}: ${rule} blocking flag`)
        if (want.status === 'unknown' || want.status === 'fail') {
          if (want.reason) assertEqual(got.reason, want.reason, `${deviceProfile.name}: ${id}: ${rule} reason code`)
        }
        if (rule === 'min_duration' && typeof want.value === 'number' && got.durationS !== null) {
          assertWithin(Number(got.durationS), want.value, entry.tolerance.duration_s, `${deviceProfile.name}: ${id}: measured duration`)
        }
        if (rule === 'near_branch' && typeof want.distance_m === 'number' && got.distanceM !== null) {
          assertWithin(Number(got.distanceM), want.distance_m, entry.tolerance.distance_m, `${deviceProfile.name}: ${id}: measured distance to the branch`)
        }
      }

      // The row level verdict is a rollup of the rules, not a separate opinion.
      // The row verdict is a rollup of the rules, never a separate opinion. A
      // blocking fail blocks; a non blocking fail (including a codec this
      // runtime cannot decode) is advisory and must never read as blocked,
      // because refusing a creator's footage for our own missing decoder would
      // be the product lying about whose problem it is.
      const rowVerdict = await page.locator(`${rowSelector} ${testid(UPLOAD_FILE_VERDICT)}`).getAttribute(ATTR_VERDICT)
      if (expected.rollup.blocking_fail > 0) {
        assertEqual(rowVerdict, 'blocked', `${deviceProfile.name}: ${id}: a blocking fail reads as blocked`)
      } else {
        assert(
          rowVerdict === 'ok' || rowVerdict === 'advisory',
          `${deviceProfile.name}: ${id}: row verdict is ${rowVerdict}, and nothing non blocking reads as blocked`,
        )
      }
    }

    // QC-MEDIA-065: prompt only for the unknown the creator can answer.
    const noMetadataRow = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'no_metadata.mp4' })
    assert(
      await exists(page, `${noMetadataRow} ${testid(CAPTURE_DATE_PROMPT)}`, 5000),
      `${deviceProfile.name}: capture_date unknown produced a "when did you shoot this" prompt`,
    )
    assertEqual(
      await page.locator(testid(NEAR_BRANCH_PROMPT_MUST_NOT_EXIST)).count(),
      0,
      `${deviceProfile.name}: near_branch unknown produced nothing at all, because there is no action the creator can take`,
    )

    // Then: the checklist is live against the locked brief.
    assert(await exists(page, testid(CHECKLIST_ROOT)), `${deviceProfile.name}: the checklist against the locked brief is shown`)
    const briefItemCount = await page.locator(testid(INVITE_BRIEF_ITEM)).count().catch(() => 0)
    const checklistCount = await page.locator(testid(CHECKLIST_ITEM)).count()
    assert(checklistCount > 0, `${deviceProfile.name}: the checklist has ${checklistCount} item(s)`)
    if (briefItemCount > 0) {
      assertEqual(checklistCount, briefItemCount, `${deviceProfile.name}: one checklist item per locked brief item`)
    }
    // Attribution is the creator's claim, and it is deliberately explicit: no
    // model has run on these clips (and must not, the fixtures are colour bars),
    // so nothing else could honestly fill the checklist in. The control being
    // present and moving the checklist IS the assertion.
    const firstStored = page.locator(`${sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'vertical_ok.mp4' })} select`)
    assertEqual(await firstStored.count(), 1, `${deviceProfile.name}: a stored clip offers "which shot is this"`)
    const briefItemValue = await page.evaluate(
      ([rowSel]) => {
        const select = document.querySelector(`${rowSel} select`)
        const option = select ? Array.from(select.options).find((o) => o.value !== 'none') : null
        return option ? option.value : null
      },
      [sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'vertical_ok.mp4' })],
    )
    assert(!!briefItemValue, `${deviceProfile.name}: the picker lists the locked brief items`)
    await firstStored.selectOption(briefItemValue)
    await page.waitForTimeout(200)

    const metCount = await page.locator(sel(CHECKLIST_ITEM, { [ATTR_STATUS]: 'met' })).count()
    assert(metCount > 0, `${deviceProfile.name}: at least one checklist item moved to met after ingest (${metCount})`)

    // When: submit.
    await page.click(testid(UPLOAD_SUBMIT))
    assert(await exists(page, testid(UPLOAD_SUBMIT_CONFIRMATION), 30_000), `${deviceProfile.name}: submitting produced a confirmation`)
    const confirmedCount = Number(await page.locator(testid(UPLOAD_SUBMIT_CONFIRMATION)).getAttribute(ATTR_COUNT))
    assert(confirmedCount > 0, `${deviceProfile.name}: the confirmation states how many clips were received (${confirmedCount})`)

    // Then: coming back on the same link resumes. Same context, because a resume
    // that only works in a fresh profile is not a resume.
    const resumed = await context.newPage()
    await resumed.goto(`${BASE_URL}${INVITE_URL}`, { waitUntil: 'load', timeout: 45_000 })
    // The same link, and it must land on the upload page rather than asking for
    // consent a second time: the consent record is immutable and singular.
    assert(
      await exists(resumed, testid(UPLOAD_ROOT), 20_000),
      `${deviceProfile.name}: reopening the link goes straight to the upload page, consent is not re-asked`,
    )
    assert(await exists(resumed, testid(UPLOAD_RESUME_BANNER), 20_000), `${deviceProfile.name}: reopening the same link resumed the delivery`)
    assertEqual(
      await resumed.locator(testid(UPLOAD_RESUME_BANNER)).getAttribute(ATTR_DELIVERY_ID),
      deliveryId,
      `${deviceProfile.name}: the resumed delivery is the same delivery, not a new one`,
    )
    assertEqual(
      Number(await resumed.locator(testid(UPLOAD_RESUME_BANNER)).getAttribute(ATTR_COUNT)),
      confirmedCount,
      `${deviceProfile.name}: the resume banner counts what was already delivered`,
    )
    await resumed.close()

    await watcher.assertClean(`${deviceProfile.name} creator run`)
  } finally {
    await context.close()
  }
}

/** Desktop only: a folder drop full of junk is filtered, not failed. */
async function junkFolderIsFiltered(browser) {
  const { context, page } = await openPage(browser, DESKTOP, { ignore: [TEARDOWN_ABORT] })
  const junk = makeJunkFolder()
  try {
    await page.goto(`${BASE_URL}${INVITE_URL}`, { waitUntil: 'load', timeout: 45_000 })
    if (await exists(page, testid(CONSENT_ACCEPT), 3000)) await page.click(testid(CONSENT_ACCEPT))
    if (await exists(page, testid(INVITE_CONTINUE), 3000)) await page.click(testid(INVITE_CONTINUE))
    await page.setInputFiles(testid(UPLOAD_FILE_INPUT), [fixturePath('vertical_ok'), ...junk.files])

    assert(
      await exists(page, testid(UPLOAD_FILTERED_NOTICE), 20_000),
      'desktop: a notice says which files were filtered out rather than failing them',
    )
    assertEqual(
      Number(await page.locator(testid(UPLOAD_FILTERED_NOTICE)).getAttribute(ATTR_COUNT)),
      junk.files.length,
      'desktop: every non clip was filtered, and the count says so',
    )
    for (const path of junk.files) {
      const name = path.split(/[\\/]/).pop()
      assertEqual(
        await page.locator(sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: name })).count(),
        0,
        `desktop: ${name} produced no file row`,
      )
    }
    const realRow = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'vertical_ok.mp4' })
    assertEqual(
      await page.locator(realRow).count(),
      1,
      'desktop: the one real clip in the folder still ingested',
    )
    // Let it settle before the context closes, so the run never tears down mid
    // decode and reports the abort as a failure of the next spec.
    await waitForSettledRow(page, realRow)
  } finally {
    await context.close()
  }
}

/** A blocked clip explains itself and does not silently disappear. */
async function blockedClipExplainsItself(browser) {
  const { context, page } = await openPage(browser, MOBILE, { ignore: [TEARDOWN_ABORT] })
  try {
    await page.goto(`${BASE_URL}${INVITE_URL}`, { waitUntil: 'load', timeout: 45_000 })
    if (await exists(page, testid(CONSENT_ACCEPT), 3000)) await page.click(testid(CONSENT_ACCEPT))
    if (await exists(page, testid(INVITE_CONTINUE), 3000)) await page.click(testid(INVITE_CONTINUE))
    await page.setInputFiles(testid(UPLOAD_FILE_INPUT), [fixturePath('horizontal_fail')])
    const row = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'horizontal_fail.mp4' })
    assert(await exists(page, row, 30_000), 'mobile: the blocked clip is still listed rather than dropped')
    await waitForSettledRow(page, row)
    assertEqual(
      await page.locator(`${row} ${testid(UPLOAD_FILE_VERDICT)}`).getAttribute(ATTR_VERDICT),
      'blocked',
      'mobile: the clip reads as blocked',
    )
    const orientation = sel(PREFLIGHT_RULE, { [ATTR_RULE]: 'orientation', [ATTR_STATUS]: 'fail' })
    assert(await exists(page, `${row} ${orientation}`), 'mobile: the blocking rule is named on the row')
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

await run('preconditions: the fixture bytes are what the manifest says (runs pending or not)', async () => {
  verifyFixtureBytes(DELIVERED)
  note(`fixture set verified by sha256 before use: ${DELIVERED.join(', ')}`)
})

const server = await startServer()
let browser = null
try {
  browser = await launch()
} catch (err) {
  pendingAssert(`creator run skipped entirely: ${err.message}`)
  if (!server.reused) await stopServer()
  finish()
}

try {
  if (PENDING && process.env.E2E_RUN_PENDING !== '1') {
    await reportPending({
      specName: 'creator run',
      reason: 'the creator invite page and upload page are not built yet (UI not built yet)',
      url: INVITE_URL,
      browser,
      anchors: [testid(INVITE_ROOT), testid(CONSENT_ACCEPT), testid(UPLOAD_ROOT), testid(UPLOAD_FILE_INPUT)],
      plan: [
        'the invite page loads from a token link with no account and lists the locked brief items',
        'the Most Compatible camera instruction is present on the invite (QC-MEDIA-049)',
        'consent is requested before any upload, states its version, and accepting writes a versioned record',
        `${DELIVERED.length} fixtures ingest through the real ingestFile() entry point and each gets its own row`,
        'every pre-flight rule per clip matches manifest expected_preflight, four valued, within tolerance',
        'a skipped rule is not rendered at all, and an unknown is rendered as unknown rather than as pass or fail',
        'capture_date unknown prompts the creator, near_branch unknown prompts nothing (QC-MEDIA-065)',
        'the checklist has one item per locked brief item and moves to met on delivery',
        'submit produces a confirmation stating how many clips were received',
        'reopening the same token link resumes the same delivery with the delivered count',
        'a desktop folder drop of junk (sidecars, proxies, RAW, system files) is filtered and counted, not failed',
        'a blocked clip stays listed, reads as blocked, and names the blocking rule',
        'no console error, page error or failed request across the whole run, at both viewports',
      ],
    })
  } else {
    await run(`creator run, ${DESKTOP.name}`, () => consentAndIngest(browser, DESKTOP))
    await run(`creator run, ${MOBILE.name}`, () => consentAndIngest(browser, MOBILE))
    await run('creator run, desktop folder drop with junk', () => junkFolderIsFiltered(browser))
    await run('creator run, a blocked clip explains itself', () => blockedClipExplainsItself(browser))
  }
} finally {
  await browser.close()
  if (!server.reused) await stopServer()
}

finish()
