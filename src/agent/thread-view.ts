// The SW-side conversation thread, rendered down to what the panel may see (#168 C).
//
// Extracted from background.ts so the REAL mapping is testable: background.ts pulls the WXT
// `#imports` virtual module and cannot be imported under Vitest, which forced
// test/integration/thread-memory.test.ts to hand-mirror this logic — a mirror that could drift
// from the code it claimed to pin. Everything here is chrome-free by construction: pure functions
// over the persisted `ChatMessage[]` plus the shared vocabulary (`operationOf`,
// `HISTORY_MAX_MESSAGES`, `ThreadViewMessage`). WHICH tab's thread to render is not this module's
// question — that is `./conversation-tab.ts`.

import { FOCUS_CONTEXT_PREFIX } from '@/agent/focus-context';
import { TURN_ADDENDUM_PREFIX } from '@/agent/modes';
import type { ChatMessage } from '@/agent/session';
import { HISTORY_MAX_MESSAGES, type ThreadViewMessage } from '@/shared/messages';
import { operationOf } from '@/shared/overlay-step';

/** The user's own words, with the scaffolding this SW added for the model stripped back off: the
 *  grounding line (`focus-context.ts`) and the mode addendum (`modes.ts`). The thread stores what
 *  the MODEL saw — rendering that verbatim attributed a 1.5 KB directive to the user. */
export function userAsk(text: string): string {
  let out = text;
  const firstBreak = out.indexOf('\n');
  if (out.startsWith(FOCUS_CONTEXT_PREFIX) && firstBreak > 0) out = out.slice(firstBreak + 1);
  const addendum = out.lastIndexOf(`\n\n${TURN_ADDENDUM_PREFIX}`);
  if (addendum > 0) out = out.slice(0, addendum);
  return out.trim();
}

/** Per-turn tool chip being assembled by {@link toThreadView}: the `toolCallId` correlates a
 *  later tool-result to its call, exactly like the stream's `tool-call`/`tool-result` pairing. */
export interface ThreadViewTool {
  name: string;
  ok: boolean;
  id?: string;
}

/** The visible text of a message's content: the string itself, or its `text` parts joined —
 *  never images/tool payloads. Structural narrowing (the content unions differ per role). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string' &&
      part.text.length > 0
    ) {
      texts.push(part.text);
    }
  }
  return texts.join('\n\n');
}

/** Did this tool-result output report success? `error-text`/`error-json`/`execution-denied`
 *  outputs are failures; a JSON output carrying the content-bus `ToolResult` shape answers with
 *  its own `ok`; anything else (plain text, unrecognized) counts as success — same optimism as
 *  the panel folding a result chip without an `error`. */
export function toolOutputOk(output: unknown): boolean {
  if (output === null || typeof output !== 'object') return true;
  const type = 'type' in output ? output.type : undefined;
  if (type === 'error-text' || type === 'error-json' || type === 'execution-denied') return false;
  const value = 'value' in output ? output.value : output;
  if (
    value !== null &&
    typeof value === 'object' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  ) {
    return value.ok;
  }
  return true;
}

/** Fold one tool-result part onto the pending chip it answers (by `toolCallId`, else the newest
 *  same-named chip), or append a chip of its own when the call fell outside the thread. */
export function settleThreadTool(
  tools: ThreadViewTool[],
  part: { toolCallId?: string; toolName: string; output?: unknown },
): void {
  const ok = toolOutputOk(part.output);
  const byId = part.toolCallId ? tools.find((t) => t.id === part.toolCallId) : undefined;
  const target = byId ?? [...tools].reverse().find((t) => t.name === part.toolName);
  if (target) target.ok = ok;
  else tools.push({ name: part.toolName, ok });
}

/**
 * Render the SW's persisted session thread down to the panel-facing view (#168 C): one entry per
 * user message, and ONE assistant entry per turn — consecutive assistant/tool messages between
 * user messages fold together (their prose joined, their tool calls settled in order by the
 * matching tool-results). Raw provider parts (tool payloads, images) never cross the bus. A
 * tool-call with no persisted result keeps `ok: true` — the absence of a recorded failure, same
 * as a text-only output. System messages are the SW's own scaffolding and are dropped. Bounded to
 * the same caps the schema enforces (`HISTORY_MAX_MESSAGES` messages, 100 tools per entry).
 */
export function toThreadView(messages: readonly ChatMessage[]): ThreadViewMessage[] {
  const view: ThreadViewMessage[] = [];
  let turn: { texts: string[]; tools: ThreadViewTool[] } | null = null;

  const flushTurn = (): void => {
    if (!turn) return;
    const tools = turn.tools.slice(0, 100).map(({ name, ok }) => ({ name, ok }));
    view.push({
      role: 'assistant',
      text: turn.texts.filter((t) => t.length > 0).join('\n\n'),
      ...(tools.length > 0 ? { tools } : {}),
    });
    turn = null;
  };

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      flushTurn();
      // The user's OWN words: the persisted message carries the grounding line + mode addendum
      // the SW added for the model, and rendering those verbatim attributed them to the user.
      view.push({ role: 'user', text: userAsk(contentText(message.content)) });
      continue;
    }
    if (message.role === 'assistant') {
      turn ??= { texts: [], tools: [] };
      if (typeof message.content === 'string') {
        if (message.content.length > 0) turn.texts.push(message.content);
        continue;
      }
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text.length > 0) turn.texts.push(part.text);
        } else if (part.type === 'tool-call') {
          // The OPERATION, not the resource. Since the tool surface was grouped
          // (`agent/tools/resources.ts`), the persisted `toolName` is `edit`/`inspect`/`interact`
          // while the real action lives in the input's `op`. The live stream already reports the
          // operation (`loop.ts`), so a rehydrated transcript must too — otherwise reconnecting to
          // a woken worker silently turns every chip in the user's scrollback into "edit".
          // The tool name gates the read (`DISPATCHER_TOOLS`): an MCP tool's input never names an
          // operation of ours, whatever stray `type` field it carries.
          turn.tools.push({
            name: operationOf(part.input, part.toolName) ?? part.toolName,
            ok: true,
            id: part.toolCallId,
          });
        } else if (part.type === 'tool-result') {
          // Provider-executed tools settle inline in the assistant message.
          settleThreadTool(turn.tools, part);
        }
      }
      continue;
    }
    // role === 'tool': results answering the current turn's calls. An orphaned tool message
    // (no assistant before it — a truncated thread) still surfaces as chips on a text-less turn.
    turn ??= { texts: [], tools: [] };
    for (const part of message.content) {
      if (part.type === 'tool-result') settleThreadTool(turn.tools, part);
    }
  }
  flushTurn();
  return view.slice(-HISTORY_MAX_MESSAGES);
}
