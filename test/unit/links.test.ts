import { describe, expect, it } from 'vitest';
import { ISSUES_URL, NEW_ISSUE_URL, REPO_URL } from '@/shared/links';

// The side panel's About section renders these verbatim into `href`s (AboutSection.tsx).
// They must be absolute https URLs on the real repo — a typo ships a dead link in the UI.
describe('outbound links', () => {
  it('REPO_URL is the canonical https repo home', () => {
    expect(REPO_URL).toBe('https://github.com/developerz-ai/ai-designer');
  });

  it('every link is an absolute https URL under the repo host', () => {
    for (const url of [REPO_URL, ISSUES_URL, NEW_ISSUE_URL]) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.host).toBe('github.com');
      expect(parsed.pathname.startsWith('/developerz-ai/ai-designer')).toBe(true);
    }
  });

  it('ISSUES_URL and NEW_ISSUE_URL derive from REPO_URL', () => {
    expect(ISSUES_URL).toBe(`${REPO_URL}/issues`);
    expect(NEW_ISSUE_URL.startsWith(`${REPO_URL}/issues/new`)).toBe(true);
  });

  it('the report-issue link pre-selects the bug template', () => {
    expect(new URL(NEW_ISSUE_URL).searchParams.get('template')).toBe('bug_report.md');
  });
});
