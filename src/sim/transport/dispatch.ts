import { buildingInfo } from '../data/buildings';
import { TOP_RANK } from '../data/ranks';
import { Ware } from '../data/wares';
import type { EntityTable } from '../entities/registry';
import type { Building } from '../entities/types';
import { BuildingState } from '../entities/types';
import type { FlagNetwork } from './flag-graph';

/** How many of each input a production building will hold in stock. */
export const INPUT_STOCK_LIMIT = 4;

/**
 * How much gold one military building will have on the road to it at a time.
 *
 * A fortress with nine privates in it genuinely wants nine coins, but ordering
 * them all at once would send the mint's whole output to one building while
 * every other post on the frontier waited. Nothing is stocked — a coin promotes
 * a man the moment it arrives — so this is purely a limit on the queue.
 */
export const COINS_IN_FLIGHT_LIMIT = 2;

/** Men in a garrison who could still be promoted. */
function promotable(building: Building): number {
  let total = 0;
  for (let rank = 0; rank < TOP_RANK; rank += 1) total += building.garrison[rank] ?? 0;
  return total;
}

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

  // Gold is what a garrison wants, and the only thing it wants: one coin, one
  // promotion. A garrison of generals asks for nothing.
  if (behaviour.kind === 'military') {
    if (ware !== Ware.Coin) return 0;
    const wanted = Math.min(promotable(building), COINS_IN_FLIGHT_LIMIT);
    return Math.max(0, wanted - (building.inputsIncoming[0] ?? 0));
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

  // Judged on the men actually standing there, not on what was ordered: a coin
  // at the door is spent at once, so the only question is whether anyone is
  // left to promote.
  if (behaviour.kind === 'military') {
    return ware === Ware.Coin && promotable(building) > 0;
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

/** How much of a ware a building is holding or has coming, for sharing out. */
function heldOf(building: Building, ware: Ware): number {
  const behaviour = buildingInfo(building.type).behaviour;

  if (building.state === BuildingState.UnderConstruction) {
    const cost = buildingInfo(building.type).cost;
    let held = 0;
    for (let i = 0; i < cost.length; i += 1) {
      if (cost[i]!.ware !== ware) continue;
      held += building.delivered[i]! + building.incoming[i]!;
    }
    return held;
  }

  if (behaviour.kind === 'craft') {
    let held = 0;
    for (let i = 0; i < behaviour.inputs.length; i += 1) {
      if (behaviour.inputs[i]!.ware !== ware) continue;
      held += building.inputs[i]! + building.inputsIncoming[i]!;
    }
    return held;
  }

  if (behaviour.kind === 'extract' && behaviour.food?.includes(ware)) {
    let held = 0;
    for (let i = 0; i < building.inputs.length; i += 1) {
      held += building.inputs[i]! + building.inputsIncoming[i]!;
    }
    return held;
  }

  if (behaviour.kind === 'military' && ware === Ware.Coin) {
    return building.inputsIncoming[0] ?? 0;
  }

  return 0;
}

/**
 * Picks where a newly produced ware should go.
 *
 * A building that actually needs the ware always wins over a warehouse. Among
 * those that want it, **trades share and rivals of a trade do not**: the kind of
 * building holding least of it goes first, and only then does distance decide,
 * between buildings of that same kind.
 *
 * So an armoury and a smelter halve the coal between them however far apart
 * they are, and the four kinds of mine share the bread — while two sawmills, of
 * one kind, still send every log to whichever is nearer, which is what makes
 * building a mill beside the woodcutter worthwhile.
 *
 * The comparison is made on what each trade actually holds, counting what is
 * already on its way, so it needs no memory of what was sent last and stays a
 * pure function of the world. Ties break on the lower type and then the lower
 * building id, so the choice never depends on iteration order.
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

  // Per building type: how much that trade holds, and its cheapest claimant.
  const trades = new Map<
    number,
    { held: number; cost: number; destination: Destination }
  >();

  let bestStore: Destination | undefined;
  let bestStoreCost = Number.POSITIVE_INFINITY;

  buildings.forEach((building) => {
    if (building.owner !== owner) return;

    const flag = flagOfBuilding(building);
    if (flag === 0) return;

    const cost = flag === sourceFlag ? 0 : costs.get(flag);
    if (cost === undefined) return;

    if (outstandingDemand(building, ware) > 0) {
      const destination: Destination = { building: building.id, flag };
      const held = heldOf(building, ware);
      const trade = trades.get(building.type);

      if (!trade) {
        trades.set(building.type, { held, cost, destination });
        return;
      }

      // The trade's total tells us whether it is behind; the nearest of its
      // buildings is the one that will actually receive.
      trade.held += held;
      if (cost < trade.cost) {
        trade.cost = cost;
        trade.destination = destination;
      }
      return;
    }

    if (isStore(building) && cost < bestStoreCost) {
      bestStoreCost = cost;
      bestStore = { building: building.id, flag };
    }
  });

  let chosen: Destination | undefined;
  let leastHeld = Number.POSITIVE_INFINITY;
  let chosenType = Number.POSITIVE_INFINITY;

  for (const [type, trade] of trades) {
    if (trade.held < leastHeld || (trade.held === leastHeld && type < chosenType)) {
      leastHeld = trade.held;
      chosenType = type;
      chosen = trade.destination;
    }
  }

  return chosen ?? bestStore;
}
