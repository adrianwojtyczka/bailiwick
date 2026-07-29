import type { BuildingType } from '../sim/data/buildings';
import type { Camera } from './camera';

/** What the player currently has selected or is about to place. */
export interface ViewState {
  readonly playerId: number;
  /** The lattice point under the cursor or last tapped, or -1. */
  readonly selectedPoint: number;
  /** A building being positioned, drawn ghosted at its site. */
  readonly buildPreview: { readonly point: number; readonly type: BuildingType } | null;
  /** A road being dragged out, drawn as a dotted line. */
  readonly roadPreview: readonly number[] | null;
  /**
   * When set, every point that could take this building is marked.
   *
   * The *type*, not merely its footprint: an outpost has a spacing rule of its
   * own, and an overlay that offered places the command then refused would
   * defeat the point of one derivation driving menu, preview and validation.
   */
  readonly buildSpaceOverlay: BuildingType | null;
  /** How far the frame falls into the tick still to come, 0..1. */
  readonly alpha: number;
}

/**
 * Draws the world.
 *
 * Kept behind an interface so the terrain layer can move to WebGL later
 * without the game loop, the HUD or the input code noticing.
 */
export interface Renderer {
  readonly camera: Camera;
  /** Sizes the drawing surface. `pixelRatio` is the device pixel ratio. */
  resize(width: number, height: number, pixelRatio: number): void;
  render(view: ViewState): void;
  /** Frees any cached canvases. */
  destroy(): void;
}
