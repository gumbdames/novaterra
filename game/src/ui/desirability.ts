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
 * NOVATERRA — ui/desirability.ts — workstream W UI/render contract
 * (pure, headless-safe).
 *
 * Responsibilities:
 *  - The single choke point between the UI/render layers and the
 *    desirability sim workstream (sim/desirability.ts): the selection
 *    panel's land-value line ("Land: Nice (64) · tax ×1.3") and the
 *    read-only per-frame view the desirability overlay renders.
 *  - Reads every sim field defensively (empty pre-sim → empty view),
 *    never writes sim state.
 *
 * SIM CONTRACT (workstream W sim workstream — VERIFIED 2026-09-30 against
 * the sim's committed code; names match exactly):
 *  - `getDesirabilityModel(t, world)` (sim/desirability.ts): the derived
 *    model, cached on structural change (never per tick). `values` is a
 *    Map of residential-zone cell → integer 0..100.
 *  - `landValueTier(d)` → `{ name, taxMultiplier }`; `LAND_VALUE_TIERS`
 *    (low ×0.8 / modest ×1.0 / nice ×1.3 / prime ×1.7).
 *  - `buildingLandValue(model, b)` (mean over the footprint cells);
 *    `buildingTaxMultiplier(model, b)`.
 *  - `STRINGS.desirability` carries the overlay toggle/legend, tier
 *    display names, and the land-value line template.
 */

import type { TerrainData } from '../sim/terrain';
import type { World } from '../sim/world';
import { BUILDING_DEFS, ZoneType, type BuildingRecord } from '../sim/city';
import {
  buildingLandValue,
  buildingTaxMultiplier,
  getDesirabilityModel,
  landValueTier,
  type DesirabilityModel,
} from '../sim/desirability';
import { STRINGS, fillLoc, loc } from './strings';

/** Re-exported so hud.ts/game.ts can thread the model without importing sim. */
export type { DesirabilityModel };

/**
 * Selection-panel land-value line for one building, e.g.
 * "Land: Nice (64) · tax ×1.3". Returns null for non-residential
 * buildings (land value is a residential concept — civic/commercial/
 * industrial buildings show no line).
 */
export function landValueLine(
  model: DesirabilityModel | null | undefined,
  b: BuildingRecord,
): string | null {
  const def = BUILDING_DEFS[b.kind];
  if (def === undefined || def.zone !== ZoneType.RESIDENTIAL) return null;
  if (model === undefined || model === null) return null;
  const value = Math.round(buildingLandValue(model, b));
  const tier = landValueTier(value);
  const names = STRINGS.desirability.tierNames[tier.name];
  return fillLoc(STRINGS.desirability.landValueLine, {
    tier: loc(names),
    score: value,
    mult: tier.taxMultiplier,
  });
}

/**
 * The land-value tax multiplier the sim applies to this building right
 * now. Used by the selection-panel digest (paletteDigest.ts) so the panel
 * rebuilds exactly when the rendered "tax ×N" would change.
 */
export function landValueTaxMultOf(
  model: DesirabilityModel | null | undefined,
  b: BuildingRecord,
): number {
  if (model === undefined || model === null) return 1;
  return buildingTaxMultiplier(model, b);
}

/** One tinted cell for the desirability overlay. */
export interface DesirabilityOverlayCell {
  cell: number;
  /** Integer 0–100 desirability. */
  value: number;
}

/** Read-only per-frame view for the desirability overlay. */
export interface DesirabilityOverlayData {
  /** Model cache key — the overlay rebuilds only when this changes. */
  key: string;
  /** Residential-zone cells with their desirability (sorted by cell). */
  cells: DesirabilityOverlayCell[];
}

/**
 * The desirability overlay's data: every residential-zone cell with its
 * 0–100 score. The sim model is cached on structural change, so this is
 * cheap per frame (one key compare + a sorted iteration). Defensive:
 * a missing/empty city yields an empty view.
 */
export function desirabilityOverlayData(
  t: TerrainData | null | undefined,
  world: World | null | undefined,
): DesirabilityOverlayData {
  if (t === undefined || t === null || world === undefined || world === null) {
    return { key: '', cells: [] };
  }
  const model = getDesirabilityModel(t, world);
  const cells: DesirabilityOverlayCell[] = [];
  for (const [cell, value] of model.values) {
    cells.push({ cell, value });
  }
  cells.sort((a, b) => a.cell - b.cell);
  return { key: model.key, cells };
}
