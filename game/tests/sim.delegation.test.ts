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
import { getPlayer } from '../src/sim/city';
import { spawnUnit, registerUnitCommands } from '../src/sim/units';
import { registerMovementCommands } from '../src/sim/movement';
import { registerCombatCommands } from '../src/sim/combat';
import {
  registerDelegationCommands,
  createMayorSystem,
  createGeneralSystem,
  getMayor,
  getGeneral,
  GENERAL_THINK_TICKS,
  MAYOR_POLICY_RATES,
  MAYOR_BUILD_TICKS,
} from '../src/sim/delegation';
import { cellIndex, registerCityCommands } from '../src/sim/city';
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

function setup(seed = 303001): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerDelegationCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [createMayorSystem(queue, terrain), createGeneralSystem(queue)],
  });
  return { terrain, world, queue, driver };
}

function enqueue(ctx: Ctx, cmds: Omit<NewCommand, 'issuer'>[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, { issuer: 'player', ...c });
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

function taxRates(ctx: Ctx): [number, number, number, number] {
  return (getPlayer(ctx.world.city, 0) as { taxRates: [number, number, number, number] }).taxRates;
}

describe('sim/delegation — mayors', () => {
  it('assignMayor stores the policy; the mayor system enforces its rates', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'revenue' } }]);
    runTicks(ctx, 1); // apply the command
    expect(getMayor(ctx.world, 0)?.policy).toBe('revenue');
    // Manual rate first, then let the mayor tick run.
    (getPlayer(ctx.world.city, 0) as { taxRates: [number, number, number, number] }).taxRates = [0.01, 0.01, 0.01, 0.01];
    runTicks(ctx, 30);
    expect(taxRates(ctx)).toEqual([...MAYOR_POLICY_RATES.revenue]);
  });

  it('growth policy lowers rates; re-assigning updates the policy', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'growth' } }]);
    runTicks(ctx, 31);
    expect(taxRates(ctx)).toEqual([...MAYOR_POLICY_RATES.growth]);
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'balanced' } }]);
    runTicks(ctx, 31);
    expect(taxRates(ctx)).toEqual([...MAYOR_POLICY_RATES.balanced]);
  });

  it('dismissMayor removes the mayor; manual rates are then untouched', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'revenue' } }]);
    runTicks(ctx, 31);
    expect(taxRates(ctx)).toEqual([...MAYOR_POLICY_RATES.revenue]);
    enqueue(ctx, [{ kind: 'dismissMayor', payload: { owner: 0 } }]);
    runTicks(ctx, 1);
    expect(getMayor(ctx.world, 0)).toBeUndefined();
    const player = getPlayer(ctx.world.city, 0) as { taxRates: [number, number, number, number] };
    player.taxRates = [0.11, 0.12, 0.13, 0.14];
    runTicks(ctx, 60);
    expect(taxRates(ctx)).toEqual([0.11, 0.12, 0.13, 0.14]);
  });

  it('rejects bad policy, unknown owner, and dismissing nobody', () => {
    const ctx = setup();
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'assignMayor', payload: { owner: 0, policy: 'tyranny' },
      }),
    ).toThrow(CommandRejectedError);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'assignMayor', payload: { owner: 99, policy: 'growth' },
      }),
    ).toThrow(CommandRejectedError);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'dismissMayor', payload: { owner: 0 },
      }),
    ).toThrow(CommandRejectedError);
  });

  it('opt-in: without a mayor, tax rates never change on their own', () => {
    const ctx = setup();
    const player = getPlayer(ctx.world.city, 0) as { taxRates: [number, number, number, number] };
    player.taxRates = [0.2, 0.2, 0.2, 0.2];
    runTicks(ctx, 120);
    expect(taxRates(ctx)).toEqual([0.2, 0.2, 0.2, 0.2]);
  });
});

describe('sim/delegation — generals', () => {
  /** Two rifles for owner 0 at origin, one enemy rifles at (10,0): visible (sight 22). */
  function skirmish(): Ctx {
    const ctx = setup();
    spawnUnit(ctx.world, 'rifles', 0, 0, 0);
    spawnUnit(ctx.world, 'rifles', 0, 2, 0);
    spawnUnit(ctx.world, 'rifles', 1, 10, 0);
    return ctx;
  }

  function ownIds(ctx: Ctx): number[] {
    return ctx.world.units.filter((u) => u.owner === 0).map((u) => u.id);
  }

  it('assignGeneral validates ownership and stance', () => {
    const ctx = skirmish();
    const ids = ownIds(ctx);
    const enemyId = ctx.world.units.find((u) => u.owner === 1)?.id as number;
    // Enemy unit rejected.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'assignGeneral',
        payload: { owner: 0, unitIds: [enemyId], stance: 'aggressive' },
      }),
    ).toThrow(CommandRejectedError);
    // Bad stance rejected.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'assignGeneral',
        payload: { owner: 0, unitIds: ids, stance: 'berserk' },
      }),
    ).toThrow(CommandRejectedError);
    // Empty group rejected.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'assignGeneral', payload: { owner: 0, unitIds: [], stance: 'hold' },
      }),
    ).toThrow(CommandRejectedError);
    // Valid assignment sticks.
    enqueue(ctx, [{ kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'hold' } }]);
    runTicks(ctx, 1);
    expect(getGeneral(ctx.world, 0)?.stance).toBe('hold');
    expect(getGeneral(ctx.world, 0)?.unitIds).toEqual(ids);
  });

  it('aggressive stance orders attacks on visible enemies', () => {
    const ctx = skirmish();
    const ids = ownIds(ctx);
    const enemyId = ctx.world.units.find((u) => u.owner === 1)?.id as number;
    enqueue(ctx, [{ kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'aggressive' } }]);
    runTicks(ctx, GENERAL_THINK_TICKS + 2); // think, then apply the orders
    for (const id of ids) {
      const u = ctx.world.units.find((x) => x.id === id);
      expect(u?.chasing).toBe(true);
      expect(u?.targetId).toBe(enemyId);
    }
  });

  it('aggressive stance ignores enemies outside sight (no fog cheating)', () => {
    const ctx = setup();
    spawnUnit(ctx.world, 'rifles', 0, 0, 0);
    spawnUnit(ctx.world, 'rifles', 1, 200, 0); // far beyond sight 22
    const ids = ownIds(ctx);
    enqueue(ctx, [{ kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'aggressive' } }]);
    runTicks(ctx, GENERAL_THINK_TICKS + 2);
    const u = ctx.world.units.find((x) => x.id === ids[0]);
    expect(u?.chasing).toBe(false);
    expect(u?.targetId).toBe(0);
  });

  it('defensive stance engages near the group but stands down when the threat leaves', () => {
    const ctx = skirmish();
    const ids = ownIds(ctx);
    const enemy = ctx.world.units.find((u) => u.owner === 1) as { id: number; x: number; z: number };
    enqueue(ctx, [{ kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'defensive' } }]);
    runTicks(ctx, GENERAL_THINK_TICKS + 2);
    const u = ctx.world.units.find((x) => x.id === ids[0]);
    expect(u?.chasing).toBe(true); // enemy 10 away < defensive radius 45
    // Move the threat far away: the general stands the group down.
    enemy.x = 500;
    enemy.z = 500;
    runTicks(ctx, GENERAL_THINK_TICKS + 2);
    const u2 = ctx.world.units.find((x) => x.id === ids[0]);
    expect(u2?.chasing).toBe(false);
  });

  it('hold stance stops chasing units', () => {
    const ctx = skirmish();
    const ids = ownIds(ctx);
    enqueue(ctx, [{ kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'aggressive' } }]);
    runTicks(ctx, GENERAL_THINK_TICKS + 2);
    expect(ctx.world.units.find((x) => x.id === ids[0])?.chasing).toBe(true);
    enqueue(ctx, [{ kind: 'setGeneralStance', payload: { owner: 0, stance: 'hold' } }]);
    runTicks(ctx, GENERAL_THINK_TICKS + 2);
    const u = ctx.world.units.find((x) => x.id === ids[0]);
    expect(u?.chasing).toBe(false);
    expect(u?.state).toBe('idle');
  });

  it('dismissGeneral ends automation; dead units are pruned from the group', () => {
    const ctx = skirmish();
    const ids = ownIds(ctx);
    enqueue(ctx, [{ kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'aggressive' } }]);
    runTicks(ctx, 1);
    // Kill one of the general's units directly.
    const victim = ctx.world.units.find((u) => u.id === ids[0]) as { hp: number };
    victim.hp = 0;
    runTicks(ctx, GENERAL_THINK_TICKS + 1);
    expect(getGeneral(ctx.world, 0)?.unitIds).toEqual([ids[1]]);
    enqueue(ctx, [{ kind: 'dismissGeneral', payload: { owner: 0 } }]);
    runTicks(ctx, 1);
    expect(getGeneral(ctx.world, 0)).toBeUndefined();
  });

  it('generals only command their own owner (two generals do not mix)', () => {
    const ctx = skirmish();
    const own = ownIds(ctx);
    const foe = ctx.world.units.filter((u) => u.owner === 1).map((u) => u.id);
    enqueue(ctx, [
      { kind: 'assignGeneral', payload: { owner: 0, unitIds: own, stance: 'aggressive' } },
      { kind: 'assignGeneral', payload: { owner: 1, unitIds: foe, stance: 'aggressive' } },
    ]);
    runTicks(ctx, GENERAL_THINK_TICKS + 2);
    // Both generals ordered attacks on each other's units.
    expect(ctx.world.units.find((x) => x.id === own[0])?.chasing).toBe(true);
    expect(ctx.world.units.find((x) => x.id === foe[0])?.chasing).toBe(true);
  });
});

describe('sim/delegation — setTaxRate', () => {
  it('sets one zone rate and leaves the others', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'setTaxRate', payload: { owner: 0, zone: 1, rate: 0.25 } }]);
    runTicks(ctx, 2);
    // The airport zone (3) got its own rate slot in Phase 5.
    expect(taxRates(ctx)).toEqual([0.1, 0.25, 0.1, 0.1]);
  });

  it('rejects bad zones and rates', () => {
    const ctx = setup();
    for (const payload of [
      { owner: 0, zone: 4, rate: 0.2 },
      { owner: 0, zone: 1, rate: -0.1 },
      { owner: 0, zone: 1, rate: 1.5 },
      { owner: 0, zone: 1, rate: 'high' },
    ]) {
      expect(() => enqueue(ctx, [{ kind: 'setTaxRate', payload }])).toThrow(
        CommandRejectedError,
      );
    }
    expect(taxRates(ctx)).toEqual([0.1, 0.1, 0.1, 0.1]);
  });

  it('applies even while a mayor holds office (the mayor system resets it next economy tick)', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'growth' } }]);
    runTicks(ctx, 1);
    expect(getMayor(ctx.world, 0)?.policy).toBe('growth');
    // The Management tab disables the tax steppers while a mayor holds
    // office; the command itself stays permissive and the mayor system
    // overwrites the manual rate at the next economy tick (30 ticks).
    enqueue(ctx, [{ kind: 'setTaxRate', payload: { owner: 0, zone: 0, rate: 0.5 } }]);
    runTicks(ctx, 2);
    expect(taxRates(ctx)[0]).toBe(0.5);
    runTicks(ctx, 30);
    expect(taxRates(ctx)).toEqual([...MAYOR_POLICY_RATES.growth]);
  });

  it('is deterministic across identical runs', () => {
    const run = (): [number, number, number, number] => {
      const ctx = setup(777001);
      enqueue(ctx, [
        { kind: 'setTaxRate', payload: { owner: 0, zone: 0, rate: 0.2 } },
        { kind: 'setTaxRate', payload: { owner: 0, zone: 2, rate: 0.3 } },
      ]);
      runTicks(ctx, 40);
      return taxRates(ctx);
    };
    expect(run()).toEqual(run());
  });
});

describe('sim/delegation — determinism', () => {
  it('same commands, same digest (mayor + general)', () => {
    const run = (): number => {
      const ctx = setup(777);
      spawnUnit(ctx.world, 'rifles', 0, 0, 0);
      spawnUnit(ctx.world, 'rifles', 1, 10, 0);
      const ids = ctx.world.units.filter((u) => u.owner === 0).map((u) => u.id);
      enqueue(ctx, [
        { kind: 'assignMayor', payload: { owner: 0, policy: 'revenue' } },
        { kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'aggressive' } },
      ]);
      runTicks(ctx, GENERAL_THINK_TICKS * 3);
      return digestWorld(ctx.world);
    };
    expect(run()).toBe(run());
  });

  it('snapshot round-trip preserves delegation state and digest', () => {
    const ctx = setup();
    spawnUnit(ctx.world, 'rifles', 0, 0, 0);
    const ids = ctx.world.units.filter((u) => u.owner === 0).map((u) => u.id);
    enqueue(ctx, [
      { kind: 'assignMayor', payload: { owner: 0, policy: 'growth' } },
      { kind: 'assignGeneral', payload: { owner: 0, unitIds: ids, stance: 'defensive' } },
    ]);
    runTicks(ctx, 5);
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(digestWorld(restored)).toBe(before);
    expect(getMayor(restored, 0)?.policy).toBe('growth');
    expect(getGeneral(restored, 0)?.stance).toBe('defensive');
  });
});

describe('sim/delegation — mayor building automation', () => {
  /** Pave a road + residential zone near (30,30) so the mayor can build. */
  function prepBuildable(ctx: Ctx): void {
    for (let i = 24; i <= 40; i++) {
      const c = cellIndex(i, 28);
      // Phase 4 (S7): roads are RoadCell[].
      if (!ctx.world.city.roads.some((r) => r.cell === c)) ctx.world.city.roads.push({ cell: c, cls: 'paved' });
    }
    ctx.world.city.roads.sort((a, b) => a.cell - b.cell);
    // Zone starts at z=29 so buildings sit zoned AND road-adjacent.
    enqueue(ctx, [{
      kind: 'paintZone',
      payload: { owner: 0, zone: 0, x0: 24, z0: 29, x1: 40, z1: 38 },
    }]);
    runTicks(ctx, 2);
    const p = getPlayer(ctx.world.city, 0) as { funds: number; materials: number };
    p.funds = 50000;
    p.materials = 50000;
  }

  it('assignMayor accepts a buildPolicy; setMayorBuildPolicy updates it', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'balanced', buildPolicy: 'housing' } }]);
    runTicks(ctx, 1);
    expect(getMayor(ctx.world, 0)?.buildPolicy).toBe('housing');
    enqueue(ctx, [{ kind: 'setMayorBuildPolicy', payload: { owner: 0, buildPolicy: 'industry' } }]);
    runTicks(ctx, 1);
    expect(getMayor(ctx.world, 0)?.buildPolicy).toBe('industry');
  });

  it('assignMayor defaults buildPolicy to balanced; bad values are rejected', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'balanced' } }]);
    runTicks(ctx, 1);
    expect(getMayor(ctx.world, 0)?.buildPolicy).toBe('balanced');
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'setMayorBuildPolicy',
        payload: { owner: 0, buildPolicy: 'moonbase' },
      }),
    ).toThrow(CommandRejectedError);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player',
        kind: 'setMayorBuildPolicy',
        payload: { owner: 1, buildPolicy: 'housing' },
      }),
    ).toThrow(CommandRejectedError); // player 1 has no mayor
  });

  it('a housing mayor places houses on zoned land', () => {
    const ctx = setup();
    prepBuildable(ctx);
    const before = ctx.world.city.buildings.length;
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'balanced', buildPolicy: 'housing' } }]);
    runTicks(ctx, MAYOR_BUILD_TICKS + 5);
    const built = ctx.world.city.buildings.slice(before);
    expect(built.length).toBeGreaterThan(0);
    expect(built[0]?.kind).toBe('house');
    expect(built[0]?.owner).toBe(0);
  });

  it('no mayor means no automatic buildings', () => {
    const ctx = setup();
    prepBuildable(ctx);
    const before = ctx.world.city.buildings.length;
    runTicks(ctx, MAYOR_BUILD_TICKS * 2 + 5);
    expect(ctx.world.city.buildings.length).toBe(before);
  });

  it('mayor placements are deterministic (same seed, same buildings)', () => {
    const run = (): string => {
      const ctx = setup(424242);
      prepBuildable(ctx);
      enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'balanced', buildPolicy: 'housing' } }]);
      runTicks(ctx, MAYOR_BUILD_TICKS * 3 + 5);
      return ctx.world.city.buildings
        .map((b) => `${b.kind}@${b.cx},${b.cz}`)
        .sort()
        .join('|');
    };
    expect(run()).toBe(run());
  });

  it('dismissMayor stops the building automation', () => {
    const ctx = setup();
    prepBuildable(ctx);
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'balanced', buildPolicy: 'housing' } }]);
    runTicks(ctx, MAYOR_BUILD_TICKS + 5);
    const countAfterMayor = ctx.world.city.buildings.length;
    expect(countAfterMayor).toBeGreaterThan(0);
    enqueue(ctx, [{ kind: 'dismissMayor', payload: { owner: 0 } }]);
    runTicks(ctx, 2);
    runTicks(ctx, MAYOR_BUILD_TICKS * 2 + 5);
    expect(ctx.world.city.buildings.length).toBe(countAfterMayor);
  });

  it('snapshot round-trip preserves the mayor buildPolicy', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'assignMayor', payload: { owner: 0, policy: 'growth', buildPolicy: 'industry' } }]);
    runTicks(ctx, 5);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(getMayor(restored, 0)?.buildPolicy).toBe('industry');
  });
});
