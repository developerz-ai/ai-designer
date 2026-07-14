// Canonical outbound links for the extension UI — single source of truth so the
// side panel, README, and package.json metadata never drift. Plain constants (no
// Zod): these are compile-time literals, not values crossing the typed message bus.

/** GitHub repository home. */
export const REPO_URL = 'https://github.com/developerz-ai/ai-designer';

/** Issue list. */
export const ISSUES_URL = `${REPO_URL}/issues`;

/**
 * "Report an issue" target — opens the new-issue form pre-seeded with the bug
 * template (`.github/ISSUE_TEMPLATE/bug_report.md`).
 */
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new?template=bug_report.md`;
