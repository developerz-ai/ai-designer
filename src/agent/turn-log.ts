// A per-conversation debug log: what the agent actually did, in a form you can paste.
//
// WHY. When a turn fails, the useful detail lives in the SERVICE WORKER console — a world you reach
// only through `chrome://extensions` → "Inspect views: service worker", where it arrives minified
// (`at background.js:79:15488`). The panel shows the failure text but not the trace around it: which
// tools ran, in what order, which one failed first, what the model was, whether the provider
// rejected the request outright. So the honest bug report was "paste a minified stack and hope",
// which is exactly how the `tools.function.parameters.type` rejection reached us.
//
// SCOPED TO THE CONVERSATION, not the process. The log rides `TurnSession` (one per tab, one per
// design session), so it is already the right unit: it survives service-worker eviction with the
// rest of the session, it resets when the session does, and two tabs being QA'd side by side keep
// separate logs instead of interleaving into one global console.
//
// WHAT IS LOGGED. The turn's SPINE: tool calls and how they settled, errors, and the turn boundary
// with its token spend. NOT `token` events — text deltas would be thousands of entries per turn for
// no diagnostic value, and the assistant text is already in the panel scrollback.
//
// SECRETS. `redactSecrets` runs on every entry as it is appended, not at render time, so a key can
// never be at rest inside a session record even if something upstream puts one in an error message.
// A provider that echoes the Authorization header back inside a 401 body is a real shape, and BYOK
// keys never leaving the service worker is a hard rule (CLAUDE.md). Belt and braces: the log is
// built from panel-bound events, which carry no credentials in the first place.

import { z } from 'zod';
import type { SwToPanel } from '@/shared/messages';

/** How many entries one session's log keeps. A ring buffer, oldest dropped first: the log is a
 *  debugging aid inside a `chrome.storage.session` record, not an archive, and an unbounded array
 *  on a long QA session grows into the storage quota. ~40 entries is a busy turn, so this holds
 *  the last several turns — which is what "reproduce it and paste the log" needs. */
export const LOG_CAP = 300;

/** Per-entry text ceiling. A provider error body can be kilobytes of JSON; the first 600 characters
 *  carry the message and the offending field, which is what a reader needs. */
const TEXT_CAP = 600;

export const LogKind = z.enum(['turn', 'tool', 'error', 'note']);
export type LogKind = z.infer<typeof LogKind>;

export const LogEntry = z.object({
  /** Epoch ms. Rendered as an offset from the log's first entry, so the paste has no wall-clock
   *  noise but keeps the timing that shows where a turn stalled. */
  at: z.number(),
  kind: LogKind,
  text: z.string().max(TEXT_CAP),
});
export type LogEntry = z.infer<typeof LogEntry>;

/** Anything key-shaped, replaced in place. Deliberately greedy — a false positive costs one
 *  unreadable token in a debug paste, a false negative leaks a credential. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Provider key prefixes (OpenAI/OpenRouter `sk-`, `sk-or-v1-`, Anthropic `sk-ant-`).
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  // `Authorization: Bearer <token>` echoed back inside an error body.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // `api_key=…` / `"apiKey":"…"` / `token: …` in a serialized request.
  /\b(api[_-]?key|apikey|access[_-]?token|token|secret)\b(\s*[:=]\s*"?)([A-Za-z0-9._~+/=-]{8,})"?/gi,
];

/** Strip credentials and clamp length. Applied on APPEND — see the header note on secrets. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    // The two trailing args of a replacer are `offset` (number) and the whole subject (string), and
    // a pattern with NO capture groups passes them in the slots a grouped pattern uses for its
    // captures. So the groups are taken positionally ONLY when they are both strings — reading them
    // unconditionally spliced the offset and the entire subject back into the output, which is how
    // this leaked the very key it was redacting until `turn-log.test.ts` caught it.
    out = out.replace(pattern, (...args: unknown[]) => {
      const [, name, sep] = args;
      // The grouped pattern keeps the field name, so the reader still sees WHICH field was set.
      return typeof name === 'string' && typeof sep === 'string'
        ? `${name}${sep}[redacted]`
        : '[redacted]';
    });
  }
  return out.length > TEXT_CAP ? `${out.slice(0, TEXT_CAP - 1)}…` : out;
}

/**
 * The log entry one panel-bound event deserves, or `null` for events that are not diagnostic.
 *
 * Returning `null` for the majority is the point: this is a filter, and `token` passing through it
 * would drown the log it is supposed to make readable.
 */
export function logEntryFor(update: SwToPanel, now: number): LogEntry | null {
  switch (update.type) {
    case 'tool-call':
      return {
        at: now,
        kind: 'tool',
        text: redactSecrets(
          `→ ${update.tool}${update.selector ? ` ${update.selector}` : ''}`.trim(),
        ),
      };
    case 'tool-result':
      return {
        at: now,
        kind: update.ok ? 'tool' : 'error',
        text: redactSecrets(
          update.ok ? `✓ ${update.tool}` : `✗ ${update.tool} — ${update.error ?? 'failed'}`,
        ),
      };
    case 'error':
      return { at: now, kind: 'error', text: redactSecrets(`ERROR ${update.message}`) };
    case 'turn-done':
      return {
        at: now,
        kind: 'turn',
        text: `turn ended — ${update.usage.steps} steps, ${update.usage.tokens} tokens`,
      };
    case 'task-status':
      // Ship timeline: only the failures are worth a line here.
      return update.status === 'error'
        ? {
            at: now,
            kind: 'error',
            text: redactSecrets(`✗ task ${update.title} — ${update.error ?? 'failed'}`),
          }
        : null;
    default:
      return null;
  }
}

/**
 * A log entry for an error that never travelled the turn's event stream.
 *
 * The stream carries what the agent loop CATCHES. It cannot carry what escapes: an uncaught
 * exception or an unhandled rejection in the service worker (`AI_NoOutputGeneratedError` arrives as
 * one) only ever reached the service-worker console, which is the surface this whole module exists
 * to stop people digging through. `name: message` rather than the stack: the stack is minified in a
 * built extension (`at background.js:79:15488`) and tells a reader nothing they can act on.
 */
export function errorLogEntry(prefix: string, err: unknown, now: number): LogEntry {
  return { at: now, kind: 'error', text: redactSecrets(`${prefix} ${describeError(err)}`) };
}

/** The most identifying one-liner available for a thrown value. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    // A value with a throwing `toJSON`, or a circular one. Still worth a line.
    return String(err);
  }
}

/** Append with the ring-buffer cap applied. Pure — returns the next log rather than mutating. */
export function appendBounded(
  log: readonly LogEntry[],
  entry: LogEntry,
  cap: number = LOG_CAP,
): LogEntry[] {
  const next = [...log, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** The environment half of the paste — everything a reader needs that is not an event. */
export interface LogContext {
  readonly version: string;
  readonly model: string;
  /** Provider ORIGIN only, never the full URL with query, and never the key. */
  readonly providerHost: string;
  readonly pageUrl: string;
  readonly tabId: number;
}

/**
 * Render a session's log as Markdown, ready to paste into an issue or a chat.
 *
 * Fenced as `text` so a GitHub comment does not try to syntax-highlight it, and timestamps are
 * OFFSETS from the first entry (`+1.2s`) — absolute times add noise and a little privacy exposure
 * while the gaps are what actually show a stall.
 */
export function renderTurnLog(context: LogContext, log: readonly LogEntry[]): string {
  const head = [
    '## Designer debug log',
    '',
    `- extension: ${context.version}`,
    `- model: ${context.model || '(none configured)'}`,
    `- provider: ${context.providerHost || '(none configured)'}`,
    `- page: ${redactSecrets(context.pageUrl)}`,
    `- tab: ${context.tabId}`,
    `- entries: ${log.length}${log.length >= LOG_CAP ? ` (capped, oldest dropped)` : ''}`,
    '',
  ];
  if (log.length === 0) {
    return [...head, 'No activity logged for this conversation yet.', ''].join('\n');
  }

  const start = log[0]?.at ?? 0;
  const body = log.map((entry) => {
    const offset = ((entry.at - start) / 1000).toFixed(1);
    return `+${offset.padStart(6)}s  ${entry.kind.padEnd(5)} ${entry.text}`;
  });
  return [...head, '```text', ...body, '```', ''].join('\n');
}
