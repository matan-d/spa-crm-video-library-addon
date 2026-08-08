<script setup lang="ts">
// The demo affordances: role switcher and profile switcher.
//
// Gated behind VITE_DEMO_TOOLS and styled as a demo strip rather than an
// account menu, deliberately: this build has no authentication, and a control
// that looked like "switch account" would read as proof of access control that
// does not exist. The strip says what it is.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { DEMO_CREATOR_TOKEN } from '@/data/seed'
import { PROFILES, type ProfileId } from '@/data/profile'
import { roleHome } from '../router'
import { useAppStore, ACTIVE_ROLE_KEY, type ActiveRole } from '../store'
import type { StaffRole } from '../session'

const store = useAppStore()
const router = useRouter()

const roles: ActiveRole[] = ['manager', 'editor', 'creator']
const activeRole = computed(() => store.role)

async function pick(role: ActiveRole) {
  if (role === store.role) return
  if (role === 'creator') {
    // Entering as a creator means opening the demo token link, because a token
    // is the only door creators have. The route guard does the resolution.
    await router.push(`/c/${DEMO_CREATOR_TOKEN}`)
  } else {
    store.enterStaffRole(role as StaffRole)
    await router.push(roleHome(role))
  }
  rememberRole(role)
}

function rememberRole(role: ActiveRole) {
  try {
    window.localStorage.setItem(ACTIVE_ROLE_KEY, role)
  } catch {
    // A blocked storage write only means the demo reopens as manager.
  }
}

function pickProfile(profile: ProfileId) {
  if (profile === store.profile) return
  store.switchProfile(profile, window.localStorage, () => window.location.reload())
}
</script>

<template>
  <div
    class="demo-tools"
    role="group"
    aria-label="Demo controls"
  >
    <span class="demo-label mono">demo</span>

    <div
      data-testid="role-switcher"
      class="switch"
      role="group"
      aria-label="View as role"
    >
      <button
        v-for="role in roles"
        :key="role"
        type="button"
        data-testid="role-option"
        :data-role="role"
        class="option"
        :class="{ active: role === activeRole }"
        :aria-pressed="role === activeRole"
        @click="pick(role)"
      >
        {{ role }}
      </button>
    </div>
    <span
      data-testid="active-role"
      :data-role="activeRole"
      class="sr-only"
    >{{ activeRole }}</span>

    <div
      data-testid="profile-switcher"
      class="switch"
      role="group"
      aria-label="Data profile"
    >
      <button
        v-for="profile in PROFILES"
        :key="profile"
        type="button"
        class="option"
        :class="{ active: profile === store.profile }"
        :aria-pressed="profile === store.profile"
        @click="pickProfile(profile)"
      >
        {{ profile }}
      </button>
    </div>
    <span
      data-testid="active-profile"
      class="sr-only"
    >{{ store.profile }}</span>
  </div>
</template>

<style scoped>
.demo-tools {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.demo-label {
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--warn);
  border: 1px dashed var(--warn);
  border-radius: var(--radius);
  padding: 1px var(--space-1);
}

.switch {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

.option {
  appearance: none;
  border: none;
  background: var(--surface);
  color: var(--muted);
  font: inherit;
  font-size: 0.75rem;
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
}

.option + .option {
  border-left: 1px solid var(--line);
}

.option.active {
  background: var(--surface-2);
  color: var(--ink);
  font-weight: 620;
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
