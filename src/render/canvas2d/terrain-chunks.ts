import { Direction } from '../../sim/core/direction';
import { OUT_OF_BOUNDS } from '../../sim/core/grid';
import type { World } from '../../sim/world/world';
import { terrainFill } from '../art/palette';
import { HEIGHT_UNIT, pointX, pointY, TILE_HEIGHT, TILE_WIDTH } from '../projection';

const CHUNK_COLS = 16;
const CHUNK_ROWS = 16;

/** Head-room above a chunk's nominal top for terrain lifted by altitude. */
const MAX_LIFT = 42 * HEIGHT_UNIT;

interface Chunk {
  readonly canvas: HTMLCanvasElement;
  /** Zoom the chunk was drawn at; a different zoom means a redraw. */
  readonly zoom: number;
  /** Top-left of the chunk in map pixels, including the head-room. */
  readonly mapX: number;
  readonly mapY: number;
}

/**
 * Terrain baked into per-chunk offscreen canvases.
 *
 * A full map holds well over a hundred thousand terrain triangles; drawing them
 * every frame would be hopeless on a phone. Terrain never changes after world
 * generation, so each patch is drawn once and then blitted — panning becomes a
 * handful of image copies, and the per-frame work is only the things that
 * actually move.
 */
export class TerrainChunks {
  private readonly world: World;
  private readonly chunks = new Map<number, Chunk>();

  constructor(world: World) {
    this.world = world;
  }

  /** Discards every baked chunk, for a zoom change or a new map. */
  clear(): void {
    this.chunks.clear();
  }

  private key(chunkCol: number, chunkRow: number): number {
    return chunkRow * 4096 + chunkCol;
  }

  /**
   * Draws all terrain covering the given lattice range onto `ctx`, which is
   * expected to already be in screen space.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    zoom: number,
    bounds: { minCol: number; maxCol: number; minRow: number; maxRow: number },
    toScreenX: (mapX: number) => number,
    toScreenY: (mapY: number) => number,
  ): void {
    const firstCol = Math.floor(bounds.minCol / CHUNK_COLS);
    const lastCol = Math.floor(bounds.maxCol / CHUNK_COLS);
    const firstRow = Math.floor(bounds.minRow / CHUNK_ROWS);
    const lastRow = Math.floor(bounds.maxRow / CHUNK_ROWS);

    for (let chunkRow = firstRow; chunkRow <= lastRow; chunkRow += 1) {
      for (let chunkCol = firstCol; chunkCol <= lastCol; chunkCol += 1) {
        const chunk = this.chunkAt(chunkCol, chunkRow, zoom);
        if (!chunk) continue;

        ctx.drawImage(
          chunk.canvas,
          Math.round(toScreenX(chunk.mapX)),
          Math.round(toScreenY(chunk.mapY)),
        );
      }
    }
  }

  private chunkAt(chunkCol: number, chunkRow: number, zoom: number): Chunk | undefined {
    const { grid } = this.world;
    if (chunkCol < 0 || chunkRow < 0) return undefined;
    if (chunkCol * CHUNK_COLS >= grid.width || chunkRow * CHUNK_ROWS >= grid.height) {
      return undefined;
    }

    const key = this.key(chunkCol, chunkRow);
    const existing = this.chunks.get(key);
    if (existing && existing.zoom === zoom) return existing;

    const chunk = this.bake(chunkCol, chunkRow, zoom);
    this.chunks.set(key, chunk);
    return chunk;
  }

  private bake(chunkCol: number, chunkRow: number, zoom: number): Chunk {
    const { grid } = this.world;

    // One extra row and column of points so triangles spanning the seam are
    // drawn by both neighbours and no gap appears between chunks.
    const colStart = chunkCol * CHUNK_COLS;
    const rowStart = chunkRow * CHUNK_ROWS;
    const colEnd = Math.min(grid.width - 1, colStart + CHUNK_COLS);
    const rowEnd = Math.min(grid.height - 1, rowStart + CHUNK_ROWS);

    const mapX = colStart * TILE_WIDTH;
    const mapY = rowStart * TILE_HEIGHT - MAX_LIFT;

    const width = Math.ceil((CHUNK_COLS + 2) * TILE_WIDTH * zoom);
    const height = Math.ceil(((CHUNK_ROWS + 2) * TILE_HEIGHT + MAX_LIFT) * zoom);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser cannot provide a 2D canvas');

    ctx.scale(zoom, zoom);
    ctx.translate(-mapX, -mapY);

    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        this.drawPointTriangles(ctx, grid.index(col, row));
      }
    }

    return { canvas, zoom, mapX, mapY };
  }

  /** Draws the two triangles a lattice point owns. */
  private drawPointTriangles(ctx: CanvasRenderingContext2D, point: number): void {
    const world = this.world;
    const { grid } = world;

    const southWest = grid.neighbour(point, Direction.SouthWest);
    const southEast = grid.neighbour(point, Direction.SouthEast);
    const east = grid.neighbour(point, Direction.East);

    const px = pointX(grid, point);
    const py = pointY(world, point);
    const height = world.height[point]!;

    if (southWest !== OUT_OF_BOUNDS && southEast !== OUT_OF_BOUNDS) {
      const tilt = height - (world.height[southWest]! + world.height[southEast]!) / 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(pointX(grid, southWest), pointY(world, southWest));
      ctx.lineTo(pointX(grid, southEast), pointY(world, southEast));
      ctx.closePath();
      ctx.fillStyle = terrainFill(world.terrainSouth[point]!, tilt);
      ctx.fill();
      // A hairline stroke in the same colour hides the seams antialiasing
      // leaves between adjacent triangles.
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    if (east !== OUT_OF_BOUNDS && southEast !== OUT_OF_BOUNDS) {
      const tilt = (height + world.height[east]!) / 2 - world.height[southEast]!;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(pointX(grid, east), pointY(world, east));
      ctx.lineTo(pointX(grid, southEast), pointY(world, southEast));
      ctx.closePath();
      ctx.fillStyle = terrainFill(world.terrainSouthEast[point]!, tilt);
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }
}
