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
 * NOVATERRA — ui/palettes.ts — tabbed train/build palettes + research panel
 * data and availability logic (roster expansion).
 *
 * Responsibilities:
 *  - The tab groupings (spec §8): 6 train tabs for the 97 units, 13
 *    build tabs for the 100 buildings, 5 research groups for the 21
 *    upgrades.
 *  - Availability checks that mirror the sim's command validation so the
 *    UI greys out exactly what the sim would reject: `unitAvailability`
 *    mirrors `spawnUnit` validate (age → production building →
 *    funds/materials → manpower), `upgradeAvailability` mirrors
 *    `researchUpgrade` validate (researched → lab → age → buildings →
 *    upgrade prereq → funds/research). Reasons are localized strings for
 *    tooltips; the sim stays the authority at enqueue/apply.
 *  - Localized cost lines (funds + materials + manpower where applicable)
 *    and display-name helpers used by hud.ts and game.ts.
 *
 * Pure module: no DOM, no three.js. Safe under Node/vitest.
 */

import type { World } from '../sim/world';
import {
  UNIT_DEFS,
  MAX_TRAIN_QUEUE,
  canProduceAt,
  hasProducibleBuilding,
  producingBuildingKind,
  type UnitKind,
} from '../sim/units';
import { BUILDING_DEFS, type BuildingKind, getPlayer } from '../sim/city';
import { isUnitAvailableForAge } from '../sim/ages';
import { getDoctrine, DOCTRINES } from '../sim/doctrine';
import {
  UPGRADE_DEFS,
  hasUpgrade,
  repeatableUpgradeLevel,
  upgradeResearchCost,
  type UpgradeId,
} from '../sim/upgrades';
import {
  STRINGS,
  loc,
  fillLoc,
  type LocalizedString,
} from './strings';

// ---------------------------------------------------------------------------
// Tab groupings (spec §8).
// ---------------------------------------------------------------------------

export type TrainTabId = 'infantry' | 'armor' | 'air' | 'navy' | 'transport' | 'intel';

export interface TrainTab {
  id: TrainTabId;
  kinds: readonly UnitKind[];
}

/**
 * Fun-audit C2d (transport consolidation, 2026-10-02): the four
 * mechanically-duplicate civilian transports delisted from TRAIN_TABS.
 * Their defs stay in UNIT_DEFS (save compatibility; "no sim changes")
 * and they remain spawnable for AI/campaign/demo use — they are just
 * no longer player-trainable. The palette's "every kind exactly once"
 * contract (tests/ui.palettes.test.ts) excludes these.
 */
export const DELISTED_TRANSPORT_KINDS: readonly UnitKind[] = [
  'jumboAirliner',
  'regionalJet',
  'passengerHeli',
  'seaplane',
];

/** 97 units across 6 tabs (Phase 8 adds the 28 Mk II/III tech-level
 * variants next to their base kinds; Half A adds the civilian fuel
 * barge to the navy tab). Every TRAINABLE unit kind appears in exactly
 * one tab — the four delisted civilian transports (fun-audit C2d,
 * 2026-10-02: jumboAirliner, regionalJet, passengerHeli, seaplane) are
 * intentionally absent (see DELISTED_TRANSPORT_KINDS). */
export const TRAIN_TABS: readonly TrainTab[] = [
  {
    id: 'infantry',
    kinds: ['engineer', 'rifles', 'sniperTeam', 'spectre', 'combatMedic', 'hauler', 'haulerMk2', 'haulerMk3'],
  },
  {
    id: 'armor',
    // Grand-expansion Phase 3 (logistics): the supply trucks ride with
    // the land vehicles (no production gate — logistics must work from
    // the start, like the hauler precedent in infantry).
    // Grand-expansion Phase 8 (tech levels): Mk II/III variants sit
    // next to their base kinds; `unitAvailability` hides locked ones.
    kinds: ['tank', 'tankMk2', 'tankMk3', 'apc', 'apcMk2', 'apcMk3', 'tankDestroyer', 'artillery', 'artilleryMk2', 'artilleryMk3', 'mlrs', 'aa', 'aaMk2', 'aaMk3', 'aegisBattery', 'tempestCannon', 'hq', 'supplyTruck', 'fuelTruck'],
  },
  {
    id: 'air',
    // Grand-expansion Phase 5 — aircraft expansion (workstream B,
    // 2026-09-30): 10 military + 6 civilian aircraft join the air tab.
    // All train from the airfield (the sibling airport workstream's
    // civil airports add civilian training when they land).
    kinds: [
      'fighter',
      'fighterMk2',
      'fighterMk3',
      'fighterBomber',
      'fighterBomberMk2',
      'fighterBomberMk3',
      'attackHeli',
      'attackHeliMk2',
      'attackHeliMk3',
      'drone',
      'awacs',
      'transport',
      'strategicBomber',
      'maritimePatrol',
      'reconUAV',
      'armedUAV',
      'reconPlane',
      'gunship',
      'gunshipMk2',
      'gunshipMk3',
      'tanker',
      'militaryCargo',
      'trainer',
      'navalFighter',
      'airliner',
      // Fun-audit C2d (transport consolidation, 2026-10-02):
      // jumboAirliner, regionalJet, passengerHeli and seaplane are
      // delisted from the palette — mechanically duplicate civilian
      // transports at different sizes (the plan's verdict: keep one
      // Cargo Plane, one Airliner, one Freighter trainable). Their defs
      // stay in UNIT_DEFS (save compatibility; "no sim changes") and
      // they remain spawnable for AI/campaign/demo use.
      'cargoPlane',
    ],
  },
  {
    id: 'navy',
    // Grand-expansion Phase 6 — naval expansion (workstream C,
    // 2026-09-30): the 15 new sea kinds. navalMine rides the tab too —
    // it shows disabled with the "Deployed by a Minelayer" reason (see
    // unitAvailability), so players learn how mines are laid.
    kinds: [
      'patrolBoat',
      'missileBoat',
      'missileBoatMk2',
      'missileBoatMk3',
      'frigate',
      'frigateMk2',
      'frigateMk3',
      'submarine',
      'submarineMk2',
      'submarineMk3',
      'destroyer',
      'destroyerMk2',
      'destroyerMk3',
      'carrier',
      'commandShip',
      'transportShip',
      'transportShipMk2',
      'transportShipMk3',
      'fishingBoat',
      'coastalSub',
      'missileSub',
      'corvette',
      'cruiser',
      'battleship',
      'heavyDestroyer',
      'cargoFreighter',
      'fuelTanker',
      // Civilian sea trade (Half A, 2026-10-01): the civilian fuel
      // barge trains at the commercialHarbor (alongside the freighter).
      'fuelBarge',
      'ammoShip',
      'repairShip',
      'minelayer',
      'navalMine',
      'coastGuardCutter',
      'cruiseLiner',
      'yacht',
    ],
  },
  // Grand-expansion Phase 4 S7 (2026-09-30): the civilian transports get
  // their own tab — they train from transport hubs (railStation/busDepot/
  // ferryTerminal), never from military production buildings.
  {
    id: 'transport',
    kinds: ['passengerTrain', 'freightTrain', 'bus', 'tram', 'ferry'],
  },
  // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
  // the intel pair gets its own tab — the spy trains at the intelHQ
  // (never at the barracks), and the reconTeam is the overt recon
  // option alongside it.
  {
    id: 'intel',
    kinds: ['spy', 'reconTeam'],
  },
];

export type BuildTabId =
  | 'housing'
  | 'civic'
  | 'commerce'
  | 'industry'
  | 'utilities'
  | 'power'
  | 'waterNet'
  | 'navalAir'
  | 'special'
  // Grand-expansion Phase 3 (logistics): production + depots.
  | 'logistics'
  // Grand-expansion Phase 4 S7 (2026-09-30): transport hubs.
  | 'transport'
  // Grand-expansion Phase 5 (S5+S8, 2026-09-30): the airport roster.
  | 'airports'
  // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
  // the intel buildings.
  | 'intel';

export interface BuildTab {
  id: BuildTabId;
  kinds: readonly BuildingKind[];
}

/** 100 buildings across 13 tabs. Every building kind appears in exactly one. */
export const BUILD_TABS: readonly BuildTab[] = [
  { id: 'housing', kinds: ['house', 'apartment'] },
  // Workstream Z (2026-09-30): the civic tab — the four education
  // buildings (kindergarten/school/college/university) together. The
  // hospital stays in Commerce (leave-hospital-alone rule).
  // Workstream W (2026-09-30): the two civic amenities (library/park)
  // join the civic tab — they raise nearby residential desirability.
  // Workstream P (ambient city life, 2026-09-30): civic parking joins
  // them — the same desirability story (convenience amenities).
  // Grand-expansion Phase 8 (civilian deep-dive, workstream E,
  // 2026-09-30): the amenity family grows — museum/theater/stadium/
  // botanical garden as desirability drivers, fire station as a civic
  // convenience tier.
  { id: 'civic', kinds: ['kindergarten', 'school', 'college', 'university', 'library', 'park', 'parkingLot', 'parkingGarage', 'museum', 'theater', 'sportsStadium', 'botanicalGarden', 'fireStation'] },
  {
    id: 'commerce',
    // Phase 8 (workstream E): grand market (market's tech-level step),
    // bank, office tower, and the clinic → medical center health ladder.
    kinds: ['shop', 'market', 'grandMarket', 'bank', 'officeTower', 'lab', 'mediaCenter', 'hospital', 'clinic', 'medicalCenter'],
  },
  {
    id: 'industry',
    kinds: [
      'factory',
      'farm',
      'quarry',
      'oilRefinery',
      'recyclingCenter',
      'barracks',
      'warFactory',
      // Phase 1 (veterancy): trains armed units to Regular on spawn.
      'militaryAcademy',
    ],
  },
  {
    id: 'utilities',
    kinds: ['powerPlant', 'solarFarm', 'nuclearPlant', 'waterPump', 'desalination'],
  },
  // Grand-expansion Phase 2 (2026-09-30): the 13 new utility buildings —
  // the six power plants plus the power-network pieces (substation,
  // battery) under Power; the water sources plus the pumping station
  // under Water — next to the classic utilities tab.
  {
    id: 'power',
    kinds: [
      'coalPlant',
      'gasPlant',
      'windFarm',
      'hydroDam',
      'geothermalPlant',
      'fusionPlant',
      'powerSubstation',
      'batteryStation',
    ],
  },
  {
    id: 'waterNet',
    kinds: ['waterWell', 'waterTower', 'waterTreatment', 'reservoir', 'pumpingStation'],
  },
  {
    id: 'navalAir',
    // Grand-expansion Phase 6 — naval expansion (workstream C,
    // 2026-09-30): the four ports build from the Naval & Air tab (they
    // are naval infrastructure). The airport roster got its own
    // civilian 'airports' tab instead (workstream A, S5+S8).
    kinds: [
      'shipyard',
      'navalYard',
      'airfield',
      'radarStation',
      'commercialPort',
      'containerPort',
      'fishingHarbor',
      'navalBase',
    ],
  },
  // Grand-expansion Phase 3 (2026-09-30): the logistics roster — crude
  // extraction, ammo production (general + specialized), and the three
  // depot reload points — gets its own tab next to Naval & Air.
  {
    id: 'logistics',
    kinds: [
      'oilWell',
      'oilRig',
      'munitionsFactory',
      'missilePlant',
      'missileSilo',
      'ordnanceDepot',
      'fuelDepot',
    ],
  },
  { id: 'special', kinds: ['monument', 'aegisControl', 'stormArray'] },
  // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
  // the four intel buildings — the intelHQ (trains spies, generates
  // operational assets), the two detection-radius sources
  // (listeningPost, signalsStation), and the late-age satelliteUplink.
  {
    id: 'intel',
    kinds: ['intelHQ', 'listeningPost', 'signalsStation', 'satelliteUplink'],
  },
  // Grand-expansion Phase 4 S7 (2026-09-30): the transport hubs — rail
  // station, bus depot, ferry terminal, and the two marinas — get their
  // own tab (civilian infrastructure, not military logistics).
  // Tiered transit stops/stations (2026-09-30): the seven passenger
  // stops join the same tab — the full civilian-transport palette.
  // Civilian sea trade (Half A, 2026-10-01): the Civilian Shipyard
  // (commercialHarbor) is civilian production infrastructure
  // (peaceful-buildable), not a military navalAir port. It builds and
  // repairs the civilian ships — the trade docks live in the Naval &
  // Air tab (the no-blur rule: shipyards build, docks trade).
  {
    id: 'transport',
    kinds: [
      'railStation', 'busDepot', 'ferryTerminal', 'marina', 'marinaLarge',
      'busStop', 'taxiStand', 'tramStop', 'ferryPier',
      'neighborhoodStation', 'centralStation', 'airportInterchange',
      'commercialHarbor',
    ],
  },
  // Grand-expansion Phase 5 (S5+S8, 2026-09-30): the airport roster —
  // anchors, terminals, tower, per-class hangars, fuel farm,
  // maintenance hangar, runway modules. Civilian infrastructure (the
  // military airbase is one building among fourteen — the tab lives
  // under Civilian, unlike the military navalAir tab).
  {
    id: 'airports',
    kinds: [
      'civilAirport', 'militaryAirbase', 'mixedAirport',
      'passengerTerminal', 'cargoTerminal', 'controlTower',
      'hangarS', 'hangarM', 'hangarL',
      'fuelFarm', 'maintenanceHangar',
      'runwayS', 'runwayM', 'runwayL',
    ],
  },
];

// ---------------------------------------------------------------------------
// Main menu tabs (workstream Y, 2026-09-30): the bottom-left menu is
// organized into three tabs — Civilian, Military, Management. Build tabs
// are assigned whole (the industry tab keeps its military production
// buildings: they are production infrastructure, built like any factory).
// ---------------------------------------------------------------------------

/** The three main menu tabs of the bottom-left menu. */
export type MenuTabId = 'civilian' | 'military' | 'management';

/**
 * Which main menu tab each build tab lives under. Every BuildTabId
 * appears here exactly once (tsc enforces it) so no build tab can be
 * orphaned by the 3-tab restructure.
 *
 * - Civilian: zone tools ride along (road / power line / water pipe /
 *   zones / demolish are civilian infrastructure tools), plus the city
 *   build tabs.
 * - Military: unit training lives here (TRAIN_TABS, below), plus the
 *   military build tabs. `logistics` is military: the missile/ammo/fuel
 *   supply chain exists to feed the war effort. `navalAir` holds the
 *   military production buildings (shipyard, naval yard, airfield,
 *   radar). `special` holds the superweapons (Aegis Control, Storm
 *   Array); the Monument rides along as the one civilian oddity.
 *   The `transport` build tab is civilian: stations, depots, terminals,
 *   and marinas are civilian infrastructure.
 */
export const BUILD_TAB_MENU_TABS: Record<BuildTabId, 'civilian' | 'military'> = {
  housing: 'civilian',
  civic: 'civilian',
  commerce: 'civilian',
  industry: 'civilian',
  utilities: 'civilian',
  power: 'civilian',
  waterNet: 'civilian',
  logistics: 'military',
  navalAir: 'military',
  special: 'military',
  transport: 'civilian',
  // Grand-expansion Phase 5 (S5+S8): airports are civilian infrastructure.
  airports: 'civilian',
  // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
  // intel buildings are military infrastructure.
  intel: 'military',
};

/**
 * The build tabs rendered under one main menu tab, in BUILD_TABS order.
 * Generic over the tab record so callers keep their kind types (the
 * canonical list comes from utilities.ts `allBuildTabs()` so the utility
 * tabs can never drift out of the menu).
 */
export function buildTabsForMenuTab<T extends { id: BuildTabId }>(
  tabs: ReadonlyArray<T>,
  menuTab: 'civilian' | 'military',
): T[] {
  return tabs.filter((t) => BUILD_TAB_MENU_TABS[t.id] === menuTab);
}

export type UpgradeGroupId = 'military' | 'economy' | 'infrastructure' | 'logistics' | 'intel';

export interface UpgradeGroup {
  id: UpgradeGroupId;
  ids: readonly UpgradeId[];
}

/**
 * True when the sim's def for this upgrade is military-flagged — the
 * single source of truth for the peaceful lockout (sim/upgrades.ts
 * `UpgradeDef.military`). Never key lockout off the visual group below;
 * groups are thematics, flags are authority.
 */
export function upgradeIsMilitary(id: UpgradeId): boolean {
  return UPGRADE_DEFS[id]?.military === true;
}

/**
 * 21 upgrades in 5 research groups.
 *
 * Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
 * the group LISTS stay explicit (order + thematics are visual), but the
 * military-flag PARTITION is pinned, not hand-maintained — the no-drift
 * test (tests/ui.peaceful.test.ts) asserts the flag-anchored invariant:
 * every upgrade with `def.military === true` sits in one of the
 * war-apparatus groups (military / logistics / intel), every upgrade in
 * those groups is military-flagged, and economy / infrastructure hold
 * only civilian upgrades. A def rebalance that flips a flag breaks the
 * suite loudly instead of silently drifting the UI. The peaceful
 * lockout keys off `upgradeIsMilitary` (the flag), never the group.
 */
export const UPGRADE_GROUPS: readonly UpgradeGroup[] = [
  {
    id: 'military',
    ids: [
      'apRounds',
      'compositeArmor',
      'engineTuning',
      'advancedAvionics',
      'sonarSuite',
      'cruiseMissiles',
      'droneOptics',
      'fieldMedicine',
    ],
  },
  {
    id: 'economy',
    ids: ['precisionManufacturing', 'smartGrid', 'verticalFarming', 'freeTrade', 'advancedResearch'],
  },
  // Grand-expansion Phase 2 (2026-09-30): the utility research ladder —
  // its own group so the military/economy pins keep their meaning.
  {
    id: 'infrastructure',
    ids: [
      'combustionTech',
      'advancedNuclear',
      'fusionResearch',
      'groundwaterSurvey',
      'desalinationTech',
      'gridStorage',
    ],
  },
  // Grand-expansion Phase 3 (2026-09-30): the logistics upgrade —
  // its own group so the military (8) pin keeps its meaning.
  {
    id: 'logistics',
    ids: ['advancedLogistics'],
  },
  // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
  // the intel upgrade pair — its own group so the other groups' pins
  // keep their meaning.
  {
    id: 'intel',
    ids: ['signalsIntel', 'counterIntel'],
  },
];

// ---------------------------------------------------------------------------
// Display names (localized, with a safe fallback to the raw kind id).
// ---------------------------------------------------------------------------

/** Localized unit name for palettes/toasts; falls back to the kind id. */
export function unitName(kind: string): string {
  const entry = (STRINGS.unitNames as Record<string, LocalizedString | undefined>)[kind];
  return entry !== undefined ? loc(entry) : kind;
}

/** Localized building name for palettes/toasts; falls back to the kind id. */
export function buildingName(kind: string): string {
  const entry = (STRINGS.buildingNames as Record<string, LocalizedString | undefined>)[kind];
  return entry !== undefined ? loc(entry) : kind;
}

/** Localized upgrade name; falls back to the sim def's English name. */
export function upgradeName(id: UpgradeId): string {
  const entry = (
    STRINGS.upgrades as Record<UpgradeId, { name: LocalizedString } | undefined>
  )[id];
  return entry !== undefined ? loc(entry.name) : (UPGRADE_DEFS[id]?.name ?? id);
}

/** Localized one-line upgrade effect. */
export function upgradeEffect(id: UpgradeId): string {
  const entry = (
    STRINGS.upgrades as Record<UpgradeId, { effect: LocalizedString } | undefined>
  )[id];
  return entry !== undefined ? loc(entry.effect) : '';
}

// ---------------------------------------------------------------------------
// Availability — mirrors of the sim's command validation, for grey-out.
// ---------------------------------------------------------------------------

/** True when the owner has a completed (progress >= 1) building of kind. */
export function hasCompletedBuilding(
  world: World,
  owner: number,
  kind: BuildingKind,
): boolean {
  return world.city.buildings.some(
    (b) => b.owner === owner && b.kind === kind && b.progress >= 1,
  );
}

export interface Availability {
  ok: boolean;
  /** Localized reason when not ok (tooltip / grey-out text). */
  reason: string;
}

/**
 * Can the owner train this unit right now? Mirrors `spawnUnit` validate:
 * age → production building → funds/materials → manpower. First failure
 * wins, so the tooltip names the single most relevant blocker.
 */
export function unitAvailability(
  world: World,
  owner: number,
  kind: UnitKind,
): Availability {
  const def = UNIT_DEFS[kind];
  const p = STRINGS.palettes;
  // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
  // military defs are not orderable in peaceful worlds — the button
  // greys out with the reason (the sim rejects loudly at the command
  // layer; the UI mirrors it so the button never lies). Keyed off the
  // def flag, never the visual tab. The flag is immutable (tick 0), so
  // no digest impact outside peaceful worlds.
  if (world.peaceful === true && def.military === true) {
    return { ok: false, reason: loc(p.peacefulLocked) };
  }
  // Grand-expansion Phase 6 (workstream C): deployable-only kinds
  // (navalMine) are never trained — the button stays visible but
  // disabled with the reason, so players learn to use a minelayer.
  if (def.deployableOnly === true) {
    return { ok: false, reason: loc(p.deployedByMinelayer) };
  }
  // Fun-audit D1 (2026-10-02): doctrine-exclusive signature units —
  // the button greys out with the reason (the sim rejects loudly at
  // the command layer; the UI mirrors it so the button never lies).
  if (def.doctrine !== undefined && getDoctrine(world, owner) !== def.doctrine) {
    return {
      ok: false,
      reason: fillLoc(p.requiresDoctrine, { doctrine: DOCTRINES[def.doctrine].name }),
    };
  }
  if (!isUnitAvailableForAge(world, owner, def.minAge)) { // per-side ages: the viewer's own age
    return {
      ok: false,
      reason: fillLoc(p.requiresAge, { age: loc(STRINGS.ageNames[def.minAge]) }),
    };
  }
  // Fun-audit C1 (production queues, 2026-10-02): military units train
  // through production-building queues — the owner needs a completed
  // building that can produce the kind (explicit requiredBuilding or
  // the domain default: barracks / airfield / shipyard; countsAs
  // honored, so a mixed airport trains airfield kinds). This
  // subsumes the plain requiredBuilding check for military defs.
  if (def.military === true) {
    if (!hasProducibleBuilding(world, owner, def)) {
      return {
        ok: false,
        reason: fillLoc(p.requiresBuilding, { name: buildingName(producingBuildingKind(def)) }),
      };
    }
  } else if (def.requiredBuilding !== undefined && !hasCompletedBuilding(world, owner, def.requiredBuilding)) {
    return {
      ok: false,
      reason: fillLoc(p.requiresBuilding, { name: buildingName(def.requiredBuilding) }),
    };
  }
  const player = getPlayer(world.city, owner);
  if (player !== undefined) {
    if (player.funds < def.trainFunds || player.materials < def.trainMaterials) {
      return { ok: false, reason: loc(p.cannotAfford) };
    }
    if (player.manpower < def.manpowerCost) {
      return { ok: false, reason: loc(p.notEnoughManpower) };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * Fun-audit C1 (production queues, 2026-10-02): can this specific
 * building train this kind right now? Mirrors the `trainUnit`
 * validator's building-side checks (completed + can-produce + queue
 * room) on top of the shared unitAvailability (peaceful / age /
 * affordability / manpower). The building detail view's train buttons
 * read this — never a dead button.
 */
export function trainAtBuildingAvailability(
  world: World,
  owner: number,
  buildingId: number,
  kind: UnitKind,
): Availability {
  const base = unitAvailability(world, owner, kind);
  if (!base.ok) return base;
  const p = STRINGS.palettes;
  const b = world.city.buildings.find((x) => x.id === buildingId);
  if (b === undefined || b.owner !== owner || b.progress < 1) {
    return { ok: false, reason: base.reason };
  }
  // The building itself must produce this kind (mirrors the sim's
  // `trainUnit` validator — e.g. rifles cannot train at an airfield).
  if (!canProduceAt(b.kind, UNIT_DEFS[kind])) {
    return {
      ok: false,
      reason: fillLoc(p.requiresBuilding, { name: buildingName(producingBuildingKind(UNIT_DEFS[kind])) }),
    };
  }
  if ((b.trainQueue ?? []).length >= MAX_TRAIN_QUEUE) {
    return { ok: false, reason: loc(STRINGS.trainQueue.queueFull) };
  }
  return { ok: true, reason: '' };
}

/**
 * Palette-side availability for a building: age gate first, then
 * affordability. Placement-time rules (the navalYard coast rule and zone
 * matching) are validated by the sim at placeBuilding time and surface in
 * the button tooltip instead.
 */
export function buildingAvailability(
  world: World,
  owner: number,
  kind: BuildingKind,
): Availability {
  const def = BUILDING_DEFS[kind];
  const p = STRINGS.palettes;
  // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
  // military defs are not orderable in peaceful worlds — mirrors the
  // sim's `placeBuilding` rejection (the Military build tabs are hidden
  // anyway; this covers the military production buildings that ride
  // along in the civilian industry tab). Def-flag-keyed, immutable, no
  // digest impact outside peaceful worlds.
  if (world.peaceful === true && def.military === true) {
    return { ok: false, reason: loc(p.peacefulLocked) };
  }
  if (!isUnitAvailableForAge(world, owner, def.minAge)) { // per-side ages: the viewer's own age
    return {
      ok: false,
      reason: fillLoc(p.requiresAge, { age: loc(STRINGS.ageNames[def.minAge]) }),
    };
  }
  const player = getPlayer(world.city, owner);
  if (
    player !== undefined &&
    (player.funds < def.costFunds || player.materials < def.costMaterials)
  ) {
    return { ok: false, reason: loc(p.cannotAfford) };
  }
  return { ok: true, reason: '' };
}

export type UpgradeAvailabilityState = 'researched' | 'ready' | 'locked';

export interface UpgradeAvailability {
  state: UpgradeAvailabilityState;
  /** Localized reason when locked (or "already researched"). */
  reason: string;
}

/**
 * Research state of an upgrade for the owner. Mirrors `researchUpgrade`
 * validate: researched → lab → age → buildings → upgrade prereq →
 * funds/research. First failure wins.
 */
export function upgradeAvailability(
  world: World,
  owner: number,
  id: UpgradeId,
): UpgradeAvailability {
  const def = UPGRADE_DEFS[id];
  const p = STRINGS.palettes;
  // Roadmap B9: repeatable upgrades are never "done" — every level is a
  // fresh research, so the researched state never applies to them
  // (hasUpgrade never covers them anyway; the guard is belt-and-braces).
  if (def.repeatable !== true && hasUpgrade(world, owner, id)) {
    return { state: 'researched', reason: loc(p.alreadyResearched) };
  }
  // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
  // military upgrades are not researchable in peaceful worlds — the
  // button greys out with the reason (mirrors the sim's
  // `researchUpgrade` rejection). Keyed off `upgradeIsMilitary` (the
  // def flag), never the visual group, so the grouping can never drift
  // the lockout. Immutable flag — no digest impact outside peaceful.
  if (world.peaceful === true && upgradeIsMilitary(id)) {
    return { state: 'locked', reason: loc(p.peacefulLocked) };
  }
  if (!hasCompletedBuilding(world, owner, 'lab')) {
    return { state: 'locked', reason: loc(p.needsLab) };
  }
  if (!isUnitAvailableForAge(world, owner, def.minAge)) { // per-side ages: the viewer's own age
    return {
      state: 'locked',
      reason: fillLoc(p.requiresAge, { age: loc(STRINGS.ageNames[def.minAge]) }),
    };
  }
  const missing = def.requiredBuildings.filter(
    (k) => !hasCompletedBuilding(world, owner, k),
  );
  if (missing.length > 0) {
    return {
      state: 'locked',
      reason: fillLoc(p.requiresBuilding, {
        name: missing.map((k) => buildingName(k)).join(', '),
      }),
    };
  }
  if (def.requiredUpgrade !== undefined && !hasUpgrade(world, owner, def.requiredUpgrade)) {
    return {
      state: 'locked',
      reason: fillLoc(p.requiresUpgrade, { name: upgradeName(def.requiredUpgrade) }),
    };
  }
  const player = getPlayer(world.city, owner);
  // Roadmap B9: repeatable upgrades price the NEXT level (200×level
  // research) — the static def cost would grey the button out wrong.
  const cost = upgradeResearchCost(world, owner, id);
  if (
    player === undefined ||
    player.funds < cost.costFunds ||
    player.research < cost.costResearch
  ) {
    return { state: 'locked', reason: loc(p.cannotAfford) };
  }
  return { state: 'ready', reason: '' };
}

/** True when the owner has at least one completed lab (research panel). */
export function playerHasCompletedLab(world: World, owner: number): boolean {
  return hasCompletedBuilding(world, owner, 'lab');
}

// ---------------------------------------------------------------------------
// Cost lines — funds + materials (+ manpower / research where applicable).
// ---------------------------------------------------------------------------

function joinCostParts(parts: Array<[number, LocalizedString]>): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${loc(label)}`)
    .join(' · ');
}

/** Localized training cost: funds + materials + manpower (non-zero parts). */
export function formatTrainCost(kind: UnitKind): string {
  const def = UNIT_DEFS[kind];
  const p = STRINGS.palettes;
  return joinCostParts([
    [def.trainFunds, p.resFunds],
    [def.trainMaterials, p.resMaterials],
    [def.manpowerCost, p.resManpower],
  ]);
}

/** Localized building cost: funds + materials. */
export function formatBuildCost(kind: BuildingKind): string {
  const def = BUILDING_DEFS[kind];
  const p = STRINGS.palettes;
  return joinCostParts([
    [def.costFunds, p.resFunds],
    [def.costMaterials, p.resMaterials],
  ]);
}

/** Localized research cost: funds + research points. */
export function formatResearchCost(id: UpgradeId): string {
  const def = UPGRADE_DEFS[id];
  const p = STRINGS.palettes;
  return joinCostParts([
    [def.costFunds, p.resFunds],
    [def.costResearch, p.resResearch],
  ]);
}

/**
 * Roadmap B9: localized research cost for the owner RIGHT NOW —
 * level-scaled for repeatable upgrades (200×level research), the static
 * def cost otherwise. The research panel renders through this so the
 * price on the button always matches the sim's `researchUpgrade`
 * validate.
 */
export function formatResearchCostFor(world: World, owner: number, id: UpgradeId): string {
  const p = STRINGS.palettes;
  const cost = upgradeResearchCost(world, owner, id);
  return joinCostParts([
    [cost.costFunds, p.resFunds],
    [cost.costResearch, p.resResearch],
  ]);
}

/**
 * Roadmap B10 (economy legibility, 2026-10-02): the topbar chip rate
 * suffix and the Economy overview's per-resource rate column render
 * through this. Signed, one decimal, '/s' suffix; empty string when
 * the flow is negligible so the topbar stays quiet at rest. Pure (no
 * world) so headless tests can pin it.
 */
export function formatFlowRate(rate: number): string {
  if (!Number.isFinite(rate) || Math.abs(rate) < 0.05) return '';
  const sign = rate > 0 ? '+' : '−';
  return `${sign}${Math.abs(rate).toFixed(1)}/s`;
}

/**
 * Roadmap B9: localized upgrade name for the research panel —
 * repeatable upgrades show their current level ("Advanced Research ·
 * Lv 2") so the panel reads as a ladder; one-shot upgrades render the
 * plain name.
 */
export function upgradeDisplayName(world: World, owner: number, id: UpgradeId): string {
  const name = upgradeName(id);
  if (UPGRADE_DEFS[id].repeatable === true) {
    const level = repeatableUpgradeLevel(world, owner, id);
    return level > 0 ? `${name} · Lv ${level}` : name;
  }
  return name;
}

/** Multi-line train-button tooltip: cost, HP, then the lock reason. */
export function trainTooltip(world: World, owner: number, kind: UnitKind): string {
  const def = UNIT_DEFS[kind];
  const lines = [formatTrainCost(kind), `${loc(STRINGS.palettes.hpLabel)}: ${def.hp}`];
  // Fun-audit C1 (production queues, 2026-10-02): military cards show
  // the train time — the queue is the mechanic now.
  if (def.military === true && def.trainSeconds !== undefined) {
    lines.push(fillLoc(STRINGS.trainQueue.trainTime, { secs: def.trainSeconds }));
  }
  const av = unitAvailability(world, owner, kind);
  if (!av.ok) lines.push(av.reason);
  return lines.filter((l) => l.length > 0).join('\n');
}

/** Multi-line build-button tooltip: cost, plus the coast rule for navalYard. */
export function buildTooltip(kind: BuildingKind): string {
  const lines = [formatBuildCost(kind)];
  if (kind === 'navalYard') lines.push(loc(STRINGS.palettes.navalYardCoast));
  return lines.filter((l) => l.length > 0).join('\n');
}

/**
 * Train-placement toast after picking a palette entry: localized unit name
 * plus the land/sea placement hint (spec §8: sea units get "click WATER").
 */
export function trainPlacementToast(kind: UnitKind): string {
  const def = UNIT_DEFS[kind];
  const hint = loc(
    def.domain === 'sea' ? STRINGS.palettes.placeSeaHint : STRINGS.palettes.placeLandHint,
  );
  return fillLoc(STRINGS.palettes.trainToast, { name: unitName(kind), hint });
}
