import { Terrain } from '../../sim/world/terrain';

/**
 * The game's colours, carried over from the welcome page's parchment-and-ink
 * palette so the map, the menus and the HUD read as one drawing.
 */
export const PALETTE = {
  parchment: '#f4e8ce',
  parchmentDeep: '#e8d8b4',
  ink: '#33261a',
  inkSoft: '#6b5843',
  ochre: '#c4832b',
  forest: '#4a6b32',
  brick: '#9c4128',
  rule: '#d3bf94',
} as const;

/** Base colour of each terrain, before slope shading. */
export const TERRAIN_COLOURS: Readonly<Record<Terrain, string>> = {
  [Terrain.Water]: '#63899f',
  [Terrain.Meadow]: '#7b9350',
  [Terrain.Steppe]: '#a2955d',
  [Terrain.Desert]: '#d5c48f',
  [Terrain.Swamp]: '#5c6a49',
  [Terrain.Mountain]: '#8a8078',
  [Terrain.MountainMeadow]: '#8a9a66',
  [Terrain.Snow]: '#e6e4dc',
  [Terrain.Lava]: '#b5462a',
};

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseHex(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

const TERRAIN_RGB: readonly Rgb[] = (() => {
  const table: Rgb[] = [];
  for (const [terrain, hex] of Object.entries(TERRAIN_COLOURS)) {
    table[Number(terrain)] = parseHex(hex);
  }
  return table;
})();

/** Shading steps either side of flat, so slopes read as light and shadow. */
const SHADE_STEPS = 9;
const SHADE_RANGE = 0.26;

/**
 * Pre-mixed shaded colours, indexed by terrain and shading step.
 *
 * Terrain is baked into chunk canvases, but a chunk can still contain a few
 * thousand triangles; building the colour string per triangle would dominate
 * the bake. Mixing them once up front makes it a table lookup.
 */
const SHADED: readonly (readonly string[])[] = (() => {
  const table: string[][] = [];

  for (let terrain = 0; terrain < TERRAIN_RGB.length; terrain += 1) {
    const base = TERRAIN_RGB[terrain];
    if (!base) continue;

    const shades: string[] = [];
    for (let step = 0; step < SHADE_STEPS; step += 1) {
      const factor = 1 + ((step / (SHADE_STEPS - 1)) * 2 - 1) * SHADE_RANGE;
      const r = Math.round(Math.min(255, base.r * factor));
      const g = Math.round(Math.min(255, base.g * factor));
      const b = Math.round(Math.min(255, base.b * factor));
      shades.push(`rgb(${r},${g},${b})`);
    }
    table[terrain] = shades;
  }

  return table;
})();

/**
 * The fill for a terrain triangle, darkened or lightened by how it lies.
 *
 * `tilt` is the height difference across the triangle: positive where the face
 * rises away from the viewer and should catch the light.
 */
export function terrainFill(terrain: number, tilt: number): string {
  const shades = SHADED[terrain] ?? SHADED[Terrain.Water]!;
  const middle = (SHADE_STEPS - 1) / 2;
  // A gentle response: strong enough that hills read as hills, weak enough
  // that ordinary undulation does not turn the map into a patchwork.
  const step = Math.max(0, Math.min(SHADE_STEPS - 1, Math.round(middle + tilt * 0.8)));
  return shades[step]!;
}

/** Player colours, used for flags, borders and building trim. */
export const PLAYER_COLOURS: readonly string[] = ['#c4832b', '#3f6f9c', '#8a4b8f', '#4a8f5f'];
