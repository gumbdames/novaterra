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
 * NOVATERRA — campaign/objectives.ts — mission objective checking
 * (Phase 2).
 *
 * Responsibilities:
 *  - Pure `checkObjective(world, playerId, aiId, objective, kills)`:
 *    every `ObjectiveDef` kind evaluated against live world state.
 *    Cumulative counters (enemy units destroyed) come from the mission
 *    run state — the sim itself never counts kills.
 *  - `checkPath(...)`: a path is complete when ALL its objectives are.
 *  - No DOM, no sim mutation — safe under Node/vitest.
 */

import type { World } from '../sim/world';
import { getPlayer } from '../sim/city';
import { getAgeState } from '../sim/ages';
import type { ObjectiveDef, MissionPath } from './missions';

/** Result of evaluating one objective. */
export interface ObjectiveProgress {
  complete: boolean;
  /** Human-readable progress, e.g. "3 / 5 houses". */
  progress: string;
}

/**
 * Evaluate one objective. `kills` is the mission-run count of enemy
 * units destroyed (tracked UI-side by the director, never sim state).
 */
export function checkObjective(
  world: World,
  playerId: number,
  aiId: number,
  objective: ObjectiveDef,
  kills: number,
): ObjectiveProgress {
  const player = getPlayer(world.city, playerId);
  switch (objective.kind) {
    case 'population': {
      const pop = player?.population ?? 0;
      return {
        complete: pop >= objective.count,
        progress: `${Math.floor(pop)} / ${objective.count}`,
      };
    }
    case 'stockpile': {
      const have = player ? (player[objective.resource] ?? 0) : 0;
      return {
        complete: have >= objective.count,
        progress: `${Math.floor(have)} / ${objective.count}`,
      };
    }
    case 'build': {
      const n = world.city.buildings.filter(
        (b) => b.owner === playerId && b.kind === objective.building && b.progress >= 1,
      ).length;
      return { complete: n >= objective.count, progress: `${n} / ${objective.count}` };
    }
    case 'train': {
      const n = world.units.filter(
        (u) => u.owner === playerId && u.kind === objective.unit && u.hp > 0,
      ).length;
      return { complete: n >= objective.count, progress: `${n} / ${objective.count}` };
    }
    case 'destroyUnits': {
      return { complete: kills >= objective.count, progress: `${kills} / ${objective.count}` };
    }
    case 'destroyAllEnemy': {
      const enemyUnits = world.units.filter((u) => u.owner === aiId && u.hp > 0).length;
      const enemyBuildings = world.city.buildings.filter((b) => b.owner === aiId).length;
      const remaining = enemyUnits + enemyBuildings;
      return { complete: remaining === 0, progress: remaining === 0 ? 'done' : `${remaining} left` };
    }
    case 'reachAge': {
      // Per-side ages (2026-10-01, roadmap A1): the mission player
      // reaches the age with THEIR OWN advancement — a rival's age
      // never completes the player's objective.
      const myAge = getAgeState(world, playerId).age;
      const reached = myAge === objective.age;
      return { complete: reached, progress: reached ? 'done' : `now: ${myAge}` };
    }
    case 'survive': {
      const alive = playerAlive(world, playerId);
      return {
        complete: alive && world.tick >= objective.ticks,
        progress: `${Math.floor(world.tick / 30)}s / ${Math.floor(objective.ticks / 30)}s`,
      };
    }
  }
}

/** True when the player still has any living unit or building. */
export function playerAlive(world: World, playerId: number): boolean {
  for (const u of world.units) {
    if (u.owner === playerId && u.hp > 0) return true;
  }
  for (const b of world.city.buildings) {
    if (b.owner === playerId) return true;
  }
  return false;
}

/** A path is complete when every objective in it is complete. */
export function checkPath(
  world: World,
  playerId: number,
  aiId: number,
  path: MissionPath,
  kills: number,
): { complete: boolean; objectives: ObjectiveProgress[] } {
  const objectives = path.objectives.map((o) => checkObjective(world, playerId, aiId, o, kills));
  return { complete: objectives.every((o) => o.complete), objectives };
}
