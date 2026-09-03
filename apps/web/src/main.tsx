import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';
import '@/styles/index.css';

/*
 * A route whose chunk no longer exists is a reload, not a dead end.
 *
 * Every page is a dynamic import, so a build whose assets have moved under an
 * already-open tab fails on the first navigation to a route that had not been
 * visited yet — the `Unable to preload CSS for .../assets/AirfarePage-*.css`
 * the Airfare and Investing routes reported. Fetching `index.html` again is
 * what resolves it: the new one names the hashes that exist.
 *
 * Once per tab, though. Reloading on a chunk that is genuinely missing rather
 * than merely renamed would reload into the same failure forever, so the
 * attempt is recorded first and the second occurrence is allowed to surface as
 * the route error it is. Storage that cannot be read is treated as an attempt
 * already spent, for the same reason: without somewhere to count, there is no
 * way to stop.
 */
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  let spent: boolean;
  try {
    spent = sessionStorage.getItem('vite-preload-reloaded') !== null;
    sessionStorage.setItem('vite-preload-reloaded', '1');
  } catch {
    return;
  }
  if (!spent) window.location.reload();
});

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
