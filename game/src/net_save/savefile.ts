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
 * NOVATERRA — net_save/savefile.ts — versioned save-file format.
 *
 * Responsibilities:
 *  - `SaveFile`: `{ version, metadata, snapshot }` — the unit persisted
 *    by the store. The snapshot is the sim's own versioned format
 *    (sim/snapshot.ts, currently v4); the SaveFile envelope has its own
 *    version so slot metadata can evolve without touching the sim.
 *  - `SaveMetadata`: everything the load-game UI shows without reading
 *    the (potentially large) snapshot: slot id, display name, save time,
 *    tick, age, National Program, AI difficulty, seed, and whether any
 *    cheat was used in the session (`cheated`).
 *  - `createSaveFile(session, slotId, name)`: build a SaveFile from a
 *    live GameSession. Deep-copies via takeSnapshot — the file never
 *    aliases live world state.
 *
 * Pure data module: no DOM, no IndexedDB, no wall clock (the caller
 * stamps `savedAt`). Safe under Node/vitest.
 */

import type { GameSession } from '../ui/session';
import { takeSnapshot, type Snapshot } from '../sim/snapshot';
import type { AIDifficulty } from '../sim/ai';

/** SaveFile envelope version. Bump if SaveMetadata changes shape. */
export const SAVEFILE_VERSION = 1;

/** Manual save slots plus the rolling autosave. */
export const SAVE_SLOTS = ['slot-1', 'slot-2', 'slot-3'] as const;
export const AUTOSAVE_SLOT = 'autosave';
export type SaveSlotId = (typeof SAVE_SLOTS)[number] | typeof AUTOSAVE_SLOT;

/** Display names for the slots (UI copy lives in ui/strings.ts). */
export const SAVE_SLOT_IDS: SaveSlotId[] = [AUTOSAVE_SLOT, ...SAVE_SLOTS];

export interface SaveMetadata {
  /** Slot id: 'autosave' | 'slot-1' | 'slot-2' | 'slot-3'. */
  slotId: SaveSlotId;
  /** Player-visible label, e.g. "Slot 1". */
  name: string;
  /** ISO-8601 wall-clock time of the save (display only, never sim). */
  savedAt: string;
  /** Sim tick the snapshot was taken at. */
  tick: number;
  /** Session seed (display/diagnostics). */
  seed: number;
  /** Classic AI rival difficulty. */
  aiDifficulty: AIDifficulty;
  /** Current age + National Program (null program in Foundation). */
  age: string;
  program: string | null;
  /** True once any cheat console command has run in this session. */
  cheated: boolean;
}

export interface SaveFile {
  version: number;
  metadata: SaveMetadata;
  snapshot: Snapshot;
}

/**
 * Build a SaveFile from a live session. The snapshot is a deep copy;
 * mutating the world afterwards never affects the file.
 */
export function createSaveFile(
  session: GameSession,
  slotId: SaveSlotId,
  name: string,
  savedAtIso: string,
): SaveFile {
  const world = session.world;
  return {
    version: SAVEFILE_VERSION,
    metadata: {
      slotId,
      name,
      savedAt: savedAtIso,
      tick: world.tick,
      seed: session.seed,
      aiDifficulty: session.aiDifficulty,
      age: world.ages.age,
      program: world.ages.program,
      cheated: session.cheated,
    },
    snapshot: takeSnapshot(world),
  };
}

/** Lightweight summary for the load-game list (no snapshot payload). */
export function summarizeSave(file: SaveFile): SaveMetadata {
  return file.metadata;
}
