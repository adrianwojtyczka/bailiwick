import { Direction, DIRECTIONS } from '../core/direction';
import { MapGrid, OUT_OF_BOUNDS } from '../core/grid';
import { Rng } from '../core/rng';
import { MapObject, Resource, Terrain, TREE_FULLY_GROWN, terrainOf } from './terrain';
import { World } from './world';

export interface WorldGenOptions {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  /** How many starting positions to find, one per player. */
  readonly players: number;
}

export interface GeneratedWorld {
  readonly world: World;
  /** One headquarters site per player, in player order. */
  readonly startPoints: readonly number[];
}

/** Altitudes run 0..HEIGHT_SCALE; the thresholds below are in the same units. */
const HEIGHT_SCALE = 40;
const SEA_LEVEL = 13;
const BEACH_LEVEL = 15;
const MOUNTAIN_MEADOW_LEVEL = 24;
const MOUNTAIN_LEVEL = 27;
const SNOW_LEVEL = 37;

/** The starting area is levelled so the first buildings always have room. */
const START_FLATTEN_RADIUS = 6;
const MIN_PLAYER_SEPARATION = 18;

// ------------------------------------------------------------------- noise

function hashInt(seed: number, x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return (h ^ (h >>> 16)) >>> 0;
}

function lattice(seed: number, x: number, y: number): number {
  return hashInt(seed, x, y) / 0x1_0000_0000;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinearly interpolated value noise — smooth, seeded, and allocation free. */
function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);

  const v00 = lattice(seed, x0, y0);
  const v10 = lattice(seed, x0 + 1, y0);
  const v01 = lattice(seed, x0, y0 + 1);
  const v11 = lattice(seed, x0 + 1, y0 + 1);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

function fractalNoise(
  seed: number,
  x: number,
  y: number,
  octaves: number,
  frequency: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let f = frequency;

  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * valueNoise(seed + octave * 7919, x * f, y * f);
    total += amplitude;
    amplitude *= 0.5;
    f *= 2;
  }

  return sum / total;
}

// ------------------------------------------------------------- generation

function generateHeights(world: World, seed: number): void {
  const { grid } = world;
  const centreX = grid.width / 2;
  const centreY = grid.height / 2;
  const maxRadius = Math.min(centreX, centreY);

  for (let index = 0; index < grid.size; index += 1) {
    const wx = grid.worldX(index);
    const wy = grid.worldY(index);

    const base = fractalNoise(seed, wx, wy, 5, 0.035);
    // A second, much broader field raises whole highland regions, so mountains
    // form connected ranges worth prospecting rather than isolated pimples.
    const ridges = fractalNoise(seed ^ 0x5bf03635, wx, wy, 3, 0.012);

    // Value noise clusters around its mean, which would leave the map an
    // unbroken plain. Stretching the middle of the range outwards is what
    // produces both real lowlands and peaks above the mountain line.
    // The mapping is chosen so the middle of the noise distribution lands in
    // meadow, its lower tail goes under water, and its upper tail clears the
    // mountain line — giving farmland, coast and ore on the same island.
    const land = base * 0.62 + ridges * 0.38;
    const shaped = Math.max(0, Math.min(1.1, (land - 0.25) / 0.54));

    // Push the map's rim below sea level so the playable area is an island and
    // the edge of the world can never be reached.
    const dx = (wx - centreX) / maxRadius;
    const dy = (wy - centreY) / maxRadius;
    const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy));
    const falloff = smoothstep(Math.max(0, Math.min(1, (radial - 0.7) / 0.28)));

    const value = shaped - falloff * 1.15;
    world.height[index] = Math.max(0, Math.min(HEIGHT_SCALE, Math.round(value * HEIGHT_SCALE)));
  }
}

function terrainForTriangle(
  world: World,
  seed: number,
  a: number,
  b: number,
  c: number,
): Terrain {
  const height = (world.height[a]! + world.height[b]! + world.height[c]!) / 3;

  if (height < SEA_LEVEL) return Terrain.Water;

  const { grid } = world;
  const wx = (grid.worldX(a) + grid.worldX(b) + grid.worldX(c)) / 3;
  const wy = (grid.worldY(a) + grid.worldY(b) + grid.worldY(c)) / 3;
  const moisture = fractalNoise(seed ^ 0x1d872b41, wx, wy, 4, 0.05);

  if (height < BEACH_LEVEL) return Terrain.Desert;

  if (height < MOUNTAIN_MEADOW_LEVEL) {
    if (moisture < 0.34) return Terrain.Steppe;
    if (moisture > 0.78 && height < BEACH_LEVEL + 3) return Terrain.Swamp;
    return Terrain.Meadow;
  }

  if (height < MOUNTAIN_LEVEL) return Terrain.MountainMeadow;
  if (height < SNOW_LEVEL) return Terrain.Mountain;
  return Terrain.Snow;
}

function generateTerrain(world: World, seed: number): void {
  const { grid } = world;

  for (let index = 0; index < grid.size; index += 1) {
    const southWest = grid.neighbour(index, Direction.SouthWest);
    const southEast = grid.neighbour(index, Direction.SouthEast);
    const east = grid.neighbour(index, Direction.East);

    world.terrainSouth[index] =
      southWest === OUT_OF_BOUNDS || southEast === OUT_OF_BOUNDS
        ? Terrain.Water
        : terrainForTriangle(world, seed, index, southWest, southEast);

    world.terrainSouthEast[index] =
      east === OUT_OF_BOUNDS || southEast === OUT_OF_BOUNDS
        ? Terrain.Water
        : terrainForTriangle(world, seed, index, east, southEast);
  }
}

/** Classifies the six triangles meeting at a point. */
function surroundings(world: World, point: number): {
  buildable: number;
  mineable: number;
  plantable: number;
  water: number;
} {
  world.trianglesAroundPoint(point, SCRATCH);

  let buildable = 0;
  let mineable = 0;
  let plantable = 0;
  let water = 0;

  for (let i = 0; i < 6; i += 1) {
    const triangle = SCRATCH[i]!;
    if (triangle === OUT_OF_BOUNDS) continue;
    const terrain = world.terrainOfTriangle(triangle);
    const properties = terrainOf(terrain);
    if (properties.buildable) buildable += 1;
    if (properties.mineable) mineable += 1;
    if (properties.plantable) plantable += 1;
    if (terrain === Terrain.Water) water += 1;
  }

  return { buildable, mineable, plantable, water };
}

function generateObjects(world: World, seed: number): void {
  const { grid } = world;
  const rng = new Rng(seed ^ 0x71fa9d13);

  for (let index = 0; index < grid.size; index += 1) {
    const around = surroundings(world, index);

    // Forests, clustered by their own noise field rather than scattered evenly.
    if (around.plantable === 6) {
      const density = fractalNoise(seed ^ 0x3c6ef372, grid.worldX(index), grid.worldY(index), 3, 0.09);
      if (density > 0.56 && rng.chance((density - 0.56) * 2.4)) {
        world.object[index] = MapObject.Tree;
        world.objectData[index] = TREE_FULLY_GROWN;
        continue;
      }
    }

    // Granite outcrops gather where the meadows meet the mountains, but they
    // also crop up in their own patches out on open ground — a settlement with
    // no mountain in reach still needs somewhere to put a quarry.
    if (around.mineable >= 1 && around.buildable >= 1 && rng.chance(0.14)) {
      world.object[index] = MapObject.Stone;
      world.objectData[index] = rng.nextRange(3, 6);
      continue;
    }

    if (around.buildable === 6) {
      const rockiness = fractalNoise(
        seed ^ 0x517cc1b7,
        grid.worldX(index),
        grid.worldY(index),
        3,
        0.11,
      );
      if (rockiness > 0.63 && rng.chance((rockiness - 0.63) * 3.2)) {
        world.object[index] = MapObject.Stone;
        world.objectData[index] = rng.nextRange(2, 5);
        continue;
      }
    }

    if (around.buildable === 6 && rng.chance(0.02)) {
      world.object[index] = MapObject.Decoration;
      world.objectData[index] = rng.nextInt(4);
    }
  }
}

function generateResources(world: World, seed: number): void {
  const { grid } = world;
  const rng = new Rng(seed ^ 0x2f8a17c5);

  for (let index = 0; index < grid.size; index += 1) {
    const around = surroundings(world, index);

    if (around.mineable >= 4) {
      // Ore bodies are laid out in broad bands so a geologist's find tells the
      // player something useful about the whole ridge.
      const band = fractalNoise(seed ^ 0x6d1a3f77, grid.worldX(index), grid.worldY(index), 2, 0.07);
      const resource =
        band < 0.3
          ? Resource.Coal
          : band < 0.55
            ? Resource.Iron
            : band < 0.72
              ? Resource.Granite
              : band < 0.86
                ? Resource.Coal
                : Resource.Gold;

      world.resource[index] = resource;
      // Enough to make sinking a shaft worth the boards it costs. A mine works
      // the seam for some way around itself, but the ore still runs out, which
      // is what eventually pushes a player outwards.
      world.resourceAmount[index] = rng.nextRange(6, 24);
      continue;
    }

    if (around.water >= 3) {
      world.resource[index] = Resource.Fish;
      world.resourceAmount[index] = rng.nextRange(4, 12);
      continue;
    }

    if (around.buildable >= 4) {
      // Groundwater almost everywhere, so wells are a matter of placement
      // rather than luck — but drier ground yields less.
      const wetness = fractalNoise(seed ^ 0x4b7d2e91, grid.worldX(index), grid.worldY(index), 3, 0.04);
      world.resource[index] = Resource.Water;
      world.resourceAmount[index] = wetness > 0.35 ? 10 : 4;
    }
  }
}

/** Scores how good a headquarters site is: flat, roomy, and near resources. */
function scoreStartSite(world: World, point: number): number {
  const around = surroundings(world, point);
  if (around.buildable < 6) return -1;
  if (world.maxSlopeAround(point) > 1) return -1;
  if (world.object[point] !== MapObject.None) return -1;

  let openGround = 0;
  let trees = 0;
  let stone = 0;

  for (const candidate of world.grid.pointsWithin(point, 7)) {
    const local = surroundings(world, candidate);
    if (local.buildable === 6 && world.maxSlopeAround(candidate) <= 2) openGround += 1;
    if (world.object[candidate] === MapObject.Tree) trees += 1;
    if (world.object[candidate] === MapObject.Stone) stone += 1;
  }

  if (openGround < 60) return -1;

  // Room to build matters most; nearby wood and stone shorten the opening.
  return openGround + Math.min(trees, 25) * 2 + Math.min(stone, 12) * 3;
}

function findStartPoints(world: World, players: number): number[] {
  const { grid } = world;
  const candidates: { point: number; score: number }[] = [];

  // A coarse scan is plenty: good sites come in patches, not single points.
  for (let y = 6; y < grid.height - 6; y += 2) {
    for (let x = 6; x < grid.width - 6; x += 2) {
      const point = grid.index(x, y);
      const score = scoreStartSite(world, point);
      if (score > 0) candidates.push({ point, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.point - b.point);

  const chosen: number[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= players) break;
    const farEnough = chosen.every(
      (existing) => grid.distance(existing, candidate.point) >= MIN_PLAYER_SEPARATION,
    );
    if (farEnough) chosen.push(candidate.point);
  }

  // Relax the separation rather than fail outright on a cramped map.
  if (chosen.length < players) {
    for (const candidate of candidates) {
      if (chosen.length >= players) break;
      if (!chosen.includes(candidate.point)) chosen.push(candidate.point);
    }
  }

  if (chosen.length < players) {
    throw new Error(`could not find ${players} viable starting positions on this map`);
  }

  return chosen;
}

/** Levels the ground around a start site and clears it of trees and stone. */
function prepareStartArea(world: World, point: number): void {
  const level = world.height[point]!;

  for (const candidate of world.grid.pointsWithin(point, START_FLATTEN_RADIUS)) {
    const distance = world.grid.distance(point, candidate);
    // Ease back to the natural terrain at the rim so the patch doesn't show.
    const blend = distance / (START_FLATTEN_RADIUS + 1);
    world.height[candidate] = Math.round(world.height[candidate]! * blend + level * (1 - blend));
  }

  for (const candidate of world.grid.pointsWithin(point, 2)) {
    world.object[candidate] = MapObject.None;
    world.objectData[candidate] = 0;
  }
}

/**
 * Builds a fresh island map from a seed.
 *
 * Generation is a pure function of the seed: the same seed always produces the
 * same island, which is what lets a save store a seed plus a command log rather
 * than a full terrain dump, and what makes the golden tests meaningful.
 */
export function generateWorld(options: WorldGenOptions): GeneratedWorld {
  const { width, height, seed, players } = options;

  const grid = new MapGrid(width, height);
  const world = new World(grid);

  generateHeights(world, seed);

  const startPoints = (() => {
    // Terrain has to exist before sites can be judged, and the start areas have
    // to be levelled before terrain is finalised — so terrain is derived twice.
    generateTerrain(world, seed);
    const points = findStartPoints(world, players);
    for (const point of points) prepareStartArea(world, point);
    generateTerrain(world, seed);
    return points;
  })();

  generateObjects(world, seed);
  generateResources(world, seed);

  // The prepared start areas must stay clear even after object generation.
  for (const point of startPoints) {
    for (const candidate of grid.pointsWithin(point, 2)) {
      world.object[candidate] = MapObject.None;
      world.objectData[candidate] = 0;
    }
  }

  return { world, startPoints };
}

/** True when every neighbour of the point is inside the map. */
export function isInterior(world: World, point: number): boolean {
  for (const direction of DIRECTIONS) {
    if (world.grid.neighbour(point, direction) === OUT_OF_BOUNDS) return false;
  }
  return true;
}

const SCRATCH = new Int32Array(6);
