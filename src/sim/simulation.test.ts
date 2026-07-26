import { describe, expect, it } from 'vitest';
import { BuildingType, buildingInfo } from './data/buildings';
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
import { MapObject, Resource } from './world/terrain';

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
    // A tick is 150ms of real time at the normal pace, so a settler that only
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
