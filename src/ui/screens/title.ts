import { loadSimulation } from '../../platform/save';
import { AUTOSAVE_ID, getSave, listSaves, deleteSave } from '../../platform/storage';
import type { Simulation } from '../../sim/simulation';
import { button, clear, el } from '../dom';
import crestSvg from './crest.svg?raw';
import sceneSvg from './scene.svg?raw';

export interface TitleCallbacks {
  /** Start a brand new province. */
  newGame(): void;
  /** Resume a game restored from a save. */
  resume(simulation: Simulation): void;
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

  private async refreshContinue(): Promise<void> {
    const continueButton = this.menu.querySelector<HTMLButtonElement>(
      '.title__button:nth-child(2)',
    );
    if (!continueButton) return;

    try {
      const autosave = await getSave(AUTOSAVE_ID);
      continueButton.disabled = !autosave;
      if (autosave) {
        continueButton.textContent = `Continue — ${formatPlayed(autosave.meta.tick)}`;
      }
    } catch {
      continueButton.disabled = true;
    }
  }

  private async continueGame(): Promise<void> {
    try {
      const autosave = await getSave(AUTOSAVE_ID);
      if (!autosave) {
        this.say('There is no game to continue.');
        return;
      }
      this.callbacks.resume(await loadSimulation(autosave.bytes));
    } catch (error) {
      this.say(`Could not continue: ${describe(error)}`);
    }
  }

  private async loadFromFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.callbacks.resume(await loadSimulation(bytes));
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
      const save = await getSave(id);
      if (!save) {
        this.say('That save has gone.');
        return;
      }
      this.callbacks.resume(await loadSimulation(save.bytes));
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

  private say(message: string): void {
    this.message.textContent = message;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
