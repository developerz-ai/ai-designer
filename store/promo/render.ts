// Renders store/promo/tile.html at the two Chrome Web Store promo-tile sizes.
// Run from the repo root: `bun store/promo/render.ts`.
// Output: promo-440x280.png (small tile) + promo-1400x560.png (marquee), exact pixel dims.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PROMO_DIR = path.dirname(fileURLToPath(import.meta.url));
const TILE = path.join(PROMO_DIR, 'tile.html');

const TARGETS = [
  { width: 440, height: 280, file: 'promo-440x280.png' },
  { width: 1400, height: 560, file: 'promo-1400x560.png' },
] as const;

const browser = await chromium.launch();
try {
  for (const { width, height, file } of TARGETS) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`file://${TILE}`);
    await page.waitForLoadState('load');
    // Screenshot only once the icon <img> has actually decoded — never a fixed sleep.
    await page.waitForFunction(() => {
      const img = document.getElementById('icon');
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
    });
    const out = path.join(PROMO_DIR, file);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`rendered ${out} (${width}x${height})`);
    await page.close();
  }
} finally {
  await browser.close();
}
