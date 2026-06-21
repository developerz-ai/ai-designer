import { render } from 'solid-js/web';
import { App } from './App';
import './main.scss';

const root = document.getElementById('root');
if (!root) throw new Error('sidepanel root missing');

render(() => <App />, root);
