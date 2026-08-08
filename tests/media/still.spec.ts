/**
 * The still image header reader.
 *
 * `photo_still.jpg` is a committed fixture whose declared dimensions came from
 * ffprobe, so the real assertion here is that our own header walk agrees with an
 * independent tool without decoding a single pixel. That is what lets a photo get a
 * real orientation and resolution verdict in a runtime with no image decoder.
 */

import { describe, expect, it } from 'vitest'
import { parseStill, sniffStillFormat, STILL_PARSER_VERSION } from '@/media/still'
import { fixtureBytes, requireFixture } from './_support'

describe('the committed still fixture', () => {
  const fixture = requireFixture('photo_still')

  it('reads dimensions from the JPEG start of frame marker, matching the probed facts', async () => {
    const facts = await parseStill(fixtureBytes(fixture))
    expect(facts.ok).toBe(true)
    expect(facts.parser_version).toBe(STILL_PARSER_VERSION)
    expect(facts.format).toBe('jpeg')
    expect(facts.coded.value).toEqual({
      width: fixture.declared.coded_width,
      height: fixture.declared.coded_height,
    })
    // Height before width in the SOF payload. Transposing them reports a portrait
    // photo as landscape, which fails the orientation rule on correct work.
    expect(facts.coded.value?.height).toBeGreaterThan(facts.coded.value?.width ?? 0)
    expect(facts.coded.confidence).toBe('exact')
    expect(facts.coded.evidence).toMatch(/^jpeg\/SOF/)
  })

  it('reports that it carries no EXIF rather than assuming a capture date', async () => {
    const facts = await parseStill(fixtureBytes(fixture))
    // We ship no EXIF parser. Saying so is better than a stills path that pretends
    // to exist, and the pre-flight reason code says exactly that.
    expect(facts.exif_present).toBe(false)
  })

  it('reads only the header, never the whole file', async () => {
    const facts = await parseStill(fixtureBytes(fixture))
    expect(facts.bytes_read).toBeLessThanOrEqual(128 * 1024)
    expect(facts.bytes).toBe(fixture.bytes)
  })
})

describe('format sniffing, from bytes and never from a filename', () => {
  it('names each format from its magic number', () => {
    expect(sniffStillFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpeg')
    expect(sniffStillFormat(png(4, 4))).toBe('png')
    expect(sniffStillFormat(gif(4, 4))).toBe('gif')
    expect(sniffStillFormat(webpVp8x(4, 4))).toBe('webp')
    expect(sniffStillFormat(heicHeader())).toBe('heif')
    expect(sniffStillFormat(new Uint8Array(16))).toBe('unknown')
  })

  it('refuses a HEIC still by name, with the remedy that also fixes the HEVC hole', async () => {
    const facts = await parseStill(heicHeader())
    expect(facts.format).toBe('heif')
    expect(facts.ok).toBe(false)
    expect(facts.reason).toBe('no_heif_parser')
    expect(facts.warnings.join(' ')).toMatch(/Most Compatible/)
    // No invented dimensions. An `ispe` box exists and reading it would imply we
    // can produce pixels, which we cannot.
    expect(facts.coded.value).toBeNull()
  })

  it('reads PNG, GIF and WebP dimensions', async () => {
    await expect(parseStill(png(1080, 1920)).then((f) => f.coded.value)).resolves.toEqual({
      width: 1080,
      height: 1920,
    })
    await expect(parseStill(gif(640, 480)).then((f) => f.coded.value)).resolves.toEqual({ width: 640, height: 480 })
    await expect(parseStill(webpVp8x(1440, 2560)).then((f) => f.coded.value)).resolves.toEqual({
      width: 1440,
      height: 2560,
    })
  })

  it('answers a zero byte file and a too short file without throwing', async () => {
    await expect(parseStill(new Uint8Array(0)).then((f) => f.reason)).resolves.toBe('empty_file')
    await expect(parseStill(new Uint8Array([0xff, 0xd8, 0xff])).then((f) => f.reason)).resolves.toBe('not_a_still')
  })

  it('reports a JPEG with no start of frame as truncated rather than guessing', async () => {
    // A JPEG header with one comment segment and then nothing.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x08, 1, 2, 3, 4, 5, 6])
    const facts = await parseStill(bytes)
    expect(facts.ok).toBe(false)
    expect(facts.reason).toBe('truncated')
    expect(facts.coded.value).toBeNull()
  })

  it('records an EXIF block as present without reading it', async () => {
    const bytes = concat([
      new Uint8Array([0xff, 0xd8]),
      // APP1 with the Exif identifier, then a payload we deliberately do not parse.
      new Uint8Array([0xff, 0xe1, 0x00, 0x10]),
      ascii('Exif\0\0'),
      // The declared segment length is 16, which covers its own two length bytes
      // plus fourteen of payload, so the next marker starts exactly here.
      new Uint8Array(8),
      // SOF0: precision, height, width, components.
      new Uint8Array([0xff, 0xc0, 0x00, 0x11, 8]),
      new Uint8Array([0x07, 0x80, 0x04, 0x38]),
      new Uint8Array(10),
    ])
    const facts = await parseStill(bytes)
    expect(facts.exif_present).toBe(true)
    expect(facts.coded.value).toEqual({ width: 1080, height: 1920 })
  })
})

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

function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(out.buffer)
  view.setUint32(8, 13)
  out.set(ascii('IHDR'), 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return out
}

function gif(width: number, height: number): Uint8Array {
  const out = new Uint8Array(16)
  out.set(ascii('GIF89a'), 0)
  out[6] = width & 0xff
  out[7] = (width >> 8) & 0xff
  out[8] = height & 0xff
  out[9] = (height >> 8) & 0xff
  return out
}

function webpVp8x(width: number, height: number): Uint8Array {
  const out = new Uint8Array(32)
  out.set(ascii('RIFF'), 0)
  out.set(ascii('WEBP'), 8)
  out.set(ascii('VP8X'), 12)
  const w = width - 1
  const h = height - 1
  out[24] = w & 0xff
  out[25] = (w >> 8) & 0xff
  out[26] = (w >> 16) & 0xff
  out[27] = h & 0xff
  out[28] = (h >> 8) & 0xff
  out[29] = (h >> 16) & 0xff
  return out
}

function heicHeader(): Uint8Array {
  const out = new Uint8Array(24)
  const view = new DataView(out.buffer)
  view.setUint32(0, 24)
  out.set(ascii('ftyp'), 4)
  out.set(ascii('heic'), 8)
  out.set(ascii('mif1'), 12)
  return out
}
