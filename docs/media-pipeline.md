# Media pipeline

Owner: `media-pipeline`.
The question this document answers: given these bytes, is everything we claim to know about them actually true, and is everything we do not know marked as unknown?

Status: **B1 and the derivation layer are complete.**
The fixtures and their ground truth exist (sections 1 to 5), and so do the parser, the still reader, the extraction chain, the perceptual hasher, the four state pre-flight engine and the byte state machine (sections 6 to 9).

One thing is deliberately absent and is the next task in this track: the two decode adapters that touch the DOM.
The chain, the frame plan, the composition, the caps, the hashing, the blank detection and the fallback logic are built and asserted against fake adapters; the twenty lines that create a `<video>` element or configure a `VideoDecoder` are not written, because jsdom cannot run either and writing them here would produce the least trustworthy code in the pipeline with no automated coverage at all.
**No contact sheet has been produced by this code yet.** See 7.6.

---

## 1. Why the fixtures came first

A parser developed against files it also defines will agree with itself about a rotation matrix it has misread, and nothing will fail.
So the order is: build the files, read their facts back with an independent tool, write down what our own code must derive, commit all of it, and only then write the code that has to satisfy it.

Two blocks per fixture, and the split is the whole point.

| block | meaning | who it tests |
|---|---|---|
| `declared` | what ffmpeg was instructed to produce, then read back out of the container with `ffprobe` and a narrow header peek. Ground truth by construction, and the build fails if the file disagrees | ffmpeg. Not interesting |
| `expected_preflight` | what our client code must independently derive from the bytes, later, with no help from the generator | our parser. The only interesting assertion |

Measured values inside `expected_preflight` (a duration in seconds, a distance in metres) are filled in by the builder from the probe, because those are facts about the bytes.
Statuses and reason codes are hand authored in `scripts/fixtures.config.mjs`, because a machine that derives the expectation the same way the parser will derive the answer proves nothing.
The builder then cross checks the hand authored statuses against the bytes and refuses to build if they disagree, so a wrong hand authored expectation cannot sit there invisibly.

`tolerance` is mandatory on every entry, not defensive.
Frame timing and perceptual hashes are not bit exact across browsers and codec builds, so exact equality is the wrong assertion rather than a stricter one.
A test that fails for reasons unrelated to correctness teaches the team to ignore it, and an ignored test is worse than a tolerant one.

### Commands

```
npm run fixtures                 build anything missing or changed, then verify all
npm run fixtures -- --force      re-encode everything, fail on any hash drift
npm run fixtures -- --only rotated_90
npm run fixtures:verify          re-read the committed bytes and check them against the manifest
npm test                         includes tests/fixtures/manifest.spec.ts, offline, no ffmpeg
```

`npm run fixtures` is idempotent: a second run encodes nothing and reports `unchanged 16`, but still re-verifies every file, so a fixture edited by hand between runs cannot survive a build.
`--force` re-encodes everything and exits non zero if any sha256 changed, naming each changed fixture, because a silent byte change quietly redefines what every downstream test means.
Verified on this build: a forced re-encode of all 16 fixtures is byte identical.

Fixtures are generated locally and committed, never generated in CI.
Two ffmpeg builds do not produce byte identical output, which would break the reproducibility the hashes exist to guarantee.

---

## 2. Fixture inventory

16 files, 4.5MB committed, in `public/fixtures/`, described by `public/fixtures/manifest.json`.
Every clip carries a burned in label with the fixture id, its declared spec, and a live timecode, so a human watching the demo can name what is on screen and can see that five sheet tiles are five different moments.

All statuses below are for the reference runtime recorded in the manifest: **Chromium on desktop Windows with no HEVC Video Extension**, which is the reviewer's machine and the runtime in which the E.4b hole is live rather than hypothetical.

### 2.1 The engineered set, 13 files

| fixture | container | codec | coded | rot | dur | bytes | moov | non-pass rules |
|---|---|---|---|---|---|---|---|---|
| `vertical_ok.mp4` | mp4 | `avc1`+`mp4a` | 1080x1920 | 0 | 6.0s | 200KB | start | none, 7 pass |
| `horizontal_fail.mp4` | mp4 | `avc1`+`mp4a` | 1920x1080 | 0 | 6.0s | 192KB | start | `orientation: fail` |
| `short_fail.mp4` | mp4 | `avc1`+`mp4a` | 1080x1920 | 0 | 1.5s | 49KB | start | `min_duration: fail` |
| `lowres_fail.mp4` | mp4 | `avc1`+`mp4a` | 480x854 | 0 | 6.0s | 105KB | start | `min_resolution: fail` |
| `offdate_fail.mp4` | mp4 | `avc1`+`mp4a` | 1080x1920 | 0 | 6.0s | 204KB | start | `capture_date: fail` |
| `rotated_90.mp4` | mp4 | `avc1`+`mp4a` | 1920x1080 | **90** | 6.0s | 200KB | start | none, 7 pass |
| `hevc.mov` | mov | `hvc1`+`mp4a` | 1080x1920 | 0 | 4.0s | 114KB | **end** | `codec_playable: fail`, `duplicate: unknown` |
| `no_metadata.mp4` | mp4 | `avc1`+`mp4a` | 1080x1920 | 0 | 6.0s | 204KB | **end** | `capture_date: unknown`, `near_branch: unknown` |
| `duplicate_of_vertical_ok.mp4` | mp4 | `avc1`+`mp4a` | 1080x1920 | 0 | 6.0s | 216KB | start | `duplicate: fail` |
| `prores.mov` | mov | `apcn`, no audio | 1024x576 | 0 | 3.5s | 1627KB | **end** | `orientation: fail`, `min_resolution: fail`, `codec_playable: fail`, 3 unknown |
| `largesize_mdat.mp4` | mp4 | `avc1`+`mp4a` | 1080x1920 | 0 | 2.0s | 71KB | start | `min_duration: fail` |
| `long_ok.mp4` | mp4 | `avc1`+`mp4a` | 1080x1920 | 0 | 20.0s | 581KB | start | none, 7 pass |
| `photo_still.jpg` | jpeg | `mjpeg` | 1080x1920 | n/a | n/a | 51KB | n/a | `min_duration: skipped`, 2 unknown |

Across the engineered set: 72 `pass`, 10 `fail`, 8 `unknown`, 1 `skipped`.
All four states are real in data, which is what keeps the grey dash render path from shipping untested.

### 2.2 The preview clips, 3 files

`preview_01.mp4`, `preview_02.mp4`, `preview_03.mp4`: 1080x1920, 5s, pleasant synthetic gradients, 197KB to 329KB.
They exist for the preview player and the library grid, carry no engineered defect, and pass every rule.

Their names deliberately claim nothing about their content.
A synthetic gradient named `preview_sauna_steam` would be a fabricated content claim that could leak into a tag index and be searched for later, which is the same class of defect as asking a model to tag a clip it cannot see.
These clips depict no room and no subject, and any AI room or subject claim about them is a fabrication rather than an error.

### 2.3 What each fixture proves

**`vertical_ok.mp4`** is the happy path, and its job is to make the other fixtures interpretable.
Every rule passes, so a fixture that fails a rule fails it for exactly one reason.

**`horizontal_fail.mp4`** fails `orientation` and only `orientation`.
That required a design decision: `min_resolution` is evaluated orientation neutrally, short display edge against 1080 and long display edge against 1920, rather than width against `min_width` and height against `min_height`.
Without that, a landscape 1920x1080 clip would trip both rules from a single defect, and a fixture that trips two rules cannot tell you which rule is broken.

**`short_fail.mp4`** fails `min_duration` at 1.5s against a 3s minimum, and nothing else.

**`lowres_fail.mp4`** fails `min_resolution` at 480x854 while still reading as vertical, which is the mirror of `horizontal_fail` and the other half of the proof that the two rules are independent.

**`offdate_fail.mp4`** is the only `capture_date: fail` in the set, shot two days before the visit.
Without it the plus or minus 24 hour window from C5.2.3 is only ever tested from the passing side, and a window that is accidentally infinite passes every test.
It is also the fixture that proves the date rule is advisory: `rollup.blocking_fail` is 0, so the clip still uploads.

**`rotated_90.mp4`** is the most valuable fixture in the set.
Coded 1920x1080, tkhd display matrix `[0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824]`, which reduces to a,b,c,d of 0, 1, -1, 0, which is 90 degrees clockwise for display, which is byte for byte the matrix a portrait iPhone clip carries.
Display orientation is 1080x1920 vertical while coded dimensions are landscape.
A parser that reads coded dimensions and stops tells a creator their correct vertical footage is horizontal, and that is the difference between accepting and rejecting real work.
Every rule passes, so a failure on this fixture can only be the matrix.

Three details make it a fair test rather than a lucky one.
First, the rotation is applied as a container remux with `-c copy`, so the coded frames are byte identical to the unrotated encode and the only difference in the file is the matrix.
Second, the content is generated at the display size with an upright label and then rotated in the pixels, exactly as a phone does it, so the label reads upright only when rotation was honoured: sideways text in the player or in a sheet tile is the visible signature of a missed or doubled rotation.
Third, the build does not trust the `-display_rotation` flag.
It reads the four matrix words back out of `tkhd` and fails the build if they are not exactly right, because a flag that silently did nothing would produce precisely the fixture that hides the bug it exists to catch.

**`hevc.mov`** is the open hole in E.4b, live rather than simulated.
It proves three separate things: that the codec is read from the `stsd` fourcc rather than from the `.mov` extension, that the metadata layer is complete with no decoder at all (atom parsing reads bytes, so `orientation`, `min_duration`, `min_resolution`, `capture_date` and `near_branch` all resolve while only the pixel layer fails), and that the absence of a sheet is represented as absence.
It is also the only fixture carrying the QuickTime `©xyz` ISO 6709 location atom and a `udta/©day` with a real timezone offset, and one of three carrying `moov` after `mdat`.

**`no_metadata.mp4`** is honest degradation.
Its mvhd creation field is literally `0`, which is the interesting case rather than a convenience: a parser that applies the 1904 epoch to a zero field reports a capture date of 1904-01-01, which is worse than reporting nothing.
`ffprobe` omits `creation_time` entirely when it is zero, which is why the manifest records the raw field and the verifier checks it directly.

**`duplicate_of_vertical_ok.mp4`** is re-encoded from `vertical_ok.mp4` itself at a different quantiser, so the sha256 differs and the frames match.
A byte hash cannot find this and a perceptual hash must.

**`prores.mov`** is the camera offload, and it is the fixture that makes `unknown` real.
A mirrorless body has no GPS receiver, so `near_branch` is `unknown` with reason `no_gps_atom_camera_has_no_receiver` and must never be `fail`.
Rendering that as a red cross fails a creator for owning better equipment, which is a product defect and not a strict rule.
ProRes `apcn` also decodes in no browser at all, which is a stronger statement than the HEVC case: `runtime_dependent: false`, where `hvc1` is `true`.
It has no audio track, which covers that parser path too.

**`largesize_mdat.mp4`** covers the 64 bit atom size path (`size == 1` followed by an 8 byte largesize).
Real files only take that form above 4GB, which cannot be committed, so the builder rewrites the 8 byte `free` atom that ffmpeg already reserves in front of `mdat` into a 16 byte 64 bit `mdat` header.
The mdat payload keeps its absolute offset, so every `stco` entry stays valid and the file still decodes, which `ffprobe` confirms.
The clip is 2s to keep it small, so it legitimately fails `min_duration`; the QA case asserts the parsed duration rather than the verdict.

**`long_ok.mp4`** is the tier ceiling case, and no shorter fixture reaches it.
Under the resolved formula (4.5) a 6 second clip already produces 5 frames at `ample`, so the `1x5` layout is covered several times over.
What only a 20 second clip covers is the top of the range: the duration term saturates, so this is the one fixture producing a `1x7` sheet at `ample` and a `1x6` at `standard` while a phone still does exactly 3, which is the widest tier spread in the set and the only place the ceiling itself is exercised.

**`photo_still.jpg`** is the only fixture where a rule is `skipped` rather than `unknown`.
A photo has no duration to check, and "this does not apply" reads differently to a human than "we could not tell".
It is also the not-a-movie input: the container walker must return a reason rather than throwing when handed bytes that are not ISO BMFF.

### 2.4 Four fixtures added beyond the C2.D set, and why

`offdate_fail`, `largesize_mdat`, `long_ok` and `photo_still` are not in the C2.D table.
Each is flagged `added_beyond_c2d: true` in the manifest and asserted as such in the test, so the addition is reviewable rather than quietly absorbed.

| added | without it |
|---|---|
| `offdate_fail.mp4` | `capture_date: fail` has no fixture anywhere, so the visit window is only tested from the passing side |
| `largesize_mdat.mp4` | the 64 bit atom size branch the charter explicitly requires has nothing to assert against at any size |
| `long_ok.mp4` | no fixture saturates the duration term, so the tier ceilings are never reached: `1x7` at `ample` and `1x6` at `standard` have nothing to assert against, and the widest tier spread in the set (3 against 7) does not exist |
| `photo_still.jpg` | `skipped` never appears, so the fourth state is legal but not real, and its render path ships untested |

---

## 3. Constants the fixture set pins down

Recorded in `manifest.context` so no test hardcodes them.

| constant | value | source |
|---|---|---|
| visit date | `2026-08-04` | C2.D worked example |
| happy path capture instant | `2026-08-04T10:12:00Z` | C2.D worked example |
| branch | San Jose, 37.3382, -121.8863 | C2.D |
| `min_duration_s` | 3 | `brief_item` default |
| `min_short_edge_px` / `min_long_edge_px` | 1080 / 1920 | `brief_item` defaults `min_width` / `min_height` |
| `visit_window_hours` | 24 | C5.2.3 |
| `near_branch_radius_m` | **500** | new, see below |
| blocking rules | `orientation`, `min_duration`, `min_resolution` | A.19 |
| preflight version | 2 | A.19 |
| frame count | `clamp(3 + round(duration_s / 3), floor, ceiling)`, bounds 5 to 7 `ample`, 4 to 6 `standard`, 3 to 3 `constrained` | D2, and the code that owns it is `src/platform/capability.ts`. See 4.5 |

**One finding for whoever owns the schema.** `near_branch` needs a radius and no existing document sets one.
500m is wide enough for a multi building wellness site plus consumer GPS error and narrow enough that "8km from the branch" still fails.
It currently lives as a constant in a fixture generator, which is the wrong home.
It belongs as a column on `branch` or on `brief_item` next to `min_duration_s`, `min_width` and `min_height`.

---

## 4. What the generator could not reproduce faithfully on this ffmpeg build

Build: `ffmpeg 6.1.1-essentials_build-www.gyan.dev` from `ffmpeg-static`, with `--enable-libx264 --enable-libx265 --enable-libfreetype`.
`ffprobe` comes from `ffprobe-static`, because `ffmpeg-static` ships no ffprobe binary.

### 4.1 `hevc.mov` IS genuinely HEVC, stated plainly because it matters

This build has `libx265` compiled in, so no substitution was needed and none was made.
`hevc.mov` was encoded with `libx265` and muxed with `-tag:v hvc1`.
`ffprobe` reads it back as `hevc (Main)` with `codec_tag_string: hvc1` and `codec_tag: 0x31637668`, and both the builder and `npm run fixtures:verify` fail if that ever stops being true.
The manifest records `declared.codec_video: "hvc1"` and `declared.facts_verified: true`.

There is no H.264 file named hevc anywhere in this set.
If a future ffmpeg build lacks x265, the correct move is to fail the build loudly and record the substitution in the manifest, never to ship a mislabelled file, because a fixture that lies about its codec invalidates every conclusion drawn from it.

Unverifiable here, and it is a real limit rather than a nitpick: **whether a browser refuses this specific file for the reason we claim.**
We assert `codec_playable: fail` with `reason: no_decoder_in_shell` on the reference runtime, but the machine that built the fixtures has no way to prove a browser's `VideoDecoder.isConfigSupported` returns false for it, nor that Safari returns true.
That is `platform-matrix`'s question and it is marked `manual-only` in QC-MEDIA-050.

### 4.2 The Apple `keys` plus `ilst` metadata form cannot be written, so it has no fixture

This is the most consequential gap in the set.

The charter names `com.apple.quicktime.creationdate` and `com.apple.quicktime.location.ISO6709` as parser targets.
Those live in `moov/meta/keys` plus `ilst`, which ffmpeg's mov muxer does not write.
There is no flag for it, and passing a long key through `-metadata` does not produce it.

What the generator can produce, and what each fixture therefore carries:

| GPS form | atom | who writes it in the real world | fixture |
|---|---|---|---|
| QuickTime string | `moov/udta/©xyz`, ISO 6709 | iPhone, GoPro, DJI | `hevc.mov` |
| 3GPP | `moov/udta/loci`, 16.16 fixed point, **longitude first** | Android and many muxers, and what ffmpeg writes into mp4 | the 10 mp4 fixtures with GPS |
| Apple keys | `moov/meta/keys` plus `ilst` | iPhone, alongside `©xyz` | **none** |

Two consequences worth being explicit about.

First, `loci` was not in the original parser spec and is now required, because it is what our own mp4 fixtures carry and it is genuinely what a large share of real files carry.
Its field order is longitude, then latitude, then altitude, each signed 16.16 fixed point, and reading them latitude first produces a coordinate in the Atlantic.
QC-MEDIA-015 exists to catch exactly that.

Second, the iPhone provenance path (`com.apple.quicktime.*`) will be written blind, like the rest of the iOS handling in this build, and must be marked as such.
Closing the gap needs either a real iPhone clip or a hand injected `keys` plus `ilst` block into a trailing `moov`, which is tractable (a trailing `moov` can grow without moving `mdat`, so no `stco` offsets shift) and was deliberately not done in this task.

### 4.3 The other gaps, each with what would close it

| gap | why the generator cannot do it | what would close it |
|---|---|---|
| a rotated HEVC clip, which is the actual iPhone default | rotation must be verified on a file we can decode, so `rotated_90` is H.264. The real iPhone case combines both | a real iPhone clip. QC-MEDIA-036 and QC-MEDIA-050, `manual-only` |
| variable frame rate | ffmpeg's lavfi sources are constant frame rate, and a synthesised VFR clip would not be byte reproducible | a synthesised VFR input inside a unit test, QC-MEDIA-128 |
| 180 and 270 degree rotation | only 0 and 90 are in the set | two more `-display_rotation` remux variants, cheap to add if the matrix reduction table is ever suspect |
| non square pixels | every fixture is pinned to SAR 1:1 on purpose, see 4.4 | a dedicated anamorphic fixture, if anamorphic footage is ever in scope |
| a genuinely 4GB file, and the byte budget | cannot be committed | synthesised sparse `File` objects, QC-MEDIA-127 and QC-MEDIA-085 |
| a genuinely corrupt or truncated file | committing deliberately broken bytes is worse than slicing a good file at test time | `File.slice()` on a committed fixture, QC-MEDIA-122 and QC-MEDIA-123 |
| `mdat` larger than 4GB with a real 64 bit size | cannot be committed | `largesize_mdat.mp4` covers the header form at 71KB, which is the part the parser has to get right |
| a fragmented MP4 with `moof` boxes | out of scope for this task, and `-movflags +frag_keyframe` would produce a file whose duration reports as 0 or `Infinity`, which is a distinct case worth its own fixture later | one added recipe |
| the byte budget story on `prores.mov` | C2.D wants it "large enough to exercise the byte budget", and ProRes 422 at a committable size is 1.6MB, not 800MB | the byte budget is a synthesised-`File` test, not a committed fixture. Stated here so nobody reads 1.6MB as the intended scale |

### 4.4 One thing the generator got wrong first, kept here because the lesson is load bearing

The first build of `lowres_fail.mp4` failed its own verification with:

```
declared — tkhd carries 478.8785095214844x854 but coded dimensions are 480x854
```

`scale` preserves the display aspect ratio by adjusting the sample aspect ratio, so scaling a 120x214 pattern up to 480x854 left SAR at 1.00234, and ffmpeg then wrote 478.88x854 into `tkhd`.

That is not an ffmpeg bug, it is the specification: **`tkhd` width and height are the aspect corrected presentation size, not the coded size.** They coincide only at SAR 1:1.
Coded dimensions come from the `stsd` sample entry.

Two changes followed.
Every fixture is now pinned to square pixels with `setsar=1`, so coded and display dimensions coincide and a failing orientation test means the rotation matrix was misread rather than the pixel aspect ratio.
And the manifest records `tkhd_width`, `tkhd_height` and `sar` as separate declared facts, so the verifier compares facts instead of assuming the two are always equal.

The parser inherits the rule: **do not read coded dimensions out of `tkhd`.**

### 4.5 A spec contradiction the fixtures surfaced, now closed by D2

The fixtures surfaced a contradiction between two documents, and it is settled rather than open.
C2.D's worked example showed `expected_frames: { count: 5, t_seconds: [0.5, 1.6, 3.0, 4.4, 5.5] }` for a 6 second clip.
E.4a specified `frameCount = clamp(round(duration_s / 4), 3, tierMax)`, which gives **3** frames for a 6 second clip at every tier and only reaches 5 above about 14 seconds.
Both could not be right, and the manifest was following E.4a.

**The resolution, recorded in `docs/06-decisions.md` D2: capability sets the ceiling, duration sets the count within it.**

```
frameCount = clamp(3 + round(duration_s / 3), tier.frameFloor, tier.frameCeiling)
```

| tier | floor | ceiling | a 1.5s clip | a 6s clip | a 20s clip |
|---|---|---|---|---|---|
| `ample` | 5 | 7 | 5 | **5** | 7 |
| `standard` | 4 | 6 | 4 | **5** | 6 |
| `constrained` | 3 | 3 | 3 | **3** | 3 |

It closes the contradiction in favour of the C2.D worked example, and it does that while keeping duration scaling and while making the tier actually change the answer, which the old formula did not for anything under about 14 seconds.
Three frames is thin evidence for judging a clip against a brief item; five gives beginning, middle, end and two intermediates.
And a weak phone does exactly three frames whatever the clip length, because capability is a ceiling on work rather than a floor, and a long clip does not make a phone stronger.

**The single source of truth is `frameCountFor(durationSeconds, tier)` exported from `src/platform/capability.ts`, alongside `layoutFor()` and `TIER_PROFILES`.**
Nothing else in this build decides that number.
The fixture generator restates the formula exactly once, in `scripts/fixtures.config.mjs`, because it is plain Node ESM on Node 20 and cannot import a TypeScript module.
That restatement is not trusted: `assertFrameFormulaMatchesSource()` reads `capability.ts` as text before anything is encoded and fails the build with a named diff if the three floor and ceiling pairs or the duration term ever stop matching.
Two copies of this formula that can drift is exactly the failure being avoided, so the duplication is tolerable only because the build breaks the moment it becomes real.

What the manifest records now:

| field | content |
|---|---|
| `expected_frames.by_tier.<tier>` | `count`, `layout` and `t_seconds` for all three tiers on every fixture, because a test asserting extraction at a given tier needs the count for that tier |
| `expected_frames.formula` and `formula_source` | the formula and the module that owns it, so a reader of the manifest is pointed at the code rather than at a number |
| `manifest.context.frame_count` | the formula, the source, the D2 reference, the three tier bounds and the frame time spacing, recorded once so no test hardcodes a bound |
| `t_seconds` | recomputed from the new count and the measured duration, evenly spaced and skipping the first and last moments: `t_i = (i + 1) * duration_s / (count + 1)` |

`layout` is `null` rather than a made up value where there is no tiled sheet: on `photo_still.jpg`, which is its own single frame, and on `hevc.mov` and `prores.mov`, which have no frames at all.

Two consequences worth stating plainly.

`long_ok.mp4` is now the tier **ceiling** fixture rather than the only 5 frame fixture.
At 20s it is the only clip in the set whose duration term saturates every tier, so it is the only source of a `1x7` sheet at `ample` and a `1x6` at `standard`, and the only fixture whose tier spread is 3 against 7.

A short clip now plans frames closer together than the keyframe interval.
`short_fail.mp4` at 1.5s plans 5 frames a quarter second apart at `ample`, while the GOP on every fixture is half a second, so on the `<video>` plus canvas path two tiles can legitimately land on the same decoded frame.
That is a property of the extractor, not a licence to fabricate: the sheet records the frames it actually got, tile distinctness is only assertable where the planned spacing exceeds the GOP (QC-MEDIA-104), and near identical tiles must never be described as five distinct moments.

### 4.6 Content is synthetic, and the reason it is allowed to be here

The settled decision is that real licensed stock footage drives the seed library and synthetic ffmpeg patterns drive only the engineered pre-flight fixtures, where the content is irrelevant and the container is the point.
That holds here.

The engineered clips are SMPTE colour bars generated at a quarter size and upscaled, plus one white box travelling across the frame, plus a burned in timecode.
That combination is chosen for three reasons, and only one of them is size.
Bars are static after the first frame, which puts a 1080x1920 six second clip near 150KB instead of near 700KB.
Hard vertical colour edges give a perceptual hash real structure to hash, where a smooth gradient would produce a near degenerate dHash and make the duplicate fixture vacuous.
And the travelling box plus the timecode make five sheet tiles visibly five different moments, which is what a human actually checks a contact sheet for.

The honest limit: these are not photographs of a treatment room.
Any judgement about framing quality, light, subject or room made against these clips is meaningless, and the AI layer must be exercised against the seed library's real imagery instead.

---

## 5. Reference runtime, and where this document stops

`manifest.reference_runtime` is `chromium_desktop_windows_without_hevc_extension`.
Every committed status assumes it.
Rules whose answer moves with the runtime carry `runtime_dependent: true` and a note (only `codec_playable` and, downstream of it, `duplicate`).

That boundary is deliberate.
`media-pipeline` owns whether a derivation is correct.
`platform-matrix` owns where it runs and how it fails there, and gets every "is this supported here" question rather than having it answered in a fixture file.

---

## 6. The parser

Built. `src/media/atoms.ts` plus `src/media/bytes.ts` and `src/media/still.ts`, asserted by `tests/media/atoms.spec.ts` (48 cases) and `tests/media/still.spec.ts` (9 cases).

`parseContainer(input, options)` never throws.
A file it cannot understand comes back with `ok: false` and one of four named reasons, because one unparseable file must not take down a forty file batch.

### 6.1 Every field comes back as a `Fact<T>`

```ts
interface Fact<T> { value: T | null; confidence: Confidence; evidence: string; note?: string }
type Confidence = 'exact' | 'high' | 'medium' | 'low' | 'none'
```

`evidence` is an atom path, never free text, so an argument about a number is a lookup rather than a discussion.
A field with no evidence is `{ value: null, confidence: 'none', evidence: 'none' }`, never a plausible default, because a plausible default is what turns a missing atom into a false statement about somebody's footage.

| field | source | confidence | why not higher |
|---|---|---|---|
| `container` | `ftyp` brand | `exact` | brand `qt  ` is mov, anything else is mp4 |
| `duration_s` | `moov/mvhd` duration over timescale | `high` | a declaration rather than a measurement, and a fragmented file may legally say 0 |
| `coded` | `stsd` visual sample entry | `exact` | the only correct source, see D8 |
| `presentation` | `moov/trak/tkhd` | `exact` | exact about the presentation size, which is a different quantity from the coded size |
| `display` | coded, then `pasp`, then the `tkhd` matrix | `high` | a derivation in three steps, each exact, but doing them in the wrong order produces a plausible wrong answer on anamorphic footage |
| `display` (fallback) | `tkhd` only | `low` | no readable `stsd`, so this may differ from the coded size. The substitution D8 forbids doing silently, done loudly |
| `rotation_deg` | `tkhd` matrix a, b, c, d | `high` | reduced from four fixed point words to one of four quarter turns |
| `sample_aspect` | `stsd/pasp` | `exact` | |
| `codec_video`, `codec_audio` | `stsd` fourcc | `exact` | never the extension, never the browser MIME type |
| `codec_string` | `avcC` or `hvcC` payload | `high` | derived from the decoder configuration record, so `VideoDecoder.isConfigSupported` is asked about the profile the file actually contains |
| `has_audio` | `mdia/hdlr` per track | `exact` | |
| `captured_at` | `mvhd`, `udta/©day`, or the Apple key | `high` with a UTC offset, `medium` without, `low` when two sources disagree by over a minute | `mvhd` is defined as UTC and cameras routinely write local time into it |
| `gps` | `udta/loci`, `udta/©xyz`, or the Apple key | `exact` for the string forms, `high` for `loci` | `loci` is 16.16 fixed point, so about 15 microdegrees of quantisation, well inside consumer GPS error |
| `video_sample_table` | `stsc`, `stsz`, `stco`/`co64`, `stts`, `ctts`, `stss` | exact by construction | only populated when `sampleTables: true`, because only the decode path needs it |

`captured_at_candidates` keeps every source that produced an instant, so a disagreement between two of them is visible rather than resolved silently.
Precedence is: a source carrying a UTC offset beats one that does not, then Apple key beats `©day` beats `mvhd`.
The ranking is about ambiguity, not about accuracy: a camera clock with no timezone is evidence of a wall clock reading rather than of an instant.

### 6.2 The walk

Two walks, one budget.

**Top level**, `walkTopLevel`: hops atom headers reading 16 bytes per hop through the `ByteSource` interface, which on a `File` is `File.slice()`.
`mdat` is never read.
That is what makes a 4GB file cost nothing to inspect, and it is asserted: `bytes_read` is counted rather than estimated, and every fixture reads under its own file size and under 2MB.
A trailing `moov` is found by walking rather than by reading a prefix and hoping, which three committed fixtures require.

**Inside `moov`**, `buildAtomTree`: a recursive child walker producing an `AtomNode` tree, so reading a field is a path lookup instead of six nested loops.
`CONTAINER_ATOMS` is its vocabulary: those atoms hold a child list starting at the body.
Two irregular atoms are named separately rather than added to that set, because their children do not start at the body offset:

- `meta` is a FullBox in ISO BMFF and a plain box in QuickTime, so the child offset is sniffed rather than assumed. Both forms turn up in both containers, so branching on the brand would be wrong.
- `stsd` is a FullBox with an entry count, so its children start eight bytes in.

A sample entry (`avc1`, `hvc1`, `mp4a`) is deliberately **not** descended: its extensions begin after a fixed 78 or 28 byte body that differs by media type, and a generic descent would read the wrong four bytes as a box header.
Those are read by the specialised reader that knows which one it is looking at.
`facts.atom_paths` records every path reached, in container order, which is how "this file was walked as a tree" is checkable rather than asserted.

Bounds, all shared across both walks so they describe the file rather than a level: 2MB of bytes, 512 atom headers, depth 8.
`atoms_visited` on the committed set runs 26 to 54.

### 6.3 The five things that produce a confident wrong answer if you get them wrong

1. **Coded dimensions never come from `tkhd`** (D8). `tkhd` holds the aspect corrected presentation size, and the two coincide only at square pixels. Both are kept, under their own names, with their own notes.
2. **A zero `mvhd` creation field is absence, not 1904.** The epoch conversion applied to zero reports a capture date of 1904-01-01, which is worse than reporting nothing. Two committed fixtures carry a literal zero.
3. **`size == 1` means a 64 bit largesize follows and the header is 16 bytes.** A walker that hops by 1 byte here loops. `size == 0` means "to the end of the file"; treating it as zero length is the other way the walk becomes infinite.
4. **`loci` is longitude first.** Reading it latitude first puts the San Jose branch in the Atlantic. It is the form ffmpeg writes into mp4, so it is what ten of the committed fixtures carry.
5. **ISO 6709 latitude forms are distinguished by integer digit count.** Two digits is degrees, four is degrees and minutes, six is degrees, minutes and seconds. Ignoring that turns `+3720.15` into a coordinate 17 degrees off.

`plausibleCoordinate` also refuses exactly zero on both axes, because that is what every stripped or uninitialised GPS field produces and treating it as a fix would place footage in the Gulf of Guinea and then pass or fail a rule on it.

### 6.4 Named failure outcomes

| reason | when | what the caller does |
|---|---|---|
| `empty_file` | zero bytes | answered before anything else, no element, no timeout |
| `not_isobmff` | the first atom type is not a top level box | try the still reader, then give up. Never throw |
| `moov_not_found` | the walk ended without one, including a truncated download whose `moov` was at the end | every container rule is `unknown`, and the runtime is asked for duration and size instead |
| `metadata_unparseable` | absurd or inconsistent atom sizes, or a `moov` that yielded no `mvhd`, no duration and no track | same as above. Reporting `ok` with every field null would hand the caller a container to re-check field by field |

### 6.5 Stills

`parseStill` reads dimensions from the JPEG `SOF` marker, the PNG `IHDR` chunk, the GIF logical screen descriptor, or the WebP `VP8X`, `VP8 ` or `VP8L` chunk.
Header only, no decoder, which is what lets a jsdom test assert the real dimensions of the real committed fixture.

Two deliberate refusals.
There is no EXIF parser in this build: `exif_present` records that an APP1 Exif block was seen and nothing reads it, so a still's capture date is `unknown` with the reason `no_exif_parser_for_still_images`.
HEIF and HEIC are detected and refused by name with the remedy attached, because an iPhone shooting in High Efficiency writes `.HEIC`, Safari renders it and Chromium on Windows does not, and the same Most Compatible camera setting fixes both this and the HEVC video hole.

## 7. The extraction chain

Partly built. `src/media/extract.ts` and `src/media/phash.ts`, asserted by `tests/media/extract.spec.ts` (77 cases) and `tests/media/phash.spec.ts` (18 cases).
**The two decode adapters that touch the DOM are not written.** See 7.6, which states exactly what is missing and why it is a seam rather than a stub.

### 7.1 The three rungs

| rung | technique | frame accuracy | recorded as |
|---|---|---|---|
| 1 | WebCodecs `VideoDecoder` plus the sample table from the parser | frame accurate and deterministic: find the last sync sample at or before the target, feed forward from there | `extractor_path: 'webcodecs'` |
| 2 | `<video>` plus canvas: muted, `playsInline`, sometimes a `play()` then pause, awaiting `seeked` | approximate: a seek snaps to the preceding keyframe | `extractor_path: 'video-canvas'` |
| 3 | a described placeholder tile | no pixels at all | `extractor_path: 'placeholder'`, `sheet: null` |

The probe's answer is a ceiling rather than an instruction.
A runtime reporting `webcodecs` still gets the element path underneath it, because a particular file can fail in the decoder and succeed in the element.
A runtime reporting `video-canvas` is never handed a WebCodecs adapter, because the probe already established the API is absent.
A runtime reporting `none` gets rung three without any decode attempt.

**Rung three is a UI descriptor and never a stored artefact, and that reconciles two rules that look like they conflict.**
The charter asks for a placeholder tile so the interface never breaks on an undecodable file.
The no fabrication rule and `expected_derivatives` require that `hevc.mov` has no contact sheet and no poster at all.
Both hold: `PlaceholderTile` carries a `kind`, a `reason`, a headline, a remedy and the facts we do have, the interface renders it, `derivative_state` stays `none`, and there is no blob for anything to store or later hand to a model.
A grey tile written into the blob store as a contact sheet would eventually be described by a model, and a plausible tag on a clip nobody could decode is the least detectable and most damaging failure this product has.

### 7.2 What is recorded on every sheet

`extractor_path`, `extractor_version`, `policy_tier`, `phash_version`, `layout`, `tile_width`, `tile_height`, `frame_count`, `jpeg_quality`.
A sheet produced by a different extractor is different evidence, so a cached model run must not be reused across a version change, and a better extractor can re-derive an old sheet because the inputs that shaped it are all on the record.
`ExtractionResult.attempts` keeps every rung that was tried and why it failed, which is what makes "why is there no preview" answerable after the fact.

### 7.3 Rotation reconciliation, C4.2.1

`reconcileRotation(coded, rotationDeg, reported)` decides from what the element actually reported rather than from a browser name:

| reported size | decision | `rotation_source` |
|---|---|---|
| equals the display size | do not rotate, the engine already did | `element_applied` |
| equals the coded size | rotate by the matrix | `we_applied` |
| both, because coded is square | do not rotate, and say the question is undecidable | `undecidable` |
| neither | apply the matrix and record that the result is suspect | `we_applied` with a note |
| no rotation in the container | nothing to do | `not_needed` |

Sideways text in a tile is the visible signature of a doubled rotation or a missed one, and `rotated_90.mp4` is built with an upright burned in label so a human can see it.

### 7.4 Timeouts and enumerated failures, C1.2.2

Every media wait has a wall clock ceiling: 8s for metadata, 5s per seek, overridable per request.
Each distinct failure carries its own reason code, because "it failed" is not an outcome: `no_extractor`, `decode_unsupported`, `demux_unavailable`, `zero_duration`, `zero_dimensions`, `blank_frame`, `seek_timeout`, `metadata_timeout`, `no_frames_decoded`, `sheet_encode_failed`, `not_decodable_input`.

A blank frame is caught rather than shipped.
`isBlankFrame` samples a grid and refuses a frame with no alpha anywhere or no luma variance anywhere.
Blank frames are dropped with a diagnostic; if a rung produces nothing but blank frames it is treated as a failed rung and the next one is tried.
The variance floor is deliberately tiny, so a genuinely near black night shot is kept: this catches "the decoder gave us nothing" and never "this shot is dark".

### 7.5 Memory discipline, and why it is a correctness concern

Every decode attempt returns a `release()` that the chain calls in a `finally`, on every path out, including a thrown adapter.
Frames arrive already downscaled to `policy.frameLongEdge` and already upright, so nothing is ever drawn at native 4K.
The sheet is composed once at the final tile size rather than assembled large and resampled twice, and the cap on the long edge (D3, 1024px) is applied by shrinking the tile geometry before drawing.
Concurrency comes from the capability probe (`decodeConcurrency`), never from a device name, and a mid batch downgrade is available through `downgradePolicy` because a static probe cannot see thermal state.

The tests assert the balance rather than watching a memory graph: the fake adapters count allocations and releases, and the counts match across a single file, across a failure and a fallback, and across the whole engineered set.

### 7.6 What is deliberately not built, stated rather than implied

The `DecodeAdapter` interface is the seam, and the two implementations that touch the DOM are missing:

| missing | why it is not a stub | what it needs |
|---|---|---|
| the `<video>` plus canvas adapter | the chain, the plan, the composition, the caps, the hashing and the fallback logic are all here and tested. What is absent is the twenty lines that create an element, await `seeked`, draw to a canvas and read back pixels | a browser to run in. jsdom has no video decode and no canvas rasteriser, so writing it here would produce code with no automated coverage at all |
| the WebCodecs adapter plus demux | the sample table it needs is built and asserted (`stsc` through `stss`, sync sample indexes, composition times) | a real `VideoDecoder`. Written blind it would be the least trustworthy code in the pipeline, and it is the path that claims frame accuracy |
| `encodeJpeg`, `decodeStill`, `probeMedia` | one canvas call each | the same browser |

Consequence, stated plainly: **no contact sheet has been produced by this code yet.**
The seed library's committed sheets were produced by `scripts/build-seed-media.mjs` with ffmpeg, which is a different program.
Everything downstream of the sheet (`ai-contract`) must keep treating a sheet as absent until this is closed, which is exactly what the enqueue guard already does.

### 7.7 The perceptual hash

dHash over a 9 by 8 luma grid, 64 bits, 16 hex characters, most significant bit first.
Chosen over an average hash or a DCT hash for three reasons that matter here: it keys on horizontal structure rather than absolute brightness so it survives the exposure and quantiser differences a re-encode introduces, it needs no DCT so it is cheap on a phone, and its distances are interpretable, which an eigenvalue based distance is not.
The manifest's `tolerance.dhash_hamming` of 4 out of 64 is a number a human can reason about.

Two clips are compared position by position rather than by best match, because both plans put frame 3 at the same proportional moment, and a best match across positions would call any two clips duplicates as soon as they share one similar frame.
The headline number is the median of the per position distances, so one badly timed frame near a cut does not decide the answer either way.
`findDuplicate` returns the **earliest** match in the comparison set, because the rule's job is to point at the delivery the creator already made.

Measured, not assumed: a proportional rescale leaves the hash bit identical, and a non proportional rescale of a hard edged pattern moves it about two bits, inside the tolerance.
That is what makes a `constrained` tier sheet comparable against an `ample` one, and it is a measurement rather than a guarantee, which is one more reason `policy_tier` is on every sheet.

## 8. The pre-flight rules

Built. `src/media/preflight.ts`, asserted by `tests/media/preflight.spec.ts` (74 cases, every fixture against every rule) and by `tests/media/ingest.spec.ts` through the whole path.

`evaluatePreflight(subject, context)` is a pure function over three things: the facts derived from the bytes, the locked brief item's thresholds, and the branch.
No clock, no randomness, no platform read, no I/O.
The contract is `expected_preflight` in the committed manifest, and this section documents the function rather than inventing the contract.

### 8.1 The seven rules

| rule | decided from | evidence string | blocks |
|---|---|---|---|
| `orientation` | display size, which is coded plus `pasp` plus the matrix | `coded_dims+tkhd_matrix`, or `image_dims` for a still | yes |
| `min_duration` | `mvhd` duration, overridden by a decode measurement when they disagree | `mvhd` or `decode_pass` | yes |
| `min_resolution` | display size, short edge against 1080 and long edge against 1920 | `tkhd+stsd`, or `image_dims` | yes |
| `capture_date` | the winning capture candidate against the visit window | the candidate atoms, for example `mvhd+udta_day` | no, advisory |
| `near_branch` | haversine distance from the GPS fix to the branch | `udta_loci`, `udta_c_xyz`, `apple_quicktime` | never, structurally |
| `duplicate` | per frame dHash against the priors in the comparison set | `phash_over_delivery` | no, advisory |
| `codec_playable` | the `stsd` fourcc plus the platform's answer | `stsd+isConfigSupported`, or `image_decode` | no, it routes |

`blocking` is derived in one place, from `status === 'fail' && rule ∈ BLOCKING_RULES`, and never set by a rule.
That is what makes "an unknown never blocks" one line of code rather than a convention seven functions have to keep.

Two design decisions inside the rules are worth restating because they are what make one defect trip one rule.
`min_resolution` is evaluated orientation neutrally on edges, so a landscape 1920x1080 clip fails `orientation` alone.
And both geometry rules are evaluated on the **display** size, so `rotated_90.mp4` reports `1080x1920` on a file whose coded size is `1920x1080`.

### 8.2 The four states, and what each one means to a human

| status | meaning | UI | blocks |
|---|---|---|---|
| `pass` | evidence, and it met the requirement | neutral tick, a measured fact | no |
| `fail` | evidence, and it did not | red for the three blocking rules, amber advisory for the rest | only the three |
| `unknown` | no evidence. Never a failure | grey dash with one clause of reason | never |
| `skipped` | the rule could not run at all | not rendered | never |

`unknown` is never rendered as a pass.
A green tick that silently means "we did not check" is the lie that matters the day somebody asks whether footage was really shot at the branch.
`skipped` is invisible rather than grey, because a grey dash against a photo's duration is noise: "does not apply" and "we could not tell" read differently.

The row level verdict is `verdictFor(rollup)`: `blocked` when a blocking rule failed, `advisory` when any other rule failed, `unknown` only when nothing at all was verifiable, `ok` otherwise.
An unknown neither blocks nor downgrades the verdict, or the grey dash would quietly become a soft rejection.
This matches what `e2e/creator.e2e.mjs` computes from `expected_preflight.rollup`, and a unit test asserts the agreement on all sixteen fixtures.

### 8.3 Reason codes, and the eight the manifest does not enumerate

The sixteen codes in `manifest.context.reason_codes` are what the sixteen committed fixtures produce.
Eight more exist in `PREFLIGHT_REASON_CODES`, for inputs no committed file can be, because committing deliberately broken bytes is worse than synthesising them in a test.
A unit test asserts the manifest's enumeration is a subset of the engine's, so the two cannot drift apart silently.

| engine only code | when |
|---|---|
| `container_facts_unavailable` | the container did not parse, so a rule that needs it cannot run |
| `duration_not_derivable` | the container parsed and carried no usable duration, and no decode pass measured one |
| `dimensions_not_derivable` | the same for dimensions |
| `display_orientation_mismatch` | a brief that required horizontal, which no fixture does |
| `codec_not_identifiable` | no readable `stsd` fourcc |
| `codec_support_unknown_in_this_runtime` | the runtime answered "maybe". Reported as unknown rather than promoted to a pass |
| `no_visit_date_in_brief` | nothing to compare a capture date against, so the rule is `skipped` |
| `no_branch_coordinates` | the branch row has no lat and lng, so `near_branch` is `skipped` |

**A finding for whoever owns the schema**, in the same shape as the `near_branch_radius_m` finding in section 3: these eight belong in the committed enumeration next to the other sixteen, and the enumeration belongs somewhere both the fixture generator and the engine read rather than in two places that a test currently keeps in step.

### 8.4 The GPS absence inference, marked as an inference

Three reason codes describe an absent location atom, and the bytes genuinely cannot distinguish "stripped by a re-encode" from "never written".
The engine picks between them from the only signal available:

| code | inferred from |
|---|---|
| `no_gps_atom_not_written_by_encoder` | the file is a still |
| `no_gps_atom_camera_has_no_receiver` | an all intra professional acquisition codec, so a camera body |
| `no_gps_atom_metadata_stripped` | anything else, which most often means a re-encode or an export dropped it |

The three differ **only** in the sentence a human reads.
Status is `unknown` and blocking is false in all three, asserted by a test, and nothing in the interface may state which of the three actually happened.
The same restraint applies to `capture_date`, where a zero `mvhd` field and a missing one share one code precisely because they are the same fact to a human.

### 8.5 The visit window

`visitWindow(visitDate, hours)` is the visit **day** expanded by `visit_window_hours` on each side, as arithmetic on an instant rather than a string comparison on a date.
A calendar day match would pass a clip shot at 23:59 on the visit day and fail one shot at 00:05 the next morning, which is the same shoot.
The window is interpreted in UTC: the branch's own timezone would be more correct, it is not available to this layer, and the consequence is bounded and stated, because 23:00 local in San Jose is 06:00Z the next day and well inside a 24 hour window either way.

A capture date is never presented as verification.
`captured_at_source` records where the answer came from, every verdict carries a note saying so, and container timestamps are user editable bytes (C5.2.4), which is why this rule is advisory and `offdate_fail.mp4` still uploads.
`File.lastModified` appears as `fallback: 'file_mtime'` with `fallback_never_promoted: true` and never in the value: `asset.captured_at` stays null and `captured_at_source` stays `unknown`.
A creator stated date outranks every container source and is recorded as `creator_stated`, because a human who was there beats a byte.

### 8.6 One vocabulary collision, resolved without a rename

`asset.captured_at_source` in `src/data/types.ts` calls the QuickTime `©day` case `udta`, and the fixture manifest plus these rules call it `udta_day`.
Both are already committed in different files, so `toAssetCapturedAtSource()` is the one place the two vocabularies meet.
Recorded here as a finding rather than fixed by a rename that would break one of the two.

## 9. The state machine for bytes

Built. `src/media/state.ts`, asserted by `tests/media/state.spec.ts` (22 cases).

### 9.1 Two states, orthogonal

`media_state` is where the original bytes are: `bytes_local`, `bytes_remote`, `bytes_absent`.
`derivative_state` is whether the small derived things exist: `none`, `partial`, `ready`.

The orthogonality is what makes the product's hardest case expressible.
"Real metadata, no pixels, permanently" is `bytes_local` plus `none`, which is exactly `hevc.mov` on a Windows laptop with no HEVC decoder.
One combined status would force that asset to read either as broken (it is not: the file is fine and the metadata layer is complete) or as ready (it is not: there is nothing to look at), and the second lie is the dangerous one, because a manager would be asked to approve something nobody can see.

`deriveMediaState` decides from measured facts: a completed write, an available byte store, and the byte budget checked against this file plus what is already held.
The budget is in bytes and never in clip count, because one ProRes clip is 1.8GB and a budget in clips would let a single file blow a device's quota while reporting two of twenty used.
`partial` on the derivative side is a real outcome and not a hedge: the sheet encoded and the poster did not, which leaves a reviewable clip with a broken grid tile, and saying so lets the poster be re-derived without redoing the decode.

### 9.2 The transport gate

Bytes are the last thing that moves.
A contact sheet plus metadata is about 170KB per clip against roughly 150MB of original, so review happens on the sheet and an original moves only when somebody decided it should.

`canTransferOriginal` refuses in five named ways: `no_bytes_to_send`, `preflight_not_run`, `preflight_blocking_fail` (naming the rules), `review_has_not_moved`, `already_transferred`.
The gate is evaluated **inside** `applyTransfer`, not before it, so a caller cannot queue an original by writing the state directly.
An illegal transition is refused by name rather than ignored, because a silently dropped transition becomes an upload that never happens and never explains itself.

```
not_queued --queue(gated)--> queued --start--> in_flight --complete--> transferred
                                 \                  \
                                  fail               fail
                                     \                  \
                                      failed --requeue(gated)--> queued
```

One sanctioned exception, and it exists because without it an asset deadlocks: a clip that `needs_transcode` passes the review gate.
`hevc.mov` has no sheet, so review cannot move until the bytes do, and no sheet can exist until a transcode happens somewhere else.
It is queued with `upload_priority: 'required_for_transcode'`.
The exception does not extend to the blocking gate: `prores.mov` also needs a transcode and is still refused, because it is landscape and 1024x576, so it fails the brief anyway and transcoding it would move bytes for footage nobody wants.

`reviewTransferBytes` counts the derivatives rather than estimating them, so the number in the demo is the number the pipeline produced.

---

## Files

| file | role |
|---|---|
| `scripts/fixtures.config.mjs` | the specification: recipes, hand authored statuses, reason codes, thresholds |
| `scripts/build-fixtures.mjs` | the mechanism: recipe to ffmpeg argv, encode, verify, write the manifest |
| `scripts/fixtures-lib.mjs` | shared ffmpeg and ffprobe runners, the narrow header peek, geometry and geography |
| `scripts/verify-fixtures.mjs` | re-reads the committed bytes and checks them against the committed manifest |
| `public/fixtures/manifest.json` | the committed contract every media test asserts against |
| `tests/fixtures/manifest.spec.ts` | 80 assertions over the manifest and the bytes, offline, no ffmpeg |
| `qa/cases/media.md` | 85 cases across the fixtures, the frame count formula, the malformed input set, and the byte state machine |
| `src/media/bytes.ts` | the range addressed `ByteSource`, so a 4GB file is never materialised to answer a question about its header |
| `src/media/atoms.ts` | the container parser: the top level walk, the recursive child walker over `CONTAINER_ATOMS`, provenance and the sample tables |
| `src/media/still.ts` | still image headers, no decoder and no EXIF parser, both stated |
| `src/media/extract.ts` | the capability chain, the frame plan, rotation reconciliation, tiling, the poster, and the placeholder descriptor |
| `src/media/phash.ts` | dHash, Hamming, frame set comparison, duplicate search, blank frame detection |
| `src/media/preflight.ts` | the seven rules, four valued, pure |
| `src/media/state.ts` | `media_state`, `derivative_state`, and the transport gate |
| `src/media/ingest.ts` | one file in, facts and artefacts and a verdict out. Writes no rows |
| `tests/media/` | 262 cases: the parser against the committed bytes, the malformed input set, the chain against fake adapters, every fixture against `expected_preflight`, and the byte state machine |

`peekContainer()` in `scripts/fixtures-lib.mjs` reads a handful of atom headers, and it is a verification tool for the build rather than the application parser.
The application parser must be written independently in `src/`.
If the two ever share code, the manifest stops being an independent statement about the bytes and becomes a restatement of whatever the parser happens to do, which is exactly the circularity the declared versus expected split exists to prevent.
