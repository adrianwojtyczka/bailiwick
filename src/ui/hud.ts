import type { BuildingInfo, BuildingType } from '../sim/data/buildings';
import { AVAILABLE_BUILDINGS, buildingInfo, CATEGORY_ORDER } from '../sim/data/buildings';
import type { Ware } from '../sim/data/wares';
import { wareInfo } from '../sim/data/wares';
import type { Building } from '../sim/entities/types';
import { BuildingState, BuildingStatus } from '../sim/entities/types';
import type { Simulation } from '../sim/simulation';
import { TICKS_PER_SECOND } from '../sim/simulation';
import { OUT_OF_BOUNDS } from '../sim/core/grid';
import { garrisonStrength, rankName, TOP_RANK } from '../sim/data/ranks';
import { BuildSpace, evaluateBuildSpace } from '../sim/world/buildspace';
import {
  FIELD_FULLY_GROWN,
  MapObject,
  Resource,
  RESOURCE_NAMES,
  TREE_FULLY_GROWN,
  terrainOf,
} from '../sim/world/terrain';
import { button, clear, el } from './dom';

const STATUS_TEXT: Readonly<Record<BuildingStatus, string>> = {
  [BuildingStatus.Working]: 'Working',
  [BuildingStatus.AwaitingWorker]: 'Waiting for a worker',
  [BuildingStatus.AwaitingMaterials]: 'Waiting for materials',
  [BuildingStatus.Exhausted]: 'Nothing left within reach',
  [BuildingStatus.Blocked]: 'The flag outside is full',
  [BuildingStatus.UnderConstruction]: 'Under construction',
  [BuildingStatus.Unreachable]: 'No road connects this to your network',
  [BuildingStatus.Unmanned]: 'Waiting for soldiers',
};

/**
 * A short summary of everything the panel shows about a point.
 *
 * The panel reads the simulation live, so it goes stale the moment the world
 * under the selected node changes — place a flag and the ground panel would go
 * on offering to place one. Re-rendering every frame would rebuild the buttons
 * sixty times a second under the player's thumb, so instead this is compared
 * against last frame's and the panel is rebuilt only when it has really moved.
 *
 * A handful of typed-array reads per frame, and no more lying.
 */
export function panelSignature(simulation: Simulation, point: number): string {
  if (point < 0) return '';

  const world = simulation.world;
  const parts = [
    point,
    world.building[point] ?? 0,
    world.flag[point] ?? 0,
    world.roadCount(point),
    world.object[point] ?? 0,
    world.objectData[point] ?? 0,
    world.resourceKnown[point] ?? 0,
    world.resource[point] ?? 0,
    world.resourceAmount[point] ?? 0,
  ];

  const buildingId = world.building[point];
  const building = buildingId ? simulation.buildings.get(buildingId) : undefined;
  if (building) {
    parts.push(
      building.owner,
      building.state,
      building.status,
      building.buildProgress,
      building.reserve,
      ...building.garrison,
      ...building.delivered,
      ...building.inputs,
      ...building.stock,
    );
  }

  const flagId = world.flag[point];
  const flag = flagId ? simulation.flags.get(flagId) : undefined;
  if (flag) {
    parts.push(flag.building, flag.wares.length, ...flag.wares.map((parcel) => parcel.ware));
  }

  return parts.join(',');
}

/**
 * A garrison written out rank by rank, strongest first, leaving out the ranks
 * nobody holds. Five lines of zeroes tell the player nothing.
 */
function rankList(garrison: readonly number[]): HTMLElement[] {
  const lines: HTMLElement[] = [];
  for (let rank = garrison.length - 1; rank >= 0; rank -= 1) {
    const count = garrison[rank] ?? 0;
    if (count > 0) lines.push(el('li', {}, `${rankName(rank)}: ${count}`));
  }
  return lines;
}

export interface HudCallbacks {
  chooseBuilding(type: BuildingType): void;
  cancelMode(): void;
  demolishBuilding(point: number): void;
  demolishFlag(point: number): void;
  demolishRoad(point: number): void;
  startRoad(flagPoint: number): void;
  placeFlag(point: number): void;
  sendGeologist(flagPoint: number): void;
  centreOn(point: number): void;
  setSpeed(speed: number): void;
  save(): void;
  exportSave(): void;
  importSave(file: File): void;
  quitToTitle(): void;
  saveAndQuit(): void;
  attack(point: number, men: number): void;
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

  private readonly unread: HTMLElement;
  private readonly ticker: HTMLElement;
  private readonly messages: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly buildMenu: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly fileInput: HTMLInputElement;

  private buildMenuOpen = false;
  private menuOpen = false;
  private messagesOpen = false;
  private lastEventCount = 0;
  private readCount = 0;
  private panelState = '';
  /** Which destructive button is one press from acting, if any. */
  private armed: string | null = null;
  /** True while the menu is asking whether to save before quitting. */
  private quitting = false;
  /** How many men the attack panel is currently offering to send. */
  private attackMen = 1;
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

    this.unread = el('button', { class: 'hud__unread', type: 'button' });
    this.unread.addEventListener('click', () => this.toggleMessages());
    this.ticker = el('div', { class: 'hud__ticker', 'aria-live': 'polite' });
    this.messages = el('div', { class: 'messages', hidden: true });
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
        this.unread,
        button('Menu', 'hud__menubutton', () => this.toggleMenu()),
      ),
      this.ticker,
      this.panel,
      this.buildMenu,
      this.messages,
      this.menu,
      this.actions,
      this.fileInput,
    );

    this.renderActions();
    this.renderBuildMenu();
    this.renderMenu();
    this.renderUnread();
  }

  /** Called every frame; keeps DOM writes to what has actually changed. */
  update(state: HudState): void {
    // The mode drives both the panel and whether Cancel is offered, so it has
    // to invalidate the action bar as well as the panel.
    const modeChanged =
      state.pendingBuilding !== this.state.pendingBuilding || state.roadFrom !== this.state.roadFrom;

    // The world under a node changes without the selection moving — a flag goes
    // up, a house is finished, a crate arrives — and the panel has to follow.
    const signature = panelSignature(this.simulation, state.selectedPoint);
    const contentChanged = signature !== this.panelState;
    this.panelState = signature;

    // Looking somewhere else disarms whatever was one press from being
    // destroyed. A confirmation should never survive the player's attention
    // moving on.
    if (state.selectedPoint !== this.state.selectedPoint || modeChanged) this.armed = null;

    const selectionChanged =
      modeChanged || state.selectedPoint !== this.state.selectedPoint || contentChanged;
    const speedChanged = state.speed !== this.state.speed;
    const noticeChanged = state.notice !== this.state.notice;

    this.state = state;

    if (selectionChanged) this.renderPanel();
    if (speedChanged || modeChanged) this.renderActions();
    if (noticeChanged || this.simulation.events.length !== this.lastEventCount) {
      this.lastEventCount = this.simulation.events.length;
      this.renderTicker();
      this.renderUnread();
      if (this.messagesOpen) this.renderMessages();
    }
  }

  destroy(): void {
    clear(this.root);
  }

  // -------------------------------------------------------------- sections

  private renderTicker(): void {
    const latest = this.simulation.events[this.simulation.events.length - 1];
    this.ticker.textContent = this.state.notice ?? latest?.text ?? '';
    this.ticker.classList.toggle('hud__ticker--warning', this.state.notice !== null);
  }

  /**
   * The way into the message log, and how many are waiting.
   *
   * Always present, even with nothing to read — a button that appears only once
   * something has happened is a button nobody knows is there, and there is no
   * other way back to the log once it has been read.
   */
  private renderUnread(): void {
    const count = Math.max(0, this.simulation.events.length - this.readCount);

    this.unread.textContent = count === 0 ? '✉' : count > 9 ? '9+' : String(count);
    this.unread.classList.toggle('hud__unread--waiting', count > 0);
    this.unread.setAttribute(
      'aria-label',
      count === 0 ? 'Messages' : `Messages, ${count} unread`,
    );
  }

  private renderMessages(): void {
    clear(this.messages);
    this.messages.append(el('h2', { class: 'messages__title' }, 'Messages'));

    const events = this.simulation.events;
    if (events.length === 0) {
      this.messages.append(el('p', { class: 'panel__note' }, 'Nothing has happened yet.'));
      return;
    }

    const list = el('div', { class: 'messages__list' });

    // Newest first: the thing that just happened is the thing being looked for.
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const message = events[i]!;
      const entry = el(
        'button',
        { class: `messages__item messages__item--${message.category}`, type: 'button' },
        el('span', { class: 'messages__when' }, formatTick(message.tick)),
        el('span', { class: 'messages__text' }, message.text),
      );

      if (message.point >= 0) {
        entry.addEventListener('click', () => {
          this.callbacks.centreOn(message.point);
          this.closeMessages();
        });
      } else {
        entry.disabled = true;
      }

      list.append(entry);
    }

    this.messages.append(list);
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
        // Cycles normal, double, quadruple, paused. One button rather than a
        // row of them: on a phone the map is worth more than the chrome.
        const next = speed === 1 ? 2 : speed === 2 ? 4 : speed === 4 ? 0 : 1;
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

    // Grouped rather than one long grid: with most of the roster available the
    // flat list ran well off the bottom of a phone.
    for (const category of CATEGORY_ORDER) {
      const inCategory = AVAILABLE_BUILDINGS.filter((info) => info.category === category);
      if (inCategory.length === 0) continue;

      const grid = el('div', { class: 'buildmenu__grid' });
      for (const info of inCategory) grid.append(this.buildCard(info));

      this.buildMenu.append(el('h3', { class: 'buildmenu__section' }, category), grid);
    }
  }

  private buildCard(info: BuildingInfo): HTMLElement {
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

    return card;
  }

  private renderMenu(): void {
    if (this.quitting) {
      this.renderQuitPrompt();
      return;
    }

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
        this.quitting = true;
        this.renderMenu();
      }),
      button('Close', 'gamemenu__item', () => this.closeMenu()),
    );
  }

  /**
   * What Quit to title asks before it acts.
   *
   * Three answers, so this is a small panel of its own rather than the
   * arm-then-confirm the demolish buttons use — that shape has room for two.
   * Nothing is written unless the player says so: quitting used to throw away
   * everything since the last automatic save without a word.
   */
  private renderQuitPrompt(): void {
    clear(this.menu);
    this.menu.append(
      el('h2', { class: 'gamemenu__title' }, 'Quit to title'),
      el('p', { class: 'gamemenu__note' }, 'Anything since your last save will be lost.'),
      button('Save and quit', 'gamemenu__item', () => {
        this.quitting = false;
        this.closeMenu();
        this.callbacks.saveAndQuit();
      }),
      button('Quit without saving', 'gamemenu__item gamemenu__item--quit', () => {
        this.quitting = false;
        this.closeMenu();
        this.callbacks.quitToTitle();
      }),
      button('Cancel', 'gamemenu__item', () => {
        this.quitting = false;
        this.renderMenu();
      }),
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
    if (building.owner !== this.playerId) {
      this.showEnemyPanel(building);
      return;
    }

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

      const trained = garrisonStrength(building.garrison);
      if (trained > 0) {
        children.push(el('p', { class: 'panel__note' }, `Soldiers waiting: ${trained}`));
        children.push(el('ul', { class: 'panel__list' }, ...rankList(building.garrison)));
      }
    } else if (info.behaviour.kind === 'military') {
      const held = garrisonStrength(building.garrison);
      children.push(
        el('p', { class: 'panel__note' }, `Garrison: ${held} of ${info.behaviour.garrison}`),
      );
      children.push(el('ul', { class: 'panel__list' }, ...rankList(building.garrison)));

      // What the gold chain is for, said where the player can act on it.
      if (held > 0) {
        const promotable = building.garrison
          .slice(0, TOP_RANK)
          .reduce((total, count) => total + count, 0);
        children.push(
          el(
            'p',
            { class: 'panel__note' },
            promotable > 0
              ? `A gold coin promotes one of the ${promotable} who can still rise.`
              : 'Every man here is a general.',
          ),
        );
      }
    }

    if (info.behaviour.kind !== 'headquarters') {
      children.push(
        this.dangerousAction(`demolish:${building.id}`, 'Demolish', 'Really demolish?', () =>
          this.callbacks.demolishBuilding(building.point),
        ),
      );
    }

    this.showPanel(children);
  }

  /**
   * Somebody else's building.
   *
   * No Demolish — it was offered on every building regardless of whose it was,
   * and the command then refused it, which was merely silly until there was
   * somebody else on the map. What is offered instead is an attack, when there
   * are men near enough to send.
   */
  private showEnemyPanel(building: Building): void {
    const info = buildingInfo(building.type);
    const held = garrisonStrength(building.garrison);

    const children: HTMLElement[] = [
      el('h2', { class: 'panel__title' }, info.name),
      el('p', { class: 'panel__status' }, `${this.ownerName(building.owner)}'s`),
    ];

    const behaviour = info.behaviour;
    const attackable = behaviour.kind === 'military' || behaviour.kind === 'headquarters';

    if (attackable) {
      children.push(el('p', { class: 'panel__note' }, `Defended by ${held}.`));
      children.push(el('ul', { class: 'panel__list' }, ...rankList(building.garrison)));
    }

    const spare = attackable ? this.simulation.menToSpare(this.playerId, building.point) : 0;

    if (attackable && spare > 0) {
      // Clamped every render: the men available change as a fight goes on, and
      // an offer to send more than there are would only be refused.
      this.attackMen = Math.max(1, Math.min(this.attackMen, spare));
      const men = this.attackMen;

      children.push(
        el(
          'div',
          { class: 'panel__stepper' },
          button('−', 'panel__step', () => {
            this.attackMen = Math.max(1, men - 1);
            this.renderPanel();
          }),
          el('span', { class: 'panel__count' }, `${men} of ${spare}`),
          button('+', 'panel__step', () => {
            this.attackMen = Math.min(spare, men + 1);
            this.renderPanel();
          }),
        ),
        button(`Attack with ${men}`, 'panel__action panel__action--danger', () =>
          this.callbacks.attack(building.point, men),
        ),
      );
    } else if (attackable) {
      children.push(
        el('p', { class: 'panel__note' }, 'No outpost of yours is near enough to send anybody.'),
      );
    }

    this.showPanel(children);
  }

  private ownerName(owner: number): string {
    return this.simulation.players.find((player) => player.id === owner)?.name ?? 'Somebody else';
  }

  /**
   * A button that asks before it acts.
   *
   * Demolishing is the one thing in the game that cannot be undone, and the
   * panel sits under a thumb. The first press arms the button and it says so;
   * the second does the deed. Anything else the player touches — another
   * selection, another panel — disarms it, because `armed` is keyed to the
   * thing being destroyed and the panel is rebuilt whenever that changes.
   */
  private dangerousAction(
    key: string,
    label: string,
    confirm: string,
    act: () => void,
  ): HTMLElement {
    const ready = this.armed === key;
    const classes = ready
      ? 'panel__action panel__action--danger panel__action--armed'
      : 'panel__action panel__action--danger';

    return button(ready ? confirm : label, classes, () => {
      if (ready) {
        this.armed = null;
        act();
        return;
      }
      this.armed = key;
      this.renderPanel();
    });
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
      button('Send a geologist', 'panel__action', () => this.callbacks.sendGeologist(point)),
    ];

    // A flag serving a building takes the building with it, so it asks the same
    // question the Demolish button does. A bare flag is put straight back if it
    // was a mistake, and a question in the way of every little adjustment to a
    // road network is worse than the mistake.
    children.push(
      flag.building === 0
        ? button('Remove flag', 'panel__action panel__action--danger', () =>
            this.callbacks.demolishFlag(point),
          )
        : this.dangerousAction(
            `flag:${flagId}`,
            'Remove flag and building',
            'Really demolish?',
            () => this.callbacks.demolishFlag(point),
          ),
    );

    this.showPanel(children);
  }

  /**
   * What a geologist has found here, if anything and if anyone has looked.
   *
   * Ground nobody has surveyed says nothing at all, rather than "nothing here"
   * — the difference between the two is the whole point of sending a geologist.
   */
  private depositNote(point: number): HTMLElement | null {
    const world = this.simulation.world;
    if (!world.resourceKnown[point]) return null;

    const resource = world.resource[point] as Resource;
    const amount = world.resourceAmount[point] ?? 0;
    if (resource === Resource.None || amount <= 0) {
      return el('p', { class: 'panel__note' }, 'Surveyed: nothing below.');
    }

    return el('p', { class: 'panel__note' }, `Surveyed: ${RESOURCE_NAMES[resource]} below.`);
  }

  /** The kind of ground under a point, named from the triangles around it. */
  private terrainName(point: number): string {
    const world = this.simulation.world;
    const counts = new Map<string, number>();

    world.trianglesAroundPoint(point, TRIANGLES);
    for (let i = 0; i < 6; i += 1) {
      const triangle = TRIANGLES[i]!;
      if (triangle === OUT_OF_BOUNDS) continue;
      const name = terrainOf(world.terrainOfTriangle(triangle)).name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    // Six triangles meet here and they need not agree; the commonest wins, so a
    // point on a shoreline reads as whichever side it mostly sits on.
    let best = 'Water';
    let most = 0;
    for (const [name, count] of counts) {
      if (count > most) {
        most = count;
        best = name;
      }
    }
    return best;
  }

  /** What is standing on a point, if anything. */
  private standingOn(point: number): string | null {
    const world = this.simulation.world;
    const data = world.objectData[point] ?? 0;

    switch (world.object[point]) {
      case MapObject.Tree:
        return data >= TREE_FULLY_GROWN ? 'A grown tree.' : 'A sapling, still growing.';
      case MapObject.Stone:
        return `A granite outcrop, ${data} block${data === 1 ? '' : 's'} left.`;
      case MapObject.Field:
        return data >= FIELD_FULLY_GROWN ? 'Corn, ready to cut.' : 'A sown field, still green.';
      case MapObject.Decoration:
        return 'Scrub.';
      default:
        return null;
    }
  }

  private showGroundPanel(point: number): void {
    const world = this.simulation.world;
    const onRoad = world.roadCount(point) > 0;
    const space = evaluateBuildSpace(world, point, this.playerId);

    const children: HTMLElement[] = [
      el('h2', { class: 'panel__title' }, onRoad ? 'Road' : this.terrainName(point)),
    ];

    const standing = this.standingOn(point);
    if (standing) children.push(el('p', { class: 'panel__status' }, standing));

    const deposit = this.depositNote(point);
    if (deposit) children.push(deposit);

    if (space !== BuildSpace.None) {
      children.push(
        button('Place a flag', 'panel__action', () => this.callbacks.placeFlag(point)),
      );
    }

    if (onRoad) {
      // Removing the road here leaves both its flags standing, unlike removing
      // a flag, which takes every road meeting it.
      children.push(
        el('p', { class: 'panel__note' }, 'A flag here divides the road into two stretches.'),
        button('Remove this road', 'panel__action panel__action--danger', () =>
          this.callbacks.demolishRoad(point),
        ),
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
      this.closeMessages();
      this.buildMenuOpen = false;
      this.buildMenu.hidden = true;
      this.renderActions();
    }
  }

  private toggleMessages(): void {
    this.messagesOpen = !this.messagesOpen;
    this.messages.hidden = !this.messagesOpen;

    if (!this.messagesOpen) return;

    this.closeMenu();
    this.buildMenuOpen = false;
    this.buildMenu.hidden = true;
    this.renderActions();
    this.renderMessages();

    // Opening the log is what marks it read.
    this.readCount = this.simulation.events.length;
    this.renderUnread();
  }

  private closeMessages(): void {
    this.messagesOpen = false;
    this.messages.hidden = true;
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.menu.hidden = true;

    // A half-answered question must not be waiting the next time the menu is
    // opened; the player who closed it has already declined to answer.
    if (this.quitting) {
      this.quitting = false;
      this.renderMenu();
    }
  }
}

const TRIANGLES = new Int32Array(6);

/** Game time as minutes and seconds, which is how long a game actually feels. */
function formatTick(tick: number): string {
  const seconds = Math.floor(tick / TICKS_PER_SECOND);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
