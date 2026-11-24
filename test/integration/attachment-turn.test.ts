import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { toStoredUserContent, toUserContent } from '@/agent/attachments';
import { groundUserText } from '@/agent/focus-context';
import { HistoryStore } from '@/agent/history-store';
import { runTurn } from '@/agent/loop';
import { modeGuidance, resolveMode } from '@/agent/modes';
import { type ChatMessage, SessionStore } from '@/agent/session';
import { buildSystemPrompt } from '@/agent/system-prompt';
import { compactForThread } from '@/agent/thread-compact';
import type { DomDispatch } from '@/agent/tools/dom';
import { type Attachments, Attachments as AttachmentsSchema } from '@/shared/attachments';

// Integration (attachment ingress, ONE-SHOT images): the reference image the user attached reaches
// the PROVIDER's prompt on the turn it was sent, and its bytes then exist NOWHERE that outlives the
// turn — not in `chrome.storage.*`, not in the session thread, not in history.
//
// The gap this covers: the agent was multimodal outward only — it screenshots the page, and
// `background.ts` built the turn's user message as a plain STRING, so a mockup had nowhere to ride.
// Unit tests pin the mapping (`test/unit/attachments.test.ts`); this pins the WIRING and the two
// properties that make one-shot safe: the model really sees the image, and nothing keeps it.
//
// background.ts can't be imported under Vitest (it pulls the WXT `#imports` virtual module), so
// `sendUserMessage` below mirrors its `user-message` spine 1:1 against the REAL cooperating modules
// — the same approach as `thread-memory.test.ts` and `agent-loop.test.ts`.

const PAGE_URL = 'https://example.com/pricing';
const SESSION_ID = '00000000-0000-0000-0000-0000000000bb';
const TAB_ID = 11;
const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'.repeat(20)}`;

const MOCKUP = {
  kind: 'image' as const,
  id: 'a1',
  name: 'hero-desktop.png',
  mediaType: 'image/png' as const,
  dataUrl: PNG,
  width: 1600,
  height: 900,
};

// --- storage fake, with its raw areas exposed so a test can scan every byte ever written ---------

interface StorageFake {
  readonly local: Map<string, unknown>;
  readonly session: Map<string, unknown>;
}

function installStorageFakes(): StorageFake {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const api = (store: Map<string, unknown>) => ({
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items))
        store.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: api(local), session: api(session) },
  };
  return { local, session };
}

/** Everything ever written to any storage area, as one string to scan. */
const storageDump = (storage: StorageFake): string =>
  JSON.stringify([[...storage.local.entries()], [...storage.session.entries()]]);

function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const answer = (text: string): LanguageModelV4StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '1' },
  { type: 'text-delta', id: '1', delta: text },
  { type: 'text-end', id: '1' },
  { type: 'finish', usage: usage(300, 20), finishReason: { unified: 'stop', raw: 'stop' } },
];

/** Captures the prompt the provider was actually handed, then answers with one line of prose. */
function capturingModel(): { model: MockLanguageModelV4; prompts: LanguageModelV4Prompt[] } {
  const prompts: LanguageModelV4Prompt[] = [];
  const model = new MockLanguageModelV4({
    doStream: (options: LanguageModelV4CallOptions) => {
      prompts.push(options.prompt);
      return Promise.resolve({ stream: convertArrayToReadableStream(answer('Matching it.')) });
    },
  });
  return { model, prompts };
}

/** A model that blocks inside `doStream` until `release()` — keeps the turn verifiably in flight
 *  (its message array, image parts and all, alive) while an abort/supersede happens. */
function gatedModel(): { model: MockLanguageModelV4; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new MockLanguageModelV4({
    doStream: async () => {
      await gate;
      return { stream: convertArrayToReadableStream(answer('Done.')) };
    },
  });
  return { model, release };
}

const noopDispatch: DomDispatch = () =>
  Promise.resolve({ type: 'tool-result', ok: true, data: { applied: true } });

/** Mirrors background.ts's `user-message` composition order EXACTLY: focus grounding, then the
 *  mode's turn addendum, then the attachments — live parts for the model, marker string for the
 *  thread. The live message is a LOCAL: nothing that outlives this call refers to it. */
async function sendUserMessage(
  deps: { sessions: SessionStore; history: HistoryStore },
  text: string,
  attachments: Attachments | undefined,
  model: MockLanguageModelV4,
  controller = new AbortController(),
): Promise<{ done: Promise<void>; thread: () => ChatMessage[] }> {
  const parsed = attachments === undefined ? undefined : AttachmentsSchema.parse(attachments);
  const ensured = await deps.sessions.ensure(TAB_ID, PAGE_URL, SESSION_ID);
  const mode = resolveMode(undefined, text, ensured.lastMode);
  const guidance = modeGuidance(mode);
  const groundedText = groundUserText(text);
  const turnText = guidance.turnAddendum
    ? `${groundedText}\n\n${guidance.turnAddendum}`
    : groundedText;

  const liveUserMessage: ChatMessage = { role: 'user', content: toUserContent(turnText, parsed) };
  const storedContent = toStoredUserContent(turnText, parsed);
  const session = await deps.sessions.appendMessages(TAB_ID, {
    role: 'user',
    content: storedContent,
  });
  const threadForModel =
    storedContent === liveUserMessage.content
      ? session.messages
      : session.messages.map((m, i) => (i === session.messages.length - 1 ? liveUserMessage : m));

  const done = runTurn({
    tabId: TAB_ID,
    messages: threadForModel,
    signal: controller.signal,
    model,
    instructions: buildSystemPrompt(),
    dispatch: noopDispatch,
    emit: () => {},
  })
    .then(async (outcome) => {
      const compacted = compactForThread(outcome.responseMessages);
      if (compacted.length > 0) await deps.sessions.appendMessages(TAB_ID, ...compacted);
      // History gets the user's OWN words (`msg.text`), never the attachment payloads.
      await deps.history.appendTurn({
        id: SESSION_ID,
        title: text,
        url: PAGE_URL,
        messages: [{ role: 'user' as const, content: text }, ...compacted],
      });
    })
    .catch(() => {});

  return { done, thread: () => deps.sessions.get(TAB_ID)?.messages ?? [] };
}

/** Every user-role content part the provider saw, flattened. */
function userParts(prompt: LanguageModelV4Prompt): { type: string; mediaType?: string }[] {
  const out: { type: string; mediaType?: string }[] = [];
  for (const message of prompt) {
    if (message.role !== 'user') continue;
    for (const part of message.content) {
      out.push({ type: part.type, mediaType: 'mediaType' in part ? part.mediaType : undefined });
    }
  }
  return out;
}

function userText(prompt: LanguageModelV4Prompt): string {
  const texts: string[] = [];
  for (const message of prompt) {
    if (message.role !== 'user') continue;
    for (const part of message.content) if (part.type === 'text') texts.push(part.text);
  }
  return texts.join('\n');
}

describe('a turn with attached reference material', () => {
  let storage: StorageFake;
  let sessions: SessionStore;
  let history: HistoryStore;

  beforeEach(() => {
    storage = installStorageFakes();
    sessions = new SessionStore({ now: () => 1000 });
    history = new HistoryStore({ now: () => 1000 });
  });

  it('hands the image to the provider as a media part, alongside the instruction', async () => {
    const { model, prompts } = capturingModel();
    const { done } = await sendUserMessage(
      { sessions, history },
      'redesign the hero to match this',
      [MOCKUP],
      model,
    );
    await done;

    const prompt = prompts[0];
    if (!prompt) throw new Error('the model was never called');
    // The SDK lowers a user `image` part to a provider `file` part; either way it must NOT have
    // been flattened into text, and it must carry the media type we declared.
    const media = userParts(prompt).filter((p) => p.type !== 'text');
    expect(media).toHaveLength(1);
    expect(media[0]?.mediaType).toBe('image/png');

    const text = userText(prompt);
    expect(text).toContain('redesign the hero to match this');
    expect(text).toContain('hero-desktop.png');
    expect(text).toContain('1600×900');
    // The line that stops the model reading the mockup as the page's current state.
    expect(text).toContain('not screenshots of the current');
  });

  it('writes no image bytes to ANY chrome.storage area, and leaves a marker in the thread', async () => {
    const { model } = capturingModel();
    const { done, thread } = await sendUserMessage(
      { sessions, history },
      'match this mockup',
      [MOCKUP],
      model,
    );
    await done;

    // The whole point of one-shot: the bytes crossed no persistence boundary at all.
    expect(storageDump(storage)).not.toContain('data:image/');
    expect(storageDump(storage)).not.toContain(PNG.slice(30));

    const first = thread()[0];
    expect(typeof first?.content).toBe('string');
    expect(String(first?.content)).toContain('"hero-desktop.png" (1600×900)');
    expect(String(first?.content)).toContain('not viewable');
    // …and the SessionStore's in-memory cache holds the same byte-free message.
    expect(JSON.stringify(sessions.all())).not.toContain('data:image/');
  });

  it('keeps nothing after an ABORTED / superseded turn — the leak guard', async () => {
    const { model, release } = gatedModel();
    const controller = new AbortController();
    const { done, thread } = await sendUserMessage(
      { sessions, history },
      'match this mockup',
      [MOCKUP],
      model,
      controller,
    );

    // The turn is in flight, holding its own message array (image parts and all). Supersede it the
    // way background.ts does — abort the controller — then let the provider settle.
    controller.abort();
    release();
    await done;

    // Every structure that outlives a turn: storage (both areas), the session cache, history.
    expect(storageDump(storage)).not.toContain('data:image/');
    expect(JSON.stringify(sessions.all())).not.toContain('data:image/');
    expect(JSON.stringify(await history.list())).not.toContain('data:image/');
    // The only trace of the attachment anywhere is the marker text.
    expect(String(thread()[0]?.content)).toContain('hero-desktop.png');
    expect(JSON.stringify(thread())).not.toContain('base64');
  });

  it('sends no media part and persists the identical plain string when nothing is attached', async () => {
    const { model, prompts } = capturingModel();
    const { done, thread } = await sendUserMessage(
      { sessions, history },
      'make the CTA orange',
      undefined,
      model,
    );
    await done;

    const prompt = prompts[0];
    if (!prompt) throw new Error('the model was never called');
    expect(userParts(prompt).every((p) => p.type === 'text')).toBe(true);
    // Prompt-cache prefix guard at the wiring level: the persisted user message is still the very
    // same string, in-flight and persisted alike.
    expect(thread()[0]?.content).toBe('make the CTA orange');
  });

  it('inlines a big paste into the thread — text is kept, only images are one-shot', async () => {
    const { model } = capturingModel();
    const { done, thread } = await sendUserMessage(
      { sessions, history },
      'apply these tokens',
      [
        MOCKUP,
        { kind: 'text', id: 't1', name: 'tokens.css', text: '--brand: #f97316;', truncated: false },
      ],
      model,
    );
    await done;

    const persisted = String(thread()[0]?.content);
    expect(persisted).toContain('--brand: #f97316;');
    expect(persisted).toContain('"hero-desktop.png" (1600×900)');
    expect(storageDump(storage)).not.toContain('data:image/');
  });
});
