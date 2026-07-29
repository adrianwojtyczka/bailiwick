import type { SimulationSnapshot } from '../sim/simulation';
import { Simulation } from '../sim/simulation';
import type { SaveMeta } from './savefile';
import { checkVersion, fromBase64, gunzip, gzip, SAVE_EXTENSION, toBase64 } from './savefile';

export { SAVE_EXTENSION } from './savefile';
export type { SaveMeta } from './savefile';

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

// -------------------------------------------------------------- base64

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

  checkVersion(parsed.version);

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
