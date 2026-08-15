import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/agent/session';
import {
  approxPromptTokens,
  COMPACT_AT_WINDOW_FRACTION,
  capInFlightResults,
  compactForThread,
  compactSessionThread,
  compactToWindow,
  HIGH_WATER_APPROX_TOKENS,
  IMAGE_OMITTED_PLACEHOLDER,
  IMAGE_PRUNED_PLACEHOLDER,
  IN_FLIGHT_TEXT_CAP,
  KEEP_NEWEST_IMAGE_SETS,
  pruneInFlightImages,
  SESSION_MEMORY_MARKER,
  TOOL_TEXT_CAP,
  USER_MEDIA_OMITTED_PLACEHOLDER,
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
          { type: 'text', text: USER_MEDIA_OMITTED_PLACEHOLDER },
        ],
      },
    ]);
    roundTrips(compacted);
  });

  it('never tells the model to "re-capture" a mockup it cannot re-capture', () => {
    // A user's reference lives on their desktop. `IMAGE_OMITTED_PLACEHOLDER`'s advice ("re-capture
    // if you need current visuals") points the agent at the LIVE PAGE — the thing it was asked to
    // change — so a stripped mockup would be replaced by a screenshot of the wrong image.
    const [compacted] = compactForThread([
      { role: 'user', content: [{ type: 'image', image: PNG, mediaType: 'image/png' }] },
    ]);
    const rendered = JSON.stringify(compacted);
    expect(rendered).toContain(USER_MEDIA_OMITTED_PLACEHOLDER);
    expect(rendered).not.toContain(IMAGE_OMITTED_PLACEHOLDER);
    expect(USER_MEDIA_OMITTED_PLACEHOLDER).toContain('ask the user to re-attach');
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

  // The defect this pins: `imageUnits` counted a user message's media as a prunable set, so on any
  // iterating turn (screenshot → edit → screenshot) two of the AGENT's own captures evicted the
  // mockup the user attached — and `IMAGE_PRUNED_PLACEHOLDER` then told the model to "re-capture
  // this view", pointing it at the live page it was asked to change. Agent media is re-capturable
  // output; user media is irreplaceable input, and the two must not share a budget.
  describe('user-attached media is never prunable', () => {
    // A payload that shares no substring with PNG, so `imageCount` counts only agent screenshots.
    const MOCKUP = 'bW9ja3VwLXBheWxvYWQtbm90LWEtc2NyZWVuc2hvdA'.repeat(40);
    const withMockup = (shots: number): ChatMessage[] => [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'redesign the hero to match this' },
          { type: 'image', image: MOCKUP, mediaType: 'image/png' },
        ],
      },
      ...transcript(shots).slice(1),
    ];

    it('survives verbatim while the agent’s own screenshots age out around it', () => {
      const messages = withMockup(4);
      const pruned = pruneInFlightImages(messages);
      // The user's message is untouched — same reference, so the prompt-cache prefix is stable too.
      expect(pruned[0]).toBe(messages[0]);
      expect(JSON.stringify(pruned[0])).toContain(MOCKUP);
      // …while the agent's screenshots pruned down to the keep window as usual.
      expect(imageCount(pruned)).toBe(KEEP_NEWEST_IMAGE_SETS);
      roundTrips(pruned);
    });

    it('does not consume a slot in the keep window', () => {
      // One mockup + exactly KEEP_NEWEST_IMAGE_SETS screenshots: if the user's image counted as a
      // set, the oldest screenshot would be evicted to make room. Nothing may be pruned at all.
      const messages = withMockup(KEEP_NEWEST_IMAGE_SETS);
      expect(pruneInFlightImages(messages)).toBe(messages);
    });

    it('is never rewritten to the "re-capture" placeholder', () => {
      const pruned = pruneInFlightImages(withMockup(6));
      const userMessage = JSON.stringify(pruned[0]);
      expect(userMessage).not.toContain(IMAGE_PRUNED_PLACEHOLDER);
      expect(userMessage).not.toContain('re-capture');
    });
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

// --- capInFlightResults (the in-flight text ceiling) ------------------------------------------
//
// THE DEFECT: `TOOL_TEXT_CAP` bounded a tool result only when the turn was PERSISTED — exactly one
// moment too late. Nothing bounded a result while the turn was still running, and every step
// re-sends the whole transcript, so one oversized read was re-billed once per remaining step: cost
// quadratic in result size. Measured on a Hacker-News-shaped DOM, `a11ySnapshot` returns ~22.4k
// chars (~5.6k tokens) and has NO aggregate ceiling of its own (src/dom/read.ts: depth 12 × 60
// children per node), which is how a 3-step turn reached 316k tokens and made zero edits.

describe('capInFlightResults', () => {
  const bigText = 'x'.repeat(IN_FLIGHT_TEXT_CAP + 5_000);

  const textResultOf = (value: string): ChatMessage => textResult('t1', 'a11ySnapshot', value);

  it('returns the input array unchanged (same reference) when nothing is over the cap', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'polish the hero' },
      textResult('t1', 'query', 'small enough'),
    ];
    expect(capInFlightResults(messages)).toBe(messages);
  });

  it('clips an oversized text result and says how to get the rest', () => {
    const capped = capInFlightResults([textResultOf(bigText)]);
    const json = JSON.stringify(capped);
    expect(json).toContain('TRUNCATED');
    // ACTIONABLE, not merely honest — a bare "truncated" invites the model to reason about what it
    // cannot see, the confabulation failure `query`'s own marker exists for.
    expect(json).toContain('NARROWER');
    expect(json).toContain('You received a PREFIX');
    expect(json.length).toBeLessThan(JSON.stringify([textResultOf(bigText)]).length);
    roundTrips(capped);
  });

  it('is idempotent — a clipped result is not re-clipped on the next step', () => {
    const once = capInFlightResults([textResultOf(bigText)]);
    const twice = capInFlightResults(once);
    // Same reference: the second pass found nothing over the cap, so the prompt prefix is stable
    // from here. This is the property that keeps prompt caching alive across the turn.
    expect(twice).toBe(once);
  });

  it('leaves the honestly-bounded reads completely alone', () => {
    // `query` (25 matches ≈ 5.5k chars), `describe` (2k), `getStyles` (~440) must pass untouched —
    // the cap exists for the UNBOUNDED read, not to second-guess the ones that already bound
    // themselves.
    const messages = [textResult('t1', 'query', 'q'.repeat(5_500))];
    expect(capInFlightResults(messages)).toBe(messages);
  });

  it('clips oversized JSON by downgrading it to text, never to invalid JSON', () => {
    const message: ChatMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'j1',
          toolName: 'diagnostics',
          output: { type: 'json', value: { blob: bigText } },
        },
      ],
    };
    const [capped] = capInFlightResults([message]);
    const part = (capped as { content: Array<{ output: { type: string; value: unknown } }> })
      .content[0];
    expect(part?.output.type).toBe('text');
    expect(String(part?.output.value)).toContain('TRUNCATED');
    roundTrips([capped as ChatMessage]);
  });

  it('clips text items inside a multimodal content output but never the image parts', () => {
    const message: ChatMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 's1',
          toolName: 'screenshot',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: bigText },
              { type: 'file', data: { type: 'data', data: PNG }, mediaType: 'image/png' },
            ],
          },
        },
      ],
    };
    const capped = capInFlightResults([message]);
    const json = JSON.stringify(capped);
    expect(json).toContain('TRUNCATED');
    expect(json).toContain(PNG); // the image is `pruneInFlightImages`'s business, not this one
    roundTrips(capped);
  });

  it('never touches a user message — attachments and instructions are not tool output', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: bigText }];
    expect(capInFlightResults(messages)).toBe(messages);
  });
});

// --- compactToWindow (proportional, context-window aware) -------------------------------------
//
// THE GAP: nothing watched how full the model's REAL context was. `compactSessionThread` fired on a
// fixed character high-water and only on the PERSISTED thread, so a 32k model and a 1M model were
// held to the same number — over the wall on one, a fifth of capacity on the other. A full-page
// overhaul exceeds one turn by nature, so lossless stop-and-resume is load-bearing, not polish.

describe('compactToWindow', () => {
  /** A turn's worth of messages, each roughly `perMessageChars` long. */
  const thread = (turns: number, perMessageChars = 4_000): ChatMessage[] => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < turns; i++) {
      messages.push({ role: 'user', content: `ask ${i}: ${'q'.repeat(perMessageChars)}` });
      messages.push(toolCall(`t${i}`, 'getStyles', {}));
      messages.push(textResult(`t${i}`, 'getStyles', 'r'.repeat(perMessageChars)));
    }
    return messages;
  };

  it('returns the input array unchanged (same reference) below the threshold', () => {
    const messages = thread(2);
    expect(compactToWindow(messages, 1_000_000)).toBe(messages);
  });

  it('is proportional — the SAME thread compacts on a small window and not on a large one', () => {
    // This is the whole point: one number cannot serve both.
    const messages = thread(12);
    expect(compactToWindow(messages, 1_000_000)).toBe(messages);
    expect(compactToWindow(messages, 32_000)).not.toBe(messages);
  });

  it('folds the oldest turns into ONE digest and keeps the recent tail verbatim', () => {
    const messages = thread(12);
    const compacted = compactToWindow(messages, 32_000);
    const digests = compacted.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith(SESSION_MEMORY_MARKER),
    );
    expect(digests).toHaveLength(1);
    // The most recent turn is never digested — it is the working set.
    expect(compacted.at(-1)).toBe(messages.at(-1));
    expect(compacted.length).toBeLessThan(messages.length);
    roundTrips(compacted);
  });

  it('actually gets under the threshold it fired on', () => {
    const compacted = compactToWindow(thread(12), 32_000);
    expect(approxPromptTokens(compacted)).toBeLessThanOrEqual(
      Math.floor(32_000 * COMPACT_AT_WINDOW_FRACTION),
    );
  });

  it('is idempotent — a second pass returns the same array', () => {
    const once = compactToWindow(thread(12), 32_000);
    expect(compactToWindow(once, 32_000)).toBe(once);
  });

  it('is deterministic — same input, same output', () => {
    expect(JSON.stringify(compactToWindow(thread(12), 32_000))).toBe(
      JSON.stringify(compactToWindow(thread(12), 32_000)),
    );
  });

  it('PRESERVES user-attached reference material verbatim through a compaction', () => {
    // The asymmetry `pruneInFlightImages` already honours: a screenshot is re-capturable output, a
    // mockup off the user's desktop is not. Compaction has to honour it too, or the long overhaul
    // that most needs compacting is the one that silently loses the design it works towards.
    const MOCKUP = 'bW9ja3VwLXJlZmVyZW5jZS1wYXlsb2Fk'.repeat(20);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'match this mockup' },
          { type: 'image', image: MOCKUP, mediaType: 'image/png' },
        ],
      },
      ...thread(12),
    ];
    const compacted = compactToWindow(messages, 32_000);
    expect(compacted).not.toBe(messages);
    // The pixels survive.
    expect(JSON.stringify(compacted)).toContain(MOCKUP);
    // …and they are still a real image part, not prose about one.
    const kept = compacted.find(
      (m) => m.role === 'user' && typeof m.content !== 'string' && m.content.some(isImagePart),
    );
    expect(kept).toBeDefined();
    roundTrips(compacted);
  });

  it('degrades safely on a nonsense window rather than compacting forever', () => {
    const messages = thread(4);
    expect(compactToWindow(messages, 0)).toBe(messages);
    expect(compactToWindow(messages, -1)).toBe(messages);
  });

  it('keeps the in-flight turn on a small context window (8192)', () => {
    // At 8k the STANDING-context estimate exceeds the whole compaction budget, so the transcript
    // budget bottomed out at 0 and `tailStartIndex` fell through to the last user-role message —
    // which mid-turn is the SDK's appended budget WARNING, not the ask, so the turn's own steps
    // were digested on every pass and the agent re-read the page forever. The floor
    // (`MIN_TRANSCRIPT_FRACTION`) keeps a real working set.
    const messages: ChatMessage[] = [
      { role: 'user', content: `earlier ask: ${'q'.repeat(4_000)}` },
      { role: 'assistant', content: `earlier reply: ${'a'.repeat(4_000)}` },
      textResult('t0', 'getStyles', 'r'.repeat(4_000)),
      { role: 'user', content: 'now fix the header' }, // the in-flight turn's ask
      toolCall('t1', 'getStyles', {}),
      textResult('t1', 'getStyles', 's'.repeat(2_000)),
      // A user-role message appended AFTER the steps (the budget warning shape) — pre-fix, the
      // tail fallback landed HERE and discarded the turn's own tool activity above it.
      { role: 'user', content: 'Budget warning: wrap up soon.' },
    ];
    const compacted = compactToWindow(messages, 8_192);
    expect(compacted).not.toBe(messages);

    const askIndex = compacted.findIndex(
      (m) => typeof m.content === 'string' && m.content === 'now fix the header',
    );
    expect(askIndex).toBeGreaterThanOrEqual(0);
    // At least one of the turn's own following assistant/tool messages survives verbatim.
    const followers = compacted.slice(askIndex + 1);
    expect(followers.some((m) => m.role === 'assistant' || m.role === 'tool')).toBe(true);

    // Second pass: idempotent — the compacted thread now fits the floored budget.
    expect(compactToWindow(compacted, 8_192)).toBe(compacted);
    roundTrips(compacted);
  });
});

function isImagePart(part: { type: string }): boolean {
  return part.type === 'image' || part.type === 'file';
}
