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
 * NOVATERRA — sim veterancy tests (grand-expansion Phase 1).
 *
 * Covers the veterancy system end to end:
 *  - XP thresholds and rank names (pure `veterancy.ts` logic),
 *  - kill XP value = training cost (funds + materials),
 *  - XP awarded on a real combat kill, in attacker id order,
 *  - overflow splits to nearby allies (floor shares, remainder to lowest
 *    ids, XP lost with no allies),
 *  - death erases all veterancy,
 *  - the Military Academy spawn bonus (armed only, academy required) and
 *    its barracks placement gate,
 *  - snapshot round-trip + legacy v6 decode (xp/vetLevel default 0),
 *  - digest coverage (xp changes the digest),
 *  - determinism: same seed + same commands ⇒ identical digest.
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
  ZoneType,
  BUILDING_DEFS,
  registerCityCommands,
  cellIsWater,
} from '../src/sim/city';
import {
  findUnit,
  spawnUnit,
  registerUnitCommands,
  UNIT_DEFS,
  type UnitKind,
  type UnitRecord,
} from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { getVisibleEnemies } from '../src/sim/ai';
import {
  VET_MAX_LEVEL,
  vetLevelForXp,
  vetRankName,
  xpForKillValue,
  awardKillXp,
  vetDamageMult,
  vetSightMult,
  vetCooldownTicks,
  vetMaxHpMult,
  vetAdjustedMaxHp,
  VET_OVERFLOW_RADIUS,
} from '../src/sim/veterancy';
import { setDoctrine } from '../src/sim/doctrine';
import { effectiveMaxHp } from '../src/sim/upgrades';
import { digestWorld, canonicalizeWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';

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

function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
    ],
  });
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

/** Direct spawn (no command): precise control of xp/vetLevel/hp. */
function directSpawn(
  world: World,
  kind: UnitKind,
  owner: number,
  x: number,
  z: number,
): UnitRecord {
  return spawnUnit(world, kind, owner, x, z);
}

/** Find a w×h all-land city-cell rectangle; deterministic scan. */
function findLandRect(t: TerrainData, w: number, h: number): { cx: number; cz: number } {
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

describe('veterancy thresholds and bonuses (pure)', () => {
  it('vetLevelForXp: 299→0, 300→1, 800→2, 1600→3', () => {
    expect(vetLevelForXp(0)).toBe(0);
    expect(vetLevelForXp(299)).toBe(0);
    expect(vetLevelForXp(300)).toBe(1);
    expect(vetLevelForXp(799)).toBe(1);
    expect(vetLevelForXp(800)).toBe(2);
    expect(vetLevelForXp(1599)).toBe(2);
    expect(vetLevelForXp(1600)).toBe(3);
    expect(vetLevelForXp(99999)).toBe(VET_MAX_LEVEL);
  });

  it('rank names: Recruit / Regular / Veteran / Elite', () => {
    expect(vetRankName(0)).toBe('Recruit');
    expect(vetRankName(1)).toBe('Regular');
    expect(vetRankName(2)).toBe('Veteran');
    expect(vetRankName(3)).toBe('Elite');
  });

  it('xpForKillValue = trainFunds + trainMaterials (rifles 60, tank 460)', () => {
    expect(xpForKillValue(UNIT_DEFS.rifles)).toBe(60);
    expect(xpForKillValue(UNIT_DEFS.tank)).toBe(460);
  });

  it('per-level multipliers match the locked numbers', () => {
    expect(vetDamageMult(0)).toBe(1);
    expect(vetDamageMult(1)).toBeCloseTo(1.1, 10);
    expect(vetDamageMult(3)).toBeCloseTo(1.3, 10);
    expect(vetSightMult(2)).toBeCloseTo(1.2, 10);
    expect(vetMaxHpMult(0)).toBe(1);
    expect(vetMaxHpMult(1)).toBe(1);
    expect(vetMaxHpMult(2)).toBeCloseTo(1.15, 10);
    expect(vetMaxHpMult(3)).toBeCloseTo(1.3, 10);
  });

  it('vetCooldownTicks: level 0 is the def value; min 1 tick', () => {
    const def = UNIT_DEFS.rifles; // 20 ticks
    expect(vetCooldownTicks(def, 0)).toBe(20);
    expect(vetCooldownTicks(def, 1)).toBe(18);
    expect(vetCooldownTicks(def, 2)).toBe(16);
    expect(vetCooldownTicks(def, 3)).toBe(14);
    // A 1-tick weapon can never go below 1.
    const fast = { ...def, cooldownTicks: 1 };
    expect(vetCooldownTicks(fast, 3)).toBe(1);
  });

  it('vetAdjustedMaxHp = effectiveMaxHp × vet mult; dead units get the base', () => {
    const ctx = setup();
    const u = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const base = effectiveMaxHp(ctx.world, 0, UNIT_DEFS.rifles);
    u.vetLevel = 2;
    expect(vetAdjustedMaxHp(ctx.world, u)).toBeCloseTo(base * 1.15, 10);
    u.vetLevel = 3;
    expect(vetAdjustedMaxHp(ctx.world, u)).toBeCloseTo(base * 1.3, 10);
    u.hp = 0;
    expect(vetAdjustedMaxHp(ctx.world, u)).toBe(base);
  });
});

describe('kill XP awarding', () => {
  it('a combat kill awards xpForKillValue to the killer', () => {
    const ctx = setup();
    // Killer at (0,0), 1-hp target at (10,0): one rifles shot kills.
    const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const target = directSpawn(ctx.world, 'rifles', 1, 10, 0);
    target.hp = 1;
    enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: killer.id, targetId: target.id, owner: 0 } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, target.id)).toBeUndefined();
    expect(killer.xp).toBe(60);
    expect(killer.vetLevel).toBe(0);
  });

  it('kills level the killer up through the thresholds', () => {
    const ctx = setup();
    const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    killer.xp = 299;
    awardKillXp(ctx.world, killer, UNIT_DEFS.engineer); // +50 → 349
    expect(killer.xp).toBe(349);
    expect(killer.vetLevel).toBe(1);
    awardKillXp(ctx.world, killer, UNIT_DEFS.rifles); // +60 → 409
    expect(killer.vetLevel).toBe(1);
    killer.xp = 1550;
    awardKillXp(ctx.world, killer, UNIT_DEFS.rifles); // +60 → 1610
    expect(killer.xp).toBe(1610);
    expect(killer.vetLevel).toBe(3);
  });

  it('two kills in the same tick credit in attacker id order', () => {
    const ctx = setup();
    // A1 (low id, Elite) and A2 (high id, 1550 xp) each kill a 1-hp
    // rifles (+60) in the same tick via opportunistic fire. A2 is within
    // A1's overflow range; R (Recruit) is within A2's overflow range but
    // NOT A1's. Id order: A1's overflow lands FIRST, pushing A2 to 1610
    // (Elite), so A2's own kill then overflows to R. Reverse order would
    // leave R at 0 (A2 banks its own kill first, then A1's overflow finds
    // A2 already maxed and is lost) — so R.xp pins id-order crediting.
    const a1 = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    a1.xp = 1600;
    a1.vetLevel = 3;
    const a2 = directSpawn(ctx.world, 'rifles', 0, 30, 0);
    a2.xp = 1550;
    a2.vetLevel = 2;
    const r = directSpawn(ctx.world, 'rifles', 0, 60, 0);
    const t1 = directSpawn(ctx.world, 'rifles', 1, 10, 0);
    t1.hp = 1;
    const t2 = directSpawn(ctx.world, 'rifles', 1, 40, 0);
    t2.hp = 1;
    expect(a1.id).toBeLessThan(a2.id);
    expect(a2.id).toBeLessThan(r.id);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, t1.id)).toBeUndefined();
    expect(findUnit(ctx.world, t2.id)).toBeUndefined();
    // A1's +60 overflowed to A2 (only eligible ally in A1's range).
    expect(a2.xp).toBe(1610);
    expect(a2.vetLevel).toBe(3);
    // A2's own kill overflowed to R (A1 already maxed).
    expect(r.xp).toBe(60);
    // A1 is maxed: its own award went to A2, A1's xp is untouched.
    expect(a1.xp).toBe(1600);
  });

  it('overflow splits floor shares by id; remainder goes to the lowest ids', () => {
    const ctx = setup();
    const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    killer.xp = 1600;
    killer.vetLevel = 3;
    // Three allies in range, one out of range (must get nothing).
    const a = directSpawn(ctx.world, 'rifles', 0, 10, 0);
    const b = directSpawn(ctx.world, 'rifles', 0, 20, 0);
    const c = directSpawn(ctx.world, 'rifles', 0, 30, 0);
    const far = directSpawn(ctx.world, 'rifles', 0, VET_OVERFLOW_RADIUS + 50, 0);
    expect(a.id).toBeLessThan(b.id);
    expect(b.id).toBeLessThan(c.id);
    // engineer kill = 50 xp: 50/3 = 16 r2 → 17, 17, 16.
    awardKillXp(ctx.world, killer, UNIT_DEFS.engineer);
    expect(a.xp).toBe(17);
    expect(b.xp).toBe(17);
    expect(c.xp).toBe(16);
    expect(far.xp).toBe(0);
    expect(killer.xp).toBe(1600); // maxed killer gains nothing
  });

  it('overflow skips dead, enemy, and maxed units', () => {
    const ctx = setup();
    const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    killer.xp = 1600;
    killer.vetLevel = 3;
    const dead = directSpawn(ctx.world, 'rifles', 0, 10, 0);
    dead.hp = 0;
    const enemy = directSpawn(ctx.world, 'rifles', 1, 12, 0);
    const maxed = directSpawn(ctx.world, 'rifles', 0, 14, 0);
    maxed.xp = 1600;
    maxed.vetLevel = 3;
    const ally = directSpawn(ctx.world, 'rifles', 0, 16, 0);
    awardKillXp(ctx.world, killer, UNIT_DEFS.engineer); // 50, one ally
    expect(ally.xp).toBe(50);
    expect(dead.xp).toBe(0);
    expect(enemy.xp).toBe(0);
    expect(maxed.xp).toBe(1600);
  });

  it('no eligible allies → XP is lost', () => {
    const ctx = setup();
    const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    killer.xp = 1600;
    killer.vetLevel = 3;
    awardKillXp(ctx.world, killer, UNIT_DEFS.tank); // 460, nobody in range
    expect(killer.xp).toBe(1600);
  });

  it('zero-value kills award nothing', () => {
    const ctx = setup();
    const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const free = { ...UNIT_DEFS.rifles, trainFunds: 0, trainMaterials: 0 };
    awardKillXp(ctx.world, killer, free);
    expect(killer.xp).toBe(0);
  });
});

describe('death erases veterancy', () => {
  it('a killed unit leaves no xp behind', () => {
    const ctx = setup();
    const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const victim = directSpawn(ctx.world, 'rifles', 1, 10, 0);
    victim.xp = 700;
    victim.vetLevel = 2;
    victim.hp = 1;
    enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: killer.id, targetId: victim.id, owner: 0 } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, victim.id)).toBeUndefined();
    expect(ctx.world.units.every((u) => u.id !== victim.id)).toBe(true);
    // The snapshot has no trace of the dead unit's veterancy either.
    const snap = takeSnapshot(ctx.world);
    expect(snap.units.every((u) => u.id !== victim.id)).toBe(true);
  });
});

describe('Elite regen and veterancy combat bonuses', () => {
  it('Elite units regen 2 hp/s up to the vet-adjusted max', () => {
    const ctx = setup();
    const u = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    u.xp = 1600;
    u.vetLevel = 3;
    const maxHp = vetAdjustedMaxHp(ctx.world, u); // 110 * 1.3 = 143
    u.hp = maxHp - 10;
    runTicks(ctx, 30); // 1 sim-second → +2 hp
    expect(u.hp).toBeCloseTo(maxHp - 8, 9);
    runTicks(ctx, 300); // regen caps at the vet-adjusted max
    expect(u.hp).toBeCloseTo(maxHp, 9);
  });

  it('non-Elite units do not regen', () => {
    const ctx = setup();
    const u = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    u.vetLevel = 2;
    u.hp = 50;
    runTicks(ctx, 60);
    expect(u.hp).toBe(50);
  });

  it('veteran damage bonus applies to real shots (level 0 unchanged)', () => {
    const ctx = setup();
    const a0 = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const a1 = directSpawn(ctx.world, 'rifles', 0, 30, 0);
    a1.xp = 300;
    a1.vetLevel = 1;
    const t0 = directSpawn(ctx.world, 'rifles', 1, 10, 0);
    const t1 = directSpawn(ctx.world, 'rifles', 1, 40, 0);
    // Keep the targets apart (range 15) so each attacker fires at its own.
    t0.hp = 1000;
    t1.hp = 1000;
    enqueue(ctx, [
      { kind: 'attackUnit', payload: { unitId: a0.id, targetId: t0.id, owner: 0 } },
      { kind: 'attackUnit', payload: { unitId: a1.id, targetId: t1.id, owner: 0 } },
    ]);
    runTicks(ctx, 1);
    // rifles: 9 dmg vs light ×1.0. L0: 9. L1: 9 × 1.1 = 9.9.
    expect(t0.hp).toBeCloseTo(1000 - 9, 9);
    expect(t1.hp).toBeCloseTo(1000 - 9.9, 9);
  });

  it('veteran cooldown is shorter (level 0 keeps the def value)', () => {
    const ctx = setup();
    const a0 = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const a3 = directSpawn(ctx.world, 'rifles', 0, 30, 0);
    a3.xp = 1600;
    a3.vetLevel = 3;
    const t0 = directSpawn(ctx.world, 'rifles', 1, 10, 0);
    const t1 = directSpawn(ctx.world, 'rifles', 1, 40, 0);
    t0.hp = 100000;
    t1.hp = 100000;
    enqueue(ctx, [
      { kind: 'attackUnit', payload: { unitId: a0.id, targetId: t0.id, owner: 0 } },
      { kind: 'attackUnit', payload: { unitId: a3.id, targetId: t1.id, owner: 0 } },
    ]);
    runTicks(ctx, 1);
    expect(a0.cooldownLeft).toBe(20); // def value, unchanged
    expect(a3.cooldownLeft).toBe(14); // 20 × 0.7
  });

  it('combat medics can heal the veteran bonus hp', () => {
    const ctx = setup();
    const medic = directSpawn(ctx.world, 'combatMedic', 0, 0, 0);
    void medic;
    const vet = directSpawn(ctx.world, 'rifles', 0, 5, 0);
    vet.vetLevel = 2; // max hp = 110 × 1.15 = 126.5
    vet.hp = 120; // above the base 110 max — only a vet-aware cap heals this
    runTicks(ctx, 30); // 1 sim-second of heal aura at 2 hp/s
    expect(vet.hp).toBeGreaterThan(120);
    expect(vet.hp).toBeLessThanOrEqual(126.5 + 1e-9);
  });
});

describe('Military Academy', () => {
  it('spawnUnit: armed units graduate Regular with a completed academy', () => {
    const ctx = setup();
    completeBuilding(ctx.world, 'militaryAcademy', 0, 10, 10);
    const rifles = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    expect(rifles.xp).toBe(300);
    expect(rifles.vetLevel).toBe(1);
    // Unarmed units get no bonus.
    const hauler = directSpawn(ctx.world, 'hauler', 0, 5, 5);
    expect(hauler.xp).toBe(0);
    expect(hauler.vetLevel).toBe(0);
    const medic = directSpawn(ctx.world, 'combatMedic', 0, 8, 8);
    expect(medic.xp).toBe(0);
    expect(medic.vetLevel).toBe(0);
  });

  it('spawnUnit: no academy → Recruit; other-owner academy → Recruit', () => {
    const ctx = setup();
    const a = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    expect(a.xp).toBe(0);
    expect(a.vetLevel).toBe(0);
    completeBuilding(ctx.world, 'militaryAcademy', 1, 10, 10);
    const b = directSpawn(ctx.world, 'rifles', 0, 5, 5);
    expect(b.xp).toBe(0);
    expect(b.vetLevel).toBe(0);
    const c = directSpawn(ctx.world, 'rifles', 1, 8, 8);
    expect(c.xp).toBe(300);
    expect(c.vetLevel).toBe(1);
  });

  it('an under-construction academy grants nothing', () => {
    const ctx = setup();
    completeBuilding(ctx.world, 'militaryAcademy', 0, 10, 10);
    const rec = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
    rec.progress = 0.5; // not completed
    const u = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    expect(u.xp).toBe(0);
    expect(u.vetLevel).toBe(0);
  });

  it('placeBuilding: academy requires a completed barracks', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 12, 6);
    enqueue(ctx, [
      { kind: 'paintZone', payload: { owner: 0, zone: ZoneType.INDUSTRIAL, x0: cx, z0: cz, x1: cx + 11, z1: cz + 5 } },
    ]);
    runTicks(ctx, 1);
    // Without a barracks the academy order is rejected.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'placeBuilding',
        payload: { kind: 'militaryAcademy', owner: 0, cx, cz, facing: 0 },
      }),
    ).toThrow(/requires a completed Barracks/);
    // With a completed barracks it validates and places.
    completeBuilding(ctx.world, 'barracks', 0, cx, cz + 3);
    ctx.queue.enqueue(ctx.world, {
      issuer: 'player',
      kind: 'placeBuilding',
      payload: { kind: 'militaryAcademy', owner: 0, cx: cx + 4, cz, facing: 0 },
    });
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings.some((b) => b.kind === 'militaryAcademy')).toBe(true);
  });

  it('academy def carries the locked numbers', () => {
    const def = BUILDING_DEFS.militaryAcademy;
    expect(def.name).toBe('Military Academy');
    expect(def.zone).toBe(ZoneType.INDUSTRIAL);
    expect(def.footprintW).toBe(3);
    expect(def.footprintH).toBe(3);
    expect(def.costFunds).toBe(600);
    expect(def.costMaterials).toBe(200);
    expect(def.buildSeconds).toBe(30);
    expect(def.upkeepFundsPerSec).toBe(0.8);
    expect(def.powerDemand).toBe(2);
    expect(def.waterDemand).toBe(1);
    expect(def.requiredBuilding).toBe('barracks');
    expect(def.minAge).toBe('foundation');
  });
});

describe('veterancy snapshots and digests', () => {
  it('snapshot round-trips xp/vetLevel', () => {
    const ctx = setup();
    const u = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    u.xp = 750;
    u.vetLevel = 2;
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    const ru = findUnit(restored, u.id)!;
    expect(ru.xp).toBe(750);
    expect(ru.vetLevel).toBe(2);
    expect(digestWorld(restored)).toBe(digestWorld(ctx.world));
  });

  it('legacy v6 saves without xp/vetLevel decode to 0 (no version bump)', () => {
    const ctx = setup();
    directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const snap = takeSnapshot(ctx.world) as unknown as {
      units: Array<Record<string, unknown>>;
    };
    for (const su of snap.units) {
      delete su['xp'];
      delete su['vetLevel'];
    }
    const restored = restoreSnapshot(snap as never);
    for (const u of restored.units) {
      expect(u.xp).toBe(0);
      expect(u.vetLevel).toBe(0);
    }
  });

  it('digest changes when xp changes', () => {
    const ctx = setup();
    const u = directSpawn(ctx.world, 'rifles', 0, 0, 0);
    const before = digestWorld(ctx.world);
    u.xp = 60;
    u.vetLevel = 0;
    const after = digestWorld(ctx.world);
    expect(after).not.toBe(before);
    // Phase 3 logistics: the unit segment now carries fuel, ammo, the
    // 3-bit service toggles, the resupply depot id, reserved amounts and
    // cargo holds after vetLevel (all defaults here: 0,0,111,0,0,0,0,0),
    // then the sea-logistics materials hold + the sea-route assignment
    // (0 = unassigned, leg '-' = no route), then the attack-move state
    // triple (2026-10-04: 0,-,- = not attack-moving), then the Phase 4
    // (S7) ferry route ('-' = no route).
    expect(canonicalizeWorld(ctx.world)).toContain(`,60,0,0,0,111,0,0,0,0,0,0,0,-,0,-,-,-`);  });

  it('same seed + same commands ⇒ identical digest (veterancy included)', () => {
    const script = (ctx: Ctx): void => {
      const killer = directSpawn(ctx.world, 'rifles', 0, 0, 0);
      const target = directSpawn(ctx.world, 'rifles', 1, 10, 0);
      target.hp = 1;
      enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: killer.id, targetId: target.id, owner: 0 } }]);
      runTicks(ctx, 40);
      // A second wave earns more XP through the same code path.
      const k2 = directSpawn(ctx.world, 'tank', 0, 20, 0);
      const t2 = directSpawn(ctx.world, 'rifles', 1, 30, 0);
      t2.hp = 1;
      enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: k2.id, targetId: t2.id, owner: 0 } }]);
      runTicks(ctx, 60);
    };
    const a = setup(777);
    script(a);
    const b = setup(777);
    script(b);
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
    // Sanity: XP actually accrued in both runs.
    expect(a.world.units.some((u) => u.xp > 0)).toBe(true);
  });
});

describe('veterancy sight bonus (AI perception)', () => {
  it('vetSightMult multiplies the unit sight, not the Signals Grid bonus', () => {
    const ctx = setup();
    setDoctrine(ctx.world, 0, 'kestrel'); // base sight 22 (Republic would see 26.4)
    // Scout at (0,0) with sight 22 (rifles). Enemy at 23: invisible at L0.
    directSpawn(ctx.world, 'rifles', 0, 0, 0);
    directSpawn(ctx.world, 'rifles', 1, 23, 0);
    expect(getVisibleEnemies(ctx.world, 0)).toHaveLength(0);
    // Veteran (L2): 22 × 1.2 = 26.4 ≥ 23 → visible.
    const scout = ctx.world.units.find((u) => u.owner === 0)!;
    scout.vetLevel = 2;
    const seen = getVisibleEnemies(ctx.world, 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.owner).toBe(1);
  });
});
