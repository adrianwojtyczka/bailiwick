import { describe, expect, it } from 'vitest';
import { Hasher } from '../core/hash';
import { BuildSpace, evaluateBuildSpace } from './buildspace';
import { MapObject, Terrain } from './terrain';
import type { World } from './world';
import { generateWorld } from './worldgen';

const OPTIONS = { width: 64, height: 64, seed: 4242, players: 2 } as const;

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
      for (const near of world.grid.pointsWithin(point, 2)) {
        expect(world.object[near]).toBe(MapObject.None);
      }
    }
  });

  it('gives every start wood and stone within reach', () => {
    const { world, startPoints } = generateWorld(OPTIONS);

    for (const point of startPoints) {
      const nearby = world.grid.pointsWithin(point, 9);
      const trees = nearby.filter((p) => world.object[p] === MapObject.Tree).length;
      const stone = nearby.filter((p) => world.object[p] === MapObject.Stone).length;

      expect(trees).toBeGreaterThan(0);
      expect(stone).toBeGreaterThan(0);
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
