import { Ware } from './wares';

/**
 * The trades a settler can follow. A settler leaves the headquarters as a
 * plain helper and takes up a trade when a building needs one — which is why
 * tools matter: without a saw there is no carpenter, however many settlers are
 * idle.
 */
export const Profession = {
  /** Carries wares between two flags, or walks to take up a trade. */
  Helper: 0,
  Woodcutter: 1,
  Forester: 2,
  Carpenter: 3,
  Stonemason: 4,
  Builder: 5,
  Fisher: 6,
  Hunter: 7,
  Farmer: 8,
  Miller: 9,
  Baker: 10,
  Butcher: 11,
  Brewer: 12,
  PigBreeder: 13,
  DonkeyBreeder: 14,
  Miner: 15,
  IronFounder: 16,
  Minter: 17,
  Metalworker: 18,
  Armourer: 19,
  WellDigger: 20,
  Geologist: 21,
  Scout: 22,
  Shipwright: 23,
  Soldier: 24,
} as const;

export type Profession = (typeof Profession)[keyof typeof Profession];

export interface ProfessionInfo {
  readonly id: Profession;
  readonly name: string;
  /** The tool this trade needs before a helper can take it up. */
  readonly tool: Ware | null;
}

export const PROFESSIONS: readonly ProfessionInfo[] = [
  { id: Profession.Helper, name: 'Helper', tool: null },
  { id: Profession.Woodcutter, name: 'Woodcutter', tool: Ware.Axe },
  { id: Profession.Forester, name: 'Forester', tool: Ware.Shovel },
  { id: Profession.Carpenter, name: 'Carpenter', tool: Ware.Saw },
  { id: Profession.Stonemason, name: 'Stonemason', tool: Ware.PickAxe },
  { id: Profession.Builder, name: 'Builder', tool: Ware.Hammer },
  { id: Profession.Fisher, name: 'Fisher', tool: Ware.FishingRod },
  { id: Profession.Hunter, name: 'Hunter', tool: Ware.Bow },
  { id: Profession.Farmer, name: 'Farmer', tool: Ware.Scythe },
  { id: Profession.Miller, name: 'Miller', tool: null },
  { id: Profession.Baker, name: 'Baker', tool: Ware.RollingPin },
  { id: Profession.Butcher, name: 'Butcher', tool: Ware.Cleaver },
  { id: Profession.Brewer, name: 'Brewer', tool: null },
  { id: Profession.PigBreeder, name: 'Pig breeder', tool: null },
  { id: Profession.DonkeyBreeder, name: 'Donkey breeder', tool: null },
  { id: Profession.Miner, name: 'Miner', tool: Ware.PickAxe },
  { id: Profession.IronFounder, name: 'Iron founder', tool: Ware.Crucible },
  { id: Profession.Minter, name: 'Minter', tool: Ware.Crucible },
  { id: Profession.Metalworker, name: 'Metalworker', tool: Ware.Hammer },
  { id: Profession.Armourer, name: 'Armourer', tool: Ware.Hammer },
  { id: Profession.WellDigger, name: 'Well digger', tool: Ware.Shovel },
  { id: Profession.Geologist, name: 'Geologist', tool: Ware.Hammer },
  { id: Profession.Scout, name: 'Scout', tool: null },
  { id: Profession.Shipwright, name: 'Shipwright', tool: Ware.Hammer },
  { id: Profession.Soldier, name: 'Soldier', tool: null },
];

const BY_ID: readonly ProfessionInfo[] = (() => {
  const table: ProfessionInfo[] = [];
  for (const profession of PROFESSIONS) table[profession.id] = profession;
  return table;
})();

export function professionInfo(profession: Profession): ProfessionInfo {
  const info = BY_ID[profession];
  if (!info) throw new Error(`unknown profession ${profession}`);
  return info;
}
