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
 * ui/logistics.ts contract tests + the order builders + digest/palette/
 * string wiring (grand-expansion Phase 3, 0.1 Alpha).
 *
 * Asserts the UI/render contract against the REAL sim defs (not a wish
 * list): the reload-point roster matches buildings with storage /
 * reloadPoint, the supply roster matches units with cargo holds, the
 * overlay data builder reads real building/unit fields, nearestDepot
 * mirrors the `resupply` validation rule (same owner, completed, stock
 * of something the unit needs), the order builders emit the exact flat
 * payloads the sim validates, and the selection digest carries the new
 * uf:/us:/bq: segments (AD11).
 *
 * Headless (no DOM/three.js): every module under test is pure.
 */
import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS, type BuildingKind, type BuildingRecord } from '../src/sim/city';
import { UNIT_DEFS, type UnitKind, type UnitRecord } from '../src/sim/units';
import { LOGISTICS_RADIUS } from '../src/sim/economy';
import type { World } from '../src/sim/world';
import {
  LOGISTICS_LOW_SUPPLY,
  RELOAD_POINT_KINDS,
  SUPPLY_UNIT_KINDS,
  ammoFracOf,
  availableAmmo,
  availableFuel,
  cargoLine,
  depotStockLine,
  fuelFracOf,
  isDepotBuilding,
  isLowSupply,
  isReloadPointKind,
  isSupplyUnit,
  isTrackedUnit,
  logisticsOverlayData,
  logisticsOverlayDigest,
  nearestDepot,
  resupplyBlockReason,
  serviceTogglesOf,
} from '../src/ui/logistics';
import { buildResupplyOrder, buildSupplyTogglesOrder } from '../src/ui/orders';
import { selectionDigest } from '../src/ui/paletteDigest';
import { BUILD_TABS, TRAIN_TABS } from '../src/ui/palettes';
import { STRINGS, loc } from '../src/ui/strings';
import type { Selection } from '../src/ui/selection';

// ---------------------------------------------------------------------------
// Roster: the contract lists match the sim defs
// ---------------------------------------------------------------------------

describe('logistics roster', () => {
  it('RELOAD_POINT_KINDS are exactly the sim buildings with reloadPoint', () => {
    const fromSim = (Object.keys(BUILDING_DEFS) as BuildingKind[]).filter(
      (k) => BUILDING_DEFS[k]?.reloadPoint === true,
    );
    expect([...RELOAD_POINT_KINDS].sort()).toEqual(fromSim.sort());
    // The sim's canonical list (sim/city.ts `reloadPoint` doc): the four
    // production bases, the two ammo producers, the three depots.
    for (const k of [
      'barracks',
      'warFactory',
      'airfield',
      'navalYard',
      'munitionsFactory',
      'missilePlant',
      'missileSilo',
      'ordnanceDepot',
      'fuelDepot',
    ] as BuildingKind[]) {
      expect(RELOAD_POINT_KINDS).toContain(k);
      expect(isReloadPointKind(k)).toBe(true);
    }
    expect(isReloadPointKind('house')).toBe(false);
  });

  it('SUPPLY_UNIT_KINDS are exactly the sim units with cargo holds', () => {
    const fromSim = (Object.keys(UNIT_DEFS) as UnitKind[]).filter((k) => {
      const d = UNIT_DEFS[k]!;
      return (d.cargoFuelCapacity ?? 0) > 0 || (d.cargoAmmoCapacity ?? 0) > 0;
    });
    expect([...SUPPLY_UNIT_KINDS].sort()).toEqual(fromSim.sort());
    // The two dedicated trucks plus the hauler's light carrier role.
    expect(SUPPLY_UNIT_KINDS).toContain('supplyTruck');
    expect(SUPPLY_UNIT_KINDS).toContain('fuelTruck');
    expect(SUPPLY_UNIT_KINDS).toContain('hauler');
    expect(isSupplyUnit(UNIT_DEFS['supplyTruck'])).toBe(true);
    expect(isSupplyUnit(UNIT_DEFS['fuelTruck'])).toBe(true);
    expect(isSupplyUnit(UNIT_DEFS['tank'])).toBe(false);
  });

  it('tracked units are the fossil-fuel or ammo-carrying kinds', () => {
    expect(isTrackedUnit(UNIT_DEFS['supplyTruck'])).toBe(true);
    expect(isTrackedUnit(UNIT_DEFS['tank'])).toBe(true);
    // An infantry kind with neither fuel nor ammo is untracked.
    expect(isTrackedUnit(UNIT_DEFS['engineer'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fake-world helpers
// ---------------------------------------------------------------------------

let nextId = 1000;

function fakeBuilding(
  kind: BuildingKind,
  opts: Partial<BuildingRecord> = {},
): BuildingRecord {
  return {
    id: nextId++,
    kind,
    owner: 1,
    cx: 0,
    cz: 0,
    progress: 1,
    hp: 100,
    operational: true,
    ammoStock: 0,
    fuelStock: 0,
    reservedAmmo: 0,
    reservedFuel: 0,
    ...opts,
  } as BuildingRecord;
}

function fakeUnit(kind: UnitKind, opts: Partial<UnitRecord> = {}): UnitRecord {
  const def = UNIT_DEFS[kind]!;
  return {
    id: nextId++,
    kind,
    owner: 1,
    x: 0,
    z: 0,
    hp: def.hp,
    fuel: def.fuelCapacity ?? 0,
    ammo: def.ammoCapacity ?? 0,
    cargoFuel: 0,
    cargoAmmo: 0,
    ...opts,
  } as UnitRecord;
}

function fakeWorld(
  buildings: BuildingRecord[] = [],
  units: UnitRecord[] = [],
): World {
  return { city: { buildings }, units } as unknown as World;
}

// ---------------------------------------------------------------------------
// Overlay data + digest
// ---------------------------------------------------------------------------

describe('logisticsOverlayData', () => {
  it('emits one disc per completed reload point, at the sim radius', () => {
    const world = fakeWorld(
      [
        fakeBuilding('ordnanceDepot', { cx: 2, cz: 3 }),
        fakeBuilding('fuelDepot', { cx: 5, cz: 5, progress: 0.5 }), // incomplete: skipped
        fakeBuilding('house', { cx: 8, cz: 8 }), // not a reload point: skipped
      ],
      [],
    );
    const data = logisticsOverlayData(world);
    expect(data.depots.length).toBe(1);
    expect(data.depots[0]!.radius).toBe(LOGISTICS_RADIUS);
  });

  it('marks living low-supply units, skips the healthy and the dead', () => {
    const low = fakeUnit('supplyTruck', { fuel: 1, hp: 100 }); // ~2% fuel
    const healthy = fakeUnit('supplyTruck', { hp: 100 });
    const dead = fakeUnit('supplyTruck', { fuel: 0, hp: 0 });
    const untracked = fakeUnit('engineer', { hp: 50 });
    const data = logisticsOverlayData(fakeWorld([], [low, healthy, dead, untracked]));
    expect(data.lowUnits.length).toBe(1);
    expect(data.lowUnits[0]).toEqual({ x: low.x, z: low.z });
  });

  it('digest is stable for identical data and moves on change', () => {
    const a = logisticsOverlayData(fakeWorld([fakeBuilding('ordnanceDepot')], []));
    const b = logisticsOverlayData(fakeWorld([fakeBuilding('ordnanceDepot')], []));
    expect(logisticsOverlayDigest(a)).toBe(logisticsOverlayDigest(b));
    const moved = logisticsOverlayData(
      fakeWorld([fakeBuilding('ordnanceDepot', { cx: 9, cz: 9 })], []),
    );
    expect(logisticsOverlayDigest(moved)).not.toBe(logisticsOverlayDigest(a));
    const marked = logisticsOverlayData(
      fakeWorld(
        [fakeBuilding('ordnanceDepot')],
        [fakeUnit('supplyTruck', { fuel: 1, hp: 100 })],
      ),
    );
    expect(logisticsOverlayDigest(marked)).not.toBe(logisticsOverlayDigest(a));
  });
});

// ---------------------------------------------------------------------------
// Depot selection + availability
// ---------------------------------------------------------------------------

describe('nearestDepot', () => {
  it('picks the nearest same-owner completed depot with stock the unit needs', () => {
    const thirsty = fakeUnit('fuelTruck', { fuel: 5, x: 8, z: 8 }); // needs fuel
    const nearEmpty = fakeBuilding('fuelDepot', { cx: 0, cz: 0, fuelStock: 0 });
    const farFull = fakeBuilding('fuelDepot', { cx: 10, cz: 10, fuelStock: 200 });
    const enemyFull = fakeBuilding('fuelDepot', {
      cx: 0,
      cz: 0,
      owner: 2,
      fuelStock: 200,
    });
    const world = fakeWorld([nearEmpty, farFull, enemyFull], [thirsty]);
    expect(nearestDepot(world, thirsty)).toBe(farFull);
  });

  it('returns null when the unit is full or no depot can help', () => {
    const full = fakeUnit('fuelTruck', { hp: 100 }); // full tanks
    const world = fakeWorld([fakeBuilding('fuelDepot', { fuelStock: 200 })], [full]);
    expect(nearestDepot(world, full)).toBeNull();
    const thirsty = fakeUnit('fuelTruck', { fuel: 5 });
    expect(nearestDepot(fakeWorld([], [thirsty]), thirsty)).toBeNull();
    // Incomplete depots don't count.
    const incomplete = fakeWorld(
      [fakeBuilding('fuelDepot', { progress: 0.2, fuelStock: 200 })],
      [thirsty],
    );
    expect(nearestDepot(incomplete, thirsty)).toBeNull();
  });

  it('resupplyBlockReason names the blocker, null when a depot serves', () => {
    const thirsty = fakeUnit('fuelTruck', { fuel: 5 });
    const depot = fakeBuilding('fuelDepot', { fuelStock: 200 });
    const world = fakeWorld([depot], [thirsty]);
    expect(resupplyBlockReason(world, thirsty, depot)).toBeNull();
    expect(resupplyBlockReason(world, thirsty, null)).toBe('no depot has available stock');
    expect(resupplyBlockReason(fakeWorld([], [thirsty]), thirsty, null)).toBe(
      'no depot built yet',
    );
    const full = fakeUnit('fuelTruck', { hp: 100 });
    expect(resupplyBlockReason(fakeWorld([], [full]), full, null)).toBe(
      'tanks and magazines full',
    );
    const civilian = fakeUnit('engineer', { hp: 50 });
    expect(resupplyBlockReason(fakeWorld([], [civilian]), civilian, null)).toBe(
      'not tracked by the supply system',
    );
  });
});

describe('availableAmmo / availableFuel', () => {
  it('subtracts reservations, crediting the unit\u2019s own live reservation', () => {
    const depot = fakeBuilding('ordnanceDepot', {
      ammoStock: 100,
      reservedAmmo: 60,
      fuelStock: 50,
      reservedFuel: 10,
    });
    const other = fakeUnit('supplyTruck', { id: 7 });
    expect(availableAmmo(depot, other)).toBe(40);
    expect(availableFuel(depot, other)).toBe(40);
    // The unit holding the reservation sees its own pool (re-issue parity
    // with the `resupply` command's availability check).
    const holder = fakeUnit('supplyTruck', {
      id: 8,
      resupplyDepotId: depot.id,
      resupplyReservedAmmo: 25,
      resupplyReservedFuel: 5,
    } as Partial<UnitRecord>);
    expect(availableAmmo(depot, holder)).toBe(65);
    expect(availableFuel(depot, holder)).toBe(45);
  });

  it('never goes negative', () => {
    const depot = fakeBuilding('ordnanceDepot', { ammoStock: 10, reservedAmmo: 99 });
    expect(availableAmmo(depot, fakeUnit('supplyTruck'))).toBe(0);
  });
});

describe('isDepotBuilding', () => {
  it('mirrors the resupply validation rule', () => {
    expect(isDepotBuilding(fakeBuilding('ordnanceDepot'))).toBe(true);
    expect(isDepotBuilding(fakeBuilding('fuelDepot'))).toBe(true);
    expect(isDepotBuilding(fakeBuilding('munitionsFactory'))).toBe(true);
    // Production bases are reload points too (stocks arrive via trucks).
    expect(isDepotBuilding(fakeBuilding('barracks'))).toBe(true);
    expect(isDepotBuilding(fakeBuilding('house'))).toBe(false);
    expect(isDepotBuilding(fakeBuilding('ordnanceDepot', { progress: 0.3 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Readers + formatting
// ---------------------------------------------------------------------------

describe('supply readers', () => {
  it('fuelFracOf / ammoFracOf read the sim fields defensively', () => {
    const def = UNIT_DEFS['supplyTruck']!;
    const u = fakeUnit('supplyTruck', { fuel: 30 }); // capacity 60
    expect(fuelFracOf(def, u)).toBeCloseTo(0.5, 9);
    expect(ammoFracOf(def, undefined as never)).toBe(1); // untracked def → full
    expect(ammoFracOf(undefined, u)).toBe(1);
  });

  it('isLowSupply fires below the threshold only', () => {
    const def = UNIT_DEFS['supplyTruck']!;
    expect(LOGISTICS_LOW_SUPPLY).toBe(0.3);
    expect(isLowSupply(def, fakeUnit('supplyTruck', { fuel: 60 * 0.29 }))).toBe(true);
    expect(isLowSupply(def, fakeUnit('supplyTruck', { fuel: 60 * 0.31 }))).toBe(false);
    expect(isLowSupply(undefined, fakeUnit('supplyTruck', { fuel: 0 }))).toBe(false);
  });

  it('serviceTogglesOf defaults all-on, cargoLine names the load', () => {
    const u = fakeUnit('supplyTruck');
    expect(serviceTogglesOf(u)).toEqual({ repair: true, rearm: true, refuel: true });
    expect(cargoLine(u)).toBe('Cargo: 0 fuel · 0 ammo');
    const loaded = fakeUnit('supplyTruck', { cargoFuel: 80, cargoAmmo: 12 });
    expect(cargoLine(loaded)).toBe('Cargo: 80 fuel · 12 ammo');
    // The fuel-only tanker names just its fuel hold.
    expect(cargoLine(fakeUnit('fuelTruck', { cargoFuel: 200 }))).toBe('Cargo: 200 fuel');
    expect(cargoLine(fakeUnit('tank'))).toBe('');
  });

  it('depotStockLine shows only the storages the def has', () => {
    const ord = fakeBuilding('ordnanceDepot', { ammoStock: 42 });
    expect(depotStockLine(ord)).toBe('Ammo 42/150');
    const fuel = fakeBuilding('fuelDepot', { fuelStock: 200 });
    expect(depotStockLine(fuel)).toBe('Fuel 200/250');
    expect(depotStockLine(fakeBuilding('barracks'))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Order builders (the exact payloads the sim validates)
// ---------------------------------------------------------------------------

describe('logistics order builders', () => {
  it('buildResupplyOrder emits the flat resupply payload', () => {
    expect(buildResupplyOrder(11, 22, 1)).toEqual({
      kind: 'resupply',
      payload: { unitId: 11, depotId: 22, owner: 1 },
    });
  });

  it('buildSupplyTogglesOrder emits the flat setSupplyToggles payload', () => {
    expect(
      buildSupplyTogglesOrder(11, 1, { repair: true, rearm: false, refuel: true }),
    ).toEqual({
      kind: 'setSupplyToggles',
      payload: { unitId: 11, owner: 1, repair: true, rearm: false, refuel: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Palette / strings / digest wiring
// ---------------------------------------------------------------------------

describe('logistics palette + strings wiring', () => {
  it('armor train tab carries the two supply trucks', () => {
    const armor = TRAIN_TABS.find((t) => t.id === 'armor')!;
    expect(armor.kinds).toContain('supplyTruck');
    expect(armor.kinds).toContain('fuelTruck');
  });

  it('logistics build tab carries the 7 buildings', () => {
    const tab = BUILD_TABS.find((t) => t.id === 'logistics')!;
    expect([...tab.kinds].sort()).toEqual(
      [
        'fuelDepot',
        'missilePlant',
        'missileSilo',
        'munitionsFactory',
        'oilRig',
        'oilWell',
        'ordnanceDepot',
      ].sort(),
    );
  });

  it('every logistics kind has a name and the logistics strings exist', () => {
    for (const k of [
      'oilWell',
      'oilRig',
      'munitionsFactory',
      'missilePlant',
      'missileSilo',
      'ordnanceDepot',
      'fuelDepot',
    ] as BuildingKind[]) {
      expect(loc(STRINGS.buildingNames[k]).length).toBeGreaterThan(0);
    }
    for (const k of ['supplyTruck', 'fuelTruck'] as UnitKind[]) {
      expect(loc(STRINGS.unitNames[k]).length).toBeGreaterThan(0);
    }
    const lg = STRINGS.logistics;
    for (const key of [
      'overlayToggle',
      'overlayLegend',
      'fuelLabel',
      'ammoLabel',
      'cargoLabel',
      'resupplyVerb',
      'lowSupplyWarning',
    ] as const) {
      expect(loc(lg[key]).length, `logistics.${key}`).toBeGreaterThan(0);
    }
    expect(loc(STRINGS.buildingTabs['logistics']!).length).toBeGreaterThan(0);
    expect(loc(STRINGS.upgradeGroups['logistics']!).length).toBeGreaterThan(0);
    expect(loc(STRINGS.upgrades.advancedLogistics.name).length).toBeGreaterThan(0);
  });
});

describe('selection digest logistics segments (AD11)', () => {
  const sel: Selection = { unitIds: [], buildingId: null };

  it('unit branch emits uf: and us: segments', () => {
    const u = fakeUnit('supplyTruck', { id: 4242, fuel: 30 });
    const world = fakeWorld([], [u]);
    const digest = selectionDigest(
      world,
      { ...sel, unitIds: [4242] },
      'armor',
      'logistics',
    );
    const segs = digest.split('|');
    expect(segs.some((s) => s.startsWith('uf:4242:'))).toBe(true);
    expect(segs.some((s) => s.startsWith('us:4242:'))).toBe(true);
  });

  it('uf: quantizes fuel to 5% steps (no per-tick rebuild churn)', () => {
    const mk = (fuel: number): string => {
      const u = fakeUnit('supplyTruck', { id: 1, fuel });
      return selectionDigest(fakeWorld([], [u]), { ...sel, unitIds: [1] }, 'armor', 'logistics');
    };
    // 30.0 vs 30.4 of 60 → same 5% bucket (50%); 33.0 → 55%, different.
    expect(mk(30)).toBe(mk(30.4));
    expect(mk(30)).not.toBe(mk(33));
  });

  it('building branch emits the bq: segment with integer stocks', () => {
    const b = fakeBuilding('ordnanceDepot', { id: 777, ammoStock: 42.7 });
    const world = fakeWorld([b], []);
    const digest = selectionDigest(world, { ...sel, buildingId: 777 }, 'armor', 'logistics');
    expect(digest).toContain('bq:42:0');
  });
});
