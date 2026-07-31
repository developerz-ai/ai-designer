# Live edit

How the agent changes the page you're looking at in real time — and how those changes become a portable changeset. All edits are **ephemeral**: they live in the page until reload, never on the server.

## The element picker

Two ways in. Both end at the same place: the clicked element becomes the chat's focus ("this"),
and the next instruction is grounded in its selector so the agent never has to guess the referent.

**Armed** — the composer's attach button starts it; the page is in picking mode until Escape.

- Hover → highlight overlay with tag, dims, and the resolved stable selector.
- Click → element becomes the chat's focus ("this"). Agent edits target it.
- Shift-select → multiple elements (e.g. "make all these cards equal height").

**Quick pick** — no mode to enter, for when you are already looking at the thing.

- Hold **Alt** (or **Ctrl**) → the element under the pointer highlights, with the same pill.
- Click while held → pinned as context, confirmed by a flash on the page and a chip in the panel.
- Release → the highlight goes.

Ctrl is accepted because it is the chord people reach for, but not unconditionally: on a **link**
Ctrl+click stays "open in a new tab", and on **macOS** it is a right-click, so Alt is the universal
one. Highlighting is armed by either — it intercepts nothing.

### What the agent receives

The pin travels as the ranked stable-selector candidates **plus the element's absolute XPath**.
The lead candidate is the most *stable* selector, which for an unremarkable element can be a bare
tag (`h1`) that matches several nodes; the XPath is unique by construction, so the grounding line
carries both and tells the model it may pass the XPath as a selector when the CSS one is ambiguous.
Every DOM tool accepts an XPath wherever it takes a selector (a CSS selector can never begin with
`/`, which is what lets one field carry either). XPath is deliberately *not* a seventh
`StableSelector` strategy: those values must all be legal `querySelector` arguments.

## Mutation primitives

The content script exposes a small, safe set the agent drives via tools (see [agent.md](agent.md)):

| Primitive | Does |
|-----------|------|
| `setStyle` | Apply CSS props to a selector (via an injected `<style>`, not inline — reversible). |
| `setText` / `setAttr` | Change text content or attributes. |
| `addClass` / `removeClass` | Toggle classes. |
| `insertNode` / `moveNode` / `removeNode` | Structural edits, clipboard-tracked for undo. |
| `injectCss` | Page-scoped stylesheet for broad rules. |
| `setViewport` | Resize to test responsive breakpoints. |

Every primitive is **reversible** and emits a recorder event.

## Stable selectors

Brittle selectors break the handoff. Resolution order:

1. `data-testid` / `data-*` stable attrs
2. `id` (if not generated/hashed)
3. ARIA role + accessible name
4. Unique text content
5. Scoped CSS path (last resort, flagged "fragile" in the changeset)

The dev-agent gets the selector **plus** the heuristics used, so it can find the same element in source even if the runtime DOM differs.

## Capture

Per accepted edit, the recorder snapshots:

- **Selector** (+ resolution strategy, fragility flag)
- **Before / after computed styles** (only the props that changed)
- **Before / after screenshots** (element crop + viewport context)
- **DOM context** — tag, nearby landmarks, framework hints (React/Vue/Solid markers, class-name patterns)
- **Intent** — the user's words for *why* ("make CTA pop", not just `color: #f60`)

## The changeset

An ordered list of recorded edits = one design session's diff.

```jsonc
{
  "url": "http://localhost:3000/pricing",
  "createdAt": "2026-06-21T12:00:00Z",
  "sessionId": "a3e1c9f2-6b7d-4e8a-9c01-5f2d3b4a6e70",
  "edits": [
    {
      "intent": "Make the primary CTA orange and larger",
      "selector": { "value": "[data-testid=cta-primary]", "strategy": "data-attr", "fragile": false },
      "changes": [
        { "prop": "background-color", "before": "#2563eb", "after": "#f97316" },
        { "prop": "padding", "before": "8px 16px", "after": "12px 24px" }
      ],
      // Attribute + class deltas (#139). null = the attribute was absent / is removed.
      "attrs": [{ "name": "href", "before": null, "after": "/buy" }],
      "classes": [{ "name": "btn-primary", "op": "add" }],
      // One structural op (#58), only on insertNode/moveNode/removeNode edits.
      "structural": { "op": "insert", "html": "<div class=\"banner\">…</div>", "position": "beforeend" },
      "text": { "before": "Buy", "after": "Buy now" },
      "screenshots": { "before": "blob:...", "after": "blob:..." },
      "frameworkHints": ["react", "tailwind: bg-blue-600 px-4 py-2"],
      // Only when the edit was made under device emulation.
      "breakpoint": "iphone-se"
    }
  ]
}
```

`frameworkHints` is the bridge: Tailwind classes, CSS-module names, or styled-components markers tell the dev-agent *where in source* the value lives. See [handoff.md](handoff.md).

## Undo / redo

- Recorder is an event log → undo = pop + invert.
- Reload = full reset (edits never persisted).
- "Clear session" wipes the changeset.
