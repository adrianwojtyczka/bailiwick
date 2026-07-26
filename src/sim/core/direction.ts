/**
 * The six directions of the Settlers-style point lattice.
 *
 * Values are ordered anticlockwise starting at west so that `opposite` is a
 * simple rotation by three, and so the three "canonical" road directions
 * (east, south-east, south-west) form a contiguous idea rather than a
 * scattered set.
 */
export const Direction = {
  West: 0,
  NorthWest: 1,
  NorthEast: 2,
  East: 3,
  SouthEast: 4,
  SouthWest: 5,
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

export const DIRECTIONS: readonly Direction[] = [
  Direction.West,
  Direction.NorthWest,
  Direction.NorthEast,
  Direction.East,
  Direction.SouthEast,
  Direction.SouthWest,
];

/**
 * Every lattice edge is shared by two points. Roads are stored only on the
 * point that owns the edge in one of these three directions, which halves the
 * storage and removes any chance of the two halves disagreeing.
 */
export const CANONICAL_ROAD_DIRECTIONS: readonly Direction[] = [
  Direction.East,
  Direction.SouthEast,
  Direction.SouthWest,
];

export function isCanonicalRoadDirection(direction: Direction): boolean {
  return (
    direction === Direction.East ||
    direction === Direction.SouthEast ||
    direction === Direction.SouthWest
  );
}

export function opposite(direction: Direction): Direction {
  return ((direction + 3) % 6) as Direction;
}

export const DIRECTION_NAMES: Readonly<Record<Direction, string>> = {
  [Direction.West]: 'west',
  [Direction.NorthWest]: 'north-west',
  [Direction.NorthEast]: 'north-east',
  [Direction.East]: 'east',
  [Direction.SouthEast]: 'south-east',
  [Direction.SouthWest]: 'south-west',
};
