import { describe, expect, it } from 'vitest';
import { BuildingType, buildingInfo } from './data/buildings';
import { DIRECTIONS } from './core/direction';
import { OUT_OF_BOUNDS } from './core/grid';
import { Profession } from './data/professions';
import { Ware } from './data/wares';
import type { Flag, Settler } from './entities/types';
import { BuildingState, BuildingStatus, FLAG_CAPACITY, SettlerState } from './entities/types';
import { garrisonStrength, Rank } from './data/ranks';
import { Simulation, SETTLERS_KEPT_BACK, STARTING_GARRISON } from './simulation';
import { INPUT_STOCK_LIMIT, outstandingDemand, willAccept } from './transport/dispatch';
import { planRoad } from './transport/pathfinding';
import {
  BuildingSize,
  BuildSpace,
  canHostSize,
  canPlaceFlag,
  evaluateBuildSpace,
  FLAG_DIRECTION,
} from './world/buildspace';
import {
  FIELD_FULLY_GROWN,
  FIELD_MAX_GROWTH,
  MapObject,
  Resource,
  Terrain,
  TREE_MAX_GROWTH,
} from './world/terrain';

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
  near?: number,
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
        .filter((candidate) => sim.world.object[candidate] === prefers).length;
    }
    // A forester is only any use to a woodcutter he can reach, so where a
    // building has to sit beside another, closeness is the whole score.
    if (near !== undefined) score = 100 - sim.world.grid.distance(near, point);
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
  near?: number,
): number | undefined {
  const point = siteFor(sim, type, prefers, near);
  if (point === undefined) return undefined;

  const placed = sim.placeBuilding(PLAYER, point, type);
  if (!placed.ok) return undefined;

  const building = sim.buildings.find((candidate) => candidate.point === point);
  if (!building) return undefined;

  const route = planRoad(sim.world, headquarters(sim).flagPoint, building.flagPoint, PLAYER);
  if (route) sim.placeRoad(PLAYER, route);

  return building.id;
}

/**
 * Where a settler is drawn: the point his step has reached, interpolated the
 * way the renderer does it.
 *
 * The step's two ends and its progress are bookkeeping and may legitimately be
 * rewritten — turning a man round swaps them — but the position they describe
 * is what the player sees, and that must never jump.
 */
function drawnPosition(sim: Simulation, settler: Settler): { x: number; y: number } {
  const { grid } = sim.world;
  const t = sim.stepFraction(settler);
  return {
    x: grid.worldX(settler.fromPoint) + (grid.worldX(settler.toPoint) - grid.worldX(settler.fromPoint)) * t,
    y: grid.worldY(settler.fromPoint) + (grid.worldY(settler.toPoint) - grid.worldY(settler.fromPoint)) * t,
  };
}

function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) sim.update();
}

/** Places a well on ground that actually has water under it, and connects it. */
function buildOverWater(sim: Simulation): number | undefined {
  const hq = headquarters(sim);
  const info = buildingInfo(BuildingType.Well);

  for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
    if (sim.world.grid.distance(hq.point, point) < 3) continue;
    const space = evaluateBuildSpace(sim.world, point, PLAYER);
    if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;

    const wet = sim.world.grid
      .pointsWithin(point, 2)
      .some(
        (near) =>
          sim.world.resource[near] === Resource.Water && sim.world.resourceAmount[near]! > 0,
      );
    if (!wet) continue;

    if (!sim.placeBuilding(PLAYER, point, BuildingType.Well).ok) continue;
    const well = sim.buildings.find((candidate) => candidate.point === point)!;
    const route = planRoad(sim.world, hq.flagPoint, well.flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);
    return well.id;
  }

  return undefined;
}

/** A flag placed as near groundwater as the starting territory allows. */
function flagNearWater(sim: Simulation): number | undefined {
  const hq = headquarters(sim);

  let best: number | undefined;
  let bestWater = 0;

  for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
    if (!canPlaceFlag(sim.world, point, PLAYER)) continue;
    const water = sim.world.grid
      .pointsWithin(point, 4)
      .filter((near) => sim.world.resource[near] === Resource.Water).length;
    if (water > bestWater) {
      bestWater = water;
      best = point;
    }
  }

  if (best === undefined) return undefined;
  if (!sim.placeFlag(PLAYER, best).ok) return undefined;

  const route = planRoad(sim.world, hq.flagPoint, best, PLAYER);
  if (route) sim.placeRoad(PLAYER, route);
  return best;
}

/**
 * Runs the game while watching that nobody is lost or counted twice.
 *
 * The population may rise — settlers arrive over time — but it must never fall,
 * and it must never jump by more than the one man who can arrive on any tick.
 * A settler credited to a store while still walking would show up as a rise
 * and then a fall; one removed without being credited, as a fall alone.
 */
function runWatchingPopulation(sim: Simulation, ticks: number): void {
  let previous = sim.population(PLAYER);

  for (let i = 0; i < ticks; i += 1) {
    sim.update();
    const now = sim.population(PLAYER);
    expect(now - previous).toBeGreaterThanOrEqual(0);
    expect(now - previous).toBeLessThanOrEqual(1);
    previous = now;
  }
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
    // The hunter is hut-sized, so only its availability is under test here —
    // it waits on game animals, which the map does not yet carry.
    expect(buildingInfo(BuildingType.Hunter).available).toBe(false);

    const point = siteFor(sim, BuildingType.Woodcutter)!;
    const result = sim.placeBuilding(PLAYER, point, BuildingType.Hunter);
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
    expect(sim.events.some((event) => event.text.includes('completed'))).toBe(true);
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
    const cutter = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    // Beside the woodcutter: a forester plants within four nodes and a
    // woodcutter cuts within six, so one dropped anywhere replants a wood
    // nobody works.
    buildAndConnect(sim, BuildingType.Forester, null, sim.buildings.require(cutter).point);
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
    expect(sim.hash()).toMatchInlineSnapshot(`"d6cf0be3"`);
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

describe('flags placed on an existing road', () => {
  /**
   * A point partway along a road where a flag is actually allowed.
   *
   * The interior points next to either end are ruled out by the no-adjacent-
   * flags rule, so the first legal one is found by asking.
   */
  function midRoadPoint(sim: Simulation): number | undefined {
    for (const road of sim.roads.all()) {
      for (let i = 1; i < road.points.length - 1; i += 1) {
        if (canPlaceFlag(sim.world, road.points[i]!, PLAYER)) return road.points[i]!;
      }
    }
    return undefined;
  }

  /** A game with one long road out to a woodcutter, carriers already at work. */
  function gameWithARoad(): Simulation {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    buildAndConnect(sim, BuildingType.Sawmill);
    run(sim, 2500);
    return sim;
  }

  it('splits the road in two at the new flag', () => {
    const sim = gameWithARoad();
    const point = midRoadPoint(sim)!;
    expect(point).toBeDefined();

    const crossed = sim.roads.all().find((road) => road.points.includes(point))!;
    const ends = [crossed.fromFlag, crossed.toFlag];
    const roadsBefore = sim.roads.count;

    expect(sim.placeFlag(PLAYER, point).ok).toBe(true);

    expect(sim.roads.count).toBe(roadsBefore + 1);

    const flag = sim.flags.require(sim.world.flag[point]!);
    expect(flag.roads).toHaveLength(2);

    // The two halves run from the original ends to the new flag.
    const halves = flag.roads.map((id) => sim.roads.require(id));
    const far = halves.map((road) => (road.fromFlag === flag.id ? road.toFlag : road.fromFlag));
    expect(far.sort()).toEqual([...ends].sort());
    // Between them the halves cover the original run, meeting at the new flag.
    expect(halves[0]!.points.length + halves[1]!.points.length).toBe(crossed.points.length + 1);
    for (const half of halves) {
      expect(half.points.length).toBeGreaterThan(1);
      expect([half.points[0], half.points[half.points.length - 1]]).toContain(point);
    }
  });

  it('keeps the far end reachable through the new flag', () => {
    const sim = gameWithARoad();
    const hqFlag = sim.world.flag[headquarters(sim).flagPoint]!;

    const point = midRoadPoint(sim)!;
    const crossed = sim.roads.all().find((road) => road.points.includes(point))!;
    const farFlag = crossed.fromFlag === hqFlag ? crossed.toFlag : crossed.fromFlag;

    sim.placeFlag(PLAYER, point);

    expect(sim.network.cost(hqFlag, farFlag)).toBeDefined();
    expect(sim.network.cost(hqFlag, sim.world.flag[point]!)).toBeDefined();
  });

  it('puts a carrier on each half', () => {
    const sim = gameWithARoad();
    const point = midRoadPoint(sim)!;
    sim.placeFlag(PLAYER, point);

    // The second carrier has to walk out from the store first.
    run(sim, 900);

    const flag = sim.flags.require(sim.world.flag[point]!);
    for (const id of flag.roads) {
      const half = sim.roads.require(id);
      expect(half.carrier).toBeGreaterThan(0);
      expect(sim.settlers.require(half.carrier).road).toBe(half.id);
    }
  });

  it('leaves nothing standing on a road that no longer exists', () => {
    const sim = gameWithARoad();
    sim.placeFlag(PLAYER, midRoadPoint(sim)!);
    run(sim, 900);

    sim.settlers.forEach((settler) => {
      if (settler.road === 0) return;
      expect(sim.roads.has(settler.road)).toBe(true);
    });
  });

  it('builds what is connected through the new flag', () => {
    // The reported bug: a quarry and a second woodcutter, both reached only by
    // roads branching off a flag the player added partway along an old one,
    // sat as scaffolds for good while the store was full of boards.
    const sim = gameWithARoad();
    const junction = midRoadPoint(sim)!;
    expect(sim.placeFlag(PLAYER, junction).ok).toBe(true);

    const built: number[] = [];
    for (const type of [BuildingType.Quarry, BuildingType.Woodcutter]) {
      const site = siteFor(sim, type, type === BuildingType.Quarry ? MapObject.Stone : MapObject.Tree);
      if (site === undefined) continue;
      if (!sim.placeBuilding(PLAYER, site, type).ok) continue;

      const building = sim.buildings.find((candidate) => candidate.point === site)!;
      const route = planRoad(sim.world, junction, building.flagPoint, PLAYER);
      if (route) sim.placeRoad(PLAYER, route);
      built.push(building.id);
    }

    expect(built.length).toBeGreaterThan(0);
    run(sim, 9000);

    for (const id of built) {
      expect(sim.buildings.require(id).state).toBe(BuildingState.Complete);
    }
  });

  it('joins the halves back together when the flag is removed', () => {
    const sim = gameWithARoad();
    const point = midRoadPoint(sim)!;

    const crossed = sim.roads.all().find((road) => road.points.includes(point))!;
    const originalLength = crossed.points.length;
    const ends = [crossed.fromFlag, crossed.toFlag].sort();

    sim.placeFlag(PLAYER, point);
    run(sim, 400);
    expect(sim.roads.count).toBe(3);

    expect(sim.demolishFlag(PLAYER, point).ok).toBe(true);

    expect(sim.roads.count).toBe(2);
    expect(sim.world.flag[point]).toBe(0);

    const rejoined = sim.roads.all().find((road) => road.points.includes(point))!;
    expect(rejoined.points).toHaveLength(originalLength);
    expect([rejoined.fromFlag, rejoined.toFlag].sort()).toEqual(ends);
    // The rejoined stretch is still connected to the headquarters.
    const hqFlag = sim.world.flag[headquarters(sim).flagPoint]!;
    expect(sim.network.cost(hqFlag, ends[0] === hqFlag ? ends[1]! : ends[0]!)).toBeDefined();
  });
});

describe('settlers and their tools', () => {
  it('gives the builder his hammer back when the work is done', () => {
    const sim = newGame();
    const hammersBefore = sim.storedWare(PLAYER, Ware.Hammer);

    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    expect(sim.buildings.require(id).state).toBe(BuildingState.Complete);
    // A trade keeps its tool, but building is a job, not a trade.
    expect(sim.storedWare(PLAYER, Ware.Hammer)).toBe(hammersBefore);
  });

  it('does not spend a hammer per building put up', () => {
    // The starting stock holds six hammers. While each build consumed one for
    // good, the seventh building of any game could never be started.
    const sim = newGame();
    const hammers = sim.storedWare(PLAYER, Ware.Hammer);

    let completed = 0;
    for (let i = 0; i < 4; i += 1) {
      const id = buildAndConnect(sim, BuildingType.Woodcutter, null);
      if (id === undefined) break;
      run(sim, 2600);
      if (sim.buildings.require(id).state === BuildingState.Complete) completed += 1;
    }

    expect(completed).toBeGreaterThanOrEqual(3);
    expect(sim.storedWare(PLAYER, Ware.Hammer)).toBe(hammers);
  });

  it('returns the worker of a demolished building to the population', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    const before = sim.population(PLAYER);
    sim.demolishBuilding(PLAYER, sim.buildings.require(id).point);
    run(sim, 20);

    expect(sim.population(PLAYER)).toBe(before);
  });
});

describe('recovering from a torn-up network', () => {
  it('finishes a site whose road was destroyed and laid again', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Sawmill)!;
    run(sim, 400);

    // Tear up the supply line mid-delivery, then restore it.
    const road = sim.roads.all()[0]!;
    const site = sim.buildings.require(id);
    expect(sim.demolishRoad(PLAYER, road.points[1]!).ok).toBe(true);
    run(sim, 300);

    expect(site.status).toBe(BuildingStatus.Unreachable);

    const route = planRoad(sim.world, headquarters(sim).flagPoint, site.flagPoint, PLAYER);
    expect(route).toBeDefined();
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    // Reservations left behind by the interrupted deliveries used to make the
    // site look satisfied for good, so nothing more was ever sent.
    run(sim, 6000);
    expect(site.state).toBe(BuildingState.Complete);
  });
});

describe('working away from the building', () => {
  /** A fishery site with as much fish as possible inside its work radius. */
  function fisherySite(sim: Simulation): number | undefined {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Fishery);

    let best: number | undefined;
    let bestFish = 0;

    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      if (sim.world.grid.distance(hq.point, point) < 3) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;

      const shoals = sim.world.grid
        .pointsWithin(point, 6)
        .filter((p) => sim.world.resource[p] === Resource.Fish && sim.world.resourceAmount[p]! > 0);
      if (shoals.length > bestFish) {
        bestFish = shoals.length;
        best = point;
      }
    }

    return bestFish > 0 ? best : undefined;
  }

  function buildFishery(sim: Simulation): number | undefined {
    const point = fisherySite(sim);
    if (point === undefined) return undefined;
    if (!sim.placeBuilding(PLAYER, point, BuildingType.Fishery).ok) return undefined;

    const hut = sim.buildings.find((candidate) => candidate.point === point)!;
    const route = planRoad(sim.world, headquarters(sim).flagPoint, hut.flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);
    return hut.id;
  }

  it('sends the fisherman out to the water and brings fish back', () => {
    const sim = newGame();
    const id = buildFishery(sim)!;
    expect(id).toBeDefined();

    const before = sim.storedWare(PLAYER, Ware.Fish);

    // Watch for the fisherman actually leaving the hut at some point.
    let wentOut = false;
    for (let i = 0; i < 9000; i += 1) {
      sim.update();
      const worker = sim.settlers.get(sim.buildings.require(id).worker);
      if (
        worker &&
        (worker.state === SettlerState.WalkingToTask ||
          worker.state === SettlerState.PerformingTask ||
          worker.state === SettlerState.ReturningHome)
      ) {
        wentOut = true;
      }
    }

    expect(wentOut).toBe(true);
    expect(sim.storedWare(PLAYER, Ware.Fish)).toBeGreaterThan(before);
  });

  it('only fishes where a settler can actually stand', () => {
    const sim = newGame();
    const id = buildFishery(sim)!;
    run(sim, 9000);

    const hut = sim.buildings.require(id);
    // Every shoal that has been worked was somewhere reachable on foot; open
    // water the fisherman could never reach must be untouched.
    for (const point of sim.world.grid.pointsWithin(hut.point, 6)) {
      if (sim.world.resource[point] !== Resource.Fish) continue;
      if (sim.world.isWalkable(point)) continue;
      expect(sim.world.resourceAmount[point]).toBeGreaterThan(0);
    }
  });

  it('reports an exhausted fishery once the shoals are gone', () => {
    const sim = newGame();
    const id = buildFishery(sim)!;
    run(sim, 3000);

    const hut = sim.buildings.require(id);
    for (const point of sim.world.grid.pointsWithin(hut.point, 8)) {
      if (sim.world.resource[point] === Resource.Fish) sim.world.resource[point] = Resource.None;
    }
    run(sim, 1500);

    expect(hut.status).toBe(BuildingStatus.Exhausted);
  });

  it('keeps the well digger at his well', () => {
    // Extraction with no radius happens where the building stands, so this one
    // must not have picked up the fisherman's wandering.
    const sim = newGame();
    // A well has to stand over groundwater, which no longer lies under sand or
    // against the mountains — so the site is chosen for its water.
    const id = buildOverWater(sim)!;
    expect(id).toBeDefined();
    run(sim, 4000);

    const well = sim.buildings.require(id);
    expect(well.state).toBe(BuildingState.Complete);
    expect(sim.storedWare(PLAYER, Ware.Water)).toBeGreaterThan(0);

    const digger = sim.settlers.get(well.worker);
    expect(digger?.state).toBe(SettlerState.AtWork);
  });
});

describe('removing a road on its own', () => {
  it('takes the road but leaves both its flags standing', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 1200);

    const road = sim.roads.all()[0]!;
    const ends = [road.fromFlag, road.toFlag];
    const middle = road.points[1]!;

    expect(sim.demolishRoad(PLAYER, middle).ok).toBe(true);

    expect(sim.roads.count).toBe(0);
    for (const flagId of ends) expect(sim.flags.has(flagId)).toBe(true);
    // The map no longer shows a road running through that point.
    expect(sim.world.roadCount(middle)).toBe(0);
  });

  it('leaves the other roads at a junction alone', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    buildAndConnect(sim, BuildingType.Sawmill);
    run(sim, 1200);

    expect(sim.roads.count).toBe(2);
    const [first, second] = sim.roads.all();

    expect(sim.demolishRoad(PLAYER, first!.points[1]!).ok).toBe(true);

    expect(sim.roads.count).toBe(1);
    expect(sim.roads.all()[0]!.points).toEqual(second!.points);
  });

  it('says so when there is no road there', () => {
    const sim = newGame();
    const result = sim.demolishRoad(PLAYER, headquarters(sim).point);
    expect(result.ok).toBe(false);
  });
});

describe('roads and building sites', () => {
  it('offers at most a flag where a road already runs', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);

    const road = sim.roads.all()[0]!;
    for (let i = 1; i < road.points.length - 1; i += 1) {
      const point = road.points[i]!;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      expect(space).toBeLessThanOrEqual(BuildSpace.Flag);
      expect(canHostSize(space, BuildingSize.Hut)).toBe(false);
    }
  });

  it('refuses to put a building on top of a road', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);

    const road = sim.roads.all()[0]!;
    const onRoad = road.points[Math.floor(road.points.length / 2)]!;

    expect(sim.placeBuilding(PLAYER, onRoad, BuildingType.Quarry).ok).toBe(false);
    expect(sim.world.building[onRoad]).toBe(0);
  });
});

describe('drawing between ticks', () => {
  it('advances a walking settler part way through the coming tick', () => {
    // A tick is 200ms of real time at the normal pace, so a settler that only
    // moved when a tick landed would visibly stutter. The renderer asks for a
    // position part way into the next tick instead.
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);

    let walker: ReturnType<typeof sim.settlers.get>;
    for (let i = 0; i < 3000 && !walker; i += 1) {
      sim.update();
      walker = sim.settlers.all().find((settler) => settler.fromPoint !== settler.toPoint);
    }

    expect(walker).toBeDefined();
    const settler = walker!;

    const atTick = sim.stepFraction(settler, 0);
    const halfWay = sim.stepFraction(settler, 0.5);

    expect(halfWay).toBeGreaterThan(atTick);
    // Never past the end of the step, whatever the frame timing.
    expect(sim.stepFraction(settler, 1)).toBeLessThanOrEqual(1);
    expect(sim.stepFraction(settler, 0)).toBe(settler.stepProgress / settler.stepLength);
  });

  it('defaults to the tick boundary when no fraction is given', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 900);

    for (const settler of sim.settlers.all()) {
      expect(sim.stepFraction(settler)).toBe(sim.stepFraction(settler, 0));
    }
  });
});

describe('walking home again', () => {
  /** Builds a woodcutter and runs until it is finished, or gives up. */
  function buildUntilComplete(sim: Simulation): number {
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    expect(id).toBeDefined();

    for (let i = 0; i < 3000; i += 1) {
      sim.update();
      if (sim.buildings.require(id).state === BuildingState.Complete) return id;
    }

    throw new Error('the woodcutter never finished');
  }

  it('leaves the builder on the map, walking, once the work is done', () => {
    const sim = newGame();
    buildUntilComplete(sim);

    const walking = sim.settlers.all().filter((s) => s.state === SettlerState.ReturningToStore);
    expect(walking).toHaveLength(1);
    expect(walking[0]!.path.length).toBeGreaterThan(0);
  });

  it('counts the builder once the whole way home, never twice and never not at all', () => {
    // Crediting the store on setting off would show a man in two places; only
    // crediting him on arrival, but removing him early, would lose him.
    const sim = newGame();

    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    runWatchingPopulation(sim, 1200);

    expect(sim.buildings.require(id).state).toBe(BuildingState.Complete);
  });

  it('takes the builder in at the headquarters when he gets there', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    buildUntilComplete(sim);

    const reserveOnFinishing = hq.reserve;
    run(sim, 400);

    expect(sim.settlers.all().some((s) => s.state === SettlerState.ReturningToStore)).toBe(false);
    // He is back in the store. New settlers arrive over time too, so the count
    // may have risen further; what matters is that he was added, not lost.
    expect(hq.reserve).toBeGreaterThan(reserveOnFinishing);
  });

  it('gets the builder home even when his road is torn up under him', () => {
    const sim = newGame();
    buildUntilComplete(sim);

    const walker = sim.settlers.all().find((s) => s.state === SettlerState.ReturningToStore)!;
    expect(walker).toBeDefined();

    const road = sim.roads.all()[0]!;
    expect(sim.demolishRoad(PLAYER, road.points[1]!).ok).toBe(true);

    runWatchingPopulation(sim, 600);

    expect(sim.settlers.has(walker.id)).toBe(false);
  });
});

describe('resting between trips out', () => {
  it('keeps a worker indoors for a while after he brings something back', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;

    // Catch the moment he steps back through his own door.
    let restingFor = 0;
    for (let i = 0; i < 4000 && restingFor === 0; i += 1) {
      sim.update();
      const worker = sim.settlers.get(sim.buildings.require(id).worker);
      if (worker?.state === SettlerState.AtWork && worker.taskTimer > 0) {
        restingFor = worker.taskTimer;
      }
    }

    expect(restingFor).toBeGreaterThan(0);

    // He is still inside on the next tick rather than straight back out.
    sim.update();
    const worker = sim.settlers.get(sim.buildings.require(id).worker)!;
    expect(worker.state).toBe(SettlerState.AtWork);
    expect(worker.taskTimer).toBe(restingFor - 1);
  });

  it('sends him out again once he has had his rest', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 900);

    // A rest that never ended would leave the hut producing nothing at all.
    const before = sim.storedWare(PLAYER, Ware.Log);
    run(sim, 3000);
    expect(sim.storedWare(PLAYER, Ware.Log)).toBeGreaterThan(before);
  });
});

describe('a carrier with nothing to carry', () => {
  /** The point on a road where its carrier waits. */
  function post(road: { points: number[] }): number {
    return road.points[Math.floor(road.points.length / 2)]!;
  }

  it('walks back to the middle of its stretch', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 1200);

    const road = sim.roads.all()[0]!;
    const carrier = sim.settlers.require(road.carrier);

    // Strand him at one end, as finishing a delivery there would.
    carrier.state = SettlerState.CarrierWaiting;
    carrier.point = road.points[0]!;
    carrier.fromPoint = carrier.point;
    carrier.toPoint = carrier.point;
    carrier.path = [];
    carrier.pathIndex = 0;

    // He is asked to reach his post, not to be standing on it at some arbitrary
    // moment: this road is busy, so most ticks find him carrying something.
    const waitingPoint = post(road);
    let cameToPost = false;
    for (let i = 0; i < 400 && !cameToPost; i += 1) {
      sim.update();
      cameToPost = sim.settlers.get(road.carrier)?.point === waitingPoint;
    }

    expect(cameToPost).toBe(true);
  });

  it('still gets on with the job while it strolls', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 1500);

    const road = sim.roads.all()[0]!;
    const carrier = sim.settlers.require(road.carrier);
    carrier.state = SettlerState.CarrierWaiting;
    carrier.point = road.points[0]!;
    carrier.fromPoint = carrier.point;
    carrier.toPoint = carrier.point;
    carrier.path = [];
    carrier.pathIndex = 0;

    // Work has to win over the stroll, or the logs would never come in.
    const before = sim.storedWare(PLAYER, Ware.Log);
    run(sim, 3000);
    expect(sim.storedWare(PLAYER, Ware.Log)).toBeGreaterThan(before);
  });
});

describe('the farm', () => {
  /**
   * A seeded island with real farmland near the start.
   *
   * The usual test seed opens on sand and steppe, where a farm correctly
   * reports itself exhausted: corn now needs six sides of meadow and clear
   * ground all round, so there is nowhere at all to sow.
   */
  const FARMING_SEED = 726;

  /**
   * Places a farm on ground that can actually grow corn.
   *
   * A farm only sows within two nodes of itself, so it has to stand in open
   * meadow to be any use at all.
   */
  function buildFarm(sim: Simulation): number | undefined {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Farm);

    let best: number | undefined;
    let bestSoil = 0;

    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      if (sim.world.grid.distance(hq.point, point) < 3) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;

      const soil = sim.world.grid
        .pointsWithin(point, 2)
        .filter((near) => sim.world.farmableSides(near) === 6).length;
      if (soil > bestSoil) {
        bestSoil = soil;
        best = point;
      }
    }

    if (best === undefined) return undefined;
    if (!sim.placeBuilding(PLAYER, best, BuildingType.Farm).ok) return undefined;

    const farm = sim.buildings.find((candidate) => candidate.point === best)!;
    const route = planRoad(sim.world, hq.flagPoint, farm.flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);
    return farm.id;
  }

  it('sows fields, lets them ripen, and cuts them for grain', () => {
    const sim = newGame(FARMING_SEED);
    const id = buildFarm(sim)!;
    expect(id).toBeDefined();

    const farm = sim.buildings.require(id);

    // Watch the whole cycle: bare ground, then green corn, then a ripe crop.
    let sown = false;
    let ripened = false;
    for (let i = 0; i < 12000 && !ripened; i += 1) {
      sim.update();
      for (const point of sim.world.grid.pointsWithin(farm.point, 6)) {
        if (sim.world.object[point] !== MapObject.Field) continue;
        sown = true;
        if (sim.world.objectData[point]! >= FIELD_FULLY_GROWN) ripened = true;
      }
    }

    expect(sown).toBe(true);
    expect(ripened).toBe(true);

    run(sim, 6000);
    expect(sim.storedWare(PLAYER, Ware.Grain)).toBeGreaterThan(0);
  });

  it('sows only where the ground will take corn', () => {
    const sim = newGame(FARMING_SEED);
    const id = buildFarm(sim)!;
    run(sim, 12000);

    const farm = sim.buildings.require(id);
    for (const point of sim.world.grid.pointsWithin(farm.point, 6)) {
      if (sim.world.object[point] !== MapObject.Field) continue;
      // Every field must stand on ground a farmer could legally sow.
      expect(sim.world.isWalkable(point)).toBe(true);
    }
  });

  /** Every field standing within sight of the farm, whatever its stage. */
  function fieldsAround(sim: Simulation, centre: number): number[] {
    return sim.world.grid
      .pointsWithin(centre, 6)
      .filter((point) => sim.world.object[point] === MapObject.Field);
  }

  it('lays its fields in a ring exactly two nodes out', () => {
    const sim = newGame(FARMING_SEED);
    const id = buildFarm(sim)!;
    const farm = sim.buildings.require(id);

    // Looked at every tick — a field sown against the farmyard would be reaped
    // again long before the run ended — but gathered rather than asserted as we
    // go: a quarter of a million assertions costs seconds, a list costs nothing.
    const wrong: number[] = [];
    for (let i = 0; i < 12000; i += 1) {
      sim.update();
      for (const field of fieldsAround(sim, farm.point)) {
        const distance = sim.world.grid.distance(farm.point, field);
        if (distance !== 2) wrong.push(distance);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('never sows two fields side by side, nor one against a wall', () => {
    const sim = newGame(FARMING_SEED);
    const id = buildFarm(sim)!;
    const farm = sim.buildings.require(id);

    const crowded: string[] = [];
    for (let i = 0; i < 12000; i += 1) {
      sim.update();
      for (const field of fieldsAround(sim, farm.point)) {
        for (const direction of DIRECTIONS) {
          const neighbour = sim.world.grid.neighbour(field, direction);
          if (sim.world.object[neighbour] === MapObject.Field) {
            crowded.push(`field ${field} touches field ${neighbour}`);
          }
          if (sim.world.building[neighbour] !== 0) {
            crowded.push(`field ${field} touches a building at ${neighbour}`);
          }
        }
      }
    }

    expect(crowded).toEqual([]);
  });

  it('works five or six fields at once on open meadow', () => {
    const sim = newGame(FARMING_SEED);
    const id = buildFarm(sim)!;
    const farm = sim.buildings.require(id);

    let most = 0;
    for (let i = 0; i < 12000; i += 1) {
      sim.update();
      most = Math.max(most, fieldsAround(sim, farm.point).length);
    }

    // The ring holds twelve nodes and no two neighbours may both be sown, so
    // half of them is the ceiling — and a farm on good land should reach it.
    expect(most).toBeGreaterThanOrEqual(5);
    expect(most).toBeLessThanOrEqual(6);
  });
});

describe('geologists', () => {
  /** A flag as near the mountains as the starting territory reaches. */
  function frontierFlag(sim: Simulation): number | undefined {
    const hq = headquarters(sim);
    let best: number | undefined;
    let bestRock = 0;

    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      if (!canPlaceFlag(sim.world, point, PLAYER)) continue;
      const rock = sim.world.grid
        .pointsWithin(point, 8)
        .filter((near) => sim.world.resource[near] === Resource.Coal ||
          sim.world.resource[near] === Resource.Iron ||
          sim.world.resource[near] === Resource.Granite ||
          sim.world.resource[near] === Resource.Gold).length;
      if (rock > bestRock) {
        bestRock = rock;
        best = point;
      }
    }

    if (best === undefined) return undefined;
    if (!sim.placeFlag(PLAYER, best).ok) return undefined;
    const route = planRoad(sim.world, headquarters(sim).flagPoint, best, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);
    return best;
  }

  it('refuses to set out where everything has already been surveyed', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    sim.world.resourceKnown.fill(1);

    const result = sim.sendGeologist(PLAYER, hq.flagPoint);
    expect(result.ok).toBe(false);
  });

  it('prospects for water when there is no rock within reach', () => {
    // Sent into open country with no mountain near it, a geologist has only
    // groundwater to look for — and groundwater no longer lies everywhere, so
    // the flag is put where there is some.
    const sim = newGame();
    const flag = flagNearWater(sim);
    expect(flag).toBeDefined();

    expect(sim.sendGeologist(PLAYER, flag!).ok).toBe(true);
    run(sim, 12000);

    const wells = [...sim.world.resourceKnown.keys()].filter(
      (point) =>
        sim.world.resourceKnown[point] === 1 && sim.world.resource[point] === Resource.Water,
    );
    expect(wells.length).toBeGreaterThan(0);
  });

  it('works the whole patch around its flag, and nothing beyond it', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    expect(sim.sendGeologist(PLAYER, hq.flagPoint).ok).toBe(true);

    run(sim, 40000);

    let known = 0;
    for (let point = 0; point < sim.world.grid.size; point += 1) {
      if (!sim.world.resourceKnown[point]) continue;
      known += 1;
      // Each mark is a hole he dug, and every hole is inside his own patch.
      expect(sim.world.grid.distance(hq.flagPoint, point)).toBeLessThanOrEqual(4);
    }

    // A whole patch, not the three holes he used to manage.
    expect(known).toBeGreaterThan(3);
  });

  it('comes home once the patch is done', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const before = sim.population(PLAYER);
    expect(sim.sendGeologist(PLAYER, hq.flagPoint).ok).toBe(true);

    run(sim, 40000);

    expect(sim.settlers.all().some((s) => s.profession === Profession.Geologist)).toBe(false);
    expect(sim.population(PLAYER)).toBeGreaterThanOrEqual(before);
  });

  it('marks what it finds and comes home with its hammer', () => {
    const sim = newGame();
    const flag = frontierFlag(sim);
    if (flag === undefined) return; // No rock in reach on this map.

    const populationBefore = sim.population(PLAYER);
    const hammersBefore = sim.storedWare(PLAYER, Ware.Hammer);

    expect(sim.sendGeologist(PLAYER, flag).ok).toBe(true);

    let surveyed = 0;
    for (let i = 0; i < 6000; i += 1) {
      sim.update();
      if (i % 500 !== 0) continue;
      surveyed = 0;
      for (let point = 0; point < sim.world.grid.size; point += 1) {
        if (sim.world.resourceKnown[point]) surveyed += 1;
      }
      if (surveyed > 0) break;
    }
    expect(surveyed).toBeGreaterThan(0);

    // He is a settler on loan, not a settler spent: nobody is lost on the way,
    // and the hammer comes back with him.
    runWatchingPopulation(sim, 6000);
    expect(sim.population(PLAYER)).toBeGreaterThanOrEqual(populationBefore);
    expect(sim.storedWare(PLAYER, Ware.Hammer)).toBe(hammersBefore);
  });

  it('says nothing about ground nobody has surveyed', () => {
    const sim = newGame();
    for (let point = 0; point < sim.world.grid.size; point += 1) {
      expect(sim.world.resourceKnown[point]).toBe(0);
    }
  });
});

describe('outposts', () => {
  it('claims new ground when one is finished', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Guardhouse)!;
    expect(id).toBeDefined();

    let owned = 0;
    for (let point = 0; point < sim.world.grid.size; point += 1) {
      if (sim.world.owner[point] === PLAYER) owned += 1;
    }

    run(sim, 6000);

    let ownedAfter = 0;
    for (let point = 0; point < sim.world.grid.size; point += 1) {
      if (sim.world.owner[point] === PLAYER) ownedAfter += 1;
    }

    expect(sim.buildings.require(id).state).toBe(BuildingState.Complete);
    expect(ownedAfter).toBeGreaterThan(owned);
  });

  it('does not sit waiting for a worker it will never want', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Guardhouse)!;
    run(sim, 6000);

    const outpost = sim.buildings.require(id);
    expect(outpost.state).toBe(BuildingState.Complete);
    expect(outpost.status).toBe(BuildingStatus.Working);
  });
});

describe('the metalworks', () => {
  it('makes whichever tool the player is shortest of', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    // Everything in plentiful supply but the scythes.
    for (const ware of [Ware.Hammer, Ware.Axe, Ware.Saw, Ware.PickAxe, Ware.Shovel,
      Ware.Crucible, Ware.FishingRod, Ware.Cleaver, Ware.RollingPin]) {
      hq.stock[ware] = 20;
    }
    hq.stock[Ware.Scythe] = 0;

    const id = buildAndConnect(sim, BuildingType.Metalworks)!;
    expect(id).toBeDefined();

    const works = sim.buildings.require(id);
    for (let i = 0; i < 12000; i += 1) {
      sim.update();
      if (works.state !== BuildingState.Complete) continue;
      // Feed it by hand: smelting its iron is a chain of its own.
      works.inputs[0] = 4;
      works.inputs[1] = 4;
      if (sim.storedWare(PLAYER, Ware.Scythe) > 0) break;
    }

    expect(sim.storedWare(PLAYER, Ware.Scythe)).toBeGreaterThan(0);
  });
});

describe('a building cut off from every store', () => {
  it('goes on working into its own flag instead of stopping dead', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    const hut = sim.buildings.require(id);
    expect(hut.state).toBe(BuildingState.Complete);

    // Cut the road, leaving the hut and its flag standing.
    const road = sim.roads.all()[0]!;
    expect(sim.demolishRoad(PLAYER, road.points[1]!).ok).toBe(true);

    run(sim, 12000);

    const flag = sim.flags.require(sim.world.flag[hut.flagPoint]!);
    // Logs pile up against the door rather than the hut producing exactly one
    // and giving up for good.
    expect(flag.wares.length).toBeGreaterThan(1);
    expect(flag.wares.every((parcel) => parcel.ware === Ware.Log)).toBe(true);
  });

  it('stacks up to the flag capacity and no further', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    const hut = sim.buildings.require(id);
    const road = sim.roads.all()[0]!;
    sim.demolishRoad(PLAYER, road.points[1]!);
    run(sim, 30000);

    const flag = sim.flags.require(sim.world.flag[hut.flagPoint]!);
    expect(flag.wares.length).toBeLessThanOrEqual(FLAG_CAPACITY);
  });

  it('moves the backlog once a road reaches it again', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    const hut = sim.buildings.require(id);
    const road = sim.roads.all()[0]!;
    sim.demolishRoad(PLAYER, road.points[1]!);
    run(sim, 12000);

    const stored = sim.storedWare(PLAYER, Ware.Log);
    const route = planRoad(sim.world, headquarters(sim).flagPoint, hut.flagPoint, PLAYER);
    expect(route).toBeDefined();
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    run(sim, 12000);
    expect(sim.storedWare(PLAYER, Ware.Log)).toBeGreaterThan(stored);
  });
});

describe('a settler sent somewhere new mid-stride', () => {
  it('finishes the pace he is taking instead of snapping back', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 1500);

    const road = sim.roads.all()[0]!;
    const carrier = sim.settlers.require(road.carrier);

    // Put him at one end with nothing to do, so he sets off for his post.
    carrier.state = SettlerState.CarrierWaiting;
    carrier.carrying = null;
    carrier.point = road.points[0]!;
    carrier.fromPoint = carrier.point;
    carrier.toPoint = carrier.point;
    carrier.path = [];
    carrier.pathIndex = 0;

    // Catch him just after setting off, so the stride cannot finish on the very
    // tick we interrupt it. Being between two points is the state the old code
    // mishandled.
    let strides = 0;
    while (
      strides < 400 &&
      !(
        carrier.state === SettlerState.CarrierWaiting &&
        carrier.stepProgress === 1 &&
        carrier.toPoint !== carrier.point
      )
    ) {
      sim.update();
      strides += 1;
    }
    expect(carrier.state).toBe(SettlerState.CarrierWaiting);
    expect(carrier.stepProgress).toBe(1);
    expect(carrier.stepLength).toBeGreaterThan(2);

    const wasWalkingTo = carrier.toPoint;
    const wasWalkingFrom = carrier.fromPoint;
    const wasProgress = carrier.stepProgress;

    // Now put a log at the far end, bound for the headquarters, so he must turn
    // round and go back for it — an interruption in the middle of a stride.
    const far = sim.flags.require(
      sim.world.flag[headquarters(sim).flagPoint] === road.fromFlag ? road.toFlag : road.fromFlag,
    );
    far.wares.push({ ware: Ware.Log, destination: headquarters(sim).id });

    sim.update();
    expect(carrier.state).toBe(SettlerState.CarrierCollecting);

    // The stride he was taking is untouched: same two points, same progress.
    // The old code threw it away and started him again from the point behind.
    expect(carrier.fromPoint).toBe(wasWalkingFrom);
    expect(carrier.toPoint).toBe(wasWalkingTo);
    expect(carrier.stepProgress).toBe(wasProgress);

    // And on the next tick he simply walks on.
    sim.update();
    expect(carrier.stepProgress).toBeGreaterThan(wasProgress);
    expect(carrier.toPoint).toBe(wasWalkingTo);
  });
});

describe('building with what has arrived', () => {
  it('raises a site as its boards turn up, and leaves the stone until last', () => {
    const sim = newGame();
    // A sawmill costs 3 boards then 2 stone, so the two materials are ordered.
    const id = buildAndConnect(sim, BuildingType.Sawmill)!;
    expect(id).toBeDefined();

    const site = sim.buildings.require(id);
    const info = buildingInfo(BuildingType.Sawmill);
    const total = info.cost.reduce((sum, item) => sum + item.count, 0);

    let sawPartial = false;

    for (let i = 0; i < 12000; i += 1) {
      sim.update();
      if (site.state === BuildingState.Complete) break;

      const boards = site.delivered[0]!;
      const stone = site.delivered[1]!;

      // Work is never further along than the delivered materials allow, and
      // stone counts for nothing until every board is there.
      const usable = boards < info.cost[0]!.count ? boards : boards + stone;
      const allowed = Math.floor((info.buildTicks * usable) / total);
      expect(site.buildProgress).toBeLessThanOrEqual(allowed);

      if (site.buildProgress > 0 && boards < info.cost[0]!.count) sawPartial = true;
    }

    // It really did rise before everything had arrived.
    expect(sawPartial).toBe(true);
    expect(site.state).toBe(BuildingState.Complete);
  });
});

describe('a growing population', () => {
  it('adds settlers over time and then levels off', () => {
    const sim = newGame();
    const before = sim.population(PLAYER);

    run(sim, 6000);
    const middle = sim.population(PLAYER);
    expect(middle).toBeGreaterThan(before);

    // With nothing new built, the province stops taking people in.
    run(sim, 30000);
    expect(sim.population(PLAYER)).toBe(middle);
  });

  it('supports more people as more is built', () => {
    const sim = newGame();
    run(sim, 8000);
    const bare = sim.population(PLAYER);

    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    buildAndConnect(sim, BuildingType.Forester);
    run(sim, 20000);

    expect(sim.population(PLAYER)).toBeGreaterThan(bare);
  });
});

describe('ore in the mountains', () => {
  it('never sits on the outermost rock', () => {
    const sim = newGame(1039);
    const world = sim.world;
    const ores: Resource[] = [Resource.Coal, Resource.Iron, Resource.Gold, Resource.Granite];

    let checked = 0;
    for (let point = 0; point < world.grid.size; point += 1) {
      if (!ores.includes(world.resource[point] as Resource)) continue;
      checked += 1;

      // Two full rings of rock around every seam, so a border nudged against a
      // hillside finds nothing without going in properly.
      for (const near of world.grid.pointsWithin(point, 2)) {
        expect(world.isWalkable(near)).toBe(true);
      }
    }

    expect(checked).toBeGreaterThan(0);
  });
});

describe('wares that cannot be routed', () => {
  it('is taken in when it is left at a store’s own door', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const flag = sim.flags.require(sim.world.flag[hq.flagPoint]!);

    const before = sim.storedWare(PLAYER, Ware.Log);
    // A parcel that arrived any way other than a carrier handing it over —
    // retargeting to the nearest store puts one here for nothing.
    flag.wares.push({ ware: Ware.Log, destination: hq.id });

    run(sim, 20);

    expect(flag.wares.some((parcel) => parcel.destination === hq.id)).toBe(false);
    expect(sim.storedWare(PLAYER, Ware.Log)).toBe(before + 1);
  });

  it('leaves room at a store door for deliveries coming the other way', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    buildAndConnect(sim, BuildingType.Sawmill);
    run(sim, 8000);

    const flag = sim.flags.require(sim.world.flag[hq.flagPoint]!);
    // A store that filled its own flag with goods going out walled itself in.
    expect(flag.wares.length).toBeLessThan(FLAG_CAPACITY);
  });

  it('swaps at a full flag rather than waiting for ever', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 4000);

    const hut = sim.buildings.require(id);
    const flag = sim.flags.require(sim.world.flag[hut.flagPoint]!);

    // Jam the hut's flag full of wares that must travel towards the store, and
    // hand its carrier something to bring the other way.
    flag.wares.length = 0;
    for (let i = 0; i < FLAG_CAPACITY; i += 1) {
      flag.wares.push({ ware: Ware.Log, destination: headquarters(sim).id });
    }

    const before = sim.storedWare(PLAYER, Ware.Log);
    run(sim, 8000);

    // The queue moved: waiting for a free place would have deadlocked, since
    // these logs can only leave in the hands of the carrier stood before them.
    expect(sim.storedWare(PLAYER, Ware.Log)).toBeGreaterThan(before);
  });
});

describe('a road torn up under a loaded carrier', () => {
  it('sets the crate down instead of destroying it, and reorders nothing twice', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Sawmill)!;
    expect(id).toBeDefined();

    // Catch a carrier actually holding something.
    let carrier: ReturnType<typeof sim.settlers.get>;
    for (let i = 0; i < 4000 && !carrier; i += 1) {
      sim.update();
      carrier = sim.settlers.all().find((s) => s.carrying !== null && s.road !== 0);
    }
    expect(carrier).toBeDefined();

    const held = carrier!.carrying!;
    const site = sim.buildings.require(id);
    const road = sim.roads.require(carrier!.road);

    const wareCount = () => {
      let total = sim.storedWare(PLAYER, held);
      sim.flags.forEach((flag) => {
        total += flag.wares.filter((parcel) => parcel.ware === held).length;
      });
      sim.settlers.forEach((settler) => {
        if (settler.carrying === held) total += 1;
      });
      let index = 0;
      for (const item of buildingInfo(site.type).cost) {
        if (item.ware === held) total += site.delivered[index] ?? 0;
        index += 1;
      }
      return total;
    };

    const before = wareCount();
    expect(sim.demolishRoad(PLAYER, road.points[1]!).ok).toBe(true);
    run(sim, 10);

    // Nothing was annihilated by the road going away.
    expect(wareCount()).toBe(before);
  });

  it('still finishes the building once the road is laid again', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Sawmill)!;

    for (let i = 0; i < 4000; i += 1) {
      sim.update();
      if (sim.settlers.all().some((s) => s.carrying !== null && s.road !== 0)) break;
    }

    const road = sim.roads.all()[0]!;
    sim.demolishRoad(PLAYER, road.points[1]!);
    run(sim, 400);

    const site = sim.buildings.require(id);
    const route = planRoad(sim.world, headquarters(sim).flagPoint, site.flagPoint, PLAYER);
    expect(route).toBeDefined();
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    // A reservation left behind by the lost crate would keep the site looking
    // satisfied for ever, and nothing more would be sent.
    run(sim, 20000);
    expect(site.state).toBe(BuildingState.Complete);
  });

  /**
   * A sawmill site reached by two roads with a flag between them, and a carrier
   * on the far one holding a crate bound for the site.
   *
   * The middle flag is what makes the test worth anything: with a single road
   * there is nowhere for a dismissed carrier to go but the headquarters, so
   * turning back and carrying on would look the same.
   */
  function carrierOnTheFarRoad(sim: Simulation, midStride = false) {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    // As far off as the territory allows, so the road between is long enough to
    // carry a flag partway along it.
    let far: number | undefined;
    let furthest = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      const distance = sim.world.grid.distance(hq.point, point);
      if (distance <= furthest) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      furthest = distance;
      far = point;
    }
    expect(far).toBeDefined();
    expect(sim.placeBuilding(PLAYER, far!, BuildingType.Sawmill).ok).toBe(true);

    const site = sim.buildings.find((building) => building.point === far)!;
    const route = planRoad(sim.world, hq.flagPoint, site.flagPoint, PLAYER);
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    // Somewhere along its length — flags keep their distance from one another,
    // so the exact node has to be one the game will take.
    const whole = sim.roads.all()[0]!;
    const middle = whole.points.slice(1, -1).find((point) => sim.placeFlag(PLAYER, point).ok);
    expect(middle).toBeDefined();

    const farRoad = sim.roads.all().find((road) => road.points.includes(site.flagPoint))!;
    expect(farRoad).toBeDefined();

    for (let i = 0; i < 8000; i += 1) {
      sim.update();
      const carrier = sim.settlers
        .all()
        .find(
          (settler) =>
            settler.carrying !== null &&
            settler.road === farRoad.id &&
            settler.state === SettlerState.CarrierDelivering &&
            (!midStride || (settler.stepProgress > 0 && settler.toPoint !== settler.point)),
        );
      if (carrier) return { carrier, farRoad, site, middle };
    }

    throw new Error('no loaded carrier appeared on the far road');
  }

  /**
   * Where a settler goes, tick by tick, until he walks into a store and is
   * taken in — after which the object is back in the pool and no longer his.
   */
  function followUntilTakenIn(sim: Simulation, settler: { id: number }, ticks: number): number[] {
    const walked: number[] = [];
    for (let i = 0; i < ticks; i += 1) {
      sim.update();
      const still = sim.settlers.get(settler.id);
      if (still !== settler) break;
      walked.push(still.point);
    }
    return walked;
  }

  it('turns him back rather than letting him finish the delivery', () => {
    const sim = newGame();
    const { carrier, farRoad, site } = carrierOnTheFarRoad(sim);

    const held = carrier.carrying!;
    expect(sim.demolishRoad(PLAYER, farRoad.points[1]!).ok).toBe(true);

    // Watch for the moment the crate leaves his hands.
    let setDownAt: number | undefined;
    for (let i = 0; i < 400 && setDownAt === undefined; i += 1) {
      sim.update();
      const still = sim.settlers.get(carrier.id);
      if (still !== carrier) break;
      if (carrier.carrying === null) setDownAt = carrier.point;
    }

    // He put it down on a flag, and not the one he was walking to: the road
    // there has gone, and the crate would have been stranded on it.
    expect(setDownAt).toBeDefined();
    expect(setDownAt).not.toBe(site.flagPoint);
    expect(sim.world.flag[setDownAt!]).toBeGreaterThan(0);

    const flag = sim.flags.require(sim.world.flag[setDownAt!]!);
    expect(flag.wares.some((parcel) => parcel.ware === held)).toBe(true);

    // Nothing was left at the far end.
    const siteFlag = sim.flags.require(sim.world.flag[site.flagPoint]!);
    expect(siteFlag.wares).toHaveLength(0);
  });

  it('never jumps him from one node to another', () => {
    const sim = newGame();
    const { carrier, farRoad } = carrierOnTheFarRoad(sim, true);

    // Caught between two nodes, which is where re-routing used to show: the
    // step was restarted from the node behind him, so he slid backwards a
    // pace before turning.
    expect(carrier.stepProgress).toBeGreaterThan(0);

    // What must not move is where he is *drawn*. He may well be turned round —
    // the two ends of a step in flight are swapped when he is sent back the way
    // he came — and that is invisible precisely because it leaves the point
    // between them untouched.
    const before = drawnPosition(sim, carrier);
    expect(sim.demolishRoad(PLAYER, farRoad.points[1]!).ok).toBe(true);
    const after = drawnPosition(sim, carrier);

    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);

    // And from there on, one neighbouring node at a time all the way home.
    const walked = [carrier.point, ...followUntilTakenIn(sim, carrier, 400)];
    for (let i = 1; i < walked.length; i += 1) {
      expect(sim.world.grid.distance(walked[i - 1]!, walked[i]!)).toBeLessThanOrEqual(1);
    }
  });
});

describe('carrying the work in and out', () => {
  it('has the woodcutter walk his log to the flag himself', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;

    let sawHimCarrying = false;
    for (let i = 0; i < 8000 && !sawHimCarrying; i += 1) {
      sim.update();
      const worker = sim.settlers.get(sim.buildings.require(id).worker);
      sawHimCarrying =
        worker?.state === SettlerState.DeliveringToFlag && worker.carrying === Ware.Log;
    }

    expect(sawHimCarrying).toBe(true);
  });

  it('sends a carrier inside the building with his delivery', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    const id = buildAndConnect(sim, BuildingType.Sawmill)!;

    let sawHimInside = false;
    for (let i = 0; i < 20000 && !sawHimInside; i += 1) {
      sim.update();
      const mill = sim.buildings.require(id);
      sawHimInside = sim.settlers
        .all()
        .some((s) => s.state === SettlerState.EnteringBuilding && s.point === mill.point);
    }

    expect(sawHimInside).toBe(true);
  });
});

describe('messages', () => {
  it('says once when a building has run out, not every tick', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    // Take every tree away, so there is nothing left to cut.
    const hut = sim.buildings.require(id);
    for (const point of sim.world.grid.pointsWithin(hut.point, 8)) {
      if (sim.world.object[point] === MapObject.Tree) sim.world.object[point] = MapObject.None;
    }

    run(sim, 6000);

    const exhausted = sim.events.filter((message) => message.category === 'exhausted');
    expect(exhausted.length).toBeGreaterThan(0);
    expect(exhausted.length).toBeLessThanOrEqual(2);
    expect(exhausted[0]!.point).toBe(hut.point);
  });

  it('waits two full minutes before saying so', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    const hut = sim.buildings.require(id);
    for (const point of sim.world.grid.pointsWithin(hut.point, 8)) {
      if (sim.world.object[point] === MapObject.Tree) sim.world.object[point] = MapObject.None;
    }

    const exhausted = () => sim.events.filter((message) => message.category === 'exhausted').length;

    // How long it had been finding nothing when it finally said so. Wall-clock
    // ticks would not do: the count only runs while the worker is indoors with
    // nothing to go out for, so it lags the clock.
    let idleWhenReported: number | undefined;
    for (let i = 0; i < 6000 && idleWhenReported === undefined; i += 1) {
      sim.update();
      if (exhausted() > 0) idleWhenReported = hut.exhaustedFor;
    }

    // Two minutes at five ticks a second. Anything sooner and a woodcutter
    // sharing a forester complains between one tree and the next.
    expect(idleWhenReported).toBe(600);
  });

  it('reports a seam once rather than once per hole', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    expect(sim.sendGeologist(PLAYER, hq.flagPoint).ok).toBe(true);

    run(sim, 40000);

    let marked = 0;
    for (let point = 0; point < sim.world.grid.size; point += 1) {
      if (sim.world.resourceKnown[point]) marked += 1;
    }

    const finds = sim.events.filter((message) => message.text.includes('finds'));
    expect(marked).toBeGreaterThan(finds.length);
  });

  it('remembers where each message happened, so the log can go there', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 4000);

    const built = sim.events.filter((message) => message.category === 'built');
    expect(built.length).toBeGreaterThan(0);
    for (const message of built) {
      expect(message.point).toBeGreaterThanOrEqual(0);
      expect(message.tick).toBeGreaterThan(0);
    }
  });
});

describe('where water lies', () => {
  it('never sits on sand, rock, or within two nodes of either', () => {
    const dry = new Set<number>([
      Terrain.Desert,
      Terrain.Mountain,
      Terrain.MountainMeadow,
      Terrain.Snow,
      Terrain.Lava,
    ]);

    const sim = newGame(726);
    const world = sim.world;
    const triangles = new Int32Array(6);

    let wells = 0;
    for (let point = 0; point < world.grid.size; point += 1) {
      if (world.resource[point] !== Resource.Water) continue;
      wells += 1;

      for (const near of world.grid.pointsWithin(point, 2)) {
        world.trianglesAroundPoint(near, triangles);
        for (let i = 0; i < 6; i += 1) {
          const triangle = triangles[i]!;
          if (triangle < 0) continue;
          expect(dry.has(world.terrainOfTriangle(triangle))).toBe(false);
        }
      }
    }

    // Still plenty of it, or the rule would have made wells unbuildable.
    expect(wells).toBeGreaterThan(100);
  });
});

describe('sharing a ware between trades', () => {
  /** How much of a ware a building is holding right now. */
  function holding(sim: Simulation, id: number, ware: Ware): number {
    const building = sim.buildings.require(id);
    const behaviour = buildingInfo(building.type).behaviour;
    if (behaviour.kind !== 'craft') return 0;

    let held = 0;
    for (let i = 0; i < behaviour.inputs.length; i += 1) {
      if (behaviour.inputs[i]!.ware === ware) held += building.inputs[i]!;
    }
    return held;
  }

  it('feeds two different kinds of consumer, not just the nearer', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    // Two trades that both burn coal, at different distances from the store.
    const smelter = buildAndConnect(sim, BuildingType.IronSmelter)!;
    const armoury = buildAndConnect(sim, BuildingType.Armoury)!;
    expect(smelter).toBeDefined();
    expect(armoury).toBeDefined();

    run(sim, 12000);

    // Coal and nothing else, so neither can burn what it is given and what
    // each was sent is still sitting in it at the end.
    hq.stock[Ware.Coal] = 40;
    run(sim, 20000);

    expect(holding(sim, smelter, Ware.Coal)).toBeGreaterThan(0);
    expect(holding(sim, armoury, Ware.Coal)).toBeGreaterThan(0);
  });

  it('sends every log to the nearer of two mills of one kind', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    const first = buildAndConnect(sim, BuildingType.Sawmill)!;
    const second = buildAndConnect(sim, BuildingType.Sawmill)!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    run(sim, 12000);

    // Watch where the logs actually go, since a mill saws them as they arrive.
    hq.stock[Ware.Log] = 40;

    let firstAt = -1;
    let secondAt = -1;
    for (let i = 0; i < 20000; i += 1) {
      sim.update();
      if (firstAt < 0 && holding(sim, first, Ware.Log) > 0) firstAt = i;
      if (secondAt < 0 && holding(sim, second, Ware.Log) > 0) secondAt = i;
    }

    // One kind of building, so distance alone decides. The nearer mill is
    // supplied first and only the overflow — once it is full — reaches the
    // other, which is what makes building a mill beside the wood worthwhile.
    expect(firstAt).toBeGreaterThanOrEqual(0);
    const nearer = sim.buildings.require(first);
    const further = sim.buildings.require(second);
    const nearerCost = sim.world.grid.distance(hq.flagPoint, nearer.flagPoint);
    const furtherCost = sim.world.grid.distance(hq.flagPoint, further.flagPoint);

    if (nearerCost < furtherCost) {
      expect(secondAt < 0 || firstAt < secondAt).toBe(true);
    } else if (furtherCost < nearerCost) {
      expect(firstAt < 0 || secondAt < firstAt).toBe(true);
    }
  });
});

describe('the frontier', () => {
  it('refuses every flag on the frontier, and still allows them inside', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    const onFrontier = (point: number): boolean =>
      DIRECTIONS.some((direction) => {
        const neighbour = sim.world.grid.neighbour(point, direction);
        return neighbour < 0 || sim.world.owner[neighbour] !== PLAYER;
      });

    let frontierPoints = 0;
    let placeable = 0;

    for (const point of sim.world.grid.pointsWithin(hq.point, 12)) {
      if (sim.world.owner[point] !== PLAYER) continue;

      if (onFrontier(point)) {
        frontierPoints += 1;
        // Nothing at all on the border: no flag, and so nothing to build.
        expect(canPlaceFlag(sim.world, point, PLAYER)).toBe(false);
        expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.None);
        continue;
      }

      if (canPlaceFlag(sim.world, point, PLAYER)) placeable += 1;
    }

    // The province genuinely has a frontier, and room to build behind it.
    expect(frontierPoints).toBeGreaterThan(0);
    expect(placeable).toBeGreaterThan(0);
  });
});

describe('a store that dispatches', () => {
  it('sends its goods out in a porter’s hands', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Sawmill);

    let sawPorter = false;
    for (let i = 0; i < 6000 && !sawPorter; i += 1) {
      sim.update();
      const hq = headquarters(sim);
      const porter = sim.settlers.get(hq.worker);
      sawPorter =
        porter !== undefined &&
        porter.carrying !== null &&
        porter.state === SettlerState.DeliveringToFlag;
    }

    expect(sawPorter).toBe(true);
  });

  it('costs the province nobody to do it', () => {
    const sim = newGame();
    buildAndConnect(sim, BuildingType.Sawmill);
    // Taking a porter out of the reserve must not change the head count.
    runWatchingPopulation(sim, 6000);
  });
});

describe('saying a building has run out', () => {
  it('waits until it has really stopped, and says so once', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    const hut = sim.buildings.require(id);
    for (const point of sim.world.grid.pointsWithin(hut.point, 8)) {
      if (sim.world.object[point] === MapObject.Tree) sim.world.object[point] = MapObject.None;
    }

    // Nothing said while it is merely between trips.
    run(sim, 200);
    expect(sim.events.filter((message) => message.category === 'exhausted')).toHaveLength(0);

    run(sim, 8000);
    const exhausted = sim.events.filter((message) => message.category === 'exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.point).toBe(hut.point);
  });
});

describe('one carrier to a road', () => {
  /**
   * The books kept about carriers, checked both ways.
   *
   * Every settler who thinks he works a road must be the man that road names,
   * and every carrier must be standing on the stretch he works. A settler who
   * fails either test is a ghost: he will never be given work, never be sent
   * home, and — if he is off his road — never move again, because every route
   * a carrier takes is computed along the road's own points.
   */
  function carrierProblems(sim: Simulation): string[] {
    const problems: string[] = [];

    for (const settler of sim.settlers.all()) {
      if (settler.road === 0) continue;
      const road = sim.roads.get(settler.road);
      if (!road) {
        problems.push(`settler ${settler.id} holds road ${settler.road}, which no longer exists`);
      } else if (road.carrier !== settler.id) {
        problems.push(`settler ${settler.id} claims road ${road.id}, whose carrier is ${road.carrier}`);
      }
    }

    for (const road of sim.roads.all()) {
      const carrier = sim.settlers.get(road.carrier);
      if (!carrier || carrier.state === SettlerState.WalkingToJob) continue;
      // A man with a path under him is on his way somewhere and will arrive.
      // What must never happen is one standing still, off his own road, with
      // nothing to do — there is no tick that would ever move him again.
      if (carrier.path.length > 0) continue;
      if (!road.points.includes(carrier.point)) {
        problems.push(`road ${road.id} carrier ${carrier.id} stands at ${carrier.point}, off it`);
      }
    }

    return problems;
  }

  /** Every spot within reach that will take a hut, furthest from the door first. */
  function sitesAround(sim: Simulation): number[] {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    return sim.world.grid
      .pointsWithin(hq.point, 9)
      .filter((point) => {
        if (sim.world.grid.distance(hq.point, point) < 4) return false;
        const space = evaluateBuildSpace(sim.world, point, PLAYER);
        return space !== BuildSpace.None && canHostSize(space, info.size);
      });
  }

  function connect(sim: Simulation, point: number): number {
    expect(sim.placeBuilding(PLAYER, point, BuildingType.Sawmill).ok).toBe(true);
    const building = sim.buildings.find((candidate) => candidate.point === point)!;
    const route = planRoad(sim.world, headquarters(sim).flagPoint, building.flagPoint, PLAYER);
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);
    return building.id;
  }

  it('sends home a settler still walking out to a road that is torn up', () => {
    const sim = newGame();
    const sites = sitesAround(sim);

    connect(sim, sites[0]!);
    const road = sim.roads.all()[0]!;

    // Catch him after the road has asked for a carrier and before he arrives.
    let walker: ReturnType<typeof sim.settlers.get>;
    for (let i = 0; i < 200 && !walker; i += 1) {
      sim.update();
      if (!road.carrierRequested || road.carrier !== 0) continue;
      walker = sim.settlers.all().find((settler) => settler.road === road.id);
    }
    expect(walker).toBeDefined();
    expect(walker!.state).toBe(SettlerState.WalkingToJob);

    const retired = road.id;
    expect(sim.demolishRoad(PLAYER, road.points[1]!).ok).toBe(true);

    // He must not still be carrying a dead road's name about with him. Entity
    // ids are recycled, so holding one means arriving at a road that is now
    // somewhere else entirely and taking it over.
    expect(walker!.road).toBe(0);

    // Lay another road, which takes the freed id.
    connect(sim, sites[sites.length - 1]!);
    expect(sim.roads.all().some((other) => other.id === retired)).toBe(true);

    run(sim, 400);
    expect(carrierProblems(sim)).toEqual([]);
  });

  it('retires a carrier his road no longer names', () => {
    const sim = newGame();
    connect(sim, sitesAround(sim)[0]!);
    run(sim, 600);

    const road = sim.roads.all()[0]!;
    const carrier = sim.settlers.require(road.carrier);

    // A second man on the same stretch, as an inconsistent save carries.
    const ghost = sim.settlers.all().find((settler) => settler.road === 0 && settler.id !== carrier.id)!;
    ghost.road = road.id;
    ghost.state = SettlerState.CarrierWaiting;
    expect(carrierProblems(sim)).not.toEqual([]);

    run(sim, 200);
    expect(carrierProblems(sim)).toEqual([]);
  });

  it('walks a carrier back to his road instead of leaving him standing', () => {
    const sim = newGame();
    connect(sim, sitesAround(sim)[0]!);

    // He has to be genuinely idle at his post: a carrier caught mid-delivery
    // already has a path under him and would walk on whatever we did to him.
    const road = sim.roads.all()[0]!;
    let carrier: ReturnType<typeof sim.settlers.get>;
    for (let i = 0; i < 2000 && !carrier; i += 1) {
      sim.update();
      const candidate = sim.settlers.get(road.carrier);
      if (candidate?.state === SettlerState.CarrierWaiting && candidate.path.length === 0) {
        carrier = candidate;
      }
    }
    expect(carrier).toBeDefined();

    // Put him well off his own stretch, as the ghost in the reported save was.
    // Every route a carrier plans runs along his road's own points, so without
    // a way back across open ground he stands here for the rest of the game.
    const stranded = sim.world.grid
      .pointsWithin(headquarters(sim).point, 4)
      .find(
        (point) =>
          sim.world.isWalkable(point) &&
          !road.points.includes(point) &&
          sim.world.grid.distance(point, road.points[0]!) >= 3,
      )!;
    expect(stranded).toBeDefined();

    carrier!.point = stranded;
    carrier!.fromPoint = stranded;
    carrier!.toPoint = stranded;
    carrier!.stepProgress = 0;
    carrier!.path = [];
    carrier!.pathIndex = 0;

    run(sim, 400);
    expect(carrier!.point).not.toBe(stranded);
    expect(carrierProblems(sim)).toEqual([]);
  });
});

describe('where a carrier waits', () => {
  /** The split stretch with an even number of points, before anyone walks it. */
  function evenRoad(sim: Simulation) {
    splitRoad(sim, 3, 0);
    const road = sim.roads.all().find((candidate) => candidate.points.length % 2 === 0);
    expect(road).toBeDefined();
    return road!;
  }

  /** Lays a long road and splits it, to get stretches of a chosen length. */
  function splitRoad(sim: Simulation, at: number, settle = 3000) {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    let far: number | undefined;
    let furthest = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      const distance = sim.world.grid.distance(hq.point, point);
      if (distance <= furthest) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      furthest = distance;
      far = point;
    }

    expect(sim.placeBuilding(PLAYER, far!, BuildingType.Sawmill).ok).toBe(true);
    const site = sim.buildings.find((building) => building.point === far)!;
    expect(sim.placeRoad(PLAYER, planRoad(sim.world, hq.flagPoint, site.flagPoint, PLAYER)!).ok).toBe(
      true,
    );

    const whole = sim.roads.all()[0]!;
    expect(sim.placeFlag(PLAYER, whole.points[at]!).ok).toBe(true);
    run(sim, settle);
  }

  it('stands halfway between two nodes when the stretch has no middle one', () => {
    const sim = newGame();
    splitRoad(sim, 3);

    const road = sim.roads.all().find((candidate) => candidate.points.length % 2 === 0)!;
    expect(road).toBeDefined();

    const carrier = sim.settlers.require(road.carrier);
    expect(carrier.state).toBe(SettlerState.CarrierWaiting);

    // Two flags three nodes apart: the centre falls between the middle pair,
    // and posting him on either would have him hugging one flag.
    const middle = road.points.length / 2;
    expect(carrier.point).toBe(road.points[middle - 1]);
    expect(carrier.toPoint).toBe(road.points[middle]);
    expect(sim.stepFraction(carrier)).toBe(0.5);
  });

  it('stands on the middle node when the stretch has one', () => {
    const sim = newGame();
    splitRoad(sim, 2);

    const road = sim.roads.all().find((candidate) => candidate.points.length % 2 === 1)!;
    const carrier = sim.settlers.require(road.carrier);

    expect(carrier.point).toBe(road.points[(road.points.length - 1) / 2]);
    expect(sim.stepFraction(carrier)).toBe(0);
  });

  it('comes home to its post without walking through it', () => {
    const sim = newGame();
    const road = evenRoad(sim);
    const { grid } = sim.world;

    // The post is the midpoint of the middle edge, whichever of the two nodes
    // he ends up standing on.
    const mid = road.points.length / 2;
    const postX = (grid.worldX(road.points[mid - 1]!) + grid.worldX(road.points[mid]!)) / 2;
    const postY = (grid.worldY(road.points[mid - 1]!) + grid.worldY(road.points[mid]!)) / 2;

    // Every unbroken spell of idleness, as a run of distances to the post. A
    // carrier with nothing to do only ever closes on it, so any rise inside one
    // run is him having walked past it and turned round.
    const runs: number[][] = [];
    let run: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      sim.update();

      const carrier = sim.settlers.get(road.carrier);
      const idle =
        carrier && carrier.state === SettlerState.CarrierWaiting && carrier.carrying === null;
      if (!idle) {
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }

      const at = drawnPosition(sim, carrier);
      run.push(Math.hypot(at.x - postX, at.y - postY));
    }
    if (run.length > 0) runs.push(run);

    // He has to have gone out and come back at least once for this to mean
    // anything: a carrier who never left is trivially never overshooting.
    expect(runs.some((spell) => spell[0]! > 1)).toBe(true);

    // Routing him always to the same one of the middle pair marched a man
    // coming home from the far end straight through the halfway point, onto the
    // node beyond it, and half a pace back again.
    for (const spell of runs) {
      for (let i = 1; i < spell.length; i += 1) {
        expect(spell[i]).toBeLessThanOrEqual(spell[i - 1]! + 1e-9);
      }
    }
  });
});

describe('a carrier at rest', () => {
  /** A road split so one stretch has an odd number of steps — no middle node. */
  function oddStepRoad(sim: Simulation) {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    let far: number | undefined;
    let furthest = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      const distance = sim.world.grid.distance(hq.point, point);
      if (distance <= furthest) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      furthest = distance;
      far = point;
    }
    expect(sim.placeBuilding(PLAYER, far!, BuildingType.Sawmill).ok).toBe(true);

    const site = sim.buildings.find((building) => building.point === far)!;
    const route = planRoad(sim.world, hq.flagPoint, site.flagPoint, PLAYER);
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    const whole = sim.roads.all()[0]!;
    const split = [3, 1, 5]
      .map((index) => whole.points[index])
      .find((point) => point !== undefined && sim.placeFlag(PLAYER, point).ok);
    expect(split).toBeDefined();

    run(sim, 3000);

    const road = sim.roads.all().find((candidate) => candidate.points.length % 2 === 0)!;
    expect(road).toBeDefined();
    return road;
  }

  it('does not twitch while it stands still', () => {
    const sim = newGame();
    const road = oddStepRoad(sim);
    const carrier = sim.settlers.require(road.carrier);

    expect(carrier.state).toBe(SettlerState.CarrierWaiting);
    expect(carrier.path).toHaveLength(0);
    expect(carrier.stepProgress).toBeGreaterThan(0);

    // The renderer asks where he is several times between ticks. Guessing ahead
    // for a man who is not going anywhere slid him a fraction of a node forward
    // and snapped him back, five times a second, all along the road.
    const drawn = [0, 0.25, 0.5, 0.75, 0.99].map((alpha) => sim.stepFraction(carrier, alpha));
    expect(drawn).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it('turns on the spot when sent back the way it faces', () => {
    const sim = newGame();
    const road = oddStepRoad(sim);
    const carrier = sim.settlers.require(road.carrier);

    const post = carrier.point;
    const ahead = carrier.toPoint;
    const behind = road.points[road.points.indexOf(post) - 1] ?? road.points[road.points.indexOf(post) + 1]!;
    expect(behind).not.toBe(ahead);

    const before = drawnPosition(sim, carrier);

    // The route a crate on the flag behind him produces. It is worked out from
    // the node he is facing — that is where his step commits him — so it comes
    // back through the post before carrying on.
    const route = [post, behind];
    (sim as unknown as { redirect(settler: Settler, path: number[]): void }).redirect(carrier, route);

    // He pivots where he stands: same place on screen, now facing the other way,
    // and no wasted pace forward to turn around in.
    const after = drawnPosition(sim, carrier);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    expect(carrier.toPoint).toBe(post);
    expect(carrier.path[0]).toBe(post);
    // No pace wasted going forward first, which is what the jig looked like.
    expect(carrier.path).not.toContain(ahead);
  });
});

describe('a carrier walking out to his road', () => {
  /** Lays a road drawn from the far end, so `fromFlag` is away from the store. */
  function roadDrawnBackwards(sim: Simulation) {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    let far: number | undefined;
    let furthest = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      const distance = sim.world.grid.distance(hq.point, point);
      if (distance <= furthest) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      furthest = distance;
      far = point;
    }
    expect(sim.placeBuilding(PLAYER, far!, BuildingType.Sawmill).ok).toBe(true);

    const site = sim.buildings.find((building) => building.point === far)!;
    const route = planRoad(sim.world, site.flagPoint, hq.flagPoint, PLAYER);
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    const road = sim.roads.all()[0]!;
    // Drawn from the site, so the road's own "from" end is the far one.
    expect(sim.flags.require(road.fromFlag).point).not.toBe(hq.flagPoint);
    return road;
  }

  it('joins it at the near end rather than walking its whole length', () => {
    const sim = newGame();
    const road = roadDrawnBackwards(sim);
    const farFlagPoint = sim.flags.require(road.fromFlag).point;

    let carrier: ReturnType<typeof sim.settlers.get>;
    const walked: number[] = [];
    for (let i = 0; i < 3000; i += 1) {
      sim.update();
      carrier = carrier ?? sim.settlers.all().find((settler) => settler.road === road.id);
      if (!carrier) continue;
      if (carrier.state !== SettlerState.WalkingToJob) break;
      walked.push(carrier.point);
    }

    expect(carrier).toBeDefined();
    // `fromFlag` is merely the end the road was drawn from. Walking always to it
    // marched him the length of the road and back — twelve nodes for a walk that
    // needs none at all when the store is already at the other end.
    expect(walked).not.toContain(farFlagPoint);
  });

  it('picks up a waiting crate before it ever reaches its post', () => {
    const sim = newGame();
    const road = roadDrawnBackwards(sim);
    const middle = road.points[Math.floor(road.points.length / 2)]!;

    // He is an ordinary carrier from the moment he reaches the road, and work
    // runs ahead of the stroll to the middle — so with a crate already waiting
    // he should be carrying it before he has ever stood at his post.
    let restedFirst = false;
    let carriedFirst = false;
    for (let i = 0; i < 4000 && !carriedFirst && !restedFirst; i += 1) {
      sim.update();
      const carrier = sim.settlers.get(road.carrier);
      if (!carrier) continue;
      if (carrier.carrying !== null) carriedFirst = true;
      else if (carrier.point === middle) restedFirst = true;
    }

    expect(carriedFirst).toBe(true);
    expect(restedFirst).toBe(false);
  });
});

describe('nobody jumps', () => {
  /** The furthest a settler can be drawn moving in one tick, with slack. */
  const A_STEP = 0.2;

  it('walks a carrier into his post rather than placing him there', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    expect(id).toBeDefined();

    // A stretch whose middle falls between two nodes is where the post sits
    // half a step out, and where the jump showed.
    const whole = sim.roads.all()[0]!;
    [3, 1, 5]
      .map((index) => whole.points[index])
      .some((point) => point !== undefined && sim.placeFlag(PLAYER, point).ok);
    const road = sim.roads.all().find((candidate) => candidate.points.length % 2 === 0);
    expect(road).toBeDefined();

    let worst = 0;
    let previous: { x: number; y: number } | undefined;
    for (let i = 0; i < 6000; i += 1) {
      sim.update();
      const carrier = sim.settlers.get(road!.carrier);
      if (!carrier) {
        previous = undefined;
        continue;
      }
      const now = drawnPosition(sim, carrier);
      if (previous) {
        worst = Math.max(worst, Math.hypot(now.x - previous.x, now.y - previous.y));
      }
      previous = now;
    }

    // Placing him halfway outright moved him half a node in one tick, every
    // time he got back from a delivery.
    expect(worst).toBeLessThan(A_STEP);
  });

  it('turns a dismissed settler for home without snapping him back', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    // As far off as the territory allows, so the road is long enough to split
    // and its far stretch is not on the store's doorstep — a carrier hired for
    // that stretch has a real walk out to be interrupted.
    let point: number | undefined;
    let furthest = 0;
    for (const candidate of sim.world.grid.pointsWithin(hq.point, 9)) {
      const distance = sim.world.grid.distance(hq.point, candidate);
      if (distance <= furthest) continue;
      const space = evaluateBuildSpace(sim.world, candidate, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      furthest = distance;
      point = candidate;
    }
    expect(sim.placeBuilding(PLAYER, point!, BuildingType.Sawmill).ok).toBe(true);

    const site = sim.buildings.find((building) => building.point === point)!;
    const route = planRoad(sim.world, hq.flagPoint, site.flagPoint, PLAYER);
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    const whole = sim.roads.all()[0]!;
    [2, 3, 1]
      .map((index) => whole.points[index])
      .some((point) => point !== undefined && sim.placeFlag(PLAYER, point).ok);
    const far = sim.roads.all().find((road) => road.points.includes(site.flagPoint))!;

    // Catch him well into a step, where the snap back was largest.
    let walker: ReturnType<typeof sim.settlers.get>;
    for (let i = 0; i < 2000 && !walker; i += 1) {
      sim.update();
      walker = sim.settlers
        .all()
        .find(
          (settler) =>
            settler.road === far.id &&
            settler.state === SettlerState.WalkingToJob &&
            settler.stepProgress >= 6 &&
            settler.toPoint !== settler.point,
        );
    }
    expect(walker).toBeDefined();

    const before = drawnPosition(sim, walker!);
    expect(sim.demolishRoad(PLAYER, far.points[1]!).ok).toBe(true);
    const after = drawnPosition(sim, walker!);

    // Routing him home from the node behind him threw him three quarters of a
    // node backwards the instant the road went.
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(A_STEP);
  });
});

describe('a geologist whose flag is taken away', () => {
  it('finishes the hole he is digging and then goes home', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    expect(sim.sendGeologist(PLAYER, hq.flagPoint).ok).toBe(true);

    // Wait until he is actually digging.
    let geologist: ReturnType<typeof sim.settlers.get>;
    for (let i = 0; i < 4000 && !geologist; i += 1) {
      sim.update();
      geologist = sim.settlers
        .all()
        .find(
          (settler) =>
            settler.profession === Profession.Geologist &&
            settler.state === SettlerState.PerformingTask,
        );
    }
    expect(geologist).toBeDefined();

    const hole = geologist!.taskPoint;
    expect(sim.world.resourceKnown[hole]).toBe(0);

    // The headquarters flag cannot be removed, so stand in for the player by
    // taking the flag off the map the way `demolishFlag` would.
    sim.world.flag[geologist!.surveyFrom] = 0;

    run(sim, 2000);

    // The hole he had started is reported — his walk out was not wasted — and
    // he is on his way back rather than digging another.
    expect(sim.world.resourceKnown[hole]).toBe(1);
    const still = sim.settlers.get(geologist!.id);
    if (still === geologist) {
      expect(geologist!.state).toBe(SettlerState.ReturningToStore);
    }
  });
});

describe('corn', () => {
  const FARMING_SEED = 726;

  it('ripens field by field rather than all at once', () => {
    const sim = newGame(FARMING_SEED);
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Farm);

    let best: number | undefined;
    let bestSoil = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      if (sim.world.grid.distance(hq.point, point) < 3) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      const soil = sim.world.grid
        .pointsWithin(point, 2)
        .filter((near) => sim.world.farmableSides(near) === 6).length;
      if (soil > bestSoil) {
        bestSoil = soil;
        best = point;
      }
    }
    expect(sim.placeBuilding(PLAYER, best!, BuildingType.Farm).ok).toBe(true);
    const farm = sim.buildings.find((building) => building.point === best)!;
    const route = planRoad(sim.world, hq.flagPoint, farm.flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);

    // Whether two fields ever ripen on the *same* tick. Sharing one clock they
    // all step together, which is what read as a single flickering field; on
    // their own clocks no two nodes in a farm's ring ever come due at once.
    const ring = sim.world.grid.pointsWithin(farm.point, 6);
    const stageOf = new Map<number, number>();
    let mostInOneTick = 0;
    let sawGrowth = false;

    for (let i = 0; i < 20000; i += 1) {
      sim.update();

      let ripenedThisTick = 0;
      for (const point of ring) {
        const stage =
          sim.world.object[point] === MapObject.Field ? sim.world.objectData[point]! : -1;
        const was = stageOf.get(point);
        // Only a field that was already standing counts. Sowing takes a node
        // from nothing (-1) to stage zero, which is not ripening — counting it
        // made two fields sown in one tick look like two ripening together.
        if (was !== undefined && was >= 0 && stage > was) ripenedThisTick += 1;
        stageOf.set(point, stage);
      }

      if (ripenedThisTick > 0) sawGrowth = true;
      mostInOneTick = Math.max(mostInOneTick, ripenedThisTick);
    }

    expect(sawGrowth).toBe(true);
    expect(mostInOneTick).toBe(1);
  });
});

describe('a farm with corn on the way', () => {
  const FARMING_SEED = 726;

  function farmOnGoodSoil(sim: Simulation) {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Farm);

    let best: number | undefined;
    let bestSoil = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      if (sim.world.grid.distance(hq.point, point) < 3) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      const soil = sim.world.grid
        .pointsWithin(point, 2)
        .filter((near) => sim.world.farmableSides(near) === 6).length;
      if (soil > bestSoil) {
        bestSoil = soil;
        best = point;
      }
    }
    expect(sim.placeBuilding(PLAYER, best!, BuildingType.Farm).ok).toBe(true);
    const farm = sim.buildings.find((building) => building.point === best)!;
    const route = planRoad(sim.world, hq.flagPoint, farm.flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);
    return farm;
  }

  it('says nothing while it waits for the crop', () => {
    const sim = newGame(FARMING_SEED);
    const farm = farmOnGoodSoil(sim);

    // Long past the point at which a building that had really run out would
    // have said so. A farmer between jobs is not an exhausted farm.
    run(sim, 20000);

    expect(sim.world.grid
      .pointsWithin(farm.point, 6)
      .some((point) => sim.world.object[point] === MapObject.Field)).toBe(true);
    expect(sim.events.filter((message) => message.category === 'exhausted')).toHaveLength(0);
  });

  it('still says so once there is nowhere left to sow', () => {
    const sim = newGame(FARMING_SEED);
    const farm = farmOnGoodSoil(sim);
    run(sim, 3000);

    // Wall the farm in: no corn standing, and every node of its ring built on.
    for (const point of sim.world.grid.pointsWithin(farm.point, 6)) {
      if (sim.world.object[point] === MapObject.Field) sim.world.object[point] = MapObject.None;
      if (sim.world.grid.distance(farm.point, point) === 2) sim.world.building[point] = farm.id;
    }

    run(sim, 8000);
    expect(sim.events.filter((message) => message.category === 'exhausted').length).toBeGreaterThan(0);
  });
});

describe('the province filling up', () => {
  it('takes in a settler every thirty seconds', () => {
    const sim = newGame();

    // When each one arrives, rather than how many: a bare game reaches its
    // ceiling almost at once, so counting heads measures the cap and not the
    // pace.
    const arrivals: number[] = [];
    let previous = sim.population(PLAYER);
    for (let i = 0; i < 2000; i += 1) {
      sim.update();
      const now = sim.population(PLAYER);
      if (now > previous) arrivals.push(sim.tick);
      previous = now;
    }

    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < arrivals.length; i += 1) {
      // Thirty seconds at five ticks a second.
      expect(arrivals[i]! - arrivals[i - 1]!).toBe(150);
    }
  });

  it('lets each finished building support four more', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    // The headquarters alone: thirty-two, plus four for itself.
    run(sim, 60000);
    const finished = sim.buildings
      .all()
      .filter((building) => building.owner === PLAYER && building.state === BuildingState.Complete)
      .length;

    expect(sim.population(PLAYER)).toBe(32 + finished * 4);
    expect(hq.reserve).toBeGreaterThan(0);
  });
});

describe('taking a flag down', () => {
  /**
   * Every ware in the world, wherever it happens to be.
   *
   * The invariant that would have caught the reported game: goods do not
   * evaporate because the player rearranged his roads.
   */
  function wareCount(sim: Simulation): number {
    let total = 0;
    sim.buildings.forEach((building) => {
      for (const held of building.stock) total += held;
      for (const done of building.delivered) total += done;
      for (const held of building.inputs) total += held;
      if (building.output !== null) total += 1;
    });
    sim.flags.forEach((flag) => {
      total += flag.wares.length;
    });
    sim.settlers.forEach((settler) => {
      if (settler.carrying !== null) total += 1;
    });
    return total;
  }

  /**
   * Buildings whose idea of what is coming disagrees with what is really on its
   * way. A reservation left standing for a ware that no longer exists is what
   * strands a site for ever: `outstandingDemand` subtracts it, so the building
   * looks satisfied and nothing more is sent.
   */
  function reservationErrors(sim: Simulation): string[] {
    const inFlight = new Map<string, number>();
    const bump = (buildingId: number, ware: Ware) => {
      if (buildingId === 0) return;
      const key = `${buildingId}:${ware}`;
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    };

    sim.flags.forEach((flag) => {
      for (const parcel of flag.wares) bump(parcel.destination, parcel.ware);
    });
    sim.settlers.forEach((settler) => {
      if (settler.carrying !== null) bump(settler.carryDestination, settler.carrying);
    });

    const problems: string[] = [];
    sim.buildings.forEach((building) => {
      if (building.state !== BuildingState.UnderConstruction) return;
      buildingInfo(building.type).cost.forEach((item, index) => {
        const real = inFlight.get(`${building.id}:${item.ware}`) ?? 0;
        if (building.incoming[index] !== real) {
          problems.push(
            `building ${building.id} claims ${building.incoming[index]} of ware ${item.ware}, really ${real}`,
          );
        }
      });
    });
    return problems;
  }

  /** A junction flag with crates waiting on it — the case that lost them. */
  function junctionWithCrates(sim: Simulation) {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    let far: number | undefined;
    let furthest = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      const distance = sim.world.grid.distance(hq.point, point);
      if (distance <= furthest) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      furthest = distance;
      far = point;
    }
    expect(sim.placeBuilding(PLAYER, far!, BuildingType.Sawmill).ok).toBe(true);
    const site = sim.buildings.find((building) => building.point === far)!;
    expect(sim.placeRoad(PLAYER, planRoad(sim.world, hq.flagPoint, site.flagPoint, PLAYER)!).ok).toBe(
      true,
    );

    const whole = sim.roads.all()[0]!;
    const middle = [3, 2, 1]
      .map((index) => whole.points[index])
      .find((point) => point !== undefined && sim.placeFlag(PLAYER, point).ok);
    expect(middle).toBeDefined();

    // A third road makes it a junction, so removing it cannot merge two
    // stretches and the roads come down instead.
    const hutInfo = buildingInfo(BuildingType.Woodcutter);
    for (const point of sim.world.grid.pointsWithin(middle!, 5)) {
      if (sim.world.grid.distance(middle!, point) < 2) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, hutInfo.size)) continue;
      if (!sim.placeBuilding(PLAYER, point, BuildingType.Woodcutter).ok) continue;
      const hut = sim.buildings.find((building) => building.point === point)!;
      const spur = planRoad(sim.world, middle!, hut.flagPoint, PLAYER);
      if (spur && sim.placeRoad(PLAYER, spur).ok) break;
    }

    let flag: ReturnType<typeof sim.flags.get>;
    for (let i = 0; i < 4000; i += 1) {
      sim.update();
      flag = sim.flags.all().find((candidate) => candidate.point === middle);
      if (flag && flag.wares.length >= 2) break;
    }
    expect(flag).toBeDefined();
    expect(flag!.wares.length).toBeGreaterThanOrEqual(2);
    return { flag: flag!, point: middle! };
  }

  it('keeps the crates that were waiting on it', () => {
    const sim = newGame();
    const { point } = junctionWithCrates(sim);

    const before = wareCount(sim);
    expect(sim.demolishFlag(PLAYER, point).ok).toBe(true);

    // Deleting the flag with its crates still on it destroyed them outright.
    expect(wareCount(sim)).toBe(before);
  });

  it('leaves no building counting on a ware that has gone', () => {
    const sim = newGame();
    const { point } = junctionWithCrates(sim);

    expect(sim.demolishFlag(PLAYER, point).ok).toBe(true);
    run(sim, 100);

    expect(reservationErrors(sim)).toEqual([]);
  });

  it('sets the crates down a road away, not across the province', () => {
    const sim = newGame();
    const { flag, point } = junctionWithCrates(sim);

    // The flags one road from here: where a crate may legitimately end up.
    const oneRoadAway = new Set<number>();
    for (const roadId of flag.roads) {
      const road = sim.roads.require(roadId);
      const other = road.fromFlag === flag.id ? road.toFlag : road.fromFlag;
      oneRoadAway.add(sim.flags.require(other).point);
    }

    const held = flag.wares.map((parcel) => parcel.ware);
    expect(sim.demolishFlag(PLAYER, point).ok).toBe(true);

    for (const ware of held) {
      const landed = sim.flags
        .all()
        .filter((candidate) => candidate.wares.some((parcel) => parcel.ware === ware))
        .map((candidate) => candidate.point);
      expect(landed.some((where) => oneRoadAway.has(where))).toBe(true);
    }
  });
});

describe('a flag raised under a walking carrier', () => {
  it('does not move him', () => {
    for (const loaded of [false, true]) {
      const sim = newGame();
      const hq = headquarters(sim);
      const info = buildingInfo(BuildingType.Sawmill);

      let far: number | undefined;
      let furthest = 0;
      for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
        const distance = sim.world.grid.distance(hq.point, point);
        if (distance <= furthest) continue;
        const space = evaluateBuildSpace(sim.world, point, PLAYER);
        if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
        furthest = distance;
        far = point;
      }
      expect(sim.placeBuilding(PLAYER, far!, BuildingType.Sawmill).ok).toBe(true);
      const site = sim.buildings.find((building) => building.point === far)!;
      expect(
        sim.placeRoad(PLAYER, planRoad(sim.world, hq.flagPoint, site.flagPoint, PLAYER)!).ok,
      ).toBe(true);
      const road = sim.roads.all()[0]!;

      let carrier: ReturnType<typeof sim.settlers.get>;
      for (let i = 0; i < 4000 && !carrier; i += 1) {
        sim.update();
        const candidate = sim.settlers.get(road.carrier);
        if (
          candidate &&
          candidate.stepProgress >= 5 &&
          candidate.toPoint !== candidate.point &&
          (candidate.carrying !== null) === loaded
        ) {
          carrier = candidate;
        }
      }
      expect(carrier).toBeDefined();

      const spot = road.points.find(
        (point) =>
          point !== carrier!.point && point !== carrier!.toPoint && sim.world.flag[point] === 0,
      );
      expect(spot).toBeDefined();

      // Dividing the road under him re-routed him from the node behind, which
      // threw him most of a node backwards.
      const before = drawnPosition(sim, carrier!);
      expect(sim.placeFlag(PLAYER, spot!).ok).toBe(true);
      const after = drawnPosition(sim, carrier!);

      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.2);
    }
  });
});

describe('a doorstep that already has a flag', () => {
  /** A site whose own flag point can take a flag, with the flag already there. */
  function siteBehindAFlag(sim: Simulation) {
    const hq = headquarters(sim);
    for (const point of sim.world.grid.pointsWithin(hq.point, 8)) {
      if (sim.world.grid.distance(hq.point, point) < 4) continue;
      if (evaluateBuildSpace(sim.world, point, PLAYER) < BuildSpace.Hut) continue;

      const flagPoint = sim.world.grid.neighbour(point, FLAG_DIRECTION);
      if (flagPoint === OUT_OF_BOUNDS) continue;
      if (!sim.placeFlag(PLAYER, flagPoint).ok) continue;
      return { point, flagPoint };
    }
    throw new Error('no site found behind a flag');
  }

  it('is still offered as a building site', () => {
    const sim = newGame();
    const { point } = siteBehindAFlag(sim);

    // The flag a building would use sits on a neighbouring node by
    // construction, and the no-crowding rule used to disqualify the site for it.
    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBeGreaterThanOrEqual(BuildSpace.Hut);
  });

  it('is used rather than a second flag being raised', () => {
    const sim = newGame();
    const { point, flagPoint } = siteBehindAFlag(sim);
    const flagsBefore = sim.flags.all().length;

    expect(sim.placeBuilding(PLAYER, point, BuildingType.Woodcutter).ok).toBe(true);

    const built = sim.buildings.find((building) => building.point === point)!;
    expect(built.flagPoint).toBe(flagPoint);
    expect(sim.flags.all()).toHaveLength(flagsBefore);
    expect(sim.flags.require(sim.world.flag[flagPoint]!).building).toBe(built.id);
  });

  it('will not let two buildings share one flag', () => {
    const sim = newGame();
    const { point, flagPoint } = siteBehindAFlag(sim);
    expect(sim.placeBuilding(PLAYER, point, BuildingType.Woodcutter).ok).toBe(true);

    // The node whose own doorstep would be that same flag.
    expect(evaluateBuildSpace(sim.world, flagPoint, PLAYER)).toBe(BuildSpace.None);
  });
});

describe('a reservation for a ware that no longer exists', () => {
  it('is counted back from the world and let go', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Sawmill)!;
    expect(id).toBeDefined();
    run(sim, 400);

    const site = sim.buildings.require(id);
    expect(site.state).toBe(BuildingState.UnderConstruction);

    // The damage a lost crate used to leave behind: the site goes on counting a
    // ware that is nowhere in the world. `outstandingDemand` subtracts it, so
    // the site looks satisfied, nothing more is sent, and it waits for ever —
    // which is how a player's barracks ended up one stone short.
    const index = site.incoming.findIndex((_, at) => at >= 0);
    site.incoming[index] = site.incoming[index]! + 5;

    run(sim, 100);

    // Counted back from the crates and hands that really exist.
    const ware = buildingInfo(site.type).cost[index]!.ware;
    let real = 0;
    sim.flags.forEach((flag) => {
      real += flag.wares.filter(
        (parcel) => parcel.destination === site.id && parcel.ware === ware,
      ).length;
    });
    sim.settlers.forEach((settler) => {
      if (settler.carryDestination === site.id && settler.carrying === ware) real += 1;
    });

    expect(site.incoming[index]).toBe(real);
  });

});

describe('a wood coming on', () => {
  it('grows tree by tree rather than all at once', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Forester)!;
    expect(id).toBeDefined();
    const hut = sim.buildings.require(id);

    const around = sim.world.grid.pointsWithin(hut.point, 6);
    const stageOf = new Map<number, number>();
    let mostInOneTick = 0;
    let sawGrowth = false;

    for (let i = 0; i < 20000; i += 1) {
      sim.update();

      let grewThisTick = 0;
      for (const point of around) {
        const stage = sim.world.object[point] === MapObject.Tree ? sim.world.objectData[point]! : -1;
        const was = stageOf.get(point);
        // Only a tree that was already standing counts; planting is not growth.
        if (was !== undefined && was >= 0 && stage > was) grewThisTick += 1;
        stageOf.set(point, stage);
      }

      if (grewThisTick > 0) sawGrowth = true;
      mostInOneTick = Math.max(mostInOneTick, grewThisTick);
    }

    expect(sawGrowth).toBe(true);
    expect(mostInOneTick).toBe(1);
  });
});

describe('waiting for ripeness', () => {
  /**
   * The last growth stage a node was seen at before whatever stood there was
   * taken away. Nothing may be harvested below its fully grown stage — there is
   * a whole growth interval between looking ready and being ready.
   */
  function stagesAtHarvest(sim: Simulation, centre: number, object: MapObject): number[] {
    const around = sim.world.grid.pointsWithin(centre, 6);
    const stageOf = new Map<number, number>();
    const taken: number[] = [];

    for (let i = 0; i < 20000; i += 1) {
      sim.update();
      for (const point of around) {
        const here = sim.world.object[point] === object ? sim.world.objectData[point]! : -1;
        const was = stageOf.get(point);
        if (was !== undefined && was >= 0 && here === -1) taken.push(was);
        stageOf.set(point, here);
      }
    }
    return taken;
  }

  it('leaves corn standing until it is more than merely grown', () => {
    const sim = newGame(726);
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Farm);

    let best: number | undefined;
    let bestSoil = 0;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      if (sim.world.grid.distance(hq.point, point) < 3) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      const soil = sim.world.grid
        .pointsWithin(point, 2)
        .filter((near) => sim.world.farmableSides(near) === 6).length;
      if (soil > bestSoil) {
        bestSoil = soil;
        best = point;
      }
    }
    expect(sim.placeBuilding(PLAYER, best!, BuildingType.Farm).ok).toBe(true);
    const farm = sim.buildings.find((building) => building.point === best)!;
    const route = planRoad(sim.world, hq.flagPoint, farm.flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);

    // Measured against the last stage that is *drawn*: corn taken the moment it
    // finished looking ready would come away at that stage, and it must not.
    const taken = stagesAtHarvest(sim, farm.point, MapObject.Field);
    expect(taken.length).toBeGreaterThan(0);
    for (const stage of taken) expect(stage).toBeGreaterThan(FIELD_MAX_GROWTH);
  });

  it('leaves a tree standing until it is more than merely grown', () => {
    const sim = newGame();
    const cutter = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    const hut = sim.buildings.require(cutter);
    buildAndConnect(sim, BuildingType.Forester, null, hut.point);

    const taken = stagesAtHarvest(sim, hut.point, MapObject.Tree);
    expect(taken.length).toBeGreaterThan(0);
    for (const stage of taken) expect(stage).toBeGreaterThan(TREE_MAX_GROWTH);
  });
});

describe('what a building says when it has run out', () => {
  function lastExhaustedMessage(sim: Simulation): string | undefined {
    const said = sim.events.filter((message) => message.category === 'exhausted');
    return said[said.length - 1]?.text;
  }

  it('names stone at a quarry and trees at a woodcutter', () => {
    for (const [type, prefers, expected] of [
      [BuildingType.Quarry, MapObject.Stone, /stone/i],
      [BuildingType.Woodcutter, MapObject.Tree, /trees/i],
    ] as [BuildingType, MapObject, RegExp][]) {
      const sim = newGame();
      const id = buildAndConnect(sim, type, prefers)!;
      expect(id).toBeDefined();
      run(sim, 2000);

      // Take away everything it works, so it really has run out.
      const building = sim.buildings.require(id);
      for (const point of sim.world.grid.pointsWithin(building.point, 8)) {
        if (sim.world.object[point] === prefers) sim.world.object[point] = MapObject.None;
      }

      run(sim, 8000);

      const said = lastExhaustedMessage(sim);
      expect(said).toBeDefined();
      // A quarry announcing it has nothing left to *cut* was the woodcutter's
      // sentence, borrowed because both are "harvest" behaviours.
      expect(said).toMatch(expected);
    }
  });
});

describe('removing a building by its flag', () => {
  it('takes the building with it', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    const hut = sim.buildings.require(id);
    const flagPoint = hut.flagPoint;

    expect(sim.demolishFlag(PLAYER, flagPoint).ok).toBe(true);

    expect(sim.buildings.get(id)).toBeUndefined();
    expect(sim.world.building[hut.point]).toBe(0);
    expect(sim.world.flag[flagPoint]).toBe(0);
  });

  it('still refuses the headquarters', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    expect(sim.demolishFlag(PLAYER, hq.flagPoint).ok).toBe(false);
    expect(sim.buildings.get(hq.id)).toBeDefined();
  });
});

describe('room to build', () => {
  /** A patch of open ground well away from the headquarters. */
  function clearing(sim: Simulation): number {
    const hq = headquarters(sim);
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      if (sim.world.grid.distance(hq.point, point) < 5) continue;
      if (evaluateBuildSpace(sim.world, point, PLAYER) === BuildSpace.Castle) return point;
    }
    throw new Error('no clearing found');
  }

  function ring(sim: Simulation, centre: number, distance: number): number[] {
    return sim.world.grid
      .pointsWithin(centre, distance)
      .filter((point) => sim.world.grid.distance(centre, point) === distance);
  }

  /** A node in the given ring that is not the site's own doorstep. */
  function spotIn(sim: Simulation, centre: number, distance: number): number {
    const flagPoint = sim.world.grid.neighbour(centre, FLAG_DIRECTION);
    return ring(sim, centre, distance).find((point) => point !== flagPoint)!;
  }

  it('gives an open clearing room for the largest footprint', () => {
    const sim = newGame();
    expect(evaluateBuildSpace(sim.world, clearing(sim), PLAYER)).toBe(BuildSpace.Castle);
  });

  it('lets a tree in the first ring leave room for a hut only', () => {
    const sim = newGame();
    const point = clearing(sim);
    sim.world.object[spotIn(sim, point, 1)] = MapObject.Tree;

    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.Hut);
  });

  it('lets a tree in the second ring leave room for a house', () => {
    const sim = newGame();
    const point = clearing(sim);
    sim.world.object[spotIn(sim, point, 2)] = MapObject.Stone;

    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.House);
  });

  it('refuses everything but a flag beside another building', () => {
    const sim = newGame();
    const point = clearing(sim);
    sim.world.building[spotIn(sim, point, 1)] = 999;

    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.Flag);
  });

  it('shrinks to a hut for a building in the second ring', () => {
    const sim = newGame();
    const point = clearing(sim);
    sim.world.building[spotIn(sim, point, 2)] = 999;

    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.Hut);
  });

  it('shrinks to a house for a building in the third ring', () => {
    const sim = newGame();
    const point = clearing(sim);
    sim.world.building[spotIn(sim, point, 3)] = 999;

    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.House);
  });

  it('does not count the road running into its own doorstep', () => {
    const sim = newGame();
    const point = clearing(sim);
    const flagPoint = sim.world.grid.neighbour(point, FLAG_DIRECTION);

    // A road laid to the doorstep before building, which is the one road with
    // any business in the first ring.
    const along = ring(sim, point, 1).find((candidate) => {
      if (candidate === flagPoint) return false;
      return DIRECTIONS.some(
        (direction) => sim.world.grid.neighbour(candidate, direction) === flagPoint,
      );
    })!;
    const towards = DIRECTIONS.find(
      (direction) => sim.world.grid.neighbour(along, direction) === flagPoint,
    )!;
    sim.world.setRoad(along, towards, true);

    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.Castle);
  });

  it('will not put a hut in the room a real castle has claimed', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    expect(buildingInfo(hq.type).size).toBe(BuildingSize.Castle);

    // The headquarters is a castle: it wants three clear nodes about it, and it
    // wants them from whoever builds next as much as it wanted them itself.
    for (const point of ring(sim, hq.point, 2)) {
      expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBeLessThanOrEqual(BuildSpace.Flag);
      expect(sim.placeBuilding(PLAYER, point, BuildingType.Woodcutter).ok).toBe(false);
    }
    for (const point of ring(sim, hq.point, 3)) {
      expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBeLessThanOrEqual(BuildSpace.Flag);
    }

    // And four nodes out it stops mattering, or there would be nowhere to start.
    expect(
      ring(sim, hq.point, 4).some(
        (point) => evaluateBuildSpace(sim.world, point, PLAYER) >= BuildSpace.Hut,
      ),
    ).toBe(true);
  });

  it('counts a road that has nothing to do with it', () => {
    const sim = newGame();
    const point = clearing(sim);
    const flagPoint = sim.world.grid.neighbour(point, FLAG_DIRECTION);

    // A road crossing the first ring but not touching the doorstep.
    const across = ring(sim, point, 1).find((candidate) => {
      if (candidate === flagPoint) return false;
      return !DIRECTIONS.some(
        (direction) => sim.world.grid.neighbour(candidate, direction) === flagPoint,
      );
    })!;
    const away = DIRECTIONS.find((direction) => {
      const beyond = sim.world.grid.neighbour(across, direction);
      return beyond !== OUT_OF_BOUNDS && beyond !== flagPoint && beyond !== point;
    })!;
    sim.world.setRoad(across, away, true);

    expect(evaluateBuildSpace(sim.world, point, PLAYER)).toBe(BuildSpace.Hut);
  });
});

describe('one forester to one woodcutter', () => {
  it('keeps a woodcutter in work indefinitely', () => {
    const sim = newGame();
    const cutter = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    const hut = sim.buildings.require(cutter);
    buildAndConnect(sim, BuildingType.Forester, null, hut.point);

    run(sim, 8000);
    const early = sim.storedWare(PLAYER, Ware.Log) + sim.storedWare(PLAYER, Ware.Board);

    run(sim, 30000);
    const late = sim.storedWare(PLAYER, Ware.Log) + sim.storedWare(PLAYER, Ware.Board);

    // Still felling long after the natural trees would have gone.
    expect(late).toBeGreaterThan(early);
    expect(
      sim.world.grid
        .pointsWithin(hut.point, 6)
        .filter((point) => sim.world.object[point] === MapObject.Tree).length,
    ).toBeGreaterThan(0);
  });
});

describe('crates and a jammed flag', () => {
  /**
   * A ring of four flags — the headquarters and three more — so that every
   * crate has two ways home and a jam on one of them can be routed around.
   *
   * The three nodes are picked from seed 4242's map; each step asserts, so a
   * change in the terrain says which leg it broke rather than failing obscurely
   * somewhere in the middle of a run.
   */
  function ring(sim: Simulation) {
    const hq = headquarters(sim);
    const points = [2598, 2472, 2538];
    for (const point of points) expect(sim.placeFlag(PLAYER, point).ok).toBe(true);

    const legs: ReadonlyArray<readonly [number, number]> = [
      [hq.flagPoint, points[0]!],
      [points[0]!, points[1]!],
      [points[1]!, points[2]!],
      [points[2]!, hq.flagPoint],
    ];
    for (const [from, to] of legs) {
      const route = planRoad(sim.world, from, to, PLAYER);
      expect(route).toBeDefined();
      expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);
    }

    const flagAt = (point: number) => sim.flags.require(sim.world.flag[point]!);
    return {
      hq,
      home: flagAt(hq.flagPoint),
      // `near` and `far` are the two ways round from `out`, which sits opposite
      // the headquarters and so is two hops from home whichever way it goes.
      near: flagAt(points[0]!),
      out: flagAt(points[1]!),
      far: flagAt(points[2]!),
    };
  }

  /** Piles crates nobody is coming for onto a flag, up to `held`. */
  function queue(sim: Simulation, flag: Flag, held = FLAG_CAPACITY): void {
    while (flag.wares.length < held) flag.wares.push({ ware: Ware.Stone, destination: 0 });
    // Routing prices the queues once a tick; say so, rather than tick the whole
    // world just to have a flag counted.
    sim.network.invalidateTraffic();
  }

  const nextFlag = (sim: Simulation, from: number, parcel: { ware: Ware; destination: number }) =>
    (
      sim as unknown as {
        nextFlagFor(flagId: number, parcel: { ware: Ware; destination: number }): number | undefined;
      }
    ).nextFlagFor(from, parcel);

  it('sends a crate the long way round a flag that is full', () => {
    const sim = newGame();
    const { hq, near, out, far } = ring(sim);
    const parcel = { ware: Ware.Board, destination: hq.id };

    // With the road clear it takes the short way, as it always did.
    expect(nextFlag(sim, out.id, parcel)).toBe(near.id);

    queue(sim, near);
    expect(nextFlag(sim, out.id, parcel)).toBe(far.id);
  });

  it('steers round a queue before it has grown to a jam', () => {
    const sim = newGame();
    const { hq, near, out, far } = ring(sim);
    const parcel = { ware: Ware.Board, destination: hq.id };

    // Six of eight: room still, but goods are visibly piling up. Waiting for
    // the flag to fill outright had every crate join the queue and then the
    // whole stream swing across at once; a price that rises with the queue
    // moves them over as it grows.
    queue(sim, near, 6);
    expect(near.wares.length).toBeLessThan(FLAG_CAPACITY);
    expect(nextFlag(sim, out.id, parcel)).toBe(far.id);
  });

  it('keeps to the jammed way when there is no other', () => {
    const sim = newGame();
    const { hq, near, out, far } = ring(sim);
    const parcel = { ware: Ware.Board, destination: hq.id };

    queue(sim, near);
    queue(sim, far);

    // A queue makes a road dear, never impassable. Answering "nowhere" would
    // leave the crate on the producer's flag and stop him working, so however
    // the prices fall a crate must always still be given somewhere to go.
    expect([near.id, far.id]).toContain(nextFlag(sim, out.id, parcel));
  });

  it('never sends a crate back to a flag it has left', () => {
    // Every arrangement of queues the little ring can hold, including the ones
    // that make the two ways home cost the same. A crate must reach the store
    // in every one of them without passing a flag twice: that is the whole of
    // why it cannot be handed round in circles, and it is worth checking
    // against the prices rather than against the roads, because the prices are
    // what routing actually goes by.
    const held = [0, 4, 6, FLAG_CAPACITY];

    for (const onNear of held) {
      for (const onFar of held) {
        const sim = newGame();
        const { hq, near, out, far } = ring(sim);
        const parcel = { ware: Ware.Board, destination: hq.id };
        const home = sim.world.flag[hq.flagPoint]!;

        queue(sim, near, onNear);
        queue(sim, far, onFar);

        const remaining = sim.network.costsThroughTraffic(home);
        const seen = new Set<number>([out.id]);
        let at = out.id;

        for (let hop = 0; hop < 10 && at !== home; hop += 1) {
          const step = nextFlag(sim, at, parcel);
          expect(step).toBeDefined();
          expect(seen.has(step!)).toBe(false);
          expect(remaining.get(step!)!).toBeLessThan(remaining.get(at)!);
          seen.add(step!);
          at = step!;
        }

        expect(at).toBe(home);
      }
    }
  });

  it('carries a crate round the jam and into the store', () => {
    const sim = newGame();
    const { hq, near, out, far } = ring(sim);
    run(sim, 1500);

    out.wares.push({ ware: Ware.Board, destination: hq.id });
    const before = sim.storedWare(PLAYER, Ware.Board);

    let wentTheLongWay = false;
    let delivered = false;
    for (let i = 0; i < 1500 && !delivered; i += 1) {
      queue(sim, near);
      sim.update();
      if (far.wares.some((parcel) => parcel.ware === Ware.Board)) wentTheLongWay = true;
      delivered = sim.storedWare(PLAYER, Ware.Board) > before;
    }

    expect(delivered).toBe(true);
    expect(wentTheLongWay).toBe(true);
  });

  it('picks a crate up anyway and waits mid-road for a way in', () => {
    const sim = newGame();
    const { hq, near, out, far } = ring(sim);
    run(sim, 1500);

    out.wares.push({ ware: Ware.Board, destination: hq.id });

    // Both ways home are full and neither has anything to trade back, so there
    // is nothing for it but to wait — holding the crate, so that whoever made it
    // has his flag back and can carry on working.
    let holder: Settler | undefined;
    for (let i = 0; i < 400; i += 1) {
      queue(sim, near);
      queue(sim, far);
      sim.update();
      holder = sim.settlers.all().find((settler) => settler.carrying === Ware.Board) ?? holder;
      if (holder && holder.path.length === 0 && sim.stepFraction(holder) === 0.5) break;
    }

    expect(holder).toBeDefined();
    expect(holder!.carrying).toBe(Ware.Board);
    expect(out.wares.some((parcel) => parcel.ware === Ware.Board)).toBe(false);

    // He waits at his post, in the middle of his own stretch, rather than
    // crowding onto a flag that has no room for him.
    const road = sim.roads.require(holder!.road);
    expect(road.points.length % 2).toBe(0);
    const middle = road.points.length / 2;
    const ends = [holder!.point, holder!.toPoint].sort((a, b) => a - b);
    expect(ends).toEqual([road.points[middle - 1]!, road.points[middle]!].sort((a, b) => a - b));
    expect(sim.stepFraction(holder!)).toBe(0.5);

    // And the moment there is room he finishes the delivery.
    const before = sim.storedWare(PLAYER, Ware.Board);
    near.wares.length = 0;
    far.wares.length = 0;
    run(sim, 300);
    expect(sim.storedWare(PLAYER, Ware.Board)).toBeGreaterThan(before);
  });
});

describe('raising an army', () => {
  /** Every soldier a player has, wherever he happens to be. */
  function soldiers(sim: Simulation): number {
    let total = 0;
    sim.buildings.forEach((building) => {
      if (building.owner === PLAYER) total += garrisonStrength(building.garrison);
    });
    sim.settlers.forEach((settler) => {
      if (settler.owner === PLAYER && settler.profession === Profession.Soldier) total += 1;
    });
    return total;
  }

  /** Runs until a building is finished, and says whether it got there. */
  function finish(sim: Simulation, id: number, ticks = 3000): boolean {
    for (let i = 0; i < ticks; i += 1) {
      sim.update();
      if (sim.buildings.get(id)?.state === BuildingState.Complete) return true;
    }
    return false;
  }

  /** How many lattice points the player holds. */
  function territory(sim: Simulation): number {
    let total = 0;
    for (let point = 0; point < sim.world.owner.length; point += 1) {
      if (sim.world.owner[point] === PLAYER) total += 1;
    }
    return total;
  }

  /** Arms a store with the makings of `count` soldiers. */
  function supply(store: { stock: number[] }, count: number): void {
    store.stock[Ware.Sword] = count;
    store.stock[Ware.Shield] = count;
    store.stock[Ware.Beer] = count;
  }

  it('turns a sword, a shield and a beer into a private', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    hq.reserve = SETTLERS_KEPT_BACK + 4;
    supply(hq, 1);

    const before = garrisonStrength(hq.garrison);
    run(sim, 2);

    expect(garrisonStrength(hq.garrison)).toBe(before + 1);
    expect(hq.garrison[Rank.Private]).toBe(STARTING_GARRISON + 1);
    expect(hq.reserve).toBe(SETTLERS_KEPT_BACK + 3);
    // Exactly one of each, and no more: an armoury's output must not vanish.
    expect(hq.stock[Ware.Sword]).toBe(0);
    expect(hq.stock[Ware.Shield]).toBe(0);
    expect(hq.stock[Ware.Beer]).toBe(0);
  });

  it('trains nobody when any one of the three is missing', () => {
    for (const missing of [Ware.Sword, Ware.Shield, Ware.Beer]) {
      const sim = newGame();
      const hq = headquarters(sim);
      hq.reserve = SETTLERS_KEPT_BACK + 4;
      supply(hq, 3);
      hq.stock[missing] = 0;

      const before = garrisonStrength(hq.garrison);
      run(sim, 60);
      expect(garrisonStrength(hq.garrison)).toBe(before);
    }
  });

  it('will not train the workforce away', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    hq.reserve = SETTLERS_KEPT_BACK;
    supply(hq, 5);

    const before = garrisonStrength(hq.garrison);
    // Short of the interval at which the province takes in anybody new, so the
    // reserve is exactly what this test put there.
    run(sim, 100);

    expect(garrisonStrength(hq.garrison)).toBe(before);
    expect(hq.reserve).toBe(SETTLERS_KEPT_BACK);
    expect(hq.stock[Ware.Sword]).toBe(5);
  });

  it('claims no ground until a soldier is actually standing in it', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    // Nobody to send, so the barracks can be finished and left empty.
    hq.garrison.fill(0);

    const id = buildAndConnect(sim, BuildingType.Barracks)!;
    expect(id).toBeDefined();
    const barracks = sim.buildings.require(id);

    let built = false;
    for (let i = 0; i < 3000 && !built; i += 1) {
      sim.update();
      built = barracks.state === BuildingState.Complete;
    }
    expect(built).toBe(true);

    const held = territory(sim);
    run(sim, 400);

    // A hut with a flag on it, and no ground of its own.
    expect(garrisonStrength(barracks.garrison)).toBe(0);
    expect(barracks.status).toBe(BuildingStatus.Unmanned);
    expect(territory(sim)).toBe(held);

    // Now give him somebody, and the frontier moves.
    hq.garrison[Rank.Private] = 2;
    let manned = false;
    for (let i = 0; i < 600 && !manned; i += 1) {
      sim.update();
      manned = garrisonStrength(barracks.garrison) > 0;
    }

    expect(manned).toBe(true);
    expect(territory(sim)).toBeGreaterThan(held);
    expect(barracks.status).toBe(BuildingStatus.Working);
  });

  it('marches men out without making or losing any', () => {
    const sim = newGame();
    const before = soldiers(sim);
    expect(before).toBe(STARTING_GARRISON);

    const id = buildAndConnect(sim, BuildingType.Barracks)!;
    expect(id).toBeDefined();
    const barracks = sim.buildings.require(id);

    let counted = before;
    for (let i = 0; i < 3000; i += 1) {
      sim.update();
      counted = Math.min(counted, soldiers(sim));
      // No man is ever in two places, and none is quietly conjured up.
      expect(soldiers(sim)).toBe(before);
    }

    const wanted = buildingInfo(BuildingType.Barracks).behaviour;
    expect(wanted.kind).toBe('military');
    expect(garrisonStrength(barracks.garrison)).toBe(
      wanted.kind === 'military' ? wanted.garrison : 0,
    );
    // And having filled it, it stops asking.
    expect(barracks.garrisonRequested).toBe(0);
  });

  it('sends a demolished garrison home rather than burying it', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Barracks)!;
    const barracks = sim.buildings.require(id);

    let manned = false;
    for (let i = 0; i < 3000 && !manned; i += 1) {
      sim.update();
      manned = garrisonStrength(barracks.garrison) > 0;
    }
    expect(manned).toBe(true);

    const before = soldiers(sim);
    expect(sim.demolishBuilding(PLAYER, barracks.point).ok).toBe(true);
    expect(soldiers(sim)).toBe(before);

    run(sim, 600);
    expect(soldiers(sim)).toBe(before);
    expect(garrisonStrength(headquarters(sim).garrison)).toBeGreaterThan(0);
  });

  it('spends a coin on the man who needs it most', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Barracks)!;
    const barracks = sim.buildings.require(id);

    let manned = false;
    for (let i = 0; i < 3000 && !manned; i += 1) {
      sim.update();
      manned = garrisonStrength(barracks.garrison) > 0;
    }
    expect(manned).toBe(true);

    // A sergeant and a private: the coin belongs to the private.
    barracks.garrison.fill(0);
    barracks.garrison[Rank.Private] = 1;
    barracks.garrison[Rank.Sergeant] = 1;

    const flag = sim.flags.require(sim.world.flag[barracks.flagPoint]!);
    flag.wares.push({ ware: Ware.Coin, destination: barracks.id });
    run(sim, 2);

    expect(barracks.garrison[Rank.Private]).toBe(0);
    expect(barracks.garrison[Rank.PrivateFirstClass]).toBe(1);
    expect(barracks.garrison[Rank.Sergeant]).toBe(1);
    expect(flag.wares.some((parcel) => parcel.ware === Ware.Coin)).toBe(false);
  });

  it('stops asking for gold once there is nobody left to promote', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Barracks)!;
    expect(finish(sim, id)).toBe(true);
    const barracks = sim.buildings.require(id);

    barracks.garrison.fill(0);
    barracks.garrison[Rank.Officer] = 2;
    expect(outstandingDemand(barracks, Ware.Coin)).toBeGreaterThan(0);
    expect(willAccept(barracks, Ware.Coin)).toBe(true);

    barracks.garrison.fill(0);
    barracks.garrison[Rank.General] = 2;
    expect(outstandingDemand(barracks, Ware.Coin)).toBe(0);
    expect(willAccept(barracks, Ware.Coin)).toBe(false);

    // And gold is the only thing it ever wants.
    barracks.garrison[Rank.General] = 0;
    barracks.garrison[Rank.Private] = 2;
    expect(outstandingDemand(barracks, Ware.Board)).toBe(0);
    expect(willAccept(barracks, Ware.Bread)).toBe(false);
  });

  it('forges whichever of a sword and a shield is scarcer', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Armoury)!;
    expect(id).toBeDefined();
    expect(finish(sim, id)).toBe(true);

    const armoury = sim.buildings.require(id);
    const hq = headquarters(sim);

    // It needs a smith at the forge before it makes anything at all.
    let staffed = false;
    for (let i = 0; i < 2000 && !staffed; i += 1) {
      sim.update();
      staffed = armoury.worker !== 0;
    }
    expect(staffed).toBe(true);

    const forge = (swords: number, shields: number): Ware | null => {
      hq.stock[Ware.Sword] = swords;
      hq.stock[Ware.Shield] = shields;

      armoury.output = null;
      armoury.workTimer = 0;
      armoury.inputs.fill(INPUT_STOCK_LIMIT);

      for (let i = 0; i < 600 && armoury.output === null; i += 1) {
        sim.update();
        // Keep the inputs topped up: what is being tested is the choice, not
        // whether an iron chain happens to exist on this seed.
        if (armoury.output === null) armoury.inputs.fill(INPUT_STOCK_LIMIT);
      }
      return armoury.output;
    };

    // An armoury that only ever forged swords left half a barracks unarmed.
    expect(forge(5, 0)).toBe(Ware.Shield);
    expect(forge(0, 5)).toBe(Ware.Sword);
  });
});
