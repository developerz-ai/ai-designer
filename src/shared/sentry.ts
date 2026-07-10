import type { Breadcrumb, ErrorEvent, Exception } from '@sentry/browser';
import * as Sentry from '@sentry/browser';

// Public GlitchTip ingest key for the ai-designer project (infra #497). A DSN is
// a write-only ingest key, safe to ship in the extension bundle — baked in here
// per the standalone-DSN convention (no cluster secret for a browser extension).
const DSN = 'https://bf037adaf792452d8b77377abb682bd4@glitchtip.infra.developerz.ai/2';

// Written over any free-form, page-derivable string we refuse to send.
const REDACTED = '[redacted]';

// Scrub page-derived content off a crash event before it leaves the browser.
//
// initSentry runs in both the service worker and the side panel, and the next
// wave adds DOM tools (query / getStyles / a11ySnapshot / mutation primitives /
// the changeset recorder) that put page text, resolved selectors, the user's
// design prompt, and base64 screenshots in scope of any thrown error. CLAUDE.md
// forbids persisting page content to a server; GlitchTip is a server. So we
// ALLOWLIST the handful of event fields that carry no page content and rebuild
// the event from only those — anything a future tool attaches (extra, contexts,
// request, attachment-shaped blobs) is dropped by construction, not by a fragile
// field-by-field denylist that each new tool could slip past.
//
// The exception's class and stack trace are kept: they are the debugging payload
// and reference the extension's own bundled code, not the page. Only the
// exception's free-form `value` (message) is redacted — a DOM tool could
// interpolate page text into it. The event is never dropped (the return type is
// a non-null event), so a genuine crash still reaches the transport carrying its
// error class and full stack; crash reporting stays useful.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    release: event.release,
    dist: event.dist,
    sdk: event.sdk,
  };
  if (event.exception?.values) {
    scrubbed.exception = { values: event.exception.values.map(scrubException) };
  }
  return scrubbed;
}

// Keep the class name, mechanism, and full stack trace; redact the free-form
// message, the one exception field a DOM tool could stuff page content into.
function scrubException(exception: Exception): Exception {
  return {
    type: exception.type,
    mechanism: exception.mechanism,
    stacktrace: exception.stacktrace,
    value: exception.value === undefined ? undefined : REDACTED,
  };
}

// Defence in depth, not the guarantee. `scrubEvent`'s allowlist omits `breadcrumbs`
// entirely, so NO breadcrumb ever reaches GlitchTip — Sentry merges the scope's
// breadcrumbs onto the event before `beforeSend` runs, and we then rebuild the event
// without them. This hook stops the two page-derived kinds from being *recorded* in
// the first place: console breadcrumbs capture logged arguments, and DOM (`ui.*`)
// breadcrumbs capture clicked-element identifiers. Crumbs it returns stay in memory
// for the session and are dropped at send time like every other crumb.
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const category = breadcrumb.category ?? '';
  if (category === 'console' || category.startsWith('ui.')) {
    return null;
  }
  return breadcrumb;
}

// Error tracking only. GlitchTip ingests error events but supports neither Sentry
// Session Replay nor performance tracing; and enabling Session Replay in the
// all_urls content script would record every page the user visits — so neither
// integration is enabled here. beforeSend + beforeBreadcrumb strip page content
// (see scrubEvent / scrubBreadcrumb) before anything reaches GlitchTip.
export function initSentry(): void {
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE ?? 'development',
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
