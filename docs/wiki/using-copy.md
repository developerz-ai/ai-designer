# Using copy mode

Match a reference site's look on the page you're editing.

## When to use it

You have a page open (your app, staging, prod) and a reference you like elsewhere — a competitor, a design you admire, your own marketing site. Copy mode reads the reference's design identity and applies it to your page, without you describing colors/fonts by hand.

## How to start it

Just say "make this page look like stripe.com's pricing section" — the agent infers copy mode from the instruction (there is no mode-picker UI; the empty-state suggestion chips seed copy-flavored prompts).

## What happens, step by step

1. **Browse** — opens the reference URL in an inactive background tab (your active tab is untouched), snapshots it, closes the tab.
2. **Extract identity** — pulls a role-tagged palette (background/foreground/accent/border), type scale (families/sizes/weights), spacing, radius, shadow from the reference.
3. **Apply** — sets styles on your page to match: colors, type, spacing tokens.
4. **Check responsive** — verifies the result across breakpoints, flags anything that breaks on mobile/tablet.
5. **Screenshot + self-correct** — the agent looks at its own result and adjusts before finishing.

Every step is a recorded, reversible edit — nothing is final until you [ship or download](ship-or-report.md).

## What it's good for

- Bringing a new marketing page in line with an existing brand.
- Prototyping a rebrand against a real competitor's palette/type.
- Fixing "this page looks dated" without hand-picking hex codes.

## What it won't do

- Copy layout/markup structure — it copies visual identity (color, type, spacing), not a competitor's HTML/CSS wholesale.
- Touch the reference site — `browse` is read-only, opens a background tab, and always closes it, even on error.
- Send anything about the reference site anywhere except your chosen model — see [Privacy & keys](privacy-keys.md).

## Tips

- Point it at a specific section ("copy the hero section of X") for a tighter, more predictable result than a whole homepage.
- Follow up in the same turn/thread: "now make the CTA bigger" — it's still your live conversation, copy mode doesn't lock you out of plain instructions.
- If a selector comes back "fragile" (shown in the chat), the applied change still works live but may need more context at ship time — see [Ship or report](ship-or-report.md).
