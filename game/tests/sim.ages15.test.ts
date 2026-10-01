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
 * NOVATERRA — Phase 1.5 Ages 3-5 tests.
 *
 * Covers:
 *  - Industry age: advancement cost, Heavy Industry vs Green Tech programs.
 *  - Information age: advancement cost, Cyber Command vs Global Media.
 *  - Ascendance age: advancement cost, Arsenal vs Prosperity programs.
 *  - Program effects: factory output, upkeep, utility demand, influence,
 *    spectre damage, manpower costs, military damage, tax multipliers.
 *  - Age gating: units/buildings require minimum age.
 *  - Full chain: Foundation → Connectivity → Industry → Information → Ascendance.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerAgeCommands, AGE_PROGRESSION, getAgeState, getFactoryOutputMult, getUpkeepMult, getUtilityDemandMult, getInfluenceMult, getSpectreDamageMult, getManpowerCostMult, getMilitaryDamageMult, getGoodsOutputMult, getTaxMultiplierFull, isUnitAvailableForAge, AGE_ORDER } from '../src/sim/ages';
import { getPlayer } from '../src/sim/city';

function setup() {
  const world = createWorld(99999);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerAgeCommands(queue);
  return { world, queue };
}

function fundPlayer(world: any, funds: number, materials: number, influence: number) {
  const p = getPlayer(world.city, 0)!;
  p.funds = funds;
  p.materials = materials;
  p.influence = influence;
}

function advance(world: any, queue: any, program: string) {
  queue.enqueue(world, {
    kind: 'advanceAge',
    issuer: 'test',
    payload: { owner: 0, program },
  });
  queue.applyDue(world, 0);
}

describe('phase 1.5 ages 3-5', () => {
  it('age progression table has the full chain', () => {
    expect(AGE_ORDER).toEqual(['foundation', 'connectivity', 'industry', 'information', 'ascendance']);
    expect(AGE_PROGRESSION.foundation.next).toBe('connectivity');
    expect(AGE_PROGRESSION.connectivity.next).toBe('industry');
    expect(AGE_PROGRESSION.industry.next).toBe('information');
    expect(AGE_PROGRESSION.information.next).toBe('ascendance');
    expect(AGE_PROGRESSION.ascendance.next).toBeNull();
  });

  it('Industry programs are heavyIndustry and greenTech', () => {
    expect(AGE_PROGRESSION.connectivity.programs).toContain('heavyIndustry');
    expect(AGE_PROGRESSION.connectivity.programs).toContain('greenTech');
  });

  it('Information programs are cyberCommand and globalMedia', () => {
    expect(AGE_PROGRESSION.industry.programs).toContain('cyberCommand');
    expect(AGE_PROGRESSION.industry.programs).toContain('globalMedia');
  });

  it('Ascendance programs are arsenalProgram and prosperityProgram', () => {
    expect(AGE_PROGRESSION.information.programs).toContain('arsenalProgram');
    expect(AGE_PROGRESSION.information.programs).toContain('prosperityProgram');
  });

  it('can advance through the full chain', () => {
    const { world, queue } = setup();
    // Foundation → Connectivity
    fundPlayer(world, 10000, 5000, 0);
    advance(world, queue, 'fiberGrid');
    expect(getAgeState(world, 0).age).toBe('connectivity');
    // Connectivity → Industry (needs influence)
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'heavyIndustry');
    expect(getAgeState(world, 0).age).toBe('industry');
    expect(getAgeState(world, 0).program).toBe('heavyIndustry');
    // Industry → Information
    fundPlayer(world, 20000, 10000, 1000);
    advance(world, queue, 'cyberCommand');
    expect(getAgeState(world, 0).age).toBe('information');
    // Information → Ascendance
    fundPlayer(world, 50000, 20000, 2000);
    advance(world, queue, 'arsenalProgram');
    expect(getAgeState(world, 0).age).toBe('ascendance');
    expect(getAgeState(world, 0).program).toBe('arsenalProgram');
  });

  it('cannot advance without enough influence', () => {
    const { world, queue } = setup();
    fundPlayer(world, 10000, 5000, 0);
    advance(world, queue, 'fiberGrid');
    // Try Industry without influence
    fundPlayer(world, 10000, 5000, 0);
    expect(() =>
      queue.enqueue(world, {
        kind: 'advanceAge',
        issuer: 'test',
        payload: { owner: 0, program: 'heavyIndustry' },
      }),
    ).toThrow(/influence/);
  });

  it('Heavy Industry boosts factory output and upkeep', () => {
    const { world, queue } = setup();
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'fiberGrid');
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'heavyIndustry');
    expect(getFactoryOutputMult(world, 0)).toBe(1.5);
    expect(getUpkeepMult(world, 0)).toBe(1.25);
  });

  it('Green Tech reduces utility demand and boosts influence', () => {
    const { world, queue } = setup();
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'signalsGrid');
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'greenTech');
    expect(getUtilityDemandMult(world, 0)).toBe(0.7);
    expect(getInfluenceMult(world, 0)).toBe(1.5);
  });

  it('Global Media doubles influence (stacks with Green Tech)', () => {
    const { world, queue } = setup();
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'fiberGrid');
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'greenTech');
    fundPlayer(world, 20000, 10000, 1000);
    advance(world, queue, 'globalMedia');
    // 1.5 (Green Tech) * 2.0 (Global Media) = 3.0
    expect(getInfluenceMult(world, 0)).toBe(3.0);
  });

  it('Cyber Command boosts spectre damage', () => {
    const { world, queue } = setup();
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'fiberGrid');
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'heavyIndustry');
    fundPlayer(world, 20000, 10000, 1000);
    advance(world, queue, 'cyberCommand');
    expect(getSpectreDamageMult(world, 0)).toBe(1.5);
  });

  it('Arsenal Program reduces manpower costs and boosts damage', () => {
    const { world, queue } = setup();
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'fiberGrid');
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'heavyIndustry');
    fundPlayer(world, 20000, 10000, 1000);
    advance(world, queue, 'cyberCommand');
    fundPlayer(world, 50000, 20000, 2000);
    advance(world, queue, 'arsenalProgram');
    expect(getManpowerCostMult(world, 0)).toBe(0.7);
    expect(getMilitaryDamageMult(world, 0)).toBe(1.25);
  });

  it('Prosperity Program boosts taxes and goods', () => {
    const { world, queue } = setup();
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'fiberGrid'); // 1.25x tax
    fundPlayer(world, 10000, 5000, 500);
    advance(world, queue, 'heavyIndustry');
    fundPlayer(world, 20000, 10000, 1000);
    advance(world, queue, 'globalMedia');
    fundPlayer(world, 50000, 20000, 2000);
    advance(world, queue, 'prosperityProgram');
    // 1.25 (Fiber) * 1.5 (Prosperity) = 1.875
    expect(getTaxMultiplierFull(world, 0)).toBeCloseTo(1.875, 6);
    expect(getGoodsOutputMult(world, 0)).toBe(1.5);
  });

  it('age gating: later ages unlock earlier content', () => {
    const { world } = setup();
    // Foundation: only foundation units
    expect(isUnitAvailableForAge(world, 0, 'foundation')).toBe(true);
    expect(isUnitAvailableForAge(world, 0, 'connectivity')).toBe(false);
    expect(isUnitAvailableForAge(world, 0, 'industry')).toBe(false);
    // Advance to Ascendance
    getAgeState(world, 0).age = 'ascendance';
    expect(isUnitAvailableForAge(world, 0, 'foundation')).toBe(true);
    expect(isUnitAvailableForAge(world, 0, 'connectivity')).toBe(true);
    expect(isUnitAvailableForAge(world, 0, 'industry')).toBe(true);
    expect(isUnitAvailableForAge(world, 0, 'information')).toBe(true);
    expect(isUnitAvailableForAge(world, 0, 'ascendance')).toBe(true);
  });

  it('cannot advance past Ascendance', () => {
    const { world, queue } = setup();
    getAgeState(world, 0).age = 'ascendance';
    getAgeState(world, 0).program = 'arsenalProgram';
    expect(() =>
      queue.enqueue(world, {
        kind: 'advanceAge',
        issuer: 'test',
        payload: { owner: 0, program: 'whatever' },
      }),
    ).toThrow(/cannot advance further/);
  });
});
