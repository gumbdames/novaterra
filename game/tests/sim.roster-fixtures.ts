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
 * Shared fixtures for roster-expansion-era tests (NOT a test suite — no
 * `.test.ts` suffix, so vitest never runs it directly).
 *
 * Since the roster expansion, `spawnUnit` deducts training funds/materials
 * and requires a completed production building for gated units. Tests that
 * don't run the economy provision those directly through these helpers
 * instead of playing the construction game.
 */
import type { World } from '../src/sim/world';
import { getPlayer, type BuildingKind } from '../src/sim/city';

/** Grant abundant stockpiles so training costs never block test spawns. */
export function grantTrainingResources(world: World, owner: number, amount = 1_000_000): void {
  const p = getPlayer(world.city, owner);
  if (!p) throw new Error(`grantTrainingResources: unknown owner ${owner}`);
  p.funds = Math.max(p.funds, amount);
  p.materials = Math.max(p.materials, amount);
  p.manpower = Math.max(p.manpower, 10000);
}

/** Grant training resources to every player. */
export function grantAllTrainingResources(world: World, amount = 1_000_000): void {
  for (const p of world.city.players) grantTrainingResources(world, p.id, amount);
}

/**
 * Place a completed, operational building directly into city state
 * (bypasses road adjacency / construction time — a fixture shortcut).
 */
export function completeBuilding(
  world: World,
  kind: BuildingKind,
  owner: number,
  cx = 10,
  cz = 10,
): void {
  world.city.buildings.push({
    id: world.city.nextBuildingId++,
    kind,
    owner,
    cx,
    cz,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  });
}

/** Complete several buildings for an owner, spaced along a row. */
export function completeBuildings(
  world: World,
  owner: number,
  kinds: BuildingKind[],
  cx = 10,
  cz = 10,
): void {
  kinds.forEach((kind, i) => completeBuilding(world, kind, owner, cx + i * 6, cz));
}
