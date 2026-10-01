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
 * NOVATERRA — save store tests (Phase 1, step 11).
 *
 * The store must work with zero IndexedDB (Node/vitest has none, just
 * like a private-browsing window): `createSaveStore()` falls back to the
 * in-memory backend, CRUD works, and every method degrades gracefully
 * instead of throwing. The memory backend deep-copies on write so a
 * stored file never aliases the caller's objects.
 */
import { describe, expect, it } from 'vitest';
import { createSaveStore } from '../src/netSave/store';
import { createSaveFile, type SaveFile } from '../src/netSave/savefile';
import { createSession } from '../src/ui/session';

const SAVED_AT = '2026-09-29T12:00:00.000Z';

function makeFile(slotId: 'slot-1' | 'slot-2' | 'autosave', name: string): SaveFile {
  const session = createSession({ seed: 7 });
  return createSaveFile(session, slotId, name, SAVED_AT);
}

describe('save store', () => {
  it('falls back to the memory backend when IndexedDB is unavailable', async () => {
    const store = await createSaveStore();
    // Node has no indexedDB — same as private mode.
    expect(store.backend).toBe('memory');
  });

  it('writes, reads, lists and removes saves', async () => {
    const store = await createSaveStore();
    const file = makeFile('slot-1', 'Slot 1');

    expect(await store.read('slot-1')).toBeNull();
    expect(await store.write('slot-1', file)).toBe(true);

    const readBack = await store.read('slot-1');
    expect(readBack).toEqual(file);

    const list = await store.list();
    expect(list.map((m) => m.slotId)).toEqual(['slot-1']);

    expect(await store.remove('slot-1')).toBe(true);
    expect(await store.read('slot-1')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('deep-copies on write: mutating the original never affects the stored file', async () => {
    const store = await createSaveStore();
    const file = makeFile('slot-2', 'Slot 2');
    await store.write('slot-2', file);
    file.metadata.name = 'MUTATED';
    file.snapshot.units.pop();
    const readBack = await store.read('slot-2');
    expect(readBack!.metadata.name).toBe('Slot 2');
    expect(readBack!.snapshot.units.length).toBeGreaterThan(0);
  });

  it('rejects a slot mismatch instead of corrupting the store', async () => {
    const store = await createSaveStore();
    const file = makeFile('slot-1', 'Slot 1');
    expect(await store.write('slot-2', file)).toBe(false);
    expect(await store.read('slot-2')).toBeNull();
  });

  it('returns false instead of throwing on unserializable input', async () => {
    const store = await createSaveStore();
    const file = makeFile('slot-1', 'Slot 1');
    // Circular structure: JSON deep-copy throws -> write returns false.
    (file as unknown as { loop: unknown }).loop = file;
    expect(await store.write('slot-1', file)).toBe(false);
  });
});
