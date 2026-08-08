/**
 * A2: still image facts, read from headers only.
 *
 * A creator can deliver a photo, and `photo_still.jpg` is a committed fixture, so
 * the pipeline needs the same three answers for a still that it needs for a clip:
 * how big is it, what is it, and what do we honestly not know.
 *
 * Two rules govern this module, and both are about refusing to guess.
 *
 * 1. **Dimensions come from the format's own header, never from a decoder.** The
 *    `SOF` marker in a JPEG and the `IHDR` chunk in a PNG are exact, they cost a
 *    few hundred bytes to read, and they work in a runtime with no image decoder
 *    at all. A jsdom test can therefore assert the real dimensions of the real
 *    committed fixture, which a decoder-based reader could never do.
 * 2. **There is no EXIF parser in this build, and that is stated rather than
 *    implied.** `exif_present` records that an APP1 Exif block was seen; nothing
 *    reads it. So a still's capture date is `unknown` with the reason
 *    `no_exif_parser_for_still_images`, which is a fact about our code and is
 *    better than a stills path that pretends to exist.
 *
 * HEIF is detected and refused by name, because it matters: an iPhone shooting in
 * High Efficiency writes `.HEIC`, Safari renders it and Chrome on Windows does
 * not, so "we cannot read this one, here is what would fix it" is the whole
 * product answer. The same Most Compatible camera setting fixes both this and the
 * HEVC video hole.
 */

import { toByteSource, type ByteSource, type SliceableBlob } from './bytes'
import type { Dimensions, Fact } from './atoms'

export const STILL_PARSER_VERSION = 1

export type StillFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'heif' | 'unknown'

export type StillFailureReason =
  | 'empty_file'
  | 'not_a_still'
  | 'no_heif_parser'
  | 'dimensions_not_declared'
  | 'truncated'

export interface StillFacts {
  ok: boolean
  reason: StillFailureReason | null
  parser_version: number
  format: StillFormat
  /** Pixel dimensions from the format header. Exact, or absent. */
  coded: Fact<Dimensions>
  /**
   * An EXIF block was present. Never parsed, so this is the honest statement that
   * evidence exists which this build does not read.
   */
  exif_present: boolean
  bytes: number
  bytes_read: number
  warnings: string[]
}

/** Enough for every header form below, and small enough to be one slice. */
const HEADER_WINDOW = 128 * 1024

export async function parseStill(
  input: ByteSource | ArrayBuffer | Uint8Array | SliceableBlob,
): Promise<StillFacts> {
  const source = toByteSource(input)
  const facts: StillFacts = {
    ok: false,
    reason: null,
    parser_version: STILL_PARSER_VERSION,
    format: 'unknown',
    coded: { value: null, confidence: 'none', evidence: 'none' },
    exif_present: false,
    bytes: source.size,
    bytes_read: 0,
    warnings: [],
  }

  if (source.size === 0) {
    facts.reason = 'empty_file'
    return facts
  }

  const head = await source.read(0, Math.min(HEADER_WINDOW, source.size))
  facts.bytes_read = source.bytesRead
  if (head.byteLength < 12) {
    facts.reason = 'not_a_still'
    facts.warnings.push(`file is ${head.byteLength} bytes, which is too short to carry an image header`)
    return facts
  }

  facts.format = sniffStillFormat(head)

  switch (facts.format) {
    case 'jpeg':
      readJpeg(head, facts)
      break
    case 'png':
      readPng(head, facts)
      break
    case 'gif':
      readGif(head, facts)
      break
    case 'webp':
      readWebp(head, facts)
      break
    case 'heif':
      // Detected and named. Dimensions live in an `ispe` box inside `meta`, and
      // reading them would imply we can produce pixels, which we cannot.
      facts.reason = 'no_heif_parser'
      facts.warnings.push(
        'HEIF or HEIC still: this build ships no HEIF reader, and Chromium on Windows has no HEIC decoder either. Switching the iPhone camera to Most Compatible produces JPEG and fixes it.',
      )
      return facts
    default:
      facts.reason = 'not_a_still'
      return facts
  }

  if (facts.coded.value === null) {
    facts.reason = facts.reason ?? 'dimensions_not_declared'
    return facts
  }

  facts.ok = true
  return facts
}

/**
 * Which still format these bytes are, from the magic numbers alone.
 *
 * Exported and separate from `parseStill` because the ingest step needs the answer
 * from sixteen bytes, before it decides whether to run the container parser or this
 * one. Classifying from the bytes rather than from the filename is the whole point:
 * an iPhone writes `.MOV` for two different codecs, and a creator can rename
 * anything.
 */
export function sniffStillFormat(head: Uint8Array): StillFormat {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'png'
  }
  if (ascii(head, 0, 3) === 'GIF') return 'gif'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp'
  // HEIF and HEIC are ISO BMFF: an `ftyp` box whose brand names the flavour.
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4)
    if (brand === 'heic' || brand === 'heix' || brand === 'heif' || brand === 'mif1' || brand === 'msf1') {
      return 'heif'
    }
  }
  return 'unknown'
}

/**
 * Walks JPEG markers to the first start of frame.
 *
 * `SOF0` through `SOF15` all carry precision, height then width, and every
 * baseline, progressive and lossless variant is covered by treating the whole
 * `0xC0` to `0xCF` range as a frame header except the three that are not
 * (`DHT`, `JPG`, `DAC`). Reading width before height is the classic transposition
 * bug here, and it produces a landscape verdict on a portrait photo.
 */
function readJpeg(head: Uint8Array, facts: StillFacts): void {
  let p = 2
  while (p + 4 <= head.byteLength) {
    if (head[p] !== 0xff) {
      // Fill bytes are legal between markers; anything else means we are lost.
      p += 1
      continue
    }
    const marker = head[p + 1] ?? 0
    if (marker === 0xff) {
      p += 1
      continue
    }
    // Standalone markers carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      p += 2
      continue
    }
    const length = (head[p + 2] ?? 0) * 256 + (head[p + 3] ?? 0)
    if (length < 2) {
      facts.warnings.push(`JPEG marker 0x${marker.toString(16)} declares a segment length of ${length}`)
      return
    }
    const segment = p + 4

    if (marker === 0xe1 && ascii(head, segment, 4) === 'Exif') {
      facts.exif_present = true
    }

    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      if (segment + 5 > head.byteLength) {
        facts.reason = 'truncated'
        facts.warnings.push('JPEG start of frame marker found but the file ends inside it')
        return
      }
      const height = (head[segment + 1] ?? 0) * 256 + (head[segment + 2] ?? 0)
      const width = (head[segment + 3] ?? 0) * 256 + (head[segment + 4] ?? 0)
      if (width > 0 && height > 0) {
        facts.coded = {
          value: { width, height },
          confidence: 'exact',
          evidence: `jpeg/SOF${(marker - 0xc0).toString(10)}`,
        }
      }
      return
    }

    if (marker === 0xda) {
      // Start of scan: the compressed data begins and there is no frame header.
      facts.warnings.push('JPEG scan started before any start of frame marker was found')
      return
    }
    p = p + 2 + length
  }
  facts.reason = 'truncated'
  facts.warnings.push('walked the JPEG header window without finding a start of frame marker')
}

function readPng(head: Uint8Array, facts: StillFacts): void {
  if (ascii(head, 12, 4) !== 'IHDR') {
    facts.warnings.push('PNG signature present but the first chunk is not IHDR')
    return
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width > 0 && height > 0) {
    facts.coded = { value: { width, height }, confidence: 'exact', evidence: 'png/IHDR' }
  }
}

function readGif(head: Uint8Array, facts: StillFacts): void {
  // Little endian logical screen descriptor, immediately after the 6 byte header.
  const width = (head[6] ?? 0) + (head[7] ?? 0) * 256
  const height = (head[8] ?? 0) + (head[9] ?? 0) * 256
  if (width > 0 && height > 0) {
    facts.coded = { value: { width, height }, confidence: 'exact', evidence: 'gif/logical_screen_descriptor' }
  }
}

function readWebp(head: Uint8Array, facts: StillFacts): void {
  const chunk = ascii(head, 12, 4)
  if (chunk === 'VP8X') {
    // Canvas size is stored minus one, 24 bit little endian.
    const width = 1 + le24(head, 24)
    const height = 1 + le24(head, 27)
    facts.coded = { value: { width, height }, confidence: 'exact', evidence: 'webp/VP8X' }
    return
  }
  if (chunk === 'VP8 ') {
    // Lossy: a 3 byte frame tag, a 3 byte sync code, then 14 bit dimensions.
    const width = ((head[27] ?? 0) * 256 + (head[26] ?? 0)) & 0x3fff
    const height = ((head[29] ?? 0) * 256 + (head[28] ?? 0)) & 0x3fff
    if (width > 0 && height > 0) {
      facts.coded = { value: { width, height }, confidence: 'exact', evidence: 'webp/VP8' }
    }
    return
  }
  if (chunk === 'VP8L') {
    // Lossless: a signature byte, then 14 bit width minus one and height minus one.
    const bits = le32(head, 21)
    const width = 1 + (bits & 0x3fff)
    const height = 1 + ((bits >>> 14) & 0x3fff)
    facts.coded = { value: { width, height }, confidence: 'exact', evidence: 'webp/VP8L' }
    return
  }
  facts.warnings.push(`WebP container with an unrecognised first chunk ${JSON.stringify(chunk)}`)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0)
  return out
}

function le24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256 + (bytes[offset + 2] ?? 0) * 65536
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) +
      (bytes[offset + 1] ?? 0) * 256 +
      (bytes[offset + 2] ?? 0) * 65536 +
      (bytes[offset + 3] ?? 0) * 16777216) >>>
    0
  )
}
