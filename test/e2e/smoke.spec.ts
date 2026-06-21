import { test } from '@playwright/test';

// E2E smoke — loads the built extension and asserts the side panel mounts.
// Requires a real Chromium with the unpacked extension from `.output/chrome-mv3`
// and a persistent context. Skipped until the build + harness are wired in CI.
test.skip('side panel mounts', async () => {
  // TODO: launch chromium with
  //   --disable-extensions-except=.output/chrome-mv3 --load-extension=.output/chrome-mv3
  // open the side panel, assert the Chat tab renders.
});
