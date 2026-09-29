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
 * Tests for render/models.ts — the model-loading infrastructure.
 *
 * The module's contract: a missing/broken/slow GLB must NEVER throw and
 * NEVER hang boot — `loadModels` records the key in `failed` and continues.
 * The tests pin that with a mocked GLTFLoader (reject / hang / resolve),
 * pin the geometry merge + normalize helpers on fake Object3D scenes, and
 * prove the module stays import-safe under Node (no DOM at import time).
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import * as THREE from 'three';

import {
  MODEL_LOAD_TIMEOUT_MS,
  MODEL_PATHS,
  disposeModels,
  extractModelGeometry,
  loadModels,
  modelBaseUrl,
  normalizeModel,
} from '../src/render/models';

// ---------------------------------------------------------------------------
// Mock GLTFLoader: behavior is driven per-test through the hoisted state.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  behavior: 'resolve' as 'resolve' | 'reject' | 'hang',
  failUrls: [] as string[],
  scene: null as THREE.Group | null,
  lastUrl: null as string | null,
}));

vi.mock('three/addons/loaders/GLTFLoader.js', () => {
  class FakeGLTFLoader {
    async loadAsync(url: string): Promise<{ scene: THREE.Object3D }> {
      mockState.lastUrl = url;
      if (mockState.behavior === 'reject' || mockState.failUrls.includes(url)) {
        throw new Error('404 Not Found');
      }
      if (mockState.behavior === 'hang') {
        return new Promise<{ scene: THREE.Object3D }>(() => {
          /* pends forever, like a stalled CDN fetch */
        });
      }
      return { scene: mockState.scene ?? new THREE.Group() };
    }
  }
  return { GLTFLoader: FakeGLTFLoader };
});

beforeEach(() => {
  mockState.behavior = 'resolve';
  mockState.failUrls = [];
  mockState.scene = null;
  mockState.lastUrl = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Fake GLTF-ish scene: two boxes at offsets sharing one material. */
function makeTwoBoxScene(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const boxA = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  boxA.position.set(5, 1, 0); // base at y=0, offset +x
  const boxB = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), material);
  boxB.position.set(-3, 2, 4); // base at y=0, offset -x/+z
  group.add(boxA, boxB);
  return group;
}

/** Bounding box of a scene root, in world space. */
function worldBox(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root);
}

describe('MODEL_PATHS stub mapping', () => {
  it('has placeholder entries with a .glb path and a positive scale', () => {
    expect(Object.keys(MODEL_PATHS).length).toBeGreaterThan(0);
    for (const [key, spec] of Object.entries(MODEL_PATHS)) {
      expect(typeof key).toBe('string');
      expect(spec.path).toMatch(/\.glb$/);
      expect(spec.scale).toBeGreaterThan(0);
    }
  });
});

describe('modelBaseUrl', () => {
  it('respects import.meta.env.BASE_URL (vitest serves the Vite base)', () => {
    // vite.config.ts sets base: '/novaterra/'.
    expect(modelBaseUrl()).toBe('/novaterra/models/');
  });
});

describe('normalizeModel', () => {
  it('centers horizontally, rests the base at y=0, and applies the scale', () => {
    const scene = makeTwoBoxScene();
    // Pre-normalize box: x in [-4, 6], y in [0, 4], z in [-1, 5].
    normalizeModel(scene, 2);
    const box = worldBox(scene);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    expect(cx).toBeCloseTo(0, 10);
    expect(cz).toBeCloseTo(0, 10);
    expect(box.min.y).toBeCloseTo(0, 10);
    // Scale applied: y span was 4, now 8.
    expect(box.max.y - box.min.y).toBeCloseTo(8, 10);
  });

  it('normalizes correctly even when the root sits under a transformed parent', () => {
    const parent = new THREE.Group();
    parent.position.set(100, 0, -50);
    const scene = makeTwoBoxScene();
    parent.add(scene);
    normalizeModel(scene, 1);
    const box = worldBox(parent);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    expect(cx).toBeCloseTo(0, 10);
    expect(cz).toBeCloseTo(0, 10);
    expect(box.min.y).toBeCloseTo(0, 10);
  });

  it('is a no-op for a root with no geometry', () => {
    const empty = new THREE.Group();
    expect(() => normalizeModel(empty, 3)).not.toThrow();
  });

  it('throws on a non-positive or non-finite scale (loud at integration time)', () => {
    const scene = makeTwoBoxScene();
    expect(() => normalizeModel(scene, 0)).toThrow();
    expect(() => normalizeModel(scene, -1)).toThrow();
    expect(() => normalizeModel(scene, Number.NaN)).toThrow();
  });
});

describe('extractModelGeometry', () => {
  it('bakes world transforms and merges same-material meshes into one geometry', async () => {
    const scene = makeTwoBoxScene();
    normalizeModel(scene, 1);
    const { geometries, materials } = await extractModelGeometry(scene);
    expect(geometries).toHaveLength(1);
    expect(materials).toHaveLength(1);
    const merged = geometries[0];
    expect(merged).toBeDefined();
    // Two BoxGeometries = 24 verts each.
    expect(merged?.getAttribute('position').count).toBe(48);
    // Normalized: centered x/z, base at y=0.
    merged?.computeBoundingBox();
    const bb = merged?.boundingBox;
    expect(bb).toBeDefined();
    if (bb !== undefined && bb !== null) {
      expect((bb.min.x + bb.max.x) / 2).toBeCloseTo(0, 10);
      expect((bb.min.z + bb.max.z) / 2).toBeCloseTo(0, 10);
      expect(bb.min.y).toBeCloseTo(0, 10);
    }
  });

  it('keeps one merged geometry per material and clones the materials', async () => {
    const group = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), red);
    a.position.y = 0.5;
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), blue);
    b.position.set(2, 0.5, 0);
    group.add(a, b);
    const { geometries, materials } = await extractModelGeometry(group);
    expect(geometries).toHaveLength(2);
    expect(materials).toHaveLength(2);
    // Cloned so the integration step can tint per-instance safely.
    for (const m of materials) {
      expect(m).not.toBe(red);
      expect(m).not.toBe(blue);
    }
  });

  it('returns empty arrays for a root with no meshes', async () => {
    const { geometries, materials } = await extractModelGeometry(new THREE.Group());
    expect(geometries).toHaveLength(0);
    expect(materials).toHaveLength(0);
  });
});

describe('loadModels', () => {
  it('loads a model: fetches the base-aware URL, normalizes, merges', async () => {
    mockState.scene = makeTwoBoxScene();
    const { models, failed } = await loadModels(
      { tank: { path: 'tank.glb', scale: 1 } },
      { timeoutMs: 1000 },
    );
    expect(failed).toHaveLength(0);
    expect(mockState.lastUrl).toBe('/novaterra/models/tank.glb');
    const tank = models.get('tank');
    expect(tank).toBeDefined();
    expect(tank?.geometries).toHaveLength(1);
    expect(tank?.materials).toHaveLength(1);
  });

  it('records a 404 as failed and resolves with an empty map (never throws)', async () => {
    mockState.behavior = 'reject';
    const { models, failed } = await loadModels(
      { tank: { path: 'tank.glb', scale: 1 } },
      { timeoutMs: 1000 },
    );
    expect(models.size).toBe(0);
    expect(failed).toEqual(['tank']);
  });

  it('records a hung fetch as failed after the timeout (never pends)', async () => {
    mockState.behavior = 'hang';
    const start = Date.now();
    const { models, failed } = await loadModels(
      { tank: { path: 'tank.glb', scale: 1 } },
      { timeoutMs: 30 },
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(models.size).toBe(0);
    expect(failed).toEqual(['tank']);
  });

  it('continues past failures: successes and failures are both reported', async () => {
    mockState.scene = makeTwoBoxScene();
    mockState.failUrls = ['/novaterra/models/bad.glb'];
    const { models, failed } = await loadModels(
      {
        good: { path: 'good.glb', scale: 1 },
        bad: { path: 'bad.glb', scale: 1 },
      },
      { timeoutMs: 1000 },
    );
    expect(models.has('good')).toBe(true);
    expect(models.has('bad')).toBe(false);
    expect(failed).toEqual(['bad']);
  });

  it('handles an empty mapping', async () => {
    const { models, failed } = await loadModels({}, { timeoutMs: 100 });
    expect(models.size).toBe(0);
    expect(failed).toHaveLength(0);
  });

  it('uses the default 15s timeout constant', () => {
    expect(MODEL_LOAD_TIMEOUT_MS).toBe(15000);
  });
});

describe('disposeModels', () => {
  it('disposes every geometry and material in the map', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial();
    const geoSpy = vi.spyOn(geometry, 'dispose');
    const matSpy = vi.spyOn(material, 'dispose');
    disposeModels(
      new Map([['tank', { geometries: [geometry], materials: [material] }]]),
    );
    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an empty map', () => {
    expect(() => disposeModels(new Map())).not.toThrow();
  });
});
