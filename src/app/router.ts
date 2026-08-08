/**
 * Routing, and the one rule it enforces: a route is reachable only by a role
 * that owns it.
 *
 * Hash history, deliberately. The creator link is `/#/c/:token`, which works
 * from a static host with zero server configuration, survives being pasted
 * into any chat app, and never sends the token in the HTTP path where an
 * access log would keep it.
 *
 * The creator route's guard can only ever call `enterCreatorToken`, which can
 * only ever construct a `creatorTokenSession`. There is no code path from the
 * creator surface to a manager or editor repository: the guard for every staff
 * route redirects a creator-role visitor back to their token page (or to the
 * root if the token is gone), rather than building a staff session for them.
 */

import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router'
import { useAppStore, type ActiveRole } from './store'
import type { StaffRole } from './session'
import LibraryView from './views/LibraryView.vue'
import CreatorInviteView from './views/CreatorInviteView.vue'
import SurfacePlaceholderView from './views/SurfacePlaceholderView.vue'

/** Where each role lands. Also the redirect target when a route is refused. */
export function roleHome(role: ActiveRole, creatorToken?: string | null): string {
  // The manager lands on the library until the triage inbox is a real surface:
  // the submission's definition of done is "opens on a non-empty library", and
  // landing a reviewer on a placeholder would fail that on purpose. When the
  // triage surface ships, this becomes '/triage'.
  if (role === 'manager') return '/library'
  if (role === 'editor') return '/library'
  // A creator context that somehow lost its token gets the invalid-token page,
  // never a staff surface, and never `/` (which would redirect here again).
  return `/c/${creatorToken ?? 'invalid'}`
}

interface SurfaceMeta {
  /** Roles that may enter. A creator may enter nothing but their token route. */
  roles: StaffRole[]
  title: string
  note?: string
}

const placeholder = (
  path: string,
  roles: StaffRole[],
  title: string,
  note: string,
): RouteRecordRaw => ({
  path,
  component: SurfacePlaceholderView,
  props: { title, note },
  meta: { roles, title } satisfies SurfaceMeta,
})

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: () => {
      const store = useAppStore()
      return roleHome(store.role, store.creatorToken)
    },
  },
  {
    path: '/library',
    component: LibraryView,
    meta: { roles: ['editor', 'manager'], title: 'Library' } satisfies SurfaceMeta,
  },
  placeholder(
    '/triage',
    ['manager'],
    'Triage inbox',
    'Deliveries grouped by what is actionable. Lands with the manager surface.',
  ),
  placeholder(
    '/deals',
    ['manager'],
    'Deals',
    'The collab kanban. Lands with the manager surface, after the inbox.',
  ),
  placeholder(
    '/briefs',
    ['manager'],
    'Briefs',
    'Gap-fed brief generation and the brief lock. Lands with the loop.',
  ),
  placeholder(
    '/gaps',
    ['manager'],
    'Gaps',
    'The gap scan and the close detection. Lands with the loop.',
  ),
  placeholder(
    '/creators',
    ['manager'],
    'Creators',
    'Vetting and the scorecard. Lands with the manager surface.',
  ),
  placeholder(
    '/data-health',
    ['manager'],
    'Data health',
    'ai_run counts by provider: the direct answer to "is any of this real".',
  ),
  placeholder('/storage', ['manager'], 'Storage', 'Quota, tier and eviction.'),
  placeholder('/sync', ['manager'], 'Sync', 'The outbox and the loopback adapter.'),
  {
    path: '/c/:token',
    component: CreatorInviteView,
    props: true,
    // No roles list: this route is the creator surface's front door and is
    // reachable by anyone holding a link, exactly like production.
    meta: { title: 'Creator invite' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

/** `history` is injectable so tests can drive the same guards over memory history. */
export function createAppRouter(history?: RouterHistory): Router {
  const router = createRouter({
    history: history ?? createWebHashHistory(),
    routes,
  })

  router.beforeEach(async (to) => {
    const store = useAppStore()
    if (!store.ready) return true

    // Opening a token link IS entering the creator context, whatever role the
    // demo switcher was in before. The resolution happens here, before the
    // view renders, so the view only ever sees a settled gate.
    if (to.path.startsWith('/c/')) {
      const raw = String(to.params.token ?? '')
      if (store.role !== 'creator' || store.creatorToken !== raw) {
        await store.enterCreatorToken(raw)
      }
      return true
    }

    const meta = to.meta as Partial<SurfaceMeta>
    if (!meta.roles) return true
    if (store.role === 'creator' || !meta.roles.includes(store.role)) {
      return { path: roleHome(store.role, store.creatorToken) }
    }
    return true
  })

  return router
}
