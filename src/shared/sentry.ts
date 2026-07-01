import * as Sentry from '@sentry/browser';

// Public GlitchTip ingest key for the ai-designer project (infra #497). A DSN is
// a write-only ingest key, safe to ship in the extension bundle — baked in here
// per the standalone-DSN convention (no cluster secret for a browser extension).
const DSN = 'https://bf037adaf792452d8b77377abb682bd4@glitchtip.infra.developerz.ai/2';

// Error tracking only. GlitchTip ingests error events but supports neither Sentry
// Session Replay nor performance tracing; and enabling Session Replay in the
// all_urls content script would record every page the user visits — so neither
// integration is enabled here.
export function initSentry(): void {
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE ?? 'development',
  });
}
