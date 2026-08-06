import { createSignal } from 'solid-js';

// Which surface the panel is showing. A store rather than a signal in App.tsx, for one concrete
// reason: `ShipBar` — two levels below App (App → ChatPanel → ShipBar) — carries the "4 edits ›"
// chip that opens the changeset, and threading a callback down two components is the prop-drilling
// CLAUDE.md forbids. Owning the type here also breaks the cycle `TabBar`/`ReadinessDropdown` used
// to work around by re-declaring it locally: a store is imported by App, never the other way.
export type Tab = 'chat' | 'diff' | 'mcp' | 'history' | 'settings';

// Deliberately NOT persisted. Chat is the app; a panel reopened onto the Settings surface because
// that is where you happened to be last week is a worse default than the conversation.
const [tab, setTab] = createSignal<Tab>('chat');

export { setTab, tab };
