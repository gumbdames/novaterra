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

/** Attack-move: unit(s) advance toward (x, z) engaging any hostiles encountered. */
export function buildAttackMoveOrder(
  owner: number,
  unitIds: number[],
  x: number,
  z: number,
): OrderIntent {
  return {
    kind: 'attackMove',
    payload: { owner, unitIds: [...unitIds], x, z },
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

/**
 * Right-click on an enemy building: one attackBuilding (siege order)
 * per selected unit. Final-review R2 (2026-10-01).
 */
export function buildAttackBuildingOrders(
  unitIds: number[],
  owner: number,
  buildingId: number,
): OrderIntent[] {
  return unitIds.map((unitId) => ({
    kind: 'attackBuilding',
    payload: { unitId, buildingId, owner },
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

/**
 * Fun-audit C1 (production queues, 2026-10-02): queue one military
 * unit of `kind` at production building `buildingId`. The sim
 * validates the building (owned, completed, can produce the kind)
 * and deducts costs at enqueue; `runTraining` completes it over
 * `def.trainSeconds`.
 */
export function buildTrainUnitOrder(
  kind: string,
  owner: number,
  buildingId: number,
): OrderIntent {
  return {
    kind: 'trainUnit',
    payload: { kind, owner, buildingId },
  };
}

/** Fun-audit C1: cancel the queued unit at `index` (full refund). */
export function buildCancelTrainOrder(
  owner: number,
  buildingId: number,
  index: number,
): OrderIntent {
  return {
    kind: 'cancelTrainUnit',
    payload: { owner, buildingId, index },
  };
}

/** Fun-audit C1: pause (true) or resume (false) a building's queue. */
export function buildSetTrainPausedOrder(
  owner: number,
  buildingId: number,
  paused: boolean,
): OrderIntent {
  return {
    kind: 'setTrainPaused',
    payload: { owner, buildingId, paused },
  };
}

/** Fun-audit C1: set a production building's rally point. */
export function buildSetRallyPointOrder(
  owner: number,
  buildingId: number,
  x: number,
  z: number,
): OrderIntent {
  return {
    kind: 'setRallyPoint',
    payload: { owner, buildingId, x, z },
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
 * 1 = commercial, 2 = industrial, 3 = airport (matches sim/city.ts
 * ZoneType).
 */
export function buildZoneOrder(
  owner: number,
  zone: 0 | 1 | 2 | 3,
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
 * Building upgrades (2026-10-05): add one reactor to an owned,
 * completed nuclear plant. The sim validates (kind, max reactors,
 * construction done, no upgrade in flight, affordability) and rejects
 * loudly.
 */
export function buildUpgradeBuildingOrder(owner: number, buildingId: number): OrderIntent {
  return {
    kind: 'upgradeBuilding',
    payload: { owner, buildingId },
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
  /** The age the issuer sees right now — makes the issuer's advance
   * idempotent when the same owner enqueues twice on the same tick
   * (the Phase 9 soak 6.1 race also bites human-vs-AI games). Per-side
   * ages (2026-10-01, roadmap A1): a rival's advancement is never a
   * duplicate of yours. Omit only where no second issuer can race
   * (scripted demos). */
  fromAge?: string,
): OrderIntent {
  return {
    kind: 'advanceAge',
    payload: fromAge === undefined ? { owner, program } : { owner, program, fromAge },
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

/** HUD tax control: set one zone's tax rate (0..1). Zone 3 = airports. */
export function buildSetTaxRateOrder(
  owner: number,
  zone: 0 | 1 | 2 | 3,
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

/**
 * Grand-expansion Phase 8 (civilian ordinances, workstream E,
 * 2026-09-30): toggle a city-wide policy. `on` is 0 (off) or 1 (on);
 * turning on requires a 60-second upkeep runway in the treasury (the
 * sim's validate rejects loudly otherwise).
 */
export function buildSetPolicyOrder(
  owner: number,
  policy: string,
  on: 0 | 1,
): OrderIntent {
  return {
    kind: 'setPolicy',
    payload: { owner, policy, on },
  };
}

/**
 * Civilian sea trade (Half A, 2026-10-01): establish a sea route
 * between two of the owner's harbors. `from` / `to` are building ids —
 * both must be the owner's completed civilian ports (the sim's
 * `establishSeaRoute` validation is authoritative); `policy` is one of
 * 'funds' | 'fuel' | 'materials'. 500 funds setup.
 */
export function buildEstablishSeaRouteOrder(
  owner: number,
  from: number,
  to: number,
  policy: string,
): OrderIntent {
  return {
    kind: 'establishSeaRoute',
    payload: { owner, from, to, policy },
  };
}

/**
 * Civilian sea trade (Half A, 2026-10-01): cancel a sea route by its
 * route id. The sim releases assigned ships loudly
 * (`clearSeaRouteAssignments`).
 */
export function buildCancelSeaRouteOrder(
  owner: number,
  id: number,
): OrderIntent {
  return {
    kind: 'cancelSeaRoute',
    payload: { owner, id },
  };
}

/**
 * Civilian sea trade (Half A, 2026-10-01): assign a civilian cargo
 * vessel to a sea route (`routeId` 0 = unassign). The sim validates
 * the hull (`isSeaTradeShip`) and the route's ownership loudly.
 */
export function buildAssignSeaRouteOrder(
  owner: number,
  unitId: number,
  routeId: number,
): OrderIntent {
  return {
    kind: 'assignSeaRoute',
    payload: { owner, unitId, routeId },
  };
}

/**
 * Grand-expansion Phase 5 (S5): establish an airline route between two of
 * the owner's airport anchors. `from` / `to` are building ids — both must
 * be the owner's completed civil or mixed airports (the sim's
 * `establishAirlineRoute` validates authoritatively); 500 funds setup.
 */
export function buildEstablishAirlineRouteOrder(
  owner: number,
  from: number,
  to: number,
): OrderIntent {
  return {
    kind: 'establishAirlineRoute',
    payload: { owner, from, to },
  };
}

/** Grand-expansion Phase 5 (S5): cancel an airline route by its route id. */
export function buildCancelAirlineRouteOrder(
  owner: number,
  id: number,
): OrderIntent {
  return {
    kind: 'cancelAirlineRoute',
    payload: { owner, id },
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
  theatre?: string,
): OrderIntent {
  return {
    kind: 'assignGeneral',
    payload: { owner, unitIds: [...unitIds], stance, ...(theatre !== undefined ? { theatre } : {}) },
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
 * Sea-logistics Half B (2026-10-01): load a supply unit's cargo holds
 * at a friendly completed naval supply point (reload point on water —
 * navalYard, navalBase, ports). The sim (`loadCargo` in
 * registerLogisticsCommands) validates unit/building/owner, the
 * LOGISTICS_RADIUS range, and the transferable amounts: fuel/ammo move
 * from the depot's stocks (never from resupply reservations),
 * materials move from the owner's stockpile. Emitted by the selection
 * panel's Load button with the depot picked by `nearestNavalDepot`
 * (ui/logistics.ts). Loud rejections — nothing fails silently.
 */
export function buildLoadCargoOrder(
  unitId: number,
  buildingId: number,
  owner: number,
): OrderIntent {
  return {
    kind: 'loadCargo',
    payload: { unitId, buildingId, owner },
  };
}

/**
 * Sea-logistics Half B (2026-10-01): unload a supply unit's cargo holds
 * into a friendly completed naval supply point. Fuel → fuelStock and
 * ammo → ammoStock (effective storage headroom), materials →
 * materialsStock (raw def headroom). This is how the navalBase's
 * forward caches get filled. Same validate/reject contract as
 * buildLoadCargoOrder.
 */
export function buildUnloadCargoOrder(
  unitId: number,
  buildingId: number,
  owner: number,
): OrderIntent {
  return {
    kind: 'unloadCargo',
    payload: { unitId, buildingId, owner },
  };
}

/**
 * Final-review R5 UI feel (2026-10-01): emergency-refuel a stranded
 * fossil-fuel aircraft (empty tank — it cannot move to a depot, so the
 * normal resupply flow can't reach it). The sim (`emergencyRefuel` in
 * registerLogisticsCommands) validates aircraft/fossil/empty-tank/
 * funds and rejects loudly otherwise.
 */
export function buildEmergencyRefuelOrder(unitId: number, owner: number): OrderIntent {
  return {
    kind: 'emergencyRefuel',
    payload: { unitId, owner },
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

/**
 * Grand-expansion Phase 5 — aircraft expansion (workstream B,
 * 2026-09-30): hangar/carrier order builders. The UI gathers the three
 * hangar commands through these builders, mirroring the sim's
 * `registerUnitCommands` payload shapes exactly. The sim still
 * validates every command at enqueue AND apply time — these only shape
 * well-formed intents.
 */

/**
 * Embark a carrier-capable aircraft onto a carrier's wing.
 * The sim rejects: non-aircraft, non-carrier-capable, dead, already
 * sheltered, wrong owner, full wing, or out of EMBARK_RANGE.
 */
export function buildEmbarkOrder(
  unitId: number,
  carrierId: number,
  owner: number,
): OrderIntent {
  return {
    kind: 'embarkAircraft',
    payload: { unitId, carrierId, owner },
  };
}

/**
 * Park an aircraft in a completed building's hangar.
 * The sim rejects: non-aircraft, dead, already sheltered, wrong owner,
 * incomplete building, or no compatible free slot.
 */
export function buildBaseOrder(
  unitId: number,
  buildingId: number,
  owner: number,
): OrderIntent {
  return {
    kind: 'baseAircraft',
    payload: { unitId, buildingId, owner },
  };
}

/** Launch a sheltered aircraft (frees its wing/hangar slot). */
export function buildLaunchOrder(unitId: number, owner: number): OrderIntent {
  return {
    kind: 'launchAircraft',
    payload: { unitId, owner },
  };
}

// ---------------------------------------------------------------------------
// Grand-expansion Phase 7 (intel, 2026-09-30): covert-op orders.
// ---------------------------------------------------------------------------

/**
 * Start a spy's infiltration of an enemy building (600 ticks / 20s;
 * the spy becomes embedded on completion, which unlocks stealTech).
 *
 * Payload shape is the sim's: `registerIntelCommands`
 * (sim/intel.ts) validates `{ unitId, buildingId, owner }` — `spyId`
 * is the spy's unit id. The sim rejects (adjacency, mission state,
 * ownership) in plain English at enqueue AND apply; the UI wraps the
 * rejection (game.ts toasts it) and never re-implements the checks.
 */
export function buildInfiltrateOrder(
  owner: number,
  spyId: number,
  buildingId: number,
): OrderIntent {
  return {
    kind: 'infiltrateBuilding',
    payload: { unitId: spyId, buildingId, owner },
  };
}

// ---------------------------------------------------------------------------
// Roadmap B3 (2026-10-02): diplomacy orders.
// ---------------------------------------------------------------------------

/**
 * Gift funds to the AI rival (warms disposition: +1 per 500 funds, up
 * to +20). Payload shape is the sim's: `registerDiplomacyCommands`
 * (sim/diplomacy.ts) validates `{ owner, targetOwner, amount }` — the
 * sim rejects (funds, parties) in plain English at enqueue; the UI
 * wraps the rejection (game.ts toasts it) and never re-checks it.
 */
export function buildSendTributeOrder(
  owner: number,
  targetOwner: number,
  amount: number,
): OrderIntent {
  return {
    kind: 'sendTribute',
    payload: { owner, targetOwner, amount },
  };
}

/**
 * Demand funds from the AI rival. The sim resolves the verdict
 * deterministically from disposition, the AI's treasury, difficulty
 * pride, and personality aggression — accepted demands transfer funds,
 * refused ones sour relations. Rejected loudly in peaceful worlds.
 */
export function buildDemandTributeOrder(
  owner: number,
  targetOwner: number,
  amount: number,
): OrderIntent {
  return {
    kind: 'demandTribute',
    payload: { owner, targetOwner, amount },
  };
}

/**
 * Ask the AI rival for a 5-minute ceasefire. The sim resolves
 * accept/decline from disposition, aggression, and difficulty pride.
 * Rejected loudly in peaceful worlds and while one is already active.
 */
export function buildProposeCeasefireOrder(
  owner: number,
  targetOwner: number,
): OrderIntent {
  return {
    kind: 'proposeCeasefire',
    payload: { owner, targetOwner },
  };
}

/**
 * Answer a waiting envoy (fun-audit Tier 4 / E1, 2026-10-02). The
 * payload carries only the owner's decision — the sim resolves the
 * offer (ceasefire / tribute / refusal) at apply time and rejects
 * loudly when no envoy waits.
 */
export function buildAnswerEnvoyOrder(owner: number, accept: boolean): OrderIntent {
  return {
    kind: 'answerEnvoy',
    payload: { owner, accept },
  };
}

/**
 * Fun-audit Tier 4 (E2, 2026-10-02): answer the luminary's card —
 * `resolveLuminary` through the command queue. Rejects loudly when no
 * luminary awaits or the choice is unknown for the drawn card.
 */
export function buildResolveLuminaryOrder(owner: number, choiceId: string): OrderIntent {
  return {
    kind: 'resolveLuminary',
    payload: { owner, choiceId },
  };
}

/**
 * Sabotage an enemy building (25 operational assets; the building goes
 * offline until `sabotagedUntil`). The UI resolves the target building
 * before building the order — the sim requires `buildingId`.
 */
export function buildSabotageOrder(
  owner: number,
  spyId: number,
  buildingId: number,
): OrderIntent {
  return {
    kind: 'sabotage',
    payload: { unitId: spyId, buildingId, owner },
  };
}

/**
 * Steal tech through a spy embedded in an enemy building (15
 * surveillance assets). There is no tech picker: the sim deterministically
 * steals the lexicographically lowest upgrade the victim has researched
 * and the thief has not (`pickStealableTech`); success grants research,
 * failure burns the spy.
 */
export function buildStealTechOrder(
  owner: number,
  spyId: number,
  buildingId: number,
): OrderIntent {
  return {
    kind: 'stealTech',
    payload: { unitId: spyId, buildingId, owner },
  };
}
