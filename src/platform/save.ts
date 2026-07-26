import type { SimulationSnapshot } from '../sim/simulation';
import { SAVE_VERSION, Simulation } from '../sim/simulation';

/**
 * Turning a game into bytes and back.
 *
 * Saves are gzipped JSON with the map's typed arrays base64-encoded. Terrain
 * and altitude are not stored at all — the simulation regenerates them from the
 * seed — so a whole province comes to a few kilobytes, small enough to keep
 * several slots in the browser and to hand the file to somebody else.
 *
 * Everything here stays on the device. Exporting writes a file; it does not
 * upload anything.
 */

export const SAVE_EXTENSION = '.bwsave';

/** JSON-friendly stand-in for the map's typed arrays. */
interface EncodedMap {
  readonly object: string;
  readonly objectData: string;
  readonly resource: string;
  readonly resourceAmount: string;
  readonly resourceKnown: string;
  readonly owner: string;
  readonly roads: string;
  readonly building: string;
  readonly flag: string;
}

interface EncodedSave extends Omit<SimulationSnapshot, 'map'> {
  readonly map: EncodedMap;
  /** Descriptive metadata, for the load menu. */
  readonly meta: SaveMeta;
}

export interface SaveMeta {
  readonly name: string;
  /** Milliseconds since the epoch, taken outside the simulation. */
  readonly savedAt: number;
  readonly tick: number;
}

// -------------------------------------------------------------- base64

function toBase64(bytes: Uint8Array): string {
  // Chunked so a large map cannot blow the argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeUint8(array: Uint8Array): string {
  return toBase64(array);
}

function encodeInt32(array: Int32Array): string {
  return toBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}

function decodeUint8(encoded: string): Uint8Array {
  return fromBase64(encoded);
}

function decodeInt32(encoded: string): Int32Array {
  const bytes = fromBase64(encoded);
  // The buffer from base64 is freshly allocated, so it is already aligned.
  return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// ---------------------------------------------------------- compression

async function gzip(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return bytes;

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
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

// ---------------------------------------------------------------- api

export async function encodeSave(simulation: Simulation, name: string): Promise<Uint8Array> {
  const snapshot = simulation.toSnapshot();

  const encoded: EncodedSave = {
    ...snapshot,
    map: {
      object: encodeUint8(snapshot.map.object),
      objectData: encodeUint8(snapshot.map.objectData),
      resource: encodeUint8(snapshot.map.resource),
      resourceAmount: encodeUint8(snapshot.map.resourceAmount),
      resourceKnown: encodeUint8(snapshot.map.resourceKnown),
      owner: encodeUint8(snapshot.map.owner),
      roads: encodeUint8(snapshot.map.roads),
      building: encodeInt32(snapshot.map.building),
      flag: encodeInt32(snapshot.map.flag),
    },
    meta: { name, savedAt: Date.now(), tick: snapshot.tick },
  };

  return gzip(JSON.stringify(encoded));
}

export async function decodeSave(
  bytes: Uint8Array,
): Promise<{ snapshot: SimulationSnapshot; meta: SaveMeta }> {
  const parsed = JSON.parse(await gunzip(bytes)) as EncodedSave;

  if (parsed.version !== SAVE_VERSION) {
    throw new Error(
      `This save was made by a different version of Bailiwick (${parsed.version}).`,
    );
  }

  const snapshot: SimulationSnapshot = {
    ...parsed,
    map: {
      object: decodeUint8(parsed.map.object),
      objectData: decodeUint8(parsed.map.objectData),
      resource: decodeUint8(parsed.map.resource),
      resourceAmount: decodeUint8(parsed.map.resourceAmount),
      resourceKnown: decodeUint8(parsed.map.resourceKnown),
      owner: decodeUint8(parsed.map.owner),
      roads: decodeUint8(parsed.map.roads),
      building: decodeInt32(parsed.map.building),
      flag: decodeInt32(parsed.map.flag),
    },
  };

  return { snapshot, meta: parsed.meta };
}

export async function loadSimulation(bytes: Uint8Array): Promise<Simulation> {
  const { snapshot } = await decodeSave(bytes);
  return Simulation.fromSnapshot(snapshot);
}

/** Offers the save to the player as a file download. */
export function exportSave(bytes: Uint8Array, name: string): void {
  const safe = name.replace(/[^\w -]+/g, '').trim() || 'bailiwick';
  const blob = new Blob([bytes as BlobPart], { type: 'application/gzip' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${safe}${SAVE_EXTENSION}`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Reads a save the player picked with a file input. */
export async function importSave(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
