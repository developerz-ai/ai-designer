import { defineConfig } from 'wxt';
import { extensionId, publicKeyBase64 } from './scripts/crx-key';

// Pin the extension ID by baking the public half of the signing key into the manifest.
// Without it every fresh profile / rebuild gets a random ID, and the OAuth redirect
// (https://<id>.chromiumapp.org/, src/mcp/auth.ts) registered with an MCP provider stops
// matching. Chrome-only: MV2/Firefox has no `key` field and would warn on it.
const CRX_PUBLIC_KEY = publicKeyBase64();
if (CRX_PUBLIC_KEY) {
  console.info(`\x1b[2mextension id: ${extensionId(CRX_PUBLIC_KEY)}\x1b[0m`);
}

// The git tag is the version. WXT otherwise falls back to package.json, so tagging v1.4.0
// would have shipped a manifest still reading 1.0.0 — and the Chrome Web Store rejects an
// upload whose version isn't higher than the published one. GITHUB_REF_NAME is only trusted
// when it parses as a version (it is "main" on a branch push); EXT_VERSION forces it locally.
const TAG = (process.env.EXT_VERSION ?? process.env.GITHUB_REF_NAME ?? '').replace(/^v/, '');
const RELEASE_VERSION = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(TAG) ? TAG : null;
// Chrome's `version` is 1-4 dot-separated integers — a `-beta.1` suffix is invalid there,
// so it lives in `version_name`, which is free-form and what the UI actually displays.
const MANIFEST_VERSION = RELEASE_VERSION?.match(/^\d+(\.\d+){0,3}/)?.[0];
const VERSION_FIELDS =
  MANIFEST_VERSION && RELEASE_VERSION
    ? {
        version: MANIFEST_VERSION,
        ...(RELEASE_VERSION === MANIFEST_VERSION ? {} : { version_name: RELEASE_VERSION }),
      }
    : {};

// WXT config — https://wxt.dev/api/config.html
// Release builds are tree-shaken + minified + css-optimized via the vite block below.
export default defineConfig({
  srcDir: 'src',
  // Not WXT's default `.output` — a dotdir is hidden by editors (VSCode `files.exclude`),
  // by `ls`, and by actions/upload-artifact. Build output you have to load unpacked
  // should be visible. Targets land in build/<browser>-mv<n>; zips + .crx at build/.
  outDir: 'build',
  // Assets live in src/public; WXT's publicDir defaults to <root>/public, so without
  // this the icons (manifest `icons`) and /logo.png are missing from the build and
  // Chrome refuses to load the unpacked extension ("Could not load icon").
  publicDir: 'src/public',
  // @wxt-dev/i18n: type-safe browser.i18n wrapper. Messages live in src/locales/<lang>.yml;
  // `wxt prepare` generates _locales/ + the typed `#i18n` module. default_locale below is
  // required for the manifest __MSG_*__ substitutions to resolve.
  modules: ['@wxt-dev/module-solid', '@wxt-dev/i18n/module'],
  manifest: ({ browser }) => ({
    ...VERSION_FIELDS,
    // `key` pins the ID for local/self-hosted builds. The Chrome Web Store assigns its own
    // key, so store uploads omit it — see CWS_UPLOAD=1 below and docs/RELEASING.md.
    ...(browser === 'chrome' && CRX_PUBLIC_KEY && !process.env.CWS_UPLOAD
      ? { key: CRX_PUBLIC_KEY }
      : {}),
    // Localized via src/locales/en.yml (top-level flat keys → generated _locales messages).
    default_locale: 'en',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    // Side panel is the durable UI surface — survives page navigation.
    side_panel: {
      default_path: 'sidepanel/index.html',
    },
    // Clicking this toolbar action opens/toggles the side panel — wired via
    // `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in the service worker
    // (src/entrypoints/background.ts), not through a manifest flag.
    action: {
      default_title: '__MSG_actionTitle__',
    },
    // Least-privilege permissions — each retained entry gates a concrete, in-use
    // `chrome.*` surface. `scripting` was removed (zero `chrome.scripting.*` refs
    // in src/; content script is auto-injected via the manifest, not programmatic).
    //   sidePanel      — chrome.sidePanel.*: the durable side-panel UI surface.
    //   storage        — chrome.storage.{session,local}: agent/mcp/changeset
    //                    stores persist SW state across ephemeral restarts.
    //   activeTab      — host grant for the user's current tab on explicit action;
    //                    lets the content script run without a broad <all_urls> grant.
    //   tabs           — chrome.tabs.* (query/capture/navigate): ~27 background.ts
    //                    calls + tab tools. SW-only — not exposed to the page.
    //   identity       — chrome.identity.{launchWebAuthFlow,getRedirectURL}:
    //                    OAuth 2.0 PKCE for MCP backends; tokens never touch the page.
    //   webNavigation  — chrome.webNavigation.getAllFrames: frame-tree enumeration
    //                    so the agent can target a specific iframe. SW-only.
    //   debugger       — chrome.debugger.* (attach/sendCommand/detach): CDP
    //                    Emulation.setDeviceMetricsOverride for true device emulation. SW-only.
    permissions: [
      'sidePanel',
      'storage',
      'activeTab',
      'tabs',
      'identity',
      'webNavigation',
      'debugger',
    ],
    // OpenRouter is the BYOK model endpoint; the service worker calls it directly,
    // so it needs a static host grant (CORS-exempt). Page hosts stay opt-in below.
    host_permissions: ['https://openrouter.ai/*', 'https://glitchtip.infra.developerz.ai/*'],
    // Least privilege: the user grants broad page access only when they want it.
    optional_host_permissions: ['<all_urls>'],
    icons: {
      '16': '/icon/icon-16.png',
      '32': '/icon/icon-32.png',
      '48': '/icon/icon-48.png',
      '128': '/icon/icon-128.png',
    },
  }),
  vite: () => ({
    build: {
      target: 'esnext',
      minify: 'esbuild',
      cssMinify: true,
      sourcemap: false,
      rollupOptions: {
        treeshake: true,
      },
    },
  }),
});
