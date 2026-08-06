/**
 * The save format's version number.
 *
 * A leaf of its own so that reading a save file's *header* — which version it
 * is, and what it says about itself — costs nothing but this constant. The
 * title screen needs exactly that much to accept or refuse a file the player
 * offers it, and it has no business loading the whole simulation to find out.
 *
 * Bump it whenever the shape of a snapshot changes. Older saves are read on
 * purpose: `Simulation.fromSnapshot` fills in whatever they predate.
 */
export const SAVE_VERSION = 10;

/**
 * The oldest save this build can open.
 *
 * A save stores its seed, not its ground: the island is regenerated from the
 * seed and the buildings, roads and borders laid back over it. That works for
 * as long as a seed means the same island — and at version 10 it stopped
 * meaning it. The map is now twice as wide and mirrored down the middle, so a
 * save made before it would come back with its halls standing in the sea and
 * its roads running over a mountain.
 *
 * Refusing such a file is the honest thing to do. It is the first time an older
 * save has been turned away, and it should stay the last: a floor is only ever
 * raised when the ground itself has moved.
 */
export const OLDEST_SAVE_VERSION = 10;
