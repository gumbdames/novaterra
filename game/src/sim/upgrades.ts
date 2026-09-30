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
 * NOVATERRA — sim/upgrades.ts — the upgrade (tech) system.
 *
 * Responsibilities:
 *  - The 12 researchable upgrades (docs/research/roster-expansion.md §4):
 *    8 military, 4 economy. Static defs (id, name, funds + research cost,
 *    prerequisite buildings / age / upgrade).
 *  - Per-player researched sets live on `world.upgrades` (player id ->
 *    upgrade ids), snapshotted (v6) and digested.
 *  - The `researchUpgrade` command: researched at the lab (the single
 *    research site; the university boosts research income instead).
 *  - `effective*` stat helpers: every upgrade's mechanical effect is
 *    applied at the existing computation points (combat damageMultiplier,
 *    spawn stats, sight/range reads, economy production) via these pure
 *    helpers — upgrades never store per-unit state.
 *  - Phase 2 (grand expansion) adds the utility research ladder:
 *    combustionTech → advancedNuclear → fusionResearch unlock the
 *    plant ladder in city.ts; groundwaterSurvey / desalinationTech /
 *    gridStorage unlock the water and storage sides.
 *
 * Upgrade-design rules (locked by the spec): every upgrade changes a
 * capability number; no upgrade has more than two prerequisite *slots*
 * (buildings count as one slot, age as the other).
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { Age } from './ages';
import { isUnitAvailableForAge } from './ages';
import type { BuildingKind } from './city';
import { getPlayer, BUILDING_DEFS, hasProductionBuilding } from './city';
import type { CommandQueue } from './commands';
import type { UnitDef } from './units';

/** The 18 upgrade ids (roster expansion's 12 + Phase 2's utility ladder 6). */
export const UPGRADE_IDS = [
  'apRounds',
  'compositeArmor',
  'engineTuning',
  'advancedAvionics',
  'sonarSuite',
  'cruiseMissiles',
  'droneOptics',
  'fieldMedicine',
  'precisionManufacturing',
  'smartGrid',
  'verticalFarming',
  'freeTrade',
  // Phase 2: the utility research ladder (grand expansion §4).
  'combustionTech',
  'advancedNuclear',
  'fusionResearch',
  'groundwaterSurvey',
  'desalinationTech',
  'gridStorage',
] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];

/** Static definition of one upgrade. */
export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  /** Funds cost (deducted from the player's stockpile). */
  costFunds: number;
  /** Research cost (deducted from the player's research stockpile). */
  costResearch: number;
  /**
   * Production/research buildings the owner must have completed (progress
   * >= 1). Counts as one prerequisite slot no matter the length.
   */
  requiredBuildings: BuildingKind[];
  /** Minimum age (second prerequisite slot). */
  minAge: Age;
  /** Another upgrade that must already be researched (unused by the 12, supported for later). */
  requiredUpgrade?: UpgradeId;
}

export const UPGRADE_DEFS: Record<UpgradeId, UpgradeDef> = {
  apRounds: {
    id: 'apRounds', name: 'AP Rounds', costFunds: 800, costResearch: 60,
    requiredBuildings: ['warFactory'], minAge: 'industry',
  },
  compositeArmor: {
    id: 'compositeArmor', name: 'Composite Armor', costFunds: 1000, costResearch: 80,
    requiredBuildings: ['warFactory'], minAge: 'industry',
  },
  engineTuning: {
    id: 'engineTuning', name: 'Engine Tuning', costFunds: 600, costResearch: 40,
    requiredBuildings: [], minAge: 'connectivity',
  },
  advancedAvionics: {
    id: 'advancedAvionics', name: 'Advanced Avionics', costFunds: 1200, costResearch: 120,
    requiredBuildings: ['airfield', 'radarStation'], minAge: 'information',
  },
  sonarSuite: {
    id: 'sonarSuite', name: 'Sonar Suite', costFunds: 900, costResearch: 80,
    requiredBuildings: ['navalYard'], minAge: 'industry',
  },
  cruiseMissiles: {
    id: 'cruiseMissiles', name: 'Cruise Missiles', costFunds: 1500, costResearch: 150,
    requiredBuildings: ['radarStation'], minAge: 'information',
  },
  droneOptics: {
    id: 'droneOptics', name: 'Drone Optics', costFunds: 500, costResearch: 50,
    requiredBuildings: [], minAge: 'connectivity',
  },
  fieldMedicine: {
    id: 'fieldMedicine', name: 'Field Medicine', costFunds: 700, costResearch: 60,
    requiredBuildings: ['hospital', 'barracks'], minAge: 'connectivity',
  },
  precisionManufacturing: {
    id: 'precisionManufacturing', name: 'Precision Manufacturing', costFunds: 1200, costResearch: 100,
    requiredBuildings: [], minAge: 'industry',
  },
  smartGrid: {
    id: 'smartGrid', name: 'Smart Grid', costFunds: 1000, costResearch: 100,
    requiredBuildings: [], minAge: 'industry',
  },
  verticalFarming: {
    id: 'verticalFarming', name: 'Vertical Farming', costFunds: 900, costResearch: 80,
    requiredBuildings: [], minAge: 'industry',
  },
  freeTrade: {
    id: 'freeTrade', name: 'Free Trade Policy', costFunds: 1500, costResearch: 200,
    requiredBuildings: ['market'], minAge: 'information',
  },
  // Phase 2: the utility research ladder (grand expansion §4). Every
  // upgrade changes a capability number; none exceeds the two-slot
  // prerequisite limit (age = one slot, upgrade-chain = the other).
  combustionTech: {
    id: 'combustionTech', name: 'Combustion Tech', costFunds: 800, costResearch: 60,
    requiredBuildings: [], minAge: 'connectivity',
  },
  advancedNuclear: {
    id: 'advancedNuclear', name: 'Advanced Nuclear', costFunds: 1500, costResearch: 150,
    requiredBuildings: [], minAge: 'industry', requiredUpgrade: 'combustionTech',
  },
  fusionResearch: {
    id: 'fusionResearch', name: 'Fusion Research', costFunds: 3000, costResearch: 400,
    requiredBuildings: [], minAge: 'ascendance', requiredUpgrade: 'advancedNuclear',
  },
  groundwaterSurvey: {
    id: 'groundwaterSurvey', name: 'Groundwater Survey', costFunds: 500, costResearch: 40,
    requiredBuildings: [], minAge: 'foundation',
  },
  desalinationTech: {
    id: 'desalinationTech', name: 'Desalination Tech', costFunds: 1000, costResearch: 100,
    requiredBuildings: [], minAge: 'industry',
  },
  gridStorage: {
    id: 'gridStorage', name: 'Grid Storage', costFunds: 900, costResearch: 80,
    requiredBuildings: [], minAge: 'connectivity',
  },
};

/** Fresh upgrade state: no player has researched anything. */
export function initUpgrades(): Record<number, string[]> {
  return {};
}

/** True when the player has researched the upgrade. */
export function hasUpgrade(world: World, owner: number, id: string): boolean {
  const list = world.upgrades[owner];
  return list !== undefined && list.includes(id);
}

/** Canonical encoding for snapshots (deep copy). */
export function encodeUpgrades(upgrades: Record<number, string[]>): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const owner of Object.keys(upgrades)) {
    out[Number(owner)] = [...(upgrades[Number(owner)] as string[])];
  }
  return out;
}

/**
 * Restore upgrade state from a snapshot payload. Unknown ids are dropped
 * (defensive); a missing payload decodes to "nothing researched" so older
 * saves load cleanly.
 */
export function decodeUpgrades(data: unknown): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  if (data === null || typeof data !== 'object') return out;
  for (const [owner, ids] of Object.entries(data as Record<string, unknown>)) {
    const n = Number(owner);
    if (!Number.isInteger(n) || !Array.isArray(ids)) continue;
    const valid = (ids as unknown[]).filter(
      (id): id is string => typeof id === 'string' && (UPGRADE_IDS as readonly string[]).includes(id),
    );
    out[n] = [...new Set(valid)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effect hooks — pure helpers applied at the existing computation points.
// ---------------------------------------------------------------------------

/** AP Rounds: +40% vsHeavy for tank, tankDestroyer, apc. */
export const AP_ROUNDS_VS_HEAVY_MULT = 1.4;
export const AP_ROUNDS_KINDS = ['tank', 'tankDestroyer', 'apc'];

/** Composite Armor: +30% max hp at spawn (no retroactive heal). */
export const COMPOSITE_ARMOR_HP_MULT = 1.3;
export const COMPOSITE_ARMOR_KINDS = ['tank', 'tankDestroyer', 'apc', 'artillery', 'mlrs'];

/** Engine Tuning: +25% speed at spawn. */
export const ENGINE_TUNING_SPEED_MULT = 1.25;
export const ENGINE_TUNING_KINDS = ['tank', 'apc', 'tankDestroyer', 'artillery', 'mlrs', 'aa'];

/** Advanced Avionics: +25% sight / +20% vsAir for fighters; awacs +15 sight. */
export const AVIONICS_SIGHT_MULT = 1.25;
export const AVIONICS_VS_AIR_MULT = 1.2;
export const AVIONICS_KINDS = ['fighter', 'fighterBomber', 'attackHeli'];
export const AVIONICS_AWACS_SIGHT_BONUS = 15;

/** Sonar Suite: +30% vsMedium (ASW) for frigate/destroyer; all sea units +8 sight. */
export const SONAR_VS_MEDIUM_MULT = 1.3;
export const SONAR_KINDS = ['frigate', 'destroyer'];
export const SONAR_SEA_SIGHT_BONUS = 8;

/** Cruise Missiles: mlrs +10 range, artillery +8 range. */
export const CRUISE_MISSILE_RANGE_BONUS: Record<string, number> = {
  mlrs: 10,
  artillery: 8,
};

/** Drone Optics: drone +15 sight, spectre +10 sight. */
export const DRONE_OPTICS_SIGHT_BONUS: Record<string, number> = {
  drone: 15,
  spectre: 10,
};

/** Field Medicine: combatMedic heal 2 -> 4 hp/s; rifles/sniperTeam/spectre +20 max hp. */
export const FIELD_MEDICINE_HEAL_PER_SEC = 4;
export const FIELD_MEDICINE_HP_BONUS = 20;
export const FIELD_MEDICINE_HP_KINDS = ['rifles', 'sniperTeam', 'spectre'];

/** Precision Manufacturing: factory output +25% (stacks with Heavy Industry). */
export const PRECISION_MANUFACTURING_MULT = 1.25;

/** Smart Grid: power supply boosts per plant kind (Phase 2 ladder added). */
export const SMART_GRID_SUPPLY: Record<string, number> = {
  powerPlant: 35,
  solarFarm: 20,
  nuclearPlant: 75,
  coalPlant: 40,
  gasPlant: 45,
  windFarm: 10,
  hydroDam: 55,
  geothermalPlant: 50,
  fusionPlant: 150,
};

/** Vertical Farming: farm food x1.5, farm water demand 4 -> 3. */
export const VERTICAL_FARMING_FOOD_MULT = 1.5;
export const VERTICAL_FARMING_WATER_DEMAND = 3;

/** Desalination Tech (Phase 2): desalination water output x1.5. */
export const DESALINATION_TECH_WATER_MULT = 1.5;

/** Water supply of a water plant, with Desalination Tech applied (desalination only). */
export function effectiveWaterSupply(world: World, owner: number, kind: string, base: number): number {
  if (kind === 'desalination' && hasUpgrade(world, owner, 'desalinationTech')) {
    return base * DESALINATION_TECH_WATER_MULT;
  }
  return base;
}

/** Free Trade: market funds x1.5, trade-route income 3 -> 4.5, shop funds x1.25. */
export const FREE_TRADE_MARKET_MULT = 1.5;
export const FREE_TRADE_TRADE_ROUTE_INCOME = 4.5;
export const FREE_TRADE_SHOP_MULT = 1.25;

/** Max (spawn) hp for a unit, with Composite Armor / Field Medicine applied. */
export function effectiveMaxHp(world: World, owner: number, def: UnitDef): number {
  let hp = def.hp;
  if (hasUpgrade(world, owner, 'compositeArmor') && COMPOSITE_ARMOR_KINDS.includes(def.kind)) {
    hp *= COMPOSITE_ARMOR_HP_MULT;
  }
  if (hasUpgrade(world, owner, 'fieldMedicine') && FIELD_MEDICINE_HP_KINDS.includes(def.kind)) {
    hp += FIELD_MEDICINE_HP_BONUS;
  }
  return hp;
}

/** Spawn speed for a unit, with Engine Tuning applied. */
export function effectiveSpeed(world: World, owner: number, def: UnitDef): number {
  if (hasUpgrade(world, owner, 'engineTuning') && ENGINE_TUNING_KINDS.includes(def.kind)) {
    return def.speed * ENGINE_TUNING_SPEED_MULT;
  }
  return def.speed;
}

/** Sight range, with Drone Optics / Advanced Avionics / Sonar Suite applied. */
export function effectiveSight(world: World, owner: number, def: UnitDef): number {
  let sight = def.sight;
  if (hasUpgrade(world, owner, 'advancedAvionics')) {
    if (AVIONICS_KINDS.includes(def.kind)) sight *= AVIONICS_SIGHT_MULT;
    if (def.kind === 'awacs') sight += AVIONICS_AWACS_SIGHT_BONUS;
  }
  const droneBonus = DRONE_OPTICS_SIGHT_BONUS[def.kind];
  if (droneBonus !== undefined && hasUpgrade(world, owner, 'droneOptics')) {
    sight += droneBonus;
  }
  if (def.domain === 'sea' && hasUpgrade(world, owner, 'sonarSuite')) {
    sight += SONAR_SEA_SIGHT_BONUS;
  }
  return sight;
}

/** Weapon range, with Cruise Missiles applied. */
export function effectiveRange(world: World, owner: number, def: UnitDef): number {
  const bonus = CRUISE_MISSILE_RANGE_BONUS[def.kind];
  if (bonus !== undefined && hasUpgrade(world, owner, 'cruiseMissiles')) {
    return def.range + bonus;
  }
  return def.range;
}

/** Heal-aura rate for a medic, with Field Medicine applied. */
export function effectiveHealPerSec(world: World, owner: number, def: UnitDef): number {
  const base = def.healPerSec ?? 0;
  if (base <= 0) return 0;
  return hasUpgrade(world, owner, 'fieldMedicine') ? FIELD_MEDICINE_HEAL_PER_SEC : base;
}

/** Power supply of a plant building, with Smart Grid applied. */
export function effectivePowerSupply(world: World, owner: number, kind: string, base: number): number {
  if (hasUpgrade(world, owner, 'smartGrid')) {
    const boosted = SMART_GRID_SUPPLY[kind];
    if (boosted !== undefined) return boosted;
  }
  return base;
}

/** Water demand of a building, with Vertical Farming applied (farm only). */
export function effectiveWaterDemand(world: World, owner: number, kind: string, base: number): number {
  if (kind === 'farm' && hasUpgrade(world, owner, 'verticalFarming')) {
    return VERTICAL_FARMING_WATER_DEMAND;
  }
  return base;
}

// ---------------------------------------------------------------------------
// researchUpgrade command
// ---------------------------------------------------------------------------

/** Register the `researchUpgrade` command kind on a queue. */
export function registerUpgradeCommands(queue: CommandQueue): void {
  queue.register('researchUpgrade', {
    validate(cmd, world): string | null {
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner) || !getPlayer(world.city, owner)) {
        return 'researchUpgrade: unknown owner';
      }
      const id = cmd.payload['upgrade'];
      if (typeof id !== 'string' || !(UPGRADE_IDS as readonly string[]).includes(id)) {
        return `researchUpgrade: upgrade must be one of ${UPGRADE_IDS.join(', ')}`;
      }
      if (hasUpgrade(world, owner, id)) {
        return `researchUpgrade: ${id} already researched`;
      }
      // Research happens at the lab — the single research site.
      if (!hasProductionBuilding(world, owner, 'lab')) {
        return 'researchUpgrade: requires a completed Research Lab';
      }
      const def = UPGRADE_DEFS[id as UpgradeId];
      // Age gate.
      if (!isUnitAvailableForAge(world, def.minAge)) {
        return `researchUpgrade: ${def.name} requires the ${def.minAge} age`;
      }
      // Building prerequisites.
      for (const kind of def.requiredBuildings) {
        if (!hasProductionBuilding(world, owner, kind)) {
          const name = BUILDING_DEFS[kind]?.name ?? kind;
          return `researchUpgrade: ${def.name} requires a completed ${name}`;
        }
      }
      // Upgrade prerequisite.
      if (def.requiredUpgrade && !hasUpgrade(world, owner, def.requiredUpgrade)) {
        return `researchUpgrade: ${def.name} requires ${def.requiredUpgrade} first`;
      }
      // Affordability (funds + research stockpile), checked at enqueue AND apply.
      const player = getPlayer(world.city, owner);
      if (!player || player.funds < def.costFunds || player.research < def.costResearch) {
        return `researchUpgrade: cannot afford ${def.name} (${def.costFunds} funds + ${def.costResearch} research)`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = cmd.payload['owner'] as number;
      const id = cmd.payload['upgrade'] as UpgradeId;
      const def = UPGRADE_DEFS[id];
      // Re-check affordability at apply (state may have changed since enqueue).
      const player = getPlayer(world.city, owner);
      if (!player || player.funds < def.costFunds || player.research < def.costResearch) {
        throw new Error(`researchUpgrade: cannot afford ${def.name} at apply time`);
      }
      player.funds -= def.costFunds;
      player.research -= def.costResearch;
      const list = world.upgrades[owner] ?? [];
      if (!list.includes(id)) list.push(id);
      world.upgrades[owner] = list;
      return id;
    },
  });
}
