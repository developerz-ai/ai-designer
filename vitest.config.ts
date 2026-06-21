import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit + integration share one runner; the npm scripts filter by directory
// (`vitest run unit` / `vitest run integration`) so CI can run them as parallel jobs.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.{test,spec}.ts'],
    exclude: ['test/e2e/**', 'node_modules', '.output', '.wxt'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/entrypoints/**', 'src/**/*.d.ts'],
    },
  },
});
