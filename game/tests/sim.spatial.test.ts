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
 * NOVATERRA — sim/spatial tests (headless).
 *
 * Covers: radius + rectangle queries against a brute-force reference under
 * a seeded randomized insert/move/remove workload, stable sorted query
 * order across rebuilds, and loud rejections (duplicate insert, unknown
 * move, inverted rect, negative radius).
 */
import { describe, expect, it } from 'vitest';
import {
  createSpatialHash,
  shCount,
  shHas,
  shInsert,
  shMove,
  shQueryRadius,
  shQueryRect,
  shRemove,
} from '../src/sim/spatial';
import type { SpatialHash } from '../src/sim/spatial';
import { createRngBank } from '../src/sim/rng';

/** Brute-force reference: plain map, same predicates, sorted output. */
class BruteForce {
  pts = new Map<number, { x: number; z: number }>();

  radius(x: number, z: number, r: number): number[] {
    const out: number[] = [];
    for (const [id, p] of this.pts) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz <= r * r) out.push(id);
    }
    return out.sort((a, b) => a - b);
  }

  rect(x0: number, z0: number, x1: number, z1: number): number[] {
    const out: number[] = [];
    for (const [id, p] of this.pts) {
      if (p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1) out.push(id);
    }
    return out.sort((a, b) => a - b);
  }
}

describe('sim/spatial', () => {
  it('matches brute force under a randomized insert/move/remove workload', () => {
    const rng = createRngBank(4242);
    const sh: SpatialHash = createSpatialHash(16);
    const ref = new BruteForce();
    let nextId = 1;
    const live: number[] = [];

    // Seed with 300 scattered entities (some off-map negative coords too).
    for (let i = 0; i < 300; i++) {
      const id = nextId++;
      const x = rng.range('t', -300, 300);
      const z = rng.range('t', -300, 300);
      shInsert(sh, id, x, z);
      ref.pts.set(id, { x, z });
      live.push(id);
    }

    for (let step = 0; step < 600; step++) {
      const roll = rng.next('t');
      if (roll < 0.35 && live.length > 0) {
        // Move a random live entity (often across cell borders).
        const id = live[rng.intBelow('t', live.length)] as number;
        const x = rng.range('t', -300, 300);
        const z = rng.range('t', -300, 300);
        shMove(sh, id, x, z);
        ref.pts.set(id, { x, z });
      } else if (roll < 0.5 && live.length > 0) {
        // Remove a random live entity.
        const at = rng.intBelow('t', live.length);
        const id = live[at] as number;
        expect(shRemove(sh, id)).toBe(true);
        ref.pts.delete(id);
        live.splice(at, 1);
      } else if (roll < 0.75) {
        // Radius query vs brute force.
        const x = rng.range('t', -300, 300);
        const z = rng.range('t', -300, 300);
        const r = rng.range('t', 0, 60);
        expect(shQueryRadius(sh, x, z, r)).toEqual(ref.radius(x, z, r));
      } else {
        // Rectangle query vs brute force.
        const x0 = rng.range('t', -300, 300);
        const z0 = rng.range('t', -300, 300);
        const x1 = x0 + rng.range('t', 0, 80);
        const z1 = z0 + rng.range('t', 0, 80);
        expect(shQueryRect(sh, x0, z0, x1, z1)).toEqual(ref.rect(x0, z0, x1, z1));
      }
      expect(shCount(sh)).toBe(ref.pts.size);
    }
  });

  it('query results are sorted and stable across identical rebuilds', () => {
    const build = (): SpatialHash => {
      const sh = createSpatialHash(16);
      const rng = createRngBank(9);
      for (let id = 1; id <= 120; id++) {
        shInsert(sh, id, rng.range('t', -100, 100), rng.range('t', -100, 100));
      }
      return sh;
    };
    const a = build();
    const b = build();
    for (const [x, z, r] of [
      [0, 0, 25],
      [-40, 30, 50],
      [90, -90, 10],
    ] as Array<[number, number, number]>) {
      const ra = shQueryRadius(a, x, z, r);
      expect(ra).toEqual(shQueryRadius(b, x, z, r));
      expect([...ra].sort((p, q) => p - q)).toEqual(ra);
    }
    const rectA = shQueryRect(a, -50, -50, 50, 50);
    expect(rectA).toEqual(shQueryRect(b, -50, -50, 50, 50));
    expect([...rectA].sort((p, q) => p - q)).toEqual(rectA);
  });

  it('finds entities straddling cell borders', () => {
    const sh = createSpatialHash(16);
    // Cell borders at multiples of 16; place entities just inside each side.
    shInsert(sh, 1, 15.9, 0);
    shInsert(sh, 2, 16.1, 0);
    shInsert(sh, 3, -0.1, -16.1);
    expect(shQueryRadius(sh, 16, 0, 0.5)).toEqual([1, 2]);
    expect(shQueryRect(sh, 15, -1, 17, 1)).toEqual([1, 2]);
    expect(shQueryRadius(sh, 0, -16, 1)).toEqual([3]);
  });

  it('rejects loudly: duplicate insert, unknown move, bad queries', () => {
    const sh = createSpatialHash(16);
    shInsert(sh, 7, 0, 0);
    expect(() => shInsert(sh, 7, 1, 1)).toThrow();
    expect(() => shMove(sh, 999, 0, 0)).toThrow();
    expect(shRemove(sh, 999)).toBe(false);
    expect(() => shQueryRadius(sh, 0, 0, -1)).toThrow();
    expect(() => shQueryRect(sh, 5, 0, 1, 1)).toThrow();
    expect(() => createSpatialHash(0)).toThrow();
    expect(() => createSpatialHash(Number.NaN)).toThrow();
    // The hash is untouched by the failed ops.
    expect(shHas(sh, 7)).toBe(true);
    expect(shCount(sh)).toBe(1);
  });

  it('move within one cell keeps the entity queryable', () => {
    const sh = createSpatialHash(16);
    shInsert(sh, 1, 1, 1);
    shMove(sh, 1, 2, 2); // same cell (0,0)
    expect(shQueryRadius(sh, 2, 2, 0.1)).toEqual([1]);
    expect(shQueryRadius(sh, 1, 1, 0.1)).toEqual([]);
    shMove(sh, 1, 100, 100); // far cell
    expect(shQueryRadius(sh, 100, 100, 0.1)).toEqual([1]);
    expect(shCount(sh)).toBe(1);
  });

  it('empty hash answers empty queries', () => {
    const sh = createSpatialHash(16);
    expect(shQueryRadius(sh, 0, 0, 100)).toEqual([]);
    expect(shQueryRect(sh, -10, -10, 10, 10)).toEqual([]);
  });
});
