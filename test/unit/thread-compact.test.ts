import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/agent/session';
import {
  compactForThread,
  compactSessionThread,
  HIGH_WATER_APPROX_TOKENS,
  IMAGE_OMITTED_PLACEHOLDER,
  IMAGE_PRUNED_PLACEHOLDER,
  KEEP_NEWEST_IMAGE_SETS,
  pruneInFlightImages,
  SESSION_MEMORY_MARKER,
  TOOL_TEXT_CAP,
} from '@/agent/thread-compact';

// thread-compact.ts unit: the pure conversation-memory policies (#168). compactForThread keeps
// tool activity structurally intact while stripping images / truncating oversized text;
// pruneInFlightImages ages screenshots out of the in-flight transcript exactly once (prefix-cache
// stability); compactSessionThread digests the oldest turns past the high-water mark. Everything
// must round-trip `modelMessageSchema` so `session.ts` re-validates it on rehydrate.

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA'.repeat(40);

const screenshotResult = (id: string): ChatMessage => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: id,
      toolName: 'screenshot',
      output: {
        type: 'content',
        value: [
          { type: 'text', text: 'Screenshot of the current result.' },
          { type: 'file', data: { type: 'data', data: PNG }, mediaType: 'image/png' },
        ],
      },
    },
  ],
});

const toolCall = (id: string, toolName: string, input: unknown): ChatMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName, input }],
});

const textResult = (id: string, toolName: string, value: string): ChatMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }],
});

const roundTrips = (messages: readonly ChatMessage[]): void => {
  for (const message of messages) {
    const parsed = modelMessageSchema.safeParse(message);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
  }
};

describe('compactForThread', () => {
  it('keeps assistant tool-call parts and tool results structurally intact', () => {
    const thread: ChatMessage[] = [
      { role: 'user', content: 'make the CTA orange' },
      toolCall('t1', 'setStyle', { selector: '#cta', props: { color: 'orange' } }),
      textResult('t1', 'setStyle', '{"ok":true}'),
      { role: 'assistant', content: 'Done.' },
    ];
    const compacted = compactForThread(thread);
    expect(compacted).toEqual(thread); // nothing oversized, nothing visual — byte-identical
    roundTrips(compacted);
  });

  it('replaces image payloads with the placeholder but keeps the tool-result envelope', () => {
    const compacted = compactForThread([toolCall('t1', 'screenshot', {}), screenshotResult('t1')]);
    const tool = compacted[1];
    if (tool?.role !== 'tool') throw new Error('expected tool message');
    const part = tool.content[0];
    if (part?.type !== 'tool-result') throw new Error('expected tool-result');
    expect(part.toolCallId).toBe('t1');
    expect(part.toolName).toBe('screenshot');
    if (part.output.type !== 'content') throw new Error('expected content output');
    expect(part.output.value).toEqual([
      { type: 'text', text: 'Screenshot of the current result.' },
      { type: 'text', text: IMAGE_OMITTED_PLACEHOLDER },
    ]);
    expect(JSON.stringify(compacted)).not.toContain(PNG);
    roundTrips(compacted);
  });

  it('truncates oversized text tool outputs with a marker', () => {
    const long = 'x'.repeat(TOOL_TEXT_CAP + 500);
    const compacted = compactForThread([textResult('t1', 'describe', long)]);
    const part = compacted[0]?.role === 'tool' ? compacted[0].content[0] : undefined;
    if (part?.type !== 'tool-result' || part.output.type !== 'text') throw new Error('shape');
    expect(part.output.value.length).toBeLessThan(long.length);
    expect(part.output.value).toContain('[truncated 500 chars]');
    roundTrips(compacted);
  });

  it('strips user-attached images and drops reasoning-only assistant messages', () => {
    const compacted = compactForThread([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'match this mock' },
          { type: 'image', image: PNG, mediaType: 'image/png' },
        ],
      },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking…' }] },
    ]);
    expect(compacted).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'match this mock' },
          { type: 'text', text: IMAGE_OMITTED_PLACEHOLDER },
        ],
      },
    ]);
    roundTrips(compacted);
  });

  it('does not mutate its input', () => {
    const original = screenshotResult('t1');
    const snapshot = JSON.parse(JSON.stringify(original));
    compactForThread([original]);
    expect(original).toEqual(snapshot);
  });
});

describe('pruneInFlightImages', () => {
  const transcript = (shots: number): ChatMessage[] => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'polish the hero' }];
    for (let i = 0; i < shots; i++) {
      messages.push(toolCall(`s${i}`, 'screenshot', {}), screenshotResult(`s${i}`));
    }
    return messages;
  };

  // Count whole payloads (PNG is internally repetitive, so a prefix match would over-count).
  const imageCount = (messages: ChatMessage[]): number =>
    JSON.stringify(messages).split(PNG).length - 1;

  it('returns the input array unchanged (same reference) when within the keep window', () => {
    const messages = transcript(KEEP_NEWEST_IMAGE_SETS);
    expect(pruneInFlightImages(messages)).toBe(messages);
  });

  it('replaces only the aged-out screenshots, keeping the newest sets intact', () => {
    const messages = transcript(4);
    const pruned = pruneInFlightImages(messages);
    expect(imageCount(pruned)).toBe(KEEP_NEWEST_IMAGE_SETS);
    expect(JSON.stringify(pruned)).toContain(IMAGE_PRUNED_PLACEHOLDER);
    // The newest screenshot messages are untouched — same references (prefix-cache stability
    // depends on unchanged messages staying identical).
    expect(pruned.at(-1)).toBe(messages.at(-1));
    roundTrips(pruned);
  });

  it('is stable: pruning an already-pruned transcript with one new image rewrites only the newly aged-out set', () => {
    const first = pruneInFlightImages(transcript(4));
    const grown = [...first, toolCall('s9', 'screenshot', {}), screenshotResult('s9')];
    const second = pruneInFlightImages(grown);
    // Transcript layout: [user, call s0, shot s0(idx2), call s1, shot s1(idx4), call s2,
    // shot s2(idx6), call s3, shot s3(idx8), call s9, shot s9(idx10)]. Pass 1 pruned idx 2+4;
    // pass 2 must rewrite ONLY the newly aged-out idx6 — everything else carries over by
    // reference (that identity is what keeps the prompt-cache prefix stable).
    for (const i of [0, 1, 2, 3, 4, 5, 7, 8, 9, 10]) {
      expect(second[i]).toBe(grown[i]);
    }
    expect(second[6]).not.toBe(grown[6]);
    expect(imageCount(second)).toBe(KEEP_NEWEST_IMAGE_SETS);
  });

  it('treats a multi-image responsiveCapture result as ONE set — never splits a sweep', () => {
    const sweep: ChatMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'r1',
          toolName: 'responsiveCapture',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'mobile (375×667)' },
              { type: 'file', data: { type: 'data', data: PNG }, mediaType: 'image/png' },
              { type: 'text', text: 'desktop (1440×900)' },
              { type: 'file', data: { type: 'data', data: PNG }, mediaType: 'image/png' },
            ],
          },
        },
      ],
    };
    const messages: ChatMessage[] = [
      toolCall('r1', 'responsiveCapture', {}),
      sweep,
      toolCall('s1', 'screenshot', {}),
      screenshotResult('s1'),
    ];
    // Two sets total (sweep + single shot) = within the window: both survive whole.
    expect(pruneInFlightImages(messages)).toBe(messages);
  });
});

describe('compactSessionThread', () => {
  const turn = (ask: string, tool: string, payload: string): ChatMessage[] => [
    { role: 'user', content: ask },
    toolCall(`c-${ask}`, tool, { selector: '#x' }),
    textResult(`c-${ask}`, tool, payload),
    { role: 'assistant', content: `did: ${ask}` },
  ];

  it('leaves a thread under the high-water mark untouched (append-only fast path)', () => {
    const thread = [...turn('one', 'setStyle', 'ok'), ...turn('two', 'query', 'ok')];
    const result = compactSessionThread(thread);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(thread);
  });

  it('past the high-water mark, digests the oldest turns and keeps the newest verbatim', () => {
    const payload = 'y'.repeat(3_000);
    const thread: ChatMessage[] = [];
    // Enough turns to comfortably exceed HIGH_WATER_APPROX_TOKENS * 4 chars.
    const turns = Math.ceil((HIGH_WATER_APPROX_TOKENS * 4) / 3_000) + 4;
    for (let i = 0; i < turns; i++) thread.push(...turn(`ask number ${i}`, 'describe', payload));

    const result = compactSessionThread(thread);
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThan(thread.length);

    const [digest, ...tail] = result.messages;
    if (digest?.role !== 'user' || typeof digest.content !== 'string') throw new Error('shape');
    expect(digest.content.startsWith(SESSION_MEMORY_MARKER)).toBe(true);
    expect(digest.content).toContain('user asked: "ask number 0');
    expect(digest.content).toMatch(/describe×\d+/);

    // The tail starts at a turn boundary and is verbatim — the last turn survives whole.
    expect(tail[0]?.role).toBe('user');
    expect(tail.slice(-4)).toEqual(thread.slice(-4));
    roundTrips(result.messages);
  });

  it('is deterministic and folds a previous digest instead of stacking markers', () => {
    const payload = 'z'.repeat(3_000);
    const thread: ChatMessage[] = [];
    const turns = Math.ceil((HIGH_WATER_APPROX_TOKENS * 4) / 3_000) + 4;
    for (let i = 0; i < turns; i++) thread.push(...turn(`step ${i}`, 'getStyles', payload));

    const once = compactSessionThread(thread);
    const twice = compactSessionThread(thread);
    expect(once).toEqual(twice); // deterministic

    // Grow the compacted thread past the mark again: the old digest folds into the new one.
    const regrown = [...once.messages];
    for (let i = 0; i < turns; i++) regrown.push(...turn(`later ${i}`, 'setText', payload));
    const again = compactSessionThread(regrown);
    expect(again.compacted).toBe(true);
    const markers = again.messages.filter(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.startsWith(SESSION_MEMORY_MARKER),
    );
    expect(markers).toHaveLength(1);
  });

  it('never digests the most recent turn, even when it alone exceeds the tail budget', () => {
    const huge = 'w'.repeat(HIGH_WATER_APPROX_TOKENS * 4 + 10_000);
    const thread = [...turn('small ask', 'query', 'ok'), ...turn('huge ask', 'describe', huge)];
    const result = compactSessionThread(thread);
    expect(result.compacted).toBe(true);
    const tail = result.messages.slice(1);
    expect(tail).toEqual(thread.slice(4)); // the huge (latest) turn is verbatim
  });
});
