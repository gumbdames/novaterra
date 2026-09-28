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
import {
  FIRST_ENTITY_ID,
  createWorld,
  despawnEntity,
  findEntity,
  rngBank,
  spawnEntity,
} from '../src/sim/world';

describe('sim/world', () => {
  it('creates a zeroed world', () => {
    const w = createWorld(123);
    expect(w.tick).toBe(0);
    expect(w.time).toBe(0);
    expect(w.seed).toBe(123);
    expect(w.nextId).toBe(FIRST_ENTITY_ID);
    expect(w.entities).toEqual([]);
    expect(w.rng).toEqual({});
  });

  it('normalizes the seed to uint32', () => {
    expect(createWorld(-5).seed).toBe(4294967291);
  });

  it('spawns entities with incrementing stable ids, in spawn order', () => {
    const w = createWorld(1);
    const a = spawnEntity(w, 'settler', 10, 20);
    const b = spawnEntity(w, 'farm', -3, 4.5);
    expect(a.id).toBe(FIRST_ENTITY_ID);
    expect(b.id).toBe(FIRST_ENTITY_ID + 1);
    expect(w.entities.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(findEntity(w, a.id)).toBe(a);
    expect(findEntity(w, 9999)).toBeUndefined();
  });

  it('despawn removes the entity and keeps survivors in spawn order', () => {
    const w = createWorld(1);
    const a = spawnEntity(w, 'a', 0, 0);
    const b = spawnEntity(w, 'b', 0, 0);
    const c = spawnEntity(w, 'c', 0, 0);
    expect(despawnEntity(w, b.id)).toBe(true);
    expect(despawnEntity(w, b.id)).toBe(false); // already gone
    expect(w.entities.map((e) => e.kind)).toEqual(['a', 'c']);
    expect(findEntity(w, a.id)?.kind).toBe('a');
    expect(findEntity(w, c.id)?.kind).toBe('c');
  });

  it('ids are never reused', () => {
    const w = createWorld(1);
    const a = spawnEntity(w, 'a', 0, 0);
    despawnEntity(w, a.id);
    const b = spawnEntity(w, 'b', 0, 0);
    expect(b.id).not.toBe(a.id);
  });

  it('spawn validates its arguments loudly', () => {
    const w = createWorld(1);
    expect(() => spawnEntity(w, '', 0, 0)).toThrow();
    expect(() => spawnEntity(w, 'x', NaN, 0)).toThrow();
    expect(() => spawnEntity(w, 'x', 0, Infinity)).toThrow();
  });

  it('rngBank draws mutate world.rng (state lives in the world)', () => {
    const w = createWorld(42);
    const bank = rngBank(w);
    const v1 = bank.next('combat');
    expect(typeof w.rng['combat']).toBe('number');
    // A fresh bank over the same record continues the same stream.
    expect(rngBank(w).next('combat')).not.toBe(v1);
    const w2 = createWorld(42);
    expect(rngBank(w2).next('combat')).toBe(v1); // same seed, same first draw
  });
});
