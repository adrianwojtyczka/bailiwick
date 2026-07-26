/**
 * Every good that can travel the road network.
 *
 * The full Settlers II range is declared here even though the opening release
 * only produces part of it. Wares are pure data — a table entry, a colour and a
 * name — so the later production chains are a matter of switching buildings on,
 * not of extending the transport or storage code.
 */
export const Ware = {
  Log: 0,
  Board: 1,
  Stone: 2,

  Grain: 3,
  Flour: 4,
  Bread: 5,
  Fish: 6,
  Meat: 7,
  Ham: 8,
  Water: 9,
  Beer: 10,

  Coal: 11,
  IronOre: 12,
  GoldOre: 13,
  Iron: 14,
  Coin: 15,

  Sword: 16,
  Shield: 17,

  Hammer: 18,
  Axe: 19,
  Saw: 20,
  PickAxe: 21,
  Shovel: 22,
  Crucible: 23,
  FishingRod: 24,
  Scythe: 25,
  Cleaver: 26,
  RollingPin: 27,
  Bow: 28,
  Tongs: 29,

  Boat: 30,
  Donkey: 31,
} as const;

export type Ware = (typeof Ware)[keyof typeof Ware];

export const WareCategory = {
  Construction: 'construction',
  Food: 'food',
  Ore: 'ore',
  Metal: 'metal',
  Weapon: 'weapon',
  Tool: 'tool',
  Transport: 'transport',
} as const;

export type WareCategory = (typeof WareCategory)[keyof typeof WareCategory];

export interface WareInfo {
  readonly id: Ware;
  readonly name: string;
  readonly category: WareCategory;
  /** Used by the renderer to tint the crate a carrier is holding. */
  readonly colour: string;
}

export const WARES: readonly WareInfo[] = [
  { id: Ware.Log, name: 'Log', category: WareCategory.Construction, colour: '#8a5a2b' },
  { id: Ware.Board, name: 'Board', category: WareCategory.Construction, colour: '#c99a52' },
  { id: Ware.Stone, name: 'Stone', category: WareCategory.Construction, colour: '#9a9187' },

  { id: Ware.Grain, name: 'Grain', category: WareCategory.Food, colour: '#d9b64a' },
  { id: Ware.Flour, name: 'Flour', category: WareCategory.Food, colour: '#efe3c8' },
  { id: Ware.Bread, name: 'Bread', category: WareCategory.Food, colour: '#b9793c' },
  { id: Ware.Fish, name: 'Fish', category: WareCategory.Food, colour: '#6fa3b5' },
  { id: Ware.Meat, name: 'Meat', category: WareCategory.Food, colour: '#a94b3c' },
  { id: Ware.Ham, name: 'Ham', category: WareCategory.Food, colour: '#c9736a' },
  { id: Ware.Water, name: 'Water', category: WareCategory.Food, colour: '#5f92ad' },
  { id: Ware.Beer, name: 'Beer', category: WareCategory.Food, colour: '#c68a2e' },

  { id: Ware.Coal, name: 'Coal', category: WareCategory.Ore, colour: '#38332e' },
  { id: Ware.IronOre, name: 'Iron ore', category: WareCategory.Ore, colour: '#7d5c4a' },
  { id: Ware.GoldOre, name: 'Gold ore', category: WareCategory.Ore, colour: '#b8912f' },
  { id: Ware.Iron, name: 'Iron', category: WareCategory.Metal, colour: '#8d8f94' },
  { id: Ware.Coin, name: 'Coin', category: WareCategory.Metal, colour: '#e0b53a' },

  { id: Ware.Sword, name: 'Sword', category: WareCategory.Weapon, colour: '#b6bcc4' },
  { id: Ware.Shield, name: 'Shield', category: WareCategory.Weapon, colour: '#7a6a52' },

  { id: Ware.Hammer, name: 'Hammer', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Axe, name: 'Axe', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Saw, name: 'Saw', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.PickAxe, name: 'Pick axe', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Shovel, name: 'Shovel', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Crucible, name: 'Crucible', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.FishingRod, name: 'Fishing rod', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Scythe, name: 'Scythe', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Cleaver, name: 'Cleaver', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.RollingPin, name: 'Rolling pin', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Bow, name: 'Bow', category: WareCategory.Tool, colour: '#7a6a52' },
  { id: Ware.Tongs, name: 'Tongs', category: WareCategory.Tool, colour: '#7a6a52' },

  { id: Ware.Boat, name: 'Boat', category: WareCategory.Transport, colour: '#8a5a2b' },
  { id: Ware.Donkey, name: 'Donkey', category: WareCategory.Transport, colour: '#9b8368' },
];

export const WARE_COUNT = WARES.length;

const BY_ID: readonly WareInfo[] = (() => {
  const table: WareInfo[] = [];
  for (const ware of WARES) table[ware.id] = ware;
  return table;
})();

export function wareInfo(ware: Ware): WareInfo {
  const info = BY_ID[ware];
  if (!info) throw new Error(`unknown ware ${ware}`);
  return info;
}

/** Anything a mine's workers will eat. */
export const MINER_FOODS: readonly Ware[] = [Ware.Bread, Ware.Fish, Ware.Meat];
