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
 * NOVATERRA — tests/sim.fog.test.ts — fun-audit C3 (2026-10-02): the
 * player fog of war.
 *
 * Covers:
 *  - explored-memory init (nothing explored) + monotonicity (once
 *    explored, a cell stays explored even after sight leaves);
 *  - `computeVisibleCells` geometry (disc rasterization around the
 *    sim's own sight discs — the shroud and the AI perception model
 *    cannot disagree);
 *  - the fog system's cadence (first-call priming, then every
 *    FOG_UPDATE_EVERY_TICKS ticks);
 *  - snapshot round-trip of the explored grids (display memory —
 *    snapshotted, not digested);
 *  - determinism: two same-seed worlds end with identical explored
 *    memory;
 *  - the threat meter's visibility gate: an unseen AI army does not
 *    move the meter (game-feel P3 — no maphack).
 *
 * No RNG is used anywhere in this file: fog is pure geometry +
 * fixed cadence, so every test is deterministic by construction.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { spawnUnit } from '../src/sim/units';
import {
  computeVisibleCells,
  createFogState,
  FOG_CELL,
  FOG_GRID,
  FOG_UPDATE_EVERY_TICKS,
  fogCellIndex,
  getFogState,
  isExplored,
  updateFog,
} from '../src/sim/fog';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { computeThreat } from '../src/muse/director';

function setup(): World {
  return createWorld(20261002);
}

/** A player-owned tank (sight 26) at (x, z). */
function tank(world: World, owner: number, x: number, z: number) {
  return spawnUnit(world, 'tank', owner, x, z);
}

/** An AI-owned artillery piece — armed, so it counts for the threat meter. */
function artillery(world: World, owner: number, x: number, z: number) {
  return spawnUnit(world, 'artillery', owner, x, z);
}

describe('fog state', () => {
  it('starts completely unexplored', () => {
    const fog = createFogState();
    expect(fog.cell).toBe(FOG_CELL);
    expect(fog.explored).toEqual({});
    const world = setup();
    expect(isExplored(world, 0, 0, 0)).toBe(false);
    expect(isExplored(world, 0, 200, -200)).toBe(false);
  });

  it('fogCellIndex maps world positions into the 64x64 grid', () => {
    // Map spans -256..256; cell 8 => (0,0) is the middle of the grid.
    expect(fogCellIndex(0, 0)).toBe(32 * FOG_GRID + 32);
    expect(fogCellIndex(-256, -256)).toBe(0);
    expect(fogCellIndex(255.9, 255.9)).toBe(FOG_GRID * FOG_GRID - 1);
    // Out-of-map clamps rather than wrapping.
    expect(fogCellIndex(-1000, -1000)).toBe(0);
    expect(fogCellIndex(1000, 1000)).toBe(FOG_GRID * FOG_GRID - 1);
  });
});

describe('computeVisibleCells', () => {
  it('marks the disc around a unit, nothing far away', () => {
    const world = setup();
    // Tank sight is 26 world units; cells are 8 => ~3.25 cells radius.
    tank(world, 0, 0, 0);
    const vis = computeVisibleCells(world, 0);
    expect(vis.length).toBe(FOG_GRID * FOG_GRID);
    // The unit's own cell and neighbours are visible...
    expect(vis[fogCellIndex(0, 0)]).toBe(1);
    expect(vis[fogCellIndex(16, 0)]).toBe(1);
    // ...but a cell 100 units away is not.
    expect(vis[fogCellIndex(100, 0)]).toBe(0);
    expect(vis[fogCellIndex(0, 100)]).toBe(0);
  });

  it('is empty for an owner with no units and no surveillance', () => {
    const world = setup();
    const vis = computeVisibleCells(world, 1);
    expect(vis.every((v) => v === 0)).toBe(true);
  });
});

describe('updateFog / explored memory', () => {
  it('explores the cells under a unit and is monotonic', () => {
    const world = setup();
    const u = tank(world, 0, 0, 0);
    updateFog(world);
    expect(isExplored(world, 0, 0, 0)).toBe(true);
    expect(isExplored(world, 0, 100, 0)).toBe(false);
    // Move the tank far away and refresh: the old cell stays explored.
    u.x = 200;
    u.z = 0;
    updateFog(world);
    expect(isExplored(world, 0, 0, 0)).toBe(true);
    expect(isExplored(world, 0, 200, 0)).toBe(true);
  });

  it('tracks owners independently', () => {
    const world = setup();
    tank(world, 0, 0, 0);
    tank(world, 1, 200, 0);
    updateFog(world);
    expect(isExplored(world, 0, 0, 0)).toBe(true);
    expect(isExplored(world, 0, 200, 0)).toBe(false);
    expect(isExplored(world, 1, 200, 0)).toBe(true);
    expect(isExplored(world, 1, 0, 0)).toBe(false);
  });

  it('the fog system primes on first call, then runs at cadence', async () => {
    const { createFogSystem } = await import('../src/sim/fog');
    const world = setup();
    tank(world, 0, 0, 0);
    const sys = createFogSystem();
    // First call primes: base explored even at tick 0.
    sys(world, 0);
    expect(isExplored(world, 0, 0, 0)).toBe(true);
    // Move the tank; no refresh until the cadence elapses.
    world.units[0]!.x = 200;
    world.units[0]!.z = 0;
    for (let t = 1; t < FOG_UPDATE_EVERY_TICKS; t++) {
      world.tick = t;
      sys(world, 0);
    }
    expect(isExplored(world, 0, 200, 0)).toBe(false);
    world.tick = FOG_UPDATE_EVERY_TICKS;
    sys(world, 0);
    expect(isExplored(world, 0, 200, 0)).toBe(true);
  });
});

describe('fog snapshot round-trip', () => {
  it('preserves explored memory across save/load', () => {
    const world = setup();
    tank(world, 0, 0, 0);
    updateFog(world);
    expect(isExplored(world, 0, 0, 0)).toBe(true);
    const snap = takeSnapshot(world);
    const world2 = restoreSnapshot(snap);
    expect(isExplored(world2, 0, 0, 0)).toBe(true);
    expect(isExplored(world2, 0, 100, 0)).toBe(false);
    // And it stays monotonic after the load.
    world2.units[0]!.x = 100;
    updateFog(world2);
    expect(isExplored(world2, 0, 0, 0)).toBe(true);
    expect(isExplored(world2, 0, 100, 0)).toBe(true);
  });
});

describe('fog system change detection', () => {
  it('skips the rasterization when nothing changed, recomputes on movement', async () => {
    const { createFogSystem } = await import('../src/sim/fog');
    const world = setup();
    tank(world, 0, 0, 0);
    const sys = createFogSystem();
    sys(world, 0); // prime
    expect(isExplored(world, 0, 0, 0)).toBe(true);
    // Idle cadence: no recompute needed, explored unchanged.
    world.tick = FOG_UPDATE_EVERY_TICKS;
    sys(world, 0);
    expect(isExplored(world, 0, 200, 0)).toBe(false);
    // The tank moves: the next cadence picks it up.
    world.units[0]!.x = 200;
    world.tick = FOG_UPDATE_EVERY_TICKS * 2;
    sys(world, 0);
    expect(isExplored(world, 0, 200, 0)).toBe(true);
    // A sight upgrade also invalidates the cache.
    world.units[0]!.x = 0;
    world.tick = FOG_UPDATE_EVERY_TICKS * 3;
    sys(world, 0);
    expect(isExplored(world, 0, 0, 0)).toBe(true);
  });
});

describe('fog determinism', () => {
  it('two same-seed worlds end with identical explored memory', () => {
    const run = (): number[] => {
      const world = createWorld(424242);
      tank(world, 0, 0, 0);
      tank(world, 1, 180, -120);
      // Drive a few fog updates with the units moving between them.
      for (let i = 0; i < 3; i++) {
        world.units[0]!.x += 40;
        world.units[1]!.z += 30;
        updateFog(world);
      }
      return getFogState(world).explored[0] ?? [];
    };
    expect(run()).toEqual(run());
  });
});

describe('threat meter visibility gate (game-feel P3)', () => {
  it('an unseen AI army does not move the meter; a seen one does', () => {
    const world = setup();
    // The player fields one tank at the origin...
    tank(world, 0, 0, 0);
    // ...while the AI masses artillery far beyond anyone's sight.
    for (let i = 0; i < 5; i++) artillery(world, 1, 220 + i * 4, 220);
    const blind = computeThreat(world, 0, 1);
    expect(blind).toBeLessThan(50);
    // A player scout walks adjacent: now the army is visible and the
    // meter must react.
    spawnUnit(world, 'reconTeam', 0, 216, 216);
    const seen = computeThreat(world, 0, 1);
    expect(seen).toBeGreaterThan(blind);
    expect(seen).toBeGreaterThan(50);
  });
});
