// Argus is a local, single-user application: the recording canvas is the first screen.
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap/dist/js/bootstrap.bundle.min.js';
import 'boxicons/css/boxicons.min.css';
import '../styles/index.css';

import { showView } from './router.ts';
import { initUserShell } from '../panels/user/user-shell.ts';

initUserShell();
showView('record');

const armViewTransitions = (): void => {
  requestAnimationFrame(() => {
    document.body.classList.add('nav-ready');
    window.api.notifyUiReady();
  });
};
if (document.readyState === 'complete') armViewTransitions();
else window.addEventListener('load', armViewTransitions, { once: true });
