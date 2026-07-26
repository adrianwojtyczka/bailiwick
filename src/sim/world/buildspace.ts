import { Direction, DIRECTIONS } from '../core/direction';
import { OUT_OF_BOUNDS } from '../core/grid';
import { MapObject } from './terrain';
import type { World } from './world';

/**
 * What a point can accommodate. This single derivation drives the build menu,
 * the placement preview and command validation, so the player is never offered
 * something the simulation would then refuse.
 *
 * `Flag` through `Castle` form a size ordering — anywhere a castle fits, a hut
 * fits too. `Mine` is separate: mines go into mountains, where nothing else can
 * be built.
 */
export const BuildSpace = {
  None: 0,
  Flag: 1,
  Hut: 2,
  House: 3,
  Castle: 4,
  Mine: 5,
} as const;

export type BuildSpace = (typeof BuildSpace)[keyof typeof BuildSpace];

/** The footprint class of a building, matching the build-space values. */
export const BuildingSize = {
  Hut: BuildSpace.Hut,
  House: BuildSpace.House,
  Castle: BuildSpace.Castle,
  Mine: BuildSpace.Mine,
} as const;

export type BuildingSize = (typeof BuildingSize)[keyof typeof BuildingSize];

/**
 * Steepest neighbouring height difference each footprint tolerates. Big
 * buildings need level ground; a hut can perch on a slope.
 */
const SLOPE_LIMIT = {
  castle: 1,
  house: 2,
  hut: 3,
  flag: 4,
} as const;

/** Roads cannot climb a steeper step than this in one segment. */
export const MAX_ROAD_SLOPE = 4;

/** A building's flag always sits on the point south-east of it. */
export const FLAG_DIRECTION = Direction.SouthEast;

function isPointClear(world: World, point: number): boolean {
  return (
    world.building[point] === 0 &&
    world.flag[point] === 0 &&
    world.object[point] === MapObject.None
  );
}

/** True when the point itself and all six neighbours belong to `player`. */
function isWellInsideTerritory(world: World, point: number, player: number): boolean {
  if (world.owner[point] !== player) return false;
  for (const direction of DIRECTIONS) {
    const neighbour = world.grid.neighbour(point, direction);
    // The map edge is always water, so this only bites at genuine borders.
    if (neighbour === OUT_OF_BOUNDS) return false;
    if (world.owner[neighbour] !== player) return false;
  }
  return true;
}

/**
 * Whether a flag may be raised here. Flags may not touch one another — the gap
 * between them is what gives a road network its segments, each worked by one
 * carrier.
 */
export function canPlaceFlag(world: World, point: number, player: number): boolean {
  if (world.owner[point] !== player) return false;
  if (!isPointClear(world, point)) return false;
  if (!world.isWalkable(point)) return false;

  for (const direction of DIRECTIONS) {
    const neighbour = world.grid.neighbour(point, direction);
    if (neighbour === OUT_OF_BOUNDS) continue;
    if (world.flag[neighbour] !== 0) return false;
  }

  return true;
}

/**
 * Whether a road segment may run from `point` in `direction`: the ground on at
 * least one side must be walkable, and the step must not be too steep.
 */
export function canTraverseEdge(world: World, point: number, direction: Direction): boolean {
  const neighbour = world.grid.neighbour(point, direction);
  if (neighbour === OUT_OF_BOUNDS) return false;

  if (Math.abs(world.height[neighbour]! - world.height[point]!) > MAX_ROAD_SLOPE) return false;

  const edge = world.grid.canonicalEdge(point, direction);
  if (!edge) return false;

  world.trianglesAlongEdge(edge.point, edge.direction, EDGE_TRIANGLES);
  for (let i = 0; i < 2; i += 1) {
    const triangle = EDGE_TRIANGLES[i]!;
    if (triangle === OUT_OF_BOUNDS) continue;
    if (world.propertiesOfTriangle(triangle).walkable) return true;
  }

  return false;
}

/**
 * Whether a road may pass *through* this point on its way between two flags.
 * Intermediate points must be empty ground that no other road already uses.
 */
export function canRouteRoadThrough(world: World, point: number, player: number): boolean {
  if (world.owner[point] !== player) return false;
  if (!isPointClear(world, point)) return false;
  if (!world.isWalkable(point)) return false;
  return world.roadCount(point) === 0;
}

/**
 * The largest thing that can be built at `point` by `player`.
 *
 * The rules, in the order they are applied:
 *  1. the point must be clear of buildings, flags, trees and stone;
 *  2. it must sit inside the player's territory, not on its border;
 *  3. no neighbouring point may already hold a building;
 *  4. the surrounding terrain decides between a mine and ordinary ground;
 *  5. the local slope caps the footprint;
 *  6. a building also needs somewhere to put its flag.
 */
export function evaluateBuildSpace(world: World, point: number, player: number): BuildSpace {
  if (!isPointClear(world, point)) return BuildSpace.None;
  if (!world.isWalkable(point)) return BuildSpace.None;
  if (world.owner[point] !== player) return BuildSpace.None;

  // A lone flag is allowed right up to the border; buildings are not.
  const flagPossible = canPlaceFlag(world, point, player);

  // A road already runs through here. A flag is still welcome — it divides the
  // road in two — but a building would leave carriers walking through its walls.
  if (world.roadCount(point) > 0) return flagPossible ? BuildSpace.Flag : BuildSpace.None;
  if (!isWellInsideTerritory(world, point, player)) {
    return flagPossible ? BuildSpace.Flag : BuildSpace.None;
  }

  for (const direction of DIRECTIONS) {
    const neighbour = world.grid.neighbour(point, direction);
    if (neighbour === OUT_OF_BOUNDS) continue;
    if (world.building[neighbour] !== 0) return flagPossible ? BuildSpace.Flag : BuildSpace.None;
  }

  // A building needs its own flag on the point to the south-east.
  const flagPoint = world.grid.neighbour(point, FLAG_DIRECTION);
  const flagUsable =
    flagPoint !== OUT_OF_BOUNDS &&
    (world.flag[flagPoint] !== 0
      ? world.owner[flagPoint] === player
      : canPlaceFlag(world, flagPoint, player));
  if (!flagUsable) return flagPossible ? BuildSpace.Flag : BuildSpace.None;

  world.trianglesAroundPoint(point, AROUND_TRIANGLES);

  let allMineable = true;
  let allBuildable = true;
  for (let i = 0; i < 6; i += 1) {
    const triangle = AROUND_TRIANGLES[i]!;
    if (triangle === OUT_OF_BOUNDS) {
      allMineable = false;
      allBuildable = false;
      break;
    }
    const properties = world.propertiesOfTriangle(triangle);
    if (!properties.mineable) allMineable = false;
    if (!properties.buildable) allBuildable = false;
  }

  if (allMineable) return BuildSpace.Mine;
  if (!allBuildable) return flagPossible ? BuildSpace.Flag : BuildSpace.None;

  const slope = world.maxSlopeAround(point);
  if (slope <= SLOPE_LIMIT.castle) return BuildSpace.Castle;
  if (slope <= SLOPE_LIMIT.house) return BuildSpace.House;
  if (slope <= SLOPE_LIMIT.hut) return BuildSpace.Hut;
  return flagPossible ? BuildSpace.Flag : BuildSpace.None;
}

/** Whether a footprint fits in the space a point offers. */
export function canHostSize(space: BuildSpace, size: BuildingSize): boolean {
  if (size === BuildingSize.Mine) return space === BuildSpace.Mine;
  if (space === BuildSpace.Mine) return false;
  return space >= size;
}

const AROUND_TRIANGLES = new Int32Array(6);
const EDGE_TRIANGLES = new Int32Array(2);
