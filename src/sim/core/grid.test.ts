import { describe, expect, it } from 'vitest';
import { Direction, DIRECTIONS, opposite } from './direction';
import { MapGrid, OUT_OF_BOUNDS } from './grid';

describe('MapGrid', () => {
  const grid = new MapGrid(16, 16);

  it('round-trips indices and coordinates', () => {
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        const index = grid.index(x, y);
        expect(grid.xOf(index)).toBe(x);
        expect(grid.yOf(index)).toBe(y);
      }
    }
  });

  it('has symmetric neighbours in every direction', () => {
    for (let index = 0; index < grid.size; index += 1) {
      for (const direction of DIRECTIONS) {
        const neighbour = grid.neighbour(index, direction);
        if (neighbour === OUT_OF_BOUNDS) continue;
        expect(grid.neighbour(neighbour, opposite(direction))).toBe(index);
      }
    }
  });

  it('gives every interior point six distinct neighbours', () => {
    const index = grid.index(8, 8);
    const neighbours = DIRECTIONS.map((direction) => grid.neighbour(index, direction));

    expect(neighbours).not.toContain(OUT_OF_BOUNDS);
    expect(new Set(neighbours).size).toBe(6);
    expect(neighbours).not.toContain(index);
  });

  it('reports out of bounds at the map edge', () => {
    expect(grid.neighbour(grid.index(0, 0), Direction.West)).toBe(OUT_OF_BOUNDS);
    expect(grid.neighbour(grid.index(0, 0), Direction.NorthWest)).toBe(OUT_OF_BOUNDS);
    expect(grid.neighbour(grid.index(15, 15), Direction.East)).toBe(OUT_OF_BOUNDS);
    expect(grid.neighbour(grid.index(15, 15), Direction.SouthEast)).toBe(OUT_OF_BOUNDS);
  });

  it('offsets odd rows half a step east', () => {
    expect(grid.worldX(grid.index(3, 0))).toBe(3);
    expect(grid.worldX(grid.index(3, 1))).toBe(3.5);
    expect(grid.worldY(grid.index(3, 1))).toBe(1);
  });

  describe('canonicalEdge', () => {
    it('maps both ends of an edge to the same owner', () => {
      for (let index = 0; index < grid.size; index += 1) {
        for (const direction of DIRECTIONS) {
          const neighbour = grid.neighbour(index, direction);
          if (neighbour === OUT_OF_BOUNDS) continue;

          const fromHere = grid.canonicalEdge(index, direction);
          const fromThere = grid.canonicalEdge(neighbour, opposite(direction));

          expect(fromHere).toBeDefined();
          expect(fromHere).toEqual(fromThere);
        }
      }
    });

    it('always resolves to east, south-east or south-west', () => {
      const edge = grid.canonicalEdge(grid.index(5, 5), Direction.West);
      expect(edge?.direction).toBe(Direction.East);
      expect(edge?.point).toBe(grid.index(4, 5));
    });

    it('returns undefined for an edge that leaves the map', () => {
      expect(grid.canonicalEdge(grid.index(0, 0), Direction.West)).toBeUndefined();
    });
  });

  describe('distance', () => {
    it('is zero for a point against itself', () => {
      expect(grid.distance(grid.index(4, 4), grid.index(4, 4))).toBe(0);
    });

    it('is one for every direct neighbour', () => {
      const centre = grid.index(8, 8);
      for (const direction of DIRECTIONS) {
        expect(grid.distance(centre, grid.neighbour(centre, direction))).toBe(1);
      }
    });

    it('agrees with breadth-first search', () => {
      const centre = grid.index(8, 8);
      const within = grid.pointsWithin(centre, 4);

      for (const point of within) {
        expect(grid.distance(centre, point)).toBeLessThanOrEqual(4);
      }

      const reachable = new Set(within);
      for (let index = 0; index < grid.size; index += 1) {
        if (grid.distance(centre, index) <= 4) {
          expect(reachable.has(index)).toBe(true);
        }
      }
    });
  });

  describe('pointsWithin', () => {
    it('covers the full hexagon around an interior point', () => {
      // A hexagonal disc of radius r holds 1 + 3r(r + 1) points.
      for (let radius = 0; radius <= 5; radius += 1) {
        const points = grid.pointsWithin(grid.index(8, 8), radius);
        expect(points.length).toBe(1 + 3 * radius * (radius + 1));
        expect(new Set(points).size).toBe(points.length);
      }
    });

    it('clips at the map edge', () => {
      const points = grid.pointsWithin(grid.index(0, 0), 2);
      expect(points.length).toBeLessThan(1 + 3 * 2 * 3);
      expect(points[0]).toBe(grid.index(0, 0));
    });
  });
});
