import { Direction, DIRECTIONS } from './core/direction';
import { OUT_OF_BOUNDS } from './core/grid';
import { Hasher } from './core/hash';
import { Rng } from './core/rng';
import { OLDEST_SAVE_VERSION, SAVE_VERSION } from './save-version';
import type { BuildingInfo, BuildingType } from './data/buildings';
import { BuildingType as Type, buildingInfo } from './data/buildings';
import { Profession, professionInfo } from './data/professions';
import { emptyGarrison, garrisonStrength, Rank, RANK_COUNT, TOP_RANK } from './data/ranks';
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
  BuildingSize,
  BuildSpace,
  canHostSize,
  canPlaceFlag,
  canPlaceOutpost,
  canRouteRoadThrough,
  canTraverseEdge,
  evaluateBuildSpace,
  FLAG_DIRECTION,
  isWellInsideTerritory,
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

/**
 * How far a headquarters holds ground — a fortress's reach, because a hall is
 * a fortress for every purpose a border cares about. `START_TERRITORY_RADIUS`
 * in `world/worldgen` follows it, so the wood and stone a start is given still
 * fall inside the opening border.
 */
const HEADQUARTERS_RADIUS = 13;

/**
 * The ring of outposts a dormant rival wakes up holding, and how far out.
 *
 * Far enough from its headquarters that taking them is a campaign rather than
 * one push, and close enough that their ground is one province rather than
 * scattered farmsteads.
 */
const RIVAL_OUTPOSTS = 4;
const RIVAL_OUTPOST_RANGE = 12;
/**
 * The near edge of that ring. Posts packed against the headquarters stand well
 * inside its own claim and add nothing but targets — and a hall now holds
 * ground as a fortress does, thirteen nodes out, so the ring wants to sit near
 * the edge of what the hall already covers rather than in the middle of it.
 */
const RIVAL_OUTPOST_REACH = 9;

/**
 * The ground a building is guaranteed whatever anybody else brings to bear, by
 * size: a large one — a hall or a fortress — keeps two rings, everything else
 * one.
 *
 * Two rings is what puts a border out of reach of a hall's wall: with the first
 * ring inside its own ground on every side, no border line can run there, and
 * the line starts at the second ring at the nearest. A hut or a house has no
 * such claim on the view from its door, so a barracks may stand with the
 * frontier drawn directly around it.
 *
 * Everything past the ring is a question of pressure and nothing else.
 */
const LARGE_KEEP = 2;
const KEEP = 1;

/**
 * How many of its six neighbours a point needs to count as really held, and the
 * most times the edges are swept before giving up. See `settleTheEdges`.
 *
 * A sweep normally settles in one or two passes; the cap is there so that a
 * shape which somehow will not settle costs a bounded amount rather than
 * spinning. Only genuine one-node tendrils erode at three neighbours — a
 * province of any width is untouched — where at four a third of the map goes.
 */
const EDGE_NEIGHBOURS = 3;
const EDGE_PASSES = 16;

/**
 * How far an outpost can send men, and how many of its spare men reach.
 *
 * The frontier is what carries a war forward: to reach further into a
 * neighbour's ground you have to build towards him first, which is what makes
 * the outposts worth putting up rather than merely worth holding. Distance
 * costs strength rather than forbidding the attack outright, so a second line
 * of posts behind the first is worth having.
 *
 * Whole fractions rather than a multiplier: a third of three men must be one
 * man on every machine that will ever run this, and floating point does not
 * promise that.
 */
const ATTACK_BANDS: readonly { readonly within: number; readonly of: number }[] = [
  { within: 12, of: 3 },
  { within: 16, of: 2 },
  { within: 20, of: 1 },
];
const ATTACK_RANGE = ATTACK_BANDS[ATTACK_BANDS.length - 1]!.within;
const ATTACK_BAND_PARTS = 3;

/**
 * How much longer each successive man takes over his first step when a building
 * is pulled down under him, so that a garrison leaves in ones.
 */
const TURN_OUT_STAGGER = 6;

/**
 * How long a man with nowhere of his own to go wanders before he is gone —
 * half a minute at the ordinary pace.
 */
const LOST_TICKS = 150;

/** Ticks between blows, so a fight is something a player can watch happen. */
const DUEL_TICKS = 12;

/**
 * Ticks between one defender falling and the next stepping out of the door.
 *
 * Long enough to read as one man replacing another rather than a number ticking
 * down, short enough that a garrison of nine is a fight and not a siege.
 */
const DEFENDER_PAUSE = 10;

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
 * What a queue at a flag adds to the cost of arriving there, in road cost —
 * which is a node a step, plus the climb.
 *
 * Goods below `QUEUE_FREE` are free: a store keeps its own flag half full of
 * outgoing crates as a matter of course, and that is traffic, not congestion.
 * Above it each waiting crate makes the roads in dearer, so a flag at capacity
 * prices at six nodes — far enough that a crate will take a parallel road to
 * avoid it, much too short to send it wandering across the province.
 *
 * A ramp rather than a threshold, deliberately. Crates begin to prefer the
 * quieter way while a queue is merely growing, instead of all piling in until
 * it is full and then all swinging across at once; and there is no line for the
 * routing to twitch back and forth over as one crate joins the queue and
 * another leaves.
 */
const QUEUE_FREE = 5;
const QUEUE_PRICE = 2;

/** What the goods waiting at a flag add to the cost of routing a crate there. */
function queueAt(flag: Flag): number {
  return Math.max(0, flag.wares.length - QUEUE_FREE) * QUEUE_PRICE;
}

/**
 * How long a building must find nothing before it says so — two full minutes at
 * five ticks a second. Short of that it is simply between trips.
 */
export const EXHAUSTED_REPORT_TICKS = 600;

/**
 * How often a building goes on saying it has nothing to do, once it has said so
 * the first time.
 *
 * Five minutes at five ticks a second. Said once and never again, the notice
 * scrolls out of the ticker and a woodcutter stands idle for the rest of the
 * game with nothing to remind the player it is there; said every tick it would
 * bury everything else. The repeat stops of its own accord — `exhaustedFor`
 * resets the moment the building finds work — so the only way to silence a
 * genuinely finished one is to pull it down, which is the point.
 */
export const EXHAUSTED_REPEAT_TICKS = 1500;

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
  // A little of each food, because a mine eats its own and no other: without
  // this a coal mine could not turn a wheel until a farm, a mill, a well and a
  // bakery stood behind it, and an iron mine not until a pig farm and a
  // slaughterhouse did. Enough to work the first mine of any kind while its
  // chain is built, and not enough to matter once it is.
  { ware: Ware.Fish, count: 8 },
  { ware: Ware.Bread, count: 4 },
  { ware: Ware.Meat, count: 4 },
];

const STARTING_SETTLERS = 32;

/**
 * What a soldier is made of. One of each, and a settler to carry them.
 */
const SOLDIER_COST: readonly Ware[] = [Ware.Sword, Ware.Shield, Ware.Beer];

/**
 * Settlers a store will not train away.
 *
 * Recruiting competes with every trade for the same people, and a player who
 * builds an armoury should not find his sawmills going quiet. The reserve above
 * this line is what the army may have.
 */
export const SETTLERS_KEPT_BACK = 8;

/**
 * Privates the headquarters starts with.
 *
 * Ground is only claimed by a building that is actually held, so without these
 * a new player could not put up so much as a barracks until he had built the
 * whole iron, armoury and brewery chain — which he cannot do without room to
 * build it in. They are the military counterpart of the starting axes: enough
 * to open the frontier once, and no more.
 */
export const STARTING_GARRISON = 6;

/**
 * How many men hold an outpost that faces nobody.
 *
 * A building must have somebody in it to hold ground at all, and inland there
 * is nothing for a second man to do. Manning every barracks to the brim tied up
 * the whole army garrisoning quiet country; one man each frees it to go where
 * the fighting is. Buildings that do face an enemy take their full complement —
 * see `manTheWalls`. Both of these are to become player settings.
 */
export const MINIMUM_GARRISON = 1;

/**
 * How long a store takes to turn a settler and his kit into a soldier.
 *
 * Thirty seconds at five ticks a second — the same rate at which the province
 * takes in a new settler, so recruiting and growth run neck and neck instead of
 * an armoury's backlog emptying the reserve in a single tick.
 */
export const TRAINING_TICKS = 150;

/**
 * How often a new settler turns up at the headquarters — every thirty seconds.
 *
 * One every two minutes could not keep up with what the player was building:
 * laying a food chain and opening a mine or two drained the reserve and then
 * left him waiting on people rather than on materials, which is the wrong thing
 * for a game about hauling goods to be about.
 */
const POPULATION_INTERVAL = 150;

/** How many more people each finished building lets a province support. */
const SETTLERS_PER_BUILDING = 4;

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
  Battle: 'battle',
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
/**
 * Why a building has stopped, in its own terms.
 *
 * Keyed by what the building actually works rather than by the shape of its
 * behaviour: a quarry and a woodcutter are both `harvest`, and keying on that
 * had an exhausted quarry announce it had nothing left to *cut*.
 */
const EXHAUSTED_REASON_FOR_OBJECT: Readonly<Partial<Record<MapObject, string>>> = {
  [MapObject.Tree]: 'no trees left to fell within reach',
  [MapObject.Stone]: 'no stone left to quarry within reach',
};

const EXHAUSTED_REASON_FOR_RESOURCE: Readonly<Partial<Record<Resource, string>>> = {
  [Resource.Fish]: 'the water here is fished out',
  [Resource.Water]: 'the ground here has run dry',
  [Resource.Coal]: 'the coal seam is worked out',
  [Resource.Iron]: 'the iron seam is worked out',
  [Resource.Gold]: 'the gold seam is worked out',
  [Resource.Granite]: 'the granite is worked out',
};

const EXHAUSTED_REASON: Readonly<Record<string, string>> = {
  plant: 'nowhere left to plant',
  farm: 'no ground left to sow',
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
  /**
   * A neighbour rather than a player: given a ring of manned outposts at the
   * outset and nothing else.
   *
   * It never builds, expands or attacks, and it needs no code to be told so —
   * it simply has no roads, so `requestSoldier` can find no store to draw from
   * and its garrisons stay exactly as they were created. What it does is hold
   * ground, and lose it when somebody comes and takes it.
   */
  readonly dormant?: boolean;
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

// Re-exported so every existing importer keeps naming it here, while the
// constant itself is a leaf that a page can read without loading the game.
export { SAVE_VERSION } from './save-version';

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
  /** Who has won, or 0. Absent in saves older than version 6. */
  readonly winner?: number;
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

/** A building holding ground, for `redrawTerritory` to work a border out from. */
interface Claimant {
  readonly building: number;
  readonly point: number;
  readonly radius: number;
  /**
   * The tick it became its owner's, for settling a dead heat: the side who has
   * held a place longest keeps it. Nought for a headquarters, which has been
   * its owner's since the beginning in every case.
   */
  readonly mannedAt: number;
  readonly player: number;
}

/** A point that has changed hands, and who has just lost it. */
interface Overrun {
  readonly point: number;
  readonly loser: number;
}

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

  /**
   * The player who has won, or 0 while the war is undecided.
   *
   * A province ends when its headquarters is taken; the last one standing wins.
   */
  winner = 0;

  /** Recent notices for the message ticker, newest last. */
  readonly events: GameMessage[] = [];

  private rng: Rng;
  /**
   * Military buildings that look across at another player's ground, by id.
   *
   * Derived from the map, not saved: rebuilt on the sweep beat, and empty for
   * the first few ticks after a load, which costs a garrison nothing.
   */
  private readonly frontierPosts = new Set<number>();
  /** Store points with somebody on the step between the door and the flag. */
  private readonly busyDoorways = new Set<number>();
  /**
   * Military buildings with a fight of their own going on, by id: their men are
   * out on a sortie, or somebody is standing at their flag. Derived from the
   * settlers and rebuilt every tick, so nothing to save.
   */
  private readonly engagedPosts = new Set<number>();
  /** Points holding a sapling that has not finished growing. */
  private growingTrees: number[] = [];
  /** Points holding corn that has not finished ripening. */
  private growingFields: number[] = [];

  private constructor(world: World, seed: number) {
    this.world = world;
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x51ed270b);
    this.network = new FlagNetwork(this.flags, this.roads, queueAt);
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
      // A foothold first: a hall cannot raise its flag on ground nobody owns —
      // nothing may stand on a frontier node, so the flag's own neighbours
      // must be his too — and the first building on an island has to stand
      // somewhere before there is anything to work a border out from. Two
      // nodes, well inside the nine the hall is about to hold.
      for (const near of simulation.world.grid.pointsWithin(point, 2)) {
        simulation.world.owner[near] = id;
      }

      const headquarters = simulation.createBuilding(Type.Headquarters, point, id);
      if (!headquarters) throw new Error('the generated start site could not take a headquarters');

      headquarters.state = BuildingState.Complete;
      headquarters.status = BuildingStatus.Working;
      // After the hall stands, not before: ground is worked out from the
      // buildings that hold it, so there has to be a building to hold it.
      simulation.redrawTerritory(point, HEADQUARTERS_RADIUS);
      for (const entry of STARTING_STOCK) {
        headquarters.stock[entry.ware] = (headquarters.stock[entry.ware] ?? 0) + entry.count;
      }
      // The six are *among* the thirty-two, not on top of them: a province
      // supports the people it supports, and some of them are already soldiers.
      headquarters.reserve = STARTING_SETTLERS - STARTING_GARRISON;
      headquarters.garrison[Rank.Private] = STARTING_GARRISON;

      simulation.players[slot]!.headquarters = headquarters.id;

      if (config.dormant) simulation.raiseRivalOutposts(headquarters, id);
    });

    return simulation;
  }

  /**
   * Rings a dormant rival's headquarters with manned outposts.
   *
   * Built the way a player would build them — `evaluateBuildSpace` and
   * `canPlaceOutpost` decide where one fits, so the rival obeys the same
   * spacing as anybody else — but finished and garrisoned on the spot, since
   * there are no roads for men to march along and never will be.
   *
   * Deterministic: sites are taken in the grid's own order, so the same seed
   * always produces the same frontier.
   */
  private raiseRivalOutposts(headquarters: Building, owner: number): void {
    const behaviour = buildingInfo(Type.Barracks).behaviour;
    if (behaviour.kind !== 'military') return;

    let raised = 0;
    for (const point of this.world.grid.pointsWithin(headquarters.point, RIVAL_OUTPOST_RANGE)) {
      if (raised >= RIVAL_OUTPOSTS) break;
      if (this.world.grid.distance(headquarters.point, point) < RIVAL_OUTPOST_REACH) continue;

      const space = evaluateBuildSpace(this.world, point, owner);
      if (space === BuildSpace.None || !canHostSize(space, buildingInfo(Type.Barracks).size)) {
        continue;
      }
      if (!canPlaceOutpost(this.world, point, owner)) continue;

      const outpost = this.createBuilding(Type.Barracks, point, owner);
      if (!outpost) continue;

      outpost.state = BuildingState.Complete;
      outpost.status = BuildingStatus.Working;
      outpost.garrison[Rank.Private] = behaviour.garrison;
      this.redrawTerritory(point, behaviour.radius);
      raised += 1;
    }
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

    if (info.behaviour.kind === 'military' && !canPlaceOutpost(this.world, point, player)) {
      return fail(`A ${info.name} must stand clear of your other outposts.`);
    }

    const building = this.createBuilding(type, point, player);
    if (!building) return fail(`A ${info.name} cannot be built there.`);
    return OK;
  }

  /**
   * Sends men from the outposts in reach to take an enemy building.
   *
   * Every outpost keeps its last man: ground is held by the men standing in a
   * building, so emptying one to fill an attack would give away at home exactly
   * what the attack is trying to win. The strongest go first — the gold that
   * promoted them was spent for this.
   */
  attack(player: number, point: number, men: number): CommandResult {
    if (this.winner !== 0) return fail('The war is over.');

    const id = this.world.building[point];
    if (!id) return fail('There is no building there.');

    const target = this.buildings.require(id);
    if (target.owner === player) return fail('That is yours already.');
    if (!isAttackable(target)) return fail('There is nothing there to take.');

    const from = this.attackersWithin(player, target.point);
    if (from.length === 0) {
      return fail('No outpost of yours is near enough to send anybody.');
    }

    const spare = this.menInReachOf(from, target.point);
    if (spare <= 0) return fail('Your outposts have nobody to spare.');

    const sending = Math.min(Math.max(1, Math.floor(men)), spare);
    let sent = 0;

    for (const post of from) {
      const allowed = menToSendFrom(post, this.world.grid.distance(post.point, target.point));
      let fromHere = 0;

      while (sent < sending && fromHere < allowed && garrisonStrength(post.garrison) > 1) {
        const rank = strongestIn(post.garrison);
        if (rank === undefined) break;

        post.garrison[rank] = post.garrison[rank]! - 1;

        // He starts inside, and leaves when the door is clear: an outpost has
        // one way out, the same as a store, and men appearing on the map six at
        // a time is a conjuring trick rather than a sortie.
        const soldier = this.createSettler(player, Profession.Soldier, post.point);
        soldier.rank = rank;
        soldier.homePost = post.id;
        soldier.building = target.id;
        soldier.taskPoint = this.nextStandingPlace(target);
        soldier.state = SettlerState.Mustering;

        sent += 1;
        fromHere += 1;
      }
    }

    if (sent === 0) return fail('Your outposts have nobody to spare.');

    this.note(
      `${sent} ${sent === 1 ? 'man marches' : 'men march'} on the ${buildingInfo(target.type).name.toLowerCase()}.`,
      MessageCategory.Battle,
      target.point,
    );
    return OK;
  }

  /**
   * Where the next man sent against a building is to stand.
   *
   * The flag first — that is the place the fight is had — and behind it a line
   * of men a node apart, each stepping back from the last away from the walls.
   * Standing places are held by the man they were given to for the whole march,
   * so two men never set out for the same node.
   */
  private nextStandingPlace(target: Building): number {
    const taken = new Set<number>();
    this.settlers.forEach((settler) => {
      if (settler.building === target.id && isAttacking(settler)) taken.add(settler.taskPoint);
    });

    let at = target.flagPoint;
    let heading: Direction | undefined;
    const line = new Set<number>([at]);

    while (taken.has(at)) {
      const next = this.nextInLine(target, at, heading, taken, line);
      // Hemmed in by water or rock with every place taken: he shares the last
      // one rather than not coming at all.
      if (next === undefined) return at;
      at = next.point;
      heading = next.direction;
      line.add(at);
    }

    return at;
  }

  /**
   * The next node back along a queue of attackers.
   *
   * A man walks out along the men already standing to the end of the queue and
   * takes the next place past it. Following an occupied node beats everything,
   * because the line on the ground *is* the line; after that the line **turns
   * one notch** from the way it came, which on a six-sided lattice draws an
   * arc. Holding the heading comes next, and among places that are otherwise
   * equal, whichever is furthest from the walls.
   *
   * A step back towards the building is refused outright, so the queue always
   * leads away from the fight before it begins to bend. What it draws is a body
   * of men curving round the place they are besieging, rather than the arrow
   * straight tail a fixed heading gave — which read as a parade rather than a
   * siege, and pointed off across country whatever the ground was doing.
   */
  private nextInLine(
    target: Building,
    from: number,
    heading: Direction | undefined,
    taken: ReadonlySet<number>,
    line: ReadonlySet<number>,
  ): { point: number; direction: Direction } | undefined {
    const ON_THE_LINE = 1000;
    const ROUND_THE_WALLS = 200;
    const STRAIGHT_ON = 100;

    const here = this.world.grid.distance(target.point, from);
    const turned = heading === undefined ? undefined : (((heading + 1) % 6) as Direction);

    let best: { point: number; direction: Direction } | undefined;
    let bestScore = -1;

    for (const direction of DIRECTIONS) {
      const point = this.world.grid.neighbour(from, direction);
      if (point === OUT_OF_BOUNDS || line.has(point)) continue;
      if (this.world.building[point] !== 0) continue;
      if (!this.world.isWalkable(point)) continue;

      const away = this.world.grid.distance(target.point, point);
      if (away < here) continue;

      const score =
        (taken.has(point) ? ON_THE_LINE : 0) +
        (direction === turned ? ROUND_THE_WALLS : 0) +
        (direction === heading ? STRAIGHT_ON : 0) +
        away;
      if (score <= bestScore) continue;

      best = { point, direction };
      bestScore = score;
    }

    return best;
  }

  /**
   * A soldier waits inside his outpost until the door is clear, then marches.
   *
   * One man on the step at a time, exactly as workers leave a store: an outpost
   * has one way out, and six men appearing on the map together is a conjuring
   * trick rather than a sortie.
   */
  private stepOutToAttack(settler: Settler): void {
    const postId = this.world.building[settler.point];
    const post = postId ? this.buildings.get(postId) : undefined;
    const target = this.buildings.get(settler.building);

    if (!post || post.owner !== settler.owner) {
      // The post was taken or pulled down with him still inside it.
      this.sendHome(settler);
      return;
    }
    if (!target || target.owner === settler.owner || !isAttackable(target)) {
      this.standDown(settler, post);
      return;
    }

    if (!this.takeTheDoorway(post)) return;

    // Out by his own flag, the way every settler in the game leaves a
    // building, and only then across country. His standing place may be
    // unreachable when the flag itself is not — rock behind the walls, or a
    // queue that has wound into a corner.
    const path =
      this.pathOutOf(post, settler.taskPoint) ?? this.pathOutOf(post, target.flagPoint);
    if (!path) {
      this.standDown(settler, post);
      return;
    }
    if (path.length === 0) {
      settler.taskPoint = post.point;
      this.arriveAtTheFight(settler);
      return;
    }

    settler.taskPoint = path[path.length - 1]!;
    settler.state = SettlerState.MarchingToAttack;
    this.setPath(settler, path);
  }

  /**
   * A route out of a building's door that goes by its flag first.
   *
   * A building has one way out and it is the doorstep, so a man setting off
   * across country still steps onto his own flag before he goes anywhere —
   * which is what `surveyDoorways` watches for, and what everybody else in the
   * game already does.
   */
  private pathOutOf(building: Building, to: number): number[] | undefined {
    return this.pathAcross(building.point, to);
  }

  /**
   * A route across country that never cuts a corner into a building.
   *
   * A building has one way in and one way out and it is the flag on its
   * doorstep. Left to the pathfinder a man walks at the door from whichever
   * side he happens to be on, which is to say through the wall — so a route
   * that starts on a door starts by stepping onto its flag, and one that ends
   * on a door comes in over its flag, whatever lies between.
   */
  private pathAcross(from: number, to: number): number[] | undefined {
    if (from === to) return [];

    const leaving = this.buildingAt(from);
    const arriving = this.buildingAt(to);

    // Both ends of the walk proper are flags, or plain ground.
    const start = leaving ? leaving.flagPoint : from;
    const finish = arriving ? arriving.flagPoint : to;

    const between = start === finish ? [] : walkablePath(this.world, start, finish);
    if (!between) return undefined;

    const route: number[] = [];
    if (leaving && start !== from) route.push(start);
    route.push(...between);
    if (arriving) route.push(to);

    // Standing on the door of the building he is walking to: he is already in.
    return route.length === 1 && route[0] === from ? [] : route;
  }

  /** The building whose door is this point, if any. */
  private buildingAt(point: number): Building | undefined {
    const id = this.world.building[point];
    return id ? this.buildings.get(id) : undefined;
  }

  /**
   * A soldier reaches the place he was sent to stand.
   *
   * If the building has already fallen — somebody else's blow landed first, or
   * it was pulled down — there is nothing to fight, and he goes home. The man
   * at the flag fights; the rest wait a node apart behind him.
   */
  private arriveAtTheFight(settler: Settler): void {
    const target = this.buildings.get(settler.building);
    if (!target || target.owner === settler.owner || !isAttackable(target)) {
      // Nothing to fight: back to his own post, and only to a store if it will
      // not have him.
      this.goBackToPost(settler);
      return;
    }

    settler.state =
      settler.point === target.flagPoint ? SettlerState.Fighting : SettlerState.WaitingToFight;
    settler.taskTimer = DUEL_TICKS;
  }

  /**
   * The men outside a building their side has just taken go in, one at a time.
   *
   * Possession is walked, not granted: the nearest man goes by the flag and
   * then the door while the rest wait where they stood, and only when he is
   * inside does the next set off. The place fills to what it can hold —
   * `joinGarrison` counts that — and whoever is left over walks back to the
   * post he marched out of.
   */
  private takePossession(): void {
    const waiting = new Map<number, Settler[]>();
    const onTheWay = new Set<number>();

    this.settlers.forEach((settler) => {
      if (settler.state === SettlerState.WaitingToEnter) {
        const at = waiting.get(settler.building);
        if (at) at.push(settler);
        else waiting.set(settler.building, [settler]);
        return;
      }
      // Somebody already walking in — a man of the storming party or a
      // replacement sent up from a store, it makes no difference to the door.
      if (settler.state === SettlerState.WalkingToJob && settler.profession === Profession.Soldier) {
        onTheWay.add(settler.building);
      }
    });

    for (const [buildingId, men] of waiting) {
      const post = this.buildings.get(buildingId);
      const behaviour = post ? buildingInfo(post.type).behaviour : undefined;

      // A hall with nobody left in it: one man walks in and throws it down.
      // Should its garrison have filled again while they waited — a store goes
      // on training men however the fight is going — the matter is not settled
      // after all, and they go back to it.
      if (post && behaviour?.kind === 'headquarters' && post.owner !== men[0]!.owner) {
        if (garrisonStrength(post.garrison) > 0) {
          for (const man of men) this.arriveAtTheFight(man);
          continue;
        }
        if (!onTheWay.has(buildingId)) this.walkOneIn(post, men, false);
        continue;
      }

      if (!post || !behaviour || behaviour.kind !== 'military' || post.owner !== men[0]!.owner) {
        // Lost again, or pulled down under them.
        for (const man of men) this.goBackToPost(man);
        continue;
      }

      const room = behaviour.garrison - garrisonStrength(post.garrison) - post.garrisonRequested;
      if (room <= 0) {
        for (const man of men) this.goBackToPost(man);
        continue;
      }
      if (onTheWay.has(buildingId)) continue;

      this.walkOneIn(post, men, true);
    }
  }

  /**
   * The nearest of a waiting party goes in, by the flag and then the door.
   *
   * Nearest first, lowest id to split a tie, so the order never depends on
   * which way the settler table happens to be walked. `expected` is for a post
   * he is going to hold — the place he will take is counted against it while he
   * walks — and false for a hall he is only going in to throw down.
   */
  private walkOneIn(building: Building, men: readonly Settler[], expected: boolean): void {
    let next: Settler | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const man of men) {
      const distance = this.world.grid.distance(man.point, building.flagPoint);
      if (distance > nearest) continue;
      if (distance === nearest && next && man.id >= next.id) continue;
      nearest = distance;
      next = man;
    }
    if (!next) return;

    const path = this.pathInTo(building, next.point);
    if (!path) {
      this.goBackToPost(next);
      return;
    }

    next.state = SettlerState.WalkingToJob;
    if (expected) building.garrisonRequested += 1;
    if (path.length === 0) {
      this.joinGarrison(next);
      return;
    }
    this.redirect(next, path);
  }

  /**
   * A route into a building that goes by its flag and then its door — the way
   * in is the way out, walked backwards.
   */
  private pathInTo(building: Building, from: number): number[] | undefined {
    return this.pathAcross(from, building.point);
  }

  /**
   * A soldier with nothing left to do walks back to the outpost he marched out
   * of, rather than to the nearest store.
   *
   * The post may be full by the time he arrives, or gone altogether;
   * `joinGarrison` turns him away in the first case and `sendHome` catches the
   * second, so he is never left standing in a field.
   */
  private goBackToPost(settler: Settler): void {
    const post = this.buildings.get(settler.homePost);
    const behaviour = post ? buildingInfo(post.type).behaviour : undefined;

    if (!post || !behaviour || behaviour.kind !== 'military' || post.owner !== settler.owner) {
      this.sendHome(settler);
      return;
    }
    if (garrisonStrength(post.garrison) + post.garrisonRequested >= behaviour.garrison) {
      this.sendHome(settler);
      return;
    }

    const path = this.pathInTo(post, this.committedPoint(settler));
    if (!path) {
      this.sendHome(settler);
      return;
    }

    settler.building = post.id;
    settler.state = SettlerState.WalkingToJob;
    post.garrisonRequested += 1;
    if (path.length === 0) {
      this.joinGarrison(settler);
      return;
    }
    this.redirect(settler, path);
  }

  /**
   * A soldier goes back inside the building he came out of, rank intact.
   *
   * For a defender whose attackers have all fallen, and for a man mustered for
   * an attack that no longer has anything to attack.
   */
  private standDown(settler: Settler, building: Building | undefined): void {
    if (
      !building ||
      building.owner !== settler.owner ||
      building.garrison.length === 0 ||
      this.buildings.get(building.id) !== building
    ) {
      this.sendHome(settler);
      return;
    }

    building.garrison[settler.rank] = (building.garrison[settler.rank] ?? 0) + 1;
    building.status = BuildingStatus.Working;
    this.settlers.remove(settler.id);
  }

  /**
   * One blow at a time, at every building somebody is standing outside.
   *
   * The men queue and go in one at a time rather than swarming, which is both
   * how the original reads and what makes a garrison of good men worth having:
   * numbers tell, but so does rank, and a fight is something the player can
   * watch turn.
   */
  private fightBattles(): void {
    const parties = new Map<number, Settler[]>();
    const defenders = new Map<number, Settler>();

    this.settlers.forEach((settler) => {
      if (settler.state === SettlerState.Defending) {
        const already = defenders.get(settler.building);
        if (!already || settler.id < already.id) defenders.set(settler.building, settler);
        return;
      }
      // Everybody committed to the fight, the men still walking up included.
      // They hold places in the line, and while one of them is on his way the
      // attack is not over — which is what keeps the man on the door out.
      if (!isAttacking(settler)) return;

      const at = parties.get(settler.building);
      if (at) at.push(settler);
      else parties.set(settler.building, [settler]);
    });

    for (const [buildingId, party] of parties) {
      const target = this.buildings.get(buildingId);
      // Already ours is as good as gone: a man left standing at a building his
      // own side now holds must not start battering it. Ids are recycled here,
      // so "the building he set out for" can even be somebody else's building
      // entirely by the time he arrives.
      if (!target || !isAttackable(target) || target.owner === party[0]!.owner) {
        // Back to the post he marched out of, which is where a man expects to
        // end up when the fight he set out for is over before he gets there.
        // `goBackToPost` falls through to a store if it has no room for him.
        for (const attacker of party) this.goBackToPost(attacker);
        continue;
      }

      const defender = defenders.get(buildingId);
      // Taken from the map here so that what is left in it at the end is
      // exactly the defenders whose attackers are every one of them gone.
      defenders.delete(buildingId);

      // The line shuffles up before anything else happens, so the place at the
      // flag is filled by whoever is next in it rather than by whoever happens
      // to be nearest.
      this.closeUpTheQueue(target, party);

      // Only the men who have arrived take a building: one still walking is
      // sent home by `arriveAtTheFight` when he gets there and finds it taken.
      const arrived = party.filter(
        (man) =>
          man.state === SettlerState.Fighting || man.state === SettlerState.WaitingToFight,
      );

      if (!defender) {
        // A breath between one man falling and the next coming out.
        if (target.defenderDelay > 0) {
          target.defenderDelay -= 1;
          continue;
        }
        // Nothing happens at a building until somebody is standing on its flag.
        // A garrison does not turn out because an attack has been *ordered* —
        // it turns out because there is a man at the door, and until then the
        // men marching up are somebody else's business. Counting them was what
        // put a defender on the step sixty ticks before anybody could reach
        // him.
        if (!this.manAtTheFlag(arrived)) continue;

        if (garrisonStrength(target.garrison) <= 0) {
          this.captureBuilding(target, arrived);
          continue;
        }
        this.sendOutDefender(target);
        continue;
      }

      // Somebody has to be standing at the flag for blows to be traded. While
      // the man whose place it is walks up into it, nobody fights — which is
      // what puts a beat between one duel and the next.
      const front = this.manAtTheFlag(arrived);
      if (!front) continue;

      front.taskTimer -= 1;
      if (front.taskTimer > 0) continue;

      front.taskTimer = DUEL_TICKS;
      this.exchangeBlows(target, front, defender);
    }

    // Beaten off: whoever is left standing outside goes back in.
    for (const [buildingId, defender] of defenders) {
      this.standDown(defender, this.buildings.get(buildingId));
    }
  }

  /**
   * The line shuffles up: every man takes the place of the man ahead of him.
   *
   * The queue used to be handed out once, when the men set out, and never
   * touched again — so a man falling at the flag left an empty node in the
   * middle of the line for the rest of the fight, with the men behind him
   * standing exactly where they had stopped. What a player watching sees now is
   * a queue closing ranks: one place goes out of it, and everybody behind moves
   * up one.
   *
   * The line itself is laid out from the flag by the same walk that laid it out
   * in the first place, with the places the men presently hold offered to
   * `nextInLine` so that it follows the line already on the ground rather than
   * drawing a new one somewhere else.
   */
  private closeUpTheQueue(target: Building, party: readonly Settler[]): void {
    if (party.length === 0) return;

    const held = new Set<number>();
    for (const man of party) held.add(man.taskPoint);

    const line: number[] = [];
    const walked = new Set<number>([target.flagPoint]);
    let at = target.flagPoint;
    let heading: Direction | undefined;

    while (line.length < party.length) {
      line.push(at);
      if (line.length === party.length) break;

      const next = this.nextInLine(target, at, heading, held, walked);
      // Hemmed in by water or rock: the rest share the last place rather than
      // being left without one.
      if (!next) break;
      at = next.point;
      heading = next.direction;
      walked.add(at);
    }

    // Order along the line, which for a queue trailing away from a flag is
    // order by distance from it. Nothing but this function moves a man's place,
    // so the order holds from tick to tick and nobody swaps back and forth.
    const inOrder = [...party].sort(
      (a, b) =>
        this.world.grid.distance(a.taskPoint, target.flagPoint) -
          this.world.grid.distance(b.taskPoint, target.flagPoint) || a.id - b.id,
    );

    for (let i = 0; i < inOrder.length; i += 1) {
      const man = inOrder[i]!;
      const place = line[Math.min(i, line.length - 1)]!;
      if (man.taskPoint === place) continue;

      man.taskPoint = place;
      // A man still inside his own post has not started walking yet, and
      // `stepOutToAttack` will read the place he has just been given.
      if (man.state === SettlerState.Mustering) continue;

      const path = walkablePath(this.world, this.committedPoint(man), place);
      if (!path) continue; // No way through; he holds where he is.
      if (path.length === 0) {
        this.arriveAtTheFight(man);
        continue;
      }

      man.state = SettlerState.MarchingToAttack;
      this.redirect(man, path);
    }
  }

  /** The man trading blows at a building's flag, if one is standing there. */
  private manAtTheFlag(arrived: readonly Settler[]): Settler | undefined {
    let front: Settler | undefined;
    for (const attacker of arrived) {
      if (attacker.state !== SettlerState.Fighting) continue;
      if (!front || attacker.id < front.id) front = attacker;
    }
    return front;
  }

  /**
   * The next man of a garrison steps out onto the door to hold it.
   *
   * He leaves the garrison to become somebody on the map, which is what makes a
   * fight something to watch rather than a count going down; he goes back in
   * again if the attack is beaten off. The strongest first — the gold that
   * promoted him was spent for exactly this.
   */
  private sendOutDefender(target: Building): void {
    const rank = strongestIn(target.garrison);
    if (rank === undefined) return;

    target.garrison[rank] = target.garrison[rank]! - 1;

    const defender = this.createSettler(target.owner, Profession.Soldier, target.point);
    defender.rank = rank;
    defender.building = target.id;
    defender.taskPoint = target.point;
    defender.state = SettlerState.Defending;
    defender.taskTimer = DUEL_TICKS;
  }

  /**
   * One blow between the man at the flag and the man on the door.
   *
   * The odds run with rank and never to certainty: weights of `rank + 1` give a
   * general five chances against a private's one, and two men of a rank an even
   * fight. Rolled on the simulation's own generator, so a battle replays the
   * same way from the same save.
   */
  private exchangeBlows(target: Building, attacker: Settler, defender: Settler): void {
    const attackerWeight = attacker.rank + 1;
    const defenderWeight = defender.rank + 1;

    if (this.rng.nextInt(attackerWeight + defenderWeight) < attackerWeight) {
      this.settlers.remove(defender.id);
      target.defenderDelay = DEFENDER_PAUSE;
      return;
    }

    this.settlers.remove(attacker.id);
  }

  /**
   * The last defender has fallen: the building changes hands.
   *
   * It keeps its type and its flag — a captured barracks is a barracks — and
   * the men who took it become its garrison. The ground is then worked out
   * again, so what goes over is what the loser can no longer cover from
   * anywhere else, and whatever he left standing on it comes down.
   */
  private captureBuilding(target: Building, attackers: Settler[]): void {
    const behaviour = buildingInfo(target.type).behaviour;
    const loser = target.owner;
    const winner = attackers[0]!.owner;

    if (behaviour.kind === 'headquarters') {
      // A headquarters is not held, it is thrown down — but not from the flag.
      // Somebody has to walk in and do it, the same as taking a post: the men
      // wait where they stood and `takePossession` sends the nearest of them in
      // by the flag and the door.
      for (const attacker of attackers) {
        attacker.state = SettlerState.WaitingToEnter;
        attacker.taskTimer = 0;
      }
      return;
    }

    target.owner = winner;
    target.garrison.fill(0);
    target.garrisonRequested = 0;
    target.defenderDelay = 0;
    // A post is as old as the day it became yours. Whatever it had stood
    // through for the man who built it counts for him and not for the man who
    // has just walked in, so a border it is now pushing on cannot be won by an
    // age it earned on the other side.
    target.mannedAt = this.tick;
    // Empty, and holding nothing until somebody is inside it — exactly a
    // newly built post. The ground goes over when the first man is in, which
    // is why there is no redraw here.
    target.status = BuildingStatus.Unmanned;
    this.world.outpost[target.point] = winner;

    const flagId = this.world.flag[target.flagPoint];
    const flag = flagId ? this.flags.get(flagId) : undefined;
    if (flag) flag.owner = winner;

    // The men do not blink inside: they wait where they stood and go in one at
    // a time by the flag and the door, and whoever finds it full walks back to
    // the post he set out from.
    for (const attacker of attackers) {
      attacker.state = SettlerState.WaitingToEnter;
      attacker.taskTimer = 0;
    }

    this.note(
      `${buildingInfo(target.type).name} taken from the ${this.nameOf(loser)}.`,
      MessageCategory.Battle,
      target.point,
    );
  }

  /**
   * A man is inside the enemy's hall, and it comes down.
   *
   * He is standing on its door when it does — nobody has ever thrown a building
   * down from outside it — and he steps back out of the wreck the way anybody
   * leaves a demolished building, because `destroyBuilding` turns out whoever
   * is inside. Everything the hall was holding goes with it: its people onto
   * the ground, its ground back to whoever else can cover it, and the war to
   * whoever is left standing.
   */
  private stormTheHall(hall: Building, settler: Settler): void {
    const loser = hall.owner;

    this.note(
      `The ${this.nameOf(loser)} headquarters has fallen.`,
      MessageCategory.Battle,
      hall.point,
    );

    // Down it comes, with everybody who was inside it turned out onto the
    // ground around him.
    this.destroyBuilding(hall);

    // And he walks back out of it himself, to the post he marched from if it
    // will have him and to a store of his own if it will not.
    this.goBackToPost(settler);
  }

  private nameOf(player: number): string {
    return this.players.find((candidate) => candidate.id === player)?.name ?? 'enemy';
  }

  /** Ends the war when only one province still has a headquarters. */
  private settleTheWar(): void {
    if (this.winner !== 0) return;

    const standing = this.players.filter((player) => {
      const home = this.buildings.get(player.headquarters);
      return home !== undefined && home.owner === player.id;
    });

    if (standing.length !== 1 || this.players.length < 2) return;

    this.winner = standing[0]!.id;
    this.note(`${standing[0]!.name} has won the war.`, MessageCategory.Battle);
  }

  /**
   * The player's manned outposts near enough to send men to a point.
   *
   * Manned, not *sparing*: a post down to its last man is still near enough,
   * and keeping it in the list is what lets the refusal say "nobody to spare"
   * rather than "nothing near enough", which would be a different and untrue
   * complaint.
   */
  private attackersWithin(player: number, point: number): Building[] {
    const near: Building[] = [];

    this.buildings.forEach((building) => {
      if (building.owner !== player) return;
      if (building.state !== BuildingState.Complete) return;
      if (buildingInfo(building.type).behaviour.kind !== 'military') return;
      if (garrisonStrength(building.garrison) <= 0) return;
      if (this.world.grid.distance(building.point, point) > ATTACK_RANGE) return;
      near.push(building);
    });

    // Nearest first, so the men with least ground to cross set out.
    return near.sort(
      (a, b) =>
        this.world.grid.distance(a.point, point) - this.world.grid.distance(b.point, point) ||
        a.id - b.id,
    );
  }

  /** How many men could be sent against a point, for the panel to offer. */
  menToSpare(player: number, point: number): number {
    return this.menInReachOf(this.attackersWithin(player, point), point);
  }

  /**
   * What a set of posts can send against a point between them.
   *
   * Counted through the same bands the march itself uses, so what the panel
   * offers and what actually sets out are the same number.
   */
  private menInReachOf(posts: readonly Building[], point: number): number {
    let total = 0;
    for (const post of posts) {
      total += menToSendFrom(post, this.world.grid.distance(post.point, point));
    }
    return total;
  }

  /**
   * A man with nowhere of his own left to walk to.
   *
   * He wanders — a step at a time, wherever the ground allows, on the
   * simulation's own generator so a replay wanders the same way — and after
   * `LOST_TICKS` he is gone. Long enough to watch a beaten province scatter,
   * short enough that the map is not left littered.
   */
  private loseHim(settler: Settler): void {
    settler.building = 0;
    settler.road = 0;
    settler.carrying = null;
    settler.carryDestination = 0;
    settler.state = SettlerState.Lost;
    settler.taskTimer = LOST_TICKS;
    this.setPath(settler, []);
  }

  /** One step of a wander, and the end of it when his time runs out. */
  private updateLost(settler: Settler): void {
    settler.taskTimer -= 1;
    if (settler.taskTimer <= 0) {
      this.settlers.remove(settler.id);
      return;
    }

    if (!this.advance(settler)) return;

    const around = this.groundAround(this.committedPoint(settler));
    if (around.length === 0) return;
    this.setPath(settler, [around[this.rng.nextInt(around.length)]!]);
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

    // A building's flag is part of the building. Taking it away takes the
    // building with it, which is what a player reaching for the flag of
    // something he wants gone expects. Demolishing on its own leaves the flag
    // standing — right for the Demolish button, since roads still meet there —
    // so the flag is pulled down afterwards as well, that being what was asked
    // for. If the building refuses to go, the flag stays too.
    if (flag.building !== 0) {
      const building = this.buildings.get(flag.building);
      if (building) {
        const demolished = this.demolishBuilding(player, building.point);
        if (!demolished.ok) return demolished;
      }
    }

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

    if (!this.takeTheDoorway(store)) return fail('Somebody is already on the way out.');

    store.reserve -= 1;
    if (tool !== null) store.stock[tool] = store.stock[tool]! - 1;

    const settler = this.createSettler(player, Profession.Geologist, store.point);
    settler.surveyFrom = point;
    settler.state = SettlerState.WalkingToJob;
    this.setPath(settler, [store.flagPoint, ...path]);

    this.note('A geologist sets out.', MessageCategory.Survey, point);
    return OK;
  }

  // ------------------------------------------------------------ the tick

  /** Advances the world by one tick. */
  update(): void {
    this.tick += 1;

    // Last tick's queues are last tick's news. Routing is re-priced once, here,
    // so every decision taken during a tick is taken against the same picture.
    this.network.invalidateTraffic();

    this.updateSettlers();
    this.fightBattles();
    // After they have moved and before anybody else is sent out, so a store
    // knows whether its own doorstep is clear and a post knows whether it still
    // has a fight on.
    this.surveyDoorways();
    this.surveyTheFighting();
    this.takePossession();
    this.updateBuildings();
    this.updateRoads();
    this.growTrees();
    this.growFields();
    this.growPopulation();

    if (this.tick % STRANDED_SWEEP_INTERVAL === 0) {
      // Re-aim first, then count: the sweep changes where crates are bound, and
      // the reservations have to agree with where they end up.
      this.retargetStrandedWares();
      this.turnBackDistantSupply();
      this.reconcileIncoming();
      this.surveyFrontier();
    }
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
      // Everything here is judged from the node he is committed to, not the one
      // behind him: a flag raised under a walking man used to restart his step
      // from the node he had just left, throwing him backwards.
      const from = this.committedPoint(carrier);

      // The carrier keeps the half it is standing on; `updateRoads` sends a
      // second settler out to the other half on the next tick.
      const half = first.points.includes(from) ? first : second;
      half.carrier = carrier.id;
      half.carrierRequested = false;
      carrier.road = half.id;

      if (carrier.carrying !== null) {
        // The new flag is an endpoint of both halves, so it is always a legal
        // place to hand the crate over; routing takes it onward from there.
        carrier.state = SettlerState.CarrierDelivering;
        carrier.taskPoint = flag.id;
        this.redirect(carrier, this.pathAlongRoad(half, from, flag.point) ?? []);
        if (carrier.pathIndex >= carrier.path.length) this.deliverWare(carrier);
      } else {
        carrier.state = SettlerState.CarrierWaiting;
        this.haltWhereHeStands(carrier);
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
      // Stores hold the men they have trained; military buildings hold the men
      // who have marched out. Nothing else keeps soldiers, so nothing else pays
      // for the array.
      garrison: keepsSoldiers(info) ? emptyGarrison() : [],
      garrisonRequested: 0,
      defenderDelay: 0,
      mannedAt: 0,
    }));

    this.world.building[point] = building.id;
    // Its footprint goes on the map beside its id, so the spacing rules can ask
    // how much room the neighbours need without a table to look it up in.
    this.world.buildingSize[point] = info.size;
    // Outposts keep their distance from one another, and the rule is a function
    // of the world alone, so whose outpost it is goes on the map beside the id.
    // Halls count as well as posts: a headquarters is a fortress for every
    // purpose a border cares about, and an outpost planted against its wall
    // adds nothing a player could not have had by building further out.
    if (info.behaviour.kind === 'military' || info.behaviour.kind === 'headquarters') {
      this.world.outpost[point] = owner;
    }

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
      rank: 0,
      homePost: 0,
    }));
  }

  private destroyBuilding(building: Building): void {
    // Read before anything is pulled apart: `disbandGarrison` below empties the
    // very garrison that decides whether this building was holding ground.
    const held = this.claimRadiusOf(building);
    const headquarters = buildingInfo(building.type).behaviour.kind === 'headquarters';

    // Anything in the building's own stores is simply lost, as in the original.
    this.world.building[building.point] = 0;
    this.world.buildingSize[building.point] = 0;
    this.world.outpost[building.point] = 0;

    const flagId = this.world.flag[building.flagPoint];
    if (flagId) {
      const flag = this.flags.get(flagId);
      if (flag && flag.building === building.id) flag.building = 0;
    }

    // Ids are recycled, so a stale entry here would quietly over-man whatever
    // building is created next.
    this.frontierPosts.delete(building.id);

    // Wares already on the road to a building that no longer exists need a new
    // home, or they would circle forever.
    this.retargetWaresBoundFor(building.id);

    // Off the books before anybody is turned out of it. A store is a place its
    // own people can be sent home to, and while it was still in the table the
    // hall being pulled down was the nearest store to every one of the
    // thirty-nine standing in it: they walked one node, found nothing there,
    // and were struck off. The object outlives the removal, so its door, its
    // flag, its garrison and its reserve are all still there to be emptied.
    this.buildings.remove(building.id);

    this.turnEverybodyOut(building);

    // The ground it held is worked out again now it is gone — from the other
    // buildings, so a neighbouring post keeps what it covers. Without this a
    // post pulled down kept its province for ever.
    if (held > 0) this.redrawTerritory(building.point, held);

    // A headquarters can fall without being captured: razed with the ground it
    // stood on, when the last post covering it has been taken.
    if (headquarters) this.settleTheWar();
  }

  private destroyFlag(flag: Flag, mayMerge = true): void {
    // Whatever is waiting here goes first, while the roads that lead away are
    // still standing to carry it.
    this.rehomeWares(flag);

    // A flag with a road on either side is a staging post, not a junction:
    // removing it should join the two stretches back together rather than tear
    // both down and cut off everything beyond. Not when the flag is being torn
    // off ground its owner has lost, though — see `razeGround`.
    if (!mayMerge || !this.mergeRoadsAt(flag)) {
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
      const from = this.committedPoint(keep);

      merged.carrier = keep.id;
      keep.road = merged.id;
      keep.state = SettlerState.CarrierWaiting;
      this.haltWhereHeStands(keep);

      if (keep.carrying !== null) {
        // Deliver to whichever end of the joined road is nearer, then let
        // ordinary routing carry the crate on from there.
        const at = merged.points.indexOf(from);
        const towardsStart = at >= 0 && at * 2 <= merged.points.length;
        const target = towardsStart ? merged.fromFlag : merged.toFlag;
        const targetFlag = this.flags.get(target);
        if (targetFlag) {
          keep.state = SettlerState.CarrierDelivering;
          keep.taskPoint = target;
          this.redirect(keep, this.pathAlongRoad(merged, from, targetFlag.point) ?? []);
          if (keep.pathIndex >= keep.path.length) this.deliverWare(keep);
        }
      }
    }

    return true;
  }

  /**
   * Hands on whatever is waiting at a flag that is about to be removed.
   *
   * Both ways of taking a flag down used to lose goods. The junction case
   * dropped them outright — the flag was simply deleted with its crates still
   * on it — and the merge case shifted them all to one fixed end of the joined
   * road, which could be the far side of the province, so a crate appeared to
   * teleport to a building site. Either way the destination went on counting a
   * ware that no longer existed, and a site waited for it for ever.
   *
   * They go to a flag one road away instead: still on the network they were
   * travelling, and a step rather than a leap from where they stood.
   */
  private rehomeWares(flag: Flag): void {
    if (flag.wares.length === 0) return;

    const neighbours: Flag[] = [];
    for (const roadId of flag.roads) {
      const road = this.roads.get(roadId);
      if (!road) continue;
      const other = this.flags.get(road.fromFlag === flag.id ? road.toFlag : road.fromFlag);
      if (other && other.id !== flag.id && !neighbours.includes(other)) neighbours.push(other);
    }
    neighbours.sort(
      (a, b) =>
        this.world.grid.distance(flag.point, a.point) -
        this.world.grid.distance(flag.point, b.point),
    );

    for (const parcel of flag.wares) {
      const host = neighbours.find((candidate) => candidate.wares.length < FLAG_CAPACITY);
      if (!host) {
        // Nowhere left to put it. Losing a crate is survivable; leaving its
        // place reserved is not, so the destination is told to stop counting on
        // it and can order another.
        this.releaseIncoming(parcel.destination, parcel.ware);
        continue;
      }

      // The route onward is left to the stranded sweep, which is what re-aims a
      // crate whose way has just been torn up.
      host.wares.push(parcel);
    }

    flag.wares.length = 0;
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

    // From the node he is committed to, not the one behind him. A settler
    // walking out to a road that is torn up under him used to be yanked back to
    // the node he had just left, which read as a jump across the map.
    const from = this.committedPoint(settler);

    const store = this.nearestStore(settler.owner, from);
    if (!store) {
      // Nowhere of his own left standing — the case when a headquarters falls
      // with nothing behind it. He is not struck off where he stands: a
      // province ought to be seen emptying rather than simply subtracted.
      this.loseHim(settler);
      return;
    }

    const path = this.pathHome(from, store);
    if (!path) {
      // Cut off with no way through: take him in on the spot rather than
      // strand him somewhere he can never walk out of.
      this.arriveAtStore(settler, store);
      return;
    }

    settler.building = store.id;
    settler.state = SettlerState.ReturningToStore;
    this.redirect(settler, path);
    if (settler.pathIndex >= settler.path.length) this.arriveAtStore(settler, store);
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

    // No road to walk: across country, but still in by the flag. Every settler
    // in the game enters a building the same way, and a man who cuts the corner
    // walks through the wall.
    return this.pathInTo(store, from);
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
    // A soldier keeps his sword, his shield and the rank he was promoted to:
    // taking him back as a plain settler would quietly disarm him, and a
    // frontier remodelled twice would cost the player his whole army.
    if (settler.profession === Profession.Soldier && store.garrison.length > 0) {
      store.garrison[settler.rank] = (store.garrison[settler.rank] ?? 0) + 1;
      this.settlers.remove(settler.id);
      return;
    }

    store.reserve += 1;
    const tool = professionInfo(settler.profession).tool;
    if (tool !== null) store.stock[tool] = (store.stock[tool] ?? 0) + 1;
    this.settlers.remove(settler.id);
  }

  /**
   * Works out afresh who holds every point in an area.
   *
   * The one place ownership is ever decided. It used to be patched — laid down
   * when a building was raised, flipped wholesale when one was captured — which
   * meant two rules that could disagree, and a border nobody could predict from
   * looking at the map. Ground is *derived* here instead, from the buildings
   * that actually hold it, so what a player owns is always exactly what his
   * buildings can cover.
   *
   * Three passes, in this order:
   *
   *  1. **pressure.** Every building covering a point pushes with
   *     `radius − distance + 1`, and the player whose buildings push hardest in
   *     total holds it. Counting them together is what lets two buildings
   *     either side of a node out-hold the one bigger building facing them —
   *     and what stops a single captured post out-holding a hall and the two
   *     posts standing with it.
   *  2. **the edges**, rubbing off the single dots a hexagon's corners leave.
   *  3. **the keeps**: each claimant takes back the ring it is guaranteed by
   *     size, and every building the node under it and its flag. Last of the
   *     three, so nothing undoes them.
   *
   * Called when ground can have changed hands — a post manned, a building
   * destroyed, a building captured — and never on the ordinary beat: a fortress
   * covers some five hundred points.
   */
  private redrawTerritory(centre: number, radius: number): void {
    // A post whose last man is out on the door holding it is still held: his
    // being outside is what a fight looks like, not the walls falling empty.
    const holding = new Set<number>();
    this.settlers.forEach((settler) => {
      if (settler.state === SettlerState.Defending) holding.add(settler.building);
    });

    const claimants: Claimant[] = [];
    this.buildings.forEach((building) => {
      const claim = this.claimOf(building, holding.has(building.id));
      if (claim) claimants.push(claim);
    });

    const area = this.world.grid.pointsWithin(centre, radius);
    const before = new Map<number, number>();

    for (const point of area) {
      const held = this.world.owner[point]!;
      before.set(point, held);
      this.world.owner[point] = this.strongestClaimTo(point, claimants, held);
    }

    // Whether a building held its own ground read here, off the scoring, and
    // not after the sweep: the scoring is where a border genuinely moving shows
    // up, and it is a genuine move that costs a building its site.
    const standing = new Set<number>();
    this.buildings.forEach((building) => {
      if (this.world.owner[building.point] === building.owner) standing.add(building.id);
    });

    // The whole map, not merely what was redrawn: a point just outside the
    // area can be left standing alone by what happened inside it, and trimming
    // only as far as the area reaches leaves a fresh dot at its own edge. Two
    // thirds of a millisecond against a tick of two hundred, and only when
    // ground has actually moved.
    for (const [point, held] of this.settleTheEdges([...this.world.owner.keys()])) {
      // What the sweep moved counts as much as what the scoring moved, and it
      // can move ground anywhere on the map rather than only inside the area.
      if (!before.has(point)) before.set(point, held);
    }

    // Last, so that nothing — neither the scoring nor the sweep — can take from
    // a building the ring it is guaranteed.
    this.keepBuildingsTheirGround(before, claimants, standing);

    const overrun: Overrun[] = [];
    for (const [point, held] of before) {
      // Ground given up is cleared whether somebody else took it or it simply
      // fell out of the province: a hut left standing beyond a border its owner
      // no longer holds is a hut he has no business keeping.
      if (held !== 0 && this.world.owner[point] !== held) overrun.push({ point, loser: held });
    }

    this.razeGround(overrun);
    this.clearTheBorderLine();

    // The border has moved, so which posts look across at somebody else has
    // too — and that is what decides how many men each of them wants. Worked
    // out now rather than on the sweep beat, so a post that has just won a
    // fight starts filling itself against the frontier as it now stands.
    this.surveyFrontier();
  }

  /** What a building brings to a border, or nothing for one that holds none. */
  private claimOf(building: Building, defended: boolean): Claimant | undefined {
    const reach = this.claimRadiusOf(building, defended);
    if (reach <= 0) return undefined;

    return {
      building: building.id,
      point: building.point,
      radius: reach,
      // A hall has been its owner's since the beginning, in every case. It is
      // not manned by a garrison walking in through the door, so nothing would
      // ever have dated it — and it is the one building on the map that was
      // there before anything else was.
      mannedAt:
        buildingInfo(building.type).behaviour.kind === 'headquarters' ? 0 : building.mannedAt,
      player: building.owner,
    };
  }

  /**
   * Who holds a point, of the buildings covering it: whoever pushes hardest on
   * it, counting everything he has within reach of it.
   *
   * Nothing here is guaranteed to anybody. What a building keeps whatever the
   * pressure — the ring it stands in — is `keepBuildingsTheirGround`, and it
   * runs after this and after the edge sweep.
   */
  private strongestClaimTo(
    point: number,
    claimants: readonly Claimant[],
    incumbent: number,
  ): number {
    // Pressure by player. Sparse and tiny — two or three players at most — so a
    // plain array beats a map, and the loop below runs on every point of a
    // redrawn area.
    const pushed: number[] = [];
    const manned: number[] = [];

    for (const claim of claimants) {
      const distance = this.world.grid.distance(claim.point, point);
      if (distance > claim.radius) continue;

      pushed[claim.player] = (pushed[claim.player] ?? 0) + claim.radius - distance + 1;
      // The earliest manning on each side, for a dead heat.
      const since = manned[claim.player];
      if (since === undefined || claim.mannedAt < since) manned[claim.player] = claim.mannedAt;
    }

    let holder = 0;
    let hardest = 0;
    for (let player = 1; player < pushed.length; player += 1) {
      const push = pushed[player];
      if (push === undefined || push < hardest) continue;
      if (push > hardest) {
        holder = player;
        hardest = push;
        continue;
      }
      // A dead heat: whoever holds it already keeps it, then whoever has been
      // manned longest, and the lower id only if even that is level.
      if (holder === incumbent) continue;
      if (player === incumbent) {
        holder = player;
        continue;
      }
      const mine = manned[player] ?? 0;
      const theirs = manned[holder] ?? 0;
      if (mine < theirs || (mine === theirs && player < holder)) holder = player;
    }

    return holder;
  }

  /**
   * The ground every building keeps whatever the pressure around it: the node
   * under it, its flag, and a ring by what it is.
   *
   * A border works out from where buildings are, so it should never be worked
   * out *through* one. How much room that takes goes by size and by whether the
   * building holds ground at all:
   *
   * - a **large** building — a hall, a fortress, a farm — keeps `LARGE_KEEP`
   *   rings, so its whole first ring is well inside its own ground and no
   *   border line can run against its wall;
   * - anything **holding ground** keeps at least `KEEP`, so a post is never
   *   razed by the very border it has just redrawn: pressure alone hands the
   *   ground under a captured post to whoever pushes hardest there, and 4 nodes
   *   from an enemy hall that is the hall. One ring is also the least that
   *   survives the edge sweep, every node of it having three of its own.
   * - everything else keeps its node and its flag, and only while it still held
   *   them when the scoring was done. A hut on ground its owner has genuinely
   *   lost is a hut about to come down with it, and handing the node back would
   *   save it from a border it has no business surviving.
   *
   * Rings can overlap only where a post stands almost against an enemy hall.
   * The bigger keep wins, then the older claim, then the lower id, so the
   * answer never depends on the order buildings sit in.
   *
   * `before` is added to for anything this takes, so the ground still counts as
   * having changed hands and whoever lost it is cleared off it.
   */
  private keepBuildingsTheirGround(
    before: Map<number, number>,
    claimants: readonly Claimant[],
    standing: ReadonlySet<number>,
  ): void {
    const keep = (point: number, owner: number): void => {
      const held = this.world.owner[point]!;
      if (held === owner) return;
      if (!before.has(point)) before.set(point, held);
      this.world.owner[point] = owner;
    };

    const holdsGround = new Map<number, Claimant>();
    for (const claim of claimants) holdsGround.set(claim.building, claim);

    const kept: { point: number; flagPoint: number; keep: number; owner: number; since: number }[] =
      [];
    this.buildings.forEach((building) => {
      const claim = holdsGround.get(building.id);
      if (!claim && !standing.has(building.id)) return;

      const large = buildingInfo(building.type).size === BuildingSize.Castle;
      kept.push({
        point: building.point,
        flagPoint: building.flagPoint,
        keep: large ? LARGE_KEEP : claim ? KEEP : 0,
        owner: building.owner,
        since: claim?.mannedAt ?? building.mannedAt,
      });
    });

    kept.sort((a, b) => a.keep - b.keep || b.since - a.since || b.owner - a.owner);
    for (const held of kept) {
      for (const near of this.world.grid.pointsWithin(held.point, held.keep)) {
        keep(near, held.owner);
      }
      keep(held.flagPoint, held.owner);
    }
  }

  /**
   * Rubs the single dots off a border.
   *
   * A claim is a hexagon, and a hexagon's corners come to a point one row wide.
   * Drawn, those corners are lone dots hanging off the edge of a province with
   * nothing either side of them. A point with fewer than three of its six
   * neighbours held by the same player is not really held: it goes to whoever
   * holds most of the ground around it, or to nobody.
   *
   * Repeated until nothing moves, which on real borders is one pass: at two
   * neighbours it clears the corners and stops, where at three it would eat a
   * third of the map and never settle.
   */
  private settleTheEdges(area: readonly number[]): Map<number, number> {
    const moved = new Map<number, number>();
    let looking: readonly number[] = area;

    for (let pass = 0; pass < EDGE_PASSES && looking.length > 0; pass += 1) {
      const changes: { point: number; owner: number }[] = [];

      for (const point of looking) {
        const owner = this.world.owner[point]!;
        if (owner === 0) continue;

        const around = new Map<number, number>();
        let mine = 0;
        for (const neighbour of this.world.grid.pointsWithin(point, 1)) {
          if (neighbour === point) continue;
          const held = this.world.owner[neighbour]!;
          around.set(held, (around.get(held) ?? 0) + 1);
          if (held === owner) mine += 1;
        }
        if (mine >= EDGE_NEIGHBOURS) continue;

        // To whoever holds most of the ground about it — nobody included, and
        // by the lower id on a tie so the sweep is not order-dependent.
        let taker = 0;
        let most = -1;
        for (const [candidate, count] of around) {
          if (count > most || (count === most && candidate < taker)) {
            taker = candidate;
            most = count;
          }
        }
        changes.push({ point, owner: taker === owner ? 0 : taker });
      }

      if (changes.length === 0) return moved;
      for (const change of changes) {
        if (!moved.has(change.point)) moved.set(change.point, this.world.owner[change.point]!);
        this.world.owner[change.point] = change.owner;
      }

      looking = area;
    }

    return moved;
  }

  /**
   * Nothing may stand on the line a border runs along.
   *
   * `canPlaceFlag` has always refused a frontier node — a flag there is a road
   * built on ground that is only half yours — but nothing asked the question
   * again once a border moved onto something already standing. Pulling a post
   * down left its own flag, the next flag along and the road between them
   * sitting on the new line, where none of them could have been put.
   *
   * Flags that stand on their own — road junctions and staging posts. A flag
   * serving a building is part of that building and stays while it does, since
   * the sketch has it that the small sizes may have a border around them and
   * only the large need a clear node first. The clearance pass gives the large
   * ones exactly that: a hall or a fortress keeps the ring about it and can
   * never come to the line, while a hut may — and pulling a hut down for a
   * border that has moved several nodes away would be a poor trade for the
   * player who built it.
   */
  private clearTheBorderLine(): void {
    const doomed: Flag[] = [];

    this.flags.forEach((flag) => {
      if (flag.building !== 0) return;
      if (this.world.owner[flag.point] !== flag.owner) return;
      if (isWellInsideTerritory(this.world, flag.point, flag.owner)) return;
      doomed.push(flag);
    });

    for (const flag of doomed) {
      // Ids are recycled, and tearing one flag can take a road and with it
      // another flag, so what was noted a moment ago is checked again here.
      if (this.flags.get(flag.id) !== flag || flag.building !== 0) continue;
      // Torn rather than merged: the roads that met here ran over the line too.
      this.destroyFlag(flag, false);
    }
  }

  /**
   * How far a building holds ground, or nought for one that holds none.
   *
   * A headquarters always, a military building only while somebody is standing
   * in it. A storehouse holds nothing: it is a depot, not a post, and taking
   * one has never moved a border.
   */
  private claimRadiusOf(building: Building, defended = false): number {
    const behaviour = buildingInfo(building.type).behaviour;
    if (behaviour.kind === 'headquarters') return HEADQUARTERS_RADIUS;
    if (behaviour.kind !== 'military') return 0;
    if (building.state !== BuildingState.Complete) return 0;
    return defended || garrisonStrength(building.garrison) > 0 ? behaviour.radius : 0;
  }

  /**
   * Clears what the loser left on ground that has changed hands: his buildings
   * come down, and his flags are torn with them.
   *
   * That last part is what makes taking an outpost worth the men — a frontier
   * post falls and the sawmills behind it fall with it — and the flags matter
   * as much as the buildings: leaving them would lace a beaten province with
   * roads its owner no longer has any ground to walk on.
   *
   * Everything is collected before anything is destroyed: `destroyBuilding` and
   * `destroyFlag` write to the very arrays being read here.
   */
  private razeGround(overrun: readonly Overrun[]): void {
    if (overrun.length === 0) return;

    const doomedBuildings: Building[] = [];
    const doomedFlags: Flag[] = [];
    const doomedRoads: Road[] = [];

    const lost = new Set<number>();
    for (const { point, loser } of overrun) {
      lost.add(point);

      const buildingId = this.world.building[point];
      const building = buildingId ? this.buildings.get(buildingId) : undefined;
      if (building && building.owner === loser) doomedBuildings.push(building);

      const flagId = this.world.flag[point];
      const flag = flagId ? this.flags.get(flagId) : undefined;
      if (flag && flag.owner === loser) doomedFlags.push(flag);
    }

    // A road may only be laid on its owner's own ground, so a stretch running
    // over ground he has lost is a road that should not exist — and its flags
    // can both still be his, which is why the ends are not enough to find it.
    this.roads.forEach((road) => {
      if (road.points.some((point) => lost.has(point) && this.world.owner[point] !== road.owner)) {
        doomedRoads.push(road);
      }
    });

    for (const building of doomedBuildings) {
      // Ids are recycled, so a building noted a moment ago can already be
      // somebody else's by the time the list is walked.
      if (this.buildings.get(building.id) !== building) continue;
      this.note(
        `${buildingInfo(building.type).name} lost with the ground it stood on.`,
        MessageCategory.Territory,
        building.point,
      );
      this.destroyBuilding(building);
    }

    for (const flag of doomedFlags) {
      if (this.flags.get(flag.id) !== flag) continue;
      // Torn, not merged: joining the two stretches that met here would leave a
      // road running through ground its owner has just lost.
      this.destroyFlag(flag, false);
    }

    // Last, and only what the flags did not already take with them.
    for (const road of doomedRoads) {
      if (this.roads.get(road.id) !== road) continue;
      this.destroyRoad(road);
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

  /**
   * Drops a settler's route without disturbing the step he is taking.
   *
   * `setPath(settler, [])` settles a half-taken step by snapping `fromPoint`,
   * `toPoint` and `stepProgress` back to `point` — right for a settler who has
   * genuinely stopped, and a jump of up to a whole node for one still walking.
   * He finishes the pace he is on instead, and whatever comes next starts from
   * where he really is.
   */
  private haltWhereHeStands(settler: Settler): void {
    if (!this.midStep(settler)) {
      this.setPath(settler, []);
      return;
    }

    settler.path = [settler.toPoint];
    settler.pathIndex = 0;
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
        this.carryOn(settler);
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

      case SettlerState.Mustering:
        this.stepOutToAttack(settler);
        return;

      case SettlerState.MarchingToAttack:
        if (this.advance(settler)) this.arriveAtTheFight(settler);
        return;

      case SettlerState.Fighting:
      case SettlerState.WaitingToFight:
      case SettlerState.Defending:
        // The fight itself is resolved building by building in `fightBattles`,
        // so that one blow lands at a time however many men are stood there.
        return;

      case SettlerState.WaitingToEnter:
        // Likewise the going in, in `takePossession`: one man at a time
        // through the flag and the door.
        return;

      case SettlerState.Lost:
        this.updateLost(settler);
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
    if (building && settler.carrying !== null) {
      // A store's porter comes back in with what was waiting on its doorstep,
      // and it goes into the stock rather than back out as something the store
      // has made.
      if (isStore(building)) this.receiveWare(building, settler.carrying);
      else if (building.output === null) building.output = settler.carrying;
    }
    settler.carrying = null;
    settler.carryDestination = 0;
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
      // Not a soul of his own left with a door: he is not struck off where he
      // stands, any more than he is in `sendHome`. He wanders, and his time
      // runs out — a province is seen emptying rather than subtracted.
      this.loseHim(settler);
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

    if (settler.profession === Profession.Soldier) {
      this.joinGarrison(settler);
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
    // Take the flag away and the posting is over. He is only asked this between
    // holes, so one already begun is finished and reported first — his walk out
    // was not wasted, and the player still learns what was under his feet.
    if (this.world.flag[settler.surveyFrom] === 0) {
      this.sendHome(settler);
      return;
    }

    const target = this.surveyTarget(settler.surveyFrom, settler.point);
    const path = target === undefined ? undefined : this.pathAcross(settler.point, target);
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

    const home = this.pathInTo(building, settler.point);
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
    const path = this.pathAcross(from, flagPoint);
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
      // Out for a crate rather than with one: he picks up whatever is waiting
      // to go in, and carries it in himself. One trip, one crate.
      if (building) this.takeUpAtFlag(settler, building);
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

  /**
   * Takes one crate waiting at a building's own flag into a porter's hands.
   *
   * Its place inside is already reserved — it has been bound for this building
   * since it was routed — so `carryDestination` is set to match and nothing is
   * counted twice.
   */
  private takeUpAtFlag(settler: Settler, building: Building): void {
    if (settler.point !== building.flagPoint) return;

    const flagId = this.world.flag[building.flagPoint];
    const flag = flagId ? this.flags.get(flagId) : undefined;
    if (!flag) return;

    const index = flag.wares.findIndex((parcel) => this.isForThisDoor(building, parcel));
    if (index < 0) return;

    const parcel = flag.wares.splice(index, 1)[0]!;
    settler.carrying = parcel.ware;
    settler.carryDestination = building.id;
  }

  private walkBackInside(settler: Settler, building: Building | undefined): void {
    if (!building) {
      // Nowhere to go back to — a carrier who was only dropping off a crate on
      // his way out of a job. He carries on home.
      this.sendHome(settler);
      return;
    }

    const path = this.pathInTo(building, settler.point);
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
    const road = this.roads.get(settler.road);
    if (!road) {
      if (settler.path.length > 0) this.advance(settler);
      return;
    }

    // Oriented on the node he last stood on, so a man coming home from the far
    // flag stops at the near side of the middle edge instead of walking through
    // the halfway point onto the node beyond it and stepping back.
    const post = this.postOf(road, settler.point);

    // Easing onto a post that lies between two nodes, which has to be settled
    // before the ordinary advance below: that would carry him the whole step
    // instead of stopping him halfway along it. Safe to test first because
    // `strollToPost` only runs when there was no work to be had, so any route
    // he is on is a stroll of our own making.
    const arrived = settler.pathIndex >= settler.path.length;
    const easingIn = settler.fromPoint === post.point && settler.toPoint === post.beyond;
    if (post.beyond !== undefined && settler.point === post.point && (arrived || easingIn)) {
      this.waitAtPost(settler, post.point, post.beyond);
      return;
    }

    if (settler.path.length > 0) {
      this.advance(settler);
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
   *
   * Which of that middle pair he stands on and which he faces is decided by
   * `from`, the node he is coming from: he takes the near one and looks across
   * at the other. Either way he is drawn on the midpoint of the same edge, so
   * this moves nobody's post — it only stops him marching through it and
   * turning round.
   */
  private postOf(road: Road, from?: number): { point: number; beyond: number | undefined } {
    const count = road.points.length;
    if (count % 2 === 1) return { point: road.points[count >> 1]!, beyond: undefined };

    const near = road.points[count / 2 - 1]!;
    const far = road.points[count / 2]!;
    if (from !== undefined && road.points.indexOf(from) >= count / 2) {
      return { point: far, beyond: near };
    }
    return { point: near, beyond: far };
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
  private waitAtPost(settler: Settler, post: number, beyond: number): void {
    // Not yet facing the far node: set off towards it properly. Placing him
    // halfway outright jumped him half a node the instant he got back from a
    // delivery, which read as a man teleporting off his post.
    if (settler.fromPoint !== post || settler.toPoint !== beyond) {
      this.setPath(settler, [beyond]);
      return;
    }

    const halfway = settler.stepLength >> 1;
    if (settler.stepProgress < halfway) {
      settler.stepProgress += 1;
      return;
    }

    // He has arrived. Dropping the route freezes the step exactly where it is,
    // and an empty route is also what stops `stepFraction` guessing ahead, so
    // he stands perfectly still instead of twitching.
    settler.path = [];
    settler.pathIndex = 0;
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

  /**
   * A carrier with a crate in his hands, walking it to the far flag.
   *
   * While that flag is full and has nothing to trade him he stops at his post,
   * in the middle of his own stretch, and stands there holding it. He took the
   * crate off the producer's flag all the same, which is what lets the producer
   * carry on working; and he waits where he does not add to the crowd at a flag
   * that already has more than it can hold.
   *
   * He only holds if he has not yet passed the middle. A man who has is nearer
   * the flag than his post, and sending him back to it every time the queue
   * shortened and lengthened again would have him pacing the road; he goes on
   * and waits at the flag, as he always did.
   */
  private carryOn(settler: Settler): void {
    const road = this.roads.get(settler.road);
    const flag = this.flags.get(settler.taskPoint);

    if (road && flag && !this.pastTheMiddle(settler, road, flag) && this.mustWaitFor(settler, flag)) {
      // `strollToPost` walks whatever route it finds him on, and his is the
      // delivery — so the delivery has to be dropped first, without disturbing
      // the pace he is in the middle of. Only once: from the next tick his
      // route is the stroll itself, which ends at his post and not at the flag.
      if (settler.path[settler.path.length - 1] === flag.point) this.haltWhereHeStands(settler);
      this.strollToPost(settler);
      return;
    }

    // Coming off a wait with the way clear again: pick the road back up.
    if (road && flag && settler.path.length === 0) {
      const from = this.committedPoint(settler);
      if (from !== flag.point) {
        const path = this.pathAlongRoad(road, from, flag.point);
        if (path && path.length > 0) this.redirect(settler, path);
      }
    }

    if (this.advance(settler)) this.deliverWare(settler);
  }

  /**
   * Whether a carrier is already nearer the flag he is bound for than his post.
   *
   * Measured from the node he last stood on rather than the one he is stepping
   * onto: a post between two nodes is reached in the middle of a step, and
   * counting him as arrived at the far node would carry him straight past it.
   */
  private pastTheMiddle(settler: Settler, road: Road, flag: Flag): boolean {
    const target = road.points.indexOf(flag.point);
    const here = road.points.indexOf(settler.point);
    if (target < 0 || here < 0) return true;

    const middle = (road.points.length - 1) / 2;
    return target === 0 ? here < middle : here > middle;
  }

  /**
   * Whether the flag ahead has no room for what he is carrying and nothing to
   * trade him for it.
   *
   * A crate for the building behind the flag never needs room on it, and a
   * crate on the flag that wants to go back the way he came is a straight swap
   * — the exchange that keeps a full flag from deadlocking. Either way he walks
   * on; only an honestly, uselessly full flag makes him wait.
   */
  private mustWaitFor(settler: Settler, flag: Flag): boolean {
    if (settler.carrying === null) return false;
    if (flag.wares.length < FLAG_CAPACITY) return false;

    if (flag.building !== 0 && flag.building === settler.carryDestination) {
      const building = this.buildings.get(flag.building);
      if (building && willAccept(building, settler.carrying)) return false;
    }

    const road = this.roads.get(settler.road);
    if (!road) return false;

    const beyond = road.fromFlag === flag.id ? road.toFlag : road.fromFlag;
    return !flag.wares.some((waiting) => this.nextFlagFor(flag.id, waiting) === beyond);
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

    const path = this.pathInTo(building, settler.point);
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

    // A carrier stepping back out of a store uses the same one-man doorway as
    // anybody the store is sending out. He is not being dispatched, but to the
    // player he is simply a second man coming through the door at once, which
    // is the thing being fixed. He waits inside a moment instead; the man on
    // the step is walking and will be off it within a pace.
    if (building && isStore(building) && !this.takeTheDoorway(building)) return;

    const flagPoint = building ? building.flagPoint : settler.point;
    const back = this.pathAcross(settler.point, flagPoint);
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

  /**
   * Rebuilds every building's idea of what is on its way from what actually is.
   *
   * A reservation is a cache of a fact the world already holds: the crates on
   * flags and in hands that are bound for a building. Kept only by hand, one
   * missed release strands a site for good — `outstandingDemand` subtracts the
   * phantom, the building looks satisfied, and nothing more is ever sent. A
   * player's barracks sat one stone short with that stone reserved and gone.
   *
   * Counting the truth back out costs a sweep of the flags and settlers every
   * fortieth tick, and makes the invariant self-repairing rather than merely
   * well guarded — including for saves that already carry the damage.
   */
  private reconcileIncoming(): void {
    const inFlight = new Map<number, number>();
    const key = (buildingId: number, ware: Ware) => buildingId * WARE_COUNT + ware;

    const bump = (buildingId: number, ware: Ware): void => {
      if (buildingId === 0) return;
      const at = key(buildingId, ware);
      inFlight.set(at, (inFlight.get(at) ?? 0) + 1);
    };

    this.flags.forEach((flag) => {
      for (const parcel of flag.wares) bump(parcel.destination, parcel.ware);
    });
    this.settlers.forEach((settler) => {
      if (settler.carrying !== null) bump(settler.carryDestination, settler.carrying);
    });

    this.buildings.forEach((building) => {
      const owed = (ware: Ware) => inFlight.get(key(building.id, ware)) ?? 0;

      if (building.state === BuildingState.UnderConstruction) {
        const cost = buildingInfo(building.type).cost;
        for (let i = 0; i < cost.length; i += 1) building.incoming[i] = owed(cost[i]!.ware);
        return;
      }

      const behaviour = buildingInfo(building.type).behaviour;
      if (behaviour.kind === 'craft') {
        for (let i = 0; i < behaviour.inputs.length; i += 1) {
          building.inputsIncoming[i] = owed(behaviour.inputs[i]!.ware);
        }
        return;
      }

      if (behaviour.kind === 'extract' && behaviour.food) {
        let total = 0;
        for (const ware of behaviour.food) total += owed(ware);
        building.inputsIncoming[0] = total;
        return;
      }

      if (behaviour.kind === 'military') {
        building.inputsIncoming[0] = owed(Ware.Coin);
      }
    });

    // Soldiers on the march are the same sort of promise as a crate on a road,
    // and go wrong the same way: a man who is dismissed or who arrives at a
    // building that has been demolished leaves a request behind him that no
    // fortress can ever fill. Count them back out of the world too.
    const marching = new Map<number, number>();
    this.settlers.forEach((settler) => {
      if (settler.profession !== Profession.Soldier) return;
      if (settler.state !== SettlerState.WalkingToJob) return;
      marching.set(settler.building, (marching.get(settler.building) ?? 0) + 1);
    });
    this.buildings.forEach((building) => {
      if (buildingInfo(building.type).behaviour.kind !== 'military') return;
      building.garrisonRequested = marching.get(building.id) ?? 0;
    });
  }

  /**
   * The flag a waiting parcel should move to next, if any.
   *
   * The cheapest hop in a metric that counts the queues as well as the roads,
   * so a crate goes round a jam of its own accord, without anybody looking for
   * a way round. Two things follow from letting the ordinary search do it.
   *
   * It cannot loop. A shortest path in a graph of positive weights leaves
   * strictly less to go at every hop, so a crate can never be handed back to a
   * flag it has left, nor down a spur and out again. (Queues shift, and the
   * yardstick with them; hop by hop the price of a jam only bends the route,
   * and a jam clearing is a jam clearing.)
   *
   * And it always answers. A queue makes a road dear, never impassable, so a
   * crate with nowhere better to go is still handed to the carrier standing in
   * front of the jam — who picks it up, so its maker's flag is free, and waits.
   */
  private nextFlagFor(flagId: number, parcel: WareParcel): number | undefined {
    const destination = this.buildings.get(parcel.destination);
    if (!destination) return undefined;

    const destinationFlag = this.world.flag[destination.flagPoint];
    if (!destinationFlag) return undefined;
    if (destinationFlag === flagId) return undefined;

    return this.network.nextThroughTraffic(flagId, destinationFlag)?.nextFlag;
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
      this.trainSoldiers(building);
      this.pushStoredWares(building);
      return;
    }

    if (behaviour.kind === 'military') {
      this.manTheWalls(building, behaviour.garrison);
      return;
    }

    // An outpost that wants nobody at all. It asks nothing of anybody once it
    // is finished, so it must not fall into the staffing branch below and sit
    // reporting a worker it will never want.
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
      // The ground goes over when the first soldier walks in, not when the
      // roof goes on. An empty barracks holds nothing.
      building.status = BuildingStatus.Unmanned;
      this.note(`${info.name} completed, waiting for soldiers.`, MessageCategory.Built, building.point);
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
    if (building.exhaustedFor < EXHAUSTED_REPORT_TICKS) return;
    if ((building.exhaustedFor - EXHAUSTED_REPORT_TICKS) % EXHAUSTED_REPEAT_TICKS !== 0) return;

    const info = buildingInfo(building.type);
    this.note(
      `${info.name}: ${exhaustedReason(info.behaviour)}.`,
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
      // A farm with its whole ring sown and still green has nothing to reap and
      // nowhere to sow, but there is nothing wrong with it: the corn is coming.
      // Saying it has run out because the farmer is between jobs was the one
      // message a working farm should never send.
      if (behaviour.kind === 'farm' && this.hasField(building.point, behaviour.radius)) {
        building.status = BuildingStatus.Working;
        return;
      }

      this.reportExhausted(building);
      return;
    }

    const path = this.pathAcross(worker.point, target);
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

    // A store has a man for this, and one door for him to use it by. Six crates
    // re-homed to a hall used to cross its doorstep in a single tick with
    // nobody touching them, which is a conjuring trick rather than a haulage
    // network.
    if (isStore(building)) {
      this.fetchWaitingWares(building, flag);
      return;
    }

    for (let i = flag.wares.length - 1; i >= 0; i -= 1) {
      const parcel = flag.wares[i]!;
      if (parcel.destination !== building.id) continue;
      if (!willAccept(building, parcel.ware)) continue;

      flag.wares.splice(i, 1);
      this.receiveWare(building, parcel.ware);
    }
  }

  /**
   * Sends a store's porter out for one crate left standing on its own doorstep.
   *
   * The mirror of `pushStoredWares`, and it uses the same man and the same
   * one-man doorway, so a store is never both fetching and dispatching at once.
   * He goes out empty; `setDownAtFlag` puts the crate in his hands when he gets
   * there and turns him round.
   */
  private fetchWaitingWares(building: Building, flag: Flag): void {
    if (!flag.wares.some((parcel) => this.isForThisDoor(building, parcel))) return;

    const porter = this.storePorter(building);
    if (!porter) return;
    if (!this.takeTheDoorway(building)) return;

    porter.taskTimer = 0;
    this.walkToOwnFlag(porter, building);
  }

  /** A crate standing at a building's own flag, waiting to be taken inside. */
  private isForThisDoor(building: Building, parcel: WareParcel): boolean {
    return parcel.destination === building.id && willAccept(building, parcel.ware);
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

      // Let the nearest store serve. Every store pushes on its own account, so
      // whichever acted first won the reservation — and since the headquarters
      // is the busy one, it was forever standing down on its own crowded flag
      // while a storehouse three times further away sent the boards.
      if (this.nearerStoreHolds(building, ware, destination.flag)) continue;

      // Somebody has to carry it out, and only once there is genuinely
      // something to carry — a store with nothing to send needs no porter. He
      // is free again only when he is back inside, which is what paces a
      // store's dispatching.
      // One door, and the porter queues at it like everybody else: a man
      // carrying a crate out and a worker leaving for a job cannot share the
      // step.
      const porter = this.storePorter(building);
      if (!porter) return;
      if (!this.takeTheDoorway(building)) return;

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

  /**
   * Whether some other store is better placed to send this ware.
   *
   * "Better placed" means nearer along the roads *and* able to act: a store
   * whose own doorstep is full cannot send anything, and must not be allowed to
   * block one that can, or the site would simply starve. Ties go to the lower
   * id so the answer never depends on the order buildings happen to be visited
   * in.
   */
  private nearerStoreHolds(store: Building, ware: Ware, destinationFlag: number): boolean {
    const ownFlag = this.world.flag[store.flagPoint];
    if (!ownFlag) return false;

    const ownCost = ownFlag === destinationFlag ? 0 : this.network.cost(ownFlag, destinationFlag);
    if (ownCost === undefined) return false;

    let nearer = false;
    this.buildings.forEach((other) => {
      if (nearer || other.id === store.id) return;
      if (other.owner !== store.owner || !isStore(other)) return;
      if ((other.stock[ware] ?? 0) <= 0) return;

      const flagId = this.world.flag[other.flagPoint];
      if (!flagId) return;

      const flag = this.flags.get(flagId);
      if (!flag || flag.wares.length >= STORE_DISPATCH_LIMIT) return;

      const cost = flagId === destinationFlag ? 0 : this.network.cost(flagId, destinationFlag);
      if (cost === undefined) return;

      if (cost < ownCost || (cost === ownCost && other.id < store.id)) nearer = true;
    });

    return nearer;
  }

  /**
   * The store nearest a flag that has a ware to send and room to send it.
   *
   * Returns the store together with what it would cost to carry the ware from
   * its door to that flag, since every caller wants both.
   */
  private nearestSupplier(
    owner: number,
    ware: Ware,
    destinationFlag: number,
  ): { store: Building; flag: number; cost: number } | undefined {
    let best: { store: Building; flag: number; cost: number } | undefined;

    this.buildings.forEach((store) => {
      if (store.owner !== owner || !isStore(store)) return;
      if ((store.stock[ware] ?? 0) <= 0) return;

      const flagId = this.world.flag[store.flagPoint];
      if (!flagId) return;

      const flag = this.flags.get(flagId);
      if (!flag || flag.wares.length >= STORE_DISPATCH_LIMIT) return;

      const cost = flagId === destinationFlag ? 0 : this.network.cost(flagId, destinationFlag);
      if (cost === undefined) return;

      if (!best || cost < best.cost || (cost === best.cost && store.id < best.store.id)) {
        best = { store, flag: flagId, cost };
      }
    });

    return best;
  }

  /**
   * Sends back a crate that set out from the wrong store.
   *
   * Correcting the rule only fixes what has not left yet; a site already being
   * supplied from across the province would go on being supplied from there.
   *
   * Turning one back is only worth doing when it is less walking altogether:
   * carrying it into the nearest store from where it stands, and then out
   * again from whichever store is nearest the site, must come to less than
   * simply finishing the journey. That is a genuine saving rather than churn,
   * and it is why a crate almost at its destination is left alone while one
   * still sitting on the doorstep it left is taken straight back in.
   *
   * Once it is in stock the site's demand reopens and `nearerStoreHolds` has
   * the near store serve it.
   */
  private turnBackDistantSupply(): void {
    this.flags.forEach((flag) => {
      for (const parcel of flag.wares) {
        const destination = this.buildings.get(parcel.destination);
        if (!destination || isStore(destination)) continue;

        const destinationFlag = this.world.flag[destination.flagPoint];
        if (!destinationFlag || destinationFlag === flag.id) continue;

        const remaining = this.network.cost(flag.id, destinationFlag);
        if (remaining === undefined) continue;

        const home = this.nearestStoreByRoad(destination.owner, flag.id);
        if (!home) continue;

        const supplier = this.nearestSupplier(destination.owner, parcel.ware, destinationFlag);
        // Sending it back to the very store that would serve the site is a
        // round trip for nothing.
        if (!supplier || supplier.store.id === home.store.id) continue;

        if (home.cost + supplier.cost >= remaining) continue;

        this.releaseIncoming(parcel.destination, parcel.ware);
        parcel.destination = home.store.id;
      }
    });
  }

  /** The store nearest a flag along the roads, and what it costs to reach. */
  private nearestStoreByRoad(
    owner: number,
    flagId: number,
  ): { store: Building; cost: number } | undefined {
    let best: { store: Building; cost: number } | undefined;

    this.buildings.forEach((store) => {
      if (store.owner !== owner || !isStore(store)) return;

      const storeFlag = this.world.flag[store.flagPoint];
      if (!storeFlag) return;

      const cost = storeFlag === flagId ? 0 : this.network.cost(storeFlag, flagId);
      if (cost === undefined) return;

      if (!best || cost < best.cost || (cost === best.cost && store.id < best.store.id)) {
        best = { store, cost };
      }
    });

    return best;
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

    if (behaviour.kind === 'military') {
      building.inputsIncoming[0] = Math.max(0, (building.inputsIncoming[0] ?? 0) - 1);
      this.promoteWithCoin(building);
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

  /**
   * The store a settler at `from` should walk back to.
   *
   * Distance by road decides it, mirroring `supplierFor` in the other
   * direction. Where the roads cannot answer — a man whose building, flag and
   * road have all just been pulled down together stands in open country with no
   * network to measure from — the answer is the store he is nearest to across
   * the ground, because that is the way he will be walking.
   *
   * Falling through to "the first store there is" put a woodcutter felled
   * beside his own storehouse on a walk right across the province to the
   * headquarters, which is merely the oldest building a player owns.
   */
  private nearestStore(owner: number, from: number): Building | undefined {
    const doorstep = this.flagPointOf(from);
    const fromFlag = doorstep === undefined ? 0 : this.world.flag[doorstep];
    if (!fromFlag) return this.closestStoreAcrossGround(owner, from);

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

    return best ?? this.closestStoreAcrossGround(owner, from);
  }

  /** The store nearest as the crow flies, for a settler with no roads to use. */
  private closestStoreAcrossGround(owner: number, from: number): Building | undefined {
    let best: Building | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    this.buildings.forEach((building) => {
      if (building.owner !== owner || !isStore(building)) return;

      const distance = this.world.grid.distance(from, building.point);
      if (distance >= bestDistance) return;

      bestDistance = distance;
      best = building;
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

  // -------------------------------------------------------------- soldiers

  /**
   * A store turns a sword, a shield, a beer and a spare settler into a private.
   *
   * The whole metal economy exists to reach this line: without it the armoury's
   * output and the mint's had nowhere to go but a warehouse shelf.
   *
   * One man a tick at most, and never down to the last of the reserve — see
   * `SETTLERS_KEPT_BACK`. He waits here in the store's own garrison until some
   * building on the frontier sends for him.
   */
  private trainSoldiers(store: Building): void {
    if (store.reserve <= SETTLERS_KEPT_BACK) return;
    for (const ware of SOLDIER_COST) {
      if ((store.stock[ware] ?? 0) <= 0) return;
    }

    // One man at a time. A store makes nothing, so its `workTimer` is free to
    // be the training clock — no new field, and saves and the fingerprint carry
    // it already. The clock only runs while a man could actually be trained,
    // and is not wound back when he could not, so weapons arriving in dribs and
    // drabs still add up to a soldier.
    store.workTimer += 1;
    if (store.workTimer < TRAINING_TICKS) return;
    store.workTimer = 0;

    for (const ware of SOLDIER_COST) store.stock[ware] = store.stock[ware]! - 1;
    store.reserve -= 1;
    store.garrison[Rank.Private] = (store.garrison[Rank.Private] ?? 0) + 1;
  }

  /**
   * A military building keeps itself manned, and holds ground only while it is.
   *
   * An empty barracks claims nothing: the ground goes over when the first man
   * reaches it, which is what makes the weapon chain the price of expanding
   * rather than a luxury bought afterwards.
   */
  private manTheWalls(building: Building, full: number): void {
    const held = garrisonStrength(building.garrison);
    building.status = held > 0 ? BuildingStatus.Working : BuildingStatus.Unmanned;

    // Not while there is a fight on. A post whose men are out has not lost them
    // yet — most of them walk back — and a post with somebody at its flag is
    // deciding the matter with what it has. What it is short of is only known
    // once the fight is over, and then `garrisonRequested` counts the men on
    // their way home, so it sends for the difference and no more.
    if (this.engagedPosts.has(building.id)) return;

    // Quiet country is held by one man; a building that actually looks across at
    // somebody else's ground takes everybody it has room for.
    const wanted = this.frontierPosts.has(building.id)
      ? full
      : Math.min(MINIMUM_GARRISON, full);

    if (held + building.garrisonRequested >= wanted) return;
    this.requestSoldier(building);
  }

  /**
   * Which buildings have somebody on the step outside their door.
   *
   * A building has one doorway and it is one man wide. Left ungated, a
   * headquarters asked for four workers, a builder and a carrier in the same
   * tick put all six on the flag at once, which looks like a conjuring trick
   * rather than a settlement — and an outpost ordered to attack would empty
   * itself onto the map in a single tick.
   *
   * Read off the world rather than remembered: entity ids are recycled here,
   * and a remembered one has twice been the cause of a bug. A single pass over
   * the settlers catches porters carrying goods out, men leaving for a job and
   * soldiers marching to an attack alike, since all take the same step. Only
   * the outward leg counts — a man walking *back* in stands on the step, not on
   * the door, so a store's dispatching never stalls behind its own returning
   * traffic.
   */
  private surveyDoorways(): void {
    this.busyDoorways.clear();

    this.settlers.forEach((settler) => {
      if (settler.fromPoint === settler.toPoint) return;

      const buildingId = this.world.building[settler.fromPoint];
      if (!buildingId) return;

      const building = this.buildings.get(buildingId);
      if (building) this.busyDoorways.add(building.point);
    });
  }

  /**
   * Which posts have a fight of their own on.
   *
   * A post is engaged while its own men are out on a sortie — they may yet come
   * home, and the places they left are theirs until they are dead or in
   * somebody else's garrison — and while anybody is standing at its flag, or
   * one of its own is out on the door holding it.
   *
   * `manTheWalls` sends for nobody while a post is engaged. Without it a
   * watchtower that had just emptied itself onto the map ordered a fresh
   * garrison from the nearest store within a couple of seconds, filled up
   * behind its own men, and turned the survivors away at the door.
   */
  private surveyTheFighting(): void {
    this.engagedPosts.clear();

    this.settlers.forEach((settler) => {
      if (settler.state === SettlerState.Defending) {
        this.engagedPosts.add(settler.building);
        return;
      }
      const committed = isAttacking(settler) || settler.state === SettlerState.WaitingToEnter;
      if (!committed) return;

      // The post he marched out of, which is short of him until he is home.
      if (settler.homePost !== 0) this.engagedPosts.add(settler.homePost);
      // And the post he is standing outside, which is being attacked.
      if (settler.building !== 0) this.engagedPosts.add(settler.building);
    });
  }

  /**
   * Whether a building can let somebody out, and claims the doorway if so.
   *
   * Claiming it here as well as in the sweep is what makes the gate hold
   * *within* a tick: two buildings asking the same store for a man in the same
   * tick would otherwise both see a clear step.
   */
  private takeTheDoorway(building: Building): boolean {
    if (this.busyDoorways.has(building.point)) return false;
    this.busyDoorways.add(building.point);
    return true;
  }

  /**
   * Which military buildings look across at another player's ground.
   *
   * Rebuilt whole every sweep rather than kept up to date: a fortress's radius
   * is thirteen nodes, some five hundred points, and asking that question every
   * tick of every outpost would cost more than everything else in the loop put
   * together. Borders move rarely, and a garrison a few seconds late to a new
   * frontier is not a fault.
   */
  private surveyFrontier(): void {
    this.frontierPosts.clear();

    this.buildings.forEach((building) => {
      const behaviour = buildingInfo(building.type).behaviour;
      if (behaviour.kind !== 'military') return;
      if (building.state !== BuildingState.Complete) return;

      for (const point of this.world.grid.pointsWithin(building.point, behaviour.radius)) {
        const owner = this.world.owner[point];
        if (owner !== 0 && owner !== building.owner) {
          this.frontierPosts.add(building.id);
          return;
        }
      }
    });
  }

  /**
   * Sends for one man from the nearest store that has one.
   *
   * The strongest goes: a player who has built the gold chain sees his best men
   * on the frontier rather than sitting in a warehouse, and the promotions he
   * paid for are visible where they matter.
   */
  private requestSoldier(building: Building): void {
    const destinationFlag = this.world.flag[building.flagPoint];
    if (!destinationFlag) return;

    const store = this.garrisonSupplierFor(building.owner, destinationFlag);
    if (!store) return;

    // The best men go where they are needed and the rest hold the quiet
    // country, which is the whole point of promoting anybody.
    const rank = this.frontierPosts.has(building.id)
      ? strongestIn(store.garrison)
      : weakestIn(store.garrison);
    if (rank === undefined) return;

    const storeFlag = this.world.flag[store.flagPoint]!;
    const path = roadPointPath(this.network, this.roads, storeFlag, destinationFlag);
    if (!path) return;
    if (!this.takeTheDoorway(store)) return;

    store.garrison[rank] = store.garrison[rank]! - 1;

    const settler = this.createSettler(building.owner, Profession.Soldier, store.point);
    settler.rank = rank;
    settler.building = building.id;
    settler.state = SettlerState.WalkingToJob;
    this.setPath(settler, [store.flagPoint, ...path, building.point]);
    building.garrisonRequested += 1;
  }

  /** The nearest store along the roads that has a soldier to spare. */
  private garrisonSupplierFor(owner: number, destinationFlag: number): Building | undefined {
    let best: Building | undefined;
    let bestCost = Number.POSITIVE_INFINITY;

    this.buildings.forEach((building) => {
      if (building.owner !== owner || !isStore(building)) return;
      if (garrisonStrength(building.garrison) <= 0) return;

      const flagId = this.world.flag[building.flagPoint];
      if (!flagId) return;

      const cost = flagId === destinationFlag ? 0 : this.network.cost(flagId, destinationFlag);
      if (cost === undefined || cost >= bestCost) return;

      bestCost = cost;
      best = building;
    });

    return best;
  }

  /**
   * A soldier reaches the building he was sent to and goes inside.
   *
   * He stops being an entity at the door — a garrison is counts by rank, the
   * same as a store's reserve — and the ground goes over on the first man in.
   */
  private joinGarrison(settler: Settler): void {
    const building = this.buildings.get(settler.building);
    const info = building ? buildingInfo(building.type) : undefined;
    const behaviour = info?.behaviour;

    // He has walked in through the door of somebody else's hall, which is the
    // one thing that throws it down.
    if (building && behaviour?.kind === 'headquarters' && building.owner !== settler.owner) {
      this.stormTheHall(building, settler);
      return;
    }

    if (!building || !behaviour || behaviour.kind !== 'military') {
      // Torn down while he was walking. He goes back to a store, weapons and
      // rank intact — `arriveAtStore` knows a soldier from a settler.
      this.sendHome(settler);
      return;
    }

    building.garrisonRequested = Math.max(0, building.garrisonRequested - 1);

    // Somebody else filled the last place. Rather than crowd in, he turns
    // round — back to the post he marched out of if he has one, and to the
    // nearest store if he has not.
    const held = garrisonStrength(building.garrison);
    if (held >= behaviour.garrison) {
      if (settler.homePost !== 0 && settler.homePost !== building.id) {
        this.goBackToPost(settler);
        return;
      }
      this.sendHome(settler);
      return;
    }

    building.garrison[settler.rank] = (building.garrison[settler.rank] ?? 0) + 1;
    building.status = BuildingStatus.Working;
    this.settlers.remove(settler.id);

    if (held === 0) {
      // The first man ever to stand in it, and only him: a post emptied in a
      // fight and filled again is the same post, and keeps the age it has held
      // its place for. A captured one is dated from the capture instead.
      if (building.mannedAt === 0) building.mannedAt = this.tick;
      this.redrawTerritory(building.point, behaviour.radius);
      this.note(
        `${info.name} manned, claiming new ground.`,
        MessageCategory.Territory,
        building.point,
      );
    }
  }

  /**
   * A gold coin buys one promotion, and buys it for the man who needs it most.
   *
   * Promoting the lowest rank first is what makes a steady trickle of gold lift
   * a whole garrison instead of producing one general and eight privates.
   */
  private promoteWithCoin(building: Building): void {
    for (let rank = 0; rank < TOP_RANK; rank += 1) {
      if ((building.garrison[rank] ?? 0) <= 0) continue;
      building.garrison[rank] = building.garrison[rank]! - 1;
      building.garrison[rank + 1] = (building.garrison[rank + 1] ?? 0) + 1;
      return;
    }
  }

  /**
   * Turns a garrison back into men and sends them home.
   *
   * Demolishing a building loses whatever wares are inside it, as in the
   * original, but soldiers are people: they walk back to a store and can be
   * sent out again.
   */
  /**
   * Everybody inside a building that is coming down, out onto the ground.
   *
   * Onto the ring around it, a man to a node, rather than all onto the door:
   * two men on one node are one man to the eye, and somebody watching a post
   * pulled down should be able to count who walks away from it and of what
   * rank. They set off a beat apart for the same reason — the first step is
   * lengthened by a little more for each man, so they leave in ones rather than
   * moving off as a single body.
   *
   * They are not kept off each other after that. Settlers have always been able
   * to share a node, and nothing here changes it.
   */
  private turnEverybodyOut(building: Building): void {
    const ring = this.groundAround(building.point);
    let placed = 0;

    // Where the next man out steps: round the ring, and back onto the doorstep
    // once it is full rather than holding anybody back.
    const standing = (): number => ring[placed] ?? building.point;

    const worker = building.worker ? this.settlers.get(building.worker) : undefined;
    if (worker) {
      const out = standing();
      this.putHimAt(worker, out);
      placed += 1;
      this.dismissSettler(worker.id);
      this.stepOutOnto(worker, building.point, out);
      this.holdBack(worker, placed);
    }

    // A store's reserve is people, not stock. They used to go with the walls: a
    // hall thrown down took the thirty-nine settlers standing in it out of the
    // world without anybody seeing them go. They walk out like everyone else,
    // and make for another store of their own — or, if their side has none left
    // anywhere, wander until their time runs out.
    const reserve = building.reserve;
    building.reserve = 0;
    for (let i = 0; i < reserve; i += 1) {
      const out = standing();
      const settler = this.createSettler(building.owner, Profession.Helper, out);
      placed += 1;
      this.sendHome(settler);
      this.stepOutOnto(settler, building.point, out);
      this.holdBack(settler, placed);
    }

    for (let rank = 0; rank < RANK_COUNT; rank += 1) {
      const count = building.garrison[rank] ?? 0;
      building.garrison[rank] = 0;

      for (let i = 0; i < count; i += 1) {
        const out = standing();
        const settler = this.createSettler(building.owner, Profession.Soldier, out);
        settler.rank = rank;
        placed += 1;
        this.sendHome(settler);
        this.stepOutOnto(settler, building.point, out);
        this.holdBack(settler, placed);
      }
    }
  }

  /**
   * Puts a man back on the doorstep he was routed from, with that first step
   * out in front of him to walk.
   *
   * The route is worked out from the node he is to leave by, because that is
   * where his journey really starts; but he must not *appear* there. Nobody in
   * the game is ever moved without walking, and a man who blinks a node clear
   * of a building coming down is the plainest possible breach of it.
   */
  private stepOutOnto(settler: Settler, door: number, out: number): void {
    if (this.settlers.get(settler.id) !== settler) return; // Taken in already.
    if (out === door) return;

    settler.point = door;
    this.setPath(settler, settler.path[0] === out ? settler.path : [out, ...settler.path]);
  }

  /** Open ground beside a point, in the lattice's own order. */
  private groundAround(point: number): number[] {
    const around: number[] = [];
    for (const direction of DIRECTIONS) {
      const neighbour = this.world.grid.neighbour(point, direction);
      if (neighbour === OUT_OF_BOUNDS) continue;
      if (this.world.building[neighbour] !== 0) continue;
      if (!this.world.isWalkable(neighbour)) continue;
      around.push(neighbour);
    }
    return around;
  }

  /** Stands a settler on a point, with no step left half-taken behind him. */
  private putHimAt(settler: Settler, point: number): void {
    settler.point = point;
    settler.fromPoint = point;
    settler.toPoint = point;
    settler.stepProgress = 0;
  }

  /**
   * Lengthens the step a man is taking, so that a crowd leaving together leaves
   * in ones. Nothing else about him changes: he is walking, just slowly, and he
   * is up to his own pace by the second node.
   */
  private holdBack(settler: Settler, place: number): void {
    if (settler.toPoint === settler.point) return;
    settler.stepLength += (place - 1) * TURN_OUT_STAGGER;
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
    if (!this.takeTheDoorway(store)) return;

    store.reserve -= 1;
    if (tool !== null) store.stock[tool] = store.stock[tool]! - 1;

    const settler = this.createSettler(building.owner, info.worker, store.point);
    settler.building = building.id;
    settler.state = SettlerState.WalkingToJob;
    this.setPath(settler, [store.flagPoint, ...path, building.point]);
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

    if (!this.takeTheDoorway(store)) return;

    store.reserve -= 1;
    store.stock[Ware.Hammer] = store.stock[Ware.Hammer]! - 1;

    const settler = this.createSettler(building.owner, Profession.Builder, store.point);
    settler.building = building.id;
    settler.state = SettlerState.WalkingToJob;
    this.setPath(settler, [store.flagPoint, ...path, building.point]);

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
      if (!this.takeTheDoorway(store)) return;

      store.reserve -= 1;

      // He is walked no further than the road itself. From the moment he
      // arrives he is an ordinary carrier: `lookForWork` runs before
      // `strollToPost`, so a crate already waiting is picked up at once and the
      // walk to the middle happens only when there is nothing to carry.
      const settler = this.createSettler(road.owner, Profession.Helper, store.point);
      settler.road = road.id;
      settler.state = SettlerState.WalkingToJob;
      this.setPath(settler, [store.flagPoint, ...toRoad]);
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

  /** Whether any corn stands within reach, ripe or still green. */
  private hasField(centre: number, radius: number): boolean {
    for (const point of this.world.grid.pointsWithin(centre, radius)) {
      if (this.world.object[point] === MapObject.Field) return true;
    }
    return false;
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

  /**
   * Every tree keeps its own clock, its phase taken from the node it stands on,
   * exactly as corn does. A whole wood stepping together read as one flickering
   * thing rather than a forest coming on.
   */
  private growTrees(): void {
    const stillGrowing: number[] = [];
    for (const point of this.growingTrees) {
      if (this.world.object[point] !== MapObject.Tree) continue;

      if ((this.tick + point) % TREE_GROWTH_INTERVAL !== 0) {
        stillGrowing.push(point);
        continue;
      }

      const stage = this.world.objectData[point]! + 1;
      this.world.objectData[point] = Math.min(TREE_FULLY_GROWN, stage);
      if (stage < TREE_FULLY_GROWN) stillGrowing.push(point);
    }
    this.growingTrees = stillGrowing;
  }

  /**
   * Corn ripens faster than timber, which is the point of a farm.
   *
   * Every field keeps its own clock, its phase taken from the node it stands
   * on. Ripening the whole farm on one tick made a field look like a single
   * flickering thing rather than a crop: corn sown minutes apart jumped a stage
   * together. Deriving the phase from the point rather than the sowing keeps
   * this a pure function of the world, with nothing new to save.
   */
  private growFields(): void {
    const stillGrowing: number[] = [];
    for (const point of this.growingFields) {
      if (this.world.object[point] !== MapObject.Field) continue;

      if ((this.tick + point) % FIELD_GROWTH_INTERVAL !== 0) {
        stillGrowing.push(point);
        continue;
      }

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
      winner: this.winner,
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
    // A save carries its seed, not its ground. Everything below lays buildings
    // and roads back onto an island regenerated from that seed, which only
    // works while a seed still means the same island.
    if (snapshot.version < OLDEST_SAVE_VERSION) {
      throw new Error(`save version ${snapshot.version} predates the mirrored map`);
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
    simulation.winner = snapshot.winner ?? 0;
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
      snapshot.buildings.items.map((b) => ({
        ...b,
        exhaustedFor: b.exhaustedFor ?? 0,
        // Saves written before soldiers existed have no army, which is exactly
        // what an empty garrison says. The array still has to be the right
        // shape for the buildings that will now keep one.
        garrison: b.garrison ?? (keepsSoldiers(buildingInfo(b.type)) ? emptyGarrison() : []),
        garrisonRequested: b.garrisonRequested ?? 0,
        // Saves written before defenders came out of the door have nobody out
        // and nobody waiting to be.
        defenderDelay: b.defenderDelay ?? 0,
        mannedAt: b.mannedAt ?? 0,
      })),
    );
    // Footprints are derived, so no save carries them: rebuild them from the
    // buildings themselves, and every save ever written gains the spacing rules.
    simulation.buildings.forEach((building) => {
      const info = buildingInfo(building.type);
      world.buildingSize[building.point] = info.size;
      const kind = info.behaviour.kind;
      if (kind === 'military' || kind === 'headquarters') {
        world.outpost[building.point] = building.owner;
      }
    });
    // Version 1 settlers have no survey counter; nobody in such a save is a
    // geologist, so nought is not merely a safe default but the right one.
    simulation.settlers.adopt(
      snapshot.settlers.pool,
      snapshot.settlers.items.map((settler) => ({
        ...settler,
        surveyFrom: settler.surveyFrom ?? 0,
        rank: settler.rank ?? 0,
        // Saves written before men walked home from a fight have no post to
        // walk back to, which sends them to the nearest store as they used to.
        homePost: settler.homePost ?? 0,
      })),
    );

    // The sweep that used to run here for saves older than version 8 has gone
    // with them: nothing below version 10 is opened at all now, so it could
    // never have run again.

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
      if (building.owner !== owner) return;
      if (isStore(building)) total += building.reserve;
      total += garrisonStrength(building.garrison);
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
        .array(building.garrison)
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

/** What a building should say when it has run out, in its own terms. */
function exhaustedReason(behaviour: BuildingInfo['behaviour']): string {
  if (behaviour.kind === 'harvest') {
    return EXHAUSTED_REASON_FOR_OBJECT[behaviour.object] ?? 'nothing left to work within reach';
  }
  if (behaviour.kind === 'extract') {
    return EXHAUSTED_REASON_FOR_RESOURCE[behaviour.resource] ?? 'the deposit is worked out';
  }
  return EXHAUSTED_REASON[behaviour.kind] ?? 'nothing left within reach';
}

function isStoreType(info: BuildingInfo): boolean {
  return info.behaviour.kind === 'headquarters' || info.behaviour.kind === 'store';
}

/**
 * Whether a building keeps soldiers: a store trains and holds them until they
 * are called for, a military building is what they are called to.
 */
function keepsSoldiers(info: BuildingInfo): boolean {
  return isStoreType(info) || info.behaviour.kind === 'military';
}

/**
 * Whether a building is something an army can be sent against.
 *
 * Military buildings and headquarters: the two kinds that hold ground and the
 * two kinds with men in them. A sawmill is taken by taking the ground it stands
 * on, not by storming it.
 */
/**
 * How many men an outpost can send, at a distance.
 *
 * Every post keeps its last man whatever the range — ground is held by the men
 * standing in a building, so an attack that emptied one would give away at home
 * exactly what it went out to win. The band then decides how many of the rest
 * can march that far: all of them close by, two thirds further out, a third at
 * the limit of reach.
 */
function menToSendFrom(post: Building, distance: number): number {
  const spare = Math.max(0, garrisonStrength(post.garrison) - 1);

  for (const band of ATTACK_BANDS) {
    if (distance <= band.within) return Math.floor((spare * band.of) / ATTACK_BAND_PARTS);
  }
  return 0;
}

/** Whether a soldier is committed to an attack: mustering, marching or there. */
function isAttacking(settler: Settler): boolean {
  return (
    settler.state === SettlerState.Mustering ||
    settler.state === SettlerState.MarchingToAttack ||
    settler.state === SettlerState.WaitingToFight ||
    settler.state === SettlerState.Fighting
  );
}

function isAttackable(building: Building): boolean {
  if (building.state !== BuildingState.Complete) return false;
  const kind = buildingInfo(building.type).behaviour.kind;
  return kind === 'military' || kind === 'headquarters';
}

/** The highest rank present in a garrison, or undefined when it is empty. */
function strongestIn(garrison: readonly number[]): number | undefined {
  for (let rank = garrison.length - 1; rank >= 0; rank -= 1) {
    if ((garrison[rank] ?? 0) > 0) return rank;
  }
  return undefined;
}

/** The lowest rank present in a garrison, or undefined when it is empty. */
function weakestIn(garrison: readonly number[]): number | undefined {
  for (let rank = 0; rank < garrison.length; rank += 1) {
    if ((garrison[rank] ?? 0) > 0) return rank;
  }
  return undefined;
}

/** How many input slots a building's behaviour needs. */
function inputSlotCount(info: BuildingInfo): number {
  const behaviour = info.behaviour;
  if (behaviour.kind === 'craft') return behaviour.inputs.length;
  // One slot for the gold on its way, which is all a military building is ever
  // sent. Nothing is stocked: a coin promotes a man the moment it arrives.
  if (behaviour.kind === 'military') return 1;
  if (behaviour.kind === 'extract' && behaviour.food && behaviour.food.length > 0) return 1;
  return 0;
}

const TRIANGLE_SCRATCH = new Int32Array(6);

export { INPUT_STOCK_LIMIT, isStore, outstandingDemand, Direction, BuildSpace };
