import { createSignal } from 'solid-js';
import { i18n } from '#i18n';
import type { Conversation, ConversationSummary } from '@/shared/messages';
import { HistoryGetResult, HistoryListResult, OkResult } from '@/shared/messages';
import { request } from './bus';

// History store: thin reflection of the SW's persisted last-10 conversations
// (src/agent/history-store.ts) over the history-list/get/delete RPCs (slice 08). No
// chrome.storage access here — the panel never touches storage directly (CLAUDE.md "MV3
// three worlds"); every read/mutation is a round-trip to the SW. There is no push stream to
// fold (unlike stores/mcp.ts, stores/changeset.ts): history only changes on an explicit
// list/open/delete call, so this module has no `wired`/`init*` port wiring.

const [conversations, setConversations] = createSignal<ConversationSummary[]>([]);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
const [selected, setSelected] = createSignal<Conversation | null>(null);
const [selectedLoading, setSelectedLoading] = createSignal(false);

export { conversations, error, loading, selected, selectedLoading };

/** Pull the current summary list from the SW (mount / manual refresh / after a delete). */
export async function hydrateHistory(): Promise<void> {
  setLoading(true);
  setError(null);
  try {
    const r = await request({ type: 'history-list' }, HistoryListResult);
    if (r.ok) setConversations(r.conversations ?? []);
    else setError(i18n.t('history.error.loadFailed'));
  } catch (e) {
    setError(errMsg(e));
  } finally {
    setLoading(false);
  }
}

/** Open one conversation for read-only replay (HistoryPanel -> ConversationView). */
export async function openConversation(id: string): Promise<void> {
  setSelectedLoading(true);
  setError(null);
  try {
    const r = await request({ type: 'history-get', id }, HistoryGetResult);
    if (r.ok && r.conversation) setSelected(r.conversation);
    else setError(r.error ?? i18n.t('history.error.notFound'));
  } catch (e) {
    setError(errMsg(e));
  } finally {
    setSelectedLoading(false);
  }
}

/** Return from the replay view to the list. */
export function closeConversation(): void {
  setSelected(null);
}

/** Delete a conversation; also closes the replay view when the deleted entry is open. */
export async function deleteConversation(id: string): Promise<void> {
  setError(null);
  try {
    const r = await request({ type: 'history-delete', id }, OkResult);
    if (!r.ok) {
      setError(r.error ?? i18n.t('history.error.deleteFailed'));
      return;
    }
    setConversations((list) => list.filter((c) => c.id !== id));
    if (selected()?.id === id) setSelected(null);
  } catch (e) {
    setError(errMsg(e));
  }
}

// --- read-only replay rendering (pure, exported for unit coverage) -----------------------------
// A persisted `Conversation.messages` entry is an AI SDK `ModelMessage` — `content` is either a
// plain string or an array of typed parts (text/reasoning/tool-call/tool-result/image/file). The
// replay view only ever displays text, never re-executes a tool or re-renders an image, so this
// flattens each message down to one display line rather than pulling in the full AI SDK part
// types (duck-typed on `type` — forward-compatible with a part kind added later).

export interface ReplayLine {
  role: string;
  text: string;
}

/** Flatten a conversation's message thread into display lines, one per message. */
export function renderConversationMessages(conversation: Conversation): ReplayLine[] {
  return conversation.messages.map((m) => ({ role: m.role, text: renderContent(m.content) }));
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => renderPart(part))
    .filter((line) => line.length > 0)
    .join('\n');
}

function renderPart(part: unknown): string {
  if (typeof part !== 'object' || part === null || !('type' in part)) return '';
  const p = part as { type: unknown; text?: unknown; toolName?: unknown };
  const toolName = typeof p.toolName === 'string' ? p.toolName : 'tool';
  switch (p.type) {
    case 'text':
    case 'reasoning':
      return typeof p.text === 'string' ? p.text : '';
    case 'tool-call':
      return i18n.t('history.replay.toolCall', { tool: toolName });
    case 'tool-result':
      return i18n.t('history.replay.toolResult', { tool: toolName });
    case 'image':
    case 'file':
      return i18n.t('history.replay.imageOmitted');
    default:
      return '';
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
