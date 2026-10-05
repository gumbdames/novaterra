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
 * NOVATERRA — ui/reactor.ts — the nuclear reactor upgrade UI contract
 * (pure, tested, `tests/ui.reactor.test.ts`).
 *
 * The UI-side mirror of the sim's `upgradeBuilding` command validation
 * (sim/city.ts): `reactorUpgradeBlockReason` returns the Add Reactor
 * button's disabled reason — null exactly when the sim would accept
 * the order — mirroring the sim's validate order (kind / construction
 * done / no upgrade in flight / below max reactors / affordable). The
 * sim remains the authority and rejects loudly; the UI never
 * re-implements validation, it only previews it (the
 * `emergencyRefuelBlockReason` precedent in ui/logistics.ts).
 *
 * `canAffordReactorUpgrade` is the funds/materials gate on its own —
 * the selection-panel digest (`br:` segment in ui/paletteDigest.ts)
 * needs just the affordability bit, and the block reason is built on
 * top of it so the two can never drift.
 *
 * Reads sim state defensively, never writes it. Headless-safe (no DOM).
 */

import {
  NUCLEAR_MAX_REACTORS,
  NUCLEAR_UPGRADE_COST_FUNDS,
  NUCLEAR_UPGRADE_COST_MATERIALS,
  getPlayer,
} from '../sim/city';
import type { BuildingRecord } from '../sim/city';
import type { World } from '../sim/world';

/**
 * The funds/materials gate for the reactor upgrade — the same check
 * the Add Reactor button applies. Exported so the digest can carry
 * exactly the affordability bit the panel renders.
 */
export function canAffordReactorUpgrade(world: World, owner: number): boolean {
  const player = getPlayer(world.city, owner);
  return (
    player !== undefined &&
    player.funds >= NUCLEAR_UPGRADE_COST_FUNDS &&
    player.materials >= NUCLEAR_UPGRADE_COST_MATERIALS
  );
}

/**
 * The Add Reactor button's disabled reason — null when the sim would
 * accept an `upgradeBuilding` order for this building. Mirrors the
 * sim's validate order; plain English (the emergencyRefuelBlockReason
 * precedent — rejection-adjacent strings are not localized).
 */
export function reactorUpgradeBlockReason(world: World, b: BuildingRecord): string | null {
  if (b.kind !== 'nuclearPlant') return 'not a nuclear plant';
  if (b.progress < 1) return 'still under construction';
  if (b.upgradeProgress !== undefined) return 'upgrade already in progress';
  if ((b.reactors ?? 1) >= NUCLEAR_MAX_REACTORS) {
    return `already at the maximum of ${NUCLEAR_MAX_REACTORS} reactors`;
  }
  if (!canAffordReactorUpgrade(world, b.owner)) {
    return `needs ${NUCLEAR_UPGRADE_COST_FUNDS} funds + ${NUCLEAR_UPGRADE_COST_MATERIALS} materials`;
  }
  return null;
}
