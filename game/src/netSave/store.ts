/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — netSave/store.ts — save-game persistence.
 *
 * Responsibilities:
 *  - `SaveStore`: async CRUD for SaveFiles keyed by slot id:
 *    `list()`, `read(slotId)`, `write(slotId, file)`, `remove(slotId)`.
 *  - `createSaveStore()`: async factory. Uses IndexedDB when available
 *    (one record per slot, single transaction per op); falls back to an
 *    in-memory Map when IndexedDB is missing or throws (private mode,
 *    Node/vitest, disabled storage). The UI checks `backend` to show a
 *    "saves won't persist" hint when on the memory fallback.
 *  - Never throws to the caller: every operation is try/caught and
 *    degrades to null/empty/false. A failed save must never crash the
 *    game — the UI toasts the failure instead.
 *
 * The store is UI-layer: it never touches sim state, only SaveFiles.
 * Safe to import under Node (the IndexedDB path is only attempted when
 * the global exists).
 */

import type { SaveFile, SaveMetadata, SaveSlotId } from './savefile';
import { SAVE_SLOT_IDS } from './savefile';

const DB_NAME = 'novaterra-saves';
const DB_VERSION = 1;
const STORE_NAME = 'saves';

export type SaveBackend = 'indexeddb' | 'memory';

export interface SaveStore {
  /** Which backend is in use. */
  readonly backend: SaveBackend;
  /** Metadata for every occupied slot, newest first. Never throws. */
  list(): Promise<SaveMetadata[]>;
  /** Full file for a slot, or null when empty/unreadable. Never throws. */
  read(slotId: SaveSlotId): Promise<SaveFile | null>;
  /** Persist a file to a slot. Returns false on failure. Never throws. */
  write(slotId: SaveSlotId, file: SaveFile): Promise<boolean>;
  /** Clear a slot. Returns false on failure. Never throws. */
  remove(slotId: SaveSlotId): Promise<boolean>;
}

/** In-memory fallback: per-store Map (fresh for each createSaveStore). */
function createMemoryStore(): SaveStore {
  const data = new Map<SaveSlotId, SaveFile>();
  return {
    backend: 'memory',
    async list(): Promise<SaveMetadata[]> {
      const out: SaveMetadata[] = [];
      for (const id of SAVE_SLOT_IDS) {
        const f = data.get(id);
        if (f) out.push(f.metadata);
      }
      return out;
    },
    async read(slotId: SaveSlotId): Promise<SaveFile | null> {
      return data.get(slotId) ?? null;
    },
    async write(slotId: SaveSlotId, file: SaveFile): Promise<boolean> {
      try {
        if (file.metadata.slotId !== slotId) return false;
        // Deep-copy through JSON so the stored file never aliases the
        // caller's objects (mirrors the IndexedDB structured-clone).
        data.set(slotId, JSON.parse(JSON.stringify(file)) as SaveFile);
        return true;
      } catch {
        return false;
      }
    },
    async remove(slotId: SaveSlotId): Promise<boolean> {
      data.delete(slotId);
      return true;
    },
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'metadata.slotId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (ok: boolean, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (ok) resolve(value as T);
      else reject(value instanceof Error ? value : new Error('indexedDB transaction failed'));
    };
    try {
      const t = db.transaction(STORE_NAME, mode);
      t.oncomplete = () => done(true, undefined);
      t.onerror = () => done(false, t.error ?? undefined);
      t.onabort = () => done(false, t.error ?? undefined);
      const req = fn(t.objectStore(STORE_NAME));
      req.onsuccess = () => {
        if (mode === 'readonly') done(true, req.result);
        // readwrite resolves on transaction complete
      };
      req.onerror = () => done(false, req.error ?? undefined);
    } catch (e) {
      done(false, e);
    }
  });
}

function createIndexedDbStore(db: IDBDatabase): SaveStore {
  return {
    backend: 'indexeddb',
    async list(): Promise<SaveMetadata[]> {
      try {
        const files = await tx<SaveFile[]>(db, 'readonly', (s) => s.getAll());
        return files
          .map((f) => f.metadata)
          .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
      } catch {
        return [];
      }
    },
    async read(slotId: SaveSlotId): Promise<SaveFile | null> {
      try {
        const file = await tx<SaveFile | undefined>(db, 'readonly', (s) => s.get(slotId));
        return file ?? null;
      } catch {
        return null;
      }
    },
    async write(slotId: SaveSlotId, file: SaveFile): Promise<boolean> {
      try {
        if (file.metadata.slotId !== slotId) return false;
        await tx(db, 'readwrite', (s) => s.put(file));
        return true;
      } catch {
        return false;
      }
    },
    async remove(slotId: SaveSlotId): Promise<boolean> {
      try {
        await tx(db, 'readwrite', (s) => s.delete(slotId));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Create a save store. Prefers IndexedDB; falls back to memory when
 * unavailable (private browsing, disabled storage, Node/vitest).
 * Never throws — worst case returns a memory store.
 */
export async function createSaveStore(): Promise<SaveStore> {
  try {
    if (typeof indexedDB === 'undefined') return createMemoryStore();
    const db = await openDb();
    return createIndexedDbStore(db);
  } catch {
    return createMemoryStore();
  }
}
