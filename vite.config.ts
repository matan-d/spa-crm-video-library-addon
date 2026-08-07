import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
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
