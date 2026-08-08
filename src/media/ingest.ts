/**
 * A7: one file in, facts and artefacts and a verdict out.
 *
 * The order matters and is the whole design:
 *
 * 1. Classify from the bytes. Not from the extension, not from the MIME type.
 * 2. Read the container or the still header. Cheap, exact, no decoder.
 * 3. Ask the platform whether this codec can be decoded here. Never answered locally.
 * 4. Extract frames, or record honestly that there are none.
 * 5. Evaluate the seven rules over the facts, the brief thresholds and the branch.
 *
 * Nothing here writes a database row. That belongs to the upload surface, which
 * owns the delivery, the ids and the outbox. This module's contract is narrower and
 * stronger: given these bytes, return everything we know, everything we do not, and
 * nothing we invented.
 *
 * A failure at any step is a named outcome with the rest of the result still
 * populated, because one unparseable file must not take down a forty file batch,
 * and partial evidence is used rather than discarded.
 */

import type { IngestPolicy } from '@/platform/capability'
import type { CapabilityReport } from '@/platform/capability'
import type { CodecKey, Support } from '@/platform/port'
import { blobSource, bufferSource, type ByteSource, type SliceableBlob } from './bytes'
import { codecFamilyOf, parseContainer, type ContainerFacts, type ParseFailureReason } from './atoms'
import { extractFrames, type ExtractionHost, type ExtractionResult, type MediaInput } from './extract'
import { evaluatePreflight, type PreflightContext, type PreflightResult } from './preflight'
import { parseStill, sniffStillFormat, type StillFacts } from './still'
import type { HashedAsset } from './phash'

export type IngestFailureReason = 'empty_file' | 'not_media' | 'unreadable'

export type IngestKind = 'video' | 'photo'

export interface IngestFile {
  filename: string
  bytes: number
  /** `File.lastModified`. Carried so it can be recorded as a fallback, never as a capture date. */
  last_modified_ms: number | null
  mime_type: string | null
  /** Present for a real `File` or `Blob`. Null when only a range reader is available. */
  blob: Blob | null
  source: ByteSource
}

export interface IngestDependencies {
  policy: IngestPolicy
  host: ExtractionHost
  context: PreflightContext
  /** Earlier assets in this delivery, earliest first. The duplicate rule's set. */
  priors: readonly HashedAsset[]
  /**
   * Whether this runtime can decode this codec. Answered by `platform-matrix`
   * through the capability probe, never by this module: media owns whether a
   * derivation is correct, platform owns where it runs.
   */
  decodeSupport: (query: { fourcc: string | null; family: ReturnType<typeof codecFamilyOf> }) => Support
  /** A capture date the creator typed, for the one unknown they can answer. */
  creator_stated_captured_at_ms?: number | null
}

export interface IngestResult {
  ok: boolean
  reason: IngestFailureReason | null
  kind: IngestKind
  file: { filename: string; bytes: number; mime_type: string | null; last_modified_ms: number | null }
  container: ContainerFacts | null
  /** Why the container parse produced nothing. Recorded even when the file turned out to be a still. */
  parse_failure: ParseFailureReason | null
  still: StillFacts | null
  extraction: ExtractionResult | null
  preflight: PreflightResult | null
  /** Bytes actually pulled. The claim "we never read mdat" has to be checkable. */
  bytes_read: number
  warnings: string[]
}

/** Wraps whatever a caller holds into the shape ingest wants. */
export function ingestFileInput(file: {
  name: string
  size: number
  type?: string
  lastModified?: number
  slice: SliceableBlob['slice']
}): IngestFile {
  const blob = file as unknown as Blob
  return {
    filename: file.name,
    bytes: file.size,
    last_modified_ms: typeof file.lastModified === 'number' ? file.lastModified : null,
    mime_type: file.type ? file.type : null,
    blob,
    source: blobSource(file as unknown as SliceableBlob),
  }
}

export function ingestBufferInput(
  name: string,
  buffer: ArrayBuffer | Uint8Array,
  options: { mime_type?: string | null; last_modified_ms?: number | null; blob?: Blob | null } = {},
): IngestFile {
  const source = bufferSource(buffer)
  return {
    filename: name,
    bytes: source.size,
    last_modified_ms: options.last_modified_ms ?? null,
    mime_type: options.mime_type ?? null,
    blob: options.blob ?? null,
    source,
  }
}

export async function ingestMedia(file: IngestFile, deps: IngestDependencies): Promise<IngestResult> {
  const result: IngestResult = {
    ok: false,
    reason: null,
    kind: 'video',
    file: {
      filename: file.filename,
      bytes: file.bytes,
      mime_type: file.mime_type,
      last_modified_ms: file.last_modified_ms,
    },
    container: null,
    parse_failure: null,
    still: null,
    extraction: null,
    preflight: null,
    bytes_read: 0,
    warnings: [],
  }

  // Zero bytes is answered before any element is created and before any timeout is
  // waited on, because the pathological case is forty of these in one drop.
  if (file.bytes === 0) {
    result.reason = 'empty_file'
    return result
  }

  const head = await file.source.read(0, Math.min(16, file.bytes))
  if (head.byteLength < 12) {
    result.reason = 'not_media'
    result.warnings.push(`the file is ${file.bytes} bytes, too short to carry any media header`)
    result.bytes_read = file.source.bytesRead
    return result
  }

  const stillFormat = sniffStillFormat(head)
  const input: MediaInput = {
    blob: file.blob,
    bytes: file.source,
    mime_type: file.mime_type,
    filename: file.filename,
  }

  if (stillFormat !== 'unknown') {
    result.kind = 'photo'
    result.still = await parseStill(file.source)
    result.warnings.push(...result.still.warnings)
    // A still named `.mov` is still a still. The container walk is recorded as
    // having refused these bytes, because that is a separate true fact, and the
    // video decode is never attempted on them.
    result.parse_failure = 'not_isobmff'
  } else {
    const container = await parseContainer(file.source, { sampleTables: true })
    result.container = container.ok ? container : null
    result.parse_failure = container.reason
    result.warnings.push(...container.warnings)
    if (!container.ok && container.reason === 'not_isobmff') {
      // Neither a movie nor a still we can read. Named, and the batch continues.
      result.reason = 'not_media'
      result.bytes_read = file.source.bytesRead
      return result
    }
    if (!container.ok) {
      // A movie whose metadata we could not read is still worth trying to decode:
      // container facts are an enhancement, never a dependency.
      result.warnings.push(
        `container metadata unusable (${container.reason}), so every container derived rule is unknown and the runtime is asked instead`,
      )
    }
  }

  const fourcc = result.container?.codec_video.value ?? null
  const family = codecFamilyOf(fourcc)
  const support: Support = result.kind === 'photo' ? 'yes' : deps.decodeSupport({ fourcc, family })

  result.extraction = await extractFrames(
    {
      input,
      kind: result.kind,
      policy: deps.policy,
      decodable: support,
      container: result.container,
      still: result.still,
    },
    deps.host,
  )

  result.preflight = evaluatePreflight(
    {
      kind: result.kind,
      file: {
        filename: file.filename,
        bytes: file.bytes,
        last_modified_ms: file.last_modified_ms,
        mime_type: file.mime_type,
      },
      container: result.container,
      still: result.still,
      parse_failure: result.parse_failure,
      decode: result.extraction.measured
        ? { duration_s: result.extraction.measured.duration_s, reported: result.extraction.measured.reported }
        : null,
      codec_support: support,
      // No browser decodes ProRes, which is a stronger statement than "not here"
      // and carries a different reason code and a different remedy.
      codec_unsupported_everywhere: family === 'prores',
      frames: {
        hashes: result.extraction.frame_hashes,
        failure: result.extraction.reason,
      },
      priors: deps.priors,
      creator_stated_captured_at_ms: deps.creator_stated_captured_at_ms ?? null,
    },
    deps.context,
  )

  result.ok = true
  result.bytes_read = file.source.bytesRead
  return result
}

/**
 * Maps a container fourcc onto the codec key the capability probe answers for, then
 * reads that answer.
 *
 * The split is the boundary: deciding that `hvc1` is HEVC is a fact about the
 * container and belongs here, and deciding whether HEVC decodes in this runtime is
 * a fact about the runtime and belongs to the probe. A codec with no probe key at
 * all (ProRes, MJPEG in a movie container) is `no` rather than `unknown`, because
 * the absence of a key means no browser implements it.
 */
export function decodeSupportFromReport(report: CapabilityReport): IngestDependencies['decodeSupport'] {
  const keyFor: Record<string, CodecKey> = { h264: 'h264', hevc: 'hevc', vp9: 'vp9', av1: 'av1' }
  return ({ family }) => {
    if (!family) return 'unknown'
    const key = keyFor[family]
    if (!key) return 'no'
    return report.codecs[key]?.decode ?? 'unknown'
  }
}
