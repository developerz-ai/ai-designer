// Shared DOM-test setup: jest-dom matchers (toBeInTheDocument, toHaveAccessibleName, …)
// and an unmount between specs so Solid roots from one test never leak into the next.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@solidjs/testing-library';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
