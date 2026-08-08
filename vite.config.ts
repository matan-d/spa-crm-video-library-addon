import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  plugins: [vue()],
  define: {
    // The shell's app-version marker. A build-time constant, not a runtime read.
    __APP_VERSION__: JSON.stringify(pkg.version),
    // The demo affordances (role and profile switcher) default ON because this
    // build is the demo, and .env files are banned from the repo by .gitignore.
    // A real deployment sets VITE_DEMO_TOOLS=false in its build environment and
    // the controls disappear. See docs/06-decisions.md D14.
    'import.meta.env.VITE_DEMO_TOOLS': JSON.stringify(process.env.VITE_DEMO_TOOLS ?? 'true'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
    // Determinism is a test target, not a hope: a suite that only passes when
    // files happen to run in a particular order is a failing suite.
    sequence: { shuffle: true },
    globals: false,
  },
})
