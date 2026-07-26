import { OUT_OF_BOUNDS } from '../sim/core/grid';
import type { World } from '../sim/world/world';
import { HEIGHT_UNIT, pointX, pointY, TILE_HEIGHT, TILE_WIDTH } from './projection';

export const MIN_ZOOM = 0.45;
export const MAX_ZOOM = 2.4;

/**
 * The window onto the map.
 *
 * Holds a centre in projected map pixels and a zoom factor, and converts
 * between map pixels and CSS pixels on the canvas. Everything above this — pan,
 * pinch, tapping a point — is expressed in terms of these two conversions.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  viewportWidth = 0;
  viewportHeight = 0;

  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Centres the view on a lattice point. */
  centreOn(point: number): void {
    this.x = pointX(this.world.grid, point);
    this.y = pointY(this.world, point);
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.clamp();
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.clamp();
  }

  /** Zooms about a fixed point on screen, so pinches feel anchored. */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const before = this.screenToMap(screenX, screenY);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const after = this.screenToMap(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  mapToScreenX(mapX: number): number {
    return (mapX - this.x) * this.zoom + this.viewportWidth / 2;
  }

  mapToScreenY(mapY: number): number {
    return (mapY - this.y) * this.zoom + this.viewportHeight / 2;
  }

  screenToMap(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.viewportWidth / 2) / this.zoom + this.x,
      y: (screenY - this.viewportHeight / 2) / this.zoom + this.y,
    };
  }

  /** Keeps the island on screen rather than letting the player drift into the void. */
  private clamp(): void {
    const { grid } = this.world;
    const margin = 4 * TILE_WIDTH;
    const maxX = grid.width * TILE_WIDTH;
    const maxY = grid.height * TILE_HEIGHT;

    this.x = Math.min(maxX + margin, Math.max(-margin, this.x));
    this.y = Math.min(maxY + margin, Math.max(-margin - 40 * HEIGHT_UNIT, this.y));
  }

  /**
   * The lattice point nearest a position on screen.
   *
   * Altitude makes the projection impossible to invert directly — a point high
   * on a hill is drawn where a point several rows nearer the viewer would be —
   * so this inverts the flat part of the projection and then checks the small
   * neighbourhood around that guess for the genuinely closest point.
   */
  pickPoint(screenX: number, screenY: number): number {
    const map = this.screenToMap(screenX, screenY);
    const { grid } = this.world;

    const guessRow = Math.round(map.y / TILE_HEIGHT);
    const guessCol = Math.round(map.x / TILE_WIDTH);

    let best = OUT_OF_BOUNDS;
    let bestDistance = Number.POSITIVE_INFINITY;

    // Search downwards further than upwards: a tall hill draws its summit high
    // on screen, so the point under the cursor is usually below the flat guess.
    for (let row = guessRow - 3; row <= guessRow + 14; row += 1) {
      if (row < 0 || row >= grid.height) continue;
      for (let col = guessCol - 2; col <= guessCol + 2; col += 1) {
        if (col < 0 || col >= grid.width) continue;

        const point = grid.index(col, row);
        const dx = pointX(grid, point) - map.x;
        const dy = pointY(this.world, point) - map.y;
        const distance = dx * dx + dy * dy;

        if (distance < bestDistance) {
          bestDistance = distance;
          best = point;
        }
      }
    }

    return best;
  }

  /** The inclusive range of lattice rows and columns currently on screen. */
  visibleBounds(): { minCol: number; maxCol: number; minRow: number; maxRow: number } {
    const { grid } = this.world;
    const topLeft = this.screenToMap(0, 0);
    const bottomRight = this.screenToMap(this.viewportWidth, this.viewportHeight);

    // Generous vertical padding so tall terrain and buildings never pop in.
    const minRow = Math.max(0, Math.floor(topLeft.y / TILE_HEIGHT) - 2);
    const maxRow = Math.min(
      grid.height - 1,
      Math.ceil(bottomRight.y / TILE_HEIGHT) + Math.ceil((60 * HEIGHT_UNIT) / TILE_HEIGHT),
    );
    const minCol = Math.max(0, Math.floor(topLeft.x / TILE_WIDTH) - 2);
    const maxCol = Math.min(grid.width - 1, Math.ceil(bottomRight.x / TILE_WIDTH) + 2);

    return { minCol, maxCol, minRow, maxRow };
  }
}
