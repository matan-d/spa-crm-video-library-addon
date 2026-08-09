/**
 * Runs every e2e spec in one go, which is what `npm run test:e2e` promised and
 * could not do: the script was referenced in `package.json` and never written,
 * so the documented command failed immediately while the individual specs
 * passed. A gate nobody can run is not a gate.
 *
 * Order matters and is not alphabetical. The cheap structural runs come first,
 * so a broken shell fails in seconds rather than after several minutes of media
 * decoding, and the runs that generate clips with ffmpeg come last.
 *
 * Each spec runs as its own process, deliberately:
 *   - a spec calls `process.exit` through `finish()`, so importing them into one
 *     process would end the whole batch at the first `finish()`
 *   - a leaked browser or server in one spec cannot poison the next
 *   - the per spec RESULT lines stay readable, and the totals below are a sum of
 *     real numbers rather than a re-count
 *
 * The dev server is started once here and reused by every child, because
 * `startServer()` reuses a server it recognises on the port. Fifteen seconds of
 * vite startup per spec is worth removing; the isolation that matters is between
 * browser contexts, and each spec still makes its own.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startServer, stopServer } from './_support/harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const SPECS = [
  // Structural, fast, and the one that must always pass.
  'boot.e2e.mjs',
  // Role surfaces over the seeded data.
  'editor.e2e.mjs',
  'manager.e2e.mjs',
  // The outbox and the loopback round trip. Cheap, and it depends on the
  // manager surface it edits through, so it sits after it.
  'sync.e2e.mjs',
  // Then the runs that decode media and generate clips.
  'decode.e2e.mjs',
  'ai.e2e.mjs',
  'creator.e2e.mjs',
  // Last, and the one that matters most: it depends on every surface above
  // working, so running it first would only ever report someone else's failure.
  'loop.e2e.mjs',
]

function runSpec(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(HERE, file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let output = ''
    const capture = (chunk) => {
      const text = String(chunk)
      output += text
      process.stdout.write(text)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    child.on('close', (code) => {
      // The RESULT line is the spec's own tally, so the summary below never
      // recounts assertions and never disagrees with the spec that printed them.
      const match = /RESULT: (\d+) passed, (\d+) failed, (\d+) pending/.exec(output)
      resolve({
        file,
        code,
        elapsedMs: Date.now() - started,
        passed: match ? Number(match[1]) : 0,
        failed: match ? Number(match[2]) : 0,
        pending: match ? Number(match[3]) : 0,
        sawResult: !!match,
      })
    })
  })
}

const server = await startServer()
const results = []

try {
  for (const spec of SPECS) {
    process.stdout.write(`\n${'='.repeat(72)}\n== ${spec}\n${'='.repeat(72)}\n`)
    results.push(await runSpec(spec))
  }
} finally {
  if (!server.reused) await stopServer()
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const totals = results.reduce(
  (sum, result) => ({
    passed: sum.passed + result.passed,
    failed: sum.failed + result.failed,
    pending: sum.pending + result.pending,
  }),
  { passed: 0, failed: 0, pending: 0 },
)

process.stdout.write(`\n${'='.repeat(72)}\n== e2e summary\n${'='.repeat(72)}\n`)
for (const result of results) {
  const status = result.code === 0 && result.sawResult ? 'ok  ' : 'FAIL'
  const seconds = (result.elapsedMs / 1000).toFixed(1)
  process.stdout.write(
    `${status} ${result.file.padEnd(22)} ${String(result.passed).padStart(4)} passed  ` +
      `${String(result.failed).padStart(3)} failed  ${String(result.pending).padStart(3)} pending  ${seconds}s\n`,
  )
  if (!result.sawResult) {
    // A spec that never printed a RESULT crashed before finishing, and reporting
    // its zeroes as a pass would be the batch lying about coverage.
    process.stdout.write(`     ^ this spec produced no RESULT line, so it did not complete\n`)
  }
}

const brokenSpecs = results.filter((result) => !result.sawResult || result.code !== 0)
process.stdout.write(
  `\nTOTAL: ${totals.passed} passed, ${totals.failed} failed, ${totals.pending} pending, ` +
    `across ${results.length} spec(s)\n`,
)

process.exit(brokenSpecs.length === 0 ? 0 : 1)
