import './styles/main.scss';
import { TitleScreen } from './ui/screens/title';

/**
 * The title screen, and nothing else.
 *
 * The game is its own document at `game/`, so this page carries none of the
 * simulation with it: it opens on a drawing and four buttons, and everything
 * it can do amounts to choosing which URL to visit next. Whatever the player
 * picks is named in the query string, since a page load leaves nothing else
 * standing.
 */

/** Where the game lives, relative to this page. */
const GAME = 'game/';

function requireApp(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>('#app');
  if (!element) throw new Error('the page is missing its #app element');
  return element;
}

/**
 * A `?seed=` named on the title screen is carried across to the game, so the
 * seed in the address bar means the same thing on either page.
 */
function seedQuery(): string {
  const seed = new URLSearchParams(window.location.search).get('seed');
  return seed === null ? '' : `?seed=${encodeURIComponent(seed)}`;
}

new TitleScreen(requireApp(), {
  newGame: () => {
    window.location.href = `${GAME}${seedQuery()}`;
  },
  playSave: (id) => {
    window.location.href = `${GAME}?save=${encodeURIComponent(id)}`;
  },
});

// The service worker is what makes the game work with no connection at all.
// It is only generated for production builds.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Relative to the page, not to this module: the bundle lives in assets/
    // but the worker sits at the deployment root, whatever path that is.
    void navigator.serviceWorker.register('./sw.js', { scope: './' });
  });
}
