import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// E2E: the History SPA (slice 08 — `docs/idea/history.md`/`08-history.md`) driven against a loaded,
// real Chromium, mirroring handoff.spec.ts's approach: two real `user-message` turns (same RPC a
// wired composer sends) run the full SW -> provider -> tool bus -> real page pipeline (network-
// stubbed model only), then `download-report` attaches a real authored brief to that conversation's
// history entry (background.ts `runHandoffRoute`'s `historyStore.setReport`). From there the test
// drives the actual panel UI — the History tab, HistoryPanel's list, and ConversationView's replay
// + re-download button — rather than the RPCs those components wrap, since the SPA itself (slice 08)
// is what this test exists to cover.

const BASE_URL = 'https://openrouter.ai/api/v1';
const FIXTURE_PREFIX = 'https://openrouter.ai/e2e-fixture-08/';

async function stubModels(context: BrowserContext): Promise<void> {
  await context.route(`${BASE_URL}/models`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test/vision', name: 'Test Vision' }] }),
    }),
  );
}

async function stubFixtures(context: BrowserContext, pages: Record<string, string>): Promise<void> {
  await context.route(`${FIXTURE_PREFIX}**`, (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const body = pages[key];
    if (body === undefined) {
      route.fulfill({ status: 404, body: '' });
      return;
    }
    route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

interface ChatMessage {
  role: string;
  content?: unknown;
}
interface ChatRequestBody {
  messages: ChatMessage[];
  stream?: boolean;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: 'e2e-chunk',
    created: 0,
    model: 'test/vision',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason
      ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : {}),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textStream(text: string): string {
  return (
    sseChunk({ role: 'assistant' }) +
    sseChunk({ content: text }) +
    sseChunk({}, 'stop') +
    'data: [DONE]\n\n'
  );
}

// Every `/chat/completions` POST is one of two shapes: the streaming turn (served in order from
// `turns[]`) or the report pass's non-streaming `generateObject` call — mirrors handoff.spec.ts.
function stubProvider(
  context: BrowserContext,
  turns: string[],
  reportDraft: Record<string, unknown>,
): { streamRequests: ChatRequestBody[] } {
  const streamRequests: ChatRequestBody[] = [];
  void context.route(`${BASE_URL}/chat/completions`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as ChatRequestBody;
    if (body.stream) {
      const index = streamRequests.length;
      streamRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: turns[index] ?? textStream('(unexpected extra turn)'),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-report',
        object: 'chat.completion',
        created: 0,
        model: 'test/vision',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(reportDraft) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }),
    });
  });
  return { streamRequests };
}

async function configureProvider(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#dz-key').fill('sk-or-test-08');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#dz-model option')).toHaveText(['Test Vision']);
  await page.locator('#dz-model').selectOption('test/vision');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dz-settings__status')).toHaveText('Provider saved and reachable.');
}

async function sendUserMessage(page: Page, text: string, mode: 'copy' | 'debug'): Promise<void> {
  await page.evaluate(
    ({ text, mode }) => chrome.runtime.sendMessage({ type: 'user-message', text, mode }),
    { text, mode },
  );
}

const OWN_PAGE =
  '<!doctype html><html><body style="background-color:#0f172a;color:#f8fafc;font-family:Georgia">' +
  '<h1 style="color:#f8fafc">My Hero</h1>' +
  '<button id="cta" style="background-color:#e5e7eb;color:#0f172a">Buy now</button>' +
  '</body></html>';

const REPORT_DRAFT = {
  summary: 'Tightened the hero copy and confirmed the CTA reads well.',
  findings: ['CTA copy reads clearly'],
  problems: ['Nav overflows the viewport at 375px'],
  pros: ['Consistent use of the accent color'],
  cons: [],
  recommendations: ['Adopt an 8px spacing grid'],
};

const TURN_1_TEXT = 'Tighten the hero headline';
const TURN_1_REPLY = 'Tightened the headline copy.';
const TURN_2_TEXT = 'Now review the CTA wording';
const TURN_2_REPLY = 'CTA wording confirmed, no changes needed.';

test.describe('History SPA', () => {
  test('two turns land in one history entry; opening it replays both turns and re-downloads the report', async ({
    context,
    openExtensionPage,
  }) => {
    await stubModels(context);
    await stubFixtures(context, { own: OWN_PAGE });
    const { streamRequests } = stubProvider(
      context,
      [textStream(TURN_1_REPLY), textStream(TURN_2_REPLY)],
      REPORT_DRAFT,
    );

    const panel = await openExtensionPage('sidepanel.html');
    await configureProvider(panel);

    const ownPage = await context.newPage();
    await ownPage.goto(`${FIXTURE_PREFIX}own`);
    await ownPage.bringToFront();

    // Turn 1 + turn 2, same tab/session -> one conversation, two turns of messages.
    await sendUserMessage(panel, TURN_1_TEXT, 'copy');
    await expect.poll(() => streamRequests.length, { timeout: 20_000 }).toBe(1);
    await sendUserMessage(panel, TURN_2_TEXT, 'copy');
    await expect.poll(() => streamRequests.length, { timeout: 20_000 }).toBe(2);

    // Author + attach a report to this session's history entry (background.ts `runHandoffRoute`
    // downloadOnly path -> `historyStore.setReport`), so the replay below has something to
    // re-download — mirrors handoff.spec.ts's `download-report` RPC.
    const downloadResult = (await panel.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'download-report' }),
    )) as { ok: boolean; markdown?: string };
    expect(downloadResult.ok).toBe(true);
    expect(downloadResult.markdown).toContain(REPORT_DRAFT.summary);

    // Open History — the entry (title = the first turn's message) shows a mode badge, a date, and
    // the "Report" badge (has a report, no PR link yet).
    await panel.getByRole('button', { name: 'History' }).click();
    const rows = panel.locator('.dz-history__item');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(TURN_1_TEXT);
    await expect(rows.first()).toContainText('copy');
    await expect(rows.first().locator('.dz-history__reportbadge')).toBeVisible();

    // Open it: a read-only replay of BOTH turns, in order.
    await rows.first().locator('.dz-history__row').click();
    const thread = panel.locator('.dz-convview__thread .dz-convview__line');
    await expect(thread).toHaveCount(4); // user+assistant x2
    const threadText = await thread.allTextContents();
    expect(threadText.join(' | ')).toContain(TURN_1_TEXT);
    expect(threadText.join(' | ')).toContain(TURN_1_REPLY);
    expect(threadText.join(' | ')).toContain(TURN_2_TEXT);
    expect(threadText.join(' | ')).toContain(TURN_2_REPLY);
    await expect(panel.locator('.dz-convview__readonly')).toContainText('Read-only replay');

    // Re-download: a real blob-URL download, filename slugified from the entry's title, content
    // matching the report that was attached.
    const [download] = await Promise.all([
      panel.waitForEvent('download'),
      panel.getByRole('button', { name: 'Re-download report' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('tighten-the-hero-headline-report.md');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream ?? []) chunks.push(chunk as Buffer);
    const content = Buffer.concat(chunks).toString('utf-8');
    expect(content).toBe(downloadResult.markdown);

    // Back to the list, then delete the entry — it's gone from both the panel and a fresh list RPC.
    await panel.locator('.dz-convview__back').click();
    await expect(panel.locator('.dz-history__item')).toHaveCount(1);
    await panel.getByRole('button', { name: `Delete ${TURN_1_TEXT}` }).click();
    await expect(panel.locator('.dz-history__item')).toHaveCount(0);
    const listAfterDelete = (await panel.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'history-list' }),
    )) as { ok: boolean; conversations?: unknown[] };
    expect(listAfterDelete.conversations).toEqual([]);
  });
});
