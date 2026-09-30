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
 * NOVATERRA — render/terrainHeight.ts — terrain-riding Y placement rules.
 *
 * Pure helpers (no three.js, no DOM): given the sim's TerrainData, where
 * should an entity's ground-anchored group sit on the Y axis?
 * `heightAt` is a pure function of terrain, so every rule here is
 * deterministic — same terrain ⇒ same Y on every frame and every
 * machine. These rules live in one place so units, buildings, roads,
 * selection rings, and FX all agree on the ground.
 *
 * Import-safe under Node/vitest (only sim/terrain, no DOM).
 */

import { heightAt, type TerrainData } from '../sim/terrain';

/** Unit movement domains, mirroring `UnitDomain` in sim/units.ts. */
export type HeightDomain = 'land' | 'air' | 'sea';

/** Land units ride just above the ground (anti z-fight epsilon). */
export const UNIT_GROUND_EPSILON = 0.15;
/** The spectre gunship hovers at 1.6 (legacy `HOVER_Y` read). */
export const SPECTRE_HOVER_Y = 1.6;
/** Fixed-wing aircraft hover at 14 above the terrain beneath them. */
export const AIR_HOVER_Y = 14;
/** Buildings rest their foundation just above the terrain at center. */
export const BUILDING_GROUND_EPSILON = 0.05;
/** Selection rings float above the ground point under the unit. */
export const SELECTION_RING_OFFSET = 0.3;

/**
 * Ground Y under an entity at (x, z): the terrain height for land and
 * air entities (aircraft use the ground *beneath* them; the hover gap is
 * applied separately), the water level for sea entities. A `null`
 * terrain (headless tests without terrain) ⇒ 0 (legacy behavior).
 */
export function groundYAt(
  terrain: TerrainData | null,
  waterLevel: number,
  domain: HeightDomain,
  x: number,
  z: number,
): number {
  if (terrain === null) return 0;
  if (domain === 'sea') return waterLevel;
  return heightAt(terrain, x, z);
}

/**
 * Group-relative hover lift for a unit: land units sit at
 * UNIT_GROUND_EPSILON above their ground point (the spectre gunship
 * keeps its 1.6 hover), aircraft hover at AIR_HOVER_Y above the terrain
 * below, and sea units ride the waterline (0 relative — the waterline is
 * baked into the models via the models.ts yOffset).
 */
export function unitHoverY(domain: HeightDomain, kind: string): number {
  if (domain === 'air') return AIR_HOVER_Y;
  if (domain === 'sea') return 0;
  return kind === 'spectre' ? SPECTRE_HOVER_Y : UNIT_GROUND_EPSILON;
}
