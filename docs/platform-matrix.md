# Platform capability matrix

Owner: `platform-matrix`.
Question this document answers: does this work, and degrade honestly, on every runtime we claim to support, in both the interface and the logic?
Commissioned in `docs/07-handoff.md` and outstanding until this file existed.

Written 2026-08-08.
Every external source in the register below was checked on 2026-08-08 unless the cell says otherwise.

This document does not decide whether a derived fact is correct: that is `media-pipeline` (`docs/media-pipeline.md`).
It does not decide who may see what: that is `tenancy-guard`.
It does not implement tests: the cases it emits live in `qa/cases/platform.md` and are `qa-runner`'s to implement.

## How to read a cell

Five values, and nothing else:

| value | meaning |
|---|---|
| `yes` | present on this target per the cited source |
| `no` | absent on this target per the cited source |
| `probe` | presence genuinely varies inside this target (by OS version, GPU, WebView version, or host configuration), so the only correct answer is what `probeCapabilities()` reports at runtime. The source establishes the variance, not the answer |
| `unknown` | we could not establish it from any source and are not guessing |
| `unverified` | no source found. My inference follows, marked `[I]`, and is never presented as fact |

Evidence markers follow `docs/02-caveats-review.md`: `[V]` verified against an authoritative source, `[V-]` verified against a secondary or dated source, `[I]` inference.

Cell format is `value [Sn dd-mm]`.
Every date in a cell is a 2026 date and the full ISO date sits in the source register.
`[C 06-08]` means a finding already verified in `docs/02-caveats-review.md` on 2026-08-06 and reused rather than re-verified.

**A `yes` in this table is never a licence to hardcode.**
Nothing in this codebase branches on a device category, a user agent, or a column of this table.
Everything branches on the observed capability from `probeCapabilities()` (`src/platform/capability.ts`), and the table exists to say what to expect, what the fallback must cover, and what a bug report from a real device probably means.

## The targets, named precisely

| column | engine and host | version basis used below | status in this build |
|---|---|---|---|
| Blink desktop | Chrome and Edge on Windows, macOS, Linux | caniuse latest tracked: Chrome 154, Edge 151 | shipped and exercised, primary target |
| Gecko desktop | Firefox on Windows, macOS, Linux | caniuse latest tracked: Firefox 156 | shipped and exercised |
| WebKit macOS | Safari on macOS | caniuse latest tracked: Safari 27, plus the 15.2 to 26 history where it matters | shipped and exercised |
| WebKit iOS | Safari on iOS and iPadOS | caniuse latest tracked: iOS Safari 26.5, plus the 15.2 to 26 history | shipped, written blind, never device tested |
| Blink Android | Chrome for Android | caniuse latest tracked: Chrome Android 151 | shipped, written blind, never device tested |
| Electron shell | Chromium renderer inside Electron, via `@capacitor-community/electron` | Electron >= 22 assumed where a version matters | designed and configured only, never built or run |
| Cap iOS | WKWebView inside a Capacitor iOS app | system WebKit, so the OS version decides | designed only, later |
| Cap Android | Android System WebView inside a Capacitor app | Chromium, WebView version decides and is not the OS version | designed only, later |

Three of those columns cannot be verified from this machine, and one specific fact governs how they are filled.
MDN's browser compat data marks `webview_android`, `webview_ios`, `edge` and `safari_ios` with the literal value `"mirror"`, which means the version numbers are **computed from the upstream browser rather than tested in the derivative** (`[V]` S33 08-08).
So a mirrored `yes` is an inference produced by a build script, not an observation, and this document will not launder it into a fact.
The only published dataset that tries to cover WKWebView specifically, caniwebview.com, lists the overwhelming majority of its entries as "support unknown" (`[V]` S35 08-08).
That is why almost every cell in the three unbuilt columns reads `probe`: not caution for its own sake, but the honest state of the evidence.

## Source register

| key | source | establishes | checked |
|---|---|---|---|
| S1 | caniuse `features-json/hevc.json` (raw.githubusercontent.com/Fyrd/caniuse) | HEVC per browser, with the hardware notes | 2026-08-08 |
| S2 | caniuse `features-json/mpeg4.json` | H.264 in MP4 per browser | 2026-08-08 |
| S3 | caniuse `features-json/webcodecs.json` | WebCodecs per browser, including Safari's video-only phase | 2026-08-08 |
| S4 | MDN browser-compat-data `api/VideoDecoder.json` | `VideoDecoder` and `isConfigSupported` version floors | 2026-08-08 |
| S5 | MDN BCD `api/MediaCapabilities.json` | `decodingInfo` version floors | 2026-08-08 |
| S6 | MDN BCD `api/HTMLMediaElement.json` | `canPlayType` version floors and per engine quirks | 2026-08-08 |
| S7 | MDN BCD `api/HTMLVideoElement.json` | `requestVideoFrameCallback` version floors | 2026-08-08 |
| S8 | MDN BCD `api/StorageManager.json` | `getDirectory`, `estimate`, `persist`, `persisted` | 2026-08-08 |
| S9 | MDN BCD `api/FileSystemFileHandle.json` | `createWritable` and `createSyncAccessHandle` | 2026-08-08 |
| S10 | MDN BCD `api/FileSystemDirectoryHandle.json` | `keys`, `getFileHandle`, `getDirectoryHandle`, `removeEntry` | 2026-08-08 |
| S11 | caniuse `features-json/native-filesystem-api.json` | the File System Access pickers | 2026-08-08 |
| S12 | MDN BCD `api/DataTransferItem.json` | `webkitGetAsEntry` | 2026-08-08 |
| S13 | caniuse `features-json/input-file-multiple.json` | multi file picker | 2026-08-08 |
| S14 | caniuse `features-json/broadcastchannel.json` | BroadcastChannel | 2026-08-08 |
| S15 | MDN BCD `api/LockManager.json` | Web Locks | 2026-08-08 |
| S16 | caniuse `features-json/offscreencanvas.json` | OffscreenCanvas | 2026-08-08 |
| S17 | caniuse `features-json/createimagebitmap.json` | `createImageBitmap` | 2026-08-08 |
| S18 | caniuse `features-json/webworkers.json` | Web Workers | 2026-08-08 |
| S19 | MDN BCD `api/Navigator.json` | `deviceMemory` and `hardwareConcurrency`, including Safari's clamp and Chrome's quantisation | 2026-08-08 |
| S20 | caniuse `features-json/css-media-interaction.json` | `pointer`, `any-pointer`, `hover`, `any-hover` | 2026-08-08 |
| S21 | caniuse `features-json/async-clipboard.json` | async clipboard, and the per engine permission model | 2026-08-08 |
| S22 | caniuse `features-json/download.json` | the `download` attribute | 2026-08-08 |
| S23 | caniuse `features-json/wake-lock.json` | Screen Wake Lock | 2026-08-08 |
| S24 | MDN "Storage quotas and eviction criteria" | per engine quota ceilings, the WebKit 7 day rule, all-or-nothing origin eviction, what `persist()` does | 2026-08-08 |
| S25 | WebKit blog, "WebKit Features in Safari 26.0" | Safari 26.0 added the File System WritableStream API, and added AudioEncoder/AudioDecoder to WebCodecs | 2026-08-08 |
| S26 | StaZhu, `enable-chromium-hevc-hardware-decoding` README | Chromium ships no built in software HEVC decoder, the per OS requirements, and Electron >= 22.0.0 HEVC hardware decode | 2026-08-08 |
| S27 | Electron docs, "Context Isolation" | `contextIsolation` has defaulted to true since Electron 12, and `contextBridge` is the way to expose anything | 2026-08-08 |
| S28 | Electron docs, "safeStorage" | `isEncryptionAvailable()` per platform, and the Linux `basic_text` unprotected fallback | 2026-08-08 |
| S29 | Capacitor docs, "Configuration" | `server.iosScheme` default `capacitor`, `server.androidScheme` default `https`, `server.hostname` default `localhost` and why localhost matters for secure context | 2026-08-08 |
| S30 | `@capacitor-community/electron` docs, "Config Options" | `customUrlScheme` default `capacitor-electron`, and that node and context isolation are not exposed as config | 2026-08-08 |
| S31 | Capacitor iOS source, `CAPBridgeViewController.swift` | `allowsInlineMediaPlayback = true`, `mediaTypesRequiringUserActionForPlayback = []`, `allowsAirPlayForMediaPlayback = true` | 2026-08-08 |
| S32 | Capacitor docs, "Preferences" | UserDefaults on iOS, SharedPreferences on Android, explicitly not a database | 2026-08-08 |
| S33 | MDN BCD `schemas/compat-data-schema.md` | the `"mirror"` value is computed from an upstream browser, with the mapping | 2026-08-08 |
| S34 | Chrome for Developers, "Page Lifecycle API" | frozen and discarded states, `freeze`/`resume` from Chrome 68, `document.wasDiscarded` on desktop Chrome, no code runs while discarded | 2026-08-08 |
| S35 | caniwebview.com, WKWebView client page | no published dataset covers WKWebView parity: most entries are "support unknown" | 2026-08-08 |
| C | `docs/02-caveats-review.md` sections C1, C2, C3, C4, C6, C7, C8, C9 | prior verified device findings, each already carrying its own source | 2026-08-06 |
| A | `docs/01-architecture-review.md` sections B.1, B.2, B.4, C3, E.4a, E.4b | the storage tiering, the port contract, the ingest policy, the undecodable asset | internal |

---

## 1. Codec and decode

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| H.264 decode | `yes` [S2 08-08] | `yes` [S2 08-08] | `yes` [S2 08-08] | `yes` [S2 08-08] | `yes` [S2 08-08] | `probe` [S26 08-08] `[I]` | `probe` [S33 08-08] `[I]` | `probe` [S33 08-08] `[I]` |
| HEVC decode | `probe` [S1+S26 08-08] | `probe` [S1 08-08] | `yes` [S1 08-08] | `yes` [S1 08-08] | `probe` [S1+S26 08-08] | `probe` [S26 08-08] | `probe` [C 06-08] `[I]` | `probe` [S26+C 06-08] `[I]` |
| `MediaCapabilities.decodingInfo` | `yes` [S5 08-08] | `yes` [S5 08-08] | `yes` [S5 08-08] | `yes` [S5 08-08] | `yes` [S5 08-08] | `probe` [S5 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| `canPlayType` | `yes` [S6 08-08] | `yes` [S6 08-08] | `yes` [S6 08-08] | `yes` [S6 08-08] | `yes` [S6 08-08] | `yes` [S6 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |

**H.264.**
Universal in the browsers, and the one codec safe to expect (`[V]` S2 08-08).
caniuse's note is worth keeping: Firefox needs system libraries on Linux, so a Linux Firefox with no `ffmpeg` package is a real, if rare, `no` (`[V]` S2 08-08).
`public/seed/video/*.mp4` is H.264 for exactly this reason (A, B.3).
Electron reads `probe` rather than `yes` because whether an Electron build ships the proprietary codec set is a property of that build, and we have never made one.

**HEVC, the product's open hole.**
caniuse's latest values are Chrome 154 `a #5`, Edge 151 `a #4`, Firefox 156 `a #8`, Safari 27 `y`, iOS Safari 26.5 `y`, Chrome Android 151 `a #5` (`[V]` S1 08-08).
Every `a` resolves to the same sentence: **Chromium ships no built in software HEVC decoder, so support is hardware decode only** (`[V]` S26 08-08), which is why macOS needs Big Sur or later, Windows needs Windows 8 or later plus in some configurations the Microsoft Store HEVC extension, Android needs 5.0 or later plus an SoC decode block, and Linux or ChromeOS needs Chrome 108 or later with VAAPI on Intel (`[V]` S26 08-08).
Firefox's current note now reads "hardware support required, software fallback available in certain cases", which is a softening of the older WONTFIX position recorded in `docs/02-caveats-review.md` C1.1 (`[V]` S1 08-08).
The consequence for us is unchanged and is stated in A, E.4b: an iPhone HEVC file delivered to a manager on a Windows laptop with no HEVC decode path produces an asset with real metadata and no pixels, permanently, in this build.
`transcode()` rejects with `Unsupported('transcode', 'no_transcoder_in_browser')` at `src/platform/browser/runtime.ts:146`, which is the design and not a gap.

**Electron is the one column where HEVC changes.**
"If Electron >= v22.0.0, the HEVC HW decoding feature for macOS, Windows, and Linux (VAAPI only) should have already been integrated" (`[V]` S26 08-08).
So the desktop shell resolves E.4b for the hardware-supported cases, and only for them: on a Linux box with a non Intel GPU it fails exactly as Chrome does.
Bundled ffmpeg, which A, B.4 relies on for "decodes everything the browser cannot", is a separate thing from Chromium's HEVC path and is the part we have never built.

**The two detection APIs disagree, and the order matters.**
`decodingInfo` is asynchronous and authoritative, present since Chrome 66, Firefox 63, Safari 13 (`[V]` S5 08-08).
`canPlayType` is synchronous, ancient, and returns `''`, `'maybe'` or `'probably'` (`[V]` S6 08-08).
Our probe asks `decodingInfo` first and falls back to `canPlayType` (`probeCodec()`, `src/platform/capability.ts:185`), and it asks about both `hvc1` and `hev1` because iPhone footage is tagged `hvc1` (`[V]` C 06-08).
It also asks at 1080x1920, 4 Mbps, 30 fps (`buildDecodingInfo()`, `src/platform/browser/environment.ts:93`), which is deliberate: some engines answer differently above a hardware decoder's limit, and that is the shape our creators deliver.
There is a defect in the ordering, recorded as P-2 below.

---

## 2. Frame extraction

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| WebCodecs `VideoDecoder` | `yes` [S3+S4 08-08] | `yes` [S3+S4 08-08] | `yes` [S4 08-08] | `probe` [S3+S4 08-08] | `yes` [S3 08-08] | `probe` [S4 08-08] `[I]` | `probe` [S33+S35 08-08] | `probe` [S33 08-08] |
| video to canvas extraction | `yes` [C 06-08] | `yes` [C 06-08] | `yes` [C 06-08] | `probe` [C 06-08] | `probe` [C 06-08] | `probe` [C 06-08] `[I]` | `probe` [S31+C 06-08] | `probe` [C 06-08] |
| `requestVideoFrameCallback` | `yes` [S7 08-08] | `yes` [S7 08-08] | `yes` [S7 08-08] | `yes` [S7 08-08] | `yes` [S7 08-08] | `probe` [S7 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| `OffscreenCanvas` | `yes` [S16 08-08] | `yes` [S16 08-08] | `yes` [S16 08-08] | `yes` [S16 08-08] | `yes` [S16 08-08] | `probe` [S16 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| `createImageBitmap` | `yes` [S17 08-08] | `yes` [S17 08-08] | `yes` [S17 08-08] | `yes` [S17 08-08] | `yes` [S17 08-08] | `probe` [S17 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| inline playback without a user gesture | `yes` [C 06-08] | `yes` [C 06-08] | `yes` [C 06-08] | `no` [C 06-08] | `probe` [C 06-08] | `yes` [C 06-08] `[I]` | `yes` [S31 08-08] | `probe` [C 06-08] |
| canvas 2D context always allocatable | `yes` `[I]` | `yes` `[I]` | `probe` [C 06-08] | `probe` [C 06-08] | `probe` [C 06-08] | `yes` `[I]` | `probe` [C 06-08] | `probe` [C 06-08] |

**WebCodecs.**
Chrome and Edge 94, Firefox 130, Safari 16.4 for the video interfaces only and 26.0 for the full API (`[V]` S3 08-08, S4 08-08).
Safari 26.0's own release notes confirm the completion from the other direction: it "expands support for WebCodecs API by adding AudioEncoder and AudioDecoder" (`[V]` S25 08-08).
We only ever need the video interfaces, so 16.4 is the real floor for WebKit, and `WebKit iOS` reads `probe` because an iPhone still on iOS 15 has none of it while an iPhone on 26 has all of it, and no user agent may be consulted to tell them apart.
One value that matters for the mobile web at large: **Firefox for Android is `false` for `VideoDecoder`, not mirrored** (`[V]` S4 08-08).
Firefox Android is outside our declared matrix, and if it ever enters, it is a `video-canvas` only runtime.

**Video to canvas is the fallback that must never be assumed to work.**
It is not one API, it is a sequence, and the sequence is specified in `docs/02-caveats-review.md` C3.2 with every step sourced.
The reasons `WebKit iOS` is `probe` rather than `yes`, all already verified on 2026-08-06: an off DOM or CSS hidden video still needs a user gesture, the first `drawImage` after a seek can be blank, a seek issued before `readyState >= 2` may never complete, and WebKit caps total canvas memory per page so `getContext('2d')` can return `null`.
`Blink Android` is `probe` for a different reason: it works, and it janks, because the main thread is doing the decode and the scale.
The code's answer is the capability chain in `src/media/extract.ts` with `allowedAdapters()` at line 726, and rung three is a described grey tile that is never stored, which is the no fabrication rule in one line.

**Capacitor iOS is the one place a shell makes extraction easier rather than harder.**
Capacitor's iOS bridge sets `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []` when it builds the `WKWebViewConfiguration` (`[V]` S31 08-08).
The second of those removes the user gesture requirement that is the highest probability iPhone only failure in the whole product on Safari (`[V]` C 06-08).
So the gesture continuity discipline we write blind for Safari is still correct, and in the shell it is redundant rather than load bearing.
That asymmetry is worth knowing before someone reads a green result in the shell as evidence about Safari.

**`requestVideoFrameCallback` now exists in Gecko, which changes a prior finding.**
See the contradictions section below.

---

## 3. Storage: where bytes live

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| OPFS root (`storage.getDirectory`) | `yes` [S8 08-08] | `yes` [S8 08-08] | `yes` [S8 08-08] | `yes` [S8 08-08] | `yes` [S8 08-08] | `probe` [S8+S30 08-08] | `probe` [S33 08-08] | `probe` [S33 08-08] |
| OPFS directory enumeration (`keys`) | `yes` [S10 08-08] | `yes` [S10 08-08] | `yes` [S10 08-08] | `yes` [S10 08-08] | `yes` [S10 08-08] | `probe` [S10 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| **OPFS async write (`createWritable`)** | `yes` [S9 08-08] | `yes` [S9 08-08] | **`probe`** [S9+S25 08-08] | **`probe`** [S9+S25 08-08] | `yes` [S9 08-08] | `probe` [S9 08-08] `[I]` | `probe` [S9+S33 08-08] | `probe` [S33 08-08] |
| OPFS sync write in a worker (`createSyncAccessHandle`) | `yes` [S9 08-08] | `yes` [S9 08-08] | `yes` [S9 08-08] | `yes` [S9 08-08] | `yes` [S9 08-08] | `probe` [S9 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| File System Access pickers | `yes` [S11 08-08] | `no` [S11 08-08] | `no` [S11 08-08] | `no` [S11 08-08] | `no` [S11 08-08] | `probe` [S11 08-08] `[I]` | `no` [S11 08-08] `[I]` | `no` [S11 08-08] `[I]` |
| IndexedDB blobs | `yes` [A] | `yes` [A] | `yes` [A] | `yes` [A] | `yes` [A] | `probe` [A] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |

**The most important row in this document is OPFS async write.**
`navigator.storage.getDirectory()` has existed in WebKit since Safari 15.2, and so have `getFileHandle`, `keys`, `removeEntry` and the worker only `createSyncAccessHandle` (`[V]` S8 08-08, S9 08-08, S10 08-08).
`FileSystemFileHandle.createWritable()`, the method our byte store actually calls, arrived in **Safari 26** (`[V]` S9 08-08), which Safari 26.0's own release notes confirm as "support for the File System WritableStream API, enabling direct writing to files within the user's file system" (`[V]` S25 08-08).
`safari_ios` mirrors Safari, so the iOS floor is iOS 26 (`[V]` S9 08-08 with S33 08-08 for the mirror semantics).

So on every WebKit runtime from Safari 15.2 to Safari 25, and on iOS 15.2 through iOS 18.x, **OPFS is present and unwritable by the path we use**.
Our probe answers `hasOpfs` from `typeof navigator.storage?.getDirectory === 'function'` alone (`src/platform/browser/environment.ts:42`), so it says yes, `createBrowserPlatform()` builds a real `createOpfsByteStore()` (`src/platform/browser/index.ts:44`), and the first `put()` calls a method that does not exist (`src/platform/browser/bytes.ts:70`).
That is a `TypeError`, not an `Unsupported`, so it is the one failure shape the product promised never to produce: unnamed, unexplained, and invisible to the degradation ladder.
Recorded as P-1, which is the highest severity finding in this pass.

**File System Access pickers are Chromium desktop only.**
caniuse's latest values: Chrome 154 `y`, Edge 151 `y`, Firefox 156 `n`, Safari 27 `n`, iOS Safari 26.5 `n`, Chrome Android 151 `n` (`[V]` S11 08-08).
This matches `docs/02-caveats-review.md` C7.1, which recorded that Safari implements OPFS and not the pickers.
The consequence for the editor's "give me the original file" flow (`docs/02-caveats-review.md` G2.2): a streaming save to a user chosen path exists on one column and nowhere else, so everywhere else a large download has to become a Blob first, which walks straight back into the memory ceiling.
`hasFileSystemAccess` is probed (`src/platform/browser/environment.ts:43`) and has no consumer yet, which is correct for the current build stage and is listed as a gap below.

---

## 4. Storage: quota, persistence, eviction

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| `storage.estimate()` | `yes` [S8 08-08] | `yes` [S8 08-08] | `probe` [S8 08-08] | `probe` [S8 08-08] | `yes` [S8 08-08] | `probe` [S8 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| `storage.persist()` exists | `yes` [S8 08-08] | `yes` [S8 08-08] | `yes` [S8 08-08] | `yes` [S8 08-08] | `yes` [S8 08-08] | `probe` [S8 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| `persist()` is granted | `probe` [S24 08-08] | `probe` [S24 08-08] | `probe` [S24 08-08] | `probe` [S24 08-08] | `probe` [S24 08-08] | `probe` [S24 08-08] `[I]` | `unknown` | `unknown` |
| quota ceiling | ~60% of disk [S24 08-08] | min(10% disk, 10 GiB per site group), 50% capped 8 TiB when persistent [S24 08-08] | ~60% of disk [S24 08-08] | ~60% of disk [S24 08-08] | ~60% of disk [S24 08-08] | `probe` [S24 08-08] `[I]` | **~15% of disk** [S24 08-08] | `unknown` |
| eviction under pressure | LRU across origins, skips persistent [S24 08-08] | LRU across origins, skips persistent [S24 08-08] | LRU plus **7 day no interaction deletion** [S24 08-08] | LRU plus **7 day no interaction deletion** [S24 08-08] | LRU across origins [S24 08-08] | `probe` `[I]` | `no` `[I]` | `no` `[I]` |
| eviction granularity | whole origin, never partial [S24 08-08] | whole origin [S24 08-08] | whole origin [S24 08-08] | whole origin [S24 08-08] | whole origin [S24 08-08] | n/a `[I]` | n/a `[I]` | n/a `[I]` |
| `QuotaExceededError` on overrun | `yes` [S24 08-08] | `yes` [S24 08-08] | `yes` [S24 08-08] | `yes` [S24 08-08] | `yes` [S24 08-08] | `probe` `[I]` | `probe` `[I]` | `probe` `[I]` |

**`estimate()` is the youngest of the four storage methods on WebKit.**
Chrome 61, Firefox 57, Safari 17 (`[V]` S8 08-08), while `persist`, `persisted` and `getDirectory` are all Safari 15.2.
So Safari 15.2 through 16.x is a runtime that can be asked to persist and cannot be asked how much room is left, which is why `hasStorageEstimate` produces its own warning line in the probe (`src/platform/capability.ts:148`) and why `QuotaReport.available` is a distinct field from `usageBytes: 0` (`src/platform/port.ts:145`).
Reporting zero where the platform declined to answer would be a lie with a number attached.

**The WebKit 7 day rule survives verification and is still the worst data loss risk in the product.**
"If an origin has no user interaction, such as click or tap, in the last seven days of browser use, its data created from script will be deleted" (`[V]` S24 08-08).
Combined with "when an origin's data is evicted by the browser, all of its data, not parts of it, is deleted at the same time" (`[V]` S24 08-08), a reviewer who opens the demo, closes it, and returns ten days later on Safari finds an empty app.
Not the videos gone and the records kept: the deals, the briefs, the consent records, and the videos, together.
A, B.2 requires the sentinel record, the "data may have been cleared" screen, and export and import as the durability mechanism.
None of the three exists in the tree yet, and that is P-6.

**Capacitor iOS gets one quarter of the storage that mobile Safari gets.**
"Non browser WebKit apps (embedded WebView): ~15% of total disk", against ~60% for a browser app or a Home Screen web app (`[V]` S24 08-08).
The direction is the opposite of the intuition that a native shell is more generous, and it is the single most consequential number in the Cap iOS column.
`maxLocalOriginalBytes` defaults to 2 GB at `ample` tier (`src/platform/capability.ts:318`), which on a 64 GB iPhone in a Capacitor shell is roughly the entire allowance.
The byte budget must be derived from the reported quota, not from the tier alone, which is P-7.

**Electron's quota row is where our own architecture document is wrong.**
`docs/01-architecture-review.md` B.4 states the Electron quota ceiling is "free disk, no origin quota".
An Electron renderer is Chromium and its IndexedDB and OPFS go through Chromium's quota manager, so MDN's ~60% of disk figure applies there too (`[V]` S24 08-08 for the figure, `[I]` for the application to Electron since we have never run one).
What actually escapes the quota in a desktop shell is the Node `fs` path that B.4 also describes, and only that.
The correction matters because it decides whether the eviction ladder can be switched off in the shell: it cannot be switched off on the strength of "no quota", only on the strength of `persist()` plus a real filesystem for originals.

---

## 5. Coordination and compute

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| Web Workers | `yes` [S18 08-08] | `yes` [S18 08-08] | `yes` [S18 08-08] | `yes` [S18 08-08] | `yes` [S18 08-08] | `probe` [S18 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| `BroadcastChannel` | `yes` [S14 08-08] | `yes` [S14 08-08] | `yes` [S14 08-08] | `yes` [S14 08-08] | `yes` [S14 08-08] | `probe` [S14 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| Web Locks (`LockManager.request`) | `yes` [S15 08-08] | `yes` [S15 08-08] | `yes` [S15 08-08] | `yes` [S15 08-08] | `yes` [S15 08-08] | `probe` [S15 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| `navigator.hardwareConcurrency` | `yes`, true count [S19 08-08] | `yes`, true count [S19 08-08] | `yes`, **clamped to 4 or 8** [S19 08-08] | `yes`, **clamped** [S19 08-08] | `yes` [S19 08-08] | `probe` [S19 08-08] `[I]` | `probe`, clamped [S33 08-08] `[I]` | `probe` [S33 08-08] |
| `navigator.deviceMemory` | `yes`, quantised [S19 08-08] | `no` [S19 08-08] | `no` [S19 08-08] | `no` [S19 08-08] | `yes`, quantised [S19 08-08] | `probe` [S19 08-08] `[I]` | `no` [S19 08-08] `[I]` | `probe` [S19 08-08] `[I]` |
| `navigator.connection` | `yes` [A, E.4a] | `no` [A, E.4a] | `no` [A, E.4a] | `no` [A, E.4a] | `yes` [A, E.4a] | `probe` `[I]` | `no` `[I]` | `probe` `[I]` |

**Web Locks is the youngest of the three coordination APIs and is still universal.**
Chrome 69, Firefox 96, Safari 15.4, all mirrored to their mobile counterparts (`[V]` S15 08-08).
`BroadcastChannel` is `y` on every latest tracked version (`[V]` S14 08-08).
Both are probed into `report.coordination` (`src/platform/browser/environment.ts:48`) and neither has a consumer yet.
That is fine while there is one tab, and it stops being fine the moment the outbox or the sync adapter runs in two tabs of the same profile, which is a realistic demo action.

**The two compute signals are degenerate on exactly the runtimes where we most need them.**
`hardwareConcurrency` on Safari and Safari iOS is documented as clamped: "the value of this property is clamped to 4 or 8 cores" (`[V]` S19 08-08).
`deviceMemory` does not exist on Firefox or on any WebKit runtime, and on Chromium it is quantised to {2, 4, 8, 16, 32} on desktop and {1, 2, 4, 8} on Android from Chrome 147 (`[V]` S19 08-08).
So on every Apple runtime, two of the three inputs to `scoreTier()` are either absent or clamped, and the third is `pointerCoarse`.
An M4 iPad Pro and a 2019 iPhone SE can therefore land on the same tier for the same reason: they are both touch devices whose engine will not say how much memory they have.
The scoring already refuses to read absence as the floor (`gradeMemory` returns 1 for null, `src/platform/capability.ts:247`), which is the right call and is why this is a limitation rather than a bug.
But it means pointer type is doing most of the work on WebKit, and pointer type is a device category wearing a capability's clothes.
Recorded as P-4, with the fix being a measured signal rather than a better guess.

---

## 6. Input and interaction

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| `pointer` / `any-pointer` / `hover` queries | `yes` [S20 08-08] | `yes` [S20 08-08] | `yes` [S20 08-08] | `yes` [S20 08-08] | `yes` [S20 08-08] | `yes` [S20 08-08] `[I]` | `probe` [S20 08-08] `[I]` | `probe` [S20 08-08] `[I]` |
| a hover capable pointer is present | `probe` [S20 08-08] | `probe` [S20 08-08] | `probe` [S20 08-08] | `probe` [S20 08-08] | `probe` [S20 08-08] | `probe` `[I]` | `probe` `[I]` | `probe` `[I]` |
| a physical keyboard is present | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` | `unknown` |
| directory drop (`webkitGetAsEntry`) | `yes` [S12 08-08] | `yes` [S12 08-08] | `yes` [S12 08-08] | `yes` [S12 08-08] | `yes` [S12 08-08] | `yes` [S12 08-08] `[I]` | `probe` [S33 08-08] | `probe` [S33 08-08] |
| a drop gesture actually exists | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `probe` `[I]` | `unverified` `[I]` | `yes` `[I]` | `unverified` `[I]` | `unverified` `[I]` |
| multi file picker (`input multiple`) | `yes` [S13 08-08] | `yes` [S13 08-08] | `yes` [S13 08-08] | `yes` [S13 08-08] | `probe` [S13 08-08] | `yes` [S13 08-08] `[I]` | `probe` `[I]` | `probe` `[I]` |
| async clipboard write | `yes` [S21 08-08] | `yes` [S21 08-08] | `yes` [S21 08-08] | `yes` [S21 08-08] | `yes` [S21 08-08] | `probe` [S21 08-08] `[I]` | `probe` `[I]` | `probe` `[I]` |
| `100dvh` and `env(safe-area-inset-*)` | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `probe` [C 06-08] | `probe` [C 06-08] | `yes` `[I]` | `probe` [C 06-08] | `probe` [C 06-08] |
| Screen Wake Lock | `yes` [S23 08-08] | `yes` [S23 08-08] | `yes` [S23 08-08] | `yes` [S23 08-08] | `yes` [S23 08-08] | `probe` [S23 08-08] `[I]` | `probe` `[I]` | `probe` `[I]` |

**Keyboard presence is not detectable, and that is not a gap in our probe.**
There is no web API that answers "is there a physical keyboard", so every cell is `unknown` and the row exists to make the consequence explicit.
An iPad with a Magic Keyboard is a real keyboard on a runtime that may report `pointer: coarse`, and a Windows touchscreen laptop is a real keyboard that reports `pointer: fine` only while a mouse is attached.
Therefore: keyboard affordances are never gated on pointer type, shortcuts are never the only path to an action (`docs/02-caveats-review.md` H1.1), and a coarse pointer removes hover, not keys.

**Pointer queries are live in CSS and stale in a cached probe.**
`pointer`, `any-pointer`, `hover` and `any-hover` are `y` on every latest tracked version (`[V]` S20 08-08).
`pointerCoarse` is read once at boot (`src/platform/browser/environment.ts:30`) and cached in the report for the session, which is correct for a logic decision that must not change mid batch and wrong for an interface decision.
A trackpad attached to an iPad, or a mouse unplugged from a laptop, changes the honest answer without changing our cached one.
The rule that follows: interaction affordances come from CSS media queries and live `matchMedia` listeners, and the cached probe value is only ever an input to logic.

**Directory drop has API presence everywhere and a usable gesture in far fewer places.**
`webkitGetAsEntry` is Chrome 13, Edge 14, Firefox 50, Safari 11.1, with Chrome Android and Safari iOS mirrored (`[V]` S12 08-08), and notably Firefox Android only at 141 (`[V]` S12 08-08).
Our probe reads `'webkitGetAsEntry' in DataTransferItem.prototype` (`src/platform/browser/environment.ts:50`) and passes the result straight into `createBrowserFilePicker(canReadDirectories)` (`src/platform/browser/runtime.ts:202`), which is correct as *logic*: if a drop happens, we can walk it.
It is not a licence to render a "drag a folder here" affordance on a phone, and `FilePicker.supportsFolders()` returning true is exactly the value a template would be tempted to bind that affordance to.
Recorded as P-8.
The folder walker itself is right where it matters: `readEntries` returns at most 100 entries per call and `walkEntry` drains it in a loop (`src/platform/browser/runtime.ts:278`), which is the difference between reading a camera card and silently truncating one.

**Multi file selection is `a` on Chrome Android, not `y`.**
caniuse's note is about Android 4.x and 5.x and is plainly dated (`[V-]` S13 08-08), so the partial value is recorded as `probe` rather than promoted to `yes`.
Independently, and already verified: on iOS the file input's `accept` filter is unreliable and `capture` would remove the library option entirely, so the correct attributes are `accept="video/*,.mov,.mp4"` plus `multiple` and never `capture` (`[V-]` C 06-08).

**Clipboard write is universal and can still fail.**
`y` on every latest tracked version, with Chromium requiring the `clipboard-write` permission and Safari gating *reads* behind a user selected Paste affordance (`[V]` S21 08-08).
We only ever write, for the diagnostics blob the creator copies to the manager (`docs/02-caveats-review.md` C9.1 item 36), so the failure mode is a rejected promise rather than a permission wall.
A copy button whose only path is `navigator.clipboard.writeText` must therefore fall back to selectable text, or the one affordance that exists for an undebuggable device is itself undebuggable.

**`dvh` and safe area insets are used in one place and not in the others.**
`src/App.vue:154` sets `min-height: 100dvh` with no `vh` fallback, `src/app/editor/ClipSheet.vue:889` uses `max-height: 70dvh`, and there is no `env(safe-area-inset-*)` anywhere in the tree.
The bottom anchored controls that `docs/02-caveats-review.md` C9.1 item 23 names as the two places where this is unusable rather than merely ugly, the sticky approve and reject bar and the creator's submit button, do not exist yet.
Recorded as P-9 so it is closed with those surfaces rather than after them.

---

## 7. Lifecycle, transfer, and secrets

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| background tab survives | `no`, freeze then discard [S34 08-08] | `unknown` | `no` [C 06-08] | `no` [C 06-08] | `no` [S34 08-08] | `yes` `[I]` | `no` `[I]` | `no` `[I]` |
| discard is observable (`freeze`, `wasDiscarded`) | `yes` [S34 08-08] | `unknown` | `unverified` `[I]` | `unverified` `[I]` | `probe` [S34 08-08] | `probe` `[I]` | `unverified` `[I]` | `unverified` `[I]` |
| `download` attribute | `yes` [S22 08-08] | `yes` [S22 08-08] | `yes` [S22 08-08] | `yes` [S22 08-08] | `yes` [S22 08-08] | `yes` [S22 08-08] `[I]` | `probe` `[I]` | `probe` `[I]` |
| large file save without buffering it | `yes` [S11 08-08] | `no` [S11 08-08] | `no` [S11 08-08] | `no` [S11 08-08] | `no` [S11 08-08] | `probe` [S11 08-08] `[I]` | `no` `[I]` | `no` `[I]` |
| OS backed secret storage | `no` [A, C3.1] | `no` [A, C3.1] | `no` [A, C3.1] | `no` [A, C3.1] | `no` [A, C3.1] | `yes` [S28 08-08] | `unknown` [S32 08-08] | `unknown` [S32 08-08] |

**Background loss is the normal case, and only Chromium lets you see it happen.**
"A page is in the discarded state when it is unloaded by the browser in order to conserve resources. No tasks, event callbacks, or JavaScript of any kind can run in this state", with `freeze` and `resume` events from Chrome 68 and `document.wasDiscarded` on desktop Chrome (`[V]` S34 08-08).
On WebKit there is no equivalent signal in any source I found, so those cells are `unverified` and the handling cannot depend on being told.
The design that works without the signal is already specified: never drive the batch loop from a timer, persist per file rather than per batch, mark in flight work `interrupted` on `pagehide` and `visibilitychange`, and resume behind a visible action rather than silently (`docs/02-caveats-review.md` C9.1 items 16 and 31).
Chrome's own recommendation matches: persist dynamic state when going from hidden to frozen (`[V]` S34 08-08).

**Downloading an original is two different capabilities.**
The `download` attribute is universal (`[V]` S22 08-08), and it requires the bytes to exist as a Blob or a URL first.
Streaming straight to a user chosen path needs `showSaveFilePicker`, which is Chromium desktop only (`[V]` S11 08-08).
So on every other column the editor's "give me the original" action materialises a multi hundred megabyte Blob in memory to hand to an anchor, which is the same ceiling that kills an iOS tab (`[V-]` C 06-08).
That makes "download the original" a capability with a real per runtime difference, and A, G2.2 already treats local and future object store downloads as different paths.

**Secrets: the browser has nowhere to put one, and that is the point.**
`createBrowserSecretStore('proxy')` (`src/platform/browser/runtime.ts:342`) holds a caller supplied credential in memory for the session and never writes it anywhere, because a key in `localStorage` is a key in a backup and Safari would discard it in seven days anyway (`[V]` S24 08-08 for the seven days).
Electron is the only column with a real answer: `safeStorage`, where `isEncryptionAvailable()` returns true if Keychain is available on macOS, after `ready` on Windows, and after `ready` plus an available secret key on Linux (`[V]` S28 08-08).
The Linux caveat has to be carried into any shell design: "if no secret store is available, items stored in using the safeStorage API will be unprotected as they are encrypted via hardcoded plaintext password", detectable because `getSelectedStorageBackend()` returns `basic_text` (`[V]` S28 08-08).
A desktop shell that reports "key stored securely" on a Linux box with no keyring would be lying, and the mode returned by `SecretStore.mode()` is where that distinction has to live.
For Capacitor, `@capacitor/preferences` is UserDefaults on iOS and SharedPreferences on Android and is documented as not a database (`[V]` S32 08-08); it is not secure storage and no first party Capacitor keychain plugin is in our dependency set, so those cells are `unknown` rather than `yes`.

---

## 8. Shell identity and document origin

| capability | Blink desktop | Gecko desktop | WebKit macOS | WebKit iOS | Blink Android | Electron shell | Cap iOS | Cap Android |
|---|---|---|---|---|---|---|---|---|
| shell is identifiable without a user agent | `yes` [A, C3] | `yes` [A, C3] | `yes` [A, C3] | `yes` [A, C3] | `yes` [A, C3] | **`no`** [S27 08-08] | `probe` [S29 08-08] `[I]` | `probe` [S29 08-08] `[I]` |
| document scheme | `https:` `[I]` | `https:` `[I]` | `https:` `[I]` | `https:` `[I]` | `https:` `[I]` | `capacitor-electron:` [S30 08-08] | `capacitor://localhost` [S29 08-08] | `https://localhost` [S29 08-08] |
| storage origin shared with the browser build | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `no` [S30 08-08] `[I]` | `no` [S29 08-08] `[I]` | `no` [S29 08-08] `[I]` |
| secure context for OPFS and workers | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `yes` `[I]` | `unverified` `[I]` | `probe` [S29 08-08] `[I]` | `probe` [S29 08-08] `[I]` |
| local transcode available | `no` [A, E.4b] | `no` [A, E.4b] | `no` [A, E.4b] | `no` [A, E.4b] | `no` [A, E.4b] | `probe` [S26 08-08] | `unknown` | `unknown` |

**The Electron shell cannot currently identify itself to our own probe.**
`detectShell()` returns `'electron'` when `globalThis.process?.versions?.electron` is truthy (`src/platform/browser/environment.ts:64`).
"Context isolation has been enabled by default since Electron 12, and it is a recommended security setting for all applications", and the documented way to expose anything to the page is `contextBridge.exposeInMainWorld` (`[V]` S27 08-08).
With the default and recommended configuration, `process` is not reachable from the renderer's world, so the probe returns `'browser'` inside the desktop shell.
Everything downstream then behaves as a browser: `transcode()` keeps rejecting, the eviction ladder stays on, and the one thing the shell exists to fix stays broken while the diagnostics blob says `browser`.
`@capacitor-community/electron` does not expose node integration or context isolation as config options, so this is decided in generated shell code rather than in `capacitor.config.ts` (`[V]` S30 08-08).
Recorded as P-3.

**Capacitor identifies itself and changes the origin while doing it.**
`detectShell()` reads the injected `Capacitor` global and `isNativePlatform()` (`src/platform/browser/environment.ts:66`), which is the right shape.
The defaults it will be running under: `server.iosScheme` is `capacitor`, `server.androidScheme` is `https`, `server.hostname` is `localhost`, and the iOS scheme "can't be set to schemes that the WKWebView already handles, such as http or https" (`[V]` S29 08-08).
The desktop shell's default is `customUrlScheme: 'capacitor-electron'` (`[V]` S30 08-08).
Two consequences, both real and neither handled:

1. **Storage identity.** A different scheme is a different origin, so IndexedDB and OPFS written in the browser build are unreachable from a shell build and vice versa. Export and import snapshot is the only migration path between them, which is another reason A, B.2 calls it mandatory rather than a debug affordance.
2. **Secure context.** Capacitor's own guidance is to keep the hostname as `localhost` because it "allows the use of Web APIs that would otherwise require a secure context" (`[V]` S29 08-08), which implies WebKit's trustworthiness check is satisfied by the host rather than the scheme. That is a documented implication and not a documented guarantee, so the cell is `probe` and the code must treat a missing OPFS in a shell as a first class state rather than an impossibility.

Our probe records `loadScheme` (`src/platform/browser/environment.ts:20`) and warns only for `file:` (`src/platform/capability.ts:143`).
A `capacitor-electron:` or `capacitor:` origin produces no warning at all, so a shell with a broken storage identity looks identical to a healthy browser tab.
Recorded as P-5.

---

## Where the code already handles the difference, and where it does not

| difference | probe field | code site | mechanism | gap |
|---|---|---|---|---|
| codec support | `codecs[key].decode` | `probeCodec()`, `src/platform/capability.ts:185` | `decodingInfo` first, `canPlayType` second, `hvc1` and `hev1` both asked, `'maybe'` reported as `unknown` and never promoted | authoritative `no` can be overridden by a weaker `probably` (P-2) |
| representative decode config | n/a | `buildDecodingInfo()`, `src/platform/browser/environment.ts:93` | asks at 1080x1920, 4 Mbps, 30 fps, the shape creators deliver | a second query at a lower resolution would separate "no decoder" from "not at this resolution" |
| no codec API at all | `warnings` | `probeCodec()`, `src/platform/capability.ts:217` | returns `unknown`, pushes a warning | warning is never rendered (P-10) |
| extractor availability | `extractor` | `src/platform/capability.ts:129`, `allowedAdapters()`, `src/media/extract.ts:726` | three rung chain, rung three is a descriptor and never a stored artefact | `requestVideoFrameCallback` is not probed, so the presented frame wait cannot be chosen from a capability |
| undecodable input | n/a | `extractFrames()`, `src/media/extract.ts:454` | `decodable === 'no'` refuses before any decode attempt, with a named headline and remedy | none |
| no transcoder | n/a | `createBrowserMediaCodecs()`, `src/platform/browser/runtime.ts:146` | rejects with `Unsupported('transcode', 'no_transcoder_in_browser')` and an explanation | no caller yet, so nothing renders the refusal |
| OPFS absent | `storage.opfs` | `src/platform/browser/index.ts:44`, `createUnavailableByteStore()`, `src/platform/browser/bytes.ts:146` | falls back to a store that refuses with `Unsupported(..., 'no_opfs')`, app still boots | presence is probed, writability is not (P-1) |
| OPFS open failure | n/a | `openOpfsDirectory()`, `src/platform/browser/bytes.ts:41` | throws `Unsupported` when `getDirectory` is missing | any other rejection propagates out of `createBrowserPlatform()` and fails boot (P-11) |
| partial write | n/a | `put()`, `src/platform/browser/bytes.ts:84` | aborts the writable and removes the entry, so a truncated original never looks whole | none |
| quota unavailable | `storage.estimate` | `createBrowserQuotaMonitor()`, `src/platform/browser/runtime.ts:295` | `available: false` and nulls, never zero | `requestPersistence()` has no caller anywhere (P-6) |
| quota display | n/a | `StorageView.vue:13` | shows used, quota, tier, persisted, all as data attributes | shows no warnings, no extractor, no shell, no codec answers (P-10) |
| folder drop | `input.directoryDrop` | `createBrowserFilePicker()`, `src/platform/browser/runtime.ts:202` | flat file list when directories are unreadable, `readEntries` drained in a loop | `supportsFolders()` is API presence, not a drop gesture (P-8) |
| camera card noise | n/a | `classify()`, `src/platform/browser/runtime.ts:183` | filters sidecars, proxies and system files, reports what was ignored | none |
| no worker | `tierInputs.cappedBy` | `scoreTier()`, `src/platform/capability.ts:235` | caps the tier rather than rescoring, and the reason is recorded in the policy | none |
| absent compute signals | `tierInputs` | `gradeMemory()`, `src/platform/capability.ts:247` | absence scores the middle, never the floor | pointer type carries the tier on WebKit (P-4) |
| thermal throttling | `policy.downgrades` | `downgradePolicy()`, `src/platform/capability.ts:423` | downgrade only, never upgrade mid batch, reason recorded | nothing measures the first clip yet, so the mechanism has no trigger |
| shell identity | `shell` | `detectShell()`, `src/platform/browser/environment.ts:56` | feature presence only, no user agent read | invisible in a default secure Electron renderer (P-3) |
| engine identity | `engineHint` | `detectEngine()`, `src/platform/browser/environment.ts:81` | diagnostics only, derived from feature presence so it cannot become a decision by accident | none, and this is the right shape |
| broken storage origin | `loadScheme` | `src/platform/capability.ts:143` | warns for `file:` | silent for every custom shell scheme (P-5) |
| coordination | `coordination` | `src/platform/browser/environment.ts:48` | both probed | no consumer, so a second tab is unserialised (P-12) |
| secret custody | `secrets.mode()` | `createBrowserSecretStore()`, `src/platform/browser/runtime.ts:342` | session only, never stored, never logged | no `ipc` or `native` implementation exists, which is correct for this build |

---

## Defects and gaps this matrix exposes

Format per `docs/AGENTS.md`.
Every one of these has at least one case in `qa/cases/platform.md`.

### P-1 OPFS presence is probed, OPFS writability is not
- Target(s): WebKit macOS (Safari 15.2 to 25), WebKit iOS (15.2 to 18.x), Cap iOS on those OS versions.
- Failure: `report.storage.opfs` is true, a real `createOpfsByteStore()` is built, and the first `put()` calls `FileSystemFileHandle.createWritable()`, which does not exist. The result is a `TypeError`, not an `Unsupported`, so no reason code reaches the record and no named state reaches the user.
- Trigger: a manager or creator on Safari 18 or earlier retains an original, which is the default path for any clip inside `maxLocalOriginalBytes`.
- Impact: the creator sees a failure with no explanation on the surface that must never do that, and the manager sees an asset whose bytes silently never arrived. Affects all three roles on WebKit.
- Verified: `createWritable` is Safari 26, `getDirectory` is Safari 15.2, `createSyncAccessHandle` is Safari 15.2 (MDN BCD `api/FileSystemFileHandle.json` and `api/StorageManager.json`, checked 2026-08-08), confirmed independently by the WebKit blog "WebKit Features in Safari 26.0" describing the File System WritableStream API as new in 26.0 (checked 2026-08-08).
- Fix: add `hasOpfsWritable` to `ProbeEnvironment` reading `typeof FileSystemFileHandle !== 'undefined' && typeof FileSystemFileHandle.prototype.createWritable === 'function'`, and make `report.storage.opfs` mean writable rather than present. Keep the raw presence as a separate field for diagnostics. The correct second rung, not required for this build, is a worker plus `createSyncAccessHandle`, which has been in WebKit since 15.2 and would restore originals on those runtimes.
- Blind: yes for the device, no for the API. The absence can be asserted in a unit test with a fake environment today.

### P-2 An authoritative decode denial is overridden by a weaker positive
- Target(s): all browser columns, and it matters most on Blink desktop without an HEVC decoder.
- Failure: in `probeCodec()` (`src/platform/capability.ts:190`) the guard is `if (sawAnswer && !env.canPlayType) return { decode: 'no' }`. When `decodingInfo` answers cleanly that nothing is supported and `canPlayType` exists, which it does in every real browser, the function proceeds to `canPlayType` and will return `decode: 'yes'` on a `'probably'`. The comment above the fallthrough says it is there for rejections, and the code also takes it for clean denials.
- Trigger: any codec where the two APIs disagree. HEVC on Chromium is the case designed to disagree, because `decodingInfo` reflects the hardware decode path that `[V]` S26 says is the only path.
- Impact: `codec_playable` reads `yes`, extraction is attempted rather than refused, and the honest "no preview: HEVC, this browser has no decoder" state at `src/media/extract.ts:459` is bypassed. The blank frame guard catches the pixels, so this does not fabricate tags, but it does turn a clean refusal into a slow failure and it does put a wrong badge on the clip.
- Verified: read from the code. The API semantics are `[V]` S5 and S6, checked 2026-08-08. Whether Chromium's `canPlayType` returns `'probably'` for `hvc1` without a hardware decoder is `unverified` and is what decides the severity, not the existence, of this defect.
- Fix: track `decodingInfoAnswered` separately from `sawAnswer`. If `decodingInfo` answered for every query and none was supported, return `no` when `canPlayType` agrees and `unknown` when it disagrees, never `yes`, and push the disagreement into `warnings`. `unknown` is the right disagreement value because `src/media/extract.ts` attempts `unknown` under the blank frame guard and refuses `no`.
- Blind: no.

### P-3 The desktop shell cannot identify itself to the probe
- Target(s): Electron shell.
- Failure: `detectShell()` needs `process.versions.electron`, which is not exposed to the renderer under the default and recommended `contextIsolation: true`.
- Trigger: running the shell as configured by `@capacitor-community/electron` without a preload that deliberately exposes an identity.
- Impact: `report.shell` is `browser` inside the desktop app, so the one capability the shell exists to add stays refused, the eviction ladder stays on, and a diagnostics blob from the shell is indistinguishable from one from a tab. Affects manager and editor, since the creator surface is browser only forever.
- Verified: Electron docs, "Context Isolation", contextIsolation default true since Electron 12 and `contextBridge` as the supported exposure mechanism, checked 2026-08-08. `@capacitor-community/electron` "Config Options" does not expose node integration or context isolation, checked 2026-08-08.
- Fix: the shell's preload calls `contextBridge.exposeInMainWorld('__shell__', { id: 'electron', electron: process.versions.electron, chrome: process.versions.chrome })`, and `detectShell()` reads that namespaced object first, keeping the `process` check only as a legacy path. The shape stays "feature presence, never a user agent".
- Blind: yes. Cannot be run here, and the failure is observable the first time someone launches the shell and reads the storage panel.

### P-4 Pointer type carries the ingest tier on every WebKit runtime
- Target(s): WebKit macOS, WebKit iOS, Cap iOS, and Gecko desktop for the memory half.
- Failure: `scoreTier()` averages three signals. On WebKit, `deviceMemory` is absent so it scores the middle by design, and `hardwareConcurrency` is clamped to 4 or 8 so it cannot separate a phone from a workstation. What is left is `pointerCoarse`, an input capability being used as a compute capability, which is a device category by another name.
- Trigger: every WebKit session.
- Impact: an M4 iPad Pro and a five year old iPhone can resolve to the same tier, and the artefacts stored from them are then compared as if they were comparable. Editors and managers see contact sheets whose resolution reflects a pointer rather than a machine.
- Verified: Safari clamp and the Chromium quantisation, MDN BCD `api/Navigator.json`, checked 2026-08-08. That absence must score the middle is already settled in `docs/01-architecture-review.md` E.4a, so the scoring is not wrong, the evidence is thin.
- Fix: add one measured signal so the tier stops resting on a proxy. A bounded synthetic benchmark at boot (scale a known raster N times, take wall clock from the injected clock) gives a comparable number on every runtime, and the existing `downgradePolicy()` already accepts a measured downgrade mid batch. Until that exists, record `tierInputs` in `delivery.ingest_policy` so a sheet can be re-derived later, which `docs/01-architecture-review.md` E.4a already requires.
- Blind: partly. The clamp cannot be observed here, the scoring behaviour can.

### P-5 A custom shell scheme produces no warning
- Target(s): Electron shell, Cap iOS, Cap Android.
- Failure: the probe warns only when `loadScheme === 'file:'`. A `capacitor-electron:`, `capacitor:` or `https://localhost` origin is a different storage origin from the deployed browser build, and the probe says nothing.
- Trigger: any shell build.
- Impact: a user who moves from the browser to the shell finds an empty library and no explanation, which reads as data loss. The real answer, export and import, is never offered because nothing knows the origin changed.
- Verified: scheme defaults from Capacitor "Configuration" and `@capacitor-community/electron` "Config Options", both checked 2026-08-08.
- Fix: extend the warning in `src/platform/capability.ts:143` to any scheme that is not `http:` or `https:`, naming the scheme and saying that data in this origin is separate and that a snapshot import is how to bring records across.
- Blind: no for the warning, yes for the shell behaviour.

### P-6 Nothing ever asks for persistence, and the panel offers no action when it is absent
- Target(s): all browser columns, most severely WebKit.
- Failure: `QuotaMonitor.requestPersistence()` exists (`src/platform/browser/runtime.ts:320`) with zero callers, and `StorageView.vue` renders "Storage persisted: no" with no action beside it. The sentinel record, the "data may have been cleared" screen, and export and import that `docs/01-architecture-review.md` B.2 makes mandatory are all absent from the tree.
- Trigger: seven days without interaction on WebKit, or ordinary disk pressure anywhere.
- Impact: total, silent loss of the demo dataset and of any real work, whole origin at once. Every role.
- Verified: the WebKit seven day rule and whole origin eviction, MDN "Storage quotas and eviction criteria", checked 2026-08-08.
- Fix: call `requestPersistence()` from the first meaningful interaction, record the boolean, and make the panel's `no` carry one sentence and one button (export a snapshot). Then the sentinel plus the cleared screen, which are twenty lines each and convert the worst failure into a handled one.
- Blind: no.

### P-7 The local byte budget ignores the reported quota
- Target(s): Cap iOS first, every column second.
- Failure: `maxLocalOriginalBytes` comes from the tier alone (`src/platform/capability.ts:318`), so `ample` means 2 GB whether the runtime reported 600 GB of headroom or 9 GB.
- Trigger: a Capacitor iOS build on a small device, where the allowance is about 15% of disk rather than about 60%.
- Impact: writes that fail mid batch instead of a batch that was never started, and on the runtime with the least room and the least observability.
- Verified: the ~15% figure for non browser WebKit apps, MDN "Storage quotas and eviction criteria", checked 2026-08-08.
- Fix: `deriveIngestPolicy()` takes the quota report as a hint and clamps `maxLocalOriginalBytes` to a fraction of remaining headroom, recording the clamp in `downgrades` the same way the large batch reduction already is.
- Blind: yes for the shell, no for the clamp.

### P-8 `supportsFolders()` is API presence, and a template will read it as an affordance
- Target(s): WebKit iOS, Blink Android, both Capacitor columns.
- Failure: `hasDirectoryDrop` is `'webkitGetAsEntry' in DataTransferItem.prototype`, which is true on a phone, and `FilePicker.supportsFolders()` returns it verbatim.
- Trigger: the creator upload page binding a "drop a folder here" affordance to `supportsFolders()`.
- Impact: a creator on a phone is told to do something the OS gives them no way to do, on the one surface with no support channel.
- Verified: `webkitGetAsEntry` version floors including mirrored mobile values, MDN BCD `api/DataTransferItem.json`, checked 2026-08-08. That a phone has no folder drop gesture is `[I]`.
- Fix: keep `supportsFolders()` as the logic answer and never bind copy to it. The affordance is gated on a hover capable, fine pointer in CSS, and the picker button is always present. If a drop arrives anyway, it is still walked.
- Blind: partly.

### P-9 `dvh` has no fallback and safe area insets are absent
- Target(s): WebKit iOS, Cap iOS, Cap Android.
- Failure: `src/App.vue:154` uses `min-height: 100dvh` with no preceding `vh` declaration, `src/app/editor/ClipSheet.vue:889` uses `70dvh`, and no rule anywhere uses `env(safe-area-inset-*)`.
- Trigger: an engine without `dvh`, or any notched device once a bottom anchored control exists.
- Impact: today, a layout that collapses on an old engine. Once the sticky approve and reject bar and the creator submit button exist, a control under the home indicator or under the browser chrome, which is unusable rather than ugly.
- Verified: the requirement and its reasoning are already verified in `docs/02-caveats-review.md` C9.1 item 23, 2026-08-06. Per engine `dvh` support was not re-verified in this pass and is `unverified` here.
- Fix: a `vh` declaration before every `dvh` declaration, and `padding-bottom: env(safe-area-inset-bottom)` on every bottom anchored container, added with those surfaces rather than after them.
- Blind: yes for the notch, no for the CSS.

### P-10 The probe computes warnings that nothing renders
- Target(s): every column, and it is the reason the other findings stay invisible.
- Failure: `probeCapabilities()` builds a `warnings` array for no extractor, no OPFS, a `file:` origin and no storage estimate (`src/platform/capability.ts:119` to `151`), and no component reads it. `StorageView.vue` shows tier, quota and persisted only.
- Trigger: any degraded runtime.
- Impact: a capability that is absent has no named state the user can see, which is a defect by the standing rule even though the code handles the absence correctly.
- Verified: read from the tree.
- Fix: render `report.warnings` in the storage panel as a list, alongside `shell`, `engineHint`, `extractor` and the four codec answers, and make the whole thing the copyable diagnostics blob that `docs/02-caveats-review.md` C9.1 item 36 requires on the creator page as well.
- Blind: no.

### P-11 An OPFS open failure fails boot instead of degrading
- Target(s): WebKit private browsing, any locked down profile, and both Capacitor columns.
- Failure: `createBrowserPlatform()` awaits `openOpfsDirectory()` inside the `report.storage.opfs` branch (`src/platform/browser/index.ts:44`). `openOpfsDirectory()` throws `Unsupported` for a missing `getDirectory`, and any other rejection, a `SecurityError` or a quota error, propagates out of platform construction and out of `boot()`.
- Trigger: a runtime where `getDirectory` exists and rejects. Private browsing is the likely case.
- Impact: a blank screen at boot rather than an app with no local originals, on exactly the unusual runtime we most needed to learn about. Every role.
- Verified: read from the tree. That WebKit private browsing rejects `getDirectory` is `unverified` `[I]`.
- Fix: wrap the call, fall back to `createUnavailableByteStore()`, and push a warning naming the rejection. The probe already refuses to throw for the same reason, so this is the same rule applied one layer out.
- Blind: partly.

### P-12 Coordination is probed and unused, so a second tab is unserialised
- Target(s): all columns.
- Failure: `report.coordination.broadcastChannel` and `.webLocks` have no consumer. The outbox and the future sync adapter run per tab with no cross tab lock.
- Trigger: a reviewer opening the demo in two tabs, which the role switcher makes a natural thing to do.
- Impact: duplicate outbox work, and interleaved writes to one profile's database. Manager and editor.
- Verified: Web Locks and BroadcastChannel are universal on current versions, MDN BCD `api/LockManager.json` and caniuse `broadcastchannel.json`, both checked 2026-08-08. So the capability is there and the gap is ours, not the platform's.
- Fix: hold a named Web Lock around the outbox drain, fall back to a `BroadcastChannel` election when locks are absent, and when neither exists refuse the drain in the second tab with a visible "another tab is syncing" state rather than racing.
- Blind: no.

---

## Where this contradicts an earlier verified finding

Two, both stated here rather than quietly corrected.

**1. `requestVideoFrameCallback` in Gecko.**
`docs/02-caveats-review.md` C3.1 and C9.1 item 7 record it as "supported in Chrome and Safari and not in Firefox `[V]`", verified against caniuse on 2026-08-06.
MDN browser compat data `api/HTMLVideoElement.json` gives Firefox 132 and Firefox for Android 132, checked 2026-08-08, which overrides it.
Consequence: the `requestAnimationFrame` fallback in the extraction sequence is no longer the Gecko path, it is only the path for a runtime that reports the callback absent, and the probe should report it so the sequence can choose rather than assume.
The fallback stays, because an engine that lacks it must still work.

**2. The iOS Safari quota figure.**
`docs/01-architecture-review.md` B.2 says "iOS Safari is the constraint: historically about 1GB per origin".
MDN "Storage quotas and eviction criteria", checked 2026-08-08, gives about 60% of total disk for WebKit browser apps and about 15% for non browser WebKit apps such as embedded web views.
`docs/02-caveats-review.md` C7.1 already carries the newer figures, so the two documents already disagreed and this resolves it: the 1 GB number is historical, the constraint on modern iOS is not the browser quota, it is the seven day eviction rule and the per tab memory ceiling.
The design target in B.2, comfortable to 1,000 clips and honest degradation beyond, is unaffected, because it was never quota bound at 170 KB per clip.

**3. Electron's quota, flagged rather than contradicted.**
`docs/01-architecture-review.md` B.4 gives the Electron quota ceiling as "free disk, no origin quota".
An Electron renderer is Chromium, so MDN's ~60% of disk applies to its IndexedDB and OPFS (`[V]` for the figure, `[I]` for the application, since no shell has been built).
Only the Node `fs` path escapes it, which B.4 also describes, so the row is imprecise rather than wrong, and the correction matters only for whether the eviction ladder may be switched off in the shell.

---

## What we write blind, per unverifiable target

Named so that a real failure later arrives as something observable rather than mysterious.

### WebKit iOS, shipped and never device tested

Written blind: the whole extraction sequence in `docs/02-caveats-review.md` C3.2 and the 38 item list in C9.1, the gesture continuity, the blank frame validation, the single reused video element and canvas, the strict serial batch, the object URL discipline, and the timeouts on every wait.
The runtime must report: `extractor`, the four codec answers, `storage.opfs` (writability once P-1 is fixed), `estimate`, `persist`, `pointerCoarse`, and the first real file's outcome as `first_extraction_result` with its reason code and elapsed ms.
How a real failure surfaces: an enumerated reason code on the file record, rendered in plain language, plus a copyable diagnostics blob on the creator page itself, since the creator is the person on the device we cannot debug.
What would falsify our handling: a frame extracted without a gesture where we assumed one was needed (harmless, we tried anyway), or a batch that dies with no reason code at all (that is the real bug, and it means a wait exists without a timeout).

### Blink Android, shipped and never device tested

Written blind: nothing specific to Android except the jank assumption and the WebView version scepticism.
The runtime must report: `hardwareConcurrency`, `deviceMemory`, `extractor`, and the WebView or Chrome version in the diagnostics blob, because "works on my Pixel" and "fails on that Samsung" is a version question and nothing else will answer it.
How a real failure surfaces: a `constrained` tier on a device that should be `standard`, visible in the storage panel, and slow per file timings in the recorded instrumentation.

### Electron shell, designed and configured only

Written blind: shell identity (P-3), `safeStorage` custody with the Linux `basic_text` caveat, the bundled ffmpeg transcode executor from `docs/01-architecture-review.md` E.4b, and the assumption that the renderer keeps Chromium's storage behaviour.
The runtime must report: `shell: 'electron'` from a `contextBridge` value, the Chromium and Electron versions, `getSelectedStorageBackend()` where `safeStorage` is used, and whether HEVC decode answered yes, since Electron >= 22 only helps where the hardware path exists.
How a real failure surfaces: the storage panel says `browser` in a packaged app, which is the single observable that catches P-3 on first launch.
What would falsify the design: an Electron build whose Chromium lacks the proprietary codec set, which would make even H.264 a `probe` rather than a formality.

### Capacitor iOS and Android, designed only

Written blind: everything.
The runtime must report: `shell`, `loadScheme` (and its warning, P-5), the quota estimate under the ~15% allowance on iOS, and whether OPFS is writable, because a WebView on iOS 18 has OPFS without `createWritable`.
How a real failure surfaces: an empty library on first launch of the shell, which P-5's warning turns from "the app lost my data" into "this is a separate storage origin, import a snapshot".
What we know changes in our favour: Capacitor's WKWebView configuration removes the user gesture requirement for media playback (`[V]` S31 08-08), so a green extraction result in the shell is not evidence about Safari and must not be read as such.
