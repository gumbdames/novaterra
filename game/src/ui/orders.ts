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
 * NOVATERRA — ui/orders.ts — player intent → command payloads.
 *
 * Responsibilities:
 *  - Translate UI gestures (right-click move, right-click attack, stop key,
 *    train-unit click, build palette, age advance) into `NewCommand`
 *    objects for the sim command queue. The UI never builds raw payloads
 *    inline — every player order goes through these builders, so the
 *    command shapes are defined once and unit-tested once.
 *  - The caller enqueues with `issuer: 'player'`; these builders leave the
 *    issuer unset so tests and callers stay explicit.
 *
 * The sim still validates every command at enqueue AND apply time — these
 * builders only shape well-formed intents; they do not bypass validation.
 *
 * Pure module: safe under Node/vitest.
 */

import type { NewCommand } from '../sim/commands';
import type { NationalProgram } from '../sim/ages';
import {
  ROAD_CLASS_ORDER,
  roadClassAt,
  type RoadCell,
  type RoadClass,
  type TrackClass,
} from '../sim/city';

/**
 * A player intent without the issuer attached. The game controller adds
 * `issuer: 'player'` at enqueue time (the AI adds its own issuer the same
 * way) — one place owns the "who", these builders own the "what".
 */
export type OrderIntent = Omit<NewCommand, 'issuer'>;

/** Right-click on open ground: one unit → moveUnit, many → moveGroup. */
export function buildMoveOrder(
  unitIds: number[],
  owner: number,
  x: number,
  z: number,
): OrderIntent {
  if (unitIds.length === 1) {
    return {
      kind: 'moveUnit',
      payload: { unitId: unitIds[0], owner, x, z },
    };
  }
  return {
    kind: 'moveGroup',
    payload: { unitIds: [...unitIds], owner, x, z },
  };
}

/** Right-click on an enemy: one attackUnit per selected unit. */
export function buildAttackOrders(
  unitIds: number[],
  owner: number,
  targetId: number,
): OrderIntent[] {
  return unitIds.map((unitId) => ({
    kind: 'attackUnit',
    payload: { unitId, targetId, owner },
  }));
}

/** Stop key / stop button: one stopUnit per selected unit. */
export function buildStopOrders(unitIds: number[], owner: number): OrderIntent[] {
  return unitIds.map((unitId) => ({
    kind: 'stopUnit',
    payload: { unitId, owner },
  }));
}

/** Train panel: spawn one unit of `kind` at the clicked map point. */
export function buildTrainOrder(
  kind: string,
  owner: number,
  x: number,
  z: number,
): OrderIntent {
  return {
    kind: 'spawnUnit',
    payload: { kind, owner, x, z },
  };
}

/** Road tool: pave a list of city cell indices (drag path). */
export function buildRoadOrder(
  owner: number,
  cells: number[],
  cls: RoadClass = 'paved',
): OrderIntent {
  return {
    kind: 'buildRoad',
    payload: { owner, cells: [...cells], cls },
  };
}

/**
 * Phase 4 (transport): upgrade existing road cells to a better class in
 * place. The sim charges the per-cell cost difference and rejects any
 * cell that is not a strict upgrade — callers must partition drag cells
 * (see `partitionRoadCells` below) before emitting.
 */
export function buildUpgradeRoadOrder(
  owner: number,
  cells: number[],
  cls: RoadClass,
): OrderIntent {
  return {
    kind: 'upgradeRoad',
    payload: { owner, cells: [...cells], cls },
  };
}

/**
 * Split a road tool's drag cells into fresh builds, in-place upgrades,
 * and skips, so the gesture never emits a command the sim would reject
 * whole (`buildRoad` rejects cells that already have roads;
 * `upgradeRoad` rejects anything but strict upgrades). Pure — the
 * controller (game.ts) calls this at pointerup where the world is
 * visible; the drag pipeline itself stays world-blind.
 */
export function partitionRoadCells(
  roads: RoadCell[],
  cells: number[],
  cls: RoadClass,
): { build: number[]; upgrade: number[]; skipped: number } {
  const build: number[] = [];
  const upgrade: number[] = [];
  let skipped = 0;
  const newIdx = ROAD_CLASS_ORDER.indexOf(cls);
  for (const cell of cells) {
    const old = roadClassAt(roads, cell);
    if (old === undefined) {
      build.push(cell);
    } else if (ROAD_CLASS_ORDER.indexOf(old) < newIdx) {
      upgrade.push(cell);
    } else {
      skipped += 1;
    }
  }
  return { build, upgrade, skipped };
}

/**
 * Zone tool: paint a rectangle of cells. `zone` is 0 = residential,
 * 1 = commercial, 2 = industrial (matches sim/city.ts ZoneType).
 */
export function buildZoneOrder(
  owner: number,
  zone: 0 | 1 | 2,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): OrderIntent {
  return {
    kind: 'paintZone',
    payload: { owner, zone, x0, z0, x1, z1 },
  };
}

/** Building palette: place one building at a cell. */
export function buildPlaceBuildingOrder(
  kind: string,
  owner: number,
  cx: number,
  cz: number,
): OrderIntent {
  return {
    kind: 'placeBuilding',
    payload: { kind, owner, cx, cz },
  };
}

/** Demolish tool: remove whatever building sits at a cell. */
export function buildDemolishOrder(owner: number, cx: number, cz: number): OrderIntent {
  return {
    kind: 'demolish',
    payload: { owner, cx, cz },
  };
}

/**
 * Phase 2 (utilities): paint a power line run. The sim's `buildPowerLine`
 * command is committed by the Phase 2 sim workstream — until then the
 * command is rejected at enqueue with a loud toast (never silent).
 */
export function buildPowerLineOrder(owner: number, cells: readonly number[]): OrderIntent {
  return {
    kind: 'buildPowerLine',
    payload: { owner, cells: [...cells] },
  };
}

/**
 * Phase 2 (utilities): paint a water pipe run. Same enqueue story as
 * `buildPowerLineOrder` — the sim's `buildPipe` command lands with the
 * Phase 2 sim workstream.
 */
export function buildWaterPipeOrder(owner: number, cells: readonly number[]): OrderIntent {
  return {
    kind: 'buildPipe',
    payload: { owner, cells: [...cells] },
  };
}

/**
 * Phase 4 (transport): paint a rail run. The sim's `buildRail` command
 * takes a track-class payload (`cls`, one of standard | electric |
 * high-speed — see TRACK_CLASS_STATS in sim/city.ts); omitted cls
 * defaults to 'standard'. Track class is a train SPEED factor (higher
 * class = faster trains), unlike road class which is a move COST.
 */
export function buildRailOrder(
  owner: number,
  cells: readonly number[],
  cls: TrackClass = 'standard',
): OrderIntent {
  return {
    kind: 'buildRail',
    payload: { owner, cells: [...cells], cls },
  };
}

/** HUD age button: advance to Connectivity with a National Program. */
export function buildAdvanceAgeOrder(
  owner: number,
  program: string,
): OrderIntent {
  return {
    kind: 'advanceAge',
    payload: { owner, program },
  };
}

/**
 * Research panel: research an upgrade at the lab. The sim validates the
 * lab, prerequisites and affordability at enqueue AND apply time.
 */
export function buildResearchUpgradeOrder(
  owner: number,
  upgrade: string,
): OrderIntent {
  return {
    kind: 'researchUpgrade',
    payload: { owner, upgrade },
  };
}

/** HUD tax control: set one zone's tax rate (0..1). */
export function buildSetTaxRateOrder(
  owner: number,
  zone: 0 | 1 | 2,
  rate: number,
): OrderIntent {
  return {
    kind: 'setTaxRate',
    payload: { owner, zone, rate },
  };
}

/** Phase 3: fire the Aegis shield. */
export function buildFireAegisOrder(owner: number): OrderIntent {
  return {
    kind: 'fireAegis',
    payload: { owner },
  };
}

/** Phase 3: fire the Storm Engine at a map point. */
export function buildFireStormOrder(
  owner: number,
  x: number,
  z: number,
): OrderIntent {
  return {
    kind: 'fireStorm',
    payload: { owner, x, z },
  };
}

/** Phase 3: set the city's economic specialization. */
export function buildSetSpecializationOrder(
  owner: number,
  specialization: string,
): OrderIntent {
  return {
    kind: 'setSpecialization',
    payload: { owner, specialization },
  };
}

/** Phase 3: establish a trade route with another player. */
export function buildEstablishTradeRouteOrder(
  owner: number,
  partner: number,
): OrderIntent {
  return {
    kind: 'establishTradeRoute',
    payload: { owner, partner },
  };
}

/** Phase 3: cancel a trade route. */
export function buildCancelTradeRouteOrder(
  owner: number,
  partner: number,
): OrderIntent {
  return {
    kind: 'cancelTradeRoute',
    payload: { owner, partner },
  };
}

/** Phase 3: appoint a mayor with a tax policy. */
export function buildAssignMayorOrder(
  owner: number,
  policy: string,
): OrderIntent {
  return {
    kind: 'assignMayor',
    payload: { owner, policy },
  };
}

/** Phase 3: dismiss the mayor. */
export function buildDismissMayorOrder(owner: number): OrderIntent {
  return {
    kind: 'dismissMayor',
    payload: { owner },
  };
}

/** Polish: set the mayor's build policy (housing/industry/balanced). */
export function buildSetMayorBuildPolicyOrder(
  owner: number,
  buildPolicy: string,
): OrderIntent {
  return {
    kind: 'setMayorBuildPolicy',
    payload: { owner, buildPolicy },
  };
}

/** Phase 3: appoint a general over selected units. */
export function buildAssignGeneralOrder(
  owner: number,
  unitIds: number[],
  stance: string,
): OrderIntent {
  return {
    kind: 'assignGeneral',
    payload: { owner, unitIds: [...unitIds], stance },
  };
}

/** Phase 3: dismiss the general. */
export function buildDismissGeneralOrder(owner: number): OrderIntent {
  return {
    kind: 'dismissGeneral',
    payload: { owner },
  };
}

/** Phase 3: change the general's stance. */
export function buildSetGeneralStanceOrder(
  owner: number,
  stance: string,
): OrderIntent {
  return {
    kind: 'setGeneralStance',
    payload: { owner, stance },
  };
}

/**
 * Phase 3 (logistics): send a unit to resupply at a depot. The sim
 * (`registerLogisticsCommands`) validates the unit/depot/owner, reserves
 * the unit's need from the depot's AVAILABLE stock (stock − reserved),
 * and routes the unit there; the refill aura fulfills the reservation on
 * arrival. Emitted by the selection panel's Resupply button with the
 * depot picked by `nearestDepot` (ui/logistics.ts). The sim rejects
 * loudly when the depot cannot serve the unit — nothing fails silently.
 */
export function buildResupplyOrder(
  unitId: number,
  depotId: number,
  owner: number,
): OrderIntent {
  return {
    kind: 'resupply',
    payload: { unitId, depotId, owner },
  };
}

/**
 * Phase 3 (logistics): set which field services a supply unit offers
 * (repair / rearm / refuel). Flat booleans — the exact payload shape
 * `setSupplyToggles` validates. Only cargo-carrying units (supplyTruck /
 * fuelTruck / hauler) accept it; the sim rejects anything else.
 */
export function buildSupplyTogglesOrder(
  unitId: number,
  owner: number,
  services: { repair: boolean; rearm: boolean; refuel: boolean },
): OrderIntent {
  return {
    kind: 'setSupplyToggles',
    payload: {
      unitId,
      owner,
      repair: services.repair,
      rearm: services.rearm,
      refuel: services.refuel,
    },
  };
}
