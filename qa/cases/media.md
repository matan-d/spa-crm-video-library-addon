# QA cases: media pipeline

Format from `docs/AGENTS.md`: Given / When / Then / Layer / Blocked-by.
Owner: `media-pipeline`.
Implemented by: `qa-runner`, except cases marked `manual-only`, which move to `qa/manual-checklist.md`.

## How to read these

Every assertion is against `public/fixtures/manifest.json`, never against a value typed into a test.
The manifest carries `declared` (what ffmpeg was instructed to produce, ground truth by construction) and `expected_preflight` (what our client code must independently derive).
**A case that asserts `declared` is testing ffmpeg and is not worth writing.**
Every numeric comparison uses the `tolerance` block on the same entry: `duration_s` 0.05, `distance_m` 30, `dhash_hamming` 4, `frame_t_seconds` 0.5.

Frame counts are never typed into a case either.
They come from `expected_frames.by_tier.<tier>.count`, which the generator computes from the formula owned by `frameCountFor()` in `src/platform/capability.ts` and recorded in `manifest.context.frame_count` (`clamp(3 + round(duration_s / 3), tier.frameFloor, tier.frameCeiling)`, decided in `docs/06-decisions.md` D2).
The numbers quoted in Group 9 are there so a human can read the case, and the assertion is against the manifest.

Statuses are four valued: `pass`, `fail`, `unknown`, `skipped`.
All statuses below are stated for the reference runtime recorded in the manifest (`chromium_desktop_windows_without_hevc_extension`).
Where a status moves with the runtime the manifest entry carries `runtime_dependent: true`, and the per runtime matrix belongs to `platform-matrix`, not to these cases.

`Blocked-by: none` means runnable today against the committed fixtures.
`Blocked-by: parser` means the case is written and cannot run until `parseContainer()` exists, which is the next task.

---

## Group 0: the manifest itself

### QC-MEDIA-001 The manifest describes its own bytes
- Given: the committed `public/fixtures/manifest.json` and the 16 committed fixture files
- When: each entry's file is read from disk
- Then: the file exists, `statSync().size` equals `bytes`, and the sha256 equals `sha256`. A mismatch fails naming the fixture and the field
- Layer: unit
- Blocked-by: none (implemented in `tests/fixtures/manifest.spec.ts`)

### QC-MEDIA-002 Every rule on every fixture is four valued and reasoned
- Given: the manifest
- When: each entry's `expected_preflight.rules` is walked
- Then: all seven rules are present, each `status` is one of `pass` / `fail` / `unknown` / `skipped`, each has a non empty `evidence`, and any `unknown` or `skipped` carries a `reason` drawn from `context.reason_codes` with `evidence: 'none'`
- Layer: unit
- Blocked-by: none (implemented)

### QC-MEDIA-003 Absent evidence never blocks and never reads as a pass
- Given: the manifest
- When: rules with `status` `unknown` or `skipped` are inspected
- Then: every one has `blocking: false`, and a rule marked `blocking` is always `status: 'fail'` and always one of `context.blocking_rules`. `codec_playable` is never blocking on any fixture
- Layer: unit
- Blocked-by: none (implemented)

### QC-MEDIA-004 The declared block matches the container
- Given: the committed fixtures and `ffprobe-static`
- When: `npm run fixtures:verify` runs
- Then: exit 0. Every `declared` field matches what ffprobe reads plus the header peek (ftyp brand, raw mvhd creation field, top level atom order, mdat size field width, tkhd presentation size). Any mismatch exits non zero naming the fixture and the field
- Layer: integration (script, not vitest, because it needs a real ffprobe binary)
- Blocked-by: none

### QC-MEDIA-005 A regenerated fixture that differs from the committed hash fails loudly
- Given: committed fixtures and a committed manifest
- When: `npm run fixtures -- --force` runs
- Then: every sha256 is unchanged, so the encode is byte reproducible on this ffmpeg build. If any hash differs the build exits non zero listing each changed fixture and instructing that `GENERATOR_VERSION` be bumped. `--accept-drift` is the only way past it
- Layer: integration
- Blocked-by: none

### QC-MEDIA-006 The generator is idempotent
- Given: an already built fixture set
- When: `npm run fixtures` runs with no flags
- Then: `encoded now 0`, `unchanged 16`, no hash drift, and verification still runs on every file so a hand edited fixture cannot survive a build
- Layer: integration
- Blocked-by: none

### QC-MEDIA-007 No perceptual hash is invented before the hasher exists
- Given: the manifest
- When: `expected_phash_prefix` is read on every entry
- Then: it is `null`, not a string. A value invented now would be asserted against forever
- Layer: unit
- Blocked-by: none (implemented)

---

## Group 1: `vertical_ok.mp4`, the happy path

`declared`: mp4, `avc1` + `mp4a`, 1080x1920, SAR 1:1, 6.0s, 24fps, GOP 12, mvhd `2026-08-04T10:12:00Z`, GPS in `udta/loci` about 120m from the branch, moov at the start.

### QC-MEDIA-010 orientation passes on a genuinely vertical clip
- Given: `vertical_ok.mp4` ingested through `ingestFile()`
- When: pre-flight runs
- Then: `rules.orientation.status === 'pass'`, `value === 'vertical'`, `evidence === 'coded_dims+tkhd_matrix'`
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-011 min_duration passes and reports the measured duration
- Given: `vertical_ok.mp4`
- When: pre-flight runs
- Then: `rules.min_duration.status === 'pass'` and `value` is within `tolerance.duration_s` of the manifest value. Both the mvhd derived duration and the decode pass duration must land inside that window, and where they differ the decode pass wins
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-012 min_resolution passes and is evaluated on edges, not on width and height
- Given: `vertical_ok.mp4`
- When: pre-flight runs
- Then: `rules.min_resolution.status === 'pass'`, `value === '1080x1920'`, and the comparison is short edge against 1080 and long edge against 1920 rather than width against 1080. QC-MEDIA-021 is the case that proves the difference matters
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-013 capture_date passes from mvhd with the 1904 epoch applied
- Given: `vertical_ok.mp4`
- When: the container is parsed
- Then: the mvhd creation field reads `3868683120` and converts to `2026-08-04T10:12:00Z` after subtracting 2082844800 seconds. `rules.capture_date.status === 'pass'`, `captured_at_source === 'mvhd'`
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-014 near_branch passes with a distance, not a boolean
- Given: `vertical_ok.mp4` and the San Jose branch at 37.3382, -121.8863
- When: pre-flight runs
- Then: `rules.near_branch.status === 'pass'` and `distance_m` is within `tolerance.distance_m` of the manifest value (about 120m). A parser that returns 0m has read the branch coordinate instead of the file's
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-015 GPS is read from the 3GPP `loci` atom, 16.16 fixed point
- Given: `vertical_ok.mp4`
- When: `moov/udta/loci` is parsed
- Then: the fields are read in the order longitude, latitude, altitude, each signed 16.16 fixed point, giving -121.8863 and 37.3382 within a metre. Reading them as latitude first produces a coordinate in the Atlantic and must fail this case
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-016 codec_playable passes for avc1
- Given: `vertical_ok.mp4`
- When: the `stsd` fourcc is read and handed to the platform probe
- Then: fourcc is `avc1`, `rules.codec_playable.status === 'pass'`. The fourcc comes from `stsd`, never from the file extension or the browser reported MIME type
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-017 duplicate passes when nothing earlier matches
- Given: `vertical_ok.mp4` ingested first in the engineered set
- When: perceptual hashes are compared across the delivery
- Then: `rules.duplicate.status === 'pass'` and `duplicate_of_asset_id` is null
- Layer: unit
- Blocked-by: parser, pHash

### QC-MEDIA-018 the happy path produces a real sheet and a real poster
- Given: `vertical_ok.mp4`
- When: extraction runs at the `standard` tier
- Then: a contact sheet exists with `expected_frames.by_tier.standard.count` tiles (5 for this 6s clip, `layout === '1x5'`), each tile is a distinct frame (no two tiles have an identical dHash, which is assertable here because the planned spacing of about 1s is well above the half second GOP), each frame time is within `tolerance.frame_t_seconds` of the planned time, `derivative_state === 'client_derived'`, and the extractor path used is recorded on the sheet
- Layer: e2e
- Blocked-by: parser, extractor

---

## Group 2: one failing rule per fixture

### QC-MEDIA-020 `horizontal_fail.mp4` fails orientation and only orientation
- Given: `horizontal_fail.mp4`, coded 1920x1080, no rotation matrix
- When: pre-flight runs
- Then: `rules.orientation.status === 'fail'` with `value === 'horizontal'`, `required === 'vertical'`, `blocking: true`, and `rollup.blocking_fail === 1`. Every other rule passes. Specifically `min_resolution` is `pass`, because 1920x1080 has a 1080 short edge and a 1920 long edge
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-021 `lowres_fail.mp4` fails resolution while still reading as vertical
- Given: `lowres_fail.mp4`, 480x854
- When: pre-flight runs
- Then: `rules.min_resolution.status === 'fail'` with `value === '480x854'` and `blocking: true`, while `rules.orientation.status === 'pass'` with `value === 'vertical'`. A fixture that failed both would not distinguish the two rules
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-022 `short_fail.mp4` fails duration and nothing else
- Given: `short_fail.mp4`, 1.5s
- When: pre-flight runs
- Then: `rules.min_duration.status === 'fail'`, `value` within `tolerance.duration_s` of 1.5, `required === 3`, `blocking: true`. `rollup.pass === 6`
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-023 `offdate_fail.mp4` fails capture_date and does not block
- Given: `offdate_fail.mp4`, mvhd `2026-08-02T09:40:00Z`, visit date `2026-08-04`
- When: pre-flight runs
- Then: `rules.capture_date.status === 'fail'` with `reason === 'capture_date_outside_visit_window'`, and `blocking: false` because the date rule is advisory. `rollup.blocking_fail === 0`, so this clip is still allowed to upload
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-024 The visit window is plus or minus 24 hours, not a calendar day match
- Given: `vertical_ok.mp4` (inside the window) and `offdate_fail.mp4` (48 hours out)
- When: both are evaluated against visit date `2026-08-04` with `visit_window_hours: 24`
- Then: the first passes and the second fails. A window implemented as a string prefix comparison on the date, or as an unbounded window, passes the first and must fail the second
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-025 A capture date is never presented as verification
- Given: any fixture with a capture date
- When: the pre-flight result is rendered to a manager
- Then: the date is labelled with its source (`captured_at_source`) and shown as a triage hint. Nothing in the UI states or implies that the clip was verified as shot on the visit day, because container timestamps are user editable bytes (C5.2.4)
- Layer: e2e
- Blocked-by: parser, review UI

---

## Group 3: `rotated_90.mp4`, the fixture the orientation rule rests on

`declared`: coded 1920x1080, SAR 1:1, tkhd matrix `[0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824]`, `rotation_deg` 90 clockwise for display, `display_matrix_rotation_ccw_deg` -90, tkhd presentation size 1920x1080 (the coded size, not the display size).

### QC-MEDIA-030 The display matrix is read from tkhd and reduced to 90 degrees
- Given: `rotated_90.mp4`
- When: `moov/trak/tkhd` is parsed
- Then: the nine matrix words equal `declared.tkhd_matrix` exactly, and a,b,c,d reduce to 0, 1, -1, 0, which is 90 degrees clockwise for display. This is byte for byte the matrix a portrait iPhone clip carries
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-031 Display orientation is vertical although coded dimensions are landscape
- Given: `rotated_90.mp4`
- When: pre-flight runs
- Then: `rules.orientation.status === 'pass'`, `value === 'vertical'`, `coded === '1920x1080'`, `display === '1080x1920'`. **A parser that reads coded dimensions and stops fails here, and that failure is the difference between accepting and rejecting a creator's correct footage.**
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-032 min_resolution is evaluated on display dimensions
- Given: `rotated_90.mp4`
- When: pre-flight runs
- Then: `rules.min_resolution.value === '1080x1920'` and status `pass`. Evaluating the coded 1920x1080 would also pass here, so this case exists to pin the value string rather than only the verdict
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-033 Every rule passes, so a failure can only be the matrix
- Given: `rotated_90.mp4`
- When: pre-flight runs
- Then: `rollup === { pass: 7, fail: 0, unknown: 0, skipped: 0, blocking_fail: 0 }`
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-034 The browser's own rotation handling is detected rather than guessed
- Given: `rotated_90.mp4` loaded into a `<video>` element
- When: `videoWidth` and `videoHeight` are compared against the container's coded dimensions
- Then: if the element reports 1080x1920 the browser already applied rotation and the canvas must NOT rotate again (`rotation_source: 'element_applied'`); if it reports 1920x1080 the canvas must rotate (`rotation_source: 'we_applied'`). The stored value distinguishes the two, so a later bug is diagnosable (C4.2.1)
- Layer: e2e
- Blocked-by: parser, extractor

### QC-MEDIA-035 The extracted frames are upright
- Given: `rotated_90.mp4`
- When: a contact sheet is produced
- Then: each tile is 1080x1920 shaped (portrait aspect) and the burned in label reads upright. The fixture is built so that the label is only upright when rotation was applied: sideways text is the visible signature of a double rotation or a missed one
- Layer: visual
- Blocked-by: parser, extractor

### QC-MEDIA-036 A rotated clip on a real iPhone
- Given: a real portrait clip shot on an iPhone camera app, HEVC or H.264
- When: it is uploaded through the creator link on iOS Safari
- Then: pre-flight reports `orientation: pass`, the sheet tiles are upright, and `rotation_source` is recorded. A human needs an iPhone, needs to shoot a portrait clip in the camera app, upload it through the public link, and compare the sheet against what they see in Photos
- Layer: manual-only
- Blocked-by: no iOS device in this build. iOS 18 has open reports of browser recorded video carrying no orientation info at all (C4.2.2), which is why the manual rotate control is not optional

---

## Group 4: `hevc.mov`, the open hole in E.4b

`declared`: MOV (`qt  ` brand), `hvc1` + `mp4a`, 1080x1920, 4.0s, mvhd `2026-08-04T10:12:00Z`, `udta/©day` `2026-08-04T03:12:00-0700`, GPS in `udta/©xyz` as ISO 6709 about 134m from the branch, moov at the end.

### QC-MEDIA-040 The codec comes from stsd, never from the extension
- Given: `hevc.mov`
- When: the sample description is parsed
- Then: the fourcc is `hvc1`. The `.mov` extension is not consulted, and the browser reported MIME type is not consulted, because an iPhone writes `.MOV` for both H.264 and HEVC and Android writes `.mp4` for both (C1.2.4)
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-041 codec_playable fails with a routing reason, not a rejection
- Given: `hevc.mov` on the reference runtime
- When: `codec_playable` is evaluated from the fourcc plus `VideoDecoder.isConfigSupported` and `canPlayType`
- Then: `status === 'fail'`, `reason === 'no_decoder_in_shell'`, `blocking: false`, `routes_to: 'transcode'`, `upload_priority: 'required_for_transcode'`. This is the one failure where uploading the original is the only way to make progress
- Layer: unit
- Blocked-by: parser, platform probe

### QC-MEDIA-042 The metadata layer is complete even with no decoder
- Given: `hevc.mov`
- When: pre-flight runs
- Then: `orientation`, `min_duration`, `min_resolution`, `capture_date` and `near_branch` are all decided from the container and none of them is `unknown`. Atom parsing reads bytes, so only the pixel layer fails
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-043 GPS is read from the QuickTime `©xyz` ISO 6709 atom
- Given: `hevc.mov`
- When: `moov/udta/©xyz` (0xA9 'x' 'y' 'z') is parsed
- Then: the 2 byte length plus 2 byte language header is skipped and the payload `+37.33765-121.88495+021.000/` parses to 37.33765, -121.88495, altitude 21. `distance_m` is within `tolerance.distance_m` of the manifest value (about 134m). This is a different atom from the `loci` in QC-MEDIA-015 and both must work
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-044 `udta/©day` supplies the one unambiguous capture instant in the set
- Given: `hevc.mov`
- When: provenance is parsed
- Then: `©day` reads `2026-08-04T03:12:00-0700`, which is the same instant as the mvhd value, and `captured_at_source === 'udta_day'` because it is the only source carrying a timezone. mvhd is defined as UTC and cameras write local time into it anyway (C5.2.3), so a source that carries an offset outranks one that does not
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-045 `moov` after `mdat` is found by walking headers, not by reading the file
- Given: `hevc.mov`, whose top level order is ftyp, free, mdat, moov
- When: the container is parsed from a `File`
- Then: `moov` is located and parsed, total bytes read stays under 2MB, and `mdat` is never read. Reading the first N bytes and expecting `moov` must fail this case
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-046 No sheet, no poster, no fabrication
- Given: `hevc.mov` on the reference runtime
- When: ingest completes
- Then: no contact sheet row, no poster, no `asset_frame` rows, `frame_hashes` and `phash_primary` null, `derivative_state === 'none'`, `derivative_producer` null, and **no `ai_run` row and no `tag` rows with `source='ai'`**. Frame extraction is not attempted at all: a try-and-catch into a black frame is worse than no frame, because a black frame gets tagged
- Layer: integration
- Blocked-by: parser, extractor, ai enqueue guard

### QC-MEDIA-047 duplicate is unknown, because dedupe genuinely cannot run
- Given: `hevc.mov` on the reference runtime
- When: pre-flight runs
- Then: `rules.duplicate.status === 'unknown'` with `reason === 'no_frames_no_decoder'`, never `pass`. Coercing this to a pass is how QC becomes a rubber stamp (C1.2.3)
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-048 The manager card is honest and Approve is disabled
- Given: `hevc.mov` reviewed by a manager on the reference runtime
- When: the deal drawer renders
- Then: a grey placeholder tile (not a broken `<video>`, not an endless spinner), the real facts we do have (filename, duration, resolution, orientation, capture date, size, codec), a chip reading "no preview: HEVC, this browser has no decoder" plus one line of what would fix it, placement in the "awaiting derivatives" bucket, Approve disabled with the reason shown, `review_status` still `pending`, and one offered action: request an H.264 version
- Layer: e2e
- Blocked-by: review UI

### QC-MEDIA-049 The Most Compatible instruction is load bearing on the invite page
- Given: the creator invite page
- When: it renders
- Then: the instruction to switch the iPhone camera to Most Compatible is present, prominent, and explained in terms of the outcome (their footage gets reviewed rather than getting stuck). This is the only preventive control we have for the E.4b hole in this build, so it is treated as a requirement and not a nicety
- Layer: e2e
- Blocked-by: invite page

### QC-MEDIA-050 HEVC decode where a decoder exists
- Given: `hevc.mov` on Safari, on iOS, or on Chromium with the HEVC Video Extension installed
- When: ingest runs
- Then: `codec_playable` is `pass` and a real sheet is produced, so the same fixture takes a different path per runtime, and `runtime_dependent: true` on the manifest entry is true rather than a hedge. A human needs a Mac or an iPhone, or a Windows machine with the HEVC Video Extension from the Microsoft Store
- Layer: manual-only
- Blocked-by: no Safari, no iOS device, and no HEVC extension on the build machine

---

## Group 5: `no_metadata.mp4`, honest degradation

`declared`: mp4, `avc1` + `mp4a`, 1080x1920, 6.0s, mvhd creation field literally `0`, no `©day`, no location atom, moov at the end.

### QC-MEDIA-060 A zero creation field is absence, not 1904
- Given: `no_metadata.mp4`, whose raw mvhd creation field is 0
- When: provenance is parsed
- Then: `rules.capture_date.status === 'unknown'` with `reason === 'mvhd_creation_time_zero'`. **A parser that applies the 1904 epoch to a zero field reports a capture date of 1904-01-01, which is worse than reporting nothing, and must fail this case**
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-061 `File.lastModified` is recorded as a fallback and never promoted
- Given: `no_metadata.mp4` ingested from a `File` with a real `lastModified`
- When: pre-flight runs
- Then: `rules.capture_date.fallback === 'file_mtime'`, `fallback_value` is set, `captured_at_source === 'unknown'`, and `asset.captured_at` stays null. The fallback appears in the record and never in the capture date field
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-062 A missing location atom is unknown, never a failure
- Given: `no_metadata.mp4`
- When: pre-flight runs
- Then: `rules.near_branch.status === 'unknown'` with `reason === 'no_gps_atom_metadata_stripped'`, `distance_m` null, `never_blocking: true`
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-063 Absence does not distinguish stripped from never written
- Given: `no_metadata.mp4` (a re-encode that lost its metadata) and `prores.mov` (a camera that never wrote any)
- When: both are parsed
- Then: both produce `capture_date: unknown` with the same reason code `mvhd_creation_time_zero`, and neither the record nor the UI claims which of the two happened. The provenance is not derivable from the bytes, so claiming it would be a fabrication
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-064 A clip with no metadata still gets a full sheet
- Given: `no_metadata.mp4`
- When: extraction runs
- Then: a real contact sheet and poster are produced. Container metadata is strictly additive: the pipeline must produce a useful result with zero container metadata, using only the element's duration and dimensions (C5.2.2)
- Layer: e2e
- Blocked-by: parser, extractor

### QC-MEDIA-065 The creator is prompted only for the unknown they can answer
- Given: `no_metadata.mp4` delivered by a creator
- When: the creator checklist renders
- Then: `capture_date: unknown` produces a prompt ("when did you shoot this?", defaulting to the visit date) which writes `captured_at` with `captured_at_source === 'creator_stated'`. `near_branch: unknown` produces **nothing at all**, because there is no action available and surfacing it would read as a problem they caused
- Layer: e2e
- Blocked-by: upload page

---

## Group 6: `duplicate_of_vertical_ok.mp4`

### QC-MEDIA-070 Perceptual dedupe catches a match the byte hash cannot
- Given: `vertical_ok.mp4` and `duplicate_of_vertical_ok.mp4` ingested as one delivery in manifest order
- When: frames are hashed and compared
- Then: the two sha256 values differ, and the per frame dHash distance between corresponding frames is within `tolerance.dhash_hamming` (4). `rules.duplicate.status === 'fail'` on the later asset with `duplicate_of_fixture_id === 'vertical_ok'`
- Layer: integration
- Blocked-by: parser, extractor, pHash

### QC-MEDIA-071 A duplicate is advisory, never blocking
- Given: the duplicate pair
- When: pre-flight completes
- Then: `rules.duplicate.blocking === false` and `rollup.blocking_fail === 0` on the duplicate. A creator delivering the same shot twice is a nudge, not a rejection
- Layer: unit
- Blocked-by: parser, pHash

### QC-MEDIA-072 The duplicate verdict names the set it was computed over
- Given: `duplicate_of_vertical_ok.mp4` ingested ALONE, with no other asset in the delivery
- When: pre-flight runs
- Then: `rules.duplicate.status === 'pass'`, because there is nothing to match. This is not a contradiction with QC-MEDIA-070: the rule is set dependent, `comparison_set` records the set, and any test asserting it must state the set
- Layer: integration
- Blocked-by: parser, pHash

---

## Group 7: `prores.mov`, the camera offload and the reason `unknown` exists

`declared`: MOV, `apcn` (ProRes 422), no audio track, 1024x576 landscape, 3.5s, 10fps, mvhd creation field 0, no location atom, moov at the end.

### QC-MEDIA-080 near_branch is unknown because the camera has no GPS receiver
- Given: `prores.mov`
- When: pre-flight runs
- Then: `rules.near_branch.status === 'unknown'` with `reason === 'no_gps_atom_camera_has_no_receiver'`, `never_blocking: true`. **It must never be `fail`. A red cross here fails a creator for using better equipment, which is a product defect and not a strict rule**
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-081 The unknown renders as a grey dash with a reason, never as a red cross or a green check
- Given: `prores.mov` in the manager review
- When: the pre-flight panel renders
- Then: `near_branch` shows a grey dash with one clause of explanation ("location not verifiable, this camera has no GPS"). It is not red, and it is not a green check. A green check that silently means "we did not check" is the lie that matters the day somebody asks whether footage was really shot at the branch
- Layer: visual
- Blocked-by: review UI

### QC-MEDIA-082 codec_playable fails on every runtime, not just this one
- Given: `prores.mov`
- When: `codec_playable` is evaluated
- Then: `status === 'fail'`, `reason === 'codec_unsupported_in_every_browser'`, `runtime_dependent: false`. Unlike `hvc1`, this answer does not move with the runtime: no browser decodes ProRes
- Layer: unit
- Blocked-by: parser, platform probe

### QC-MEDIA-083 Three unknowns and two blocking fails coexist without contradiction
- Given: `prores.mov`
- When: pre-flight completes
- Then: `rollup === { pass: 1, fail: 3, unknown: 3, skipped: 0, blocking_fail: 2 }`. The blocking fails are `orientation` and `min_resolution`; `codec_playable` fails without blocking; the three unknowns are `capture_date`, `near_branch` and `duplicate`
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-084 A file with no audio track is parsed, not rejected
- Given: `prores.mov`
- When: the container is parsed
- Then: `has_audio === false` is reported as a fact and no rule fails because of it. The track walk must handle a moov with exactly one trak
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-085 The byte budget cannot be exercised by a committed fixture
- Given: `maxLocalOriginalBytes` at the `standard` tier (1GB)
- When: a synthesised `File` of 1.8GB (one two minute ProRes clip at 1080p) is ingested
- Then: the original is not written to OPFS, `media_state === 'bytes_absent'`, and the reason is recorded. The `File` is synthesised in the test from a sparse blob, because a fixture large enough to test this could not be committed. `prores.mov` at 1.6MB is the largest committed fixture and covers the codec and metadata path only
- Layer: integration
- Blocked-by: parser, byte store

---

## Group 8: `largesize_mdat.mp4`, the 64 bit atom size path

### QC-MEDIA-090 A `size == 1` atom header is read as a 64 bit largesize
- Given: `largesize_mdat.mp4`, whose `mdat` header is `00 00 00 01 6D 64 61 74` followed by an 8 byte largesize
- When: top level atoms are walked
- Then: the walker reads the 8 byte largesize, treats the header as 16 bytes rather than 8, and lands exactly on the next atom boundary. A walker that jumps by 1 byte on a `size == 1` header loops or bails, and must fail this case
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-091 The rest of the container still parses through a 64 bit header
- Given: `largesize_mdat.mp4`
- When: pre-flight runs
- Then: coded dimensions, duration, codec, capture date and GPS all parse normally, and the parsed duration is within `tolerance.duration_s` of the manifest value. The fixture is 2s, so `min_duration` legitimately fails, and this case asserts the parsed duration rather than the verdict
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-092 A `size == 0` atom means "to end of file"
- Given: a synthesised buffer whose last top level atom carries `size == 0`
- When: the walker runs
- Then: the atom is treated as extending to the end of the file, not as zero length, and the walk terminates. No committed fixture produces this because ffmpeg does not write it, so the input is synthesised
- Layer: unit
- Blocked-by: parser

---

## Group 9: the frame count formula, as resolved in D2

`frameCount = clamp(3 + round(duration_s / 3), tier.frameFloor, tier.frameCeiling)`, with bounds 5 to 7 at `ample`, 4 to 6 at `standard`, and 3 to 3 at `constrained`.
The formula itself belongs to `frameCountFor()` in `src/platform/capability.ts` and is asserted directly by `tests/platform/capability.spec.ts`.
It reaches these cases only through `expected_frames.by_tier` in the manifest, so what Group 9 asserts is that the extractor produces what the manifest plans, which is a different claim from the formula being right.

### QC-MEDIA-100 `long_ok.mp4` reaches the tier ceiling, which no shorter fixture does
- Given: `long_ok.mp4`, 20s, the only fixture whose duration term saturates every tier
- When: extraction runs at each tier
- Then: 7 frames at `ample` with `contact_sheet.layout === '1x7'`, 6 at `standard` with `1x6`, and 3 at `constrained` with `1x3`, each matching `expected_frames.by_tier.<tier>.count` and `.layout`. This is the widest tier spread in the set and the only case where the ceiling rather than the floor decides the answer
- Layer: integration
- Blocked-by: extractor

### QC-MEDIA-101 A 6s clip gets 5 frames on a capable machine and 3 on a phone
- Given: `vertical_ok.mp4`, 6s
- When: extraction runs at all three tiers
- Then: 5 frames at `ample` and 5 at `standard`, both `layout === '1x5'`, and 3 at `constrained` with `1x3`, each matching `expected_frames.by_tier`. `3 + round(6 / 3)` is 5, which sits inside the `ample` band of 5 to 7 and the `standard` band of 4 to 6, and above the `constrained` ceiling of 3. This is the resolved behaviour from `docs/06-decisions.md` D2, replacing the old `clamp(round(duration_s / 4), 3, tierMax)` that gave this clip 3 frames at every tier and contradicted the C2.D worked example
- Layer: integration
- Blocked-by: extractor

### QC-MEDIA-102 The policy tier is recorded on the artifact it shaped
- Given: any fixture ingested at `constrained`
- When: the sheet is written
- Then: `contact_sheet.policy_tier === 'constrained'`, `generator_version` set, and the extractor path recorded. A 3 frame 360px sheet and a 5 frame 480px sheet are different inputs to the vision model, so a cached run must not be reused across them
- Layer: integration
- Blocked-by: extractor

### QC-MEDIA-103 The tier genuinely changes the answer, on every fixture
- Given: every video fixture in the manifest that expects frames at all (so not `hevc.mov` and not `prores.mov`)
- When: `expected_frames.by_tier.constrained.count` is compared against `expected_frames.by_tier.ample.count`
- Then: they differ on every single one: 3 against 5 for the 1.5s, 2s, 5s and 6s clips, and 3 against 7 for the 20s clip. **This property is the whole point of D2 and must be asserted rather than assumed**, because the previous formula produced identical counts at every tier for every fixture in this set, which made the tier system decorative
- Layer: unit
- Blocked-by: none (assertable against the committed manifest today, no extractor needed)

### QC-MEDIA-104 A short clip plans frames closer together than the keyframe interval
- Given: `short_fail.mp4`, 1.5s, whose `ample` plan is 5 frames a quarter second apart while the GOP on every fixture is half a second
- When: extraction runs at `ample` on the `<video>` plus canvas path
- Then: 5 tiles are still produced, because the tier floor is a floor, and every frame time is within `tolerance.frame_t_seconds` of its planned time. Tile distinctness is deliberately NOT asserted here: two planned times can legitimately snap to the same decoded frame, so what is asserted instead is that the sheet records the times it actually reached rather than the times it planned, and that nothing in the UI or in an AI prompt describes near identical tiles as distinct moments. On the WebCodecs path the frames are frame accurate and may well be distinct, and the case must not depend on which path ran
- Layer: integration
- Blocked-by: extractor

---

## Group 10: `photo_still.jpg`, the `skipped` state

### QC-MEDIA-110 min_duration is skipped, not unknown
- Given: `photo_still.jpg` with `kind: 'photo'`
- When: pre-flight runs
- Then: `rules.min_duration.status === 'skipped'` with `reason === 'rule_not_applicable_to_kind'`, and the rule is **not rendered at all**. "This does not apply" and "we could not tell" read differently to a human, and a grey dash for a photo's duration would be noise
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-111 A non ISO BMFF file returns a reason instead of throwing
- Given: `photo_still.jpg` handed to the container parser
- When: the top level walk runs
- Then: it returns `{ ok: false, reason: 'not_isobmff' }` and does not throw. One unparseable file must not kill a 40 file batch (C5.2.2)
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-112 A still is its own sheet and dedupe still works
- Given: `photo_still.jpg`
- When: derivatives are produced
- Then: one frame, the sheet is the photo itself, a poster exists, and `rules.duplicate.status === 'pass'` rather than `unknown`, because a still genuinely has a frame to hash
- Layer: integration
- Blocked-by: extractor, pHash

### QC-MEDIA-113 EXIF is honestly absent rather than silently assumed
- Given: `photo_still.jpg`, which carries no EXIF
- When: provenance is parsed
- Then: `rules.capture_date.status === 'unknown'` with `reason === 'no_exif_parser_for_still_images'`. We ship no EXIF parser, and saying so is better than a stills path that pretends to exist
- Layer: unit
- Blocked-by: parser

---

## Group 11: the malformed input set

No committed fixture. Each input is synthesised in the test, because committing a 4GB file or a deliberately corrupt one is worse than constructing it.

### QC-MEDIA-120 Zero byte file
- Given: `new File([], 'empty.mp4', { type: 'video/mp4' })`
- When: `ingestFile()` runs
- Then: it returns `{ ok: false, reason: 'empty_file' }` within one tick, no `<video>` element is created, no timeout is waited on, and the batch continues. `media_state` is not set and no asset row is written
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-121 A `.mov` that is not a movie
- Given: a `File` named `holiday.mov` with MIME `video/quicktime` whose bytes are a PNG
- When: ingest runs
- Then: `reason: 'not_isobmff'` from the container walk, and the decode attempt fails with its own enumerated reason (`decode_unsupported`), not with a generic error. The extension and the MIME type are never trusted (C1.2.4), and the two failures are recorded separately because they are two different facts
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-122 A truncated download
- Given: `vertical_ok.mp4` sliced to the first 40% of its bytes, so `moov` (which sits at the front) parses but `mdat` is short
- When: ingest runs
- Then: the container facts parse and are kept, the decode pass fails with `reason: 'seek_timeout'` or `'zero_duration'` within the wall clock timeout, `rules.duplicate` becomes `unknown` with `no_frames_no_decoder`, and the container derived rules still produce verdicts. Partial evidence is used, not discarded
- Layer: unit
- Blocked-by: parser, extractor

### QC-MEDIA-123 A truncated download where `moov` was at the end
- Given: `hevc.mov` (moov last) sliced to the first 40% of its bytes
- When: ingest runs
- Then: the walk reaches the end of the buffer without finding `moov` and returns `reason: 'moov_not_found'`. Every container rule is `unknown` and a container level `fail` is escalated. Nothing is guessed from the filename
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-124 No `moov` atom at all
- Given: a synthesised file with a valid `ftyp` and a single `mdat`, no `moov`
- When: the walk runs
- Then: `reason: 'moov_not_found'`, and the pipeline falls back to the `<video>` element for duration and dimensions. Container metadata is an enhancement, never a dependency (C5.2.2)
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-125 Atoms in an unexpected order
- Given: a synthesised file ordered `mdat`, `free`, `ftyp`, `moov`, with `ftyp` not first
- When: the walk runs
- Then: `moov` is still found by walking headers, and the missing leading `ftyp` is recorded as a warning rather than a rejection. Committed coverage of moov-after-mdat already exists on `hevc.mov`, `no_metadata.mp4` and `prores.mov`
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-126 A recursive or absurd atom size
- Given: a synthesised file whose `moov` declares a size larger than the file, and another whose child atom declares size 0 inside a parent
- When: the walk runs
- Then: the walk bails with `reason: 'metadata_unparseable'` rather than looping, having read under 2MB of headers and made under 512 hops. A parser without a hop cap and a byte cap hangs here
- Layer: unit
- Blocked-by: parser

### QC-MEDIA-127 A 4GB file
- Given: a synthesised `File` of 4GB (a sparse blob, never materialised in memory)
- When: ingest runs
- Then: the header walk reads only `File.slice()` ranges, total bytes read stays under 2MB, `mdat` is never read, and memory usage does not track file size. `maxLocalOriginalBytes` refuses the OPFS write and `media_state === 'bytes_absent'`
- Layer: integration
- Blocked-by: parser, byte store

### QC-MEDIA-128 Variable frame rate
- Given: a synthesised VFR clip (no committed fixture: every fixture in the set is CFR, which is a recorded gap)
- When: duration and frame times are derived
- Then: duration comes from mvhd over timescale and is cross checked against the decode pass, `fps` is recorded as nominal rather than as a guarantee, and frame extraction still lands within `tolerance.frame_t_seconds`
- Layer: unit
- Blocked-by: parser, extractor, and a VFR fixture that this generator does not produce

### QC-MEDIA-129 Nothing waits forever
- Given: each malformed input above
- When: ingest runs
- Then: every media wait has a wall clock timeout (8s for metadata, 5s per seek) and each distinct failure carries its own enumerated reason code from `decode_unsupported`, `zero_duration`, `zero_dimensions`, `blank_frame`, `seek_timeout`, `metadata_timeout`. A single file must never stall a 40 file batch, which is the single most likely way this pipeline dies in the field (C1.2.2)
- Layer: integration
- Blocked-by: extractor

### QC-MEDIA-130 A blank frame is detected rather than shipped
- Given: any input whose decode produces a fully black or fully transparent canvas
- When: a frame is drawn
- Then: a pixel grid sample finds zero variance or zero alpha, the draw is treated as failed with `reason: 'blank_frame'`, and no sheet is written. A black frame that becomes a contact sheet is worse than no sheet, because it will be tagged
- Layer: unit
- Blocked-by: extractor

---

## Group 12: the state machine for bytes

### QC-MEDIA-140 The transport refuses to move originals before pre-flight passes
- Given: any fixture whose `rollup.blocking_fail > 0` (`horizontal_fail`, `lowres_fail`, `short_fail`, `prores`)
- When: an upload of the original is requested
- Then: the transition is refused by the state machine, not by a caller side check, and the refusal names the blocking rule
- Layer: integration
- Blocked-by: transport

### QC-MEDIA-141 An unknown does not refuse the transition
- Given: `prores.mov` with `orientation` and `min_resolution` forced to pass and only the three unknowns remaining
- When: an upload is requested
- Then: the transition is allowed. `unknown` never blocks, so a legitimate camera delivery from the VIP location is not refused by a rule about a GPS chip that does not exist
- Layer: integration
- Blocked-by: transport

### QC-MEDIA-142 `codec_playable: fail` raises upload priority instead of blocking
- Given: `hevc.mov`
- When: pre-flight completes
- Then: the original is queued with `upload_priority: 'required_for_transcode'`, because shipping the original is the only path forward
- Layer: integration
- Blocked-by: transport

### QC-MEDIA-143 Review happens on the sheet, and originals move only on demand
- Given: the engineered set ingested as one delivery
- When: the manager reviews it
- Then: total bytes transferred for review is the sum of the sheets and posters (about 170KB per clip), not the originals. An original moves only after a manager action, and the transition is enforced by the state machine
- Layer: e2e
- Blocked-by: transport, review UI

### QC-MEDIA-144 Memory is released across a batch
- Given: the full engineered set ingested in one batch on a constrained tier
- When: extraction completes
- Then: every `ImageBitmap` is closed, every object URL is revoked, no canvas is retained, and no frame is ever drawn at native resolution. Asserted by counting live object URLs and bitmaps rather than by watching a memory graph
- Layer: integration
- Blocked-by: extractor

### QC-MEDIA-145 A mid batch downgrade is measured, not guessed
- Given: a batch whose first clip takes longer than the extraction budget (about 2.5s for five frames)
- When: the batch continues
- Then: the tier drops by one for the remainder of the batch, the new tier is recorded on the artifacts it shaped, and no upward re-evaluation happens until the next batch boundary. A static probe cannot see thermal throttling, so the downgrade must come from a measurement
- Layer: integration
- Blocked-by: extractor, capability probe

### QC-MEDIA-146 Thermal throttling on a real phone
- Given: a real phone ingesting 20 clips in one batch
- When: the device heats up partway through
- Then: the tier downgrade fires from the measured extraction time, the batch completes, and no clip is dropped. A human needs a real Android or iOS device, needs 20 clips of 10 to 30 seconds, and needs to watch the recorded `policy_tier` per sheet change mid batch
- Layer: manual-only
- Blocked-by: no device in this build

---

## Coverage gaps, stated rather than implied

These are cases that cannot be written against a committed fixture on this ffmpeg build.
Each is a named gap in `docs/media-pipeline.md`, not a silence.

| gap | why | what would close it |
|---|---|---|
| `com.apple.quicktime.location.ISO6709` and `com.apple.quicktime.creationdate` in `moov/meta/keys` plus `ilst` | ffmpeg cannot write the Apple keys and ilst metadata form. `©xyz` and `©day` on `hevc.mov` are the closest producible equivalents | a real iPhone clip, or a hand injected keys and ilst block into a trailing `moov` |
| a rotated HEVC clip, which is the actual iPhone default | rotation must be tested on a file we can decode, so `rotated_90` is H.264. The real iPhone case combines both | QC-MEDIA-036 and QC-MEDIA-050, manual-only |
| variable frame rate | every fixture is CFR | QC-MEDIA-128 with a synthesised VFR clip |
| non square pixels | every fixture is pinned to SAR 1:1 so a failing orientation test means the matrix was misread rather than the pixel aspect ratio | a dedicated anamorphic fixture, if anamorphic footage is ever in scope |
| a genuinely 4GB file and the byte budget | cannot be committed | QC-MEDIA-127 and QC-MEDIA-085 with synthesised `File` objects |
| 180 and 270 degree rotation | only 0 and 90 are in the set | two more remux variants, cheap to add if the reduction table is ever wrong |
