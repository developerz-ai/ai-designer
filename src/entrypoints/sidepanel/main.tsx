import { render } from 'solid-js/web';
import { App } from './App';
import './main.scss';
import { initSentry } from '@/shared/sentry';

const root = document.getElementById('root');
if (!root) throw new Error('sidepanel root missing');

initSentry();
render(() => <App />, root);
