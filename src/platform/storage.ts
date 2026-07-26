import type { SaveMeta } from './save';

/**
 * Save slots kept in IndexedDB.
 *
 * IndexedDB rather than localStorage because saves are binary and can run to a
 * few hundred kilobytes, well past what localStorage will hold comfortably.
 * Nothing leaves the device.
 */

const DATABASE = 'bailiwick';
const STORE = 'saves';
const VERSION = 1;

export interface SaveSlot {
  readonly id: string;
  readonly meta: SaveMeta;
  readonly bytes: Uint8Array;
}

export interface SaveSlotSummary {
  readonly id: string;
  readonly meta: SaveMeta;
}

/** The slot the game writes to on its own, separate from named saves. */
export const AUTOSAVE_ID = 'autosave';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the save database'));
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('the save database failed'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function putSave(id: string, meta: SaveMeta, bytes: Uint8Array): Promise<void> {
  await transact('readwrite', (store) => store.put({ id, meta, bytes }));
}

export async function getSave(id: string): Promise<SaveSlot | undefined> {
  // IndexedDB's typings hand back IDBRequest<any>; the store only ever holds
  // records this module wrote, so the shape is known.
  return transact<SaveSlot | undefined>(
    'readonly',
    (store) => store.get(id) as IDBRequest<SaveSlot | undefined>,
  );
}

export async function listSaves(): Promise<SaveSlotSummary[]> {
  const records = await transact<SaveSlot[]>(
    'readonly',
    (store) => store.getAll() as IDBRequest<SaveSlot[]>,
  );
  return records
    .map((record) => ({ id: record.id, meta: record.meta }))
    .sort((a, b) => b.meta.savedAt - a.meta.savedAt);
}

export async function deleteSave(id: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(id));
}

/** True when the browser can store saves at all — private modes sometimes cannot. */
export async function isStorageAvailable(): Promise<boolean> {
  try {
    const db = await open();
    db.close();
    return true;
  } catch {
    return false;
  }
}
