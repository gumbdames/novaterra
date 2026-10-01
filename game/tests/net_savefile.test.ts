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
import { getMission } from '../src/campaign/missions';
import {
  createSaveFile,
  SAVEFILE_VERSION,
  saveMapPreset,
  summarizeSave,
  validateSaveVersion,
  type SaveFile,
} from '../src/netSave/savefile';

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

  it('validateSaveVersion accepts a current save', () => {
    const file = makeFile();
    expect(validateSaveVersion(file)).toBeNull();
  });

  it('validateSaveVersion explains an old save in plain language', () => {
    const file = makeFile();
    // Simulate a v4 save from before the Phase 3 snapshot bump.
    (file.snapshot as { version: number }).version = 4;
    const msg = validateSaveVersion(file);
    expect(msg).not.toBeNull();
    expect(typeof msg).toBe('string');
    // Plain language: no "v4", no "snapshot", no "mismatch".
    expect(msg as string).toMatch(/older version/i);
    expect(msg as string).not.toMatch(/v4/);
    expect(msg as string).not.toMatch(/snapshot/i);
    expect(msg as string).not.toMatch(/mismatch/i);
  });

  it('validateSaveVersion accepts v5/v6/v7/v8 (R1-C/M1: matches restoreSnapshot)', () => {
    for (const version of [5, 6, 7, 8]) {
      const file = makeFile();
      (file.snapshot as { version: number }).version = version;
      expect(validateSaveVersion(file), `v${version} should load`).toBeNull();
    }
  });

  it('validateSaveVersion rejects saves newer than this build', () => {
    const file = makeFile();
    (file.snapshot as { version: number }).version = 9;
    expect(validateSaveVersion(file)).not.toBeNull();
  });

  it('stamps the resolved map preset name (R1-C/C4)', () => {
    const session = createSession({ seed: 99, mapPreset: 'Ocean World' });
    const file = createSaveFile(session, 'slot-1', 'Slot 1', SAVED_AT);
    expect(file.metadata.mapPreset).toBe('Ocean World');
  });

  it('records the resolved name for an unknown preset (not the raw option)', () => {
    const session = createSession({ seed: 99, mapPreset: 'No Such Map' });
    const file = createSaveFile(session, 'slot-1', 'Slot 1', SAVED_AT);
    expect(file.metadata.mapPreset).toBe('Meridian Plains');
  });

  it('stamps null campaignMissionId for skirmish saves (R1-C/C4)', () => {
    const file = makeFile();
    expect(file.metadata.campaignMissionId).toBeNull();
  });

  it('stamps the campaign mission id and its map preset (R1-C/C4)', () => {
    const mission = getMission('crossing-the-water')!;
    const session = createSession({ seed: 7, campaignMission: mission });
    const file = createSaveFile(session, 'slot-1', 'Slot 1', SAVED_AT);
    expect(file.metadata.campaignMissionId).toBe('crossing-the-water');
    expect(file.metadata.mapPreset).toBe(mission.mapPreset);
    expect(file.metadata.mapPreset).toBe('Archipelago');
  });

  describe('saveMapPreset', () => {
    it("prefers the save's own mapPreset", () => {
      const file = makeFile();
      file.metadata.mapPreset = 'Inland Sea';
      expect(saveMapPreset(file, 'Archipelago')).toBe('Inland Sea');
    });

    it('falls back to the mission def preset when the save predates the field', () => {
      const file = makeFile();
      delete file.metadata.mapPreset;
      expect(saveMapPreset(file, 'Archipelago')).toBe('Archipelago');
    });

    it("defaults to Meridian Plains for pre-R1-C saves (the historic load behavior)", () => {
      const file = makeFile();
      delete file.metadata.mapPreset;
      delete file.metadata.campaignMissionId;
      expect(saveMapPreset(file)).toBe('Meridian Plains');
    });
  });
});
