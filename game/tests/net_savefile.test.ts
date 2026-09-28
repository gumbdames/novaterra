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
 * NOVATERRA — save-file tests (Phase 1, step 11).
 *
 * Covers the SaveFile envelope: metadata is stamped correctly from a
 * live session, the snapshot is a deep copy (mutating the world after
 * the save never affects the file), and a JSON round trip preserves
 * everything byte-for-byte.
 */
import { describe, expect, it } from 'vitest';
import { createSession } from '../src/ui/session';
import {
  createSaveFile,
  SAVEFILE_VERSION,
  summarizeSave,
  type SaveFile,
} from '../src/net_save/savefile';

const SAVED_AT = '2026-09-29T12:00:00.000Z';

function makeFile(): SaveFile {
  const session = createSession({ seed: 4242, aiDifficulty: 'commander' });
  session.tick();
  session.tick();
  return createSaveFile(session, 'slot-1', 'Slot 1', SAVED_AT);
}

describe('savefile', () => {
  it('stamps metadata from the live session', () => {
    const file = makeFile();
    expect(file.version).toBe(SAVEFILE_VERSION);
    expect(file.metadata.slotId).toBe('slot-1');
    expect(file.metadata.name).toBe('Slot 1');
    expect(file.metadata.savedAt).toBe(SAVED_AT);
    expect(file.metadata.tick).toBe(3); // 1 (starting forces) + 2 ticks
    expect(file.metadata.seed).toBe(4242);
    expect(file.metadata.aiDifficulty).toBe('commander');
    expect(file.metadata.age).toBe('foundation');
    expect(file.metadata.program).toBeNull();
    expect(file.metadata.cheated).toBe(false);
  });

  it('records the cheated flag when the session cheated', () => {
    const session = createSession({ seed: 1 });
    session.cheated = true;
    const file = createSaveFile(session, 'slot-2', 'Slot 2', SAVED_AT);
    expect(file.metadata.cheated).toBe(true);
  });

  it('deep-copies the snapshot: later world mutation never affects the file', () => {
    const session = createSession({ seed: 99 });
    const file = createSaveFile(session, 'slot-1', 'Slot 1', SAVED_AT);
    const unitsBefore = file.snapshot.units.length;
    // Mutate the live world after saving.
    session.world.units.pop();
    session.world.tick += 1000;
    expect(file.snapshot.units.length).toBe(unitsBefore);
    expect(file.snapshot.tick).not.toBe(session.world.tick);
  });

  it('survives a JSON round trip byte-for-byte', () => {
    const file = makeFile();
    const revived = JSON.parse(JSON.stringify(file)) as SaveFile;
    expect(revived).toEqual(file);
    expect(revived.metadata.tick).toBe(file.metadata.tick);
    expect(revived.snapshot.units).toEqual(file.snapshot.units);
  });

  it('summarizeSave returns just the metadata', () => {
    const file = makeFile();
    expect(summarizeSave(file)).toBe(file.metadata);
  });
});
