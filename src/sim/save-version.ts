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
export const SAVE_VERSION = 6;
