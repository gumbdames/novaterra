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
 * NOVATERRA — ui/linearNetworkDrag.ts — generic linear-network gesture pipeline (pure).
 *
 * One drag-paint pipeline shared by every linear network tool: today the road
 * tool, tomorrow power lines, water pipes (Phase 2) and rail (Phase 4)
 * (§AD10). The network kind is a parameter — never copy this file per kind.
 *
 * Contract (controller wiring, see game.ts `bindInput`):
 *   pointerdown → `new LinearNetworkDrag({ kind, owner, gridWidth })`
 *     (construction starts the drag; the press cell itself is NOT seeded —
 *     same as the old road code, so a plain click still releases with zero
 *     cells and falls through to the click resolver)
 *   pointermove → `addCell(cell)` for the cell under the pointer
 *   pointerup   → `finish(gesture)` emits exactly one outcome:
 *     - { action: 'order', intent } when ≥1 cell was painted (exactly one
 *       order per gesture — finish consumes the cells, so a second finish
 *       can never double-emit)
 *     - { action: 'click', kind, owner } when nothing was painted and the
 *       gesture classified as a click — the caller resolves the release
 *       cell via `resolveNetworkToolClick` (order or human-readable hint;
 *       nothing fails silently)
 *     - { action: 'none' } when nothing was painted and it wasn't a click
 *       (e.g. a drag over sky/off-grid cells) — the gesture is swallowed
 *
 * Click-vs-drag classification is NOT done here: the caller passes the
 * `PointerUpClass` from `ui/pointer.ts` (the press-anchored ≤6px click rule)
 * and the pipeline trusts it.
 *
 * Gap-filling: the old road code added ONLY the exact cell under the pointer
 * on each pointermove — no interpolation — so fast drags left holes in the
 * road. The pipeline deliberately improves this: `addCell` walks an
 * 8-connected line (`lineCells`) from the previous cell to the new one.
 * For normal-speed drags the walk is the identity (adjacent cells add
 * exactly the same single cell as the old code); for fast drags it fills
 * the skipped cells. The old accumulation order + dedup semantics are
 * otherwise unchanged, so player-visible behavior is identical except that
 * holes disappear.
 *
 * Adding a network kind (Phase 2/4):
 *   1. Extend `LinearNetworkKind` ('powerLine' | 'waterPipe' | 'rail').
 *   2. Add the order builder in ui/orders.ts and wire it into the
 *      `buildNetworkOrder` switch below.
 *   3. Map the kind to its build tool in the `toolForKind` switch below
 *      (used for the click resolver).
 *   4. Extend `networkKindForTool` with the new build-tool string.
 *   5. Add unit tests here (accumulation, gap-fill, order payload, click).
 * The two switches are exhaustive over `LinearNetworkKind` with no default
 * arm — compiling after step 1 fails until steps 2–3 are done, so a new kind
 * can never silently fall through.
 *
 * Headless-safe: no DOM, no three.js. Fully unit-tested.
 */

import { buildRoadOrder, buildPowerLineOrder, buildWaterPipeOrder, type OrderIntent } from './orders';
import {
  resolveBuildToolClick,
  type CellRef,
  type PlacementResolution,
} from './placement';
import type { PointerUpClass } from './pointer';
import type { BuildTool } from './hud';

/**
 * Linear network kinds that share the drag-paint gesture. Phase 2 adds
 * 'powerLine' | 'waterPipe'; Phase 4 adds 'rail'.
 */
export type LinearNetworkKind = 'road' | 'powerLine' | 'waterPipe';

export interface LinearNetworkDragOptions {
  /** Which network is being painted. */
  kind: LinearNetworkKind;
  /** Sim owner id stamped on the emitted order. */
  owner: number;
  /**
   * City grid width in cells (CITY_GRID_CELLS). Passed in so this module
   * stays decoupled from sim constants and is trivially testable on a
   * small grid.
   */
  gridWidth: number;
}

/**
 * What a finished linear-network gesture becomes. The controller acts on
 * exactly one of these per gesture.
 */
export type LinearNetworkDragOutcome =
  /** ≥1 cell painted: enqueue this intent (and play the place SFX). */
  | { action: 'order'; intent: OrderIntent }
  /**
   * Nothing painted, gesture was a click: resolve the release cell with
   * `resolveNetworkToolClick` (order or hint — never silent).
   */
  | { action: 'click'; kind: LinearNetworkKind; owner: number }
  /** Nothing painted, not a click: swallow the gesture. */
  | { action: 'none' };

/**
 * Map a build tool to the network kind it paints, or null for non-network
 * tools (zones, buildings, demolish). The controller calls this on
 * pointerdown to decide whether a press starts a network drag.
 */
export function networkKindForTool(tool: string): LinearNetworkKind | null {
  if (tool === 'road') return 'road';
  if (tool === 'powerLine') return 'powerLine';
  if (tool === 'waterPipe') return 'waterPipe';
  return null;
}

/** Map a network kind to its build-tool string (for the click resolver). */
function toolForKind(kind: LinearNetworkKind): BuildTool {
  switch (kind) {
    case 'road':
      return 'road';
    case 'powerLine':
      return 'powerLine';
    case 'waterPipe':
      return 'waterPipe';
    default: {
      // Exhaustive: adding a LinearNetworkKind forces a mapping here.
      const _exhaustive: never = kind;
      throw new Error(
        `[linearNetworkDrag] no build tool for network kind: ${String(_exhaustive)}`,
      );
    }
  }
}

/** Build the single order payload for a finished drag. */
function buildNetworkOrder(
  kind: LinearNetworkKind,
  owner: number,
  cells: number[],
): OrderIntent {
  switch (kind) {
    case 'road':
      return buildRoadOrder(owner, cells);
    case 'powerLine':
      return buildPowerLineOrder(owner, cells);
    case 'waterPipe':
      return buildWaterPipeOrder(owner, cells);
    default: {
      // Exhaustive: adding a LinearNetworkKind forces an order builder here.
      const _exhaustive: never = kind;
      throw new Error(
        `[linearNetworkDrag] no order builder for network kind: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Resolve a plain click with a network tool active (the drag painted zero
 * cells). Delegates to the placement resolver so the click either paves the
 * single clicked cell or toasts a human-readable hint — nothing fails
 * silently. `cell` is null when the pick missed the city grid.
 */
export function resolveNetworkToolClick(
  kind: LinearNetworkKind,
  owner: number,
  cell: CellRef | null,
): PlacementResolution {
  return resolveBuildToolClick(toolForKind(kind), owner, cell);
}

/**
 * 8-connected walk of city cells from `from` to `to` (inclusive). Consecutive
 * cells differ by at most 1 in each axis, so no cell on the straight path is
 * skipped; adjacent (or identical) inputs yield exactly `[from, to]` (or
 * `[from]`), making gap-filling the identity for normal-speed drags.
 */
export function lineCells(from: CellRef, to: CellRef): CellRef[] {
  const dx = to.cx - from.cx;
  const dz = to.cz - from.cz;
  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  if (steps === 0) return [{ cx: from.cx, cz: from.cz }];
  const out: CellRef[] = [];
  for (let i = 0; i <= steps; i++) {
    const cx = from.cx + Math.round((dx * i) / steps);
    const cz = from.cz + Math.round((dz * i) / steps);
    const last = out[out.length - 1];
    if (!last || last.cx !== cx || last.cz !== cz) out.push({ cx, cz });
  }
  return out;
}

/**
 * One in-progress linear-network drag gesture. Construct on pointerdown,
 * feed `addCell` on pointermove, call `finish` once on pointerup.
 */
export class LinearNetworkDrag {
  private readonly kind: LinearNetworkKind;
  private readonly owner: number;
  private readonly gridWidth: number;
  /** Accumulated cell indices, insertion-ordered, deduplicated. */
  private cells: number[] = [];
  private readonly seen = new Set<number>();
  private lastCell: CellRef | null = null;
  private active = true;

  constructor(opts: LinearNetworkDragOptions) {
    this.kind = opts.kind;
    this.owner = opts.owner;
    this.gridWidth = opts.gridWidth;
  }

  /** True between construction and `finish`. */
  get isActive(): boolean {
    return this.active;
  }

  /** Number of distinct cells accumulated so far. */
  get cellCount(): number {
    return this.cells.length;
  }

  /**
   * Accumulate the cell under the pointer, gap-filling the 8-connected walk
   * since the previously accumulated cell. No-op once finished.
   */
  addCell(cell: CellRef): void {
    if (!this.active) return;
    const from = this.lastCell ?? cell;
    for (const c of lineCells(from, cell)) {
      const idx = c.cz * this.gridWidth + c.cx;
      if (!this.seen.has(idx)) {
        this.seen.add(idx);
        this.cells.push(idx);
      }
    }
    this.lastCell = cell;
  }

  /**
   * End the gesture and emit exactly one outcome. Consumes the accumulated
   * cells: calling finish twice (or addCell after finish) can never emit a
   * second order.
   */
  finish(gesture: PointerUpClass): LinearNetworkDragOutcome {
    const cells = this.cells;
    const { kind, owner } = this;
    this.cells = [];
    this.seen.clear();
    this.lastCell = null;
    this.active = false;
    if (cells.length > 0) {
      return { action: 'order', intent: buildNetworkOrder(kind, owner, cells) };
    }
    if (gesture === 'click') {
      return { action: 'click', kind, owner };
    }
    return { action: 'none' };
  }
}
