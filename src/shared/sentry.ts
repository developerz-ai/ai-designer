import * as Sentry from '@sentry/browser';

const DSN = 'https://bf037adaf792452d8b77377abb682bd4@glitchtip.infra.developerz.ai/2';
const VERSION = '0.0.0'; // synced from package.json

export function initSentry(): void {
  if (!DSN) {
    return;
  }

  const environment = import.meta.env.MODE ?? 'development';

  Sentry.init({
    dsn: DSN,
    environment,
    release: VERSION,
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}
