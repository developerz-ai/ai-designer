import { defineContentScript } from '#imports';
import { serveBridge } from '@/dom/bridge';
import { extractCharts } from '@/dom/charts';
import { detectFacts } from '@/dom/page-facts';

// MAIN-world bridge server (slice 15F) — the ONLY world that can read the page's own JS (framework
// internals, chart-lib instances). It answers a NARROW, READ-ONLY RPC from the isolated content world
// over an origin + nonce-guarded `window.postMessage` channel (`src/dom/bridge.ts`), serving two
// methods: `page-facts` (framework/lib detection) and `chart-data` (series extracted from the page's
// own chart-lib instances — slice 15E). It NEVER receives or returns a key/token — MAIN == the page's
// own, untrusted world (CLAUDE.md "MV3 three worlds", docs/architecture/security.md). All logic lives
// in the jsdom-tested src/dom modules; this entrypoint (coverage-excluded) stays a thin wire.
//
// WXT emits this as a `"world": "MAIN"` content script in the manifest from the `world` option below
// (no manual wxt.config registration needed), injected into every frame beside the isolated
// content.ts so each frame's content client talks to its own frame's MAIN server.
export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_idle',
  allFrames: true,
  matchAboutBlank: true,
  main() {
    serveBridge({
      'page-facts': () => detectFacts(window, document),
      'chart-data': () => ({ charts: extractCharts(window, document) }),
    });
  },
});
