import { BuildingType } from '../../sim/data/buildings';
import { BuildingSize } from '../../sim/world/buildspace';
import { PALETTE } from './palette';

/**
 * Every sprite in the game, drawn in code at load time.
 *
 * The original Settlers II artwork is copyrighted and is not used here.
 * Drawing the whole set procedurally keeps the download to a single script,
 * makes the game work offline the moment it has loaded, and lets the map share
 * the parchment-and-ink language of the title screen rather than imitating
 * somebody else's pixels.
 */
export interface Sprite {
  readonly canvas: HTMLCanvasElement;
  /** Draw size in map pixels at zoom 1. */
  readonly width: number;
  readonly height: number;
  /** Where the lattice point sits within the sprite, as a fraction. */
  readonly anchorX: number;
  readonly anchorY: number;
}

/** Sprites are drawn at this multiple and scaled down, so zooming stays sharp. */
const SUPERSAMPLE = 3;

interface DrawOptions {
  readonly width: number;
  readonly height: number;
  readonly anchorX?: number;
  readonly anchorY?: number;
}

function createSprite(
  options: DrawOptions,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(options.width * SUPERSAMPLE);
  canvas.height = Math.ceil(options.height * SUPERSAMPLE);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser cannot provide a 2D canvas');

  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  paint(ctx, options.width, options.height);

  return {
    canvas,
    width: options.width,
    height: options.height,
    anchorX: options.anchorX ?? 0.5,
    anchorY: options.anchorY ?? 1,
  };
}

function outlined(ctx: CanvasRenderingContext2D, fill: string, lineWidth = 1.1): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

// ------------------------------------------------------------------- trees

function drawTree(ctx: CanvasRenderingContext2D, w: number, h: number, growth: number): void {
  // Saplings are short and sparse; a full-grown tree fills the sprite.
  const maturity = 0.28 + 0.72 * growth;
  const crownHeight = h * 0.72 * maturity;
  const crownWidth = w * 0.9 * maturity;
  const trunkHeight = h * 0.26 * maturity;
  const cx = w / 2;
  const base = h - 1;

  ctx.beginPath();
  ctx.moveTo(cx - w * 0.06 * maturity, base);
  ctx.lineTo(cx - w * 0.045 * maturity, base - trunkHeight);
  ctx.lineTo(cx + w * 0.045 * maturity, base - trunkHeight);
  ctx.lineTo(cx + w * 0.06 * maturity, base);
  ctx.closePath();
  outlined(ctx, '#6b4a2a', 0.9);

  // Three stacked tufts read as a conifer at any size.
  const top = base - trunkHeight - crownHeight;
  for (let tier = 0; tier < 3; tier += 1) {
    const t = tier / 2;
    const tierWidth = crownWidth * (0.55 + 0.45 * t);
    const tierY = top + crownHeight * (t * 0.62);
    const tierBottom = tierY + crownHeight * 0.5;

    ctx.beginPath();
    ctx.moveTo(cx, tierY);
    ctx.lineTo(cx + tierWidth / 2, tierBottom);
    ctx.lineTo(cx - tierWidth / 2, tierBottom);
    ctx.closePath();
    outlined(ctx, tier === 0 ? '#5a7d3c' : tier === 1 ? '#4e6f34' : '#43602c', 0.9);
  }
}

// ------------------------------------------------------------------ stone

function drawStone(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number): void {
  const scale = 0.5 + 0.5 * amount;
  const cx = w / 2;
  const base = h - 1;

  const blocks = [
    { x: -0.3, y: 0, s: 0.42 },
    { x: 0.22, y: 0.08, s: 0.36 },
    { x: -0.02, y: -0.24, s: 0.4 },
  ];

  for (const block of blocks) {
    const size = w * block.s * scale;
    const x = cx + block.x * w * scale;
    const y = base + block.y * h * scale;

    ctx.beginPath();
    ctx.moveTo(x - size / 2, y);
    ctx.lineTo(x - size / 2.4, y - size * 0.75);
    ctx.lineTo(x + size / 3, y - size * 0.9);
    ctx.lineTo(x + size / 2, y - size * 0.2);
    ctx.closePath();
    outlined(ctx, '#9a9187', 0.9);
  }
}

function drawDecoration(ctx: CanvasRenderingContext2D, w: number, h: number, variant: number): void {
  const cx = w / 2;
  const base = h - 1;

  if (variant % 2 === 0) {
    // A tuft of grass.
    ctx.strokeStyle = '#6b8145';
    ctx.lineWidth = 1;
    for (let blade = -2; blade <= 2; blade += 1) {
      ctx.beginPath();
      ctx.moveTo(cx + blade * 1.6, base);
      ctx.quadraticCurveTo(cx + blade * 2.6, base - h * 0.5, cx + blade * 3.4, base - h * 0.8);
      ctx.stroke();
    }
    return;
  }

  // A low shrub.
  ctx.beginPath();
  ctx.ellipse(cx, base - h * 0.3, w * 0.32, h * 0.3, 0, 0, Math.PI * 2);
  outlined(ctx, '#6f8a4a', 0.9);
}

// --------------------------------------------------------------- buildings

interface BuildingLook {
  readonly roof: string;
  readonly glyph: (ctx: CanvasRenderingContext2D, x: number, y: number, s: number) => void;
}

function glyphAxe(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x - s * 0.1, y + s * 0.5);
  ctx.lineTo(x + s * 0.1, y - s * 0.5);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = s * 0.16;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + s * 0.05, y - s * 0.45);
  ctx.lineTo(x + s * 0.5, y - s * 0.2);
  ctx.lineTo(x + s * 0.1, y);
  ctx.closePath();
  outlined(ctx, PALETTE.inkSoft, 0.7);
}

function glyphSapling(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.5);
  ctx.lineTo(x, y - s * 0.2);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = s * 0.14;
  ctx.stroke();

  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * s * 0.24, y - s * 0.24, s * 0.24, s * 0.14, side * 0.6, 0, Math.PI * 2);
    outlined(ctx, PALETTE.forest, 0.7);
  }
}

function glyphSaw(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x - s * 0.5, y - s * 0.2);
  ctx.lineTo(x + s * 0.5, y - s * 0.2);
  ctx.lineTo(x + s * 0.5, y + s * 0.05);
  for (let tooth = 4; tooth >= 0; tooth -= 1) {
    const tx = x - s * 0.5 + (tooth / 5) * s;
    ctx.lineTo(tx + s * 0.1, y + s * 0.25);
    ctx.lineTo(tx, y + s * 0.05);
  }
  ctx.closePath();
  outlined(ctx, PALETTE.inkSoft, 0.7);
}

function glyphBlock(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.rect(x - s * 0.4, y - s * 0.32, s * 0.8, s * 0.64);
  outlined(ctx, '#9a9187', 0.8);
  ctx.beginPath();
  ctx.moveTo(x - s * 0.4, y);
  ctx.lineTo(x + s * 0.4, y);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

function glyphBucket(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x - s * 0.34, y - s * 0.3);
  ctx.lineTo(x + s * 0.34, y - s * 0.3);
  ctx.lineTo(x + s * 0.24, y + s * 0.34);
  ctx.lineTo(x - s * 0.24, y + s * 0.34);
  ctx.closePath();
  outlined(ctx, '#5f92ad', 0.8);
}

function glyphFish(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.36, s * 0.22, 0, 0, Math.PI * 2);
  outlined(ctx, '#6fa3b5', 0.8);

  ctx.beginPath();
  ctx.moveTo(x - s * 0.34, y);
  ctx.lineTo(x - s * 0.56, y - s * 0.2);
  ctx.lineTo(x - s * 0.56, y + s * 0.2);
  ctx.closePath();
  outlined(ctx, '#6fa3b5', 0.8);
}

function glyphCrate(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.rect(x - s * 0.38, y - s * 0.34, s * 0.76, s * 0.68);
  outlined(ctx, '#a9803f', 0.8);

  ctx.beginPath();
  ctx.moveTo(x - s * 0.38, y - s * 0.34);
  ctx.lineTo(x + s * 0.38, y + s * 0.34);
  ctx.moveTo(x + s * 0.38, y - s * 0.34);
  ctx.lineTo(x - s * 0.38, y + s * 0.34);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

function glyphBanner(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x - s * 0.32, y - s * 0.4);
  ctx.lineTo(x + s * 0.32, y - s * 0.4);
  ctx.lineTo(x + s * 0.32, y + s * 0.18);
  ctx.lineTo(x, y + s * 0.42);
  ctx.lineTo(x - s * 0.32, y + s * 0.18);
  ctx.closePath();
  outlined(ctx, PALETTE.ochre, 0.8);
}

const BUILDING_LOOKS: Readonly<Record<number, BuildingLook>> = {
  [BuildingType.Headquarters]: { roof: '#9c4128', glyph: glyphBanner },
  [BuildingType.Storehouse]: { roof: '#8a6a3a', glyph: glyphCrate },
  [BuildingType.Woodcutter]: { roof: '#7a5330', glyph: glyphAxe },
  [BuildingType.Forester]: { roof: '#4a6b32', glyph: glyphSapling },
  [BuildingType.Sawmill]: { roof: '#a1642c', glyph: glyphSaw },
  [BuildingType.Quarry]: { roof: '#7d7269', glyph: glyphBlock },
  [BuildingType.Well]: { roof: '#5f92ad', glyph: glyphBucket },
  [BuildingType.Fishery]: { roof: '#4d7f8f', glyph: glyphFish },
};

const DEFAULT_LOOK: BuildingLook = { roof: '#8a6a3a', glyph: glyphCrate };

const SIZE_DIMENSIONS: Readonly<Record<number, { width: number; height: number }>> = {
  [BuildingSize.Hut]: { width: 30, height: 30 },
  [BuildingSize.House]: { width: 40, height: 38 },
  [BuildingSize.Castle]: { width: 54, height: 50 },
  [BuildingSize.Mine]: { width: 30, height: 28 },
};

function drawBuilding(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  look: BuildingLook,
  size: BuildingSize,
): void {
  const base = h - 1;
  const bodyHeight = h * (size === BuildingSize.Castle ? 0.5 : 0.46);
  const bodyWidth = w * 0.66;
  const cx = w / 2;
  const bodyTop = base - bodyHeight;

  // Shadow, so buildings sit on the ground rather than float above it.
  ctx.beginPath();
  ctx.ellipse(cx, base - 1, bodyWidth * 0.6, h * 0.07, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(51, 38, 26, 0.22)';
  ctx.fill();

  if (size === BuildingSize.Mine) {
    // A mine is a timbered adit cut into the hillside, not a house.
    ctx.beginPath();
    ctx.rect(cx - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
    outlined(ctx, '#6b5a45');

    ctx.beginPath();
    ctx.moveTo(cx - bodyWidth * 0.28, base);
    ctx.lineTo(cx - bodyWidth * 0.28, bodyTop + bodyHeight * 0.3);
    ctx.quadraticCurveTo(cx, bodyTop, cx + bodyWidth * 0.28, bodyTop + bodyHeight * 0.3);
    ctx.lineTo(cx + bodyWidth * 0.28, base);
    ctx.closePath();
    outlined(ctx, PALETTE.ink);
    return;
  }

  ctx.beginPath();
  ctx.rect(cx - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  outlined(ctx, PALETTE.parchmentDeep);

  // Roof, overhanging the walls.
  const roofHeight = h - bodyHeight - 1;
  ctx.beginPath();
  ctx.moveTo(cx, base - bodyHeight - roofHeight);
  ctx.lineTo(cx + w * 0.46, bodyTop + 1);
  ctx.lineTo(cx - w * 0.46, bodyTop + 1);
  ctx.closePath();
  outlined(ctx, look.roof);

  look.glyph(ctx, cx, bodyTop + bodyHeight * 0.52, Math.min(bodyWidth, bodyHeight) * 0.72);
}

function drawConstructionSite(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const base = h - 1;
  const cx = w / 2;
  const frameWidth = w * 0.6;
  const frameHeight = h * 0.5;

  ctx.beginPath();
  ctx.ellipse(cx, base - 1, frameWidth * 0.6, h * 0.06, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(51, 38, 26, 0.18)';
  ctx.fill();

  // Bare scaffolding: four posts and a couple of braces.
  ctx.strokeStyle = '#8a6a45';
  ctx.lineWidth = 1.6;

  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + (side * frameWidth) / 2, base);
    ctx.lineTo(cx + (side * frameWidth) / 2, base - frameHeight);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(cx - frameWidth / 2, base - frameHeight);
  ctx.lineTo(cx + frameWidth / 2, base - frameHeight);
  ctx.moveTo(cx - frameWidth / 2, base - frameHeight * 0.5);
  ctx.lineTo(cx + frameWidth / 2, base - frameHeight * 0.5);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - frameWidth / 2, base);
  ctx.lineTo(cx + frameWidth / 2, base - frameHeight);
  ctx.stroke();
}

function drawFlag(ctx: CanvasRenderingContext2D, w: number, h: number, colour: string): void {
  const base = h - 1;
  const poleX = w * 0.34;

  ctx.beginPath();
  ctx.moveTo(poleX, base);
  ctx.lineTo(poleX, 1);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(poleX, 1.5);
  ctx.lineTo(w - 1, h * 0.24);
  ctx.lineTo(poleX, h * 0.44);
  ctx.closePath();
  outlined(ctx, colour, 1);
}

function drawSettler(ctx: CanvasRenderingContext2D, w: number, h: number, colour: string): void {
  const cx = w / 2;
  const base = h - 1;

  ctx.beginPath();
  ctx.ellipse(cx, base, w * 0.34, h * 0.07, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(51, 38, 26, 0.25)';
  ctx.fill();

  // Body.
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.28, base - 1);
  ctx.lineTo(cx - w * 0.2, base - h * 0.5);
  ctx.lineTo(cx + w * 0.2, base - h * 0.5);
  ctx.lineTo(cx + w * 0.28, base - 1);
  ctx.closePath();
  outlined(ctx, colour, 0.9);

  // Head.
  ctx.beginPath();
  ctx.arc(cx, base - h * 0.66, w * 0.24, 0, Math.PI * 2);
  outlined(ctx, PALETTE.parchment, 0.9);
}

function drawCrate(ctx: CanvasRenderingContext2D, w: number, h: number, colour: string): void {
  ctx.beginPath();
  ctx.rect(1, 1, w - 2, h - 2);
  outlined(ctx, colour, 0.9);
}

// ------------------------------------------------------------------ sheet

export interface SpriteSheet {
  readonly trees: readonly Sprite[];
  readonly stones: readonly Sprite[];
  readonly decorations: readonly Sprite[];
  readonly buildings: ReadonlyMap<BuildingType, Sprite>;
  readonly sites: ReadonlyMap<BuildingSize, Sprite>;
  readonly flags: ReadonlyMap<string, Sprite>;
  readonly settlers: ReadonlyMap<string, Sprite>;
  crate(colour: string): Sprite;
}

/** Draws the whole sprite set. Call once, at start-up. */
export function buildSprites(
  buildingTypes: readonly { id: BuildingType; size: BuildingSize }[],
  playerColours: readonly string[],
): SpriteSheet {
  const trees = [0, 1, 2, 3, 4].map((stage) =>
    createSprite({ width: 22, height: 32 }, (ctx, w, h) => drawTree(ctx, w, h, stage / 4)),
  );

  const stones = [0, 1, 2].map((level) =>
    createSprite({ width: 22, height: 18 }, (ctx, w, h) => drawStone(ctx, w, h, (level + 1) / 3)),
  );

  const decorations = [0, 1].map((variant) =>
    createSprite({ width: 16, height: 12 }, (ctx, w, h) => drawDecoration(ctx, w, h, variant)),
  );

  const buildings = new Map<BuildingType, Sprite>();
  for (const entry of buildingTypes) {
    const dimensions = SIZE_DIMENSIONS[entry.size] ?? SIZE_DIMENSIONS[BuildingSize.Hut]!;
    const look = BUILDING_LOOKS[entry.id] ?? DEFAULT_LOOK;
    buildings.set(
      entry.id,
      createSprite(dimensions, (ctx, w, h) => drawBuilding(ctx, w, h, look, entry.size)),
    );
  }

  const sites = new Map<BuildingSize, Sprite>();
  for (const size of [
    BuildingSize.Hut,
    BuildingSize.House,
    BuildingSize.Castle,
    BuildingSize.Mine,
  ]) {
    const dimensions = SIZE_DIMENSIONS[size]!;
    sites.set(size, createSprite(dimensions, drawConstructionSite));
  }

  const flags = new Map<string, Sprite>();
  const settlers = new Map<string, Sprite>();
  for (const colour of playerColours) {
    flags.set(
      colour,
      createSprite({ width: 16, height: 26, anchorX: 0.34 }, (ctx, w, h) =>
        drawFlag(ctx, w, h, colour),
      ),
    );
    settlers.set(
      colour,
      createSprite({ width: 12, height: 18 }, (ctx, w, h) => drawSettler(ctx, w, h, colour)),
    );
  }

  const crates = new Map<string, Sprite>();

  return {
    trees,
    stones,
    decorations,
    buildings,
    sites,
    flags,
    settlers,
    crate(colour: string): Sprite {
      let sprite = crates.get(colour);
      if (!sprite) {
        sprite = createSprite({ width: 9, height: 9, anchorY: 0.5 }, (ctx, w, h) =>
          drawCrate(ctx, w, h, colour),
        );
        crates.set(colour, sprite);
      }
      return sprite;
    },
  };
}
