import { defineUnlistedScript } from '#imports';
import {
  type EncodeRequest,
  runEncodeRequest,
} from '@/entrypoints/sidepanel/lib/image-encode-protocol';

// The image encoder, off the main thread. Transport only — the encode lives in
// `sidepanel/lib/image-encode.ts` and the wire in `sidepanel/lib/image-encode-protocol.ts`.
//
// WHY A WORKER: `createImageBitmap` and `OffscreenCanvas.convertToBlob` are genuinely async, but
// `drawImage` is not. Rasterizing a 20MP phone photo into the 1600×1200 box is real main-thread
// work, and the interaction this feature is FOR — drop six mockups on the composer at once —
// bursts six of them. In a panel Chrome pins to ~360px that reads as the whole panel freezing at
// the moment the user is handing us their design.
//
// WHY A WXT ENTRYPOINT rather than `new Worker(new URL('./x.ts', import.meta.url))`, the form
// every Vite tutorial shows: that form CANNOT WORK under WXT, and fails silently.
// `wxt/dist/core/builders/vite/plugins/defineImportMeta.mjs` sets Vite's
// `define: { 'import.meta.url': 'self.location.href' }` for every build (it is what stops the
// background service worker crashing on `document.location`). Vite registers `vite:define` BEFORE
// `vite:worker-import-meta-url` (`resolvePlugins`, vite/dist/node/chunks/config.js), and the
// worker plugin's transform filter is the literal regex
// `/new\s+(?:Worker|SharedWorker)\s*\(\s*new\s+URL.+?import\.meta\.url/s`. By the time it runs,
// `import.meta.url` is gone, nothing matches, no worker chunk is emitted, and the `.ts` specifier
// is left verbatim in the bundle — a 404 at runtime, silently swallowed by the client's inline
// fallback. It ships looking like it works. (It did: caught in the gate's build inspection, which
// is why `test/unit/image-encode-bundling.test.ts` now exists.)
//
// An unlisted script sidesteps the whole mechanism: WXT builds it as its own entrypoint to a
// KNOWN path, and the client addresses it with `chrome.runtime.getURL` — an absolute
// chrome-extension:// URL with no bundler URL-rewriting anywhere in the path. Same origin,
// bundled at build time, no blob and no code string: CSP- and Trusted-Types-clean.
//
// FORMAT: WXT builds unlisted scripts in Vite lib mode with `formats: ['iife']`
// (`core/builders/vite/index.mjs` `getLibModeConfig`), i.e. one self-contained script with no
// `import`/`export`. So this must be spawned as a CLASSIC worker — `new Worker(url)` with no
// `{ type: 'module' }`. Passing the module type would fail to load it.

/** Locally declared rather than reaching for `DedicatedWorkerGlobalScope`: this project's tsconfig
 *  carries the DOM lib, where `self` is a `Window` whose `postMessage` demands a target origin.
 *  Two members is the entire contract a worker entry needs. */
declare const self: {
  addEventListener(type: 'message', listener: (event: MessageEvent<EncodeRequest>) => void): void;
  postMessage(message: unknown): void;
};

export default defineUnlistedScript(() => {
  // Registered during the worker's first evaluation, so nothing posted before this line is lost —
  // the browser queues messages until the initial script task finishes.
  self.addEventListener('message', (event) => {
    void runEncodeRequest(event.data).then((response) => self.postMessage(response));
  });
});
