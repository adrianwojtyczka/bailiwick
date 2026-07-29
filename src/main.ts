import './styles/main.scss';
import { rollSeed, setHandoff } from './platform/handoff';
import { TitleScreen } from './ui/screens/title';

/**
 * The title screen, and nothing else.
 *
 * The game is its own document at `game/`, so this page carries none of the
 * simulation with it: it opens on a drawing and four buttons, and everything it
 * can do amounts to settling what should be played and then going there.
 *
 * What was chosen travels in storage rather than in the address bar — see
 * `platform/handoff` — with one exception. A `?seed=` named here is passed on
 * as a `?seed=` there, because a seed is meant to be shared and a slot id is
 * not.
 */

/** Where the game lives, relative to this page. */
const GAME = 'game/';

function requireApp(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>('#app');
  if (!element) throw new Error('the page is missing its #app element');
  return element;
}

/** A seed the player named in the address bar, if any. */
function namedSeed(): number | null {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null) return null;

  const seed = Number.parseInt(raw, 10);
  return Number.isFinite(seed) ? seed >>> 0 : null;
}

new TitleScreen(requireApp(), {
  newGame: () => {
    // Settled here rather than on the other side, so that reloading the game
    // page raises the island that is already on screen instead of a new one.
    const named = namedSeed();
    const seed = named ?? rollSeed();

    // A browser that will not keep the choice still gets the right island:
    // the seed is the one thing that may travel in the open.
    const kept = setHandoff({ kind: 'new', seed });
    window.location.href = kept ? GAME : `${GAME}?seed=${seed}`;
  },

  playSave: (id) => {
    if (!setHandoff({ kind: 'save', id })) {
      return 'This browser will not let the game remember which save to open.';
    }
    window.location.href = GAME;
    return undefined;
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
