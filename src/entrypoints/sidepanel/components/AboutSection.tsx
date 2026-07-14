import { NEW_ISSUE_URL, REPO_URL } from '../../../shared/links';
import { Icon } from './Icon';
import './AboutSection.scss';

// Render-only (CLAUDE.md "SolidJS + SRP" — no logic in components). Static outbound
// links from ../../../shared/links; `target="_blank"` opens a real browser tab from the
// side panel (mirrors HistoryPanel/TaskTimeline), `rel="noopener noreferrer"` keeps the
// opened page from reaching back into the panel's window.
export function AboutSection() {
  return (
    <section class="dz-about" aria-label="About">
      <a class="dz-about__link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
        <Icon name="repo" size="sm" />
        GitHub repository
      </a>
      <a class="dz-about__link" href={NEW_ISSUE_URL} target="_blank" rel="noopener noreferrer">
        <Icon name="bug" size="sm" />
        Report an issue
      </a>
    </section>
  );
}
