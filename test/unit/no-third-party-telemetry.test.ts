import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #25 criteria 3 & 4: the extension sends page content ONLY to the user's chosen model/MCP and
// ships NO third-party telemetry/analytics. First-party self-hosted GlitchTip (via @sentry/browser
// -> glitchtip.infra.developerz.ai) is the ONLY telemetry allowed. This guards the dependency
// graph — the vector by which an analytics SaaS would slip back in — at CI's unit lane; the #25
// live-test greps the built bundle for the same hosts as a belt-and-braces runtime check.

const __dirname = dirname(fileURLToPath(import.meta.url));

// Third-party analytics/telemetry package fragments. GlitchTip is self-hosted and rides
// @sentry/browser, so `sentry` is deliberately absent — a first-party error client pointing at our
// own GlitchTip is allowed, exactly as the #25 live-test allow-list documents.
const THIRD_PARTY_TELEMETRY = [
  'google-analytics',
  'gtag',
  'react-ga',
  'mixpanel',
  '@segment/',
  'amplitude',
  'fullstory',
  'hotjar',
  'posthog',
  'heapanalytics',
  '@datadog/',
];

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

describe('no third-party telemetry (#25 criteria 3 & 4)', () => {
  it('declares no third-party analytics/telemetry SDK dependency', () => {
    const offenders = deps.filter((d) =>
      THIRD_PARTY_TELEMETRY.some((frag) => d.toLowerCase().includes(frag)),
    );
    expect(offenders).toEqual([]);
  });

  it('ships only first-party telemetry — GlitchTip via @sentry/browser', () => {
    expect(deps).toContain('@sentry/browser');
  });
});
