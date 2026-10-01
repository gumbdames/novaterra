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

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  CommandRejectedError,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  cellCenterWorld,
  cellIndex,
  cellIsWater,
  getPlayer,
  placeBuilding,
  registerCityCommands,
  type CityState,
} from '../src/sim/city';
import { spawnUnit, registerUnitCommands, UNIT_DEFS } from '../src/sim/units';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { createEconomySystem } from '../src/sim/economy';
import { registerMovementCommands } from '../src/sim/movement';
import { registerAgeCommands , getAgeState } from '../src/sim/ages';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
import {
  registerSuperweaponCommands,
  createSuperweaponSystem,
  isAegisActive,
  isAegisReady,
  isStormReady,
  hasAegisFacility,
  hasStormFacility,
  AEGIS_DURATION_TICKS,
  SUPERWEAPON_COOLDOWN_TICKS,
  STORM_RADIUS,
  STORM_STRIKE_COUNT,
  STORM_STRIKE_INTERVAL_TICKS,
  STORM_DAMAGE,
  STORM_FX_TICKS,
} from '../src/sim/superweapons';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';

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

function setup(seed = 404001): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerAgeCommands(queue);
  registerSuperweaponCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createCombatSystem(),
      createSuperweaponSystem(),
      createEconomySystem(terrain),
      createAISystem(queue),
    ],
  });
  return { terrain, world, queue, driver };
}

function enqueue(ctx: Ctx, cmds: Omit<NewCommand, 'issuer'>[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, { issuer: 'player', ...c });
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

/** Give the player everything: Ascendance age + a completed facility + solvency. */
function godAscendance(ctx: Ctx, kind: 'aegisControl' | 'stormArray'): void {
  // God-mode fixture: the staged world is at Ascendance. Per-side ages
  // (roadmap A1, 2026-10-01): both staged sides get it — some tests hand
  // the shield to owner 1 or fire as the AI side.
  getAgeState(ctx.world, 0).age = 'ascendance';
  getAgeState(ctx.world, 1).age = 'ascendance';
  const city = ctx.world.city;
  const b = placeBuildingForTest(city, kind, 0);
  b.progress = 1;
  b.operational = true;
  b.powered = true;
  b.watered = true;
  // placeBuilding deducts the (large) cost straight from funds; top the
  // player back up so the economy's upkeep pass doesn't mothball the
  // zero-upkeep facility for insolvency on the first economy tick.
  const p = getPlayer(city, 0) as { funds: number; materials: number };
  p.funds = 20000;
  p.materials = 20000;
}

function placeBuildingForTest(city: CityState, kind: 'aegisControl' | 'stormArray', owner: number) {
  // Find a land cell, pave a neighboring road, place via the real function.
  const t = getTerrain();
  for (let cz = 2; cz < 60; cz++) {
    for (let cx = 2; cx < 60; cx++) {
      if (cellIsWater(t, cx, cz) || cellIsWater(t, cx + 1, cz)) continue;
      const roadCell = cellIndex(cx - 1, cz);
      // Phase 4 (S7): roads are RoadCell[].
      if (!city.roads.some((r) => r.cell === roadCell)) {
        city.roads.push({ cell: roadCell, cls: 'paved' });
        city.roads.sort((a, b) => a.cell - b.cell);
      }
      try {
        return placeBuilding(city, { kind, owner, cx, cz, facing: 0 });
      } catch {
        continue;
      }
    }
  }
  throw new Error('no placement found');
}

describe('sim/superweapons — buildings', () => {
  it('aegisControl/stormArray need the Ascendance age to place', () => {
    const ctx = setup();
    getAgeState(ctx.world, 0).age = 'industry';
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'placeBuilding',
        payload: { kind: 'aegisControl', owner: 0, cx: 10, cz: 10, facing: 0 },
      }),
    ).toThrow(/ascendance/i);
    getAgeState(ctx.world, 0).age = 'ascendance';
    // Still needs a road etc. — the age gate specifically is what we test;
    // with no road it fails on road adjacency, not age.
    try {
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'placeBuilding',
        payload: { kind: 'aegisControl', owner: 0, cx: 10, cz: 10, facing: 0 },
      });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/ascendance/i);
    }
  });
});

describe('sim/superweapons — Aegis', () => {
  it('fireAegis raises a 60s shield that blocks all damage', () => {
    const ctx = setup();
    godAscendance(ctx, 'aegisControl');
    expect(hasAegisFacility(ctx.world, 0)).toBe(true);
    expect(isAegisReady(ctx.world, 0)).toBe(true);
    // Attacker (owner 1) shoots a defender (owner 0) via direct combat ticks.
    const attacker = spawnUnit(ctx.world, 'rifles', 1, 0, 0);
    const defender = spawnUnit(ctx.world, 'rifles', 0, 5, 0);
    const fullHp = UNIT_DEFS.rifles.hp;
    enqueue(ctx, [{ kind: 'fireAegis', payload: { owner: 0 } }]);
    runTicks(ctx, 2);
    expect(isAegisActive(ctx.world, 0)).toBe(true);
    // Order the attack and let combat run: no damage gets through.
    ctx.queue.enqueue(ctx.world, {
      issuer: 'player', kind: 'attackUnit',
      payload: { unitId: attacker.id, targetId: defender.id, owner: 1 },
    });
    runTicks(ctx, 120);
    expect(defender.hp).toBe(fullHp);
    expect(isAegisActive(ctx.world, 0)).toBe(true);
  });

  it('the shield drops after 60 seconds and damage flows again', () => {
    const ctx = setup();
    godAscendance(ctx, 'aegisControl');
    const defender = spawnUnit(ctx.world, 'rifles', 0, 5, 0);
    const fullHp = UNIT_DEFS.rifles.hp;
    enqueue(ctx, [{ kind: 'fireAegis', payload: { owner: 0 } }]);
    runTicks(ctx, 2);
    expect(isAegisActive(ctx.world, 0)).toBe(true);
    runTicks(ctx, AEGIS_DURATION_TICKS + 10);
    expect(isAegisActive(ctx.world, 0)).toBe(false);
    // A fresh attacker engages after the shield is down: damage flows.
    const attacker = spawnUnit(ctx.world, 'rifles', 1, 0, 0);
    ctx.queue.enqueue(ctx.world, {
      issuer: 'player', kind: 'attackUnit',
      payload: { unitId: attacker.id, targetId: defender.id, owner: 1 },
    });
    runTicks(ctx, 120);
    expect(defender.hp).toBeLessThan(fullHp);
  });

  it('cooldown blocks a second firing; validation is loud', () => {
    const ctx = setup();
    godAscendance(ctx, 'aegisControl');
    enqueue(ctx, [{ kind: 'fireAegis', payload: { owner: 0 } }]);
    runTicks(ctx, 1);
    expect(() =>
      ctx.queue.enqueue(ctx.world, { issuer: 'player', kind: 'fireAegis', payload: { owner: 0 } }),
    ).toThrow(/already up|cooling down/);
    // Fast-forward past shield + cooldown.
    runTicks(ctx, SUPERWEAPON_COOLDOWN_TICKS + 10);
    expect(isAegisReady(ctx.world, 0)).toBe(true);
    enqueue(ctx, [{ kind: 'fireAegis', payload: { owner: 0 } }]);
    runTicks(ctx, 1);
    expect(isAegisActive(ctx.world, 0)).toBe(true);
  });

  it('fireAegis rejects without Ascendance, without the building, or unknown owner', () => {
    const ctx = setup();
    expect(() =>
      ctx.queue.enqueue(ctx.world, { issuer: 'player', kind: 'fireAegis', payload: { owner: 0 } }),
    ).toThrow(/Ascendance/);
    getAgeState(ctx.world, 0).age = 'ascendance';
    expect(() =>
      ctx.queue.enqueue(ctx.world, { issuer: 'player', kind: 'fireAegis', payload: { owner: 0 } }),
    ).toThrow(/Aegis Control/);
    expect(() =>
      ctx.queue.enqueue(ctx.world, { issuer: 'player', kind: 'fireAegis', payload: { owner: 42 } }),
    ).toThrow(CommandRejectedError);
  });

  it('the aegis fx is anchored in world units at the firing bases (final-review R1 M18)', () => {
    const ctx = setup();
    godAscendance(ctx, 'aegisControl');
    enqueue(ctx, [{ kind: 'fireAegis', payload: { owner: 0 } }]);
    runTicks(ctx, 2);
    const fx = ctx.world.superweapons.fx.filter((f) => f.kind === 'aegis');
    expect(fx).toHaveLength(1);
    // The single completed Aegis Control: centroid == its cell center, in
    // WORLD units. The bug averaged raw cell indices (~10), which the
    // render layer reads as world coords — the shield rendered at the map
    // origin instead of over the base (~-200).
    const b = ctx.world.city.buildings.find((bb) => bb.kind === 'aegisControl' && bb.owner === 0)!;
    expect(b).toBeDefined();
    expect(fx[0]!.x).toBe(cellCenterWorld(b.cx));
    expect(fx[0]!.z).toBe(cellCenterWorld(b.cz));
  });
});

describe('sim/superweapons — Storm Engine', () => {
  it('fireStorm schedules strikes that damage enemies in the area', () => {
    const ctx = setup();
    godAscendance(ctx, 'stormArray');
    expect(isStormReady(ctx.world, 0)).toBe(true);
    const victim = spawnUnit(ctx.world, 'rifles', 1, 50, 50);
    const far = spawnUnit(ctx.world, 'rifles', 1, 500, 500);
    const fullHp = UNIT_DEFS.rifles.hp;
    enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: 50, z: 50 } }]);
    runTicks(ctx, 2);
    expect(ctx.world.superweapons.strikes).toHaveLength(STORM_STRIKE_COUNT);
    runTicks(ctx, STORM_STRIKE_COUNT * STORM_STRIKE_INTERVAL_TICKS + 10);
    expect(ctx.world.superweapons.strikes).toHaveLength(0);
    expect(victim.hp).toBeLessThan(fullHp); // scatter ±3 keeps all strikes within radius 10
    expect(far.hp).toBe(fullHp);
  });

  it('storm strikes respect an active Aegis shield', () => {
    const ctx = setup();
    godAscendance(ctx, 'stormArray');
    godAscendance(ctx, 'aegisControl');
    // Give the shield to owner 1 (the storm target).
    const city = ctx.world.city;
    const aegis = city.buildings.find((b) => b.kind === 'aegisControl') as { owner: number };
    aegis.owner = 1;
    const victim = spawnUnit(ctx.world, 'rifles', 1, 50, 50);
    const fullHp = UNIT_DEFS.rifles.hp;
    enqueue(ctx, [
      { kind: 'fireAegis', payload: { owner: 1 } },
      { kind: 'fireStorm', payload: { owner: 0, x: 50, z: 50 } },
    ]);
    runTicks(ctx, STORM_STRIKE_COUNT * STORM_STRIKE_INTERVAL_TICKS + 10);
    expect(victim.hp).toBe(fullHp);
  });

  it('storm kills: a strike can destroy a unit (killUnit cleanup runs)', () => {
    const ctx = setup();
    godAscendance(ctx, 'stormArray');
    const weak = spawnUnit(ctx.world, 'rifles', 1, 50, 50);
    weak.hp = 1; // one strike finishes it
    const before = ctx.world.units.length;
    enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: 50, z: 50 } }]);
    runTicks(ctx, STORM_STRIKE_COUNT * STORM_STRIKE_INTERVAL_TICKS + 10);
    expect(ctx.world.units.length).toBe(before - 1);
    expect(ctx.world.units.find((u) => u.id === weak.id)).toBeUndefined();
  });

  it('storm fx entries appear for the renderer and expire', () => {
    const ctx = setup();
    godAscendance(ctx, 'stormArray');
    spawnUnit(ctx.world, 'rifles', 1, 50, 50);
    enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: 50, z: 50 } }]);
    runTicks(ctx, STORM_STRIKE_INTERVAL_TICKS + 2);
    expect(ctx.world.superweapons.fx.length).toBeGreaterThan(0);
    expect(ctx.world.superweapons.fx[0]?.kind).toBe('storm');
    // Wait out the whole strike schedule plus the fx lifetime.
    runTicks(ctx, STORM_STRIKE_COUNT * STORM_STRIKE_INTERVAL_TICKS + STORM_FX_TICKS + 10);
    expect(ctx.world.superweapons.fx).toHaveLength(0);
  });

  it('aegis fx entry appears on firing, anchored at the base, and expires with the shield', () => {
    const ctx = setup();
    godAscendance(ctx, 'aegisControl');
    enqueue(ctx, [{ kind: 'fireAegis', payload: { owner: 0 } }]);
    runTicks(ctx, 2);
    expect(isAegisActive(ctx.world, 0)).toBe(true);
    const fx = ctx.world.superweapons.fx.filter((f) => f.kind === 'aegis');
    expect(fx).toHaveLength(1);
    expect(fx[0]?.untilTick).toBeGreaterThan(ctx.world.tick);
    // The dome outlives the test's short run: it expires with the shield.
    runTicks(ctx, AEGIS_DURATION_TICKS + 10);
    expect(isAegisActive(ctx.world, 0)).toBe(false);
    expect(ctx.world.superweapons.fx.some((f) => f.kind === 'aegis')).toBe(false);
  });

  it('fireStorm validates age, facility, coordinates, and cooldown', () => {
    const ctx = setup();
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'fireStorm', payload: { owner: 0, x: 1, z: 1 },
      }),
    ).toThrow(/Ascendance/);
    getAgeState(ctx.world, 0).age = 'ascendance';
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'fireStorm', payload: { owner: 0, x: 1, z: 1 },
      }),
    ).toThrow(/Storm Array/);
    godAscendance(ctx, 'stormArray');
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'fireStorm', payload: { owner: 0, x: NaN, z: 1 },
      }),
    ).toThrow(CommandRejectedError);
    enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: 50, z: 50 } }]);
    runTicks(ctx, 1);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'fireStorm', payload: { owner: 0, x: 50, z: 50 },
      }),
    ).toThrow(/cooling down/);
  });
});

describe('sim/superweapons — Marshal AI', () => {
  it('a Marshal AI constructs and fires the Storm at visible enemies', () => {
    const ctx = setup(909);
    getAgeState(ctx.world, 1).age = 'ascendance';
    addAIPlayer(ctx.world, 1, 'marshal', 0, 0);
    const player = getPlayer(ctx.world.city, 1) as { funds: number; materials: number };
    player.funds = 1e7;
    player.materials = 1e7;
    runTicks(ctx, 60); // marshal thinks every 30 ticks
    const ai = ctx.world.ai.players.find((p) => p.owner === 1);
    expect(ai?.superweapons.stormReadyTick).toBeGreaterThan(0);
    // Fast-forward through construction (no targets yet — the Marshal's
    // army would kill them during the 150s build).
    runTicks(ctx, 150 * 30 + 120);
    expect(hasStormFacility(ctx.world, 1)).toBe(true);
    expect(isStormReady(ctx.world, 1)).toBe(true);
    // Now present a visible cluster: fresh targets + a fresh AI scout.
    for (let i = 0; i < 4; i++) spawnUnit(ctx.world, 'rifles', 0, -10 + i * 2, -10);
    spawnUnit(ctx.world, 'rifles', 1, 0, 0);
    runTicks(ctx, 120); // let the Marshal think and fire
    const fired = ctx.world.superweapons.strikes.length > 0 ||
      ctx.world.superweapons.fx.some((f) => f.kind === 'storm') ||
      (ctx.world.superweapons.players.find((p) => p.owner === 1)?.storm.cooldownUntil ?? 0) > 0;
    expect(fired).toBe(true);
  });

  it('fires the Storm at the largest visible cluster, not the centroid', () => {
    // Final-review R5 (2026-10-01): largest-cluster targeting. Two
    // far-apart enemy groups — 5 rifles at x≈-60, 3 at x≈+60. The old
    // all-visible centroid would land near x≈-14 (empty ground); the
    // new targeting fires at a member of the 5-unit cluster.
    const ctx = setup(911);
    getAgeState(ctx.world, 1).age = 'ascendance';
    addAIPlayer(ctx.world, 1, 'marshal', 0, 0);
    const ai = ctx.world.ai.players.find((p) => p.owner === 1);
    if (!ai) throw new Error('AI player missing');
    ai.superweapons.stormReadyTick = 1; // built, off cooldown
    for (let i = 0; i < 5; i++) spawnUnit(ctx.world, 'rifles', 0, -62 + i * 2, 0);
    for (let i = 0; i < 3; i++) spawnUnit(ctx.world, 'rifles', 0, 58 + i * 2, 0);
    spawnUnit(ctx.world, 'rifles', 1, -60, 6); // AI eyes on both groups
    spawnUnit(ctx.world, 'rifles', 1, 60, 6);
    ctx.world.tick = 1;
    ai.nextThinkTick = 1;
    createAISystem(ctx.queue)(ctx.world, 1);
    const applied = ctx.queue.applyDue(ctx.world, 1);
    const fire = applied.find((a) => a.command.kind === 'fireStorm');
    expect(fire, 'marshal fired the storm').toBeDefined();
    const x = fire!.command.payload['x'] as number;
    expect(Math.abs(x - -60)).toBeLessThanOrEqual(STORM_RADIUS);
  });

  it('non-marshal AI cannot use the construction command', () => {
    const ctx = setup();
    // The general (owner 1) is at Ascendance: the only gate left is personality.
    getAgeState(ctx.world, 1).age = 'ascendance';
    addAIPlayer(ctx.world, 1, 'general', 400, 400);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'ai', kind: 'constructSuperweaponFacility',
        payload: { owner: 1, kind: 'storm' },
      }),
    ).toThrow(/Marshal/);
  });
});

describe('sim/superweapons — AI ledger guard (R1 H2)', () => {
  /**
   * Drive exactly one marshal think + applyDue, without the other
   * systems (economy upkeep would move funds between setup and
   * assert). Returns the kinds applied at tick 0.
   */
  function thinkOnce(ctx: Ctx, owner: number): string[] {
    const ai = ctx.world.ai.players.find((p) => p.owner === owner);
    if (!ai) throw new Error('H2: AI player missing');
    ai.nextThinkTick = 0;
    ctx.world.tick = 0;
    createAISystem(ctx.queue)(ctx.world, 0);
    // applyDue must never throw: before the H2 guard, a think whose
    // production/research pass reserved the treasury left the bare
    // facility command stale, and applyDue threw CommandRejectedError
    // out of runTick (a hard crash).
    const applied = ctx.queue.applyDue(ctx.world, 0);
    return applied.map((a) => a.command.kind);
  }

  function marshalAtAscendance(ctx: Ctx, owner: number): void {
    getAgeState(ctx.world, owner).age = 'ascendance';
    addAIPlayer(ctx.world, owner, 'marshal', 0, 0);
    const ai = ctx.world.ai.players.find((p) => p.owner === owner);
    if (!ai) throw new Error('H2: AI player missing');
    ai.virtualBuildings.completed = [
      'barracks',
      'warFactory',
      'airfield',
      'lab',
      'radarStation',
    ];
  }

  it('a think that spends its treasury on units does not enqueue an unaffordable facility', () => {
    const ctx = setup(424242);
    marshalAtAscendance(ctx, 1);
    const player = getPlayer(ctx.world.city, 1);
    if (!player) throw new Error('H2: player missing');
    // 6050 funds looks affordable for the 6000-fund storm facility —
    // but thinkSuperweapons runs AFTER production/research in the same
    // think (see thinkMarshal), and production reserves at least 600
    // funds here (the 20 starting manpower trains 10+ rifles at 60
    // funds each). The ledger guard sees 6050 − ledger < 6000 and
    // fizzles the facility at think time instead of crashing at apply.
    player.funds = 6050;
    player.materials = 3000;
    const kinds = thinkOnce(ctx, 1);
    expect(kinds).not.toContain('constructSuperweaponFacility');
    const ai = ctx.world.ai.players.find((p) => p.owner === 1);
    expect(ai?.superweapons.stormReadyTick).toBe(0);
  });

  it('an affordable facility is still enqueued and applies cleanly', () => {
    const ctx = setup(434343);
    marshalAtAscendance(ctx, 1);
    const player = getPlayer(ctx.world.city, 1);
    if (!player) throw new Error('H2: player missing');
    // Army at the marshal cap (48) so production reserves nothing;
    // the 20000 treasury covers the 6000-fund facility even after the
    // scout pass trains its drone.
    for (let i = 0; i < 48; i++) spawnUnit(ctx.world, 'rifles', 1, i, 0);
    player.funds = 20000;
    player.materials = 20000;
    const kinds = thinkOnce(ctx, 1);
    expect(kinds).toContain('constructSuperweaponFacility');
    const ai = ctx.world.ai.players.find((p) => p.owner === 1);
    expect(ai?.superweapons.stormReadyTick).toBeGreaterThan(0);
  });
});

describe('sim/superweapons — determinism', () => {
  it('same storm, same digest (scatter is seeded)', () => {
    const run = (): number => {
      const ctx = setup(31337);
      godAscendance(ctx, 'stormArray');
      spawnUnit(ctx.world, 'rifles', 1, 50, 50);
      spawnUnit(ctx.world, 'rifles', 1, 55, 52);
      enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: 52, z: 51 } }]);
      runTicks(ctx, STORM_STRIKE_COUNT * STORM_STRIKE_INTERVAL_TICKS + 60);
      return digestWorld(ctx.world);
    };
    expect(run()).toBe(run());
  });

  it('snapshot round-trip preserves superweapon state and digest', () => {
    const ctx = setup();
    godAscendance(ctx, 'aegisControl');
    godAscendance(ctx, 'stormArray');
    enqueue(ctx, [
      { kind: 'fireAegis', payload: { owner: 0 } },
      { kind: 'fireStorm', payload: { owner: 0, x: 50, z: 50 } },
    ]);
    runTicks(ctx, 5);
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(digestWorld(restored)).toBe(before);
    expect(isAegisActive(restored, 0)).toBe(true);
    expect(restored.superweapons.strikes).toHaveLength(STORM_STRIKE_COUNT);
  });

  it('STORM_DAMAGE sanity: one strike cannot one-shot a tank, a full storm can', () => {
    // 120 per strike vs 500 tank hp: a single strike won't kill a tank, but
    // all 8 strikes landing (960 raw) will — storms punish clumped armor.
    expect(STORM_DAMAGE).toBeLessThan(UNIT_DEFS.tank.hp);
    expect(STORM_DAMAGE * STORM_STRIKE_COUNT).toBeGreaterThan(UNIT_DEFS.tank.hp);
  });
});
