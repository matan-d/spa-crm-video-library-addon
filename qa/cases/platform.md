# QA cases: platform matrix

Format from `docs/AGENTS.md`: Given / When / Then / Layer / Blocked-by.
Owner: `platform-matrix`.
Implemented by: `qa-runner`, except cases marked `manual-only`, which move to `qa/manual-checklist.md` with the human steps written out.

## How to read these

Every case here is about **where code runs and how it fails there**, never about whether a derived fact is correct.
A case that asserts a duration, a rotation or a hash belongs in `qa/cases/media.md`.

Each case names the finding it closes, `P-n`, from the "Defects and gaps" section of `docs/platform-matrix.md`, or from section 5 of `docs/09-shell-notes.md` for P-13 and above.
A case with no `P-n` is a regression guard for behaviour that is already correct and easy to break.

Reuse the existing harness rather than adding another one:

- `tests/platform/capability.spec.ts` already has a `desktop()` `ProbeEnvironment` builder. Extend it with `webkitPre26()`, `webkitCurrent()`, `androidPhone()` and `shellRenderer()` shapes rather than inlining literals per case.
- `tests/platform/bytes.spec.ts` already has an in-memory OPFS fake and a `readText` helper. jsdom has no OPFS, no WebCodecs and no video decode, so every OPFS case is a fake-directory case.
- Anything requiring a real decoder, a real quota, a real notch or a real shell is `manual-only` by construction, and says so.

`Blocked-by: none` means runnable today.
`Blocked-by: probe field` means the case is correct and cannot pass until the named field exists, which is the point of writing it now.

---

## Group 0: the probe reports capability, never a device

### QC-PLAT-001 No decision anywhere reads a user agent
- Given: the whole `src/` tree
- When: it is searched for `userAgent`, `platform`, `vendor`, `maxTouchPoints`, and the strings `iPhone`, `iPad`, `Android`, `Safari`, `Chrome` used as a conditional
- Then: there are zero matches outside comments and outside `docs/`. `src/platform/browser/environment.ts` is allowed to read platform globals and is not allowed to read a user agent, so it must not match either
- Layer: unit (a lint-shaped test over the source, the same shape as the existing determinism ban)
- Blocked-by: none

### QC-PLAT-002 The engine hint cannot become a decision
- Given: `report.engineHint`
- When: the tree is searched for reads of `engineHint`
- Then: the only readers are diagnostics or display code. No conditional in `src/media/**`, `src/data/**` or `src/app/**` branches on its value
- Layer: unit
- Blocked-by: none

### QC-PLAT-003 A hostile environment cannot take the probe down
- Given: a `ProbeEnvironment` where every getter throws, `decodingInfo` rejects, and `canPlayType` throws
- When: `probeCapabilities()` runs
- Then: it resolves, every codec is `unknown`, `extractor` is `none`, and `warnings` is non empty. It never rejects
- Layer: unit
- Blocked-by: none (partly covered by the existing "never throws, whatever the environment does" test, extend it to cover `canPlayType` throwing)

---

## Group 1: OPFS presence versus OPFS writability (P-1, P-11)

### QC-PLAT-004 OPFS that cannot be written is not reported as available storage
- Given: a `ProbeEnvironment` shaped like Safari 18: `hasOpfs: true`, and the new `hasOpfsWritable: false`
- When: `probeCapabilities()` runs
- Then: `report.storage.opfs` is `false`, a warning names that OPFS exists but cannot be written by this runtime and that originals will not be kept on this device, and a separate diagnostics field still records that the OPFS root was present
- Layer: unit
- Blocked-by: probe field (`hasOpfsWritable` does not exist yet; this is P-1's fix)

### QC-PLAT-005 A byte store built on a handle with no createWritable refuses by name
- Given: the in-memory OPFS fake from `tests/platform/bytes.spec.ts`, modified so `getFileHandle()` resolves a handle whose `createWritable` is `undefined`
- When: `put('asset/x', blob)` is called
- Then: it rejects with `Unsupported`, `reason` is a storage reason code, and the message names the runtime limitation. It must not reject with a `TypeError`
- Layer: unit
- Blocked-by: none (the assertion is that we do not currently do this, so it fails first, which is correct)

### QC-PLAT-006 A platform built without writable OPFS still boots and still serves records
- Given: `createBrowserPlatform()` with a report whose `storage.opfs` is `false`
- When: `boot()` completes and the library view renders the seeded posters
- Then: boot succeeds, `port.bytes` is the refusing store, every poster and sheet still renders from IndexedDB, and no unhandled rejection is logged
- Layer: integration
- Blocked-by: none

### QC-PLAT-007 An OPFS root that rejects for any reason degrades instead of failing boot
- Given: a platform factory where `navigator.storage.getDirectory()` exists and rejects with a `SecurityError`, which is the shape of a private browsing session
- When: `createBrowserPlatform()` runs
- Then: it resolves, `port.bytes` is the refusing store, and a warning names that local byte storage could not be opened and why. It must not reject
- Layer: unit
- Blocked-by: none (closes P-11)

### QC-PLAT-008 A half written original never looks like a whole one
- Given: the OPFS fake with a writable whose second `write()` throws
- When: `put()` streams a two chunk source
- Then: `put()` rejects, `has(key)` is `false`, and `list()` does not contain the key
- Layer: unit
- Blocked-by: none (regression guard for behaviour already correct at `src/platform/browser/bytes.ts:84`)

---

## Group 2: codec probing (P-2)

### QC-PLAT-009 An authoritative denial is never overridden by a weaker positive
- Given: a `ProbeEnvironment` where `decodingInfo` resolves `{ supported: false }` for both HEVC queries and `canPlayType` returns `'probably'` for both
- When: `probeCapabilities()` runs
- Then: `report.codecs.hevc.decode` is `unknown`, never `yes`, and a warning records that the two detection APIs disagreed and names both answers
- Layer: unit
- Blocked-by: none (this case fails today and closes P-2)

### QC-PLAT-010 Agreement on a denial is still a denial
- Given: `decodingInfo` resolves `{ supported: false }` for both HEVC queries and `canPlayType` returns `''`
- When: `probeCapabilities()` runs
- Then: `report.codecs.hevc.decode` is `no` and no disagreement warning is pushed
- Layer: unit
- Blocked-by: none (guards the existing behaviour while QC-PLAT-009 changes the neighbouring branch)

### QC-PLAT-011 A rejection is not evidence of absence
- Given: `decodingInfo` rejects with a `TypeError` for every query and `canPlayType` returns `'probably'`
- When: `probeCapabilities()` runs
- Then: the codec is `yes`, because a rejection means the engine disliked the configuration and not that the codec is unsupported
- Layer: unit
- Blocked-by: none (already covered, keep it, because QC-PLAT-009's fix must not break it)

### QC-PLAT-012 Both HEVC fourccs are asked
- Given: a `decodingInfo` spy that records every `contentType` it is asked about
- When: `probeCapabilities()` runs
- Then: the recorded queries include both `hvc1` and `hev1`, because iPhone footage is tagged `hvc1` and asking only `hev1` would report a false negative on the base case
- Layer: unit
- Blocked-by: none

### QC-PLAT-013 A denied codec is refused before any decode is attempted
- Given: `public/fixtures/hevc.mov` and a report whose `codecs.hevc.decode` is `no`
- When: `extractFrames()` runs against an `ExtractionHost` whose adapters record every call
- Then: no adapter is called, the result has `path: 'placeholder'`, `reason: 'decode_unsupported'`, `sheet` and `poster` are null, and the placeholder headline names HEVC and the browser
- Layer: integration
- Blocked-by: none

### QC-PLAT-014 An unknown codec is attempted under the blank frame guard
- Given: the same fixture and a report whose `codecs.hevc.decode` is `unknown`
- When: `extractFrames()` runs against a host whose adapter returns frames that are entirely one colour
- Then: an adapter is called, every frame is dropped as blank, the result is a placeholder with `reason: 'blank_frame'`, no sheet blob is produced, and no frame rows are returned
- Layer: integration
- Blocked-by: none

---

## Group 3: shell identity and document origin (P-3, P-5)

### QC-PLAT-015 The shell is identified from an exposed bridge value
- Given: a `globalThis` with no `process`, and a namespaced object exposed the way `contextBridge` exposes one, declaring an Electron shell
- When: `detectShell()` runs
- Then: it returns `'electron'`
- Layer: unit
- Blocked-by: none (implemented 2026-08-09: `detectShell()` reads `globalThis.__shell__.id` first, validated against the four `ShellId` values. The contract for the preload side is `docs/09-shell-notes.md` 5.1)

### QC-PLAT-016 A default secure Electron renderer is not mistaken for a browser
- Given: a `ProbeEnvironment` with `shell: 'browser'` and `loadScheme: 'capacitor-electron:'`, which is what a renderer looks like under `contextIsolation: true` with no preload edit
- When: `probeCapabilities()` runs
- Then: `report.shell` is `'browser'`, and a warning says the origin scheme claims a shell while no shell identified itself, naming the scheme. The warning is what makes P-3 observable on first launch rather than silent
- Layer: unit
- Blocked-by: none
- Amended 2026-08-09: originally written as a `detectShell()` case asserting a warning. `detectShell()` returns a `ShellId` and emits nothing, and a bare "no shell identity" warning would fire in every ordinary browser tab, which is noise rather than signal. The detector that carries information is the contradiction between the scheme and the identity, so the assertion moved to `probeCapabilities()` and is implemented in `warnOnOrigin()`

### QC-PLAT-017 Capacitor is identified without a user agent
- Given: a `globalThis` carrying a `Capacitor` object whose `getPlatform()` returns `'ios'` and `isNativePlatform()` returns `true`
- When: `detectShell()` runs
- Then: it returns `'capacitor-ios'`, and the same environment with `isNativePlatform()` false returns `'browser'`
- Layer: unit
- Blocked-by: none (regression guard)

### QC-PLAT-018 A non http origin is warned about by name
- Given: `ProbeEnvironment` variants with `loadScheme` of `capacitor:`, `capacitor-electron:`, `file:`, `unknown` and `https:`
- When: `probeCapabilities()` runs on each
- Then: the first two each produce a warning naming the scheme and saying that storage in this origin is separate and that a snapshot import is how records come across, `file:` keeps its existing opaque origin warning, `unknown` says the origin could not be read, and `https:` produces none
- Layer: unit
- Blocked-by: none (closes P-5, implemented in `warnOnOrigin()`, `src/platform/capability.ts`)

---

## Group 4: the tier, and what it rests on (P-4, P-7)

### QC-PLAT-019 A clamped core count does not promote a phone
- Given: a WebKit shaped environment: `hardwareConcurrency: 8` because Safari clamps it, `deviceMemoryGb: null` because WebKit has no `deviceMemory`, `pointerCoarse: true`
- When: `scoreTier()` and `tierFromScore()` run
- Then: the tier is not `ample`, and `tierInputs` records all three component scores so the reason is inspectable afterwards
- Layer: unit
- Blocked-by: none

### QC-PLAT-020 A capable tablet and a weak phone are distinguishable by something other than pointer type
- Given: two WebKit shaped environments identical except for a measured benchmark input, one fast and one slow
- When: the tier is derived
- Then: the two environments resolve to different tiers, and `tierInputs` names the measured signal
- Layer: unit
- Blocked-by: probe field (no measured signal exists; this is P-4's fix, and until it lands this case documents the gap rather than passing)

### QC-PLAT-021 The documented `deviceMemory` value sets map to sensible tiers
- Given: the values Chromium actually reports, {2, 4, 8, 16, 32} on desktop and {1, 2, 4, 8} on Android
- When: each is scored
- Then: every value produces a score in range, 8 and above is the top band, and no value produces the same score as absence except 4, which is the middle by design
- Layer: unit
- Blocked-by: none

### QC-PLAT-022 The local byte budget is clamped by the reported quota
- Given: a report at `ample` tier and a quota report with 3 GB of headroom
- When: `deriveIngestPolicy()` runs with the quota as a hint
- Then: `maxLocalOriginalBytes` is below the reported headroom rather than the tier's 2 GB default when headroom is smaller, and the clamp is recorded in `policy.downgrades`
- Layer: unit
- Blocked-by: policy change (`deriveIngestPolicy()` takes no quota hint yet; this is P-7's fix)

### QC-PLAT-023 A mid batch downgrade never becomes an upgrade
- Given: a policy at `standard`
- When: `downgradePolicy()` is asked to move to `ample`
- Then: the policy is returned unchanged, because neighbouring sheets in one delivery must stay comparable
- Layer: unit
- Blocked-by: none (already covered, listed so the platform reason for the rule is recorded here too)

---

## Group 5: degradation the user can actually see (P-6, P-10)

### QC-PLAT-024 Every probe warning reaches a surface
- Given: a booted app whose report carries warnings for no extractor, no OPFS, a non http scheme and no storage estimate
- When: the storage panel renders
- Then: each warning text appears in the DOM, under a stable testid, and the panel also shows `shell`, `extractor` and the four codec answers as data attributes
- Layer: e2e
- Blocked-by: none (closes P-10; needs a testid added to `e2e/_support/testids.mjs`)

### QC-PLAT-025 "Not persisted" carries an action
- Given: a runtime where `persisted()` resolves false
- When: the storage panel renders
- Then: the persisted row reads `no`, one sentence states that the browser has not protected this data, and one control is present that either requests persistence or exports a snapshot. A bare `no` with no action fails this case
- Layer: e2e
- Blocked-by: none (closes half of P-6)

### QC-PLAT-026 Persistence is requested once, from a real interaction
- Given: a spy on `QuotaMonitor.requestPersistence`
- When: the first meaningful interaction happens in a session
- Then: it is called exactly once, its boolean result is recorded, and it is not called again on a second interaction in the same session
- Layer: integration
- Blocked-by: none (closes the other half of P-6)

### QC-PLAT-027 A quota overrun names what could not be saved
- Given: a blob store whose `put()` rejects with a `DOMException` named `QuotaExceededError`
- When: a sheet write is attempted
- Then: the failure surfaces as a named state that says what could not be saved and offers export or delete oldest, and no record is left claiming the artefact exists
- Layer: integration
- Blocked-by: none

### QC-PLAT-028 An evicted origin is detected rather than presented as an empty app
- Given: `localStorage` says the app was previously initialised and the database has no sentinel record
- When: `boot()` runs
- Then: a "data may have been cleared" state is returned in the boot result, naming browser storage cleanup as the reason and offering to reload demo data
- Layer: integration
- Blocked-by: sentinel record (the sentinel does not exist yet; the case is the specification)

---

## Group 6: input and interaction

### QC-PLAT-029 A folder affordance is never bound to API presence
- Given: an environment with `hasDirectoryDrop: true` and `pointerCoarse: true`, which is what a phone reports
- When: the upload surface renders
- Then: no copy inviting a folder drop is present, the file picker button is present, and `picker.supportsFolders()` still returns true so a drop that does arrive is still walked
- Layer: e2e
- Blocked-by: creator upload surface (closes P-8, and must land with that surface)

### QC-PLAT-030 A dropped directory is drained past the hundredth entry
- Given: a fake `DataTransfer` whose directory reader returns 100 entries, then 100 more, then an empty batch
- When: `fromDrop()` runs
- Then: 200 files are returned, which is the assertion that `readEntries` was called in a loop rather than once
- Layer: unit
- Blocked-by: none (regression guard for `src/platform/browser/runtime.ts:278`)

### QC-PLAT-031 Camera card noise is reported, not failed
- Given: a fake drop containing a clip, a `.THM`, a `.XMP`, a `.DS_Store`, and a file under a `proxy/` path
- When: `fromDrop()` runs
- Then: one file is returned and four names appear in `ignored`, so the creator sees one clip rather than five pre-flight failures
- Layer: unit
- Blocked-by: none

### QC-PLAT-032 Every keyboard action has a visible control
- Given: any surface that binds a single key accelerator
- When: the surface renders with a coarse pointer and no keyboard assumption
- Then: every action reachable by a key is also reachable by a visible control, and no action is keyboard only. Shortcuts are scoped to a focused region, never bound to `document`
- Layer: e2e
- Blocked-by: review queue surface (there is no keyboard surface yet; the case is written so it lands with one)

### QC-PLAT-033 Keyboard affordances are not gated on pointer type
- Given: an environment reporting `pointerCoarse: true`
- When: a surface with shortcuts renders
- Then: the shortcut hints and the shortcut sheet are still reachable, because an iPad with a keyboard is a coarse pointer with real keys
- Layer: e2e
- Blocked-by: review queue surface

### QC-PLAT-034 A copy button survives a clipboard rejection
- Given: a `navigator.clipboard.writeText` that rejects
- When: the diagnostics copy control is used
- Then: the diagnostics text is shown in a selectable field with a message saying it could not be copied automatically. The control never fails silently
- Layer: e2e
- Blocked-by: diagnostics surface

### QC-PLAT-035 Dynamic viewport units have a fallback and bottom anchors have safe area padding
- Given: the built CSS
- When: it is searched for `dvh` and for bottom anchored containers
- Then: every `dvh` declaration is preceded by a `vh` declaration for the same property, and every position-fixed or sticky bottom container includes `env(safe-area-inset-bottom)` in its padding
- Layer: unit (a stylesheet assertion, the same shape as the boolean index test)
- Blocked-by: none for the `vh` half, sticky surfaces for the safe area half (closes P-9)

---

## Group 7: coordination across tabs (P-12)

### QC-PLAT-036 Two tabs of one profile do not drain the outbox twice
- Given: two clients over one fake database, with `webLocks: true`
- When: both drain the outbox at the same time
- Then: each entry is processed exactly once
- Layer: integration
- Blocked-by: outbox consumer (closes P-12)

### QC-PLAT-037 With no Web Locks, the second tab refuses visibly
- Given: the same two clients with `coordination.webLocks: false` and `broadcastChannel: false`
- When: both drain
- Then: one proceeds and the other returns a named refusal that a surface can render as "another tab is syncing", rather than both racing
- Layer: integration
- Blocked-by: outbox consumer

---

## Group 8: lifecycle and transfer

### QC-PLAT-038 An interrupted batch is resumable rather than restarted
- Given: a batch of five files where the third is in flight
- When: a `pagehide` is dispatched
- Then: per file results for the first two are already persisted, the batch is marked interrupted, and a resume returns to file three rather than to file one
- Layer: integration
- Blocked-by: ingest batch runner

### QC-PLAT-039 The batch loop is not driven by a timer
- Given: the ingest batch runner
- When: its source is inspected
- Then: no `setInterval` drives progression, and the next file starts from the completion of the previous one, because a hidden tab throttles timers
- Layer: unit
- Blocked-by: ingest batch runner

### QC-PLAT-040 A large original download does not need the whole file in memory where a streaming path exists
- Given: a report with `storage.fileSystemAccess: true` and one with `false`
- When: the download action is invoked for an original
- Then: the first streams to a chosen path, the second materialises a Blob and warns about the size above a threshold. The two paths are distinguishable and both are named
- Layer: integration
- Blocked-by: editor download action

---

## Group 9: manual only, one per unverifiable target

Each of these is `manual-only` because the runtime does not exist on this machine.
They belong in `qa/manual-checklist.md` with these steps, so the gap is written down rather than implied.

### QC-PLAT-041 iPhone Safari, one real clip end to end
- Given: a real iPhone on iOS 18 or later, the deployed creator link, and one HEVC clip and one H.264 clip from the camera roll
- When: a human opens the link, picks both clips, and lets pre-flight run to completion
- Then: the H.264 clip produces a contact sheet, the HEVC clip produces a named refusal or a sheet depending on what the probe reported, no file sits at "analysing" forever, and the copied diagnostics blob contains the codec answers, the extractor, and a reason code per file
- Layer: manual-only
- Blocked-by: needs a real iPhone. Human steps: open the link, choose two clips from the camera roll, wait for both verdicts, tap the diagnostics copy control, paste the result into the checklist. Record the iOS version, whether Low Power Mode was on, and the elapsed time per file

### QC-PLAT-042 Safari before 26, the OPFS write path
- Given: a device on macOS Safari 18 or iOS 18, which has OPFS and no `createWritable`
- When: a human retains an original locally
- Then: the app states that originals cannot be kept on this device and continues to work from posters and sheets. A `TypeError` in the console, or a spinner that never resolves, fails this case
- Layer: manual-only
- Blocked-by: needs a Safari older than 26. Human steps: check the Safari version first and record it, retain one clip, then reopen the storage panel and read the warning list. This is the observable that confirms P-1's fix

### QC-PLAT-043 Safari's seven day eviction
- Given: a Safari browser with cross site tracking prevention on, and a seeded library
- When: a human does not open the app for eight days and then opens it
- Then: either the data is present, or the "data may have been cleared" state appears with browser storage cleanup named as the reason. An empty library with no explanation fails this case
- Layer: manual-only
- Blocked-by: needs eight days of real time. Human steps: note the date of the last visit, do not open the app, return after eight days, screenshot whatever appears

### QC-PLAT-044 The packaged desktop shell identifies itself
- Given: a built Electron shell, which has never been built
- When: a human launches it and opens the storage panel
- Then: it reads `electron`, not `browser`, and the codec row shows whether HEVC decode answered yes on that machine
- Layer: manual-only
- Blocked-by: the shell is designed and configured only, never built or run. Human steps: build the shell, launch it, read the storage panel, then copy the diagnostics blob and record the Electron and Chromium versions. This is the first launch check for P-3

### QC-PLAT-045 The desktop shell's secret custody degrades honestly on Linux
- Given: the built shell on a Linux box with no keyring available
- When: `safeStorage.isEncryptionAvailable()` and `getSelectedStorageBackend()` are read at startup
- Then: the app reports that secure storage is unavailable rather than claiming a key is protected, because the documented fallback encrypts with a hardcoded plaintext password
- Layer: manual-only
- Blocked-by: the shell has never been built, and this needs a Linux machine with no secret store. Human steps: launch on a bare Linux profile, read the reported secret mode, confirm it is not presented as secure

### QC-PLAT-046 A Capacitor shell is a separate storage origin and says so
- Given: a Capacitor iOS or Android build, which has never been built
- When: a human installs it after using the browser build on the same device
- Then: the library is empty and the app says why, naming the separate storage origin and offering to import a snapshot. A silent empty library fails this case
- Layer: manual-only
- Blocked-by: no native build exists. Human steps: use the browser build first and add one clip, then install the shell, launch it, and record whether the empty state explains itself. Expect the Android half to fail until P-16 is closed, because that shell's scheme is `https:` and the current warning is scheme shaped

### QC-PLAT-047 A Capacitor iOS build against the fifteen percent allowance
- Given: a Capacitor iOS build on a device with a small amount of free disk
- When: `storage.estimate()` is read at startup and a large retention is attempted
- Then: the reported quota is materially smaller than the same device's mobile Safari figure, and the retention is refused before it is attempted rather than failing mid write
- Layer: manual-only
- Blocked-by: no native build exists, and the assertion needs both the shell and mobile Safari on one device. Human steps: read and record the quota in mobile Safari, install the shell, read and record it there, compare, then attempt a retention larger than the shell's headroom

### QC-PLAT-048 A mid range Android device, the jank check
- Given: a real Android phone that is not a current flagship, and a batch of ten clips
- When: a human runs pre-flight on the batch
- Then: the tier reported in the storage panel matches the device class, the interface stays responsive enough to show per file progress, and the recorded per file timings are present in the diagnostics blob
- Layer: manual-only
- Blocked-by: needs a real Android device. Human steps: record the device model, the Android System WebView version from the Play Store listing, and the reported tier, then run the batch and copy the diagnostics

---

## Group 10: the shell configuration (P-13 to P-16)

Added 2026-08-09 with `capacitor.config.ts` and `docs/09-shell-notes.md`.
The first four are runnable today and are about our own files rather than about a device, which is the only part of a shell that can be tested from here.

### QC-PLAT-049 The Android WebView floor is never below the floor our own bundle needs
- Given: `capacitor.config.ts` and `vite.config.ts`, plus the Vite major in `package.json`
- When: a test reads `android.minWebViewVersion` from the config and compares it against the Chromium version implied by the effective Vite `build.target`, which is `baseline-widely-available` (Chrome 107 on Vite 6, Chrome 111 on Vite 7) unless `vite.config.ts` sets `build.target` explicitly
- Then: `minWebViewVersion` is greater than or equal to that Chromium version. Capacitor's own default of 60 fails this, which is the point: below the bundle's floor the app is a white screen rather than a refusal
- Layer: unit
- Blocked-by: none. **Read both files as text, never `import` them.** `capacitor.config.ts` imports a type from `@capacitor/cli`, which is deliberately not installed, so importing it from a test inside `tests/` would pull an unresolvable module into the typecheck program and break a gate that must stay honest about shells

### QC-PLAT-050 The configured error page exists in the build output
- Given: `server.errorPath` in `capacitor.config.ts`
- When: a test resolves that path against `public/` and against `dist/` after a build
- Then: the file exists in both. An `errorPath` pointing at nothing turns the one visible failure state the Android shell has back into a blank view
- Layer: unit
- Blocked-by: none for the `public/` half. The `dist/` half needs a build to have run, so assert `public/` and leave a comment naming the build dependency

### QC-PLAT-051 The error page depends on nothing that could also be broken
- Given: `public/unsupported-webview.html`
- When: it is parsed as text
- Then: it contains no `<script>`, no `src=` or `href=` pointing outside itself, and no reference to a hashed asset. It is reached precisely when the WebView cannot run our bundle, and Capacitor documents that it has no plugin access on Android, so anything it loads is a second thing that can fail
- Layer: unit
- Blocked-by: none

### QC-PLAT-052 A shell scheme with no shell identity is reported as a contradiction
- Given: `ProbeEnvironment` pairs: (`capacitor-electron:`, `shell: 'browser'`), (`capacitor-electron:`, `shell: 'electron'`), (`https:`, `shell: 'browser'`)
- When: `probeCapabilities()` runs on each
- Then: only the first produces the contradiction warning, and it names the scheme. The second gets the separate origin warning alone, and the third gets nothing
- Layer: unit
- Blocked-by: none (this is the first launch observable for P-3, implemented in `warnOnOrigin()`)

### QC-PLAT-053 An origin change is detected by origin, not by scheme
- Given: a profile whose sentinel record was written under `https://example.netlify.app` and a runtime whose origin is `https://localhost`
- When: `boot()` runs
- Then: the mismatch is reported and the empty library is explained as a separate storage origin with a snapshot import offered. Asserting on the scheme alone cannot catch this, because both are `https:`
- Layer: integration
- Blocked-by: sentinel record (closes P-16, and it lands with P-6's sentinel rather than as its own mechanism)

### QC-PLAT-054 The desktop shell's scheme is a secure context
- Given: a built Electron shell, which has never been built
- When: a human launches it and reads `storage.opfs` in the storage panel
- Then: it is true. False means the custom scheme was not registered as standard and secure, so the one target with a real filesystem becomes the only target that cannot keep an original
- Layer: manual-only
- Blocked-by: no shell has been built, and the scheme privileges live in generated code (`electron/src/setup.ts`) that this repository does not contain. Human steps: launch, read the storage panel, and if `storage.opfs` is false open `electron/src/setup.ts` and look for `registerSchemesAsPrivileged` with `standard: true` and `secure: true`

### QC-PLAT-055 Capacitor iOS storage survives, or says that it did not
- Given: a Capacitor iOS build on a device driven close to full
- When: the OS reclaims WebView storage, then a human reopens the app
- Then: either the library is intact, or the app detects that its data went away and says so. Silent, total loss with a healthy looking app fails this case
- Layer: manual-only
- Blocked-by: no native build exists, and the trigger is an OS behaviour that cannot be invoked on demand. This is P-13, and Capacitor's own storage guide predicts the failure, so the honest expectation today is that this case fails until the sentinel and export exist. Human steps: fill the device, use the app, leave it a day, reopen, record exactly what the app says

### QC-PLAT-056 An old Android System WebView is refused visibly
- Given: an Android device or emulator whose System WebView is below the configured `minWebViewVersion`
- When: a human installs and launches the shell
- Then: the unsupported WebView page is displayed, naming Android System WebView and offering the browser as the alternative. A white screen or a Logcat only message fails this case
- Layer: manual-only
- Blocked-by: no native build exists. That `server.errorPath` is shown for this specific refusal comes from a secondary source, so this reading is what promotes it to a fact. Human steps: record the WebView version before launching, launch, screenshot, then update the WebView and launch again

### QC-PLAT-057 Android 15 edge to edge is handled once, not twice
- Given: an Android 15 device and the shell with `android.adjustMarginsForEdgeToEdge: 'auto'`
- When: a human opens a scrolling view and looks at the bottom of the screen
- Then: content clears the gesture bar. After the CSS safe area insets land (P-9) the same check must show no doubled empty space, and if it does the option moves to `disable`
- Layer: manual-only
- Blocked-by: no native build exists, and the second half also blocks on P-9. Human steps: screenshot the bottom of a scrolling view now, keep the screenshot, and compare after the CSS lands
