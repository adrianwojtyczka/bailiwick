import { Direction, DIRECTIONS } from '../core/direction';
import type { MapGrid } from '../core/grid';
import { OUT_OF_BOUNDS } from '../core/grid';
import type { TerrainProperties } from './terrain';
import { terrainOf } from './terrain';

/**
 * A terrain triangle, encoded as `point * 2 + kind`.
 *
 * Every lattice point owns two triangles — the one directly below it and the
 * one below-right of it — and between them they tile the entire map.
 */
export const TriangleKind = {
  /** (P, south-west of P, south-east of P) — the triangle below the point. */
  South: 0,
  /** (P, east of P, south-east of P) — the triangle below-right of the point. */
  SouthEast: 1,
} as const;

export type TriangleKind = (typeof TriangleKind)[keyof typeof TriangleKind];

/** Bit positions for the three canonical road directions. */
const ROAD_BIT: Readonly<Record<number, number>> = {
  [Direction.East]: 1,
  [Direction.SouthEast]: 2,
  [Direction.SouthWest]: 4,
};

/**
 * The mutable state of the map itself: heights, terrain, objects, ownership,
 * roads and what occupies each point.
 *
 * Everything is a typed array indexed by lattice point, so the whole map is a
 * handful of contiguous buffers — cheap to snapshot for saves, cheap to hash
 * for the determinism tests, and free of per-tick garbage.
 */
export class World {
  readonly grid: MapGrid;

  /** Altitude per point. Differences between neighbours drive slope rules. */
  readonly height: Uint8Array;

  /** Terrain of each point's two triangles. */
  readonly terrainSouth: Uint8Array;
  readonly terrainSouthEast: Uint8Array;

  /** What stands on the point: a tree, a granite outcrop, a field, nothing. */
  readonly object: Uint8Array;
  /** Object payload — tree growth stage, remaining stone, field ripeness. */
  readonly objectData: Uint8Array;

  /** Underground resource kind and remaining amount. */
  readonly resource: Uint8Array;
  readonly resourceAmount: Uint8Array;
  /** Bitmask of players who have surveyed this point with a geologist. */
  readonly resourceKnown: Uint8Array;

  /** Owning player, 0 for unclaimed land. */
  readonly owner: Uint8Array;

  /** Road bits for the three canonical directions (east, SE, SW). */
  readonly roads: Uint8Array;

  /** Building and flag occupying the point, 0 for none. */
  readonly building: Int32Array;
  readonly flag: Int32Array;

  constructor(grid: MapGrid) {
    this.grid = grid;
    const size = grid.size;

    this.height = new Uint8Array(size);
    this.terrainSouth = new Uint8Array(size);
    this.terrainSouthEast = new Uint8Array(size);
    this.object = new Uint8Array(size);
    this.objectData = new Uint8Array(size);
    this.resource = new Uint8Array(size);
    this.resourceAmount = new Uint8Array(size);
    this.resourceKnown = new Uint8Array(size);
    this.owner = new Uint8Array(size);
    this.roads = new Uint8Array(size);
    this.building = new Int32Array(size);
    this.flag = new Int32Array(size);
  }

  // ---------------------------------------------------------------- terrain

  terrainOfTriangle(triangle: number): number {
    const point = triangle >> 1;
    return (triangle & 1) === TriangleKind.SouthEast
      ? this.terrainSouthEast[point]!
      : this.terrainSouth[point]!;
  }

  propertiesOfTriangle(triangle: number): TerrainProperties {
    return terrainOf(this.terrainOfTriangle(triangle));
  }

  /**
   * Writes the six triangles meeting at `point` into `out`. Entries are
   * `OUT_OF_BOUNDS` where the map ends.
   */
  trianglesAroundPoint(point: number, out: Int32Array): void {
    const west = this.grid.neighbour(point, Direction.West);
    const northWest = this.grid.neighbour(point, Direction.NorthWest);
    const northEast = this.grid.neighbour(point, Direction.NorthEast);

    out[0] = point * 2 + TriangleKind.South;
    out[1] = point * 2 + TriangleKind.SouthEast;
    out[2] = west === OUT_OF_BOUNDS ? OUT_OF_BOUNDS : west * 2 + TriangleKind.SouthEast;
    out[3] = northWest === OUT_OF_BOUNDS ? OUT_OF_BOUNDS : northWest * 2 + TriangleKind.South;
    out[4] = northWest === OUT_OF_BOUNDS ? OUT_OF_BOUNDS : northWest * 2 + TriangleKind.SouthEast;
    out[5] = northEast === OUT_OF_BOUNDS ? OUT_OF_BOUNDS : northEast * 2 + TriangleKind.South;
  }

  /**
   * The two triangles flanking the edge that leaves `point` in a canonical
   * road direction. Entries may be `OUT_OF_BOUNDS` at the map edge.
   */
  trianglesAlongEdge(point: number, direction: Direction, out: Int32Array): void {
    switch (direction) {
      case Direction.East: {
        const northEast = this.grid.neighbour(point, Direction.NorthEast);
        out[0] = point * 2 + TriangleKind.SouthEast;
        out[1] = northEast === OUT_OF_BOUNDS ? OUT_OF_BOUNDS : northEast * 2 + TriangleKind.South;
        return;
      }
      case Direction.SouthEast: {
        out[0] = point * 2 + TriangleKind.South;
        out[1] = point * 2 + TriangleKind.SouthEast;
        return;
      }
      case Direction.SouthWest: {
        const west = this.grid.neighbour(point, Direction.West);
        out[0] = point * 2 + TriangleKind.South;
        out[1] = west === OUT_OF_BOUNDS ? OUT_OF_BOUNDS : west * 2 + TriangleKind.SouthEast;
        return;
      }
      default:
        throw new Error(`edge triangles require a canonical direction, received ${direction}`);
    }
  }

  // ------------------------------------------------------------------ roads

  hasRoad(point: number, direction: Direction): boolean {
    const edge = this.grid.canonicalEdge(point, direction);
    if (!edge) return false;
    return (this.roads[edge.point]! & ROAD_BIT[edge.direction]!) !== 0;
  }

  setRoad(point: number, direction: Direction, present: boolean): void {
    const edge = this.grid.canonicalEdge(point, direction);
    if (!edge) return;
    const bit = ROAD_BIT[edge.direction]!;
    const current = this.roads[edge.point]!;
    this.roads[edge.point] = present ? current | bit : current & ~bit;
  }

  /** How many of the six directions carry a road out of this point. */
  roadCount(point: number): number {
    let count = 0;
    for (const direction of DIRECTIONS) {
      if (this.hasRoad(point, direction)) count += 1;
    }
    return count;
  }

  /** The steepest height difference between `point` and its neighbours. */
  maxSlopeAround(point: number): number {
    const here = this.height[point]!;
    let steepest = 0;
    for (const direction of DIRECTIONS) {
      const neighbour = this.grid.neighbour(point, direction);
      if (neighbour === OUT_OF_BOUNDS) continue;
      const delta = Math.abs(this.height[neighbour]! - here);
      if (delta > steepest) steepest = delta;
    }
    return steepest;
  }

  /** Height difference across one edge, signed from `point` towards `direction`. */
  slopeTowards(point: number, direction: Direction): number {
    const neighbour = this.grid.neighbour(point, direction);
    if (neighbour === OUT_OF_BOUNDS) return 0;
    return this.height[neighbour]! - this.height[point]!;
  }

  /** True when a settler may stand on this point at all. */
  isWalkable(point: number): boolean {
    const triangles = SCRATCH_TRIANGLES;
    this.trianglesAroundPoint(point, triangles);
    for (let i = 0; i < 6; i += 1) {
      const triangle = triangles[i]!;
      if (triangle === OUT_OF_BOUNDS) continue;
      if (this.propertiesOfTriangle(triangle).walkable) return true;
    }
    return false;
  }

  /**
   * How many of the six triangles meeting at a point will grow corn. A farmer
   * needs most of them, not all: a field may lie along the edge of good ground.
   */
  farmableSides(point: number): number {
    const triangles = SCRATCH_TRIANGLES;
    this.trianglesAroundPoint(point, triangles);

    let sides = 0;
    for (let i = 0; i < 6; i += 1) {
      const triangle = triangles[i]!;
      if (triangle === OUT_OF_BOUNDS) continue;
      if (this.propertiesOfTriangle(triangle).farmable) sides += 1;
    }
    return sides;
  }
}

const SCRATCH_TRIANGLES = new Int32Array(6);
