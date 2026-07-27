import { beforeEach, describe, expect, it } from 'vitest';
import { Direction } from '../core/direction';
import { MapGrid } from '../core/grid';
import {
  BuildingSize,
  BuildSpace,
  canHostSize,
  canPlaceFlag,
  canRouteRoadThrough,
  canTraverseEdge,
  evaluateBuildSpace,
  FLAG_DIRECTION,
} from './buildspace';
import { MapObject, Terrain } from './terrain';
import { World } from './world';

const PLAYER = 1;

/** A flat, fully owned meadow — every rule under test starts from "allowed". */
function flatWorld(size = 14): World {
  const world = new World(new MapGrid(size, size));
  world.height.fill(10);
  world.terrainSouth.fill(Terrain.Meadow);
  world.terrainSouthEast.fill(Terrain.Meadow);
  world.owner.fill(PLAYER);
  return world;
}

describe('evaluateBuildSpace', () => {
  let world: World;
  let centre: number;

  beforeEach(() => {
    world = flatWorld();
    centre = world.grid.index(7, 7);
  });

  it('offers a castle on level, open, owned ground', () => {
    expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Castle);
  });

  it('refuses land owned by nobody', () => {
    world.owner[centre] = 0;
    expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.None);
  });

  it('refuses land owned by another player', () => {
    expect(evaluateBuildSpace(world, centre, 2)).toBe(BuildSpace.None);
  });

  it('offers nothing at all on the border of the territory', () => {
    // Taking one neighbour away makes this point a border point. Not even a
    // flag belongs there: ground has to be claimed before it is built on.
    world.owner[world.grid.neighbour(centre, Direction.NorthEast)] = 0;
    expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.None);
    expect(canPlaceFlag(world, centre, PLAYER)).toBe(false);
  });

  it('refuses a point occupied by a tree or stone', () => {
    world.object[centre] = MapObject.Tree;
    expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.None);

    world.object[centre] = MapObject.Stone;
    expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.None);
  });

  it('keeps buildings apart', () => {
    world.building[world.grid.neighbour(centre, Direction.West)] = 42;
    expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Flag);
  });

  describe('slope', () => {
    it('steps down through the footprints as the ground steepens', () => {
      const neighbour = world.grid.neighbour(centre, Direction.East);

      world.height[neighbour] = 11;
      expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Castle);

      world.height[neighbour] = 12;
      expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.House);

      world.height[neighbour] = 13;
      expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Hut);

      world.height[neighbour] = 14;
      expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Flag);
    });
  });

  describe('terrain', () => {
    it('offers a mine where the point is ringed by mountain', () => {
      world.terrainSouth.fill(Terrain.Mountain);
      world.terrainSouthEast.fill(Terrain.Mountain);
      expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Mine);
    });

    it('refuses a building where any surrounding triangle is unbuildable', () => {
      world.terrainSouth[centre] = Terrain.Water;
      const space = evaluateBuildSpace(world, centre, PLAYER);
      expect(space).not.toBe(BuildSpace.Castle);
      expect(space).toBe(BuildSpace.Flag);
    });
  });

  it('refuses a building with nowhere to put its flag', () => {
    // Block the flag point with a neighbouring flag, which forbids a new one.
    const flagPoint = world.grid.neighbour(centre, FLAG_DIRECTION);
    world.flag[world.grid.neighbour(flagPoint, Direction.East)] = 7;
    expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Flag);
  });
});

describe('canPlaceFlag', () => {
  it('accepts open owned ground', () => {
    const world = flatWorld();
    expect(canPlaceFlag(world, world.grid.index(7, 7), PLAYER)).toBe(true);
  });

  it('refuses a point next to an existing flag', () => {
    const world = flatWorld();
    const centre = world.grid.index(7, 7);
    world.flag[world.grid.neighbour(centre, Direction.West)] = 3;
    expect(canPlaceFlag(world, centre, PLAYER)).toBe(false);
  });

  it('refuses water', () => {
    const world = flatWorld();
    world.terrainSouth.fill(Terrain.Water);
    world.terrainSouthEast.fill(Terrain.Water);
    expect(canPlaceFlag(world, world.grid.index(7, 7), PLAYER)).toBe(false);
  });
});

describe('canTraverseEdge', () => {
  it('accepts a gentle step', () => {
    const world = flatWorld();
    const centre = world.grid.index(7, 7);
    world.height[world.grid.neighbour(centre, Direction.East)] = 14;
    expect(canTraverseEdge(world, centre, Direction.East)).toBe(true);
  });

  it('refuses a cliff', () => {
    const world = flatWorld();
    const centre = world.grid.index(7, 7);
    world.height[world.grid.neighbour(centre, Direction.East)] = 15;
    expect(canTraverseEdge(world, centre, Direction.East)).toBe(false);
  });

  it('refuses open water', () => {
    const world = flatWorld();
    world.terrainSouth.fill(Terrain.Water);
    world.terrainSouthEast.fill(Terrain.Water);
    expect(canTraverseEdge(world, world.grid.index(7, 7), Direction.East)).toBe(false);
  });

  it('refuses stepping off the map', () => {
    const world = flatWorld();
    expect(canTraverseEdge(world, world.grid.index(0, 0), Direction.West)).toBe(false);
  });
});

describe('canRouteRoadThrough', () => {
  it('accepts empty owned ground', () => {
    const world = flatWorld();
    expect(canRouteRoadThrough(world, world.grid.index(7, 7), PLAYER)).toBe(true);
  });

  it('refuses a point another road already uses', () => {
    const world = flatWorld();
    const centre = world.grid.index(7, 7);
    world.setRoad(centre, Direction.East, true);
    expect(canRouteRoadThrough(world, centre, PLAYER)).toBe(false);
  });

  it('refuses a point holding a flag', () => {
    const world = flatWorld();
    const centre = world.grid.index(7, 7);
    world.flag[centre] = 9;
    expect(canRouteRoadThrough(world, centre, PLAYER)).toBe(false);
  });
});

describe('canHostSize', () => {
  it('lets smaller buildings use larger sites', () => {
    expect(canHostSize(BuildSpace.Castle, BuildingSize.Hut)).toBe(true);
    expect(canHostSize(BuildSpace.Castle, BuildingSize.Castle)).toBe(true);
    expect(canHostSize(BuildSpace.Hut, BuildingSize.Castle)).toBe(false);
  });

  it('keeps mines and ordinary buildings apart', () => {
    expect(canHostSize(BuildSpace.Mine, BuildingSize.Mine)).toBe(true);
    expect(canHostSize(BuildSpace.Mine, BuildingSize.Hut)).toBe(false);
    expect(canHostSize(BuildSpace.Castle, BuildingSize.Mine)).toBe(false);
  });

  it('refuses everything on an unusable point', () => {
    expect(canHostSize(BuildSpace.None, BuildingSize.Hut)).toBe(false);
    expect(canHostSize(BuildSpace.Flag, BuildingSize.Hut)).toBe(false);
  });
});
