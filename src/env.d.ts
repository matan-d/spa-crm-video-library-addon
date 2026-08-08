/** Build-time constants injected by vite.config.ts `define`. */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /**
   * Gates the demo affordances (role switcher, profile switcher). Defaults to
   * 'true' via `define` in vite.config.ts because this build IS the demo; a
   * real deployment sets VITE_DEMO_TOOLS=false in its build environment and
   * the controls disappear. See docs/06-decisions.md D14.
   */
  readonly VITE_DEMO_TOOLS?: string
}
