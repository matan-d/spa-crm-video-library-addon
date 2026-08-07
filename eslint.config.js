import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

/**
 * The bans below are the mechanism that keeps the demo reproducible and the
 * tests deterministic. They are enforced by the linter rather than by code
 * review, because determinism decays quietly: one `Date.now()` added at 3am in a
 * component is enough to make a seeded dataset produce different ids on every
 * run, and nothing fails loudly when it happens.
 *
 * src/platform/ is the sanctioned boundary. Everything else takes Clock, Rng and
 * the capability probe as injected dependencies.
 */
const deterministicOnly = [
  {
    // `new Date()` reads ambient time. `new Date(explicitValue)` is a pure
    // conversion and stays allowed, which is the distinction that matters:
    // formatting an instant we were given is fine, inventing one is not.
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Ambient time is banned outside src/platform. Take a Clock and pass clock.now() into new Date(ms).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Ambient time is banned outside src/platform. Take a Clock and use clock.now().',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Ambient randomness is banned outside src/platform. Take an Rng and use rng.next().',
  },
  {
    selector: "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
    message: 'Use createIdFactory(clock, rng) so ids are reproducible under a seeded clock.',
  },
  {
    selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
    message: 'performance.now is ambient time. Measure through the platform layer so replayed latency stays data rather than measurement.',
  },
  {
    selector: "MemberExpression[object.name='navigator'][property.name='hardwareConcurrency']",
    message: 'Read capability through probeCapabilities(), never directly. Device-shaped branching must be capability-shaped.',
  },
  {
    selector: "MemberExpression[object.name='navigator'][property.name='deviceMemory']",
    message: 'Read capability through probeCapabilities(), never directly.',
  },
  {
    selector: "MemberExpression[object.name='navigator'][property.name='connection']",
    message: 'Read capability through probeCapabilities(), never directly.',
  },
  {
    selector: "MemberExpression[object.name='navigator'][property.name='userAgent']",
    message: 'Nothing in this product may branch on a user agent string. Use probeCapabilities().',
  },
]

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'docs/**', '.netlify/**'],
  },
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    rules: {
      'no-restricted-syntax': ['error', ...deterministicOnly],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    // The sanctioned boundary. These files exist precisely to contain the calls
    // banned above, so they may make them.
    files: ['src/platform/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Build scripts run in Node, outside the app, and legitimately use real time.
    files: ['scripts/**/*.mjs', 'netlify/**/*.mjs', 'eslint.config.js', 'vite.config.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
)
