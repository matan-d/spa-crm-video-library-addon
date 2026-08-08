/**
 * Shared harness for the browser end to end specs.
 *
 * House convention, taken from `432 Player/432Player/e2e/radio-favorites.e2e.mjs`:
 * the devDependency is `playwright` (not `@playwright/test`), reached through
 * `createRequire`, the specs are plain ESM `.e2e.mjs` scripts run with `node`,
 * and the whole reporting surface is `assert(cond, msg)` printing PASS or FAIL,
 * counting failures, and exiting non zero if any failed.
 *
 * There is no retry anywhere in this file, deliberately. A flake that a second
 * attempt hides is a defect we shipped, so a failure here is always the first
 * failure, and re-running is a human decision rather than an automatic one.
 *
 * One improvement on the 432 Player convention: that repo required the developer
 * to run `npm run dev` in another shell. This app needs no network and no
 * backend, so `startServer()` boots Vite itself on a dedicated port, waits for it
 * to answer, and `stopServer()` shuts it down. An already running server on the
 * same port is reused rather than fought over.
 *
 * Chromium resolution order (`resolveChromium()`), which matters more here than it
 * did there because this repo is meant to be picked up in a cloud sandbox that may
 * already carry a browser:
 *   1. $CHROMIUM_PATH (explicit override)
 *   2. a browser under $PLAYWRIGHT_BROWSERS_PATH (pre-installed sandbox image)
 *   3. Playwright's own managed browser (`npx playwright install chromium`)
 *   4. any chromium-* build in the default Playwright cache, as a last resort when
 *      the installed `playwright` package wants a revision that is not present
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')

export { devices }

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Dedicated port, so a `npm run dev` on 5173 is never disturbed. */
export const PORT = Number(process.env.E2E_PORT || 4330)
export const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')

/**
 * The two viewports from `qa/PLAN.md`. Desktop is an instrument, mobile is a
 * decision surface, so both are checked on every run rather than one being
 * assumed to follow from the other.
 *
 * `colorScheme` is pinned to light on purpose: the design tokens differ between
 * light and dark, so a colour assertion that inherits the machine's preference is
 * a test that passes on one laptop and fails on another.
 */
export const DESKTOP = {
  name: 'desktop 1440x900 (fine pointer)',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  colorScheme: 'light',
}

export const MOBILE = {
  name: 'mobile 390x844 (coarse pointer, iPhone 13 descriptor)',
  ...devices['iPhone 13'],
  colorScheme: 'light',
}

// ---------------------------------------------------------------------------
// Chromium resolution
// ---------------------------------------------------------------------------

/** Per platform layouts of a Playwright chromium build directory. */
const CHROME_LAYOUTS = [
  ['chrome-win64', 'chrome.exe'],
  ['chrome-win', 'chrome.exe'],
  ['chrome-linux', 'chrome'],
  ['chrome-linux64', 'chrome'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
]

function defaultCacheRoots() {
  const home = homedir()
  return [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean)
}

/** Highest revision first, so a stale build never wins over a fresh one. */
function scanBrowsersRoot(root) {
  if (!root || !existsSync(root)) return undefined
  let dirs
  try {
    dirs = readdirSync(root)
  } catch {
    return undefined
  }
  const builds = dirs
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const dir of builds) {
    for (const layout of CHROME_LAYOUTS) {
      const candidate = join(root, dir, ...layout)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

let chromiumSource = 'unresolved'

/**
 * Returns an explicit executable path, or `undefined` to let Playwright use its
 * own managed browser. `chromiumSourceLabel()` says which branch won, which is
 * the line you want in a CI log when a run behaves differently on two machines.
 */
export function resolveChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    chromiumSource = '$CHROMIUM_PATH'
    return process.env.CHROMIUM_PATH
  }

  const fromEnvRoot = scanBrowsersRoot(process.env.PLAYWRIGHT_BROWSERS_PATH)
  if (fromEnvRoot) {
    chromiumSource = '$PLAYWRIGHT_BROWSERS_PATH'
    return fromEnvRoot
  }

  // Playwright's own managed browser, which is the normal case after
  // `npx playwright install chromium`.
  try {
    const managed = chromium.executablePath()
    if (managed && existsSync(managed)) {
      chromiumSource = 'playwright managed'
      return undefined
    }
  } catch {
    // executablePath() throws when the registry has no entry at all.
  }

  // Last resort: the installed `playwright` package wants a revision that is not
  // in the cache, but some chromium build is. Better a version skew warning than
  // a suite that cannot run at all in a sandbox.
  for (const root of defaultCacheRoots()) {
    const found = scanBrowsersRoot(root)
    if (found) {
      chromiumSource = 'default cache (revision may not match this playwright)'
      return found
    }
  }

  chromiumSource = 'none found'
  return undefined
}

export function chromiumSourceLabel() {
  return chromiumSource
}

export class BrowserUnavailableError extends Error {
  constructor(cause) {
    super(`chromium could not be launched: ${String(cause && cause.message ? cause.message : cause).split('\n')[0]}`)
    this.name = 'BrowserUnavailableError'
    this.cause = cause
  }
}

/**
 * Launches Chromium, or throws `BrowserUnavailableError` with a fix list. The
 * failure text matters: a suite that cannot find a browser must say so plainly
 * rather than looking like a product bug.
 */
export async function launch(opts = {}) {
  const executablePath = resolveChromium()
  console.log(`browser: ${chromiumSourceLabel()}${executablePath ? ` -> ${executablePath}` : ''}`)
  try {
    return await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
      ...opts,
    })
  } catch (err) {
    console.log('')
    console.log('chromium is not available in this environment.')
    console.log(`  reason: ${String(err.message).split('\n')[0]}`)
    console.log('  fix one of:')
    console.log('    npx playwright install chromium')
    console.log('    CHROMIUM_PATH=/path/to/chrome npm run test:e2e')
    console.log('    PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright npm run test:e2e')
    console.log('')
    throw new BrowserUnavailableError(err)
  }
}

// ---------------------------------------------------------------------------
// The dev server, started by the suite rather than by the developer
// ---------------------------------------------------------------------------

let serverProc = null
let serverOutput = ''

/**
 * True only when the thing answering the port is this app, not some other
 * process that happens to hold it. Checking for the module entry means a stray
 * server cannot be mistaken for ours and produce a confusing failure.
 */
async function isOurServer(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return false
    const html = await res.text()
    return html.includes('/src/main.ts') && html.includes('id="app"')
  } catch {
    return false
  }
}

export async function startServer({ baseUrl = BASE_URL, port = PORT, timeoutMs = 90_000 } = {}) {
  if (await isOurServer(baseUrl)) {
    console.log(`server: reusing the one already answering on ${baseUrl}`)
    return { baseUrl, reused: true }
  }

  console.log(`server: starting vite on ${baseUrl}`)
  serverProc = spawn(
    process.execPath,
    [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  serverProc.stdout.on('data', (d) => { serverOutput += d.toString() })
  serverProc.stderr.on('data', (d) => { serverOutput += d.toString() })
  serverProc.on('exit', (code) => { serverOutput += `\n[vite exited with code ${code}]\n` })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null) break
    if (await isOurServer(baseUrl)) {
      console.log(`server: ready on ${baseUrl}`)
      return { baseUrl, reused: false }
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  const detail = serverOutput.trim() || '(no output)'
  await stopServer()
  throw new Error(`vite did not answer on ${baseUrl} within ${timeoutMs}ms.\nvite output:\n${detail}`)
}

export async function stopServer() {
  const proc = serverProc
  serverProc = null
  if (!proc || proc.exitCode !== null) return

  await new Promise((done) => {
    let settled = false
    const finishOnce = () => { if (!settled) { settled = true; done() } }
    proc.once('exit', finishOnce)

    if (process.platform === 'win32') {
      // Vite spawns an esbuild service, so the whole tree has to go or the port
      // stays held and the next run reuses a server it did not start.
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      proc.kill('SIGTERM')
    }
    setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } finishOnce() }, 5000)
  })
  console.log('server: stopped')
}

// ---------------------------------------------------------------------------
// Assertions and tally
// ---------------------------------------------------------------------------

const tally = { pass: 0, fail: 0, pending: 0 }
const failureDetail = []

export function assert(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`)
  if (cond) tally.pass++
  else {
    tally.fail++
    failureDetail.push(msg)
  }
}

/**
 * Asserts two values and prints both when they differ, because "expected X, got
 * Y" is the difference between a report and a reproduction.
 */
export function assertEqual(actual, expected, msg) {
  const ok = Object.is(actual, expected)
  assert(ok, ok ? msg : `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

/** Numeric comparison with an explicit tolerance. Tolerances are mandatory. */
export function assertWithin(actual, expected, tolerance, msg) {
  const ok = typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
  assert(ok, `${msg} (expected ${expected} +/- ${tolerance}, got ${JSON.stringify(actual)})`)
}

/**
 * A claim that cannot be checked yet. It never counts as a pass and it never
 * counts as a failure: it prints, it is tallied separately, and it appears in
 * the summary so nobody reads a green run as full coverage.
 */
export function pendingAssert(msg) {
  console.log(`PEND: ${msg}`)
  tally.pending++
}

export function note(msg) {
  console.log(`NOTE: ${msg}`)
}

export function tallySnapshot() {
  return { ...tally }
}

export async function run(name, fn) {
  console.log(`\n--- ${name} ---`)
  const started = Date.now()
  try {
    await fn()
  } catch (err) {
    assert(false, `${name} threw: ${String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err)}`)
  }
  await checkWatchers()
  console.log(`--- ${name}: ${Date.now() - started}ms ---`)
}

export function finish() {
  const { pass, fail, pending } = tally
  console.log('')
  if (fail > 0) {
    console.log('failed assertions:')
    for (const f of failureDetail) console.log(`  - ${f}`)
  }
  console.log(`RESULT: ${pass} passed, ${fail} failed, ${pending} pending`)
  process.exit(fail === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Console, page error and network watching
// ---------------------------------------------------------------------------

/**
 * The one ignore rule in the suite, and it is stated rather than hidden.
 * Chromium requests /favicon.ico unprompted and the dev server has none, so that
 * single 404 is not a product fact. Every other console error, page error,
 * failed request and 4xx/5xx response fails the test it happened in.
 */
export const DEFAULT_IGNORE = [/\/favicon\.ico(\?|$)/]

const watchers = new Set()

export function watchPage(page, { ignore = [], label = 'page' } = {}) {
  const rules = [...DEFAULT_IGNORE, ...ignore]
  const problems = []
  const ignored = []
  const responses = []

  const record = (kind, text) => {
    if (rules.some((rx) => rx.test(text))) { ignored.push(`${kind}: ${text}`); return }
    problems.push({ kind, text })
  }

  page.on('console', (msg) => {
    if (msg.type() === 'error') record('console.error', msg.text())
  })
  page.on('pageerror', (err) => {
    record('pageerror', String(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : err))
  })
  page.on('requestfailed', (req) => {
    const failure = req.failure()
    record('requestfailed', `${req.method()} ${req.url()} :: ${failure ? failure.errorText : 'unknown'}`)
  })
  page.on('response', (res) => {
    responses.push({ url: res.url(), status: res.status() })
    if (res.status() >= 400) record(`http ${res.status()}`, `${res.request().method()} ${res.url()}`)
  })

  // Unhandled rejections do not always reach `pageerror`, so they are captured in
  // the page and drained on check. A promise nobody awaited is exactly the silent
  // failure this collector exists for.
  const initScript = page.addInitScript(() => {
    window.__e2eUnhandled = window.__e2eUnhandled || []
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason
      window.__e2eUnhandled.push(String((reason && (reason.stack || reason.message)) || reason))
    })
  })

  const watcher = {
    label,
    problems,
    ignored,
    responses,
    reported: 0,
    async drain() {
      try {
        const found = await page.evaluate(() => {
          const list = window.__e2eUnhandled || []
          window.__e2eUnhandled = []
          return list
        })
        for (const text of found) record('unhandledrejection', text)
      } catch {
        // The page is closed or navigating. Nothing to drain.
      }
    },
    responsesMatching(pattern) {
      return responses.filter((r) => pattern.test(r.url))
    },
    async assertClean(context = label) {
      await watcher.drain()
      const fresh = problems.slice(watcher.reported)
      watcher.reported = problems.length
      for (const p of fresh) console.log(`    ${p.kind}: ${p.text}`)
      assert(fresh.length === 0, `no console errors, page errors, failed requests or 4xx/5xx on ${context} (${fresh.length} found)`)
      if (ignored.length) note(`ignored by DEFAULT_IGNORE on ${context}: ${ignored.length} (${ignored[0]})`)
    },
  }

  watchers.add(watcher)
  void initScript
  return watcher
}

/** Called automatically at the end of every `run()` block. */
async function checkWatchers() {
  for (const watcher of watchers) {
    await watcher.drain()
    const fresh = watcher.problems.slice(watcher.reported)
    if (fresh.length === 0) continue
    watcher.reported = watcher.problems.length
    for (const p of fresh) console.log(`    ${p.kind}: ${p.text}`)
    assert(false, `${watcher.label} logged ${fresh.length} console error(s) / page error(s) / failed request(s)`)
  }
}

export function forgetWatchers() {
  watchers.clear()
}

// ---------------------------------------------------------------------------
// Small page helpers
// ---------------------------------------------------------------------------

export async function openPage(browser, deviceProfile, { ignore = [] } = {}) {
  const { name, ...contextOptions } = deviceProfile
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  const watcher = watchPage(page, { ignore, label: name || 'page' })
  return { context, page, watcher }
}

/** Presence probe that never throws, for pending gates and adaptive assertions. */
export async function isVisible(page, selector, timeout = 1500) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

export async function exists(page, selector, timeout = 1500) {
  try {
    await page.waitForSelector(selector, { state: 'attached', timeout })
    return true
  } catch {
    return false
  }
}

/**
 * The pending gate. A spec whose surface does not exist yet prints its plan as
 * SKIP lines and exits zero, and it also probes the anchor selectors so the skip
 * message states a checked fact rather than a stale assumption. If an anchor has
 * landed while the spec is still marked pending, that is reported loudly: QA is
 * meant to be in step with the code, not behind it.
 */
export async function reportPending({ specName, reason, anchors = [], url = '/', plan = [], browser = null }) {
  console.log('')
  console.log(`pending: ${specName}: ${reason}`)

  let probed = null
  if (browser) {
    try {
      const { context, page } = await openPage(browser, DESKTOP)
      await page.goto(`${BASE_URL}${url}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      probed = []
      for (const anchor of anchors) {
        probed.push({ anchor, present: await exists(page, anchor, 1200) })
      }
      await context.close()
      forgetWatchers()
    } catch (err) {
      note(`anchor probe skipped: ${String(err.message).split('\n')[0]}`)
    }
  }

  if (probed) {
    const present = probed.filter((p) => p.present)
    const missing = probed.filter((p) => !p.present)
    console.log(`  anchors probed at ${url}: ${present.length} present, ${missing.length} missing`)
    for (const m of missing) console.log(`    missing: ${m.anchor}`)
    if (present.length > 0) {
      for (const p of present) console.log(`    present: ${p.anchor}`)
      note(`${present.length} anchor(s) have landed. Set PENDING = false in this spec and re-run: the assertions are already written.`)
    }
  }

  console.log('  planned assertions, none of them run yet:')
  for (const step of plan) console.log(`  SKIP: ${step}`)
  tally.pending += plan.length
}
