// Rasterises the application icon at build time.
//
// Drawn with the same parchment/ink/ochre palette as the game itself, at 4x
// resolution and box-downsampled for anti-aliasing. The background is
// full-bleed so the icon also works as an Android maskable icon, with the
// motif kept well inside the safe zone.
import { encodePng } from './png';

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const PARCHMENT: Rgb = { r: 0xf4, g: 0xe8, b: 0xce };
const PARCHMENT_DEEP: Rgb = { r: 0xe8, g: 0xd8, b: 0xb4 };
const INK: Rgb = { r: 0x33, g: 0x26, b: 0x1a };
const OCHRE: Rgb = { r: 0xc4, g: 0x83, b: 0x2b };
const FOREST: Rgb = { r: 0x4a, g: 0x6b, b: 0x32 };
const BRICK: Rgb = { r: 0x9c, g: 0x41, b: 0x28 };

const SUPERSAMPLE = 4;

class Canvas {
  readonly size: number;
  private readonly pixels: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.pixels = new Uint8Array(size * size * 3);
  }

  fill(color: Rgb): void {
    for (let i = 0; i < this.pixels.length; i += 3) {
      this.pixels[i] = color.r;
      this.pixels[i + 1] = color.g;
      this.pixels[i + 2] = color.b;
    }
  }

  plot(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 3;
    this.pixels[i] = color.r;
    this.pixels[i + 1] = color.g;
    this.pixels[i + 2] = color.b;
  }

  /** Fills every pixel for which `inside` reports true. */
  paint(inside: (x: number, y: number) => boolean, color: Rgb): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (inside(x + 0.5, y + 0.5)) this.plot(x, y, color);
      }
    }
  }

  /** Averages each SUPERSAMPLE x SUPERSAMPLE block into one opaque RGBA pixel. */
  downsample(factor: number): { size: number; rgba: Uint8Array } {
    const size = this.size / factor;
    const rgba = new Uint8Array(size * size * 4);
    const samples = factor * factor;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < factor; sy += 1) {
          for (let sx = 0; sx < factor; sx += 1) {
            const i = ((y * factor + sy) * this.size + (x * factor + sx)) * 3;
            r += this.pixels[i]!;
            g += this.pixels[i + 1]!;
            b += this.pixels[i + 2]!;
          }
        }
        const o = (y * size + x) * 4;
        rgba[o] = Math.round(r / samples);
        rgba[o + 1] = Math.round(g / samples);
        rgba[o + 2] = Math.round(b / samples);
        rgba[o + 3] = 255;
      }
    }

    return { size, rgba };
  }
}

function roundedRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): (x: number, y: number) => boolean {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
}

function triangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): (x: number, y: number) => boolean {
  const sign = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (px - rx) * (qy - ry) - (qx - rx) * (py - ry);

  return (x, y) => {
    const d1 = sign(x, y, ax, ay, bx, by);
    const d2 = sign(x, y, bx, by, cx, cy);
    const d3 = sign(x, y, cx, cy, ax, ay);
    const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNegative && hasPositive);
  };
}

function rect(x0: number, y0: number, x1: number, y1: number): (x: number, y: number) => boolean {
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function ring(
  outer: (x: number, y: number) => boolean,
  inner: (x: number, y: number) => boolean,
): (x: number, y: number) => boolean {
  return (x, y) => outer(x, y) && !inner(x, y);
}

/** Renders the Bailiwick icon at `size` x `size` and returns encoded PNG bytes. */
export function renderIcon(size: number): Buffer {
  const canvas = new Canvas(size * SUPERSAMPLE);
  const s = canvas.size;
  const u = (fraction: number) => fraction * s;

  canvas.fill(PARCHMENT);

  // Ochre keyline, inset far enough to survive Android's maskable crop.
  canvas.paint(
    ring(
      roundedRect(u(0.11), u(0.11), u(0.89), u(0.89), u(0.17)),
      roundedRect(u(0.145), u(0.145), u(0.855), u(0.855), u(0.14)),
    ),
    OCHRE,
  );

  // Ground.
  canvas.paint(rect(u(0.2), u(0.7), u(0.8), u(0.74)), FOREST);

  // Hut body with an ink outline.
  canvas.paint(rect(u(0.35), u(0.5), u(0.62), u(0.7)), INK);
  canvas.paint(rect(u(0.375), u(0.525), u(0.595), u(0.7)), PARCHMENT_DEEP);

  // Roof.
  canvas.paint(triangle(u(0.485), u(0.3), u(0.3), u(0.51), u(0.67), u(0.51)), INK);
  canvas.paint(triangle(u(0.485), u(0.335), u(0.345), u(0.492), u(0.625), u(0.492)), BRICK);

  // Flag on its pole — the Settlers signature, and the game's road marker.
  canvas.paint(rect(u(0.7), u(0.36), u(0.725), u(0.7)), INK);
  canvas.paint(triangle(u(0.725), u(0.37), u(0.725), u(0.47), u(0.83), u(0.42)), OCHRE);

  const { size: outSize, rgba } = canvas.downsample(SUPERSAMPLE);
  return encodePng(outSize, outSize, rgba);
}
