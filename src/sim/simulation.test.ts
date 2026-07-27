import { describe, expect, it } from 'vitest';
import { BuildingType, buildingInfo } from './data/buildings';
import { Profession } from './data/professions';
import { Ware } from './data/wares';
import { BuildingState, BuildingStatus, FLAG_CAPACITY, SettlerState } from './entities/types';
import { Simulation } from './simulation';
import { planRoad } from './transport/pathfinding';
import {
  BuildingSize,
  BuildSpace,
  canHostSize,
  canPlaceFlag,
  evaluateBuildSpace,
} from './world/buildspace';
import { FIELD_FULLY_GROWN, MapObject, Resource } from './world/terrain';

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
    expect(sim.hash()).toMatchInlineSnapshot(`"de241a8d"`);
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
    const id = buildAndConnect(sim, BuildingType.Well)!;
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
   * Places a farm on ground that can actually grow corn.
   *
   * A farm only sows within two nodes of itself, so it has to stand on meadow
   * to be any use at all — put one in the desert and it reports itself
   * exhausted, which is correct but makes for a poor test of farming.
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
        .filter((near) => sim.world.farmableSides(near) >= 4).length;
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
    const sim = newGame();
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
    const sim = newGame();
    const id = buildFarm(sim)!;
    run(sim, 12000);

    const farm = sim.buildings.require(id);
    for (const point of sim.world.grid.pointsWithin(farm.point, 6)) {
      if (sim.world.object[point] !== MapObject.Field) continue;
      // Every field must stand on ground a farmer could legally sow.
      expect(sim.world.isWalkable(point)).toBe(true);
    }
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
    // The headquarters stands on levelled ground with no mountain near it, so
    // a geologist sent from its own flag has only groundwater to look for.
    const sim = newGame();
    const hq = headquarters(sim);

    expect(sim.sendGeologist(PLAYER, hq.flagPoint).ok).toBe(true);
    run(sim, 4000);

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
