import type {
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationTabId } from '@/agent/conversation-tab';
import { HistoryStore } from '@/agent/history-store';
import { runTurn } from '@/agent/loop';
import { modeGuidance, resolveMode } from '@/agent/modes';
import { cachedSystemPrompt, withCacheBreakpoint } from '@/agent/prompt-cache';
import { type ChatMessage, SessionStore } from '@/agent/session';
import { buildSystemPrompt } from '@/agent/system-prompt';
import { compactForThread } from '@/agent/thread-compact';
import { toThreadView } from '@/agent/thread-view';
import type { DomDispatch } from '@/agent/tools/dom';
import { logEntryFor, renderTurnLog } from '@/agent/turn-log';
import type { SwToPanel } from '@/shared/messages';

// Integration (#168 cross-turn amnesia): the conversation-memory wiring background.ts's
// `user-message` handler drives — persist the REAL turn (`compactForThread(outcome.
// responseMessages)`, tool calls + results included) on every completion path, order the thread
// across a supersede/stop by AWAITING the old turn's finalization before appending the new user
// message, stamp `turnId` on every per-turn stream event, and render the thread down to
// `ThreadViewMessage`s for `thread-get`. background.ts itself can't be imported under Vitest (it
// pulls the WXT `#imports` virtual module), so `sendUserMessage`/`stampTurnId` below mirror its
// wiring 1:1 against the REAL cooperating modules (`agent/loop.ts` runTurn,
// `agent/thread-compact.ts`, `agent/session.ts`, `agent/history-store.ts`,
// `agent/thread-view.ts` — the view mapping is the REAL export now, no longer a mirror) — the
// same approach as history-flow.test.ts and agent-loop.test.ts.

// Named PAGE_URL, not URL: a bare `URL` constant would shadow the global URL constructor the
// `isOpenRouterBase` mirror parses baseURLs with (it silently disabled the cache gating).
const PAGE_URL = 'https://example.com/pricing';
const SESSION_ID = '00000000-0000-0000-0000-0000000000aa';
const TAB_ID = 7;

// --- storage fakes -------------------------------------------------------------------------------

function installStorageFakes(): void {
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
    storage: { local: api(new Map()), session: api(new Map()) },
  };
}

// --- model builders (v4 mock vocabulary, as in agent-loop.test.ts) -------------------------------

function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream(parts),
});

const finish = (
  u: LanguageModelV4Usage,
  unified: 'stop' | 'tool-calls',
): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: u,
  finishReason: { unified, raw: unified },
});

const textParts = (id: string, text: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: text },
  { type: 'text-end', id },
];

/** Step 1: narrate + call setStyle; step 2: wrap up — the minimal agentic turn with tool activity. */
function toolTurnModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        ...textParts('1', 'Recoloring the CTA. '),
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'edit',
          input: JSON.stringify({
            op: 'setStyle',
            intent: 'Test intent',
            selector: '#cta',
            props: { 'background-color': '#f97316' },
          }),
        },
        finish(usage(500, 100), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        ...textParts('2', 'Done — the CTA now pops.'),
        finish(usage(600, 40), 'stop'),
      ]),
    ],
  });
}

function textOnlyModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        ...textParts('1', text),
        finish(usage(200, 40), 'stop'),
      ]),
    ],
  });
}

/** A turn whose SECOND model call blocks until `release()` — keeps the turn verifiably in flight
 *  (step 1's tool activity already accumulated) while a supersede/stop happens. */
function gatedSecondStepModel(): { model: MockLanguageModelV4; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        return stream([
          { type: 'stream-start', warnings: [] },
          ...textParts('1', 'Working on it. '),
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'edit',
            input: JSON.stringify({
              op: 'setStyle',
              intent: 'Test intent',
              selector: '#cta',
              props: { color: 'red' },
            }),
          },
          finish(usage(100, 20), 'tool-calls'),
        ]);
      }
      await gate;
      return stream([
        { type: 'stream-start', warnings: [] },
        ...textParts('2', 'Finished.'),
        finish(usage(100, 10), 'stop'),
      ]);
    },
  });
  return { model, release };
}

/** Fake content script: settle every DOM tool with `okByCall[n]` (default ok). */
function fakeContent(okByCall: boolean[] = []) {
  let call = 0;
  const dispatch: DomDispatch = async () => {
    const ok = okByCall[call] ?? true;
    call += 1;
    return ok
      ? { type: 'tool-result', ok: true, data: { applied: true } }
      : { type: 'tool-result', ok: false, error: 'no element matches the selector' };
  };
  return { dispatch };
}

// --- background.ts user-message wiring, mirrored 1:1 ---------------------------------------------

/** Mirrors background.ts `stampTurnId`: the five per-turn stream events carry the turn's id. */
function stampTurnId(update: SwToPanel, turnId: string): SwToPanel {
  switch (update.type) {
    case 'token':
    case 'tool-call':
    case 'tool-result':
    case 'error':
    case 'turn-done':
      return { ...update, turnId };
    default:
      return update;
  }
}

const SUPERSEDE_SETTLE_MS = 3_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The SW's module-level turn state, as background.ts holds it. */
interface SwMirror {
  sessions: SessionStore;
  history: HistoryStore;
  turnAbort: AbortController | null;
  settlingTurn: { id: string; done: Promise<void> } | null;
  forfeited: Set<string>;
}

function newSw(): SwMirror {
  return {
    sessions: new SessionStore({ now: () => 1000 }),
    history: new HistoryStore({ now: () => 1000 }),
    turnAbort: null,
    settlingTurn: null,
    forfeited: new Set(),
  };
}

/** Mirrors background.ts `session-stop`: abort the turn but leave `settlingTurn` registered so the
 *  next send still awaits its finalization. */
function sessionStop(sw: SwMirror): void {
  sw.turnAbort?.abort();
  sw.turnAbort = null;
}

/** Mirrors background.ts `isOpenRouterBase`: `cache_control` annotations are OpenRouter-only. */
function isOpenRouterBase(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

/** Mirrors background.ts `annotatePriorThreadTail`: the breakpoint sits on the last message of
 *  the PRIOR thread; the just-appended user message grows past it. */
function annotatePriorThreadTail(messages: readonly ChatMessage[]): ChatMessage[] {
  if (messages.length < 2) return [...messages];
  const tail = messages.length - 2;
  return messages.map((m, i) => (i === tail ? withCacheBreakpoint(m) : m));
}

/** A non-OpenRouter default: a strict OpenAI-compatible endpoint that must see NO annotations. */
const STRICT_BASE_URL = 'http://localhost:11434/v1';

/** Mirrors the `user-message` handler's new spine: supersede + bounded settlement wait BEFORE the
 *  user append; sticky mode resolution whose `turnAddendum` rides the user message (never the
 *  byte-stable system prompt); OpenRouter-gated cache breakpoints; then run the turn and persist
 *  `compactForThread(outcome.responseMessages)` (thread AND history) on every completion path
 *  unless the turn was forfeited. */
async function sendUserMessage(
  sw: SwMirror,
  text: string,
  model: LanguageModelV4,
  opts: { dispatch?: DomDispatch; emit?: (event: SwToPanel) => void; baseURL?: string } = {},
): Promise<{ turnId: string; done: Promise<void> }> {
  const emit = opts.emit ?? ((): void => {});
  const turnId = crypto.randomUUID();
  const prior = sw.settlingTurn;
  sw.turnAbort?.abort();
  const controller = new AbortController();
  sw.turnAbort = controller;
  if (prior) {
    const settledInTime = await Promise.race([
      prior.done.then(() => true),
      delay(SUPERSEDE_SETTLE_MS).then(() => false),
    ]);
    if (!settledInTime) sw.forfeited.add(prior.id);
  }
  const ensured = await sw.sessions.ensure(TAB_ID, PAGE_URL, SESSION_ID);
  const mode = resolveMode(undefined, text, ensured.lastMode);
  const guidance = modeGuidance(mode);
  const turnText = guidance.turnAddendum ? `${text}\n\n${guidance.turnAddendum}` : text;
  const session = await sw.sessions.appendMessages(TAB_ID, { role: 'user', content: turnText });
  await sw.sessions.patch(TAB_ID, { status: 'running', lastMode: mode });
  const cacheable = isOpenRouterBase(opts.baseURL ?? STRICT_BASE_URL);
  const systemPrompt = buildSystemPrompt();
  // Mirrors background.ts's split fan-out: the wire gets the turnId-stamped event, the
  // conversation's debug log gets the same event's spine entry (fire-and-forget, like the SW).
  const logTurnEvent = (update: SwToPanel): void => {
    const entry = logEntryFor(update, Date.now());
    if (entry) void sw.sessions.appendLog(TAB_ID, entry).catch(() => {});
  };
  const emitTurn = (update: SwToPanel): void => {
    emit(stampTurnId(update, turnId));
    logTurnEvent(update);
  };
  const done = runTurn({
    tabId: TAB_ID,
    messages: cacheable ? annotatePriorThreadTail(session.messages) : session.messages,
    signal: controller.signal,
    model,
    instructions: cacheable ? cachedSystemPrompt(systemPrompt) : systemPrompt,
    dispatch: opts.dispatch ?? fakeContent().dispatch,
    emit: emitTurn,
  })
    .then(async (outcome) => {
      if (sw.forfeited.has(turnId)) return;
      const compacted = compactForThread(outcome.responseMessages);
      if (compacted.length > 0) await sw.sessions.appendMessages(TAB_ID, ...compacted);
      await sw.history.appendTurn({
        id: SESSION_ID,
        title: text,
        url: PAGE_URL,
        messages: [{ role: 'user' as const, content: text }, ...compacted],
      });
    })
    .finally(() => {
      const wasCurrent = sw.turnAbort === controller;
      if (wasCurrent) sw.turnAbort = null;
      if (sw.settlingTurn?.id === turnId) sw.settlingTurn = null;
      sw.forfeited.delete(turnId);
      // Through emitTurn (as in background.ts): stamped on the wire AND logged as the boundary.
      if (wasCurrent) emitTurn({ type: 'turn-done', usage: { steps: 2, tokens: 640 } });
    });
  sw.settlingTurn = { id: turnId, done };
  return { turnId, done };
}

// --- assertions helpers --------------------------------------------------------------------------

/** Index of the user message that STARTS with `text` — the mode's `turnAddendum` may follow it. */
function userIndex(messages: readonly ChatMessage[], text: string): number {
  return messages.findIndex(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(text),
  );
}

function roles(messages: readonly ChatMessage[]): string[] {
  return messages.map((m) => m.role);
}

function hasAdjacentUsers(messages: readonly ChatMessage[]): boolean {
  return messages.some((m, i) => m.role === 'user' && messages[i + 1]?.role === 'user');
}

beforeEach(() => {
  installStorageFakes();
});

// --- the headline regression: turn 2 must SEE turn 1's tool activity -----------------------------

describe('two-turn memory: the second turn is grounded in the first turn REAL messages', () => {
  it('persists tool calls + results to the session thread, and turn 2 model input contains them', async () => {
    const sw = newSw();

    // Turn 1: narrate -> setStyle -> summarize. Pre-fix, only the flat summary text was threaded.
    const { done } = await sendUserMessage(sw, 'make the CTA orange', toolTurnModel());
    await done;

    const thread = sw.sessions.get(TAB_ID)?.messages ?? [];
    // The thread holds the REAL turn: a tool-role message (the setStyle result) and an assistant
    // message carrying the tool-call part — not just [user, assistant-prose].
    expect(roles(thread)).toContain('tool');
    const assistantToolCalls = thread
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
      .filter((p) => p.type === 'tool-call');
    // The persisted call names the RESOURCE (that is what the model invoked); the operation
    // rides its input, which is what the panel's chips and the overlay both read.
    expect(assistantToolCalls.map((p) => p.toolName)).toContain('edit');
    expect(JSON.stringify(assistantToolCalls)).toContain('"op":"setStyle"');

    // Turn 2: what the MODEL actually receives must include turn 1's tool-call AND its result —
    // this is the assertion that fails pre-fix (the model saw only prose, re-ran every tool, and
    // tripled the spend: #168, measured 31.8k -> 97.1k tokens).
    const model2 = textOnlyModel('Also tightened the spacing.');
    const turn2 = await sendUserMessage(sw, 'now tighten the spacing', model2);
    await turn2.done;

    const prompt = model2.doStreamCalls[0]?.prompt as LanguageModelV4Prompt | undefined;
    expect(prompt).toBeDefined();
    if (!prompt) throw new Error('unreachable');
    const promptToolCalls = prompt
      .flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === 'tool-call');
    expect(promptToolCalls.map((p) => p.toolName)).toContain('edit');
    expect(JSON.stringify(promptToolCalls)).toContain('"op":"setStyle"');
    const promptToolResults = prompt
      .flatMap((m) => (m.role === 'tool' ? m.content : []))
      .filter((p) => p.type === 'tool-result');
    expect(promptToolResults.map((p) => p.toolName)).toContain('edit');
  });

  it('history receives the same tool-bearing messages, so replay keeps the tool activity', async () => {
    const sw = newSw();
    const { done } = await sendUserMessage(sw, 'make the CTA orange', toolTurnModel());
    await done;

    const conversation = sw.history.get(SESSION_ID);
    expect(conversation).toBeDefined();
    // The history thread keeps whole tool units (history-store's toolUnits pairing — dead code
    // when only flat text was appended): an assistant message with the call and the tool message
    // with its result both survive size-bounding + re-validation.
    expect(conversation?.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(
      conversation?.messages.some(
        (m) =>
          m.role === 'assistant' &&
          typeof m.content !== 'string' &&
          m.content.some((p) => p.type === 'tool-call'),
      ),
    ).toBe(true);
  });
});

// --- supersede / stop ordering -------------------------------------------------------------------

describe('supersede mid-turn: the thread stays [user1, assistant1(partial), user2]', () => {
  it('awaits the aborted turn finalization, so the partial lands BEFORE the new user message', async () => {
    const sw = newSw();
    const gated = gatedSecondStepModel();

    // Turn 1 launches; step 1 (tool call) completes; step 2 blocks on the gate.
    await sendUserMessage(sw, 'restyle the hero', gated.model);
    await vi.waitFor(() => expect(gated.model.doStreamCalls.length).toBe(2));

    // A newer instruction supersedes: it aborts turn 1 and AWAITS its settlement before appending
    // its own user message. Release the gate while it waits.
    const secondSend = sendUserMessage(sw, 'actually make it blue', textOnlyModel('Blue it is.'));
    gated.release();
    const turn2 = await secondSend;
    await turn2.done;

    const thread = sw.sessions.get(TAB_ID)?.messages ?? [];
    const user1 = userIndex(thread, 'restyle the hero');
    const user2 = userIndex(thread, 'actually make it blue');
    expect(user1).toBe(0);
    expect(user2).toBeGreaterThan(user1 + 1); // something of turn 1 persisted in between
    // The in-between content is turn 1's REAL partial: its assistant message (with the tool call).
    const between = thread.slice(user1 + 1, user2);
    expect(between.some((m) => m.role === 'assistant')).toBe(true);
    expect(hasAdjacentUsers(thread)).toBe(false);
  });
});

describe('stop then send: no [user, user] adjacency in the resumed thread', () => {
  it('persists the stopped turn partial before the next user message', async () => {
    const sw = newSw();
    const gated = gatedSecondStepModel();

    await sendUserMessage(sw, 'debug the layout', gated.model);
    await vi.waitFor(() => expect(gated.model.doStreamCalls.length).toBe(2));

    // User hits Stop (background.ts `session-stop`): abort + clear turnAbort, but the turn's
    // finalization is still registered — the next send must wait for it.
    sessionStop(sw);

    const secondSend = sendUserMessage(sw, 'try the footer instead', textOnlyModel('On it.'));
    gated.release();
    const turn2 = await secondSend;
    await turn2.done;

    const thread = sw.sessions.get(TAB_ID)?.messages ?? [];
    expect(hasAdjacentUsers(thread)).toBe(false);
    const user2 = userIndex(thread, 'try the footer instead');
    expect(user2).toBeGreaterThan(1); // the stopped turn's partial precedes it
    expect(thread.slice(1, user2).some((m) => m.role === 'assistant')).toBe(true);
  });
});

// --- turn attribution ----------------------------------------------------------------------------

describe('turnId attribution on the stream', () => {
  it('stamps every token/tool-call/tool-result/turn-done with the turn id the ack returned', async () => {
    const sw = newSw();
    const events: SwToPanel[] = [];
    const { turnId, done } = await sendUserMessage(sw, 'make the CTA orange', toolTurnModel(), {
      emit: (event) => events.push(event),
    });
    await done;

    const turnEvents = events.filter(
      (e) =>
        e.type === 'token' ||
        e.type === 'tool-call' ||
        e.type === 'tool-result' ||
        e.type === 'error' ||
        e.type === 'turn-done',
    );
    expect(turnEvents.length).toBeGreaterThan(0);
    for (const event of turnEvents) {
      expect(event).toMatchObject({ turnId });
    }
    expect(events.some((e) => e.type === 'turn-done')).toBe(true);
  });
});

// --- thread-get view -----------------------------------------------------------------------------

describe('thread-get: the persisted thread renders down to text + per-tool outcomes', () => {
  it('maps a real turn to user/assistant view messages with settled tool chips', async () => {
    const sw = newSw();
    const { done } = await sendUserMessage(sw, 'make the CTA orange', toolTurnModel());
    await done;

    const view = toThreadView(sw.sessions.get(TAB_ID)?.messages ?? []);
    expect(view[0]).toEqual({ role: 'user', text: 'make the CTA orange' });
    const assistant = view[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.text).toContain('Recoloring the CTA');
    expect(assistant?.text).toContain('Done — the CTA now pops');
    expect(assistant?.tools).toEqual([{ name: 'setStyle', ok: true }]);
    // Never raw provider parts: the view is exactly the ThreadViewMessage vocabulary.
    expect(view).toHaveLength(2);
  });

  it('distills a FAILED tool result to ok: false on the chip', async () => {
    const sw = newSw();
    // The single setStyle call fails in the fake content script (ok: false ToolResult).
    const { done } = await sendUserMessage(sw, 'make the CTA orange', toolTurnModel(), {
      dispatch: fakeContent([false]).dispatch,
    });
    await done;

    const view = toThreadView(sw.sessions.get(TAB_ID)?.messages ?? []);
    const assistant = view.find((m) => m.role === 'assistant');
    expect(assistant?.tools).toEqual([{ name: 'setStyle', ok: false }]);
  });
});

// --- thread-get answers for the CONVERSATION, not the active tab (P0) ----------------------------

describe('thread-get survives a mid-turn tab activation', () => {
  /** Mirrors background.ts's thread-get tab resolution (the conversationTabId call is the REAL
   *  export; only the chrome tab plumbing is mirrored). */
  function resolveThreadTab(
    sw: SwMirror,
    ids: { running: number | null; active: number | null; lastTurn: number | null },
  ): number | null {
    const has = (id: number) => sw.sessions.get(id) !== undefined;
    return conversationTabId([ids.running, ids.active, ids.lastTurn], has) ?? ids.active;
  }

  it('a turn on tab A keeps answering for A while tab B is active, and reports turnRunning', async () => {
    const sw = newSw();
    const gated = gatedSecondStepModel();

    // Turn runs on TAB_ID; the agent (or the user) activates another, session-less tab mid-turn.
    await sendUserMessage(sw, 'restyle the hero', gated.model);
    await vi.waitFor(() => expect(gated.model.doStreamCalls.length).toBe(2));
    const NEW_TAB = 99; // opened by tabs(op:'open', active:true) — no session

    const tabId = resolveThreadTab(sw, { running: TAB_ID, active: NEW_TAB, lastTurn: TAB_ID });
    expect(tabId).toBe(TAB_ID);
    // The pre-fix resolution (active tab, unconditionally) answered for the session-less tab:
    expect(sw.sessions.get(NEW_TAB)).toBeUndefined();

    // The thread the panel re-hydrates from is still tab A's conversation, mid-turn…
    const view = toThreadView(sw.sessions.get(tabId as number)?.messages ?? []);
    expect(view[0]).toEqual({ role: 'user', text: 'restyle the hero' });
    // …and session-get would still report the turn as running (turnAbort is live).
    expect(sw.turnAbort).not.toBeNull();

    gated.release();
    await sw.settlingTurn?.done;
  });

  it('between turns, the active tab own session wins; a session-less active tab falls back to the last turn', async () => {
    const sw = newSw();
    await (await sendUserMessage(sw, 'make the CTA orange', textOnlyModel('Done.'))).done;

    const has = (id: number) => sw.sessions.get(id) !== undefined;
    // No running turn, active tab HAS a session (it is the conversation).
    expect(conversationTabId([null, TAB_ID, null], has)).toBe(TAB_ID);
    // No running turn, active tab has NO session — the last turn's tab still answers.
    expect(conversationTabId([null, 42, TAB_ID], has)).toBe(TAB_ID);
    // Nothing matches: null, so the caller reports "no session yet" for the active tab.
    expect(conversationTabId([null, 42, null], has)).toBeNull();
  });
});

// --- the debug log gets the turn boundary + spend (P1) --------------------------------------------

describe('the turn boundary reaches the conversation debug log', () => {
  it('renders "turn ended" with the spend after a completed turn', async () => {
    const sw = newSw();
    const { done } = await sendUserMessage(sw, 'make the CTA orange', toolTurnModel());
    await done;

    // appendLog is fire-and-forget in the fan-out (as in the SW) — wait for it to land.
    await vi.waitFor(() => {
      const log = sw.sessions.get(TAB_ID)?.log ?? [];
      expect(log.some((entry) => entry.kind === 'turn')).toBe(true);
    });

    const markdown = renderTurnLog(
      {
        version: '0.0.0-test',
        model: 'test/model',
        providerHost: 'http://localhost',
        pageUrl: PAGE_URL,
        tabId: TAB_ID,
      },
      sw.sessions.get(TAB_ID)?.log ?? [],
    );
    expect(markdown).toMatch(/turn ended — \d+ steps, \d+ tokens/);
  });
});

// --- mode guidance placement (#168, prompt-cache stability) --------------------------------------

describe('mode guidance rides the user message, never the system prompt', () => {
  const DEBUG_MARKER = 'This turn is a debug task';

  it('appends the debug turnAddendum to the outgoing user message; the system prompt stays clean', async () => {
    const sw = newSw();
    const model = textOnlyModel('Diagnosing.');
    const { done } = await sendUserMessage(sw, 'debug the checkout flow', model);
    await done;

    // The addendum is part of the PERSISTED user message (the next turn rebuilds the model input
    // from the thread — a divergence would break the cached prefix).
    const user = sw.sessions.get(TAB_ID)?.messages[0];
    expect(user?.role).toBe('user');
    expect(user?.content).toContain(DEBUG_MARKER);

    // …and it reached the MODEL on the user message, while the system prompt stayed byte-stable
    // (`ModeGuidance.addenda` is always empty now; injecting there would bust the prefix cache).
    const prompt = model.doStreamCalls[0]?.prompt as LanguageModelV4Prompt | undefined;
    expect(prompt).toBeDefined();
    if (!prompt) throw new Error('unreachable');
    const system = prompt.find((m) => m.role === 'system');
    expect(JSON.stringify(system)).not.toContain(DEBUG_MARKER);
    const promptUser = prompt.find((m) => m.role === 'user');
    expect(JSON.stringify(promptUser)).toContain(DEBUG_MARKER);

    // E: the resolved mode persisted back for the next turn's sticky inference.
    expect(sw.sessions.get(TAB_ID)?.lastMode).toBe('debug');
  });

  it('a neutral follow-up inherits the session lastMode and still carries the addendum', async () => {
    const sw = newSw();
    await (await sendUserMessage(sw, 'debug the checkout flow', textOnlyModel('Found it.'))).done;
    const { done } = await sendUserMessage(sw, 'now the header too', textOnlyModel('Fixed.'));
    await done;

    const thread = sw.sessions.get(TAB_ID)?.messages ?? [];
    const followUp = thread.filter((m) => m.role === 'user').at(-1);
    expect(followUp?.content).toContain('now the header too');
    expect(followUp?.content).toContain(DEBUG_MARKER); // sticky: still a debug turn
    expect(sw.sessions.get(TAB_ID)?.lastMode).toBe('debug');
  });
});

// --- prompt-cache gating (#168): cache_control iff the endpoint is OpenRouter --------------------

describe('prompt-cache breakpoints are OpenRouter-gated', () => {
  const OPENROUTER = 'https://openrouter.ai/api/v1';

  it('annotates the system prompt and the prior-thread tail for an OpenRouter endpoint', async () => {
    const sw = newSw();
    await (
      await sendUserMessage(sw, 'make the CTA orange', toolTurnModel(), { baseURL: OPENROUTER })
    ).done;
    const model2 = textOnlyModel('Tightened.');
    await (await sendUserMessage(sw, 'now tighten the spacing', model2, { baseURL: OPENROUTER }))
      .done;

    const prompt = model2.doStreamCalls[0]?.prompt as LanguageModelV4Prompt | undefined;
    expect(prompt).toBeDefined();
    if (!prompt) throw new Error('unreachable');

    // Breakpoint 1: on the byte-stable system prompt (`cachedSystemPrompt`).
    const system = prompt.find((m) => m.role === 'system');
    expect(JSON.stringify(system)).toContain('cache_control');

    // Breakpoint 2: on the LAST message of the PRIOR thread — the new user message (the prompt's
    // last message) grows past it unannotated, so it never invalidates the cached prefix.
    const last = prompt.at(-1);
    expect(last?.role).toBe('user');
    expect(JSON.stringify(last)).not.toContain('cache_control');
    const priorTail = prompt.at(-2);
    expect(JSON.stringify(priorTail)).toContain('cache_control');
  });

  it('sends NO cache annotations to a strict OpenAI-compatible endpoint', async () => {
    const sw = newSw();
    await (await sendUserMessage(sw, 'make the CTA orange', toolTurnModel())).done;
    const model2 = textOnlyModel('Tightened.');
    await (await sendUserMessage(sw, 'now tighten the spacing', model2)).done;

    // Default baseURL is the strict endpoint: the whole serialized prompt — system message
    // included — must carry no cache_control field the endpoint could reject.
    const prompt = model2.doStreamCalls[0]?.prompt as LanguageModelV4Prompt | undefined;
    expect(prompt).toBeDefined();
    expect(JSON.stringify(prompt)).not.toContain('cache_control');
  });
});
