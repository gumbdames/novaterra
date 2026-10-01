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
import { canonicalizeWorld, digestWorld, fnv1a32 } from '../src/sim/digest';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import type { CommandQueue } from '../src/sim/commands';
import { createTickDriver } from '../src/sim/tick';
import type { TickDriver } from '../src/sim/tick';
import { createWorld, rngBank } from '../src/sim/world';
import type { World } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  passabilityMask,
  landComponents,
  beginFieldBuild,
  stepFieldBuild,
} from '../src/sim/pathfinding';
import type { MayorAssignment } from '../src/sim/delegation';

/** A deterministic test system: entities drift using the sim RNG. */
function driftSystem(world: World, dt: number): void {
  const bank = rngBank(world);
  for (const e of world.entities) {
    e.x += (bank.next('drift') - 0.5) * dt;
    e.z += (bank.next('drift') - 0.5) * dt;
  }
}

/** Same command script for every determinism run. */
function scriptCommands(w: World, queue: CommandQueue): void {
  queue.enqueue(w, {
    kind: 'spawn', tick: 10, issuer: 'player', seq: 0,
    payload: { kind: 'settler', x: 100, z: -50 },
  });
  queue.enqueue(w, {
    kind: 'spawn', tick: 10, issuer: 'ai:classic:2', seq: 0,
    payload: { kind: 'farm', x: -20, z: 300 },
  });
  queue.enqueue(w, {
    kind: 'spawn', tick: 250, issuer: 'player', seq: 1,
    payload: { kind: 'tank', x: 0, z: 0 },
  });
}

function runTicks(w: World, driver: TickDriver, ticks: number): void {
  for (let i = 0; i < ticks / 3; i++) driver.step(w, 100); // 3 ticks per 100ms
}

function buildRun(seed: number, extraCommand: boolean): number {
  const w = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  const driver = createTickDriver({ systems: [driftSystem], queue });
  scriptCommands(w, queue);
  if (extraCommand) {
    queue.enqueue(w, {
      kind: 'spawn', tick: 100, issuer: 'player', seq: 2,
      payload: { kind: 'scout', x: 5, z: 5 },
    });
  }
  runTicks(w, driver, 600);
  return digestWorld(w);
}

describe('sim/digest', () => {
  it('fnv1a32 is a sane 32-bit hash', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    const h = fnv1a32('novaterra');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(fnv1a32('novaterra')).toBe(h); // stable
    expect(fnv1a32('novaterra!')).not.toBe(h); // avalanches
  });

  it('same seed + same commands => identical digest after 600 ticks', () => {
    expect(buildRun(2026, false)).toBe(buildRun(2026, false));
  });

  it('a single divergent command changes the digest (hash is sensitive)', () => {
    const base = buildRun(2026, false);
    const divergent = buildRun(2026, true);
    expect(divergent).not.toBe(base);
  });

  it('different seeds diverge', () => {
    expect(buildRun(1, false)).not.toBe(buildRun(2, false));
  });

  it('canonicalization is independent of rng stream creation order', () => {
    const a = createWorld(9);
    rngBank(a).next('b');
    rngBank(a).next('a');
    const b = createWorld(9);
    rngBank(b).next('a');
    rngBank(b).next('b');
    // Stream states are identical; only insertion order differed.
    expect(canonicalizeWorld(a)).toBe(canonicalizeWorld(b));
    expect(digestWorld(a)).toBe(digestWorld(b));
  });

  it('empty worlds with different seeds have different digests', () => {
    expect(digestWorld(createWorld(1))).not.toBe(digestWorld(createWorld(2)));
  });
});

describe('sim/digest — final-review R6/L1 digest-gap coverage', () => {
  it('nextAirlineRouteId is digest-covered: a counter-only difference changes the digest', () => {
    const a = createWorld(4242);
    const b = createWorld(4242);
    expect(digestWorld(a)).toBe(digestWorld(b));
    // Identical routes, different counter: the next established route
    // would get a different id, so the digest must already differ.
    b.city.nextAirlineRouteId = a.city.nextAirlineRouteId + 1;
    expect(digestWorld(b)).not.toBe(digestWorld(a));
  });

  it('mayor buildPolicy is digest-covered', () => {
    const a = createWorld(4242);
    const b = createWorld(4242);
    const ma: MayorAssignment = { owner: 0, policy: 'growth', buildPolicy: 'housing' };
    const mb: MayorAssignment = { owner: 0, policy: 'growth', buildPolicy: 'industry' };
    a.delegation.mayors.push(ma);
    b.delegation.mayors.push(mb);
    expect(digestWorld(a)).not.toBe(digestWorld(b));
    mb.buildPolicy = 'housing';
    expect(digestWorld(b)).toBe(digestWorld(a));
  });

  /**
   * Start an identical mid-flood Dijkstra build on two same-seed worlds,
   * then diverge one heap tie-breaker: the digests must differ, because
   * the heap internals decide which cell pops next (build duration and,
   * via early-exit timing, the finished field's directions).
   */
  function midFloodWorld(seed: number, terrain: TerrainData, mutate: boolean): World {
    const w = createWorld(seed);
    const mask = passabilityMask(terrain);
    const comps = landComponents(terrain);
    // First passable cell: deterministic, works on any preset.
    let destCell = -1;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) {
        destCell = i;
        break;
      }
    }
    if (destCell < 0) throw new Error('test terrain has no passable cell');
    const build = beginFieldBuild(
      1, destCell, [101, 102], [], mask, [], comps, false,
    );
    stepFieldBuild(build, mask, [], 40); // a few dozen pops: heap non-trivial
    if (build.heapTies.length === 0) throw new Error('expected a non-empty heap after 40 pops');
    if (mutate) build.heapTies[0] = (build.heapTies[0] as number) + 1;
    w.pathfinding.activeBuild = build;
    return w;
  }

  it('activeBuild Dijkstra heap internals are digest-covered', () => {
    const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
    const a = midFloodWorld(5150, terrain, false);
    const b = midFloodWorld(5150, terrain, false);
    expect(digestWorld(a)).toBe(digestWorld(b)); // identical builds: stable
    const c = midFloodWorld(5150, terrain, true);
    expect(digestWorld(c)).not.toBe(digestWorld(a)); // one tie changed: diverges
  });
});
