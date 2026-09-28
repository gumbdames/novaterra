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
 * NOVATERRA — order builder tests (Phase 1, step 9).
 *
 * Every player gesture becomes a sim command through ui/orders.ts. These
 * tests pin the command kind + payload shapes so the UI and the sim's
 * validation specs cannot drift apart. The builders return intents without
 * an issuer; the game controller attaches `issuer: 'player'` at enqueue.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAdvanceAgeOrder,
  buildAttackOrders,
  buildDemolishOrder,
  buildMoveOrder,
  buildPlaceBuildingOrder,
  buildRoadOrder,
  buildSetTaxRateOrder,
  buildStopOrders,
  buildTrainOrder,
  buildZoneOrder,
} from '../src/ui/orders';

describe('order builders', () => {
  it('single unit move → moveUnit', () => {
    const cmd = buildMoveOrder([7], 0, 10, 20);
    expect(cmd.kind).toBe('moveUnit');
    expect(cmd.payload).toEqual({ unitId: 7, owner: 0, x: 10, z: 20 });
    expect('issuer' in cmd).toBe(false);
  });

  it('multi-unit move → moveGroup with copied ids', () => {
    const ids = [7, 8];
    const cmd = buildMoveOrder(ids, 0, 10, 20);
    expect(cmd.kind).toBe('moveGroup');
    expect(cmd.payload).toEqual({ unitIds: [7, 8], owner: 0, x: 10, z: 20 });
    // Mutating the input afterwards must not affect the command.
    ids.push(9);
    expect((cmd.payload as { unitIds: number[] }).unitIds).toEqual([7, 8]);
  });

  it('attack → one attackUnit per unit', () => {
    const cmds = buildAttackOrders([7, 8], 0, 99);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toEqual({
      kind: 'attackUnit',
      payload: { unitId: 7, targetId: 99, owner: 0 },
    });
    expect(cmds[1]?.payload).toEqual({ unitId: 8, targetId: 99, owner: 0 });
  });

  it('stop → one stopUnit per unit', () => {
    const cmds = buildStopOrders([7, 8], 0);
    expect(cmds).toEqual([
      { kind: 'stopUnit', payload: { unitId: 7, owner: 0 } },
      { kind: 'stopUnit', payload: { unitId: 8, owner: 0 } },
    ]);
  });

  it('train → spawnUnit', () => {
    expect(buildTrainOrder('tank', 0, 10, 20)).toEqual({
      kind: 'spawnUnit',
      payload: { kind: 'tank', owner: 0, x: 10, z: 20 },
    });
  });

  it('road → buildRoad with copied cells', () => {
    const cells = [1, 2, 3];
    const cmd = buildRoadOrder(0, cells);
    expect(cmd.kind).toBe('buildRoad');
    expect(cmd.payload).toEqual({ owner: 0, cells: [1, 2, 3] });
    cells.push(4);
    expect((cmd.payload as { cells: number[] }).cells).toEqual([1, 2, 3]);
  });

  it('zone → paintZone with zone code and rect', () => {
    expect(buildZoneOrder(0, 1, 0, 0, 4, 4)).toEqual({
      kind: 'paintZone',
      payload: { owner: 0, zone: 1, x0: 0, z0: 0, x1: 4, z1: 4 },
    });
  });

  it('building → placeBuilding', () => {
    expect(buildPlaceBuildingOrder('powerPlant', 0, 10, 12)).toEqual({
      kind: 'placeBuilding',
      payload: { kind: 'powerPlant', owner: 0, cx: 10, cz: 12 },
    });
  });

  it('demolish → demolish', () => {
    expect(buildDemolishOrder(0, 10, 12)).toEqual({
      kind: 'demolish',
      payload: { owner: 0, cx: 10, cz: 12 },
    });
  });

  it('advanceAge → advanceAge with program', () => {
    expect(buildAdvanceAgeOrder(0, 'fiberGrid')).toEqual({
      kind: 'advanceAge',
      payload: { owner: 0, program: 'fiberGrid' },
    });
  });

  it('setTaxRate → setTaxRate', () => {
    expect(buildSetTaxRateOrder(0, 2, 0.15)).toEqual({
      kind: 'setTaxRate',
      payload: { owner: 0, zone: 2, rate: 0.15 },
    });
  });
});
