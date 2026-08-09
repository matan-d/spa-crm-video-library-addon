# Shell notes: the desktop and native targets

Owner: `platform-matrix`.
Companion to `capacitor.config.ts`, which is the configuration this document explains, and to `docs/platform-matrix.md`, which is the capability table this document extends.
Written 2026-08-09.

**Status, stated once and not softened anywhere below: nothing here has ever been built, synced, packaged or launched.**
No `ios/`, `android/` or `electron/` directory exists in this repository.
`@capacitor/cli` and `@capacitor-community/electron` are not installed, deliberately.
Every claim in this document comes from a dated document, from our own source tree, or is marked as an inference.
Per `docs/06-decisions.md` U4 and U6 that is the deal: designed, configured, documented, never run.

The question this file answers is the one the honesty rule implies but does not spell out: **if somebody builds one of these shells next month, what will they hit, in what order, and how will they know what they are looking at?**

## How to read this

Evidence markers follow `docs/02-caveats-review.md` and the matrix: `[V]` verified against an authoritative source, `[V-]` verified against a secondary or dated source, `[I]` my inference, never presented as fact.
Every date is 2026.

Findings continue the matrix's `P-n` series, which stops at P-12 in `docs/platform-matrix.md`.
P-13 to P-16 below are new and belong to the same series.
They are recorded here rather than appended to the matrix because they are shell findings and the matrix's defect list is about the shipped browser build; the amendment list in the next section says exactly what a matrix reader needs to know.

Two decisions were settled while writing this, and they are in section 9 rather than in `docs/06-decisions.md`.
That is not a preference: another track added a `D27` to the decisions log while this document was being written, so section 9 is written as finished decision entries ready to be transcribed as D32 and D33 by whoever next touches that file safely.

## Amendments to `docs/platform-matrix.md`, stated rather than quietly applied

Three of the matrix's statements are now out of date, and one is contradicted.
The matrix was written 2026-08-08, this document 2026-08-09.

1. **P-3 is closed in code, not just specified.**
   The matrix says `detectShell()` needs `process.versions.electron`.
   It now reads a `contextBridge` exposed identity first (`detectShell()`, `src/platform/browser/environment.ts`), with the `process` check kept only as the legacy path.
   The matrix's fix paragraph described exactly this, so the finding is implemented rather than reinterpreted.
2. **P-5 is closed in code.**
   The matrix says the probe warns only for `file:`.
   `warnOnOrigin()` in `src/platform/capability.ts` now warns for any scheme that is not `http:` or `https:`, names the scheme, says the storage origin is separate, and names snapshot export and import as the way across.
   It also emits a second warning when a shell scheme reports `shell: 'browser'`, which is the observable that catches P-3 on first launch.
3. **P-1 is closed in code for the probe half.**
   The matrix says `hasOpfs` is answered from `getDirectory` alone.
   It now requires `FileSystemFileHandle.prototype.createWritable` as well, so a Safari 18 or iOS 18 runtime reports `storage.opfs: false` and gets the refusing byte store rather than a `TypeError`.
   This matters here because it is also the WKWebView answer: see section 5.5.
4. **Contradicted: the matrix's S30 note that the desktop shell platform is a current option.**
   `@capacitor-community/electron`'s own README now states the project is unmaintained and points at the Capawesome Electron platform (`[V]` S40, checked 2026-08-09).
   That does not change any capability cell, and it does change what "configured" means for the desktop shell.
   Recorded as P-14 and decided in section 9.

## Source register for this document

Everything checked 2026-08-09 unless the row says otherwise.

| key | source | establishes |
|---|---|---|
| S36 | Capacitor docs, "Configuration" (capacitorjs.com/docs/config) | every config key, type and default used in `capacitor.config.ts`, including `server.iosScheme` `capacitor`, `server.androidScheme` `https`, `server.hostname` `localhost`, `server.errorPath`, `ios.contentInset` `never`, `android.minWebViewVersion` `60` |
| S37 | npm registry metadata for `@capacitor/cli` | current CLI major is 8 (8.5.0) |
| S38 | npm registry metadata for `@capacitor-community/electron` | latest published 5.0.1, depends on `@capacitor/cli >=5.4.0`, Electron `^26.2.2` in devDependencies |
| S39 | `@capacitor-community/electron` docs, "Config Options" | the `electron` key: `customUrlScheme` default `capacitor-electron`, `trayIconAndMenuEnabled`, `splashScreenEnabled`, `splashScreenImageName`, `hideMainWindowOnLaunch`, `deepLinkingEnabled`, `deepLinkingCustomProtocol` default `mycapacitorapp`, all default false where boolean |
| S40 | `@capacitor-community/electron` README on GitHub | "This project is currently unmaintained", recommends the Capawesome Electron platform |
| S41 | Capawesome, "Capacitor Electron Platform" docs | supports Capacitor >= 6, config lives in `electron/capacitor.electron.config.ts`, and "Sandboxed renderer, context isolation, strict Content-Security-Policy, and validated IPC" are "enabled by default and not configurable" |
| S42 | Capacitor docs, "Storage" guide | Local Storage "must be considered transient", "the OS will reclaim local storage from Web Views if a device is running low on space", and "The same can be said for IndexedDB at least on iOS (on Android, the persisted storage API is available to mark IndexedDB as persisted)" |
| S43 | ionic-team/capacitor issue 7594, "[Feature]: Persist storage (IndexedDB etc.)" | the request to make `navigator.storage.persist()` work for a Capacitor app was **closed as not planned** |
| S44 | MDN, "Storage quotas and eviction criteria" | "For WebKit-based browser apps, each origin can store up to around 60% of total disk", "For other WebKit-based apps that embed web content, each origin can store up to around 15% of total disk", the overall ceiling of 80% for browser apps and **20% for non browser apps**, the seven day no interaction deletion, and whole origin eviction |
| S45 | Vite docs, "Building for Production" plus the v7 migration note | Vite 6's default `build.target` is `baseline-widely-available`, which for this major is Chrome >= 107, Edge >= 107, Firefox >= 104, Safari >= 16. Vite 7 raises it to Chrome 111 |
| S46 | Capacitor issue 7804 and the Capacitor 7.1.0 option `android.adjustMarginsForEdgeToEdge` | Android 15 enforces edge to edge, the option takes `auto`, `force` or `disable`, and the default is `disable` `[V-]` |
| S47 | Capgo plugin documentation for WebView version checking | with `minWebViewVersion` alone an old WebView produces a Logcat message only, and `server.errorPath` is what turns it into something the user sees `[V-]` |
| S48 | Electron docs, "Context Isolation", "safeStorage" and "protocol" | `contextIsolation` default true since Electron 12, `contextBridge` as the only supported exposure route, a scheme registered as `standard` is required for resource resolution and File System API access and `secure` for a secure context, and `safeStorage.getSelectedStorageBackend()` returning `basic_text` when Linux has no keyring (the first and last reused from the matrix, checked 2026-08-08) |
| S49 | caniuse `hevc.json` and secondary Apple codec coverage | Safari and iOS Safari decode HEVC (`[V]`, 2026-08-08); HEVC is a system codec on iOS since iOS 11 with hardware decode on A9 and later (`[V-]`, 2026-08-09) |

---

## 1. What the configuration actually decides

`capacitor.config.ts` carries the reason for every non obvious value inline, so this section is only the shape of the argument, not a second copy of it.

| decision | value | why it is not the default reflex |
|---|---|---|
| web assets | `webDir: 'dist'` | the shells package the same bundle Netlify serves. There is no shell build, which is what stops three surfaces becoming three products |
| routing | hash, from `src/app/router.ts` | a custom scheme handler has no rewrite rule, so a history router would 404 on `capacitor://localhost/library` while working perfectly on Netlify. Hash routing deletes that entire class of shell only bug |
| iOS scheme | `capacitor` (default) | it cannot be `http` or `https`: WKWebView already handles those (`[V]` S36) |
| hostname | `localhost` (default) | this is what keeps the origin a secure context, which is what keeps OPFS, workers and Web Crypto alive (`[V]` S36) |
| Android WebView floor | `minWebViewVersion: 107` | Capacitor's default is 60 and our bundle cannot parse below Chrome 107 (`[V]` S45). See P-15 |
| error page | `server.errorPath: 'unsupported-webview.html'` | without it the floor above is a Logcat line (`[V-]` S47). The page is committed at `public/unsupported-webview.html`, plain HTML, no script |
| iOS content inset | `never` (default) | the safe area becomes our problem in CSS, which is also the only mechanism mobile Safari has. One implementation, two targets. See P-9 |
| Android edge to edge | `adjustMarginsForEdgeToEdge: 'auto'` | Android 15 enforces edge to edge (`[V-]` S46). This is a belt while P-9 is open, and it must move to `disable` when the CSS insets land, or the two stack |
| plugins | `includePlugins: []` | this app uses zero Capacitor plugins on purpose. Everything it needs is a web API that has to keep working in the browser build, where no plugin can exist |
| deep linking | off | the creator link is browser only forever (U5). A desktop protocol handler claiming those URLs would break the one flow with no install and no account |
| signing | absent | no keystore path, no password, nothing resembling a credential in this repository |

Two things the config **cannot** decide, and this is the most important paragraph in this section.

**Shell identity is not a config option.**
`@capacitor-community/electron` exposes neither node integration nor context isolation as configuration (`[V]` S39 by absence, and the matrix recorded the same on 2026-08-08).
Whatever the renderer can see is decided in generated project code (`electron/src/setup.ts` and `electron/src/preload.ts`), which is created by `npx cap add` and does not exist here.
So P-3 cannot be fixed from this file: it is fixed on our side of the seam, plus a preload edit that has to be made by whoever first runs the generator.
The contract for that edit is section 5.1.

**Durability is not a config option either.**
There is no Capacitor setting that makes IndexedDB survive on iOS, and the request for one was closed as not planned (`[V]` S43).
That is P-13, and it is the finding that decides whether a Capacitor iOS build should be shipped at all.

---

## 2. What would have to be true for the Electron desktop shell to work

Ordered by what fails first.

1. **A platform package that works against Capacitor 8.**
   `@capacitor-community/electron` is 5.0.1, declares `@capacitor/cli >=5.4.0`, and is unmaintained (`[V]` S38, S40).
   The CLI is 8.5.0 (`[V]` S37).
   `npx cap add @capacitor-community/electron` on a Capacitor 8 project is unverified and may simply refuse.
   This is the first thing a builder will hit, before any of our code runs. See P-14.
2. **A preload that declares the shell.**
   Without it every downstream decision is made as though this were a browser tab, including the transcode refusal that the shell exists to lift. See P-3 in section 5.1.
3. **A custom scheme registered as `standard` and `secure`.**
   Electron requires a scheme to be registered as standard for relative and absolute resource resolution and for File System API access, and as secure for a secure context (`[V]` S48).
   Whether the community platform registers `capacitor-electron:` with both privileges is `unverified`: I could not read the generated `setup.ts` from here.
   **This is the single highest value thing to check on first launch**, because if the scheme is not secure, `navigator.storage.getDirectory` is absent, the probe reports `storage.opfs: false`, and the desktop shell, the target with a real filesystem, becomes the one target that cannot keep a single original.
   The failure is at least visible: the probe warns, and the byte store refuses by name.
4. **A `ByteStore` that uses Node `fs` rather than OPFS.**
   `docs/01-architecture-review.md` B.4 and C3 already specify it: originals under `app.getPath('userData')`, or referenced in place with no copy at all.
   It does not exist. Today an Electron build would run the browser `ByteStore` and inherit Chromium's quota, which is the matrix's own correction to B.4's "no origin quota" claim.
5. **The ffmpeg derive executor**, if the shell is meant to close the HEVC hole rather than merely widen it.
   Electron >= 22 integrates Chromium's HEVC hardware decode (`[V]` matrix S26, 2026-08-08), which helps only where the hardware path exists.
   Bundled ffmpeg is a separate thing and is the part `docs/01-architecture-review.md` E.4b relies on.
6. **`safeStorage` custody with the Linux caveat honoured.**
   `getSelectedStorageBackend()` returning `basic_text` means the secret is encrypted with a hardcoded plaintext password (`[V]` S48).
   `SecretStore.mode()` must return something other than a mode that implies safety in that case, or the app tells a lie about a key.

## 3. What would have to be true for Capacitor iOS

1. **A durability story that is not IndexedDB.**
   By Capacitor's own documentation this target treats our primary datastore as transient (`[V]` S42). See P-13.
2. **P-9 closed**, or the submit and approve controls sit under the home indicator.
   `contentInset: 'never'` plus `viewport-fit=cover` in `index.html` means the insets are available and unused.
3. **OPFS writability probed rather than assumed**, which is now true (section 5.5).
4. **The gesture discipline kept even though the shell does not need it.**
   Capacitor's iOS bridge sets `mediaTypesRequiringUserActionForPlayback = []` (`[V]` matrix S31), so the highest probability iPhone only failure in the product is switched off inside the shell and switched on in Safari, where the creator lives.
   A green extraction result in the shell is therefore not evidence about Safari, and must never be recorded as if it were.
5. **A quota derived budget**, because the allowance here is roughly a quarter of the browser's. See section 5.3.

## 4. What would have to be true for Capacitor Android

1. **A System WebView at or above the bundle's floor**, which the config now enforces and explains. See P-15.
2. **Edge to edge handled once**, not twice. See P-9 and the config note.
3. **`persist()` actually requested.**
   Android is the one embedded target where Capacitor's own guide says the persisted storage API is available for IndexedDB (`[V]` S42), and P-6 records that nothing in our tree ever calls `requestPersistence()`.
   So on Android the remedy exists and we do not use it, which is a gap of ours rather than the platform's.
4. **The WebView version in the diagnostics blob**, because "works on my Pixel, fails on that Samsung" is a WebView version question and nothing else answers it.

---

## 5. What we know will break, and why

### 5.1 P-3 The `process.versions.electron` check cannot work in a correctly configured shell

- Target(s): Electron shell.
- Failure: `detectShell()` used to identify Electron by reading `globalThis.process.versions.electron`. Under `contextIsolation: true` the renderer's world has no `process`, so the check returns nothing and the probe reports `browser`.
- Trigger: any Electron build using the default and recommended configuration. Under the Capawesome platform it is not even opt out able: context isolation and a sandboxed renderer are "enabled by default and not configurable" (`[V]` S41).
- Impact: the desktop shell behaves as a browser tab. `transcode()` keeps refusing, the eviction ladder stays on, the Node filesystem path is never selected, and a diagnostics blob from the packaged app is indistinguishable from one from a tab. Manager and editor; the creator surface is browser only forever.
- Verified: Electron "Context Isolation", default true since Electron 12 and `contextBridge` as the supported route (`[V]` S48, checked 2026-08-08). Capawesome's non configurable hardening (`[V]` S41, checked 2026-08-09).
- Fix, half done here: `detectShell()` now reads a declared identity first.

  ```ts
  // src/platform/browser/environment.ts
  const declared = safe(() => g.__shell__?.id, undefined)
  if (typeof declared === 'string' && SHELL_IDS.includes(declared)) return declared as ShellId
  ```

  The other half is a preload edit in generated code that does not exist yet. The contract, written here so the two sides cannot drift:

  ```ts
  // electron/src/preload.ts, after `npx cap add`
  import { contextBridge } from 'electron'

  contextBridge.exposeInMainWorld('__shell__', {
    id: 'electron',                      // must be one of the four ShellId values
    electron: process.versions.electron, // diagnostics only
    chrome: process.versions.chrome,     // diagnostics only
  })
  ```

  Only `id` is read today, and only as an identity claim: nothing downstream may take a capability from it, because capabilities are probed. The two version strings are for the diagnostics blob, which has no surface yet (P-10).
- Blind: yes. Cannot be run here.
- How it surfaces if the preload is forgotten: the probe now emits `The origin scheme capacitor-electron: says this is an app shell, and no shell identified itself to the probe`, because the scheme and the identity disagree. That is a first launch observable rather than a mystery, which is exactly what P-3 lacked.

### 5.2 P-5 A custom shell scheme used to produce no warning at all

- Target(s): Electron shell, Cap iOS, Cap Android.
- Failure: the probe warned only for `file:`. A `capacitor:`, `capacitor-electron:` or `https://localhost` document is a different storage origin from the deployed site, and nothing said so.
- Trigger: any shell build, on first launch, by a person who used the browser build yesterday.
- Impact: an empty library with no explanation, which reads as data loss and is not. Every role that gets a shell.
- Verified: scheme defaults (`[V]` S36, S39). That a different scheme is a different origin is the web's origin rule, not a Capacitor behaviour.
- Fix, done: `warnOnOrigin()` in `src/platform/capability.ts`. Four branches, because there are four different sentences: `http`/`https` says nothing, `file:` keeps its existing opaque origin warning, `unknown` says we could not read the origin (which is not the same as saying it is fine), and anything else names the scheme and names snapshot import as the route across.
- Note on Cap Android: its scheme is `https:`, so this warning does **not** fire there, and the origin is still different because the host is `localhost` rather than our domain. The warning is scheme shaped and the problem is origin shaped, so Android's separate origin remains unannounced. That is a known residual, recorded as P-16.
- Blind: no for the warning, yes for the shell.

### 5.3 P-7 The embedded WebView storage allowance is about a quarter of the browser's

- Target(s): Cap iOS first, every column second. Still **open**: this task did not change `deriveIngestPolicy()`.
- The numbers, quoted rather than paraphrased (`[V]` S44):
  - "For WebKit-based browser apps, each origin can store up to around 60% of total disk."
  - "For other WebKit-based apps that embed web content, each origin can store up to around 15% of total disk."
  - "WebKit also enforces an overall quota that stored data across all origins cannot grow beyond 80% of disk size for browser apps, and 20% of disk size for non-browser apps that display web content."
- What that means for us: `maxLocalOriginalBytes` is 2 GB at `ample` tier from the tier table alone (`src/platform/capability.ts`). On a 64 GB iPhone the browser allowance is around 38 GB and the shell allowance is around 9.6 GB, so the same default consumes about 5% of the browser's room and about 21% of the shell's.
- The subtler trap, and it is mine rather than the platform's `[I]`: these figures are percentages of **total** disk, not of free disk. A quota of 9.6 GB on a phone with 1 GB free is an honest quota and a dishonest promise, so `estimate().quota` is an upper bound and never an availability check. Any budget derived from it has to be clamped by what actually writes, which means a `QuotaExceededError` handler is not optional even after the clamp exists.
- Fix: `deriveIngestPolicy()` takes the quota report as a hint and records the clamp in `downgrades`, per QC-PLAT-022. Unchanged and still owed.
- Blind: yes for the device, no for the clamp.

### 5.4 P-9 `dvh` has no fallback, safe area insets do not exist, and Android 15 makes it worse

- Target(s): WebKit iOS, Cap iOS, Cap Android. Still **open**.
- Failure: `src/App.vue` uses `min-height: 100dvh` with no preceding `vh` declaration, `src/app/editor/ClipSheet.vue` uses `70dvh`, and no rule anywhere uses `env(safe-area-inset-*)`.
- Trigger in the shells specifically: `ios.contentInset` is `never`, which is the default and which we keep deliberately, so WKWebView does not inset anything for us (`[V]` S36). Android 15 enforces edge to edge, so the WebView fills the screen under the system bars unless margins are adjusted natively (`[V-]` S46).
- Impact: today, a layout that collapses on an engine without `dvh`. Once the sticky approve and reject bar and the creator submit button exist, a primary control under the home indicator or under the gesture bar, which is unusable rather than ugly.
- What the config does about it: `adjustMarginsForEdgeToEdge: 'auto'` on Android only. There is no equivalent for iOS, and there is no equivalent for mobile Safari, which is a shipped target. So the native option is a belt on one of three surfaces and the CSS is the only real fix.
- Consequence, stated as a gate: **P-9 must close before any mobile shell is built.** If it does not, the observable is a control the user cannot tap, and the second observable is double bottom padding on Android once the CSS lands while `auto` is still set.
- Blind: yes for the notch, no for the CSS.

### 5.5 OPFS in WKWebView: present, and for years unwritable by the method we call

- `navigator.storage.getDirectory()` has been in WebKit since Safari 15.2, and `FileSystemFileHandle.createWritable()` only since Safari 26 (`[V]` matrix S9 and S25, 2026-08-08).
- A Capacitor iOS shell runs system WebKit, so the OS version decides, and an iPhone on iOS 18 is a runtime with an OPFS root and no writable stream `[I]`.
- Our probe now answers both halves, so that runtime reports `storage.opfs: false`, `createBrowserPlatform()` builds `createUnavailableByteStore()`, and the app boots into the same `bytes_absent` state every record reaches once bytes live in object storage. That is a named degradation with a warning attached rather than a `TypeError`, which is what P-1 was about.
- The second rung, not built: a worker plus `createSyncAccessHandle`, which WebKit has had since 15.2 and which would restore originals on every one of those runtimes. It is the highest value unbuilt storage work for the iOS column, browser and shell alike.
- What is genuinely unverified: whether a wrapped WKWebView behaves like Safari here at all. The only dataset that tries to cover WKWebView lists most entries as "support unknown" (`[V]` matrix S35), and a third party OPFS checker states that in a wrapped WKWebView "the restrictions are substantially different than a normal web view" without enumerating them (`[V-]`, checked 2026-08-09). So the Cap iOS OPFS cells stay `probe`, and the code treats a missing OPFS in a shell as a first class state rather than an impossibility.

### 5.6 HEVC: the one place the biggest hole closes by itself, and why it is worth less than it sounds

The product's open hole, from `docs/01-architecture-review.md` E.4b: an iPhone HEVC clip delivered to a manager on a Windows laptop with no HEVC decode path produces an asset with real metadata and no pixels, permanently, because `transcode()` refuses in the browser by design.

**An iPhone WKWebView can decode HEVC.**
Safari and iOS Safari are `y` on caniuse (`[V]` S49, 2026-08-08), HEVC has been a system codec on iOS since iOS 11, and hardware decode is available on A9 and later with software decode as the fallback (`[V-]` S49, 2026-08-09).
WKWebView is the same WebKit and the same system video pipeline, so a Capacitor iOS build decodes what Safari on that device decodes `[I]`.

Three things follow, and the third is the one that matters.

1. It must still be probed. `decodingInfo` first, `canPlayType` second, both `hvc1` and `hev1` asked, exactly as now. "iOS decodes HEVC" as a code branch would be a device category wearing a capability's clothes, and it would also be wrong on an iPhone 6.
2. A green HEVC result in the Cap iOS shell is not evidence about any other target, in the same way that a green extraction result there is not evidence about Safari (the gesture asymmetry, section 3 item 4).
3. **The capability lands on the wrong role.** The person holding the iPhone HEVC file is the creator, and the creator surface is browser only forever (U5), so the creator never gets this shell. Meanwhile mobile Safari on that same iPhone already decodes HEVC, so the browser build already covers the creator's case. The hole opens when the file reaches a Windows or Linux desktop, and that is the Electron column, where it closes only where Chromium's hardware path exists (Electron >= 22, `[V]` matrix S26) or where we ship the bundled ffmpeg executor that has never been written.

So the honest summary is: the Cap iOS shell closes a hole that was not open on that device, and the Electron shell closes the hole that is actually open, conditionally, using a component that does not exist.
That is not an argument against recording the fact.
It is an argument against letting "the native app can decode HEVC" become a reason to build the native app.

### 5.7 P-13 Capacitor's own documentation says IndexedDB is transient on iOS, and our entire record store is IndexedDB

- Target(s): Cap iOS. New finding.
- Failure: every record in this product (deals, briefs, consent records, tags, the search index, contact sheets, posters) lives in IndexedDB, per the no server constraint. Capacitor's storage guide says Local Storage "must be considered transient", that "the OS will reclaim local storage from Web Views if a device is running low on space", and that "The same can be said for IndexedDB at least on iOS (on Android, the persisted storage API is available to mark IndexedDB as persisted)" (`[V]` S42).
- Trigger: a device low on storage. No user action, no seven day rule, no eviction warning of ours.
- Impact: the whole library disappears from the app while the app is installed and looks healthy. This is strictly worse than the browser case, because in a browser the user has a mental model for "the browser cleared site data" and in an installed app they do not.
- Verified: Capacitor's own storage guide (`[V]` S42), and the feature request to make `navigator.storage.persist()` work for a Capacitor app was closed as not planned (`[V]` S43). Both checked 2026-08-09.
- Fix, in order of honesty rather than effort:
  1. **Gate.** Do not ship a Capacitor iOS build until export and import plus the sentinel record exist (`docs/01-architecture-review.md` B.2, tracked as P-6). That is now a decision, section 9 item 2.
  2. **Design.** The durable store on this target is a native one behind the existing `ByteStore` and record seams, which is the port doing the job it was built for rather than a rewrite. That is a real body of work and it is the price of this target.
  3. **Meanwhile, say it.** The storage panel's persisted row must read the actual `persisted()` answer and, in a shell, say plainly that the operating system may reclaim this data.
- Blind: yes for the behaviour, no for the reading of the vendor's documentation.

### 5.8 P-14 The desktop shell's platform package is unmaintained and two majors behind

- Target(s): Electron shell. New finding.
- Failure: `@capacitor-community/electron` is 5.0.1, declares `@capacitor/cli >=5.4.0` and lists Electron `^26.2.2` (`[V]` S38), while the Capacitor CLI is 8.5.0 (`[V]` S37). Its README states the project is unmaintained and recommends the Capawesome Electron platform (`[V]` S40).
- Trigger: the first `npx cap add @capacitor-community/electron` on a Capacitor 8 project.
- Impact: the desktop shell may not be addable at all, before any of our code runs. Nothing in this repository detects that, because nothing in this repository runs it.
- Fix: section 9 item 1 decides what we do. In short, we keep the community platform's config shape because U4 named it and because the shape is what is being reviewed, we record the maintenance status here rather than discovering it during a build, and we write down exactly what changes on a move to Capawesome: the `electron` key in `capacitor.config.ts` becomes `electron/capacitor.electron.config.ts`, and the preload contract in section 5.1 becomes mandatory rather than merely correct, because that platform's context isolation cannot be switched off (`[V]` S41).
- Blind: yes.

### 5.9 P-15 The Android WebView floor was four majors below the floor our own bundle needs

- Target(s): Cap Android. New finding, fixed in configuration.
- Failure: Capacitor's `android.minWebViewVersion` defaults to 60 (`[V]` S36). Vite 6's default `build.target` is `baseline-widely-available`, which for this major is Chrome >= 107 (`[V]` S45), and `vite.config.ts` does not override it. So the shipped bundle contains syntax that a Chromium between 60 and 106 cannot parse, and the result on such a device is a white screen plus a console message nobody reads.
- Trigger: an Android device whose System WebView has not been updated, which is common on budget hardware and on devices with restricted Play Store access.
- Impact: a blank app with no explanation. Every role that uses the Android shell.
- Fix, done: `minWebViewVersion: 107` plus `server.errorPath: 'unsupported-webview.html'`, and the page is committed at `public/unsupported-webview.html` with no script and no plugin dependency, because Capacitor documents that the error page has no plugin access on Android.
- Residual risk: that `errorPath` is actually shown for the minimum version refusal is a secondary source claim (`[V-]` S47). The observable is written into `qa/manual-checklist.md` 2.3 rather than assumed.
- Coupling: this number tracks `build.target`. Vite 7 raises the baseline to Chrome 111 (`[V]` S45), so a Vite upgrade that leaves this line alone reopens the hole. QC-PLAT-049 asserts the coupling from the text of both files.
- Blind: yes for the device, no for the coupling.

### 5.10 P-16 The Android shell's origin differs by host, and our warning is scheme shaped

- Target(s): Cap Android. New finding, open.
- Failure: `warnOnOrigin()` returns silently for `https:`, and the Android shell loads `https://localhost` (`[V]` S36). The origin is still different from the deployed site, so the same empty library appears with no explanation, which is the exact failure P-5 was written to remove.
- Trigger: installing the Android shell after using the browser build.
- Impact: reads as data loss on one of the two mobile targets.
- Fix: the check has to compare the full origin against the origin the data was written under, not the scheme. The cheapest correct version is to record the origin in the profile's sentinel record when it is created (the sentinel is already owed by P-6) and warn when the current origin differs from the recorded one. That covers Android, Electron, iOS and a domain change on the deployed site, with one mechanism and no scheme list.
- Verified: the Android scheme default (`[V]` S36). That `https://localhost` is a distinct origin from `https://our.site` is the origin rule.
- Blind: no. This is testable today with a fake sentinel.

---

## 6. What we write blind, per shell, and how a real failure will surface

Named so a failure later arrives as something observable rather than mysterious.
This extends the matrix's own blind list rather than replacing it.

### Electron shell

Written blind: the whole configuration, shell identity and the preload contract, the Node `fs` byte store that does not exist yet, `safeStorage` custody with the Linux `basic_text` caveat, the ffmpeg derive executor, and the assumption that the renderer keeps Chromium's storage behaviour.
The runtime must report: `shell: 'electron'` from the bridge, the Electron and Chromium versions, whether `storage.opfs` came back true (which answers the secure scheme question in one boolean), the four codec answers, and `getSelectedStorageBackend()` wherever `safeStorage` is used.
First launch observables, in order: does the storage panel say `electron` or `browser` (P-3), is there an origin warning (P-5), and does `storage.opfs` read true (the scheme privileges question).
What would falsify the design: an Electron build whose Chromium lacks the proprietary codec set, which would make even H.264 a `probe` rather than a formality, or a platform package that cannot be added at all (P-14).

### Capacitor iOS

Written blind: everything.
The runtime must report: `shell: 'capacitor-ios'`, `loadScheme: 'capacitor:'` with its warning, the quota estimate under the roughly 15% allowance, whether OPFS came back writable, and the first real file's extraction outcome with its reason code and elapsed milliseconds.
First launch observables: an empty library that explains itself (P-5), a quota figure materially smaller than the same device's mobile Safari figure (P-7), and whether originals can be kept at all (5.5).
The failure that will not announce itself: P-13. Data reclaimed by the OS produces no event, no error and no reason code, only an app that is suddenly empty. Until the sentinel exists, this target cannot tell that story, which is the argument for the gate.
What we know changes in our favour: the gesture requirement is switched off in this shell (`[V]` matrix S31), so extraction results here are more optimistic than mobile Safari's and must not be read as evidence about it.

### Capacitor Android

Written blind: everything except the WebView floor, which is derived from our own build target rather than guessed.
The runtime must report: `shell: 'capacitor-android'`, the System WebView version in the diagnostics blob, `hardwareConcurrency`, `deviceMemory`, the tier, and per file timings.
First launch observables: the unsupported WebView page instead of a white screen (P-15), and whether the bottom controls clear the gesture bar (P-9).
The silent one: the origin difference, because the scheme is `https:` and our warning will not fire (P-16).

---

## 7. The commands nobody has run

Recorded exactly, so "never built" is checkable rather than a claim.

```bash
# none of this has been executed in this repository
npm i -D @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android
npm run build && npx cap sync

# desktop, and see P-14 before starting
npm i -D @capacitor-community/electron
npx cap add @capacitor-community/electron
```

Three consequences a builder should expect on the first attempt.

1. `capacitor.config.ts` must be added to the `include` array in `tsconfig.json` at the same time as the install, or the type import stays unresolved. It is excluded today precisely so `npm run typecheck` cannot pass by pretending a shell exists.
2. `npx cap add` generates `ios/`, `android/` and `electron/` project directories. Capacitor's convention is to commit them, and this repository's `.gitignore` deliberately does not list them, so they will show up in `git status` on purpose. They are generated code that changes behaviour, so they get reviewed like code, not ignored like build output.
3. The preload edit in section 5.1 has to be made immediately after `npx cap add`, before the first launch, or the first launch teaches the builder the wrong thing about their own shell.

## 8. What would falsify this document

- A Capacitor 8 project that adds the community Electron platform cleanly. That would soften P-14 without removing the maintenance question.
- A Cap iOS build where `navigator.storage.persist()` returns true and data survives a low storage event. That would contradict S42 and S43, and it would need to be reproduced twice before P-13 is downgraded.
- A wrapped WKWebView that reports OPFS present and `createWritable` absent while writing successfully by some other path. That would mean our probe is too strict, which is the safe direction to be wrong in, and it would still be worth recording.
- `server.errorPath` not being shown for a `minWebViewVersion` refusal. That would leave P-15 half fixed: the refusal would be correct and invisible, which is the failure shape this project bans, and the answer would be a native check before the WebView loads.

---

## 9. Decisions this track settled

Both are now in `docs/06-decisions.md` as **D33** and **D34**, which is the only copy: a decision written down twice is a decision that will disagree with itself.

- **D33.** The desktop shell keeps `@capacitor-community/electron`'s configuration shape, even though that project is now unmaintained. The reasoning, and what changes on a move to Capawesome, is P-14 above.
- **D34.** No Capacitor iOS build ships before export and import plus the sentinel record exist. The evidence is P-13 above: the vendor documents IndexedDB on iOS as reclaimable and `navigator.storage.persist()` as not planned.
