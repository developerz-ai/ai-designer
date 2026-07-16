import { defineConfig } from 'vitest/config';

// Local config so `vitest run` from waitlist/ does not walk up to the repo-root
// vitest.config.ts (which needs the root extension's node_modules).
export default defineConfig({
  test: {
    include: ['test/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
