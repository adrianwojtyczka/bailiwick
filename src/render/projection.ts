import type { MapGrid } from '../sim/core/grid';
import type { World } from '../sim/world/world';

/**
 * How the point lattice is laid out on screen.
 *
 * The view is the flattened, slightly-oblique projection The Settlers II uses:
 * columns are evenly spaced, rows are squashed vertically, odd rows shift half
 * a column east, and a point's altitude simply lifts it up the screen. Terrain
 * triangles drawn between the lifted points is what gives the landscape its
 * rolling shape — there is no separate 3D step anywhere.
 */
export const TILE_WIDTH = 32;
export const TILE_HEIGHT = 18;
/** Screen pixels each unit of altitude lifts a point. */
export const HEIGHT_UNIT = 4;

export function pointX(grid: MapGrid, point: number): number {
  return grid.worldX(point) * TILE_WIDTH;
}

export function pointY(world: World, point: number): number {
  return world.grid.worldY(point) * TILE_HEIGHT - world.height[point]! * HEIGHT_UNIT;
}

/**
 * The row a settler or building should be sorted into when drawing.
 *
 * Depth is taken from the lattice row alone, ignoring altitude: two things on
 * the same row must overlap in a fixed order however hilly the ground is, or
 * they would flicker past each other as the terrain changed.
 */
export function depthOf(grid: MapGrid, point: number): number {
  return grid.yOf(point) * grid.width + grid.xOf(point);
}
