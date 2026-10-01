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
 * NOVATERRA — campaign/progress.ts — campaign progress + the two endings
 * (Phase 2).
 *
 * Responsibilities:
 *  - `CampaignProgress`: completed mission ids, diplomat vs commander
 *    points. Plain JSON-safe data.
 *  - `scoreMission(kills, unitsLost)`: pure scoring — bloodless, lossless
 *    missions earn diplomat points; destroying enemies earns commander
 *    points. Decides the campaign ending (see `campaignEnding`).
 *  - `isMissionUnlocked(progress, mission)`: mission 1 is open; a mission
 *    unlocks when the previous one (by order) is complete.
 *  - `CampaignStore`: async load/save/reset of the progress, IndexedDB
 *    when available (`novaterra-campaign` database), in-memory Map
 *    fallback otherwise. Never throws — same contract as netSave/store.
 *  - No DOM, no sim — safe under Node/vitest.
 */

import { missionsInOrder, type MissionDef } from './missions';

export interface CampaignProgress {
  /** Mission ids completed, in completion order. */
  completed: string[];
  diplomat: number;
  commander: number;
}

export function emptyProgress(): CampaignProgress {
  return { completed: [], diplomat: 0, commander: 0 };
}

/**
 * Score a finished mission. Bloodless and lossless play is diplomatic;
 * destroying enemies is commanding. Pure and deterministic.
 */
export function scoreMission(
  kills: number,
  unitsLost: number,
): { diplomat: number; commander: number } {
  let diplomat = 0;
  let commander = 0;
  if (kills === 0) diplomat += 2;
  if (unitsLost === 0) diplomat += 1;
  if (kills >= 30) commander += 2;
  else if (kills > 0) commander += 1;
  return { diplomat, commander };
}

/** Record a mission completion into the progress (returns a new object). */
export function recordCompletion(
  progress: CampaignProgress,
  missionId: string,
  kills: number,
  unitsLost: number,
): CampaignProgress {
  const score = scoreMission(kills, unitsLost);
  const completed = progress.completed.includes(missionId)
    ? progress.completed
    : [...progress.completed, missionId];
  return {
    completed,
    diplomat: progress.diplomat + score.diplomat,
    commander: progress.commander + score.commander,
  };
}

/** Mission 1 is always open; others unlock when the previous is done. */
export function isMissionUnlocked(
  progress: CampaignProgress,
  mission: MissionDef,
): boolean {
  if (mission.order <= 1) return true;
  const prev = missionsInOrder().find((m) => m.order === mission.order - 1);
  return prev !== undefined && progress.completed.includes(prev.id);
}

/** The two campaign endings. Ties go to the peacemaker. */
export type CampaignEnding = 'peacemaker' | 'commander';

export function campaignEnding(progress: CampaignProgress): CampaignEnding {
  return progress.commander > progress.diplomat ? 'commander' : 'peacemaker';
}

export const ENDING_COPY: Record<
  CampaignEnding,
  { title: string; text: string }
> = {
  peacemaker: {
    title: 'The Peacemaker',
    text:
      'Four years, and the republic never had to become what it fought. ' +
      'Treaties signed, grids wired, granaries full — history will call ' +
      'your term the one where a nation chose to build instead of burn. ' +
      'The people re-elect you in a landslide.',
  },
  commander: {
    title: 'The Commander',
    text:
      'Peace through strength — your strength. The separatists are ' +
      'scattered, the borders quiet, the straits safe. Historians will ' +
      'debate the cost, but none will debate the result: the republic ' +
      'stands, unbroken, because you refused to let it fall.',
  },
};

// ---------------------------------------------------------------------------
// Persistence (IndexedDB with in-memory fallback; never throws).
// ---------------------------------------------------------------------------

const DB_NAME = 'novaterra-campaign';
const DB_VERSION = 1;
const STORE_NAME = 'progress';
const ROW_KEY = 'campaign';

export interface CampaignStore {
  readonly backend: 'indexeddb' | 'memory';
  load(): Promise<CampaignProgress>;
  save(progress: CampaignProgress): Promise<boolean>;
  reset(): Promise<boolean>;
}

function isValidProgress(p: unknown): p is CampaignProgress {
  if (typeof p !== 'object' || p === null) return false;
  const c = (p as { completed?: unknown }).completed;
  const d = (p as { diplomat?: unknown }).diplomat;
  const cm = (p as { commander?: unknown }).commander;
  return (
    Array.isArray(c) &&
    c.every((x) => typeof x === 'string') &&
    typeof d === 'number' &&
    typeof cm === 'number'
  );
}

function createMemoryCampaignStore(): CampaignStore {
  let progress: CampaignProgress = emptyProgress();
  return {
    backend: 'memory',
    async load(): Promise<CampaignProgress> {
      return { ...progress, completed: [...progress.completed] };
    },
    async save(p: CampaignProgress): Promise<boolean> {
      progress = { ...p, completed: [...p.completed] };
      return true;
    },
    async reset(): Promise<boolean> {
      progress = emptyProgress();
      return true;
    },
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

/** Async factory: IndexedDB when available, memory fallback otherwise. */
export async function createCampaignStore(): Promise<CampaignStore> {
  try {
    if (typeof indexedDB === 'undefined') return createMemoryCampaignStore();
    const db = await openDb();
    const store: CampaignStore = {
      backend: 'indexeddb',
      load(): Promise<CampaignProgress> {
        return new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(ROW_KEY);
            req.onsuccess = () => {
              const v = req.result as unknown;
              resolve(isValidProgress(v) ? v : emptyProgress());
            };
            req.onerror = () => resolve(emptyProgress());
          } catch {
            resolve(emptyProgress());
          }
        });
      },
      save(progress: CampaignProgress): Promise<boolean> {
        return new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).put(
              { ...progress, completed: [...progress.completed] },
              ROW_KEY,
            );
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        });
      },
      reset(): Promise<boolean> {
        return new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).delete(ROW_KEY);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        });
      },
    };
    return store;
  } catch {
    return createMemoryCampaignStore();
  }
}
