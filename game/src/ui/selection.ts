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
 * NOVATERRA — ui/selection.ts — selection state and picking helpers.
 *
 * Responsibilities:
 *  - Own the player's selection as plain data: selected unit ids plus an
 *    optional selected building id. Units and buildings are mutually
 *    exclusive selections (selecting one clears the other).
 *  - Pure picking helpers: `boxSelectUnits` filters a unit list against a
 *    world-space rectangle (the caller converts the screen drag-rect to
 *    world space via a ground-plane raycast). `nearestUnit` picks the
 *    closest unit to a click point within a tolerance.
 *
 * Picking itself (raycasting) lives in ui/game.ts — this module only does
 * the data filtering, so it is fully unit-testable with no DOM/three.js.
 *
 * Pure module: safe under Node/vitest.
 */

/** Minimal unit shape needed for picking. Matches UnitRecord's fields. */
export interface PickableUnit {
  id: number;
  owner: number;
  x: number;
  z: number;
  hp: number;
}

/** The player's current selection. Plain data. */
export interface Selection {
  /** Selected unit ids (player-owned only, enforced by callers). */
  unitIds: number[];
  /** Selected building id, or null. Cleared when units are selected. */
  buildingId: number | null;
}

/** Empty selection. */
export function createSelection(): Selection {
  return { unitIds: [], buildingId: null };
}

/** Replace the unit selection (clears any building selection). */
export function selectUnits(ids: number[]): Selection {
  return { unitIds: [...ids], buildingId: null };
}

/** Select a single building (clears any unit selection). */
export function selectBuilding(id: number): Selection {
  return { unitIds: [], buildingId: id };
}

/** Clear everything. */
export function clearSelection(): Selection {
  return { unitIds: [], buildingId: null };
}

/** True when nothing is selected. */
export function isSelectionEmpty(sel: Selection): boolean {
  return sel.unitIds.length === 0 && sel.buildingId === null;
}

/**
 * Toggle one unit id in the selection (shift-click behavior). Keeps
 * building selection cleared — mixed unit/building selections are not
 * supported in 0.1 Alpha.
 */
export function toggleUnit(sel: Selection, id: number): Selection {
  const idx = sel.unitIds.indexOf(id);
  const unitIds =
    idx === -1 ? [...sel.unitIds, id] : sel.unitIds.filter((u) => u !== id);
  return { unitIds, buildingId: null };
}

/**
 * Box-select: return the ids of living units owned by `owner` whose (x, z)
 * falls inside the world-space rectangle. Rectangle corners may be given in
 * any order. Deterministic: output follows the input array order.
 */
export function boxSelectUnits(
  units: PickableUnit[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  owner: number,
): number[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  const out: number[] = [];
  for (const u of units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    if (u.x >= minX && u.x <= maxX && u.z >= minZ && u.z <= maxZ) out.push(u.id);
  }
  return out;
}

/**
 * Click-pick: the nearest living unit to (x, z) within `tolerance` world
 * units, or null. Ties break by lowest id (deterministic).
 */
export function nearestUnit(
  units: PickableUnit[],
  x: number,
  z: number,
  tolerance: number,
): PickableUnit | null {
  let best: PickableUnit | null = null;
  let bestD2 = tolerance * tolerance;
  for (const u of units) {
    if (u.hp <= 0) continue;
    const dx = u.x - x;
    const dz = u.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2 || (d2 === bestD2 && best !== null && u.id < best.id)) {
      best = u;
      bestD2 = d2;
    }
  }
  return best;
}

/**
 * Remove ids that no longer exist (units died, buildings demolished).
 * Returns a new selection; the input is untouched.
 */
export function pruneSelection(
  sel: Selection,
  liveUnitIds: Set<number>,
  liveBuildingIds: Set<number>,
): Selection {
  const unitIds = sel.unitIds.filter((id) => liveUnitIds.has(id));
  const buildingId =
    sel.buildingId !== null && liveBuildingIds.has(sel.buildingId)
      ? sel.buildingId
      : null;
  return { unitIds, buildingId };
}
