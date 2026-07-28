import { Direction, DIRECTIONS, opposite } from '../core/direction';
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
 * How far a footprint pushes everything else away: nothing may be built within
 * this many nodes of it.
 *
 * The rule reads the same from either side, which is the point. A hut two nodes
 * from a castle satisfies the hut's own reach and breaks the castle's, and it is
 * just as illegal as putting the castle down second would be.
 */
const REACH: Readonly<Record<BuildingSize, number>> = {
  [BuildingSize.Hut]: 1,
  [BuildingSize.House]: 2,
  [BuildingSize.Castle]: 3,
  [BuildingSize.Mine]: 1,
};

export function reachOf(size: BuildingSize): number {
  return REACH[size] ?? 1;
}

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
 *
 * Nothing may be put on the frontier itself, flags included. A flag on the
 * border is a road built on ground that is only half yours, and it let a player
 * creep outwards without ever claiming anything; expanding now means taking the
 * ground first.
 *
 * `ignoreFlagAt` excuses one neighbouring flag from the no-crowding rule. It
 * exists for a building's own doorstep: the flag a building would use sits on a
 * neighbouring node by construction, so without this the one flag that makes a
 * site usable would be the very thing that disqualified it.
 */
export function canPlaceFlag(
  world: World,
  point: number,
  player: number,
  ignoreFlagAt?: number,
): boolean {
  if (!isWellInsideTerritory(world, point, player)) return false;
  if (!isPointClear(world, point)) return false;
  if (!world.isWalkable(point)) return false;

  for (const direction of DIRECTIONS) {
    const neighbour = world.grid.neighbour(point, direction);
    if (neighbour === OUT_OF_BOUNDS) continue;
    if (neighbour === ignoreFlagAt) continue;
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

  // A building needs its own flag on the point to the south-east, and that flag
  // may already be there — put one down and then build behind it, which is how
  // a player who has laid his roads first expects to work.
  const flagPoint = world.grid.neighbour(point, FLAG_DIRECTION);
  const standing = flagPoint !== OUT_OF_BOUNDS ? world.flag[flagPoint] : 0;

  // `canPlaceFlag` keeps the frontier clear too, so a point on the border offers
  // nothing at all. A building is judged with its own doorstep excused from the
  // no-crowding rule; a flag never is, since flags really cannot crowd.
  const flagPossible = canPlaceFlag(world, point, player);
  const buildingPossible =
    standing !== 0 ? canPlaceFlag(world, point, player, flagPoint) : flagPossible;
  if (!flagPossible && !buildingPossible) return BuildSpace.None;

  // Where only a building is possible, "just a flag" is not an answer.
  const flagVerdict = flagPossible ? BuildSpace.Flag : BuildSpace.None;

  // A road already runs through here. A flag is still welcome — it divides the
  // road in two — but a building would leave carriers walking through its walls.
  if (world.roadCount(point) > 0) return flagVerdict;

  // How much elbow room the surroundings leave. A hut only wants no neighbour
  // building; bigger footprints want progressively more room around them.
  const spacing = largestBySpacing(world, point, flagPoint);
  if (spacing === BuildSpace.None) return flagVerdict;

  const flagUsable =
    flagPoint !== OUT_OF_BOUNDS &&
    (standing !== 0
      ? world.owner[flagPoint] === player && !servesABuilding(world, flagPoint)
      : canPlaceFlag(world, flagPoint, player));
  if (!flagUsable) return flagVerdict;

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

  // A mine goes into the mountain, where nothing else can be built at all, so
  // it answers to the small rule and no more.
  if (allMineable) return BuildSpace.Mine;
  if (!allBuildable) return flagVerdict;

  const slope = world.maxSlopeAround(point);
  const bySlope =
    slope <= SLOPE_LIMIT.castle
      ? BuildSpace.Castle
      : slope <= SLOPE_LIMIT.house
        ? BuildSpace.House
        : slope <= SLOPE_LIMIT.hut
          ? BuildSpace.Hut
          : BuildSpace.None;

  const verdict = Math.min(bySlope, spacing) as BuildSpace;
  return verdict === BuildSpace.None ? flagVerdict : verdict;
}

/**
 * The biggest footprint the ground around a site will tolerate.
 *
 * Bigger buildings want more room, and want it emptier:
 *
 *  - a **hut** only asks that no building stands on a neighbouring node;
 *  - a **house** wants its first ring clear of buildings, flags, trees and
 *    stone, and free of roads, with no building in the second ring;
 *  - a **castle** wants both of the first two rings clear of buildings, flags,
 *    trees and stone, and no building in the third.
 *
 * Every building already standing asks the same of this site in return, by its
 * own `reachOf`: a neighbour whose footprint reaches this far leaves no room at
 * all here, however modest the thing being put up. Without that a hut could be
 * dropped two nodes from a castle — legal by the hut's rule, and quietly
 * breaking the castle's.
 *
 * The site's own doorstep is excused throughout — the flag a building uses
 * stands in its first ring by construction — and so is the road that runs into
 * that flag, which is the only road with any business being there.
 *
 * A neighbouring building settles it in six lookups, which is the common case
 * near anything already built. Otherwise the rings are walked outward, and only
 * the verdict falls: a spoiled first ring no longer ends the scan, since a
 * castle further out can still veto the site outright. This runs for every
 * visible node while the build overlay is up.
 */
function largestBySpacing(world: World, point: number, flagPoint: number): BuildSpace {
  const { grid } = world;

  for (const direction of DIRECTIONS) {
    const neighbour = grid.neighbour(point, direction);
    if (neighbour === OUT_OF_BOUNDS) continue;
    if (world.building[neighbour] !== 0) return BuildSpace.None;
  }

  let largest: BuildSpace = BuildSpace.Castle;

  for (const neighbour of ringAt(world, point, 1)) {
    if (neighbour === flagPoint) continue;
    if (!isBareGround(world, neighbour)) largest = BuildSpace.Hut;
    else if (world.roadCount(neighbour) > 0 && !runsIntoTheFlag(world, neighbour, flagPoint)) {
      largest = BuildSpace.Hut;
    }
  }

  for (const further of ringAt(world, point, 2)) {
    if (world.building[further] !== 0) {
      if (withinReach(world, further, 2)) return BuildSpace.None;
      largest = BuildSpace.Hut;
      continue;
    }
    if (further === flagPoint) continue;
    if (largest > BuildSpace.House && !isBareGround(world, further)) largest = BuildSpace.House;
  }

  for (const beyond of ringAt(world, point, 3)) {
    if (world.building[beyond] === 0) continue;
    if (withinReach(world, beyond, 3)) return BuildSpace.None;
    if (largest > BuildSpace.House) largest = BuildSpace.House;
  }

  return largest;
}

/** Whether the building standing on `point` claims the ground `distance` away. */
function withinReach(world: World, point: number, distance: number): boolean {
  const size = world.buildingSize[point];
  return size !== undefined && size !== 0 && reachOf(size as BuildingSize) >= distance;
}

/** The nodes exactly `distance` steps from a point. */
function ringAt(world: World, point: number, distance: number): number[] {
  return world.grid
    .pointsWithin(point, distance)
    .filter((candidate) => world.grid.distance(point, candidate) === distance);
}

/** Nothing built and nothing growing: no building, no flag, no tree, no stone. */
function isBareGround(world: World, point: number): boolean {
  return (
    world.building[point] === 0 &&
    world.flag[point] === 0 &&
    world.object[point] !== MapObject.Tree &&
    world.object[point] !== MapObject.Stone
  );
}

/**
 * Whether a road crossing this node is the one serving the site's own flag.
 *
 * The road a player laid to his doorstep before building is the one road that
 * belongs in the first ring, and it is recognised by having an edge that runs
 * straight into the flag.
 */
function runsIntoTheFlag(world: World, point: number, flagPoint: number): boolean {
  for (const direction of DIRECTIONS) {
    if (!world.hasRoad(point, direction)) continue;
    if (world.grid.neighbour(point, direction) === flagPoint) return true;
  }
  return false;
}

/**
 * Whether a flag is already the doorstep of a building.
 *
 * A building sits on the node opposite its own flag, so one lookup settles it.
 * Two buildings sharing a flag would leave both their goods on one doorstep and
 * neither able to tell which were his.
 */
function servesABuilding(world: World, flagPoint: number): boolean {
  const door = world.grid.neighbour(flagPoint, opposite(FLAG_DIRECTION));
  return door !== OUT_OF_BOUNDS && world.building[door] !== 0;
}

/** Whether a footprint fits in the space a point offers. */
export function canHostSize(space: BuildSpace, size: BuildingSize): boolean {
  if (size === BuildingSize.Mine) return space === BuildSpace.Mine;
  if (space === BuildSpace.Mine) return false;
  return space >= size;
}

const AROUND_TRIANGLES = new Int32Array(6);
const EDGE_TRIANGLES = new Int32Array(2);
