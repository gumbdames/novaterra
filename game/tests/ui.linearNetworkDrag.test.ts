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
 * NOVATERRA — linear-network gesture pipeline tests (0.1 Alpha).
 *
 * `ui/linearNetworkDrag.ts` is the one generic drag-paint pipeline shared by
 * the road tool today and power lines / water pipes / rail later (§AD10).
 * These tests pin the pipeline contract:
 *  - tool → kind mapping (`networkKindForTool`)
 *  - cell accumulation: insertion order, dedup, grid-width index math
 *  - gap-filling: `lineCells` is the identity for adjacent cells (so
 *    player-visible behavior matches the old road code) and fills skipped
 *    cells on fast drags
 *  - exactly one outcome per gesture: one order on pointerup, a click falls
 *    through to the click resolver, a cell-less non-click is swallowed
 *  - kind parameter plumbing: the emitted order and click resolution carry
 *    the kind through
 */
import { describe, expect, it } from 'vitest';
import {
  LinearNetworkDrag,
  lineCells,
  networkKindForTool,
  resolveNetworkToolClick,
  type LinearNetworkDragOptions,
} from '../src/ui/linearNetworkDrag';
import { buildRailOrder, buildRoadOrder, buildPowerLineOrder, buildWaterPipeOrder, partitionRoadCells } from '../src/ui/orders';
import { CITY_GRID_CELLS, type RoadCell } from '../src/sim/city';
import type { CellRef } from '../src/ui/placement';

const OWNER = 1;
const GRID = 8; // small test grid; the pipeline takes gridWidth as a parameter

function drag(partial?: Partial<LinearNetworkDragOptions>): LinearNetworkDrag {
  return new LinearNetworkDrag({
    kind: 'road',
    owner: OWNER,
    gridWidth: GRID,
    ...partial,
  });
}

// ---------------------------------------------------------------------------
// Grand-expansion Phase 2: the two utility network kinds ride the same
// gesture pipeline as roads (ui/AGENTS.md "Adding a linear-network kind").
// ---------------------------------------------------------------------------

describe('networkKindForTool (Phase 2 utility tools)', () => {
  it("maps the powerLine tool to the 'powerLine' network kind", () => {
    expect(networkKindForTool('powerLine')).toBe('powerLine');
  });

  it("maps the waterPipe tool to the 'waterPipe' network kind", () => {
    expect(networkKindForTool('waterPipe')).toBe('waterPipe');
  });
});

describe('utility network drags emit the right orders', () => {
  it('a powerLine drag emits a buildPowerLine order', () => {
    const d = drag({ kind: 'powerLine' });
    d.addCell(cell(4, 4));
    d.addCell(cell(5, 4));
    const outcome = d.finish('drag');
    expect(outcome).toEqual({
      action: 'order',
      intent: buildPowerLineOrder(OWNER, [idx(4, 4), idx(5, 4)]),
    });
    if (outcome.action === 'order') {
      expect(outcome.intent.kind).toBe('buildPowerLine');
    }
  });

  it('a waterPipe drag emits a buildPipe order', () => {
    const d = drag({ kind: 'waterPipe' });
    d.addCell(cell(4, 4));
    d.addCell(cell(5, 4));
    const outcome = d.finish('drag');
    expect(outcome).toEqual({
      action: 'order',
      intent: buildWaterPipeOrder(OWNER, [idx(4, 4), idx(5, 4)]),
    });
    if (outcome.action === 'order') {
      expect(outcome.intent.kind).toBe('buildPipe');
    }
  });

  it('utility clicks fall through to click handling with the right kind', () => {
    const d = drag({ kind: 'powerLine' });
    expect(d.finish('click')).toEqual({ action: 'click', kind: 'powerLine', owner: OWNER, roadClass: 'paved' });
    const e = drag({ kind: 'waterPipe' });
    expect(e.finish('click')).toEqual({ action: 'click', kind: 'waterPipe', owner: OWNER, roadClass: 'paved' });
  });

  it('resolves single-cell clicks into the right single-cell orders', () => {
    // The click resolver uses the real city grid (CITY_GRID_CELLS), not the
    // pipeline's test grid — it runs on the controller's picked cell.
    expect(resolveNetworkToolClick('powerLine', OWNER, cell(2, 3))).toEqual({
      kind: 'order',
      intent: buildPowerLineOrder(OWNER, [3 * CITY_GRID_CELLS + 2]),
    });
    expect(resolveNetworkToolClick('waterPipe', OWNER, cell(2, 3))).toEqual({
      kind: 'order',
      intent: buildWaterPipeOrder(OWNER, [3 * CITY_GRID_CELLS + 2]),
    });
  });
});

function cell(cx: number, cz: number): CellRef {
  return { cx, cz };
}

function idx(cx: number, cz: number): number {
  return cz * GRID + cx;
}

describe('networkKindForTool', () => {
  it("maps the road tool to the 'road' network kind", () => {
    expect(networkKindForTool('road')).toBe('road');
  });

  it('returns null for non-network tools', () => {
    expect(networkKindForTool('zoneR')).toBeNull();
    expect(networkKindForTool('zoneC')).toBeNull();
    expect(networkKindForTool('zoneI')).toBeNull();
    expect(networkKindForTool('demolish')).toBeNull();
    expect(networkKindForTool('building:barracks')).toBeNull();
    expect(networkKindForTool('')).toBeNull();
  });
});

describe('lineCells (gap-filling walk)', () => {
  it('a cell walked to itself yields just that cell', () => {
    expect(lineCells(cell(2, 3), cell(2, 3))).toEqual([cell(2, 3)]);
  });

  it('adjacent cells yield exactly the two cells (identity for slow drags)', () => {
    expect(lineCells(cell(1, 1), cell(2, 1))).toEqual([cell(1, 1), cell(2, 1)]);
    expect(lineCells(cell(1, 1), cell(1, 2))).toEqual([cell(1, 1), cell(1, 2)]);
    expect(lineCells(cell(1, 1), cell(2, 2))).toEqual([cell(1, 1), cell(2, 2)]);
  });

  it('fills a horizontal gap on a fast drag', () => {
    expect(lineCells(cell(0, 0), cell(3, 0))).toEqual([
      cell(0, 0),
      cell(1, 0),
      cell(2, 0),
      cell(3, 0),
    ]);
  });

  it('fills a vertical gap on a fast drag', () => {
    expect(lineCells(cell(0, 0), cell(0, 3))).toEqual([
      cell(0, 0),
      cell(0, 1),
      cell(0, 2),
      cell(0, 3),
    ]);
  });

  it('walks diagonals 8-connected with no skipped cells', () => {
    const walk = lineCells(cell(0, 0), cell(3, 3));
    expect(walk[0]).toEqual(cell(0, 0));
    expect(walk[walk.length - 1]).toEqual(cell(3, 3));
    for (let i = 1; i < walk.length; i++) {
      const prev = walk[i - 1]!;
      const cur = walk[i]!;
      expect(Math.abs(cur.cx - prev.cx)).toBeLessThanOrEqual(1);
      expect(Math.abs(cur.cz - prev.cz)).toBeLessThanOrEqual(1);
    }
  });

  it('a steep line stays 8-connected (no holes)', () => {
    const walk = lineCells(cell(0, 0), cell(1, 4));
    for (let i = 1; i < walk.length; i++) {
      const prev = walk[i - 1]!;
      const cur = walk[i]!;
      expect(Math.abs(cur.cx - prev.cx)).toBeLessThanOrEqual(1);
      expect(Math.abs(cur.cz - prev.cz)).toBeLessThanOrEqual(1);
    }
    expect(walk[walk.length - 1]).toEqual(cell(1, 4));
  });

  it('works backwards as well as forwards', () => {
    const fwd = lineCells(cell(0, 0), cell(3, 1));
    const back = lineCells(cell(3, 1), cell(0, 0));
    expect(back).toEqual([...fwd].reverse());
  });
});

describe('LinearNetworkDrag accumulation', () => {
  it('starts active with zero cells', () => {
    const d = drag();
    expect(d.isActive).toBe(true);
    expect(d.cellCount).toBe(0);
  });

  it('accumulates cells in insertion order with the grid-width index math', () => {
    const d = drag();
    d.addCell(cell(1, 0));
    d.addCell(cell(2, 0));
    d.addCell(cell(2, 1));
    const outcome = d.finish('drag');
    expect(outcome.action).toBe('order');
    if (outcome.action !== 'order') return;
    expect(outcome.intent.payload).toMatchObject({
      owner: OWNER,
      cells: [idx(1, 0), idx(2, 0), idx(2, 1)],
    });
  });

  it('deduplicates revisited cells (matches the old road code)', () => {
    const d = drag();
    d.addCell(cell(1, 1));
    d.addCell(cell(1, 1));
    d.addCell(cell(2, 1));
    d.addCell(cell(1, 1));
    const outcome = d.finish('drag');
    expect(outcome.action).toBe('order');
    if (outcome.action !== 'order') return;
    expect(outcome.intent.payload).toMatchObject({
      cells: [idx(1, 1), idx(2, 1)],
    });
  });

  it('matches the old accumulation for a slow adjacent-cell drag (no extra cells)', () => {
    // The old road code added exactly the pointer cell per move; for an
    // adjacent-cell walk the gap-filler must add nothing extra.
    const d = drag();
    const path = [cell(0, 0), cell(1, 0), cell(2, 0), cell(2, 1), cell(2, 2)];
    for (const c of path) d.addCell(c);
    const outcome = d.finish('drag');
    expect(outcome.action).toBe('order');
    if (outcome.action !== 'order') return;
    expect(outcome.intent.payload).toMatchObject({
      cells: path.map((c) => idx(c.cx, c.cz)),
    });
  });

  it('fills holes on a fast drag that skips cells', () => {
    const d = drag();
    d.addCell(cell(0, 0));
    d.addCell(cell(3, 0)); // pointer jumped: the old code left 1,2 unpaved
    const outcome = d.finish('drag');
    expect(outcome.action).toBe('order');
    if (outcome.action !== 'order') return;
    expect(outcome.intent.payload).toMatchObject({
      cells: [idx(0, 0), idx(1, 0), idx(2, 0), idx(3, 0)],
    });
  });

  it('ignores addCell after finish', () => {
    const d = drag();
    d.addCell(cell(0, 0));
    expect(d.finish('drag').action).toBe('order');
    d.addCell(cell(5, 5));
    expect(d.isActive).toBe(false);
    expect(d.cellCount).toBe(0);
    expect(d.finish('drag')).toEqual({ action: 'none' });
  });
});

describe('LinearNetworkDrag finish (single-outcome emission)', () => {
  it('emits exactly one buildRoad order carrying kind + owner + cells', () => {
    const d = drag();
    d.addCell(cell(4, 4));
    d.addCell(cell(5, 4));
    const outcome = d.finish('drag');
    expect(outcome).toEqual({
      action: 'order',
      intent: buildRoadOrder(OWNER, [idx(4, 4), idx(5, 4)]),
    });
    if (outcome.action === 'order') {
      expect(outcome.intent.kind).toBe('buildRoad');
    }
  });

  it('a click with zero cells falls through to click handling (no order)', () => {
    const d = drag();
    const outcome = d.finish('click');
    expect(outcome).toEqual({ action: 'click', kind: 'road', owner: OWNER, roadClass: 'paved' });
  });

  it('a drag with zero cells (e.g. over sky/off-grid) is swallowed, not clicked', () => {
    const d = drag();
    expect(d.finish('drag')).toEqual({ action: 'none' });
  });

  it('an ignored gesture with zero cells emits nothing', () => {
    const d = drag();
    expect(d.finish('ignore')).toEqual({ action: 'none' });
  });

  it('cells painted always emit the order, even when the gesture was a click', () => {
    // Matches the old controller: cells.length > 0 wins over the gesture class.
    const d = drag();
    d.addCell(cell(0, 0));
    const outcome = d.finish('click');
    expect(outcome.action).toBe('order');
  });

  it('finish consumes the cells: a second finish can never emit another order', () => {
    const d = drag();
    d.addCell(cell(0, 0));
    const first = d.finish('drag');
    expect(first.action).toBe('order');
    // No second order is possible; a later click gesture on the spent drag
    // still resolves as a click (zero cells + click), never as an order.
    expect(d.finish('drag')).toEqual({ action: 'none' });
    expect(d.finish('click')).toEqual({
      action: 'click',
      kind: 'road',
      owner: OWNER,
      roadClass: 'paved',
    });
  });

  it('plumbs the owner into the order payload', () => {
    const d = drag({ owner: 7 });
    d.addCell(cell(0, 0));
    const outcome = d.finish('drag');
    expect(outcome.action).toBe('order');
    if (outcome.action !== 'order') return;
    expect(outcome.intent.payload).toMatchObject({ owner: 7 });
  });
});

describe('resolveNetworkToolClick', () => {
  it("a road click resolves to a single-cell buildRoad order (the kind's click behavior)", () => {
    // The click resolver uses the real city grid (CITY_GRID_CELLS), not the
    // pipeline's test grid — it runs on the controller's picked cell.
    const res = resolveNetworkToolClick('road', OWNER, cell(2, 2));
    expect(res).toEqual({
      kind: 'order',
      intent: buildRoadOrder(OWNER, [2 * CITY_GRID_CELLS + 2]),
    });
  });

  it('an off-grid click resolves to a hint, never a silent no-op', () => {
    const res = resolveNetworkToolClick('road', OWNER, null);
    expect(res.kind).toBe('hint');
    if (res.kind !== 'hint') return;
    expect(res.message.length).toBeGreaterThan(0);
  });
});

describe('Phase 4: rail drag (item 1)', () => {
  it("networkKindForTool maps the 'rail' tool to the rail kind", () => {
    expect(networkKindForTool('rail')).toBe('rail');
  });

  it('a rail drag emits a single buildRail order on pointerup', () => {
    const d = drag({ kind: 'rail' });
    d.addCell(cell(0, 0));
    d.addCell(cell(1, 0));
    d.addCell(cell(2, 0));
    const outcome = d.finish('drag');
    expect(outcome.action).toBe('order');
    if (outcome.action !== 'order') return;
    const expected = buildRailOrder(OWNER, [
      0 * GRID + 0,
      0 * GRID + 1,
      0 * GRID + 2,
    ]);
    expect(outcome.intent).toEqual(expected);
  });

  it('a rail click resolves to a single-cell buildRail order', () => {
    const res = resolveNetworkToolClick('rail', OWNER, cell(3, 3));
    expect(res).toEqual({
      kind: 'order',
      intent: buildRailOrder(OWNER, [3 * CITY_GRID_CELLS + 3]),
    });
  });

  it('a rail click with no road class still resolves (rail has no class selector)', () => {
    const res = resolveNetworkToolClick('rail', OWNER, cell(1, 1), 'paved');
    expect(res).toEqual({
      kind: 'order',
      intent: buildRailOrder(OWNER, [1 * CITY_GRID_CELLS + 1]),
    });
  });
});

describe('Phase 4: road-class partition (item 2)', () => {
  // The sim rejects a whole buildRoad batch when ANY cell already has a
  // road, so the controller splits a mixed drag into build + upgrade
  // orders (and drops cells already at-or-above the target class).
  function roadsOf(entries: Array<[number, RoadCell['cls']]>): RoadCell[] {
    return entries.map(([cell, cls]) => ({ cell, cls }));
  }

  it('fresh cells go to build, existing lower-class cells go to upgrade', () => {
    const roads = roadsOf([
      [2, 'dirt'],
      [3, 'country'],
    ]);
    const res = partitionRoadCells(roads, [1, 2, 3, 4], 'paved');
    expect(res.build).toEqual([1, 4]);
    expect(res.upgrade).toEqual([2, 3]);
    expect(res.skipped).toBe(0);
  });

  it('cells already at or above the target class are skipped, never re-sent', () => {
    const roads = roadsOf([
      [1, 'paved'],
      [2, 'highway'],
    ]);
    const res = partitionRoadCells(roads, [1, 2, 3], 'paved');
    expect(res.build).toEqual([3]);
    expect(res.upgrade).toEqual([]);
    expect(res.skipped).toBe(2);
  });

  it('an empty drag partitions to empty lists (no orders)', () => {
    const res = partitionRoadCells([], [], 'dirt');
    expect(res).toEqual({ build: [], upgrade: [], skipped: 0 });
  });

  it('a drag over only fresh cells is a pure build with no upgrade order', () => {
    const res = partitionRoadCells([], [5, 6, 7], 'country');
    expect(res.build).toEqual([5, 6, 7]);
    expect(res.upgrade).toEqual([]);
    expect(res.skipped).toBe(0);
  });
});
