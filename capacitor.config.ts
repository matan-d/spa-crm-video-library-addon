/**
 * Capacitor configuration for the three shells this build designs and never runs:
 * Capacitor iOS, Capacitor Android, and the Electron desktop shell.
 *
 * Per docs/06-decisions.md U4 and U6 all three are designed, configured and
 * documented, and not one of them has ever been built, synced or launched.
 * `docs/09-shell-notes.md` is the companion to this file: what would have to be
 * true for each shell to work, what we already know will break, and what is
 * untested. Read it before changing anything here.
 *
 * Two consequences of "never built" that a reader should not have to infer:
 *
 * 1. Neither `@capacitor/cli` nor `@capacitor-community/electron` is installed,
 *    deliberately, because a dependency whose CLI we never run is a claim we
 *    cannot back. The type import below is therefore unresolvable today, and
 *    this file is outside the `include` list in `tsconfig.json` so that
 *    `npm run typecheck` stays green while saying nothing at all about a shell.
 *    Installing Capacitor and adding this file to `include` is step one of
 *    actually building a shell, and it should be a deliberate act.
 * 2. Every value below is reasoned from documentation, never from a device.
 *    Each non obvious setting carries its reason, and where getting it wrong is
 *    survivable it also carries the observable that will tell us it was wrong.
 *
 * Sources, all checked 2026-08-09:
 * - Capacitor "Configuration" (capacitorjs.com/docs/config) for every key, type
 *   and default used here. Current CLI on npm is 8.5.0.
 * - `@capacitor-community/electron` "Config Options"
 *   (capacitor-community.github.io/electron/docs/configoptions/) for the
 *   `electron` key and its defaults. Latest published version is 5.0.1 and its
 *   own README now states the project is unmaintained: see docs/09-shell-notes.md
 *   section 9 for why we still write its config shape.
 * - Vite "Building for Production" for the browser floor this bundle really has.
 */

import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The `electron` key contributed by `@capacitor-community/electron`.
 *
 * Declared structurally rather than imported as that package's
 * `ElectronCapacitorConfig`, for one reason: the package is unmaintained and
 * pinned to `@capacitor/cli >=5.4.0` while the CLI is at 8, so importing its
 * type would tie this file's type to the older of the two dependencies. The
 * shape and the defaults in the comments come from its published Config Options
 * page, checked 2026-08-09.
 */
interface ElectronShellConfig {
  /** Scheme the app is served on inside the Electron window. Default `capacitor-electron`. */
  customUrlScheme?: string
  /** Default false. */
  trayIconAndMenuEnabled?: boolean
  /** Default false. */
  splashScreenEnabled?: boolean
  /** Default `splash.png`, resolved inside `electron/assets`. */
  splashScreenImageName?: string
  /** Default false. */
  hideMainWindowOnLaunch?: boolean
  /** Default false. */
  deepLinkingEnabled?: boolean
  /** Default `mycapacitorapp`. Only read when `deepLinkingEnabled` is true. */
  deepLinkingCustomProtocol?: string
  /** Electron window background colour. */
  backgroundColor?: string
}

const config: CapacitorConfig & { electron: ElectronShellConfig } = {
  // Reverse domain identifier. Stated intent only: no bundle identifier has been
  // registered with Apple or Google, nothing is provisioned, and nothing is signed.
  appId: 'com.astolia.collabs',
  appName: 'Astolia Collabs',

  // Vite writes the static site to `dist`, and `npm run build` is the only step
  // that produces it. There is no separate shell build: the same bundle that
  // Netlify serves is the bundle a shell would package, which is what keeps the
  // three surfaces from drifting into three products.
  webDir: 'dist',

  // The router is hash based (`src/app/router.ts` uses `createWebHashHistory`),
  // which is load bearing here rather than incidental. A history router needs a
  // server rewrite, and a custom scheme handler serving a directory has no
  // rewrite rule, so `capacitor://localhost/library` would 404 inside the shell
  // while working perfectly on Netlify. Hash routing removes that entire class
  // of shell only bug, and it is also why the creator link `/#/c/<token>` works
  // identically in every runtime.

  server: {
    // Default, and stated rather than omitted because a secure context depends
    // on it. Capacitor's own guidance is to keep the hostname `localhost`,
    // because that is what satisfies the engine's trustworthiness check and so
    // keeps OPFS, Web Workers and Web Crypto available. Changing this single
    // string is enough to silently remove the storage layer this product is
    // built on.
    hostname: 'localhost',

    // Defaults, both. iOS cannot use `http` or `https` here because WKWebView
    // already handles those schemes, so iOS gets `capacitor://localhost` and
    // Android gets `https://localhost`.
    //
    // Both are a DIFFERENT ORIGIN from the deployed browser build, so IndexedDB
    // and OPFS written in a browser are unreachable inside a shell and vice
    // versa. That is not a bug to fix, it is a fact to surface: the probe now
    // warns on any non http scheme (`warnOnOrigin()`, src/platform/capability.ts),
    // and snapshot export and import is the only supported route between the
    // two. Changing either value after a shell has shipped orphans that shell's
    // data. Note that the Android value does NOT trigger that warning, because
    // it is `https:` and only the host differs: see P-16 in the shell notes.
    iosScheme: 'capacitor',
    androidScheme: 'https',

    // A local page shown when the WebView cannot load the app. It exists here
    // for one specific failure: `android.minWebViewVersion` below refuses to
    // start on an old System WebView, and without `errorPath` that refusal is a
    // Logcat line, which is invisible to the person holding the phone. The page
    // is plain static HTML with no script, because Capacitor documents that the
    // error page has no access to Capacitor plugins on Android.
    // Source for the Logcat only behaviour is secondary (Capgo's plugin docs,
    // checked 2026-08-09), so the observable is written down in
    // qa/manual-checklist.md 2.3 rather than assumed.
    errorPath: 'unsupported-webview.html',

    // Default. This app never talks to a plaintext origin: there is no server at
    // all, and the one designed network call (the model proxy) is https.
    cleartext: false,

    // Deliberately empty. Every URL outside the app opens in the system browser
    // instead of inside the WebView, which matters more here than usual: a page
    // allowed to navigate inside this WebView shares the shell's storage origin,
    // and that origin holds the whole library plus the consent records.
    allowNavigation: [],
  },

  ios: {
    // Default, and correct for us rather than merely inherited. `never` means
    // WKWebView does not adjust the scroll view for the safe area, so the notch
    // and the home indicator are ours to handle in CSS with
    // `env(safe-area-inset-*)`. That is the same mechanism mobile Safari needs,
    // so one implementation covers both, and `index.html` already carries the
    // `viewport-fit=cover` that makes those values non zero.
    // The CSS half is not written yet: docs/platform-matrix.md P-9 is open, and
    // it must close before this shell is built or the submit and approve
    // controls sit under the home indicator.
    contentInset: 'never',

    // Left at the default `false`, deliberately. Setting it true requires a
    // matching `WKAppBoundDomains` array in Info.plist, and if that array is
    // wrong or missing the WebView refuses navigation entirely, which is a
    // blank app. We cannot test either outcome, so we take the default that
    // fails soft over the hardening that fails hard.
    limitsNavigationsToAppBoundDomains: false,

    // The app ships no notifications of any kind, and letting Capacitor claim
    // the notification delegate would be taking ownership of a surface that
    // does not exist.
    handleApplicationNotifications: false,

    // `mobile` rather than `recommended`, because `recommended` gives an iPad a
    // desktop content mode, and this layout is built from capability queries
    // (pointer, hover, width) rather than from a device class. Asking for the
    // mobile content mode keeps the viewport honest about the hardware.
    preferredContentMode: 'mobile',

    // Never in a shipped build. It is an Xcode 14.3+ switch that leaves the web
    // content inspectable on any machine the app is installed on.
    webContentsDebuggingEnabled: false,

    // Pinch zoom off inside the app shell: this is an application surface, not a
    // document, and a zoomed WebView breaks the sticky action bars that the
    // review flow depends on. Text scaling still comes from the OS accessibility
    // settings, which is the accessible path and is not affected by this.
    zoomEnabled: false,

    // The light `--bg` token from src/styles/tokens.css, so the first frame is
    // not a white flash against our own surface colour.
    // Known and unfixable from config: this is one static colour, while the app
    // follows `prefers-color-scheme` (tokens.css has a dark block). On a device
    // in dark mode the launch frame is light for as long as the WebView takes to
    // paint. Cosmetic, visible, and stated so nobody files it as a mystery.
    backgroundColor: '#eef1eb',
  },

  android: {
    // The honest floor, and the one number in this file derived from our own
    // build rather than from a platform document.
    //
    // Vite 6's default `build.target` is `baseline-widely-available`, which for
    // this Vite major resolves to Chrome >= 107, and `vite.config.ts` does not
    // override it. So the bundle we ship contains syntax that a Chromium below
    // 107 cannot parse, and on an older Android System WebView the result is a
    // white screen and a console error nobody will ever read.
    // Capacitor's default here is 60, which would let exactly that happen.
    // Setting 107 converts an unexplained white screen into a named refusal plus
    // the error page above.
    //
    // This number is coupled to `build.target`: Vite 7 moves the baseline to
    // Chrome 111, so upgrading Vite without moving this line reopens the hole.
    // QC-PLAT-049 asserts the coupling from the text of both files.
    minWebViewVersion: 107,

    // Android 15 enforces edge to edge, so without this the app draws under the
    // status and navigation bars. `auto` adjusts the native margins only when
    // the OS is actually enforcing it, which is the closest thing this option
    // has to a capability check. Introduced in Capacitor 7.1.0, default
    // `disable` (checked 2026-08-09).
    //
    // This is a temporary belt: the real fix is `env(safe-area-inset-*)` in CSS,
    // which also covers iOS and mobile Safari where no native option exists.
    // When P-9 lands, the two mechanisms stack and this should move to
    // `disable`. Recorded in qa/manual-checklist.md 2.3 with the observable
    // (doubled empty space below the review bar) so the revisit is not left to
    // memory.
    adjustMarginsForEdgeToEdge: 'auto',

    // Defaults, all three, and each stated because loosening it has a cost:
    // mixed content would let an http subresource into an https origin,
    // `captureInput` swaps in a simpler keyboard with documented limitations,
    // and debuggable web content in a release build is inspectable by anyone
    // with the device.
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,

    zoomEnabled: false,
    backgroundColor: '#eef1eb',

    // No `buildOptions` block, and that is a rule rather than an omission: it
    // holds keystore paths and passwords, and nothing resembling a credential is
    // committed to this repository. A real release build supplies them from its
    // own environment.
  },

  // An empty allowlist means `npx cap sync` copies no Capacitor plugins into a
  // shell. That is the true state: this app uses zero Capacitor plugins, because
  // everything it needs (storage, files, media decode) is a web API that must
  // keep working in the browser build where no plugin can exist. Stating it
  // explicitly means a plugin cannot arrive transitively and start serving a
  // capability the browser build does not have, which would fork the product.
  includePlugins: [],

  electron: {
    // Default. It is also the reason this shell is a separate storage origin
    // from every other target, exactly like the two mobile schemes above.
    customUrlScheme: 'capacitor-electron',

    // No tray icon, no splash screen, no hidden launch window, no deep linking.
    // Each of these is a surface that would need designing, and a surface that
    // only exists in a shell nobody has run is a surface nobody has reviewed.
    // Deep linking in particular stays off: the creator link is a browser only
    // URL forever (U5), and a desktop protocol handler that claimed those links
    // would break the one flow that has no install and no account.
    trayIconAndMenuEnabled: false,
    splashScreenEnabled: false,
    hideMainWindowOnLaunch: false,
    deepLinkingEnabled: false,

    backgroundColor: '#eef1eb',
  },

  // Deliberately not set, and each for a reason:
  //
  // - `loggingBehavior`: left at `debug`. Raising it to `production` would keep
  //   native and JS logging on in a release build, and this app's logs describe
  //   real creators and real deals.
  // - `overrideUserAgent` and `appendUserAgent`: nothing in this product may
  //   read a user agent (CLAUDE.md standing rules), so writing one would be a
  //   string nobody is allowed to consult. Shell identity comes from the probe.
  // - `server.url`: that is the live reload escape hatch. It points the WebView
  //   at a dev server over the network, which changes the origin again and would
  //   make a shell session read a third storage identity.
  // - `ios.scheme` (the Xcode build scheme, not the URL scheme) and
  //   `android.flavor`: both are properties of native projects that do not exist.
  // - `cordova`: no Cordova plugins, now or planned.
}

export default config
