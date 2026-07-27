import type { BuildingSize } from '../world/buildspace';
import { BuildingSize as Size } from '../world/buildspace';
import { MapObject, Resource } from '../world/terrain';
import { Profession } from './professions';
import { MINER_FOODS, Ware } from './wares';

export interface WareAmount {
  readonly ware: Ware;
  readonly count: number;
}

/**
 * What a building actually does once it is staffed.
 *
 * Behaviours are deliberately few and general: the whole Settlers II roster
 * fits into gathering from the map, planting on it, extracting from under it,
 * turning wares into other wares, storing them, or holding ground. Adding the
 * remaining buildings is then a data change rather than new engine code.
 */
export type BuildingBehaviour =
  /** The player's first building: stores wares and sends out new settlers. */
  | { readonly kind: 'headquarters' }
  /** Accepts and issues wares, extending the supply network. */
  | { readonly kind: 'store' }
  /** Takes something standing on the map — a tree, a granite outcrop. */
  | {
      readonly kind: 'harvest';
      readonly object: MapObject;
      readonly output: Ware;
      readonly radius: number;
      readonly workTicks: number;
    }
  /** Puts something back onto the map. */
  | {
      readonly kind: 'plant';
      readonly object: MapObject;
      readonly radius: number;
      readonly workTicks: number;
    }
  /**
   * Sows fields on the ground around it and reaps them once they ripen — a
   * cycle of planting and harvesting in one trade, which is what makes a farm
   * different from a forester and a woodcutter working side by side.
   */
  | {
      readonly kind: 'farm';
      readonly output: Ware;
      readonly radius: number;
      readonly workTicks: number;
    }
  /** Draws an underground resource: water, fish, ore. */
  | {
      readonly kind: 'extract';
      readonly resource: Resource;
      readonly output: Ware;
      readonly radius: number;
      readonly workTicks: number;
      /** Mines and fisheries exhaust their deposit; wells do not. */
      readonly depletes: boolean;
      /** Wares the workers eat before they will work, if any. */
      readonly food?: readonly Ware[];
    }
  /** Turns delivered wares into another ware. */
  | {
      readonly kind: 'craft';
      readonly inputs: readonly WareAmount[];
      readonly output: Ware;
      readonly workTicks: number;
      /**
       * A workshop that can turn its hand to several things makes whichever of
       * these the player is shortest of, and `output` is merely the first
       * guess. This is how one metalworks keeps every trade in tools without
       * asking the player to manage a production queue.
       */
      readonly alternatives?: readonly Ware[];
    }
  /** Holds territory and garrisons soldiers. */
  | {
      readonly kind: 'military';
      readonly garrison: number;
      readonly radius: number;
    }
  /** Declared for completeness; behaviour arrives with a later phase. */
  | { readonly kind: 'unimplemented' };

export const BuildingType = {
  Headquarters: 0,
  Storehouse: 1,

  Woodcutter: 2,
  Forester: 3,
  Sawmill: 4,
  Quarry: 5,
  Well: 6,
  Fishery: 7,

  Hunter: 8,
  Farm: 9,
  Mill: 10,
  Bakery: 11,
  PigFarm: 12,
  Slaughterhouse: 13,
  Brewery: 14,
  DonkeyBreeder: 15,

  CoalMine: 16,
  IronMine: 17,
  GoldMine: 18,
  GraniteMine: 19,

  IronSmelter: 20,
  Mint: 21,
  Metalworks: 22,
  Armoury: 23,

  Barracks: 24,
  Guardhouse: 25,
  WatchTower: 26,
  Fortress: 27,
  LookoutTower: 28,

  Shipyard: 29,
  Harbour: 30,
  Catapult: 31,
} as const;

export type BuildingType = (typeof BuildingType)[keyof typeof BuildingType];

/**
 * How the build menu groups a building. With most of the roster now available
 * a single flat grid runs off the bottom of a phone, and a player looking for
 * a bakery should not have to read past four kinds of mine to find it.
 */
export const BuildingCategory = {
  Storage: 'Storage',
  WoodAndStone: 'Wood and stone',
  Food: 'Food',
  Mining: 'Mining',
  MetalAndTools: 'Metal and tools',
  Military: 'Outposts',
} as const;

export type BuildingCategory = (typeof BuildingCategory)[keyof typeof BuildingCategory];

/** The order sections appear in the build menu. */
export const CATEGORY_ORDER: readonly BuildingCategory[] = [
  BuildingCategory.WoodAndStone,
  BuildingCategory.Food,
  BuildingCategory.Mining,
  BuildingCategory.MetalAndTools,
  BuildingCategory.Military,
  BuildingCategory.Storage,
];

export interface BuildingInfo {
  readonly id: BuildingType;
  readonly name: string;
  readonly size: BuildingSize;
  readonly category: BuildingCategory;
  /** Materials a construction site must receive before it can be finished. */
  readonly cost: readonly WareAmount[];
  /** Ticks of a builder's work the site needs, on top of its materials. */
  readonly buildTicks: number;
  /** The trade that staffs it, or null if it needs no worker. */
  readonly worker: Profession | null;
  readonly behaviour: BuildingBehaviour;
  /** Whether the player can build it in this release. */
  readonly available: boolean;
  readonly description: string;
}

const boards = (count: number): WareAmount => ({ ware: Ware.Board, count });
const stones = (count: number): WareAmount => ({ ware: Ware.Stone, count });

/**
 * Every tool a trade in this release asks for. The metalworks makes whichever
 * of them is scarcest, so no trade can be shut out for good by an unlucky run
 * of losses.
 */
const TOOLS: readonly Ware[] = [
  Ware.Hammer,
  Ware.Axe,
  Ware.Saw,
  Ware.PickAxe,
  Ware.Shovel,
  Ware.Crucible,
  Ware.FishingRod,
  Ware.Scythe,
  Ware.Cleaver,
  Ware.RollingPin,
];

export const BUILDINGS: readonly BuildingInfo[] = [
  {
    id: BuildingType.Headquarters,
    name: 'Headquarters',
    size: Size.Castle,
    category: BuildingCategory.Storage,
    cost: [],
    buildTicks: 0,
    worker: null,
    behaviour: { kind: 'headquarters' },
    available: false, // Placed at the start of a game, never built by hand.
    description: 'Your seat of government. Stores wares and sends out settlers.',
  },
  {
    id: BuildingType.Storehouse,
    name: 'Storehouse',
    size: Size.House,
    category: BuildingCategory.Storage,
    cost: [boards(3), stones(3)],
    buildTicks: 420,
    worker: null,
    behaviour: { kind: 'store' },
    available: true,
    description: 'A second home for your wares, shortening every haul near it.',
  },

  {
    id: BuildingType.Woodcutter,
    name: "Woodcutter's hut",
    size: Size.Hut,
    category: BuildingCategory.WoodAndStone,
    cost: [boards(2)],
    buildTicks: 220,
    worker: Profession.Woodcutter,
    behaviour: {
      kind: 'harvest',
      object: MapObject.Tree,
      output: Ware.Log,
      radius: 6,
      workTicks: 150,
    },
    available: true,
    description: 'Fells nearby trees for logs. Pair it with a forester.',
  },
  {
    id: BuildingType.Forester,
    name: "Forester's hut",
    size: Size.Hut,
    category: BuildingCategory.WoodAndStone,
    cost: [boards(2)],
    buildTicks: 220,
    worker: Profession.Forester,
    behaviour: { kind: 'plant', object: MapObject.Tree, radius: 6, workTicks: 60 },
    available: true,
    description: 'Plants saplings so the woodcutters never run dry.',
  },
  {
    id: BuildingType.Sawmill,
    name: 'Sawmill',
    size: Size.House,
    category: BuildingCategory.WoodAndStone,
    cost: [boards(3), stones(2)],
    buildTicks: 400,
    worker: Profession.Carpenter,
    behaviour: {
      kind: 'craft',
      inputs: [{ ware: Ware.Log, count: 1 }],
      output: Ware.Board,
      workTicks: 130,
    },
    available: true,
    description: 'Saws logs into the boards every building needs.',
  },
  {
    id: BuildingType.Quarry,
    name: 'Quarry',
    size: Size.Hut,
    category: BuildingCategory.WoodAndStone,
    cost: [boards(2)],
    buildTicks: 220,
    worker: Profession.Stonemason,
    behaviour: {
      kind: 'harvest',
      object: MapObject.Stone,
      output: Ware.Stone,
      radius: 6,
      workTicks: 170,
    },
    available: true,
    description: 'Cuts stone from nearby granite outcrops.',
  },
  {
    id: BuildingType.Well,
    name: 'Well',
    size: Size.Hut,
    category: BuildingCategory.Food,
    cost: [boards(3), stones(1)],
    buildTicks: 240,
    worker: Profession.WellDigger,
    behaviour: {
      kind: 'extract',
      resource: Resource.Water,
      output: Ware.Water,
      radius: 0,
      workTicks: 140,
      depletes: true,
    },
    available: true,
    description: 'Draws water for bakers, brewers and stockmen.',
  },
  {
    id: BuildingType.Fishery,
    name: "Fisherman's hut",
    size: Size.Hut,
    category: BuildingCategory.Food,
    cost: [boards(2)],
    buildTicks: 220,
    worker: Profession.Fisher,
    behaviour: {
      kind: 'extract',
      resource: Resource.Fish,
      output: Ware.Fish,
      radius: 6,
      workTicks: 160,
      depletes: true,
    },
    available: true,
    description: 'Works the shoals offshore. The catch does run out.',
  },

  {
    id: BuildingType.Hunter,
    name: "Hunter's hut",
    size: Size.Hut,
    category: BuildingCategory.Food,
    cost: [boards(2)],
    buildTicks: 220,
    worker: Profession.Hunter,
    behaviour: { kind: 'unimplemented' },
    available: false,
    description: 'Hunts game for meat.',
  },
  {
    id: BuildingType.Farm,
    name: 'Farm',
    size: Size.Castle,
    category: BuildingCategory.Food,
    cost: [boards(3), stones(3)],
    buildTicks: 620,
    worker: Profession.Farmer,
    behaviour: { kind: 'farm', output: Ware.Grain, radius: 2, workTicks: 170 },
    available: true,
    description: 'Sows and reaps grain on the surrounding fields.',
  },
  {
    id: BuildingType.Mill,
    name: 'Mill',
    size: Size.House,
    category: BuildingCategory.Food,
    cost: [boards(3), stones(3)],
    buildTicks: 400,
    worker: Profession.Miller,
    behaviour: {
      kind: 'craft',
      inputs: [{ ware: Ware.Grain, count: 1 }],
      output: Ware.Flour,
      workTicks: 130,
    },
    available: true,
    description: 'Grinds grain into flour.',
  },
  {
    id: BuildingType.Bakery,
    name: 'Bakery',
    size: Size.House,
    category: BuildingCategory.Food,
    cost: [boards(2), stones(3)],
    buildTicks: 400,
    worker: Profession.Baker,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.Flour, count: 1 },
        { ware: Ware.Water, count: 1 },
      ],
      output: Ware.Bread,
      workTicks: 150,
    },
    available: true,
    description: 'Bakes bread, the staple that keeps mines working.',
  },
  {
    id: BuildingType.PigFarm,
    name: 'Pig farm',
    size: Size.Castle,
    category: BuildingCategory.Food,
    cost: [boards(3), stones(3)],
    buildTicks: 620,
    worker: Profession.PigBreeder,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.Grain, count: 1 },
        { ware: Ware.Water, count: 1 },
      ],
      output: Ware.Ham,
      workTicks: 200,
    },
    available: true,
    description: 'Fattens pigs on grain and water.',
  },
  {
    id: BuildingType.Slaughterhouse,
    name: 'Slaughterhouse',
    size: Size.House,
    category: BuildingCategory.Food,
    cost: [boards(3), stones(2)],
    buildTicks: 400,
    worker: Profession.Butcher,
    behaviour: {
      kind: 'craft',
      inputs: [{ ware: Ware.Ham, count: 1 }],
      output: Ware.Meat,
      workTicks: 130,
    },
    available: true,
    description: 'Turns pigs into meat.',
  },
  {
    id: BuildingType.Brewery,
    name: 'Brewery',
    size: Size.House,
    category: BuildingCategory.Food,
    cost: [boards(3), stones(3)],
    buildTicks: 400,
    worker: Profession.Brewer,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.Grain, count: 1 },
        { ware: Ware.Water, count: 1 },
      ],
      output: Ware.Beer,
      workTicks: 160,
    },
    available: true,
    description: 'Brews the beer that turns settlers into soldiers.',
  },
  {
    id: BuildingType.DonkeyBreeder,
    name: 'Donkey breeder',
    size: Size.Castle,
    category: BuildingCategory.Food,
    cost: [boards(3), stones(3)],
    buildTicks: 620,
    worker: Profession.DonkeyBreeder,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.Grain, count: 1 },
        { ware: Ware.Water, count: 1 },
      ],
      output: Ware.Donkey,
      workTicks: 220,
    },
    available: true,
    description: 'Raises donkeys to speed goods along busy roads.',
  },

  {
    id: BuildingType.CoalMine,
    name: 'Coal mine',
    size: Size.Mine,
    category: BuildingCategory.Mining,
    cost: [boards(4)],
    buildTicks: 360,
    worker: Profession.Miner,
    behaviour: {
      kind: 'extract',
      resource: Resource.Coal,
      output: Ware.Coal,
      radius: 0,
      workTicks: 180,
      depletes: true,
      food: MINER_FOODS,
    },
    available: true,
    description: 'Digs coal. Miners must be fed.',
  },
  {
    id: BuildingType.IronMine,
    name: 'Iron mine',
    size: Size.Mine,
    category: BuildingCategory.Mining,
    cost: [boards(4)],
    buildTicks: 360,
    worker: Profession.Miner,
    behaviour: {
      kind: 'extract',
      resource: Resource.Iron,
      output: Ware.IronOre,
      radius: 0,
      workTicks: 180,
      depletes: true,
      food: MINER_FOODS,
    },
    available: true,
    description: 'Digs iron ore. Miners must be fed.',
  },
  {
    id: BuildingType.GoldMine,
    name: 'Gold mine',
    size: Size.Mine,
    category: BuildingCategory.Mining,
    cost: [boards(4)],
    buildTicks: 360,
    worker: Profession.Miner,
    behaviour: {
      kind: 'extract',
      resource: Resource.Gold,
      output: Ware.GoldOre,
      radius: 0,
      workTicks: 200,
      depletes: true,
      food: MINER_FOODS,
    },
    available: true,
    description: 'Digs gold ore for the mint.',
  },
  {
    id: BuildingType.GraniteMine,
    name: 'Granite mine',
    size: Size.Mine,
    category: BuildingCategory.Mining,
    cost: [boards(4)],
    buildTicks: 360,
    worker: Profession.Miner,
    behaviour: {
      kind: 'extract',
      resource: Resource.Granite,
      output: Ware.Stone,
      radius: 0,
      workTicks: 180,
      depletes: true,
      food: MINER_FOODS,
    },
    available: true,
    description: 'Wins stone from the mountain when the quarries run out.',
  },

  {
    id: BuildingType.IronSmelter,
    name: 'Iron smelter',
    size: Size.House,
    category: BuildingCategory.MetalAndTools,
    cost: [boards(2), stones(3)],
    buildTicks: 400,
    worker: Profession.IronFounder,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.IronOre, count: 1 },
        { ware: Ware.Coal, count: 1 },
      ],
      output: Ware.Iron,
      workTicks: 160,
    },
    available: true,
    description: 'Smelts ore and coal into iron.',
  },
  {
    id: BuildingType.Mint,
    name: 'Mint',
    size: Size.House,
    category: BuildingCategory.MetalAndTools,
    cost: [boards(2), stones(3)],
    buildTicks: 400,
    worker: Profession.Minter,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.GoldOre, count: 1 },
        { ware: Ware.Coal, count: 1 },
      ],
      output: Ware.Coin,
      workTicks: 180,
    },
    available: true,
    description: 'Strikes coins, which promote soldiers in your strongholds.',
  },
  {
    id: BuildingType.Metalworks,
    name: 'Metalworks',
    size: Size.House,
    category: BuildingCategory.MetalAndTools,
    cost: [boards(2), stones(3)],
    buildTicks: 400,
    worker: Profession.Metalworker,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.Iron, count: 1 },
        { ware: Ware.Board, count: 1 },
      ],
      output: Ware.Hammer,
      alternatives: TOOLS,
      workTicks: 170,
    },
    available: true,
    description: 'Makes the tools every trade depends on.',
  },
  {
    id: BuildingType.Armoury,
    name: 'Armoury',
    size: Size.House,
    category: BuildingCategory.MetalAndTools,
    cost: [boards(2), stones(3)],
    buildTicks: 400,
    worker: Profession.Armourer,
    behaviour: {
      kind: 'craft',
      inputs: [
        { ware: Ware.Iron, count: 1 },
        { ware: Ware.Coal, count: 1 },
      ],
      output: Ware.Sword,
      workTicks: 180,
    },
    available: true,
    description: 'Forges swords and shields.',
  },

  {
    id: BuildingType.Barracks,
    name: 'Barracks',
    size: Size.Hut,
    category: BuildingCategory.Military,
    cost: [boards(2), stones(2)],
    buildTicks: 260,
    worker: null,
    behaviour: { kind: 'military', garrison: 2, radius: 8 },
    available: true,
    description: 'The smallest outpost. Claims a little ground. No garrison yet.',
  },
  {
    id: BuildingType.Guardhouse,
    name: 'Guardhouse',
    size: Size.House,
    category: BuildingCategory.Military,
    cost: [boards(3), stones(3)],
    buildTicks: 400,
    worker: null,
    behaviour: { kind: 'military', garrison: 3, radius: 9 },
    available: true,
    description: 'A sturdier post for a wider claim. No garrison yet.',
  },
  {
    id: BuildingType.WatchTower,
    name: 'Watchtower',
    size: Size.House,
    category: BuildingCategory.Military,
    cost: [boards(4), stones(3)],
    buildTicks: 480,
    worker: null,
    behaviour: { kind: 'military', garrison: 6, radius: 11 },
    available: true,
    description: 'Holds a good stretch of frontier. No garrison yet.',
  },
  {
    id: BuildingType.Fortress,
    name: 'Fortress',
    size: Size.Castle,
    category: BuildingCategory.Military,
    cost: [boards(5), stones(5)],
    buildTicks: 700,
    worker: null,
    behaviour: { kind: 'military', garrison: 9, radius: 13 },
    available: true,
    description: 'The strongest hold, and the widest claim. No garrison yet.',
  },
  {
    id: BuildingType.LookoutTower,
    name: 'Lookout tower',
    size: Size.Hut,
    category: BuildingCategory.Military,
    cost: [boards(4), stones(2)],
    buildTicks: 300,
    worker: null,
    behaviour: { kind: 'unimplemented' },
    available: false,
    description: 'Lifts the fog from a wide circle without claiming it.',
  },

  {
    id: BuildingType.Shipyard,
    name: 'Shipyard',
    size: Size.House,
    category: BuildingCategory.Storage,
    cost: [boards(3), stones(3)],
    buildTicks: 460,
    worker: Profession.Shipwright,
    behaviour: { kind: 'unimplemented' },
    available: false,
    description: 'Builds boats and ships on the shoreline.',
  },
  {
    id: BuildingType.Harbour,
    name: 'Harbour',
    size: Size.Castle,
    category: BuildingCategory.Storage,
    cost: [boards(6), stones(6)],
    buildTicks: 800,
    worker: null,
    behaviour: { kind: 'unimplemented' },
    available: false,
    description: 'Loads expeditions bound for distant shores.',
  },
  {
    id: BuildingType.Catapult,
    name: 'Catapult',
    size: Size.House,
    category: BuildingCategory.Military,
    cost: [boards(4), stones(2)],
    buildTicks: 420,
    worker: null,
    behaviour: { kind: 'unimplemented' },
    available: false,
    description: 'Throws stones at whatever stands across the border.',
  },
];

const BY_ID: readonly BuildingInfo[] = (() => {
  const table: BuildingInfo[] = [];
  for (const building of BUILDINGS) table[building.id] = building;
  return table;
})();

export function buildingInfo(type: BuildingType): BuildingInfo {
  const info = BY_ID[type];
  if (!info) throw new Error(`unknown building type ${type}`);
  return info;
}

/** The buildings the player may currently place, in menu order. */
export const AVAILABLE_BUILDINGS: readonly BuildingInfo[] = BUILDINGS.filter(
  (building) => building.available,
);
