import { describe, expect, it } from 'vitest';
import { Direction, DIRECTIONS } from '../core/direction';
import { OUT_OF_BOUNDS } from '../core/grid';
import { Hasher } from '../core/hash';
import { BuildSpace, canPlaceFlag, evaluateBuildSpace, MAX_ROAD_SLOPE } from './buildspace';
import { MapObject, Resource, Terrain } from './terrain';
import type { World } from './world';
import { generateWorld } from './worldgen';

const SEEDS = [4242, 726, 99, 11, 1234, 7, 55555, 192792530, 3, 21, 808, 42, 6, 77];

// Twice as wide as it is tall, like the map the game ships: the western half is
// the eastern half turned about, so a test map has to be doubled to give one
// player the room a 64x64 island used to give him.
const OPTIONS = { width: 128, height: 64, seed: 4242, players: 2 } as const;

/**
 * The shape the game ships. The tests below are about the mirror and the range
 * a start is guaranteed, and both are claims about the map a player is actually
 * dealt — a 128x64 island is a third land and a spit besides, which is a
 * different question.
 */
const SHIPPED = { width: 192, height: 96, seed: 4242, players: 2 } as const;

function fingerprint(world: World): string {
  return new Hasher()
    .array(world.height)
    .array(world.terrainSouth)
    .array(world.terrainSouthEast)
    .array(world.object)
    .array(world.objectData)
    .array(world.resource)
    .array(world.resourceAmount)
    .hex();
}

describe('generateWorld', () => {
  it('is a pure function of its seed', () => {
    const a = generateWorld(OPTIONS);
    const b = generateWorld(OPTIONS);

    expect(fingerprint(a.world)).toBe(fingerprint(b.world));
    expect(a.startPoints).toEqual(b.startPoints);
  });

  it('produces a different island for a different seed', () => {
    const a = generateWorld(OPTIONS);
    const b = generateWorld({ ...OPTIONS, seed: OPTIONS.seed + 1 });
    expect(fingerprint(a.world)).not.toBe(fingerprint(b.world));
  });

  it('surrounds the island with water so the map edge is unreachable', () => {
    const { world } = generateWorld(OPTIONS);
    const { grid } = world;

    for (let x = 0; x < grid.width; x += 1) {
      expect(world.terrainSouth[grid.index(x, 0)]).toBe(Terrain.Water);
      expect(world.terrainSouth[grid.index(x, grid.height - 1)]).toBe(Terrain.Water);
    }
    for (let y = 0; y < grid.height; y += 1) {
      expect(world.terrainSouth[grid.index(0, y)]).toBe(Terrain.Water);
      expect(world.terrainSouthEast[grid.index(grid.width - 1, y)]).toBe(Terrain.Water);
    }
  });

  it('finds one viable, well separated start per player', () => {
    const { world, startPoints } = generateWorld(OPTIONS);

    expect(startPoints).toHaveLength(2);
    expect(new Set(startPoints).size).toBe(2);
    expect(world.grid.distance(startPoints[0]!, startPoints[1]!)).toBeGreaterThan(10);
  });

  it('leaves every start site able to take a headquarters', () => {
    const { world, startPoints } = generateWorld(OPTIONS);

    // Ownership is granted by the simulation, not the generator, so stand in
    // for it here to exercise the same rule the game will apply.
    world.owner.fill(1);

    for (const point of startPoints) {
      expect(evaluateBuildSpace(world, point, 1)).toBe(BuildSpace.Castle);
    }
  });

  it('clears the ground immediately around each start', () => {
    const { world, startPoints } = generateWorld(OPTIONS);

    for (const point of startPoints) {
      for (const near of world.grid.pointsWithin(point, 3)) {
        expect(world.object[near]).toBe(MapObject.None);
      }
    }
  });

  it('finds somewhere to settle on every island it makes', () => {
    // Judging the apron on natural ground rejected whole islands. It is levelled
    // now instead, so a site is only ever turned down on its own merits.
    for (const seed of SEEDS) {
      expect(() => generateWorld({ ...OPTIONS, seed })).not.toThrow();
    }
  });

  it('holds the apron dead level, so nothing on it can be cliff or pond', () => {
    for (const seed of SEEDS) {
      const { world, startPoints } = generateWorld({ ...OPTIONS, seed });

      for (const point of startPoints) {
        const level = world.height[point]!;
        for (const near of world.grid.pointsWithin(point, 3)) {
          expect(world.height[near]).toBe(level);
        }
      }
    }
  });

  it('leaves an apron three nodes wide that can actually be built on', () => {
    for (const seed of SEEDS) {
      const { world, startPoints } = generateWorld({ ...OPTIONS, seed });
      world.owner.fill(1);

      for (const point of startPoints) {
        for (const near of world.grid.pointsWithin(point, 3)) {
          // Swept of trees and stone is not enough: a pond or a crag on the
          // doorstep would block the first roads out of the headquarters. Every
          // node in the apron has to take a flag, which is what a road needs.
          expect(world.object[near]).toBe(MapObject.None);
          expect(canPlaceFlag(world, near, 1)).toBe(true);
        }
      }
    }
  });

  it('gives every start wood and stone within its own borders', () => {
    for (const seed of SEEDS) {
      const { world, startPoints } = generateWorld({ ...OPTIONS, seed });

      for (const point of startPoints) {
        const nearby = world.grid.pointsWithin(point, 9);
        const trees = nearby.filter((p) => world.object[p] === MapObject.Tree).length;
        const stone = nearby.filter((p) => world.object[p] === MapObject.Stone).length;

        // Enough to open with, on every seed rather than the lucky ones: a
        // start with three trees and no granite has nowhere to go.
        expect(trees).toBeGreaterThanOrEqual(20);
        expect(stone).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('only ever writes known terrain values', () => {
    const { world } = generateWorld(OPTIONS);
    const known = new Set<number>(Object.values(Terrain));

    for (let i = 0; i < world.grid.size; i += 1) {
      expect(known.has(world.terrainSouth[i]!)).toBe(true);
      expect(known.has(world.terrainSouthEast[i]!)).toBe(true);
    }
  });
});

describe('the two halves of the map', () => {
  /**
   * The map is one lattice turned half a turn onto itself, so that the two
   * players are dealt the same country rather than whatever the noise happened
   * to give each of them. This is the whole of that claim in one assertion:
   * every array the world carries, at every point, matching its opposite
   * number.
   */
  it('deals both players exactly the same ground', () => {
    for (const seed of SEEDS) {
      const { world } = generateWorld({ ...SHIPPED, seed });
      const { grid } = world;

      let off = 0;
      for (let point = 0; point < grid.size; point += 1) {
        const opposite = grid.mirrored(point);
        if (
          world.height[point] !== world.height[opposite] ||
          world.object[point] !== world.object[opposite] ||
          world.objectData[point] !== world.objectData[opposite] ||
          world.resource[point] !== world.resource[opposite] ||
          world.resourceAmount[point] !== world.resourceAmount[opposite]
        ) {
          off += 1;
        }
      }
      expect(off).toBe(0);
    }
  });

  /**
   * Terrain lives on the triangles between points, and the half-turn sends a
   * point's southern triangle to the south-eastern triangle of a point one step
   * north-west of its opposite number. Worth asserting separately: heights
   * matching would not by itself make the *ground* match.
   */
  it('gives both halves the same terrain, triangle for triangle', () => {
    const { world } = generateWorld(SHIPPED);
    const { grid } = world;

    let off = 0;
    for (let point = 0; point < grid.size; point += 1) {
      const opposite = grid.neighbour(grid.mirrored(point), Direction.NorthWest);
      if (opposite === OUT_OF_BOUNDS) continue;
      if (world.terrainSouth[point] !== world.terrainSouthEast[opposite]) off += 1;
      if (world.terrainSouthEast[point] !== world.terrainSouth[opposite]) off += 1;
    }
    expect(off).toBe(0);
  });

  it('puts the second player opposite the first', () => {
    for (const seed of SEEDS) {
      const { world, startPoints } = generateWorld({ ...SHIPPED, seed });
      expect(startPoints).toHaveLength(2);
      expect(world.grid.mirrored(startPoints[0]!)).toBe(startPoints[1]!);

      // And in his own half, not crowded against the middle with him.
      expect(world.grid.xOf(startPoints[0]!)).toBeLessThan(world.grid.width / 3);
    }
  });

  /**
   * The halves are not stamped: heights and terrain are generated symmetric, by
   * blending each noise field with its own reflection. A stamp would be simpler
   * and would leave a cliff down the join.
   *
   * Islands have real cliffs, so an absolute figure would say nothing, and a
   * whole third of the map is far too coarse a window — a stamped join is one
   * column in ninety-six, which vanishes into the average. So this measures the
   * join itself: the step from the last column of the western half to the first
   * of the eastern, against the step between neighbours everywhere else. A
   * stamp puts two unrelated pieces of noise against each other there, and the
   * join comes out several times rougher than the ground around it.
   */
  it('leaves no cliff down the middle where the halves meet', () => {
    let acrossJoin = 0;
    let joinPairs = 0;
    let elsewhere = 0;
    let elsewherePairs = 0;

    // Totalled over every seed rather than judged one at a time: an island can
    // have a bay right down the middle, and a join under water has nothing to
    // say either way.
    for (const seed of SEEDS) {
      const { world } = generateWorld({ ...SHIPPED, seed });
      const { grid } = world;
      const join = grid.width >> 1;

      for (let point = 0; point < grid.size; point += 1) {
        const east = grid.neighbour(point, Direction.East);
        if (east === OUT_OF_BOUNDS) continue;
        // Dry land either side: a cliff into the sea is not a road's problem.
        if (world.height[point]! < 13 || world.height[east]! < 13) continue;

        const step = Math.abs(world.height[point]! - world.height[east]!);
        if (grid.xOf(east) === join) {
          acrossJoin += step;
          joinPairs += 1;
        } else {
          elsewhere += step;
          elsewherePairs += 1;
        }
      }
    }

    expect(joinPairs).toBeGreaterThan(100);
    expect(acrossJoin / joinPairs).toBeLessThan((elsewhere / elsewherePairs) * 1.5);
  });

  it('refuses a map with an odd number of rows, which cannot be mirrored', () => {
    expect(() => generateWorld({ ...SHIPPED, height: 65 })).toThrow(/even height/);
  });
});

describe('the range every start is given', () => {
  /**
   * Counted over sixteen seeds before this landed, six islands in eight had no
   * ore at all and four no mineable rock whatever. A start with no iron and no
   * coal has no army and no tools, so the shortfall is planted the way wood and
   * stone already were.
   */
  it('puts iron and coal within reach of every start on every seed', () => {
    for (const seed of SEEDS) {
      const { world, startPoints } = generateWorld({ ...SHIPPED, seed });

      for (const start of startPoints) {
        let iron = 0;
        let coal = 0;
        for (const point of world.grid.pointsWithin(start, 24)) {
          if (world.resource[point] === Resource.Iron) iron += 1;
          if (world.resource[point] === Resource.Coal) coal += 1;
        }
        // A mine works one node and exhausts it, so a dozen of each is several
        // mines' worth rather than a token seam.
        expect(iron).toBeGreaterThanOrEqual(12);
        expect(coal).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('keeps the rock out of the apron, a proper walk from the door', () => {
    for (const seed of SEEDS) {
      const { world, startPoints } = generateWorld({ ...SHIPPED, seed });

      for (const start of startPoints) {
        for (const point of world.grid.pointsWithin(start, 7)) {
          // Nothing mineable on the doorstep, and nothing to mine there either.
          expect(world.resource[point]).not.toBe(Resource.Iron);
          expect(world.resource[point]).not.toBe(Resource.Coal);
        }
      }
    }
  });

  /**
   * A range a mine cannot be roaded to is no use to anybody. The skirt eases
   * back to the natural ground over five nodes for exactly this reason, and
   * this is the test that would catch it being made steeper: it walks out from
   * the hall taking only steps a road could take, and asks whether the ore is
   * on the far side of anything.
   */
  it('leaves a way up to the ore that a road could climb', () => {
    for (const seed of SEEDS) {
      const { world, startPoints } = generateWorld({ ...SHIPPED, seed });
      const { grid } = world;
      const start = startPoints[0]!;

      const reached = new Set<number>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const point = queue.shift()!;
        for (const direction of DIRECTIONS) {
          const near = grid.neighbour(point, direction);
          if (near === OUT_OF_BOUNDS || reached.has(near)) continue;
          if (!world.isWalkable(near)) continue;
          if (Math.abs(world.height[near]! - world.height[point]!) > MAX_ROAD_SLOPE) continue;
          reached.add(near);
          queue.push(near);
        }
      }

      const ore = grid
        .pointsWithin(start, 24)
        .filter((point) => world.resource[point] === Resource.Iron);
      expect(ore.length).toBeGreaterThan(0);
      expect(ore.some((point) => reached.has(point))).toBe(true);
    }
  });
});
