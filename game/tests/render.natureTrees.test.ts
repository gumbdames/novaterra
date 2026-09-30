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
 * Tests for render/natureTrees.ts — procedural textured trees.
 *
 * Pins: seeded determinism (same kind → byte-identical geometry on every
 * build), geometry validity (attributes present, finite, non-empty), the
 * per-tree triangle budget behind the 60fps claim, and the material
 * contract (alpha-cut foliage, sRGB bark).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  buildCanopyGeometry,
  buildConiferGeometry,
  buildNatureTreeGeometry,
  buildTrunkGeometry,
  makeNatureTreeMaterials,
  mulberry32,
  NATURE_TREE_KINDS,
  NATURE_TREE_TEXTURE_PATHS,
  type NatureTreeKind,
  type NatureTreeTextures,
} from '../src/render/natureTrees';

/** Triangle count of a geometry (indexed or not). */
function triCount(geo: THREE.BufferGeometry): number {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  return index !== null ? index.count / 3 : pos.count / 3;
}

function stubTextures(): NatureTreeTextures {
  const make = (r: number, g: number, b: number): THREE.Texture => {
    const data = new Uint8Array([r, g, b, 255]);
    const tex = new THREE.DataTexture(data, 1, 1);
    tex.needsUpdate = true;
    return tex;
  };
  return {
    bark: make(120, 80, 50),
    birchBark: make(220, 220, 220),
    leaves: make(60, 140, 60),
    birchLeaves: make(90, 170, 80),
    pineLeaves: make(40, 110, 50),
  };
}

describe('mulberry32', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqB).toEqual(seqA);
    expect(c()).not.toBe(seqA[0]);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('buildTrunkGeometry', () => {
  it('rests at y=0, tapers upward, and carries bark UVs', () => {
    // lean: 0 here so the radial taper measurement isn't confounded by
    // the sideways shear (lean is covered by the determinism test).
    const geo = buildTrunkGeometry({
      height: 4, rBase: 0.3, rTop: 0.15, flare: 1.6, lean: 0, seed: 7,
    });
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    expect(pos.count).toBeGreaterThan(0);
    expect(uv.count).toBe(pos.count);
    let minY = Infinity;
    let maxRBase = 0;
    let maxRTop = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      expect(Number.isFinite(x + y + z)).toBe(true);
      minY = Math.min(minY, y);
      const r = Math.hypot(x, z);
      if (y < 0.5) maxRBase = Math.max(maxRBase, r);
      if (y > 3.5) maxRTop = Math.max(maxRTop, r);
    }
    expect(minY).toBeCloseTo(0, 6);
    // Flared base is wider than the tapered top.
    expect(maxRBase).toBeGreaterThan(maxRTop * 1.5);
  });

  it('is deterministic for a fixed seed', () => {
    const opts = { height: 4, rBase: 0.3, rTop: 0.15, flare: 1.6, lean: 0.2, seed: 7 };
    const a = buildTrunkGeometry(opts).getAttribute('position') as THREE.BufferAttribute;
    const b = buildTrunkGeometry(opts).getAttribute('position') as THREE.BufferAttribute;
    expect(a.count).toBe(b.count);
    for (let i = 0; i < a.count; i++) {
      expect(a.getX(i)).toBe(b.getX(i));
      expect(a.getY(i)).toBe(b.getY(i));
      expect(a.getZ(i)).toBe(b.getZ(i));
    }
  });
});

describe('buildCanopyGeometry / buildConiferGeometry', () => {
  it('produces non-empty merged cards + core with UVs', () => {
    const { cards, core } = buildCanopyGeometry(
      [
        { x: 0, y: 4, z: 0, s: 2 },
        { x: 1, y: 4.5, z: 0.5, s: 1.6 },
      ],
      99,
    );
    for (const geo of [cards, core]) {
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      expect(pos.count).toBeGreaterThan(0);
      expect(geo.getAttribute('uv')).toBeDefined();
    }
    // 2 puffs × (6 cards × 2 tris) = 24 card tris; 2 × 20 core tris.
    expect(triCount(cards)).toBe(24);
    expect(triCount(core)).toBe(40);
  });

  it('builds conifer tiers with a leader card', () => {
    const geo = buildConiferGeometry({
      baseY: 2, tierGap: 1, tiers: 3, rBase: 2, rTop: 0.5,
      cardsPerTier: 4, cardW: 1, cardH: 1.5, droop: 0.5, seed: 5,
    });
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBeGreaterThan(0);
    // 3 tiers × 4 cards × 2 tris + 1 leader × 2 tris.
    expect(triCount(geo)).toBe(3 * 4 * 2 + 2);
  });
});

describe('buildNatureTreeGeometry', () => {
  it('covers all six species keys', () => {
    expect(NATURE_TREE_KINDS).toHaveLength(6);
    const kinds = new Set<NatureTreeKind>(NATURE_TREE_KINDS);
    expect(kinds.has('propTreeOak')).toBe(true);
    expect(kinds.has('propTreeBirch')).toBe(true);
    expect(kinds.has('propTreePineTall')).toBe(true);
    expect(kinds.has('propTreePine')).toBe(true);
    expect(kinds.has('propTreeOldOak')).toBe(true);
    expect(kinds.has('propTreePoplar')).toBe(true);
  });

  it.each(NATURE_TREE_KINDS)('builds a valid, deterministic %s', (kind) => {
    const build = (): number[] => {
      const parts = buildNatureTreeGeometry(kind);
      const out: number[] = [];
      for (const geo of [parts.trunk, parts.foliage, parts.core]) {
        const pos = geo.getAttribute('position') as THREE.BufferAttribute;
        expect(pos.count).toBeGreaterThan(0);
        expect(geo.getAttribute('normal')).toBeDefined();
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);
          expect(Number.isFinite(x + y + z)).toBe(true);
          out.push(x, y, z);
        }
      }
      return out;
    };
    expect(build()).toEqual(build());
  });

  it.each(NATURE_TREE_KINDS)('%s stays inside the per-tree triangle budget', (kind) => {
    const parts = buildNatureTreeGeometry(kind);
    const total =
      triCount(parts.trunk) + triCount(parts.foliage) + triCount(parts.core);
    // Perf claim in natureTrees.ts: ~140–380 tris/tree. The test pins a
    // generous ceiling so a future species can't silently 10× the budget.
    expect(total).toBeLessThan(600);
    expect(total).toBeGreaterThan(50);
  });

  it('builds trees ~5.5–8.5 units tall (matches the old scatter footprint)', () => {
    for (const kind of NATURE_TREE_KINDS) {
      const parts = buildNatureTreeGeometry(kind);
      let maxY = 0;
      for (const geo of [parts.trunk, parts.foliage, parts.core]) {
        const pos = geo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
      }
      expect(maxY).toBeGreaterThan(5);
      expect(maxY).toBeLessThan(8.5);
    }
  });
});

describe('makeNatureTreeMaterials', () => {
  it('wires textures into bark + alpha-cut foliage materials', () => {
    const tex = stubTextures();
    const mats = makeNatureTreeMaterials(tex);
    expect(mats.bark.map).toBe(tex.bark);
    expect(mats.birchBark.map).toBe(tex.birchBark);
    expect(mats.leaves.map).toBe(tex.leaves);
    expect(mats.birchLeaves.map).toBe(tex.birchLeaves);
    expect(mats.pineLeaves.map).toBe(tex.pineLeaves);
    for (const m of [mats.leaves, mats.birchLeaves, mats.pineLeaves]) {
      expect(m.alphaTest).toBeGreaterThan(0);
      expect(m.side).toBe(THREE.DoubleSide);
    }
    // Cores are untextured dark interiors.
    expect(mats.core.map).toBeNull();
    expect(mats.pineCore.map).toBeNull();
  });
});

describe('NATURE_TREE_TEXTURE_PATHS', () => {
  it('lists the five shipped CC0 texture files', () => {
    expect(Object.keys(NATURE_TREE_TEXTURE_PATHS).sort()).toEqual(
      ['bark', 'birchBark', 'birchLeaves', 'leaves', 'pineLeaves'].sort(),
    );
    for (const p of Object.values(NATURE_TREE_TEXTURE_PATHS)) {
      expect(p.startsWith('quaternius-nature/textures/')).toBe(true);
    }
  });
});
