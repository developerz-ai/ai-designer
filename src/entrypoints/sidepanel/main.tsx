import { render } from 'solid-js/web';
import { App } from './App';
import './main.scss';
import { initSentry } from '@/shared/sentry';
import { initFocusStore } from './stores/focus';

const root = document.getElementById('root');
if (!root) throw new Error('sidepanel root missing');

initSentry();
initFocusStore();
render(() => <App />, root);
