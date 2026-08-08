/**
 * The one store the shell runs on.
 *
 * It holds the boot context, the active session and the repository built for
 * that session. No component touches IndexedDB or the platform directly: a view
 * that needs data asks `repo`, and `repo` decides what this session may see.
 *
 * Role switching is a teardown, not a mutation. Switching builds a fresh
 * session and a fresh repository, and bumps `viewKey` so the router view
 * remounts the entire tree. A cached view holding the previous role's data is
 * the highest-probability leak in this product (see docs/07-handoff.md), and it
 * is caused by the standard fix for preserving grid scroll position. So scroll
 * position is deliberately lost on a role switch, and that is the correct
 * trade: the switcher is a demo affordance, not a user workflow.
 */

import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { ScopedRepo } from '@/data/repo'
import type { Session } from '@/data/scope'
import { writeActiveProfile, type ProfileId } from '@/data/profile'
import { bootApp, repoForSession, type AppContext, type BootDeps } from './bootstrap'
import { resolveCreatorToken, sessionForRole, type StaffRole, type TokenResolution } from './session'

export type ActiveRole = StaffRole | 'creator'

export type CreatorGate = 'ok' | 'expired' | 'invalid'

/** Where the demo remembers which role the switcher last chose. */
export const ACTIVE_ROLE_KEY = 'astolia.active_role'

interface AppState {
  status: 'idle' | 'booting' | 'ready' | 'error'
  bootError: string | null
  /**
   * The in-flight boot, so the router's guard can await it rather than waving
   * navigations through while the session does not exist yet. That race is what
   * made a token link render nothing: the first navigation resolved un-booted,
   * and re-navigating to the same path afterwards was rejected as a duplicate.
   */
  bootPromise: Promise<void> | null
  ctx: AppContext | null
  role: ActiveRole
  session: Session | null
  repo: ScopedRepo | null
  /** Set only on the creator route: how the token resolved. */
  creatorGate: CreatorGate | null
  /** The raw token the creator arrived with, for resume on reload. */
  creatorToken: string | null
  /** Remount epoch. Changes on every role or token change, never on navigation. */
  viewEpoch: number
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    status: 'idle',
    bootError: null,
    bootPromise: null,
    ctx: null,
    role: 'manager',
    session: null,
    repo: null,
    creatorGate: null,
    creatorToken: null,
    viewEpoch: 0,
  }),

  getters: {
    ready: (state) => state.status === 'ready',
    profile: (state): ProfileId | null => state.ctx?.profile ?? null,
    /**
     * The router view is keyed on this. It includes the epoch rather than only
     * the session kind so creator-to-creator token changes also remount.
     */
    viewKey: (state): string => {
      const kind = state.session?.kind ?? 'none'
      return `${kind}:${state.viewEpoch}`
    },
  },

  actions: {
    async boot(deps: BootDeps & { initialRole?: StaffRole } = {}) {
      if (this.status === 'ready') return
      // A second caller joins the first boot rather than starting a rival one.
      if (this.bootPromise) return this.bootPromise
      this.bootPromise = this.runBoot(deps)
      return this.bootPromise
    },

    /**
     * Anything that must not act on a half-booted store awaits this. Returns
     * immediately once boot has settled, successfully or not.
     */
    async whenReady(): Promise<void> {
      if (this.status === 'ready' || this.status === 'error') return
      if (this.bootPromise) await this.bootPromise
    },

    async runBoot(deps: BootDeps & { initialRole?: StaffRole } = {}) {
      this.status = 'booting'
      this.bootError = null
      try {
        const ctx = await bootApp(deps)
        // markRaw: the context holds an IDBDatabase and closures. Deep reactive
        // proxying of either is wasted work and breaks structuredClone-based
        // IndexedDB writes, and nothing in the UI needs the context itself to
        // be reactive, only the fields the store copies out.
        this.ctx = markRaw(ctx)
        this.enterStaffRole(deps.initialRole ?? 'manager')
        this.status = 'ready'
      } catch (error) {
        this.bootError = error instanceof Error ? error.message : String(error)
        this.status = 'error'
      }
    },

    /** Builds the session and repository for a staff role, remounting the view tree. */
    enterStaffRole(role: StaffRole) {
      const ctx = this.ctx
      if (!ctx) throw new Error('enterStaffRole before boot')
      const session = sessionForRole(role)
      this.role = role
      this.session = session
      this.repo = markRaw(repoForSession(ctx, session))
      this.creatorGate = null
      this.creatorToken = null
      this.viewEpoch += 1
    },

    /**
     * Resolves a creator token and, only on success, builds the creator
     * session. On failure no session and no repository exist at all: the invite
     * view renders the gate state and nothing else, so there is no object a
     * curious page could use to read anything.
     */
    async enterCreatorToken(rawToken: string): Promise<CreatorGate> {
      const ctx = this.ctx
      if (!ctx) throw new Error('enterCreatorToken before boot')
      const resolution: TokenResolution = await resolveCreatorToken(
        ctx.db,
        rawToken,
        ctx.clock.now(),
      )
      this.role = 'creator'
      this.creatorToken = rawToken
      this.viewEpoch += 1
      if (resolution.status !== 'ok') {
        this.session = null
        this.repo = null
        this.creatorGate = resolution.status
        return resolution.status
      }
      this.session = resolution.session
      this.repo = markRaw(repoForSession(ctx, resolution.session))
      this.creatorGate = 'ok'
      return 'ok'
    },

    /**
     * Profile switching is a write plus a reload, per src/data/profile.ts: the
     * reload eliminates every stale-connection bug for zero code. `reload` is
     * injected because jsdom cannot navigate.
     */
    switchProfile(profile: ProfileId, storage: Pick<Storage, 'setItem'> | null, reload: () => void) {
      writeActiveProfile(storage, profile)
      reload()
    },
  },
})
