# Manual checklist

Everything that cannot be asserted by a test in this build, with what a human would have to do.

This file exists so coverage is never implied.
A case that lands here is not a case that was skipped: it is a case whose evidence needs hardware, a runtime, or a service this build deliberately does not have.
Each entry names the case, why it is here, what a human does, and what the pass condition is.

Owners write into their own section.
`media-pipeline` owns section 1.
`platform-matrix`, `ai-contract`, `tenancy-guard` and `loop-integrity` add their own sections as their tracks land.

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
