import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// hCaptcha's public "always-passes" test sitekey. A production build must NEVER
// ship this — it disables bot protection on the waitlist form (#128).
const HCAPTCHA_TEST_KEY = '10000000-ffff-ffff-ffff-000000000001';

// Fail closed at build time: the deploy build (site/Dockerfile) always DEFINES
// VITE_HCAPTCHA_SITEKEY as an ENV — empty when the HCAPTCHA_SITEKEY repo variable
// is unset — so a deploy with no real key would otherwise silently fall back to the
// test key. Abort the build instead. A LOCAL `bun run build` leaves the var
// UNDEFINED (it never deploys), so it is allowed; the runtime then renders a visible
// disabled state rather than the test key (see src/main.ts initCaptcha).
function hcaptchaKeyGuard(): Plugin {
  return {
    name: 'hcaptcha-key-guard',
    apply: 'build',
    config() {
      const raw = process.env.VITE_HCAPTCHA_SITEKEY;
      if (raw === undefined) {
        return; // local build — allowed (cannot deploy; runtime fails closed)
      }
      const key = raw.trim();
      if (key === '' || key === HCAPTCHA_TEST_KEY) {
        const what = key === '' ? 'empty' : 'the hCaptcha test key';
        throw new Error(
          `hcaptcha-key-guard: VITE_HCAPTCHA_SITEKEY is ${what} — refusing to build a ` +
            'production image with no real hCaptcha key (it would ship the always-pass ' +
            'test key and disable bot protection on the waitlist form). Set the ' +
            'HCAPTCHA_SITEKEY repo variable (site-deploy.yml -> Dockerfile ARG).',
        );
      }
    },
  };
}

// Standalone static site — NOT part of the WXT extension build.
// Dev server binds 127.0.0.1 only: the SSH local-forward tunnel is the sole access path,
// so nothing leaks to the LAN. HMR (websocket on the same port) traverses the tunnel.
export default defineConfig({
  plugins: [hcaptchaKeyGuard()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    sourcemap: false,
    rollupOptions: {
      // Multi-page: the landing page plus a standalone privacy notice.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
      },
    },
  },
});
