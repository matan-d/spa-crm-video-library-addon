# Manual checklist

Everything that cannot be asserted by a test in this build, with what a human would have to do.

This file exists so coverage is never implied.
A case that lands here is not a case that was skipped: it is a case whose evidence needs hardware, a runtime, or a service this build deliberately does not have.
Each entry names the case, why it is here, what a human does, and what the pass condition is.

Owners write into their own section.
`media-pipeline` owns section 1.
`platform-matrix` owns section 2.
`ai-contract`, `tenancy-guard` and `loop-integrity` add their own sections as their tracks land.

Style: no em dashes and no en dashes, and a new line after each sentence ending period.

---

## 1. Media pipeline

### 1.1 Blocked on the decode adapters, not on hardware

These are the cases that become automatable the moment the two decode adapters exist (`docs/media-pipeline.md` 7.6).
They are listed here rather than in the runnable set because there is currently no way to produce a real decoded frame in this repository, and pretending otherwise would be the exact failure this pipeline exists to prevent.

| case | what a human does | pass condition |
|---|---|---|
| QC-MEDIA-018 | open the creator link in Chrome, upload `vertical_ok.mp4`, look at the sheet | five tiles at the `standard` tier, five visibly different moments (the travelling white box and the burned in timecode both move), and the recorded `extractor_path` is on the sheet |
| QC-MEDIA-035 | upload `rotated_90.mp4` and look at the tiles | each tile is portrait shaped and the burned in label reads upright. Sideways text is a doubled rotation or a missed one |
| QC-MEDIA-034 | upload `rotated_90.mp4` and read the recorded `rotation_source` | it is `element_applied` or `we_applied`, never absent, and the tiles are upright either way |
| QC-MEDIA-070 | upload `vertical_ok.mp4` and `duplicate_of_vertical_ok.mp4` as one delivery | the second reads `duplicate: fail` pointing at the first, with a per frame Hamming distance inside 4. **This is also the moment `expected_phash_prefix` can stop being null in the manifest** |
| QC-MEDIA-064 | upload `no_metadata.mp4` | a real sheet and poster exist although the container carries no creation time and no location |
| QC-MEDIA-100, QC-MEDIA-101 | upload `long_ok.mp4` and `vertical_ok.mp4` at each tier | 7 and 5 tiles at `ample`, 6 and 5 at `standard`, 3 and 3 at `constrained`, matching `expected_frames.by_tier` |
| QC-MEDIA-104 | upload `short_fail.mp4` at `ample` | five tiles are still produced, and where two land on the same decoded frame nothing in the interface or in an AI prompt calls them distinct moments |
| QC-MEDIA-112 | upload `photo_still.jpg` | the still is its own sheet, a poster exists, and `duplicate` is `pass` rather than `unknown` |
| QC-MEDIA-129 | upload a deliberately truncated clip | every wait ends inside its ceiling (8s metadata, 5s per seek) and the row names its own failure reason. The batch continues |
| QC-MEDIA-144 | upload the whole engineered set with the memory panel open | no growth in retained bitmaps or object URLs across the batch |
| QC-MEDIA-145 | upload a batch whose first clip is slow enough to blow the extraction budget | the tier drops for the rest of the batch, the new tier is recorded on the sheets it shaped, and nothing upgrades again until the next batch |
| QC-MEDIA-128 | shoot a variable frame rate clip (many phone camera apps in low light) and upload it | duration comes from the container and is cross checked against the decode pass, `fps` is recorded as nominal, and the frames still land inside `tolerance.frame_t_seconds` |

### 1.2 Blocked on hardware or a runtime this build does not have

| case | what a human needs | what they do | pass condition |
|---|---|---|---|
| QC-MEDIA-036 | an iPhone | shoot a portrait clip in the camera app, upload it through the public creator link on iOS Safari, then compare the sheet against what Photos shows | `orientation: pass`, upright tiles, `rotation_source` recorded. iOS 18 has open reports of browser recorded video carrying no orientation information at all (C4.2.2), so if the sheet is sideways the manual rotate control is the fallback and must be present |
| QC-MEDIA-050 | a Mac, an iPhone, or Windows with the HEVC Video Extension from the Microsoft Store | upload `hevc.mov` | `codec_playable: pass` and a real sheet, so the same fixture takes a different path per runtime and `runtime_dependent: true` on that manifest entry is a fact rather than a hedge |
| QC-MEDIA-146 | a real Android or iOS device | ingest 20 clips of 10 to 30 seconds in one batch and watch the device get warm | the recorded `policy_tier` per sheet changes mid batch, the batch completes, and no clip is dropped |
| the Apple `keys` plus `ilst` provenance path | a real iPhone clip | upload it and read `captured_at_source` | it is `apple_quicktime`, and the GPS comes from `com.apple.quicktime.location.ISO6709`. ffmpeg cannot write this form, so the only coverage today is a hand built block in `tests/media/atoms.spec.ts` (QC-MEDIA-152) and this path has never seen a real file |
| a rotated HEVC clip, which is the actual iPhone default | an iPhone | shoot in High Efficiency and upload | on a runtime with an HEVC decoder: upright tiles and `orientation: pass`. On the reference runtime: no sheet, and the honest degradation of QC-MEDIA-048 |
| a HEIC still | an iPhone shooting in High Efficiency | upload a photo | Chromium on Windows: `no_heif_parser`, no invented dimensions, and the Most Compatible instruction shown. Safari: it renders, and this build still refuses to read it, which is a stated limit rather than a bug (QC-MEDIA-153) |
| the byte budget at real scale | a 1.8GB ProRes clip | upload it | the original is not written to OPFS, `media_state: bytes_absent` with `over_local_byte_budget`, and the sheet still exists. The decision is unit tested with a synthesised size; only a real file exercises the OPFS refusal (QC-MEDIA-085, QC-MEDIA-127) |

### 1.3 Things a test could never prove, recorded so nobody assumes otherwise

- **That `hevc.mov` is refused by a browser for the reason we claim.** The manifest records `codec_playable: fail` with `no_decoder_in_shell` on the reference runtime. The machine that built the fixtures cannot prove `VideoDecoder.isConfigSupported` returns false for that specific file, nor that Safari returns true. That is `platform-matrix`'s question and it is why the support answer is injected into the rule engine rather than computed inside it.
- **That the synthetic fixtures say anything about framing, light, subject or room.** They are colour bars with a travelling box and a timecode. Any AI judgement about their content is a fabrication rather than an error, and the AI layer must be exercised against the seed library's real imagery.
- **That the visit window is right for a creator in another timezone.** It is interpreted in UTC because the branch timezone is not available to the pre-flight layer. The consequence is bounded and stated in `docs/media-pipeline.md` 8.5, and a human in San Jose shooting at 23:00 local is still inside a 24 hour window.

---

## 2. Platform, shells and devices

Owner: `platform-matrix`.
Cases live in `qa/cases/platform.md`, findings in `docs/platform-matrix.md` and `docs/09-shell-notes.md`.

Everything in 2.2 and 2.3 needs an artefact that does not exist: a built shell.
Nothing in this repository can produce one, because `@capacitor/cli` and `@capacitor-community/electron` are not installed and `npx cap add` has never been run (`docs/06-decisions.md` U4 and U6).
These are not slow tests, they are tests with no subject, and that distinction is the reason they are written down rather than left implied.

### 2.1 Real devices, browser build

The runnable half of the matrix ends at the edge of this machine.
These need hardware.

| case | what a human needs | what they do | pass condition |
|---|---|---|---|
| QC-PLAT-041 | a real iPhone on iOS 18 or later | open the deployed creator link, pick one HEVC clip and one H.264 clip from the camera roll, let pre-flight finish, then use the diagnostics copy control | the H.264 clip produces a contact sheet, the HEVC clip produces either a sheet or a named refusal depending on what the probe reported, no file sits at "analysing" forever, and the pasted blob carries the codec answers, the extractor and a reason code per file. Record the iOS version, whether Low Power Mode was on, and the elapsed time per file |
| QC-PLAT-042 | a device on macOS Safari 18 or iOS 18, which has OPFS and no `createWritable` | retain an original locally, then open the storage panel | the app states that originals cannot be kept on this device and keeps working from posters and sheets. A `TypeError` in the console, or a spinner that never resolves, fails this. Record the Safari version first, because the case is meaningless without it. This is the observable that confirms the P-1 probe change |
| QC-PLAT-043 | Safari with cross site tracking prevention on, and eight days | seed the library, do not open the app for eight days, then open it | either the data is present, or the "data may have been cleared" state appears naming browser storage cleanup. An empty library with no explanation fails. Screenshot whatever appears, with the date of the previous visit |
| QC-PLAT-048 | a mid range Android phone that is not a current flagship | run pre-flight on a batch of ten clips | the tier in the storage panel matches the device class, per file progress stays visible, and the diagnostics blob carries per file timings. Record the device model and the Android System WebView version from its Play Store listing |

### 2.2 The shells, blocked on a build that has never happened

| case | what a human needs | what they do | pass condition |
|---|---|---|---|
| QC-PLAT-044 | a built Electron shell | launch it and open the storage panel | it reads `electron`, not `browser`. If it reads `browser` there is now also an origin warning saying the scheme claims a shell and no shell identified itself, which means the preload contract in `docs/09-shell-notes.md` 5.1 was not applied. Record the Electron and Chromium versions. This is the first launch check for P-3 |
| QC-PLAT-045 | the built shell on a Linux box with no keyring | read the reported secret mode at startup | it does not claim a key is protected. The documented fallback encrypts with a hardcoded plaintext password and is detectable as `basic_text`, so anything reading as "stored securely" fails this case |
| QC-PLAT-046 | a Capacitor iOS or Android build, after using the browser build on the same device | install the shell and launch it | the library is empty **and the app says why**, naming the separate storage origin and offering a snapshot import. A silent empty library fails. On Android expect this to fail today: the scheme is `https:`, so the scheme shaped warning does not fire, which is P-16 |
| QC-PLAT-047 | a Capacitor iOS build and mobile Safari on one device with little free disk | read and record `storage.estimate()` in mobile Safari, install the shell, read and record it there, then attempt a retention larger than the shell's headroom | the shell figure is materially smaller than the Safari figure, roughly a quarter of it, and the retention is refused before it is attempted rather than failing mid write. Closes the device half of P-7 |
| QC-PLAT-054 | a built Electron shell | open the storage panel and read `storage.opfs` | it is true. False means `capacitor-electron:` was not registered as a secure and standard scheme, which silently turns the one target with a real filesystem into the one target that cannot keep an original. This is the highest value single reading on first launch, and it is `unverified` in `docs/09-shell-notes.md` section 2 item 3 |
| QC-PLAT-055 | a Capacitor iOS build and a device driven close to full | fill the device to near capacity with photos or video, use the app, then reopen it a day later | either the library is intact, or the app detects its data went away and says so. Capacitor's own storage guide says the OS reclaims WebView storage under pressure and that `persist()` is not the remedy on iOS, so the expected result today is silent, total loss. This is P-13, and it is the case that decides whether this target ships at all |

### 2.3 The configuration itself, which only a device can confirm

Each row checks a value written into `capacitor.config.ts` from documentation, never from observation.

| what is being checked | what a human needs | what they do | pass condition |
|---|---|---|---|
| `server.errorPath` is reached for an old WebView (P-15, QC-PLAT-056) | an Android device or emulator whose System WebView is below 107 | install the shell and launch it | the unsupported WebView page appears, naming Android System WebView and offering the browser as the alternative. A white screen fails. That `errorPath` covers this case at all is a secondary source claim, so this reading is what turns it into a fact |
| the WebView floor is not set too high | an Android device with a current WebView | launch the shell | the app starts normally. A floor above what the fleet actually runs would block working devices, and 107 is derived from Vite's baseline rather than measured on hardware |
| `adjustMarginsForEdgeToEdge: 'auto'` (P-9, QC-PLAT-057) | an Android 15 device | launch the shell and look at the bottom of any scrolling view | content clears the gesture bar. **Then check again after the CSS safe area insets land:** the native margin and the CSS padding stack, and the observable is doubled empty space at the bottom. That is the signal to move the option to `disable` |
| iOS safe area (P-9) | a notched iPhone | open the app in the shell and in mobile Safari, side by side | the same layout in both, with nothing under the home indicator. `ios.contentInset` is `never`, so if the shell looks right and Safari does not, the CSS is missing and something native is compensating |
| the launch background colour | any device in dark mode | cold start the shell | a light coloured frame appears briefly before the app paints. Expected, and unfixable from configuration: the native background is one static colour while the app follows `prefers-color-scheme`. Recorded here so it is not filed as a bug |
| `includePlugins: []` | a synced project | run `npx cap sync` and read what it reports | zero Capacitor plugins are copied. If a plugin appears, something pulled it in transitively and it is now serving a capability the browser build cannot have, which forks the product |

### 2.4 Things no test in this repository can prove, shells edition

- **That any of this configuration is syntactically accepted by the Capacitor CLI.** The CLI is not installed. `capacitor.config.ts` sits outside `tsconfig.json`'s `include`, so `npm run typecheck` does not even parse it, which is deliberate: a green typecheck must not be able to imply a working shell.
- **That the desktop shell can be added at all.** `@capacitor-community/electron` is unmaintained and pinned to a Capacitor major two behind the current CLI (P-14). The first command in `docs/09-shell-notes.md` section 7 may simply fail, and nothing here would know.
- **That WKWebView behaves like Safari.** No published dataset covers WKWebView parity, which is why every Capacitor cell in the matrix reads `probe`. A green result in a shell is evidence about that shell and nothing else.
- **That an iPhone WKWebView decodes HEVC.** It almost certainly does, since HEVC is a system codec on iOS and WKWebView is system WebKit. It remains an inference, it must still be probed at runtime, and it is worth less than it sounds: the creator, who is the person holding the HEVC file, is browser only forever, and mobile Safari on that same phone already decodes it. See `docs/09-shell-notes.md` 5.6.
