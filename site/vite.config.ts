import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

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
      // Multi-page: the landing page plus a standalone privacy notice.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
      },
    },
  },
});
