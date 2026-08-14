import { describe, expect, it } from 'vitest';
import {
  appendBounded,
  errorLogEntry,
  LOG_CAP,
  type LogEntry,
  logEntryFor,
  redactSecrets,
  renderTurnLog,
} from '@/agent/turn-log';
import type { SwToPanel } from '@/shared/messages';

// The per-conversation debug log. Two things carry real risk and are tested hardest: that a
// credential can never reach the paste, and that `token` deltas can never reach storage.

const context = {
  version: '1.1.0',
  model: 'anthropic/claude-sonnet-5',
  providerHost: 'https://openrouter.ai',
  pageUrl: 'https://example.com/pricing',
  tabId: 7,
};

describe('redactSecrets', () => {
  it.each([
    ['sk-or-v1-0123456789abcdefghij', 'an OpenRouter key'],
    ['sk-ant-api03-abcdefghijklmnop', 'an Anthropic key'],
    ['sk-proj-abcdefghijklmnopqrst', 'an OpenAI project key'],
  ])('strips %s (%s)', (secret) => {
    const out = redactSecrets(`request failed with key ${secret} attached`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('strips an Authorization header echoed back inside an error body', () => {
    const out = redactSecrets('401 {"error":"bad auth","sent":"Bearer abcdef1234567890"}');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('[redacted]');
  });

  it('keeps the FIELD NAME while dropping the value, so the reader still learns what was set', () => {
    const out = redactSecrets('config: api_key=abcdef1234567890, model=gpt-4');
    expect(out).toContain('api_key');
    expect(out).not.toContain('abcdef1234567890');
    // Non-secret context survives — over-redaction would make the log useless.
    expect(out).toContain('model=gpt-4');
  });

  it('clamps a provider payload instead of storing kilobytes of JSON', () => {
    const out = redactSecrets('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    const text = 'tools.function.parameters.type is required and must be "object"';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('logEntryFor', () => {
  it('DROPS token deltas — the log must stay readable and must not grow per character', () => {
    expect(logEntryFor({ type: 'token', text: 'Hello' }, 1000)).toBeNull();
  });

  it.each<SwToPanel>([
    { type: 'picker-state', active: true },
    { type: 'session-state', state: 'running' },
  ])('drops the non-diagnostic event %o', (update) => {
    expect(logEntryFor(update, 1000)).toBeNull();
  });

  it('records a tool call with its target', () => {
    const entry = logEntryFor({ type: 'tool-call', tool: 'edit', selector: '.hero' }, 1000);
    expect(entry).toMatchObject({ kind: 'tool', at: 1000 });
    expect(entry?.text).toContain('edit');
    expect(entry?.text).toContain('.hero');
  });

  it('records a FAILED tool result as an error, carrying the reason', () => {
    const entry = logEntryFor(
      { type: 'tool-result', tool: 'edit', ok: false, error: 'no element matched .hero' },
      2000,
    );
    expect(entry?.kind).toBe('error');
    expect(entry?.text).toContain('no element matched .hero');
  });

  it('records a successful tool result as a plain tool line', () => {
    const entry = logEntryFor({ type: 'tool-result', tool: 'inspect', ok: true }, 2000);
    expect(entry?.kind).toBe('tool');
  });

  it('records the turn error verbatim — this is the line a bug report is pasted for', () => {
    const entry = logEntryFor(
      {
        type: 'error',
        message: 'tools.function.parameters.type is required and must be "object"',
      },
      3000,
    );
    expect(entry?.kind).toBe('error');
    expect(entry?.text).toContain('tools.function.parameters.type');
  });

  it('records the turn boundary with its spend', () => {
    const entry = logEntryFor({ type: 'turn-done', usage: { steps: 4, tokens: 1234 } }, 4000);
    expect(entry?.kind).toBe('turn');
    expect(entry?.text).toContain('4 steps');
    expect(entry?.text).toContain('1234 tokens');
  });

  it('logs only the FAILING ship task, not every status transition', () => {
    const base = { type: 'task-status' as const, taskId: 't1', title: 'Warm the hero', index: 0 };
    expect(logEntryFor({ ...base, total: 1, status: 'working' }, 5000)).toBeNull();
    const failed = logEntryFor(
      { ...base, total: 1, status: 'error', error: 'backend refused' },
      5000,
    );
    expect(failed?.kind).toBe('error');
    expect(failed?.text).toContain('backend refused');
  });

  it('redacts on the way IN, so a key is never at rest in a session record', () => {
    const entry = logEntryFor(
      { type: 'error', message: 'auth failed for sk-or-v1-0123456789abcdef' },
      1000,
    );
    expect(entry?.text).not.toContain('sk-or-v1-0123456789abcdef');
  });
});

describe('errorLogEntry — the errors that ESCAPE the loop', () => {
  it('names the error class, because that is the actionable half', () => {
    class ApiCallError extends Error {
      override name = 'AI_APICallError';
    }
    const entry = errorLogEntry(
      'UNHANDLED',
      new ApiCallError('tools.function.parameters.type is required and must be "object"'),
      1000,
    );
    expect(entry.kind).toBe('error');
    expect(entry.text).toContain('UNHANDLED');
    expect(entry.text).toContain('AI_APICallError');
    expect(entry.text).toContain('tools.function.parameters.type');
  });

  it('does not prefix a plain Error with a useless "Error:"', () => {
    expect(errorLogEntry('UNCAUGHT', new Error('boom'), 1).text).toBe('UNCAUGHT boom');
  });

  it('handles a thrown non-Error, which is what an unhandled rejection often carries', () => {
    expect(errorLogEntry('UNHANDLED', 'just a string', 1).text).toContain('just a string');
    expect(errorLogEntry('UNHANDLED', { code: 42 }, 1).text).toContain('42');
  });

  it('survives a value that cannot be serialized rather than throwing inside the logger', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => errorLogEntry('UNHANDLED', circular, 1)).not.toThrow();
  });

  it('redacts a credential that rode along in the message', () => {
    const entry = errorLogEntry('UNHANDLED', new Error('bad key sk-or-v1-abcdef123456'), 1);
    expect(entry.text).not.toContain('sk-or-v1-abcdef123456');
  });
});

describe('appendBounded', () => {
  const entry = (n: number): LogEntry => ({ at: n, kind: 'note', text: `#${n}` });

  it('appends in order below the cap', () => {
    const log = [entry(1), entry(2)];
    expect(appendBounded(log, entry(3), 10).map((e) => e.text)).toEqual(['#1', '#2', '#3']);
  });

  it('drops the OLDEST at the cap — a long QA session must not grow into the storage quota', () => {
    let log: LogEntry[] = [];
    for (let n = 1; n <= 5; n += 1) log = appendBounded(log, entry(n), 3);
    expect(log.map((e) => e.text)).toEqual(['#3', '#4', '#5']);
  });

  it('does not mutate the log it was given', () => {
    const log = [entry(1)];
    appendBounded(log, entry(2), 10);
    expect(log).toHaveLength(1);
  });

  it('defaults to LOG_CAP', () => {
    let log: LogEntry[] = [];
    for (let n = 0; n < LOG_CAP + 10; n += 1) log = appendBounded(log, entry(n));
    expect(log).toHaveLength(LOG_CAP);
  });
});

describe('renderTurnLog', () => {
  it('heads the paste with the environment a reader needs to reproduce', () => {
    const md = renderTurnLog(context, []);
    expect(md).toContain('1.1.0');
    expect(md).toContain('anthropic/claude-sonnet-5');
    expect(md).toContain('https://openrouter.ai');
    expect(md).toContain('https://example.com/pricing');
  });

  it('says so plainly when nothing has been logged, rather than rendering an empty fence', () => {
    expect(renderTurnLog(context, [])).toContain('No activity logged');
  });

  it('renders entries as OFFSETS from the first, which is what shows a stall', () => {
    const md = renderTurnLog(context, [
      { at: 10_000, kind: 'tool', text: '→ inspect' },
      { at: 13_500, kind: 'error', text: '✗ edit — failed' },
    ]);
    expect(md).toContain('+   0.0s');
    expect(md).toContain('+   3.5s');
  });

  it('fences as `text` so a pasted log is not syntax-highlighted into nonsense', () => {
    const md = renderTurnLog(context, [{ at: 1, kind: 'note', text: 'hi' }]);
    expect(md).toContain('```text');
  });

  it('flags a capped log, so a reader knows the beginning is missing', () => {
    const log = Array.from({ length: LOG_CAP }, (_, n) => ({
      at: n,
      kind: 'note' as const,
      text: `#${n}`,
    }));
    expect(renderTurnLog(context, log)).toContain('capped');
  });

  it('names an unconfigured provider instead of rendering empty fields', () => {
    const md = renderTurnLog({ ...context, model: '', providerHost: '' }, []);
    expect(md).toContain('(none configured)');
  });
});
