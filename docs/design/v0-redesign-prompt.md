# v0 prompt — Designer side panel redesign

Paste everything below the line into v0. Reference image to attach: the Brave Leo side-panel screenshot.

---

# Redesign a Chrome extension side panel: "Designer"

You are designing the complete UI for a Chrome MV3 extension side panel. I will port your output to SolidJS + SCSS by hand, so optimise for **clarity of structure and styling**, not for React cleverness.

## What the product is

Designer is an AI agent that lives in a Chrome side panel. The user chats with it about the web page currently open in the tab next to the panel. The agent **edits that live page in real time** — changes DOM, CSS, copy, layout — and every edit is recorded into a "changeset". When the user is happy, they hit **Ship**: the changeset is handed to a backend coding agent that opens a real pull request against the site's source code. If no backend is connected, Ship instead downloads a Markdown brief the user can paste into any coding agent.

So the mental model is: **talk → the page changes in front of you → ship the change as real code.**

The user is a designer, PM, or developer doing quick design iteration on a real site. They are looking at the page, not the panel. The panel must be calm, dense, and never steal attention from the page it is editing.

## Hard constraints — non-negotiable

1. **Width is fixed at 360 CSS px.** Chrome pins the side panel to 360px as both the default AND the minimum, and an extension cannot change it. Every layout must work at exactly 360px. Never design for a wider viewport. Assume height ~700–900px.
2. **Dark theme only.** No light mode.
3. **No component libraries.** No shadcn/ui, no Radix, no MUI, no Headless UI. Plain elements + Tailwind utility classes only. I am porting to hand-written SCSS, so every shadcn import is work I have to undo.
4. **No icon packages.** Use inline `<svg>` elements written directly in the markup. Keep them simple, 16px, `stroke="currentColor"` or `fill="currentColor"`.
5. **No images, no external fonts, no network requests.** The extension runs under a strict CSP. System font stack only.
6. **No animation libraries.** CSS transitions only, and every one of them must sit behind `@media (prefers-reduced-motion: reduce)`.

## Design tokens — use these exact values

Emit them as CSS custom properties on `:root` and reference them by `var()` in your Tailwind arbitrary values (e.g. `bg-[var(--dz-elev-card)]`). Do not invent new colors; if you need one, derive it from these and tell me.

```css
/* Brand */
--dz-accent:        #f97316;  /* orange — our brand, NOT Leo's violet */
--dz-accent-fg:     #1a1205;  /* text on an accent surface */

/* Elevation — opaque surfaces, never stacked alpha washes */
--dz-elev-base:     #0f1115;  /* page / panel background */
--dz-elev-card:     #171a21;  /* cards, menus, composer shell, message bubbles */
--dz-elev-hover:    #1f232c;  /* hovered / selected row on top of a card */
--dz-elev-inset:    #0b0d11;  /* recessed wells — code blocks, tracks, empty slots */

/* Foreground ramp — long-form prose is NOT the brightest value */
--dz-fg-strong:     #edeff2;  /* titles, bold runs inside prose */
--dz-fg:            #e6e8eb;  /* default UI text */
--dz-fg-body:       #c9cdd4;  /* long-form prose, message bodies */
--dz-fg-muted:      #8b909a;  /* captions, meta, placeholders */

/* Borders */
--dz-border-subtle: #232733;  /* outlines a control that already has visible text/icon */
--dz-border-strong: #6b7285;  /* when the border IS the only affordance (WCAG 1.4.11) */

/* Interaction washes — translucent so they compose over any elevation */
--dz-wash-hover:    rgba(255,255,255,.06);
--dz-wash-active:   rgba(255,255,255,.10);
--dz-scrim:         rgba(0,0,0,.55);

/* Status */
--dz-status-connected: #22c55e;
--dz-status-warning:   #fbbf24;
--dz-status-error:     #ff6b6b;
```

**Scales.** Radius 4 / 6 / 10 / 12 / 16 / 9999px. Spacing 4 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32px. Font sizes 11 / 12 / 13 / 14 / 15 / 17px. Line heights 1.25 (titles), 1.4 (dense UI), 1.55 (prose). Font weights 400 / 500 / 600 — **never 700**. Control heights: 28 / 32 / 40px only, and every interactive target must present at least a 44px pointer area (pad it out invisibly if the control is visually smaller). Focus ring: 2px `--dz-accent`, 2px offset, on every interactive element.

## Visual reference — Brave's Leo panel (attached screenshot)

Steal Leo's **density, rhythm, elevation and restraint**. Specifically:

- The quiet single-line header with a title and small controls, one hairline beneath it — never a heavy toolbar.
- The intro state: left-aligned avatar, title, a muted meta line, then **full-width left-aligned action rows** with a leading glyph. Not centred hero text, not wrapped pill chips.
- The composer at the foot: one rounded shell that owns the border and the focus treatment, a chrome-less textarea inside it, and a toolbar row along the bottom of the same shell holding small quiet controls on the left and one circular send button on the right.
- The context chip sitting directly above the composer showing what the conversation is currently attached to.
- Generous 16px panel gutters, tight vertical rhythm inside cards.

Do **not** steal: Leo's violet accent (we are orange), and absolutely nothing resembling that giant purple "Unleash Leo's full powers with Premium" upsell card. We have no upsell. That card is in the screenshot only because it happened to be on screen — treat it as an example of what NOT to build.

## The three problems you are being hired to fix

### 1. Element referencing is weak

Today the user clicks a picker button, then clicks one element on the page, and gets **one** chip above the composer showing a CSS selector string like `.hero > div:nth-child(2) · css path`. That's it. One element, and the chip shows a developer selector rather than something a human recognises.

Design a much better version, modelled on how Cursor lets you attach files to a chat:

- **On the page**: a labelled rectangle drawn around the referenced element — a 2px accent border, a faint accent fill, and a small floating label badge at a corner reading something like `[1] <section.hero>`. Design the hover state (element under the cursor, before it is picked) as visually distinct from the pinned state (element already attached to the conversation). Also design a "fragile selector" warning variant, for when the element can only be located by a brittle path that may not survive a page change. Mock these as a separate frame showing a fake web page with elements outlined.
- **In the panel**: **multiple** element references at once, as a wrapping row of compact removable chips above the composer. Each chip shows a **human-readable** name — `Hero heading`, `Nav`, `Pricing card 2` — with the raw selector available on hover/expand, not as the primary label. Each chip carries the same `[1] [2] [3]` index that its rectangle shows on the page, so panel and page stay tied together. Each chip has a dismiss affordance and a hover state that highlights its rectangle on the page.
- Design the **empty**, **picking…** (user is actively hovering elements on the page), **one reference**, and **five references** states. Five chips must not blow out the 360px width or push the composer off screen — decide whether they wrap, scroll horizontally, or collapse to `3 elements ⌄`, and show me your choice.
- Also design an inline `@`-mention affordance in the composer: typing `@` opens a small menu of recently referenced elements so the user can reference one without leaving the keyboard.

### 2. Too many scrollbars

The panel currently shows visible scrollbars in several nested regions at once, which reads as broken and cheap. Leo shows none.

Enforce a **single-scroller contract**: exactly one scroll region per screen. On the chat screen, only the message thread scrolls; the header, tab strip, element chips, and composer are all fixed and never move. Scrollbars must be **overlay-style and near-invisible** — thin, transparent track, thumb only on hover, and the layout must not shift when they appear. Nothing may nest a scroll region inside another scroll region. If a card's content is too tall, it truncates with a "show more" disclosure rather than growing its own scrollbar.

### 3. It reads like a dev tool, not a product

The current panel is honest but raw: it exposes CSS selectors, tool names like `mutateElement`, and raw token counts. Keep all of that information — it is genuinely useful and the users are technical — but restage it so the **default view is calm and human**, with the raw detail one disclosure away. Simple, professional, quiet. No gradients, no glow, no glassmorphism, no decorative illustration.

## Every screen and component to design

The panel is a header + a tab strip + one of five surfaces. Design all of it.

### Shell

**Header** — 40px tall, one hairline beneath. Left: a 16px logo square, then the title `Designer`. Right: a **readiness pill** and a **Start/Stop button**.

**Readiness pill** — a small status pill, the loudest single element in the panel. Collapsed it shows an icon plus one of three labels: `Ready` (green check), `Setup needed` (amber warning), `Running…` (green check — a live session is a state, not a spinner). Clicking it opens a dropdown panel listing seven check rows, each with a status glyph, a label, an optional detail line **stacked below the label** (never beside it — at 360px the detail wins the width fight and truncates the label), and, when failing, a right-aligned `Fix →` link. The rows are: `AI provider`, `Model`, `API key` (may read `not required` for a local endpoint), `Host permission`, `Page access` (its fix button is `Grant`, an in-place permission prompt, not a navigation), `MCP backend` (detail: `2 of 3 connected`). Below the rows sits an eighth row that is a **toggle switch**, not a check: `On-page overlay · On/Off`. An error line can appear at the bottom of the dropdown. Design the pill in all three states and the dropdown open, with a mix of passing and failing rows.

**Start/Stop button** — sits beside the pill. Reads `Start` when idle or stopped, `Stop` while running. Disabled when the panel is not ready.

**Tab strip** — five route-like destinations directly under the header: `Chat` (text), a diff/changeset tab (**icon only**), `MCP` (text), a history tab (**icon only**), `Settings` (text). Mixed text and icon tabs at 360px is the real constraint — solve it convincingly. Show active and inactive states.

### Surface 1 — Chat (the primary surface, spend most of your effort here)

**Pre-start screen** — shown before the session starts. Two variants: (a) not configured yet → headline plus a primary `Open settings` button; (b) configured → headline plus a primary `Start` button.

**Empty state** — shown after starting, before the first message. Follows Leo's intro: a 24px agent avatar, the title `Tell the agent what to build`, a muted meta line reading `Automatic ⓘ` (mode is inferred from the message text — there is nothing to pick, the ⓘ is explanatory only), a subtitle `It edits this page live — pin an element with the picker for context, or start with one of these:`, then three full-width left-aligned suggestion rows, each with a leading glyph: `Copy nvidia's hero`, a debug-a-filter row, and a ship row.

**Message thread** — the one scroll region. Two roles:

- **User turn**: plain text, right-leaning or subtly boxed, compact. It is an instruction, not prose. May carry the element reference chips that were attached when it was sent — design that.
- **Assistant turn**: unboxed markdown prose at 15px, line-height 1.55, body text at `--dz-fg-body` with bold runs stepping up to `--dz-fg-strong`. Must style: paragraphs, `h1`–`h3`, bullet and numbered lists, inline `code`, fenced code blocks (recessed well, `--dz-elev-inset`, horizontally scrollable, mono), links, and blockquotes. Long selectors and URLs must wrap rather than widen the panel.

**Streaming state** — the assistant turn is being generated token by token. Design the in-flight indicator.

**Tool call chips** — under an assistant turn, a list of what the agent actually did. Each chip: a status glyph (`running` spinner / `done` check / `error` warning), the tool name in mono (`mutateElement`, `extractIdentity`, `screenshot`, `inspectVisually`), an optional kind badge (`read` / `act` / `info`), and an optional one-line summary (`extractIdentity → 4 colors`). Chips that carry a selector are expandable, revealing the raw selector in mono below. A single turn commonly fires **6–12 of these**, so design both the individual chip and how a long run collapses — a group header like `12 actions ⌄` that expands, with the currently-running one always visible, is the sort of thing I'm after. This is the densest, ugliest part of the current UI; it matters most.

**Edits summary** — a line under a turn: a check glyph plus `4 edits recorded`.

**Turn error** — a warning glyph plus an error message, inside the turn.

**Task timeline** — appears after Ship. An ordered list of backend tasks, one row each: a stage glyph, the task title, a status word (`queued` → `working` → `pr_open` → `ci_green` / `ci_red`, or `error`), an optional `2 of 3` counter, an optional error line, and, once open, a `View PR ↗` link. Design at least the `working` and `pr_open` rows.

**Ship bar** — docked above the composer once a thread exists. A primary `Ship` button (with a spinner state while shipping), a ghost `Download brief` button, and a ghost `Send to… ⌄` split button that opens a menu of connected backends. Below it, three conditional strips: a fallback hint (`Shipped as a report instead: <reason>`), an inline "map this origin to a repo" mini-form (a repo field, an optional backend field, an optional branch field, and a `Map and ship` button), and an error line. Three buttons plus a menu at 360px is tight — solve it.

**Usage meter** — a small muted line: `Usage · 7 steps · ~48.2k tokens`. Hidden until the first turn has spent something. Never shows a dollar figure (the user brings their own API key, so there is no universal price).

**Composer** — always docked at the foot, never scrolls away. One rounded shell (16px radius) owning the border and the focus ring, containing:
- the element reference chips row above it (see problem 1),
- a chrome-less auto-growing textarea, placeholder `Tell the agent what to change…`, growing from 1 row to a capped max (design the cap) before it scrolls internally,
- a bottom toolbar inside the same shell: on the left a **picker/attach** toggle button (has a pressed/active state while picking) and a **model quick-switch** rendered as quiet *text* with a chevron (`glm-4.6 ⌄`) — not a bordered box, since a second border inside the shell reads as a nested field; on the right, **one** circular 32px button that changes identity: accent-filled up-arrow `Send` when idle, and a `Stop` square/× while a turn streams. One button, never two side by side.
- a small keyboard hint (`Enter to send, Shift+Enter for a new line`).

The **model menu** opens upward from the text trigger: a card listing model ids with the current one check-marked. Can hold ~300 entries, so it needs a search field and a scrollable list — this is a legitimate exception to the single-scroller rule because it is a popover, not a page region.

### Surface 2 — Changeset / Diff

A curated list of recorded edits, one card per edit, grouped by kind: `Classes`, `Structural`, `Text`, `Framework`, `Breakpoint`. Each card shows the target element, before → after values (design the before/after treatment — this is the most information-dense card in the app), and a remove affordance. Above the list: `Undo`, `Redo`, and a `Clear session` button that requires **two clicks** — the first arms it and changes its label, and it disarms itself after a few seconds. All mutating controls are disabled while a turn is streaming. Design the empty state (`No edits recorded yet`) and a list with ~6 edits across three kinds.

### Surface 3 — MCP backends

A list of backend server cards: label, URL, a status dot (`connected` green / `connecting` amber / `error` red / `disconnected` grey), and connect/disconnect/remove actions. An `Add server` form. A row of quick-add preset buttons. An **auth dialog** as a modal over a scrim, offering two credential paths: an API key field, or an OAuth flow with fields for authorization endpoint, token endpoint, client ID, and an optional scope (placeholder `mcp:tools`). Also an **origin → repo mapping** section: a list of `example.com → acme/website` rows plus a form with repository, optional backend, and optional branch fields.

### Surface 4 — History

The last 10 design sessions as a ring buffer. Each row: a favicon, the page title, the origin, a relative date, a badge showing edit count, and a delete affordance. Clicking a row opens a **read-only conversation replay** — the same thread rendering as Chat, but with no composer and a back affordance. Design both the list and the replay header.

### Surface 5 — Settings

A provider section: a preset dropdown (`OpenRouter` / `OpenAI` / `Custom`), a base URL field (only shown for Custom), a password-style API key field whose placeholder reflects **presence** rather than value (`•••• saved` vs `Paste your key`), and a `Model` control that is a **searchable free-text combobox** — the user must be able to type or paste a model id the endpoint never listed, while also filtering a fetched list of ~300. Design the combobox closed, open with a filtered list, and with a pasted-unknown value. Beside it a `Refresh` button. Below: a save button with `idle` / `saving` / `valid` / `invalid` states and an error line. Then an About section of static outbound links, and a link to re-open onboarding.

### Overlays

**Onboarding** — a three-step first-run guide over a scrim: `Add your AI provider`, `Connect a backend`, `Make your first edit`. Progress indicator, back/next/skip.

**On-page agent overlay** — the extension can draw an overlay on the *web page* (not the panel) narrating what the agent is doing right now: which element it is touching and which step it is on. Design this as a page-level element, distinct from the reference rectangles of problem 1 but visually consistent with them. Mock it over a fake web page.

## What to deliver

1. **One self-contained React file** (`app.tsx`), default-exported, no props, no external imports beyond React itself. It renders **every state listed above stacked vertically on one page**, each inside a 360px-wide bordered frame with a small caption naming the state (`Chat — streaming, 8 tool calls`). I want to see them all at once, not click through a prototype. Use local `useState` only where a state genuinely needs to be interactive (menus, expanders) — everything else should be static markup driven by literal props so I can read the structure.
2. The page-level mocks (reference rectangles, on-page overlay) rendered in a wider frame containing a crude fake web page.
3. A `:root` block with the CSS custom properties, plus any tokens you added, called out explicitly.
4. A short list at the bottom of the file, in a comment, of **the specific decisions you made where the constraints forced a trade-off** — how five element chips fit at 360px, how twelve tool chips collapse, how three ship buttons plus a menu fit on one row, how the mixed text/icon tab strip resolves. One line each. This is the part I care most about.

Prioritise, in order: the Chat surface, the element referencing system, the tool-call chips, the composer. The other four surfaces can be less polished if you run out of room.
