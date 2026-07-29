import { readSaveMeta } from '../../platform/savefile';
import type { SaveSlotSummary } from '../../platform/storage';
import { getSave, listSaves, deleteSave, putSave } from '../../platform/storage';
import { button, clear, el } from '../dom';
import crestSvg from './crest.svg?raw';
import sceneSvg from './scene.svg?raw';

/**
 * What the title screen can ask for.
 *
 * It names a choice and nothing more: the game is a separate page, so acting on
 * either of these means visiting a URL rather than building a simulation here.
 * Which save is worth resuming is a question about the save list, and so stays
 * on this side; where a save is *played* is not.
 */
export interface TitleCallbacks {
  /** Start a brand new province. */
  newGame(): void;
  /**
   * Open the game on a save already in storage.
   *
   * Returns a message when it cannot — which slot to open travels in storage,
   * and a browser that refuses to keep it must say so rather than quietly
   * raising a new island and looking as though the save had been lost.
   */
  playSave(id: string): string | undefined;
}

function svg(markup: string, className: string): HTMLElement {
  const holder = el('div', { class: className });
  holder.innerHTML = markup;
  return holder;
}

function formatWhen(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatPlayed(tick: number): string {
  const minutes = Math.floor(tick / (20 * 60));
  if (minutes < 60) return `${minutes} min played`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m played`;
}

/**
 * The title screen.
 *
 * Keeps the welcome page's crest, isometric scene and parchment styling, so the
 * game opens on the same drawing the project started with rather than a
 * separate splash that has to be maintained alongside it.
 */
export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly callbacks: TitleCallbacks;
  private readonly menu: HTMLElement;
  private readonly message: HTMLElement;

  constructor(root: HTMLElement, callbacks: TitleCallbacks) {
    this.root = root;
    this.callbacks = callbacks;

    this.menu = el('nav', { class: 'title__menu' });
    this.message = el('p', { class: 'title__message', 'aria-live': 'polite' });

    const fileInput = el('input', {
      type: 'file',
      accept: '.bwsave,application/gzip',
      hidden: true,
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void this.loadFromFile(file);
      fileInput.value = '';
    });

    root.append(
      el(
        'div',
        { class: 'title' },
        el(
          'header',
          { class: 'title__header' },
          svg(crestSvg, 'title__crest'),
          el('h1', { class: 'title__name' }, 'Bailiwick'),
          el(
            'p',
            { class: 'title__tagline' },
            'A settlement-building strategy game, in the spirit of The Settlers II',
          ),
        ),
        svg(sceneSvg, 'title__scene'),
        this.menu,
        this.message,
        el(
          'footer',
          { class: 'title__footer' },
          'Plays offline. Saves stay on this device and can be exported as a file.',
        ),
        fileInput,
      ),
    );

    this.renderMenu(fileInput);
  }

  destroy(): void {
    clear(this.root);
  }

  private renderMenu(fileInput: HTMLInputElement): void {
    clear(this.menu);

    this.menu.append(
      button('New game', 'title__button title__button--primary', () => this.callbacks.newGame()),
      button('Continue', 'title__button', () => void this.continueGame(), { disabled: true }),
      button('Load a save', 'title__button', () => void this.showSaves()),
      button('Import a file', 'title__button', () => fileInput.click()),
    );

    // Enabling Continue depends on storage, so settle it once the check returns.
    void this.refreshContinue();
  }

  /**
   * The most recent save of any kind.
   *
   * Continue used to read the autosave slot alone, so pressing Save, quitting
   * and continuing brought back the last *automatic* save — up to two minutes
   * stale, or from an entirely earlier sitting. The saved game was never lost;
   * it was under "Load a save", which is precisely why this read as the game
   * ignoring the button. `listSaves` already returns every slot newest first.
   */
  private async newestSave(): Promise<SaveSlotSummary | undefined> {
    const saves = await listSaves();
    return saves[0];
  }

  private async refreshContinue(): Promise<void> {
    const continueButton = this.menu.querySelector<HTMLButtonElement>(
      '.title__button:nth-child(2)',
    );
    if (!continueButton) return;

    try {
      const newest = await this.newestSave();
      continueButton.disabled = !newest;
      if (newest) {
        continueButton.textContent = `Continue — ${formatPlayed(newest.meta.tick)}`;
      }
    } catch {
      continueButton.disabled = true;
    }
  }

  private async continueGame(): Promise<void> {
    try {
      const newest = await this.newestSave();
      if (!newest) {
        this.say('There is no game to continue.');
        return;
      }
      this.play(newest.id);
    } catch (error) {
      this.say(`Could not continue: ${describe(error)}`);
    }
  }

  /**
   * Takes a save file in and opens the game on it.
   *
   * The bytes are put into a slot first. A page load cannot carry a file across
   * with it, so storage is how it travels — and keeping the import means a file
   * fetched from another device shows up in the load list afterwards rather
   * than being playable exactly once. Only the file's *header* is read here —
   * enough to refuse a file that is not a save, on the screen that offered to
   * read it, without this page having to carry the whole simulation.
   */
  private async loadFromFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = await readSaveMeta(bytes);

      const id = `slot-${Date.now()}`;
      await putSave(id, { ...meta, name: meta.name || file.name, savedAt: Date.now() }, bytes);
      this.play(id);
    } catch (error) {
      this.say(`Could not read that file: ${describe(error)}`);
    }
  }

  private async showSaves(): Promise<void> {
    let saves;
    try {
      saves = await listSaves();
    } catch (error) {
      this.say(`Could not read your saves: ${describe(error)}`);
      return;
    }

    if (saves.length === 0) {
      this.say('There are no saved games on this device yet.');
      return;
    }

    clear(this.menu);
    for (const save of saves) {
      const row = el('div', { class: 'title__save' });

      row.append(
        button(
          `${save.meta.name} — ${formatWhen(save.meta.savedAt)}`,
          'title__button title__button--save',
          () => void this.loadSlot(save.id),
        ),
        button('Delete', 'title__button title__button--delete', () => void this.removeSlot(save.id)),
      );

      this.menu.append(row);
    }

    this.menu.append(
      button('Back', 'title__button', () => {
        const fileInput = this.root.querySelector<HTMLInputElement>('input[type=file]');
        if (fileInput) this.renderMenu(fileInput);
      }),
    );
  }

  private async loadSlot(id: string): Promise<void> {
    try {
      // Checked here rather than on the other side, so a slot deleted on
      // another tab says so on the screen that listed it.
      if (!(await getSave(id))) {
        this.say('That save has gone.');
        return;
      }
      this.play(id);
    } catch (error) {
      this.say(`Could not load that save: ${describe(error)}`);
    }
  }

  private async removeSlot(id: string): Promise<void> {
    try {
      await deleteSave(id);
      await this.showSaves();
    } catch (error) {
      this.say(`Could not delete that save: ${describe(error)}`);
    }
  }

  /** Hands a slot over to the game page, or reports why it cannot. */
  private play(id: string): void {
    const trouble = this.callbacks.playSave(id);
    if (trouble) this.say(trouble);
  }

  private say(message: string): void {
    this.message.textContent = message;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
