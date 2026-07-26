import './styles/main.scss';
import { GameSession, setCurrentSession } from './game/session';
import type { Simulation } from './sim/simulation';
import { Simulation as Game } from './sim/simulation';
import { clear, el } from './ui/dom';
import { TitleScreen } from './ui/screens/title';

/** A map this size generates in a fraction of a second and gives room to grow. */
const MAP_SIZE = 96;
const HUMAN_PLAYER = 1;

/**
 * A seed given as `?seed=12345`.
 *
 * World generation is a pure function of its seed, so naming one reproduces
 * exactly the same island — useful for comparing notes on a map, for reporting
 * a problem, and for tests that need the same ground every run.
 */
function requestedSeed(): number | null {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null) return null;

  const seed = Number.parseInt(raw, 10);
  return Number.isFinite(seed) ? seed >>> 0 : null;
}

function requireApp(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>('#app');
  if (!element) throw new Error('the page is missing its #app element');
  return element;
}

const app = requireApp();

let title: TitleScreen | null = null;
let session: GameSession | null = null;

function showTitle(): void {
  session?.destroy();
  session = null;
  setCurrentSession(null);

  clear(app);
  title = new TitleScreen(app, {
    newGame: () => void startNewGame(),
    resume: (simulation) => startSession(simulation),
  });
}

function showBusy(message: string): void {
  clear(app);
  app.append(el('div', { class: 'loading' }, el('p', {}, message)));
}

async function startNewGame(): Promise<void> {
  showBusy('Raising an island…');

  // Yield a frame so the message actually paints before generation blocks.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const seed = requestedSeed() ?? Math.floor(Math.random() * 0xffff_ffff);

  try {
    const simulation = Game.create({
      width: MAP_SIZE,
      height: MAP_SIZE,
      seed,
      players: [{ name: 'You', colour: '#c4832b' }],
    });
    startSession(simulation);
  } catch (error) {
    // Some seeds produce an island with nowhere sensible to start; try again.
    console.warn('world generation failed, retrying with a new seed', error);
    void startNewGame();
  }
}

function startSession(simulation: Simulation): void {
  title?.destroy();
  title = null;

  clear(app);
  session = new GameSession(app, simulation, HUMAN_PLAYER, showTitle);
  setCurrentSession(session);
  session.start();
}

showTitle();

// The service worker is what makes the game work with no connection at all.
// It is only generated for production builds.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Relative to the page, not to this module: the bundle lives in assets/
    // but the worker sits at the deployment root, whatever path that is.
    void navigator.serviceWorker.register('./sw.js', { scope: './' });
  });
}
