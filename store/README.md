# Chrome Web Store assets (#26)

Everything the store listing needs, regenerable. The dashboard listing itself is
MANUAL (no API) — paste from `listing-copy.md`, upload from `icons/`,
`screenshots/`, `promo/`.

| Path | What | How produced |
|------|------|--------------|
| `listing-copy.md` | name, short + detailed description, category, permission justifications | authored; paste into the dashboard |
| `icons/` | icon SVG source + PNG set (16/32/48/128/512) | `icon.svg` redrawn from Sebby's pick (Kubeez `gpt-C-cursor`); PNGs rendered via Playwright |
| `screenshots/` | 1280x800 listing screenshots of the design loop | `demo-page.html` + `capture.ts` (loaded-extension Playwright, stub provider — no model key needed) |
| `promo/` | small promo tile 440x280 + marquee 1400x560 | `tile.html` + `render.ts` (Playwright) |

Regenerate: `bun store/screenshots/capture.ts` and `bun store/promo/render.ts`
from the repo root (both need `bun run build` first — the capture loads the
built extension).

The extension's own icons (`src/public/icon/`, `src/public/logo.png` for the
panel header) are the same brand, wired in `wxt.config.ts`.
