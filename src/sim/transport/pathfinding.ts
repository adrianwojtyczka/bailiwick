import { DIRECTIONS } from '../core/direction';
import { OUT_OF_BOUNDS } from '../core/grid';
import type { EntityTable } from '../entities/registry';
import type { Flag, Road } from '../entities/types';
import { canPlaceFlag, canRouteRoadThrough, canTraverseEdge, MAX_ROAD_SLOPE } from '../world/buildspace';
import type { World } from '../world/world';
import type { FlagNetwork } from './flag-graph';

/**
 * Expands a flag-to-flag route into the lattice points a settler actually
 * walks, following each road's own list of points in the right direction.
 *
 * The returned path excludes the starting point, since the settler is already
 * standing on it.
 */
export function roadPointPath(
  network: FlagNetwork,
  roads: EntityTable<Road>,
  fromFlag: number,
  toFlag: number,
): number[] | undefined {
  if (fromFlag === toFlag) return [];

  const path: number[] = [];
  let current = fromFlag;

  // The network is a shortest-path tree, so this terminates; the guard only
  // protects against a corrupted graph.
  for (let guard = 0; guard < 4096; guard += 1) {
    if (current === toFlag) return path;

    const step = network.next(current, toFlag);
    if (!step) return undefined;

    const road = roads.get(step.road);
    if (!road) return undefined;

    const forwards = road.fromFlag === current;
    if (forwards) {
      for (let i = 1; i < road.points.length; i += 1) path.push(road.points[i]!);
    } else {
      for (let i = road.points.length - 2; i >= 0; i -= 1) path.push(road.points[i]!);
    }

    current = step.nextFlag;
  }

  return undefined;
}

/** The lattice point a settler standing at `flag` occupies. */
export function flagPoint(flags: EntityTable<Flag>, flagId: number): number | undefined {
  return flags.get(flagId)?.point;
}

/**
 * Works out where a road from `from` to `to` should run.
 *
 * The player drags towards a destination and the game finds the line, exactly
 * as dragging a road in the original does. The returned list starts at `from`
 * and ends at `to`, and satisfies every rule `placeRoad` will check — so a
 * planned road is always a road that can actually be laid.
 *
 * Returns undefined when no legal line exists.
 */
export function planRoad(
  world: World,
  from: number,
  to: number,
  player: number,
  maxExpansions = 4000,
): number[] | undefined {
  if (from === to) return undefined;
  if (world.flag[from] === 0) return undefined;

  const endHasFlag = world.flag[to] !== 0;
  if (endHasFlag) {
    if (world.owner[to] !== player) return undefined;
  } else if (!canPlaceFlag(world, to, player)) {
    return undefined;
  }

  const { grid } = world;
  const cameFrom = new Map<number, number>();
  const costSoFar = new Map<number, number>([[from, 0]]);
  const frontier: { point: number; priority: number }[] = [
    { point: from, priority: grid.distance(from, to) },
  ];

  let expansions = 0;

  while (frontier.length > 0 && expansions < maxExpansions) {
    let bestIndex = 0;
    for (let i = 1; i < frontier.length; i += 1) {
      if (frontier[i]!.priority < frontier[bestIndex]!.priority) bestIndex = i;
    }
    const current = frontier.splice(bestIndex, 1)[0]!.point;
    expansions += 1;

    if (current === to) {
      const path = [to];
      let node = to;
      while (node !== from) {
        const previous = cameFrom.get(node);
        if (previous === undefined) return undefined;
        path.push(previous);
        node = previous;
      }
      path.reverse();
      return path;
    }

    const currentCost = costSoFar.get(current)!;

    for (const direction of DIRECTIONS) {
      const neighbour = grid.neighbour(current, direction);
      if (neighbour === OUT_OF_BOUNDS) continue;
      if (!canTraverseEdge(world, current, direction)) continue;
      if (world.hasRoad(current, direction)) continue;
      // Only the far end may already be occupied, and only by its flag.
      if (neighbour !== to && !canRouteRoadThrough(world, neighbour, player)) continue;

      // Climbing costs more, which nudges roads around hills rather than over.
      const climb = Math.abs(world.height[neighbour]! - world.height[current]!);
      const next = currentCost + 1 + climb;

      const known = costSoFar.get(neighbour);
      if (known !== undefined && known <= next) continue;

      costSoFar.set(neighbour, next);
      cameFrom.set(neighbour, current);
      frontier.push({ point: neighbour, priority: next + grid.distance(neighbour, to) });
    }
  }

  return undefined;
}

/**
 * A* across open ground, for the short trips workers make off the road network
 * — a woodcutter walking to a tree, a forester to a planting spot.
 *
 * Deliberately bounded: these journeys are always short, and refusing to search
 * further keeps a blocked worker from stalling the whole tick.
 *
 * Not *that* short, though. The bound used to be 1500, which was ample on a map
 * 96 nodes across and quietly too small on one 192 wide: a man turned out of a
 * post a hundred nodes from his own hall found no way home along ground he
 * could plainly walk, and `sendHome` took him in on the spot instead — a man
 * crossing the island without walking it. The road home in that case is 105
 * steps and wants a shade over 2000 expansions. A hopeless search still costs
 * about seven milliseconds, well inside a 200 ms tick.
 */
export function walkablePath(
  world: World,
  from: number,
  to: number,
  maxExpansions = 4000,
): number[] | undefined {
  if (from === to) return [];

  const { grid } = world;
  const cameFrom = new Map<number, number>();
  const costSoFar = new Map<number, number>([[from, 0]]);

  // Small frontier, so a sorted array beats the bookkeeping of a heap.
  const frontier: { point: number; priority: number }[] = [
    { point: from, priority: grid.distance(from, to) },
  ];

  let expansions = 0;

  while (frontier.length > 0 && expansions < maxExpansions) {
    let bestIndex = 0;
    for (let i = 1; i < frontier.length; i += 1) {
      if (frontier[i]!.priority < frontier[bestIndex]!.priority) bestIndex = i;
    }
    const current = frontier.splice(bestIndex, 1)[0]!.point;
    expansions += 1;

    if (current === to) {
      const path: number[] = [];
      let node = to;
      while (node !== from) {
        path.push(node);
        const previous = cameFrom.get(node);
        if (previous === undefined) return undefined;
        node = previous;
      }
      path.reverse();
      return path;
    }

    const currentCost = costSoFar.get(current)!;

    for (const direction of DIRECTIONS) {
      const neighbour = grid.neighbour(current, direction);
      if (neighbour === OUT_OF_BOUNDS) continue;

      // The destination itself may hold the tree or outcrop being walked to,
      // so only intermediate points must be clear.
      if (neighbour !== to && world.building[neighbour] !== 0) continue;
      if (!world.isWalkable(neighbour)) continue;
      if (Math.abs(world.height[neighbour]! - world.height[current]!) > MAX_ROAD_SLOPE) continue;

      const next = currentCost + 1;
      const known = costSoFar.get(neighbour);
      if (known !== undefined && known <= next) continue;

      costSoFar.set(neighbour, next);
      cameFrom.set(neighbour, current);
      frontier.push({ point: neighbour, priority: next + grid.distance(neighbour, to) });
    }
  }

  return undefined;
}
