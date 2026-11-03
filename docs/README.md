# developerz-ai/ai-designer — docs

> Index — established by dz-runner setup mode. Add a line when you add a page.

| Where | What lives there |
|---|---|
| [`idea/`](idea/) | Why this repository is shaped the way it is: the product idea, the architecture, the principles a change is weighed against. |
| [`design/`](design/) | Design sandbox — the v0 side-panel redesign source: `v0-redesign-prompt.md` (the brief) + `designer/` (a standalone Next.js prototype). Not the shipped UI: the extension ships `src/entrypoints/sidepanel/`, and the shipped SCSS cites the prototype as its design reference. Excluded from the extension build and from Biome; Dependabot tracks its npm deps. |
| [`standards/`](standards/) | How work is done here: the rules a change follows, and for each rule the check that enforces it. *(not created yet)* |

The brain itself is the repo root's [`CLAUDE.md`](../CLAUDE.md); the
commands are `bin/{setup,dev,check,stop}`.
