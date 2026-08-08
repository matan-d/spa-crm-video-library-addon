/**
 * The container parser, against the committed bytes and against inputs no
 * committed file can be.
 *
 * Two halves, deliberately:
 *
 * 1. Every fixture is parsed from its real bytes and checked against `declared`.
 *    This is the one place in the suite where asserting `declared` is the right
 *    thing to do, because here `declared` is the independent ground truth (ffprobe
 *    plus a header peek) and our own parser is the thing under test. Every other
 *    suite asserts `expected_preflight`.
 * 2. Malformed inputs, synthesised in the test, because committing a 4GB file or a
 *    deliberately corrupt one is worse than constructing it.
 */

import { describe, expect, it } from 'vitest'
import {
  CONTAINER_ATOMS,
  MAX_ATOM_DEPTH,
  PARSER_VERSION,
  QUICKTIME_EPOCH_OFFSET_S,
  codecFamilyOf,
  parseContainer,
  parseIso6709,
  parseIso8601WithOffset,
  rotationFromMatrix,
} from '@/media/atoms'
import { bufferSource } from '@/media/bytes'
import { fixtureBytes, fixtures, requireFixture } from './_support'

const videoFixtures = fixtures.filter((fixture) => fixture.kind === 'video')

describe('the parser reads the committed bytes correctly', () => {
  it.each(videoFixtures.map((fixture) => [fixture.fixture_id, fixture] as const))(
    '%s: container, codec, dimensions and duration match the independently probed facts',
    async (id, fixture) => {
      const facts = await parseContainer(fixtureBytes(fixture), { sampleTables: true })

      expect(facts.ok, `${id}: ${facts.reason}`).toBe(true)
      expect(facts.parser_version).toBe(PARSER_VERSION)
      expect(facts.container.value).toBe(fixture.declared.container)
      expect(facts.ftyp_brand).toBe(fixture.declared.ftyp_brand)
      expect(facts.codec_video.value).toBe(fixture.declared.codec_video)
      expect(facts.has_audio.value).toBe(fixture.declared.has_audio)
      expect(facts.codec_audio.value).toBe(fixture.declared.codec_audio)

      // D8: coded dimensions come from the stsd sample entry, never from tkhd.
      expect(facts.coded.value).toEqual({
        width: fixture.declared.coded_width,
        height: fixture.declared.coded_height,
      })
      expect(facts.coded.evidence).toContain('stsd')
      expect(facts.presentation.evidence).toBe('moov/trak/tkhd')

      expect(
        Math.abs((facts.duration_s.value ?? 0) - (fixture.declared.duration_s ?? 0)),
        `${id}: duration outside the manifest tolerance`,
      ).toBeLessThanOrEqual(fixture.tolerance.duration_s)
      expect(facts.rotation_deg.value).toBe(fixture.declared.rotation_deg)
      expect(facts.moov_position).toBe(fixture.declared.moov_position)
    },
  )

  it('reads the tkhd presentation size as its own separate fact, never as the coded size', async () => {
    // lowres_fail is the fixture that surfaced D8 during the build: scaling left
    // SAR at 1.00234 and ffmpeg wrote 478.88x854 into tkhd for a 480x854 encode.
    // Every fixture is now pinned to square pixels, so the two coincide, and they
    // are still asserted as two separate facts rather than as one.
    const fixture = requireFixture('lowres_fail')
    const facts = await parseContainer(fixtureBytes(fixture))
    expect(facts.presentation.value).toEqual({
      width: fixture.declared.tkhd_width,
      height: fixture.declared.tkhd_height,
    })
    expect(facts.coded.value).toEqual({ width: 480, height: 854 })
    expect(facts.coded.note).toMatch(/never taken from tkhd/i)
  })

  it('never reads mdat, and stays inside the byte budget on every fixture', async () => {
    for (const fixture of videoFixtures) {
      const source = bufferSource(fixtureBytes(fixture))
      const facts = await parseContainer(source, { sampleTables: true })
      expect(facts.ok, fixture.fixture_id).toBe(true)
      expect(facts.bytes_read, `${fixture.fixture_id} read ${facts.bytes_read} bytes`).toBeLessThan(2 * 1024 * 1024)
      // The mdat payload is the bulk of every fixture, so reading less than the
      // file size is the checkable form of "we never read the media data".
      expect(facts.bytes_read).toBeLessThan(fixture.bytes)
      expect(facts.atoms_visited).toBeLessThan(512)
    }
  })
})

describe('rotated_90, the fixture the orientation rule rests on', () => {
  const fixture = requireFixture('rotated_90')

  it('reads the nine matrix words exactly and reduces them to 90 degrees', async () => {
    const facts = await parseContainer(fixtureBytes(fixture))
    expect(facts.video_tracks[0]?.matrix).toEqual(fixture.declared.tkhd_matrix)
    expect(facts.rotation_deg.value).toBe(90)
    expect(facts.rotation_deg.evidence).toBe('moov/trak/tkhd matrix')
  })

  it('reports coded landscape and display vertical, which is the whole point', async () => {
    const facts = await parseContainer(fixtureBytes(fixture))
    expect(facts.coded.value).toEqual({ width: 1920, height: 1080 })
    expect(facts.display.value).toEqual({ width: 1080, height: 1920 })
    expect(facts.display.value?.height).toBeGreaterThan(facts.display.value?.width ?? 0)
  })

  it('reduces the four rotation forms and refuses to invent a quarter turn for a shear', () => {
    expect(rotationFromMatrix([65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824])).toBe(0)
    expect(rotationFromMatrix([0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824])).toBe(90)
    expect(rotationFromMatrix([-65536, 0, 0, 0, -65536, 0, 0, 0, 1073741824])).toBe(180)
    expect(rotationFromMatrix([0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824])).toBe(270)
    // A flip is not a rotation, and guessing one would rotate correct footage.
    expect(rotationFromMatrix([-65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824])).toBe(0)
  })
})

describe('provenance', () => {
  it('applies the 1904 epoch to a non zero mvhd creation field', async () => {
    const fixture = requireFixture('vertical_ok')
    const facts = await parseContainer(fixtureBytes(fixture))
    expect(facts.mvhd_creation_time_raw).toBe(fixture.declared.mvhd_creation_time_raw)
    const expected = ((fixture.declared.mvhd_creation_time_raw ?? 0) - QUICKTIME_EPOCH_OFFSET_S) * 1000
    expect(facts.captured_at.value).toBe(expected)
    expect(facts.captured_at_source).toBe('mvhd')
    expect(new Date(expected).toISOString()).toBe('2026-08-04T10:12:00.000Z')
  })

  it('treats a zero mvhd creation field as absence rather than as 1904', async () => {
    for (const id of ['no_metadata', 'prores']) {
      const facts = await parseContainer(fixtureBytes(requireFixture(id)))
      expect(facts.mvhd_creation_time_raw, id).toBe(0)
      expect(facts.captured_at.value, `${id}: 1904-01-01 is worse than nothing`).toBeNull()
      expect(facts.captured_at_source, id).toBeNull()
      expect(facts.captured_at.confidence, id).toBe('none')
    }
  })

  it('prefers udta/©day over mvhd because only one of them carries a UTC offset', async () => {
    const facts = await parseContainer(fixtureBytes(requireFixture('hevc')))
    expect(facts.captured_at_source).toBe('udta_day')
    expect(facts.captured_at.evidence).toBe('mvhd+udta_day')
    const day = facts.captured_at_candidates.find((candidate) => candidate.source === 'udta_day')
    expect(day?.raw).toBe('2026-08-04T03:12:00-0700')
    expect(day?.has_offset).toBe(true)
    // Same instant as the mvhd value, expressed in local time with an offset.
    const mvhd = facts.captured_at_candidates.find((candidate) => candidate.source === 'mvhd')
    expect(day?.at_ms).toBe(mvhd?.at_ms)
  })

  it('reads GPS from the 3GPP loci atom in longitude, latitude, altitude order', async () => {
    const fixture = requireFixture('vertical_ok')
    const facts = await parseContainer(fixtureBytes(fixture))
    expect(facts.gps_atom).toBe('udta_loci_3gpp')
    // Reading latitude first puts the San Jose branch in the Atlantic, which is a
    // difference of thousands of kilometres rather than a rounding error.
    expect(facts.gps.value?.lat).toBeCloseTo(fixture.declared.gps?.lat ?? 0, 4)
    expect(facts.gps.value?.lng).toBeCloseTo(fixture.declared.gps?.lng ?? 0, 4)
    expect(facts.gps.value?.lng).toBeLessThan(0)
    expect(facts.gps.value?.alt_m).toBeCloseTo(fixture.declared.gps?.alt_m ?? 0, 1)
  })

  it('reads GPS from the QuickTime ©xyz ISO 6709 atom, skipping its length and language header', async () => {
    const fixture = requireFixture('hevc')
    const facts = await parseContainer(fixtureBytes(fixture))
    expect(facts.gps_atom).toBe('udta_c_xyz_iso6709')
    expect(facts.gps.value?.lat).toBeCloseTo(fixture.declared.gps?.lat ?? 0, 5)
    expect(facts.gps.value?.lng).toBeCloseTo(fixture.declared.gps?.lng ?? 0, 5)
  })

  it('parses the ISO 6709 forms by their integer digit count', () => {
    expect(parseIso6709('+37.33765-121.88495+021.000/')).toEqual({ lat: 37.33765, lng: -121.88495, alt_m: 21 })
    // Degrees and minutes: 3720.15 is 37 degrees 20.15 minutes, not 3720 degrees.
    const dm = parseIso6709('+3720.15-12153.10/')
    expect(dm?.lat).toBeCloseTo(37.3358, 3)
    expect(dm?.lng).toBeCloseTo(-121.885, 3)
    // The null island is what an uninitialised GPS field produces, so it is refused.
    expect(parseIso6709('+00.0000+000.0000/')).toBeNull()
    expect(parseIso6709('not a coordinate')).toBeNull()
  })

  it('parses the date forms a container carries and reports whether an offset was present', () => {
    expect(parseIso8601WithOffset('2026-08-04T10:12:00Z')).toEqual({ at_ms: 1785838320000, hasOffset: true })
    expect(parseIso8601WithOffset('2026-08-04T03:12:00-0700')).toEqual({ at_ms: 1785838320000, hasOffset: true })
    expect(parseIso8601WithOffset('2026-08-04T03:12:00-07:00')).toEqual({ at_ms: 1785838320000, hasOffset: true })
    // No offset is the case that matters: a camera clock reading, not an instant.
    expect(parseIso8601WithOffset('2026-08-04T10:12:00')).toEqual({ at_ms: 1785838320000, hasOffset: false })
    expect(parseIso8601WithOffset('')).toBeNull()
  })

  it('reads the Apple keys plus ilst form, which no committed fixture can carry', async () => {
    // ffmpeg's mov muxer cannot write `moov/meta/keys` plus `ilst`, so this path is
    // exercised against a hand built block and has never seen a real iPhone file.
    // Written blind, and marked as such in docs/media-pipeline.md section 4.2.
    const file = appleMetaFile()
    const facts = await parseContainer(file)
    expect(facts.ok).toBe(true)
    expect(facts.captured_at_source).toBe('apple_quicktime')
    expect(facts.captured_at.value).toBe(Date.UTC(2026, 7, 4, 10, 12, 0))
    expect(facts.gps_atom).toBe('apple_quicktime_iso6709')
    expect(facts.gps.value?.lat).toBeCloseTo(37.3382, 4)
    expect(facts.atom_paths).toContain('moov/meta/ilst')
  })
})

describe('the recursive child walker', () => {
  it('walks moov as a tree and reports the path of every atom it reached', async () => {
    const facts = await parseContainer(fixtureBytes(requireFixture('vertical_ok')), { sampleTables: true })
    expect(facts.atom_paths[0]).toBe('moov')
    expect(facts.atom_paths).toContain('moov/mvhd')
    expect(facts.atom_paths).toContain('moov/trak[0]/mdia/minf/stbl/stsd/avc1')
    expect(facts.atom_paths).toContain('moov/trak[1]/mdia/minf/stbl/stsd/mp4a')
    expect(facts.atom_paths).toContain('moov/udta/loci')
    // Repeated siblings are indexed and single children are not, so a path stays
    // readable while two tracks stay distinguishable.
    expect(facts.atom_paths).not.toContain('moov/mvhd[0]')
  })

  it('descends only the container vocabulary, and never into a sample entry', async () => {
    const facts = await parseContainer(fixtureBytes(requireFixture('vertical_ok')), { sampleTables: true })
    // `avc1` holds a fixed 78 byte body before its extensions, so a generic walk
    // into it would read the wrong four bytes as a box header.
    expect(facts.atom_paths.some((path) => path.includes('avc1/'))).toBe(false)
    for (const path of facts.atom_paths) {
      const parent = path.split('/').at(-2)?.replace(/\[\d+\]$/, '')
      if (!parent) continue
      expect(
        CONTAINER_ATOMS.has(parent) || parent === 'meta' || parent === 'stsd',
        `${path}: descended into ${parent}, which is not in the walker's vocabulary`,
      ).toBe(true)
    }
  })

  it('finds a single trak file with no audio track', async () => {
    const facts = await parseContainer(fixtureBytes(requireFixture('prores')), { sampleTables: true })
    expect(facts.has_audio.value).toBe(false)
    expect(facts.audio_tracks).toHaveLength(0)
    expect(facts.video_tracks).toHaveLength(1)
    expect(facts.codec_video.value).toBe('apcn')
    expect(codecFamilyOf('apcn')).toBe('prores')
    // ProRes is all intra, so there is no stss and every sample is a sync sample.
    expect(facts.video_sample_table?.all_sync).toBe(true)
  })

  it('builds a sample table a WebCodecs demux could seek with', async () => {
    const facts = await parseContainer(fixtureBytes(requireFixture('vertical_ok')), { sampleTables: true })
    const table = facts.video_sample_table
    expect(table).not.toBeNull()
    expect(table?.samples.length).toBe(144)
    expect(table?.sync_indexes.length).toBe(12)
    expect(table?.all_sync).toBe(false)
    // Monotonic decode times and a plausible first sync sample at index 0.
    expect(table?.sync_indexes[0]).toBe(0)
    const times = table?.samples.map((sample) => sample.dts_ms) ?? []
    for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThan(times[i - 1] ?? 0)
    expect(facts.video_tracks[0]?.nominal_fps).toBeCloseTo(24, 1)
  })

  it('does not read sample tables unless they were asked for', async () => {
    const facts = await parseContainer(fixtureBytes(requireFixture('vertical_ok')))
    expect(facts.video_sample_table).toBeNull()
    expect(facts.video_tracks[0]?.sample_count).toBeNull()
  })

  it('caps its own depth rather than trusting a file to stop nesting', () => {
    expect(MAX_ATOM_DEPTH).toBeGreaterThanOrEqual(6)
    expect(MAX_ATOM_DEPTH).toBeLessThanOrEqual(12)
  })
})

describe('the 64 bit and zero size atom header forms', () => {
  it('reads a size == 1 header as a 64 bit largesize and lands on the next boundary', async () => {
    const fixture = requireFixture('largesize_mdat')
    expect(fixture.declared.mdat_size_field).toBe('64bit_largesize')
    const facts = await parseContainer(fixtureBytes(fixture), { sampleTables: true })
    expect(facts.ok).toBe(true)
    // A walker that hops by 1 byte on a size == 1 header loops or bails, so
    // reaching moov at all is the assertion.
    expect(facts.top_level_types).toContain('mdat')
    expect(facts.top_level_types).toContain('moov')
    expect(facts.duration_s.value).toBeCloseTo(fixture.declared.duration_s ?? 0, 2)
    expect(facts.coded.value).toEqual({ width: 1080, height: 1920 })
    expect(facts.gps.value).not.toBeNull()
  })

  it('treats a size == 0 top level atom as running to the end of the file', async () => {
    // ffmpeg never writes this, so no committed fixture produces it.
    const file = concat([
      box('ftyp', ascii('isom')),
      box('moov', concat([mvhd({ creation: 0, timescale: 600, duration: 1200 })])),
      // `mdat` with a declared size of zero: legal, and means "to end of file".
      concat([u32(0), ascii('mdat'), new Uint8Array(64)]),
    ])
    const facts = await parseContainer(file)
    expect(facts.top_level_types).toEqual(['ftyp', 'moov', 'mdat'])
    expect(facts.reason).not.toBe('metadata_unparseable')
  })
})

describe('malformed input, synthesised because committing broken bytes is worse', () => {
  it('answers a zero byte file immediately, with a named reason', async () => {
    const facts = await parseContainer(new Uint8Array(0))
    expect(facts.ok).toBe(false)
    expect(facts.reason).toBe('empty_file')
    expect(facts.bytes_read).toBe(0)
  })

  it('returns a reason rather than throwing for a file that is not ISO BMFF', async () => {
    const jpeg = fixtureBytes(requireFixture('photo_still'))
    const facts = await parseContainer(jpeg)
    expect(facts.ok).toBe(false)
    expect(facts.reason).toBe('not_isobmff')
    expect(facts.warnings.join(' ')).toMatch(/not an ISO BMFF top level box/)
    // One unparseable file must not kill a forty file batch, so nothing throws.
  })

  it('treats a PNG named .mov as not a movie, from the bytes rather than the name', async () => {
    const png = concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      u32(13),
      ascii('IHDR'),
      u32(1080),
      u32(1920),
      new Uint8Array([8, 6, 0, 0, 0]),
    ])
    const facts = await parseContainer(png)
    expect(facts.reason).toBe('not_isobmff')
  })

  it('reports moov_not_found when the walk ends without one', async () => {
    const file = concat([box('ftyp', ascii('isom')), box('mdat', new Uint8Array(512))])
    const facts = await parseContainer(file)
    expect(facts.ok).toBe(false)
    expect(facts.reason).toBe('moov_not_found')
    expect(facts.warnings.join(' ')).toMatch(/without finding moov/)
  })

  it('finds moov after mdat, which three committed fixtures also prove', async () => {
    for (const id of ['hevc', 'no_metadata', 'prores']) {
      const fixture = requireFixture(id)
      const facts = await parseContainer(fixtureBytes(fixture))
      expect(facts.ok, id).toBe(true)
      expect(facts.moov_position, id).toBe('end')
      expect((facts.mdat_offset ?? 0) < (facts.moov_offset ?? 0), `${id}: mdat comes first`).toBe(true)
    }
  })

  it('finds moov even when ftyp is not first, and records the oddity as a warning', async () => {
    const file = concat([
      box('mdat', new Uint8Array(128)),
      box('free', new Uint8Array(8)),
      box('ftyp', ascii('isom')),
      box('moov', mvhd({ creation: 3868683120, timescale: 600, duration: 3600 })),
    ])
    const facts = await parseContainer(file)
    expect(facts.reason).toBeNull()
    expect(facts.moov_position).toBe('end')
    expect(facts.warnings.join(' ')).toMatch(/first atom is mdat rather than ftyp/)
    expect(facts.mvhd_creation_time_raw).toBe(3868683120)
  })

  it('keeps the container facts from a truncated file whose moov came first', async () => {
    const fixture = requireFixture('vertical_ok')
    const whole = fixtureBytes(fixture)
    const truncated = whole.subarray(0, Math.floor(whole.byteLength * 0.4))
    const facts = await parseContainer(truncated, { sampleTables: true })
    // moov is at the front on this fixture, so the metadata layer survives and is
    // used. Partial evidence is used rather than discarded.
    expect(facts.ok).toBe(true)
    expect(facts.coded.value).toEqual({ width: 1080, height: 1920 })
    expect(facts.duration_s.value).toBeCloseTo(6, 2)
    expect(facts.warnings.join(' ')).toMatch(/truncated/)
  })

  it('reports moov_not_found for a truncated file whose moov was at the end', async () => {
    const whole = fixtureBytes(requireFixture('hevc'))
    const truncated = whole.subarray(0, Math.floor(whole.byteLength * 0.4))
    const facts = await parseContainer(truncated)
    expect(facts.ok).toBe(false)
    expect(facts.reason).toBe('moov_not_found')
    // Nothing is guessed from the filename, so there are no dimensions at all.
    expect(facts.coded.value).toBeNull()
    expect(facts.duration_s.value).toBeNull()
  })

  it('bails on an atom that declares a size larger than the file, rather than looping', async () => {
    const file = concat([box('ftyp', ascii('isom')), concat([u32(9_000_000), ascii('moov'), new Uint8Array(32)])])
    const facts = await parseContainer(file)
    expect(facts.warnings.join(' ')).toMatch(/truncated|declares size/)
    expect(facts.reason === 'moov_not_found' || facts.reason === 'metadata_unparseable').toBe(true)
  })

  it('bails on a child atom whose declared size is smaller than its own header', async () => {
    const brokenChild = concat([u32(4), ascii('mvhd')])
    const file = concat([box('ftyp', ascii('isom')), box('moov', brokenChild)])
    const facts = await parseContainer(file)
    expect(facts.warnings.join(' ')).toMatch(/smaller than its own header/)
    expect(facts.duration_s.value).toBeNull()
  })

  it('stops at the hop cap instead of walking forever', async () => {
    const many: Uint8Array[] = [box('ftyp', ascii('isom'))]
    for (let i = 0; i < 40; i += 1) many.push(box('free', new Uint8Array(4)))
    many.push(box('moov', mvhd({ creation: 0, timescale: 600, duration: 600 })))
    const facts = await parseContainer(concat(many), { maxAtoms: 10 })
    expect(facts.atoms_visited).toBeLessThanOrEqual(10)
    expect(facts.warnings.join(' ')).toMatch(/hop cap|stopped after/)
    expect(facts.reason).toBe('moov_not_found')
  })

  it('does not read the whole file to inspect a large one', async () => {
    // A 4GB file cannot be committed, so the source is synthesised: it reports a
    // huge size and serves only the ranges asked for. If the parser ever read
    // linearly this test would allocate 4GB and fail.
    const header = concat([
      box('ftyp', ascii('isom')),
      box('moov', mvhd({ creation: 3868683120, timescale: 600, duration: 3600 })),
    ])
    const declaredSize = 4 * 1024 * 1024 * 1024
    let served = 0
    const sparse = {
      size: declaredSize,
      bytesRead: 0,
      readCount: 0,
      async read(start: number, end: number) {
        served += 1
        if (start >= header.byteLength) return new Uint8Array(0)
        return header.subarray(start, Math.min(end, header.byteLength))
      },
    }
    const facts = await parseContainer(sparse)
    expect(served).toBeLessThan(64)
    expect(facts.mvhd_creation_time_raw).toBe(3868683120)
  })
})

// ---------------------------------------------------------------------------
// synthesised container helpers
// ---------------------------------------------------------------------------

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function box(type: string, body: Uint8Array): Uint8Array {
  return concat([u32(body.byteLength + 8), ascii(type), body])
}

function mvhd(fields: { creation: number; timescale: number; duration: number }): Uint8Array {
  const body = new Uint8Array(100)
  const view = new DataView(body.buffer)
  view.setUint32(0, 0) // version and flags
  view.setUint32(4, fields.creation)
  view.setUint32(8, fields.creation)
  view.setUint32(12, fields.timescale)
  view.setUint32(16, fields.duration)
  return box('mvhd', body)
}

/**
 * A minimal movie carrying the Apple `keys` plus `ilst` metadata form.
 *
 * Hand built because ffmpeg cannot write it. The structure is: `moov/meta` as a
 * QuickTime plain box, a `keys` table of long key names, then an `ilst` whose child
 * box type is the 1 based index into that table.
 */
function appleMetaFile(): Uint8Array {
  const keyNames = ['com.apple.quicktime.creationdate', 'com.apple.quicktime.location.ISO6709']
  const keyEntries = keyNames.map((name) => concat([u32(name.length + 8), ascii('mdta'), ascii(name)]))
  const keys = box('keys', concat([u32(0), u32(keyEntries.length), ...keyEntries]))

  const dataBox = (payload: string): Uint8Array => box('data', concat([u32(1), u32(0), ascii(payload)]))
  const item = (index: number, payload: string): Uint8Array => {
    const body = dataBox(payload)
    const header = new Uint8Array(8)
    const view = new DataView(header.buffer)
    view.setUint32(0, body.byteLength + 8)
    view.setUint32(4, index)
    return concat([header, body])
  }
  const ilst = box('ilst', concat([item(1, '2026-08-04T10:12:00+0000'), item(2, '+37.3382-121.8863+017.000/')]))

  // `hdlr` first so the plain QuickTime form of `meta` is detected by sniffing.
  const meta = box('meta', concat([box('hdlr', concat([u32(0), ascii('mdta'), ascii('mdta')])), keys, ilst]))
  return concat([
    box('ftyp', ascii('qt  ')),
    box('moov', concat([mvhd({ creation: 0, timescale: 600, duration: 2400 }), meta])),
    box('mdat', new Uint8Array(32)),
  ])
}
