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
 * along with this program. If you did, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tests/render.blobShadows.test.ts — one-draw-call blob shadows.
 *
 * Final-review R5 visual lift (2026-10-01). Tests the pure layout math
 * (`collectBlobShadows`) and the generated gradient texture; the
 * InstancedMesh itself is exercised through EntityRenderer in the game.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOB_SHADOW_CAPACITY,
  BLOB_SHADOW_LIFT,
  collectBlobShadows,
  makeBlobShadowTexture,
} from '../src/render/blobShadows';
import { BUILDING_DEFS, cellCenterWorld } from '../src/sim/city';
import type { BuildingKind } from '../src/sim/city';
import type { UnitKind, UnitRecord } from '../src/sim/units';
import type { World } from '../src/sim/world';
import { hullSizeFor } from '../src/render/entities';

let nextId = 1;

function fakeUnit(
  kind: UnitKind,
  domain: 'land' | 'air' | 'sea',
  opts: { x?: number; z?: number; hp?: number } = {},
): UnitRecord {
  return {
    id: nextId++,
    kind,
    domain,
    owner: 0,
    x: opts.x ?? 10,
    z: opts.z ?? 20,
    hp: opts.hp ?? 100,
  } as unknown as UnitRecord;
}

function fakeBuilding(kind: BuildingKind, cx = 4, cz = 6) {
  return { id: nextId++, kind, owner: 0, cx, cz, progress: 1 } as unknown as World['city']['buildings'][number];
}

function fakeWorld(units: UnitRecord[], buildings: ReturnType<typeof fakeBuilding>[]): World {
  return { units, city: { buildings } } as unknown as World;
}

/** Flat test height: land/air → 5, sea → 0 (water level). */
function flatHeight(x: number, z: number, domain: 'land' | 'air' | 'sea'): number {
  void x;
  void z;
  return domain === 'sea' ? 0 : 5;
}

describe('makeBlobShadowTexture', () => {
  it('is a 64x64 RGBA texture, opaque core, transparent rim', () => {
    const tex = makeBlobShadowTexture();
    expect(tex.image.width).toBe(64);
    expect(tex.image.height).toBe(64);
    const data = tex.image.data as Uint8Array;
    const at = (x: number, y: number) => data[(y * 64 + x) * 4 + 3]!;
    // Core is solid.
    expect(at(32, 32)).toBeGreaterThan(200);
    // Rim is fully transparent.
    expect(at(0, 0)).toBe(0);
    expect(at(63, 0)).toBe(0);
    expect(at(0, 63)).toBe(0);
    expect(at(63, 63)).toBe(0);
    // Monotonic falloff from center to edge.
    expect(at(32, 32)).toBeGreaterThanOrEqual(at(40, 32));
    expect(at(40, 32)).toBeGreaterThanOrEqual(at(48, 32));
    expect(at(48, 32)).toBeGreaterThanOrEqual(at(56, 32));
    tex.dispose();
  });
});

describe('collectBlobShadows', () => {
  it('shadows every living unit at its ground point plus lift', () => {
    const world = fakeWorld([fakeUnit('tank', 'land', { x: 11, z: 22 })], []);
    const entries = collectBlobShadows(world, flatHeight);
    expect(entries).toHaveLength(1);
    const hull = hullSizeFor('tank');
    expect(entries[0]).toMatchObject({
      x: 11,
      z: 22,
      y: 5 + BLOB_SHADOW_LIFT,
      diameter: Math.max(hull.x, hull.z, 1) * 1.1,
    });
  });

  it('skips dead units', () => {
    const world = fakeWorld(
      [fakeUnit('tank', 'land'), fakeUnit('rifles', 'land', { hp: 0 })],
      [],
    );
    expect(collectBlobShadows(world, flatHeight)).toHaveLength(1);
  });

  it('aircraft shadow the ground beneath them (domain passed through)', () => {
    const seen: string[] = [];
    const world = fakeWorld([fakeUnit('fighter', 'air')], []);
    const entries = collectBlobShadows(world, (x, z, domain) => {
      seen.push(domain);
      return flatHeight(x, z, domain);
    });
    expect(seen).toEqual(['air']);
    expect(entries[0]!.y).toBe(5 + BLOB_SHADOW_LIFT);
  });

  it('sea units shadow the water level', () => {
    const world = fakeWorld([fakeUnit('destroyer', 'sea')], []);
    const entries = collectBlobShadows(world, flatHeight);
    expect(entries[0]!.y).toBe(0 + BLOB_SHADOW_LIFT);
  });

  it('buildings shadow their footprint center', () => {
    const kind = 'barracks' as BuildingKind;
    const def = BUILDING_DEFS[kind];
    const world = fakeWorld([], [fakeBuilding(kind, 4, 6)]);
    const entries = collectBlobShadows(world, flatHeight);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.x).toBe(cellCenterWorld(4));
    expect(entries[0]!.z).toBe(cellCenterWorld(6));
    expect(entries[0]!.diameter).toBe(
      Math.max(def.footprintW, def.footprintH) * 2 * 1.05,
    );
  });

  it('tech-level variants use the base hull (no rifleman-sized tank shadows)', () => {
    const world = fakeWorld([fakeUnit('tankMk2' as UnitKind, 'land')], []);
    const entries = collectBlobShadows(world, flatHeight);
    const base = hullSizeFor('tank');
    expect(entries[0]!.diameter).toBe(Math.max(base.x, base.z, 1) * 1.1);
  });

  it('respects the capacity cap', () => {
    const units = Array.from({ length: 10 }, () => fakeUnit('rifles', 'land'));
    const world = fakeWorld(units, []);
    expect(collectBlobShadows(world, flatHeight, 4)).toHaveLength(4);
    expect(BLOB_SHADOW_CAPACITY).toBeGreaterThan(0);
  });

  it('is deterministic: same world, same entries', () => {
    const units = [fakeUnit('tank', 'land'), fakeUnit('fighter', 'air')];
    const buildings = [fakeBuilding('barracks' as BuildingKind)];
    const a = collectBlobShadows(fakeWorld(units, buildings), flatHeight);
    const b = collectBlobShadows(fakeWorld(units, buildings), flatHeight);
    expect(a).toEqual(b);
  });
});
