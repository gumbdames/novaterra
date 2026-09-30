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
 * Utility plants (grand expansion, Phase 2): the 13-kind plant ladder,
 * research gating, hydro-dam coastal validation, pollution → water
 * fouling with treatment scrubbing, nuclear meltdowns, and the new
 * upgrade hooks.
 *
 * Command-level tests go through the real command queue (validation at
 * enqueue); allocation behavior is asserted via runEconomyTick.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  type TerrainData,
} from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  bumpUtilityEpoch,
  cellIndex,
  cellIsWater,
  placeBuilding,
  registerCityCommands,
  type BuildingKind,
  type BuildingRecord,
  type CityState,
} from '../src/sim/city';
import {
  createEconomySystem,
  runEconomyTick,
  ECONOMY_TICKS,
} from '../src/sim/economy';
import {
  UPGRADE_IDS,
  UPGRADE_DEFS,
  SMART_GRID_SUPPLY,
  DESALINATION_TECH_WATER_MULT,
  effectivePowerSupply,
  effectiveWaterSupply,
  decodeUpgrades,
  registerUpgradeCommands,
} from '../src/sim/upgrades';
import { meltdownOffline } from '../src/sim/utilityNetworks';
import type { Age } from '../src/sim/ages';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
}

function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.city.players[0]!.funds = 1e9;
  world.city.players[0]!.materials = 1e9;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerUpgradeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [createEconomySystem(terrain)],
  });
  return { terrain, world, queue, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

/** One economy second per iteration, from tick 0 (no driver). */
function runSeconds(world: World, terrain: TerrainData, seconds: number): void {
  for (let s = 0; s < seconds; s++) {
    world.tick += ECONOMY_TICKS;
    world.time = world.tick / ECONOMY_TICKS;
    runEconomyTick(world, terrain);
  }
}

function enqueue(ctx: Ctx, cmds: NewCommand[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, c);
}

/** Directly place a completed building (bypasses command validation). */
function completed(
  world: World,
  kind: BuildingKind,
  owner: number,
  cx: number,
  cz: number,
): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  return b;
}

function lay(
  city: CityState,
  field: 'roads' | 'powerLines' | 'pipes',
  cells: number[],
): void {
  const arr = city[field];
  for (const c of cells) {
    if (!arr.includes(c)) arr.push(c);
  }
  arr.sort((a, b) => a - b);
  bumpUtilityEpoch(city);
}

function row(cx0: number, cz: number, len: number): number[] {
  const cells: number[] = [];
  for (let i = 0; i < len; i++) cells.push(cellIndex(cx0 + i, cz));
  return cells;
}

function findLandRect(
  t: TerrainData,
  w: number,
  h: number,
): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= 256; cz++) {
    for (let cx = 0; cx + w <= 256; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error(`no ${w}x${h} land rect`);
}

/**
 * A wxh all-land rect whose footprint is (or is not) orthogonally
 * adjacent to water — mirrors city.ts isCoastal.
 */
function findShoreRect(
  t: TerrainData,
  w: number,
  h: number,
  wantCoastal: boolean,
): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= 256; cz++) {
    for (let cx = 0; cx + w <= 256; cx++) {
      let allLand = true;
      for (let dz = 0; dz < h && allLand; dz++) {
        for (let dx = 0; dx < w && allLand; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) allLand = false;
        }
      }
      if (!allLand) continue;
      let coastal = false;
      for (let dz = 0; dz < h && !coastal; dz++) {
        for (let dx = 0; dx < w && !coastal; dx++) {
          const px = cx + dx;
          const pz = cz + dz;
          if (
            (px > 0 && cellIsWater(t, px - 1, pz)) ||
            (px < 255 && cellIsWater(t, px + 1, pz)) ||
            (pz > 0 && cellIsWater(t, px, pz - 1)) ||
            (pz < 255 && cellIsWater(t, px, pz + 1))
          ) {
            coastal = true;
          }
        }
      }
      if (coastal === wantCoastal) return { cx, cz };
    }
  }
  throw new Error(`no ${wantCoastal ? 'coastal' : 'landlocked'} ${w}x${h} rect`);
}

// ---------------------------------------------------------------------------
// The 13-kind plant ladder
// ---------------------------------------------------------------------------

describe('plant ladder defs', () => {
  const kinds: BuildingKind[] = [
    'coalPlant',
    'gasPlant',
    'windFarm',
    'hydroDam',
    'geothermalPlant',
    'fusionPlant',
    'waterWell',
    'waterTower',
    'waterTreatment',
    'reservoir',
    'powerSubstation',
    'pumpingStation',
    'batteryStation',
  ];

  it('defines all 13 utility kinds', () => {
    for (const kind of kinds) {
      expect(BUILDING_DEFS[kind]).toBeDefined();
    }
    expect(kinds).toHaveLength(13);
  });

  it('climbs the supply ladder coal -> gas -> hydro -> geothermal -> fusion', () => {
    const s = (k: BuildingKind): number => BUILDING_DEFS[k].powerSupply;
    expect(s('coalPlant')).toBe(30);
    expect(s('gasPlant')).toBe(35);
    expect(s('hydroDam')).toBe(45);
    expect(s('geothermalPlant')).toBe(40);
    expect(s('fusionPlant')).toBe(120);
    expect(s('coalPlant')).toBeLessThan(s('gasPlant'));
    expect(s('gasPlant')).toBeLessThan(s('fusionPlant'));
  });

  it('marks storage, conduction and fouling flags', () => {
    expect(BUILDING_DEFS['batteryStation'].storageKind).toBe('power');
    expect(BUILDING_DEFS['batteryStation'].storageCapacity).toBe(300);
    expect(BUILDING_DEFS['waterTower'].storageKind).toBe('water');
    expect(BUILDING_DEFS['reservoir'].storageKind).toBe('water');
    expect(BUILDING_DEFS['powerSubstation'].conductsPower).toBe(true);
    expect(BUILDING_DEFS['pumpingStation'].conductsWater).toBe(true);
    expect(BUILDING_DEFS['coalPlant'].fouling).toBe(true);
    expect(BUILDING_DEFS['gasPlant'].fouling).toBe(true);
    expect(BUILDING_DEFS['powerPlant'].fouling).toBe(true);
    expect(BUILDING_DEFS['waterWell'].foulable).toBe(true);
    expect(BUILDING_DEFS['waterPump'].foulable).toBe(true);
  });

  it('gates the ladder behind research', () => {
    expect(BUILDING_DEFS['coalPlant'].requiredUpgrade).toBe('combustionTech');
    expect(BUILDING_DEFS['gasPlant'].requiredUpgrade).toBe('combustionTech');
    expect(BUILDING_DEFS['fusionPlant'].requiredUpgrade).toBe('fusionResearch');
    expect(BUILDING_DEFS['waterWell'].requiredUpgrade).toBe('groundwaterSurvey');
    expect(BUILDING_DEFS['batteryStation'].requiredUpgrade).toBe('gridStorage');
    expect(BUILDING_DEFS['waterTower'].requiredUpgrade).toBe('gridStorage');
    expect(BUILDING_DEFS['reservoir'].requiredUpgrade).toBe('gridStorage');
    // The classics stay ungated.
    expect(BUILDING_DEFS['powerPlant'].requiredUpgrade).toBeUndefined();
    expect(BUILDING_DEFS['waterPump'].requiredUpgrade).toBeUndefined();
    expect(BUILDING_DEFS['solarFarm'].requiredUpgrade).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Research gating (command level)
// ---------------------------------------------------------------------------

describe('research gating', () => {
  it('rejects gated plants until their upgrade is researched', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 20, 10);
    // Industry age so the age gate passes and the upgrade gate is the
    // blocker (coalPlant is minAge industry, waterWell foundation,
    // batteryStation connectivity).
    ctx.world.ages.age = 'industry' as Age;
    // No upgrades researched: gated kinds reject with the upgrade id.
    expect(() =>
      enqueue(ctx, [
        { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'coalPlant', owner: 0, cx, cz, facing: 0 } },
      ]),
    ).toThrow(/combustionTech/);
    expect(() =>
      enqueue(ctx, [
        { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'waterWell', owner: 0, cx: cx + 5, cz, facing: 0 } },
      ]),
    ).toThrow(/groundwaterSurvey/);
    expect(() =>
      enqueue(ctx, [
        { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'batteryStation', owner: 0, cx: cx + 10, cz, facing: 0 } },
      ]),
    ).toThrow(/gridStorage/);
    // Research the upgrades -> placement validates.
    ctx.world.upgrades[0] = ['combustionTech', 'groundwaterSurvey', 'gridStorage'];
    enqueue(ctx, [
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'coalPlant', owner: 0, cx, cz, facing: 0 } },
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'waterWell', owner: 0, cx: cx + 5, cz, facing: 0 } },
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'batteryStation', owner: 0, cx: cx + 10, cz, facing: 0 } },
    ]);
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings).toHaveLength(3);
  });

  it('chains the research ladder combustionTech -> advancedNuclear -> fusionResearch', () => {
    expect(UPGRADE_IDS).toHaveLength(18);
    expect(UPGRADE_DEFS['advancedNuclear'].requiredUpgrade).toBe('combustionTech');
    expect(UPGRADE_DEFS['fusionResearch'].requiredUpgrade).toBe('advancedNuclear');
    expect(UPGRADE_DEFS['combustionTech'].requiredUpgrade).toBeUndefined();
    // fusionPlant sits at the end of the chain.
    expect(BUILDING_DEFS['fusionPlant'].requiredUpgrade).toBe('fusionResearch');
  });

  it('enforces the upgrade prerequisite in researchUpgrade', () => {
    const ctx = setup();
    // A lab to research at, industry age for the ladder.
    const { cx, cz } = findLandRect(ctx.terrain, 20, 10);
    completed(ctx.world, 'lab', 0, cx, cz);
    ctx.world.city.players[0]!.research = 1e9;
    ctx.world.ages.age = 'industry' as Age;
    expect(() =>
      enqueue(ctx, [
        { kind: 'researchUpgrade', issuer: 'p', payload: { owner: 0, upgrade: 'advancedNuclear' } },
      ]),
    ).toThrow(/combustionTech/);
    ctx.world.upgrades[0] = ['combustionTech'];
    enqueue(ctx, [
      { kind: 'researchUpgrade', issuer: 'p', payload: { owner: 0, upgrade: 'advancedNuclear' } },
    ]);
    runTicks(ctx, 1);
    expect(ctx.world.upgrades[0]).toContain('advancedNuclear');
  });

  it('keeps the new upgrades through snapshot decode (unknown ids dropped)', () => {
    const decoded = decodeUpgrades({ 0: ['combustionTech', 'bogusUpgrade', 'gridStorage'] });
    expect(decoded[0]).toEqual(['combustionTech', 'gridStorage']);
  });
});

// ---------------------------------------------------------------------------
// Smart Grid + Desalination Tech hooks
// ---------------------------------------------------------------------------

describe('upgrade effect hooks', () => {
  it('extends Smart Grid to the new plant kinds', () => {
    expect(SMART_GRID_SUPPLY['coalPlant']).toBe(40);
    expect(SMART_GRID_SUPPLY['gasPlant']).toBe(45);
    expect(SMART_GRID_SUPPLY['windFarm']).toBe(10);
    expect(SMART_GRID_SUPPLY['hydroDam']).toBe(55);
    expect(SMART_GRID_SUPPLY['geothermalPlant']).toBe(50);
    expect(SMART_GRID_SUPPLY['fusionPlant']).toBe(150);
    // Old kinds unchanged.
    expect(SMART_GRID_SUPPLY['powerPlant']).toBe(35);
    const { world } = setup();
    expect(effectivePowerSupply(world, 0, 'coalPlant', 30)).toBe(30);
    world.upgrades[0] = ['smartGrid'];
    expect(effectivePowerSupply(world, 0, 'coalPlant', 30)).toBe(40);
    expect(effectivePowerSupply(world, 0, 'fusionPlant', 120)).toBe(150);
  });

  it('boosts desalination output x1.5 with desalinationTech', () => {
    expect(DESALINATION_TECH_WATER_MULT).toBe(1.5);
    const { world } = setup();
    expect(effectiveWaterSupply(world, 0, 'desalination', 40)).toBe(40);
    // Other plants are unaffected by the tech.
    world.upgrades[0] = ['desalinationTech'];
    expect(effectiveWaterSupply(world, 0, 'desalination', 40)).toBe(60);
    expect(effectiveWaterSupply(world, 0, 'waterPump', 25)).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Hydro dam coastal validation
// ---------------------------------------------------------------------------

describe('hydroDam placement', () => {
  it('requires water adjacency', () => {
    const ctx = setup();
    ctx.world.ages.age = 'industry' as Age;
    const land = findShoreRect(ctx.terrain, 4, 2, false);
    expect(() =>
      enqueue(ctx, [
        { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'hydroDam', owner: 0, cx: land.cx, cz: land.cz, facing: 0 } },
      ]),
    ).toThrow(/adjacent to water/);
  });

  it('accepts a coastal site', () => {
    const ctx = setup();
    ctx.world.ages.age = 'industry' as Age;
    const shore = findShoreRect(ctx.terrain, 4, 2, true);
    enqueue(ctx, [
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'hydroDam', owner: 0, cx: shore.cx, cz: shore.cz, facing: 0 } },
    ]);
    runTicks(ctx, 1);
    expect(
      ctx.world.city.buildings.some((b) => b.kind === 'hydroDam'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pollution -> fouling -> scrubbing
// ---------------------------------------------------------------------------

describe('fouling and scrubbing', () => {
  it('halves a fouled well and restores it via treatment', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 60, 12);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 50));
    // Coal plant (fouling) on the road; well orthogonally adjacent to
    // the plant's footprint, also on the road.
    const coal = completed(world, 'coalPlant', 0, cx + 1, rz - 3);
    const well = completed(world, 'waterWell', 0, cx + 4, rz - 2);
    const houses: BuildingRecord[] = [];
    for (let i = 0; i < 4; i++) {
      houses.push(completed(world, 'house', 0, cx + 12 + i * 4, rz - 2));
    }
    // Power-line spur from the road; the treatment sits at its far end,
    // touching the line (power) but NOT the road (water), so its own 20
    // supply can't mask the well. It still scrubs positionally.
    lay(world.city, 'powerLines', row(cx + 30, rz + 1, 8));
    void coal;
    // Tick 1: coal online (1-tick bootstrap) fouls the adjacent well:
    // 10 -> 5 supply against 3 (coal) + 4 (houses) = 7 demand.
    runSeconds(world, terrain, 1);
    const watered1 = [well, ...houses].filter((b) => b.watered).length;
    expect(watered1).toBeLessThan(5);
    expect(houses[2]!.waterDiag).toBe('shortage');
    expect(houses[3]!.waterDiag).toBe('shortage');
    // The well itself is a networked plant: 'ok' even while fouled.
    expect(well.waterDiag).toBe('ok');
    // Tick 2: a treatment plant arrives at the far end of the power-line
    // spur. It is powered via the line and scrubs the well positionally.
    const treatment = completed(world, 'waterTreatment', 0, cx + 36, rz + 2);
    runSeconds(world, terrain, 2);
    expect(well.waterDiag).toBe('ok');
    for (const h of houses) {
      expect(h.watered).toBe(true);
      expect(h.waterDiag).toBe('ok');
    }
    // The stranded treatment flags itself on water...
    expect(treatment.waterDiag).toBe('disconnected');
    // ...but is fine on power (the line spur).
    expect(treatment.powerDiag).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Nuclear meltdown
// ---------------------------------------------------------------------------

describe('nuclear meltdown', () => {
  // Seed 6855: building id 1 melts down at economy tick 5, clean before.
  it('takes a melting plant offline with a shortage flag', () => {
    const { terrain, world } = setup(6855);
    const { cx, cz } = findLandRect(terrain, 40, 12);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 40));
    // The nuclear plant MUST be building id 1 for the seeded meltdown,
    // and adjacent to the road so the pump can water it.
    const nuke = completed(world, 'nuclearPlant', 0, cx + 1, rz - 4);
    expect(nuke.id).toBe(1);
    const pump = completed(world, 'waterPump', 0, cx + 7, rz + 1);
    const house = completed(world, 'house', 0, cx + 12, rz - 2);
    void pump;
    // Tick 1: 1-tick bootstrap (assumed watered) -> online.
    runSeconds(world, terrain, 1);
    expect(nuke.powerDiag).toBe('ok');
    expect(house.powered).toBe(true);
    // Ticks 2-4: watered for real, no meltdown -> online.
    runSeconds(world, terrain, 3);
    expect(nuke.powerDiag).toBe('ok');
    expect(house.powered).toBe(true);
    // Tick 5: meltdown -> offline for 180 s, shortage flag, dark houses.
    // (The house reads 'disconnected': with its only plant melted the
    // network collapses, so the house is unreached, not reached-short.)
    runSeconds(world, terrain, 1);
    expect(nuke.powerDiag).toBe('shortage');
    expect(house.powered).toBe(false);
    expect(house.powerDiag).toBe('disconnected');
    // Still offline much later (180-second outage).
    runSeconds(world, terrain, 60);
    expect(nuke.powerDiag).toBe('shortage');
  });

  it('is seeded-reproducible across identical runs', () => {
    const run = (): string => {
      const { terrain, world } = setup(6855);
      const { cx, cz } = findLandRect(terrain, 40, 12);
      const rz = cz + 5;
      lay(world.city, 'roads', row(cx, rz, 40));
      completed(world, 'nuclearPlant', 0, cx + 1, rz - 4);
      completed(world, 'waterPump', 0, cx + 7, rz + 1);
      completed(world, 'house', 0, cx + 12, rz - 2);
      const diags: string[] = [];
      for (let s = 0; s < 8; s++) {
        runSeconds(world, terrain, 1);
        const nuke = world.city.buildings[0]!;
        diags.push(`${nuke.powerDiag}:${nuke.powered}`);
      }
      return diags.join('|');
    };
    expect(run()).toBe(run());
  });
});

// ---------------------------------------------------------------------------
// Conductor commands (validation + epoch)
// ---------------------------------------------------------------------------

describe('conductor commands', () => {
  it('buildPowerLine validates cells, cost and overlap', () => {
    const ctx = setup();
    const player = ctx.world.city.players[0]!;
    const cells = [cellIndex(10, 10), cellIndex(11, 10)];
    const epoch = ctx.world.city.utilityEpoch;
    enqueue(ctx, [
      { kind: 'buildPowerLine', issuer: 'p', payload: { owner: 0, cells } },
    ]);
    runTicks(ctx, 1);
    expect(ctx.world.city.powerLines).toEqual(cells);
    expect(ctx.world.city.utilityEpoch).toBe(epoch + 1);
    expect(player.funds).toBeLessThan(1e9);
    // Overlap with the existing line rejects.
    expect(() =>
      enqueue(ctx, [
        { kind: 'buildPowerLine', issuer: 'p', payload: { owner: 0, cells: [cellIndex(10, 10)] } },
      ]),
    ).toThrow(/already has a power line/);
    // Empty and oversize arrays reject.
    expect(() =>
      enqueue(ctx, [{ kind: 'buildPowerLine', issuer: 'p', payload: { owner: 0, cells: [] } }]),
    ).toThrow(/non-empty/);
    expect(() =>
      enqueue(ctx, [
        { kind: 'buildPowerLine', issuer: 'p', payload: { owner: 0, cells: new Array(513).fill(0).map((_, i) => i) } },
      ]),
    ).toThrow(/at most 512/);
  });

  it('buildPipe mirrors buildPowerLine for water', () => {
    const ctx = setup();
    const cells = [cellIndex(20, 20), cellIndex(21, 20)];
    enqueue(ctx, [
      { kind: 'buildPipe', issuer: 'p', payload: { owner: 0, cells } },
    ]);
    runTicks(ctx, 1);
    expect(ctx.world.city.pipes).toEqual(cells);
  });

  it('demolish removes lines and pipes cell-wise and bumps the epoch', () => {
    const ctx = setup();
    const cell = cellIndex(30, 30);
    lay(ctx.world.city, 'powerLines', [cell]);
    const epoch = ctx.world.city.utilityEpoch;
    enqueue(ctx, [
      { kind: 'demolish', issuer: 'p', payload: { cx: 30, cz: 30 } },
    ]);
    runTicks(ctx, 1);
    expect(ctx.world.city.powerLines).toEqual([]);
    expect(ctx.world.city.utilityEpoch).toBe(epoch + 1);
    // Nothing left to demolish now.
    expect(() =>
      enqueue(ctx, [{ kind: 'demolish', issuer: 'p', payload: { cx: 30, cz: 30 } }]),
    ).toThrow(/nothing to demolish/);
  });

  it('splitting a line with demolish re-runs the flood fill', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 60, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 8));
    completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    // One continuous line to a far house (cx+36: footprint touches a
    // line cell).
    lay(world.city, 'powerLines', row(cx + 8, rz, 30));
    const far = completed(world, 'house', 0, cx + 36, rz - 2);
    runSeconds(world, terrain, 2);
    expect(far.powered).toBe(true);
    // Cut the line in the middle: the house strands (pool fallback has
    // no unreached supply — the plant is networked, not pooled).
    const cut = cellIndex(cx + 20, rz);
    world.city.powerLines.splice(world.city.powerLines.indexOf(cut), 1);
    bumpUtilityEpoch(world.city);
    runSeconds(world, terrain, 2);
    expect(far.powered).toBe(false);
    expect(far.powerDiag).toBe('disconnected');
  });
});
