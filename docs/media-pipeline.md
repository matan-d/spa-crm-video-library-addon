# Media pipeline

Owner: `media-pipeline`.
The question this document answers: given these bytes, is everything we claim to know about them actually true, and is everything we do not know marked as unknown?

Status: **B1 complete.** The fixtures, their ground truth, and the expected verdicts exist.
The parser, the frame extractor, the pre-flight engine and the perceptual hasher do not exist yet, and their sections below are headings on purpose.

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

**`long_ok.mp4`** is the only fixture long enough for the frame count formula to produce 5 frames, so the `1x5` sheet layout and the constrained versus standard tier difference have a fixture at all.

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
| `long_ok.mp4` | no fixture reaches 5 frames, so the `1x5` layout the contact sheet spec is written around is untested, and the ingest tier never changes an answer |
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

### 4.5 A spec contradiction the fixtures surfaced, needing a decision

C2.D's worked example shows `expected_frames: { count: 5, t_seconds: [0.5, 1.6, 3.0, 4.4, 5.5] }` for a 6 second clip.
E.4a specifies `frameCount = clamp(round(duration_s / 4), 3, tierMax)`, which gives **3** frames for a 6 second clip at every tier, and only reaches 5 above about 14 seconds.

Both cannot be right.
The manifest follows E.4a, records the per tier plan under `expected_frames.by_tier`, and `long_ok.mp4` exists so the 5 frame layout has a fixture at all.
QC-MEDIA-101 asserts the 3 frame outcome and names the contradiction, so whichever way it is resolved the manifest and the code have to move together.

The product consequence, which is why this is not a detail: at 5 to 30 second b-roll lengths, the E.4a formula means almost every real clip gets a 3 tile sheet, the ingest tier almost never changes the answer, and the authored AI fixtures are written against 3 tiles rather than 5.
If 5 tiles is what the vision layer wants, the formula needs a higher floor, not a longer fixture.

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

Not built.
Next task.

This section will carry the field list with a confidence level per field, the atom walk strategy (header only, `File.slice()`, never read `mdat`, capped hops and capped bytes), the 1904 epoch handling, the 64 bit size case, the three GPS atom forms from 4.2, and the rule that `tkhd` holds presentation size rather than coded size.

## 7. The extraction chain

Not built.

This section will carry the capability chain (WebCodecs `VideoDecoder` plus demux, then `<video>` plus canvas, then a generated placeholder tile), the recorded extractor path and version per sheet, the rotation reconciliation from C4.2.1, the timeouts and enumerated failure reasons from C1.2.2, and the memory discipline.

## 8. The pre-flight rules

Not built.

The four states, the blocking set, and the reason code enumeration are already fixed in `manifest.context` and asserted by `tests/fixtures/manifest.spec.ts`, so this section will document the pure function rather than invent the contract.

## 9. The state machine for bytes

Not built.

`media_state` and `derivative_state` are orthogonal, which is what makes "real metadata, no pixels, permanently" expressible at all.
The transport refuses the transition until pre-flight passes and review has moved on, enforced in the state machine rather than trusted to a caller.
Cases QC-MEDIA-140 through QC-MEDIA-146 are written against it already.

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
| `qa/cases/media.md` | 60 cases across the fixtures, the malformed input set, and the byte state machine |

`peekContainer()` in `scripts/fixtures-lib.mjs` reads a handful of atom headers, and it is a verification tool for the build rather than the application parser.
The application parser must be written independently in `src/`.
If the two ever share code, the manifest stops being an independent statement about the bytes and becomes a restatement of whatever the parser happens to do, which is exactly the circularity the declared versus expected split exists to prevent.
