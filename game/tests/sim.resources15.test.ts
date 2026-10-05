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
 * NOVATERRA — Phase 1.5 resource tests (goods, influence, manpower).
 *
 * Covers:
 *  - Factories produce goods alongside materials.
 *  - Shops consume goods to boost fund output.
 *  - Media Centers generate influence.
 *  - Manpower accrues from population each economy tick.
 *  - Military units cost manpower; spawn is rejected without it.
 *  - Civilian units (engineer, hauler, drone) cost no manpower.
 *  - New resources are in the digest and survive snapshot round-trips.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerUnitCommands, UNIT_DEFS } from '../src/sim/units';
import { getPlayer, BUILDING_DEFS } from '../src/sim/city';
import { runEconomyTick, MANPOWER_PER_POP_PER_SEC } from '../src/sim/economy';
import { generateTerrain } from '../src/sim/terrain';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';

function setup() {
  const terrain = generateTerrain(12345);
  const world = createWorld(12345);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  return { terrain, world, queue };
}

describe('phase 1.5 resources', () => {
  it('factory produces goods alongside materials', () => {
    expect(BUILDING_DEFS.factory.output.goods).toBeGreaterThan(0);
    expect(BUILDING_DEFS.factory.output.materials).toBeGreaterThan(0);
  });

  it('shop consumes goods and produces extra funds', () => {
    expect(BUILDING_DEFS.shop.input.goods).toBeGreaterThan(0);
    // Shop with goods input is more profitable than the old flat output.
    expect(BUILDING_DEFS.shop.output.funds).toBeGreaterThan(1.2);
  });

  it('media center generates influence', () => {
    expect(BUILDING_DEFS.mediaCenter.output.influence).toBeGreaterThan(0);
  });

  it('manpower accrues from population each economy tick', () => {
    const { terrain, world } = setup();
    const player = getPlayer(world.city, 0)!;
    // Place a house directly (bypassing construction) to get population.
    // recountPopulation sums def.population for completed buildings.
    world.city.buildings.push({
      id: 1, kind: 'house', owner: 0, cell: 0, x: 0, z: 0,
      progress: 1, operational: true, powered: true, watered: true,
    } as any);
    player.manpower = 0;
    // Fix 3: occupancy distributes the demand pool — inject it so the
    // house fills (manpower accrues on total population, housed +
    // unhoused, by design).
    player.population = 6;
    const popBefore = player.population;
    runEconomyTick(world, terrain);
    // House gives 6 population; manpower = 6 * 0.02 = 0.12
    expect(player.population).toBe(6);
    expect(player.manpower).toBeCloseTo(6 * MANPOWER_PER_POP_PER_SEC, 6);
  });

  it('military units cost manpower; civilian units are free', () => {
    expect(UNIT_DEFS.rifles.manpowerCost).toBeGreaterThan(0);
    expect(UNIT_DEFS.tank.manpowerCost).toBeGreaterThan(0);
    expect(UNIT_DEFS.engineer.manpowerCost).toBe(0);
    expect(UNIT_DEFS.hauler.manpowerCost).toBe(0);
    expect(UNIT_DEFS.drone.manpowerCost).toBe(0);
  });

  it('spawnUnit rejects military units without manpower', () => {
    const { world, queue } = setup();
    const player = getPlayer(world.city, 0)!;
    player.manpower = 0;
    expect(() =>
      queue.enqueue(world, {
        kind: 'spawnUnit',
        issuer: 'test',
        payload: { kind: 'rifles', owner: 0, x: 0, z: 0 },
      }),
    ).toThrow(/manpower/);
  });

  it('spawnUnit deducts manpower on success', () => {
    const { world, queue } = setup();
    const player = getPlayer(world.city, 0)!;
    player.manpower = 10;
    const before = player.manpower;
    queue.enqueue(world, {
      kind: 'spawnUnit',
      issuer: 'test',
      payload: { kind: 'rifles', owner: 0, x: 0, z: 0 },
    });
    // Apply via applyDue: enqueue validates, applyDue applies at tick 0.
    queue.applyDue(world, 0);
    expect(player.manpower).toBe(before - UNIT_DEFS.rifles.manpowerCost);
  });

  it('new resources appear in the digest', () => {
    const { world } = setup();
    const player = getPlayer(world.city, 0)!;
    player.goods = 42;
    player.influence = 7;
    player.manpower = 13;
    const d1 = digestWorld(world);
    // Change a new resource; digest must change (it's in the canonical encoding).
    player.goods = 43;
    const d2 = digestWorld(world);
    expect(d1).not.toBe(d2);
  });

  it('snapshot round-trips the new resources', () => {
    const { world } = setup();
    const player = getPlayer(world.city, 0)!;
    player.goods = 42;
    player.influence = 7;
    player.manpower = 13;
    const snap = takeSnapshot(world);
    const json = JSON.stringify(snap);
    const restored = restoreSnapshot(JSON.parse(json));
    const rp = getPlayer(restored.city, 0)!;
    expect(rp.goods).toBe(42);
    expect(rp.influence).toBe(7);
    expect(rp.manpower).toBe(13);
  });
});
