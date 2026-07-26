import { Direction, DIRECTIONS, isCanonicalRoadDirection, opposite } from './direction';

/** Returned by `neighbour` when a step would leave the map. */
export const OUT_OF_BOUNDS = -1;

/**
 * The world is a lattice of *points*, not a grid of square tiles — the geometry
 * The Settlers II uses and the reason its roads and terrain look the way they
 * do. Points are stored row-major in a rectangular array; odd-numbered rows sit
 * half a step further east, which gives every point six equidistant neighbours.
 *
 * Buildings, flags and settlers all live on points. Terrain lives on the
 * triangles *between* points: each point owns the triangle directly below it
 * and the one below-right of it, which between them tile the whole map.
 *
 * The map does not wrap. World generation surrounds it with a ring of
 * unbuildable water so the edge is never reachable in play.
 */
export class MapGrid {
  readonly width: number;
  readonly height: number;
  readonly size: number;

  constructor(width: number, height: number) {
    if (width < 3 || height < 3) {
      throw new Error(`map must be at least 3x3, received ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.size = width * height;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  xOf(index: number): number {
    return index % this.width;
  }

  yOf(index: number): number {
    return (index / this.width) | 0;
  }

  contains(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** The neighbouring point index, or `OUT_OF_BOUNDS` at the map edge. */
  neighbour(index: number, direction: Direction): number {
    const y = (index / this.width) | 0;
    const x = index - y * this.width;
    const odd = (y & 1) === 1;

    let nx = x;
    let ny = y;

    switch (direction) {
      case Direction.West:
        nx = x - 1;
        break;
      case Direction.East:
        nx = x + 1;
        break;
      case Direction.NorthWest:
        nx = odd ? x : x - 1;
        ny = y - 1;
        break;
      case Direction.NorthEast:
        nx = odd ? x + 1 : x;
        ny = y - 1;
        break;
      case Direction.SouthWest:
        nx = odd ? x : x - 1;
        ny = y + 1;
        break;
      case Direction.SouthEast:
        nx = odd ? x + 1 : x;
        ny = y + 1;
        break;
    }

    if (!this.contains(nx, ny)) return OUT_OF_BOUNDS;
    return ny * this.width + nx;
  }

  /**
   * Writes all six neighbours into `out`, indexed by direction. Entries may be
   * `OUT_OF_BOUNDS`. Reusing a caller-owned array keeps the hot simulation
   * loops free of allocation.
   */
  neighboursInto(index: number, out: Int32Array): void {
    for (const direction of DIRECTIONS) {
      out[direction] = this.neighbour(index, direction);
    }
  }

  /**
   * Canonicalises a lattice edge to the (point, direction) pair that owns it,
   * so an edge is always stored in exactly one place. Returns `undefined` when
   * the edge leaves the map.
   */
  canonicalEdge(
    index: number,
    direction: Direction,
  ): { readonly point: number; readonly direction: Direction } | undefined {
    if (isCanonicalRoadDirection(direction)) {
      if (this.neighbour(index, direction) === OUT_OF_BOUNDS) return undefined;
      return { point: index, direction };
    }

    const neighbour = this.neighbour(index, direction);
    if (neighbour === OUT_OF_BOUNDS) return undefined;
    return { point: neighbour, direction: opposite(direction) };
  }

  /** Horizontal position in lattice units — odd rows are offset half a step. */
  worldX(index: number): number {
    const y = (index / this.width) | 0;
    const x = index - y * this.width;
    return x + (y & 1) * 0.5;
  }

  /** Vertical position in lattice units. */
  worldY(index: number): number {
    return (index / this.width) | 0;
  }

  /**
   * Every point within `radius` steps of `centre`, including the centre itself,
   * in breadth-first order. Used for territory, resource searches and the area
   * a military building claims.
   */
  pointsWithin(centre: number, radius: number): number[] {
    if (radius < 0) return [];

    const visited = new Set<number>([centre]);
    const result: number[] = [centre];
    let frontier: number[] = [centre];

    for (let step = 0; step < radius; step += 1) {
      const next: number[] = [];
      for (const point of frontier) {
        for (const direction of DIRECTIONS) {
          const neighbour = this.neighbour(point, direction);
          if (neighbour === OUT_OF_BOUNDS || visited.has(neighbour)) continue;
          visited.add(neighbour);
          result.push(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
    }

    return result;
  }

  /** Number of lattice steps between two points. */
  distance(a: number, b: number): number {
    if (a === b) return 0;

    // Convert both to cube coordinates for the hexagonal lattice, where the
    // step distance has a closed form and no search is needed.
    const [ax, ay, az] = this.cubeOf(a);
    const [bx, by, bz] = this.cubeOf(b);
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
  }

  private cubeOf(index: number): [number, number, number] {
    const row = (index / this.width) | 0;
    const col = index - row * this.width;
    // "Odd-row" offset layout to cube coordinates.
    const x = col - ((row - (row & 1)) >> 1);
    const z = row;
    return [x, -x - z, z];
  }
}
