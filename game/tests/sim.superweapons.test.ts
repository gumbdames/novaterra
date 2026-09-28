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
import { registerAgeCommands } from '../src/sim/ages';
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
  ctx.world.ages.age = 'ascendance';
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
      if (!city.roads.includes(roadCell)) {
        city.roads.push(roadCell);
        city.roads.sort((a, b) => a - b);
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
    ctx.world.ages.age = 'industry';
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'placeBuilding',
        payload: { kind: 'aegisControl', owner: 0, cx: 10, cz: 10, facing: 0 },
      }),
    ).toThrow(/Ascendance/);
    ctx.world.ages.age = 'ascendance';
    // Still needs a road etc. — the age gate specifically is what we test;
    // with no road it fails on road adjacency, not age.
    try {
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'placeBuilding',
        payload: { kind: 'aegisControl', owner: 0, cx: 10, cz: 10, facing: 0 },
      });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Ascendance/);
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
    ctx.world.ages.age = 'ascendance';
    expect(() =>
      ctx.queue.enqueue(ctx.world, { issuer: 'player', kind: 'fireAegis', payload: { owner: 0 } }),
    ).toThrow(/Aegis Control/);
    expect(() =>
      ctx.queue.enqueue(ctx.world, { issuer: 'player', kind: 'fireAegis', payload: { owner: 42 } }),
    ).toThrow(CommandRejectedError);
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

  it('fireStorm validates age, facility, coordinates, and cooldown', () => {
    const ctx = setup();
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'fireStorm', payload: { owner: 0, x: 1, z: 1 },
      }),
    ).toThrow(/Ascendance/);
    ctx.world.ages.age = 'ascendance';
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
    ctx.world.ages.age = 'ascendance';
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

  it('non-marshal AI cannot use the construction command', () => {
    const ctx = setup();
    ctx.world.ages.age = 'ascendance';
    addAIPlayer(ctx.world, 1, 'general', 400, 400);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'ai', kind: 'constructSuperweaponFacility',
        payload: { owner: 1, kind: 'storm' },
      }),
    ).toThrow(/Marshal/);
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
