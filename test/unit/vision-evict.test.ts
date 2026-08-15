import { modelMessageSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/agent/session';
import {
  evictStaleVision,
  KEEP_RECENT_VISION_STEPS,
  STALE_VISION_STUB,
} from '@/agent/vision-evict';

// vision-evict.ts unit: step-age eviction of screenshot payloads from the OUTGOING in-flight
// transcript. The defect it pins: `pruneInFlightImages` bounds how MANY captures ride the
// transcript, not for how LONG — a single screenshot from step 1 of a ten-step turn was re-billed
// on every remaining model call because the set-count window never filled (~277k tokens over 3
// steps on a real turn). Once a vision result is older than the last KEEP_RECENT_VISION_STEPS
// steps its images become STALE_VISION_STUB text; structure/ids stay; the stored thread is never
// touched (this runs only on what `prepareStep` sends).

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA'.repeat(40);

const screenshotResult = (id: string, images = 1): ChatMessage => ({
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
          ...Array.from({ length: images }, () => ({
            type: 'file' as const,
            data: { type: 'data' as const, data: PNG },
            mediaType: 'image/png',
          })),
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

/** A turn whose FIRST step is a screenshot, followed by `editSteps` edit steps — the exact shape
 *  where the set-count pruning never fires but the capture keeps getting re-billed. */
const turnWithEarlyScreenshot = (editSteps: number): ChatMessage[] => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'make the hero match the brand' },
    toolCall('s1', 'screenshot', {}),
    screenshotResult('s1'),
  ];
  for (let i = 0; i < editSteps; i++) {
    messages.push(toolCall(`e${i}`, 'setStyle', { selector: '#hero' }));
    messages.push(textResult(`e${i}`, 'setStyle', '{"ok":true}'));
  }
  return messages;
};

const serialized = (messages: readonly ChatMessage[]): string => JSON.stringify(messages);

describe('evictStaleVision', () => {
  // FAILURE-FIRST: the shape that actually billed 277k tokens. Screenshot at step 1, two more
  // steps completed — the capture is now older than the keep-window and must go out as a stub.
  it('replaces a screenshot older than the last N steps with the stub, not the base64', () => {
    const messages = turnWithEarlyScreenshot(KEEP_RECENT_VISION_STEPS); // 3 steps total
    const out = evictStaleVision(messages);

    expect(serialized(out)).not.toContain(PNG);
    expect(serialized(out)).toContain(STALE_VISION_STUB);
  });

  it('keeps the tool-call/result structure, ids and surrounding text intact', () => {
    const messages = turnWithEarlyScreenshot(KEEP_RECENT_VISION_STEPS);
    const out = evictStaleVision(messages);

    const evicted = out[2];
    if (evicted?.role !== 'tool') throw new Error('expected tool message at index 2');
    const part = evicted.content[0];
    if (part?.type !== 'tool-result') throw new Error('expected tool-result part');
    expect(part.toolCallId).toBe('s1');
    expect(part.toolName).toBe('screenshot');
    if (part.output.type !== 'content') throw new Error('expected content output');
    expect(part.output.value).toEqual([
      { type: 'text', text: 'Screenshot of the current result.' },
      { type: 'text', text: STALE_VISION_STUB },
    ]);
    // The matching assistant tool-call message is untouched (same reference).
    expect(out[1]).toBe(messages[1]);
    // And everything still round-trips the SDK schema.
    for (const message of out) {
      const parsed = modelMessageSchema.safeParse(message);
      expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
    }
  });

  it('leaves a fresh screenshot untouched — same array reference, base64 intact', () => {
    // Screenshot in the newest step of a 3-step turn: inside the protected window.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'darken the header' },
      toolCall('e0', 'setStyle', { selector: 'header' }),
      textResult('e0', 'setStyle', '{"ok":true}'),
      toolCall('e1', 'setStyle', { selector: 'header' }),
      textResult('e1', 'setStyle', '{"ok":true}'),
      toolCall('s1', 'screenshot', {}),
      screenshotResult('s1'),
    ];
    const out = evictStaleVision(messages);

    expect(out).toBe(messages);
    expect(serialized(out)).toContain(PNG);
  });

  it('keeps the current AND immediately preceding step intact, evicts the one before that', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'iterate on the card' },
      toolCall('s1', 'screenshot', {}),
      screenshotResult('s1'), // step 1 of 3 → stale
      toolCall('s2', 'screenshot', {}),
      screenshotResult('s2'), // step 2 of 3 → protected (immediately preceding)
      toolCall('s3', 'screenshot', {}),
      screenshotResult('s3'), // step 3 of 3 → protected (current)
    ];
    const out = evictStaleVision(messages);

    expect(serialized([out[2] as ChatMessage])).not.toContain(PNG);
    expect(out[4]).toBe(messages[4]);
    expect(out[6]).toBe(messages[6]);
  });

  it('is idempotent — a second pass returns the first pass by reference', () => {
    const once = evictStaleVision(turnWithEarlyScreenshot(KEEP_RECENT_VISION_STEPS));
    expect(evictStaleVision(once)).toBe(once);
  });

  it('returns the input array by reference when the turn is shorter than the window', () => {
    const messages = turnWithEarlyScreenshot(KEEP_RECENT_VISION_STEPS - 1); // 2 steps total
    expect(evictStaleVision(messages)).toBe(messages);
  });

  it('stubs every image of a multi-image responsiveCapture result', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'check the breakpoints' },
      toolCall('r1', 'responsiveCapture', { widths: [360, 768, 1280] }),
      screenshotResult('r1', 3),
      toolCall('e0', 'setStyle', { selector: '.nav' }),
      textResult('e0', 'setStyle', '{"ok":true}'),
      toolCall('e1', 'setStyle', { selector: '.nav' }),
      textResult('e1', 'setStyle', '{"ok":true}'),
    ];
    const out = evictStaleVision(messages);

    expect(serialized(out)).not.toContain(PNG);
    const evicted = out[2];
    if (evicted?.role !== 'tool') throw new Error('expected tool message');
    const part = evicted.content[0];
    if (part?.type !== 'tool-result' || part.output.type !== 'content') {
      throw new Error('expected content tool-result');
    }
    expect(part.output.value.filter((item) => item.type === 'text').length).toBe(4);
  });

  it('never evicts user-attached media, however old', () => {
    const MOCKUP = 'MOCKUPBYTES'.repeat(50);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'match this mockup' },
          { type: 'image', image: MOCKUP, mediaType: 'image/png' },
        ],
      },
      ...turnWithEarlyScreenshot(KEEP_RECENT_VISION_STEPS + 2).slice(1),
    ];
    const out = evictStaleVision(messages);

    expect(out[0]).toBe(messages[0]);
    expect(serialized(out)).toContain(MOCKUP);
    expect(serialized(out)).not.toContain(PNG);
  });
});
