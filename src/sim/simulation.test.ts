import { describe, expect, it } from 'vitest';
import { BuildingType, buildingInfo } from './data/buildings';
import { DIRECTIONS } from './core/direction';
import { OUT_OF_BOUNDS } from './core/grid';
import { Profession } from './data/professions';
import { Ware } from './data/wares';
import type { Building, Flag, Settler } from './entities/types';
import { BuildingState, BuildingStatus, FLAG_CAPACITY, SettlerState } from './entities/types';
import { garrisonStrength, Rank } from './data/ranks';
import {
  EXHAUSTED_REPEAT_TICKS,
  EXHAUSTED_REPORT_TICKS,
  MINIMUM_GARRISON,
  SETTLERS_KEPT_BACK,
  Simulation,
  STARTING_GARRISON,
  TRAINING_TICKS,
} from './simulation';
import { INPUT_STOCK_LIMIT, outstandingDemand, willAccept } from './transport/dispatch';
import { planRoad } from './transport/pathfinding';
import {
  BuildingSize,
  BuildSpace,
  canHostSize,
  canPlaceFlag,
  canPlaceOutpost,
  evaluateBuildSpace,
  FLAG_DIRECTION,
  isWellInsideTerritory,
  OUTPOST_SPACING,
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
    // Doubled since the map became a mirror of itself: half of a 128-wide
    // island is the 64-wide one these tests were written against.
    width: 128,
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
    // Posts keep their distance from one another and from the hall, so a site
    // the game would refuse is no site at all.
    if (info.behaviour.kind === 'military' && !canPlaceOutpost(sim.world, point, PLAYER)) {
      continue;
    }

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
/**
 * A site out at the edge of the hall's own claim.
 *
 * A post well inside a province takes no new ground — the hall already holds
 * it — so anything testing a *claim* has to stand at the frontier, where there
 * is unowned ground within reach to take.
 */
function edgeSite(sim: Simulation, type: BuildingType): number | undefined {
  const hq = headquarters(sim);
  const info = buildingInfo(type);

  for (const point of [...sim.world.grid.pointsWithin(hq.point, 13)].reverse()) {
    const space = evaluateBuildSpace(sim.world, point, PLAYER);
    if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
    return point;
  }
  return undefined;
}

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
    // Posts keep their distance from one another and from the hall, so a site
    // the game would refuse is no site at all.
    if (info.behaviour.kind === 'military' && !canPlaceOutpost(sim.world, point, PLAYER)) {
      continue;
    }

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
    // Re-recorded twice: when the map was doubled and mirrored, and again when
    // the hall began stocking bread and meat for the mines. Both times the hash
    // moved because the world it starts from moved, which is the change landing
    // rather than a rule slipping. There is no mine in these thousand ticks.
    expect(sim.hash()).toMatchInlineSnapshot(`"fa4fcb90"`);
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
    // Out at the edge of the hall's own claim: a post well inside it takes
    // nothing new, so a site near the door would prove nothing about claiming.
    const site = edgeSite(sim, BuildingType.Guardhouse)!;
    expect(site).toBeDefined();
    expect(sim.placeBuilding(PLAYER, site, BuildingType.Guardhouse).ok).toBe(true);
    const id = sim.buildings.find((candidate) => candidate.point === site)!.id;
    const route = planRoad(sim.world, headquarters(sim).flagPoint, sim.buildings.require(id).flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);

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
  it('says a building has run out again and again, but not every tick', () => {
    const sim = newGame();
    const id = buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree)!;
    run(sim, 3000);

    // Take every tree away, so there is nothing left to cut.
    const hut = sim.buildings.require(id);
    for (const point of sim.world.grid.pointsWithin(hut.point, 8)) {
      if (sim.world.object[point] === MapObject.Tree) sim.world.object[point] = MapObject.None;
    }

    run(sim, 6000);

    // Said once when it really stops, then every five minutes it stays that
    // way — a notice that scrolls out of the ticker and never returns leaves a
    // hut standing idle for the rest of the game with nothing to say so.
    const exhausted = sim.events.filter((message) => message.category === 'exhausted');
    expect(exhausted.length).toBeGreaterThan(1);
    expect(exhausted.length).toBeLessThanOrEqual(1 + Math.ceil(6000 / EXHAUSTED_REPEAT_TICKS));
    expect(exhausted[0]!.point).toBe(hut.point);

    // Spaced out, not in a burst.
    for (let i = 1; i < exhausted.length; i += 1) {
      expect(exhausted[i]!.tick - exhausted[i - 1]!.tick).toBe(EXHAUSTED_REPEAT_TICKS);
    }
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

describe('what a mine eats', () => {
  /**
   * A working mine of a given kind, sunk on a seam of its own ore.
   *
   * Reached in rather than built: the ranges are raised a dozen nodes beyond
   * the hall's own claim, so a mine needs a frontier post and a road to it
   * before a builder will ever walk out, and none of that is what these tests
   * are about.
   */
  function mineOf(sim: Simulation, type: BuildingType): Building {
    const { grid } = sim.world;
    const hq = headquarters(sim);
    const behaviour = buildingInfo(type).behaviour;
    if (behaviour.kind !== 'extract') throw new Error('not a mine');

    for (const point of grid.pointsWithin(hq.point, 30)) {
      if (sim.world.resource[point] !== behaviour.resource) continue;
      for (const near of grid.pointsWithin(point, 2)) sim.world.owner[near] = PLAYER;

      const mine = reachIn(sim).createBuilding(type, point, PLAYER);
      if (!mine) continue;
      mine.state = BuildingState.Complete;
      mine.status = BuildingStatus.Working;
      return mine;
    }
    throw new Error(`nowhere to sink a ${buildingInfo(type).name}`);
  }

  interface Innards {
    createBuilding(type: BuildingType, point: number, owner: number): Building | undefined;
  }

  function reachIn(sim: Simulation): Innards {
    return sim as unknown as Innards;
  }

  const DIETS: readonly { type: BuildingType; eats: Ware }[] = [
    { type: BuildingType.CoalMine, eats: Ware.Bread },
    { type: BuildingType.IronMine, eats: Ware.Meat },
    { type: BuildingType.GoldMine, eats: Ware.Fish },
    { type: BuildingType.GraniteMine, eats: Ware.Fish },
  ];

  const FOODS: readonly Ware[] = [Ware.Bread, Ware.Fish, Ware.Meat];

  it('takes in its own food and turns the rest away', () => {
    const sim = newGame();

    for (const { type, eats } of DIETS) {
      const mine = mineOf(sim, type);

      for (const food of FOODS) {
        const wanted = food === eats;
        expect([buildingInfo(type).name, food, willAccept(mine, food)]).toEqual([
          buildingInfo(type).name,
          food,
          wanted,
        ]);
        expect(outstandingDemand(mine, food) > 0).toBe(wanted);
      }

      // And nothing else at all: a mine is not a warehouse.
      expect(willAccept(mine, Ware.Board)).toBe(false);
      expect(willAccept(mine, Ware.Coal)).toBe(false);
    }
  });

  it('stops asking once its four are in, whatever else is going spare', () => {
    const sim = newGame();
    const mine = mineOf(sim, BuildingType.CoalMine);

    expect(outstandingDemand(mine, Ware.Bread)).toBe(INPUT_STOCK_LIMIT);
    mine.inputs[0] = INPUT_STOCK_LIMIT;
    expect(outstandingDemand(mine, Ware.Bread)).toBe(0);
    expect(willAccept(mine, Ware.Bread)).toBe(false);
  });

  /**
   * The diet is a rule about the mine, not merely about the routing: food of
   * the wrong kind put straight into a mine's own hands still leaves it idle.
   */
  it('will not work on another mine’s food', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    // Fish and meat in the province, and not a loaf anywhere.
    hq.stock[Ware.Bread] = 0;
    hq.stock[Ware.Fish] = 20;
    hq.stock[Ware.Meat] = 20;

    const coal = mineOf(sim, BuildingType.CoalMine);
    const route = planRoad(sim.world, hq.flagPoint, coal.flagPoint, PLAYER);
    expect(route).toBeDefined();
    expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);

    run(sim, 4000);
    expect(sim.storedWare(PLAYER, Ware.Coal)).toBe(0);
    expect(coal.inputs[0] ?? 0).toBe(0);

    // A loaf, and only then does the seam come up.
    hq.stock[Ware.Bread] = 20;
    run(sim, 6000);
    expect(sim.storedWare(PLAYER, Ware.Coal)).toBeGreaterThan(0);
  });

  /**
   * Fish is the one food two trades still ask for, so it is the one place the
   * sharing rule in `chooseDestination` still has work to do among the mines.
   */
  it('splits the catch between a gold mine and a granite mine', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    const gold = mineOf(sim, BuildingType.GoldMine);
    const granite = mineOf(sim, BuildingType.GraniteMine);
    for (const mine of [gold, granite]) {
      const route = planRoad(sim.world, hq.flagPoint, mine.flagPoint, PLAYER);
      expect(route).toBeDefined();
      expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);
    }

    // No worker will reach either, so nothing is eaten and what each was sent
    // is still sitting in it at the end.
    hq.stock[Ware.Fish] = 40;
    gold.status = BuildingStatus.AwaitingWorker;
    granite.status = BuildingStatus.AwaitingWorker;

    let goldFed = 0;
    let graniteFed = 0;
    for (let i = 0; i < 8000; i += 1) {
      sim.update();
      goldFed = Math.max(goldFed, gold.inputs[0] ?? 0);
      graniteFed = Math.max(graniteFed, granite.inputs[0] ?? 0);
    }

    expect(goldFed).toBeGreaterThan(0);
    expect(graniteFed).toBeGreaterThan(0);
  });

  it('sends the bread past a granite mine to the coal mine behind it', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    const granite = mineOf(sim, BuildingType.GraniteMine);
    const coal = mineOf(sim, BuildingType.CoalMine);
    for (const mine of [granite, coal]) {
      const route = planRoad(sim.world, hq.flagPoint, mine.flagPoint, PLAYER);
      expect(route).toBeDefined();
      expect(sim.placeRoad(PLAYER, route!).ok).toBe(true);
    }

    hq.stock[Ware.Bread] = 40;
    hq.stock[Ware.Fish] = 0;
    granite.status = BuildingStatus.AwaitingWorker;
    coal.status = BuildingStatus.AwaitingWorker;

    let graniteFed = 0;
    let coalFed = 0;
    for (let i = 0; i < 8000; i += 1) {
      sim.update();
      graniteFed = Math.max(graniteFed, granite.inputs[0] ?? 0);
      coalFed = Math.max(coalFed, coal.inputs[0] ?? 0);
    }

    // However the two lie, a loaf is a coal miner's and nobody else's.
    expect(coalFed).toBeGreaterThan(0);
    expect(graniteFed).toBe(0);
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

    for (const point of sim.world.grid.pointsWithin(hq.point, 15)) {
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
  it('waits until it has really stopped before saying anything', () => {
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

    // Just past the first announcement and well short of the repeat.
    run(sim, EXHAUSTED_REPORT_TICKS + 100);
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

      // Somewhere a flag can genuinely go: not under his feet, not the node he
      // is walking into, and not crowding a flag that is already there.
      const spot = road.points.find(
        (point) =>
          point !== carrier!.point &&
          point !== carrier!.toPoint &&
          canPlaceFlag(sim.world, point, PLAYER),
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
   * The three nodes used to be written down as indices off seed 4242's island,
   * which stopped meaning anything the moment the map was doubled — an index is
   * a row times a width. They are found on the ground now instead: the first
   * three nodes out from the hall that will take a flag and stand clear of one
   * another. Each step still asserts, so a change in the terrain says which leg
   * it broke rather than failing obscurely in the middle of a run.
   */
  function ring(sim: Simulation) {
    const hq = headquarters(sim);
    const { grid } = sim.world;

    const points: number[] = [];
    for (const point of grid.pointsWithin(hq.flagPoint, 6)) {
      if (points.length >= 3) break;
      if (grid.distance(hq.flagPoint, point) < 3) continue;
      if (points.some((taken) => grid.distance(taken, point) < 3)) continue;
      if (!sim.placeFlag(PLAYER, point).ok) continue;
      points.push(point);
    }
    expect(points).toHaveLength(3);

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
    // Comfortably over the cap the province supports, so no settler arrives
    // part way through and quietly refills the reserve under the assertions.
    hq.reserve = 40;
    supply(hq, 1);

    const before = garrisonStrength(hq.garrison);

    // Not on the next tick: a man takes half a minute to train.
    run(sim, TRAINING_TICKS - 1);
    expect(garrisonStrength(hq.garrison)).toBe(before);

    run(sim, 1);
    expect(garrisonStrength(hq.garrison)).toBe(before + 1);
    expect(hq.garrison[Rank.Private]).toBe(STARTING_GARRISON + 1);
    expect(hq.reserve).toBe(39);
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

    // Nobody to send, so the barracks can be finished and left empty. Out at
    // the frontier, where there is unowned ground for it to take once it is
    // manned — inside the hall's own claim it would take nothing either way.
    hq.garrison.fill(0);

    const site = edgeSite(sim, BuildingType.Barracks)!;
    expect(site).toBeDefined();
    expect(sim.placeBuilding(PLAYER, site, BuildingType.Barracks).ok).toBe(true);
    const barracks = sim.buildings.find((candidate) => candidate.point === site)!;
    const route = planRoad(sim.world, hq.flagPoint, barracks.flagPoint, PLAYER);
    if (route) sim.placeRoad(PLAYER, route);

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

    // Inland, and so held by the fewest men the rule allows rather than by
    // everybody it has room for.
    expect(garrisonStrength(barracks.garrison)).toBe(MINIMUM_GARRISON);
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

describe('how hard an outpost is held', () => {
  /** Runs until a building is finished. */
  function finish(sim: Simulation, id: number, ticks = 3000): boolean {
    for (let i = 0; i < ticks; i += 1) {
      sim.update();
      if (sim.buildings.get(id)?.state === BuildingState.Complete) return true;
    }
    return false;
  }

  function manned(sim: Simulation, id: number, ticks = 3000): number {
    for (let i = 0; i < ticks; i += 1) sim.update();
    return garrisonStrength(sim.buildings.require(id).garrison);
  }

  it('sends the weakest man to quiet country', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    // Emptied before it is built, or one of the opening privates is already on
    // the march by the time there is a choice to make — and the test would
    // pass whichever man the rule picked.
    hq.garrison.fill(0);

    const id = buildAndConnect(sim, BuildingType.Barracks)!;
    expect(finish(sim, id)).toBe(true);
    expect(garrisonStrength(sim.buildings.require(id).garrison)).toBe(0);

    // A general and a private to choose from. Promotions are bought with gold
    // to be spent where they matter, not to garrison an empty hillside.
    hq.garrison[Rank.Private] = 1;
    hq.garrison[Rank.General] = 1;

    const barracks = sim.buildings.require(id);
    for (let i = 0; i < 1200 && garrisonStrength(barracks.garrison) === 0; i += 1) sim.update();

    expect(garrisonStrength(barracks.garrison)).toBe(MINIMUM_GARRISON);
    expect(barracks.garrison[Rank.Private]).toBe(1);
    expect(barracks.garrison[Rank.General]).toBe(0);
    // And the general is still in the store, where he is of some use.
    expect(hq.garrison[Rank.General]).toBe(1);
  });

  it('turns out in force, and sends the best, where it faces somebody', () => {
    const sim = newGame();
    const hq = headquarters(sim);

    // Nobody to send while it is going up, so no weak man is posted before the
    // border is there to be noticed.
    hq.garrison.fill(0);

    const id = buildAndConnect(sim, BuildingType.Barracks)!;
    expect(finish(sim, id)).toBe(true);
    const barracks = sim.buildings.require(id);

    const full = buildingInfo(BuildingType.Barracks).behaviour;
    expect(full.kind).toBe('military');
    const places = full.kind === 'military' ? full.garrison : 0;
    expect(places).toBeGreaterThan(MINIMUM_GARRISON);

    // A rival's ground inside its reach. There is no second player to build
    // one yet, so the frontier is painted onto the map directly.
    const radius = full.kind === 'military' ? full.radius : 0;
    let painted = 0;
    for (const point of sim.world.grid.pointsWithin(barracks.point, radius)) {
      if (sim.world.grid.distance(barracks.point, point) < radius) continue;
      sim.world.owner[point] = 2;
      painted += 1;
      if (painted >= 3) break;
    }
    expect(painted).toBeGreaterThan(0);

    // The frontier is surveyed on the sweep beat rather than every tick, so
    // give it a sweep to notice before anybody is available to march.
    run(sim, 80);

    hq.garrison[Rank.Private] = 4;
    hq.garrison[Rank.Officer] = 4;

    expect(manned(sim, id)).toBe(places);
    // The best men available, since this is where they are worth having.
    expect(barracks.garrison[Rank.Officer]).toBe(places);
    expect(barracks.garrison[Rank.Private]).toBe(0);
  });
});

describe('the door of a store', () => {
  /**
   * Men the store is sending out, caught on the step between door and flag.
   *
   * A road carrier who walked in with a crate and is making his own way back to
   * his post is passing through rather than being dispatched, and the gate does
   * not govern him; `WalkingToJob` is everybody sent out to a job, and
   * `DeliveringToFlag` is the porter carrying goods out.
   */
  function onTheStep(sim: Simulation): number {
    let count = 0;
    for (const settler of sim.settlers.all()) {
      if (settler.fromPoint === settler.toPoint) continue;
      if (
        settler.state !== SettlerState.WalkingToJob &&
        settler.state !== SettlerState.DeliveringToFlag
      ) {
        continue;
      }

      const buildingId = sim.world.building[settler.fromPoint];
      if (!buildingId) continue;
      const store = sim.buildings.get(buildingId);
      if (!store) continue;
      // Stores only. A worker stepping out of his own woodcutter's hut is not
      // using anybody's doorway.
      const kind = buildingInfo(store.type).behaviour.kind;
      if (kind !== 'headquarters' && kind !== 'store') continue;
      if (settler.toPoint === store.flagPoint) count += 1;
    }
    return count;
  }

  it('lets one man out at a time, porters and workers alike', () => {
    const sim = newGame();

    // A busy opening: several buildings wanting workers and a store wanting to
    // send their materials, all at once.
    for (const type of [
      BuildingType.Woodcutter,
      BuildingType.Forester,
      BuildingType.Quarry,
      BuildingType.Sawmill,
    ]) {
      buildAndConnect(sim, type, type === BuildingType.Woodcutter ? MapObject.Tree : null);
    }

    let worst = 0;
    let sawSomebody = false;
    for (let i = 0; i < 4000; i += 1) {
      sim.update();
      const step = onTheStep(sim);
      if (step > 0) sawSomebody = true;
      worst = Math.max(worst, step);
    }

    // Six men appearing on the flag in one tick was a conjuring trick, not a
    // settlement.
    expect(sawSomebody).toBe(true);
    expect(worst).toBe(1);
  });

  it('sends a porter out for what is waiting on its own doorstep, one crate at a time', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const flag = sim.flags.require(sim.world.flag[hq.flagPoint]!);

    // Six crates standing at the hall's own flag, bound for the hall — which is
    // where a building site the player pulls down leaves its materials.
    const CRATES = 6;
    const before = sim.storedWare(PLAYER, Ware.Board);
    for (let i = 0; i < CRATES; i += 1) {
      flag.wares.push({ ware: Ware.Board, destination: hq.id });
    }

    // Nothing crosses the doorstep in a single tick, and nothing crosses it
    // without a man carrying it.
    let biggestJump = 0;
    let held = sim.storedWare(PLAYER, Ware.Board);
    let carried = 0;
    for (let tick = 0; tick < 2000 && flag.wares.length > 0; tick += 1) {
      sim.update();
      const now = sim.storedWare(PLAYER, Ware.Board);
      biggestJump = Math.max(biggestJump, now - held);
      held = now;
      carried = Math.max(
        carried,
        sim.settlers.all().filter((settler) => settler.carrying === Ware.Board).length,
      );
      expect(onTheStep(sim)).toBeLessThanOrEqual(1);
    }

    // The last of them is still in the porter's hands when the flag empties.
    for (let tick = 0; tick < 60; tick += 1) {
      sim.update();
      const now = sim.storedWare(PLAYER, Ware.Board);
      biggestJump = Math.max(biggestJump, now - held);
      held = now;
    }

    expect(flag.wares.length).toBe(0);
    expect(sim.storedWare(PLAYER, Ware.Board)).toBe(before + CRATES);
    expect(biggestJump).toBe(1);
    expect(carried).toBeGreaterThan(0);
  });

  it('makes the porter fetching a crate queue at the door like everybody else', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const flag = sim.flags.require(sim.world.flag[hq.flagPoint]!);

    // Crates waiting to come in, and buildings wanting men to go out: the two
    // directions competing for one doorway.
    for (const type of [
      BuildingType.Woodcutter,
      BuildingType.Forester,
      BuildingType.Quarry,
      BuildingType.Sawmill,
    ]) {
      buildAndConnect(sim, type, type === BuildingType.Woodcutter ? MapObject.Tree : null);
    }

    let worst = 0;
    let sawSomebody = false;
    for (let i = 0; i < 3000; i += 1) {
      // Kept topped up, so the hall is fetching for the whole run rather than
      // for the first few seconds of it.
      if (flag.wares.length < FLAG_CAPACITY) {
        flag.wares.push({ ware: Ware.Board, destination: hq.id });
      }
      sim.update();
      const step = onTheStep(sim);
      if (step > 0) sawSomebody = true;
      worst = Math.max(worst, step);
    }

    expect(sawSomebody).toBe(true);
    expect(worst).toBe(1);
  });

  it('is not held by a man walking back in', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    buildAndConnect(sim, BuildingType.Woodcutter, MapObject.Tree);
    run(sim, 1500);

    // Somebody stepping from the flag towards the door: the way back in.
    const inbound = sim.settlers
      .all()
      .find((settler) => settler.fromPoint === hq.flagPoint && settler.toPoint === hq.point);

    // Whether or not one happens to be caught this instant, what matters is
    // that inbound traffic is not what the gate is reading.
    if (inbound) {
      const before = sim.storedWare(PLAYER, Ware.Log);
      run(sim, 600);
      expect(sim.storedWare(PLAYER, Ware.Log)).toBeGreaterThanOrEqual(before);
    }

    // The store goes on dispatching over a long run rather than seizing up.
    const logs = sim.storedWare(PLAYER, Ware.Log);
    run(sim, 3000);
    expect(sim.storedWare(PLAYER, Ware.Log)).toBeGreaterThan(logs);
  });
});

describe('which store supplies a site', () => {
  /**
   * A game with a storehouse as far from the headquarters as the province
   * allows, both stocked, and finished.
   */
  function withAStorehouse(sim: Simulation): { store: Building; hq: Building } {
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Storehouse);

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
    expect(sim.placeBuilding(PLAYER, far!, BuildingType.Storehouse).ok).toBe(true);

    const store = sim.buildings.find((building) => building.point === far)!;
    expect(
      sim.placeRoad(PLAYER, planRoad(sim.world, hq.flagPoint, store.flagPoint, PLAYER)!).ok,
    ).toBe(true);

    for (let i = 0; i < 6000 && store.state !== BuildingState.Complete; i += 1) sim.update();
    expect(store.state).toBe(BuildingState.Complete);

    store.stock[Ware.Board] = 20;
    store.stock[Ware.Stone] = 20;
    hq.stock[Ware.Board] = 20;
    hq.stock[Ware.Stone] = 20;
    return { store, hq };
  }

  it('takes the boards from the nearer store', () => {
    const sim = newGame();
    const { store, hq } = withAStorehouse(sim);
    const info = buildingInfo(BuildingType.Sawmill);

    // A site hard by the headquarters and well away from the storehouse.
    let site: number | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const point of sim.world.grid.pointsWithin(hq.point, 9)) {
      const toHq = sim.world.grid.distance(hq.point, point);
      if (toHq < 3 || toHq >= nearest) continue;
      if (sim.world.grid.distance(store.point, point) <= toHq + 2) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      nearest = toHq;
      site = point;
    }
    expect(site).toBeDefined();
    expect(sim.placeBuilding(PLAYER, site!, BuildingType.Sawmill).ok).toBe(true);
    const building = sim.buildings.find((candidate) => candidate.point === site)!;
    expect(
      sim.placeRoad(PLAYER, planRoad(sim.world, hq.flagPoint, building.flagPoint, PLAYER)!).ok,
    ).toBe(true);

    const storeBefore = store.stock[Ware.Board]!;
    for (let i = 0; i < 4000 && building.state !== BuildingState.Complete; i += 1) sim.update();

    // Every board came from the near store. The far one used to send some of
    // them, because the busy headquarters kept standing down on its own full
    // flag and the quiet storehouse got in first.
    expect(store.stock[Ware.Board]).toBe(storeBefore);
    expect(hq.stock[Ware.Board]).toBeLessThan(20);
  });

  it('turns back a crate that set out from the wrong store', () => {
    const sim = newGame();
    const { store, hq } = withAStorehouse(sim);

    // A crate from the far storehouse, waiting on its own doorstep, bound for
    // a site the headquarters could serve far more cheaply.
    const info = buildingInfo(BuildingType.Sawmill);
    let site: number | undefined;
    for (const point of sim.world.grid.pointsWithin(hq.point, 4)) {
      if (sim.world.grid.distance(hq.point, point) < 3) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      site = point;
      break;
    }
    expect(site).toBeDefined();
    expect(sim.placeBuilding(PLAYER, site!, BuildingType.Sawmill).ok).toBe(true);
    const building = sim.buildings.find((candidate) => candidate.point === site)!;
    expect(
      sim.placeRoad(PLAYER, planRoad(sim.world, hq.flagPoint, building.flagPoint, PLAYER)!).ok,
    ).toBe(true);
    run(sim, 40);

    const wrong = sim.flags.require(sim.world.flag[store.flagPoint]!);
    wrong.wares.push({ ware: Ware.Board, destination: building.id });
    const parcel = wrong.wares[wrong.wares.length - 1]!;

    // The sweep itself, rather than a tick that happens to contain one: within
    // a tick the carriers move first, so left to the clock one of them collects
    // the crate before the sweep can look at the flag — which proves nothing
    // either way about the rule under test.
    (sim as unknown as { turnBackDistantSupply(): void }).turnBackDistantSupply();

    // Back into the storehouse rather than walking the length of the province.
    expect(parcel.destination).toBe(store.id);
  });
});

describe('a settler with no roads left to walk', () => {
  it('goes to the store he is nearest, not the oldest one', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const info = buildingInfo(BuildingType.Storehouse);

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
    expect(sim.placeBuilding(PLAYER, far!, BuildingType.Storehouse).ok).toBe(true);
    const store = sim.buildings.find((building) => building.point === far)!;
    expect(
      sim.placeRoad(PLAYER, planRoad(sim.world, hq.flagPoint, store.flagPoint, PLAYER)!).ok,
    ).toBe(true);
    for (let i = 0; i < 6000 && store.state !== BuildingState.Complete; i += 1) sim.update();
    expect(store.state).toBe(BuildingState.Complete);

    // A hut hard beside the storehouse, staffed, and connected only to it.
    let hutPoint: number | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    const hutInfo = buildingInfo(BuildingType.Woodcutter);
    for (const point of sim.world.grid.pointsWithin(store.point, 6)) {
      const distance = sim.world.grid.distance(store.point, point);
      if (distance < 2 || distance >= nearest) continue;
      if (sim.world.grid.distance(hq.point, point) <= distance + 2) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, hutInfo.size)) continue;
      nearest = distance;
      hutPoint = point;
    }
    expect(hutPoint).toBeDefined();
    expect(sim.placeBuilding(PLAYER, hutPoint!, BuildingType.Woodcutter).ok).toBe(true);
    const hut = sim.buildings.find((building) => building.point === hutPoint)!;
    expect(
      sim.placeRoad(PLAYER, planRoad(sim.world, store.flagPoint, hut.flagPoint, PLAYER)!).ok,
    ).toBe(true);

    let man: Settler | undefined;
    for (let i = 0; i < 8000 && !man; i += 1) {
      sim.update();
      const candidate = hut.worker ? sim.settlers.get(hut.worker) : undefined;
      if (candidate && candidate.building === hut.id && candidate.state === SettlerState.AtWork) {
        man = candidate;
      }
    }
    expect(man).toBeDefined();

    // Tear up every road, so no store can be reached along one and the choice
    // falls back on the ground he will actually be crossing.
    for (const road of sim.roads.all()) sim.demolishRoad(PLAYER, road.points[1]!);
    expect(sim.demolishBuilding(PLAYER, hut.point).ok).toBe(true);

    // He is beside the storehouse. Walking to the headquarters — merely the
    // oldest building he owns — was most of the way across the province.
    expect(man!.building).toBe(store.id);
  });
});

describe('outposts keeping their distance', () => {
  /** A point that will take a building of this size, `away` nodes from `from`. */
  function siteAt(
    sim: Simulation,
    from: number,
    away: number,
    type: BuildingType,
  ): number | undefined {
    const info = buildingInfo(type);
    for (const point of sim.world.grid.pointsWithin(from, away)) {
      if (sim.world.grid.distance(from, point) !== away) continue;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, info.size)) continue;
      return point;
    }
    return undefined;
  }

  /** Plants an outpost well clear of the headquarters and hands back its point. */
  function firstOutpost(sim: Simulation, type: BuildingType = BuildingType.Barracks): number {
    const hq = headquarters(sim);
    const point = siteAt(sim, hq.point, 6, type);
    expect(point).toBeDefined();
    expect(sim.placeBuilding(PLAYER, point!, type).ok).toBe(true);
    return point!;
  }

  it('refuses a second outpost within four nodes and allows one at five', () => {
    for (const type of [BuildingType.Barracks, BuildingType.Fortress]) {
      const sim = newGame();
      const first = firstOutpost(sim, type);

      // Four away is inside the exclusion range, five is clear of it. The rule
      // is about outposts, not about footprints, so it must bite the same for a
      // barracks as for a fortress.
      for (let away = 1; away <= OUTPOST_SPACING; away += 1) {
        const near = siteAt(sim, first, away, type);
        if (near === undefined) continue;
        const refused = sim.placeBuilding(PLAYER, near, type);
        expect(refused.ok).toBe(false);
        expect(refused.ok === false && refused.reason).toContain('clear of your other outposts');
      }

      const far = siteAt(sim, first, OUTPOST_SPACING + 1, type);
      expect(far).toBeDefined();
      expect(sim.placeBuilding(PLAYER, far!, type).ok).toBe(true);
    }
  });

  it('leaves ordinary buildings out of it, both ways', () => {
    const sim = newGame();
    const first = firstOutpost(sim);

    // A hut may stand beside an outpost.
    const beside = siteAt(sim, first, 2, BuildingType.Woodcutter);
    expect(beside).toBeDefined();
    expect(sim.placeBuilding(PLAYER, beside!, BuildingType.Woodcutter).ok).toBe(true);

    // And a hut does not hold an outpost back — only the outpost five nodes off
    // does, so a barracks placed clear of it goes up regardless of the hut.
    const clear = siteAt(sim, first, OUTPOST_SPACING + 1, BuildingType.Barracks);
    expect(clear).toBeDefined();
    expect(sim.placeBuilding(PLAYER, clear!, BuildingType.Barracks).ok).toBe(true);
  });

  it('is not held back by somebody else’s outpost', () => {
    const sim = newGame();
    const hq = headquarters(sim);
    const point = siteAt(sim, hq.point, 6, BuildingType.Barracks);
    expect(point).toBeDefined();

    // A rival's post right beside it. Pushing up against theirs is how ground
    // is contested, so it must not be what stops you.
    for (const near of sim.world.grid.pointsWithin(point!, 2)) {
      if (sim.world.grid.distance(point!, near) === 2) {
        sim.world.outpost[near] = PLAYER + 1;
        break;
      }
    }

    expect(sim.placeBuilding(PLAYER, point!, BuildingType.Barracks).ok).toBe(true);
  });

  it('frees the ground again when the outpost comes down', () => {
    const sim = newGame();
    const first = firstOutpost(sim);

    const near = siteAt(sim, first, 2, BuildingType.Barracks);
    expect(near).toBeDefined();
    expect(sim.placeBuilding(PLAYER, near!, BuildingType.Barracks).ok).toBe(false);

    // Not merely written but cleared: an outpost that has been pulled down must
    // stop reserving the ground around it.
    expect(sim.demolishBuilding(PLAYER, first).ok).toBe(true);
    expect(sim.placeBuilding(PLAYER, near!, BuildingType.Barracks).ok).toBe(true);
  });

  it('still holds after a save has been loaded', () => {
    const sim = newGame();
    const first = firstOutpost(sim);
    const near = siteAt(sim, first, 2, BuildingType.Barracks);
    expect(near).toBeDefined();

    // The map of outposts is derived and never saved, so this is what checks it
    // is rebuilt from the buildings on the way in.
    const restored = Simulation.fromSnapshot(sim.toSnapshot());
    expect(restored.placeBuilding(PLAYER, near!, BuildingType.Barracks).ok).toBe(false);
  });
});

describe('a war', () => {
  const RIVAL = 2;

  /** How far a headquarters holds ground: a fortress's reach. */
  const HALL_REACH = 13;

  /**
   * The simulation's private workings, for setting up a battle.
   *
   * These tests stage fights that a real game reaches only after an hour of
   * play — a manned outpost on a contested border, a single blow with known
   * ranks. Reaching in beats widening the game's own surface with methods that
   * exist for nobody but the tests.
   */
  interface Claim {
    readonly building: number;
    readonly point: number;
    readonly radius: number;
    readonly mannedAt: number;
    readonly player: number;
  }

  interface Innards {
    createBuilding(type: BuildingType, point: number, owner: number): Building | undefined;
    exchangeBlows(target: Building, attacker: Settler, defender: Settler): void;
    joinGarrison(settler: Settler): void;
    pathOutOf(building: Building, to: number): number[] | undefined;
    destroyBuilding(building: Building): void;
    sendHome(settler: Settler): void;
    claimOf(building: Building, defended: boolean): Claim | undefined;
    strongestClaimTo(point: number, claimants: readonly Claim[], incumbent: number): number;
  }

  /** Every state a soldier passes through between the order and the outcome. */
  const AT_WAR: readonly SettlerState[] = [
    SettlerState.Mustering,
    SettlerState.MarchingToAttack,
    SettlerState.WaitingToFight,
    SettlerState.Fighting,
    SettlerState.Defending,
    SettlerState.WaitingToEnter,
  ];

  const atWar = (sim: Simulation): Settler[] =>
    sim.settlers.all().filter((settler) => AT_WAR.includes(settler.state));

  function reachIn(sim: Simulation): Innards {
    return sim as unknown as Innards;
  }

  /** A game with a dormant neighbour, as every real game now has. */
  function contested(seed = 4242): Simulation {
    return Simulation.create({
      // The shape the game ships: the rival's half is this player's half turned
      // about, so the two of them are dealt exactly the same country.
      width: 192,
      height: 96,
      seed,
      players: [
        { name: 'You', colour: '#c4832b' },
        { name: 'Rival', colour: '#3f6f9c', dormant: true },
      ],
    });
  }

  function outpostsOf(sim: Simulation, owner: number): Building[] {
    return sim.buildings
      .all()
      .filter(
        (building) =>
          building.owner === owner &&
          buildingInfo(building.type).behaviour.kind === 'military',
      );
  }

  function ground(sim: Simulation, owner: number): number {
    let total = 0;
    for (let point = 0; point < sim.world.owner.length; point += 1) {
      if (sim.world.owner[point] === owner) total += 1;
    }
    return total;
  }

  /** Every soldier either side has, in a garrison or in the field. */
  function soldiers(sim: Simulation, owner: number): number {
    let total = 0;
    sim.buildings.forEach((building) => {
      if (building.owner === owner) total += garrisonStrength(building.garrison);
    });
    sim.settlers.forEach((settler) => {
      if (settler.owner === owner && settler.profession === Profession.Soldier) total += 1;
    });
    return total;
  }

  /** Plants a manned outpost of the player's within reach of a point. */
  function baseNear(
    sim: Simulation,
    target: number,
    men: number,
    from = 5,
    to = 9,
    type: BuildingType = BuildingType.Barracks,
  ): Building {
    for (const point of sim.world.grid.pointsWithin(target, to)) {
      const away = sim.world.grid.distance(target, point);
      if (away < from || away > to) continue;

      // The ground has to be his before he can build on it, as it would be if
      // he had pushed his frontier this far. Painted on every site *tried*, not
      // only the one settled on, which leaves a corridor of his ground between
      // the post and its target — the attacks below need it, and the border
      // tests work around it by noting which nodes the harness painted.
      sim.world.owner[point] = PLAYER;
      for (const near of sim.world.grid.pointsWithin(point, 1)) sim.world.owner[near] = PLAYER;

      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, buildingInfo(type).size)) continue;

      // Reached into rather than built: a barracks needs boards, stone and a
      // road to the site, and none of that is what these tests are about. The
      // dormant rival's own outposts are raised exactly this way.
      const post = reachIn(sim).createBuilding(type, point, PLAYER);
      if (!post) continue;

      post.state = BuildingState.Complete;
      post.status = BuildingStatus.Working;
      post.garrison[Rank.Private] = men;
      return post;
    }
    throw new Error('nowhere to base an attack');
  }

  /**
   * Mans a post through its front door, which is what works the border out.
   *
   * `baseNear` paints a site by hand and drops men straight into the garrison,
   * so the ground around it is whatever the harness painted. Walking one man in
   * puts the simulation's own rule over the top of it, leaving the garrison the
   * size it was.
   */
  function holdIt(sim: Simulation, post: Building): void {
    const men = garrisonStrength(post.garrison);
    post.garrison.fill(0);

    const soldier = sim.settlers.add(
      (id) =>
        ({
          id,
          owner: post.owner,
          profession: Profession.Soldier,
          rank: Rank.Private,
          building: post.id,
          state: SettlerState.WalkingToJob,
        }) as Settler,
    );
    reachIn(sim).joinGarrison(soldier);

    post.garrison.fill(0);
    post.garrison[Rank.Private] = men;
  }

  /**
   * A manned post of the player's out beyond the hall's own reach, with open
   * ground about it.
   *
   * Distance alone is not enough: the ring beyond a hall is as likely to be
   * mountain as meadow, and a post in the rocks has nowhere to put the hut or
   * the flag a test wants to stand beside it. Sites are tried until one has
   * room, and the post is manned through its door so its claim is real.
   */
  function baseBeyond(sim: Simulation, home: number, men: number): Building {
    for (let to = 16; to <= 22; to += 1) {
      let post: Building;
      try {
        post = baseNear(sim, home, men, to - 1, to);
      } catch {
        continue;
      }
      holdIt(sim, post);

      const room = sim.world.grid
        .pointsWithin(post.point, 6)
        .filter(
          (point) =>
            sim.world.grid.distance(home, point) > HALL_REACH &&
            sim.world.owner[point] === PLAYER &&
            canHostSize(evaluateBuildSpace(sim.world, point, PLAYER), BuildingSize.Hut),
        );
      if (room.length > 0) return post;
    }
    throw new Error('nowhere beyond the hall with room to build');
  }

  /**
   * A storehouse beside a post, roaded to it, with men in it to spare.
   *
   * A post only sends for a soldier when a store can actually reach it: the
   * request needs a road between the two flags. `baseNear` reaches a post onto
   * the map without one, so anything testing what a post asks for has to give
   * it somewhere to ask.
   */
  function supply(sim: Simulation, post: Building, men: number): Building {
    for (const point of sim.world.grid.pointsWithin(post.point, 7)) {
      if (sim.world.grid.distance(post.point, point) < 3) continue;

      // The ground has to be his to build on, as it would be if his frontier
      // had reached this far — the same reach-in `baseNear` uses.
      for (const near of sim.world.grid.pointsWithin(point, 2)) sim.world.owner[near] = PLAYER;

      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, BuildingSize.House)) continue;

      const store = reachIn(sim).createBuilding(BuildingType.Storehouse, point, PLAYER);
      if (!store) continue;
      store.state = BuildingState.Complete;
      store.status = BuildingStatus.Working;
      store.garrison[Rank.Private] = men;

      const route = planRoad(sim.world, store.flagPoint, post.flagPoint, PLAYER);
      if (route && sim.placeRoad(PLAYER, route).ok) return store;

      reachIn(sim).destroyBuilding(store);
    }
    throw new Error('nowhere to put a store beside the post');
  }

  /** Plants a finished hut of somebody's on the first of these points it fits. */
  function hutOn(sim: Simulation, owner: number, points: readonly number[]): Building {
    for (const point of points) {
      if (sim.world.owner[point] !== owner) continue;
      const space = evaluateBuildSpace(sim.world, point, owner);
      if (space === BuildSpace.None || !canHostSize(space, BuildingSize.Hut)) continue;

      const hut = reachIn(sim).createBuilding(BuildingType.Woodcutter, point, owner);
      if (!hut) continue;
      hut.state = BuildingState.Complete;
      return hut;
    }
    throw new Error('nowhere to put a hut');
  }

  /** Plants a finished hut of somebody's on ground he holds, near a point. */
  function hutNear(sim: Simulation, owner: number, near: number, within: number): Building {
    for (const point of sim.world.grid.pointsWithin(near, within)) {
      if (sim.world.owner[point] !== owner) continue;
      const space = evaluateBuildSpace(sim.world, point, owner);
      if (space === BuildSpace.None || !canHostSize(space, BuildingSize.Hut)) continue;

      const hut = reachIn(sim).createBuilding(BuildingType.Woodcutter, point, owner);
      if (!hut) continue;
      hut.state = BuildingState.Complete;
      return hut;
    }
    throw new Error('nowhere to put a hut');
  }

  /** Runs until the fighting is over, or gives up. */
  function fightItOut(sim: Simulation, ticks = 4000): number {
    for (let i = 0; i < ticks; i += 1) {
      sim.update();
      if (atWar(sim).length === 0) return i;
    }
    return ticks;
  }

  it('puts a rival on the island, holding ground', () => {
    const sim = contested();

    expect(sim.players).toHaveLength(2);
    const mine = sim.buildings.require(sim.players[0]!.headquarters);
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);
    expect(sim.world.grid.distance(mine.point, theirs.point)).toBeGreaterThanOrEqual(18);

    // Manned from the outset: an outpost holds no ground without men in it, so
    // an unmanned rival would be a rival with no province at all.
    const posts = outpostsOf(sim, RIVAL);
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(garrisonStrength(post.garrison)).toBeGreaterThan(0);
    expect(ground(sim, RIVAL)).toBeGreaterThan(0);
  });

  it('never stirs: the rival builds nothing and sends nobody', () => {
    const sim = contested();
    const before = sim.buildings.all().filter((building) => building.owner === RIVAL).length;

    run(sim, 3000);

    expect(sim.buildings.all().filter((building) => building.owner === RIVAL)).toHaveLength(before);
    expect(sim.settlers.all().filter((settler) => settler.owner === RIVAL)).toHaveLength(0);
  });

  it('refuses an attack that makes no sense, and says why', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const mine = sim.buildings.require(sim.players[0]!.headquarters);

    const own = sim.attack(PLAYER, mine.point, 1);
    expect(own.ok).toBe(false);
    expect(own.ok === false && own.reason).toContain('yours already');

    // Nothing near enough to send anybody: the frontier has to be pushed out
    // before a neighbour can be reached at all.
    const far = sim.attack(PLAYER, target.point, 1);
    expect(far.ok).toBe(false);
    expect(far.ok === false && far.reason).toContain('near enough');

    // And an outpost down to its last man cannot spare him — holding the
    // ground is what he is for.
    baseNear(sim, target.point, 1);
    const thin = sim.attack(PLAYER, target.point, 1);
    expect(thin.ok).toBe(false);
    expect(thin.ok === false && thin.reason).toContain('nobody to spare');
  });

  it('sends the men, and never the last one', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 4);

    // Four men in the post, three of them free to go: what is offered and what
    // marches are the same number, and it is one short of the garrison.
    expect(sim.menToSpare(PLAYER, target.point)).toBe(3);
    expect(sim.attack(PLAYER, target.point, 99).ok).toBe(true);

    // Three are committed, one stayed to hold the ground. They are mustered
    // inside the post rather than on the map: the door lets one out at a time.
    expect(garrisonStrength(post.garrison)).toBe(1);
    expect(atWar(sim)).toHaveLength(3);
    expect(
      sim.settlers.all().filter((settler) => settler.state === SettlerState.Mustering),
    ).toHaveLength(3);
  });

  it('takes the building and the ground under it', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);

    // Which points changed hands, not how many he holds: working a border out
    // also fills in ground the old patched map left blank, so a province can
    // gain from nobody in the same breath as it loses to somebody and a bare
    // total would show neither.
    const before = sim.world.grid
      .pointsWithin(target.point, 8)
      .filter((point) => sim.world.owner[point] === RIVAL);
    expect(before.length).toBeGreaterThan(0);

    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);
    fightItOut(sim);

    const taken = sim.buildings.require(target.id);
    expect(taken.owner).toBe(PLAYER);
    expect(garrisonStrength(taken.garrison)).toBeGreaterThan(0);
    expect(sim.world.owner[target.point]).toBe(PLAYER);
    expect(before.filter((point) => sim.world.owner[point] !== RIVAL).length).toBeGreaterThan(0);
  });

  it('is beaten off when too few are sent', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 2);

    expect(sim.attack(PLAYER, target.point, 1).ok).toBe(true);
    fightItOut(sim);

    const held = sim.buildings.require(target.id);
    expect(held.owner).toBe(RIVAL);
    expect(garrisonStrength(held.garrison)).toBeGreaterThan(0);
  });

  it('kills nobody it did not have to', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);

    const before = soldiers(sim, PLAYER) + soldiers(sim, RIVAL);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);
    fightItOut(sim);

    // Men die in a fight and nowhere else. Conjuring one is as bad as losing
    // one, and leaving the attackers standing about after a capture would do
    // exactly that — so the count is pinned from both sides, not merely
    // observed to have fallen.
    const after = soldiers(sim, PLAYER) + soldiers(sim, RIVAL);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(before - 15);

    // And nobody is left standing at a building his own side now holds.
    expect(
      sim.settlers.all().filter((settler) => settler.state === SettlerState.Fighting),
    ).toHaveLength(0);
  });

  it('closes the line up when the man at the flag falls', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 6).ok).toBe(true);

    /**
     * The men committed to the target, in the order of the line: from the flag
     * outwards, each place a node from the last. Read off the places they hold
     * rather than where they are standing, since a man walking up into a place
     * is in it as far as the queue is concerned — and followed rather than
     * sorted by distance, because the line curves round the walls.
     */
    const line = (): Settler[] => {
      const committed = sim.settlers
        .all()
        .filter((settler) => settler.building === target.id && AT_WAR.includes(settler.state));

      const ordered: Settler[] = [];
      let at = target.flagPoint;
      for (;;) {
        const next = committed.find(
          (man) => !ordered.includes(man) && sim.world.grid.distance(man.taskPoint, at) <= 1,
        );
        if (!next) return ordered;
        ordered.push(next);
        at = next.taskPoint;
      }
    };

    // Wait until the line has formed up a few deep.
    for (let i = 0; i < 2000 && line().length < 4; i += 1) sim.update();
    const formed = line();
    expect(formed.length).toBeGreaterThan(3);

    // Every place is a node from the one ahead of it: that is the line.
    const gaps = (men: readonly Settler[]): number[] =>
      men.slice(1).map((man, i) => sim.world.grid.distance(man.taskPoint, men[i]!.taskPoint));
    expect(gaps(formed).every((gap) => gap === 1)).toBe(true);

    // The man at the flag falls. Everybody behind takes the place of the man
    // ahead of him, where the line used to keep his node empty for the rest of
    // the fight.
    const front = formed[0]!;
    expect(front.taskPoint).toBe(target.flagPoint);
    const behind = formed.slice(1);
    const wasAt = behind.map((man) => man.taskPoint);
    sim.settlers.remove(front.id);
    sim.update();

    const moved = behind.filter((man) => sim.settlers.get(man.id) === man);
    expect(moved.length).toBeGreaterThan(2);
    for (const man of moved) {
      expect(man.taskPoint).toBe(wasAt[behind.indexOf(man) - 1] ?? target.flagPoint);
    }
    expect(gaps(line()).every((gap) => gap === 1)).toBe(true);
  });

  it('bends the queue round the walls instead of trailing it away straight', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 12);
    // A garrison that cannot be beaten, so the whole party forms up and stays.
    target.garrison.fill(0);
    target.garrison[Rank.General] = 9;
    expect(sim.attack(PLAYER, target.point, post.garrison[Rank.Private]! - 1).ok).toBe(true);

    /** The places the party holds, followed from the flag outwards. */
    const places = (): number[] => {
      const held = sim.settlers
        .all()
        .filter((settler) => settler.building === target.id && AT_WAR.includes(settler.state))
        .map((settler) => settler.taskPoint);

      const line: number[] = [];
      let at = target.flagPoint;
      for (;;) {
        const next = held.findIndex(
          (place) => !line.includes(place) && sim.world.grid.distance(place, at) <= 1,
        );
        if (next < 0) return line;
        at = held[next]!;
        line.push(at);
      }
    };

    for (let i = 0; i < 400 && places().length < 6; i += 1) sim.update();
    const line = places();
    expect(line.length).toBeGreaterThan(5);

    // Nothing doubles back: every place is at least as far from the walls as
    // the one before it, so the queue leads away from the fight.
    const away = line.map((place) => sim.world.grid.distance(target.point, place));
    for (let i = 1; i < away.length; i += 1) expect(away[i]!).toBeGreaterThanOrEqual(away[i - 1]!);

    // And it bends: a straight tail would keep gaining a node on the walls the
    // whole way, where an arc settles at a distance and curves round.
    expect(away[away.length - 1]).toBeLessThan(line.length - 1);
    expect(new Set(away).size).toBeLessThan(line.length);
  });

  it('keeps the door shut until a man is standing on the flag', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 6).ok).toBe(true);

    const onTheDoor = (): Settler[] =>
      sim.settlers
        .all()
        .filter(
          (settler) => settler.state === SettlerState.Defending && settler.building === target.id,
        );
    const onTheFlag = (): Settler[] =>
      sim.settlers
        .all()
        .filter(
          (settler) =>
            settler.building === target.id &&
            settler.state === SettlerState.Fighting &&
            settler.point === target.flagPoint,
        );

    let marched = 0;
    let out = -1;
    let knocked = -1;
    for (let i = 0; i < 2000; i += 1) {
      sim.update();
      // Men on the road with nobody yet at the flag: the fight is ordered but
      // has not arrived, and the garrison has no business turning out for it.
      if (onTheFlag().length === 0 && atWar(sim).length > 0) {
        marched += 1;
        expect(onTheDoor()).toHaveLength(0);
      }
      if (out < 0 && onTheDoor().length > 0) out = i;
      if (knocked < 0 && onTheFlag().length > 0) knocked = i;
      if (out >= 0) break;
    }

    // He had a long walk to stand through, and stayed inside for all of it.
    expect(marched).toBeGreaterThan(20);
    // And he comes out on the knock, not before it.
    expect(knocked).toBeGreaterThan(0);
    expect(out).toBe(knocked);
  });

  it('sends a man whose fight is already over back to his own post', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    // Six men in a tower that holds six, five of them sent: one place is kept,
    // one man goes into the place they take, and the rest have room to come
    // home — so anybody who ends up at a store did so by choice of rule, not
    // for want of a bed.
    const post = baseNear(sim, target.point, 6, 5, 9, BuildingType.WatchTower);
    holdIt(sim, post);
    supply(sim, post, 20);
    expect(sim.attack(PLAYER, target.point, 5).ok).toBe(true);

    // Taken the moment the first man arrives, so the rest are still walking.
    for (let i = 0; i < 2000 && target.owner !== PLAYER; i += 1) {
      target.garrison.fill(0);
      sim.update();
    }
    expect(target.owner).toBe(PLAYER);

    const stillWalking = sim.settlers
      .all()
      .filter((settler) => settler.homePost === post.id && AT_WAR.includes(settler.state));
    expect(stillWalking.length).toBeGreaterThan(0);

    // The place they were making for is somebody else's now, so they turn
    // round — and a man turns round towards the post he marched out of, which
    // has room for him, not to a store on the other side of the province.
    sim.update();
    const turned = stillWalking.filter((settler) => sim.settlers.get(settler.id) === settler);
    expect(turned.length).toBe(stillWalking.length);
    for (const settler of turned) {
      expect(settler.state).toBe(SettlerState.WalkingToJob);
      expect(settler.building).toBe(post.id);
    }

    // And they get there: the tower ends up holding the men it sent out, less
    // whoever went into the place they took.
    for (let i = 0; i < 2000; i += 1) sim.update();
    expect(garrisonStrength(post.garrison)).toBeGreaterThanOrEqual(turned.length);
  });

  it('keeps the man on the door out until the last attacker is gone', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 6).ok).toBe(true);

    const defenders = (): Settler[] =>
      sim.settlers.all().filter((settler) => settler.state === SettlerState.Defending);
    const marching = (): Settler[] =>
      sim.settlers
        .all()
        .filter(
          (settler) =>
            settler.building === target.id && settler.state === SettlerState.MarchingToAttack,
        );

    // Wait until a defender is out and somebody is still on his way up.
    let watched = 0;
    for (let i = 0; i < 4000; i += 1) {
      sim.update();
      if (defenders().length === 0 || marching().length === 0) continue;

      // With a man still walking up, the fight is not over: the defender holds
      // his door rather than ducking back inside and coming out again.
      const held = defenders()[0]!;
      sim.settlers.remove(
        sim.settlers
          .all()
          .find(
            (settler) => settler.building === target.id && settler.state === SettlerState.Fighting,
          )?.id ?? 0,
      );
      sim.update();
      expect(sim.settlers.get(held.id)).toBe(held);
      expect(held.state).toBe(SettlerState.Defending);
      watched += 1;
      break;
    }
    expect(watched).toBe(1);
    expect(post.owner).toBe(PLAYER);
  });

  it('sends for no replacement while its own men are out', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    // A watchtower, which holds six, so there is really a gap to fill; and a
    // hall with men in it to fill the gap from.
    const post = baseNear(sim, target.point, 6, 5, 9, BuildingType.WatchTower);
    holdIt(sim, post);
    const store = supply(sim, post, 20);

    expect(sim.attack(PLAYER, target.point, 5).ok).toBe(true);

    // Its own men who are still committed to the fight — not the ones already
    // turned round and walking home, who are counted in `garrisonRequested`.
    const stillOut = (): number =>
      sim.settlers
        .all()
        .filter((settler) => settler.homePost === post.id && AT_WAR.includes(settler.state)).length;

    // Counted at the store, not at the post: a man walking back reserves his
    // own place at the post, so its books rising is not a man being sent for.
    // A man leaving the store is.
    let askedWhileOut = 0;
    for (let i = 0; i < 4000; i += 1) {
      const before = garrisonStrength(store.garrison);
      sim.update();
      if (garrisonStrength(store.garrison) < before && stillOut() > 0) askedWhileOut += 1;
      if (stillOut() === 0 && atWar(sim).length === 0) break;
    }

    // Not one: the men it sent may yet walk back, and it is only short of
    // whoever does not.
    expect(askedWhileOut).toBe(0);

    // And once it is over it fills what is genuinely missing, no more.
    fightItOut(sim, 4000);
    for (let i = 0; i < 4000; i += 1) sim.update();
    expect(garrisonStrength(post.garrison)).toBeLessThanOrEqual(6);
  });

  it('sends for no replacement while somebody is standing at its flag', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    // A post of the player's on the frontier, a man short, with a store beside
    // it that could fill the gap.
    // Three men of the six it holds, so it is short and could send for more,
    // and enough of them that one attacker cannot simply take it.
    const mine = baseNear(sim, target.point, 3, 5, 9, BuildingType.WatchTower);
    holdIt(sim, mine);
    supply(sim, mine, 20);

    // A rival soldier standing at its flag, which is what being attacked looks
    // like from the inside.
    sim.settlers.add((id) => ({
      id,
      owner: RIVAL,
      profession: Profession.Soldier,
      rank: Rank.Private,
      state: SettlerState.Fighting,
      building: mine.id,
      point: mine.flagPoint,
      fromPoint: mine.flagPoint,
      toPoint: mine.flagPoint,
      path: [],
      pathIndex: 0,
      stepProgress: 0,
      stepLength: 8,
      taskPoint: mine.flagPoint,
      taskTimer: 12,
      homePost: 0,
      carrying: null,
      carryDestination: 0,
      road: 0,
      surveyFrom: 0,
    }));

    // While he stands there the post sends for nobody: it settles the matter
    // with the men it has.
    const besieged = (): boolean =>
      sim.settlers
        .all()
        .some(
          (settler) =>
            settler.owner === RIVAL &&
            settler.building === mine.id &&
            AT_WAR.includes(settler.state),
        );

    let watched = 0;
    let asked = mine.garrisonRequested;
    for (let i = 0; i < 600 && besieged(); i += 1) {
      sim.update();
      expect(mine.garrisonRequested).toBeLessThanOrEqual(asked);
      asked = mine.garrisonRequested;
      watched += 1;
    }
    expect(watched).toBeGreaterThan(10);
    expect(mine.owner).toBe(PLAYER); // Not taken: it is the sending-for under test.

    // And with the fight over it fills up from the store beside it, which is
    // what says the store could have supplied it all along.
    const after = garrisonStrength(mine.garrison);
    for (let i = 0; i < 3000 && garrisonStrength(mine.garrison) <= after; i += 1) sim.update();
    expect(garrisonStrength(mine.garrison)).toBeGreaterThan(after);
  });

  it('lets rank tell, without making it certain', () => {
    // Many blows on one seed rather than one roll: the odds run with rank, and
    // what matters is that they run, not how any single blow lands.
    const sim = contested();
    const ROUNDS = 200;

    const strike = (attacker: number, defender: number): boolean => {
      const target = { garrison: [0, 0, 0, 0, 0], defenderDelay: 0 } as Building;
      // Both men are real entities: a blow takes one of the two off the world,
      // and a made-up id would collide with the other one's.
      const man = sim.settlers.add((id) => ({ id, rank: attacker }) as Settler);
      const held = sim.settlers.add((id) => ({ id, rank: defender }) as Settler);

      reachIn(sim).exchangeBlows(target, man, held);
      const won = sim.settlers.get(held.id) === undefined;
      sim.settlers.remove(man.id);
      sim.settlers.remove(held.id);
      return won;
    };

    let generalWins = 0;
    let evenWins = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      if (strike(Rank.General, Rank.Private)) generalWins += 1;
      if (strike(Rank.Private, Rank.Private)) evenWins += 1;
    }

    // Five weights against one: a general should take about five in six, and a
    // private against a private about half. Neither ever certain.
    expect(generalWins / ROUNDS).toBeGreaterThan(0.7);
    expect(generalWins).toBeLessThan(ROUNDS);
    expect(evenWins / ROUNDS).toBeGreaterThan(0.35);
    expect(evenWins / ROUNDS).toBeLessThan(0.65);
  });

  it('survives a save taken mid-battle', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);

    // Far enough for the men to be on the road and not yet at the flag.
    run(sim, 20);
    const marching = atWar(sim);
    expect(marching.length).toBeGreaterThan(0);

    const restored = Simulation.fromSnapshot(sim.toSnapshot());
    const carriedOver = atWar(restored);
    expect(carriedOver).toHaveLength(marching.length);
    expect(carriedOver.map((settler) => settler.rank).sort()).toEqual(
      marching.map((settler) => settler.rank).sort(),
    );

    // And the fight goes on rather than the men standing about for ever.
    fightItOut(restored);
    expect(restored.buildings.require(target.id).owner).toBe(PLAYER);
  });

  it('ends the war when a headquarters falls', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);
    baseNear(sim, theirs.point, 12);

    expect(sim.attack(PLAYER, theirs.point, 11).ok).toBe(true);
    fightItOut(sim, 8000);

    expect(sim.winner).toBe(PLAYER);

    // And a decided war takes no more orders. Checked by its *words*: the
    // headquarters is gone, so "there is nothing there" would refuse it too,
    // and the test would have proved nothing.
    const mine = sim.buildings.require(sim.players[0]!.headquarters);
    const after = sim.attack(PLAYER, mine.point, 1);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.reason).toContain('war is over');
  });

  it('leaves a hall standing until somebody walks in through its door', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);
    baseNear(sim, theirs.point, 12);
    expect(sim.attack(PLAYER, theirs.point, 11).ok).toBe(true);

    let lastStep: readonly [number, number] | undefined;
    let waitedOutside = 0;
    for (let i = 0; i < 8000; i += 1) {
      // The man on his way in, and the step he is taking.
      const walkingIn = sim.settlers
        .all()
        .find(
          (settler) =>
            settler.owner === PLAYER &&
            settler.building === theirs.id &&
            settler.state === SettlerState.WalkingToJob,
        );
      if (walkingIn) lastStep = [walkingIn.fromPoint, walkingIn.toPoint];

      // Men standing outside a hall whose garrison is spent, waiting their turn
      // at the door: under the old rule it was already rubble by now.
      if (
        garrisonStrength(theirs.garrison) === 0 &&
        sim.settlers.all().some((settler) => settler.state === SettlerState.WaitingToEnter)
      ) {
        waitedOutside += 1;
      }

      sim.update();
      if (!sim.buildings.get(theirs.id)) break;
    }

    // It stood, empty, while somebody walked up to it — and the step that threw
    // it down was the one from its flag onto its door.
    expect(waitedOutside).toBeGreaterThan(0);
    expect(lastStep).toEqual([theirs.flagPoint, theirs.point]);
    expect(sim.winner).toBe(PLAYER);
  });

  it('turns a fallen hall’s people out onto the ground rather than deleting them', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);
    expect(theirs.reserve).toBeGreaterThan(10);

    // What the rival has, in people, before anybody lays a hand on him.
    const before = sim.population(RIVAL);
    const inside = theirs.reserve;

    baseNear(sim, theirs.point, 12);
    expect(sim.attack(PLAYER, theirs.point, 11).ok).toBe(true);
    for (let i = 0; i < 8000 && sim.buildings.get(theirs.id); i += 1) sim.update();
    expect(sim.buildings.get(theirs.id)).toBeUndefined();

    // Every one of them is on the map, walking: the garrison they lost in the
    // fight is the only place the count may fall.
    const out = sim.settlers.all().filter((settler) => settler.owner === RIVAL);
    expect(out.length).toBeGreaterThanOrEqual(inside);
    expect(sim.population(RIVAL)).toBeGreaterThanOrEqual(before - 12);

    // They walk out of it: every one of them is standing on the door the tick
    // it comes down. Nobody is put on the ground beside it, any more than
    // anybody else in this game is.
    const turnedOut = out.filter((settler) => settler.profession === Profession.Helper);
    expect(turnedOut.length).toBeGreaterThanOrEqual(inside);
    for (const settler of turnedOut) {
      expect(settler.point).toBe(theirs.point);
      expect(settler.fromPoint).toBe(theirs.point);
    }

    // The ring holds six; the first six out have a step of their own in front
    // of them and the rest crowd the doorstep until they can move off.
    const stepping = turnedOut.filter((settler) => settler.toPoint !== theirs.point);
    expect(stepping.length).toBeGreaterThan(0);
    for (const settler of stepping) {
      expect(sim.world.grid.distance(settler.toPoint, theirs.point)).toBe(1);
    }

    // And they are going somewhere: the hall was the rival's only store, so
    // there is nowhere of his own left to walk to and every one of them is
    // wandering. Nobody is sent home to the wreck he has just walked out of.
    for (const settler of turnedOut) {
      expect(settler.state).toBe(SettlerState.Lost);
      expect(settler.building).toBe(0);
    }

    // They scatter, and their time runs out: within a couple of hundred ticks
    // most are clear of the ruin, and none of them is left standing on it —
    // which is what they used to do until they were struck off one by one.
    for (let i = 0; i < 200; i += 1) sim.update();
    const still = sim.settlers.all().filter((settler) => settler.owner === RIVAL);
    const onTheSpot = still.filter(
      (settler) => sim.world.grid.distance(settler.point, theirs.point) <= 1,
    );
    expect(onTheSpot.length).toBeLessThan(turnedOut.length / 2);

    for (let i = 0; i < 400; i += 1) sim.update();
    expect(sim.settlers.all().filter((settler) => settler.owner === RIVAL)).toHaveLength(0);
  });

  it('loses a man whose store goes while he is walking to it', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);

    // A man of the rival's on his way home to his only store, a step from the
    // door.
    const walker = sim.settlers.add((id) => ({
      id,
      owner: RIVAL,
      profession: Profession.Helper,
      rank: Rank.Private,
      state: SettlerState.ReturningToStore,
      building: theirs.id,
      point: theirs.flagPoint,
      fromPoint: theirs.flagPoint,
      toPoint: theirs.flagPoint,
      path: [theirs.point],
      pathIndex: 0,
      stepProgress: 0,
      stepLength: 8,
      taskPoint: theirs.point,
      taskTimer: 0,
      homePost: 0,
      carrying: null,
      carryDestination: 0,
      road: 0,
      surveyFrom: 0,
    }));

    reachIn(sim).destroyBuilding(theirs);
    expect(sim.buildings.get(theirs.id)).toBeUndefined();

    // He walks the last step, finds nothing there and nothing of his own
    // anywhere else — and wanders rather than being struck off on the doorstep.
    for (let i = 0; i < 40 && sim.settlers.get(walker.id) === walker; i += 1) {
      sim.update();
      if (walker.state === SettlerState.Lost) break;
    }
    expect(sim.settlers.get(walker.id)).toBe(walker);
    expect(walker.state).toBe(SettlerState.Lost);
  });

  it('takes one post, not the whole province behind it', () => {
    // The fault this round was written for: a captured outpost's radius used
    // to go over whole, so a barracks six nodes from its own headquarters took
    // the headquarters and every other post with it — one blow won the war.
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);
    const posts = outpostsOf(sim, RIVAL);
    const target = posts[0]!;
    const others = posts.slice(1);
    expect(others.length).toBeGreaterThan(0);

    baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);
    fightItOut(sim);

    expect(sim.buildings.require(target.id).owner).toBe(PLAYER);

    // Everything else of his is standing, manned, and still holding ground.
    expect(sim.buildings.get(theirs.id)?.owner).toBe(RIVAL);
    expect(sim.world.owner[theirs.point]).toBe(RIVAL);
    for (const post of others) {
      expect(sim.buildings.get(post.id)?.owner).toBe(RIVAL);
      expect(garrisonStrength(sim.buildings.require(post.id).garrison)).toBeGreaterThan(0);
      expect(sim.world.owner[post.point]).toBe(RIVAL);
    }
    expect(sim.winner).toBe(0);
  });

  it('clears the ground it takes of his buildings and his flags', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);

    // A hut and a flag of his, close enough to the post to go with it.
    const hut = hutNear(sim, RIVAL, target.point, 3);
    const flagPoint = sim.world.grid
      .pointsWithin(target.point, 3)
      .find(
        (point) => sim.world.owner[point] === RIVAL && canPlaceFlag(sim.world, point, RIVAL),
      );
    expect(flagPoint).toBeDefined();
    expect(sim.placeFlag(RIVAL, flagPoint!).ok).toBe(true);

    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);
    fightItOut(sim);

    expect(sim.buildings.require(target.id).owner).toBe(PLAYER);
    // The ground under both went over, so both are gone: a beaten province
    // must not be left laced with roads its owner cannot walk on.
    expect(sim.world.owner[hut.point]).toBe(PLAYER);
    expect(sim.buildings.get(hut.id)).toBeUndefined();
    expect(sim.world.owner[flagPoint!]).toBe(PLAYER);
    expect(sim.world.flag[flagPoint!]).toBe(0);
  });

  it('gives up the ground of a post that is pulled down', () => {
    const sim = contested();
    const home = sim.buildings.require(sim.players[0]!.headquarters).point;
    // Beyond the hall's own reach, or the hall would hold this ground whatever
    // became of the post standing on it.
    const first = baseBeyond(sim, home, 3);
    const second = baseNear(sim, first.point, 3, 5, 8);
    holdIt(sim, second);

    // Ground only the first post covers, and ground the second covers too.
    const onlyFirst = sim.world.grid
      .pointsWithin(first.point, 8)
      .find(
        (point) =>
          sim.world.owner[point] === PLAYER &&
          sim.world.grid.distance(second.point, point) > 8 &&
          sim.world.grid.distance(home, point) > HALL_REACH,
      );
    expect(onlyFirst).toBeDefined();
    const alsoSecond = sim.world.grid
      .pointsWithin(second.point, 3)
      .find((point) => sim.world.owner[point] === PLAYER);
    expect(alsoSecond).toBeDefined();

    expect(sim.demolishBuilding(PLAYER, first.point).ok).toBe(true);

    // What only it held goes back to nobody; what its neighbour covers stays.
    expect(sim.world.owner[onlyFirst!]).toBe(0);
    expect(sim.world.owner[alsoSecond!]).toBe(PLAYER);
  });

  it('keeps a manned post its first ring, and settles the rest on pressure', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);

    // A post of the player's hard up against the rival's hall — inside its
    // reach, where the hall out-pushes a barracks on every node either of them
    // covers. Nothing but the post's own ring should be the player's.
    const post = baseNear(sim, theirs.point, 0, 5, 7);
    const away = (point: number): number => sim.world.grid.distance(post.point, point);
    // By distance, not by who holds them at this moment: `baseNear` paints
    // ownership onto every site it tries before settling on one, so what the
    // map says here is partly the harness's own doing.
    const covered = sim.world.grid
      .pointsWithin(post.point, 8)
      .filter((point) => sim.world.grid.distance(theirs.point, point) <= HALL_REACH);
    expect(covered.length).toBeGreaterThan(0);

    const soldier = sim.settlers.add(
      (id) =>
        ({
          id,
          owner: PLAYER,
          profession: Profession.Soldier,
          rank: Rank.Private,
          building: post.id,
          state: SettlerState.WalkingToJob,
        }) as Settler,
    );
    reachIn(sim).joinGarrison(soldier);

    // The ring it keeps whatever is pushing at it, which is what stops a post
    // being razed by the border it has just redrawn.
    const ring = covered.filter((point) => away(point) <= 1);
    expect(ring.length).toBeGreaterThan(0);
    for (const point of ring) expect(sim.world.owner[point]).toBe(PLAYER);

    // And past it, pressure and nothing else. A hall reaching thirteen brings
    // more to bear than a barracks reaching eight on every node it covers this
    // near, so the ground stays the rival's — where the old grip handed the
    // player a quarter of the barracks's radius outright.
    const beyond = covered.filter((point) => {
      if (away(point) <= 1) return false;
      if (sim.world.grid.distance(theirs.point, point) <= 2) return false; // the hall's own ring
      return HALL_REACH - sim.world.grid.distance(theirs.point, point) > 8 - away(point);
    });
    expect(beyond.length).toBeGreaterThan(10);
    for (const point of beyond) expect(sim.world.owner[point]).toBe(RIVAL);
  });

  it('offers all its spare men close by, and fewer further out', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;

    // Six men, five of them spare: all of them within twelve nodes, two thirds
    // within sixteen, a third within twenty, and nobody at all beyond. The
    // expectation is read off the distance actually reached, so the bands are
    // what is under test rather than where the ground happened to allow a post.
    const bands: readonly (readonly [number, number])[] = [
      [12, 5],
      [16, 3],
      [20, 1],
      [Number.POSITIVE_INFINITY, 0],
    ];
    const offeredAt = (away: number): number => bands.find(([within]) => away <= within)![1];

    const seen = new Set<number>();
    for (const [from, to] of [
      [10, 12],
      [13, 16],
      [17, 20],
      [21, 23],
    ] as const) {
      const one = contested();
      const its = outpostsOf(one, RIVAL)[0]!;
      const post = baseNear(one, its.point, 6, from, to);
      const away = one.world.grid.distance(post.point, its.point);
      seen.add(offeredAt(away));
      expect(one.menToSpare(PLAYER, its.point)).toBe(offeredAt(away));
    }
    // All four bands were really reached, not the same one four times over.
    expect([...seen].sort()).toEqual([0, 1, 3, 5]);

    // And out of reach altogether is a refusal, not a march of nobody.
    baseNear(sim, target.point, 6, 21, 23);
    const refused = sim.attack(PLAYER, target.point, 1);
    expect(refused.ok).toBe(false);
  });

  it('never offers the last man, however near', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 1, 5, 6);

    expect(sim.menToSpare(PLAYER, target.point)).toBe(0);
    const refused = sim.attack(PLAYER, target.point, 1);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain('nobody to spare');
  });

  it('holds ground from a headquarters and a manned post, never from a store', () => {
    const sim = contested();
    const mine = sim.buildings.require(sim.players[0]!.headquarters);
    const post = baseBeyond(sim, mine.point, 3);

    // A store standing on ground the post holds, well clear of the hall.
    const site = sim.world.grid.pointsWithin(post.point, 7).find((point) => {
      if (sim.world.owner[point] !== PLAYER) return false;
      if (sim.world.grid.distance(mine.point, point) <= 9) return false;
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      return space !== BuildSpace.None && canHostSize(space, BuildingSize.House);
    });
    expect(site).toBeDefined();
    const store = reachIn(sim).createBuilding(BuildingType.Storehouse, site!, PLAYER)!;
    store.state = BuildingState.Complete;
    store.status = BuildingStatus.Working;
    expect(sim.world.owner[store.point]).toBe(PLAYER);

    // Pulling the post down works the border out again across everything it
    // held. A store holds nothing — it is a depot, not a post — so the ground
    // under it goes back to nobody, and it comes down with the ground exactly
    // as a woodcutter's hut would. Were a store a claimant, it would have kept
    // its own site and stood.
    expect(sim.demolishBuilding(PLAYER, post.point).ok).toBe(true);

    expect(sim.world.owner[store.point]).toBe(0);
    expect(sim.buildings.get(store.id)).toBeUndefined();

    // And the hall goes on holding every one of its own nine.
    expect(sim.world.owner[mine.point]).toBe(PLAYER);
    for (const point of sim.world.grid.pointsWithin(mine.point, HALL_REACH)) {
      expect(sim.world.owner[point]).toBe(PLAYER);
    }
  });

  it('lets the men out one at a time, and lines them up a node apart', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);

    let crowdedDoor = 0;
    let sharedNode = 0;
    let secondManAtTheFlag = 0;
    let longestQueue = 0;

    for (let i = 0; i < 400; i += 1) {
      sim.update();

      // One man on the step outside the post at a time.
      const leaving = sim.settlers
        .all()
        .filter((settler) => settler.fromPoint === post.point && settler.toPoint !== post.point);
      if (leaving.length > 1) crowdedDoor += 1;

      // And one man to a node once they are there, with the fight at the flag.
      const standing = sim.settlers
        .all()
        .filter(
          (settler) =>
            settler.state === SettlerState.Fighting ||
            settler.state === SettlerState.WaitingToFight,
        );
      longestQueue = Math.max(longestQueue, standing.length);
      if (new Set(standing.map((settler) => settler.point)).size < standing.length) {
        sharedNode += 1;
      }
      const front = standing.filter((settler) => settler.state === SettlerState.Fighting);
      if (front.length > 1) secondManAtTheFlag += 1;
      if (front.length === 1 && front[0]!.point !== target.flagPoint) secondManAtTheFlag += 1;
    }

    expect(longestQueue).toBeGreaterThan(2);
    expect(crowdedDoor).toBe(0);
    expect(sharedNode).toBe(0);
    expect(secondManAtTheFlag).toBe(0);
  });

  it('sends its defenders out of the door one at a time, with a breath between', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const held = garrisonStrength(target.garrison);
    expect(held).toBeGreaterThan(1);
    baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);

    const onTheDoor = (): Settler[] =>
      sim.settlers.all().filter((settler) => settler.state === SettlerState.Defending);

    let twoOut = 0;
    let seen = 0;
    let previous: number | undefined;
    let fellAt: number | undefined;
    let shortestGap = Number.POSITIVE_INFINITY;

    for (let i = 0; i < 600; i += 1) {
      sim.update();
      const out = onTheDoor();
      if (out.length > 1) twoOut += 1;

      const now = out[0];
      if (now && now.id !== previous) {
        seen += 1;
        if (fellAt !== undefined) shortestGap = Math.min(shortestGap, i - fellAt);
        expect(now.point).toBe(target.point);
      }
      if (!now && previous !== undefined) fellAt = i;
      previous = now?.id;

      if (sim.buildings.get(target.id)?.owner === PLAYER) break;
    }

    expect(seen).toBeGreaterThan(1);
    expect(twoOut).toBe(0);
    // A pause between one falling and the next coming out, not the next tick.
    expect(shortestGap).toBeGreaterThan(1);
  });

  it('carries a queued attack and a man on the door through a save', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);

    // Far enough in for the queue to have formed and a defender to be out.
    let ready = false;
    for (let i = 0; i < 400 && !ready; i += 1) {
      sim.update();
      const states = sim.settlers.all().map((settler) => settler.state);
      ready =
        states.includes(SettlerState.WaitingToFight) && states.includes(SettlerState.Defending);
    }
    expect(ready).toBe(true);

    const restored = Simulation.fromSnapshot(sim.toSnapshot());
    expect(atWar(restored).map((settler) => settler.state).sort()).toEqual(
      atWar(sim).map((settler) => settler.state).sort(),
    );

    // And the fight goes on to a finish rather than the men standing about.
    fightItOut(restored);
    expect(restored.buildings.require(target.id).owner).toBe(PLAYER);
  });

  it('gives every node to whoever pushes hardest on it, counting all his buildings', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);

    // Two posts of the player's up against the rival's hall, so that plenty of
    // ground is pushed at from both sides by more than one building.
    const near = baseNear(sim, theirs.point, 3, 14, 16);
    holdIt(sim, near);
    const second = baseNear(sim, near.point, 3, 5, 7);
    holdIt(sim, second);

    /** What a building brings to bear on a node: its reach, less the walk. */
    const reachOfBuilding = (building: Building): number => {
      const behaviour = buildingInfo(building.type).behaviour;
      if (behaviour.kind === 'headquarters') return HALL_REACH;
      if (behaviour.kind !== 'military') return 0;
      return garrisonStrength(building.garrison) > 0 ? behaviour.radius : 0;
    };

    // Only the ground the last redraw actually covered. Ownership is worked
    // out where a building has just changed something, not over the whole map
    // every time, so anything outside that area still reflects an older
    // arrangement and says nothing about the rule.
    let judged = 0;
    for (const point of sim.world.grid.pointsWithin(second.point, 8)) {
      const push = new Map<number, number>();
      let kept = false;

      for (const building of sim.buildings.all()) {
        const reach = reachOfBuilding(building);
        if (reach <= 0) continue;
        const away = sim.world.grid.distance(building.point, point);
        if (away > reach) continue;
        // The ring a building keeps whatever the pressure is a rule of its
        // own — two nodes for a hall or a fortress, one for the rest — and is
        // not under test here.
        if (away <= (buildingInfo(building.type).size === BuildingSize.Castle ? 2 : 1)) {
          kept = true;
        }
        push.set(building.owner, (push.get(building.owner) ?? 0) + reach - away + 1);
      }
      if (kept || push.size < 2) continue;

      const ranked = [...push.entries()].sort((a, b) => b[1] - a[1]);
      // A dead heat is settled by other rules, so only clear ones are judged.
      if (ranked[0]![1] === ranked[1]![1]) continue;

      const winner = ranked[0]![0];
      // And the edge sweep is a rule of its own: a node with fewer than three
      // neighbours of its owner is not really held, whatever pushed hardest.
      const kin = sim.world.grid
        .pointsWithin(point, 1)
        .filter((near) => near !== point && sim.world.owner[near] === winner).length;
      if (kin < 3) continue;

      expect(sim.world.owner[point]).toBe(winner);
      judged += 1;
    }

    // Genuinely contested ground, not an empty loop dressed as a test.
    expect(judged).toBeGreaterThan(20);
  });

  it('lets two buildings pushing together out-hold one that beats either alone', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);

    // One post of the player's against the rival's hall, and a second beside
    // it left empty for now: an unmanned post holds nothing and pushes nothing.
    const near = baseNear(sim, theirs.point, 3, 14, 16);
    holdIt(sim, near);
    // A watchtower for the second: it reaches eleven, so the two of them
    // together bring enough to bear that there is ground the difference tells
    // on. A second barracks changes too little to measure against a hall.
    const second = baseNear(sim, near.point, 0, 5, 7, BuildingType.WatchTower);

    /** What everybody manned brings to bear on a node, by player. */
    const pushOn = (point: number, counting: Building | undefined): Map<number, number> => {
      const push = new Map<number, number>();
      for (const building of sim.buildings.all()) {
        const behaviour = buildingInfo(building.type).behaviour;
        const reach =
          behaviour.kind === 'headquarters'
            ? HALL_REACH
            : behaviour.kind === 'military' &&
                (building === counting || garrisonStrength(building.garrison) > 0)
              ? behaviour.radius
              : 0;
        if (reach <= 0) continue;
        const away = sim.world.grid.distance(building.point, point);
        if (away > reach) continue;
        push.set(building.owner, (push.get(building.owner) ?? 0) + reach - away + 1);
      }
      return push;
    };

    // The nodes the rule says should turn: the rival out-pushes one post of
    // his, and does not out-push the two of them together.
    const willTurn = sim.world.grid.pointsWithin(second.point, 11).filter((point) => {
      if (sim.world.grid.distance(near.point, point) <= 2) return false;
      if (sim.world.grid.distance(second.point, point) <= 2) return false;
      const alone = pushOn(point, undefined);
      const together = pushOn(point, second);
      const his = alone.get(RIVAL) ?? 0;
      return his > (alone.get(PLAYER) ?? 0) && his < (together.get(PLAYER) ?? 0);
    });
    expect(willTurn.length).toBeGreaterThan(0);

    // Manned, the second post pushes too, and every one of those nodes comes
    // over. What the map said beforehand is not asserted: ownership is worked
    // out where a building has changed something, so ground nobody has touched
    // yet still reflects an older arrangement.
    second.garrison[Rank.Private] = 3;
    holdIt(sim, second);
    for (const point of willTurn) expect(sim.world.owner[point]).toBe(PLAYER);
  });

  it('never lets anybody step on or off a door except by its flag', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 8);

    // A whole game's worth of coming and going: workers out to the trees,
    // carriers into stores, soldiers to a fight, a garrison turned out of a
    // building pulled down under it.
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);

    let throughAWall = 0;
    for (let i = 0; i < 1200; i += 1) {
      sim.update();
      if (i === 600) sim.demolishBuilding(PLAYER, post.point);

      // Rebuilt every tick, never added to: a site whose building has been
      // pulled down is open ground, and walking over it is no offence.
      const doors = new Map<number, number>();
      sim.buildings.forEach((building) => doors.set(building.point, building.flagPoint));

      for (const settler of sim.settlers.all()) {
        if (settler.fromPoint === settler.toPoint) continue;
        const out = doors.get(settler.fromPoint);
        if (out !== undefined && settler.toPoint !== out) throughAWall += 1;
        const into = doors.get(settler.toPoint);
        if (into !== undefined && settler.fromPoint !== into) throughAWall += 1;
      }
    }

    expect(throughAWall).toBe(0);
  });

  it('turns a demolished garrison out onto nodes of its own', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 4);
    holdIt(sim, post);
    expect(garrisonStrength(post.garrison)).toBeGreaterThan(2);

    const before = sim.settlers.all().length;
    expect(sim.demolishBuilding(PLAYER, post.point).ok).toBe(true);

    // Everybody who was inside is on the map, and countable: a man to a node,
    // so four men read as four men rather than as one. They are *walking* to
    // those nodes, though — every one of them stands on the door he came out
    // of, with a step of his own in front of him, because nobody in this game
    // is ever moved without walking.
    const turnedOut = sim.settlers.all().slice(before);
    expect(turnedOut.length).toBeGreaterThan(2);
    for (const settler of turnedOut) {
      expect(settler.point).toBe(post.point);
      expect(settler.fromPoint).toBe(post.point);
      expect(sim.world.grid.distance(settler.toPoint, post.point)).toBe(1);
    }
    expect(new Set(turnedOut.map((settler) => settler.toPoint)).size).toBe(turnedOut.length);

    // And a beat apart: no two of them finish that first step on the same tick.
    const arrivals = turnedOut.map((settler) => settler.stepLength - settler.stepProgress);
    expect(new Set(arrivals).size).toBe(arrivals.length);
  });

  it('lets a man with nowhere to go wander, and then lose him', () => {
    const sim = contested();
    const hall = sim.buildings.require(sim.players[0]!.headquarters);

    // A soldier of the player's, and not a store of his own left anywhere.
    const stray = sim.settlers.add(
      (id) =>
        ({
          id,
          owner: PLAYER,
          profession: Profession.Soldier,
          rank: Rank.Private,
          state: SettlerState.Idle,
          point: hall.flagPoint,
          fromPoint: hall.flagPoint,
          toPoint: hall.flagPoint,
          path: [],
          pathIndex: 0,
          stepProgress: 0,
          stepLength: 8,
        }) as unknown as Settler,
    );
    reachIn(sim).destroyBuilding(hall);

    reachIn(sim).sendHome(stray);
    expect(stray.state).toBe(SettlerState.Lost);

    // He walks about rather than blinking out where he stood...
    const seen = new Set<number>();
    for (let i = 0; i < 120 && sim.settlers.get(stray.id); i += 1) {
      sim.update();
      seen.add(stray.point);
    }
    expect(seen.size).toBeGreaterThan(1);

    // ...and then he is gone.
    run(sim, 300);
    expect(sim.settlers.get(stray.id)).toBeUndefined();
  });

  it('leaves no flag standing where a flag could not be put', () => {
    const sim = contested();
    const home = sim.buildings.require(sim.players[0]!.headquarters);
    const post = baseBeyond(sim, home.point, 3);

    // Flags out at the very edge of what the hall holds. While the post stands
    // beyond them they are well inside a continuous province; once it comes
    // down the border falls back onto them, and a flag may not stand on a
    // border node — which is the watchtower case from the save.
    // Outermost ring first. Flags will not stand next to one another, so
    // working outwards fills the ring at twelve and leaves the one at thirteen
    // — the ring that becomes the border — with nowhere to go. It is the ring
    // at thirteen this test is about.
    const outward = (a: number, b: number) =>
      sim.world.grid.distance(home.point, b) - sim.world.grid.distance(home.point, a) || a - b;

    const edge: number[] = [];
    for (const point of sim.world.grid.pointsWithin(home.point, HALL_REACH).sort(outward)) {
      if (sim.world.grid.distance(home.point, point) < HALL_REACH - 1) continue;
      if (!canPlaceFlag(sim.world, point, PLAYER)) continue;
      if (sim.placeFlag(PLAYER, point).ok) edge.push(point);
    }
    expect(edge.length).toBeGreaterThan(0);
    for (const point of edge) expect(sim.world.flag[point]).not.toBe(0);

    expect(sim.demolishBuilding(PLAYER, post.point).ok).toBe(true);

    // Every one of them that now sits on the line has gone, and none of them
    // has taken ground with it: they were the player's before and are still.
    let onTheLine = 0;
    for (const point of edge) {
      if (isWellInsideTerritory(sim.world, point, PLAYER)) continue;
      onTheLine += 1;
      expect(sim.world.flag[point]).toBe(0);
    }
    expect(onTheLine).toBeGreaterThan(0);

    // And nothing anywhere is left where the rules would not have allowed it.
    for (const flag of sim.flags.all()) {
      if (flag.building !== 0) continue;
      expect(isWellInsideTerritory(sim.world, flag.point, flag.owner)).toBe(true);
    }
    for (const road of sim.roads.all()) {
      for (const point of road.points) expect(sim.world.owner[point]).toBe(road.owner);
    }
  });

  it('keeps a clear node around a large building before the border starts', () => {
    const sim = contested();
    const home = sim.buildings.require(sim.players[0]!.headquarters);

    // A farm is large, and unlike a fortress it holds no ground of its own.
    // Out at the edge of the hall's claim, where the border would otherwise run
    // against its wall.
    let farm: Building | undefined;
    for (const point of [...sim.world.grid.pointsWithin(home.point, HALL_REACH)].reverse()) {
      const space = evaluateBuildSpace(sim.world, point, PLAYER);
      if (space === BuildSpace.None || !canHostSize(space, BuildingSize.Castle)) continue;
      farm = reachIn(sim).createBuilding(BuildingType.Farm, point, PLAYER);
      if (farm) break;
    }
    expect(farm).toBeDefined();
    farm!.state = BuildingState.Complete;

    // Take the ground around it away, then work the border out again.
    for (const point of sim.world.grid.pointsWithin(farm!.point, 1)) {
      if (point === farm!.point) continue;
      sim.world.owner[point] = 0;
    }
    const post = baseNear(sim, home.point, 3, 6, 9);
    holdIt(sim, post);

    // Its own node, its flag, and the whole ring about it are the player's.
    expect(sim.world.owner[farm!.point]).toBe(PLAYER);
    expect(sim.world.owner[farm!.flagPoint]).toBe(PLAYER);
    for (const point of sim.world.grid.pointsWithin(farm!.point, 1)) {
      expect(sim.world.owner[point]).toBe(PLAYER);
    }
  });

  it('keeps a border two nodes clear of a headquarters, whoever has taken what', () => {
    const sim = contested();
    const theirs = sim.buildings.require(sim.players[1]!.headquarters);

    // A post of the player's as near the rival's hall as the ground allows,
    // manned. Under the old rule its grip reached two nodes and took ground off
    // the hall's own doorstep.
    const post = baseNear(sim, theirs.point, 0, 4, 6);
    holdIt(sim, post);

    // Nothing of anybody else's within two nodes of the hall.
    for (const point of sim.world.grid.pointsWithin(theirs.point, 2)) {
      expect(sim.world.owner[point]).toBe(RIVAL);
    }

    // And so no border line can run in its first ring: a border node is one
    // whose neighbours are not all its owner's, which is exactly what
    // `canPlaceFlag` refuses to build on.
    for (const point of sim.world.grid.pointsWithin(theirs.point, 1)) {
      expect(isWellInsideTerritory(sim.world, point, RIVAL)).toBe(true);
    }
  });

  it('holds a hall’s second ring against everything the rival can bring', () => {
    const sim = contested();
    const hall = sim.buildings.require(sim.players[0]!.headquarters);

    // Rival posts crowded as near the player's hall as the ground allows, and
    // manned: together they push harder on some of the hall's own second ring
    // than the hall does, which is the only way that ring is ever in question.
    const planted: Building[] = [];
    for (const type of [BuildingType.Fortress, BuildingType.WatchTower, BuildingType.Barracks]) {
      const size = buildingInfo(type).size;
      for (const point of sim.world.grid.pointsWithin(hall.point, 7)) {
        if (sim.world.grid.distance(hall.point, point) < 4) continue;
        // The ground has to be his to build on, as it would be if he had pushed
        // his frontier this far — the same reach-in `baseNear` uses.
        for (const near of sim.world.grid.pointsWithin(point, 1)) sim.world.owner[near] = RIVAL;

        const space = evaluateBuildSpace(sim.world, point, RIVAL);
        if (space === BuildSpace.None || !canHostSize(space, size)) continue;
        const built = reachIn(sim).createBuilding(type, point, RIVAL);
        if (!built) continue;
        built.state = BuildingState.Complete;
        built.status = BuildingStatus.Working;
        built.garrison[Rank.Private] = 2;
        planted.push(built);
        break;
      }
    }
    // However many of the three the ground will take — what matters is that
    // between them they out-push the hall somewhere on its second ring.
    expect(planted.length).toBeGreaterThan(1);
    for (const post of planted) holdIt(sim, post);

    /** What everybody manned brings to bear on a node, by player. */
    const pushOn = (point: number): Map<number, number> => {
      const push = new Map<number, number>();
      for (const building of sim.buildings.all()) {
        const behaviour = buildingInfo(building.type).behaviour;
        const reach =
          behaviour.kind === 'headquarters'
            ? HALL_REACH
            : behaviour.kind === 'military' && garrisonStrength(building.garrison) > 0
              ? behaviour.radius
              : 0;
        const away = sim.world.grid.distance(building.point, point);
        if (reach <= 0 || away > reach) continue;
        push.set(building.owner, (push.get(building.owner) ?? 0) + reach - away + 1);
      }
      return push;
    };

    // The nodes of the hall's second ring the rival genuinely out-pushes: they
    // stay the player's, because two rings are the hall's whatever is brought
    // to bear on them.
    const outPushed = sim.world.grid
      .pointsWithin(hall.point, 2)
      .filter((point) => (pushOn(point).get(RIVAL) ?? 0) > (pushOn(point).get(PLAYER) ?? 0));
    expect(outPushed.length).toBeGreaterThan(0);
    for (const point of outPushed) expect(sim.world.owner[point]).toBe(PLAYER);

    // And so the first ring is well inside, with no border running through it.
    for (const point of sim.world.grid.pointsWithin(hall.point, 1)) {
      expect(isWellInsideTerritory(sim.world, point, PLAYER)).toBe(true);
    }
  });

  it('dates a captured post from the day it changed hands', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    // Manned long before the fight, as the rival's posts all are.
    expect(target.mannedAt).toBe(0);
    target.mannedAt = 1;

    const post = baseNear(sim, target.point, 4);
    holdIt(sim, post);
    for (let tick = 0; tick < 200 && sim.tick < 40; tick += 1) sim.update();

    expect(sim.attack(PLAYER, target.point, 4).ok).toBe(true);
    for (let tick = 0; tick < 3000 && target.owner !== PLAYER; tick += 1) sim.update();
    expect(target.owner).toBe(PLAYER);

    // As old as the day it became his, and not a tick older.
    const taken = target.mannedAt;
    expect(taken).toBeGreaterThan(1);

    // And it keeps that date through being emptied and filled again: it is the
    // same post, and it has not changed hands.
    for (let tick = 0; tick < 3000 && garrisonStrength(target.garrison) === 0; tick += 1) {
      sim.update();
    }
    expect(garrisonStrength(target.garrison)).toBeGreaterThan(0);
    target.garrison.fill(0);
    const soldier = sim.settlers.add(
      (id) =>
        ({
          id,
          owner: PLAYER,
          profession: Profession.Soldier,
          rank: Rank.Private,
          building: target.id,
          state: SettlerState.WalkingToJob,
        }) as Settler,
    );
    reachIn(sim).joinGarrison(soldier);
    expect(target.mannedAt).toBe(taken);
  });

  it('counts a hall as manned from the beginning, whatever its own book says', () => {
    const sim = contested();
    const hall = sim.buildings.require(sim.players[0]!.headquarters);
    const post = baseNear(sim, hall.point, 3, 6, 9);
    holdIt(sim, post);

    hall.mannedAt = 500;
    post.mannedAt = 500;

    expect(reachIn(sim).claimOf(hall, false)?.mannedAt).toBe(0);
    expect(reachIn(sim).claimOf(post, false)?.mannedAt).toBe(500);
  });

  it('settles a dead heat by incumbency, then by who has held his place longest', () => {
    const sim = contested();
    const claim = (player: number, mannedAt: number, radius = 8): Claim => ({
      building: player * 10 + mannedAt,
      point: sim.buildings.require(sim.players[0]!.headquarters).point,
      radius,
      mannedAt,
      player,
    });
    const here = sim.buildings.require(sim.players[0]!.headquarters).point;
    const decide = (claimants: readonly Claim[], incumbent: number): number =>
      reachIn(sim).strongestClaimTo(here, claimants, incumbent);

    // Pressure first, and it is a sum: two of the player's small claims beat
    // one bigger one of the rival's that beats either of them alone.
    expect(decide([claim(PLAYER, 0, 6), claim(RIVAL, 0, 9)], 0)).toBe(RIVAL);
    expect(decide([claim(PLAYER, 0, 6), claim(PLAYER, 0, 6), claim(RIVAL, 0, 9)], 0)).toBe(PLAYER);

    // A dead heat goes to whoever holds it already, either way round — and
    // holding it beats having held your place longer.
    expect(decide([claim(PLAYER, 0), claim(RIVAL, 0)], RIVAL)).toBe(RIVAL);
    expect(decide([claim(PLAYER, 0), claim(RIVAL, 0)], PLAYER)).toBe(PLAYER);
    expect(decide([claim(PLAYER, 40), claim(RIVAL, 10)], PLAYER)).toBe(PLAYER);
    expect(decide([claim(PLAYER, 10), claim(RIVAL, 40)], RIVAL)).toBe(RIVAL);

    // With nobody holding it, to whoever has held his place longest.
    expect(decide([claim(PLAYER, 40), claim(RIVAL, 10)], 0)).toBe(RIVAL);
    expect(decide([claim(PLAYER, 10), claim(RIVAL, 40)], 0)).toBe(PLAYER);

    // And only then the lower id.
    expect(decide([claim(PLAYER, 10), claim(RIVAL, 10)], 0)).toBe(PLAYER);
  });

  it('keeps a post five nodes clear of a headquarters', () => {
    const sim = contested();
    const hall = sim.buildings.require(sim.players[0]!.headquarters);

    for (const point of sim.world.grid.pointsWithin(hall.point, 4)) {
      // Its own node answers about everything *else* nearby, and there is
      // nothing else; a building stands there anyway.
      if (point === hall.point) continue;
      expect(canPlaceOutpost(sim.world, point, PLAYER)).toBe(false);
    }

    // And five out it is only the ordinary rules that can refuse him.
    const clear = sim.world.grid
      .pointsWithin(hall.point, 6)
      .filter((point) => sim.world.grid.distance(hall.point, point) >= 5);
    expect(clear.some((point) => canPlaceOutpost(sim.world, point, PLAYER))).toBe(true);
  });

  it('leaves no single dots hanging off a border', () => {
    const thin = (sim: Simulation): number[] => {
      const found: number[] = [];
      for (let point = 0; point < sim.world.owner.length; point += 1) {
        const owner = sim.world.owner[point];
        if (owner === 0) continue;

        let same = 0;
        for (const near of sim.world.grid.pointsWithin(point, 1)) {
          if (near !== point && sim.world.owner[near] === owner) same += 1;
        }
        if (same >= 3) continue;

        // A building keeps a guaranteed ring, handed back after the sweep with
        // nothing allowed to undo it. Where somebody else's ring reaches a node
        // next door, it takes that node out from under this one and leaves it
        // looking thin — the keep rule working, not a border half drawn.
        const pinched = sim.buildings.all().some((building) => {
          if (building.owner === owner) return false;
          const keep = buildingInfo(building.type).size === BuildingSize.Castle ? 2 : 1;
          return sim.world.grid.distance(point, building.point) <= keep + 1;
        });

        if (!pinched) found.push(point);
      }
      return found;
    };

    // A claim is a hexagon and a hexagon has corners; where two of them meet,
    // the corners come to a point one row wide and draw as a lone dot. A fresh
    // island is every border the game lays down of its own accord.
    const sim = contested();
    expect(thin(sim)).toEqual([]);

    // And after a capture, across the ground the capture worked out. Only that
    // ground, and only the part of it the simulation itself owns: `baseNear`
    // paints by hand on every site it tries, and paint is not a border the game
    // ever drew. Which nodes those are is noted rather than guessed at, since
    // where the harness happens to paint moves with the map.
    const target = outpostsOf(sim, RIVAL)[0]!;
    const before = Uint8Array.from(sim.world.owner);
    baseNear(sim, target.point, 8);
    const painted = new Set<number>();
    for (let point = 0; point < before.length; point += 1) {
      if (before[point] !== sim.world.owner[point]) painted.add(point);
    }

    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);
    fightItOut(sim);
    run(sim, 200);

    const worked = new Set(sim.world.grid.pointsWithin(target.point, 6));
    expect(thin(sim).filter((point) => worked.has(point) && !painted.has(point))).toEqual([]);
  });

  it('clears what falls outside the border when a post comes down', () => {
    const sim = contested();
    const home = sim.buildings.require(sim.players[0]!.headquarters);
    const post = baseBeyond(sim, home.point, 3);

    // A hut and a flag of the player's out beyond the hall, standing on ground
    // only this post holds.
    const outside = (point: number): boolean =>
      sim.world.grid.distance(home.point, point) > HALL_REACH &&
      sim.world.grid.distance(post.point, point) <= 6;
    const hut = hutOn(sim, PLAYER, sim.world.grid.pointsWithin(post.point, 6).filter(outside));
    const flagPoint = sim.world.grid
      .pointsWithin(post.point, 7)
      .find((point) => outside(point) && canPlaceFlag(sim.world, point, PLAYER));
    expect(flagPoint).toBeDefined();
    expect(sim.placeFlag(PLAYER, flagPoint!).ok).toBe(true);

    const roads = sim.roads.all().length;
    expect(sim.demolishBuilding(PLAYER, post.point).ok).toBe(true);

    // The ground has gone back to nobody, so nothing of his is left on it.
    expect(sim.world.owner[hut.point]).toBe(0);
    expect(sim.buildings.get(hut.id)).toBeUndefined();
    expect(sim.world.flag[flagPoint!]).toBe(0);
    for (const road of sim.roads.all()) {
      for (const point of road.points) expect(sim.world.owner[point]).toBe(road.owner);
    }
    expect(sim.roads.all().length).toBeLessThanOrEqual(roads);
  });

  it('marches the men out by their own flag', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 4);

    // Whichever way he is headed, the route out starts on the doorstep. Asked
    // of every direction rather than the one the ground happened to give, since
    // a march that sets off towards the flag anyway proves nothing.
    let routes = 0;
    for (const somewhere of sim.world.grid.pointsWithin(post.point, 4)) {
      if (somewhere === post.point || somewhere === post.flagPoint) continue;
      const route = reachIn(sim).pathOutOf(post, somewhere);
      if (!route || route.length === 0) continue;
      expect(route[0]).toBe(post.flagPoint);
      routes += 1;
    }
    expect(routes).toBeGreaterThan(10);

    // And on the map, the first step off the door really is the doorstep.
    expect(sim.attack(PLAYER, target.point, 3).ok).toBe(true);
    const steps = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      sim.update();
      for (const settler of sim.settlers.all()) {
        if (settler.fromPoint === post.point && settler.toPoint !== post.point) {
          steps.add(settler.toPoint);
        }
      }
    }

    expect(steps.size).toBeGreaterThan(0);
    expect([...steps]).toEqual([post.flagPoint]);
  });

  it('walks the men into what they have taken, one at a time and no more than it holds', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const behaviour = buildingInfo(target.type).behaviour;
    if (behaviour.kind !== 'military') throw new Error('the rival holds something odd');
    const capacity = behaviour.garrison;

    const post = baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);

    let taken = -1;
    let twoOnTheWay = 0;
    let emptyOnCapture = true;

    for (let i = 0; i < 1500; i += 1) {
      sim.update();
      const held = sim.buildings.get(target.id);
      if (taken < 0 && held?.owner === PLAYER) {
        taken = i;
        // Taken is not held: it stands empty until somebody is inside it, so
        // the ground goes over when a man is in and not a moment before.
        emptyOnCapture = garrisonStrength(held.garrison) === 0;
      }
      if (taken >= 0) {
        const walkingIn = sim.settlers
          .all()
          .filter(
            (settler) =>
              settler.state === SettlerState.WalkingToJob && settler.building === target.id,
          );
        if (walkingIn.length > 1) twoOnTheWay += 1;
        if (walkingIn.length === 0 && atWar(sim).length === 0) break;
      }
    }
    // The men over have a walk back ahead of them.
    run(sim, 300);

    expect(taken).toBeGreaterThan(0);
    expect(emptyOnCapture).toBe(true);
    expect(twoOnTheWay).toBe(0);

    // Filled to what it holds and no further, and the men over walked back to
    // the post they marched out of rather than vanishing.
    const held = sim.buildings.require(target.id);
    expect(garrisonStrength(held.garrison)).toBe(capacity);
    expect(garrisonStrength(post.garrison)).toBeGreaterThan(1);
  });

  it('conjures nobody and loses nobody taking a post', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);

    const before = soldiers(sim, PLAYER) + soldiers(sim, RIVAL);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);
    fightItOut(sim);
    run(sim, 200);

    // Men die in a fight and nowhere else, and the walk in is not a fight.
    const after = soldiers(sim, PLAYER) + soldiers(sim, RIVAL);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(before - 15);
    expect(atWar(sim)).toHaveLength(0);
  });

  it('sizes a garrison against the border the moment it moves', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    const post = baseNear(sim, target.point, 8);

    // Which posts look across at somebody is what decides how many men each of
    // them wants, and it used to be worked out only on the sweep beat — so a
    // post that had just won a fight sized itself against a border several
    // seconds out of date. Emptied here and checked without running a tick, so
    // it is the redraw that fills it and not the beat.
    const frontier = (reachIn(sim) as unknown as { frontierPosts: Set<number> }).frontierPosts;
    frontier.clear();

    holdIt(sim, post);

    expect(frontier.size).toBeGreaterThan(0);
    expect(frontier.has(post.id)).toBe(true);
  });

  it('tears a road that has been left running over ground its owner lost', () => {
    const sim = contested();
    const home = sim.buildings.require(sim.players[0]!.headquarters);
    const post = baseBeyond(sim, home.point, 3);

    // A road of the player's whose two flags stand on ground the hall holds,
    // but whose middle only the post holds. Both flags survive the post coming
    // down, so nothing else can take this road with it — only the sweep can.
    const onlyThePost = (point: number): boolean =>
      sim.world.owner[point] === PLAYER && sim.world.grid.distance(home.point, point) > HALL_REACH;

    let laid: number[] | undefined;
    for (const middle of sim.world.grid.pointsWithin(post.point, 6)) {
      if (!onlyThePost(middle)) continue;

      // Two steps out either side, so the flags are far enough apart to stand.
      const legs: number[][] = [];
      for (const step of sim.world.grid.pointsWithin(middle, 1)) {
        if (step === middle || sim.world.owner[step] !== PLAYER) continue;
        for (const end of sim.world.grid.pointsWithin(step, 1)) {
          if (end === step || end === middle) continue;
          if (sim.world.grid.distance(middle, end) !== 2) continue;
          if (sim.world.grid.distance(home.point, end) > HALL_REACH) continue;
          if (sim.world.owner[end] !== PLAYER) continue;
          if (!canPlaceFlag(sim.world, end, PLAYER)) continue;
          legs.push([end, step]);
        }
      }

      const pair = legs.flatMap((a) =>
        legs
          .filter(
            (b) =>
              a[0] !== b[0] && a[1] !== b[1] && sim.world.grid.distance(a[0]!, b[0]!) >= 2,
          )
          .map((b) => [a, b] as const),
      )[0];
      if (!pair) continue;

      const [left, right] = pair;
      if (!sim.placeFlag(PLAYER, left[0]!).ok) continue;
      if (!sim.placeFlag(PLAYER, right[0]!).ok) continue;
      const points = [left[0]!, left[1]!, middle, right[1]!, right[0]!];
      if (!sim.placeRoad(PLAYER, points).ok) continue;
      laid = points;
      break;
    }
    expect(laid).toBeDefined();

    const road = sim.roads.all().find((r) => r.points.includes(laid![2]!));
    expect(road).toBeDefined();

    expect(sim.demolishBuilding(PLAYER, post.point).ok).toBe(true);

    // The middle has gone back to nobody, so the road over it goes too.
    expect(sim.world.owner[laid![2]!]).toBe(0);
    expect(sim.roads.get(road!.id)).toBeUndefined();

    // And nothing anywhere is left running over ground its owner has lost —
    // the invariant the sweep exists for, whichever way a given road goes.
    for (const other of sim.roads.all()) {
      for (const point of other.points) expect(sim.world.owner[point]).toBe(other.owner);
    }
  });

  it('carries the men waiting to walk in through a save', () => {
    const sim = contested();
    const target = outpostsOf(sim, RIVAL)[0]!;
    baseNear(sim, target.point, 8);
    expect(sim.attack(PLAYER, target.point, 7).ok).toBe(true);

    let ready = false;
    for (let i = 0; i < 1500 && !ready; i += 1) {
      sim.update();
      ready = sim.settlers
        .all()
        .some((settler) => settler.state === SettlerState.WaitingToEnter);
    }
    expect(ready).toBe(true);

    const restored = Simulation.fromSnapshot(sim.toSnapshot());
    expect(
      restored.settlers.all().filter((s) => s.state === SettlerState.WaitingToEnter).length,
    ).toBe(sim.settlers.all().filter((s) => s.state === SettlerState.WaitingToEnter).length);
    expect(restored.settlers.all().map((s) => s.homePost).sort()).toEqual(
      sim.settlers.all().map((s) => s.homePost).sort(),
    );

    // And they go in rather than standing outside for ever.
    run(restored, 400);
    expect(garrisonStrength(restored.buildings.require(target.id).garrison)).toBeGreaterThan(0);
  });
});
