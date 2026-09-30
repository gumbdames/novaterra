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
 * NOVATERRA — ui/placement.ts — placement click resolution (pure).
 *
 * The game controller's map-click path funnels through these resolvers
 * before anything reaches the sim: given the armed palette tool and the
 * picked map cell/point, resolve to either a concrete `OrderIntent`
 * (built with the ui/orders.ts builders — the exact structs the click
 * path enqueues) or a human-readable hint for the HUD toast.
 *
 * Nothing here fails silently: every input maps to an order or a hint.
 * The controller toasts hints with an error cue, so a click that cannot
 * place always tells the player why.
 *
 * Pure module: safe under Node/vitest.
 */

import type { BuildTool } from './hud';
import {
  buildDemolishOrder,
  buildPlaceBuildingOrder,
  buildPowerLineOrder,
  buildRailOrder,
  buildRoadOrder,
  buildTrainOrder,
  buildWaterPipeOrder,
  type OrderIntent,
} from './orders';
import { STRINGS } from './strings';
import { CITY_GRID_CELLS, type RoadClass } from '../sim/city';

/** A picked city-grid cell (from the controller's worldToCell). */
export interface CellRef {
  cx: number;
  cz: number;
}

/** A picked ground point (from the controller's groundPoint). */
export interface PointRef {
  x: number;
  z: number;
}

/** What a placement click means: an order to enqueue, or a hint to toast. */
export type PlacementResolution =
  | { kind: 'order'; intent: OrderIntent }
  | { kind: 'hint'; message: string };

/**
 * Resolve a build-palette click. `cell` is null when the picked point is
 * off the city grid (or the pick ray missed the ground entirely).
 * `roadClass` is the road tool's selected class (single-cell road
 * click-paves use it).
 */
export function resolveBuildToolClick(
  tool: BuildTool,
  owner: number,
  cell: CellRef | null,
  roadClass: RoadClass = 'paved',
): PlacementResolution {
  if (cell === null) {
    return { kind: 'hint', message: STRINGS.orders.buildFailed };
  }
  if (tool === 'road') {
    return {
      kind: 'order',
      intent: buildRoadOrder(owner, [cell.cz * CITY_GRID_CELLS + cell.cx], roadClass),
    };
  }
  // Phase 2 (utilities): network tools paint the single clicked cell —
  // same as roads, the sim command lands with the Phase 2 sim workstream.
  if (tool === 'powerLine') {
    return {
      kind: 'order',
      intent: buildPowerLineOrder(owner, [cell.cz * CITY_GRID_CELLS + cell.cx]),
    };
  }
  if (tool === 'waterPipe') {
    return {
      kind: 'order',
      intent: buildWaterPipeOrder(owner, [cell.cz * CITY_GRID_CELLS + cell.cx]),
    };
  }
  // Phase 4 (transport): the rail tool click-paves the single cell with
  // standard track (the drag path is the primary use).
  if (tool === 'rail') {
    return {
      kind: 'order',
      intent: buildRailOrder(owner, [cell.cz * CITY_GRID_CELLS + cell.cx]),
    };
  }
  if (tool === 'demolish') {
    return {
      kind: 'order',
      intent: buildDemolishOrder(owner, cell.cx, cell.cz),
    };
  }
  if (tool.startsWith('building:')) {
    const kind = tool.slice('building:'.length);
    return {
      kind: 'order',
      intent: buildPlaceBuildingOrder(kind, owner, cell.cx, cell.cz),
    };
  }
  // Zone tools are drag-only: a click paints nothing, so say so instead
  // of silently swallowing the click.
  return { kind: 'hint', message: STRINGS.orders.zoneNeedsDrag };
}

/**
 * Resolve a train-palette click. `point` is null when the pick ray missed
 * the ground (e.g. the player clicked the sky).
 */
export function resolveTrainClick(
  unitKind: string,
  owner: number,
  point: PointRef | null,
): PlacementResolution {
  if (point === null) {
    return { kind: 'hint', message: STRINGS.orders.trainFailed };
  }
  return {
    kind: 'order',
    intent: buildTrainOrder(unitKind, owner, point.x, point.z),
  };
}
