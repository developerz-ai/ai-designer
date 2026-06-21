---
name: solid-srp
description: SolidJS + single-responsibility conventions for the side-panel UI — one component per file with co-located SCSS, thin stores, no logic in components. Use when creating or editing anything under src/entrypoints/sidepanel, Solid components, signals/stores, or SCSS.
---

UI is SolidJS in the side panel. See root `CLAUDE.md` and `docs/idea/ui.md`.

## Component rules

- **One component = one `.tsx` + one co-located `.scss`**, same basename (`ChatPanel.tsx` + `ChatPanel.scss`).
- **NO business logic in components.** Components render + dispatch only. Logic lives in `src/agent/`, `src/dom/`, `src/mcp/`, `src/changeset/`.
- Split a file the moment it does two things. Small files.

## State

- Signals/stores: `createSignal`, `createStore`. NEVER prop-drill more than one level — lift to a store.
- Derive with `createMemo`. Side effects in `createEffect`. No manual DOM in components.
- Panel stores are **thin reflections** of service-worker state, synced over the bus — the SW is the source of truth, not the panel.

## SCSS

- Co-located; scope to a root class (`.chat-panel { ... }`), BEM-ish for children.
- Tokens (color/spacing/radius) in `src/styles/_tokens.scss`. NEVER hardcode a hex/px that's a token.

## Checklist before done

- New component has its `.scss` and is scoped.
- No logic leaked into the component.
- `bun run lint` + `bun run typecheck` clean.
