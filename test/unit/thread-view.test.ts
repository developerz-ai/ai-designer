import { describe, expect, it } from 'vitest';
import { conversationTabId } from '@/agent/conversation-tab';
import { FOCUS_CONTEXT_PREFIX, groundUserText } from '@/agent/focus-context';
import { modeGuidance, TURN_ADDENDUM_PREFIX } from '@/agent/modes';
import type { ChatMessage } from '@/agent/session';
import { toThreadView, userAsk } from '@/agent/thread-view';

// The SW-side thread view + conversation-tab resolution, both extracted from background.ts (which
// Vitest cannot import — WXT `#imports`). Two behaviours carry the weight here: WHICH conversation
// an out-of-band read answers for (the P0 blanked-transcript defect, `agent/conversation-tab.ts`),
// and rendering the user's OWN words rather than the scaffolding the SW added for the model.

describe('conversationTabId', () => {
  const sessions = new Set<number>();
  const has = (id: number): boolean => sessions.has(id);

  it('answers for the running turn tab when the user activates another tab mid-turn', () => {
    sessions.clear();
    sessions.add(7); // the turn's tab
    sessions.add(9); // another tab with its own conversation, currently active
    expect(conversationTabId([7, 9, 7], has)).toBe(7);
  });

  it('prefers the active tab own session when no turn runs', () => {
    sessions.clear();
    sessions.add(7);
    sessions.add(9);
    // No running turn (null leads); the active tab (9) has a session of its own.
    expect(conversationTabId([null, 9, 7], has)).toBe(9);
  });

  it('falls back to the last turn tab when the active tab has no session', () => {
    sessions.clear();
    sessions.add(7);
    // Active tab 42 is session-less (the agent just opened it): the last turn's tab answers.
    expect(conversationTabId([null, 42, 7], has)).toBe(7);
  });

  it('returns null when nothing matches', () => {
    sessions.clear();
    expect(conversationTabId([null, 42, undefined], has)).toBeNull();
    expect(conversationTabId([], has)).toBeNull();
  });
});

describe('userAsk — the user own words, scaffolding stripped', () => {
  const selector = { value: '.hero__cta', strategy: 'css-path' as const, fragile: false };

  it('renders the user own words, not the grounding line', () => {
    const grounded = groundUserText('make this 20% bigger', selector);
    expect(grounded.startsWith(FOCUS_CONTEXT_PREFIX)).toBe(true); // the fixture is honest
    expect(userAsk(grounded)).toBe('make this 20% bigger');
  });

  it('drops the mode addendum from the message tail', () => {
    const addendum = modeGuidance('debug').turnAddendum;
    expect(addendum?.startsWith(TURN_ADDENDUM_PREFIX)).toBe(true); // the fixture is honest
    const persisted = `fix the checkout\n\n${addendum}`;
    expect(userAsk(persisted)).toBe('fix the checkout');
  });

  it('strips both at once — a grounded, mode-stamped turn renders as the bare ask', () => {
    const addendum = modeGuidance('copy').turnAddendum;
    const persisted = `${groundUserText('copy this style', selector)}\n\n${addendum}`;
    expect(userAsk(persisted)).toBe('copy this style');
  });

  it('leaves a plain message byte-identical', () => {
    const plain = 'tighten the spacing under the hero';
    expect(userAsk(plain)).toBe(plain);
  });

  it('never strips assistant prose routed through toThreadView', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: `${FOCUS_CONTEXT_PREFIX}… I am quoting the grounding syntax on purpose.\nStill mine.`,
      },
    ];
    const view = toThreadView(messages);
    expect(view[1]?.text).toContain(FOCUS_CONTEXT_PREFIX);
    expect(view[1]?.text).toContain('Still mine.');
  });
});

describe('toThreadView renders what the user typed', () => {
  const selector = { value: '.hero__cta', strategy: 'css-path' as const, fragile: false };

  it('a persisted grounded + mode-stamped user message renders as the bare ask', () => {
    const addendum = modeGuidance('debug').turnAddendum;
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `${groundUserText('why is this broken', selector)}\n\n${addendum}`,
      },
      { role: 'assistant', content: 'Diagnosing.' },
    ];
    expect(toThreadView(messages)[0]).toEqual({ role: 'user', text: 'why is this broken' });
  });

  it('names the operation for a grouped tool call but never reads an MCP tool input', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'edit',
            input: { op: 'setStyle', selector: '.cta', intent: 'x' },
          },
          {
            type: 'tool-call',
            toolCallId: 't2',
            toolName: 'acme__task',
            // A third-party input with a stray `type` field used to relabel the chip "bug".
            input: { type: 'bug', title: 'broken checkout' },
          },
        ],
      },
    ];
    const view = toThreadView(messages);
    expect(view[1]?.tools).toEqual([
      { name: 'setStyle', ok: true },
      { name: 'acme__task', ok: true },
    ]);
  });
});
