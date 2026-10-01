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
 * NOVATERRA — advisor tests (Phase 1, step 9).
 *
 * The advisor is a pure function of (world, playerId): given a situation
 * it must surface the worst problems first. Tests poke world state
 * directly (funds, food flag, unit hp) and assert the prioritized output.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { getPlayer, placeBuilding, BUILDING_DEFS } from '../src/sim/city';
import { spawnUnit } from '../src/sim/units';
import {
  ADVISOR_DAMAGED_FRACTION,
  ADVISOR_FUNDS_CRITICAL,
  ADVISOR_MATERIALS_LOW,
  evaluateAdvisor,
} from '../src/ui/advisor';
import { CONNECTIVITY_COST , getAgeState } from '../src/sim/ages';
import { UNIT_DEFS } from '../src/sim/units';
import { STRINGS } from '../src/ui/strings';

function setup(): World {
  const world = createWorld(20260928);
  // Fresh worlds start rich enough to afford the age advance; keep funds
  // below the age cost so "all clear" really means all clear.
  setFunds(world, CONNECTIVITY_COST.funds - 1);
  return world;
}

function setFunds(world: World, funds: number): void {
  getPlayer(world.city, 0)!.funds = funds;
}

describe('advisor', () => {
  it('reports all clear on a healthy fresh world', () => {
    const items = evaluateAdvisor(setup(), 0);
    expect(items).toEqual([]);
  });

  it('flags critical funds below the threshold', () => {
    const world = setup();
    setFunds(world, ADVISOR_FUNDS_CRITICAL - 1);
    const items = evaluateAdvisor(world, 0);
    expect(items[0]?.severity).toBe('critical');
    expect(items[0]?.title.length).toBeGreaterThan(0);
    expect(items[0]?.detail.length).toBeGreaterThan(0);
  });

  it('flags low materials as a warning', () => {
    const world = setup();
    getPlayer(world.city, 0)!.materials = ADVISOR_MATERIALS_LOW - 1;
    const items = evaluateAdvisor(world, 0);
    expect(items.some((i) => i.severity === 'warning' && i.title.length > 0)).toBe(true);
  });

  it('flags food shortage as critical', () => {
    const world = setup();
    world.city.foodShortage = true;
    const items = evaluateAdvisor(world, 0);
    expect(items.some((i) => i.severity === 'critical')).toBe(true);
  });

  it('flags damaged units as a warning', () => {
    const world = setup();
    const u = spawnUnit(world, 'tank', 0, 10, 10);
    u.hp = Math.floor(UNIT_DEFS.tank.hp * (ADVISOR_DAMAGED_FRACTION - 0.1));
    const items = evaluateAdvisor(world, 0);
    const damaged = items.find((i) => i.severity === 'warning');
    expect(damaged).toBeDefined();
    expect(damaged?.detail).toContain('1');
  });

  it('never warns about missing engineers (A9: the trigger was false advice)', () => {
    const world = createWorld(20260928); // no engineer — must stay silent
    const items = evaluateAdvisor(world, 0);
    expect(items.some((i) => i.title.toLowerCase().includes('engineer'))).toBe(false);
  });

  it('suggests the age advance as info when affordable', () => {
    const world = setup();
    setFunds(world, CONNECTIVITY_COST.funds + 100);
    getPlayer(world.city, 0)!.materials = CONNECTIVITY_COST.materials + 100;
    const items = evaluateAdvisor(world, 0);
    const info = items.find((i) => i.severity === 'info');
    expect(info).toBeDefined();
  });

  it('does not suggest the age advance once in Connectivity', () => {
    const world = setup();
    getAgeState(world, 0).age = 'connectivity';
    getAgeState(world, 0).program = 'fiberGrid';
    setFunds(world, CONNECTIVITY_COST.funds + 100);
    const items = evaluateAdvisor(world, 0);
    expect(items.some((i) => i.severity === 'info')).toBe(false);
  });

  it('sorts worst-first: critical before warning before info', () => {
    const world = setup();
    // Age affordable → info, but food shortage → critical on top.
    setFunds(world, CONNECTIVITY_COST.funds + 50);
    getPlayer(world.city, 0)!.materials = CONNECTIVITY_COST.materials + 50;
    world.city.foodShortage = true; // critical
    const items = evaluateAdvisor(world, 0);
    const ranks = items.map((i) => (i.severity === 'critical' ? 0 : i.severity === 'warning' ? 1 : 2));
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
    expect(items[0]?.severity).toBe('critical');
    expect(items[items.length - 1]?.severity).toBe('info');
  });

  it('ignores the other player completely', () => {
    const world = setup();
    const enemy = spawnUnit(world, 'tank', 1, -50, -50);
    enemy.hp = 1; // damaged — but not the human's problem
    getPlayer(world.city, 1)!.funds = 0;
    const items = evaluateAdvisor(world, 0);
    expect(items.some((i) => i.title.toLowerCase().includes('damage'))).toBe(false);
  });

  it('returns nothing for an unknown player', () => {
    expect(evaluateAdvisor(setup(), 999)).toEqual([]);
  });

  it('flags unpowered buildings as a warning (tutorial A3)', () => {
    const world = setup();
    const b = placeBuilding(world.city, { kind: 'house', owner: 0, cx: 5, cz: 5, facing: 0 });
    b.operational = true;
    b.powerDiag = 'disconnected';
    b.waterDiag = 'ok';
    const items = evaluateAdvisor(world, 0);
    const warn = items.find((i) => i.title.toLowerCase().includes('power'));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
    expect(warn?.detail).toContain('1');
  });

  it('flags unwatered buildings as a warning (tutorial A3)', () => {
    const world = setup();
    const b = placeBuilding(world.city, { kind: 'house', owner: 0, cx: 5, cz: 5, facing: 0 });
    b.operational = true;
    b.powerDiag = 'ok';
    b.waterDiag = 'shortage';
    const items = evaluateAdvisor(world, 0);
    const warn = items.find((i) => i.title.toLowerCase().includes('water'));
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('warning');
  });

  it('does not flag buildings under construction for utilities', () => {
    const world = setup();
    const b = placeBuilding(world.city, { kind: 'house', owner: 0, cx: 5, cz: 5, facing: 0 });
    // Still under construction: not operational, diags at bootstrap defaults.
    b.powerDiag = 'disconnected';
    b.waterDiag = 'disconnected';
    const items = evaluateAdvisor(world, 0);
    expect(items.some((i) => i.title.toLowerCase().includes('power'))).toBe(false);
    expect(items.some((i) => i.title.toLowerCase().includes('water'))).toBe(false);
  });

  // Roadmap A9 (2026-10-01): the advisor must never recommend buildings
  // that do not exist or roles units do not have.
  it('names only real material producers when materials run low', () => {
    const world = setup();
    getPlayer(world.city, 0)!.materials = ADVISOR_MATERIALS_LOW - 1;
    const items = evaluateAdvisor(world, 0);
    const warn = items.find((i) => i.severity === 'warning');
    expect(warn).toBeDefined();
    expect(warn!.detail.toLowerCase()).not.toContain('warehouse');
    // Every producer the advice names exists and really outputs materials.
    expect(BUILDING_DEFS.factory).toBeDefined();
    expect(BUILDING_DEFS.quarry).toBeDefined();
    const out = (k: 'factory' | 'quarry') =>
      (BUILDING_DEFS[k].output as unknown as Record<string, number>).materials ?? 0;
    expect(out('factory')).toBeGreaterThan(0);
    expect(out('quarry')).toBeGreaterThan(0);
  });

  it('never mentions warehouses in any advisor state', () => {
    // Trigger every advice branch, then sweep all copy for the A9
    // falsehood class (nonexistent buildings).
    const world = setup();
    setFunds(world, ADVISOR_FUNDS_CRITICAL - 1);
    getPlayer(world.city, 0)!.materials = ADVISOR_MATERIALS_LOW - 1;
    world.city.foodShortage = true;
    const u = spawnUnit(world, 'tank', 0, 10, 10);
    u.hp = 1;
    const b = placeBuilding(world.city, { kind: 'house', owner: 0, cx: 5, cz: 5, facing: 0 });
    b.operational = true;
    b.powerDiag = 'disconnected';
    b.waterDiag = 'shortage';
    setFunds(world, CONNECTIVITY_COST.funds + 100);
    getPlayer(world.city, 0)!.materials = CONNECTIVITY_COST.materials + 100;
    const items = evaluateAdvisor(world, 0);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(`${item.title} ${item.detail}`.toLowerCase()).not.toContain('warehouse');
    }
  });

  it('has no engineer-construction copy left in the advisor strings', () => {
    expect(STRINGS.advisor).not.toHaveProperty('noEngineers');
    expect(STRINGS.advisor).not.toHaveProperty('noEngineersDetail');
    for (const value of Object.values(STRINGS.advisor)) {
      expect(String(value).toLowerCase()).not.toContain('engineers to build');
    }
  });
});
