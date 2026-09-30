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
 * Tests for the procedural surface texture library:
 * - `surfaceTextures.ts`: seeded determinism (same seed → byte-identical
 *   pixels, different seed → different pixels), tileability (edges match),
 *   DataTexture factory wiring.
 * - `surfaceMaterials.ts`: the shared record is complete (all 16
 *   categories), instances are shared, params are sane.
 * - `boxProjectUVs.ts`: dominant-axis projection correctness, bounds,
 *   no NaNs, determinism, error paths.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { boxProjectUVs, ensureBoxUVs } from '../src/render/boxProjectUVs';
import {
  SURFACE_MATERIALS,
  SURFACE_SPECS,
} from '../src/render/surfaceMaterials';
import {
  defaultSurfaceSeed,
  generateSurfacePixels,
  generateSurfaceRoughness,
  mulberry32,
  SURFACE_CATEGORIES,
  SURFACE_TEXTURE_SIZE,
  surfaceRoughnessTexture,
  surfaceTexture,
  type SurfaceCategory,
} from '../src/render/surfaceTextures';

/** Byte-exact comparison (no Node Buffer types in the test tsconfig). */
function u8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('mulberry32', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const seqA = [a(), a(), a(), a()];
    expect([b(), b(), b(), b()]).toEqual(seqA);
    expect(c()).not.toBe(seqA[0]);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('surface catalog', () => {
  it('has 16 categories, each with a texture size and default seed', () => {
    expect(SURFACE_CATEGORIES.length).toBe(16);
    for (const cat of SURFACE_CATEGORIES) {
      expect(SURFACE_TEXTURE_SIZE[cat] ?? 0).toBeGreaterThanOrEqual(128);
      expect(defaultSurfaceSeed(cat)).toBe(defaultSurfaceSeed(cat));
    }
    // Default seeds differ per category (no accidental seed sharing).
    const seeds = new Set(SURFACE_CATEGORIES.map(defaultSurfaceSeed));
    expect(seeds.size).toBe(SURFACE_CATEGORIES.length);
  });
});

describe('generateSurfacePixels determinism', () => {
  for (const category of SURFACE_CATEGORIES) {
    it(`${category}: same seed → byte-identical pixels`, () => {
      const seed = 12345;
      const a = generateSurfacePixels(category, seed);
      const b = generateSurfacePixels(category, seed);
      expect(a.width).toBe(SURFACE_TEXTURE_SIZE[category]);
      expect(a.height).toBe(SURFACE_TEXTURE_SIZE[category]);
      expect(a.data.length).toBe(a.width * a.height * 4);
      expect(u8Equal(a.data, b.data)).toBe(true);
    });

    it(`${category}: different seed → different pixels`, () => {
      const a = generateSurfacePixels(category, 111);
      const b = generateSurfacePixels(category, 222);
      expect(u8Equal(a.data, b.data)).toBe(false);
    });
  }

  it(
    'pixels are fully opaque (alpha 255 everywhere)',
    { timeout: 20000 },
    () => {
      for (const category of SURFACE_CATEGORIES) {
        const px = generateSurfacePixels(category, 42);
        for (let i = 3; i < px.data.length; i += 4) {
          expect(px.data[i]).toBe(255);
        }
      }
    },
  );
});

describe('generateSurfacePixels tileability', () => {
  /**
   * Repeat-tiling seamlessness: with RepeatWrapping, column w-1 sits next to
   * column 0 of the next copy, so the seam is just another adjacent-pixel
   * pair. It must be no worse than the texture's own grain (max interior
   * adjacent-pixel difference). This is the user-visible property: no
   * discontinuity line at tile boundaries. (Column 0 == column w-1 would be
   * mirror-tiling — the wrong property for RepeatWrapping.)
   */
  function maxAdjacentDiff(
    data: Uint8Array,
    w: number,
    h: number,
    channels: number,
  ): { interior: number; seam: number } {
    const at = (x: number, y: number, c: number): number =>
      data[(y * w + x) * channels + c] ?? 0;
    let interior = 0;
    let seam = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        for (let c = 0; c < channels; c++) {
          interior = Math.max(interior, Math.abs(at(x, y, c) - at(x + 1, y, c)));
        }
      }
      for (let c = 0; c < channels; c++) {
        seam = Math.max(seam, Math.abs(at(w - 1, y, c) - at(0, y, c)));
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h - 1; y++) {
        for (let c = 0; c < channels; c++) {
          interior = Math.max(interior, Math.abs(at(x, y, c) - at(x, y + 1, c)));
        }
      }
      for (let c = 0; c < channels; c++) {
        seam = Math.max(seam, Math.abs(at(x, h - 1, c) - at(x, 0, c)));
      }
    }
    return { interior, seam };
  }

  for (const category of SURFACE_CATEGORIES) {
    it(`${category}: repeat seam is no worse than the texture's own grain`, () => {
      const px = generateSurfacePixels(category, 99);
      const { interior, seam } = maxAdjacentDiff(px.data, px.width, px.height, 4);
      expect(seam).toBeLessThanOrEqual(interior + 1);
    });
  }
});

describe('generateSurfaceRoughness', () => {
  it('is deterministic and single-channel for every category', () => {
    for (const category of SURFACE_CATEGORIES) {
      const a = generateSurfaceRoughness(category, 31337);
      const b = generateSurfaceRoughness(category, 31337);
      const size = SURFACE_TEXTURE_SIZE[category] ?? 0;
      expect(a.width).toBe(size);
      expect(a.data.length).toBe(size * size);
      expect(u8Equal(a.data, b.data)).toBe(true);
    }
  });

  it('repeat seam is no worse than the roughness grain', () => {
    for (const category of SURFACE_CATEGORIES) {
      const r = generateSurfaceRoughness(category, 77);
      const size = r.width;
      let interior = 0;
      let seam = 0;
      const at = (x: number, y: number): number => r.data[y * size + x] ?? 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size - 1; x++) {
          interior = Math.max(interior, Math.abs(at(x, y) - at(x + 1, y)));
        }
        seam = Math.max(seam, Math.abs(at(size - 1, y) - at(0, y)));
      }
      expect(seam).toBeLessThanOrEqual(interior + 1);
    }
  });
});

describe('texture factories', () => {
  it('surfaceTexture returns a cached sRGB RepeatWrapping DataTexture', () => {
    const t1 = surfaceTexture('paintedMetal');
    const t2 = surfaceTexture('paintedMetal');
    expect(t1).toBe(t2); // shared cache
    expect(t1.image.width).toBe(128);
    expect(t1.image.height).toBe(128);
    expect(t1.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t1.wrapS).toBe(THREE.RepeatWrapping);
    expect(t1.wrapT).toBe(THREE.RepeatWrapping);
  });

  it('256px surfaces get 256px textures', () => {
    const t = surfaceTexture('brickRed');
    expect(t.image.width).toBe(256);
    expect(t.image.height).toBe(256);
  });

  it('surfaceRoughnessTexture returns a cached single-channel DataTexture', () => {
    const t1 = surfaceRoughnessTexture('gunmetal');
    const t2 = surfaceRoughnessTexture('gunmetal');
    expect(t1).toBe(t2);
    expect(t1.format).toBe(THREE.RedFormat);
    expect(t1.colorSpace).toBe(THREE.NoColorSpace);
    expect(t1.wrapS).toBe(THREE.RepeatWrapping);
  });

  it('different categories get different textures', () => {
    expect(surfaceTexture('camoGreen')).not.toBe(surfaceTexture('camoDesert'));
  });
});

describe('SURFACE_MATERIALS', () => {
  it('has one shared MeshStandardMaterial per category', () => {
    for (const category of SURFACE_CATEGORIES) {
      const mat = SURFACE_MATERIALS[category];
      expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(mat.map).toBe(surfaceTexture(category));
      expect(mat.roughnessMap).toBe(surfaceRoughnessTexture(category));
      // Shared: repeated access returns the same instance.
      expect(SURFACE_MATERIALS[category]).toBe(mat);
    }
  });

  it('has sane metalness/roughness in [0, 1] for every category', () => {
    for (const category of SURFACE_CATEGORIES) {
      const spec = SURFACE_SPECS[category];
      expect(spec.metalness).toBeGreaterThanOrEqual(0);
      expect(spec.metalness).toBeLessThanOrEqual(1);
      expect(spec.roughness).toBeGreaterThanOrEqual(0);
      expect(spec.roughness).toBeLessThanOrEqual(1);
      const mat = SURFACE_MATERIALS[category];
      expect(mat.metalness).toBe(spec.metalness);
      expect(mat.roughness).toBe(spec.roughness);
    }
  });

  it('every category has a material spec with a tintable flag', () => {
    const keys = Object.keys(SURFACE_SPECS);
    expect(new Set(keys).size).toBe(SURFACE_CATEGORIES.length);
    for (const category of SURFACE_CATEGORIES) {
      expect(typeof SURFACE_SPECS[category].tintable).toBe('boolean');
    }
  });

  it('metals are metallic, rubber/fabric are not', () => {
    expect(SURFACE_SPECS.gunmetal.metalness).toBeGreaterThan(0.5);
    expect(SURFACE_SPECS.tireRubber.metalness).toBe(0);
    expect(SURFACE_SPECS.canvasFabric.metalness).toBe(0);
    expect(SURFACE_SPECS.concrete.metalness).toBe(0);
  });
});

describe('boxProjectUVs', () => {
  function uvOf(geo: THREE.BufferGeometry, i: number): [number, number] {
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    return [uv.getX(i), uv.getY(i)];
  }

  it('projects a +X-facing vertex to (z, y) in tile units', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([4, 6, 8]), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([1, 0, 0]), 3));
    const attr = boxProjectUVs(geo, 2);
    expect(attr.itemSize).toBe(2);
    expect(uvOf(geo, 0)).toEqual([4, 3]); // (z/2, y/2)
  });

  it('projects up-facing vertices to (x, z) and front-facing to (x, y)', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([2, 4, 6, 2, 4, 6]), 3),
    );
    geo.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 0, 1]), 3),
    );
    boxProjectUVs(geo, 2);
    expect(uvOf(geo, 0)).toEqual([1, 3]); // (x/2, z/2)
    expect(uvOf(geo, 1)).toEqual([1, 2]); // (x/2, y/2)
  });

  it('UV bounds match position extents / worldScale on a box', () => {
    const geo = new THREE.BoxGeometry(2, 4, 6);
    boxProjectUVs(geo, 2);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      expect(Number.isFinite(u)).toBe(true);
      expect(Number.isFinite(v)).toBe(true);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    // Box spans [-1,1]×[-2,2]×[-3,3]; tiles are 2 units → extents within ±1.5.
    expect(minU).toBeGreaterThanOrEqual(-1.5);
    expect(maxU).toBeLessThanOrEqual(1.5);
    expect(minV).toBeGreaterThanOrEqual(-1.5);
    expect(maxV).toBeLessThanOrEqual(1.5);
    // And the full tile range is actually used (not collapsed).
    expect(maxU - minU).toBeGreaterThan(0.5);
    expect(maxV - minV).toBeGreaterThan(0.5);
  });

  it('is deterministic across runs', () => {
    const make = () => {
      const g = new THREE.BoxGeometry(3, 5, 7);
      boxProjectUVs(g, 1.5);
      return Array.from((g.getAttribute('uv') as THREE.BufferAttribute).array);
    };
    expect(make()).toEqual(make());
  });

  it('handles missing normals with the up-facing fallback (no NaNs)', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([2, 4, 6]), 3));
    boxProjectUVs(geo, 2);
    expect(uvOf(geo, 0)).toEqual([1, 3]); // (x/2, z/2)
  });

  it('handles non-finite normals without producing NaNs', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([2, 4, 6]), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([NaN, NaN, NaN]), 3));
    boxProjectUVs(geo, 1);
    const [u, v] = uvOf(geo, 0);
    expect(Number.isFinite(u)).toBe(true);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('throws on invalid worldScale and missing position', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([1, 2, 3]), 3));
    expect(() => boxProjectUVs(geo, 0)).toThrow();
    expect(() => boxProjectUVs(geo, -1)).toThrow();
    expect(() => boxProjectUVs(geo, NaN)).toThrow();
    expect(() => boxProjectUVs(new THREE.BufferGeometry(), 2)).toThrow();
  });

  it('ensureBoxUVs projects only when no uv attribute exists', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.deleteAttribute('uv'); // BoxGeometry ships with UVs; drop them first
    expect(ensureBoxUVs(geo, 2)).not.toBeNull();
    expect(geo.getAttribute('uv')).toBeTruthy();
    const before = Array.from((geo.getAttribute('uv') as THREE.BufferAttribute).array);
    expect(ensureBoxUVs(geo, 0.5)).toBeNull(); // untouched
    expect(Array.from((geo.getAttribute('uv') as THREE.BufferAttribute).array)).toEqual(before);
  });
});
