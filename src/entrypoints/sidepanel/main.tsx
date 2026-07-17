import { render } from 'solid-js/web';
import { i18n } from '#i18n';
import { App } from './App';
import './main.scss';
import { initSentry } from '@/shared/sentry';
import { initFocusStore } from './stores/focus';

document.title = i18n.t('app.documentTitle');

const root = document.getElementById('root');
if (!root) throw new Error('sidepanel root missing');

initSentry();
initFocusStore();
render(() => <App />, root);
