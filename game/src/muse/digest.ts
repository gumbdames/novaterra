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
 * NOVATERRA — muse/digest.ts — Muse Commander battle digest.
 *
 * Builds the compact, JSON-safe snapshot of the game that is sent to the
 * player's own Anthropic API key when they pick the "Muse" rival
 * difficulty. Two hard fairness rules are structural here, not just
 * promised in docs:
 *
 * 1. **Fog of war.** The digest carries the Muse owner's full state, but
 *    enemy units/buildings are filtered through `isVisibleTo()` — the
 *    exact same sight rule the Classic AI plays by. Muse can never see a
 *    hidden unit or building, no matter what the model asks for.
 * 2. **Size.** The digest is capped so its serialized JSON stays under
 *    2 KB: at most 40 visible enemy units and 40 visible enemy buildings,
 *    rounded coordinates, no strings that grow with game time.
 *
 * Pure module: no DOM, no fetch, no wall clock, no randomness.
 * Safe under Node/vitest.
 */

import type { World } from '../sim/world';
import { isVisibleTo, getVisibleEnemies } from '../sim/ai';
import { getPlayer, cellCoords, cellIndex, CELL_WORLD_SIZE, MAP_HALF_SIZE } from '../sim/city';
import { rawToWorldHeight, type TerrainData } from '../sim/terrain';

/** Maximum enemy entries in the digest (keeps JSON under 2 KB). */
export const DIGEST_MAX_UNITS = 20;
export const DIGEST_MAX_BUILDINGS = 20;

/** A visible enemy unit: kind + position, nothing else. */
export interface DigestEnemyUnit {
  kind: string;
  x: number;
  z: number;
}

/** A visible enemy building: kind + position, nothing else. */
export interface DigestEnemyBuilding {
  kind: string;
  x: number;
  z: number;
}

/**
 * The battle digest sent to the Muse API. JSON-safe by construction
 * (numbers, strings, plain objects and arrays only).
 */
export interface CommanderDigest {
  game: 'novaterra';
  tick: number;
  age: string;
  map: { size: number; waterPct: number };
  me: {
    funds: number;
    materials: number;
    fuel: number;
    food: number;
    goods: number;
    influence: number;
    manpower: number;
    population: number;
    /** Unit counts by kind (Muse's own army). */
    units: Record<string, number>;
    /** Building counts by kind (Muse's own buildings). */
    buildings: Record<string, number>;
  };
  /** Only what the Muse owner can actually see. */
  enemy: {
    units: DigestEnemyUnit[];
    buildings: DigestEnemyBuilding[];
  };
}

function roundPos(n: number): number {
  // Whole map units are plenty for strategic reasoning and keep the
  // digest compact.
  return Math.round(n);
}

/**
 * Estimate a terrain's water coverage (0–100) by sampling the
 * heightfield. Run once per game, not per digest — the digest only
 * needs an approximate number for naval reasoning.
 */
export function computeWaterPct(terrain: TerrainData): number {
  const heights = terrain.heights;
  let water = 0;
  let total = 0;
  for (let i = 0; i < heights.length; i += 4) {
    total += 1;
    if (rawToWorldHeight(heights[i]!) < terrain.waterLevel) water += 1;
  }
  return total === 0 ? 0 : Math.round((water / total) * 100);
}

/**
 * Build the commander digest for `ownerId`. Enemy entries are strictly
 * fog-filtered; own state is complete. Deterministic for a given world.
 */
export function buildCommanderDigest(
  world: World,
  ownerId: number,
  map: { size: number; waterPct: number },
): CommanderDigest {
  const player = getPlayer(world.city, ownerId);

  const units: Record<string, number> = {};
  for (const u of world.units) {
    if (u.owner !== ownerId || u.hp <= 0) continue;
    units[u.kind] = (units[u.kind] ?? 0) + 1;
  }

  const buildings: Record<string, number> = {};
  for (const b of world.city.buildings) {
    if (b.owner !== ownerId) continue;
    buildings[b.kind] = (buildings[b.kind] ?? 0) + 1;
  }

  // Enemy units: strictly the fog-filtered set (same rule as Classic AI).
  const enemyUnits: DigestEnemyUnit[] = [];
  for (const e of getVisibleEnemies(world, ownerId)) {
    if (enemyUnits.length >= DIGEST_MAX_UNITS) break;
    enemyUnits.push({ kind: e.kind, x: roundPos(e.x), z: roundPos(e.z) });
  }

  // Enemy buildings: only those within sight of a Muse-owned unit.
  const enemyBuildings: DigestEnemyBuilding[] = [];
  const seen = new Set<number>();
  for (const b of world.city.buildings) {
    if (b.owner === ownerId || seen.has(b.id)) continue;
    if (enemyBuildings.length >= DIGEST_MAX_BUILDINGS) break;
    const { cx, cz } = cellCoords(cellIndex(b.cx, b.cz));
    const wx = cx * CELL_WORLD_SIZE - MAP_HALF_SIZE + CELL_WORLD_SIZE / 2;
    const wz = cz * CELL_WORLD_SIZE - MAP_HALF_SIZE + CELL_WORLD_SIZE / 2;
    if (isVisibleTo(world, ownerId, wx, wz)) {
      seen.add(b.id);
      enemyBuildings.push({ kind: b.kind, x: roundPos(wx), z: roundPos(wz) });
    }
  }

  return {
    game: 'novaterra',
    tick: world.tick,
    age: world.ages.age,
    map: { size: map.size, waterPct: map.waterPct },
    me: {
      funds: Math.round(player?.funds ?? 0),
      materials: Math.round(player?.materials ?? 0),
      fuel: Math.round(player?.fuel ?? 0),
      food: Math.round(player?.food ?? 0),
      goods: Math.round(player?.goods ?? 0),
      influence: Math.round(player?.influence ?? 0),
      manpower: Math.round(player?.manpower ?? 0),
      population: Math.round(player?.population ?? 0),
      units,
      buildings,
    },
    enemy: { units: enemyUnits, buildings: enemyBuildings },
  };
}
