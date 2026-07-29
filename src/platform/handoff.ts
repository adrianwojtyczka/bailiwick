/**
 * What the title screen last asked the game page to open.
 *
 * The two are separate documents, so a choice made on one has to survive a page
 * load to reach the other. The query string did that job and did it badly: a
 * save's slot id is an internal name, and the address bar is the first thing a
 * player sees, copies and hands to somebody else. This keeps that book-keeping
 * out of sight.
 *
 * A **seed** is the exception and keeps its query parameter, because a seed is
 * meant to be typed and shared — world generation is a pure function of it, so
 * `?seed=1234` is how two people compare notes on one island.
 *
 * Deliberately free of any simulation import: the title page reads and writes
 * this, and it must not drag the game along behind it.
 */

const KEY = 'bailiwick:play';

export type Handoff =
  | { readonly kind: 'new'; readonly seed: number }
  | { readonly kind: 'save'; readonly id: string };

/**
 * Records what should be played next.
 *
 * Returns false when the browser will not keep it — a private window may refuse
 * storage outright — so the caller can say so rather than press on and open the
 * wrong game.
 */
export function setHandoff(intent: Handoff): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

/**
 * What was last asked for, if anything, and if it still makes sense.
 *
 * **Read, not consumed.** The slot says what this page should be showing, so a
 * reload replays it and the player gets the same save or the same island back.
 * Clearing it on read would turn a refresh into a silently discarded game,
 * which is a good deal worse than the staleness it would save.
 */
export function getHandoff(): Handoff | undefined {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;

  try {
    // Anything can be in storage — an older build wrote it, or a person typed
    // it — so nothing is taken on trust.
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const intent = parsed as Partial<Handoff>;
    if (intent.kind === 'save' && typeof intent.id === 'string' && intent.id !== '') {
      return { kind: 'save', id: intent.id };
    }
    if (intent.kind === 'new' && typeof intent.seed === 'number' && Number.isFinite(intent.seed)) {
      return { kind: 'new', seed: intent.seed >>> 0 };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** A seed of the moment, for a player who did not name one. */
export function rollSeed(): number {
  return Math.floor(Math.random() * 0xffff_ffff);
}
