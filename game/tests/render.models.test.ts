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
  lastBytes: null as number | null,
  lastFetchUrl: null as string | null,
}));

vi.mock('three/addons/loaders/GLTFLoader.js', () => {
  class FakeGLTFLoader {
    async parseAsync(data: ArrayBuffer, path: string): Promise<{ scene: THREE.Object3D }> {
      mockState.lastUrl = path;
      mockState.lastBytes = data.byteLength;
      if (mockState.behavior === 'reject' || mockState.failUrls.includes(path)) {
        throw new Error('404 Not Found');
      }
      if (mockState.behavior === 'hang') {
        return new Promise<{ scene: THREE.Object3D }>(() => {
          /* pends forever, like a stalled parse */
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
  mockState.lastBytes = null;
  // Route the Cache-API fetch layer at a fake network: resolve = 200 with
  // dummy bytes, reject/hang driven by the same hoisted behavior.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      mockState.lastFetchUrl = url;
      if (mockState.behavior === 'hang') {
        return new Promise<Response>(() => {
          /* pends forever, like a stalled CDN fetch */
        });
      }
      if (mockState.behavior === 'reject' || mockState.failUrls.includes(url)) {
        return new Response('not found', { status: 404 });
      }
      return new Response(new ArrayBuffer(16), { status: 200 });
    }),
  );
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

describe('MODEL_PATHS real mapping', () => {
  it('maps 61 CC0 keys to .glb paths with positive finite scales', () => {
    const keys = Object.keys(MODEL_PATHS);
    expect(keys).toHaveLength(61);
    for (const [key, spec] of Object.entries(MODEL_PATHS)) {
      expect(typeof key).toBe('string');
      expect(spec.path).toMatch(/\.glb$/);
      expect(spec.scale).toBeGreaterThan(0);
      expect(Number.isFinite(spec.scale)).toBe(true);
      if (spec.rotY !== undefined) expect(Number.isFinite(spec.rotY)).toBe(true);
      if (spec.yOffset !== undefined) expect(Number.isFinite(spec.yOffset)).toBe(true);
    }
  });

  it('covers the documented key set (units, building pieces, nature props)', () => {
    const expected = [
      // units (1:1)
      'engineer', 'rifles', 'tank', 'hauler', 'spectre', 'hq',
      'patrolBoat', 'transportShip',
      // NOVATERRA roster-expansion units (1:1)
      'sniperTeam', 'combatMedic', 'tankDestroyer', 'awacs',
      'missileBoat', 'commandShip', 'fishingBoat',
      // building pieces (composites assemble several)
      'house', 'apartment', 'shop', 'lab', 'factory', 'waterPump',
      'aegisMain', 'farmBarn', 'farmSilo', 'powerPlantMain',
      'powerPlantChimney', 'shipyardCrane', 'shipyardMachine',
      // NOVATERRA roster-expansion building pieces
      'barracks', 'warFactoryMain', 'industrialStack', 'airfieldHangar',
      'airfieldHangar2', 'navalYardCrane', 'navalYardHall', 'radarStation',
      'oilRefineryTank', 'industrialTank', 'recyclingCenter', 'market',
      'solarFarmA', 'solarFarmB', 'nuclearPlantMain', 'desalinationHall',
      'hospital', 'university', 'school',
      // NOVATERRA Phase 1 (veterancy)
      'militaryAcademy',
      // NOVATERRA Workstream Z (education ladder)
      'kindergarten', 'college',
      // nature props (tree keys are overlaid by render/natureTrees.ts at
      // game start; the GLB paths here are the silent fallback)
      'propTreeOak', 'propTreeBirch', 'propTreePineTall', 'propTreePine',
      'propTreeOldOak', 'propTreePoplar', 'propRockLarge', 'propRockTall',
      'propRockSmall', 'propBushDetailed', 'propBushLarge',
    ];
    expect(Object.keys(MODEL_PATHS).sort()).toEqual([...expected].sort());
  });

  it('bakes the documented yaw corrections and boat waterline offsets', () => {
    expect(MODEL_PATHS['tank']?.rotY).toBeCloseTo(Math.PI / 2, 10);
    expect(MODEL_PATHS['hauler']?.rotY).toBeCloseTo(Math.PI, 10);
    expect(MODEL_PATHS['spectre']?.rotY).toBeCloseTo(Math.PI, 10);
    expect(MODEL_PATHS['hq']?.rotY).toBeCloseTo(Math.PI, 10);
    expect(MODEL_PATHS['transportShip']?.rotY).toBeCloseTo(Math.PI, 10);
    // NOVATERRA roster expansion: tankDestroyer's Quaternius tank is
    // authored facing +x (yaw π/2 like the original tank); the AWACS
    // cargo plane, command ship, and fishing boat follow the +z-bow
    // convention (yaw π).
    expect(MODEL_PATHS['tankDestroyer']?.rotY).toBeCloseTo(Math.PI / 2, 10);
    expect(MODEL_PATHS['awacs']?.rotY).toBeCloseTo(Math.PI, 10);
    expect(MODEL_PATHS['commandShip']?.rotY).toBeCloseTo(Math.PI, 10);
    expect(MODEL_PATHS['fishingBoat']?.rotY).toBeCloseTo(Math.PI, 10);
    // Boats sink (negative yOffset) so the waterline sits partway up the
    // hull instead of at the keel — never a positive (hovering) offset.
    for (const key of ['patrolBoat', 'transportShip', 'missileBoat', 'commandShip', 'fishingBoat']) {
      const yOffset = MODEL_PATHS[key]?.yOffset;
      expect(yOffset).toBeDefined();
      expect(yOffset as number).toBeLessThan(0);
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
    // parseAsync gets the model's DIRECTORY as the texture resource path
    // (three string-concatenates it with texture URIs — the GLB file URL
    // would resolve textures to `<name>.glbTextures/...`).
    expect(mockState.lastUrl).toBe('/novaterra/models/');
    const tank = models.get('tank');
    expect(tank).toBeDefined();
    expect(tank?.geometries).toHaveLength(1);
    expect(tank?.materials).toHaveLength(1);
  });

  it('bakes rotY into the geometry: yaw-corrected before normalization', async () => {
    // Two boxes, different materials (stay separate after merge) and
    // different heights (distinguishable): the tall one is authored at -x.
    const scene = new THREE.Group();
    const tall = new THREE.Mesh(
      new THREE.BoxGeometry(2, 4, 2),
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
    );
    tall.position.set(-3, 2, 0);
    const short = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshStandardMaterial({ color: 0x0000ff }),
    );
    short.position.set(5, 1, 0);
    scene.add(tall, short);
    mockState.scene = scene;
    const tallCenterX = async (rotY?: number): Promise<number> => {
      const { models } = await loadModels(
        { k: { path: 'k.glb', scale: 1, rotY } },
        { timeoutMs: 1000 },
      );
      const geos = models.get('k')?.geometries ?? [];
      let best = 0;
      let bestSpan = -1;
      geos.forEach((g, i) => {
        g.computeBoundingBox();
        const bb = g.boundingBox;
        if (bb === null) return;
        const span = bb.max.y - bb.min.y;
        if (span > bestSpan) {
          bestSpan = span;
          best = i;
        }
      });
      const g = geos[best];
      if (g === undefined) throw new Error('no geometries');
      g.computeBoundingBox();
      const bb = g.boundingBox;
      if (bb === null) throw new Error('no bounding box');
      return (bb.min.x + bb.max.x) / 2;
    };
    // Tall box authored at -x stays at -x without rotY...
    expect(await tallCenterX(undefined)).toBeLessThan(0);
    // ...and mirrors to +x with rotY π (yaw baked before centering).
    expect(await tallCenterX(Math.PI)).toBeGreaterThan(0);
  });

  it('applies yOffset after normalization: base rests at yOffset', async () => {
    mockState.scene = makeTwoBoxScene();
    const { models } = await loadModels(
      { boat: { path: 'boat.glb', scale: 1, yOffset: -0.3 } },
      { timeoutMs: 1000 },
    );
    const boat = models.get('boat');
    expect(boat).toBeDefined();
    const geo = boat?.geometries[0];
    expect(geo).toBeDefined();
    geo?.computeBoundingBox();
    // Base at -0.3 (sunk), not 0: the waterline sits up the hull.
    expect(geo?.boundingBox?.min.y).toBeCloseTo(-0.3, 6);
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

  it('also disposes textures referenced by the materials (once each)', () => {
    const texture = new THREE.Texture();
    const texSpy = vi.spyOn(texture, 'dispose');
    const a = new THREE.MeshStandardMaterial({ map: texture });
    const b = new THREE.MeshStandardMaterial({ map: texture });
    disposeModels(new Map([['tank', { geometries: [], materials: [a, b] }]]));
    expect(texSpy).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an empty map', () => {
    expect(() => disposeModels(new Map())).not.toThrow();
  });
});
