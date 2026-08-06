import { OLDEST_SAVE_VERSION, SAVE_VERSION } from '../sim/save-version';

/**
 * The save file's outer layer: gzip, base64, and the header on the front.
 *
 * Kept apart from `save.ts` because the two have different appetites. Turning a
 * save into a *simulation* needs the whole game; deciding whether a file is a
 * save at all, and what it calls itself, needs none of it. The title screen
 * only ever asks the second question, and this is what lets it ask without
 * dragging every building, ware and rule onto a page that shows a drawing and
 * four buttons.
 */

export const SAVE_EXTENSION = '.bwsave';

export interface SaveMeta {
  readonly name: string;
  /** Milliseconds since the epoch, taken outside the simulation. */
  readonly savedAt: number;
  readonly tick: number;
}

/** What every save carries on its front, whatever else is behind it. */
interface SaveHeader {
  readonly version: number;
  readonly meta: SaveMeta;
}

// -------------------------------------------------------------- base64

export function toBase64(bytes: Uint8Array): string {
  // Chunked so a large map cannot blow the argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------- compression

export async function gzip(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return bytes;

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  // Uncompressed saves start with '{'; gzip always starts with 0x1f 0x8b.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot read compressed saves');
  }

  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// ---------------------------------------------------------------- header

/**
 * Refuses a save this build cannot read.
 *
 * Older saves are read on purpose — the simulation fills in whatever they
 * predate — but only back as far as `OLDEST_SAVE_VERSION`. A save from a
 * *newer* version cannot be opened because there is no telling what it left
 * out; one from before the map changed cannot be opened because its island is
 * no longer where it was.
 */
export function checkVersion(version: number): void {
  if (version > SAVE_VERSION) {
    throw new Error(`This save was made by a newer version of Bailiwick (${version}).`);
  }
  if (version < OLDEST_SAVE_VERSION) {
    throw new Error(
      `This save (${version}) was made before the map was doubled and mirrored, and its island no longer exists.`,
    );
  }
}

/**
 * Reads what a file says about itself, and refuses it if it is not a save.
 *
 * Enough to list a file, name it and decide whether this build can open it,
 * without unpacking the province inside.
 */
export async function readSaveMeta(bytes: Uint8Array): Promise<SaveMeta> {
  const header = JSON.parse(await gunzip(bytes)) as Partial<SaveHeader>;

  if (typeof header.version !== 'number' || !header.meta) {
    throw new Error('That file is not a Bailiwick save.');
  }
  checkVersion(header.version);

  return header.meta;
}
