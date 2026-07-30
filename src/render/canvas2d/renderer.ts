import { DIRECTIONS } from '../../sim/core/direction';
import { OUT_OF_BOUNDS } from '../../sim/core/grid';
import type { BuildingType } from '../../sim/data/buildings';
import { BUILDINGS, buildingInfo } from '../../sim/data/buildings';
import { garrisonStrength } from '../../sim/data/ranks';
import { wareInfo } from '../../sim/data/wares';
import { BuildingState, SettlerState } from '../../sim/entities/types';
import type { Simulation } from '../../sim/simulation';
import {
  BuildSpace,
  canHostSize,
  canPlaceOutpost,
  evaluateBuildSpace,
} from '../../sim/world/buildspace';
import { MapObject, Resource } from '../../sim/world/terrain';
import { PALETTE, PLAYER_COLOURS } from '../art/palette';
import { buildSprites, type Sprite, type SpriteSheet } from '../art/sprites';
import { Camera } from '../camera';
import { depthOf, pointX, pointY } from '../projection';
import type { Renderer, ViewState } from '../renderer';
import { TerrainChunks } from './terrain-chunks';

/** How many men a building of this type has room for, or 0 if it takes none. */
function garrisonPlaces(type: BuildingType): number {
  const behaviour = buildingInfo(type).behaviour;
  return behaviour.kind === 'military' ? behaviour.garrison : 0;
}

/**
 * How each kind of deposit is marked once a geologist has found it. Fish are
 * left out: a shoal is plain to see without anybody digging for it.
 */
const DEPOSIT_COLOURS: Readonly<Partial<Record<Resource, string>>> = {
  [Resource.Coal]: '#38332e',
  [Resource.Iron]: '#7d5c4a',
  [Resource.Gold]: '#e0b53a',
  [Resource.Granite]: '#9a9187',
  [Resource.Water]: '#5f92ad',
};

/** Ground a geologist has dug and found nothing in. */
const BARREN_COLOUR = 'rgba(90, 80, 68, 0.55)';

/** Zoom is snapped to these steps before terrain is baked, so panning at a
 *  slightly wobbling pinch zoom doesn't rebake every chunk every frame. */
const ZOOM_STEPS = [0.5, 0.65, 0.8, 1, 1.25, 1.6, 2, 2.4];

function snapZoom(zoom: number): number {
  let best = ZOOM_STEPS[0]!;
  for (const step of ZOOM_STEPS) {
    if (Math.abs(step - zoom) < Math.abs(best - zoom)) best = step;
  }
  return best;
}

interface Drawable {
  depth: number;
  sprite: Sprite;
  x: number;
  y: number;
  alpha: number;
}

export class CanvasRenderer implements Renderer {
  readonly camera: Camera;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly simulation: Simulation;
  private readonly terrain: TerrainChunks;
  private readonly sprites: SpriteSheet;

  private pixelRatio = 1;
  private bakedZoom = 1;

  // Reused between frames so a busy screen doesn't churn the collector.
  private readonly pool: Drawable[] = [];
  private readonly order: number[] = [];
  private used = 0;

  constructor(canvas: HTMLCanvasElement, simulation: Simulation) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('this browser cannot provide a 2D canvas');

    this.canvas = canvas;
    this.ctx = ctx;
    this.simulation = simulation;
    this.camera = new Camera(simulation.world);
    this.terrain = new TerrainChunks(simulation.world);
    this.sprites = buildSprites(
      BUILDINGS.map((building) => ({ id: building.id, size: building.size })),
      PLAYER_COLOURS,
    );
  }

  resize(width: number, height: number, pixelRatio: number): void {
    // A phone at 3x costs nine times the fill rate of 1x for detail nobody can
    // see at this scale; 2x is the sweet spot between crisp and smooth.
    this.pixelRatio = Math.min(2, pixelRatio);

    this.canvas.width = Math.max(1, Math.round(width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(height * this.pixelRatio));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.camera.setViewport(width, height);
  }

  destroy(): void {
    this.terrain.clear();
  }

  render(view: ViewState): void {
    const { ctx, camera } = this;

    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(0, 0, camera.viewportWidth, camera.viewportHeight);

    const zoom = snapZoom(camera.zoom);
    if (zoom !== this.bakedZoom) {
      this.terrain.clear();
      this.bakedZoom = zoom;
    }

    const bounds = camera.visibleBounds();

    // Terrain is baked at the snapped zoom, then scaled the last few percent to
    // the live zoom so pinching stays smooth without rebaking every frame.
    const correction = camera.zoom / zoom;
    ctx.save();
    ctx.translate(camera.viewportWidth / 2, camera.viewportHeight / 2);
    ctx.scale(correction, correction);
    ctx.translate(-camera.viewportWidth / 2, -camera.viewportHeight / 2);

    this.terrain.draw(
      ctx,
      zoom,
      bounds,
      (mapX) => (mapX - camera.x) * zoom + camera.viewportWidth / 2,
      (mapY) => (mapY - camera.y) * zoom + camera.viewportHeight / 2,
    );
    ctx.restore();

    // Survey marks go down first: they sit on the same points the frontier
    // does, and a border the player cannot see is far worse than a deposit
    // mark with a dot on it.
    this.drawDeposits(bounds);
    this.drawBorders(bounds);
    this.drawRoads(bounds);
    if (view.buildSpaceOverlay !== null) this.drawBuildSpaces(bounds, view);
    if (view.roadPreview) this.drawRoadPreview(view.roadPreview);

    this.collectSprites(bounds, view);
    this.flushSprites();

    this.drawGarrisons(bounds);
    if (view.selectedPoint >= 0) this.drawSelection(view.selectedPoint);
  }

  // ------------------------------------------------------------ map layers

  private screenX(point: number): number {
    return this.camera.mapToScreenX(pointX(this.simulation.world.grid, point));
  }

  private screenY(point: number): number {
    return this.camera.mapToScreenY(pointY(this.simulation.world, point));
  }

  private drawBorders(bounds: ReturnType<Camera['visibleBounds']>): void {
    const { ctx } = this;
    const world = this.simulation.world;
    const { grid } = world;

    ctx.lineWidth = 2;

    for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) {
        const point = grid.index(col, row);
        const owner = world.owner[point]!;
        if (owner === 0) continue;

        // A point is on the frontier when any neighbour belongs to somebody
        // else, which traces the border without storing it.
        let frontier = false;
        for (const direction of DIRECTIONS) {
          const neighbour = grid.neighbour(point, direction);
          if (neighbour === OUT_OF_BOUNDS || world.owner[neighbour] !== owner) {
            frontier = true;
            break;
          }
        }
        if (!frontier) continue;

        const colour = PLAYER_COLOURS[(owner - 1) % PLAYER_COLOURS.length]!;
        ctx.beginPath();
        ctx.arc(this.screenX(point), this.screenY(point), 2.4 * this.camera.zoom, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
      }
    }
  }

  /**
   * What the geologists have turned up.
   *
   * Only surveyed ground is marked, and only where something was actually
   * found — the map stays honest about what the player has been told, which is
   * the whole reason for sending a geologist in the first place.
   */
  private drawDeposits(bounds: ReturnType<Camera['visibleBounds']>): void {
    const { ctx, camera } = this;
    const world = this.simulation.world;
    const { grid } = world;

    for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) {
        const point = grid.index(col, row);
        if (!world.resourceKnown[point]) continue;

        // Surveyed and barren is worth saying: without a mark of its own the
        // player cannot tell ground that was dug and held nothing from ground
        // nobody has looked at.
        const barren = (world.resourceAmount[point] ?? 0) <= 0;
        const colour = barren ? BARREN_COLOUR : DEPOSIT_COLOURS[world.resource[point] as Resource];
        if (!colour) continue;

        const x = this.screenX(point);
        const y = this.screenY(point);
        const size = (barren ? 1.5 : 2.6) * camera.zoom;

        // A small diamond, which reads as a survey mark rather than as
        // something standing on the ground.
        ctx.beginPath();
        ctx.moveTo(x, y - size);
        ctx.lineTo(x + size, y);
        ctx.lineTo(x, y + size);
        ctx.lineTo(x - size, y);
        ctx.closePath();
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.strokeStyle = 'rgba(51, 38, 26, 0.55)';
        ctx.lineWidth = Math.max(0.5, 0.9 * camera.zoom);
        ctx.stroke();
      }
    }
  }

  private drawRoads(bounds: ReturnType<Camera['visibleBounds']>): void {
    const { ctx, camera } = this;
    const { grid } = this.simulation.world;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Every stretch goes into one path so the dark outline is laid down under
    // all of it at once; stroking road by road would let one road's outline
    // cut across its neighbour's surface at a junction.
    ctx.beginPath();

    this.simulation.roads.forEach((road) => {
      // Cheap rejection: skip roads whose ends are both off screen.
      const firstRow = grid.yOf(road.points[0]!);
      const lastRow = grid.yOf(road.points[road.points.length - 1]!);
      if (Math.max(firstRow, lastRow) < bounds.minRow) return;
      if (Math.min(firstRow, lastRow) > bounds.maxRow) return;

      ctx.moveTo(this.screenX(road.points[0]!), this.screenY(road.points[0]!));
      for (let i = 1; i < road.points.length; i += 1) {
        ctx.lineTo(this.screenX(road.points[i]!), this.screenY(road.points[i]!));
      }
    });

    // The step from a building's door to its own flag. The simulation keeps no
    // road there — it is implied by the building — but everyone who works the
    // place walks it, and leaving it undrawn made buildings read as detached
    // from the network they plainly belong to.
    this.simulation.buildings.forEach((building) => {
      const row = grid.yOf(building.point);
      if (row < bounds.minRow - 1 || row > bounds.maxRow + 1) return;

      ctx.moveTo(this.screenX(building.point), this.screenY(building.point));
      ctx.lineTo(this.screenX(building.flagPoint), this.screenY(building.flagPoint));
    });

    ctx.strokeStyle = 'rgba(51, 38, 26, 0.5)';
    ctx.lineWidth = 7 * camera.zoom;
    ctx.stroke();

    ctx.strokeStyle = '#c8ab72';
    ctx.lineWidth = 4.5 * camera.zoom;
    ctx.stroke();
  }

  private drawBuildSpaces(bounds: ReturnType<Camera['visibleBounds']>, view: ViewState): void {
    const { ctx, camera } = this;
    const { grid } = this.simulation.world;
    const type = view.buildSpaceOverlay as BuildingType;
    const info = buildingInfo(type);
    const outpost = info.behaviour.kind === 'military';

    for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) {
        const point = grid.index(col, row);
        const space = evaluateBuildSpace(this.simulation.world, point, view.playerId);
        if (space === BuildSpace.None) continue;

        const fits =
          canHostSize(space, info.size) &&
          (!outpost || canPlaceOutpost(this.simulation.world, point, view.playerId));
        const x = this.screenX(point);
        const y = this.screenY(point);
        const radius = (fits ? 5 : 3) * camera.zoom;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fits ? 'rgba(74, 107, 50, 0.85)' : 'rgba(51, 38, 26, 0.28)';
        ctx.fill();

        if (fits) {
          ctx.strokeStyle = PALETTE.parchment;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }
    }
  }

  /**
   * A row of pips over every military building, one for each man holding it.
   *
   * A barracks claims no ground until somebody is standing in it, so "manned"
   * and "empty" are the difference between a frontier and a shed, and the
   * player has to be able to tell them apart without opening a panel. Drawn
   * after the sprites so the pips are never buried by the roof in front.
   */
  private drawGarrisons(bounds: ReturnType<Camera['visibleBounds']>): void {
    const { ctx, camera } = this;
    const { grid } = this.simulation.world;
    const radius = Math.max(1.2, 2 * camera.zoom);
    const gap = radius * 2.6;

    this.simulation.buildings.forEach((building) => {
      if (building.state !== BuildingState.Complete) return;
      if (buildingInfo(building.type).behaviour.kind !== 'military') return;

      const row = grid.yOf(building.point);
      if (row < bounds.minRow - 3 || row > bounds.maxRow + 3) return;

      const wanted = garrisonPlaces(building.type);
      const held = garrisonStrength(building.garrison);
      if (wanted <= 0) return;

      const x = this.screenX(building.point);
      const y = this.screenY(building.point) - 26 * camera.zoom;
      const left = x - ((wanted - 1) * gap) / 2;
      const colour = PLAYER_COLOURS[(building.owner - 1) % PLAYER_COLOURS.length]!;

      for (let i = 0; i < wanted; i += 1) {
        ctx.beginPath();
        ctx.arc(left + i * gap, y, radius, 0, Math.PI * 2);
        // A filled pip is a man; an outline is a place still to be filled.
        if (i < held) {
          ctx.fillStyle = colour;
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(20, 16, 12, 0.55)';
          ctx.lineWidth = Math.max(0.6, camera.zoom * 0.5);
          ctx.stroke();
        }
      }
    });
  }

  private drawRoadPreview(points: readonly number[]): void {
    const { ctx, camera } = this;
    if (points.length < 2) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.screenX(points[0]!), this.screenY(points[0]!));
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(this.screenX(points[i]!), this.screenY(points[i]!));
    }
    ctx.setLineDash([6 * camera.zoom, 5 * camera.zoom]);
    ctx.strokeStyle = PALETTE.parchment;
    ctx.lineWidth = 3.5 * camera.zoom;
    ctx.stroke();
    ctx.restore();
  }

  private drawSelection(point: number): void {
    const { ctx, camera } = this;
    ctx.beginPath();
    ctx.arc(this.screenX(point), this.screenY(point), 9 * camera.zoom, 0, Math.PI * 2);
    ctx.strokeStyle = PALETTE.parchment;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // -------------------------------------------------------------- sprites

  private add(sprite: Sprite, mapX: number, mapY: number, depth: number, alpha = 1): void {
    let entry = this.pool[this.used];
    if (!entry) {
      entry = { depth: 0, sprite, x: 0, y: 0, alpha: 1 };
      this.pool[this.used] = entry;
    }

    entry.depth = depth;
    entry.sprite = sprite;
    entry.x = mapX;
    entry.y = mapY;
    entry.alpha = alpha;
    this.used += 1;
  }

  private collectSprites(bounds: ReturnType<Camera['visibleBounds']>, view: ViewState): void {
    const simulation = this.simulation;
    const world = simulation.world;
    const { grid } = world;

    this.used = 0;

    // Trees, stone and scrub standing on the visible ground.
    for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
      for (let col = bounds.minCol; col <= bounds.maxCol; col += 1) {
        const point = grid.index(col, row);
        const object = world.object[point]!;
        if (object === MapObject.None) continue;

        const data = world.objectData[point]!;
        let sprite: Sprite | undefined;

        if (object === MapObject.Tree) {
          sprite = this.sprites.trees[Math.min(this.sprites.trees.length - 1, data)];
        } else if (object === MapObject.Stone) {
          const level = data >= 5 ? 2 : data >= 3 ? 1 : 0;
          sprite = this.sprites.stones[level];
        } else if (object === MapObject.Field) {
          sprite = this.sprites.fields[Math.min(this.sprites.fields.length - 1, data)];
        } else if (object === MapObject.Decoration) {
          sprite = this.sprites.decorations[data % this.sprites.decorations.length];
        }

        if (sprite) this.add(sprite, this.screenX(point), this.screenY(point), depthOf(grid, point));
      }
    }

    simulation.buildings.forEach((building) => {
      const row = grid.yOf(building.point);
      if (row < bounds.minRow - 3 || row > bounds.maxRow + 3) return;

      const info = buildingInfo(building.type);
      const sprite =
        building.state === BuildingState.UnderConstruction
          ? this.sprites.sites.get(info.size)
          : this.sprites.buildings.get(building.type);

      if (sprite) {
        this.add(
          sprite,
          this.screenX(building.point),
          this.screenY(building.point),
          depthOf(grid, building.point),
        );
      }
    });

    simulation.flags.forEach((flag) => {
      const row = grid.yOf(flag.point);
      if (row < bounds.minRow - 2 || row > bounds.maxRow + 2) return;

      const colour = PLAYER_COLOURS[(flag.owner - 1) % PLAYER_COLOURS.length]!;
      const sprite = this.sprites.flags.get(colour);
      const x = this.screenX(flag.point);
      const y = this.screenY(flag.point);
      const depth = depthOf(grid, flag.point);

      if (sprite) this.add(sprite, x, y, depth);

      // Wares waiting for a carrier, stacked beside the pole.
      for (let i = 0; i < flag.wares.length; i += 1) {
        const crate = this.sprites.crate(wareInfo(flag.wares[i]!.ware).colour);
        const column = i % 4;
        const tier = Math.floor(i / 4);
        this.add(
          crate,
          x + (5 + column * 5) * this.camera.zoom,
          y - (2 + tier * 6) * this.camera.zoom,
          depth + 1,
        );
      }
    });

    simulation.settlers.forEach((settler) => {
      // Settlers inside a building are not drawn; the building stands for them.
      // A soldier waiting his turn at the door is inside it too — he appears
      // when he steps out, one man at a time.
      if (
        settler.state === SettlerState.AtWork ||
        settler.state === SettlerState.Idle ||
        settler.state === SettlerState.Mustering
      ) {
        return;
      }

      const row = grid.yOf(settler.point);
      if (row < bounds.minRow - 2 || row > bounds.maxRow + 2) return;

      const t = simulation.stepFraction(settler, view.alpha);
      const fromX = this.screenX(settler.fromPoint);
      const fromY = this.screenY(settler.fromPoint);
      const toX = this.screenX(settler.toPoint);
      const toY = this.screenY(settler.toPoint);
      const x = fromX + (toX - fromX) * t;
      const y = fromY + (toY - fromY) * t;

      const colour = PLAYER_COLOURS[(settler.owner - 1) % PLAYER_COLOURS.length]!;
      const sprite = this.sprites.settlers.get(colour);
      const depth = depthOf(grid, settler.toPoint);

      if (sprite) this.add(sprite, x, y, depth);

      if (settler.carrying !== null) {
        const crate = this.sprites.crate(wareInfo(settler.carrying).colour);
        this.add(crate, x, y - 20 * this.camera.zoom, depth + 1);
      }
    });

    if (view.buildPreview) {
      const preview = view.buildPreview;
      const sprite = this.sprites.buildings.get(preview.type);
      if (sprite) {
        this.add(
          sprite,
          this.screenX(preview.point),
          this.screenY(preview.point),
          depthOf(grid, preview.point),
          0.6,
        );
      }
    }
  }

  private flushSprites(): void {
    const { ctx, camera } = this;

    this.order.length = this.used;
    for (let i = 0; i < this.used; i += 1) this.order[i] = i;
    this.order.sort((a, b) => this.pool[a]!.depth - this.pool[b]!.depth);

    for (let i = 0; i < this.used; i += 1) {
      const entry = this.pool[this.order[i]!]!;
      const sprite = entry.sprite;

      const width = sprite.width * camera.zoom;
      const height = sprite.height * camera.zoom;
      const x = entry.x - width * sprite.anchorX;
      const y = entry.y - height * sprite.anchorY;

      // Skip anything that ended up off screen after projection.
      if (x + width < 0 || y + height < 0) continue;
      if (x > camera.viewportWidth || y > camera.viewportHeight) continue;

      if (entry.alpha !== 1) {
        ctx.globalAlpha = entry.alpha;
        ctx.drawImage(sprite.canvas, x, y, width, height);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(sprite.canvas, x, y, width, height);
      }
    }
  }
}
