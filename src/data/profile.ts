/**
 * Profiles: `demo` and `live` are separate databases, not a flag on rows.
 *
 * The argument for separation rather than a discriminator column is the same one
 * that puts visibility scoping in a single layer. A row flag has to be honoured
 * by every query in the application, forever, and one forgotten `where` clause
 * puts fabricated demo data in a real library. A separate database makes that
 * leak impossible rather than unlikely, because the open connection does not
 * contain the other profile's data at all.
 *
 * It also settles the sync question. The outbox lives inside its database, so the
 * demo profile's outbox is structurally incapable of targeting a real backend. A
 * single bug in a shared-store drain would otherwise push fabricated creators and
 * collabs into production, which is unrecoverable.
 *
 * The cost, accepted deliberately: demo and live data cannot be viewed side by
 * side, and demo data cannot be promoted into live. Both are correct behaviours.
 * Demo data must never graduate.
 */

export type ProfileId = 'demo' | 'live'

export const PROFILES: readonly ProfileId[] = ['demo', 'live'] as const

export const DEFAULT_PROFILE: ProfileId = 'demo'

/** Where the active profile is remembered. One of the few legitimate uses of localStorage. */
export const ACTIVE_PROFILE_KEY = 'astolia.active_profile'

export function databaseName(profile: ProfileId): string {
  return `astolia_${profile}`
}

/** The OPFS subdirectory for this profile's original media bytes. */
export function bytesDirectory(profile: ProfileId): string {
  return profile
}

export function isProfileId(value: unknown): value is ProfileId {
  return value === 'demo' || value === 'live'
}

/**
 * Reads the active profile from storage, falling back to demo.
 *
 * Falls back silently on a storage read failure because a Safari tab with
 * storage blocked must still boot: the consequence of guessing wrong here is that
 * a reviewer lands in the demo profile, which is where we want them anyway.
 */
export function readActiveProfile(storage: Pick<Storage, 'getItem'> | null): ProfileId {
  if (!storage) return DEFAULT_PROFILE
  try {
    const raw = storage.getItem(ACTIVE_PROFILE_KEY)
    return isProfileId(raw) ? raw : DEFAULT_PROFILE
  } catch {
    return DEFAULT_PROFILE
  }
}

/**
 * Records the active profile.
 *
 * Switching profiles is deliberately a write plus a reload rather than a live
 * teardown and reopen. A reload eliminates an entire class of stale-connection
 * and stale-component-state bug for zero code, and nobody notices a reload on a
 * deliberate mode switch.
 */
export function writeActiveProfile(
  storage: Pick<Storage, 'setItem'> | null,
  profile: ProfileId,
): void {
  if (!storage) return
  try {
    storage.setItem(ACTIVE_PROFILE_KEY, profile)
  } catch {
    // Storage refused, so the switch will not survive a reload. The caller shows
    // this state rather than us pretending it worked.
  }
}
