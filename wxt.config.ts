import { defineConfig } from 'wxt';

// WXT config — https://wxt.dev/api/config.html
// Release builds are tree-shaken + minified + css-optimized via the vite block below.
export default defineConfig({
  srcDir: 'src',
  // Assets live in src/public; WXT's publicDir defaults to <root>/public, so without
  // this the icons (manifest `icons`) and /logo.png are missing from the build and
  // Chrome refuses to load the unpacked extension ("Could not load icon").
  publicDir: 'src/public',
  // @wxt-dev/i18n: type-safe browser.i18n wrapper. Messages live in src/locales/<lang>.yml;
  // `wxt prepare` generates _locales/ + the typed `#i18n` module. default_locale below is
  // required for the manifest __MSG_*__ substitutions to resolve.
  modules: ['@wxt-dev/module-solid', '@wxt-dev/i18n/module'],
  manifest: {
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
      '16': '/icon/logo.png',
      '32': '/icon/logo.png',
      '48': '/icon/logo.png',
      '128': '/icon/logo.png',
    },
  },
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
