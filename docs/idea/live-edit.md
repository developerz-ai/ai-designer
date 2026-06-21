# Live edit

How the agent changes the page you're looking at in real time — and how those changes become a portable changeset. All edits are **ephemeral**: they live in the page until reload, never on the server.

## The element picker

- Hover → highlight overlay with tag, dims, and the resolved stable selector.
- Click → element becomes the chat's focus ("this"). Agent edits target it.
- Shift-select → multiple elements (e.g. "make all these cards equal height").

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
  "edits": [
    {
      "intent": "Make the primary CTA orange and larger",
      "selector": { "value": "[data-testid=cta-primary]", "strategy": "data-attr", "fragile": false },
      "changes": [
        { "prop": "background-color", "before": "#2563eb", "after": "#f97316" },
        { "prop": "padding", "before": "8px 16px", "after": "12px 24px" }
      ],
      "screenshots": { "before": "blob:...", "after": "blob:..." },
      "frameworkHints": ["react", "tailwind: bg-blue-600 px-4 py-2"]
    }
  ]
}
```

`frameworkHints` is the bridge: Tailwind classes, CSS-module names, or styled-components markers tell the dev-agent *where in source* the value lives. See [handoff.md](handoff.md).

## Undo / redo

- Recorder is an event log → undo = pop + invert.
- Reload = full reset (edits never persisted).
- "Clear session" wipes the changeset.
