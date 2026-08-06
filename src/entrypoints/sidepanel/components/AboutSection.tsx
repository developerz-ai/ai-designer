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
      {/* Leading glyph says what the link is, trailing glyph says it leaves the panel — the
          second one matters here because a side panel opening a real browser tab is a bigger
          jump than a normal in-page link. */}
      <a class="dz-about__link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
        <Icon name="repo" size="sm" class="dz-icon--fixed" />
        <span>{i18n.t('about.repoLink')}</span>
        <Icon name="externalLink" size="sm" class="dz-icon--fixed" />
      </a>
      <a class="dz-about__link" href={NEW_ISSUE_URL} target="_blank" rel="noopener noreferrer">
        <Icon name="bug" size="sm" class="dz-icon--fixed" />
        <span>{i18n.t('about.issueLink')}</span>
        <Icon name="externalLink" size="sm" class="dz-icon--fixed" />
      </a>
    </section>
  );
}
