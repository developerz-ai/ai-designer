import { z } from 'zod';

// Side-effect module: switch Zod off its JIT path, for the two worlds that run inside a page.
//
// WHY. Zod compiles a fast-path object parser with `new Function`. Before it does, it PROBES for
// eval by constructing an empty `Function` inside a try/catch. On a Trusted-Types or strict-CSP
// site the throw is swallowed and validation still works — but the browser has already reported
// the blocked attempt, so the page console fills with
// `This document requires 'TrustedScript' assignment. The action has been blocked.` Real sites do
// this (Google reports it once per frame — `injected.content.ts` declares `allFrames` +
// `matchAboutBlank`, so a SERP is ~7 realms and ~7 violations), and it looks like OUR extension is
// doing something forbidden. Zod 4.4 added `jitless` for exactly this case and its own source says
// so: "Skip the probe under `jitless`: strict CSPs report the caught `new Function` as a
// `securitypolicyviolation` even though the throw is swallowed" (zod/v4/core/util.js).
//
// PLACEMENT IS LOAD-BEARING. `allowsEval` is read while a `z.object()` is CONSTRUCTED
// (zod/v4/core/schemas.js — `const fastEnabled = jit && allowsEval.value`, at schema build time,
// not at parse time), and every schema in `src/shared/*` is built at module scope. So this must
// run before the first schema module is evaluated, which means it must be the FIRST import of an
// entrypoint. It is a bare side-effect import for that reason: Biome's `organizeImports` treats a
// side-effect import as a barrier and will not sort it below the others.
//
// THE TRADE. `jitless` costs the compiled fast path: object parsing walks the shape instead of
// running generated code. In these two worlds nothing parses in a loop — the content script
// validates one bus message per tool call, and the bridge validates two small envelopes per
// request. The one place worth watching is `src/dom/diagnostics-collector.ts`, which can see a
// console-chatty page — but it runs no schema parse at all (it builds plain objects and the SW
// validates the drained batch), so it is not a hot parse path either.
//
// The service worker and the side panel are NOT affected: they run on their own origin under our
// own CSP, where the probe succeeds and the fast path is free.
z.config({ jitless: true });
