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
 * ui/utilities.ts contract tests (grand-expansion Phase 2).
 *
 * The sim workstream landed in the same tree (2026-09-30), so these tests
 * verify the REAL contract, not the pre-sim defensive stubs:
 *  - the 12 utility kinds are the sim's BuildingKind entries
 *    (verified against sim/city.ts, not a local wish list);
 *  - diag readers honor the sim's powerDiag/waterDiag fields;
 *  - stranded-plant detection mirrors the sim's own stranded rule
 *    (economy.ts: producer def with supply > 0 and diag 'disconnected');
 *  - network cell reads hit the sim's city.powerLines / city.pipes;
 *  - palette availability/cost now take the standard BUILDING_DEFS path;
 *  - the overlay-data builder derives markers/tints from real fields.
 *
 * Headless (no DOM/three.js): the module under test is pure.
 */
import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS, type BuildingKind, type BuildingRecord } from '../src/sim/city';
import { createSession } from '../src/ui/session';
import { buildingAvailability } from '../src/ui/palettes';
import {
  allBuildTabs,
  buildingFouledSource,
  buildingPowerDiag,
  buildingUtilityLine,
  buildingWaterDiag,
  cityPipes,
  cityPowerLines,
  isStrandedPlant,
  isUtilityBuildingKind,
  POWER_PRODUCER_KINDS,
  UTILITY_BUILDING_KINDS,
  UTILITY_BUILDING_NAMES,
  UTILITY_BUILD_TABS,
  utilityBuildingAvailability,
  utilityBuildingName,
  utilityBuildTooltip,
  formatUtilityBuildCost,
  utilityOverlayData,
  WATER_PRODUCER_KINDS,
} from '../src/ui/utilities';

const UTILITY_TWELVE = [
  'coalPlant', 'gasPlant', 'windFarm', 'hydroDam',
  'geothermalPlant', 'fusionPlant', 'waterWell', 'waterTower',
  'waterTreatment', 'reservoir', 'powerSubstation', 'pumpingStation',
  'batteryStation',
] as const;

/** A minimal building record the UI layer can reason about. */
function fakeBuilding(over: Partial<BuildingRecord> = {}): BuildingRecord {
  return {
    id: 1,
    kind: 'house',
    owner: 1,
    cx: 10,
    cz: 10,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
    ...over,
  } as BuildingRecord;
}

describe('the Phase 2 utility roster', () => {
  it('lists exactly the 13 utility kinds', () => {
    expect([...UTILITY_TWELVE]).toEqual([...UTILITY_BUILDING_KINDS]);
    expect(new Set(UTILITY_BUILDING_KINDS).size).toBe(13);
  });

  it('matches the sim\'s BuildingKind entries (verified, not assumed)', () => {
    for (const kind of UTILITY_TWELVE) {
      expect(
        (Object.values(BUILDING_DEFS) as Array<{ kind: string }>).some(
          (d) => d.kind === kind,
        ),
        `${kind}: no sim def`,
      ).toBe(true);
    }
  });

  it('has a distinct human-readable name for every kind', () => {
    expect(Object.keys(UTILITY_BUILDING_NAMES)).toHaveLength(13);
    const names = new Set<string>();
    for (const kind of UTILITY_TWELVE) {
      const name = utilityBuildingName(kind);
      expect(name).toBe(UTILITY_BUILDING_NAMES[kind].en);
      expect(names.has(name), `${kind}: name reused`).toBe(false);
      names.add(name);
    }
    expect(names.size).toBe(13);
  });

  it('isUtilityBuildingKind agrees with the roster', () => {
    for (const kind of UTILITY_TWELVE) {
      expect(isUtilityBuildingKind(kind)).toBe(true);
    }
    expect(isUtilityBuildingKind('house')).toBe(false);
    expect(isUtilityBuildingKind('powerLine')).toBe(false);
  });
});

describe('build tabs', () => {
  it('defines the power and waterNet tabs with the full roster', () => {
    expect(UTILITY_BUILD_TABS.map((t) => t.id)).toEqual(['power', 'waterNet']);
    const powerKinds = UTILITY_BUILD_TABS[0]!.kinds;
    const waterKinds = UTILITY_BUILD_TABS[1]!.kinds;
    expect(new Set([...powerKinds, ...waterKinds])).toEqual(new Set(UTILITY_TWELVE));
  });

  it('allBuildTabs is the canonical BUILD_TABS with the utility tabs merged', () => {
    const tabs = allBuildTabs();
    const ids = tabs.map((t) => t.id);
    // The Phase 2 tabs sit between the classic utilities tab and navalAir.
    expect(ids).toContain('power');
    expect(ids).toContain('waterNet');
    expect(ids.indexOf('power')).toBe(ids.indexOf('utilities') + 1);
    expect(ids.indexOf('waterNet')).toBe(ids.indexOf('utilities') + 2);
    // No kind appears in two tabs.
    const seen = new Set<string>();
    for (const tab of tabs) {
      for (const k of tab.kinds) {
        expect(seen.has(k), `${k}: duplicated across tabs`).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe('diagnosis readers', () => {
  it('reads the sim powerDiag/waterDiag fields', () => {
    const b = fakeBuilding({ powerDiag: 'shortage', waterDiag: 'ok' } as never);
    expect(buildingPowerDiag(b)).toBe('shortage');
    expect(buildingWaterDiag(b)).toBe('ok');
  });

  it('falls back to powered/watered when the fields are absent', () => {
    const b = fakeBuilding();
    delete (b as unknown as Record<string, unknown>).powerDiag;
    delete (b as unknown as Record<string, unknown>).waterDiag;
    expect(buildingPowerDiag(b)).toBe('ok');
    expect(buildingWaterDiag({ ...b, watered: false })).toBe('disconnected');
    expect(buildingWaterDiag({ ...b, watered: false })).toBe('disconnected');
  });

  it('treats unknown diag values as absent (never a blank diagnosis)', () => {
    const b = fakeBuilding({ powerDiag: 'mystery' } as never);
    expect(buildingPowerDiag(b)).toBe('ok'); // powered=true fallback
  });
});

describe('producer sets and stranded plants', () => {
  it('derives producers from the sim defs (supply > 0)', () => {
    for (const kind of ['coalPlant', 'gasPlant', 'windFarm', 'hydroDam', 'geothermalPlant', 'fusionPlant', 'powerPlant', 'solarFarm', 'nuclearPlant']) {
      expect(POWER_PRODUCER_KINDS.has(kind), `${kind}: not a power producer`).toBe(true);
    }
    for (const kind of ['waterWell', 'waterTreatment', 'waterPump', 'desalination']) {
      expect(WATER_PRODUCER_KINDS.has(kind), `${kind}: not a water producer`).toBe(true);
    }
    // Storage/conductors are not producers.
    for (const kind of ['reservoir', 'waterTower', 'powerSubstation', 'pumpingStation', 'batteryStation', 'house']) {
      expect(POWER_PRODUCER_KINDS.has(kind), `${kind}: wrongly a power producer`).toBe(false);
      expect(WATER_PRODUCER_KINDS.has(kind), `${kind}: wrongly a water producer`).toBe(false);
    }
  });

  it('flags a disconnected producer as stranded (mirrors the sim rule)', () => {
    const stranded = fakeBuilding({ kind: 'coalPlant', powerDiag: 'disconnected' } as never);
    expect(isStrandedPlant(stranded)).toBe(true);
    const served = fakeBuilding({ kind: 'coalPlant', powerDiag: 'ok' } as never);
    expect(isStrandedPlant(served)).toBe(false);
    const shortage = fakeBuilding({ kind: 'coalPlant', powerDiag: 'shortage' } as never);
    expect(isStrandedPlant(shortage)).toBe(false);
    const waterStranded = fakeBuilding({ kind: 'waterWell', waterDiag: 'disconnected' } as never);
    expect(isStrandedPlant(waterStranded)).toBe(true);
  });

  it('never flags non-producers or unknown kinds', () => {
    expect(isStrandedPlant(fakeBuilding({ kind: 'house', powerDiag: 'disconnected' } as never))).toBe(false);
    expect(isStrandedPlant(fakeBuilding({ kind: 'nope', powerDiag: 'disconnected' } as never))).toBe(false);
  });
});

describe('fouled sources', () => {
  it('reads the optional fouledSource flag, false when absent', () => {
    expect(buildingFouledSource(fakeBuilding())).toBe(false);
    expect(
      buildingFouledSource(fakeBuilding({ fouledSource: true } as never)),
    ).toBe(true);
  });
});

describe('network cell sets', () => {
  it('reads the sim city.powerLines / city.pipes', () => {
    const session = createSession({ seed: 7 });
    const city = session.world.city as unknown as {
      powerLines?: unknown;
      pipes?: unknown;
    };
    city.powerLines = [9, 4, 4, 25];
    city.pipes = [100, 101];
    expect(cityPowerLines(session.world)).toEqual([9, 4, 4, 25]);
    expect(cityPipes(session.world)).toEqual([100, 101]);
  });

  it('returns empty arrays when the fields are missing or garbage', () => {
    const session = createSession({ seed: 7 });
    const city = session.world.city as unknown as Record<string, unknown>;
    delete city.powerLines;
    delete city.pipes;
    expect(cityPowerLines(session.world)).toEqual([]);
    expect(cityPipes(session.world)).toEqual([]);
    city.powerLines = 'nope';
    city.pipes = [1, 'x', -3, 2.5, 8];
    expect(cityPowerLines(session.world)).toEqual([]);
    expect(cityPipes(session.world)).toEqual([1, 8]);
  });
});

describe('palette availability and cost', () => {
  it('mirrors the standard building availability exactly (same def path)', () => {
    const session = createSession({ seed: 7 });
    for (const kind of UTILITY_TWELVE) {
      const util = utilityBuildingAvailability(session.world, 1, kind);
      const std = buildingAvailability(session.world, 1, kind as BuildingKind);
      expect(util, `${kind}: diverged from standard availability`).toEqual(std);
    }
  });

  it('greys the industry-age coal plant in a fresh session with an honest reason', () => {
    const session = createSession({ seed: 7 });
    const avail = utilityBuildingAvailability(session.world, 1, 'coalPlant');
    expect(avail.ok).toBe(false);
    expect(avail.reason).not.toBe('');
  });

  it('still greys unknown kinds with an honest reason', () => {
    const session = createSession({ seed: 7 });
    const avail = utilityBuildingAvailability(session.world, 1, 'nope' as never);
    expect(avail.ok).toBe(false);
    expect(avail.reason).not.toBe('');
  });

  it('formats a real cost from the def, never inventing one', () => {
    const def = BUILDING_DEFS['coalPlant' as BuildingKind];
    const cost = formatUtilityBuildCost('coalPlant');
    expect(cost).not.toBe('—');
    expect(cost).toContain(String(def.costFunds));
    expect(formatUtilityBuildCost('nope' as never)).toBe('—');
  });

  it('produces a non-empty tooltip naming cost and status', () => {
    const session = createSession({ seed: 7 });
    const tip = utilityBuildTooltip(session.world, 1, 'windFarm');
    expect(tip.length).toBeGreaterThan(0);
    expect(tip).toContain(String(BUILDING_DEFS['windFarm' as BuildingKind].costFunds));
    expect(tip).toContain('Requires');
  });
});

describe('buildingUtilityLine', () => {
  it('reports power and water diagnosis in one line', () => {
    const line = buildingUtilityLine(
      fakeBuilding({ powerDiag: 'shortage', waterDiag: 'ok' } as never),
    );
    expect(line).toContain('Power');
    expect(line).toContain('Water');
    expect(line).toContain('Shortage');
  });
});

describe('utilityOverlayData', () => {
  const GRID_W = 64;
  const cellToWorld = (cell: number): { x: number; z: number } => ({
    x: (cell % GRID_W) * 8,
    z: Math.floor(cell / GRID_W) * 8,
  });
  const footprintOf = (b: BuildingRecord): number[] => [b.cz * GRID_W + b.cx];
  const markerAt = (
    data: ReturnType<typeof utilityOverlayData>,
    cx: number,
    cz: number,
  ): string[] =>
    data.markers
      .filter((m) => m.x === cx * 8 && m.z === cz * 8)
      .map((m) => m.kind);

  it('derives markers from diag fields: disconnected > shortage > stranded', () => {
    const session = createSession({ seed: 11 });
    const world = session.world;
    world.city.buildings.length = 0;
    const disc = fakeBuilding({ id: 1, cx: 1, cz: 1, powerDiag: 'disconnected' } as never);
    const short = fakeBuilding({ id: 2, cx: 2, cz: 2, powerDiag: 'shortage', waterDiag: 'ok' } as never);
    const stranded = fakeBuilding({
      id: 3, cx: 3, cz: 3, kind: 'gasPlant',
      powerDiag: 'disconnected', waterDiag: 'ok',
    } as never);
    world.city.buildings.push(disc, short, stranded);
    const data = utilityOverlayData(world, cellToWorld, footprintOf);
    const kinds = data.markers.map((m) => m.kind);
    expect(kinds).toContain('disconnected');
    expect(kinds).toContain('shortage');
    expect(kinds).toContain('stranded');
    // The disconnected non-producer gets exactly one marker (no stranded
    // double-flag).
    expect(markerAt(data, 1, 1)).toEqual(['disconnected']);
    // The stranded plant gets both its diag marker and the stranded flag.
    expect(markerAt(data, 3, 3).sort()).toEqual(['disconnected', 'stranded']);
    expect(markerAt(data, 2, 2)).toEqual(['shortage']);
  });

  it('marks fouled sources from the optional flag', () => {
    const session = createSession({ seed: 11 });
    const world = session.world;
    world.city.buildings.length = 0;
    const fouled = fakeBuilding({ id: 5, cx: 5, cz: 5, fouledSource: true } as never);
    world.city.buildings.push(fouled);
    const data = utilityOverlayData(world, cellToWorld, footprintOf);
    expect(data.markers.some((m) => m.kind === 'fouled')).toBe(true);
    expect(data.fouledCells.length).toBeGreaterThan(0);
  });

  it('tints only zoned cells where everything is ok', () => {
    const session = createSession({ seed: 11 });
    const world = session.world;
    world.city.buildings.length = 0;
    world.city.zones.length = 0;
    const served = fakeBuilding({ id: 6, cx: 6, cz: 6, powerDiag: 'ok', waterDiag: 'ok' } as never);
    const unzoned = fakeBuilding({ id: 7, cx: 7, cz: 7, powerDiag: 'ok', waterDiag: 'ok' } as never);
    world.city.buildings.push(served, unzoned);
    // No zones: no served tint anywhere (zone-level hookup unit).
    expect(utilityOverlayData(world, cellToWorld, footprintOf).servedPowerCells).toEqual([]);
    // Zone the served building's cell: the tint appears for it only.
    world.city.zones.push({ cell: 6 * GRID_W + 6, zone: 'residential' as never });
    const data = utilityOverlayData(world, cellToWorld, footprintOf);
    expect(data.servedPowerCells).toEqual([6 * GRID_W + 6]);
    expect(data.servedWaterCells).toEqual([6 * GRID_W + 6]);
  });

  it('carries the raw line/pipe cells through', () => {
    const session = createSession({ seed: 11 });
    const world = session.world;
    (world.city as unknown as { powerLines: number[] }).powerLines = [10, 20];
    (world.city as unknown as { pipes: number[] }).pipes = [30];
    const data = utilityOverlayData(world, cellToWorld, footprintOf);
    expect(data.powerLineCells).toEqual([10, 20]);
    expect(data.pipeCells).toEqual([30]);
  });
});
