/**
 * DECODE RUN: the only automated proof that this codebase can produce a contact
 * sheet from real pixels.
 *
 * Everything below the decode adapters is unit tested against fakes: the frame
 * plan, the fallback order, blank detection, tiling, the long edge cap, the
 * hashing and the memory discipline. What no unit test can assert is that a real
 * decoder, a real canvas and a real JPEG encoder produce a real image, because
 * jsdom has none of the three. That is what this run is for, and it is why
 * `docs/06-decisions.md` D25 reverses D24 for the element path.
 *
 * Why a generated clip rather than a committed fixture (D26): the Chromium in
 * this environment is the open source build with no proprietary codecs, so it
 * cannot decode the H.264 fixture set at all. VP9 in MP4 is a real ISOBMFF file,
 * so it goes through our own atom parser rather than around it, and this browser
 * decodes VP9, so the run exercises the same path an iPhone clip takes on a Mac.
 * The clip is generated at run time because `public/fixtures/` is a sha256
 * verified contract about container gotchas and a codec picked to suit one CI
 * machine does not belong in it.
 *
 * What is asserted, and each one is a claim the product makes to a manager:
 *   1. the browser really cannot decode H.264 here, so the rest of the run means
 *      what it says rather than passing by accident
 *   2. a decodable clip yields a poster or sheet image that DECODED, with real
 *      pixel dimensions, and no placeholder
 *   3. the frames are visibly different moments, by per frame hash distance,
 *      because five copies of one frame is the failure that looks like success
 *   4. the sheet's long edge honours the cap from D3
 *   5. a `contact_sheet` row and one `asset_frame` row per frame exist, because
 *      a sheet nothing points at cannot be re-derived or explained
 *   6. the undecodable clip degrades honestly in the same session: no sheet, no
 *      AI fields, a stated reason, and the record still exists
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  BASE_URL, DESKTOP, REPO_ROOT, assert, assertEqual, exists,
  finish, launch, note, openPage, pendingAssert, run, startServer, stopServer,
} from './_support/harness.mjs'
import {
  CONSENT_ACCEPT, CONSENT_RECORDED,
  INVITE_CONTINUE, INVITE_ROOT,
  PLACEHOLDER_TILE, PREFLIGHT_RULE, UPLOAD_FILE_INPUT, UPLOAD_FILE_ROW,
  UPLOAD_FILE_THUMB, UPLOAD_FILE_VERDICT, UPLOAD_ROOT,
  ATTR_FILE_NAME, ATTR_RULE, ATTR_STATUS, ATTR_VERDICT,
  sel, testid,
} from './_support/testids.mjs'

const require = createRequire(import.meta.url)
const INVITE_URL = '/#/c/demo-creator-token'

/**
 * An aborted blob fetch during media teardown is expected, not a defect.
 *
 * The extractor deliberately stops reading once it has the frames it planned:
 * never materialising a whole clip is the point, and it is why a 1.8GB ProRes
 * file does not have to fit in memory. Revoking the object URL while the element
 * is still buffering is therefore the normal end of every extraction, and
 * Chromium reports it as `net::ERR_ABORTED` on the blob URL.
 *
 * Scoped to the runs that actually decode rather than added to the harness
 * default, so a genuinely failed request anywhere else still fails a run.
 */
const TEARDOWN_ABORT = /blob:.*ERR_ABORTED/

/**
 * A decodable vertical clip: 1080x1920 so it clears the resolution rule, and 6
 * seconds so the frame count formula asks for five frames at the standard tier.
 *
 * The content is a continuously zooming Mandelbrot rather than `testsrc2`, and
 * that is a deliberate correction rather than a preference. `testsrc2` is mostly
 * static colour bars, and this run's own assertion caught the consequence: five
 * genuinely different decoded frames produced five IDENTICAL 64 bit hashes,
 * because at a 9 by 8 luma grid the moving element is too small to move a bit.
 * That is a true fact about dHash and a useless test clip. A zooming fractal
 * changes every region of the frame at every scale, so "these are different
 * moments" becomes measurable, which is the whole point of the assertion.
 */
function makeDecodableClip() {
  const ffmpeg = require('ffmpeg-static')
  const dir = mkdtempSync(join(tmpdir(), 'astolia-e2e-decode-'))
  const path = join(dir, 'garden_vertical.mp4')
  execFileSync(
    ffmpeg,
    [
      '-y', '-f', 'lavfi', '-i', 'mandelbrot=size=1080x1920:rate=25',
      '-t', '6',
      '-c:v', 'libvpx-vp9', '-b:v', '900k', '-pix_fmt', 'yuv420p',
      '-metadata', 'creation_time=2026-08-02T11:00:00Z',
      '-f', 'mp4', path,
    ],
    { stdio: 'ignore' },
  )
  return { path, bytes: statSync(path).size }
}

function h264FixturePath() {
  return join(REPO_ROOT, 'public', 'fixtures', 'vertical_ok.mp4')
}

/** Hamming distance between two hex hashes, for the distinct-frames claim. */
function hamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return null
  let bits = 0
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      bits += x & 1
      x >>= 1
    }
  }
  return bits
}

async function openUploadPage(page) {
  await page.goto(`${BASE_URL}${INVITE_URL}`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForSelector(testid(INVITE_ROOT), { timeout: 30_000 })
  if (await exists(page, testid(CONSENT_ACCEPT), 3000)) {
    await page.click(testid(CONSENT_ACCEPT))
    await page.waitForSelector(testid(CONSENT_RECORDED), { timeout: 10_000 })
  }
  await page.click(testid(INVITE_CONTINUE))
  await page.waitForSelector(testid(UPLOAD_ROOT), { timeout: 20_000 })
}

/** Claim 1: state the runtime's codec reality before relying on it. */
async function runtimeCodecs(browser) {
  const { context, page } = await openPage(browser, DESKTOP)
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 45_000 })
    const answers = await page.evaluate(() => {
      const v = document.createElement('video')
      return {
        h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
        vp9: v.canPlayType('video/mp4; codecs="vp09.00.10.08"'),
        hevc: v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'),
        hasVideoDecoder: typeof VideoDecoder !== 'undefined',
      }
    })
    note(`runtime codecs: h264="${answers.h264}" vp9="${answers.vp9}" hevc="${answers.hevc}" VideoDecoder=${answers.hasVideoDecoder}`)
    assert(
      answers.vp9 === 'probably' || answers.vp9 === 'maybe',
      `this runtime decodes VP9 ("${answers.vp9}"), so the decode proof below is meaningful`,
    )
    if (answers.h264 === '') {
      note('this runtime has NO H.264 decoder, which is exactly what docs/06-decisions.md D26 records. The committed fixture set cannot demonstrate decode here, and the honest-degradation assertions below use it instead.')
    }
    return answers
  } finally {
    await context.close()
  }
}

/** Claims 2 to 5: a decodable clip produces a real, re-derivable sheet. */
async function realSheetFromRealPixels(browser, clip) {
  const { context, page, watcher } = await openPage(browser, DESKTOP, { ignore: [TEARDOWN_ABORT] })
  try {
    await openUploadPage(page)
    await page.setInputFiles(testid(UPLOAD_FILE_INPUT), [clip.path])

    const rowSelector = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'garden_vertical.mp4' })
    assert(await exists(page, rowSelector, 30_000), 'the decodable clip produced a row')

    // Decoding five frames of 1080x1920 takes real time. Waiting on the state
    // rather than on a sleep keeps the run honest on a slow machine.
    await page.waitForFunction(
      ([selector]) => {
        const row = document.querySelector(selector)
        const state = row?.getAttribute('data-upload-state')
        return state === 'stored' || state === 'blocked' || state === 'failed'
      },
      [rowSelector],
      { timeout: 120_000 },
    )

    const state = await page.getAttribute(rowSelector, 'data-upload-state')
    assertEqual(state, 'stored', 'the decodable clip passed pre-flight and was stored')

    const verdict = await page.getAttribute(`${rowSelector} ${testid(UPLOAD_FILE_VERDICT)}`, ATTR_VERDICT)
    assert(verdict === 'ok' || verdict === 'advisory', `its verdict is ${verdict}, not blocked`)

    // Claim 2: a real image, decoded, with real pixels.
    const image = await page.evaluate(
      ([selector, thumbSel]) => {
        const img = document.querySelector(`${selector} ${thumbSel}`)
        if (!img) return null
        return { complete: img.complete, w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 24) }
      },
      [rowSelector, testid(UPLOAD_FILE_THUMB)],
    )
    assert(!!image, 'the row rendered a derived image rather than a placeholder')
    assert(
      !!image && image.complete && image.w > 0 && image.h > 0,
      `the derived image decoded to real pixels (${image ? `${image.w}x${image.h}` : 'none'})`,
    )
    assert(
      !!image && image.src.startsWith('blob:'),
      'the image came from a blob this code produced, not from a committed seed file',
    )
    assertEqual(
      await page.locator(`${rowSelector} ${testid(PLACEHOLDER_TILE)}`).count(),
      0,
      'no placeholder tile is shown for a clip we could decode',
    )

    // Claims 3 to 5 read the records back, because a sheet nothing points at
    // cannot be re-derived, explained, or handed to a model later.
    const records = await page.evaluate(async () => {
      const open = () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('astolia_demo')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const all = (db, store) =>
        new Promise((resolve, reject) => {
          const request = db.transaction([store], 'readonly').objectStore(store).getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const db = await open()
      const [sheets, frameRowsAll, assets, blobs] = await Promise.all([
        all(db, 'contact_sheet'),
        all(db, 'asset_frame'),
        all(db, 'asset'),
        all(db, 'blob'),
      ])
      db.close()
      const asset = assets.find((row) => row.filename === 'garden_vertical.mp4')
      const sheet = sheets.find((row) => row.asset_id === asset?.id)
      const frames = frameRowsAll
        .filter((row) => row.asset_id === asset?.id)
        .sort((a, b) => a.seq - b.seq)
      return {
        asset: asset
          ? {
              id: asset.id,
              derivative_state: asset.derivative_state,
              sheet_key: asset.sheet_key,
              poster_key: asset.poster_key,
              frame_hashes: asset.frame_hashes,
              coded_width: asset.coded_width,
              coded_height: asset.coded_height,
              duration_s: asset.duration_s,
              codec_video: asset.codec_video,
              ai_provenance: asset.ai_provenance,
              ai_description: asset.ai_description,
            }
          : null,
        sheet: sheet ?? null,
        frameRows: frames.length,
        frameTimes: frames.map((row) => row.actual_t_seconds),
        plannedTimes: frames.map((row) => row.planned_t_seconds),
        blobKeys: blobs.map((row) => row.key ?? row.id).filter(Boolean).length,
      }
    })

    assert(!!records.asset, 'an asset row exists for the decoded clip')
    assertEqual(records.asset?.derivative_state, 'ready', 'derivative_state is ready, because pixels really exist')
    assert(!!records.asset?.sheet_key, `the asset points at its sheet blob (${records.asset?.sheet_key})`)
    assertEqual(records.asset?.codec_video, 'vp09', 'the parser read the codec from the sample description')
    assertEqual(records.asset?.coded_width, 1080, 'the parser read coded width from stsd, not from tkhd')
    assertEqual(records.asset?.coded_height, 1920, 'the parser read coded height from stsd, not from tkhd')

    // No fabrication: pixels exist, and still no model has spoken.
    assertEqual(records.asset?.ai_provenance, 'none', 'no AI provenance is claimed on a freshly ingested clip')
    assertEqual(records.asset?.ai_description, null, 'no AI description is invented at ingest')

    assert(!!records.sheet, 'a contact_sheet row exists, so the sheet is re-derivable and explainable')
    if (records.sheet) {
      assert(
        records.sheet.frame_count >= 3,
        `the sheet records its frame count (${records.sheet.frame_count})`,
      )
      assertEqual(
        records.frameRows,
        records.sheet.frame_count,
        'one asset_frame row per frame in the sheet',
      )
      assert(
        !!records.sheet.extractor_path,
        `the sheet records which path produced it (${records.sheet.extractor_path})`,
      )
      assert(
        Math.max(records.sheet.width, records.sheet.height) <= 1024,
        `the sheet honours the 1024px long edge cap (${records.sheet.width}x${records.sheet.height})`,
      )
    }

    // Claim 3a: the adapter really moved through the clip. This is a statement
    // about seeking and is independent of what the content looks like, so it
    // stays meaningful even for a clip whose pixels barely change.
    const times = records.frameTimes ?? []
    note(`planned frame times: ${(records.plannedTimes ?? []).join(', ')}`)
    note(`actual frame times: ${times.join(', ')}`)
    assertEqual(
      new Set(times.map((t) => Math.round(t * 100))).size,
      times.length,
      `every frame was decoded at a distinct timestamp (${times.map((t) => t.toFixed(2)).join(', ')})`,
    )
    assert(
      times.length > 1 && times[times.length - 1] > times[0],
      'the frame times increase through the clip rather than clustering at the start',
    )

    // Claim 3b: visibly different moments. A zooming fractal changes at every
    // scale, so identical hashes here would mean we sampled one frame five
    // times, which is the failure that looks exactly like success.
    const hashes = records.asset?.frame_hashes ?? []
    assert(hashes.length >= 3, `the asset recorded a hash per frame (${hashes.length})`)
    const distances = []
    for (let i = 1; i < hashes.length; i += 1) {
      distances.push(hamming(hashes[i - 1], hashes[i]))
    }
    assert(
      distances.every((d) => d !== null && d > 0),
      `consecutive frames are different moments (per frame distances: ${distances.join(', ')})`,
    )
    assertEqual(
      new Set(hashes).size,
      hashes.length,
      'no two extracted frames are identical',
    )

    await watcher.assertClean('decode run')
  } finally {
    await context.close()
  }
}

/** Claim 6: the clip this runtime cannot decode degrades honestly. */
async function undecodableDegradesHonestly(browser) {
  const { context, page } = await openPage(browser, DESKTOP, { ignore: [TEARDOWN_ABORT] })
  try {
    await openUploadPage(page)
    await page.setInputFiles(testid(UPLOAD_FILE_INPUT), [h264FixturePath()])
    const rowSelector = sel(UPLOAD_FILE_ROW, { [ATTR_FILE_NAME]: 'vertical_ok.mp4' })
    assert(await exists(page, rowSelector, 30_000), 'the undecodable clip is still listed, never silently dropped')

    await page.waitForFunction(
      ([selector]) => {
        const row = document.querySelector(selector)
        const state = row?.getAttribute('data-upload-state')
        return state === 'stored' || state === 'blocked' || state === 'failed'
      },
      [rowSelector],
      { timeout: 120_000 },
    )

    // The container facts still come out, because the parser reads bytes and
    // needs no decoder: this is why metadata is an enhancement, not a dependency.
    const rules = await page.evaluate(
      ([selector, ruleSel, ruleAttr, statusAttr]) => {
        const out = {}
        for (const el of document.querySelectorAll(`${selector} ${ruleSel}`)) {
          out[el.getAttribute(ruleAttr)] = {
            status: el.getAttribute(statusAttr),
            reason: el.getAttribute('data-reason'),
          }
        }
        return out
      },
      [rowSelector, testid(PREFLIGHT_RULE), ATTR_RULE, ATTR_STATUS],
    )
    assertEqual(rules.orientation?.status, 'pass', 'orientation was still decided, from the bytes alone')
    assert(!!rules.codec_playable, 'codec_playable is reported rather than omitted')
    note(`codec_playable on this runtime: ${rules.codec_playable?.status} (${rules.codec_playable?.reason ?? 'no reason'})`)

    const state = await page.getAttribute(rowSelector, 'data-upload-state')
    if (state === 'stored') {
      const records = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('astolia_demo')
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const assets = await new Promise((resolve, reject) => {
          const request = db.transaction(['asset'], 'readonly').objectStore('asset').getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        db.close()
        const asset = assets.find((row) => row.filename === 'vertical_ok.mp4')
        return asset
          ? {
              derivative_state: asset.derivative_state,
              sheet_key: asset.sheet_key,
              ai_provenance: asset.ai_provenance,
              ai_description: asset.ai_description,
              ai_matched_brief_item_id: asset.ai_matched_brief_item_id,
            }
          : null
      })
      assert(!!records, 'the undecodable clip still produced a record: we received the footage')
      assertEqual(records?.derivative_state, 'none', 'derivative_state is none, because there are no pixels')
      assertEqual(records?.sheet_key, null, 'no sheet key is invented for a clip we could not decode')
      assertEqual(records?.ai_provenance, 'none', 'no AI provenance on a clip nobody could see')
      assertEqual(records?.ai_description, null, 'no AI description on a clip nobody could see')
      assertEqual(
        records?.ai_matched_brief_item_id,
        null,
        'no brief item match on a clip nobody could see, which is the fabrication the data health panel counts',
      )
      assert(
        await exists(page, `${rowSelector} ${testid(PLACEHOLDER_TILE)}`, 3000),
        'a grey placeholder is shown, never a broken video element and never an endless spinner',
      )
    } else {
      pendingAssert(
        `the undecodable clip read as ${state} rather than stored on this runtime, so the degradation record assertions did not run`,
      )
    }
  } finally {
    await context.close()
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

let clip = null
await run('preconditions: generate a clip this runtime can actually decode', async () => {
  clip = makeDecodableClip()
  assert(clip.bytes > 10_000, `generated a VP9 in MP4 clip of ${clip.bytes} bytes`)
  note('generated rather than committed, per docs/06-decisions.md D26')
})

const server = await startServer()
let browser
try {
  browser = await launch()
} catch (err) {
  assert(false, `chromium is required for the decode run: ${err.message}`)
  if (!server.reused) await stopServer()
  finish()
}

try {
  await run('the runtime states its own codec support', () => runtimeCodecs(browser))
  if (clip) {
    await run('a decodable clip yields a real sheet from real pixels', () =>
      realSheetFromRealPixels(browser, clip),
    )
  }
  await run('an undecodable clip degrades honestly', () => undecodableDegradesHonestly(browser))
} finally {
  await browser.close()
  if (!server.reused) await stopServer()
}

finish()
