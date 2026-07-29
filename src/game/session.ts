import { CanvasRenderer } from '../render/canvas2d/renderer';
import type { ViewState } from '../render/renderer';
import { encodeSave, exportSave, importSave, loadSimulation } from '../platform/save';
import { AUTOSAVE_ID, putSave } from '../platform/storage';
import type { BuildingType } from '../sim/data/buildings';
import type { Simulation } from '../sim/simulation';
import { TICKS_PER_SECOND } from '../sim/simulation';
import { planRoad } from '../sim/transport/pathfinding';
import { el } from '../ui/dom';
import { Hud } from '../ui/hud';
import { attachGestures } from '../ui/input/gestures';
import { BASE_SPEED, GameLoop } from './loop';

/** How the next tap on the map will be interpreted. */
type Mode =
  | { readonly kind: 'view' }
  | { readonly kind: 'build'; readonly type: BuildingType }
  | { readonly kind: 'road'; readonly from: number };

/**
 * Ticks between automatic saves — about every two minutes of real time.
 *
 * Measured against the pace the game actually runs at, so changing that pace
 * does not quietly change how often the player's progress is kept.
 */
const AUTOSAVE_INTERVAL = Math.round(TICKS_PER_SECOND * BASE_SPEED * 120);

/** How long a message stays in the ticker, in frames at 60fps. */
const NOTICE_FRAMES = 240;

/**
 * One running game: the simulation, the view onto it, and the controls.
 *
 * Everything stateful about playing — what is selected, what is about to be
 * built, how fast time is running — lives here, so the renderer stays a pure
 * function of the world and the HUD stays a view of it.
 */
export class GameSession {
  private readonly root: HTMLElement;
  private readonly simulation: Simulation;
  private readonly playerId: number;
  private readonly onQuit: () => void;

  private readonly canvas: HTMLCanvasElement;
  private readonly hudRoot: HTMLElement;
  private readonly renderer: CanvasRenderer;
  private readonly hud: Hud;
  private readonly loop: GameLoop;
  private readonly detachGestures: () => void;
  private readonly resizeObserver: ResizeObserver;

  private mode: Mode = { kind: 'view' };
  private selectedPoint = -1;
  private hoverPoint = -1;
  private roadPreview: number[] | null = null;
  private notice: string | null = null;
  private noticeFrames = 0;
  private autosaving = false;

  constructor(root: HTMLElement, simulation: Simulation, playerId: number, onQuit: () => void) {
    this.root = root;
    this.simulation = simulation;
    this.playerId = playerId;
    this.onQuit = onQuit;

    this.canvas = el('canvas', { class: 'map' });
    this.hudRoot = el('div', { class: 'hud' });
    root.append(this.canvas, this.hudRoot);

    this.renderer = new CanvasRenderer(this.canvas, simulation);

    const headquarters = simulation.buildings.get(
      simulation.players.find((player) => player.id === playerId)?.headquarters ?? 0,
    );
    if (headquarters) this.renderer.camera.centreOn(headquarters.point);

    this.hud = new Hud(this.hudRoot, simulation, playerId, {
      chooseBuilding: (type) => this.beginBuild(type),
      cancelMode: () => this.cancel(),
      demolishBuilding: (point) => this.run(() => simulation.demolishBuilding(playerId, point)),
      demolishFlag: (point) => this.run(() => simulation.demolishFlag(playerId, point)),
      demolishRoad: (point) => this.run(() => simulation.demolishRoad(playerId, point)),
      startRoad: (point) => {
        this.mode = { kind: 'road', from: point };
        this.roadPreview = null;
      },
      placeFlag: (point) => this.run(() => simulation.placeFlag(playerId, point)),
      sendGeologist: (point) => this.run(() => simulation.sendGeologist(playerId, point)),
      centreOn: (point) => {
        this.renderer.camera.centreOn(point);
        this.selectedPoint = point;
      },
      setSpeed: (speed) => this.loop.setSpeed(speed),
      save: () => void this.save('Manual save'),
      exportSave: () => void this.exportToFile(),
      importSave: (file) => void this.importFromFile(file),
      quitToTitle: () => this.onQuit(),
      saveAndQuit: () => void this.saveAndQuit(),
    });

    this.loop = new GameLoop(
      () => this.step(),
      (alpha) => this.draw(alpha),
    );

    this.detachGestures = attachGestures(this.canvas, {
      onTap: (x, y) => this.handleTap(x, y),
      onLongPress: () => this.hud.toggleBuildMenu(),
      onDragStart: (x, y) => this.handleDragStart(x, y),
      onDrag: (x, y, dx, dy) => this.handleDrag(x, y, dx, dy),
      onDragEnd: (x, y) => this.handleDragEnd(x, y),
      onZoom: (factor, x, y) => this.renderer.camera.zoomAt(factor, x, y),
      onHover: (x, y) => {
        this.hoverPoint = this.renderer.camera.pickPoint(x, y);
      },
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.resize();
  }

  start(): void {
    this.loop.start();
  }

  destroy(): void {
    this.loop.stop();
    this.detachGestures();
    this.resizeObserver.disconnect();
    this.renderer.destroy();
    this.hud.destroy();
    this.canvas.remove();
    this.hudRoot.remove();
  }

  // ------------------------------------------------------------ the frame

  private resize(): void {
    const bounds = this.root.getBoundingClientRect();
    this.renderer.resize(bounds.width, bounds.height, window.devicePixelRatio || 1);
  }

  private step(): void {
    this.simulation.update();

    if (this.simulation.tick % AUTOSAVE_INTERVAL === 0) void this.autosave();
  }

  private draw(alpha: number): void {
    if (this.noticeFrames > 0) {
      this.noticeFrames -= 1;
      if (this.noticeFrames === 0) this.notice = null;
    }

    const view: ViewState = {
      playerId: this.playerId,
      selectedPoint: this.selectedPoint,
      buildPreview: this.buildPreview(),
      roadPreview: this.roadPreview,
      buildSpaceOverlay: this.mode.kind === 'build' ? this.mode.type : null,
      alpha,
    };

    this.renderer.render(view);

    this.hud.update({
      selectedPoint: this.selectedPoint,
      pendingBuilding: this.mode.kind === 'build' ? this.mode.type : null,
      roadFrom: this.mode.kind === 'road' ? this.mode.from : null,
      speed: this.loop.getSpeed(),
      notice: this.notice,
    });
  }

  private buildPreview(): { point: number; type: BuildingType } | null {
    if (this.mode.kind !== 'build') return null;
    const point = this.hoverPoint >= 0 ? this.hoverPoint : this.selectedPoint;
    if (point < 0) return null;
    return { point, type: this.mode.type };
  }

  // -------------------------------------------------------------- controls

  private beginBuild(type: BuildingType): void {
    this.mode = { kind: 'build', type };
    this.roadPreview = null;
  }

  private cancel(): void {
    this.mode = { kind: 'view' };
    this.roadPreview = null;
  }

  private handleTap(x: number, y: number): void {
    const point = this.renderer.camera.pickPoint(x, y);
    if (point < 0) return;

    if (this.mode.kind === 'build') {
      const type = this.mode.type;
      this.run(() => this.simulation.placeBuilding(this.playerId, point, type), () => {
        this.selectedPoint = point;
        this.cancel();
      });
      return;
    }

    if (this.mode.kind === 'road') {
      this.commitRoad(point);
      return;
    }

    this.selectedPoint = point;
  }

  private handleDragStart(x: number, y: number): void {
    if (this.mode.kind !== 'road') return;
    this.updateRoadPreview(x, y);
  }

  private handleDrag(x: number, y: number, dx: number, dy: number): void {
    if (this.mode.kind === 'road') {
      this.updateRoadPreview(x, y);
      return;
    }
    this.renderer.camera.panBy(dx, dy);
  }

  private handleDragEnd(x: number, y: number): void {
    if (this.mode.kind !== 'road') return;

    const point = this.renderer.camera.pickPoint(x, y);
    if (point >= 0) this.commitRoad(point);
    this.roadPreview = null;
  }

  private updateRoadPreview(x: number, y: number): void {
    if (this.mode.kind !== 'road') return;
    const point = this.renderer.camera.pickPoint(x, y);
    this.roadPreview =
      point >= 0 ? (planRoad(this.simulation.world, this.mode.from, point, this.playerId) ?? null) : null;
  }

  private commitRoad(to: number): void {
    if (this.mode.kind !== 'road') return;

    const route = planRoad(this.simulation.world, this.mode.from, to, this.playerId);
    if (!route) {
      this.showNotice('No road can run there.');
      return;
    }

    this.run(
      () => this.simulation.placeRoad(this.playerId, route),
      () => {
        this.selectedPoint = to;
        this.cancel();
      },
    );
  }

  /** Runs a command and surfaces its refusal, if any, in the ticker. */
  private run(command: () => { ok: boolean; reason?: string }, onSuccess?: () => void): void {
    const result = command();
    if (result.ok) {
      onSuccess?.();
      return;
    }
    this.showNotice(result.reason ?? 'That cannot be done.');
  }

  private showNotice(message: string): void {
    this.notice = message;
    this.noticeFrames = NOTICE_FRAMES;
  }

  // ----------------------------------------------------------------- saves

  private async save(name: string): Promise<boolean> {
    try {
      const bytes = await encodeSave(this.simulation, name);
      await putSave(`slot-${Date.now()}`, { name, savedAt: Date.now(), tick: this.simulation.tick }, bytes);
      this.showNotice('Game saved.');
      return true;
    } catch (error) {
      this.showNotice(`Could not save: ${describe(error)}`);
      return false;
    }
  }

  /**
   * Writes an ordinary save and only then leaves.
   *
   * The ordering is the point: a save that failed must not take the game down
   * with it, or the player loses the province *and* the chance to try again.
   */
  private async saveAndQuit(): Promise<void> {
    if (await this.save('Saved on quitting')) this.onQuit();
  }

  private async autosave(): Promise<void> {
    // Saving is asynchronous and the loop keeps running; skipping an overlapping
    // autosave is better than queueing them up behind a slow disk.
    if (this.autosaving) return;
    this.autosaving = true;

    try {
      const bytes = await encodeSave(this.simulation, 'Autosave');
      await putSave(
        AUTOSAVE_ID,
        { name: 'Autosave', savedAt: Date.now(), tick: this.simulation.tick },
        bytes,
      );
    } catch {
      // An autosave that fails should never interrupt play.
    } finally {
      this.autosaving = false;
    }
  }

  private async exportToFile(): Promise<void> {
    try {
      const bytes = await encodeSave(this.simulation, 'Bailiwick');
      exportSave(bytes, `bailiwick-${this.simulation.tick}`);
      this.showNotice('Save exported.');
    } catch (error) {
      this.showNotice(`Could not export: ${describe(error)}`);
    }
  }

  private async importFromFile(file: File): Promise<void> {
    try {
      const bytes = await importSave(file);
      const restored = await loadSimulation(bytes);
      this.replaceWith(restored);
    } catch (error) {
      this.showNotice(`Could not load that file: ${describe(error)}`);
    }
  }

  /** Swaps in a loaded game by restarting the session around it. */
  private replaceWith(simulation: Simulation): void {
    const root = this.root;
    const onQuit = this.onQuit;
    const playerId = this.playerId;

    this.destroy();

    const session = new GameSession(root, simulation, playerId, onQuit);
    session.start();
    currentSession = session;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session currently on screen.
 *
 * Loading a save rebuilds the session around the new world, so the bootstrap
 * needs a way to find whichever one is live.
 */
export let currentSession: GameSession | null = null;

export function setCurrentSession(session: GameSession | null): void {
  currentSession = session;
}
