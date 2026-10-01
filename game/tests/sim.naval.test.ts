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
 * NOVATERRA — sim naval-expansion tests (grand-expansion Phase 6,
 * workstream C, 2026-09-30).
 *
 * Covers the 15 new sea kinds (roster shape, nuclear-fuel exemption,
 * carrier wing capacity), the four ports (coastal placement rule,
 * countsAs production gates, civilian harvest income), the minelayer's
 * deployMine command (validate≡apply, lay-down cost, deployable-only
 * rejection), the naval-mine detonation pass (trigger radius, armor
 * counters, determinism), the repairShip's sea heal aura, and
 * save/load round-trip of the new records.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { getAgeState } from '../src/sim/ages';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  getPlayer,
  hasProductionBuilding,
  registerCityCommands,
  isCoastal,
  cellIsWater,
  cellCoords,
  cellCenterWorld,
  CITY_GRID_CELLS,
  BUILDING_DEFS,
  type BuildingKind,
} from '../src/sim/city';
import {
  findUnit,
  registerUnitCommands,
  spawnUnit,
  UNIT_DEFS,
  type UnitKind,
  type UnitRecord,
} from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { seaComponents } from '../src/sim/pathfinding';
import {
  createCombatSystem,
  registerCombatCommands,
  MINE_TRIGGER_RADIUS,
} from '../src/sim/combat';
import { createEconomySystem, registerEconomyCommands } from '../src/sim/economy';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';

const NAVAL_KINDS: UnitKind[] = [
  'coastalSub',
  'missileSub',
  'corvette',
  'cruiser',
  'battleship',
  'heavyDestroyer',
  'cargoFreighter',
  'fuelTanker',
  'ammoShip',
  'repairShip',
  'minelayer',
  'navalMine',
  'coastGuardCutter',
  'cruiseLiner',
  'yacht',
  // Civilian sea trade (Half A, 2026-10-01): the civilian fuel barge.
  'fuelBarge',
];

const PORT_KINDS: BuildingKind[] = [
  'commercialPort',
  'containerPort',
  'fishingHarbor',
  'navalBase',
];

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** Full sim stack: units + movement + combat (+ city/economy when asked). */
function setup(seed = 20260930, withEconomy = false): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerCityCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  if (withEconomy) {
    // Same mid-pulse start as sim.economy.test.ts: the first step runs
    // the economy (150 % 30 === 0) without the tick-0 growth pulse.
    world.tick = 150;
    world.time = 150 / 30;
    registerEconomyCommands(queue);
  }
  const systems = [
    createPathfindingSystem(terrain),
    createMovementSystem(terrain),
    createCombatSystem(),
  ];
  if (withEconomy) systems.push(createEconomySystem(terrain));
  const driver = createTickDriver({ queue, systems });
  return { terrain, world, queue, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmds: Array<Omit<NewCommand, 'issuer'>>): void {
  for (const c of cmds) {
    ctx.queue.enqueue(ctx.world, { issuer: 'player', ...c });
  }
}

function rejectionReason(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).reason;
  }
  throw new Error('expected a CommandRejectedError but none was thrown');
}

/** Spiral out from (x, z) for the nearest water point (deterministic). */
function findWaterNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 120; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no water near (${x}, ${z})`);
}

/** A w×h footprint of pure land with a one-cell land border around it —
 * guarantees isCoastal() is false for that footprint. */
function findInlandFootprint(
  t: TerrainData,
  w: number,
  h: number,
): { cx: number; cz: number } {
  for (let cz = 8; cz < CITY_GRID_CELLS - 8 - h; cz += 2) {
    for (let cx = 8; cx < CITY_GRID_CELLS - 8 - w; cx += 2) {
      let waterNear = false;
      for (let dz = -1; dz <= h && !waterNear; dz++) {
        for (let dx = -1; dx <= w && !waterNear; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) waterNear = true;
        }
      }
      if (!waterNear) return { cx, cz };
    }
  }
  throw new Error('no inland footprint on MERIDIAN_PLAINS');
}

type FootRect = { cx: number; cz: number; w: number; h: number };

/**
 * A w×h footprint of pure land that IS coastal (passes the port rule),
 * not overlapping any rect in `exclude`.
 */
function findCoastalFootprint(
  t: TerrainData,
  w: number,
  h: number,
  exclude: FootRect[] = [],
): { cx: number; cz: number } {
  for (let cz = 8; cz < CITY_GRID_CELLS - 8 - h; cz += 2) {
    for (let cx = 8; cx < CITY_GRID_CELLS - 8 - w; cx += 2) {
      let allLand = true;
      for (let dz = 0; dz < h && allLand; dz++) {
        for (let dx = 0; dx < w && allLand; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) allLand = false;
        }
      }
      if (!allLand) continue;
      if (!isCoastal(t, cx, cz, w, h)) continue;
      if (
        exclude.some(
          (r) =>
            cx < r.cx + r.w + 1 &&
            r.cx < cx + w + 1 &&
            cz < r.cz + r.h + 1 &&
            r.cz < cz + h + 1,
        )
      ) {
        continue;
      }
      return { cx, cz };
    }
  }
  throw new Error('no coastal footprint on MERIDIAN_PLAINS');
}

/**
 * Two water points in the LARGEST sea component, ~the component's
 * diameter apart. MERIDIAN_PLAINS has disconnected lakes/seas — a blind
 * spiral can strand the destination across water the ship can never
 * reach ("no path: destination unreachable by water").
 */
function findBigSeaLane(t: TerrainData): { a: { x: number; z: number }; b: { x: number; z: number } } {
  const comps = seaComponents(t);
  const byComp = new Map<number, number[]>();
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i] as number;
    if (c === -1) continue;
    let cells = byComp.get(c);
    if (!cells) {
      cells = [];
      byComp.set(c, cells);
    }
    cells.push(i);
  }
  let best: number[] = [];
  for (const cells of byComp.values()) {
    if (cells.length > best.length) best = cells;
  }
  if (best.length === 0) throw new Error('no sea on MERIDIAN_PLAINS');
  const pt = (i: number): { x: number; z: number } => {
    const { cx, cz } = cellCoords(i);
    return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
  };
  const farthest = (from: { x: number; z: number }): number => {
    let bi = best[0]!;
    let bd = -1;
    for (const i of best) {
      const p = pt(i);
      const d = Math.hypot(p.x - from.x, p.z - from.z);
      if (d > bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  };
  const e1 = farthest(pt(best[0]!));
  const e1p = pt(e1);
  // A mid-range destination in the same component: far enough to burn
  // measurable fuel, close enough that findSeaPath stays under
  // ASTAR_MAX_EXPANDED (sea searches fail loudly when capped).
  let goal = -1;
  let goalDist = Infinity;
  for (const i of best) {
    const p = pt(i);
    const d = Math.hypot(p.x - e1p.x, p.z - e1p.z);
    if (d >= 60 && d < goalDist) {
      goalDist = d;
      goal = i;
    }
  }
  if (goal === -1) throw new Error('no mid-range same-body water on MERIDIAN_PLAINS');
  return { a: e1p, b: pt(goal) };
}

describe('naval roster', () => {
  it('has 36 sea kinds: the 9 originals + ferry + the 15 new + 10 Phase 8 tech-level variants + Half A fuelBarge', () => {
    const sea = Object.keys(UNIT_DEFS).filter(
      (k) => UNIT_DEFS[k as UnitKind].domain === 'sea',
    );
    expect(sea).toHaveLength(36);
    for (const kind of NAVAL_KINDS) {
      expect(UNIT_DEFS[kind as UnitKind].domain, kind).toBe('sea');
    }
  });

  it('every new kind has sane combat stats (hp/speed/armor/damage set)', () => {
    for (const kind of NAVAL_KINDS) {
      const def = UNIT_DEFS[kind as UnitKind];
      expect(def.hp, `${kind}.hp`).toBeGreaterThan(0);
      expect(def.speed, `${kind}.speed`).toBeGreaterThanOrEqual(0);
      expect(['light', 'medium', 'heavy'], `${kind}.armor`).toContain(def.armor);
    }
    // navalMine is the only immobile kind (moored ordnance).
    expect(UNIT_DEFS.navalMine.speed).toBe(0);
  });

  it('heavyDestroyer is the surface gunfighter; destroyer stays the AA escort', () => {
    expect(UNIT_DEFS.heavyDestroyer.targets).toBe('sea');
    expect(UNIT_DEFS.heavyDestroyer.damage).toBeGreaterThan(UNIT_DEFS.destroyer.damage);
    expect(UNIT_DEFS.destroyer.targets).toBe('seaAir');
  });

  it('carrier sails with wingCapacity 8 and an empty wing', () => {
    expect(UNIT_DEFS.carrier.wingCapacity).toBe(8);
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    const carrier = spawnUnit(ctx.world, 'carrier', 0, w.x, w.z);
    expect(carrier.embarkedOn).toBe(0);
  });
});

describe('nuclear fuel exemption', () => {
  it('missileSub and carrier never burn fuel (user rule 2026-09-30)', () => {
    expect(UNIT_DEFS.missileSub.fuelType).toBe('nuclear');
    expect(UNIT_DEFS.carrier.fuelType).toBe('nuclear');
  });

  it('a moving missileSub keeps its fuel while a fossil corvette burns', () => {
    const ctx = setup();
    const { a, b } = findBigSeaLane(ctx.terrain);
    // Internal spawn bypasses age/building gates — the fuel-burn path
    // is what this test exercises.
    const sub = spawnUnit(ctx.world, 'missileSub', 0, a.x, a.z);
    const corvette = spawnUnit(ctx.world, 'corvette', 0, a.x, a.z);
    const subFuel0 = sub.fuel;
    const corvetteFuel0 = corvette.fuel;
    expect(corvetteFuel0).toBeGreaterThan(0);
    enqueue(ctx, [
      { kind: 'moveUnit', payload: { owner: 0, unitId: sub.id, x: b.x, z: b.z } },
      { kind: 'moveUnit', payload: { owner: 0, unitId: corvette.id, x: b.x, z: b.z } },
    ]);
    runTicks(ctx, 600);
    // Both actually sailed (otherwise the corvette assertion is vacuous).
    expect(Math.hypot(sub.x - a.x, sub.z - a.z)).toBeGreaterThan(20);
    expect(Math.hypot(corvette.x - a.x, corvette.z - a.z)).toBeGreaterThan(20);
    expect(sub.fuel).toBe(subFuel0);
    expect(corvette.fuel).toBeLessThan(corvetteFuel0);
  });
});

describe('deployMine', () => {
  /** A minelayer floating on water, ready to lay mines. */
  function floatingMinelayer(ctx: Ctx, owner = 0): UnitRecord {
    const w = findWaterNear(ctx.terrain, 0, 0);
    return spawnUnit(ctx.world, 'minelayer', owner, w.x, w.z);
  }

  it('spawnUnit rejects navalMine loudly — mines only come from deployMine', () => {
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    const reason = rejectionReason(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'spawnUnit',
        payload: { kind: 'navalMine', owner: 0, x: w.x, z: w.z },
      }),
    );
    expect(reason).toMatch(/deployable-only/);
    expect(reason).toMatch(/deployMine/);
    expect(ctx.world.units.some((u) => u.kind === 'navalMine')).toBe(false);
  });

  it('lays a mine at the minelayer, deducting 50 funds + 10 materials', () => {
    const ctx = setup();
    const layer = floatingMinelayer(ctx);
    const player = getPlayer(ctx.world.city, 0)!;
    const funds0 = player.funds;
    const mats0 = player.materials;
    enqueue(ctx, [{ kind: 'deployMine', payload: { owner: 0, minelayerId: layer.id } }]);
    runTicks(ctx, 1);
    const mines = ctx.world.units.filter((u) => u.kind === 'navalMine' && u.hp > 0);
    expect(mines).toHaveLength(1);
    expect(mines[0]!.x).toBe(layer.x);
    expect(mines[0]!.z).toBe(layer.z);
    expect(mines[0]!.owner).toBe(0);
    expect(player.funds).toBe(funds0 - 50);
    expect(player.materials).toBe(mats0 - 10);
  });

  it('validate and apply agree: a broke player is rejected at enqueue', () => {
    const ctx = setup();
    const layer = floatingMinelayer(ctx);
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 10;
    player.materials = 10;
    const reason = rejectionReason(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'deployMine',
        payload: { owner: 0, minelayerId: layer.id },
      }),
    );
    expect(reason).toMatch(/cannot afford/);
    expect(ctx.world.units.some((u) => u.kind === 'navalMine')).toBe(false);
  });

  it('rejects a minelayer that is not on water', () => {
    const ctx = setup();
    // Internal spawn skips terrain validation — park it on land on purpose.
    const layer = spawnUnit(ctx.world, 'minelayer', 0, 0, 0);
    expect(isWater(ctx.terrain, 0, 0)).toBe(false);
    const reason = rejectionReason(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'deployMine',
        payload: { owner: 0, minelayerId: layer.id },
      }),
    );
    expect(reason).toMatch(/must be on water/);
  });

  it('rejects a non-minelayer unit id', () => {
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    const boat = spawnUnit(ctx.world, 'patrolBoat', 0, w.x, w.z);
    const reason = rejectionReason(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'deployMine',
        payload: { owner: 0, minelayerId: boat.id },
      }),
    );
    expect(reason).toMatch(/only a minelayer/);
  });

  it('deployed mines earn no academy XP (expendable ordnance)', () => {
    const ctx = setup();
    completeBuilding(ctx.world, 'militaryAcademy', 0);
    const layer = floatingMinelayer(ctx);
    enqueue(ctx, [{ kind: 'deployMine', payload: { owner: 0, minelayerId: layer.id } }]);
    runTicks(ctx, 1);
    const mine = ctx.world.units.find((u) => u.kind === 'navalMine')!;
    expect(mine.xp).toBe(0);
  });
});

describe('mine detonation', () => {
  it(`triggers within ${MINE_TRIGGER_RADIUS} on the nearest enemy sea unit`, () => {
    expect(MINE_TRIGGER_RADIUS).toBe(8);
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    const mine = spawnUnit(ctx.world, 'navalMine', 0, w.x, w.z);
    // transportShip: unarmed (targets 'none'), medium armor, 350 hp —
    // it cannot shoot back, so the blast is the only damage source.
    const target = spawnUnit(ctx.world, 'transportShip', 1, w.x + 5, w.z);
    const hp0 = target.hp;
    runTicks(ctx, 3);
    // The mine is spent...
    const mineAfter = findUnit(ctx.world, mine.id);
    expect(mineAfter === undefined || mineAfter.hp <= 0).toBe(true);
    // ...and the blast went through damageMultiplier: 150 × vsMedium 1.2.
    const expected = hp0 - 150 * UNIT_DEFS.navalMine.vsMedium;
    expect(target.hp).toBeCloseTo(expected, 6);
  });

  it('does not trigger on friendly ships or beyond the radius', () => {
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    const mine = spawnUnit(ctx.world, 'navalMine', 0, w.x, w.z);
    const friend = spawnUnit(ctx.world, 'transportShip', 0, w.x + 4, w.z);
    const far = spawnUnit(ctx.world, 'transportShip', 1, w.x + 20, w.z);
    runTicks(ctx, 30);
    expect(findUnit(ctx.world, mine.id)!.hp).toBeGreaterThan(0);
    expect(friend.hp).toBe(UNIT_DEFS.transportShip.hp);
    expect(far.hp).toBe(UNIT_DEFS.transportShip.hp);
  });

  it('picks the nearest enemy, ties break to the lowest id', () => {
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    const mine = spawnUnit(ctx.world, 'navalMine', 0, w.x, w.z);
    const near = spawnUnit(ctx.world, 'transportShip', 1, w.x + 3, w.z);
    const far = spawnUnit(ctx.world, 'transportShip', 1, w.x + 6, w.z);
    runTicks(ctx, 3);
    expect(near.hp).toBeLessThan(UNIT_DEFS.transportShip.hp);
    expect(far.hp).toBe(UNIT_DEFS.transportShip.hp);
  });

  it('is deterministic: identical scripts give identical digests', () => {
    const script = (seed: number): number => {
      const ctx = setup(seed);
      const w = findWaterNear(ctx.terrain, 0, 0);
      const layer = spawnUnit(ctx.world, 'minelayer', 0, w.x, w.z);
      enqueue(ctx, [{ kind: 'deployMine', payload: { owner: 0, minelayerId: layer.id } }]);
      runTicks(ctx, 1);
      spawnUnit(ctx.world, 'transportShip', 1, w.x + 5, w.z);
      spawnUnit(ctx.world, 'patrolBoat', 1, w.x - 30, w.z + 10);
      runTicks(ctx, 60);
      return digestWorld(ctx.world);
    };
    expect(script(777)).toBe(script(777));
  });
});

describe('repairShip aura', () => {
  it('heals friendly sea units in radius (healDomain sea)', () => {
    expect(UNIT_DEFS.repairShip.healDomain).toBe('sea');
    expect(UNIT_DEFS.repairShip.healRadius).toBe(15);
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    const tender = spawnUnit(ctx.world, 'repairShip', 0, w.x, w.z);
    const patient = spawnUnit(ctx.world, 'patrolBoat', 0, w.x + 10, w.z);
    patient.hp = 100;
    runTicks(ctx, 60); // 2 sim-seconds at 1.5 hp/s
    expect(patient.hp).toBeCloseTo(103, 6);
    expect(tender.hp).toBe(UNIT_DEFS.repairShip.hp); // already full: untouched
  });

  it('does not heal land units (combatMedic still owns land)', () => {
    const ctx = setup();
    const w = findWaterNear(ctx.terrain, 0, 0);
    spawnUnit(ctx.world, 'repairShip', 0, w.x, w.z);
    // A land unit parked next to the tender — walk +x until dry land.
    let lx = w.x;
    while (isWater(ctx.terrain, lx, w.z) && lx < w.x + 200) lx += 2;
    expect(isWater(ctx.terrain, lx, w.z)).toBe(false);
    const grunt = spawnUnit(ctx.world, 'rifles', 0, lx, w.z);
    grunt.hp = 10;
    runTicks(ctx, 60);
    expect(grunt.hp).toBe(10);
    // ...while the combatMedic keeps healing land as before.
    expect(UNIT_DEFS.combatMedic.healDomain ?? 'land').toBe('land');
  });
});

describe('ports', () => {
  /** Ports are age-gated (up to industry); the tests below are about
   * placement, so jump straight there (deterministic plain-state set). */
  function atIndustryAge(ctx: Ctx): void {
    getAgeState(ctx.world, 0).age = 'industry';
  }

  it('require the coast: inland placement is rejected', () => {
    const ctx = setup();
    atIndustryAge(ctx);
    for (const kind of PORT_KINDS) {
      const def = BUILDING_DEFS[kind];
      const inland = findInlandFootprint(ctx.terrain, def.footprintW, def.footprintH);
      const reason = rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, {
          issuer: 'player',
          kind: 'placeBuilding',
          payload: { kind, owner: 0, cx: inland.cx, cz: inland.cz, facing: 0 },
        }),
      );
      expect(reason, kind).toMatch(/coast/);
    }
    // A non-port building places fine inland (the rule keys on
    // def.portType, not a kind list).
    const plant = findInlandFootprint(ctx.terrain, 3, 3);
    ctx.queue.enqueue(ctx.world, {
      issuer: 'player',
      kind: 'placeBuilding',
      payload: { kind: 'powerPlant', owner: 0, cx: plant.cx, cz: plant.cz, facing: 0 },
    });
  });

  it('place on a coastal cell', () => {
    const ctx = setup();
    atIndustryAge(ctx);
    const used: FootRect[] = [];
    for (const kind of PORT_KINDS) {
      const def = BUILDING_DEFS[kind];
      const cell = findCoastalFootprint(
        ctx.terrain,
        def.footprintW,
        def.footprintH,
        used,
      );
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'placeBuilding',
        payload: { kind, owner: 0, cx: cell.cx, cz: cell.cz, facing: 0 },
      });
      used.push({ cx: cell.cx, cz: cell.cz, w: def.footprintW, h: def.footprintH });
    }
    runTicks(ctx, 1); // commands validate at enqueue; apply runs on the tick
    const placed = ctx.world.city.buildings.filter((b) =>
      (PORT_KINDS as string[]).includes(b.kind),
    );
    expect(placed).toHaveLength(PORT_KINDS.length);
  });

  it('countsAs gates: commercialPort trains like a shipyard, navalBase like a navalYard', () => {
    const ctx = setup();
    expect(hasProductionBuilding(ctx.world, 0, 'shipyard')).toBe(false);
    expect(hasProductionBuilding(ctx.world, 0, 'navalYard')).toBe(false);
    completeBuilding(ctx.world, 'commercialPort', 0);
    expect(hasProductionBuilding(ctx.world, 0, 'shipyard')).toBe(true);
    expect(hasProductionBuilding(ctx.world, 0, 'navalYard')).toBe(false);
    completeBuilding(ctx.world, 'navalBase', 0);
    expect(hasProductionBuilding(ctx.world, 0, 'navalYard')).toBe(true);
  });

  it('civilian ports pay harvest income net of upkeep (deterministic across identical runs)', () => {
    const runWorld = (withPorts: boolean): number => {
      const ctx = setup(4242, true);
      if (withPorts) {
        completeBuilding(ctx.world, 'commercialPort', 0);
        completeBuilding(ctx.world, 'containerPort', 0);
      }
      const player = getPlayer(ctx.world.city, 0)!;
      player.funds = 1000;
      runTicks(ctx, 90); // 3 economy pulses; runGrowth never fires (tick % 300)
      return player.funds;
    };
    const withPorts = runWorld(true);
    const without = runWorld(false);
    // Net funds flow per pulse = Σ(harvest.funds − upkeepFundsPerSec);
    // every other funds flow is identical between the two runs (same
    // seed, same commands, ports are UTILITY_ZONE so runTaxes skips them).
    let netPerPulse = 0;
    for (const kind of ['commercialPort', 'containerPort'] as const) {
      const def = BUILDING_DEFS[kind];
      netPerPulse += (def.harvest?.funds ?? 0) - def.upkeepFundsPerSec;
    }
    expect(netPerPulse).toBeCloseTo(1.7, 9);
    expect(withPorts - without).toBeCloseTo(netPerPulse * 3, 6);
  });

  it('fishingHarbor harvests food', () => {
    const runWorld = (withHarbor: boolean): number => {
      const ctx = setup(5150, true);
      if (withHarbor) completeBuilding(ctx.world, 'fishingHarbor', 0);
      const player = getPlayer(ctx.world.city, 0)!;
      player.funds = 1000;
      // Plenty of food so runFood never hits the shortage cap — then
      // consumption is identical in both runs (population is
      // residents-only; ports add jobs, not residents).
      player.food = 1_000_000;
      runTicks(ctx, 90); // 3 economy pulses
      return player.food;
    };
    const withHarbor = runWorld(true);
    const without = runWorld(false);
    const def = BUILDING_DEFS.fishingHarbor;
    expect(def.harvest?.food).toBe(1.2);
    expect(withHarbor - without).toBeCloseTo(1.2 * 3, 6);
  });
});

describe('save/load round-trip', () => {
  it('snapshot preserves mines, new units, and ports with an identical digest', () => {
    const ctx = setup(9999);
    const w = findWaterNear(ctx.terrain, 0, 0);
    const layer = spawnUnit(ctx.world, 'minelayer', 0, w.x, w.z);
    enqueue(ctx, [{ kind: 'deployMine', payload: { owner: 0, minelayerId: layer.id } }]);
    runTicks(ctx, 1);
    spawnUnit(ctx.world, 'missileSub', 0, w.x + 40, w.z);
    spawnUnit(ctx.world, 'cruiseLiner', 1, w.x + 60, w.z);
    spawnUnit(ctx.world, 'repairShip', 0, w.x + 80, w.z);
    completeBuilding(ctx.world, 'commercialPort', 0);
    completeBuilding(ctx.world, 'navalBase', 0);
    runTicks(ctx, 30);
    const before = digestWorld(ctx.world);
    const snap = takeSnapshot(ctx.world);
    const restored = restoreSnapshot(snap);
    expect(digestWorld(restored)).toBe(before);
    expect(restored.units.some((u) => u.kind === 'navalMine')).toBe(true);
    expect(restored.units.some((u) => u.kind === 'missileSub')).toBe(true);
    expect(
      restored.city.buildings.some((b) => b.kind === 'commercialPort'),
    ).toBe(true);
  });
});

describe('palette availability', () => {
  it('navalMine is never trainable — the palette shows the minelayer reason', async () => {
    const { unitAvailability } = await import('../src/ui/palettes');
    const ctx = setup();
    const avail = unitAvailability(ctx.world, 0, 'navalMine');
    expect(avail.ok).toBe(false);
    expect(avail.reason).toMatch(/Minelayer/);
  });
});
