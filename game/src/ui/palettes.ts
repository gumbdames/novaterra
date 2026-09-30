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
 *  - The tab groupings (spec §8): 4 train tabs for the 28 units, 6 build
 *    tabs for the 30 buildings, 2 research groups for the 12 upgrades.
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
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { BUILDING_DEFS, type BuildingKind, getPlayer } from '../sim/city';
import { isUnitAvailableForAge } from '../sim/ages';
import {
  UPGRADE_DEFS,
  hasUpgrade,
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

export type TrainTabId = 'infantry' | 'armor' | 'air' | 'navy';

export interface TrainTab {
  id: TrainTabId;
  kinds: readonly UnitKind[];
}

/** 28 units across 4 tabs. Every unit kind appears in exactly one tab. */
export const TRAIN_TABS: readonly TrainTab[] = [
  {
    id: 'infantry',
    kinds: ['engineer', 'rifles', 'sniperTeam', 'spectre', 'combatMedic', 'hauler'],
  },
  {
    id: 'armor',
    // Grand-expansion Phase 3 (logistics): the supply trucks ride with
    // the land vehicles (no production gate — logistics must work from
    // the start, like the hauler precedent in infantry).
    kinds: ['tank', 'apc', 'tankDestroyer', 'artillery', 'mlrs', 'aa', 'hq', 'supplyTruck', 'fuelTruck'],
  },
  {
    id: 'air',
    kinds: ['fighter', 'fighterBomber', 'attackHeli', 'drone', 'awacs', 'transport'],
  },
  {
    id: 'navy',
    kinds: [
      'patrolBoat',
      'missileBoat',
      'frigate',
      'submarine',
      'destroyer',
      'carrier',
      'commandShip',
      'transportShip',
      'fishingBoat',
    ],
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
  | 'logistics';

export interface BuildTab {
  id: BuildTabId;
  kinds: readonly BuildingKind[];
}

/** 55 buildings across 10 tabs. Every building kind appears in exactly one. */
export const BUILD_TABS: readonly BuildTab[] = [
  { id: 'housing', kinds: ['house', 'apartment'] },
  // Workstream Z (2026-09-30): the civic tab — the four education
  // buildings (kindergarten/school/college/university) together. The
  // hospital stays in Commerce (leave-hospital-alone rule).
  // Workstream W (2026-09-30): the two civic amenities (library/park)
  // join the civic tab — they raise nearby residential desirability.
  // Workstream P (ambient city life, 2026-09-30): civic parking joins
  // them — the same desirability story (convenience amenities).
  { id: 'civic', kinds: ['kindergarten', 'school', 'college', 'university', 'library', 'park', 'parkingLot', 'parkingGarage'] },
  {
    id: 'commerce',
    kinds: ['shop', 'market', 'lab', 'mediaCenter', 'hospital'],
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
    kinds: ['shipyard', 'navalYard', 'airfield', 'radarStation'],
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

export type UpgradeGroupId = 'military' | 'economy' | 'infrastructure' | 'logistics';

export interface UpgradeGroup {
  id: UpgradeGroupId;
  ids: readonly UpgradeId[];
}

/** 19 upgrades in 4 research groups. */
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
    ids: ['precisionManufacturing', 'smartGrid', 'verticalFarming', 'freeTrade'],
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
  if (!isUnitAvailableForAge(world, def.minAge)) {
    return {
      ok: false,
      reason: fillLoc(p.requiresAge, { age: loc(STRINGS.ageNames[def.minAge]) }),
    };
  }
  if (def.requiredBuilding !== undefined && !hasCompletedBuilding(world, owner, def.requiredBuilding)) {
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
  if (!isUnitAvailableForAge(world, def.minAge)) {
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
  if (hasUpgrade(world, owner, id)) {
    return { state: 'researched', reason: loc(p.alreadyResearched) };
  }
  if (!hasCompletedBuilding(world, owner, 'lab')) {
    return { state: 'locked', reason: loc(p.needsLab) };
  }
  if (!isUnitAvailableForAge(world, def.minAge)) {
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
  if (
    player === undefined ||
    player.funds < def.costFunds ||
    player.research < def.costResearch
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

/** Multi-line train-button tooltip: cost, HP, then the lock reason. */
export function trainTooltip(world: World, owner: number, kind: UnitKind): string {
  const def = UNIT_DEFS[kind];
  const lines = [formatTrainCost(kind), `${loc(STRINGS.palettes.hpLabel)}: ${def.hp}`];
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
