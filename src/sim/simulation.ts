import { Direction, DIRECTIONS } from './core/direction';
import { OUT_OF_BOUNDS } from './core/grid';
import { Hasher } from './core/hash';
import { Rng } from './core/rng';
import type { BuildingInfo, BuildingType } from './data/buildings';
import { BuildingType as Type, buildingInfo } from './data/buildings';
import { Profession, professionInfo } from './data/professions';
import { Ware, WARE_COUNT } from './data/wares';
import type { PoolSnapshot } from './core/pool';
import { EntityTable } from './entities/registry';
import type { Building, Flag, Road, Settler, WareParcel } from './entities/types';
import {
  BuildingState,
  BuildingStatus,
  FLAG_CAPACITY,
  SettlerState,
  STEP_TICKS,
} from './entities/types';
import { FlagNetwork } from './transport/flag-graph';
import { roadPointPath, walkablePath } from './transport/pathfinding';
import {
  chooseDestination,
  INPUT_STOCK_LIMIT,
  isStore,
  outstandingDemand,
  willAccept,
} from './transport/dispatch';
import {
  BuildSpace,
  canHostSize,
  canPlaceFlag,
  canRouteRoadThrough,
  canTraverseEdge,
  evaluateBuildSpace,
  FLAG_DIRECTION,
} from './world/buildspace';
import {
  FIELD_FULLY_GROWN,
  MapObject,
  Resource,
  RESOURCE_NAMES,
  TREE_FULLY_GROWN,
} from './world/terrain';
import type { World } from './world/world';
import { generateWorld } from './world/worldgen';

/** Simulation ticks per second of game time. */
export const TICKS_PER_SECOND = 20;

/** How far the headquarters claims territory on the first day. */
const HEADQUARTERS_RADIUS = 9;

/** Saplings advance one growth stage every this many ticks. */
const TREE_GROWTH_INTERVAL = 260;

/**
 * Corn advances one growth stage every this many ticks.
 *
 * Four times slower than it first was: a farm that turned its fields over
 * every few seconds made grain far too cheap for a crop that feeds the mills,
 * bakeries, breweries and stockyards downstream of it.
 */
const FIELD_GROWTH_INTERVAL = 600;

/** How far from its shaft a mine can work the seam. */
const SEAM_RADIUS = 2;

/** How far from the flag he set out from a geologist works the ground. */
const GEOLOGIST_RANGE = 4;

/**
 * How far a settler in open country will look for a flag to join the roads at
 * on his way home. Wide enough to cover a geologist's patch and the walk to it.
 */
const NEAREST_FLAG_RANGE = 12;

/**
 * Ticks spent hammering at one outcrop.
 *
 * Kept short on purpose. At two minutes of game time this looked for all the
 * world like a settler who had hung: he stood stock still, and the find was
 * announced only once he had finished. Six seconds reads as work.
 */
const GEOLOGIST_WORK_TICKS = 30;

/** How many spots a geologist will try before giving one up as unreachable. */
const GEOLOGIST_TRIES = 8;

/** How often stranded wares are given a new destination. */
const STRANDED_SWEEP_INTERVAL = 40;

/** How many messages are kept before the oldest are dropped. */
const MESSAGE_LIMIT = 64;

/**
 * How near a previous find of the same thing has to be for a fresh one to go
 * unreported. A geologist works a patch of four, so this covers a seam without
 * hiding a genuinely separate one on the next hill.
 */
const SURVEY_MESSAGE_SPREAD = 3;

/**
 * How much of its own flag a store will fill with goods going out, leaving the
 * rest free for whatever is being brought back to it.
 */
const STORE_DISPATCH_LIMIT = Math.floor(FLAG_CAPACITY / 2);

/**
 * How long a building must find nothing before it says so — two full minutes at
 * five ticks a second. Short of that it is simply between trips.
 */
const EXHAUSTED_REPORT_TICKS = 600;

/**
 * How long a worker rests indoors between trips out.
 *
 * A woodcutter who turned straight round and left again read as frantic rather
 * than industrious. Twelve seconds of quiet is enough to see the door close
 * behind him and open again, which is what makes the cycle legible.
 */
const WORKER_REST_TICKS = 60;

/** Wares and settlers a player begins with. */
const STARTING_STOCK: readonly { ware: Ware; count: number }[] = [
  { ware: Ware.Board, count: 24 },
  { ware: Ware.Stone, count: 18 },
  { ware: Ware.Log, count: 8 },
  { ware: Ware.Axe, count: 4 },
  { ware: Ware.Saw, count: 2 },
  { ware: Ware.PickAxe, count: 4 },
  { ware: Ware.Shovel, count: 3 },
  { ware: Ware.Hammer, count: 6 },
  { ware: Ware.FishingRod, count: 2 },
  // Enough of the specialist tools to open each new trade once. Replacing them
  // is what the metalworks is for; until one is built these are all there is.
  { ware: Ware.Scythe, count: 2 },
  { ware: Ware.Crucible, count: 2 },
  { ware: Ware.RollingPin, count: 1 },
  { ware: Ware.Cleaver, count: 1 },
  { ware: Ware.Fish, count: 8 },
];

const STARTING_SETTLERS = 32;

/** How often a new settler turns up at the headquarters. */
const POPULATION_INTERVAL = 600;

/** How many more people each finished building lets a province support. */
const SETTLERS_PER_BUILDING = 3;

/**
 * What a message is about. The category decides how a message is shown and,
 * more importantly, which earlier messages it counts as a repeat of.
 */
export const MessageCategory = {
  Built: 'built',
  Territory: 'territory',
  Survey: 'survey',
  Coal: 'coal',
  Iron: 'iron',
  Gold: 'gold',
  Granite: 'granite',
  Water: 'water',
  Exhausted: 'exhausted',
} as const;

export type MessageCategory = (typeof MessageCategory)[keyof typeof MessageCategory];

/** Something worth telling the player about, and where it happened. */
export interface GameMessage {
  readonly text: string;
  readonly category: MessageCategory;
  /** Where on the map it happened, or -1 when it has no place. */
  readonly point: number;
  readonly tick: number;
}

/** What a building has actually run out of, in its own terms. */
const EXHAUSTED_REASON: Readonly<Record<string, string>> = {
  harvest: 'nothing left to cut within reach',
  plant: 'nowhere left to plant',
  farm: 'no ground left to sow',
  extract: 'the deposit is worked out',
};

/** A find of each resource gets its own category, so like is coalesced. */
const FIND_CATEGORY: Readonly<Partial<Record<Resource, MessageCategory>>> = {
  [Resource.Coal]: MessageCategory.Coal,
  [Resource.Iron]: MessageCategory.Iron,
  [Resource.Gold]: MessageCategory.Gold,
  [Resource.Granite]: MessageCategory.Granite,
  [Resource.Water]: MessageCategory.Water,
};

export interface PlayerConfig {
  readonly name: string;
  readonly colour: string;
}

export interface Player {
  readonly id: number;
  readonly name: string;
  readonly colour: string;
  headquarters: number;
}

export interface SimulationOptions {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly players: readonly PlayerConfig[];
}

/** The behaviours whose worker leaves the building to do the work. */
type FieldWork = Extract<
  BuildingInfo['behaviour'],
  { kind: 'harvest' } | { kind: 'plant' } | { kind: 'extract' } | { kind: 'farm' }
>;

/**
 * Bumped whenever the shape of a saved game changes.
 *
 * Version 2 added ripening fields and a geologist's survey counter; version 3
 * replaced that counter with the flag whose ground he is working; version 4
 * added how long a building has been finding nothing. Older saves still load:
 * `fromSnapshot` fills in whatever they predate.
 */
export const SAVE_VERSION = 4;

/** The parts of the map that play can change, and so must be saved. */
export interface MapSnapshot {
  readonly object: Uint8Array;
  readonly objectData: Uint8Array;
  readonly resource: Uint8Array;
  readonly resourceAmount: Uint8Array;
  readonly resourceKnown: Uint8Array;
  readonly owner: Uint8Array;
  readonly roads: Uint8Array;
  readonly building: Int32Array;
  readonly flag: Int32Array;
}

interface TableSnapshot<T> {
  readonly pool: PoolSnapshot;
  readonly items: readonly T[];
}

export interface SimulationSnapshot {
  readonly version: number;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly tick: number;
  readonly rng: number;
  readonly players: readonly Player[];
  readonly map: MapSnapshot;
  readonly flags: TableSnapshot<Flag>;
  readonly roads: TableSnapshot<Road>;
  readonly buildings: TableSnapshot<Building>;
  readonly settlers: TableSnapshot<Settler>;
  readonly growingTrees: readonly number[];
  /** Absent in version 1 saves, which predate farms. */
  readonly growingFields?: readonly number[];
  readonly events: readonly GameMessage[];
}

export type CommandResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: CommandResult = { ok: true };
const fail = (reason: string): CommandResult => ({ ok: false, reason });

/**
 * The whole game world and the rules that move it forward.
 *
 * Nothing here touches the DOM, the clock or `Math.random`: a simulation is a
 * pure function of its seed and the commands it has been given. That is what
 * makes saves small, replays exact, and the golden tests meaningful.
 */
export class Simulation {
  readonly world: World;
  readonly flags = new EntityTable<Flag>();
  readonly roads = new EntityTable<Road>();
  readonly buildings = new EntityTable<Building>();
  readonly settlers = new EntityTable<Settler>();
  readonly network: FlagNetwork;
  readonly players: Player[] = [];

  readonly seed: number;
  tick = 0;

  /** Recent notices for the message ticker, newest last. */
  readonly events: GameMessage[] = [];

  private rng: Rng;
  /** Points holding a sapling that has not finished growing. */
  private growingTrees: number[] = [];
  /** Points holding corn that has not finished ripening. */
  private growingFields: number[] = [];

  private constructor(world: World, seed: number) {
    this.world = world;
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x51ed270b);
    this.network = new FlagNetwork(this.flags, this.roads);
  }

  // ------------------------------------------------------------- creation

  static create(options: SimulationOptions): Simulation {
    const { world, startPoints } = generateWorld({
      width: options.width,
      height: options.height,
      seed: options.seed,
      players: options.players.length,
    });

    const simulation = new Simulation(world, options.seed);

    options.players.forEach((config, slot) => {
      const id = slot + 1;
      simulation.players.push({ id, name: config.name, colour: config.colour, headquarters: 0 });

      const point = startPoints[slot]!;
      simulation.claimTerritory(point, HEADQUARTERS_RADIUS, id);

      const headquarters = simulation.createBuilding(Type.Headquarters, point, id);
      if (!headquarters) throw new Error('the generated start site could not take a headquarters');

      headquarters.state = BuildingState.Complete;
      headquarters.status = BuildingStatus.Working;
      for (const entry of STARTING_STOCK) {
        headquarters.stock[entry.ware] = (headquarters.stock[entry.ware] ?? 0) + entry.count;
      }
      headquarters.reserve = STARTING_SETTLERS;

      simulation.players[slot]!.headquarters = headquarters.id;
    });

    return simulation;
  }

  // ------------------------------------------------------------- commands

  /** Raises a flag on open ground. */
  placeFlag(player: number, point: number): CommandResult {
    if (!canPlaceFlag(this.world, point, player)) return fail('A flag cannot stand there.');
    this.createFlag(point, player);
    return OK;
  }

  /**
   * Lays a road along a list of lattice points. The first point must already
   * carry a flag; the last either carries one or gets one.
   */
  placeRoad(player: number, points: readonly number[]): CommandResult {
    if (points.length < 2) return fail('A road needs at least two points.');

    const start = points[0]!;
    const end = points[points.length - 1]!;

    const startFlag = this.world.flag[start];
    if (!startFlag) return fail('A road must start at a flag.');
    if (this.flags.require(startFlag).owner !== player) return fail('That flag is not yours.');

    if (start === end) return fail('A road cannot end where it began.');

    // Every step must be a real lattice edge the ground allows.
    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1]!;
      const current = points[i]!;

      const direction = DIRECTIONS.find(
        (candidate) => this.world.grid.neighbour(previous, candidate) === current,
      );
      if (direction === undefined) return fail('A road must follow neighbouring points.');
      if (!canTraverseEdge(this.world, previous, direction)) {
        return fail('The ground is too steep or too wet for a road.');
      }
      if (this.world.hasRoad(previous, direction)) return fail('A road already runs there.');
    }

    // Intermediate points must be clear of everything, including other roads.
    for (let i = 1; i < points.length - 1; i += 1) {
      if (!canRouteRoadThrough(this.world, points[i]!, player)) {
        return fail('The road cannot pass through there.');
      }
    }

    if (new Set(points).size !== points.length) return fail('A road cannot cross itself.');

    let endFlag = this.world.flag[end];
    if (!endFlag) {
      if (!canPlaceFlag(this.world, end, player)) return fail('A road must end at a flag.');
      endFlag = this.createFlag(end, player).id;
    } else if (this.flags.require(endFlag).owner !== player) {
      return fail('That flag is not yours.');
    }

    this.createRoad(player, [...points], startFlag, endFlag);
    return OK;
  }

  /** Starts a construction site. */
  placeBuilding(player: number, point: number, type: BuildingType): CommandResult {
    const info = buildingInfo(type);
    if (!info.available) return fail(`${info.name} cannot be built yet.`);

    const space = evaluateBuildSpace(this.world, point, player);
    if (space === BuildSpace.None) return fail('Nothing can be built there.');
    if (!canHostSize(space, info.size)) return fail(`There is not enough room for a ${info.name}.`);

    const building = this.createBuilding(type, point, player);
    if (!building) return fail(`A ${info.name} cannot be built there.`);
    return OK;
  }

  /** Tears down a building, returning its site to open ground. */
  demolishBuilding(player: number, point: number): CommandResult {
    const id = this.world.building[point];
    if (!id) return fail('There is no building there.');

    const building = this.buildings.require(id);
    if (building.owner !== player) return fail('That is not yours to demolish.');
    if (buildingInfo(building.type).behaviour.kind === 'headquarters') {
      return fail('The headquarters cannot be demolished.');
    }

    this.destroyBuilding(building);
    return OK;
  }

  /** Removes a flag, and with it every road that met there. */
  demolishFlag(player: number, point: number): CommandResult {
    const id = this.world.flag[point];
    if (!id) return fail('There is no flag there.');

    const flag = this.flags.require(id);
    if (flag.owner !== player) return fail('That is not yours to remove.');
    if (flag.building !== 0) return fail("A building's own flag cannot be removed.");

    this.destroyFlag(flag);
    return OK;
  }

  /** Removes the road passing through a point between two flags. */
  demolishRoad(player: number, point: number): CommandResult {
    const road = this.roads.find(
      (candidate) => candidate.owner === player && candidate.points.includes(point),
    );
    if (!road) return fail('There is no road there.');

    this.destroyRoad(road);
    return OK;
  }

  /**
   * Sends a geologist out from a flag to look for ore.
   *
   * The mountains are seeded with coal, iron, gold and granite from the first
   * tick, but none of it is visible. A mine sunk on a guess is a mine that
   * reports itself exhausted, so somebody has to go and look first.
   */
  sendGeologist(player: number, point: number): CommandResult {
    const flagId = this.world.flag[point];
    if (!flagId) return fail('Geologists set out from a flag.');

    const flag = this.flags.require(flagId);
    if (flag.owner !== player) return fail('That flag is not yours.');

    if (this.surveyTarget(point, point) === undefined) {
      return fail('There is nothing left to survey within reach of that flag.');
    }

    const tool = professionInfo(Profession.Geologist).tool;
    const store = this.supplierFor(player, flagId, tool);
    if (!store) return fail('No store can spare a geologist and a hammer.');

    const storeFlag = this.world.flag[store.flagPoint]!;
    const path = roadPointPath(this.network, this.roads, storeFlag, flagId);
    if (!path) return fail('No road runs from a store to that flag.');

    store.reserve -= 1;
    if (tool !== null) store.stock[tool] = store.stock[tool]! - 1;

    const settler = this.createSettler(player, Profession.Geologist, store.flagPoint);
    settler.surveyFrom = point;
    settler.state = SettlerState.WalkingToJob;
    this.setPath(settler, path);

    this.note('A geologist sets out.', MessageCategory.Survey, point);
    return OK;
  }

  // ------------------------------------------------------------ the tick

  /** Advances the world by one tick. */
  update(): void {
    this.tick += 1;

    this.updateSettlers();
    this.updateBuildings();
    this.updateRoads();
    this.growTrees();
    this.growFields();
    this.growPopulation();

    if (this.tick % STRANDED_SWEEP_INTERVAL === 0) this.retargetStrandedWares();
  }

  /**
   * New settlers arrive at the headquarters as time passes.
   *
   * The cap rises with the buildings a player has finished, so a province that
   * has actually been developed supports more people — and a long game cannot
   * quietly breed settlers without limit while nothing else changes.
   */
  private growPopulation(): void {
    if (this.tick % POPULATION_INTERVAL !== 0) return;

    for (const player of this.players) {
      const home = this.buildings.get(player.headquarters);
      if (!home || home.state !== BuildingState.Complete) continue;

      let finished = 0;
      this.buildings.forEach((building) => {
        if (building.owner === player.id && building.state === BuildingState.Complete) {
          finished += 1;
        }
      });

      const cap = STARTING_SETTLERS + finished * SETTLERS_PER_BUILDING;
      if (this.population(player.id) >= cap) continue;

      home.reserve += 1;
    }
  }

  // ------------------------------------------------------- entity helpers

  private createFlag(point: number, owner: number): Flag {
    const flag = this.flags.add((id) => ({
      id,
      point,
      owner,
      wares: [],
      roads: [],
      building: 0,
    }));

    this.world.flag[point] = flag.id;
    this.network.invalidate();

    // A flag raised on an existing road divides it in two.
    this.splitRoadAt(flag);

    return flag;
  }

  /**
   * Splits the road running through a newly raised flag into two stretches.
   *
   * This is what makes a flag mean anything in the middle of a road. Carriers
   * work one stretch each, so dividing a long haul at a flag puts a second
   * settler on the second half and shortens both their walks — and, just as
   * importantly, the new flag becomes a real node in the network that further
   * roads can branch from. Without this the flag would be an island: nothing
   * would connect through it, and anything built beyond it would sit
   * unreachable, never receiving a builder or a single board.
   *
   * The map itself is untouched. The same lattice edges are still roads; only
   * the entities describing them change.
   */
  private splitRoadAt(flag: Flag): void {
    const road = this.roads.find((candidate) => {
      const index = candidate.points.indexOf(flag.point);
      return index > 0 && index < candidate.points.length - 1;
    });
    if (!road) return;

    const index = road.points.indexOf(flag.point);
    const carrier = this.settlers.get(road.carrier);
    const retired = road.id;

    for (const endFlag of [road.fromFlag, road.toFlag]) {
      const end = this.flags.get(endFlag);
      if (!end) continue;
      const at = end.roads.indexOf(road.id);
      if (at >= 0) end.roads.splice(at, 1);
    }
    this.roads.remove(road.id);

    // Send home anyone still walking out to the road that has just gone, and do
    // it before the halves exist: entity ids are recycled, so a new road can be
    // handed the very id the old one just gave up.
    this.settlers.forEach((settler) => {
      if (settler.road === retired && settler.id !== carrier?.id) this.dismissSettler(settler.id);
    });

    const first = this.createRoad(
      road.owner,
      road.points.slice(0, index + 1),
      road.fromFlag,
      flag.id,
    );
    const second = this.createRoad(road.owner, road.points.slice(index), flag.id, road.toFlag);

    if (carrier) {
      // The carrier keeps the half it is standing on; `updateRoads` sends a
      // second settler out to the other half on the next tick.
      const half = first.points.includes(carrier.point) ? first : second;
      half.carrier = carrier.id;
      half.carrierRequested = false;
      carrier.road = half.id;

      if (carrier.carrying !== null) {
        // The new flag is an endpoint of both halves, so it is always a legal
        // place to hand the crate over; routing takes it onward from there.
        carrier.state = SettlerState.CarrierDelivering;
        carrier.taskPoint = flag.id;
        this.setPath(carrier, this.pathAlongRoad(half, carrier.point, flag.point) ?? []);
        if (carrier.path.length === 0) this.deliverWare(carrier);
      } else {
        carrier.state = SettlerState.CarrierWaiting;
        this.setPath(carrier, []);
      }
    }
  }

  private createRoad(player: number, points: number[], fromFlag: number, toFlag: number): Road {
    let cost = 0;
    for (let i = 1; i < points.length; i += 1) {
      const climb = Math.abs(this.world.height[points[i]!]! - this.world.height[points[i - 1]!]!);
      cost += 1 + climb;
    }

    const road = this.roads.add((id) => ({
      id,
      owner: player,
      points,
      fromFlag,
      toFlag,
      carrier: 0,
      carrierRequested: false,
      cost,
    }));

    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1]!;
      const direction = DIRECTIONS.find(
        (candidate) => this.world.grid.neighbour(previous, candidate) === points[i]!,
      );
      if (direction !== undefined) this.world.setRoad(previous, direction, true);
    }

    this.flags.require(fromFlag).roads.push(road.id);
    this.flags.require(toFlag).roads.push(road.id);
    this.network.invalidate();

    return road;
  }

  private createBuilding(type: BuildingType, point: number, owner: number): Building | undefined {
    const info = buildingInfo(type);

    const flagPoint = this.world.grid.neighbour(point, FLAG_DIRECTION);
    if (flagPoint === OUT_OF_BOUNDS) return undefined;

    if (this.world.flag[flagPoint] === 0) {
      if (!canPlaceFlag(this.world, flagPoint, owner)) return undefined;
      this.createFlag(flagPoint, owner);
    }

    const inputSlots = inputSlotCount(info);

    const building = this.buildings.add((id) => ({
      id,
      type,
      point,
      flagPoint,
      owner,
      state: BuildingState.UnderConstruction,
      worker: 0,
      workerRequested: false,
      delivered: info.cost.map(() => 0),
      incoming: info.cost.map(() => 0),
      buildProgress: 0,
      inputs: new Array<number>(inputSlots).fill(0),
      inputsIncoming: new Array<number>(inputSlots).fill(0),
      workTimer: 0,
      output: null,
      status: BuildingStatus.UnderConstruction,
      exhaustedFor: 0,
      stock: isStoreType(info) ? new Array<number>(WARE_COUNT).fill(0) : [],
      reserve: 0,
    }));

    this.world.building[point] = building.id;

    const flag = this.flags.require(this.world.flag[flagPoint]!);
    flag.building = building.id;

    return building;
  }

  private createSettler(owner: number, profession: Profession, point: number): Settler {
    return this.settlers.add((id) => ({
      id,
      owner,
      profession,
      state: SettlerState.Idle,
      point,
      fromPoint: point,
      toPoint: point,
      stepProgress: 0,
      stepLength: STEP_TICKS,
      path: [],
      pathIndex: 0,
      carrying: null,
      carryDestination: 0,
      building: 0,
      road: 0,
      taskPoint: 0,
      taskTimer: 0,
      surveyFrom: 0,
    }));
  }

  private destroyBuilding(building: Building): void {
    // Anything in the building's own stores is simply lost, as in the original.
    this.world.building[building.point] = 0;

    const flagId = this.world.flag[building.flagPoint];
    if (flagId) {
      const flag = this.flags.get(flagId);
      if (flag && flag.building === building.id) flag.building = 0;
    }

    if (building.worker) this.dismissSettler(building.worker);

    // Wares already on the road to a building that no longer exists need a new
    // home, or they would circle forever.
    this.retargetWaresBoundFor(building.id);

    this.buildings.remove(building.id);
  }

  private destroyFlag(flag: Flag): void {
    // A flag with a road on either side is a staging post, not a junction:
    // removing it should join the two stretches back together rather than tear
    // both down and cut off everything beyond.
    if (!this.mergeRoadsAt(flag)) {
      for (const roadId of [...flag.roads]) {
        const road = this.roads.get(roadId);
        if (road) this.destroyRoad(road);
      }
    }

    this.world.flag[flag.point] = 0;
    this.flags.remove(flag.id);
    this.network.invalidate();
  }

  /**
   * Rejoins the two roads meeting at a flag that is being removed — the
   * counterpart of `splitRoadAt`.
   *
   * Returns false, leaving the roads alone, when the flag is anything other
   * than a simple staging post between exactly two stretches.
   */
  private mergeRoadsAt(flag: Flag): boolean {
    if (flag.building !== 0 || flag.roads.length !== 2) return false;

    const first = this.roads.get(flag.roads[0]!);
    const second = this.roads.get(flag.roads[1]!);
    if (!first || !second || first.id === second.id) return false;

    // Orient the first stretch to end at the flag and the second to start
    // there, so the two point lists splice into one continuous road.
    const leading = first.toFlag === flag.id ? first.points : [...first.points].reverse();
    const leadingFar = first.toFlag === flag.id ? first.fromFlag : first.toFlag;
    const trailing = second.fromFlag === flag.id ? second.points : [...second.points].reverse();
    const trailingFar = second.fromFlag === flag.id ? second.toFlag : second.fromFlag;

    // A road from a flag back to itself is not a road.
    if (leadingFar === trailingFar) return false;

    // One stretch now needs one carrier; the spare goes back to the store.
    const keep = this.settlers.get(first.carrier) ?? this.settlers.get(second.carrier);
    const retired = [first.id, second.id];

    for (const road of [first, second]) {
      for (const endFlag of [road.fromFlag, road.toFlag]) {
        const end = this.flags.get(endFlag);
        if (!end) continue;
        const at = end.roads.indexOf(road.id);
        if (at >= 0) end.roads.splice(at, 1);
      }
      this.roads.remove(road.id);
    }

    // Both the spare carrier and anyone still walking out go home now, before
    // the merged road can be handed one of the ids just given up.
    this.settlers.forEach((settler) => {
      if (retired.includes(settler.road) && settler.id !== keep?.id) {
        this.dismissSettler(settler.id);
      }
    });

    const merged = this.createRoad(
      first.owner,
      [...leading, ...trailing.slice(1)],
      leadingFar,
      trailingFar,
    );

    if (keep) {
      merged.carrier = keep.id;
      keep.road = merged.id;
      keep.state = SettlerState.CarrierWaiting;
      this.setPath(keep, []);

      if (keep.carrying !== null) {
        // Deliver to whichever end of the joined road is nearer, then let
        // ordinary routing carry the crate on from there.
        const at = merged.points.indexOf(keep.point);
        const towardsStart = at >= 0 && at * 2 <= merged.points.length;
        const target = towardsStart ? merged.fromFlag : merged.toFlag;
        const targetFlag = this.flags.get(target);
        if (targetFlag) {
          keep.state = SettlerState.CarrierDelivering;
          keep.taskPoint = target;
          this.setPath(keep, this.pathAlongRoad(merged, keep.point, targetFlag.point) ?? []);
          if (keep.path.length === 0) this.deliverWare(keep);
        }
      }
    }

    // Crates waiting at the flag being removed move onto the joined road.
    for (const parcel of flag.wares) {
      const host = this.flags.get(merged.fromFlag) ?? this.flags.get(merged.toFlag);
      if (host && host.wares.length < FLAG_CAPACITY) host.wares.push(parcel);
    }
    flag.wares.length = 0;

    return true;
  }

  private destroyRoad(road: Road): void {
    for (let i = 1; i < road.points.length; i += 1) {
      const previous = road.points[i - 1]!;
      const direction = DIRECTIONS.find(
        (candidate) => this.world.grid.neighbour(previous, candidate) === road.points[i]!,
      );
      if (direction !== undefined) this.world.setRoad(previous, direction, false);
    }

    for (const flagId of [road.fromFlag, road.toFlag]) {
      const flag = this.flags.get(flagId);
      if (!flag) continue;
      const index = flag.roads.indexOf(road.id);
      if (index >= 0) flag.roads.splice(index, 1);
    }

    // The carrier is let go only once the road has really gone and the network
    // knows it. He works out his way home from where he stands, and that route
    // has to be through the country as it is now, not as it was a moment ago.
    const retired = road.id;
    this.roads.remove(retired);
    this.network.invalidate();

    // Everyone bound to this road goes, not just the man working it: a settler
    // still walking out to take up the post has to be sent home too. Entity ids
    // are recycled, so leaving him with a dead road's id in hand means he
    // arrives to find that id belongs to a road on the other side of the
    // province — and takes it over, standing nowhere near it. `splitRoadAt` and
    // `mergeRoadsAt` guard against exactly this; so does this.
    this.settlers.forEach((settler) => {
      if (settler.road === retired) this.dismissSettler(settler.id);
    });
  }

  /** Sends a settler back into the nearest store. */
  private dismissSettler(settlerId: number): void {
    const settler = this.settlers.get(settlerId);
    if (!settler) return;

    // A crate in hand is walked to a flag before he goes; `setDownAtFlag` sends
    // him home once it is down.
    if (this.carryCrateToNearestFlag(settler)) return;

    this.putDownCarriedWare(settler);
    this.sendHome(settler);
  }

  /**
   * Turns a dismissed carrier round and sends him home, leaving his crate at
   * the first flag on the way.
   *
   * He must not finish the delivery he was in the middle of. The road under him
   * has just gone; the flag he was walking to may no longer connect to anything,
   * and carrying on to it would strand the crate somewhere nothing can reach.
   * So the route is worked out backwards from where he is going *now* — the
   * nearest store — and the crate is set down at the first flag along it, which
   * puts it back on the network behind him.
   *
   * Returns false when he has nothing in hand, or when there is no store, no
   * route home, or no flag on the way with room for the crate; the caller then
   * puts it down where it stands, which at least does not destroy it.
   */
  private carryCrateToNearestFlag(settler: Settler): boolean {
    if (settler.carrying === null) return false;

    const from = this.committedPoint(settler);
    const store = this.nearestStore(settler.owner, from);
    if (!store) return false;

    const home = this.pathHome(from, store);
    if (!home) return false;

    for (const point of home) {
      const flagId = this.world.flag[point];
      const flag = flagId ? this.flags.get(flagId) : undefined;
      if (!flag || flag.wares.length >= FLAG_CAPACITY) continue;

      // He is nobody's worker now, so `setDownAtFlag` will send him home rather
      // than back through a door.
      settler.building = 0;
      settler.road = 0;
      return this.carryToFlag(settler, point);
    }

    return false;
  }

  /**
   * Sets down whatever a settler is holding before he leaves the job.
   *
   * Tearing up a road under a loaded carrier used to annihilate the crate and,
   * worse, leave its reservation standing at the far end: the destination went
   * on counting a ware that no longer existed, so `outstandingDemand` stayed
   * satisfied, nothing was ever reordered, and a building site waited for good.
   *
   * The crate is put on the nearest flag that will hold it. The reservation is
   * released either way — the ware has stopped being on its way, whether it
   * found a flag or was lost — so the destination can ask again.
   */
  private putDownCarriedWare(settler: Settler): void {
    const ware = settler.carrying;
    if (ware === null) {
      settler.carryDestination = 0;
      return;
    }

    const destination = settler.carryDestination;
    settler.carrying = null;
    settler.carryDestination = 0;

    this.releaseIncoming(destination, ware);

    // The flag he was headed for, then the ends of the road he worked: the
    // nearest place the crate can wait for somebody to pick it up again.
    const road = this.roads.get(settler.road);
    const candidates = [settler.taskPoint, road?.fromFlag ?? 0, road?.toFlag ?? 0];

    for (const flagId of candidates) {
      if (!flagId) continue;
      const flag = this.flags.get(flagId);
      if (!flag || flag.wares.length >= FLAG_CAPACITY) continue;

      const parcel: WareParcel = { ware, destination: 0 };
      // Give it a home again if one can be found; the stranded sweep will keep
      // trying if not.
      this.retarget(flag, parcel);
      flag.wares.push(parcel);
      return;
    }
  }

  /**
   * Starts a settler walking back to a store, along with the tool of its trade.
   *
   * Settlers are not consumed by taking a job: remodelling a road network or
   * demolishing a building hands the people back, and their tools with them.
   * Losing either would slowly starve a long game of both.
   *
   * The walk is what the player sees — a builder who has just finished a house
   * should be seen leaving it, not blink out on the doorstep — so the man is
   * only counted back into the store when he actually arrives.
   */
  private sendHome(settler: Settler): void {
    settler.building = 0;
    settler.road = 0;
    settler.carrying = null;
    settler.carryDestination = 0;
    settler.taskTimer = 0;

    const store = this.nearestStore(settler.owner, settler.point);
    if (!store) {
      // Nowhere to go home to. Nothing is gained by leaving him standing.
      this.settlers.remove(settler.id);
      return;
    }

    const path = this.pathHome(settler.point, store);
    if (!path) {
      // Cut off with no way through: take him in on the spot rather than
      // strand him somewhere he can never walk out of.
      this.arriveAtStore(settler, store);
      return;
    }

    settler.building = store.id;
    settler.state = SettlerState.ReturningToStore;
    this.setPath(settler, path);
    if (path.length === 0) this.arriveAtStore(settler, store);
  }

  /**
   * The way back to a store's door: along the roads when they reach, across
   * open ground when they no longer do.
   *
   * A settler standing in a building steps out to its flag first, which is how
   * a builder leaving a finished house joins the network he arrived on.
   */
  private pathHome(from: number, store: Building): number[] | undefined {
    const storeFlag = this.world.flag[store.flagPoint];

    if (storeFlag) {
      const doorstep = this.flagPointOf(from);
      if (doorstep !== undefined) {
        const startFlag = this.world.flag[doorstep]!;
        const alongRoads = roadPointPath(this.network, this.roads, startFlag, storeFlag);
        if (alongRoads) {
          const toDoorstep =
            doorstep === from ? [] : (walkablePath(this.world, from, doorstep) ?? undefined);
          if (toDoorstep) return [...toDoorstep, ...alongRoads, store.point];
        }
      }
    }

    return walkablePath(this.world, from, store.point);
  }

  /**
   * The nearest point from which a settler can join the road network: the flag
   * he is standing on, the flag of the building he is in, or — for somebody out
   * in open country, a geologist most of all — the nearest flag he can walk to.
   *
   * Finding that flag is what lets him come home along the roads rather than
   * striking out cross-country the whole way.
   */
  private flagPointOf(point: number): number | undefined {
    if (this.world.flag[point]) return point;

    const buildingId = this.world.building[point];
    if (buildingId) return this.buildings.get(buildingId)?.flagPoint;

    let best: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    this.flags.forEach((flag) => {
      const distance = this.world.grid.distance(point, flag.point);
      if (distance >= bestDistance || distance > NEAREST_FLAG_RANGE) return;
      bestDistance = distance;
      best = flag.point;
    });

    return best;
  }

  /** Takes a returning settler in, with the tool of its trade. */
  private arriveAtStore(settler: Settler, store: Building): void {
    store.reserve += 1;
    const tool = professionInfo(settler.profession).tool;
    if (tool !== null) store.stock[tool] = (store.stock[tool] ?? 0) + 1;
    this.settlers.remove(settler.id);
  }

  private claimTerritory(centre: number, radius: number, player: number): void {
    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (this.world.owner[point] === 0) this.world.owner[point] = player;
    }
  }

  // -------------------------------------------------------------- movement

  /** Starts the next step of a settler's path. */
  private beginStep(settler: Settler): void {
    const next = settler.path[settler.pathIndex]!;
    settler.fromPoint = settler.point;
    settler.toPoint = next;
    settler.stepProgress = 0;

    // Climbing costs time; descending does not.
    const climb = Math.max(0, this.world.height[next]! - this.world.height[settler.point]!);
    settler.stepLength = STEP_TICKS + climb * 2;
  }

  private setPath(settler: Settler, path: number[]): void {
    settler.path = path;
    settler.pathIndex = 0;

    if (path.length > 0) {
      this.beginStep(settler);
      return;
    }

    // No path means standing still, so any step left half-taken is settled
    // rather than left on the books — otherwise the settler goes on being
    // drawn between two points he is no longer walking between.
    settler.fromPoint = settler.point;
    settler.toPoint = settler.point;
    settler.stepProgress = 0;
  }

  /** True while the settler is between two points rather than standing on one. */
  private midStep(settler: Settler): boolean {
    return settler.stepProgress > 0 && settler.toPoint !== settler.point;
  }

  /**
   * Where a settler will be standing once the step under way has finished.
   *
   * `point` only advances when a step completes, so it is the point *behind* a
   * walking settler. Anything routing him somewhere new has to start from here
   * instead, or the route begins with a step he has already taken.
   */
  private committedPoint(settler: Settler): number {
    return this.midStep(settler) ? settler.toPoint : settler.point;
  }

  /**
   * Sends a settler somewhere new without jerking him backwards.
   *
   * `setPath` restarts the current step from `point`, which is fine for a
   * settler standing still and wrong for one in mid-stride: he would snap back
   * to the point he had just left and walk it again. Keeping the step in flight
   * and queueing the new route behind it lets him finish the pace he is already
   * taking and turn from there.
   */
  private redirect(settler: Settler, path: number[]): void {
    if (!this.midStep(settler)) {
      this.setPath(settler, path);
      return;
    }

    // Sent back the way he came, he turns where he stands rather than walking
    // on to the next node to do it. Swapping the two ends of the step and
    // counting the progress from the other side leaves him drawn in exactly the
    // same place — `A + (p/L)(B - A)` and `B + ((L - p)/L)(A - B)` are the same
    // point — so he pivots on the spot instead of jigging forward and back.
    if (path[0] === settler.fromPoint) {
      const behind = settler.fromPoint;
      settler.fromPoint = settler.toPoint;
      settler.toPoint = behind;
      settler.point = settler.fromPoint;
      settler.stepProgress = settler.stepLength - settler.stepProgress;
      settler.path = path;
      settler.pathIndex = 0;
      return;
    }

    settler.path = [settler.toPoint, ...path];
    settler.pathIndex = 0;
  }

  /** Advances one settler along its path. Returns true when it has arrived. */
  private advance(settler: Settler): boolean {
    if (settler.pathIndex >= settler.path.length) return true;

    settler.stepProgress += 1;
    if (settler.stepProgress < settler.stepLength) return false;

    settler.point = settler.toPoint;
    settler.pathIndex += 1;

    if (settler.pathIndex >= settler.path.length) {
      settler.path = [];
      settler.pathIndex = 0;
      settler.fromPoint = settler.point;
      settler.toPoint = settler.point;
      settler.stepProgress = 0;
      return true;
    }

    this.beginStep(settler);
    return false;
  }

  /**
   * How far along its current step a settler is, for smooth rendering.
   *
   * `alpha` is how far the frame falls into the tick still to come. Without it
   * a settler would only move when a tick lands, which at a leisurely pace
   * would read as a stutter rather than a walk.
   *
   * It is only ever added to a settler who is *going* somewhere. A carrier
   * resting midway between two nodes has a step that will never advance, and
   * guessing ahead for him drew a man twitching a fraction of a node forward
   * and snapping back five times a second — the whole road appeared to fidget.
   */
  stepFraction(settler: Settler, alpha = 0): number {
    if (settler.stepLength <= 0) return 0;
    const walking = settler.pathIndex < settler.path.length;
    const progress = walking ? settler.stepProgress + alpha : settler.stepProgress;
    return Math.min(1, progress / settler.stepLength);
  }

  // -------------------------------------------------------------- settlers

  private updateSettlers(): void {
    this.settlers.forEach((settler) => this.updateSettler(settler));
  }

  private updateSettler(settler: Settler): void {
    switch (settler.state) {
      case SettlerState.WalkingToJob:
        if (this.advance(settler)) this.arriveAtJob(settler);
        return;

      case SettlerState.WalkingToTask:
        if (this.advance(settler)) {
          settler.state = SettlerState.PerformingTask;
          settler.taskTimer = this.taskDuration(settler);
        }
        return;

      case SettlerState.PerformingTask:
        settler.taskTimer -= 1;
        if (settler.taskTimer <= 0) this.completeTask(settler);
        return;

      case SettlerState.ReturningHome:
        if (this.advance(settler)) this.depositAtHome(settler);
        return;

      case SettlerState.CarrierCollecting:
        if (this.advance(settler)) this.collectWare(settler);
        return;

      case SettlerState.CarrierDelivering:
        if (this.advance(settler)) this.deliverWare(settler);
        return;

      case SettlerState.CarrierWaiting:
        if (!this.lookForWork(settler)) this.strollToPost(settler);
        return;

      case SettlerState.Building:
        if (settler.path.length > 0) {
          if (this.advance(settler)) settler.taskTimer = 0;
          return;
        }
        this.workOnSite(settler);
        return;

      case SettlerState.ReturningToStore:
        if (this.advance(settler)) this.finishWalkHome(settler);
        return;

      case SettlerState.DeliveringToFlag:
        if (this.advance(settler)) this.setDownAtFlag(settler);
        return;

      case SettlerState.EnteringBuilding:
        if (this.advance(settler)) this.finishBuildingVisit(settler);
        return;

      case SettlerState.AtWork:
        // Resting between trips out. `updateFieldWork` holds off until this
        // reaches zero.
        if (settler.taskTimer > 0) settler.taskTimer -= 1;
        return;

      case SettlerState.Idle:
        return;
    }
  }

  /**
   * A worker is back at his workplace with whatever he went out for. He puts it
   * down and takes a breather before setting off again.
   */
  private depositAtHome(settler: Settler): void {
    settler.state = SettlerState.AtWork;
    settler.taskTimer = WORKER_REST_TICKS;

    const building = this.buildings.get(settler.building);
    if (building && settler.carrying !== null && building.output === null) {
      building.output = settler.carrying;
    }
    settler.carrying = null;
  }

  /**
   * A settler walking home has reached the end of his path.
   *
   * The store he set out for may have been demolished while he walked, so the
   * arrival is re-checked rather than assumed; failing that he looks for
   * another, and only vanishes when his people have nowhere left to take him.
   */
  private finishWalkHome(settler: Settler): void {
    const store = this.buildings.get(settler.building);
    if (store && isStore(store) && store.point === settler.point) {
      this.arriveAtStore(settler, store);
      return;
    }

    const other = this.nearestStore(settler.owner, settler.point);
    if (!other) {
      this.settlers.remove(settler.id);
      return;
    }

    const path = this.pathHome(settler.point, other);
    if (!path || path.length === 0) {
      this.arriveAtStore(settler, other);
      return;
    }

    settler.building = other.id;
    this.setPath(settler, path);
  }

  private arriveAtJob(settler: Settler): void {
    if (settler.profession === Profession.Geologist) {
      this.beginSurvey(settler);
      return;
    }

    if (settler.road !== 0) {
      const road = this.roads.get(settler.road);

      // A road has one carrier, and he stands on it. Anything else means the id
      // he set out with now belongs to a different road — so he goes home
      // rather than displacing the man already working it.
      const taken = road !== undefined && road.carrier !== 0 && road.carrier !== settler.id;
      const elsewhere = road !== undefined && !road.points.includes(settler.point);
      if (!road || taken || elsewhere) {
        this.dismissSettler(settler.id);
        return;
      }

      road.carrier = settler.id;
      road.carrierRequested = false;
      settler.state = SettlerState.CarrierWaiting;
      return;
    }

    const building = this.buildings.get(settler.building);
    if (!building) {
      this.dismissSettler(settler.id);
      return;
    }

    if (building.state === BuildingState.UnderConstruction) {
      settler.state = SettlerState.Building;
      return;
    }

    building.worker = settler.id;
    building.workerRequested = false;
    settler.state = SettlerState.AtWork;
  }

  // ------------------------------------------------------------ geologists

  /**
   * Rock a geologist could usefully strike, within walking reach of a point.
   *
   * He wants somewhere he can stand that is part of the mountain, and has not
   * been looked at already — sending him back to a spot he has surveyed would
   * teach the player nothing.
   */
  private surveyTarget(patch: number, from: number): number | undefined {
    const rocky: number[] = [];
    const ground: number[] = [];

    for (const point of this.world.grid.pointsWithin(patch, GEOLOGIST_RANGE)) {
      if (this.world.resourceKnown[point]) continue;
      if (!this.world.isWalkable(point)) continue;
      if (this.world.building[point] !== 0 || this.world.flag[point] !== 0) continue;

      this.world.trianglesAroundPoint(point, TRIANGLE_SCRATCH);
      let rock = 0;
      let soil = 0;
      for (let t = 0; t < 6; t += 1) {
        const triangle = TRIANGLE_SCRATCH[t]!;
        if (triangle === OUT_OF_BOUNDS) continue;
        const properties = this.world.propertiesOfTriangle(triangle);
        if (properties.mineable) rock += 1;
        if (properties.buildable) soil += 1;
      }

      if (rock >= 4) rocky.push(point);
      else if (soil >= 4) ground.push(point);
    }

    // Rock first, since ore is what a geologist is usually wanted for; sent
    // into farmland with no rock in reach he prospects for water instead, which
    // is what tells the player where a well will actually draw.
    const candidates = rocky.length > 0 ? rocky : ground;

    // A spot is no use if he cannot get to it. `walkablePath` refuses any step
    // steeper than a road may climb, so a great deal of visible mountain is not
    // actually reachable on foot; picking blind meant giving up the whole trip
    // on the first bad draw.
    for (let tries = 0; tries < GEOLOGIST_TRIES && candidates.length > 0; tries += 1) {
      const index = this.rng.nextInt(candidates.length);
      const point = candidates[index]!;
      if (walkablePath(this.world, from, point)) return point;

      // Swap-remove, so each try costs one path search and no repeats.
      candidates[index] = candidates[candidates.length - 1]!;
      candidates.pop();
    }

    return undefined;
  }

  /**
   * Points the geologist at his next hole, or sends him home.
   *
   * He works the ground around the flag he set out from rather than wandering
   * off wherever the last hole led, and he stays until there is nothing left
   * within reach that he has not looked at. Every strike marks its node, so the
   * candidates only ever shrink and the posting always ends.
   */
  private beginSurvey(settler: Settler): void {
    const target = this.surveyTarget(settler.surveyFrom, settler.point);
    const path = target === undefined ? undefined : walkablePath(this.world, settler.point, target);
    if (target === undefined || !path) {
      this.sendHome(settler);
      return;
    }

    settler.taskPoint = target;
    settler.state = SettlerState.WalkingToTask;
    this.setPath(settler, path);
    if (path.length === 0) {
      settler.state = SettlerState.PerformingTask;
      settler.taskTimer = GEOLOGIST_WORK_TICKS;
    }
  }

  /**
   * He has finished digging. Only the spot he actually struck becomes known —
   * a geologist reports the hole he dug, not the hillside around it, so
   * mapping a seam takes several trips.
   */
  private completeSurvey(settler: Settler): void {
    const found = this.world.resource[settler.taskPoint] as Resource;

    this.world.resourceKnown[settler.taskPoint] = 1;

    if (found !== Resource.None && this.world.resourceAmount[settler.taskPoint]! > 0) {
      const category = FIND_CATEGORY[found] ?? MessageCategory.Survey;
      if (!this.alreadyReported(category, settler.taskPoint, SURVEY_MESSAGE_SPREAD)) {
        this.note(`A geologist finds ${RESOURCE_NAMES[found]}.`, category, settler.taskPoint);
      }
    }

    this.beginSurvey(settler);
  }

  private taskDuration(settler: Settler): number {
    if (settler.profession === Profession.Geologist) return GEOLOGIST_WORK_TICKS;

    const building = this.buildings.get(settler.building);
    if (!building) return 1;
    const behaviour = buildingInfo(building.type).behaviour;
    if (behaviour.kind === 'harvest' || behaviour.kind === 'plant') return behaviour.workTicks;
    if (behaviour.kind === 'extract' || behaviour.kind === 'farm') return behaviour.workTicks;
    return 60;
  }

  /** A woodcutter has finished felling, or a forester has finished planting. */
  private completeTask(settler: Settler): void {
    if (settler.profession === Profession.Geologist) {
      this.completeSurvey(settler);
      return;
    }

    const building = this.buildings.get(settler.building);
    if (!building) {
      this.dismissSettler(settler.id);
      return;
    }

    const behaviour = buildingInfo(building.type).behaviour;
    const point = settler.taskPoint;

    if (behaviour.kind === 'harvest') {
      if (this.world.object[point] === behaviour.object) {
        if (behaviour.object === MapObject.Stone) {
          const remaining = this.world.objectData[point]! - 1;
          this.world.objectData[point] = Math.max(0, remaining);
          if (remaining <= 0) this.world.object[point] = MapObject.None;
        } else {
          this.world.object[point] = MapObject.None;
          this.world.objectData[point] = 0;
        }
        settler.carrying = behaviour.output;
      }
    } else if (behaviour.kind === 'plant') {
      if (this.world.object[point] === MapObject.None) {
        this.world.object[point] = MapObject.Tree;
        this.world.objectData[point] = 0;
        this.growingTrees.push(point);
      }
    } else if (behaviour.kind === 'farm') {
      // Whichever job he walked out for: a ripe field is cut back to bare
      // earth, and bare earth is sown.
      if (
        this.world.object[point] === MapObject.Field &&
        this.world.objectData[point]! >= FIELD_FULLY_GROWN
      ) {
        this.world.object[point] = MapObject.None;
        this.world.objectData[point] = 0;
        settler.carrying = behaviour.output;
      } else if (this.world.object[point] === MapObject.None) {
        this.world.object[point] = MapObject.Field;
        this.world.objectData[point] = 0;
        this.growingFields.push(point);
      }
    } else if (behaviour.kind === 'extract') {
      if (this.world.resource[point] === behaviour.resource && this.world.resourceAmount[point]! > 0) {
        if (behaviour.depletes) {
          const remaining = this.world.resourceAmount[point]! - 1;
          this.world.resourceAmount[point] = Math.max(0, remaining);
          if (remaining <= 0) this.world.resource[point] = Resource.None;
        }
        settler.carrying = behaviour.output;
      }
    }

    // Carrying something back means stopping at the flag on the way in, so the
    // player sees the log arrive rather than finding it already stacked there.
    if (settler.carrying !== null) {
      this.walkToOwnFlag(settler, building);
      return;
    }

    const home = walkablePath(this.world, settler.point, building.point);
    settler.state = SettlerState.ReturningHome;
    this.setPath(settler, home ?? []);
    if ((home?.length ?? 0) === 0) {
      // Already home, or hemmed in — deposit immediately rather than stall.
      settler.point = building.point;
      this.depositAtHome(settler);
    }
  }

  /**
   * Sends a worker to his building's own flag with what he is carrying.
   *
   * The doorstep is always one step from the door, so if the pathfinder cannot
   * find a way — it will not walk *out* of a building — he simply takes that
   * step. He is standing inside, which is the one place a settler may be that
   * open ground does not connect to.
   */
  private walkToOwnFlag(settler: Settler, building: Building): void {
    if (this.carryToFlag(settler, building.flagPoint)) return;

    settler.taskPoint = building.flagPoint;
    settler.state = SettlerState.DeliveringToFlag;
    this.redirect(settler, [building.flagPoint]);
  }

  /**
   * Sends a settler to a flag with what he is holding, wherever that flag is.
   *
   * A worker's own doorstep for a finished ware; the first flag on the way home
   * for a carrier whose road has just been torn up from under him. Either way
   * the crate is *walked* there: the settler is never moved to the flag, and a
   * man caught in mid-stride finishes the pace he is taking before he turns.
   *
   * Returns false when there is no way through, leaving the settler exactly as
   * he was so the caller can do something else with him.
   */
  private carryToFlag(settler: Settler, flagPoint: number): boolean {
    const from = this.committedPoint(settler);
    const path = walkablePath(this.world, from, flagPoint);
    if (!path) return false;

    settler.taskPoint = flagPoint;
    settler.state = SettlerState.DeliveringToFlag;
    this.redirect(settler, path);

    // Already standing on it, with no step left to finish: put the crate down
    // now rather than waste a tick arriving where he is.
    if (path.length === 0 && !this.midStep(settler)) this.setDownAtFlag(settler);
    return true;
  }

  /**
   * A worker puts what he has made on his building's flag and goes back inside.
   *
   * If the flag is full he stands there holding it, which is what makes a
   * backed-up network visible: a line of workers waiting at their own doors
   * rather than production silently stopping.
   */
  private setDownAtFlag(settler: Settler): void {
    const building = this.buildings.get(settler.building);
    if (settler.carrying === null) {
      this.walkBackInside(settler, building);
      return;
    }

    const flagId = this.world.flag[settler.taskPoint];
    const flag = flagId ? this.flags.get(flagId) : undefined;
    if (!flag || flag.wares.length >= FLAG_CAPACITY) return; // Wait, crate in hand.

    // A crate a store dispatched already knows where it is bound, and its place
    // there is already reserved; anything else has to be routed now.
    let bound = settler.carryDestination;
    if (bound === 0) {
      const destination = chooseDestination(
        this.buildings,
        this.network,
        flag.id,
        settler.carrying,
        settler.owner,
        (candidate) => this.world.flag[candidate.flagPoint] ?? 0,
      );

      // Nowhere to send it is no reason to stop working: it waits at the flag
      // until a store or a consumer can be reached again.
      bound = destination && destination.building !== building?.id ? destination.building : 0;
      if (bound !== 0) this.reserveIncoming(bound, settler.carrying);
    }

    flag.wares.push({ ware: settler.carrying, destination: bound });
    settler.carrying = null;
    settler.carryDestination = 0;
    if (building) building.status = BuildingStatus.Working;

    this.walkBackInside(settler, building);
  }

  private walkBackInside(settler: Settler, building: Building | undefined): void {
    if (!building) {
      // Nowhere to go back to — a carrier who was only dropping off a crate on
      // his way out of a job. He carries on home.
      this.sendHome(settler);
      return;
    }

    const path = walkablePath(this.world, settler.point, building.point);
    settler.state = SettlerState.ReturningHome;
    this.setPath(settler, path ?? []);
    if ((path?.length ?? 0) === 0) {
      settler.point = building.point;
      this.depositAtHome(settler);
    }
  }

  private workOnSite(settler: Settler): void {
    const building = this.buildings.get(settler.building);
    if (!building || building.state === BuildingState.Complete) {
      this.sendHome(settler);
      return;
    }

    const info = buildingInfo(building.type);

    // The builder works with what has turned up rather than waiting for the
    // whole delivery, so a site visibly rises as its materials arrive.
    if (building.buildProgress >= this.progressAllowedBy(building)) return;

    building.buildProgress += 1;
    if (building.buildProgress < info.buildTicks || !this.hasAllMaterials(building)) return;

    this.completeConstruction(building);
    this.sendHome(settler);
  }

  /**
   * How far the work can get on the materials delivered so far.
   *
   * The cost list is read in order and stops at the first material that has not
   * all arrived, so the boards are laid before any stone is touched — a frame
   * goes up before it is clad, and a half-delivered pile of stone buys nothing
   * until the timber is complete.
   */
  private progressAllowedBy(building: Building): number {
    const cost = buildingInfo(building.type).cost;
    if (cost.length === 0) return buildingInfo(building.type).buildTicks;

    let required = 0;
    for (const item of cost) required += item.count;
    if (required === 0) return buildingInfo(building.type).buildTicks;

    let usable = 0;
    for (let i = 0; i < cost.length; i += 1) {
      const delivered = Math.min(building.delivered[i]!, cost[i]!.count);
      usable += delivered;
      if (delivered < cost[i]!.count) break;
    }

    return Math.floor((buildingInfo(building.type).buildTicks * usable) / required);
  }

  // -------------------------------------------------------------- carriers

  /**
   * A waiting carrier looks at both its flags for something to move.
   *
   * The end it is already standing at is checked first. That matters more than
   * it sounds: a carrier that always favoured one end would keep ferrying an
   * incoming trickle in one direction and never clear the queue building up
   * behind it, until the far flag filled and the whole stretch deadlocked.
   * Starting from where it stands makes the carrier ping-pong instead, which is
   * both livelier to watch and free of that trap.
   *
   * Returns true when it found something to do.
   */
  private lookForWork(settler: Settler): boolean {
    const road = this.roads.get(settler.road);
    if (!road) {
      this.dismissSettler(settler.id);
      return true;
    }

    // Two men cannot work one stretch. If the road does not name him, he is a
    // leftover of some earlier remodelling and his place is back in the store.
    if (road.carrier !== settler.id) {
      this.dismissSettler(settler.id);
      return true;
    }

    // A carrier strolling back to his post may be picked off mid-stride, so
    // every decision here is made from where he will be, not where he was.
    const from = this.committedPoint(settler);
    const position = road.points.indexOf(from);
    const nearerToStart = position >= 0 && position * 2 <= road.points.length;

    const ends = nearerToStart
      ? ([
          [road.fromFlag, road.toFlag],
          [road.toFlag, road.fromFlag],
        ] as const)
      : ([
          [road.toFlag, road.fromFlag],
          [road.fromFlag, road.toFlag],
        ] as const);

    for (const [here, there] of ends) {
      const flag = this.flags.get(here);
      if (!flag) continue;

      const index = flag.wares.findIndex((parcel) => this.nextFlagFor(here, parcel) === there);
      if (index < 0) continue;

      const path = this.pathAlongRoad(road, from, flag.point);
      if (!path) continue;

      settler.state = SettlerState.CarrierCollecting;
      settler.taskPoint = here;
      this.redirect(settler, path);
      if (settler.path.length === 0) this.collectWare(settler);
      return true;
    }

    return false;
  }

  /**
   * With nothing to carry, a carrier walks back to the middle of his stretch —
   * the same post a newly hired one is sent to, so his resting place is the
   * same whether he has just arrived or just finished a delivery. Standing
   * where the last crate happened to be dropped made a quiet road look
   * lopsided.
   *
   * Work always wins: `lookForWork` runs first each tick and simply replaces
   * the stroll wherever it has got to.
   */
  private strollToPost(settler: Settler): void {
    if (settler.path.length > 0) {
      this.advance(settler);
      return;
    }

    const road = this.roads.get(settler.road);
    if (!road) return;

    const post = this.postOf(road);
    if (settler.point === post.point) {
      this.waitAtPost(settler, post);
      return;
    }

    // Along the road while he is on it, across open country when he is not. A
    // carrier who has somehow ended up off his own stretch still has to be able
    // to reach it: handing him an empty path would leave him standing there for
    // the rest of the game.
    const from = this.committedPoint(settler);
    const path =
      this.pathAlongRoad(road, from, post.point) ?? walkablePath(this.world, from, post.point);
    if (path && path.length > 0) this.redirect(settler, path);
  }

  /**
   * Where a carrier waits: the middle of his stretch.
   *
   * A road of an even number of steps has a node at its centre, and he stands
   * on it. One of an odd number does not — two flags three nodes apart put the
   * centre *between* the middle pair — and posting him on either node would
   * leave him visibly hugging one flag. He waits between them instead.
   */
  private postOf(road: Road): { point: number; beyond: number | undefined } {
    const count = road.points.length;
    if (count % 2 === 1) return { point: road.points[count >> 1]!, beyond: undefined };
    return { point: road.points[count / 2 - 1]!, beyond: road.points[count / 2]! };
  }

  /**
   * Holds a carrier still at his post, half a step out when the post falls
   * between two nodes.
   *
   * Nothing advances a waiting carrier — the step simply sits at half its
   * length — so the renderer, which interpolates from one point to the other,
   * draws him exactly midway. Should work turn up, `committedPoint` reports the
   * node ahead of him and he finishes the half-step into it rather than
   * snapping back.
   */
  private waitAtPost(settler: Settler, post: { point: number; beyond: number | undefined }): void {
    if (post.beyond === undefined) return;

    const climb = Math.max(0, this.world.height[post.beyond]! - this.world.height[post.point]!);
    settler.fromPoint = post.point;
    settler.toPoint = post.beyond;
    settler.stepLength = STEP_TICKS + climb * 2;
    settler.stepProgress = settler.stepLength >> 1;
  }

  private collectWare(settler: Settler): void {
    const road = this.roads.get(settler.road);
    const flag = this.flags.get(settler.taskPoint);
    if (!road || !flag) {
      this.dismissSettler(settler.id);
      return;
    }

    const other = road.fromFlag === flag.id ? road.toFlag : road.fromFlag;
    const index = flag.wares.findIndex((parcel) => this.nextFlagFor(flag.id, parcel) === other);

    if (index < 0) {
      // Someone else took it; go back to waiting.
      settler.state = SettlerState.CarrierWaiting;
      return;
    }

    const parcel = flag.wares.splice(index, 1)[0]!;
    settler.carrying = parcel.ware;
    settler.carryDestination = parcel.destination;

    const target = this.flags.get(other);
    if (!target) {
      settler.state = SettlerState.CarrierWaiting;
      return;
    }

    const path = this.pathAlongRoad(road, settler.point, target.point);
    settler.state = SettlerState.CarrierDelivering;
    settler.taskPoint = other;
    this.setPath(settler, path ?? []);
    if ((path?.length ?? 0) === 0) this.deliverWare(settler);
  }

  private deliverWare(settler: Settler): void {
    const flag = this.flags.get(settler.taskPoint);
    if (!flag || settler.carrying === null) {
      settler.state = SettlerState.CarrierWaiting;
      return;
    }

    const parcel: WareParcel = {
      ware: settler.carrying,
      destination: settler.carryDestination,
    };

    // Deliveries that have reached their destination's own flag go straight in
    // — but only if the building still wants them. A site that finished while
    // the crate was in transit no longer does, and taking it in anyway would
    // quietly destroy the ware.
    if (flag.building !== 0 && flag.building === parcel.destination) {
      const building = this.buildings.get(flag.building);
      if (building && willAccept(building, parcel.ware)) {
        this.enterBuilding(settler, building);
        return;
      }
    }

    // A full flag is not the end of the line: put this crate down and take one
    // away in the same breath, so the count is unchanged and the queue moves.
    if (flag.wares.length >= FLAG_CAPACITY) {
      this.swapAtFullFlag(settler, flag, parcel);
      return;
    }

    // Re-check the route: the network may have changed while walking.
    if (this.nextFlagFor(flag.id, parcel) === undefined && !this.isAcceptableHere(flag, parcel)) {
      this.retarget(flag, parcel);
    }

    flag.wares.push(parcel);
    settler.carrying = null;
    settler.carryDestination = 0;
    settler.state = SettlerState.CarrierWaiting;
  }

  /**
   * Trades a crate for one waiting at a full flag.
   *
   * Simply waiting for room deadlocks: the crates on a full flag can often only
   * leave in the hands of the very carrier stood in front of it, and he cannot
   * free his hands until they go. Both then wait for ever, and every road
   * behind them silts up. Swapping keeps the flag at its capacity while letting
   * traffic through in both directions, which is what the original game does.
   *
   * If nothing on the flag wants to go back the way he came, he waits — that is
   * an honestly full flag rather than a knot.
   */
  private swapAtFullFlag(settler: Settler, flag: Flag, parcel: WareParcel): void {
    const road = this.roads.get(settler.road);
    if (!road) return;

    const beyond = road.fromFlag === flag.id ? road.toFlag : road.fromFlag;
    const index = flag.wares.findIndex((waiting) => this.nextFlagFor(flag.id, waiting) === beyond);
    if (index < 0) return;

    const target = this.flags.get(beyond);
    const path = target && this.pathAlongRoad(road, flag.point, target.point);
    if (!path) return;

    if (this.nextFlagFor(flag.id, parcel) === undefined && !this.isAcceptableHere(flag, parcel)) {
      this.retarget(flag, parcel);
    }

    const taken = flag.wares.splice(index, 1)[0]!;
    flag.wares.push(parcel);

    settler.carrying = taken.ware;
    settler.carryDestination = taken.destination;
    settler.state = SettlerState.CarrierDelivering;
    settler.taskPoint = beyond;
    this.setPath(settler, path);
    if (path.length === 0) this.deliverWare(settler);
  }

  /**
   * A carrier takes a delivery through the door rather than posting it from
   * outside. `building` is remembered on `taskPoint` so the walk back out knows
   * which flag to return to.
   */
  private enterBuilding(settler: Settler, building: Building): void {
    settler.state = SettlerState.EnteringBuilding;

    const path = walkablePath(this.world, settler.point, building.point);
    this.setPath(settler, path ?? []);
    if ((path?.length ?? 0) === 0) {
      settler.point = building.point;
      this.finishBuildingVisit(settler);
    }
  }

  /**
   * Either he has just stepped inside with a delivery, or he is back out at the
   * flag having made it. Carrying tells the two apart.
   */
  private finishBuildingVisit(settler: Settler): void {
    if (settler.carrying === null) {
      // Back at the door, empty handed, and ready for the next crate.
      settler.state = SettlerState.CarrierWaiting;
      return;
    }

    const building = this.buildings.get(this.world.building[settler.point] ?? 0);
    if (building && willAccept(building, settler.carrying)) {
      this.receiveWare(building, settler.carrying);
    } else if (building) {
      // It finished, or filled up, while he was walking in. Take it back out
      // rather than destroying it; `deliverWare` will find it a home.
      this.releaseIncoming(settler.carryDestination, settler.carrying);
    }

    settler.carrying = null;
    settler.carryDestination = 0;

    const flagPoint = building ? building.flagPoint : settler.point;
    const back = walkablePath(this.world, settler.point, flagPoint);
    this.setPath(settler, back ?? []);
    if ((back?.length ?? 0) === 0) {
      settler.point = flagPoint;
      settler.state = SettlerState.CarrierWaiting;
    }
  }

  /** True when the building on this flag will actually take the ware in. */
  private isAcceptableHere(flag: Flag, parcel: WareParcel): boolean {
    if (flag.building === 0 || flag.building !== parcel.destination) return false;
    const building = this.buildings.get(flag.building);
    if (!building) return false;
    return willAccept(building, parcel.ware);
  }

  /**
   * Finds new destinations for wares that have become stranded — bound for a
   * building that has been demolished, finished, or cut off by a road the
   * player tore up. Without this sweep such a crate would sit on its flag for
   * good, and eight of them would block the flag entirely.
   */
  private retargetStrandedWares(): void {
    this.flags.forEach((flag) => {
      for (const parcel of flag.wares) {
        if (this.nextFlagFor(flag.id, parcel) !== undefined) continue;
        if (this.isAcceptableHere(flag, parcel)) continue;
        this.retarget(flag, parcel);
      }
    });
  }

  /** The flag a waiting parcel should move to next, if any. */
  private nextFlagFor(flagId: number, parcel: WareParcel): number | undefined {
    const destination = this.buildings.get(parcel.destination);
    if (!destination) return undefined;

    const destinationFlag = this.world.flag[destination.flagPoint];
    if (!destinationFlag) return undefined;
    if (destinationFlag === flagId) return undefined;

    return this.network.next(flagId, destinationFlag)?.nextFlag;
  }

  /** Walks a road's own point list between two points on it. */
  private pathAlongRoad(road: Road, from: number, to: number): number[] | undefined {
    const start = road.points.indexOf(from);
    const end = road.points.indexOf(to);
    if (start < 0 || end < 0) return undefined;

    const path: number[] = [];
    if (start < end) {
      for (let i = start + 1; i <= end; i += 1) path.push(road.points[i]!);
    } else {
      for (let i = start - 1; i >= end; i -= 1) path.push(road.points[i]!);
    }
    return path;
  }

  // ------------------------------------------------------------- buildings

  private updateBuildings(): void {
    this.buildings.forEach((building) => {
      this.updateBuilding(building);

      // The run of empty ticks only counts while it is unbroken: a building
      // that found something to do this tick starts its count again.
      if (building.status !== BuildingStatus.Exhausted) building.exhaustedFor = 0;
    });
  }

  private updateBuilding(building: Building): void {
    this.forgetLostWorker(building);
    this.takeInWaitingWares(building);

    if (building.state === BuildingState.UnderConstruction) {
      this.updateConstruction(building);
      return;
    }

    const info = buildingInfo(building.type);
    const behaviour = info.behaviour;

    if (behaviour.kind === 'headquarters' || behaviour.kind === 'store') {
      this.pushStoredWares(building);
      return;
    }

    // An outpost holds its ground on its own. It claimed the territory the
    // moment it was finished and asks nothing of anybody after that, so it must
    // not fall into the staffing branch below and sit reporting a worker it
    // will never want.
    if (info.worker === null) {
      building.status = BuildingStatus.Working;
      return;
    }

    // Anything else needs somebody to work it.
    if (building.worker === 0) {
      building.status = this.storeReaches(building)
        ? BuildingStatus.AwaitingWorker
        : BuildingStatus.Unreachable;
      this.requestWorker(building, info);
      return;
    }

    if (building.output !== null) {
      if (!this.pushOutput(building)) building.status = BuildingStatus.Blocked;
      return;
    }

    switch (behaviour.kind) {
      case 'harvest':
      case 'plant':
      case 'farm':
        this.updateFieldWork(building, behaviour);
        return;
      case 'extract':
        // A well is sunk where it stands and a mine works its own shaft, but a
        // fisherman has to walk to the water. The work radius is what tells
        // them apart.
        if (behaviour.radius > 0) this.updateFieldWork(building, behaviour);
        else this.updateExtraction(building, behaviour);
        return;
      case 'craft':
        this.updateCraft(building, behaviour);
        return;
      default:
        building.status = BuildingStatus.Working;
    }
  }

  private updateConstruction(building: Building): void {
    // A site with nothing left to do finishes even without a builder present.
    if (buildingInfo(building.type).buildTicks === 0 && this.hasAllMaterials(building)) {
      this.completeConstruction(building);
      return;
    }

    // A site no road reaches will never see a builder or a board. Saying so is
    // far kinder than leaving the player staring at a scaffold that never
    // changes, wondering what they did wrong.
    if (!this.storeReaches(building)) {
      building.status = BuildingStatus.Unreachable;
      return;
    }

    building.status = BuildingStatus.UnderConstruction;

    if (building.worker === 0 && !building.workerRequested) {
      this.requestBuilder(building);
    }
  }

  /**
   * Clears a worker that no longer exists.
   *
   * `requestBuilder` records the settler it sent out, and nothing else asks for
   * one while that record stands. If the settler is dismissed on the way — its
   * road torn up, say — the record would otherwise pin the building forever.
   */
  private forgetLostWorker(building: Building): void {
    if (building.worker === 0) return;
    if (this.settlers.has(building.worker)) return;

    building.worker = 0;
    building.workerRequested = false;
  }

  /** Whether any of the player's stores can reach this building by road. */
  private storeReaches(building: Building): boolean {
    const flagId = this.world.flag[building.flagPoint];
    if (!flagId) return false;

    let reachable = false;
    this.buildings.forEach((candidate) => {
      if (reachable || candidate.owner !== building.owner || !isStore(candidate)) return;

      const storeFlag = this.world.flag[candidate.flagPoint];
      if (!storeFlag) return;
      if (storeFlag === flagId || this.network.cost(storeFlag, flagId) !== undefined) {
        reachable = true;
      }
    });

    return reachable;
  }

  private hasAllMaterials(building: Building): boolean {
    const cost = buildingInfo(building.type).cost;
    for (let i = 0; i < cost.length; i += 1) {
      if (building.delivered[i]! < cost[i]!.count) return false;
    }
    return true;
  }

  private completeConstruction(building: Building): void {
    building.state = BuildingState.Complete;
    building.status = BuildingStatus.AwaitingWorker;
    building.buildProgress = 0;
    building.worker = 0;
    building.workerRequested = false;

    const info = buildingInfo(building.type);
    if (info.behaviour.kind === 'military') {
      this.claimTerritory(building.point, info.behaviour.radius, building.owner);
      this.note(`${info.name} completed, claiming new ground.`, MessageCategory.Territory, building.point);
      return;
    }

    this.note(`${info.name} completed.`, MessageCategory.Built, building.point);
  }

  /**
   * A building has run out of whatever it lives on.
   *
   * Said once, on the way into that state rather than every tick it stays
   * there: a woodcutter with no trees left would otherwise repeat itself five
   * times a second for the rest of the game.
   */
  private reportExhausted(building: Building): void {
    building.status = BuildingStatus.Exhausted;
    building.exhaustedFor += 1;

    // Only once it has really stopped. A woodcutter sharing a forester with
    // another dips in and out of having nothing to cut all day long, and saying
    // so each time buried every other message; two solid minutes of finding
    // nothing at all is a different matter.
    if (building.exhaustedFor !== EXHAUSTED_REPORT_TICKS) return;

    const info = buildingInfo(building.type);
    this.note(
      `${info.name}: ${EXHAUSTED_REASON[info.behaviour.kind] ?? 'nothing left within reach'}.`,
      MessageCategory.Exhausted,
      building.point,
    );
  }

  /**
   * Where the worker of a building should go next.
   *
   * A farmer is the only one with two jobs: he cuts a ripe field if there is
   * one, and sows a fresh one otherwise. Reaping first is what keeps a farm
   * from carpeting its whole radius before harvesting any of it.
   */
  private workTarget(centre: number, behaviour: FieldWork): number | undefined {
    switch (behaviour.kind) {
      case 'harvest':
        return this.findObject(centre, behaviour.radius, behaviour.object);
      case 'extract':
        return this.findResource(centre, behaviour.radius, behaviour.resource, true);
      case 'farm':
        return (
          this.findObject(centre, behaviour.radius, MapObject.Field) ??
          this.findFieldSpot(centre, behaviour.radius)
        );
      case 'plant':
        return this.findGrowingSpot(centre, behaviour.radius, 'plantable');
    }
  }

  private updateFieldWork(building: Building, behaviour: FieldWork): void {
    const worker = this.settlers.get(building.worker);
    if (!worker || worker.state !== SettlerState.AtWork) return;

    // Still resting from the last trip.
    if (worker.taskTimer > 0) {
      building.status = BuildingStatus.Working;
      return;
    }

    const target = this.workTarget(building.point, behaviour);

    if (target === undefined) {
      this.reportExhausted(building);
      return;
    }

    const path = walkablePath(this.world, worker.point, target);
    if (!path) {
      this.reportExhausted(building);
      return;
    }

    building.status = BuildingStatus.Working;
    worker.taskPoint = target;
    worker.state = SettlerState.WalkingToTask;
    this.setPath(worker, path);
    if (path.length === 0) {
      worker.state = SettlerState.PerformingTask;
      worker.taskTimer = behaviour.workTicks;
    }
  }

  private updateExtraction(
    building: Building,
    behaviour: Extract<ReturnType<typeof buildingInfo>['behaviour'], { kind: 'extract' }>,
  ): void {
    if (behaviour.food && behaviour.food.length > 0) {
      const fed = building.inputs[0]! > 0;
      if (!fed) {
        building.status = BuildingStatus.AwaitingMaterials;
        return;
      }
    }

    // A shaft reaches the seam around it, not just the speck of ground it
    // stands on: worldgen scatters ore point by point, so a mine confined to
    // its own point would report itself exhausted almost at once. The radius in
    // the data stays zero — `updateBuilding` reads a non-zero one as "the
    // worker goes outdoors", which is right for a fisherman and wrong here.
    const reach = Math.max(behaviour.radius, SEAM_RADIUS);
    const source = this.findResource(building.point, reach, behaviour.resource);
    if (source === undefined) {
      this.reportExhausted(building);
      return;
    }

    building.status = BuildingStatus.Working;
    building.workTimer += 1;
    if (building.workTimer < behaviour.workTicks) return;

    building.workTimer = 0;
    if (behaviour.depletes) {
      const remaining = this.world.resourceAmount[source]! - 1;
      this.world.resourceAmount[source] = Math.max(0, remaining);
      if (remaining <= 0) this.world.resource[source] = Resource.None;
    }
    if (behaviour.food && behaviour.food.length > 0) building.inputs[0]! -= 1;
    building.output = behaviour.output;
  }

  private updateCraft(
    building: Building,
    behaviour: Extract<ReturnType<typeof buildingInfo>['behaviour'], { kind: 'craft' }>,
  ): void {
    for (let i = 0; i < behaviour.inputs.length; i += 1) {
      if (building.inputs[i]! < behaviour.inputs[i]!.count) {
        building.status = BuildingStatus.AwaitingMaterials;
        return;
      }
    }

    building.status = BuildingStatus.Working;
    building.workTimer += 1;
    if (building.workTimer < behaviour.workTicks) return;

    building.workTimer = 0;
    for (let i = 0; i < behaviour.inputs.length; i += 1) {
      building.inputs[i] = building.inputs[i]! - behaviour.inputs[i]!.count;
    }
    building.output = behaviour.alternatives
      ? this.scarcest(building.owner, behaviour.alternatives)
      : behaviour.output;
  }

  /**
   * Whichever of these wares the player holds fewest of.
   *
   * Ties go to the earliest in the list rather than to iteration order, so a
   * workshop's choice is a function of the game state alone — no clock, no
   * random draw, and identical in a replay.
   */
  private scarcest(owner: number, choices: readonly Ware[]): Ware {
    let best = choices[0]!;
    let bestHeld = Number.POSITIVE_INFINITY;

    for (const ware of choices) {
      const held = this.storedWare(owner, ware);
      if (held < bestHeld) {
        bestHeld = held;
        best = ware;
      }
    }

    return best;
  }

  /**
   * Sends the worker out with what his building has made.
   *
   * Nothing appears on a flag by itself any more: a miller carries his flour to
   * his own door, puts it down, and goes back in. A building with no worker to
   * send — there is no such producer today, but the guard costs nothing — keeps
   * its output until one arrives.
   */
  private pushOutput(building: Building): boolean {
    if (building.output === null) return true;

    const worker = this.settlers.get(building.worker);
    if (!worker || worker.state !== SettlerState.AtWork) return false;

    const flagId = this.world.flag[building.flagPoint];
    if (!flagId) return false;

    // He does not set off into a full flag; he waits inside until there is
    // somewhere to put it.
    const flag = this.flags.get(flagId);
    if (!flag || flag.wares.length >= FLAG_CAPACITY) return false;

    worker.carrying = building.output;
    building.output = null;
    worker.taskTimer = 0;
    this.walkToOwnFlag(worker, building);
    return true;
  }

  /**
   * A building takes in anything left standing at its own door.
   *
   * A crate normally goes in at the moment a carrier hands it over, but one can
   * arrive at its destination's own flag by other means — a carrier dismissed
   * there setting it down, or `retarget` re-homing it to the nearest store,
   * which from that store's own flag costs nothing at all. Such a crate has no
   * next hop to be carried to and is already where it belongs, so every sweep
   * passed over it and it sat there for good.
   *
   * Left alone this jams whole provinces: eight of them fill a headquarters
   * flag and every road behind it silts up, and a single one at a building
   * site's door leaves it a board short for ever, since the reservation it
   * still holds tells the network the board is on its way.
   */
  private takeInWaitingWares(building: Building): void {
    const flagId = this.world.flag[building.flagPoint];
    if (!flagId) return;

    const flag = this.flags.get(flagId);
    if (!flag) return;

    for (let i = flag.wares.length - 1; i >= 0; i -= 1) {
      const parcel = flag.wares[i]!;
      if (parcel.destination !== building.id) continue;
      if (!willAccept(building, parcel.ware)) continue;

      flag.wares.splice(i, 1);
      this.receiveWare(building, parcel.ware);
    }
  }

  /** Stores hand out wares that somebody has asked for. */
  private pushStoredWares(building: Building): void {
    const flagId = this.world.flag[building.flagPoint];
    if (!flagId) return;

    const flag = this.flags.require(flagId);

    // A store must leave room at its own door for deliveries coming the other
    // way. Left to fill all eight places with goods going out — and a single
    // two-input workshop can legitimately have eight crates on their way to it
    // — it walls itself in, and every road bringing anything back jams solid
    // behind the queue.
    if (flag.wares.length >= STORE_DISPATCH_LIMIT) return;

    // One dispatch per tick keeps a store from flooding its own flag.
    for (let ware = 0 as Ware; ware < WARE_COUNT; ware = (ware + 1) as Ware) {
      if (building.stock[ware]! <= 0) continue;

      const destination = chooseDestination(
        this.buildings,
        this.network,
        flagId,
        ware,
        building.owner,
        (candidate) => this.world.flag[candidate.flagPoint] ?? 0,
      );
      if (!destination || destination.building === building.id) continue;

      const target = this.buildings.get(destination.building);
      if (!target || outstandingDemand(target, ware) <= 0) continue;

      // Somebody has to carry it out, and only once there is genuinely
      // something to carry — a store with nothing to send needs no porter. He
      // is free again only when he is back inside, which is what paces a
      // store's dispatching.
      const porter = this.storePorter(building);
      if (!porter) return;

      building.stock[ware] = building.stock[ware]! - 1;
      this.reserveIncoming(destination.building, ware);

      // He carries it out already knowing where it is bound, so `setDownAtFlag`
      // leaves the choice — and its reservation — exactly as made here.
      porter.carrying = ware;
      porter.carryDestination = destination.building;
      porter.taskTimer = 0;
      this.walkToOwnFlag(porter, building);
      return;
    }
  }

  /**
   * The settler who fetches and carries at a store, ready for another crate.
   *
   * A store has never had a worker of its own, so it takes one from the people
   * waiting inside it the first time it has something to send. Nothing is spent
   * doing so: `population` counts a settler on the books and one in the reserve
   * alike, so the province is no smaller for it.
   */
  private storePorter(building: Building): Settler | undefined {
    const existing = this.settlers.get(building.worker);
    if (existing) {
      // Ready the moment he is back inside. The rest `depositAtHome` gives him
      // is for a trade that has been out in the field, not for a man walking to
      // his own doorstep and back.
      return existing.state === SettlerState.AtWork ? existing : undefined;
    }

    if (building.reserve <= 0) return undefined;

    building.reserve -= 1;
    const porter = this.createSettler(building.owner, Profession.Helper, building.point);
    porter.building = building.id;
    porter.state = SettlerState.AtWork;
    building.worker = porter.id;
    return porter;
  }

  /** Records that a ware is on its way, so nobody orders it twice. */
  private reserveIncoming(buildingId: number, ware: Ware): void {
    const building = this.buildings.get(buildingId);
    if (!building) return;

    if (building.state === BuildingState.UnderConstruction) {
      const cost = buildingInfo(building.type).cost;
      for (let i = 0; i < cost.length; i += 1) {
        if (cost[i]!.ware !== ware) continue;
        if (building.delivered[i]! + building.incoming[i]! >= cost[i]!.count) continue;
        building.incoming[i] = building.incoming[i]! + 1;
        return;
      }
      return;
    }

    const behaviour = buildingInfo(building.type).behaviour;
    if (behaviour.kind === 'craft') {
      for (let i = 0; i < behaviour.inputs.length; i += 1) {
        if (behaviour.inputs[i]!.ware !== ware) continue;
        building.inputsIncoming[i] = building.inputsIncoming[i]! + 1;
        return;
      }
      return;
    }

    if (behaviour.kind === 'extract' && behaviour.food?.includes(ware)) {
      building.inputsIncoming[0] = (building.inputsIncoming[0] ?? 0) + 1;
    }
  }

  /**
   * Cancels a reservation made by `reserveIncoming`.
   *
   * Every ware that stops being on its way somewhere has to give its place
   * back. A reservation left behind counts against the building for good:
   * `outstandingDemand` subtracts it, so the building looks satisfied, nothing
   * more is ever sent, and a construction site quietly waits forever.
   */
  private releaseIncoming(buildingId: number, ware: Ware): void {
    const building = this.buildings.get(buildingId);
    if (!building) return;

    if (building.state === BuildingState.UnderConstruction) {
      const cost = buildingInfo(building.type).cost;
      for (let i = 0; i < cost.length; i += 1) {
        if (cost[i]!.ware !== ware || building.incoming[i]! <= 0) continue;
        building.incoming[i] = building.incoming[i]! - 1;
        return;
      }
      return;
    }

    const behaviour = buildingInfo(building.type).behaviour;
    if (behaviour.kind === 'craft') {
      for (let i = 0; i < behaviour.inputs.length; i += 1) {
        if (behaviour.inputs[i]!.ware !== ware || building.inputsIncoming[i]! <= 0) continue;
        building.inputsIncoming[i] = building.inputsIncoming[i]! - 1;
        return;
      }
      return;
    }

    if (behaviour.kind === 'extract' && behaviour.food?.includes(ware)) {
      building.inputsIncoming[0] = Math.max(0, (building.inputsIncoming[0] ?? 0) - 1);
    }
  }

  /** Takes a delivered ware into a building's stock. */
  private receiveWare(building: Building, ware: Ware): void {
    if (building.state === BuildingState.UnderConstruction) {
      const cost = buildingInfo(building.type).cost;
      for (let i = 0; i < cost.length; i += 1) {
        if (cost[i]!.ware !== ware) continue;
        building.delivered[i] = building.delivered[i]! + 1;
        building.incoming[i] = Math.max(0, building.incoming[i]! - 1);
        return;
      }
      return;
    }

    const behaviour = buildingInfo(building.type).behaviour;

    if (behaviour.kind === 'headquarters' || behaviour.kind === 'store') {
      building.stock[ware] = (building.stock[ware] ?? 0) + 1;
      return;
    }

    if (behaviour.kind === 'craft') {
      for (let i = 0; i < behaviour.inputs.length; i += 1) {
        if (behaviour.inputs[i]!.ware !== ware) continue;
        building.inputs[i] = building.inputs[i]! + 1;
        building.inputsIncoming[i] = Math.max(0, building.inputsIncoming[i]! - 1);
        return;
      }
      return;
    }

    if (behaviour.kind === 'extract' && behaviour.food?.includes(ware)) {
      building.inputs[0] = (building.inputs[0] ?? 0) + 1;
      building.inputsIncoming[0] = Math.max(0, (building.inputsIncoming[0] ?? 0) - 1);
    }
  }

  /**
   * Points a ware at a fresh destination, releasing its old reservation first
   * so the building it was bound for does not go on counting it as incoming.
   *
   * Returns false when nowhere will take it, leaving the parcel as it was.
   */
  private retarget(flag: Flag, parcel: WareParcel): boolean {
    this.releaseIncoming(parcel.destination, parcel.ware);

    const destination = chooseDestination(
      this.buildings,
      this.network,
      flag.id,
      parcel.ware,
      flag.owner,
      (candidate) => this.world.flag[candidate.flagPoint] ?? 0,
    );

    if (!destination) {
      // Nothing wants it anywhere reachable; put the reservation back so the
      // books stay straight and try again on the next sweep.
      this.reserveIncoming(parcel.destination, parcel.ware);
      return false;
    }

    this.reserveIncoming(destination.building, parcel.ware);
    parcel.destination = destination.building;
    return true;
  }

  private retargetWaresBoundFor(buildingId: number): void {
    this.flags.forEach((flag) => {
      for (const parcel of flag.wares) {
        if (parcel.destination !== buildingId) continue;
        if (!this.retarget(flag, parcel)) parcel.destination = 0;
      }
    });

    this.settlers.forEach((settler) => {
      if (settler.carryDestination !== buildingId) return;
      settler.carryDestination = 0;
    });
  }

  // ------------------------------------------------------- staffing & roads

  private storeFor(owner: number): Building | undefined {
    let best: Building | undefined;
    this.buildings.forEach((building) => {
      if (best) return;
      if (building.owner === owner && isStore(building)) best = building;
    });
    return best;
  }

  /**
   * The store a settler at `from` should walk back to.
   *
   * Distance by road decides it, mirroring `supplierFor` in the other
   * direction; a settler with no road under him falls back on the first store,
   * since he will be crossing open ground anyway.
   */
  private nearestStore(owner: number, from: number): Building | undefined {
    const doorstep = this.flagPointOf(from);
    const fromFlag = doorstep === undefined ? 0 : this.world.flag[doorstep];
    if (!fromFlag) return this.storeFor(owner);

    let best: Building | undefined;
    let bestCost = Number.POSITIVE_INFINITY;

    this.buildings.forEach((building) => {
      if (building.owner !== owner || !isStore(building)) return;

      const flagId = this.world.flag[building.flagPoint];
      if (!flagId) return;

      const cost = flagId === fromFlag ? 0 : this.network.cost(flagId, fromFlag);
      if (cost === undefined || cost >= bestCost) return;

      bestCost = cost;
      best = building;
    });

    return best ?? this.storeFor(owner);
  }

  /** The cheapest store that can supply a settler, and optionally a tool. */
  private supplierFor(owner: number, destinationFlag: number, tool: Ware | null): Building | undefined {
    let best: Building | undefined;
    let bestCost = Number.POSITIVE_INFINITY;

    this.buildings.forEach((building) => {
      if (building.owner !== owner || !isStore(building)) return;
      if (building.reserve <= 0) return;
      if (tool !== null && (building.stock[tool] ?? 0) <= 0) return;

      const flagId = this.world.flag[building.flagPoint];
      if (!flagId) return;

      const cost = flagId === destinationFlag ? 0 : this.network.cost(flagId, destinationFlag);
      if (cost === undefined || cost >= bestCost) return;

      bestCost = cost;
      best = building;
    });

    return best;
  }

  private requestWorker(building: Building, info: BuildingInfo): void {
    if (building.workerRequested || info.worker === null) return;

    const destinationFlag = this.world.flag[building.flagPoint];
    if (!destinationFlag) return;

    const tool = professionInfo(info.worker).tool;
    const store = this.supplierFor(building.owner, destinationFlag, tool);
    if (!store) return;

    const storeFlag = this.world.flag[store.flagPoint]!;
    const path = roadPointPath(this.network, this.roads, storeFlag, destinationFlag);
    if (!path) return;

    store.reserve -= 1;
    if (tool !== null) store.stock[tool] = store.stock[tool]! - 1;

    const settler = this.createSettler(building.owner, info.worker, store.flagPoint);
    settler.building = building.id;
    settler.state = SettlerState.WalkingToJob;
    this.setPath(settler, [...path, building.point]);
    building.workerRequested = true;
  }

  private requestBuilder(building: Building): void {
    const destinationFlag = this.world.flag[building.flagPoint];
    if (!destinationFlag) return;

    const store = this.supplierFor(building.owner, destinationFlag, Ware.Hammer);
    if (!store) return;

    const storeFlag = this.world.flag[store.flagPoint]!;
    const path = roadPointPath(this.network, this.roads, storeFlag, destinationFlag);
    if (!path) return;

    store.reserve -= 1;
    store.stock[Ware.Hammer] = store.stock[Ware.Hammer]! - 1;

    const settler = this.createSettler(building.owner, Profession.Builder, store.flagPoint);
    settler.building = building.id;
    settler.state = SettlerState.WalkingToJob;
    this.setPath(settler, [...path, building.point]);

    building.worker = settler.id;
    building.workerRequested = true;
  }

  private updateRoads(): void {
    this.roads.forEach((road) => {
      if (road.carrier !== 0 || road.carrierRequested) return;

      const store = this.supplierFor(road.owner, road.fromFlag, null);
      if (!store) return;

      const storeFlag = this.world.flag[store.flagPoint]!;

      // He joins the road at whichever end is nearer. Walking always to
      // `fromFlag` — merely the end the road happened to be drawn from — sent
      // him the length of a road laid the other way round, past the very crate
      // he was hired to move, only to double back.
      const ends = [road.fromFlag, road.toFlag]
        .map((flag) => ({ flag, cost: flag === storeFlag ? 0 : this.network.cost(storeFlag, flag) }))
        .filter((end): end is { flag: number; cost: number } => end.cost !== undefined)
        .sort((a, b) => a.cost - b.cost);

      const nearest = ends[0];
      if (!nearest) return;

      const toRoad = roadPointPath(this.network, this.roads, storeFlag, nearest.flag);
      if (!toRoad) return;

      store.reserve -= 1;

      // He is walked no further than the road itself. From the moment he
      // arrives he is an ordinary carrier: `lookForWork` runs before
      // `strollToPost`, so a crate already waiting is picked up at once and the
      // walk to the middle happens only when there is nothing to carry.
      const settler = this.createSettler(road.owner, Profession.Helper, store.flagPoint);
      settler.road = road.id;
      settler.state = SettlerState.WalkingToJob;
      this.setPath(settler, toRoad);
      road.carrierRequested = true;
    });
  }

  // ------------------------------------------------------------- map search

  /** The nearest point within `radius` carrying the given object. */
  /**
   * The nearest object of a kind worth working. Trees and fields both have to
   * be ripe first — a sapling is not timber and green corn is not a crop.
   */
  private findObject(centre: number, radius: number, object: MapObject): number | undefined {
    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (this.world.object[point] !== object) continue;
      if (object === MapObject.Tree && this.world.objectData[point]! < TREE_FULLY_GROWN) continue;
      if (object === MapObject.Field && this.world.objectData[point]! < FIELD_FULLY_GROWN) continue;
      return point;
    }
    return undefined;
  }

  /**
   * The nearest point within `radius` still holding the given resource.
   *
   * A fisherman has to stand somewhere to cast, and the nearest shoal is often
   * open water he cannot reach; `reachable` restricts the search to ground a
   * settler can actually occupy. Wells and mines work where they stand and do
   * not care.
   */
  private findResource(
    centre: number,
    radius: number,
    resource: Resource,
    reachable = false,
  ): number | undefined {
    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (this.world.resource[point] !== resource) continue;
      if (this.world.resourceAmount[point]! <= 0) continue;
      if (reachable && !this.world.isWalkable(point)) continue;
      return point;
    }
    return undefined;
  }

  /**
   * Open ground something can be put in: saplings for a forester, corn for a
   * farmer. The two differ only in which terrain will take it, so they share
   * the search.
   *
   * The spot is drawn at random from everything suitable rather than taken in
   * scan order, so a forester grows a natural-looking wood instead of a tidy
   * ring around its hut. The draw comes from the simulation's seeded generator,
   * so it stays reproducible.
   */
  private findGrowingSpot(
    centre: number,
    radius: number,
    property: 'plantable' | 'farmable',
  ): number | undefined {
    const suitable: number[] = [];

    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (point === centre) continue;
      if (!this.isClearGround(point)) continue;
      if (!this.allSidesAre(point, property)) continue;

      suitable.push(point);
    }

    return this.rng.pick(suitable);
  }

  /**
   * Where a farmer sows: the ring of points *exactly* `radius` out from the
   * farmyard, never nearer and never further.
   *
   * Corn laid out that way looks like a farm's land rather than a rash across
   * the countryside, and it keeps the yard itself clear — the building's own
   * walls and flag lie a node inside the ring and so can never be in the way.
   *
   * The ring holds twelve points and no two neighbours may both be sown, so a
   * farm on open meadow works five or six fields at once.
   */
  private findFieldSpot(centre: number, radius: number): number | undefined {
    const suitable: number[] = [];

    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (this.world.grid.distance(centre, point) !== radius) continue;
      if (!this.isClearGround(point)) continue;
      if (!this.allSidesAre(point, 'farmable')) continue;
      if (!this.hasRoomToSow(point)) continue;

      suitable.push(point);
    }

    return this.rng.pick(suitable);
  }

  /** Whether all six triangles meeting at a point will take what is being put in. */
  private allSidesAre(point: number, property: 'plantable' | 'farmable'): boolean {
    this.world.trianglesAroundPoint(point, TRIANGLE_SCRATCH);
    for (let t = 0; t < 6; t += 1) {
      const triangle = TRIANGLE_SCRATCH[t]!;
      if (triangle === OUT_OF_BOUNDS) return false;
      if (!this.world.propertiesOfTriangle(triangle)[property]) return false;
    }
    return true;
  }

  /** Bare ground with nothing standing on it and no road across it. */
  private isClearGround(point: number): boolean {
    if (this.world.object[point] !== MapObject.None) return false;
    if (this.world.building[point] !== 0 || this.world.flag[point] !== 0) return false;
    return this.world.roadCount(point) === 0;
  }

  /**
   * Whether a field may be sown here: no neighbouring point already carries a
   * field or a building.
   *
   * Only those two. A field running alongside a track or up against a wood is
   * exactly right — forbidding those as well would cost a farm most of its ring
   * wherever the country is anything but bare.
   */
  private hasRoomToSow(point: number): boolean {
    for (const direction of DIRECTIONS) {
      const neighbour = this.world.grid.neighbour(point, direction);
      if (neighbour === OUT_OF_BOUNDS) return false;
      if (this.world.object[neighbour] === MapObject.Field) return false;
      if (this.world.building[neighbour] !== 0) return false;
    }
    return true;
  }

  private growTrees(): void {
    if (this.tick % TREE_GROWTH_INTERVAL !== 0) return;

    const stillGrowing: number[] = [];
    for (const point of this.growingTrees) {
      if (this.world.object[point] !== MapObject.Tree) continue;

      const stage = this.world.objectData[point]! + 1;
      this.world.objectData[point] = Math.min(TREE_FULLY_GROWN, stage);
      if (stage < TREE_FULLY_GROWN) stillGrowing.push(point);
    }
    this.growingTrees = stillGrowing;
  }

  /** Corn ripens faster than timber, which is the point of a farm. */
  private growFields(): void {
    if (this.tick % FIELD_GROWTH_INTERVAL !== 0) return;

    const stillGrowing: number[] = [];
    for (const point of this.growingFields) {
      if (this.world.object[point] !== MapObject.Field) continue;

      const stage = this.world.objectData[point]! + 1;
      this.world.objectData[point] = Math.min(FIELD_FULLY_GROWN, stage);
      if (stage < FIELD_FULLY_GROWN) stillGrowing.push(point);
    }
    this.growingFields = stillGrowing;
  }

  // -------------------------------------------------------------- saving

  /**
   * A complete, structured copy of the game.
   *
   * Terrain and altitude are left out on purpose: they are a pure function of
   * the seed, so a save stores the seed and regenerates them. Only what play
   * has actually changed — ownership, roads, what stands on the ground, and the
   * entities — needs to be written down, which keeps saves small enough to hand
   * around as a file.
   *
   * The typed arrays are handed over as-is; turning them into something a file
   * can hold is the platform layer's business, not the simulation's.
   */
  toSnapshot(): SimulationSnapshot {
    return {
      version: SAVE_VERSION,
      seed: this.seed,
      width: this.world.grid.width,
      height: this.world.grid.height,
      tick: this.tick,
      rng: this.rng.save(),
      players: this.players.map((player) => ({ ...player })),
      map: {
        object: this.world.object,
        objectData: this.world.objectData,
        resource: this.world.resource,
        resourceAmount: this.world.resourceAmount,
        resourceKnown: this.world.resourceKnown,
        owner: this.world.owner,
        roads: this.world.roads,
        building: this.world.building,
        flag: this.world.flag,
      },
      flags: { pool: this.flags.savePool(), items: this.flags.all() },
      roads: { pool: this.roads.savePool(), items: this.roads.all() },
      buildings: { pool: this.buildings.savePool(), items: this.buildings.all() },
      settlers: { pool: this.settlers.savePool(), items: this.settlers.all() },
      growingTrees: [...this.growingTrees],
      growingFields: [...this.growingFields],
      events: [...this.events],
    };
  }

  /**
   * Rebuilds a game from `toSnapshot`.
   *
   * Older snapshots are accepted and their missing pieces defaulted below; only
   * a snapshot from a future version is genuinely unreadable, since there is no
   * telling what it means.
   */
  static fromSnapshot(snapshot: SimulationSnapshot): Simulation {
    if (snapshot.version > SAVE_VERSION) {
      throw new Error(`unsupported save version ${snapshot.version}`);
    }

    // Regenerating from the seed restores terrain and altitude exactly.
    const { world } = generateWorld({
      width: snapshot.width,
      height: snapshot.height,
      seed: snapshot.seed,
      players: Math.max(1, snapshot.players.length),
    });

    world.object.set(snapshot.map.object);
    world.objectData.set(snapshot.map.objectData);
    world.resource.set(snapshot.map.resource);
    world.resourceAmount.set(snapshot.map.resourceAmount);
    world.resourceKnown.set(snapshot.map.resourceKnown);
    world.owner.set(snapshot.map.owner);
    world.roads.set(snapshot.map.roads);
    world.building.set(snapshot.map.building);
    world.flag.set(snapshot.map.flag);

    const simulation = new Simulation(world, snapshot.seed);
    simulation.tick = snapshot.tick;
    simulation.rng = Rng.restore(snapshot.rng);
    simulation.growingTrees = [...snapshot.growingTrees];
    // Saves written before farms existed have no field list, and no fields.
    simulation.growingFields = [...(snapshot.growingFields ?? [])];
    simulation.players.push(...snapshot.players.map((player) => ({ ...player })));
    simulation.events.push(...snapshot.events);

    simulation.flags.adopt(snapshot.flags.pool, snapshot.flags.items);
    simulation.roads.adopt(snapshot.roads.pool, snapshot.roads.items);
    simulation.buildings.adopt(
      snapshot.buildings.pool,
      snapshot.buildings.items.map((b) => ({ ...b, exhaustedFor: b.exhaustedFor ?? 0 })),
    );
    // Version 1 settlers have no survey counter; nobody in such a save is a
    // geologist, so nought is not merely a safe default but the right one.
    simulation.settlers.adopt(
      snapshot.settlers.pool,
      snapshot.settlers.items.map((settler) => ({ ...settler, surveyFrom: settler.surveyFrom ?? 0 })),
    );

    return simulation;
  }

  // ------------------------------------------------------------- reporting

  /**
   * Records something worth telling the player about.
   *
   * `point` is where it happened, so the message log can take the player
   * straight there. `category` lets like messages be recognised — which is how
   * a geologist working a whole seam produces a handful of lines rather than
   * one for every hole he digs.
   */
  private note(text: string, category: MessageCategory, point = -1): void {
    this.events.push({ text, category, point, tick: this.tick });
    if (this.events.length > MESSAGE_LIMIT) this.events.shift();
  }

  /**
   * True when the same sort of thing has just been reported close by.
   *
   * Without this a geologist's patch would flood the log with sixty near
   * identical finds and bury everything else.
   */
  private alreadyReported(category: MessageCategory, point: number, within: number): boolean {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const past = this.events[i]!;
      if (past.category !== category || past.point < 0) continue;
      if (this.world.grid.distance(past.point, point) <= within) return true;
    }
    return false;
  }

  /** Total of a ware held across all of a player's stores. */
  storedWare(owner: number, ware: Ware): number {
    let total = 0;
    this.buildings.forEach((building) => {
      if (building.owner === owner && isStore(building)) total += building.stock[ware] ?? 0;
    });
    return total;
  }

  /** Settlers waiting in a player's stores, plus those out in the world. */
  population(owner: number): number {
    let total = 0;
    this.buildings.forEach((building) => {
      if (building.owner === owner && isStore(building)) total += building.reserve;
    });
    this.settlers.forEach((settler) => {
      if (settler.owner === owner) total += 1;
    });
    return total;
  }

  /**
   * A fingerprint of the entire simulation state.
   *
   * The golden tests compare this after a fixed run, so any accidental
   * non-determinism surfaces as a failing test rather than a broken save.
   */
  hash(): string {
    const hasher = new Hasher()
      .int32(this.tick)
      .int32(this.seed)
      .array(this.world.height)
      .array(this.world.object)
      .array(this.world.objectData)
      .array(this.world.owner)
      .array(this.world.roads)
      .array(this.world.resourceAmount);

    this.flags.forEach((flag) => {
      hasher.int32(flag.id).int32(flag.point).int32(flag.wares.length);
      for (const parcel of flag.wares) hasher.int32(parcel.ware).int32(parcel.destination);
    });

    this.roads.forEach((road) => {
      hasher.int32(road.id).int32(road.carrier).int32(road.cost).array(road.points);
    });

    this.buildings.forEach((building) => {
      hasher
        .int32(building.id)
        .int32(building.type)
        .int32(building.point)
        .int32(building.state)
        .int32(building.status)
        .int32(building.worker)
        .int32(building.buildProgress)
        .int32(building.workTimer)
        .int32(building.output ?? -1)
        .int32(building.reserve)
        .array(building.delivered)
        .array(building.incoming)
        .array(building.inputs)
        .array(building.inputsIncoming)
        .array(building.stock);
    });

    this.settlers.forEach((settler) => {
      hasher
        .int32(settler.id)
        .int32(settler.state)
        .int32(settler.point)
        .int32(settler.toPoint)
        .int32(settler.stepProgress)
        .int32(settler.pathIndex)
        .int32(settler.carrying ?? -1)
        .int32(settler.taskTimer);
    });

    return hasher.hex();
  }
}

function isStoreType(info: BuildingInfo): boolean {
  return info.behaviour.kind === 'headquarters' || info.behaviour.kind === 'store';
}

/** How many input slots a building's behaviour needs. */
function inputSlotCount(info: BuildingInfo): number {
  const behaviour = info.behaviour;
  if (behaviour.kind === 'craft') return behaviour.inputs.length;
  if (behaviour.kind === 'extract' && behaviour.food && behaviour.food.length > 0) return 1;
  return 0;
}

const TRIANGLE_SCRATCH = new Int32Array(6);

export { INPUT_STOCK_LIMIT, isStore, outstandingDemand, Direction, BuildSpace };
