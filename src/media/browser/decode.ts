/**
 * The two decode adapters that touch the DOM, and the browser extraction host.
 *
 * These were the one named seam left open (docs/06-decisions.md D24) because
 * jsdom has no video decode, no canvas rasteriser and no `VideoDecoder`, so a
 * unit test of this file would assert nothing. They are written now and tested
 * where they can actually run: a real Chromium, driven by
 * `e2e/creator.e2e.mjs`, which uploads committed fixtures and asserts that a
 * contact sheet came out with real pixels in it.
 *
 * That is the honest testing story for this file, and it is the reason the file
 * is deliberately thin: every decision that can be made without pixels
 * (frame planning, fallback order, tiling, the long-edge cap, hashing, blank
 * detection, memory release) already lives in `src/media/extract.ts` under
 * unit test. What is here is only the part that genuinely needs a browser.
 *
 * Two engine facts shape the element path, both from docs/02-caveats-review.md
 * and re-checked in docs/platform-matrix.md:
 *
 * 1. Safari yields black frames unless the element is `muted` and
 *    `playsInline`, and sometimes needs a `play()` before it will paint at all.
 *    Both are set unconditionally: they cost nothing on engines that do not
 *    need them.
 * 2. Seek accuracy varies with GOP structure, so `actual_t_seconds` is read
 *    back from `video.currentTime` rather than assumed to equal the plan. The
 *    extractor already treats the two as different numbers.
 */

import type { Dimensions } from '../atoms'
import type {
  DecodeAdapter,
  DecodeOutcome,
  DecodeRequest,
  DecodedFrame,
  ExtractionHost,
  MediaInput,
  RotationSource,
} from '../extract'
import type { RgbaImage } from '../phash'

// ---------------------------------------------------------------------------
// the drawing surface
// ---------------------------------------------------------------------------

interface Surface {
  /**
   * Draws `source` into a `width` x `height` surface, turning it clockwise by
   * `quarterTurns` first. The turn is applied by transforming the destination
   * rather than by allocating an intermediate raster, because an intermediate
   * doubles peak memory per frame and a phone ingesting forty clips dies on
   * exactly that.
   */
  draw(source: CanvasImageSource, width: number, height: number, quarterTurns?: number): void
  read(width: number, height: number): RgbaImage
  toBlob(quality: number): Promise<Blob | null>
  release(): void
}

type Ctx2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * The transform for a clockwise quarter turn count.
 *
 * `width` and `height` are the OUTPUT size, already swapped by `fitTo` for an
 * odd number of turns, so the source is drawn at the swapped extent and the
 * transform maps it back into place.
 */
function drawTurned(
  context: Ctx2d,
  source: CanvasImageSource,
  width: number,
  height: number,
  quarterTurns: number,
): void {
  const turns = ((quarterTurns % 4) + 4) % 4
  if (turns === 0) {
    context.drawImage(source, 0, 0, width, height)
    return
  }
  context.save()
  if (turns === 1) {
    context.translate(width, 0)
    context.rotate(Math.PI / 2)
    context.drawImage(source, 0, 0, height, width)
  } else if (turns === 2) {
    context.translate(width, height)
    context.rotate(Math.PI)
    context.drawImage(source, 0, 0, width, height)
  } else {
    context.translate(0, height)
    context.rotate(-Math.PI / 2)
    context.drawImage(source, 0, 0, height, width)
  }
  context.restore()
}

/**
 * Prefers `OffscreenCanvas` because it does not touch layout and works in a
 * worker later without changing this file. Falls back to a detached `<canvas>`,
 * which every engine we care about has.
 */
function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | null
    if (!context) throw new Error('offscreen 2d context refused')
    return {
      draw(source, w, h, quarterTurns = 0) {
        canvas.width = w
        canvas.height = h
        context.clearRect(0, 0, w, h)
        drawTurned(context, source, w, h, quarterTurns)
      },
      read(w, h) {
        const data = context.getImageData(0, 0, w, h)
        return { width: data.width, height: data.height, data: data.data }
      },
      async toBlob(quality) {
        return canvas.convertToBlob({ type: 'image/jpeg', quality })
      },
      release() {
        canvas.width = 0
        canvas.height = 0
      },
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('2d context refused')
  return {
    draw(source, w, h, quarterTurns = 0) {
      canvas.width = w
      canvas.height = h
      context.clearRect(0, 0, w, h)
      drawTurned(context, source, w, h, quarterTurns)
    },
    read(w, h) {
      const data = context.getImageData(0, 0, w, h)
      return { width: data.width, height: data.height, data: data.data }
    },
    toBlob(quality) {
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    },
    release() {
      canvas.width = 0
      canvas.height = 0
    },
  }
}

/** The target size for a frame, honouring the long edge cap and the rotation. */
function fitTo(
  source: Dimensions,
  targetLongEdge: number,
  quarterTurns: number,
): { width: number; height: number } {
  const swapped = quarterTurns % 2 !== 0
  const width = swapped ? source.height : source.width
  const height = swapped ? source.width : source.height
  const longEdge = Math.max(width, height)
  // Never upscale: a 480p clip does not become sharper by being drawn larger.
  const scale = longEdge > targetLongEdge ? targetLongEdge / longEdge : 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

// ---------------------------------------------------------------------------
// the element path
// ---------------------------------------------------------------------------

function waitForEvent(target: EventTarget, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      target.removeEventListener(event, onEvent)
      target.removeEventListener('error', onError)
      clearTimeout(timer)
      resolve(value)
    }
    const onEvent = () => done(true)
    const onError = () => done(false)
    const timer = setTimeout(() => done(false), timeoutMs)
    target.addEventListener(event, onEvent, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

/**
 * `<video>` plus canvas. The universally available path, and the one whose
 * failure modes are best understood.
 */
export function createVideoCanvasAdapter(): DecodeAdapter {
  return {
    path: 'video-canvas',

    async decode(input: MediaInput, request: DecodeRequest): Promise<DecodeOutcome> {
      const diagnostics: string[] = []
      const frames: DecodedFrame[] = []
      let objectUrl: string | null = null
      let video: HTMLVideoElement | null = null
      let surface: Surface | null = null

      /**
       * Teardown order matters, and getting it wrong is visible rather than
       * theoretical: calling `load()` after clearing `src` makes the engine
       * abort whatever it was still buffering, which surfaces as a failed
       * request for the blob URL and fails a console-clean assertion.
       *
       * So: pause first so nothing is fetching, then drop the source, then
       * revoke. The element is detached and never entered the document, so
       * releasing the last reference is enough; no `load()` is needed to
       * collect it, and issuing one only creates the abort.
       */
      const release = () => {
        if (surface) {
          surface.release()
          surface = null
        }
        if (video) {
          try {
            video.pause()
          } catch {
            // A pause on an element that never started is not interesting.
          }
          video.removeAttribute('src')
          video = null
        }
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
          objectUrl = null
        }
      }

      const fail = (reason: DecodeOutcome['reason']): DecodeOutcome => ({
        ok: false,
        reason,
        rotation_source: null,
        frames: [],
        diagnostics,
        release,
      })

      if (!input.blob) {
        diagnostics.push('element path needs a blob and only a range reader was available')
        return fail('not_decodable_input')
      }
      if (typeof document === 'undefined') {
        return fail('no_extractor')
      }

      objectUrl = URL.createObjectURL(input.blob)
      video = document.createElement('video')
      // Both required for Safari to paint anything at all. Cheap elsewhere.
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.crossOrigin = 'anonymous'
      video.src = objectUrl

      const gotMetadata = await waitForEvent(video, 'loadedmetadata', request.timeouts.metadata_ms)
      if (!gotMetadata) {
        diagnostics.push('loadedmetadata never fired or the element errored')
        return fail('metadata_timeout')
      }

      const reported: Dimensions | null =
        video.videoWidth > 0 && video.videoHeight > 0
          ? { width: video.videoWidth, height: video.videoHeight }
          : null
      const measuredDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null

      if (!reported) {
        diagnostics.push('the element reported no intrinsic size, so there are no pixels to read')
        return fail('zero_dimensions')
      }

      /**
       * Whether the element already applied the rotation for us.
       *
       * An engine that honours the display matrix reports the PRESENTATION size,
       * so a 90 degree rotated 1920x1080 clip reports 1080x1920 and drawing it
       * needs no turn of our own. An engine that ignores the matrix reports the
       * coded size and we have to rotate. Comparing what the element says
       * against the coded size from the container is the only way to tell, and
       * it is why the container parse is worth having.
       */
      let quarterTurns = 0
      let rotationSource: RotationSource = 'not_needed'
      if (request.rotation_deg !== 0) {
        const coded = request.coded
        if (!coded) {
          // No coded size to compare against, so we cannot know who rotated.
          // Applying a turn on a guess is how footage arrives sideways.
          rotationSource = 'undecidable'
          diagnostics.push('rotation declared but no coded size to compare, so no turn was applied')
        } else {
          const elementSwapped =
            reported.width === coded.height && reported.height === coded.width
          if (elementSwapped) {
            rotationSource = 'element_applied'
          } else {
            quarterTurns = ((request.rotation_deg / 90) | 0) % 4
            rotationSource = 'we_applied'
          }
        }
      }

      // Some engines will not paint until playback has been kicked once.
      try {
        await video.play()
        video.pause()
      } catch {
        diagnostics.push('play() was refused, continuing: many engines seek without it')
      }

      surface = createSurface(1, 1)
      const target = fitTo(reported, request.target_long_edge, quarterTurns)

      for (const planned of request.times) {
        const clamped = measuredDuration
          ? Math.min(planned, Math.max(0, measuredDuration - 0.05))
          : planned
        video.currentTime = clamped
        const seeked = await waitForEvent(video, 'seeked', request.timeouts.seek_ms)
        if (!seeked) {
          diagnostics.push(`seek to ${clamped.toFixed(2)}s timed out`)
          continue
        }

        try {
          surface.draw(video, target.width, target.height, quarterTurns)
          const raster = surface.read(target.width, target.height)
          frames.push({
            planned_t_seconds: planned,
            // Read back, never assumed: GOP structure decides where a seek lands.
            actual_t_seconds: video.currentTime,
            raster,
          })
        } catch (error) {
          // A tainted canvas or a refused readback is a real failure mode, and
          // it is per frame rather than per file.
          diagnostics.push(
            `readback failed at ${clamped.toFixed(2)}s: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      if (frames.length === 0) {
        return fail('no_frames_decoded')
      }

      return {
        ok: true,
        reason: null,
        rotation_source: rotationSource,
        frames,
        measured_duration_s: measuredDuration,
        reported_size: reported,
        diagnostics,
        release,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// the WebCodecs path
// ---------------------------------------------------------------------------

/**
 * WebCodecs, the frame-accurate path.
 *
 * It needs a demuxed sample table to feed the decoder, which the container
 * parser produces. Without one there is nothing to decode from, so this adapter
 * declines and the chain falls to the element path. That decline is a normal
 * outcome, not a failure: the extractor records the attempt and moves on.
 */
export function createWebCodecsAdapter(): DecodeAdapter {
  return {
    path: 'webcodecs',

    async decode(input: MediaInput, request: DecodeRequest): Promise<DecodeOutcome> {
      const diagnostics: string[] = []
      const release = () => {}

      if (typeof VideoDecoder === 'undefined') {
        return { ok: false, reason: 'no_extractor', rotation_source: null, frames: [], diagnostics, release }
      }
      if (!request.sample_table || !request.codec_string) {
        // The honest decline: the demuxer has not produced a sample table for
        // this container yet, so there is nothing to hand a decoder. The
        // element path is not a worse answer here, it is the only one.
        diagnostics.push('no sample table or codec string, so the demux path has no input')
        return { ok: false, reason: 'demux_unavailable', rotation_source: null, frames: [], diagnostics, release }
      }

      const support = await VideoDecoder.isConfigSupported({
        codec: request.codec_string,
        description: request.codec_description ?? undefined,
        codedWidth: request.coded?.width,
        codedHeight: request.coded?.height,
      }).catch(() => null)

      if (!support?.supported) {
        diagnostics.push(`VideoDecoder refused the configuration for ${request.codec_string}`)
        return { ok: false, reason: 'decode_unsupported', rotation_source: null, frames: [], diagnostics, release }
      }

      // Configuration is supported, so the remaining work is sample feeding.
      // Declining here rather than half-implementing keeps the claim honest:
      // the seam is open, and the element path below it is fully working.
      diagnostics.push('configuration supported, sample feeding not implemented, deferring to the element path')
      return { ok: false, reason: 'demux_unavailable', rotation_source: null, frames: [], diagnostics, release }
    },
  }
}

// ---------------------------------------------------------------------------
// the host
// ---------------------------------------------------------------------------

export interface BrowserExtractionHostOptions {
  /** Set false to force the element path, which the e2e run uses. */
  useWebCodecs?: boolean
}

export function createBrowserExtractionHost(
  options: BrowserExtractionHostOptions = {},
): ExtractionHost {
  const adapters: DecodeAdapter[] = []
  if (options.useWebCodecs !== false && typeof VideoDecoder !== 'undefined') {
    adapters.push(createWebCodecsAdapter())
  }
  adapters.push(createVideoCanvasAdapter())

  return {
    adapters,

    async encodeJpeg(image: RgbaImage, quality: number): Promise<Blob | null> {
      try {
        const surface = createSurface(image.width, image.height)
        try {
          const bitmap = await imageFrom(image)
          surface.draw(bitmap, image.width, image.height)
          if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()
          return await surface.toBlob(quality)
        } finally {
          surface.release()
        }
      } catch {
        // A runtime that cannot encode is not a crash: the record simply has no
        // sheet, which is a state the whole product already handles.
        return null
      }
    },

    async decodeStill(input: MediaInput, targetLongEdge: number): Promise<RgbaImage | null> {
      if (!input.blob) return null
      try {
        const bitmap = await createImageBitmap(input.blob)
        try {
          const target = fitTo({ width: bitmap.width, height: bitmap.height }, targetLongEdge, 0)
          const surface = createSurface(target.width, target.height)
          try {
            surface.draw(bitmap, target.width, target.height)
            return surface.read(target.width, target.height)
          } finally {
            surface.release()
          }
        } finally {
          bitmap.close()
        }
      } catch {
        return null
      }
    },

    async probeMedia(input: MediaInput, timeoutMs: number) {
      if (!input.blob || typeof document === 'undefined') return null
      const url = URL.createObjectURL(input.blob)
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'metadata'
      video.src = url
      try {
        const ok = await waitForEvent(video, 'loadedmetadata', timeoutMs)
        if (!ok) return null
        return {
          duration_s: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
          reported:
            video.videoWidth > 0 && video.videoHeight > 0
              ? { width: video.videoWidth, height: video.videoHeight }
              : null,
        }
      } finally {
        // Same teardown order as the adapter, and for the same reason.
        try {
          video.pause()
        } catch {
          // Nothing was playing.
        }
        video.removeAttribute('src')
        URL.revokeObjectURL(url)
      }
    },
  }
}

/** Turns a raster back into something drawable. */
async function imageFrom(image: RgbaImage): Promise<CanvasImageSource & { close?: () => void }> {
  const data = new Uint8ClampedArray(
    image.data instanceof Uint8ClampedArray ? image.data : Uint8ClampedArray.from(image.data),
  )
  const imageData = new ImageData(data, image.width, image.height)
  return (await createImageBitmap(imageData)) as CanvasImageSource & { close?: () => void }
}
