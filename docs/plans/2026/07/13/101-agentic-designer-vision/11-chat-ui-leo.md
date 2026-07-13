# 11 — Leo-style chat UI

> Part of [`overview.md`](overview.md). Depends on: 04 (stream), 10 (Icon), 03 (readiness header). World: **side panel only**. Reference: Brave **Leo** — `.codegraph/*.png`. Spec: `docs/idea/ui.md`. Skill: `solid-srp`.

## Why
`ChatPanel.tsx:12-50` is a local echo stub — no streaming, no assistant reply, no tool chips. Rebuild as a real streaming agent chat matching Leo's feel: header actions, inline model selector, page-context chip above the input, suggestion chips, tool-call chips, Ship/Download bar (07). **SRP** — logic lives in stores/`src/agent`, components render + dispatch only.

**Copy Leo's polish, but make it for web developers _and_ vibecoders.** Same clean side-panel calm — but the affordances are dev-shaped, not a generic "ask about this page":
- Suggestion chips are **tasks, not questions**: "Copy nvidia's hero", "Make this match our brand", "Debug this broken filter", "Audit colors/fonts", "Ship to developerz.ai".
- Tool chips speak dev ("`extractIdentity` → 4 colors, 2 fonts", "`setStyle .cta`", "opened reference tab") — legible to a coder, reassuring to a vibecoder who wants to *watch* not micromanage.
- One-click **Download brief / Send to backend** (07) framed as "hand this to your coding agent".
- Vibecoder-friendly: plain-language in, real code out (PR/brief); the agent does the work and shows its reasoning (overlay 09 + tool chips) so non-experts trust it.

## Leo reference (match)
- Header: title + expand/menu/close actions; avatar + "Chat" + model label ("Automatic").
- Suggestion chips ("Summarize this page", "Suggest questions…") when empty.
- **Page-context chip** pinned above the composer (favicon + page title + dismiss) — here it's the current tab / focused element.
- Composer: multiline input, attach, **inline model dropdown**, send.

## Files to change
- `src/entrypoints/sidepanel/stores/chat.ts` — **new**. `chatStore`: messages, streaming assembly from `SwToPanel` `token`/`tool-call`/`edit-recorded`/`error`/`turn-done` (via `sw-stream.ts`); `send(text)` → `user-message` over the bus (replaces the `ChatPanel` TODO at `:21-22`). Thin; SW is truth.
- `src/entrypoints/sidepanel/components/ChatPanel.tsx` + `.scss` — **rebuild**. Compose the subcomponents below; subscribe to `chatStore`. No business logic.
- `components/chat/Thread.tsx` + `.scss` — **new**. Message list + streaming token render (`ui.md:29`).
- `components/chat/Message.tsx` + `.scss` — **new**. One message (user/assistant/system) with markdown render (bundled renderer, no remote).
- `components/chat/ToolChip.tsx` + `.scss` — **new**. One tool call: name + status (running/done/error) + expandable args/result (`ui.md:30`), FontAwesome status icon.
- `components/chat/Composer.tsx` + `.scss` — **new**. Input + send + inline model picker (from settings/readiness) + attach; Enter-to-send, Shift+Enter newline.
- `components/chat/ContextChip.tsx` + `.scss` — **new**. Current tab / focused element chip above composer (from `stores/focus.ts`), dismissable.
- `components/chat/SuggestionChips.tsx` + `.scss` — **new**. Empty-state prompts tuned to the modes: "Copy nvidia's hero", "Make this like …", "Debug this feature".
- `components/chat/EmptyState.tsx` + `.scss` — **new**. Pre-first-message state (after Start).
- Integrate `ShipBar` + `TaskTimeline` (07) at the thread foot.

## Steps
1. `chat.ts` store: wire `sw-stream` events → message/tool-chip assembly; `send` over bus; abort/stop control.
2. Build the subcomponents (one `.tsx` + `.scss` each, SRP), all icons via `Icon` (10), all color/spacing via tokens.
3. Rebuild `ChatPanel` as pure composition subscribing to `chatStore` + `focusStore` + `readinessStore`.
4. Match Leo: header actions, context chip, suggestions, inline model picker.
5. Streaming UX: token-by-token render, tool chips update in place, error surfaced inline, Ship/Download at foot.

## Tests
- Unit: `chatStore` assembly (tokens accumulate; tool-call → chip; error state); `send` dispatches `user-message`; `ToolChip`/`Message`/`ContextChip` render states.
- Integration: mocked `SwToPanel` stream → Thread renders streamed assistant text + a ToolChip that transitions running→done.
- E2E: after Start, type an instruction → assistant streams, tool chips appear, context chip shows the page, Ship/Download visible.
- `bun run typecheck`, `bun run lint`.

## Done when
- Chat streams real agent output with live tool-call chips, page-context chip, suggestions, and inline model selector — Leo-like.
- Every component is SRP (one `.tsx` + `.scss`, no logic); icons from `Icon`, styles from tokens. Gate green.
