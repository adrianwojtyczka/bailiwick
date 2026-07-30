import '../styles/main.scss';
import { getHandoff, rollSeed, setHandoff } from '../platform/handoff';
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
 * page that can be opened, bookmarked and cached on its own. What to open is
 * settled before arriving here, and read back in this order:
 *
 *  1. `?seed=<n>` in this page's own URL — a seed a person named, and the only
 *     query parameter there is. It wins, and it leaves the handoff alone, so
 *     deep-linking an island cannot clobber a save waiting to be opened.
 *  2. the handoff written by the title screen (`platform/handoff`): a slot to
 *     resume, or the seed it settled on for a new island.
 *  3. neither, for somebody who typed `game/` straight in: a seed of the
 *     moment, kept so that a reload raises the same island rather than another.
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
 * A seed given as `?seed=12345`, which is the whole of this page's URL surface.
 *
 * World generation is a pure function of its seed, so naming one reproduces
 * exactly the same island — useful for comparing notes on a map, for reporting
 * a problem, and for tests that need the same ground every run.
 */
function namedSeed(): number | null {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null) return null;

  const seed = Number.parseInt(raw, 10);
  return Number.isFinite(seed) ? seed >>> 0 : null;
}

/**
 * Raises an island.
 *
 * `named` is what separates a seed a person asked for from one that was rolled:
 * some seeds produce ground with nowhere sensible to start, and retrying a
 * named one would only fail the same way, so it is reported instead. A rolled
 * seed is replaced — and the replacement recorded, or a reload would raise a
 * third island and disagree with the screen.
 */
async function startNewGame(seed: number, named: boolean): Promise<void> {
  showBusy('Raising an island…');

  // Yield a frame so the message actually paints before generation blocks.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    startSession(
      Game.create({
        width: MAP_SIZE,
        height: MAP_SIZE,
        seed,
        players: [
          { name: 'You', colour: '#c4832b' },
          // A neighbour on every island. It holds ground and defends it, and
          // never builds or attacks — see `PlayerConfig.dormant`.
          { name: 'Rival', colour: '#3f6f9c', dormant: true },
        ],
      }),
    );
  } catch (error) {
    if (named) {
      showTrouble(`No island could be raised from seed ${seed}.`);
      return;
    }
    console.warn('world generation failed, retrying with a new seed', error);
    void raiseFreshIsland();
  }
}

/** Rolls a seed, records it so a reload keeps the island, and builds it. */
function raiseFreshIsland(): Promise<void> {
  const seed = rollSeed();
  setHandoff({ kind: 'new', seed });
  return startNewGame(seed, false);
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

void (() => {
  const named = namedSeed();
  if (named !== null) return startNewGame(named, true);

  const intent = getHandoff();
  if (intent?.kind === 'save') return resumeSlot(intent.id);
  if (intent?.kind === 'new') return startNewGame(intent.seed, false);

  return raiseFreshIsland();
})();

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
