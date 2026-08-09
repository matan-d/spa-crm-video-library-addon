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
import CreatorsView from './views/CreatorsView.vue'
import SyncView from './views/SyncView.vue'
import TriageView from './views/TriageView.vue'
import DealsView from './views/DealsView.vue'
import ReviewQueueView from './views/ReviewQueueView.vue'
import GapsView from './views/GapsView.vue'
import BriefsView from './views/BriefsView.vue'
import DataHealthView from './views/DataHealthView.vue'
import StorageView from './views/StorageView.vue'
import CreatorUploadView from './views/CreatorUploadView.vue'

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
  {
    path: '/triage',
    component: TriageView,
    meta: { roles: ['manager'], title: 'Triage' } satisfies SurfaceMeta,
  },
  {
    path: '/review/:deliveryId',
    component: ReviewQueueView,
    meta: { roles: ['manager'], title: 'Review' } satisfies SurfaceMeta,
  },
  {
    path: '/deals',
    component: DealsView,
    meta: { roles: ['manager'], title: 'Deals' } satisfies SurfaceMeta,
  },
  {
    path: '/briefs',
    component: BriefsView,
    meta: { roles: ['manager'], title: 'Briefs' } satisfies SurfaceMeta,
  },
  {
    path: '/gaps',
    component: GapsView,
    meta: { roles: ['manager'], title: 'Gaps' } satisfies SurfaceMeta,
  },
  {
    path: '/creators',
    component: CreatorsView,
    meta: { roles: ['manager'], title: 'Creators' } satisfies SurfaceMeta,
  },
  {
    path: '/data-health',
    component: DataHealthView,
    meta: { roles: ['manager'], title: 'Data health' } satisfies SurfaceMeta,
  },
  {
    path: '/storage',
    component: StorageView,
    meta: { roles: ['manager'], title: 'Storage' } satisfies SurfaceMeta,
  },
  {
    path: '/sync',
    component: SyncView,
    meta: { roles: ['manager'], title: 'Sync' } satisfies SurfaceMeta,
  },
  {
    path: '/c/:token',
    component: CreatorInviteView,
    props: true,
    // No roles list: this route is the creator surface's front door and is
    // reachable by anyone holding a link, exactly like production.
    meta: { title: 'Creator invite' },
  },
  {
    // The upload page lives UNDER the token, so it is reachable only by
    // resolving that token: there is no upload URL that works without one.
    path: '/c/:token/upload',
    component: CreatorUploadView,
    props: true,
    meta: { title: 'Send clips' },
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
    // Wait for boot rather than waving the navigation through. A guard that
    // passes an un-booted navigation has to be re-run later, and re-navigating
    // to the same path is a duplicate vue-router rejects, so the second chance
    // never comes: the creator's token link rendered an empty page.
    await store.whenReady()
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
