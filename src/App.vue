<script setup lang="ts">
// The shell. It boots the app, then renders a header, a role-appropriate nav
// and the routed surface. Two rules it exists to keep:
//
// 1. No component below this point touches IndexedDB or the platform. They ask
//    the store's repository.
// 2. The router view is keyed on the session, so a role switch REMOUNTS the
//    whole view tree instead of restoring cached views. A cached view holding
//    the previous role's data is the highest-probability leak in the product.
import { computed, onMounted } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { useAppStore, ACTIVE_ROLE_KEY } from './app/store'
import type { StaffRole } from './app/session'
import DemoTools from './app/components/DemoTools.vue'

const store = useAppStore()

const demoTools = import.meta.env.VITE_DEMO_TOOLS === 'true'

function rememberedRole(): StaffRole {
  try {
    const raw = window.localStorage.getItem(ACTIVE_ROLE_KEY)
    return raw === 'editor' ? 'editor' : 'manager'
  } catch {
    return 'manager'
  }
}

// Boot starts as the shell mounts, and the router's guard awaits it, so the
// first navigation already resolves against a real session. Nothing re-navigates
// afterwards: a second navigation to the same path is a duplicate, and relying
// on one is what made token links render an empty page.
onMounted(() => {
  void store.boot({
    storage: safeLocalStorage(),
    initialRole: rememberedRole(),
  })
})

function safeLocalStorage(): Pick<Storage, 'getItem'> | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const isCreator = computed(() => store.role === 'creator')

// A build-time constant; it never changes while the page lives.
const version = __APP_VERSION__

interface NavLink {
  to: string
  label: string
  testid: string
}

const navLinks = computed<NavLink[]>(() => {
  if (!store.ready || isCreator.value) return []
  if (store.role === 'editor') {
    return [{ to: '/library', label: 'Library', testid: 'nav-library' }]
  }
  return [
    { to: '/triage', label: 'Triage', testid: 'nav-triage' },
    { to: '/deals', label: 'Deals', testid: 'nav-deals' },
    { to: '/briefs', label: 'Briefs', testid: 'nav-briefs' },
    { to: '/gaps', label: 'Gaps', testid: 'nav-gaps' },
    { to: '/creators', label: 'Creators', testid: 'nav-creators' },
    { to: '/library', label: 'Library', testid: 'nav-library' },
    { to: '/data-health', label: 'Data health', testid: 'nav-data-health' },
    { to: '/storage', label: 'Storage', testid: 'nav-storage' },
    { to: '/sync', label: 'Sync', testid: 'nav-sync' },
  ]
})
</script>

<template>
  <div
    data-testid="app-root"
    class="shell"
  >
    <p
      v-if="store.status === 'booting' || store.status === 'idle'"
      data-testid="app-loading"
      class="boot-note"
    >
      Opening the library&hellip;
    </p>

    <div
      v-else-if="store.status === 'error'"
      data-testid="app-error-banner"
      class="error"
      role="alert"
    >
      <strong>The app could not start.</strong>
      <span>{{ store.bootError }}</span>
    </div>

    <template v-else>
      <header class="head">
        <div class="brand">
          <span class="brand-name">Astolia</span>
          <span class="brand-sub mono">collab add-on</span>
        </div>

        <nav
          v-if="navLinks.length"
          data-testid="app-nav"
          class="nav"
          aria-label="Surfaces"
        >
          <RouterLink
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            :data-testid="link.testid"
            class="nav-link"
          >
            {{ link.label }}
          </RouterLink>
        </nav>

        <DemoTools v-if="demoTools" />
      </header>

      <main
        data-testid="app-main"
        class="main"
      >
        <RouterView :key="store.viewKey" />
      </main>

      <span
        data-testid="seed-ready"
        :data-seed-version="store.ctx?.seedVersion"
        :data-count="store.ctx?.assetCount ?? 0"
        class="sr-only"
      >seeded</span>
      <span
        data-testid="app-version"
        class="sr-only"
      >{{ version }}</span>
    </template>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

.boot-note {
  color: var(--muted);
  padding: var(--space-6) var(--space-4);
}

.error {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-5) var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--critical);
  border-radius: var(--radius);
  color: var(--critical);
  background: var(--surface);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.brand {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.brand-name {
  font-weight: 680;
  letter-spacing: -0.01em;
}

.brand-sub {
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

.nav {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.nav-link {
  color: var(--muted);
  text-decoration: none;
  font-size: 0.82rem;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
}

.nav-link.router-link-active {
  color: var(--ink);
  background: var(--surface-2);
  font-weight: 620;
}

.main {
  flex: 1;
  min-width: 0;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
