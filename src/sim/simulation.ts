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
import { MapObject, Resource, TREE_FULLY_GROWN } from './world/terrain';
import type { World } from './world/world';
import { generateWorld } from './world/worldgen';

/** Simulation ticks per second of game time. */
export const TICKS_PER_SECOND = 20;

/** How far the headquarters claims territory on the first day. */
const HEADQUARTERS_RADIUS = 9;

/** Saplings advance one growth stage every this many ticks. */
const TREE_GROWTH_INTERVAL = 260;

/** How often stranded wares are given a new destination. */
const STRANDED_SWEEP_INTERVAL = 40;

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
  { ware: Ware.Fish, count: 8 },
];

const STARTING_SETTLERS = 32;

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

/** Bumped whenever the shape of a saved game changes. */
export const SAVE_VERSION = 1;

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
  readonly events: readonly string[];
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
  readonly events: string[] = [];

  private rng: Rng;
  /** Points holding a sapling that has not finished growing. */
  private growingTrees: number[] = [];

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

  // ------------------------------------------------------------ the tick

  /** Advances the world by one tick. */
  update(): void {
    this.tick += 1;

    this.updateSettlers();
    this.updateBuildings();
    this.updateRoads();
    this.growTrees();

    if (this.tick % STRANDED_SWEEP_INTERVAL === 0) this.retargetStrandedWares();
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
    return flag;
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
    for (const roadId of [...flag.roads]) {
      const road = this.roads.get(roadId);
      if (road) this.destroyRoad(road);
    }

    this.world.flag[flag.point] = 0;
    this.flags.remove(flag.id);
    this.network.invalidate();
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

    if (road.carrier) this.dismissSettler(road.carrier);

    this.roads.remove(road.id);
    this.network.invalidate();
  }

  /** Sends a settler back into the nearest store, or simply removes it. */
  private dismissSettler(settlerId: number): void {
    const settler = this.settlers.get(settlerId);
    if (!settler) return;

    // Whatever was in hand falls where the settler stood.
    settler.carrying = null;
    this.settlers.remove(settlerId);
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
    if (path.length > 0) this.beginStep(settler);
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

  /** How far along the current step a settler is, for smooth rendering. */
  stepFraction(settler: Settler): number {
    if (settler.stepLength <= 0) return 0;
    return Math.min(1, settler.stepProgress / settler.stepLength);
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
        if (this.advance(settler)) {
          settler.state = SettlerState.AtWork;
          const building = this.buildings.get(settler.building);
          if (building && settler.carrying !== null && building.output === null) {
            building.output = settler.carrying;
          }
          settler.carrying = null;
        }
        return;

      case SettlerState.CarrierCollecting:
        if (this.advance(settler)) this.collectWare(settler);
        return;

      case SettlerState.CarrierDelivering:
        if (this.advance(settler)) this.deliverWare(settler);
        return;

      case SettlerState.CarrierWaiting:
        this.lookForWork(settler);
        return;

      case SettlerState.Building:
        if (settler.path.length > 0) {
          if (this.advance(settler)) settler.taskTimer = 0;
          return;
        }
        this.workOnSite(settler);
        return;

      case SettlerState.AtWork:
      case SettlerState.Idle:
      case SettlerState.ReturningToStore:
        return;
    }
  }

  private arriveAtJob(settler: Settler): void {
    if (settler.road !== 0) {
      const road = this.roads.get(settler.road);
      if (!road) {
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

  private taskDuration(settler: Settler): number {
    const building = this.buildings.get(settler.building);
    if (!building) return 1;
    const behaviour = buildingInfo(building.type).behaviour;
    if (behaviour.kind === 'harvest' || behaviour.kind === 'plant') return behaviour.workTicks;
    return 60;
  }

  /** A woodcutter has finished felling, or a forester has finished planting. */
  private completeTask(settler: Settler): void {
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
    }

    const home = walkablePath(this.world, settler.point, building.point);
    settler.state = SettlerState.ReturningHome;
    this.setPath(settler, home ?? []);
    if ((home?.length ?? 0) === 0) {
      // Already home, or hemmed in — deposit immediately rather than stall.
      settler.point = building.point;
      settler.state = SettlerState.AtWork;
      if (settler.carrying !== null && building.output === null) building.output = settler.carrying;
      settler.carrying = null;
    }
  }

  private workOnSite(settler: Settler): void {
    const building = this.buildings.get(settler.building);
    if (!building || building.state === BuildingState.Complete) {
      this.returnToStore(settler);
      return;
    }

    if (!this.hasAllMaterials(building)) return;

    building.buildProgress += 1;
    if (building.buildProgress < buildingInfo(building.type).buildTicks) return;

    this.completeConstruction(building);
    this.returnToStore(settler);
  }

  private returnToStore(settler: Settler): void {
    settler.building = 0;
    settler.road = 0;
    settler.carrying = null;
    // The builder simply melts back into the population; tracking a walk home
    // would cost more than it adds.
    const store = this.storeFor(settler.owner);
    if (store) store.reserve += 1;
    this.settlers.remove(settler.id);
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
   */
  private lookForWork(settler: Settler): void {
    const road = this.roads.get(settler.road);
    if (!road) {
      this.dismissSettler(settler.id);
      return;
    }

    const position = road.points.indexOf(settler.point);
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

      const path = this.pathAlongRoad(road, settler.point, flag.point);
      if (!path) continue;

      settler.state = SettlerState.CarrierCollecting;
      settler.taskPoint = here;
      this.setPath(settler, path);
      if (path.length === 0) this.collectWare(settler);
      return;
    }
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
        this.receiveWare(building, parcel.ware);
        settler.carrying = null;
        settler.carryDestination = 0;
        settler.state = SettlerState.CarrierWaiting;
        return;
      }
    }

    if (flag.wares.length >= FLAG_CAPACITY) return; // The flag is full; wait.

    // Re-check the route: the network may have changed while walking.
    if (this.nextFlagFor(flag.id, parcel) === undefined && !this.isAcceptableHere(flag, parcel)) {
      const replacement = this.retarget(flag, parcel.ware);
      if (replacement !== undefined) parcel.destination = replacement;
    }

    flag.wares.push(parcel);
    settler.carrying = null;
    settler.carryDestination = 0;
    settler.state = SettlerState.CarrierWaiting;
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
        parcel.destination = this.retarget(flag, parcel.ware) ?? parcel.destination;
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
    this.buildings.forEach((building) => this.updateBuilding(building));
  }

  private updateBuilding(building: Building): void {
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

    // Anything else needs somebody to work it.
    if (building.worker === 0) {
      building.status = BuildingStatus.AwaitingWorker;
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
        this.updateFieldWork(building, behaviour);
        return;
      case 'extract':
        this.updateExtraction(building, behaviour);
        return;
      case 'craft':
        this.updateCraft(building, behaviour);
        return;
      default:
        building.status = BuildingStatus.Working;
    }
  }

  private updateConstruction(building: Building): void {
    building.status = BuildingStatus.UnderConstruction;

    // A site with nothing left to do finishes even without a builder present.
    if (buildingInfo(building.type).buildTicks === 0 && this.hasAllMaterials(building)) {
      this.completeConstruction(building);
      return;
    }

    if (building.worker === 0 && !building.workerRequested) {
      this.requestBuilder(building);
    }
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
    }

    this.note(`${info.name} completed.`);
  }

  private updateFieldWork(
    building: Building,
    behaviour: Extract<
      ReturnType<typeof buildingInfo>['behaviour'],
      { kind: 'harvest' } | { kind: 'plant' }
    >,
  ): void {
    const worker = this.settlers.get(building.worker);
    if (!worker || worker.state !== SettlerState.AtWork) return;

    const target =
      behaviour.kind === 'harvest'
        ? this.findObject(building.point, behaviour.radius, behaviour.object)
        : this.findPlantingSpot(building.point, behaviour.radius);

    if (target === undefined) {
      building.status = BuildingStatus.Exhausted;
      return;
    }

    const path = walkablePath(this.world, worker.point, target);
    if (!path) {
      building.status = BuildingStatus.Exhausted;
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

    const source = this.findResource(building.point, behaviour.radius, behaviour.resource);
    if (source === undefined) {
      building.status = BuildingStatus.Exhausted;
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
    building.output = behaviour.output;
  }

  /** Moves a finished ware out onto the building's flag. */
  private pushOutput(building: Building): boolean {
    if (building.output === null) return true;

    const flagId = this.world.flag[building.flagPoint];
    if (!flagId) return false;

    const flag = this.flags.require(flagId);
    if (flag.wares.length >= FLAG_CAPACITY) return false;

    const destination = chooseDestination(
      this.buildings,
      this.network,
      flagId,
      building.output,
      building.owner,
      (candidate) => this.world.flag[candidate.flagPoint] ?? 0,
    );
    if (!destination) return false;

    // A ware destined for the very building it came from would loop forever.
    if (destination.building === building.id) return false;

    this.reserveIncoming(destination.building, building.output);
    flag.wares.push({ ware: building.output, destination: destination.building });
    building.output = null;
    building.status = BuildingStatus.Working;
    return true;
  }

  /** Stores hand out wares that somebody has asked for. */
  private pushStoredWares(building: Building): void {
    const flagId = this.world.flag[building.flagPoint];
    if (!flagId) return;

    const flag = this.flags.require(flagId);
    if (flag.wares.length >= FLAG_CAPACITY) return;

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

      building.stock[ware] = building.stock[ware]! - 1;
      this.reserveIncoming(destination.building, ware);
      flag.wares.push({ ware, destination: destination.building });
      return;
    }
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

  /** Finds a fresh destination for a ware whose target has gone. */
  private retarget(flag: Flag, ware: Ware): number | undefined {
    const destination = chooseDestination(
      this.buildings,
      this.network,
      flag.id,
      ware,
      flag.owner,
      (candidate) => this.world.flag[candidate.flagPoint] ?? 0,
    );
    if (!destination) return undefined;
    this.reserveIncoming(destination.building, ware);
    return destination.building;
  }

  private retargetWaresBoundFor(buildingId: number): void {
    this.flags.forEach((flag) => {
      for (const parcel of flag.wares) {
        if (parcel.destination !== buildingId) continue;
        parcel.destination = this.retarget(flag, parcel.ware) ?? 0;
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
      const toStart = roadPointPath(this.network, this.roads, storeFlag, road.fromFlag);
      if (!toStart) return;

      // Carriers wait in the middle of their stretch, as in the original.
      const middle = Math.max(1, Math.floor(road.points.length / 2));
      const alongRoad = road.points.slice(1, middle + 1);

      store.reserve -= 1;

      const settler = this.createSettler(road.owner, Profession.Helper, store.flagPoint);
      settler.road = road.id;
      settler.state = SettlerState.WalkingToJob;
      this.setPath(settler, [...toStart, ...alongRoad]);
      road.carrierRequested = true;
    });
  }

  // ------------------------------------------------------------- map search

  /** The nearest point within `radius` carrying the given object. */
  private findObject(centre: number, radius: number, object: MapObject): number | undefined {
    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (this.world.object[point] !== object) continue;
      if (object === MapObject.Tree && this.world.objectData[point]! < TREE_FULLY_GROWN) continue;
      return point;
    }
    return undefined;
  }

  private findResource(centre: number, radius: number, resource: Resource): number | undefined {
    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (this.world.resource[point] === resource && this.world.resourceAmount[point]! > 0) {
        return point;
      }
    }
    return undefined;
  }

  /**
   * Open ground a forester can plant on.
   *
   * The spot is drawn at random from everything suitable rather than taken in
   * scan order, so a forester grows a natural-looking wood instead of a tidy
   * ring around its hut. The draw comes from the simulation's seeded generator,
   * so it stays reproducible.
   */
  private findPlantingSpot(centre: number, radius: number): number | undefined {
    const suitable: number[] = [];

    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (point === centre) continue;
      if (this.world.object[point] !== MapObject.None) continue;
      if (this.world.building[point] !== 0 || this.world.flag[point] !== 0) continue;
      if (this.world.roadCount(point) > 0) continue;

      this.world.trianglesAroundPoint(point, TRIANGLE_SCRATCH);
      let plantable = true;
      for (let t = 0; t < 6; t += 1) {
        const triangle = TRIANGLE_SCRATCH[t]!;
        if (triangle === OUT_OF_BOUNDS || !this.world.propertiesOfTriangle(triangle).plantable) {
          plantable = false;
          break;
        }
      }
      if (plantable) suitable.push(point);
    }

    return this.rng.pick(suitable);
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
      events: [...this.events],
    };
  }

  /** Rebuilds a game from `toSnapshot`. */
  static fromSnapshot(snapshot: SimulationSnapshot): Simulation {
    if (snapshot.version !== SAVE_VERSION) {
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
    simulation.players.push(...snapshot.players.map((player) => ({ ...player })));
    simulation.events.push(...snapshot.events);

    simulation.flags.adopt(snapshot.flags.pool, snapshot.flags.items);
    simulation.roads.adopt(snapshot.roads.pool, snapshot.roads.items);
    simulation.buildings.adopt(snapshot.buildings.pool, snapshot.buildings.items);
    simulation.settlers.adopt(snapshot.settlers.pool, snapshot.settlers.items);

    return simulation;
  }

  // ------------------------------------------------------------- reporting

  private note(message: string): void {
    this.events.push(message);
    if (this.events.length > 32) this.events.shift();
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
