import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// hcaptcha-key-guard: fail closed (#128). The PUBLIC hCaptcha site key is baked into
// the Vite bundle. Prevent shipping the always-pass test key or an empty key.
const hcaptchaKey = process.env.VITE_HCAPTCHA_SITEKEY || '';
if (!hcaptchaKey || hcaptchaKey === '10000000-ffff-ffff-ffff-000000000001') {
  throw new Error(
    `hcaptcha-key-guard: VITE_HCAPTCHA_SITEKEY must be set to a real key (got: ${hcaptchaKey ? 'test-key' : 'empty'}). ` +
      'This prevents shipping a captcha that always passes.',
  );
}

// Standalone static site — NOT part of the WXT extension build.
// Dev server binds 127.0.0.1 only: the SSH local-forward tunnel is the sole access path,
// so nothing leaks to the LAN. HMR (websocket on the same port) traverses the tunnel.
export default defineConfig({
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
      // Multi-page: the landing page, a standalone privacy notice, and the
      // (dark, unlinked) /world scroll-world page (#160).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
        world: fileURLToPath(new URL('./world.html', import.meta.url)),
      },
    },
  },
});
