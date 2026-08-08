/**
 * Boot smoke test. This is the one spec that must pass right now, on whatever
 * the app currently renders, at both viewports.
 *
 * What it proves, and each of these is a bug class a unit test cannot see:
 *   1. the bundle actually loads and Vue actually mounts into #app
 *   2. nothing was logged to the console, no page error, no unhandled rejection,
 *      no failed request and no 4xx or 5xx response. A silent console error
 *      during a demo is exactly the class of bug this catches
 *   3. the design tokens are applied: the computed body background equals the
 *      resolved `--bg` token and is not the browser default white, which proves
 *      the stylesheet loaded rather than merely existing on disk
 *   4. the app reaches a non-empty seeded state: a real poster under
 *      /seed/posters/ decoded, and no seed asset request failed. A grid of broken
 *      image boxes is invisible to a unit test and obvious here
 *   5. no horizontal body scroll at 390px, which is the only layout guarantee
 *      available with no device testing
 *   6. a second load does not break, which is the cheapest possible check that
 *      idempotent hydration is idempotent in the browser too
 *
 * Run: `npm run test:e2e:boot`
 *
 * Note on 4: while the library surface is still being built, the poster
 * assertion cannot be satisfied by anything the app requests, so it reports as
 * PEND rather than as PASS. It is deliberately not weakened into something that
 * would pass on an empty shell, and the same claim is asserted for real in
 * `e2e/editor.e2e.mjs`. See `qa/status.md`.
 */
import {
  BASE_URL, DESKTOP, MOBILE, assert, assertEqual, finish, launch, note, openPage,
  pendingAssert, run, startServer, stopServer, exists,
} from './_support/harness.mjs'
import {
  APP_ROOT, RESULT_GRID, RESULT_TILE, RESULT_TILE_POSTER, SEED_READY,
  ATTR_COUNT, ATTR_SEED_VERSION, testid,
} from './_support/testids.mjs'

const SEED_ASSET = /\/seed\/(posters|sheets|clips)\//
const SEED_POSTER = /\/seed\/posters\/[^/]+\.(jpg|jpeg|png|webp)(\?|$)/

async function bootChecks(browser, deviceProfile) {
  const { context, page, watcher } = await openPage(browser, deviceProfile)
  try {
    const response = await page.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 45_000 })
    assertEqual(response ? response.status() : 0, 200, `${deviceProfile.name}: GET / returned 200`)

    // 1. Mount. Vue replacing the empty #app is the whole claim here.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('app')
        return !!root && root.childElementCount > 0
      },
      undefined,
      { timeout: 20_000 },
    ).catch(() => {})

    const mounted = await page.evaluate(() => {
      const root = document.getElementById('app')
      return {
        exists: !!root,
        children: root ? root.childElementCount : 0,
        textLength: root ? root.innerText.trim().length : 0,
        title: document.title,
      }
    })
    assert(mounted.exists, `${deviceProfile.name}: #app exists in the document`)
    assert(mounted.children > 0, `${deviceProfile.name}: Vue mounted into #app (${mounted.children} child element(s))`)
    assert(mounted.textLength > 0, `${deviceProfile.name}: the mounted app rendered visible text (${mounted.textLength} chars)`)
    assert(mounted.title.trim().length > 0, `${deviceProfile.name}: document has a title ("${mounted.title}")`)

    // Give hydration a chance to settle before reading state, without waiting on
    // a marker that may not exist yet.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

    // 3. Design tokens. The token is read from :root and resolved through a probe
    // element, so nothing here hardcodes a hex value from the design system: if
    // the palette changes, this test still asserts the right thing.
    const tokens = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement)
      const bgToken = rootStyle.getPropertyValue('--bg').trim()
      const inkToken = rootStyle.getPropertyValue('--ink').trim()
      const probe = document.createElement('div')
      probe.style.color = bgToken || 'transparent'
      document.body.appendChild(probe)
      const resolvedBgToken = getComputedStyle(probe).color
      probe.remove()
      const bodyStyle = getComputedStyle(document.body)
      return {
        bgToken,
        inkToken,
        resolvedBgToken,
        bodyBackground: bodyStyle.backgroundColor,
        bodyFontFamily: bodyStyle.fontFamily,
        boxSizing: bodyStyle.boxSizing,
      }
    })
    assert(tokens.bgToken.length > 0, `${deviceProfile.name}: --bg is defined on :root (${tokens.bgToken})`)
    assert(tokens.inkToken.length > 0, `${deviceProfile.name}: --ink is defined on :root (${tokens.inkToken})`)
    assert(
      tokens.bodyBackground !== 'rgba(0, 0, 0, 0)' && tokens.bodyBackground !== 'rgb(255, 255, 255)',
      `${deviceProfile.name}: body background is not the browser default (${tokens.bodyBackground})`,
    )
    assertEqual(
      tokens.bodyBackground,
      tokens.resolvedBgToken,
      `${deviceProfile.name}: body background equals the resolved --bg token`,
    )
    assert(
      /system-ui/.test(tokens.bodyFontFamily),
      `${deviceProfile.name}: the --sans token reached body font-family (${tokens.bodyFontFamily.slice(0, 40)})`,
    )
    assertEqual(tokens.boxSizing, 'border-box', `${deviceProfile.name}: the tokens reset applied box-sizing: border-box`)

    // 4. Non-empty seeded state. Two independent facts: no seed request failed,
    // and at least one poster actually decoded to real pixels.
    const seedResponses = watcher.responsesMatching(SEED_ASSET)
    const failedSeedResponses = seedResponses.filter((r) => r.status >= 400)
    assert(
      failedSeedResponses.length === 0,
      `${deviceProfile.name}: no failed request for a seed asset (${seedResponses.length} requested, ${failedSeedResponses.length} failed)`,
    )

    const images = await page.evaluate(() => {
      const list = Array.from(document.images)
      const src = (i) => i.currentSrc || i.src || ''
      return {
        total: list.length,
        broken: list.filter((i) => !(i.complete && i.naturalWidth > 0)).map(src),
        posters: list
          .filter((i) => /\/seed\/posters\//.test(src(i)))
          .map((i) => ({ src: src(i), width: i.naturalWidth, height: i.naturalHeight })),
      }
    })
    assert(
      images.broken.length === 0,
      `${deviceProfile.name}: no broken <img> on the page (${images.total} image(s) checked${images.broken.length ? `, first broken: ${images.broken[0]}` : ''})`,
    )

    const posterResponses = watcher.responsesMatching(SEED_POSTER)
    if (posterResponses.length === 0 && images.posters.length === 0) {
      pendingAssert(
        `${deviceProfile.name}: at least one real image loaded from /seed/posters/. No poster was requested at all, so the library surface has not landed yet. This assertion is live and starts counting the moment it renders, and it is asserted for real in e2e/editor.e2e.mjs`,
      )
      const hasGrid = await exists(page, testid(RESULT_GRID), 500)
      note(`${deviceProfile.name}: ${testid(RESULT_GRID)} present: ${hasGrid}, ${testid(RESULT_TILE)} present: ${await exists(page, testid(RESULT_TILE), 500)}, ${testid(RESULT_TILE_POSTER)} present: ${await exists(page, testid(RESULT_TILE_POSTER), 500)}`)
    } else {
      assert(
        images.posters.length > 0,
        `${deviceProfile.name}: the page holds at least one /seed/posters/ image (${images.posters.length})`,
      )
      const decoded = images.posters.filter((p) => p.width > 0 && p.height > 0)
      assert(
        decoded.length === images.posters.length,
        `${deviceProfile.name}: every /seed/posters/ image decoded to real pixels (${decoded.length}/${images.posters.length}, first ${decoded[0] ? `${decoded[0].width}x${decoded[0].height}` : 'n/a'})`,
      )
      assert(
        posterResponses.every((r) => r.status === 200),
        `${deviceProfile.name}: every /seed/posters/ response was 200 (${posterResponses.length} checked)`,
      )
    }

    // The hydration marker, if the shell publishes it yet.
    if (await exists(page, testid(SEED_READY), 1000)) {
      const seedInfo = await page.evaluate(
        ([selector, countAttr, versionAttr]) => {
          const el = document.querySelector(selector)
          return el ? { count: Number(el.getAttribute(countAttr)), version: el.getAttribute(versionAttr) } : null
        },
        [testid(SEED_READY), ATTR_COUNT, ATTR_SEED_VERSION],
      )
      assert(!!seedInfo && seedInfo.count > 0, `${deviceProfile.name}: hydration reported a non-empty seed (${seedInfo ? seedInfo.count : 'null'} assets, version ${seedInfo ? seedInfo.version : 'null'})`)
    } else {
      pendingAssert(`${deviceProfile.name}: ${testid(SEED_READY)} reports the hydrated asset count. Marker not rendered yet`)
    }

    // 5. No horizontal body scroll. The mobile case is the one that matters.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
    }))
    assert(
      overflow.scrollWidth <= overflow.clientWidth + 1,
      `${deviceProfile.name}: no horizontal body scroll (scrollWidth ${overflow.scrollWidth} <= clientWidth ${overflow.clientWidth})`,
    )
    assertEqual(overflow.innerWidth, deviceProfile.viewport.width, `${deviceProfile.name}: viewport width is ${deviceProfile.viewport.width}`)

    // The shell anchor from the selector contract. Not yet a hard assertion,
    // because the shell is being rewritten as this runs.
    if (await exists(page, testid(APP_ROOT), 800)) {
      assert(true, `${deviceProfile.name}: ${testid(APP_ROOT)} present, the shell honours the selector contract`)
    } else {
      pendingAssert(`${deviceProfile.name}: ${testid(APP_ROOT)} on the app shell (see e2e/_support/testids.mjs). Not rendered yet`)
    }

    await watcher.assertClean(deviceProfile.name)
  } finally {
    await context.close()
  }
}

async function secondBootIsClean(browser) {
  const { context, page, watcher } = await openPage(browser, DESKTOP)
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    await page.reload({ waitUntil: 'load', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    const children = await page.evaluate(() => {
      const root = document.getElementById('app')
      return root ? root.childElementCount : 0
    })
    assert(children > 0, `second load into the same origin still mounts (${children} child element(s))`)
    await watcher.assertClean('second load (hydration must be idempotent)')
  } finally {
    await context.close()
  }
}

const server = await startServer()
let browser
try {
  browser = await launch()
} catch (err) {
  // The boot spec is the one that must pass, so an unavailable browser is a
  // failure here rather than a skip. The fix list was already printed.
  assert(false, `chromium is required for the boot smoke test: ${err.message}`)
  if (!server.reused) await stopServer()
  finish()
}

try {
  await run(DESKTOP.name, () => bootChecks(browser, DESKTOP))
  await run(MOBILE.name, () => bootChecks(browser, MOBILE))
  await run('second load, hydration idempotence', () => secondBootIsClean(browser))
} finally {
  await browser.close()
  if (!server.reused) await stopServer()
}

finish()
