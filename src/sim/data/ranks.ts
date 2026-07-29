/**
 * A soldier's standing.
 *
 * Every soldier starts a private and is promoted by gold: a coin carried out to
 * the building he holds buys one man one step. That is the whole purpose of the
 * gold chain — a mine, a smelter and a mint exist so that the men on the
 * frontier are better than the men who walked out to it.
 *
 * Ranks are stored as counts rather than as five kinds of soldier, so a
 * garrison is an array indexed by these values.
 */
export const Rank = {
  Private: 0,
  PrivateFirstClass: 1,
  Sergeant: 2,
  Officer: 3,
  General: 4,
} as const;

export type Rank = (typeof Rank)[keyof typeof Rank];

export const RANK_NAMES: readonly string[] = [
  'Private',
  'Private first class',
  'Sergeant',
  'Officer',
  'General',
];

export const RANK_COUNT = RANK_NAMES.length;

/** The highest rank there is: a general cannot be promoted, and wants no coin. */
export const TOP_RANK = Rank.General;

export function rankName(rank: number): string {
  return RANK_NAMES[rank] ?? RANK_NAMES[Rank.Private]!;
}

/** An empty garrison, sized for every rank. */
export function emptyGarrison(): number[] {
  return new Array<number>(RANK_COUNT).fill(0);
}

/** How many men a garrison holds, across all ranks. */
export function garrisonStrength(garrison: readonly number[]): number {
  let total = 0;
  for (const count of garrison) total += count;
  return total;
}
