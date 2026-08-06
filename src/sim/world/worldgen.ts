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

/**
 * The apron kept clear and level around a headquarters, in nodes.
 *
 * Not merely swept of trees: every node within it has to be ground a settler
 * could build or lay a road on, so the opening moves are never blocked by a
 * pond or a crag right on the doorstep.
 */
const START_CLEAR_RADIUS = 3;

/**
 * How near a start its opening wood and stone must be.
 *
 * Not the whole of what a headquarters claims — that is a fortress's thirteen
 * nodes, and timber at the far edge of it is no use on the first morning. This
 * is the ground a first road can reach, and what the guarantee is counted over.
 */
const START_SUPPLY_RADIUS = 9;

/** Wood and stone a start is guaranteed within its own borders. */
const START_TREES = 20;
const START_OUTCROPS = 4;

/**
 * A range is raised near every start, because most islands have no mountain.
 *
 * Counted over sixteen seeds, six in eight carried no ore at all and four no
 * mineable rock whatever: `generateHeights` has to lift its blended noise clear
 * of `MOUNTAIN_LEVEL`, and `findDeepRock` then wants a solid nineteen-node blob
 * before any of it will hold ore. The two rarities multiply, and an island with
 * a few crags gets nothing. So the shortfall is planted, exactly as
 * `stockStartArea` plants wood and stone — an island with a real range of its
 * own keeps it and nothing is raised.
 */
const RANGE_MIN_DISTANCE = 14;
const RANGE_MAX_DISTANCE = 18;

/** Solid rock out to here, and easing back to the natural ground beyond it. */
const RANGE_RADIUS = 6;
const RANGE_SKIRT = 5;

/** How far from a start the guarantee is counted, and what counts as enough. */
const ORE_REACH = 24;
const RANGE_MIN_ROCK = 24;

/** Nodes of each a start is guaranteed. A mine works one node and exhausts it. */
const START_IRON = 12;
const START_COAL = 12;

/**
 * Where anything planted to make up the shortfall goes: out of the apron, in
 * from the frontier, and near enough that a hut sited on the doorstep still
 * reaches it.
 */
const STOCK_INNER_RADIUS = 5;
const STOCK_OUTER_RADIUS = 8;

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

// ------------------------------------------------------------ the mirror

/**
 * The share of the map's width over which the two halves' noise is blended.
 *
 * Out at either rim the blend does nothing and the noise comes through at its
 * full contrast, so each homeland looks as an unmirrored island always did;
 * across the middle third the two fields cross over. That crossing is what
 * makes the map one continuous country rather than a copy stitched to an
 * original down a visible seam.
 */
const MIRROR_BLEND = 0.35;

/**
 * Samples a noise field so that a point and its mirror always come out with the
 * same number.
 *
 * The two halves are one lattice turned half a turn, so every point belongs to
 * a *pair*. This resolves the pair first — western member, eastern member — and
 * then does exactly the same arithmetic in exactly the same order whichever
 * member it was asked about. Blending "my noise with my mirror's" would be
 * symmetric on paper and off by a rounding in practice, which over eighteen
 * thousand points is a handful of nodes where one player's ground is a
 * millimetre higher than the other's. This way the halves match to the bit.
 *
 * Continuous, too: at the middle the pair's two members swap roles just as the
 * blend reaches an even share of each, and an even share reads the same from
 * both sides.
 */
function foldedNoise(
  grid: MapGrid,
  seed: number,
  wx: number,
  wy: number,
  octaves: number,
  frequency: number,
): number {
  const mx = grid.width - 0.5 - wx;
  const my = grid.height - 1 - wy;

  const west = wx < mx || (wx === mx && wy < my);
  const nx = west ? wx : mx;
  const ny = west ? wy : my;
  const fx = west ? mx : wx;
  const fy = west ? my : wy;

  const u = nx / (grid.width - 0.5);
  const share = smoothstep(Math.max(0, Math.min(1, (u - 0.5) / MIRROR_BLEND + 0.5)));

  return (
    fractalNoise(seed, nx, ny, octaves, frequency) * (1 - share) +
    fractalNoise(seed, fx, fy, octaves, frequency) * share
  );
}

// ------------------------------------------------------------- generation

function generateHeights(world: World, seed: number): void {
  const { grid } = world;
  // The centre of the *mirror*, not of the array: a point and its opposite
  // straddle it exactly, so the falloff below comes out identical for both.
  const centreX = (grid.width - 0.5) / 2;
  const centreY = (grid.height - 1) / 2;

  for (let index = 0; index < grid.size; index += 1) {
    const wx = grid.worldX(index);
    const wy = grid.worldY(index);

    const base = foldedNoise(grid, seed, wx, wy, 5, 0.035);
    // A second, much broader field raises whole highland regions, so mountains
    // form connected ranges worth prospecting rather than isolated pimples.
    const ridges = foldedNoise(grid, seed ^ 0x5bf03635, wx, wy, 3, 0.012);

    // Value noise clusters around its mean, which would leave the map an
    // unbroken plain. Stretching the middle of the range outwards is what
    // produces both real lowlands and peaks above the mountain line.
    // The mapping is chosen so the middle of the noise distribution lands in
    // meadow, its lower tail goes under water, and its upper tail clears the
    // mountain line — giving farmland, coast and ore on the same island.
    const land = base * 0.62 + ridges * 0.38;
    const shaped = Math.max(0, Math.min(1.1, (land - 0.25) / 0.54));

    // Push the map's rim below sea level so the playable area is an island and
    // the edge of the world can never be reached. Each axis is measured against
    // its own half-width, so a map twice as wide as it is tall drowns its ends
    // rather than everything outside a circle that would fit inside it.
    const dx = (wx - centreX) / centreX;
    const dy = (wy - centreY) / centreY;
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
  // Folded like the heights are. Under the half-turn a triangle's three corners
  // become the three corners of its opposite number, so their mean height is
  // already the same on both sides; folding the moisture too is what makes the
  // terrain itself match without a single value being copied across.
  const moisture = foldedNoise(grid, seed ^ 0x1d872b41, wx, wy, 4, 0.05);

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

/** How far inside a range the rock must be before it carries ore. */
const BARREN_MOUNTAIN_RIM = 2;

/** How far from sand, rock, snow or lava groundwater has to be. */
const WATER_DRY_MARGIN = 2;

/** Terrain that rules out groundwater, for itself and for its neighbourhood. */
const DRY_TERRAIN: ReadonlySet<Terrain> = new Set([
  Terrain.Desert,
  Terrain.Mountain,
  Terrain.MountainMeadow,
  Terrain.Snow,
  Terrain.Lava,
]);

/**
 * Marks the rock that lies well inside a range.
 *
 * Ore on the outermost slopes would be found the moment a player nudged a
 * border against a hill. Keeping the rim barren means the mountains have to be
 * entered properly before they give anything up.
 *
 * Computed as one pass over the map and then a neighbourhood test against that,
 * rather than re-deriving each point's terrain nineteen times over.
 */
function findDeepRock(world: World): Uint8Array {
  const { grid } = world;

  const solid = new Uint8Array(grid.size);
  for (let index = 0; index < grid.size; index += 1) {
    if (surroundings(world, index).mineable === 6) solid[index] = 1;
  }

  const deep = new Uint8Array(grid.size);
  for (let index = 0; index < grid.size; index += 1) {
    if (!solid[index]) continue;

    let buried = true;
    for (const near of grid.pointsWithin(index, BARREN_MOUNTAIN_RIM)) {
      if (!solid[near]) {
        buried = false;
        break;
      }
    }
    if (buried) deep[index] = 1;
  }

  return deep;
}

/**
 * Ground that could hold groundwater: soft country, well clear of anywhere dry
 * or stony.
 *
 * Water used to go wherever four sides were buildable, which put wells in the
 * middle of the desert and hard against mountain walls. It now wants grass on
 * every side and no sand, rock, snow or lava for two nodes in any direction.
 */
function findWetGround(world: World): Uint8Array {
  const { grid } = world;

  const soft = new Uint8Array(grid.size);
  for (let index = 0; index < grid.size; index += 1) {
    world.trianglesAroundPoint(index, SCRATCH);

    let grass = 0;
    let dry = false;
    for (let i = 0; i < 6; i += 1) {
      const triangle = SCRATCH[i]!;
      if (triangle === OUT_OF_BOUNDS) {
        dry = true;
        break;
      }
      const terrain = world.terrainOfTriangle(triangle);
      if (terrain === Terrain.Meadow || terrain === Terrain.Steppe) grass += 1;
      if (DRY_TERRAIN.has(terrain as Terrain)) dry = true;
    }

    if (!dry && grass === 6) soft[index] = 1;
  }

  const wet = new Uint8Array(grid.size);
  for (let index = 0; index < grid.size; index += 1) {
    if (!soft[index]) continue;

    let clear = true;
    for (const near of grid.pointsWithin(index, WATER_DRY_MARGIN)) {
      if (!soft[near]) {
        clear = false;
        break;
      }
    }
    if (clear) wet[index] = 1;
  }

  return wet;
}

function generateResources(world: World, seed: number): void {
  const { grid } = world;
  const rng = new Rng(seed ^ 0x2f8a17c5);
  const deepRock = findDeepRock(world);
  const wetGround = findWetGround(world);

  for (let index = 0; index < grid.size; index += 1) {
    const around = surroundings(world, index);

    if (deepRock[index]) {
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

    if (wetGround[index]) {
      // Groundwater under any decent stretch of grass, so a well is a matter of
      // placement rather than luck — but drier country yields less.
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

  // The apron is not judged here. Demanding that three nodes of natural ground
  // already be flat and buildable threw away whole islands — two seeds in
  // sixteen could not be settled at all. `prepareStartArea` levels the apron
  // instead, which turns a hope into a guarantee and leaves the map varied.

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

/**
 * Every start site sits in the western third of the map, and its opposite
 * number in the eastern third.
 *
 * A site is only ever chosen on the near half — the far half is that half
 * turned about — so without this a pair could be picked either side of the
 * middle and the two players would open a dozen nodes apart with the whole
 * island empty behind them. The outer thirds are the homelands; the middle
 * third, which is also where the two noise fields cross over, is the ground
 * they meet on.
 */
const HOMELAND_THIRD = 3;

/**
 * Sites for half the players, all in the west; the other half are these turned
 * about. Odd player counts round up, so the extra site's opposite number goes
 * unused rather than leaving one player without one.
 */
function findStartPairs(world: World, pairs: number): number[] {
  const { grid } = world;

  const scan = (limit: number): { point: number; score: number }[] => {
    const found: { point: number; score: number }[] = [];
    // A coarse scan is plenty: good sites come in patches, not single points.
    for (let y = 6; y < grid.height - 6; y += 2) {
      for (let x = 6; x < limit; x += 2) {
        const point = grid.index(x, y);
        const score = scoreStartSite(world, point);
        if (score > 0) found.push({ point, score });
      }
    }
    return found;
  };

  // The homeland first; a cramped map may have nothing settleable there, and a
  // start anywhere on its own half beats no island at all.
  let candidates = scan(Math.floor(grid.width / HOMELAND_THIRD));
  if (candidates.length < pairs) candidates = scan(grid.width >> 1);

  candidates.sort((a, b) => b.score - a.score || a.point - b.point);

  const chosen: number[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= pairs) break;
    const farEnough = chosen.every(
      (existing) => grid.distance(existing, candidate.point) >= MIN_PLAYER_SEPARATION,
    );
    if (farEnough) chosen.push(candidate.point);
  }

  // Relax the separation rather than fail outright on a cramped map.
  if (chosen.length < pairs) {
    for (const candidate of candidates) {
      if (chosen.length >= pairs) break;
      if (!chosen.includes(candidate.point)) chosen.push(candidate.point);
    }
  }

  if (chosen.length < pairs) {
    throw new Error(`could not find ${pairs} viable starting positions on this map`);
  }

  return chosen;
}

/** Levels the ground around a start site and clears it of trees and stone. */
function prepareStartArea(world: World, point: number): void {
  const level = world.height[point]!;

  for (const candidate of world.grid.pointsWithin(point, START_FLATTEN_RADIUS)) {
    const distance = world.grid.distance(point, candidate);

    // The apron itself is held dead level at the door's own altitude. That is
    // what makes it a guarantee rather than a hope: flat ground at a height the
    // headquarters can stand on is never water and never cliff, so every node
    // of it takes a flag once the trees are cleared off. Judging natural ground
    // instead cost two seeds in sixteen — whole islands with nowhere to settle.
    if (distance <= START_CLEAR_RADIUS) {
      world.height[candidate] = level;
      continue;
    }

    // Beyond it, ease back to the natural terrain so the patch doesn't show.
    const reach = START_FLATTEN_RADIUS + 1 - START_CLEAR_RADIUS;
    const blend = (distance - START_CLEAR_RADIUS) / reach;
    world.height[candidate] = Math.round(world.height[candidate]! * blend + level * (1 - blend));
  }

  for (const candidate of world.grid.pointsWithin(point, START_CLEAR_RADIUS)) {
    world.object[candidate] = MapObject.None;
    world.objectData[candidate] = 0;
  }
}

/**
 * Makes sure a start has wood and stone inside its own borders.
 *
 * The site score rewards trees and outcrops but has never required them, so a
 * seed could open on beautiful empty grassland with nothing to cut and nothing
 * to quarry — an opening with no way out of it. Rather than reject such a map
 * and risk finding no site at all, the shortfall is planted: a wood in a couple
 * of clumps and a few outcrops, out beyond the cleared apron but well inside
 * the frontier.
 *
 * Seeded throughout, so the island stays a pure function of its seed.
 */
function stockStartArea(world: World, point: number, seed: number): void {
  const { grid } = world;
  const rng = new Rng(seed ^ (point * 0x9e3779b1));

  let trees = 0;
  let outcrops = 0;
  for (const candidate of grid.pointsWithin(point, START_SUPPLY_RADIUS)) {
    if (world.object[candidate] === MapObject.Tree) trees += 1;
    if (world.object[candidate] === MapObject.Stone) outcrops += 1;
  }

  // Only the ring between the apron and the frontier is available, and only
  // where nothing stands already.
  const open: number[] = [];
  for (const candidate of grid.pointsWithin(point, STOCK_OUTER_RADIUS)) {
    if (grid.distance(point, candidate) < STOCK_INNER_RADIUS) continue;
    if (world.object[candidate] !== MapObject.None) continue;
    open.push(candidate);
  }

  const plantable = open.filter((candidate) => surroundings(world, candidate).plantable === 6);
  const buildable = open.filter((candidate) => surroundings(world, candidate).buildable === 6);

  // A wood, not a sprinkle: saplings go in around a couple of seed points, so
  // the result reads like a copse rather than a dusting of single trees.
  let wanted = START_TREES - trees;
  while (wanted > 0 && plantable.length > 0) {
    const heart = rng.pick(plantable)!;
    for (const candidate of grid.pointsWithin(heart, 2)) {
      if (wanted <= 0) break;
      if (world.object[candidate] !== MapObject.None) continue;
      if (grid.distance(point, candidate) < STOCK_INNER_RADIUS) continue;
      if (surroundings(world, candidate).plantable < 6) continue;
      if (!rng.chance(0.7)) continue;

      world.object[candidate] = MapObject.Tree;
      world.objectData[candidate] = TREE_FULLY_GROWN;
      wanted -= 1;
    }

    // Nothing took around this heart, so there is nothing to be gained by
    // trying it again.
    const at = plantable.indexOf(heart);
    if (at >= 0) plantable.splice(at, 1);
  }

  let missing = START_OUTCROPS - outcrops;
  while (missing > 0 && buildable.length > 0) {
    const at = rng.nextInt(buildable.length);
    const candidate = buildable.splice(at, 1)[0]!;
    if (world.object[candidate] !== MapObject.None) continue;

    world.object[candidate] = MapObject.Stone;
    world.objectData[candidate] = rng.nextRange(3, 6);
    missing -= 1;
  }
}

/**
 * Where to put a range for a start that has none, or nothing if the island
 * already carries one.
 *
 * The band it is chosen from is a short expansion away — outside the levelled
 * apron, and about one outpost out — so the ore is something to reach for
 * rather than something on the doorstep. Within the band the highest natural
 * ground wins, so the range grows out of a rise the island already had instead
 * of standing on the flat like a wart.
 */
function rangeSiteFor(
  world: World,
  start: number,
  deep: Uint8Array,
): { readonly point: number; readonly radius: number } | undefined {
  const { grid } = world;

  let rock = 0;
  for (const point of grid.pointsWithin(start, ORE_REACH)) rock += deep[point]!;
  if (rock >= RANGE_MIN_ROCK) return undefined;

  const look = (radius: number, near: number, out: number): number | undefined => {
    let best: number | undefined;
    let bestScore = -1;

    for (const point of grid.pointsWithin(start, out)) {
      if (grid.distance(start, point) < near) continue;

      let score = 0;
      let room = true;
      for (const candidate of grid.pointsWithin(point, radius)) {
        // Filling in a bay to make a mountain would take the coast with it, and
        // a range half off the map is half a range.
        if (world.height[candidate]! < SEA_LEVEL || !isInterior(world, candidate)) {
          room = false;
          break;
        }
        score += world.height[candidate]!;
      }
      if (!room) continue;

      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }

    return best;
  };

  // A full range, a short walk out, is what a start ought to get. Some islands
  // are a spit of land with a third of the ground about the start above water,
  // and there a smaller range, nearer or further, beats no ore at all — so the
  // search gives way on size first and then on where it will look, stopping
  // only where the ore would fall outside what the guarantee is counted over.
  for (let radius = RANGE_RADIUS; radius >= RANGE_RADIUS - 2; radius -= 1) {
    const point = look(radius, RANGE_MIN_DISTANCE, RANGE_MAX_DISTANCE);
    if (point !== undefined) return { point, radius };
  }
  for (let radius = RANGE_RADIUS; radius >= RANGE_RADIUS - 2; radius -= 1) {
    const point = look(radius, START_FLATTEN_RADIUS + radius, ORE_REACH - 3);
    if (point !== undefined) return { point, radius };
  }

  return undefined;
}

/**
 * Raises a mountain, and the same mountain on the other half.
 *
 * The plateau is held between the mountain line and the snow line, since snow
 * is not mineable, and roughened a little so it does not read as a cake. The
 * skirt eases back to the natural ground over five nodes — two or three units a
 * node, well inside what a road can climb, because a range a mine cannot be
 * roaded to is no use to anybody.
 *
 * Nothing within a start's own levelled apron is touched, whichever start it
 * belongs to, so the opening moves stay on the flat ground they were promised.
 */
function raiseARange(
  world: World,
  range: { readonly point: number; readonly radius: number },
  starts: readonly number[],
  seed: number,
): void {
  const { grid } = world;

  for (const middle of [range.point, grid.mirrored(range.point)]) {
    for (const point of grid.pointsWithin(middle, range.radius + RANGE_SKIRT)) {
      if (starts.some((start) => grid.distance(start, point) <= START_FLATTEN_RADIUS + 1)) {
        continue;
      }

      const rough = foldedNoise(grid, seed ^ 0x2b1f5c07, grid.worldX(point), grid.worldY(point), 2, 0.12);
      const peak = MOUNTAIN_LEVEL + 2 + rough * 4;

      const away = grid.distance(middle, point);
      const natural = world.height[point]!;
      const target =
        away <= range.radius
          ? peak
          : peak + (natural - peak) * smoothstep((away - range.radius) / (RANGE_SKIRT + 1));

      world.height[point] = Math.max(natural, Math.min(HEIGHT_SCALE, Math.round(target)));
    }
  }
}

/**
 * Lays a seam of one ore through the rock nearest a start.
 *
 * Grown outwards from a single node rather than sprinkled, so a geologist's
 * find still tells the player something about the ridge he is standing on. An
 * island's own rock comes in patches, though, and the nearest patch is often
 * smaller than a seam — so when one runs out the seam picks up again at the
 * next nearest rock rather than stopping short of what was promised.
 */
function laySeam(
  world: World,
  rock: readonly number[],
  taken: Set<number>,
  wanted: number,
  resource: Resource,
  rng: Rng,
): void {
  const available = new Set(rock.filter((point) => !taken.has(point)));
  let left = wanted;

  while (left > 0) {
    const start = rock.find((point) => available.has(point));
    if (start === undefined) return;

    const queue = [start];
    available.delete(start);

    while (queue.length > 0 && left > 0) {
      const point = queue.shift()!;
      taken.add(point);
      world.resource[point] = resource;
      world.resourceAmount[point] = rng.nextRange(6, 24);
      left -= 1;

      for (const near of world.grid.pointsWithin(point, 1)) {
        if (!available.has(near)) continue;
        available.delete(near);
        queue.push(near);
      }
    }
  }
}

/**
 * Makes sure a start has iron and coal in reach, on both halves at once.
 *
 * Ore is laid on the point and on its opposite number together, rather than
 * left to the wholesale mirroring, because on a small map a start's reach can
 * cross the middle and the stamp would rub half a seam out again.
 *
 * Granite and gold are left to the band noise: nice to have, never promised.
 */
function oreForTheRange(world: World, start: number, seed: number): void {
  const { grid } = world;
  const deep = findDeepRock(world);

  const rock = grid
    .pointsWithin(start, ORE_REACH)
    .filter((point) => deep[point])
    .sort((a, b) => grid.distance(start, a) - grid.distance(start, b) || a - b);

  const count = (resource: Resource): number =>
    rock.reduce((total, point) => total + (world.resource[point] === resource ? 1 : 0), 0);

  const short = new Map<Resource, number>();
  if (count(Resource.Iron) < START_IRON) short.set(Resource.Iron, START_IRON);
  if (count(Resource.Coal) < START_COAL) short.set(Resource.Coal, START_COAL);
  if (short.size === 0) return;

  // What the island already has enough of is protected — but only up to what
  // its own guarantee asks for, and only the nodes nearest the start. Two
  // mistakes were made here in turn. Laying coal over every node of natural
  // iron left a start with eighteen iron holding ten; then protecting *all* the
  // iron on an island whose rock was almost entirely iron left nowhere to put
  // the coal, and the start held five. Keeping a dozen and freeing the rest is
  // what satisfies both.
  const taken = new Set<number>();
  for (const [resource, wanted] of [
    [Resource.Iron, START_IRON],
    [Resource.Coal, START_COAL],
  ] as const) {
    if (short.has(resource)) continue;
    let kept = 0;
    for (const point of rock) {
      if (kept >= wanted) break;
      if (world.resource[point] !== resource) continue;
      taken.add(point);
      kept += 1;
    }
  }

  const rng = new Rng(seed ^ (start * 0x2545f491));
  for (const [resource, wanted] of short) {
    laySeam(world, rock, taken, wanted, resource, rng);
  }

  for (const point of taken) {
    const opposite = grid.mirrored(point);
    world.resource[opposite] = world.resource[point]!;
    world.resourceAmount[opposite] = world.resourceAmount[point]!;
  }
}

/**
 * Stamps the western half of the map onto the eastern one.
 *
 * The ground itself needs no stamping — heights and terrain are made symmetric
 * where they are generated, because a copied *surface* would leave a cliff down
 * the join. Trees, stone and ore are another matter: they are laid down by an
 * `Rng` walking the map in index order, which no amount of folded noise would
 * make symmetric, and being one thing to a node they can be copied across
 * without any seam to show for it.
 */
function mirrorHalf(world: World): void {
  const { grid } = world;
  const half = grid.width >> 1;

  for (let index = 0; index < grid.size; index += 1) {
    if (grid.xOf(index) >= half) continue;
    const opposite = grid.mirrored(index);
    world.object[opposite] = world.object[index]!;
    world.objectData[opposite] = world.objectData[index]!;
    world.resource[opposite] = world.resource[index]!;
    world.resourceAmount[opposite] = world.resourceAmount[index]!;
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

  if ((height & 1) === 1) {
    // The half-turn sends row `y` to row `height - 1 - y`. On an odd number of
    // rows the middle row maps onto itself while keeping its half-step offset,
    // and the lattice no longer lines up with its own reflection.
    throw new Error(`a mirrored map needs an even height, received ${height}`);
  }

  const grid = new MapGrid(width, height);
  const world = new World(grid);

  generateHeights(world, seed);

  // Terrain has to exist before sites can be judged, and the start areas have
  // to be levelled before terrain is finalised — so terrain is derived twice.
  generateTerrain(world, seed);

  const pairs = findStartPairs(world, Math.ceil(players / 2));
  // Both members of every pair, including the one an odd player count leaves
  // unsettled: every deliberate edit to the ground has to land on both halves,
  // or they stop being the same country and the tests that say so start lying.
  const sites: number[] = [];
  for (const point of pairs) sites.push(point, grid.mirrored(point));

  for (const point of sites) prepareStartArea(world, point);

  const rock = findDeepRock(world);
  for (const point of pairs) {
    const range = rangeSiteFor(world, point, rock);
    if (range !== undefined) raiseARange(world, range, sites, seed);
  }

  generateTerrain(world, seed);

  generateObjects(world, seed);
  generateResources(world, seed);

  // The prepared start areas must stay clear even after object generation.
  for (const point of sites) {
    for (const candidate of grid.pointsWithin(point, START_CLEAR_RADIUS)) {
      world.object[candidate] = MapObject.None;
      world.objectData[candidate] = 0;
    }
  }

  // Only once the apron is clear, so nothing planted can land back inside it.
  for (const point of pairs) stockStartArea(world, point, seed);

  mirrorHalf(world);

  // After the stamp, so a seam that reaches across the middle is not rubbed
  // out again by it.
  for (const point of pairs) oreForTheRange(world, point, seed);

  return { world, startPoints: sites.slice(0, players) };
}

/** True when every neighbour of the point is inside the map. */
export function isInterior(world: World, point: number): boolean {
  for (const direction of DIRECTIONS) {
    if (world.grid.neighbour(point, direction) === OUT_OF_BOUNDS) return false;
  }
  return true;
}

const SCRATCH = new Int32Array(6);
