/**
 * Session construction for the app shell.
 *
 * Two ways into the app, and they deliberately do not share a code path:
 *
 * - A staff role (manager, editor) maps to a seeded account and its session
 *   factory. In this build "signing in" is the demo role switcher; the mapping
 *   from role to session lives here so the switcher stays a dumb control.
 * - A creator arrives with a raw token in the URL. The token is hashed and
 *   resolved against `access_token`, and only a successful resolution can
 *   construct a `creatorTokenSession`. There is no other constructor reachable
 *   from the creator route, which is what makes the creator surface incapable
 *   of reaching a manager repository.
 *
 * The token lookup reads the database directly rather than through a scoped
 * repository, and that is correct rather than a bypass to apologise for: no
 * session exists yet while the session is being established. It mirrors the
 * planned Supabase `security definer` RPC, which performs exactly this lookup
 * (`where token_hash = digest(p_token, 'sha256')`) before any row level policy
 * applies. See docs/01-architecture-review.md.
 */

import { fromRequest, readTx } from '@/data/db'
import { SEED_ORG_ID, SEED_USERS } from '@/data/seed'
import {
  creatorTokenSession,
  editorSession,
  managerSession,
  withCreator,
  type Session,
} from '@/data/scope'
import { sha256Hex } from '@/platform/hash'

export type StaffRole = 'manager' | 'editor'

export function sessionForRole(role: StaffRole): Session {
  if (role === 'manager') {
    return managerSession({ org_id: SEED_ORG_ID, user_id: SEED_USERS.manager })
  }
  return editorSession({ org_id: SEED_ORG_ID, user_id: SEED_USERS.editor })
}

interface AccessTokenRow {
  id: string
  org_id: string
  collab_id: string
  token_hash: string
  purpose: string
  expires_at: number
  revoked_at: number | null
  deleted_at: number | null
}

interface CollabRow {
  id: string
  creator_id: string | null
  deleted_at: number | null
}

export type TokenResolution =
  | { status: 'ok'; session: Session }
  | { status: 'expired' }
  | { status: 'invalid' }

/**
 * Resolves a raw creator token into a session, or says why it cannot.
 *
 * Only two failure states are surfaced, deliberately. A token that is unknown,
 * revoked, malformed or pointing at a deleted collab all read as `invalid`,
 * because distinguishing them tells a guesser which failures are near misses.
 * `expired` is separate because the legitimate holder needs different advice
 * (ask for a new link) than a stranger does.
 */
export async function resolveCreatorToken(
  db: IDBDatabase,
  rawToken: string,
  now: number,
): Promise<TokenResolution> {
  const trimmed = rawToken.trim()
  if (trimmed.length === 0) return { status: 'invalid' }

  const hash = await sha256Hex(trimmed)
  const tokenRow = (await fromRequest(
    readTx(db, ['access_token']).objectStore('access_token').index('by_token_hash').get(hash),
  )) as AccessTokenRow | undefined

  if (!tokenRow || tokenRow.deleted_at != null || tokenRow.revoked_at != null) {
    return { status: 'invalid' }
  }
  if (tokenRow.purpose !== 'upload') return { status: 'invalid' }
  if (tokenRow.expires_at <= now) return { status: 'expired' }

  const collab = (await fromRequest(
    readTx(db, ['collab']).objectStore('collab').get(tokenRow.collab_id),
  )) as CollabRow | undefined
  if (!collab || collab.deleted_at != null) return { status: 'invalid' }

  let session = creatorTokenSession({
    org_id: tokenRow.org_id ?? SEED_ORG_ID,
    collab_id: tokenRow.collab_id,
    token_id: tokenRow.id,
  })
  // Bind the one creator row this token may read. An unbound collab stays
  // unbound, and the session simply sees no creator, which is the safe default.
  if (typeof collab.creator_id === 'string') {
    session = withCreator(session, collab.creator_id)
  }
  return { status: 'ok', session }
}
