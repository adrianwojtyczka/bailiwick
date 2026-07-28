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

  describe('the room a neighbour has already claimed', () => {
    /** Stands a building of `size` exactly `distance` nodes east of centre. */
    function neighbourAt(size: BuildingSize, distance: number): void {
      let point = centre;
      for (let i = 0; i < distance; i += 1) point = world.grid.neighbour(point, Direction.East);
      expect(world.grid.distance(centre, point)).toBe(distance);

      world.building[point] = 42;
      world.buildingSize[point] = size;
    }

    // A building's reach — 1 for a hut or a mine, 2 for a house, 3 for a castle
    // — binds whoever comes second just as it bound whoever came first.
    const cases: ReadonlyArray<[string, BuildingSize, number, BuildSpace]> = [
      ['a castle leaves nothing two nodes away', BuildingSize.Castle, 2, BuildSpace.Flag],
      ['a castle leaves nothing three nodes away', BuildingSize.Castle, 3, BuildSpace.Flag],
      ['a castle four nodes away is no bother', BuildingSize.Castle, 4, BuildSpace.Castle],
      ['a house leaves nothing two nodes away', BuildingSize.House, 2, BuildSpace.Flag],
      ['a house three nodes away allows a house', BuildingSize.House, 3, BuildSpace.House],
      ['a hut two nodes away allows a hut', BuildingSize.Hut, 2, BuildSpace.Hut],
      ['a hut three nodes away allows a house', BuildingSize.Hut, 3, BuildSpace.House],
      ['a hut four nodes away allows a castle', BuildingSize.Hut, 4, BuildSpace.Castle],
      ['a mine two nodes away allows a hut', BuildingSize.Mine, 2, BuildSpace.Hut],
    ];

    for (const [name, size, distance, expected] of cases) {
      it(name, () => {
        neighbourAt(size, distance);
        expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(expected);
      });
    }

    it('judges a building of unknown footprint by the site alone', () => {
      // Nothing in the world says how big it is, so only the candidate's own
      // rule applies — which is what a hand-built world and every old save get.
      const point = world.grid.neighbour(world.grid.neighbour(centre, Direction.East), Direction.East);
      world.building[point] = 42;
      expect(evaluateBuildSpace(world, centre, PLAYER)).toBe(BuildSpace.Hut);
    });
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
