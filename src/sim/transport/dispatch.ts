import { buildingInfo } from '../data/buildings';
import type { Ware } from '../data/wares';
import type { EntityTable } from '../entities/registry';
import type { Building } from '../entities/types';
import { BuildingState } from '../entities/types';
import type { FlagNetwork } from './flag-graph';

/** How many of each input a production building will hold in stock. */
export const INPUT_STOCK_LIMIT = 4;

/**
 * How much of an input a building still wants, counting what is already on its
 * way. Returns 0 for a building that does not use the ware at all.
 */
export function outstandingDemand(building: Building, ware: Ware): number {
  if (building.state === BuildingState.UnderConstruction) {
    const cost = buildingInfo(building.type).cost;
    let wanted = 0;
    for (let i = 0; i < cost.length; i += 1) {
      const item = cost[i]!;
      if (item.ware !== ware) continue;
      wanted += item.count - building.delivered[i]! - building.incoming[i]!;
    }
    return Math.max(0, wanted);
  }

  const behaviour = buildingInfo(building.type).behaviour;

  if (behaviour.kind === 'craft') {
    let wanted = 0;
    for (let i = 0; i < behaviour.inputs.length; i += 1) {
      if (behaviour.inputs[i]!.ware !== ware) continue;
      wanted += INPUT_STOCK_LIMIT - building.inputs[i]! - building.inputsIncoming[i]!;
    }
    return Math.max(0, wanted);
  }

  if (behaviour.kind === 'extract' && behaviour.food) {
    if (!behaviour.food.includes(ware)) return 0;
    let held = 0;
    for (let i = 0; i < building.inputs.length; i += 1) {
      held += building.inputs[i]! + building.inputsIncoming[i]!;
    }
    return Math.max(0, INPUT_STOCK_LIMIT - held);
  }

  return 0;
}

/**
 * Whether a building will take this ware in right now.
 *
 * Deliberately distinct from `outstandingDemand`, which subtracts wares already
 * in transit so the same crate is not ordered twice. A crate arriving at the
 * door must be judged against what the building actually *holds* — otherwise
 * its own reservation would count against it and the delivery would bounce.
 */
export function willAccept(building: Building, ware: Ware): boolean {
  if (isStore(building)) return true;

  if (building.state === BuildingState.UnderConstruction) {
    const cost = buildingInfo(building.type).cost;
    for (let i = 0; i < cost.length; i += 1) {
      if (cost[i]!.ware === ware && building.delivered[i]! < cost[i]!.count) return true;
    }
    return false;
  }

  const behaviour = buildingInfo(building.type).behaviour;

  if (behaviour.kind === 'craft') {
    for (let i = 0; i < behaviour.inputs.length; i += 1) {
      if (behaviour.inputs[i]!.ware === ware && building.inputs[i]! < INPUT_STOCK_LIMIT) return true;
    }
    return false;
  }

  if (behaviour.kind === 'extract' && behaviour.food?.includes(ware)) {
    let held = 0;
    for (const amount of building.inputs) held += amount;
    return held < INPUT_STOCK_LIMIT;
  }

  return false;
}

/** True for the headquarters and storehouses, which accept anything. */
export function isStore(building: Building): boolean {
  if (building.state !== BuildingState.Complete) return false;
  const kind = buildingInfo(building.type).behaviour.kind;
  return kind === 'headquarters' || kind === 'store';
}

export interface Destination {
  /** The building that will receive the ware. */
  readonly building: number;
  /** The flag it should be carried to. */
  readonly flag: number;
}

/**
 * Picks where a newly produced ware should go.
 *
 * A building that actually needs the ware always wins over a warehouse, and
 * among equals the cheapest journey wins — which is what makes a sawmill built
 * next to the woodcutter feel immediately worthwhile. Ties break on the lower
 * building id so the choice never depends on iteration order.
 */
export function chooseDestination(
  buildings: EntityTable<Building>,
  network: FlagNetwork,
  sourceFlag: number,
  ware: Ware,
  owner: number,
  flagOfBuilding: (building: Building) => number,
): Destination | undefined {
  const costs = network.costsFrom(sourceFlag);

  let bestConsumer: Destination | undefined;
  let bestConsumerCost = Number.POSITIVE_INFINITY;
  let bestStore: Destination | undefined;
  let bestStoreCost = Number.POSITIVE_INFINITY;

  buildings.forEach((building) => {
    if (building.owner !== owner) return;

    const flag = flagOfBuilding(building);
    if (flag === 0) return;

    const cost = flag === sourceFlag ? 0 : costs.get(flag);
    if (cost === undefined) return;

    if (outstandingDemand(building, ware) > 0) {
      if (cost < bestConsumerCost) {
        bestConsumerCost = cost;
        bestConsumer = { building: building.id, flag };
      }
      return;
    }

    if (isStore(building) && cost < bestStoreCost) {
      bestStoreCost = cost;
      bestStore = { building: building.id, flag };
    }
  });

  return bestConsumer ?? bestStore;
}
