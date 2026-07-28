/**
 * Terrain lives on the triangles between lattice points, not on the points
 * themselves. What you may build somewhere is decided by the six triangles
 * that meet at that point, which is why a hut can sit on a shoreline but a
 * castle cannot.
 */
export const Terrain = {
  Water: 0,
  Meadow: 1,
  Steppe: 2,
  Desert: 3,
  Swamp: 4,
  Mountain: 5,
  MountainMeadow: 6,
  Snow: 7,
  Lava: 8,
} as const;

export type Terrain = (typeof Terrain)[keyof typeof Terrain];

export interface TerrainProperties {
  readonly name: string;
  /** Settlers may cross it on foot. */
  readonly walkable: boolean;
  /** Ordinary buildings may stand on it. */
  readonly buildable: boolean;
  /** Mines may be sunk into it. */
  readonly mineable: boolean;
  /** Boats may cross it. */
  readonly navigable: boolean;
  /** Foresters may plant here and trees may grow. */
  readonly plantable: boolean;
  /** Farms may sow fields here. */
  readonly farmable: boolean;
}

export const TERRAIN: Readonly<Record<Terrain, TerrainProperties>> = {
  [Terrain.Water]: {
    name: 'Water',
    walkable: false,
    buildable: false,
    mineable: false,
    navigable: true,
    plantable: false,
    farmable: false,
  },
  [Terrain.Meadow]: {
    name: 'Meadow',
    walkable: true,
    buildable: true,
    mineable: false,
    navigable: false,
    plantable: true,
    farmable: true,
  },
  [Terrain.Steppe]: {
    name: 'Steppe',
    walkable: true,
    buildable: true,
    mineable: false,
    navigable: false,
    plantable: true,
    farmable: false,
  },
  [Terrain.Desert]: {
    name: 'Desert',
    walkable: true,
    buildable: true,
    mineable: false,
    navigable: false,
    plantable: false,
    farmable: false,
  },
  [Terrain.Swamp]: {
    name: 'Swamp',
    walkable: true,
    buildable: false,
    mineable: false,
    navigable: false,
    plantable: false,
    farmable: false,
  },
  [Terrain.Mountain]: {
    name: 'Mountain',
    walkable: true,
    buildable: false,
    mineable: true,
    navigable: false,
    plantable: false,
    farmable: false,
  },
  [Terrain.MountainMeadow]: {
    name: 'Mountain meadow',
    walkable: true,
    buildable: true,
    mineable: false,
    navigable: false,
    plantable: true,
    farmable: false,
  },
  [Terrain.Snow]: {
    name: 'Snow',
    walkable: false,
    buildable: false,
    mineable: false,
    navigable: false,
    plantable: false,
    farmable: false,
  },
  [Terrain.Lava]: {
    name: 'Lava',
    walkable: false,
    buildable: false,
    mineable: false,
    navigable: false,
    plantable: false,
    farmable: false,
  },
};

export function terrainOf(value: number): TerrainProperties {
  return TERRAIN[value as Terrain] ?? TERRAIN[Terrain.Water];
}

/** Objects standing on a lattice point. */
export const MapObject = {
  None: 0,
  Tree: 1,
  /** A granite outcrop a quarry can work. */
  Stone: 2,
  /** Purely decorative: shrubs, bones, cacti. */
  Decoration: 3,
  /** A grain field sown by a farm, in one of several growth stages. */
  Field: 4,
} as const;

export type MapObject = (typeof MapObject)[keyof typeof MapObject];

/**
 * Growth runs one stage past the last one that is drawn.
 *
 * `MAX_GROWTH` is the tallest a tree or the fullest a field is ever pictured;
 * `FULLY_GROWN` is the stage at which it may be felled or cut, one higher. A
 * crop therefore stands ripe for a whole growth interval before anyone comes
 * for it, instead of being taken on the tick it finishes looking ready.
 */
export const TREE_MAX_GROWTH = 4;
export const TREE_FULLY_GROWN = 5;

export const FIELD_MAX_GROWTH = 3;
export const FIELD_FULLY_GROWN = 4;

/** Underground resources, revealed by geologists and worked by mines. */
export const Resource = {
  None: 0,
  Coal: 1,
  Iron: 2,
  Gold: 3,
  Granite: 4,
  /** Groundwater, which is what a well actually needs. */
  Water: 5,
  Fish: 6,
} as const;

export type Resource = (typeof Resource)[keyof typeof Resource];

export const RESOURCE_NAMES: Readonly<Record<Resource, string>> = {
  [Resource.None]: 'nothing',
  [Resource.Coal]: 'coal',
  [Resource.Iron]: 'iron ore',
  [Resource.Gold]: 'gold ore',
  [Resource.Granite]: 'granite',
  [Resource.Water]: 'water',
  [Resource.Fish]: 'fish',
};
