import type { BuildingInfo, BuildingType } from '../sim/data/buildings';
import { AVAILABLE_BUILDINGS, buildingInfo } from '../sim/data/buildings';
import { Ware, wareInfo } from '../sim/data/wares';
import type { Building } from '../sim/entities/types';
import { BuildingState, BuildingStatus } from '../sim/entities/types';
import type { Simulation } from '../sim/simulation';
import { BuildSpace, canHostSize, evaluateBuildSpace } from '../sim/world/buildspace';
import { button, clear, el } from './dom';

/** Wares shown permanently in the top bar. */
const TRACKED_WARES: readonly Ware[] = [Ware.Board, Ware.Stone, Ware.Log, Ware.Fish];

const STATUS_TEXT: Readonly<Record<BuildingStatus, string>> = {
  [BuildingStatus.Working]: 'Working',
  [BuildingStatus.AwaitingWorker]: 'Waiting for a worker',
  [BuildingStatus.AwaitingMaterials]: 'Waiting for materials',
  [BuildingStatus.Exhausted]: 'Nothing left within reach',
  [BuildingStatus.Blocked]: 'The flag outside is full',
  [BuildingStatus.UnderConstruction]: 'Under construction',
  [BuildingStatus.Unreachable]: 'No road connects this to your network',
};

export interface HudCallbacks {
  chooseBuilding(type: BuildingType): void;
  cancelMode(): void;
  demolishBuilding(point: number): void;
  demolishFlag(point: number): void;
  startRoad(flagPoint: number): void;
  placeFlag(point: number): void;
  setSpeed(speed: number): void;
  save(): void;
  exportSave(): void;
  importSave(file: File): void;
  quitToTitle(): void;
}

export interface HudState {
  readonly selectedPoint: number;
  readonly pendingBuilding: BuildingType | null;
  readonly roadFrom: number | null;
  readonly speed: number;
  readonly notice: string | null;
}

/**
 * The heads-up display: stock at the top, actions at the bottom, and a panel
 * describing whatever is selected.
 *
 * Laid out for a phone held in one hand — the controls that get used most sit
 * within reach of a thumb, and every target is finger-sized.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly simulation: Simulation;
  private readonly playerId: number;
  private readonly callbacks: HudCallbacks;

  private readonly stats: HTMLElement;
  private readonly ticker: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly buildMenu: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly fileInput: HTMLInputElement;

  private buildMenuOpen = false;
  private menuOpen = false;
  private lastEventCount = 0;
  private state: HudState = {
    selectedPoint: -1,
    pendingBuilding: null,
    roadFrom: null,
    speed: 1,
    notice: null,
  };

  constructor(
    root: HTMLElement,
    simulation: Simulation,
    playerId: number,
    callbacks: HudCallbacks,
  ) {
    this.root = root;
    this.simulation = simulation;
    this.playerId = playerId;
    this.callbacks = callbacks;

    this.stats = el('div', { class: 'hud__stats' });
    this.ticker = el('div', { class: 'hud__ticker', 'aria-live': 'polite' });
    this.panel = el('aside', { class: 'panel', hidden: true });
    this.buildMenu = el('div', { class: 'buildmenu', hidden: true });
    this.actions = el('div', { class: 'hud__actions' });
    this.menu = el('div', { class: 'gamemenu', hidden: true });

    this.fileInput = el('input', { type: 'file', accept: '.bwsave,application/gzip', hidden: true });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) this.callbacks.importSave(file);
      this.fileInput.value = '';
    });

    root.append(
      el(
        'header',
        { class: 'hud__bar' },
        this.stats,
        button('Menu', 'hud__menubutton', () => this.toggleMenu()),
      ),
      this.ticker,
      this.panel,
      this.buildMenu,
      this.menu,
      this.actions,
      this.fileInput,
    );

    this.renderActions();
    this.renderBuildMenu();
    this.renderMenu();
  }

  /** Called every frame; keeps DOM writes to what has actually changed. */
  update(state: HudState): void {
    // The mode drives both the panel and whether Cancel is offered, so it has
    // to invalidate the action bar as well as the panel.
    const modeChanged =
      state.pendingBuilding !== this.state.pendingBuilding || state.roadFrom !== this.state.roadFrom;
    const selectionChanged = modeChanged || state.selectedPoint !== this.state.selectedPoint;
    const speedChanged = state.speed !== this.state.speed;
    const noticeChanged = state.notice !== this.state.notice;

    this.state = state;

    this.renderStats();
    if (selectionChanged) this.renderPanel();
    if (speedChanged || modeChanged) this.renderActions();
    if (noticeChanged || this.simulation.events.length !== this.lastEventCount) {
      this.lastEventCount = this.simulation.events.length;
      this.renderTicker();
    }
  }

  destroy(): void {
    clear(this.root);
  }

  // -------------------------------------------------------------- sections

  private renderStats(): void {
    clear(this.stats);

    for (const ware of TRACKED_WARES) {
      const info = wareInfo(ware);
      this.stats.append(
        el(
          'span',
          { class: 'chip', title: info.name },
          el('span', { class: 'chip__swatch', style: `background:${info.colour}` }),
          el('span', { class: 'chip__value' }, String(this.simulation.storedWare(this.playerId, ware))),
        ),
      );
    }

    this.stats.append(
      el(
        'span',
        { class: 'chip', title: 'Settlers' },
        el('span', { class: 'chip__label' }, 'Pop'),
        el('span', { class: 'chip__value' }, String(this.simulation.population(this.playerId))),
      ),
    );
  }

  private renderTicker(): void {
    const message = this.state.notice ?? this.simulation.events[this.simulation.events.length - 1];
    this.ticker.textContent = message ?? '';
    this.ticker.classList.toggle('hud__ticker--warning', this.state.notice !== null);
  }

  private renderActions(): void {
    clear(this.actions);

    const speed = this.state.speed;
    const speedLabel = speed === 0 ? 'Paused' : `${speed}×`;

    this.actions.append(
      button(this.buildMenuOpen ? 'Close' : 'Build', 'action action--primary', () =>
        this.toggleBuildMenu(),
      ),
      button(speedLabel, 'action', () => {
        // Cycles pause, normal, fast — the three speeds anybody actually uses.
        const next = speed === 0 ? 1 : speed === 1 ? 3 : 0;
        this.callbacks.setSpeed(next);
      }),
    );

    if (this.state.pendingBuilding !== null || this.state.roadFrom !== null) {
      this.actions.append(
        button('Cancel', 'action action--cancel', () => this.callbacks.cancelMode()),
      );
    }
  }

  private renderBuildMenu(): void {
    clear(this.buildMenu);
    this.buildMenu.append(el('h2', { class: 'buildmenu__title' }, 'Build'));

    const grid = el('div', { class: 'buildmenu__grid' });

    for (const info of AVAILABLE_BUILDINGS) {
      const cost = info.cost
        .map((item) => `${item.count} ${wareInfo(item.ware).name.toLowerCase()}`)
        .join(', ');

      const card = el(
        'button',
        { class: 'card', type: 'button' },
        el('span', { class: 'card__name' }, info.name),
        el('span', { class: 'card__cost' }, cost || 'no materials'),
        el('span', { class: 'card__note' }, info.description),
      );

      card.addEventListener('click', (event) => {
        event.preventDefault();
        this.buildMenuOpen = false;
        this.buildMenu.hidden = true;
        this.renderActions();
        this.callbacks.chooseBuilding(info.id);
      });

      grid.append(card);
    }

    this.buildMenu.append(grid);
  }

  private renderMenu(): void {
    clear(this.menu);
    this.menu.append(
      el('h2', { class: 'gamemenu__title' }, 'Bailiwick'),
      button('Save game', 'gamemenu__item', () => {
        this.closeMenu();
        this.callbacks.save();
      }),
      button('Export save to a file', 'gamemenu__item', () => {
        this.closeMenu();
        this.callbacks.exportSave();
      }),
      button('Import a save file', 'gamemenu__item', () => {
        this.closeMenu();
        this.fileInput.click();
      }),
      button('Quit to title', 'gamemenu__item gamemenu__item--quit', () => {
        this.closeMenu();
        this.callbacks.quitToTitle();
      }),
      button('Close', 'gamemenu__item', () => this.closeMenu()),
    );
  }

  private renderPanel(): void {
    const point = this.state.selectedPoint;

    if (this.state.pendingBuilding !== null) {
      this.showPlacementHelp(buildingInfo(this.state.pendingBuilding));
      return;
    }

    if (this.state.roadFrom !== null) {
      this.showPanel([
        el('h2', { class: 'panel__title' }, 'Lay a road'),
        el('p', { class: 'panel__note' }, 'Drag to where the road should end, then let go.'),
      ]);
      return;
    }

    if (point < 0) {
      this.panel.hidden = true;
      return;
    }

    const world = this.simulation.world;
    const buildingId = world.building[point];
    if (buildingId) {
      this.showBuildingPanel(this.simulation.buildings.require(buildingId));
      return;
    }

    const flagId = world.flag[point];
    if (flagId) {
      this.showFlagPanel(point, flagId);
      return;
    }

    this.showGroundPanel(point);
  }

  private showPanel(children: HTMLElement[]): void {
    clear(this.panel);
    for (const child of children) this.panel.append(child);
    this.panel.hidden = false;
  }

  private showPlacementHelp(info: BuildingInfo): void {
    this.showPanel([
      el('h2', { class: 'panel__title' }, `Place the ${info.name.toLowerCase()}`),
      el('p', { class: 'panel__note' }, 'Green markers show where it will fit. Tap one to build.'),
    ]);
  }

  private showBuildingPanel(building: Building): void {
    const info = buildingInfo(building.type);
    const children: HTMLElement[] = [
      el('h2', { class: 'panel__title' }, info.name),
      el('p', { class: 'panel__status' }, STATUS_TEXT[building.status]),
    ];

    if (building.state === BuildingState.UnderConstruction) {
      const materials = info.cost.map((item, index) =>
        el(
          'li',
          {},
          `${wareInfo(item.ware).name}: ${building.delivered[index] ?? 0} of ${item.count}`,
        ),
      );
      children.push(el('ul', { class: 'panel__list' }, ...materials));

      const progress = Math.round((building.buildProgress / Math.max(1, info.buildTicks)) * 100);
      children.push(el('p', { class: 'panel__note' }, `Built: ${progress}%`));
    } else if (info.behaviour.kind === 'craft') {
      const inputs = info.behaviour.inputs.map((item, index) =>
        el('li', {}, `${wareInfo(item.ware).name}: ${building.inputs[index] ?? 0}`),
      );
      children.push(el('ul', { class: 'panel__list' }, ...inputs));
    } else if (info.behaviour.kind === 'headquarters' || info.behaviour.kind === 'store') {
      const held = building.stock
        .map((count, ware) => ({ count, ware: ware as Ware }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map((entry) => el('li', {}, `${wareInfo(entry.ware).name}: ${entry.count}`));
      children.push(el('ul', { class: 'panel__list' }, ...held));
      children.push(el('p', { class: 'panel__note' }, `Settlers waiting: ${building.reserve}`));
    }

    if (info.behaviour.kind !== 'headquarters') {
      children.push(
        button('Demolish', 'panel__action panel__action--danger', () =>
          this.callbacks.demolishBuilding(building.point),
        ),
      );
    }

    this.showPanel(children);
  }

  private showFlagPanel(point: number, flagId: number): void {
    const flag = this.simulation.flags.require(flagId);

    const waiting =
      flag.wares.length === 0
        ? 'Nothing waiting here.'
        : flag.wares.map((parcel) => wareInfo(parcel.ware).name).join(', ');

    const children: HTMLElement[] = [
      el('h2', { class: 'panel__title' }, 'Flag'),
      el('p', { class: 'panel__status' }, waiting),
      button('Lay a road from here', 'panel__action', () => this.callbacks.startRoad(point)),
    ];

    if (flag.building === 0) {
      children.push(
        button('Remove flag', 'panel__action panel__action--danger', () =>
          this.callbacks.demolishFlag(point),
        ),
      );
    }

    this.showPanel(children);
  }

  private showGroundPanel(point: number): void {
    const space = evaluateBuildSpace(this.simulation.world, point, this.playerId);

    if (space === BuildSpace.None) {
      this.showPanel([
        el('h2', { class: 'panel__title' }, 'Open ground'),
        el('p', { class: 'panel__note' }, 'Nothing can be built here.'),
      ]);
      return;
    }

    const fits = AVAILABLE_BUILDINGS.filter((info) => canHostSize(space, info.size));

    const children: HTMLElement[] = [
      el('h2', { class: 'panel__title' }, 'Open ground'),
      button('Place a flag', 'panel__action', () => this.callbacks.placeFlag(point)),
    ];

    if (fits.length > 0) {
      children.push(
        el('p', { class: 'panel__note' }, `Room for: ${fits.map((info) => info.name).join(', ')}`),
      );
    }

    this.showPanel(children);
  }

  // --------------------------------------------------------------- toggles

  toggleBuildMenu(): void {
    this.buildMenuOpen = !this.buildMenuOpen;
    this.buildMenu.hidden = !this.buildMenuOpen;
    if (this.buildMenuOpen) this.closeMenu();
    this.renderActions();
  }

  private toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
    this.menu.hidden = !this.menuOpen;
    if (this.menuOpen) {
      this.buildMenuOpen = false;
      this.buildMenu.hidden = true;
      this.renderActions();
    }
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.menu.hidden = true;
  }
}
