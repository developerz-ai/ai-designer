import { i18n } from '#i18n';
import { NEW_ISSUE_URL, REPO_URL } from '../../../shared/links';
import { Icon } from './Icon';
import './AboutSection.scss';

// Render-only (CLAUDE.md "SolidJS + SRP" — no logic in components). Static outbound
// links from ../../../shared/links; `target="_blank"` opens a real browser tab from the
// side panel (mirrors HistoryPanel/TaskTimeline), `rel="noopener noreferrer"` keeps the
// opened page from reaching back into the panel's window.
export function AboutSection() {
  return (
    <section class="dz-about" aria-label={i18n.t('about.section.ariaLabel')}>
      <a class="dz-about__link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
        <Icon name="repo" size="sm" />
        {i18n.t('about.repoLink')}
      </a>
      <a class="dz-about__link" href={NEW_ISSUE_URL} target="_blank" rel="noopener noreferrer">
        <Icon name="bug" size="sm" />
        {i18n.t('about.issueLink')}
      </a>
    </section>
  );
}
