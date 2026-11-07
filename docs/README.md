# developerz-ai/ai-designer — docs

> Index — established by dz-runner setup mode. Add a line when you add a page.

| Where | What lives there |
|---|---|
| [`idea/`](idea/README.md) | Why this repository is shaped the way it is: the product idea, the architecture, the principles a change is weighed against. |
| [`architecture/`](architecture/README.md) | How it is built: components, MV3 worlds, agent loop, changeset, handoff, security, and the ADRs. |
| [`wiki/`](wiki/README.md) | User guide: install, copy and debug modes, ship-or-report, history, privacy and keys. |
| [`reference/agent-sdk.md`](reference/agent-sdk.md) | AI SDK 7 API reference — `ToolLoopAgent`, OpenRouter, MCP, version gotchas. |
| [`plans/`](plans/2026/07/13/101-agentic-designer-vision/) | **Superseded** historical plan: its 16 slices shipped as PRs #71–#105 and its tracking fields were never maintained after kickoff (`status.yml`: `superseded`). Kept for the design rationale — not a live roadmap. One directory link; GitHub renders the slice listing. |
| [`design/v0-redesign-prompt.md`](design/v0-redesign-prompt.md) | The prompt the side-panel UI was redesigned from. `design/designer/` is the generated v0 sandbox, not documentation. |
| [`roadmap-note.md`](roadmap-note.md) | WIP reference for the shipped-master-plan threshold landmarks — v0 shipped-state pointer, v1/v2 next. |
| [`store/LISTING.md`](store/LISTING.md) | The Chrome Web Store listing, paste-ready in dashboard order. |
| [`RELEASING.md`](RELEASING.md) | How a tag becomes a signed build and a GitHub Release. |
| [`STORE-SETUP.md`](STORE-SETUP.md) | Store accounts, the secrets CI needs to publish, and who clicks what. |

The brain itself is the repo root's [`CLAUDE.md`](../CLAUDE.md) — and its pointer
[`AGENTS.md`](../AGENTS.md), the name other agents look for first; the commands are
`bin/{setup,dev,check,stop}`.
