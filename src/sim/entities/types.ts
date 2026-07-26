import type { BuildingType } from '../data/buildings';
import type { Profession } from '../data/professions';
import type { Ware } from '../data/wares';

/**
 * Entities are plain objects held in pool-indexed arrays.
 *
 * The map itself — a hundred thousand lattice points — lives in typed arrays,
 * where the memory layout genuinely matters. Buildings, flags and roads number
 * in the hundreds and settlers in the low thousands, so they are stored as
 * objects instead: allocated once when the entity is created, mutated in place
 * thereafter, and never reallocated per tick. That keeps the hot loops free of
 * garbage while leaving this heterogeneous state readable.
 */

/** How many wares may wait at one flag before its road backs up. */
export const FLAG_CAPACITY = 8;

export interface WareParcel {
  readonly ware: Ware;
  /**
   * The building this ware is bound for. Re-targeted if the destination is
   * demolished or stops wanting it.
   */
  destination: number;
}

export interface Flag {
  readonly id: number;
  point: number;
  owner: number;
  /** Wares waiting to be picked up, oldest first. */
  readonly wares: WareParcel[];
  /** Roads meeting here, by road id. */
  readonly roads: number[];
  /** The building this flag serves, if any. */
  building: number;
}

export interface Road {
  readonly id: number;
  owner: number;
  /** Every lattice point along the road, from `fromFlag` to `toFlag`. */
  points: number[];
  fromFlag: number;
  toFlag: number;
  /** The settler working this stretch, or 0 while one is on the way. */
  carrier: number;
  carrierRequested: boolean;
  /** Travel cost, longer for steep ground. */
  cost: number;
}

export const BuildingState = {
  UnderConstruction: 0,
  Complete: 1,
} as const;

export type BuildingState = (typeof BuildingState)[keyof typeof BuildingState];

export interface Building {
  readonly id: number;
  readonly type: BuildingType;
  point: number;
  flagPoint: number;
  owner: number;
  state: BuildingState;

  /** The settler who works here, or 0. */
  worker: number;
  /** True once a worker has been asked for, so we don't ask twice. */
  workerRequested: boolean;

  // ---- construction
  /** Materials delivered so far, parallel to the building's cost list. */
  readonly delivered: number[];
  /** Materials already on their way, parallel to the cost list. */
  readonly incoming: number[];
  /** Ticks of building work completed. */
  buildProgress: number;

  // ---- production
  /** Input wares in stock, parallel to the recipe's input list. */
  readonly inputs: number[];
  /** Input wares already on their way. */
  readonly inputsIncoming: number[];
  /** Ticks of work done on the current item. */
  workTimer: number;
  /** A finished ware waiting to be carried out to the flag. */
  output: Ware | null;
  /** Why production is stalled, for the building panel. */
  status: BuildingStatus;

  // ---- stores (headquarters and storehouses)
  /** Ware counts held here, indexed by ware id. Empty for other buildings. */
  readonly stock: number[];
  /** Settlers waiting here to be sent out to jobs. */
  reserve: number;
}

export const BuildingStatus = {
  Working: 0,
  AwaitingWorker: 1,
  AwaitingMaterials: 2,
  /** Nothing left within reach: no trees, no stone, an exhausted seam. */
  Exhausted: 3,
  /** The output has nowhere to go because the flag outside is full. */
  Blocked: 4,
  UnderConstruction: 5,
  /** No road links this to a store, so nothing can ever reach it. */
  Unreachable: 6,
} as const;

export type BuildingStatus = (typeof BuildingStatus)[keyof typeof BuildingStatus];

export const SettlerState = {
  /** Inside a building or the headquarters, doing nothing visible. */
  Idle: 0,
  /** Walking to a building to take up a trade. */
  WalkingToJob: 1,
  /** Inside its workplace, working the production timer. */
  AtWork: 2,
  /** Walking out to a tree, an outcrop or a planting spot. */
  WalkingToTask: 3,
  /** Standing at a work point, felling or planting. */
  PerformingTask: 4,
  /** Walking back to its workplace. */
  ReturningHome: 5,
  /** A carrier waiting on its stretch of road. */
  CarrierWaiting: 6,
  /** A carrier walking to collect a ware. */
  CarrierCollecting: 7,
  /** A carrier walking a ware to the far flag. */
  CarrierDelivering: 8,
  /** Walking to a construction site, or building it. */
  Building: 9,
  /** Walking back to a store to be taken in again. */
  ReturningToStore: 10,
} as const;

export type SettlerState = (typeof SettlerState)[keyof typeof SettlerState];

export interface Settler {
  readonly id: number;
  owner: number;
  profession: Profession;
  state: SettlerState;

  /** The point the settler currently stands on. */
  point: number;
  /** The step being walked, for smooth rendering between ticks. */
  fromPoint: number;
  toPoint: number;
  /** Progress along the current step, 0..STEP_TICKS. */
  stepProgress: number;
  stepLength: number;

  /** Remaining points to walk, excluding the one under foot. */
  path: number[];
  pathIndex: number;

  /** The ware in hand, or null. */
  carrying: Ware | null;
  carryDestination: number;

  /** Workplace, road or construction site this settler belongs to. */
  building: number;
  road: number;
  /** Where the settler is headed for its current task. */
  taskPoint: number;
  /** Countdown for felling, planting, building and the like. */
  taskTimer: number;
}

/** Ticks a settler takes to cross one lattice step on level ground. */
export const STEP_TICKS = 8;
