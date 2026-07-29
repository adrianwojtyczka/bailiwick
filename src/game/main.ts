import '../styles/main.scss';
import { loadSimulation } from '../platform/save';
import { getSave } from '../platform/storage';
import type { Simulation } from '../sim/simulation';
import { Simulation as Game } from '../sim/simulation';
import { clear, el } from '../ui/dom';
import { GameSession } from './session';

/**
 * The game page.
 *
 * It is its own document, reached at `game/`, so the title screen is a plain
 * page that can be opened, bookmarked and cached on its own. Everything the
 * game needs to start arrives in the query string, because a page load leaves
 * nothing else standing:
 *
 *  - `?save=<id>`  resume that slot, which is how Continue and Load a save
 *                  both arrive — the title picks the slot, this plays it;
 *  - `?seed=<n>`   a new island from that seed;
 *  - neither       a new island from a seed of the moment.
 */

/** A map this size generates in a fraction of a second and gives room to grow. */
const MAP_SIZE = 96;
const HUMAN_PLAYER = 1;

/** Where the title screen lives, relative to this page. */
const TITLE = '../';

function requireApp(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>('#app');
  if (!element) throw new Error('the page is missing its #app element');
  return element;
}

const app = requireApp();

function showBusy(message: string): void {
  clear(app);
  app.append(el('div', { class: 'loading' }, el('p', {}, message)));
}

/**
 * Something went wrong before there was a game to show it in, so this page has
 * no ticker to put it in and no menu to leave by. Say so and offer the way out.
 */
function showTrouble(message: string): void {
  clear(app);

  const back = el('a', { class: 'title__button', href: TITLE }, 'Back to the title');
  app.append(
    el(
      'div',
      { class: 'title' },
      el('p', { class: 'title__message' }, message),
      el('nav', { class: 'title__menu' }, back),
    ),
  );
}

function goToTitle(): void {
  window.location.href = TITLE;
}

function startSession(simulation: Simulation): void {
  clear(app);
  const session = new GameSession(app, simulation, HUMAN_PLAYER, goToTitle);
  session.start();
}

/**
 * A seed given as `?seed=12345`.
 *
 * World generation is a pure function of its seed, so naming one reproduces
 * exactly the same island — useful for comparing notes on a map, for reporting
 * a problem, and for tests that need the same ground every run. The title
 * screen passes its own `?seed=` through, so a seed named there survives the
 * step across to here.
 */
function requestedSeed(params: URLSearchParams): number | null {
  const raw = params.get('seed');
  if (raw === null) return null;

  const seed = Number.parseInt(raw, 10);
  return Number.isFinite(seed) ? seed >>> 0 : null;
}

async function startNewGame(seed: number | null): Promise<void> {
  showBusy('Raising an island…');

  // Yield a frame so the message actually paints before generation blocks.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const chosen = seed ?? Math.floor(Math.random() * 0xffff_ffff);

  try {
    startSession(
      Game.create({
        width: MAP_SIZE,
        height: MAP_SIZE,
        seed: chosen,
        players: [{ name: 'You', colour: '#c4832b' }],
      }),
    );
  } catch (error) {
    // Some seeds produce an island with nowhere sensible to start. Retrying a
    // *named* seed would only fail the same way, so that one is reported.
    if (seed !== null) {
      showTrouble(`No island could be raised from seed ${seed}.`);
      return;
    }
    console.warn('world generation failed, retrying with a new seed', error);
    void startNewGame(null);
  }
}

async function resumeSlot(id: string): Promise<void> {
  showBusy('Unrolling the map…');

  try {
    const save = await getSave(id);
    if (!save) {
      showTrouble('That save is no longer on this device.');
      return;
    }
    startSession(await loadSimulation(save.bytes));
  } catch (error) {
    showTrouble(`Could not open that save: ${describe(error)}`);
  }
}

const params = new URLSearchParams(window.location.search);
const slot = params.get('save');
void (slot ? resumeSlot(slot) : startNewGame(requestedSeed(params)));

// The service worker is what makes the game work with no connection at all.
// It is only generated for production builds.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // The worker sits at the deployment root and this page is one level under
    // it, so both the script and its scope are named from there.
    void navigator.serviceWorker.register('../sw.js', { scope: TITLE });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
