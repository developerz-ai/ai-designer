# Using debug mode

Find and fix a bug on the live page — layout, visual, or interaction.

## When to use it

Something's broken and you can point at it: a button that doesn't respond, an overlapping layout on mobile, a chart not rendering, a console error you've seen but not traced. Debug mode drives the observe → reproduce → confirm → fix loop for you.

## How to start it

Describe the bug directly: "the mobile nav doesn't close when you tap outside it" — the agent infers debug mode from the instruction (there is no mode-picker UI).

## What happens, step by step

1. **Diagnostics first** — drains buffered console errors, network failures, accessibility issues, layout problems already observed on the page.
2. **Observe → hypothesize** — reads the DOM, computed styles, accessibility tree around the reported area.
3. **Reproduce** — drives the page like a user would (click, type, scroll, resize) to trigger the bug live.
4. **Capture** — screenshots / snapshots the broken state, checks responsive breakpoints if relevant.
5. **Confirm** — a vision pass verifies what it captured actually matches the described symptom, not a false positive.
6. **Root-cause + fix** — proposes and applies the smallest fix, then re-drives the repro to confirm it's resolved.

## What comes out

Beyond the live-edited page, debug mode produces a structured **Report** — findings, severity, root cause, before/after screenshots. This report is what a fix ships with, or what downloads as a Markdown brief if there's no connected backend. See [Ship or report](ship-or-report.md).

## What it's good for

- Visual/layout bugs: overlap, overflow, broken responsive breakpoints, image sizing.
- Interaction bugs: a control that doesn't fire, a modal that doesn't close, a form that doesn't validate.
- Cross-checking a bug across viewport sizes without you resizing the window by hand.

## What it won't do

- Fix backend/server-side bugs — the agent only sees and mutates the rendered page in your browser.
- Guess silently — genuinely ambiguous bugs get a clarifying question in chat instead of a blind fix.
- Auto-ship the fix — you still review and click Ship/Download.

## Tips

- The more specific the repro steps you give ("click the filter icon, then scroll down"), the faster it reproduces — but a bare description works too, it will explore.
- If it can't reproduce, it says so and reports what it tried — that's useful signal on its own (maybe it's environment-specific).
- Findings with low-confidence selectors are flagged "fragile" in the report; the dev-agent on the other end treats those as lower-confidence and prefers other hints when mapping to source.
