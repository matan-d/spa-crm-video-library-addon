/**
 * Ingest end to end, with fake decode adapters.
 *
 * This is where the malformed input set lives, because every one of those cases is
 * about the whole path rather than about one function: a zero byte file must be
 * answered before any element is created, a PNG named `.mov` must be classified from
 * its bytes, and a truncated download must keep the evidence it does have.
 *
 * Nothing here writes a database row. `ingestMedia` returns facts and artefacts, and
 * the upload surface owns the ids, the delivery and the outbox.
 */

import { describe, expect, it } from 'vitest'
import { codecFamilyOf } from '@/media/atoms'
import { decodeSupportFromReport, ingestBufferInput, ingestMedia, type IngestDependencies } from '@/media/ingest'
import type { CapabilityReport } from '@/platform/capability'
import {
  REFERENCE_RUNTIME_CODECS,
  contextFromManifest,
  fakeExtractionHost,
  fixtureBytes,
  fixtures,
  policyForTier,
  referenceCodecSupport,
  requireFixture,
  type FakeHost,
} from './_support'

function deps(host: FakeHost, overrides: Partial<IngestDependencies> = {}): IngestDependencies {
  return {
    policy: policyForTier('standard'),
    host,
    context: contextFromManifest(),
    priors: [],
    decodeSupport: ({ family }) => referenceCodecSupport(family),
    ...overrides,
  }
}

describe('the committed fixtures, through the whole path', () => {
  it('ingested as one delivery in manifest order, every fixture matches its committed verdict', async () => {
    // The comparison set the manifest names, exercised as a set rather than per file:
    // the duplicate rule is set dependent, so ingesting in order with accumulating
    // priors is the only arrangement in which its expectations mean anything.
    const host = fakeExtractionHost({ stillDecoder: true })
    const priors: { asset_id: string; frame_hashes: string[] }[] = []

    for (const fixture of fixtures) {
      const id = fixture.fixture_id
      const input = ingestBufferInput(fixture.path.split('/').at(-1) ?? id, fixtureBytes(fixture), {
        mime_type: fixture.kind === 'photo' ? 'image/jpeg' : 'video/mp4',
        last_modified_ms: Date.UTC(2026, 7, 6, 9, 0, 0),
      })
      const result = await ingestMedia(input, deps(host, { priors: [...priors] }))

      expect(result.ok, `${id}: ${result.reason}`).toBe(true)
      expect(result.kind, `${id} kind`).toBe(fixture.kind)
      expect(result.preflight?.rollup, `${id} rollup`).toEqual(fixture.expected_preflight.rollup)

      const hasSheet = result.extraction?.sheet !== null
      expect(hasSheet, `${id} sheet presence`).toBe(fixture.expected_derivatives.contact_sheet)
      expect(result.extraction?.poster !== null, `${id} poster presence`).toBe(fixture.expected_derivatives.poster)
      if (!hasSheet) {
        // No fabrication: no sheet, no poster, no frames, no hashes, and a described
        // placeholder for the interface to render instead.
        expect(result.extraction?.frames, id).toHaveLength(0)
        expect(result.extraction?.frame_hashes, id).toHaveLength(0)
        expect(result.extraction?.placeholder, id).not.toBeNull()
      }

      if (fixture.group === 'engineered' && (result.extraction?.frame_hashes.length ?? 0) > 0) {
        priors.push({ asset_id: id, frame_hashes: result.extraction?.frame_hashes ?? [] })
      }
    }

    // And the memory discipline holds across the whole delivery.
    expect(host.counters.released).toBe(host.counters.allocated)
  })

  it('never reads the media data of a file it inspects', async () => {
    for (const fixture of fixtures.filter((entry) => entry.kind === 'video')) {
      const input = ingestBufferInput('clip.mp4', fixtureBytes(fixture))
      const result = await ingestMedia(input, deps(fakeExtractionHost()))
      expect(result.bytes_read, fixture.fixture_id).toBeLessThan(fixture.bytes)
      expect(result.bytes_read).toBeLessThan(2 * 1024 * 1024)
    }
  })

  it('finds the duplicate only when the original is in the set, and names the set either way', async () => {
    const host = fakeExtractionHost()
    const first = await ingestMedia(
      ingestBufferInput('vertical_ok.mp4', fixtureBytes(requireFixture('vertical_ok'))),
      deps(host, { priors: [] }),
    )
    expect(first.preflight?.rules.duplicate.status).toBe('pass')

    const duplicate = ingestBufferInput(
      'duplicate_of_vertical_ok.mp4',
      fixtureBytes(requireFixture('duplicate_of_vertical_ok')),
    )
    const alone = await ingestMedia(duplicate, deps(host, { priors: [] }))
    // Ingested alone there is nothing to match, which is not a contradiction.
    expect(alone.preflight?.rules.duplicate.status).toBe('pass')

    const withOriginal = await ingestMedia(
      duplicate,
      deps(host, { priors: [{ asset_id: 'vertical_ok', frame_hashes: first.extraction?.frame_hashes ?? [] }] }),
    )
    expect(withOriginal.preflight?.rules.duplicate.status).toBe('fail')
    expect(withOriginal.preflight?.rules.duplicate.duplicate_of_asset_id).toBe('vertical_ok')
    expect(withOriginal.preflight?.rules.duplicate.blocking).toBe(false)
  })
})

describe('the malformed input set', () => {
  it('answers a zero byte file without creating an element or waiting on a timeout', async () => {
    const host = fakeExtractionHost()
    const result = await ingestMedia(ingestBufferInput('empty.mp4', new Uint8Array(0)), deps(host))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('empty_file')
    expect(host.counters.decodeCalls).toHaveLength(0)
    expect(result.preflight).toBeNull()
    expect(result.bytes_read).toBe(0)
  })

  it('answers a file too short to hold any header', async () => {
    const result = await ingestMedia(ingestBufferInput('tiny.mp4', new Uint8Array([1, 2, 3])), deps(fakeExtractionHost()))
    expect(result.reason).toBe('not_media')
    expect(result.warnings.join(' ')).toMatch(/too short/)
  })

  it('classifies a PNG named .mov from its bytes, and records that the container refused it', async () => {
    const png = new Uint8Array(33)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    const view = new DataView(png.buffer)
    view.setUint32(8, 13)
    png.set([0x49, 0x48, 0x44, 0x52], 12)
    view.setUint32(16, 1080)
    view.setUint32(20, 1920)

    const host = fakeExtractionHost({ stillDecoder: true })
    const result = await ingestMedia(
      ingestBufferInput('holiday.mov', png, { mime_type: 'video/quicktime' }),
      deps(host),
    )

    // The extension and the MIME type are never trusted, and the two facts are
    // recorded separately: the container walk refused these bytes, and they are a
    // still. No video decode is attempted, so there is no generic error either.
    expect(result.kind).toBe('photo')
    expect(result.parse_failure).toBe('not_isobmff')
    expect(result.still?.format).toBe('png')
    expect(result.still?.coded.value).toEqual({ width: 1080, height: 1920 })
    expect(host.counters.decodeCalls).toHaveLength(0)
    expect(result.preflight?.rules.min_duration.status).toBe('skipped')
  })

  it('answers bytes that are neither a movie nor a still we can read', async () => {
    const noise = new Uint8Array(64).fill(0x5a)
    const result = await ingestMedia(ingestBufferInput('mystery.mov', noise), deps(fakeExtractionHost()))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_media')
    expect(result.parse_failure).toBe('not_isobmff')
    expect(result.preflight).toBeNull()
  })

  it('keeps the container facts from a truncated download whose moov came first', async () => {
    const whole = fixtureBytes(requireFixture('vertical_ok'))
    const truncated = whole.slice(0, Math.floor(whole.byteLength * 0.4))
    const host = fakeExtractionHost({ behaviour: { webcodecs: { kind: 'fail', reason: 'seek_timeout' }, 'video-canvas': { kind: 'fail', reason: 'seek_timeout' } } })
    const result = await ingestMedia(ingestBufferInput('partial.mp4', truncated), deps(host))

    // Partial evidence is used, not discarded.
    expect(result.ok).toBe(true)
    expect(result.preflight?.rules.orientation.status).toBe('pass')
    expect(result.preflight?.rules.min_duration.status).toBe('pass')
    expect(result.preflight?.rules.near_branch.status).toBe('pass')
    // And the pixel layer honestly failed.
    expect(result.extraction?.sheet).toBeNull()
    expect(result.extraction?.reason).toBe('seek_timeout')
    expect(result.preflight?.rules.duplicate.status).toBe('unknown')
    expect(result.preflight?.rules.duplicate.reason).toBe('no_frames_no_decoder')
  })

  it('reports moov_not_found for a truncated download whose moov was at the end', async () => {
    const whole = fixtureBytes(requireFixture('hevc'))
    const truncated = whole.slice(0, Math.floor(whole.byteLength * 0.4))
    const host = fakeExtractionHost({ probe: null })
    const result = await ingestMedia(ingestBufferInput('partial.mov', truncated), deps(host))

    expect(result.parse_failure).toBe('moov_not_found')
    expect(result.container).toBeNull()
    // Every container rule is unknown rather than failed, and nothing is guessed
    // from the filename.
    for (const name of ['orientation', 'min_duration', 'min_resolution'] as const) {
      expect(result.preflight?.rules[name].status, name).toBe('unknown')
      expect(result.preflight?.rules[name].reason, name).toBe('container_facts_unavailable')
    }
    expect(result.preflight?.verdict).toBe('unknown')
  })

  it('falls back to the runtime for a file with no moov at all', async () => {
    const file = concat([box('ftyp', ascii('isom')), box('mdat', new Uint8Array(256))])
    const host = fakeExtractionHost({ probe: { duration_s: 6, reported: { width: 1080, height: 1920 } } })
    const result = await ingestMedia(ingestBufferInput('no-moov.mp4', file), deps(host))

    expect(result.parse_failure).toBe('moov_not_found')
    // Container metadata is an enhancement, never a dependency: a sheet still exists.
    expect(result.extraction?.sheet).not.toBeNull()
    expect(result.preflight?.rules.min_duration.status).toBe('pass')
    expect(result.preflight?.rules.min_duration.evidence).toBe('decode_pass')
    expect(result.preflight?.rules.duplicate.status).toBe('pass')
  })

  it('does not stall the batch on a file that fails, and the next file still ingests', async () => {
    const host = fakeExtractionHost({ stillDecoder: true })
    const batch = [
      ingestBufferInput('empty.mp4', new Uint8Array(0)),
      ingestBufferInput('mystery.mov', new Uint8Array(64).fill(0x5a)),
      ingestBufferInput('vertical_ok.mp4', fixtureBytes(requireFixture('vertical_ok'))),
    ]
    const results = []
    for (const file of batch) results.push(await ingestMedia(file, deps(host)))
    expect(results.map((result) => result.reason)).toEqual(['empty_file', 'not_media', null])
    expect(results[2]?.extraction?.sheet).not.toBeNull()
    expect(host.counters.released).toBe(host.counters.allocated)
  })

  it('inspects a 4GB file without reading it, because the header walk is range addressed', async () => {
    const header = concat([
      box('ftyp', ascii('isom')),
      box('moov', new Uint8Array(0)),
      // A `mdat` declaring four gigabytes through the 64 bit largesize form.
      concat([u32(1), ascii('mdat'), u64(4 * 1024 * 1024 * 1024)]),
    ])
    let served = 0
    const sparse = {
      size: 4 * 1024 * 1024 * 1024,
      bytesRead: 0,
      readCount: 0,
      async read(start: number, end: number) {
        served += 1
        if (start >= header.byteLength) return new Uint8Array(0)
        return header.subarray(start, Math.min(end, header.byteLength))
      },
    }
    const result = await ingestMedia(
      {
        filename: 'huge.mov',
        bytes: sparse.size,
        last_modified_ms: null,
        mime_type: 'video/quicktime',
        blob: null,
        source: sparse,
      },
      deps(fakeExtractionHost({ probe: null })),
    )
    // Memory does not track file size: the walk asked for a handful of ranges.
    expect(served).toBeLessThan(64)
    expect(result.reason).toBeNull()
    expect(result.preflight).not.toBeNull()
  })
})

describe('the codec question goes to the platform, never answered locally', () => {
  it('maps a fourcc to a probe key and reads the probe answer', () => {
    const report = { codecs: Object.fromEntries(
      Object.entries(REFERENCE_RUNTIME_CODECS).map(([key, decode]) => [key, { decode, powerEfficient: false }]),
    ) } as unknown as CapabilityReport
    const support = decodeSupportFromReport(report)

    expect(support({ fourcc: 'avc1', family: codecFamilyOf('avc1') })).toBe('yes')
    expect(support({ fourcc: 'hvc1', family: codecFamilyOf('hvc1') })).toBe('no')
    // ProRes has no probe key at all, and the absence of a key means no browser
    // implements it, which is `no` rather than `unknown`.
    expect(support({ fourcc: 'apcn', family: codecFamilyOf('apcn') })).toBe('no')
    // An unrecognised fourcc is unknown, not no: we do not know what it is.
    expect(support({ fourcc: 'zzzz', family: codecFamilyOf('zzzz') })).toBe('unknown')
  })

  it('does not attempt a decode for a codec the platform refused', async () => {
    const host = fakeExtractionHost()
    const result = await ingestMedia(
      ingestBufferInput('hevc.mov', fixtureBytes(requireFixture('hevc'))),
      deps(host, { decodeSupport: () => 'no' }),
    )
    expect(host.counters.decodeCalls).toHaveLength(0)
    expect(result.preflight?.rules.codec_playable.status).toBe('fail')
    expect(result.preflight?.rules.codec_playable.upload_priority).toBe('required_for_transcode')
  })
})

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
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
