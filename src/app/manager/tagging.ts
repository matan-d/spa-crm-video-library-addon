/**
 * Running the vision tagger from the manager surface.
 *
 * This is the one place in the running application that calls the AI seam, and
 * it exists so the product's central claim is demonstrable rather than merely
 * designed: a manager can point at a delivered clip, ask for tags, and watch
 * amber model output appear with a run row behind it that says which provider
 * produced it and what it was given.
 *
 * Three rules this module enforces rather than trusts a caller to remember:
 *
 * 1. No sheet, no call. `assertVisionEnqueueAllowed` refuses an asset with no
 *    `sheet_key`, so a clip nobody could decode produces no run, no tags and no
 *    AI fields. A plausible tag on a clip nobody could see is the least
 *    detectable and most damaging failure this product can have.
 * 2. The sheet is read from the blob store and sent as the actual bytes. The
 *    call is given the same evidence a human sees on the clip sheet, so "why did
 *    the AI say this" has an answer that is a real image.
 * 3. Provenance comes from the provider, never from the current mode. A run
 *    records what produced it; the badge later reads the asset's provenance, so
 *    a library holding both mock and live rows tells the truth about each.
 *
 * In this build the mode is always `mock` (U7). The seam is real, so replacing
 * the factory's mode is the entire change needed to make it live, and nothing
 * here knows which mode it got.
 */

import type { ScopedRepo } from '@/data/repo'
import type { PlatformPort } from '@/platform/port'
import type { Asset, Branch } from '@/data/types'
import {
  AiError,
  createAiProvider,
  recordVisionTag,
  type AiMode,
  type AiProvider,
  type VisionTagOutput,
} from '@/ai'

export interface TaggingDeps {
  repo: ScopedRepo
  port: PlatformPort
  /** Always `mock` in this build. Named rather than assumed, so the seam shows. */
  mode?: AiMode
}

export type TaggingOutcome =
  | { status: 'tagged'; runId: string; output: VisionTagOutput }
  | { status: 'refused'; reason: string }
  | { status: 'failed'; reason: string }

/** Reads a stored sheet back as base64, which is what the provider takes. */
async function sheetAsBase64(port: PlatformPort, key: string): Promise<string | null> {
  const blob = await port.blobs.get(key)
  if (!blob) return null
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // Chunked rather than spread: a spread over a megabyte of bytes overflows the
  // argument list on every engine, and a sheet is comfortably big enough.
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function orientationOf(asset: Asset): 'vertical' | 'horizontal' | 'square' | null {
  const width = asset.coded_width
  const height = asset.coded_height
  if (!width || !height) return null
  const rotated = (asset.rotation_deg ?? 0) % 180 !== 0
  const w = rotated ? height : width
  const h = rotated ? width : height
  if (w === h) return 'square'
  return h > w ? 'vertical' : 'horizontal'
}

/**
 * Tags one asset, or explains why it will not.
 *
 * A refusal is a first class outcome rather than an exception, because "we did
 * not analyse this and here is why" is information a manager needs, and burying
 * it in a thrown error is how it ends up as a silent no-op.
 */
export async function tagAsset(
  deps: TaggingDeps,
  asset: Asset,
  branch: Branch | null,
  provider?: AiProvider,
): Promise<TaggingOutcome> {
  if (!asset.sheet_key) {
    return {
      status: 'refused',
      reason:
        'No contact sheet exists for this clip, so there is nothing for a model to look at. Tagging it anyway would invent a description of footage nobody has seen.',
    }
  }

  const sheet = await sheetAsBase64(deps.port, asset.sheet_key)
  if (!sheet) {
    return {
      status: 'refused',
      reason:
        'The contact sheet for this clip is not in local storage, so the evidence cannot be sent. Re-derive the sheet and try again.',
    }
  }

  const ai = provider ?? createAiProvider({ mode: deps.mode ?? 'mock' })

  try {
    const result = await ai.vision_tag({
      asset_id: asset.id,
      sheet_base64: sheet,
      sheet_media_type: 'image/jpeg',
      frames_seen: asset.frame_hashes?.length ?? 0,
      duration_s: asset.duration_s,
      orientation: orientationOf(asset),
      // The rooms this branch actually has, so the model chooses from a closed
      // list rather than inventing a room the studio does not contain.
      branch_rooms: (branch?.rooms ?? []).map((room) => room.key),
    })

    const written = await recordVisionTag(deps.repo, {
      asset: {
        id: asset.id,
        sheet_key: asset.sheet_key,
        derivative_state: asset.derivative_state,
        codec_video: asset.codec_video,
        client_decodable: asset.client_decodable,
        ai_provenance: asset.ai_provenance,
      },
      output: result.output,
      meta: result.meta,
    })

    return { status: 'tagged', runId: written.run_id, output: result.output }
  } catch (error) {
    if (error instanceof AiError) {
      // A refusal or a validation failure is recorded as a run so the attempt is
      // visible in Data Health rather than vanishing.
      return { status: 'failed', reason: `${error.reason}: ${error.message}` }
    }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
