/**
 * SYNC RUN.
 *
 * Source cases: `qa/cases/sync.md` group 6, QC-SYNC-050, 051 and 052. All three
 * were written `Blocked-by: the route`, because the adapter and the panel were
 * built and unit tested before `/sync` existed. The route exists now, so they
 * are assertions rather than a checklist entry.
 *
 * Given the manager role and the loopback adapter
 * When the manager makes a local edit, drains the outbox, and pulls back
 * Then the panel names the adapter and claims nothing beyond it, the queue shows
 *      the verbatim patch that will be sent, the cursor advances by the SERVER's
 *      clock, and a refused merge is a row on the surface rather than a toast.
 *
 * The honesty assertion is the one that matters most here and is the easiest to
 * lose in a redesign: nothing on this page may say connected, live, or Supabase.
 * The transport is not built, and a panel that implies otherwise is the single
 * most misleading screen this product could ship.
 *
 * The storage panel rides along at the end, because it is the same claim about
 * the same machine: what is held locally, whether the browser reclaimed it, and
 * the snapshot that makes an eviction survivable.
 */
import { readFile } from 'node:fs/promises'
import {
  BASE_URL, DESKTOP, assert, assertEqual, exists,
  finish, launch, note, openPage, run, startServer, stopServer,
} from './_support/harness.mjs'
import {
  ACTIVE_ROLE, ATTR_ROLE, ROLE_MANAGER, ROLE_OPTION,
  RESULT_GRID,
  sel, testid,
} from './_support/testids.mjs'

const SYNC_PANEL = 'sync-panel'
const SYNC_ADAPTER = 'sync-adapter'
const SYNC_STATUS = 'sync-status'
const SYNC_PUSH = 'sync-push'
const SYNC_PULL = 'sync-pull'
const SYNC_LAST_RUN = 'sync-last-run'
const SYNC_SERVER_ROWS = 'sync-server-rows'
const OUTBOX_PENDING = 'outbox-pending-count'
const OUTBOX_SENT = 'outbox-sent-count'
const OUTBOX_FAILED = 'outbox-failed-count'
const OUTBOX_ENTRY_ROW = 'outbox-entry-row'
const OUTBOX_STORE_ROW = 'outbox-store-row'
const CURSOR_ROW = 'sync-cursor-row'
const CONFLICT_EMPTY = 'sync-conflict-empty'
const STORAGE_PANEL = 'storage-panel'
const STORAGE_VERDICT = 'storage-verdict'
const STORAGE_EXPORT = 'storage-export'
const STORAGE_EXPORT_RECEIPT = 'storage-export-receipt'
const STORAGE_IMPORT_RECEIPT = 'storage-import-receipt'

/** Strings that would be a lie on this page. Matched case-insensitively. */
const FORBIDDEN_CLAIMS = ['supabase', 'connected', 'live sync', 'syncing to the server']

/**
 * Waits for the panel to have actually read the outbox.
 *
 * The counts default to nothing until the snapshot resolves, and reading them
 * early would report an empty queue on no evidence. The panel says which state
 * it is in via `data-loaded`, so this waits on the panel's own claim rather than
 * on a timer.
 */
async function openSyncPanel(page) {
  await page.click(testid('nav-sync'))
  await page.waitForSelector(testid(SYNC_PANEL), { timeout: 15_000 })
  await page.waitForSelector(`${testid(SYNC_STATUS)}[data-loaded="yes"]`, { timeout: 15_000 })
}

async function boot(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector(testid(RESULT_GRID), { timeout: 30_000 })
  await page.click(sel(ROLE_OPTION, { [ATTR_ROLE]: ROLE_MANAGER }))
  await page.waitForSelector(sel(ACTIVE_ROLE, { [ATTR_ROLE]: ROLE_MANAGER }), { timeout: 10_000 })
}

async function count(page, id) {
  const el = await page.$(testid(id))
  return el ? Number(await el.getAttribute('data-count')) : 0
}

async function syncChecks(browser, deviceProfile) {
  const { context, page, watcher } = await openPage(browser, deviceProfile)
  try {
    await boot(page)

    // ---- QC-SYNC-050: the panel names the adapter and claims nothing else ----
    await openSyncPanel(page)

    assertEqual(
      await page.getAttribute(testid(SYNC_ADAPTER), 'data-adapter'),
      'loopback',
      `${deviceProfile.name}: the panel names its adapter in data, not only in prose`,
    )

    const pageText = (await page.$eval(testid(SYNC_PANEL), (node) => node.innerText)).toLowerCase()
    for (const claim of FORBIDDEN_CLAIMS) {
      // "never been connected to Supabase" is the panel's own honesty sentence,
      // so the check is for a claim, not for a word. A page that says it is
      // connected and a page that says it is not both contain "connected".
      const lies = pageText.includes(claim) && !pageText.includes(`never been ${claim}`)
      assert(
        claim === 'supabase' ? pageText.includes('never been connected to supabase') || !lies : !lies,
        `${deviceProfile.name}: the panel does not claim "${claim}"`,
      )
    }

    // ---- the seeded state: history, not work this session did ----------------
    //
    // D12: hydration writes no outbox entries, because a seeded row is history.
    // A demo that opens with two hundred queued writes teaches the reader that
    // the queue is noise.
    const pendingAtRest = await count(page, OUTBOX_PENDING)
    assertEqual(pendingAtRest, 0, `${deviceProfile.name}: hydration queued nothing, so the queue means something`)

    // ---- QC-SYNC-051: the panel shows the real payloads ----------------------
    //
    // A real edit through a real surface, so the queue holds a patch a reviewer
    // can read rather than one this run manufactured.
    await page.click(testid('nav-creators'))
    await page.waitForSelector(testid('creator-row'), { timeout: 15_000 })
    // A model-scored row, tracked by id: the seed already contains one human
    // override, so waiting for "any human row" would resolve instantly and this
    // run would navigate away before its own write had committed.
    const row = await page.$(sel('creator-row', { 'data-score-source': 'model' }))
    assert(row != null, `${deviceProfile.name}: found a creator to edit`)
    const editedId = await row.getAttribute('data-creator-id')
    await (await row.$(testid('creator-override'))).click()
    await page.waitForSelector(testid('creator-override-form'), { timeout: 8_000 })
    await page.fill(testid('override-score'), '77')
    await page.fill(testid('override-reason'), 'Sync run: a real edit, so the queue holds a real patch.')
    await page.click(testid('override-save'))
    await page.waitForSelector(
      sel('creator-row', { 'data-creator-id': editedId, 'data-score-source': 'human' }),
      { timeout: 8_000 },
    )

    await openSyncPanel(page)

    const pendingAfterEdit = await count(page, OUTBOX_PENDING)
    assert(
      pendingAfterEdit > 0,
      `${deviceProfile.name}: the edit queued ${pendingAfterEdit} write(s)`,
    )

    const entries = await page.$$eval(testid(OUTBOX_ENTRY_ROW), (nodes) =>
      nodes.map((node) => ({
        seq: node.getAttribute('data-seq'),
        store: node.getAttribute('data-store'),
        op: node.getAttribute('data-op'),
        state: node.getAttribute('data-state'),
        patch: node.querySelector('[data-testid="outbox-entry-patch"]')?.textContent ?? '',
      })),
    )
    assert(entries.length > 0, `${deviceProfile.name}: the queue renders its entries (${entries.length})`)
    assert(
      entries.every((entry) => entry.seq && entry.store && entry.op && entry.state),
      `${deviceProfile.name}: every entry exposes seq, store, op and state as data`,
    )

    const creatorPatch = entries.find((entry) => entry.store === 'creator')
    assert(creatorPatch != null, `${deviceProfile.name}: the creator edit is in the queue`)
    assertEqual(creatorPatch.op, 'patch', `${deviceProfile.name}: a field edit queues a patch, not a whole row`)
    assert(
      creatorPatch.patch.includes('fit_score_override') && creatorPatch.patch.includes('77'),
      `${deviceProfile.name}: the patch is verbatim and carries the field that changed`,
    )
    // A patch carries only what changed. Sending the whole row would make two
    // devices editing different fields of one creator into a conflict.
    assert(
      !creatorPatch.patch.includes('display_name'),
      `${deviceProfile.name}: the patch carries only the changed fields, not the whole row`,
    )

    const storeRows = await page.$$eval(testid(OUTBOX_STORE_ROW), (nodes) =>
      nodes.map((node) => node.getAttribute('data-store')),
    )
    assert(storeRows.includes('creator'), `${deviceProfile.name}: the per table breakdown names the table`)

    // ---- the drain, and the cursor that advances on the server's clock -------
    await page.click(testid(SYNC_PUSH))
    await page.waitForSelector(testid(SYNC_LAST_RUN), { timeout: 20_000 })

    assertEqual(
      await count(page, OUTBOX_PENDING),
      0,
      `${deviceProfile.name}: the drain emptied the queue`,
    )
    assert(
      (await count(page, OUTBOX_SENT)) > 0,
      `${deviceProfile.name}: the drained entries are marked sent rather than deleted`,
    )
    assertEqual(
      await count(page, OUTBOX_FAILED),
      0,
      `${deviceProfile.name}: nothing failed on the way to the loopback server`,
    )
    assert(
      (await count(page, SYNC_SERVER_ROWS)) > 0,
      `${deviceProfile.name}: the loopback server holds rows, so the push went somewhere real`,
    )

    await page.click(testid(SYNC_PULL))
    await page.waitForTimeout(400)
    await page.waitForSelector(testid(CURSOR_ROW), { timeout: 20_000 })

    const cursors = await page.$$eval(testid(CURSOR_ROW), (nodes) =>
      nodes.map((node) => ({
        store: node.getAttribute('data-store'),
        at: node.getAttribute('data-server-updated-at'),
        id: node.getAttribute('data-cursor-id'),
      })),
    )
    const advanced = cursors.filter((cursor) => cursor.at != null)
    assert(
      advanced.length > 0,
      `${deviceProfile.name}: the cursor advanced for ${advanced.length} table(s) after the pull`,
    )
    assert(
      advanced.every((cursor) => cursor.id != null),
      `${deviceProfile.name}: every advanced cursor carries the id tiebreak, not only the timestamp`,
    )

    // ---- the storage panel, and the snapshot -------------------------------
    //
    // Records live in IndexedDB by constraint and IndexedDB is evictable. The
    // app cannot prevent that; it can refuse to lose the data silently. So the
    // panel states a verdict rather than a row count, and offers a file.
    await page.click(testid('nav-storage'))
    await page.waitForSelector(testid(STORAGE_PANEL), { timeout: 15_000 })
    await page.waitForSelector(testid(STORAGE_VERDICT), { timeout: 15_000 })

    const verdict = await page.getAttribute(testid(STORAGE_VERDICT), 'data-state')
    assert(
      ['first_run', 'intact', 'evicted'].includes(verdict),
      `${deviceProfile.name}: the storage panel states a verdict, not a bare row count (${verdict})`,
    )
    assert(
      verdict !== 'evicted',
      `${deviceProfile.name}: a fresh browser context is not reported as an eviction`,
    )

    // An unmeasurable quota reads unknown rather than zero, same rule as the
    // scorecard and pre-flight: absent evidence is absent.
    const quotaUsed = await page.$eval(testid('storage-quota-used'), (node) => ({
      bytes: node.getAttribute('data-bytes'),
      text: node.textContent.trim(),
    }))
    assert(
      quotaUsed.bytes != null || quotaUsed.text === 'unknown',
      `${deviceProfile.name}: the quota is a number or the word unknown, never a fabricated zero`,
    )

    // The export is a real file: the download is intercepted and its manifest
    // read, so this asserts the bytes rather than that a button exists.
    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.click(testid(STORAGE_EXPORT)),
    ]).then(([event]) => event)

    const path = await download.path()
    const manifest = JSON.parse(await readFile(path, 'utf8')).manifest
    assertEqual(
      manifest.format,
      'astolia.snapshot.v1',
      `${deviceProfile.name}: the snapshot names its own format, so a restore can refuse a stranger`,
    )
    assert(
      manifest.total_rows > 0,
      `${deviceProfile.name}: the snapshot carries ${manifest.total_rows} records`,
    )
    // The gaps are documented in the file rather than discovered during a restore.
    assert(
      typeof manifest.excluded?.original_bytes === 'string' &&
        manifest.excluded.original_bytes.includes('OPFS'),
      `${deviceProfile.name}: the manifest states that the originals are not in it`,
    )
    assert(
      await exists(page, testid(STORAGE_EXPORT_RECEIPT)),
      `${deviceProfile.name}: the export says what it wrote`,
    )

    // And it restores. Feeding the file straight back is the weakest possible
    // version of a restore, but it is the one that proves the reader and the
    // writer agree, which is the failure a restore actually has.
    await page.setInputFiles(testid('storage-import-file'), path)
    await page.waitForSelector(testid(STORAGE_IMPORT_RECEIPT), { timeout: 20_000 })
    assertEqual(
      Number(await page.getAttribute(testid(STORAGE_IMPORT_RECEIPT), 'data-count')),
      manifest.total_rows,
      `${deviceProfile.name}: the restore read back exactly what the export wrote`,
    )

    await page.click(testid('nav-sync'))
    await openSyncPanel(page)

    // ---- QC-SYNC-052: a conflict is a row on the surface ---------------------
    //
    // A clean round trip produces no conflict, and the panel says so explicitly
    // rather than rendering an empty area that could equally mean "not loaded".
    // The refusal paths themselves are unit tested per merge primitive in
    // tests/app/sync.spec.ts, where a second device can be constructed.
    assert(
      await exists(page, testid(CONFLICT_EMPTY)),
      `${deviceProfile.name}: a clean round trip says "no conflict recorded" rather than showing blank`,
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
  await run(DESKTOP.name, () => syncChecks(browser, DESKTOP))
} catch (err) {
  note(`sync run threw: ${err && err.stack ? err.stack : err}`)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (!server.reused) await stopServer()
  note('sync run complete')
  finish()
}
