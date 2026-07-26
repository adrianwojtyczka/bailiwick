import { describe, expect, it } from 'vitest';
import { BuildingType, buildingInfo } from './data/buildings';
import { Ware } from './data/wares';
import { BuildingState, BuildingStatus, FLAG_CAPACITY } from './entities/types';
import { Simulation } from './simulation';
import { planRoad } from './transport/pathfinding';
import { BuildSpace, canHostSize, evaluateBuildSpace } from './world/buildspace';
import { MapObject } from './world/terrain';

const PLAYER = 1;

function newGame(seed = 4242): Simulation {
  return Simulation.create({
    width: 64,
    height: 64,
    seed,
    players: [{ name: 'You', colour: '#c4832b' }],
  });
}

function headquarters(sim: Simulation) {
  return sim.buildings.require(sim.players[0]!.headquarters);
}

/** Picks a legal site for a building, favouring nearby trees or stone. */
function siteFor(
  sim: Simulation,
  type: BuildingType,
  prefers: MapObject | null = null,
): number | undefined {
  const info = buildingInfo(type);
  const hq = headquarters(sim);

  let best: number | undefined;
  let bestScore = -1;

  for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
    if (sim.world.grid.distance(hq.point, point) < 3) continue;
    const space = evaluateBuildSpace(sim.world, point, PLAYER);
    if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;

    let score = 1;
    if (prefers !== null) {
      score = sim.world.grid
        .pointsWithin(point, 6)
        .filter((near) => sim.world.object[near] === prefers).length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = point;
    }
  }

  return bestScore > 0 ? best : undefined;
}

/** Places a building and connects its flag to the headquarters by road. */
function buildAndConnect(
  sim: Simulation,
  type: BuildingType,
  prefers: MapObject | null = null,
): number | undefined {
  const point = siteFor(sim, type, prefers);
  if (point === undefined) return undefined;

  const placed = sim.placeBuilding(PLAYER, point, type);
  if (!placed.ok) return undefined;

  const building = sim.buildings.find((candidate) => candidate.point === point);
  if (!building) return undefined;

  const route = planRoad(sim.world, headquarters(sim).flagPoint, building.flagPoint, PLAYER);
  if (route) sim.placeRoad(PLAYER, route);

  return building.id;
}

function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) sim.update();
}

describe('a new game', () => {
  it('gives the player a stocked headquarters', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    expect(hq.state).toBe(BuildingState.Complete);
    expect(hq.stock[Ware.Board]).toBeGreaterThan(0);
    expect(hq.reserve).toBeGreaterThan(0);
    expect(sim.world.building[hq.point]).toBe(hq.id);
  });

  it('raises the headquarters flag to its south-east', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    expect(sim.world.flag[hq.flagPoint]).toBeGreaterThan(0);
  });

  it('claims territory around the headquarters', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    for (const point of sim.world.grid.pointsWithin(hq.point, 4)) {
      expect(sim.world.owner[point]).toBe(PLAYER);
    }
  });
});

describe('placement rules', () => {
  it('refuses buildings that are not yet available', () => {
    const sim = newGame();
    const point = siteFor(sim, BuildingType.Woodcutter)!;
    const result = sim.placeBuilding(PLAYER, point, BuildingType.Fortress);
    expect(result.ok).toBe(false);
  });

  it('refuses building outside the player territory', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const far = sim.world.grid.index(1, 1);
    expect(sim.world.grid.distance(hq.point, far)).toBeGreaterThan(9);

    const result = sim.placeBuilding(PLAYER, far, BuildingType.Woodcutter);
    expect(result.ok).toBe(false);
  });

  it('refuses a road that does not start at a flag', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const route = planRoad(sim.world, hq.flagPoint, hq.flagPoint, PLAYER);
    expect(route).toBeUndefined();

    const result = sim.placeRoad(PLAYER, [hq.point, hq.flagPoint]);
    expect(result.ok).toBe(false);
  });

  it('lays a planned road and records it on the map', () => {
    const sim = newGame();
    const woodcutter = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    expect(woodcutter).toBeDefined();
    expect(sim.roads.count).toBe(1);

    const road = sim.roads.all()[0]!;
    expect(road.points.length).toBeGreaterThan(1);
    // Both ends carry flags, and the middle of the road is marked on the map.
    expect(sim.world.flag[road.points[0]!]).toBeGreaterThan(0);
    expect(sim.world.roadCount(road.points[1]!)).toBeGreaterThan(0);
  });
});

describe('construction', () => {
  it('draws materials from the headquarters and finishes the building', () => {
    const sim = newGame();
    const boardsBefore = sim.storedWare(PLAYER, Ware.Board);

    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 2500);

    const building = sim.buildings.require(id);
    expect(building.state).toBe(BuildingState.Complete);
    expect(sim.storedWare(PLAYER, Ware.Board)).toBeLessThan(boardsBefore);
    expect(sim.events.some((event) => event.includes('completed'))).toBe(true);
  });

  it('staffs a finished building with a worker', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 2500);

    const building = sim.buildings.require(id);
    expect(building.worker).toBeGreaterThan(0);
    expect(sim.settlers.has(building.worker)).toBe(true);
  });

  it('puts a carrier on every road', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 1200);

    sim.roads.forEach((road) => {
      expect(road.carrier).toBeGreaterThan(0);
    });
  });
});

describe('the wood chain', () => {
  it('carries logs from the woodcutter to the headquarters', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 6000);

    expect(sim.storedWare(PLAYER, Ware.Log)).toBeGreaterThan(0);
  });

  it('turns logs into boards once a sawmill is connected', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    buildAndConnect(sim, BuildingType.Sawmill);

    const before = sim.storedWare(PLAYER, Ware.Board);
    run(sim, 10000);

    expect(sim.storedWare(PLAYER, Ware.Board)).toBeGreaterThan(before);
  });

  it('cuts stone with a quarry', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Quarry, MapObject.Stone);

    const before = sim.storedWare(PLAYER, Ware.Stone);
    run(sim, 8000);

    expect(sim.storedWare(PLAYER, Ware.Stone)).toBeGreaterThan(before);
  });

  it('replants the forest with a forester', () => {
    const sim = newGame();
    const forester = buildAndConnect(sim, BuildingType.Forester)!;
    run(sim, 3000);

    const hut = sim.buildings.require(forester);
    const saplings = sim.world.grid
      .pointsWithin(hut.point, 6)
      .filter((point) => sim.world.object[point] === MapObject.Tree);

    expect(saplings.length).toBeGreaterThan(0);
  });

  it('never lets wares pile up past a flag capacity', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    buildAndConnect(sim, BuildingType.Sawmill);
    buildAndConnect(sim, BuildingType.Quarry, MapObject.Stone);
    run(sim, 12000);

    sim.flags.forEach((flag) => {
      expect(flag.wares.length).toBeLessThanOrEqual(FLAG_CAPACITY);
    });
  });

  it('keeps the network flowing rather than deadlocking a full flag', () => {
    // A sawmill fed by a woodcutter shares one road with its own output. If a
    // carrier always favoured the same end of that road, the outbound boards
    // would queue until the flag filled and the stretch would jam for good.
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    buildAndConnect(sim, BuildingType.Forester);
    buildAndConnect(sim, BuildingType.Sawmill);
    run(sim, 8000);

    const boardsAtEight = sim.storedWare(PLAYER, Ware.Board);
    run(sim, 4000);

    // A jammed network would leave the stored total frozen.
    expect(sim.storedWare(PLAYER, Ware.Board)).toBeGreaterThan(boardsAtEight);
    sim.flags.forEach((flag) => {
      expect(flag.wares.length).toBeLessThan(FLAG_CAPACITY);
    });
  });
});

describe('demolition', () => {
  it('removes a building and frees its site', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    const point = sim.buildings.require(id).point;

    run(sim, 2500);
    expect(sim.demolishBuilding(PLAYER, point).ok).toBe(true);

    expect(sim.buildings.has(id)).toBe(false);
    expect(sim.world.building[point]).toBe(0);
  });

  it('refuses to demolish the headquarters', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    expect(sim.demolishBuilding(PLAYER, hq.point).ok).toBe(false);
  });

  it('keeps running after a road is torn up mid-delivery', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 3000);

    const road = sim.roads.all()[0]!;
    expect(sim.demolishRoad(PLAYER, road.points[1]!).ok).toBe(true);

    expect(() => run(sim, 2000)).not.toThrow();
    sim.flags.forEach((flag) => {
      expect(flag.wares.length).toBeLessThanOrEqual(FLAG_CAPACITY);
    });
  });
});

describe('determinism', () => {
  /** The same opening, played twice, must produce the same world. */
  function playScenario(seed: number): Simulation {
    const sim = newGame(seed);
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 500);
    buildAndConnect(sim, BuildingType.Sawmill);
    run(sim, 500);
    buildAndConnect(sim, BuildingType.Forester);
    run(sim, 4000);
    return sim;
  }

  it('reaches an identical state from identical commands', () => {
    expect(playScenario(4242).hash()).toBe(playScenario(4242).hash());
  });

  it('reaches a different state from a different seed', () => {
    expect(playScenario(4242).hash()).not.toBe(playScenario(99).hash());
  });

  it('advances the hash as the world changes', () => {
    const sim = newGame();
    const early = sim.hash();
    run(sim, 200);
    expect(sim.hash()).not.toBe(early);
  });

  it('produces a stable fingerprint for a fixed run', () => {
    // A golden value: if this changes, some rule changed with it. Update it
    // deliberately, never reflexively.
    const sim = newGame(4242);
    run(sim, 1000);
    expect(sim.hash()).toMatchInlineSnapshot(`"f3df2b5c"`);
  });
});

describe('building status', () => {
  it('reports an exhausted woodcutter once the trees are gone', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 2500);

    const building = sim.buildings.require(id);
    // Strip the surrounding forest and the hut has nothing left to do.
    for (const point of sim.world.grid.pointsWithin(building.point, 8)) {
      sim.world.object[point] = MapObject.None;
    }
    run(sim, 600);

    expect(building.status).toBe(BuildingStatus.Exhausted);
  });
});
