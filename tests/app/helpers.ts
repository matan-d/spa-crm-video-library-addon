/**
 * Shared boot deps for the app-shell suites: fake indexeddb, an injected
 * manifest so no test needs a network, and a platform assembled from a
 * synthetic probe because jsdom is half a runtime.
 */

import type { IDBFactory } from 'fake-indexeddb'
import type { BootDeps } from '@/app/bootstrap'
import type { MediaManifest } from '@/data/seed'
import { createBrowserPlatform } from '@/platform/browser'
import { probeCapabilities, type ProbeEnvironment } from '@/platform/capability'
import { SeededClock, SEED_EPOCH_MS } from '@/platform/clock'
import { SeededRng, SEED_STRING } from '@/platform/rng'
import { createIdFactory } from '@/platform/id'

export function manifest(count = 27): MediaManifest {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      slug: `item-${i + 1}`,
      orientation: 'vertical',
      meta: {
        shot_type: ['closeup', 'macro', 'wide', 'medium'][i % 4]!,
        room: ['treatment_room', 'reception', 'sauna', 'studio'][i % 4]!,
        subjects: ['hands', 'oil'],
        vibe: 'calm',
        light: 'soft_indoor',
      },
      derived_clip: {
        width: 1080,
        height: 1920,
        duration_s: 6,
        committed: i < 3,
        path: i < 3 ? `/seed/clips/item-${i + 1}.mp4` : null,
        bytes: 400_000,
      },
      poster: { path: `/seed/posters/item-${i + 1}.jpg`, bytes: 10_000 },
      contact_sheet: {
        path: `/seed/sheets/item-${i + 1}.jpg`,
        bytes: 34_000,
        frames: 5,
        layout: '1x5',
      },
    })),
  }
}

export function probeEnv(): ProbeEnvironment {
  return {
    shell: 'browser',
    engineHint: 'blink',
    loadScheme: 'https:',
    hardwareConcurrency: 8,
    deviceMemoryGb: 8,
    pointerCoarse: false,
    hasWorker: true,
    hasOffscreenCanvas: false,
    hasCreateImageBitmap: false,
    hasVideoDecoder: false,
    hasOpfs: false,
    hasFileSystemAccess: false,
    hasStorageEstimate: false,
    hasStoragePersist: false,
    hasBroadcastChannel: false,
    hasWebLocks: false,
    hasDirectoryDrop: false,
    decodingInfo: null,
    canPlayType: () => '',
  }
}

export function testDeps(factory: IDBFactory): BootDeps {
  const clock = new SeededClock({ startMs: SEED_EPOCH_MS, autoAdvanceMs: 1 })
  return {
    profile: 'demo',
    indexedDbFactory: factory,
    clock,
    newId: createIdFactory(clock, new SeededRng(SEED_STRING)),
    loadMediaManifest: async () => manifest(),
    platform: async (db, subdirectory, now) =>
      createBrowserPlatform({
        db,
        bytesSubdirectory: subdirectory,
        now,
        report: await probeCapabilities(probeEnv()),
      }),
  }
}
