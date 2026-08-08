/**
 * A1: the ISO BMFF / QuickTime container parser.
 *
 * One question: given these bytes, what do we actually know, how did we come to
 * know it, and how much should anyone trust it? Every field therefore comes back
 * as a `Fact<T>` carrying a value, a confidence, and the atom path that produced
 * it. A field with no evidence is `{ value: null, confidence: 'none', evidence:
 * 'none' }`, never a plausible default, because a plausible default is what turns
 * a missing atom into a false statement about somebody's footage.
 *
 * Four rules are load bearing here, and each of them exists because getting it
 * wrong produces a confident wrong answer rather than an error.
 *
 * 1. **Coded dimensions never come from `tkhd`.** `tkhd` holds the aspect
 *    corrected PRESENTATION size, which coincides with the coded size only at
 *    square pixels. `public/fixtures/lowres_fail.mp4` exists because an early
 *    build of it wrote 478.88x854 into `tkhd` for a 480x854 encode. Coded size
 *    comes from the `stsd` visual sample entry, and `docs/06-decisions.md` D8
 *    settles it.
 * 2. **A zero `mvhd` creation field is absence, not 1904.** The 1904 epoch
 *    conversion applied to zero reports a capture date of 1904-01-01, which is
 *    worse than reporting nothing.
 * 3. **`File.lastModified` is never a capture date.** This module never sees it;
 *    the pre-flight engine records it as a named fallback and never promotes it.
 * 4. **`moov` may follow `mdat`.** The walk hops top level headers rather than
 *    reading a prefix and hoping, and it never reads `mdat` at all.
 *
 * Everything is bounded: a byte budget, a hop budget, and a per atom sanity
 * check, so a file whose atom sizes are absurd (deliberately or through
 * truncation) makes the walk stop with a named reason rather than loop.
 */

import { blobSource, bufferSource, toByteSource, type ByteSource, type SliceableBlob } from './bytes'

// ---------------------------------------------------------------------------
// the vocabulary
// ---------------------------------------------------------------------------

export const PARSER_VERSION = 1

/**
 * Why a parse produced nothing usable. Each of these is a named outcome with its
 * own UI consequence, which is the point: "it failed" is not an outcome.
 */
export type ParseFailureReason =
  | 'empty_file'
  | 'not_isobmff'
  | 'moov_not_found'
  | 'metadata_unparseable'

/**
 * How much a field should be trusted, which is a different question from whether
 * it is present.
 *
 * - `exact`: read straight out of a spec defined field, no interpretation.
 * - `high`: derived from spec fields by a documented reduction (rotation from the
 *   matrix, duration from duration over timescale).
 * - `medium`: present, but the source is known to be unreliable in the field.
 *   `mvhd` creation time is defined as UTC and cameras write local time into it.
 * - `low`: present but weak, or two sources disagree and we picked one.
 * - `none`: absent. The value is null.
 */
export type Confidence = 'exact' | 'high' | 'medium' | 'low' | 'none'

export interface Fact<T> {
  value: T | null
  confidence: Confidence
  /** The atom path this came from, or `none`. Never a free text explanation. */
  evidence: string
  /** Present when the value needs a caveat a human would want to read. */
  note?: string
}

export type Rotation = 0 | 90 | 180 | 270

export interface Dimensions {
  width: number
  height: number
}

export interface GpsFix {
  lat: number
  lng: number
  alt_m: number | null
}

/** Which atom the GPS came out of. Three real forms exist and all three are parsed. */
export type GpsAtom = 'udta_loci_3gpp' | 'udta_c_xyz_iso6709' | 'apple_quicktime_iso6709'

/** Which atom a capture instant came out of. */
export type CaptureAtom = 'mvhd' | 'udta_day' | 'apple_quicktime'

export interface CaptureCandidate {
  source: CaptureAtom
  /** Epoch milliseconds. */
  at_ms: number
  /** The raw field, so a misread epoch is a diff rather than a mystery. */
  raw: string | number
  /**
   * True when the source carried a UTC offset. A source that carries one outranks
   * one that does not, because `mvhd` is defined as UTC and is routinely written
   * in camera local time.
   */
  has_offset: boolean
  confidence: Confidence
}

export interface SampleAspect {
  h: number
  v: number
}

export interface VideoTrackFacts {
  track_id: number
  /** From the `stsd` visual sample entry. The only correct source for coded size. */
  coded: Dimensions | null
  /** From `tkhd`. Presentation size, which is NOT the coded size at non square pixels. */
  presentation: Dimensions | null
  rotation_deg: Rotation | null
  matrix: number[] | null
  sample_aspect: SampleAspect | null
  codec_fourcc: string | null
  /** `avcC` or `hvcC` payload, needed verbatim by `VideoDecoder.configure`. */
  codec_description: Uint8Array | null
  /** RFC 6381 style string derived from the description, for `isConfigSupported`. */
  codec_string: string | null
  timescale: number | null
  duration_s: number | null
  /** Frames divided by duration. Nominal: a variable frame rate clip has no single fps. */
  nominal_fps: number | null
  sample_count: number | null
}

export interface AudioTrackFacts {
  track_id: number
  codec_fourcc: string | null
  duration_s: number | null
}

export interface ContainerFacts {
  ok: boolean
  reason: ParseFailureReason | null
  parser_version: number

  /** `mp4` or `mov`, from the `ftyp` brand rather than from the filename. */
  container: Fact<'mp4' | 'mov'>
  ftyp_brand: string | null

  duration_s: Fact<number>
  /** Coded dimensions, from `stsd`. Never from `tkhd`. */
  coded: Fact<Dimensions>
  /** `tkhd` presentation size, kept separately and labelled so it cannot be mistaken for coded size. */
  presentation: Fact<Dimensions>
  /** Coded size with the sample aspect ratio and then the rotation applied. What a human sees. */
  display: Fact<Dimensions>
  rotation_deg: Fact<Rotation>
  sample_aspect: Fact<SampleAspect>
  codec_video: Fact<string>
  codec_audio: Fact<string>
  has_audio: Fact<boolean>
  codec_string: Fact<string>
  codec_description: Uint8Array | null

  captured_at: Fact<number>
  captured_at_source: CaptureAtom | null
  /** Every candidate found, so a disagreement between sources is visible rather than resolved silently. */
  captured_at_candidates: CaptureCandidate[]
  mvhd_creation_time_raw: number | null

  gps: Fact<GpsFix>
  gps_atom: GpsAtom | null

  bytes: number
  video_tracks: VideoTrackFacts[]
  audio_tracks: AudioTrackFacts[]

  /** Diagnostics: where the metadata actually was, and what the walk cost. */
  moov_offset: number | null
  mdat_offset: number | null
  moov_position: 'start' | 'end' | 'unknown'
  top_level_types: string[]
  /**
   * Every atom path the recursive walker reached inside `moov`, in container
   * order: `moov/trak[0]/mdia/minf/stbl/stsd/avc1`. Diagnostics rather than a
   * derivation, and the cheapest way to see that a file was walked as a tree
   * rather than sniffed for a byte pattern.
   */
  atom_paths: string[]
  bytes_read: number
  atoms_visited: number
  /** Non fatal oddities. A warning never changes a verdict, it explains one. */
  warnings: string[]

  /** Only populated when `sampleTables` was requested. */
  video_sample_table: VideoSampleTable | null
}

export interface Sample {
  index: number
  offset: number
  size: number
  /** Decode time in milliseconds. */
  dts_ms: number
  /** Composition (presentation) time in milliseconds. */
  cts_ms: number
  sync: boolean
}

export interface VideoSampleTable {
  timescale: number
  samples: Sample[]
  sync_indexes: number[]
  /** True when the file declared no `stss`, meaning every sample is a sync sample. */
  all_sync: boolean
  duration_ms: number
}

export interface ParseOptions {
  /**
   * Read the sample tables as well, which is what makes a real WebCodecs demux
   * possible. Off by default: it is only needed by the decode path, and parsing
   * it on every ingest would cost memory for nothing.
   */
  sampleTables?: boolean
  /** Hard ceiling on bytes pulled. `mdat` is never inside this budget. */
  maxBytesRead?: number
  /** Hard ceiling on atom headers visited, so a cyclic or absurd file cannot loop. */
  maxAtoms?: number
}

const DEFAULT_MAX_BYTES_READ = 2 * 1024 * 1024
const DEFAULT_MAX_ATOMS = 512

/** The 1904 epoch. QuickTime counts seconds from 1904-01-01, Unix from 1970-01-01. */
export const QUICKTIME_EPOCH_OFFSET_S = 2082844800

/**
 * Top level atom types we are prepared to see. A file whose first atom is not one
 * of these is not ISO BMFF, and saying so is better than walking garbage.
 */
const KNOWN_TOP_LEVEL = new Set([
  'ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid',
  'moof', 'mfra', 'meta', 'junk', 'pict', 'sidx', 'ssix',
])

/** Atoms whose payload is a list of child atoms. Read by the recursive walker. */
export const CONTAINER_ATOMS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'tapt',
  'gmhd', 'mvex', 'moof', 'traf', 'ilst', 'wave',
])

const VIDEO_SAMPLE_FORMATS = new Set([
  'avc1', 'avc3', 'avcC', 'hvc1', 'hev1', 'hvcC', 'mp4v', 'apcn', 'apch', 'apcs',
  'apco', 'ap4h', 'ap4x', 'av01', 'vp09', 'vp08', 'dvh1', 'dvhe', 'jpeg', 'mjpa',
])

// Which codecs a browser could conceivably decode. ProRes is in no browser at
// all, which is a stronger statement than the HEVC case and is why the two carry
// different reason codes downstream.
const CODEC_FAMILY: Record<string, 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores' | 'other'> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
  vp09: 'vp9', vp08: 'vp9', av01: 'av1',
  apcn: 'prores', apch: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores', ap4x: 'prores',
  mp4v: 'other', jpeg: 'other', mjpa: 'other',
}

export function codecFamilyOf(fourcc: string | null): 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores' | 'other' | null {
  if (!fourcc) return null
  return CODEC_FAMILY[fourcc] ?? null
}

// ---------------------------------------------------------------------------
// the entry point
// ---------------------------------------------------------------------------

/**
 * Parses container facts out of a file, a blob, a buffer, or an already wrapped
 * source.
 *
 * Never throws on bad input. A file this cannot understand comes back with
 * `ok: false` and a named reason, because one unparseable file must not take down
 * a forty file batch.
 */
export async function parseContainer(
  input: ByteSource | ArrayBuffer | Uint8Array | SliceableBlob,
  options: ParseOptions = {},
): Promise<ContainerFacts> {
  const source = toByteSource(input)
  const maxBytesRead = options.maxBytesRead ?? DEFAULT_MAX_BYTES_READ
  const maxAtoms = options.maxAtoms ?? DEFAULT_MAX_ATOMS
  const facts = emptyFacts(source.size)

  if (source.size === 0) return fail(facts, 'empty_file', source)
  if (source.size < 8) {
    facts.warnings.push(`file is ${source.size} bytes, which is too short to hold a single atom header`)
    return fail(facts, 'not_isobmff', source)
  }

  let top: TopLevelWalk
  try {
    top = await walkTopLevel(source, maxBytesRead, maxAtoms)
  } catch (error) {
    facts.warnings.push(`top level walk failed: ${describeError(error)}`)
    return fail(facts, 'metadata_unparseable', source)
  }

  facts.warnings.push(...top.warnings)
  facts.top_level_types = top.types
  facts.mdat_offset = top.mdatOffset
  facts.atoms_visited = top.atomsVisited

  if (!top.isIsoBmff) return fail(facts, 'not_isobmff', source)

  facts.ftyp_brand = top.brand
  if (top.brand) {
    const container = top.brand.startsWith('qt') ? 'mov' : 'mp4'
    facts.container = { value: container, confidence: 'exact', evidence: 'ftyp' }
  } else {
    facts.warnings.push('no ftyp atom, so the container brand is unknown')
  }

  if (top.moovOffset === null || top.moovSize === null) return fail(facts, 'moov_not_found', source)

  facts.moov_offset = top.moovOffset
  facts.moov_position =
    top.mdatOffset === null ? 'start' : top.moovOffset < top.mdatOffset ? 'start' : 'end'

  const remainingBudget = maxBytesRead - source.bytesRead
  if (remainingBudget <= 0) {
    facts.warnings.push('byte budget exhausted before moov could be read')
    return fail(facts, 'metadata_unparseable', source)
  }

  const wanted = Math.min(top.moovSize, remainingBudget)
  if (wanted < top.moovSize) {
    facts.warnings.push(
      `moov is ${top.moovSize} bytes and the read budget allows ${wanted}, so it was parsed truncated`,
    )
  }
  const moov = await source.read(top.moovOffset, top.moovOffset + wanted)
  if (moov.byteLength < 16) {
    facts.warnings.push(`moov header found at ${top.moovOffset} but only ${moov.byteLength} bytes are present`)
    return fail(facts, 'moov_not_found', source)
  }

  // One budget across both walks, starting from what the top level walk already
  // spent, so the hop cap is a statement about the file rather than about a level.
  const budget: AtomBudget = { atoms: top.atomsVisited, max: maxAtoms, warnings: facts.warnings }
  try {
    readMoov(moov, facts, budget, options.sampleTables === true)
  } catch (error) {
    facts.warnings.push(`moov parse failed: ${describeError(error)}`)
    facts.atoms_visited = budget.atoms
    return fail(facts, 'metadata_unparseable', source)
  }
  facts.atoms_visited = budget.atoms

  if (options.sampleTables === true && facts.video_sample_table === null) {
    facts.warnings.push('sample tables were requested but the video track carries none')
  }

  // A `moov` we found and could read nothing out of is not a parse: reporting `ok`
  // with every field null would hand the caller a container it has to re-check
  // field by field. This is the truncated or absurdly sized moov case.
  if (facts.video_tracks.length === 0 && facts.duration_s.value === null && facts.mvhd_creation_time_raw === null) {
    facts.warnings.push('moov was located but carried no readable mvhd, duration or track')
    return fail(facts, 'metadata_unparseable', source)
  }

  facts.ok = true
  facts.bytes_read = source.bytesRead
  return facts
}

/** Convenience wrappers, so callers do not have to know about `ByteSource`. */
export function containerSourceFromBlob(blob: SliceableBlob): ByteSource {
  return blobSource(blob)
}

export function containerSourceFromBuffer(buffer: ArrayBuffer | Uint8Array): ByteSource {
  return bufferSource(buffer)
}

// ---------------------------------------------------------------------------
// the top level walk
// ---------------------------------------------------------------------------

interface TopLevelWalk {
  isIsoBmff: boolean
  brand: string | null
  moovOffset: number | null
  moovSize: number | null
  mdatOffset: number | null
  types: string[]
  warnings: string[]
  atomsVisited: number
}

/**
 * Hops the top level atom headers looking for `moov`, reading 16 bytes per hop.
 *
 * This is the whole reason a 4GB file costs nothing to inspect, and the reason a
 * trailing `moov` (every `.mov` ffmpeg writes without `+faststart`, and every
 * iPhone clip) is found rather than missed. A parser that reads the first N bytes
 * and expects `moov` fails on three of the committed fixtures.
 */
async function walkTopLevel(source: ByteSource, maxBytesRead: number, maxAtoms: number): Promise<TopLevelWalk> {
  const walk: TopLevelWalk = {
    isIsoBmff: false,
    brand: null,
    moovOffset: null,
    moovSize: null,
    mdatOffset: null,
    types: [],
    warnings: [],
    atomsVisited: 0,
  }

  let offset = 0
  let first = true

  while (offset + 8 <= source.size) {
    if (walk.atomsVisited >= maxAtoms) {
      walk.warnings.push(`stopped after ${maxAtoms} top level atoms, which is a hop cap rather than a file end`)
      break
    }
    if (source.bytesRead >= maxBytesRead) {
      walk.warnings.push('stopped walking top level atoms: byte budget exhausted')
      break
    }

    const header = await source.read(offset, Math.min(offset + 16, source.size))
    if (header.byteLength < 8) break
    walk.atomsVisited += 1

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const declared = view.getUint32(0)
    const type = fourccAt(header, 4)

    if (first) {
      first = false
      // The cheapest possible honest check. A JPEG's first four bytes read as a
      // ~4GB size and a non printable type, so this is where `photo_still.jpg`
      // and a PNG renamed to `.mov` get a reason instead of a stack trace.
      if (!KNOWN_TOP_LEVEL.has(type)) {
        walk.warnings.push(`first atom type ${JSON.stringify(type)} is not an ISO BMFF top level box`)
        return walk
      }
      walk.isIsoBmff = true
      if (type !== 'ftyp') {
        walk.warnings.push(
          `first atom is ${type} rather than ftyp, which is unusual but legal enough to keep walking`,
        )
      }
    }

    let size = declared
    let headerBytes = 8
    if (declared === 1) {
      if (header.byteLength < 16) {
        walk.warnings.push(`${type} declares a 64 bit size but the file ends inside its header`)
        break
      }
      // The 64 bit form: `size == 1`, then an 8 byte largesize, so the header is
      // 16 bytes rather than 8. A walker that hops by 1 here loops forever.
      const large = view.getBigUint64(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        walk.warnings.push(`${type} declares an unrepresentable 64 bit size`)
        break
      }
      size = Number(large)
      headerBytes = 16
    } else if (declared === 0) {
      // `size == 0` means "to the end of the file". Treating it as zero length is
      // the other way this walk turns into an infinite loop.
      size = source.size - offset
    }

    if (size < headerBytes) {
      walk.warnings.push(`${type} at ${offset} declares size ${size}, which is smaller than its own header`)
      break
    }
    if (offset + size > source.size) {
      walk.warnings.push(
        `${type} at ${offset} declares size ${size} but only ${source.size - offset} bytes remain, so the file is truncated`,
      )
      // Keep what we have: a truncated `mdat` is still a valid `moov` if `moov`
      // came first, which is exactly the truncated download case.
      if (type === 'moov') {
        walk.moovOffset = offset
        walk.moovSize = source.size - offset
        walk.types.push(type)
      }
      break
    }

    walk.types.push(type)

    if (type === 'ftyp' && walk.brand === null) {
      const brandBytes = await source.read(offset + headerBytes, offset + headerBytes + 4)
      if (brandBytes.byteLength === 4) walk.brand = fourccAt(brandBytes, 0)
    }
    if (type === 'moov' && walk.moovOffset === null) {
      walk.moovOffset = offset
      walk.moovSize = size
    }
    if (type === 'mdat' && walk.mdatOffset === null) {
      walk.mdatOffset = offset
    }
    if (type === 'moof') {
      walk.warnings.push(
        'moof present: this is a fragmented file, so the sample tables in moov may describe no samples',
      )
    }

    offset += size
  }

  if (walk.moovOffset === null && walk.isIsoBmff) {
    walk.warnings.push('walked every top level atom without finding moov')
  }
  return walk
}

// ---------------------------------------------------------------------------
// the moov walk
// ---------------------------------------------------------------------------

interface BoxRef {
  type: string
  start: number
  end: number
  bodyStart: number
}

/**
 * One shared budget for the whole walk: hops made, the cap, and the warnings
 * collected on the way. Shared rather than per level so "under 512 atom headers
 * for any file" is a claim about the file and not about one subtree.
 */
interface AtomBudget {
  atoms: number
  max: number
  warnings: string[]
}

/**
 * Walks the children of one box, calling back per child.
 *
 * Returns the number of boxes visited so the caller can enforce a global hop cap.
 * Every size anomaly stops this level rather than throwing, so a corrupt sub tree
 * costs its own subtree and nothing else.
 */
function eachChild(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  end: number,
  budget: AtomBudget,
  visit: (box: BoxRef) => void,
): void {
  let offset = start
  while (offset + 8 <= end) {
    if (budget.atoms >= budget.max) {
      budget.warnings.push(`atom hop cap of ${budget.max} reached inside moov`)
      return
    }
    budget.atoms += 1

    const declared = view.getUint32(offset)
    const type = fourccAt(bytes, offset + 4)
    let size = declared
    let headerBytes = 8

    if (declared === 1) {
      if (offset + 16 > end) {
        budget.warnings.push(`${type} declares a 64 bit size but its header runs past its parent`)
        return
      }
      const large = view.getBigUint64(offset + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        budget.warnings.push(`${type} declares an unrepresentable 64 bit size`)
        return
      }
      size = Number(large)
      headerBytes = 16
    } else if (declared === 0) {
      size = end - offset
    }

    if (size < headerBytes) {
      budget.warnings.push(`${type} declares size ${size}, smaller than its own header, so this level stops here`)
      return
    }
    if (offset + size > end) {
      budget.warnings.push(
        `${type} declares size ${size} but its parent has ${end - offset} bytes left, so this level stops here`,
      )
      return
    }

    visit({ type, start: offset, end: offset + size, bodyStart: offset + headerBytes })
    offset += size
  }
}

// ---------------------------------------------------------------------------
// the recursive child walker
// ---------------------------------------------------------------------------

/**
 * One atom in the tree, with the path that reached it.
 *
 * Offsets are into the buffer the tree was built over (the `moov` window), not
 * into the file, because that window is the only thing this parser ever holds in
 * memory.
 */
export interface AtomNode {
  type: string
  /** Slash separated, with a bracketed index on repeated siblings: `moov/trak[1]/mdia`. */
  path: string
  depth: number
  start: number
  end: number
  bodyStart: number
  children: AtomNode[]
}

/**
 * Depth cap for the recursive descent.
 *
 * The deepest legal path this parser cares about is
 * `moov/trak/mdia/minf/stbl/stsd/avc1`, which is depth 6, so 8 leaves room for a
 * writer that nests one more level and still refuses a file that claims to nest
 * forever.
 */
export const MAX_ATOM_DEPTH = 8

/**
 * Where a container's children begin, or null when this atom holds data rather
 * than boxes.
 *
 * `CONTAINER_ATOMS` is the vocabulary: those are plain containers whose payload
 * is a child list starting at the body. Two atoms are irregular and are named
 * here rather than added to that set, because their child offset is not the body
 * offset and a generic walk would read four or eight bytes of the wrong thing:
 *
 * - `meta` is a FullBox in ISO BMFF and a plain box in QuickTime, so the start is
 *   sniffed rather than assumed.
 * - `stsd` is a FullBox with an entry count, so its children (the sample entries)
 *   start eight bytes in.
 *
 * A sample entry (`avc1`, `hvc1`, `mp4a`) is deliberately NOT descended: its
 * children begin after a fixed 78 or 28 byte body that differs by media type, so
 * they are read by the specialised reader that knows which one it is looking at.
 */
function childrenStartOf(bytes: Uint8Array, node: Pick<AtomNode, 'type' | 'bodyStart'>): number | null {
  if (CONTAINER_ATOMS.has(node.type)) return node.bodyStart
  if (node.type === 'meta') return metaChildStart(bytes, node)
  if (node.type === 'stsd') return node.bodyStart + 8
  return null
}

/**
 * Fills in `node.children`, recursively, for every atom whose payload is a child
 * list.
 *
 * This is the walk that turns "find the atom at this path" into a lookup instead
 * of six nested hand written loops, and it shares one hop budget with the top
 * level walk so the 512 hop cap is global rather than per level. A subtree whose
 * sizes are inconsistent stops at that subtree: `eachChild` returns rather than
 * throwing, so a corrupt `udta` costs the `udta` and nothing else.
 */
function buildAtomTree(bytes: Uint8Array, view: DataView, node: AtomNode, budget: AtomBudget): void {
  const start = childrenStartOf(bytes, node)
  if (start === null) return
  if (node.depth >= MAX_ATOM_DEPTH) {
    budget.warnings.push(`stopped descending at ${node.path}: depth cap of ${MAX_ATOM_DEPTH} reached`)
    return
  }

  const boxes: BoxRef[] = []
  eachChild(bytes, view, start, node.end, budget, (box) => {
    boxes.push(box)
  })

  // Repeated siblings get a bracketed index and a lone child does not, so
  // `moov/trak[0]` and `moov/trak[1]` are distinguishable while `moov/mvhd`
  // stays readable. Two passes because the suffix depends on the total.
  const totals = new Map<string, number>()
  for (const box of boxes) totals.set(box.type, (totals.get(box.type) ?? 0) + 1)
  const seen = new Map<string, number>()

  for (const box of boxes) {
    const index = seen.get(box.type) ?? 0
    seen.set(box.type, index + 1)
    const child: AtomNode = {
      type: box.type,
      path: (totals.get(box.type) ?? 1) > 1 ? `${node.path}/${box.type}[${index}]` : `${node.path}/${box.type}`,
      depth: node.depth + 1,
      start: box.start,
      end: box.end,
      bodyStart: box.bodyStart,
      children: [],
    }
    node.children.push(child)
    buildAtomTree(bytes, view, child, budget)
  }
}

/** The first child of this type, or null. Absence is a normal answer here. */
export function childOf(node: AtomNode, type: string): AtomNode | null {
  return node.children.find((child) => child.type === type) ?? null
}

export function childrenOf(node: AtomNode, type: string): AtomNode[] {
  return node.children.filter((child) => child.type === type)
}

/**
 * Every atom of this type anywhere below `node`, in container order.
 *
 * Needed because `meta` legally appears at `moov/meta`, at `moov/udta/meta` and
 * at `moov/trak/meta` depending on the writer, and an iPhone's creation date is
 * in whichever one it chose.
 */
export function descendantsOf(node: AtomNode, type: string): AtomNode[] {
  const out: AtomNode[] = []
  const visit = (current: AtomNode): void => {
    for (const child of current.children) {
      if (child.type === type) out.push(child)
      visit(child)
    }
  }
  visit(node)
  return out
}

function collectPaths(node: AtomNode): string[] {
  const out = [node.path]
  for (const child of node.children) out.push(...collectPaths(child))
  return out
}

function readMoov(
  moov: Uint8Array,
  facts: ContainerFacts,
  budget: AtomBudget,
  sampleTables: boolean,
): void {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)

  // `moov` itself is the box at offset 0 of this buffer.
  let moovBody = 8
  const declared = view.getUint32(0)
  if (declared === 1) moovBody = 16

  const root: AtomNode = {
    type: 'moov',
    path: 'moov',
    depth: 0,
    start: 0,
    // The buffer, not the declared size: a truncated download hands us fewer
    // bytes than the header claims and the walk must stop at what is present.
    end: moov.byteLength,
    bodyStart: moovBody,
    children: [],
  }
  buildAtomTree(moov, view, root, budget)
  facts.atom_paths = collectPaths(root)

  const mvhdNode = childOf(root, 'mvhd')
  if (mvhdNode) {
    const mvhd = readMvhd(moov, view, mvhdNode)
    facts.mvhd_creation_time_raw = mvhd.creationRaw

    if (mvhd.creationRaw > 0) {
      facts.captured_at_candidates.push({
        source: 'mvhd',
        at_ms: (mvhd.creationRaw - QUICKTIME_EPOCH_OFFSET_S) * 1000,
        raw: mvhd.creationRaw,
        has_offset: false,
        // Defined as UTC by the specification, and routinely written in camera
        // local time in practice, so a value here is a hint and not a fact.
        confidence: 'medium',
      })
    } else {
      // Rule two of this module: zero is absence. Applying the 1904 epoch to it
      // reports a capture date of 1904-01-01, which is worse than nothing.
      facts.warnings.push('mvhd creation time is zero, which is absence rather than 1904-01-01')
    }

    if (mvhd.timescale > 0) {
      const seconds = mvhd.duration / mvhd.timescale
      facts.duration_s = {
        value: round(seconds, 6),
        confidence: 'high',
        evidence: 'moov/mvhd',
        note: 'duration divided by timescale. A fragmented file can legally report 0 here.',
      }
      if (seconds === 0) {
        facts.warnings.push('mvhd reports a zero duration, which a fragmented or still-writing file does')
      }
    }
  } else {
    facts.warnings.push('moov carries no mvhd, so there is no movie duration or creation time')
  }

  for (const trak of childrenOf(root, 'trak')) {
    readTrak(moov, view, trak, budget, facts, sampleTables)
  }

  const udta = childOf(root, 'udta')
  if (udta) readUdta(moov, view, udta, facts)

  // `meta` turns up at `moov/meta`, at `moov/udta/meta` and at `moov/trak/meta`
  // depending on the writer, and an iPhone's creation date is in whichever one it
  // chose, so every one of them is read rather than the two we happened to expect.
  for (const meta of descendantsOf(root, 'meta')) {
    readAppleMeta(moov, view, meta, budget, facts)
  }

  finaliseVideoFacts(facts)
  finaliseCapture(facts)
}

interface MvhdFields {
  creationRaw: number
  timescale: number
  duration: number
}

function readMvhd(bytes: Uint8Array, view: DataView, box: BoxRef): MvhdFields {
  const version = bytes[box.bodyStart] ?? 0
  let p = box.bodyStart + 4
  let creationRaw = 0
  let timescale = 0
  let duration = 0

  if (version === 1) {
    creationRaw = Number(view.getBigUint64(p))
    p += 16 // creation plus modification
    timescale = view.getUint32(p)
    p += 4
    duration = Number(view.getBigUint64(p))
  } else {
    creationRaw = view.getUint32(p)
    p += 8 // creation plus modification
    timescale = view.getUint32(p)
    p += 4
    duration = view.getUint32(p)
  }
  return { creationRaw, timescale, duration }
}

/**
 * Reads one track out of the atom tree.
 *
 * Every lookup here is a named path rather than a nested loop, which is the whole
 * point of walking the tree first: a track with no `mdia`, or an `mdia` with no
 * `stbl`, produces nulls and a warning instead of a silently skipped branch.
 */
function readTrak(
  bytes: Uint8Array,
  view: DataView,
  trak: AtomNode,
  budget: AtomBudget,
  facts: ContainerFacts,
  sampleTables: boolean,
): void {
  const tkhdNode = childOf(trak, 'tkhd')
  const tkhd = tkhdNode ? readTkhd(bytes, view, tkhdNode) : null
  const trackId = tkhd?.trackId ?? 0
  const matrix = tkhd?.matrix ?? null
  const presentation = tkhd?.presentation ?? null

  const mdia = childOf(trak, 'mdia')
  if (!mdia) {
    facts.warnings.push(`${trak.path} carries no mdia, so the track cannot be described`)
    return
  }

  const mdhd = childOf(mdia, 'mdhd')
  let mediaTimescale: number | null = null
  let mediaDurationUnits: number | null = null
  if (mdhd) {
    const version = bytes[mdhd.bodyStart] ?? 0
    let p = mdhd.bodyStart + 4
    if (version === 1) {
      p += 16 // creation plus modification, 64 bit
      mediaTimescale = view.getUint32(p)
      p += 4
      mediaDurationUnits = Number(view.getBigUint64(p))
    } else {
      p += 8 // creation plus modification, 32 bit
      mediaTimescale = view.getUint32(p)
      p += 4
      mediaDurationUnits = view.getUint32(p)
    }
  }

  const hdlr = childOf(mdia, 'hdlr')
  const handler = hdlr ? fourccAt(bytes, hdlr.bodyStart + 8) : null
  const minf = childOf(mdia, 'minf')
  const stbl = minf ? childOf(minf, 'stbl') : null

  const durationSeconds =
    mediaTimescale && mediaTimescale > 0 && mediaDurationUnits !== null
      ? round(mediaDurationUnits / mediaTimescale, 6)
      : null

  if (handler === 'soun') {
    const entry = stbl ? firstSampleEntry(stbl) : null
    facts.audio_tracks.push({
      track_id: trackId,
      codec_fourcc: entry?.type ?? null,
      duration_s: durationSeconds,
    })
    return
  }

  if (handler !== 'vide') {
    if (handler) facts.warnings.push(`ignored a track with handler ${handler}`)
    else facts.warnings.push(`${trak.path} has no hdlr, so its media type is unknown and it was ignored`)
    return
  }

  const visual = stbl ? readVisualSampleEntry(bytes, view, stbl, budget) : null
  const table = sampleTables && stbl ? readSampleTable(bytes, view, stbl, mediaTimescale ?? 0) : null

  const track: VideoTrackFacts = {
    track_id: trackId,
    coded: visual?.coded ?? null,
    presentation,
    rotation_deg: matrix ? rotationFromMatrix(matrix) : null,
    matrix,
    sample_aspect: visual?.sampleAspect ?? null,
    codec_fourcc: visual?.format ?? null,
    codec_description: visual?.description ?? null,
    codec_string: visual?.codecString ?? null,
    timescale: mediaTimescale,
    duration_s: durationSeconds,
    nominal_fps:
      table && durationSeconds && durationSeconds > 0
        ? round(table.samples.length / durationSeconds, 3)
        : null,
    sample_count: table ? table.samples.length : null,
  }

  facts.video_tracks.push(track)
  if (table && facts.video_sample_table === null) facts.video_sample_table = table
}

interface TkhdFields {
  trackId: number
  matrix: number[]
  presentation: Dimensions
}

function readTkhd(bytes: Uint8Array, view: DataView, box: BoxRef): TkhdFields {
  const version = bytes[box.bodyStart] ?? 0
  let p = box.bodyStart + 4
  p += version === 1 ? 16 : 8 // creation plus modification
  const trackId = view.getUint32(p)
  p += 4
  p += 4 // reserved
  p += version === 1 ? 8 : 4 // duration
  p += 8 // reserved
  p += 2 + 2 + 2 + 2 // layer, alternate group, volume, reserved

  const matrix: number[] = []
  for (let i = 0; i < 9; i += 1) matrix.push(view.getInt32(p + i * 4))
  p += 36

  // 16.16 fixed point, and this is the PRESENTATION size. See D8: it equals the
  // coded size only at square pixels, so it is recorded under its own name.
  const width = view.getUint32(p) / 65536
  const height = view.getUint32(p + 4) / 65536

  return { trackId, matrix, presentation: { width: round(width, 4), height: round(height, 4) } }
}

/**
 * Reduces the 3x3 display matrix to one of four rotations.
 *
 * The matrix is stored as 16.16 fixed point except for the last column, which is
 * 2.30. Only a, b, c, d matter for rotation. `rotated_90.mp4` carries
 * `[0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824]`, which reduces to a,b,c,d of
 * 0, 1, -1, 0, and that is byte for byte the matrix a portrait iPhone clip
 * carries. Getting this wrong tells a creator their correct vertical footage is
 * horizontal.
 */
export function rotationFromMatrix(matrix: number[]): Rotation {
  const a = sign((matrix[0] ?? 0) / 65536)
  const b = sign((matrix[1] ?? 0) / 65536)
  const c = sign((matrix[3] ?? 0) / 65536)
  const d = sign((matrix[4] ?? 0) / 65536)

  if (a === 1 && b === 0 && c === 0 && d === 1) return 0
  if (a === 0 && b === 1 && c === -1 && d === 0) return 90
  if (a === -1 && b === 0 && c === 0 && d === -1) return 180
  if (a === 0 && b === -1 && c === 1 && d === 0) return 270

  // A shear, a flip, or an identity-with-scale. Rotation is 0 and the caller is
  // told, rather than a made up quarter turn.
  return 0
}

function sign(value: number): -1 | 0 | 1 {
  if (value > 0.5) return 1
  if (value < -0.5) return -1
  return 0
}

interface VisualEntry {
  format: string
  coded: Dimensions
  sampleAspect: SampleAspect | null
  description: Uint8Array | null
  codecString: string | null
}

/**
 * The first sample entry of a track, which is where the codec fourcc lives.
 *
 * The tree already descended into `stsd` past its entry count, so the sample
 * entries are its children and this is a lookup. The fourcc comes from here and
 * never from the file extension or the browser reported MIME type: an iPhone
 * writes `.MOV` for both H.264 and HEVC, and Android writes `.mp4` for both.
 */
function firstSampleEntry(stbl: AtomNode): AtomNode | null {
  const stsd = childOf(stbl, 'stsd')
  return stsd?.children[0] ?? null
}

function readVisualSampleEntry(
  bytes: Uint8Array,
  view: DataView,
  stbl: AtomNode,
  budget: AtomBudget,
): VisualEntry | null {
  const entry = firstSampleEntry(stbl)
  if (!entry) return null
  if (!VIDEO_SAMPLE_FORMATS.has(entry.type)) {
    budget.warnings.push(`unrecognised video sample format ${JSON.stringify(entry.type)}`)
  }

  // VisualSampleEntry: 8 byte box header, 6 reserved, 2 data reference index,
  // 2 pre_defined, 2 reserved, 12 pre_defined, then width and height as uint16.
  // THIS is the coded size. `tkhd` is not.
  const dimsAt = entry.start + 32
  if (dimsAt + 4 > entry.end) return null

  const coded = { width: view.getUint16(dimsAt), height: view.getUint16(dimsAt + 2) }

  let sampleAspect: SampleAspect | null = null
  let description: Uint8Array | null = null

  // Extensions begin after the 78 byte visual sample entry body.
  eachChild(bytes, view, entry.start + 86, entry.end, budget, (ext) => {
    if (ext.type === 'pasp') {
      const h = view.getUint32(ext.bodyStart)
      const v = view.getUint32(ext.bodyStart + 4)
      if (h > 0 && v > 0) sampleAspect = { h, v }
    } else if (ext.type === 'avcC' || ext.type === 'hvcC' || ext.type === 'vpcC' || ext.type === 'av1C') {
      description = bytes.subarray(ext.bodyStart, ext.end)
    }
  })

  return {
    format: entry.type,
    coded,
    sampleAspect,
    description,
    codecString: codecStringFor(entry.type, description),
  }
}

/**
 * Builds the RFC 6381 codec string `VideoDecoder.isConfigSupported` wants.
 *
 * Derived from the decoder configuration record rather than guessed, because a
 * guessed string produces a support answer about a codec profile the file does
 * not contain, which is a confidently wrong answer about whether a creator's clip
 * can be decoded here.
 */
export function codecStringFor(fourcc: string, description: Uint8Array | null): string | null {
  if (!description) return null

  if (fourcc === 'avc1' || fourcc === 'avc3') {
    if (description.byteLength < 4) return null
    const profile = description[1] ?? 0
    const compat = description[2] ?? 0
    const level = description[3] ?? 0
    return `${fourcc}.${hex2(profile)}${hex2(compat)}${hex2(level)}`
  }

  if (fourcc === 'hvc1' || fourcc === 'hev1') {
    if (description.byteLength < 13) return null
    const b1 = description[1] ?? 0
    const profileSpace = (b1 >> 6) & 0x3
    const tierFlag = (b1 >> 5) & 0x1
    const profileIdc = b1 & 0x1f
    let compat = 0
    for (let i = 2; i <= 5; i += 1) compat = ((compat << 8) | (description[i] ?? 0)) >>> 0
    const levelIdc = description[12] ?? 0

    const spacePrefix = profileSpace === 0 ? '' : String.fromCharCode(64 + profileSpace)
    const parts = [
      `${fourcc}.${spacePrefix}${profileIdc}`,
      reverseBits32(compat).toString(16),
      `${tierFlag === 0 ? 'L' : 'H'}${levelIdc}`,
    ]
    const constraints: string[] = []
    for (let i = 6; i <= 11; i += 1) constraints.push((description[i] ?? 0).toString(16))
    while (constraints.length > 0 && constraints[constraints.length - 1] === '0') constraints.pop()
    return [...parts, ...constraints].join('.')
  }

  // ProRes and anything else: no browser decoder exists, so a codec string would
  // be asked of an API that has no answer. Absence is the honest value.
  return null
}

function reverseBits32(value: number): number {
  let out = 0
  for (let i = 0; i < 32; i += 1) {
    out = ((out << 1) | ((value >>> i) & 1)) >>> 0
  }
  return out >>> 0
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

// ---------------------------------------------------------------------------
// sample tables: what makes a real WebCodecs demux possible
// ---------------------------------------------------------------------------

/**
 * Builds a per sample index from `stsc`, `stsz`, `stco`/`co64`, `stts`, `ctts`
 * and `stss`.
 *
 * This is what the WebCodecs path needs: to produce a frame at 3.4 seconds it has
 * to find the last sync sample at or before 3.4s, then feed every sample from
 * there forward. Without the table there is no seek that is not a guess.
 *
 * Fragmented files carry their samples in `moof` boxes and will produce an empty
 * table here, which the caller must treat as "this path cannot run" rather than
 * as a zero length clip.
 */
function readSampleTable(
  bytes: Uint8Array,
  view: DataView,
  stbl: AtomNode,
  timescale: number,
): VideoSampleTable | null {
  let sizes: number[] | null = null
  let chunkOffsets: number[] | null = null
  let stscEntries: { firstChunk: number; samplesPerChunk: number }[] | null = null
  let sttsEntries: { count: number; delta: number }[] | null = null
  let cttsEntries: { count: number; offset: number }[] | null = null
  let syncSamples: number[] | null = null

  // The children are already indexed, so this reads the tree rather than walking
  // the bytes a second time.
  for (const box of stbl.children) {
    const body = box.bodyStart + 4 // every one of these is a FullBox
    switch (box.type) {
      case 'stsz': {
        const uniform = view.getUint32(body)
        const count = view.getUint32(body + 4)
        sizes = []
        if (uniform > 0) {
          for (let i = 0; i < count; i += 1) sizes.push(uniform)
        } else {
          for (let i = 0; i < count && body + 8 + i * 4 + 4 <= box.end; i += 1) {
            sizes.push(view.getUint32(body + 8 + i * 4))
          }
        }
        break
      }
      case 'stco': {
        const count = view.getUint32(body)
        chunkOffsets = []
        for (let i = 0; i < count && body + 4 + i * 4 + 4 <= box.end; i += 1) {
          chunkOffsets.push(view.getUint32(body + 4 + i * 4))
        }
        break
      }
      case 'co64': {
        const count = view.getUint32(body)
        chunkOffsets = []
        for (let i = 0; i < count && body + 4 + i * 8 + 8 <= box.end; i += 1) {
          chunkOffsets.push(Number(view.getBigUint64(body + 4 + i * 8)))
        }
        break
      }
      case 'stsc': {
        const count = view.getUint32(body)
        stscEntries = []
        for (let i = 0; i < count && body + 4 + i * 12 + 12 <= box.end; i += 1) {
          stscEntries.push({
            firstChunk: view.getUint32(body + 4 + i * 12),
            samplesPerChunk: view.getUint32(body + 4 + i * 12 + 4),
          })
        }
        break
      }
      case 'stts': {
        const count = view.getUint32(body)
        sttsEntries = []
        for (let i = 0; i < count && body + 4 + i * 8 + 8 <= box.end; i += 1) {
          sttsEntries.push({
            count: view.getUint32(body + 4 + i * 8),
            delta: view.getUint32(body + 4 + i * 8 + 4),
          })
        }
        break
      }
      case 'ctts': {
        const count = view.getUint32(body)
        cttsEntries = []
        for (let i = 0; i < count && body + 4 + i * 8 + 8 <= box.end; i += 1) {
          cttsEntries.push({
            count: view.getUint32(body + 4 + i * 8),
            // Version 1 makes this signed. Reading it signed either way is safe:
            // version 0 offsets are non negative and fit in the positive range.
            offset: view.getInt32(body + 4 + i * 8 + 4),
          })
        }
        break
      }
      case 'stss': {
        const count = view.getUint32(body)
        syncSamples = []
        for (let i = 0; i < count && body + 4 + i * 4 + 4 <= box.end; i += 1) {
          syncSamples.push(view.getUint32(body + 4 + i * 4))
        }
        break
      }
      default:
        break
    }
  }

  if (!sizes || !chunkOffsets || !stscEntries || !sttsEntries) return null
  if (timescale <= 0) return null

  const sampleSizes = sizes as number[]
  const offsets = chunkOffsets as number[]
  const stsc = stscEntries as { firstChunk: number; samplesPerChunk: number }[]
  const stts = sttsEntries as { count: number; delta: number }[]
  const ctts = cttsEntries as { count: number; offset: number }[] | null
  const stss = syncSamples as number[] | null

  const samples: Sample[] = []
  const syncSet = stss ? new Set(stss) : null

  let sampleIndex = 0
  let dtsUnits = 0
  let sttsCursor = 0
  let sttsRemaining = stts[0]?.count ?? 0
  let cttsCursor = 0
  let cttsRemaining = ctts?.[0]?.count ?? 0

  for (let chunk = 0; chunk < offsets.length; chunk += 1) {
    const samplesInChunk = samplesPerChunkAt(stsc, chunk)
    let offsetInChunk = offsets[chunk] ?? 0

    for (let i = 0; i < samplesInChunk && sampleIndex < sampleSizes.length; i += 1) {
      while (sttsRemaining === 0 && sttsCursor + 1 < stts.length) {
        sttsCursor += 1
        sttsRemaining = stts[sttsCursor]?.count ?? 0
      }
      const delta = stts[sttsCursor]?.delta ?? 0

      let compositionOffset = 0
      if (ctts && ctts.length > 0) {
        while (cttsRemaining === 0 && cttsCursor + 1 < ctts.length) {
          cttsCursor += 1
          cttsRemaining = ctts[cttsCursor]?.count ?? 0
        }
        compositionOffset = ctts[cttsCursor]?.offset ?? 0
        if (cttsRemaining > 0) cttsRemaining -= 1
      }

      const size = sampleSizes[sampleIndex] ?? 0
      samples.push({
        index: sampleIndex,
        offset: offsetInChunk,
        size,
        dts_ms: (dtsUnits / timescale) * 1000,
        cts_ms: ((dtsUnits + compositionOffset) / timescale) * 1000,
        // No `stss` means every sample is a sync sample, which is what an
        // all-intra codec like ProRes writes.
        sync: syncSet ? syncSet.has(sampleIndex + 1) : true,
      })

      offsetInChunk += size
      dtsUnits += delta
      if (sttsRemaining > 0) sttsRemaining -= 1
      sampleIndex += 1
    }
  }

  const syncIndexes = samples.filter((s) => s.sync).map((s) => s.index)
  return {
    timescale,
    samples,
    sync_indexes: syncIndexes,
    all_sync: syncSet === null,
    duration_ms: (dtsUnits / timescale) * 1000,
  }
}

function samplesPerChunkAt(
  stsc: { firstChunk: number; samplesPerChunk: number }[],
  chunkZeroBased: number,
): number {
  const chunkOneBased = chunkZeroBased + 1
  let current = 0
  for (const entry of stsc) {
    if (entry.firstChunk <= chunkOneBased) current = entry.samplesPerChunk
    else break
  }
  return current
}

// ---------------------------------------------------------------------------
// provenance: dates and coordinates
// ---------------------------------------------------------------------------

function readUdta(bytes: Uint8Array, view: DataView, udta: AtomNode, facts: ContainerFacts): void {
  for (const box of udta.children) {
    if (box.type === '©day') {
      const text = readQuickTimeText(bytes, box)
      if (!text) continue
      const parsed = parseIso8601WithOffset(text)
      if (!parsed) {
        facts.warnings.push(`udta/©day could not be parsed: ${JSON.stringify(text)}`)
        continue
      }
      facts.captured_at_candidates.push({
        source: 'udta_day',
        at_ms: parsed.at_ms,
        raw: text,
        has_offset: parsed.hasOffset,
        // A source carrying a UTC offset is the strongest thing a container gives
        // us, because it removes the timezone guess entirely.
        confidence: parsed.hasOffset ? 'high' : 'medium',
      })
    } else if (box.type === '©xyz') {
      const text = readQuickTimeText(bytes, box)
      if (!text) continue
      const fix = parseIso6709(text)
      if (!fix) {
        facts.warnings.push(`udta/©xyz is not ISO 6709: ${JSON.stringify(text)}`)
        continue
      }
      recordGps(facts, fix, 'udta_c_xyz_iso6709', 'moov/udta/©xyz')
    } else if (box.type === 'loci') {
      const fix = readLoci(bytes, view, box)
      if (!fix) {
        facts.warnings.push('moov/udta/loci is present but too short to read')
        continue
      }
      recordGps(facts, fix, 'udta_loci_3gpp', 'moov/udta/loci')
    }
  }
}

/**
 * QuickTime metadata text atoms carry a 2 byte length and a 2 byte language code
 * before the payload. Reading from the start of the body gives two junk
 * characters in front of every date and coordinate.
 */
function readQuickTimeText(bytes: Uint8Array, box: BoxRef): string | null {
  const available = box.end - box.bodyStart
  if (available <= 4) return null
  const declared = (bytes[box.bodyStart] ?? 0) * 256 + (bytes[box.bodyStart + 1] ?? 0)
  const start = box.bodyStart + 4
  const length = declared > 0 && declared <= available - 4 ? declared : available - 4
  return decodeUtf8(bytes.subarray(start, start + length)).replace(/\0+$/, '').trim()
}

/**
 * The 3GPP location box.
 *
 * Field order is longitude, then latitude, then altitude, each signed 16.16 fixed
 * point. Reading them latitude first puts the San Jose branch in the Atlantic,
 * which is exactly the bug QC-MEDIA-015 exists to catch. This is the form ffmpeg
 * writes into mp4, so it is what most of the committed fixtures carry.
 */
function readLoci(bytes: Uint8Array, view: DataView, box: BoxRef): GpsFix | null {
  // version and flags, then a 2 byte language, then a null terminated name.
  let p = box.bodyStart + 4 + 2
  while (p < box.end && bytes[p] !== 0) p += 1
  p += 1 // the name's terminator
  p += 1 // role
  if (p + 12 > box.end) return null

  const lng = view.getInt32(p) / 65536
  const lat = view.getInt32(p + 4) / 65536
  const alt = view.getInt32(p + 8) / 65536

  if (!plausibleCoordinate(lat, lng)) return null
  return { lat: round(lat, 6), lng: round(lng, 6), alt_m: round(alt, 3) }
}

/**
 * The Apple `keys` plus `ilst` metadata form, which is what an iPhone writes
 * alongside `©xyz`.
 *
 * WRITTEN BLIND, and it must stay marked that way. ffmpeg's mov muxer cannot
 * write this form, so no committed fixture carries it (see docs/media-pipeline.md
 * 4.2). It is exercised against a hand built keys plus ilst block in
 * `tests/media/atoms.spec.ts` and has never been run against a real iPhone file.
 */
function readAppleMeta(
  bytes: Uint8Array,
  view: DataView,
  meta: AtomNode,
  budget: AtomBudget,
  facts: ContainerFacts,
): void {
  const keysBox = childOf(meta, 'keys')
  const ilst = childOf(meta, 'ilst')
  if (!keysBox || !ilst) return

  // FullBox, then a 4 byte entry count, then per entry: size, namespace, name.
  // The entries are not boxes in the CONTAINER_ATOMS sense (their "type" is the
  // namespace, usually `mdta`, and the key name is the payload), so this level is
  // read directly rather than descended into by the tree walker.
  const keys: string[] = []
  eachChild(bytes, view, keysBox.bodyStart + 8, keysBox.end, budget, (entry) => {
    keys.push(decodeUtf8(bytes.subarray(entry.bodyStart, entry.end)))
  })
  if (keys.length === 0) return

  const values = new Map<string, string>()
  for (const item of ilst.children) {
    // An `ilst` child's type is the 1 based index into `keys`, big endian.
    const key = keys[fourccToUint32(item.type) - 1]
    if (!key) continue
    eachChild(bytes, view, item.bodyStart, item.end, budget, (data) => {
      if (data.type !== 'data') return
      // type indicator (4) then locale (4), then the payload.
      const payload = bytes.subarray(data.bodyStart + 8, data.end)
      values.set(key, decodeUtf8(payload).replace(/\0+$/, '').trim())
    })
  }

  const creation = values.get('com.apple.quicktime.creationdate')
  if (creation) {
    const parsed = parseIso8601WithOffset(creation)
    if (parsed) {
      facts.captured_at_candidates.push({
        source: 'apple_quicktime',
        at_ms: parsed.at_ms,
        raw: creation,
        has_offset: parsed.hasOffset,
        confidence: parsed.hasOffset ? 'high' : 'medium',
      })
    } else {
      facts.warnings.push(`com.apple.quicktime.creationdate could not be parsed: ${JSON.stringify(creation)}`)
    }
  }

  const location = values.get('com.apple.quicktime.location.ISO6709')
  if (location) {
    const fix = parseIso6709(location)
    if (fix) recordGps(facts, fix, 'apple_quicktime_iso6709', 'moov/meta/ilst com.apple.quicktime.location.ISO6709')
    else facts.warnings.push(`com.apple.quicktime.location.ISO6709 is not ISO 6709: ${JSON.stringify(location)}`)
  }
}

/**
 * `meta` is a FullBox in ISO BMFF and a plain box in QuickTime, so its children
 * start 4 bytes later in one than in the other. Sniffing which it is beats
 * branching on the container brand, because both forms turn up in both.
 */
function metaChildStart(bytes: Uint8Array, meta: Pick<AtomNode, 'bodyStart'>): number {
  const plain = fourccAt(bytes, meta.bodyStart + 4)
  if (plain === 'hdlr' || plain === 'keys' || plain === 'ilst' || plain === 'mdta') return meta.bodyStart
  return meta.bodyStart + 4
}

function recordGps(facts: ContainerFacts, fix: GpsFix, atom: GpsAtom, evidence: string): void {
  // Precedence: the Apple form is the most precise, then the QuickTime string,
  // then the 3GPP fixed point form. A file carrying two is not a conflict, it is
  // the same fix written twice by the same device.
  const rank: Record<GpsAtom, number> = {
    apple_quicktime_iso6709: 3,
    udta_c_xyz_iso6709: 2,
    udta_loci_3gpp: 1,
  }
  if (facts.gps_atom && rank[facts.gps_atom] >= rank[atom]) return

  facts.gps_atom = atom
  facts.gps = {
    value: fix,
    confidence: atom === 'udta_loci_3gpp' ? 'high' : 'exact',
    evidence,
    note:
      atom === 'udta_loci_3gpp'
        ? '16.16 fixed point, so about 15 microdegrees of quantisation. Well inside consumer GPS error.'
        : undefined,
  }
}

/**
 * ISO 6709 fixed format, the form Apple and QuickTime write.
 *
 * The integer digit count is what distinguishes the three latitude forms, and
 * ignoring that is how `+3720.15-12153.10/` becomes a coordinate 17 degrees off:
 * 2 digits is degrees, 4 is degrees and minutes, 6 is degrees, minutes and
 * seconds. Longitude uses 3, 5 and 7.
 */
export function parseIso6709(text: string): GpsFix | null {
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/.exec(text.trim())
  if (!match) return null

  const lat = sexagesimalToDegrees(match[1] ?? '', 'lat')
  const lng = sexagesimalToDegrees(match[2] ?? '', 'lng')
  if (lat === null || lng === null) return null
  if (!plausibleCoordinate(lat, lng)) return null

  const altText = match[3]
  const alt = altText === undefined ? null : Number(altText)

  return {
    lat: round(lat, 6),
    lng: round(lng, 6),
    alt_m: alt === null || !Number.isFinite(alt) ? null : round(alt, 3),
  }
}

function sexagesimalToDegrees(token: string, kind: 'lat' | 'lng'): number | null {
  if (token.length < 2) return null
  const negative = token.startsWith('-')
  const digits = token.slice(1)
  const dot = digits.indexOf('.')
  const integerDigits = dot === -1 ? digits.length : dot
  const value = Number(digits)
  if (!Number.isFinite(value)) return null

  const degreeDigits = kind === 'lat' ? 2 : 3
  let degrees: number
  if (integerDigits <= degreeDigits) {
    degrees = value
  } else if (integerDigits === degreeDigits + 2) {
    const whole = Math.trunc(value / 100)
    degrees = whole + (value - whole * 100) / 60
  } else if (integerDigits === degreeDigits + 4) {
    const whole = Math.trunc(value / 10000)
    const minutes = Math.trunc((value - whole * 10000) / 100)
    const seconds = value - whole * 10000 - minutes * 100
    degrees = whole + minutes / 60 + seconds / 3600
  } else {
    return null
  }
  return negative ? -degrees : degrees
}

function plausibleCoordinate(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false
  // Exactly zero on both axes is the null island, which every stripped or
  // uninitialised GPS field produces. Treating it as a fix would place footage in
  // the Gulf of Guinea and pass or fail a rule on it.
  if (lat === 0 && lng === 0) return false
  return true
}

/**
 * Parses the date forms a container actually carries, and reports whether the
 * string carried a UTC offset.
 *
 * The offset flag matters more than the value: a camera clock with no timezone is
 * evidence of a wall clock reading, not of an instant, and the pre-flight engine
 * has to be able to say so.
 */
export function parseIso8601WithOffset(text: string): { at_ms: number; hasOffset: boolean } | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  // `2026-08-04T03:12:00-0700` (no colon in the offset) is what ffmpeg and many
  // cameras write, and `Date.parse` handles it inconsistently across engines, so
  // it is normalised here rather than trusted.
  const compact = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    trimmed,
  )
  if (!compact) {
    const fallback = Date.parse(trimmed)
    if (Number.isNaN(fallback)) return null
    return { at_ms: fallback, hasOffset: /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) }
  }

  const [, year, month, day, hour, minute, second, millis, offset] = compact
  const base = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? '0'),
    Number((millis ?? '0').padEnd(3, '0')),
  )
  if (!Number.isFinite(base)) return null

  if (!offset || offset === 'Z') {
    return { at_ms: base, hasOffset: offset === 'Z' }
  }

  const sign = offset.startsWith('-') ? -1 : 1
  const normalised = offset.slice(1).replace(':', '')
  const offsetMinutes = Number(normalised.slice(0, 2)) * 60 + Number(normalised.slice(2, 4))
  return { at_ms: base - sign * offsetMinutes * 60_000, hasOffset: true }
}

// ---------------------------------------------------------------------------
// reconciling what the tracks said
// ---------------------------------------------------------------------------

function finaliseVideoFacts(facts: ContainerFacts): void {
  facts.has_audio = {
    value: facts.audio_tracks.length > 0,
    confidence: 'exact',
    evidence: 'moov/trak/mdia/hdlr',
  }
  if (facts.audio_tracks.length > 0) {
    const fourcc = facts.audio_tracks[0]?.codec_fourcc ?? null
    if (fourcc) {
      facts.codec_audio = { value: fourcc, confidence: 'exact', evidence: 'moov/trak/mdia/minf/stbl/stsd' }
    }
  }

  const track = facts.video_tracks[0]
  if (!track) {
    facts.warnings.push('no video track found in moov')
    return
  }
  if (facts.video_tracks.length > 1) {
    facts.warnings.push(
      `${facts.video_tracks.length} video tracks present, and only the first is described. Multi angle files are out of scope.`,
    )
  }

  if (track.coded) {
    facts.coded = {
      value: track.coded,
      confidence: 'exact',
      evidence: 'moov/trak/mdia/minf/stbl/stsd',
      note: 'Coded size, from the sample entry. Never taken from tkhd, which holds the presentation size.',
    }
  }
  if (track.presentation) {
    facts.presentation = {
      value: track.presentation,
      confidence: 'exact',
      evidence: 'moov/trak/tkhd',
      note: 'Aspect corrected presentation size. Equal to the coded size only at square pixels (D8).',
    }
  }
  if (track.sample_aspect) {
    facts.sample_aspect = {
      value: track.sample_aspect,
      confidence: 'exact',
      evidence: 'moov/trak/mdia/minf/stbl/stsd/pasp',
    }
  }
  if (track.rotation_deg !== null && track.matrix) {
    facts.rotation_deg = {
      value: track.rotation_deg,
      confidence: 'high',
      evidence: 'moov/trak/tkhd matrix',
      note: `matrix [${track.matrix.join(', ')}]`,
    }
  }
  if (track.codec_fourcc) {
    facts.codec_video = {
      value: track.codec_fourcc,
      confidence: 'exact',
      evidence: 'moov/trak/mdia/minf/stbl/stsd',
      note: 'From the sample entry fourcc, never from the file extension or the browser reported MIME type.',
    }
  }
  if (track.codec_string) {
    facts.codec_string = {
      value: track.codec_string,
      confidence: 'high',
      evidence: 'moov/trak/mdia/minf/stbl/stsd avcC or hvcC',
    }
  }
  facts.codec_description = track.codec_description

  // Display size: coded, then the sample aspect ratio, then the rotation. Doing
  // these in the wrong order produces a plausible number that is wrong on every
  // anamorphic clip.
  const coded = track.coded
  if (coded) {
    const sar = track.sample_aspect
    const scaledWidth = sar ? (coded.width * sar.h) / sar.v : coded.width
    const upright = { width: Math.round(scaledWidth), height: coded.height }
    const rotation = track.rotation_deg ?? 0
    const rotated =
      rotation === 90 || rotation === 270
        ? { width: upright.height, height: upright.width }
        : upright
    facts.display = {
      value: rotated,
      confidence: track.rotation_deg === null ? 'medium' : 'high',
      evidence: 'stsd coded size, pasp, tkhd matrix',
      note:
        rotation === 0
          ? undefined
          : `coded ${coded.width}x${coded.height} rotated ${rotation} degrees for display`,
    }
  } else if (track.presentation && track.presentation.width > 0) {
    // Last resort. Recorded as low confidence with the reason, because this is the
    // exact substitution D8 forbids doing silently.
    facts.display = {
      value: { width: Math.round(track.presentation.width), height: Math.round(track.presentation.height) },
      confidence: 'low',
      evidence: 'moov/trak/tkhd',
      note: 'No stsd sample entry was readable, so this is the tkhd presentation size and may differ from the coded size.',
    }
  }

  // Prefer the movie duration, fall back to the video track's own.
  if (facts.duration_s.value === null && track.duration_s !== null) {
    facts.duration_s = {
      value: track.duration_s,
      confidence: 'high',
      evidence: 'moov/trak/mdia/mdhd',
    }
  }
}

function finaliseCapture(facts: ContainerFacts): void {
  const candidates = facts.captured_at_candidates
  if (candidates.length === 0) return

  // Precedence: a source with a UTC offset beats one without, and the Apple key
  // beats `©day` beats `mvhd`. Camera clocks are frequently wrong and often carry
  // no timezone, so the ranking is about ambiguity rather than about accuracy.
  const rank: Record<CaptureAtom, number> = { apple_quicktime: 3, udta_day: 2, mvhd: 1 }
  const best = [...candidates].sort((a, b) => {
    if (a.has_offset !== b.has_offset) return a.has_offset ? -1 : 1
    return rank[b.source] - rank[a.source]
  })[0]
  if (!best) return

  const others = candidates.filter((c) => c !== best)
  const disagreement = others.reduce((worst, c) => Math.max(worst, Math.abs(c.at_ms - best.at_ms)), 0)

  // The evidence string names every atom that produced a candidate, in container
  // order, so `mvhd+udta_day` reads as "both said something and they agree".
  const order: CaptureAtom[] = ['mvhd', 'udta_day', 'apple_quicktime']
  const evidence = order.filter((source) => candidates.some((c) => c.source === source)).join('+')

  facts.captured_at_source = best.source
  facts.captured_at = {
    value: best.at_ms,
    confidence: disagreement > 60_000 ? 'low' : best.confidence,
    evidence,
    note:
      disagreement > 60_000
        ? `sources disagree by ${Math.round(disagreement / 1000)}s, and the one carrying a UTC offset was preferred`
        : best.has_offset
          ? 'the source carried a UTC offset, so the instant is unambiguous'
          : 'mvhd is defined as UTC and cameras routinely write local time into it, so the timezone is assumed',
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function emptyFacts(bytes: number): ContainerFacts {
  const absent = <T>(): Fact<T> => ({ value: null, confidence: 'none', evidence: 'none' })
  return {
    ok: false,
    reason: null,
    parser_version: PARSER_VERSION,
    container: absent(),
    ftyp_brand: null,
    duration_s: absent(),
    coded: absent(),
    presentation: absent(),
    display: absent(),
    rotation_deg: absent(),
    sample_aspect: absent(),
    codec_video: absent(),
    codec_audio: absent(),
    has_audio: absent(),
    codec_string: absent(),
    codec_description: null,
    captured_at: absent(),
    captured_at_source: null,
    captured_at_candidates: [],
    mvhd_creation_time_raw: null,
    gps: absent(),
    gps_atom: null,
    bytes,
    video_tracks: [],
    audio_tracks: [],
    moov_offset: null,
    mdat_offset: null,
    moov_position: 'unknown',
    top_level_types: [],
    atom_paths: [],
    bytes_read: 0,
    atoms_visited: 0,
    warnings: [],
    video_sample_table: null,
  }
}

function fail(facts: ContainerFacts, reason: ParseFailureReason, source: ByteSource): ContainerFacts {
  facts.ok = false
  facts.reason = reason
  facts.bytes_read = source.bytesRead
  return facts
}

function fourccAt(bytes: Uint8Array, offset: number): string {
  let out = ''
  for (let i = 0; i < 4; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0)
  return out
}

function fourccToUint32(fourcc: string): number {
  let out = 0
  for (let i = 0; i < 4; i += 1) out = (out << 8) | (fourcc.charCodeAt(i) & 0xff)
  return out >>> 0
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
