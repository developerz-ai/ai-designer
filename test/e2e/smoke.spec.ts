import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { expect, test } from './fixtures';

function emittedSidePanelPath(): string {
  const buildDir = realpathSync('build/chrome-mv3');
  const manifest = z
    .object({ side_panel: z.object({ default_path: z.string().trim().min(1) }) })
    .parse(JSON.parse(readFileSync(path.join(buildDir, 'manifest.json'), 'utf8')));
  const panelPath = manifest.side_panel.default_path;
  const target = realpathSync(path.resolve(buildDir, panelPath));
  const relativeTarget = path.relative(buildDir, target);
  expect(relativeTarget, 'side-panel target must stay within build/chrome-mv3').not.toBe('');
  expect(relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === '..').toBe(false);
  expect(path.isAbsolute(relativeTarget)).toBe(false);
  expect(statSync(target).isFile(), `side-panel target must be a file: ${panelPath}`).toBe(true);
  console.info(`Emitted side_panel.default_path: ${panelPath} (target exists)`);
  test.info().annotations.push({ type: 'side_panel.default_path', description: panelPath });
  return panelPath;
}

// E2E smoke — loads the built extension (build/chrome-mv3) and asserts the side
// panel mounts. MV3 side panels can't be opened via a Playwright toolbar gesture,
// so navigate a tab directly to the panel's extension-origin page and assert the
// Chat surface renders. Read the emitted manifest rather than assuming WXT
// preserves the source config path or flattens it to a particular output name.
test('side panel mounts on the Chat tab, gated behind Start on a fresh profile', async ({
  openExtensionPage,
}) => {
  const panelPath = emittedSidePanelPath();
  const page = await openExtensionPage(panelPath);

  // App shell rendered (App.tsx → <div class="dz-app">).
  await expect(page.locator('.dz-app')).toBeVisible({ timeout: 10_000 });

  // Chat owns the panel at rest — there is no strip, so what proves "mounted on Chat" is the
  // nav trigger being present with NO room bar over the surface (a room would show a back
  // button and its own heading). A fresh profile has no provider configured yet, so ChatPanel
  // stays gated behind the pre-Start empty state (App.tsx `sessionStarted`, see
  // readiness.spec.ts for the full configure -> Ready -> Start walk). Static DOM, no
  // chrome.* / network dependency at mount, so this is deterministic across CI retries.
  await expect(page.getByRole('button', { name: 'Designer' })).toBeVisible();
  await expect(page.locator('.dz-app__roombar')).toHaveCount(0);
  await expect(
    page.getByText('Configure a provider above, then hit Start to begin chatting.'),
  ).toBeVisible();
  await expect(page.getByPlaceholder('Tell the agent what to change…')).toHaveCount(0);
});

// CSP no-remote-fetch verification: icons are self-hosted, tree-shaken SVG (bundled JS,
// not a remote webfont — CLAUDE.md "no remote code" MV3 rule / "Icon component (inline
// SVG, tree-shaken, no innerHTML-of-remote)"). Every request the loaded panel makes must
// resolve to its own extension origin and none may be blocked (e.g. by CSP) or fail.
test('side panel makes zero blocked/remote font or script requests', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const requestUrls: string[] = [];
  const failedRequests: string[] = [];

  page.on('request', (request) => {
    requestUrls.push(request.url());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'unknown'})`);
  });

  const panelPath = emittedSidePanelPath();
  await page.goto(`chrome-extension://${extensionId}/${panelPath}`);
  await expect(page.locator('.dz-app')).toBeVisible({ timeout: 10_000 });

  const remoteRequests = requestUrls.filter((url) => !url.startsWith('chrome-extension://'));
  expect(remoteRequests).toEqual([]);
  expect(failedRequests).toEqual([]);

  await page.close();
});
