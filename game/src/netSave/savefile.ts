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
 * NOVATERRA — netSave/savefile.ts — versioned save-file format.
 *
 * Responsibilities:
 *  - `SaveFile`: `{ version, metadata, snapshot }` — the unit persisted
 *    by the store. The snapshot is the sim's own versioned format
 *    (sim/snapshot.ts, currently v4); the SaveFile envelope has its own
 *    version so slot metadata can evolve without touching the sim.
 *  - `SaveMetadata`: everything the load-game UI shows without reading
 *    the (potentially large) snapshot: slot id, display name, save time,
 *    tick, age, National Program, AI difficulty, seed, the map preset
 *    name the session was generated on, the campaign mission id when
 *    the save came from a campaign mission, and whether any cheat was
 *    used in the session (`cheated`).
 *  - `createSaveFile(session, slotId, name)`: build a SaveFile from a
 *    live GameSession. Deep-copies via takeSnapshot — the file never
 *    aliases live world state.
 *  - `saveMapPreset(file, missionMapPreset?)`: the map preset name the
 *    load path must regenerate terrain from. The save's own name wins;
 *    the mission def is the fallback for saves that predate the field;
 *    'Meridian Plains' is the last-resort default (matches the historic
 *    load behavior).
 *
 * Save/load contract notes (R1-C):
 *  - The sim command queue is session-owned and is NEVER persisted:
 *    pending commands (orders due on a later tick, self-scheduled
 *    cleanups like `resupplyTimeout`) are deliberately dropped on
 *    save/load. See ui/session.ts createSession for the reservation
 *    release that keeps the drop leak-free.
 *  - `mapPreset`/`campaignMissionId` are optional on the type so saves
 *    written before the R1-C fix still load — readers default them
 *    (see `saveMapPreset`). Purely additive, no envelope bump (the AD9
 *    neutral-default precedent; see docs/grand-expansion/PLAN.md §11).
 *
 * Pure data module: no DOM, no IndexedDB, no wall clock (the caller
 * stamps `savedAt`). Safe under Node/vitest.
 */

import type { GameSession } from '../ui/session';
import { takeSnapshot, SNAPSHOT_VERSION, OLDEST_SUPPORTED_SNAPSHOT_VERSION, type Snapshot } from '../sim/snapshot';
import { getAgeState } from '../sim/ages';
import type { AIDifficulty } from '../sim/ai';

/** SaveFile envelope version. Bump on a BREAKING SaveMetadata shape change. */
export const SAVEFILE_VERSION = 1;
// NOTE: SAVEFILE_VERSION stays 1 for the R1-C metadata additions —
// `mapPreset`/`campaignMissionId` are optional with load-time defaults,
// so older files keep loading unchanged (the AD9 purely-additive
// precedent from docs/grand-expansion/PLAN.md §11).

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
  /**
   * Map preset name this save's terrain was generated from (R1-C/C4).
   * Optional: saves written before the R1-C fix lack it — loaders use
   * `saveMapPreset()` to default it to 'Meridian Plains'.
   */
  mapPreset?: string;
  /**
   * Campaign mission id when this save came from a campaign mission
   * (R1-C/C4); null/absent for skirmish, sandbox, and peaceful saves.
   * The load path uses it as the map fallback when `mapPreset` is
   * absent, and records which mission the save belongs to.
   */
  campaignMissionId?: string | null;
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
      // Per-side ages (2026-10-01, roadmap A1): the save summary shows
      // the human player's own age (owner 0) — rivals advance alone.
      age: getAgeState(world, 0).age,
      program: getAgeState(world, 0).program,
      // R1-C/C4: the session records the RESOLVED preset name (never
      // the raw option) and the mission id, so the load path can
      // regenerate the exact terrain this save was played on.
      mapPreset: session.mapPreset,
      campaignMissionId: session.campaignMissionId,
      cheated: session.cheated,
    },
    snapshot: takeSnapshot(world),
  };
}

/** Lightweight summary for the load-game list (no snapshot payload). */
export function summarizeSave(file: SaveFile): SaveMetadata {
  return file.metadata;
}

/**
 * The map preset name a save should load with (R1-C/C4). Precedence:
 * the save's own `mapPreset` (it names the terrain actually generated),
 * then the campaign mission def's preset (covers saves that predate
 * the metadata field but carry a mission id), then 'Meridian Plains'
 * (the historic load default — matches what old saves always got).
 * Pure and testable.
 */
export function saveMapPreset(
  file: SaveFile,
  missionMapPreset?: string,
): string {
  return file.metadata.mapPreset ?? missionMapPreset ?? 'Meridian Plains';
}

/**
 * Check whether a save file can be loaded by this version of the game.
 * Returns null when the save is compatible, or a plain-language message
 * explaining why it can't be loaded (no jargon, no version numbers).
 * Pure and testable.
 */
export function validateSaveVersion(file: SaveFile): string | null {
  const found = (file.snapshot as { version?: unknown } | null)?.version;
  // R1-C/M1: restoreSnapshot loads v5–v8, so the UI layer must accept
  // the same range — v6/v7 saves the sim can load were being rejected
  // here, breaking the documented "v5/v6/v7 still load" contract.
  if (
    typeof found === 'number' &&
    found >= OLDEST_SUPPORTED_SNAPSHOT_VERSION &&
    found <= SNAPSHOT_VERSION
  ) {
    return null;
  }
  return (
    'This save is from an older version of NOVATERRA and can\u2019t be loaded. ' +
    'Starting a new game is recommended \u2014 your other saves are unaffected.'
  );
}
