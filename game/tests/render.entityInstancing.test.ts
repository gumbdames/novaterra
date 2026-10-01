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
 * Tests for render/entityInstancing.ts + the EntityRenderer instanced path
 * (Phase 0 workstream 1: the draw-call ceiling decision).
 *
 * - Pool discipline: one InstancedMesh per (pool key × material), dense
 *   swap-compacted storage, capacity doubling preserves instances.
 * - Draw-call scaling: N views of one kind cost a constant number of
 *   draws (model pools + stripe + pennant [+ 2 bar pools when damaged]),
 *   never O(N).
 * - Determinism: identical op sequences produce byte-identical instance
 *   matrices; render-side only (no sim state touched).
 * - Renderer integration: `instanced: true` routes model bodies, stripes,
 *   pennants, and health bars into pools; per-view groups stay empty but
 *   present; constructing buildings stay legacy until completion, then
 *   convert; empty model maps fall back to the legacy path.
 * - Disposal: shared geometries/materials are never disposed by the
 *   instancer; use-after-dispose throws.
 *
 * Headless (node env): `document` is stubbed for the health-bar canvas
 * texture; everything else is pure three.js scene graph work.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

import { EntityInstancer } from '../src/render/entityInstancing';
import { EntityRenderer } from '../src/render/entities';
import type { LoadedModel } from '../src/render/models';
import { UNIT_DEFS, type UnitKind, type UnitRecord } from '../src/sim/units';
import {
  BUILDING_DEFS,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import type { World } from '../src/sim/world';

// ---------------------------------------------------------------------------
// Minimal DOM stub (health-bar CanvasTexture only).
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (_tag: string) => ({
      width: 1,
      height: 1,
      getContext: () => ({ fillStyle: '', fillRect: () => {} }),
    }),
    documentElement: { classList: { contains: () => false } },
  });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function boxModel(color = 0x8899aa): LoadedModel {
  return {
    geometries: [new THREE.BoxGeometry(2, 1, 4)],
    materials: [new THREE.MeshStandardMaterial({ color, roughness: 0.8 })],
  };
}

/** Two-material model: one InstancedMesh per material. */
function twoMatModel(): LoadedModel {
  return {
    geometries: [new THREE.BoxGeometry(2, 1, 4), new THREE.BoxGeometry(1, 1, 1)],
    materials: [
      new THREE.MeshStandardMaterial({ color: 0x8899aa }),
      new THREE.MeshStandardMaterial({ color: 0xaa9988 }),
    ],
  };
}

const OFFSET = new THREE.Matrix4(); // identity entity-local offset

function addBoxEntity(
  inst: EntityInstancer,
  id: number,
  pool = 'tank',
  model?: LoadedModel,
): void {
  inst.definePool(pool, model ?? boxModel());
  inst.addEntity(id, [{ pool, offset: OFFSET.clone() }], {
    stripe: true,
    stripeScale: 1,
    team: '#3aa0ff',
  });
}

function writeAt(
  inst: EntityInstancer,
  id: number,
  x: number,
  showBar = false,
): void {
  inst.writeTransform(id, {
    x,
    y: 0,
    z: 0,
    yaw: 0,
    baseY: 0,
    modelTop: 1,
    hpFrac: 0.4,
    showBar,
  });
}

/** Count live render objects by kind under a scene. */
function countObjects(scene: THREE.Scene): {
  meshes: number;
  instanced: number;
  sprites: number;
} {
  let meshes = 0;
  let instanced = 0;
  let sprites = 0;
  scene.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) instanced++;
    else if ((o as THREE.Mesh).isMesh) meshes++;
    else if ((o as THREE.Sprite).isSprite) sprites++;
  });
  return { meshes, instanced, sprites };
}

let nextId = 1;

function fakeUnit(kind: UnitKind, hpFrac = 1): UnitRecord {
  const def = UNIT_DEFS[kind];
  return {
    id: nextId++,
    kind,
    domain: def.domain,
    owner: 0,
    x: 10,
    z: 20,
    speed: def.speed,
    hp: def.hp * hpFrac,
    cooldownLeft: 0,
    targetId: 0,
    chasing: false,
    state: 'idle',
    failReason: null,
    destX: 40,
    destZ: 20,
  } as UnitRecord;
}

function fakeBuilding(kind: BuildingKind, progress = 1): BuildingRecord {
  return {
    id: nextId++,
    kind,
    owner: 0,
    cx: 50,
    cz: 50,
    facing: 0,
    progress,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  };
}

function fakeWorld(
  units: UnitRecord[],
  buildings: BuildingRecord[],
): World {
  return {
    units,
    city: { buildings, roads: [] },
    superweapons: { fx: [] },
    tick: 0,
  } as unknown as World;
}

// ---------------------------------------------------------------------------
// EntityInstancer: pool discipline.
// ---------------------------------------------------------------------------

describe('EntityInstancer pools', () => {
  it('creates one InstancedMesh per material; definePool is idempotent', () => {
    const scene = new THREE.Scene();
    const inst = new EntityInstancer(scene);
    inst.definePool('tank', twoMatModel());
    inst.definePool('tank', twoMatModel()); // second call: no duplicates
    const stats = inst.poolStats().filter((s) => s.key.startsWith('tank#'));
    expect(stats).toHaveLength(2);
    expect(stats.map((s) => s.key).sort()).toEqual(['tank#0', 'tank#1']);
    inst.dispose();
  });

  it('add/remove keeps storage dense via swap-compaction', () => {
    const scene = new THREE.Scene();
    const inst = new EntityInstancer(scene);
    for (const id of [1, 2, 3]) addBoxEntity(inst, id);
    expect(inst.entityCount).toBe(3);

    inst.beginFrame();
    writeAt(inst, 1, 10);
    writeAt(inst, 2, 20);
    writeAt(inst, 3, 30);
    inst.endFrame();

    // Remove the middle entity: entity 3's instance must move into slot 1.
    inst.removeEntity(2);
    expect(inst.entityCount).toBe(2);
    const stats = inst.poolStats().find((s) => s.key === 'tank#0');
    expect(stats?.count).toBe(2);

    // Rewrite transforms; the moved entity must still land correctly.
    inst.beginFrame();
    writeAt(inst, 1, 11);
    writeAt(inst, 3, 33);
    inst.endFrame();
    const mats = inst.debugMatrices('tank');
    expect(mats).not.toBeNull();
    // Instance 0 = entity 1 at x=11, instance 1 = entity 3 at x=33
    // (translation lives in elements 12/13/14 of each 16-float matrix).
    expect(mats![12]).toBeCloseTo(11, 5);
    expect(mats![16 + 12]).toBeCloseTo(33, 5);
    inst.dispose();
  });

  it('grows pool capacity by doubling, preserving instances', () => {
    const scene = new THREE.Scene();
    const inst = new EntityInstancer(scene);
    const n = 20; // > INITIAL_POOL_CAPACITY (8)
    for (let id = 1; id <= n; id++) addBoxEntity(inst, id);
    inst.beginFrame();
    for (let id = 1; id <= n; id++) writeAt(inst, id, id * 2);
    inst.endFrame();
    const stats = inst.poolStats().find((s) => s.key === 'tank#0');
    expect(stats?.count).toBe(n);
    expect(stats!.capacity).toBeGreaterThanOrEqual(n);
    const mats = inst.debugMatrices('tank');
    expect(mats![12]).toBeCloseTo(2, 5); // entity 1 at x=2
    expect(mats![(n - 1) * 16 + 12]).toBeCloseTo(n * 2, 5);
    inst.dispose();
  });

  it('health bars cost 2 draw calls only while a damaged unit is shown', () => {
    const scene = new THREE.Scene();
    const inst = new EntityInstancer(scene);
    addBoxEntity(inst, 1);
    // Undamaged: model pool + stripe + pennant = 3 draws.
    inst.beginFrame();
    writeAt(inst, 1, 0, false);
    inst.endFrame();
    expect(inst.drawCallCount()).toBe(3);
    // Damaged: + bg + fg bar pools = 5 draws (not 5 per entity).
    addBoxEntity(inst, 2);
    inst.beginFrame();
    writeAt(inst, 1, 0, false);
    writeAt(inst, 2, 5, true);
    inst.endFrame();
    expect(inst.drawCallCount()).toBe(5);
    inst.dispose();
  });

  it('draw calls stay constant as entity count grows', () => {
    const scene = new THREE.Scene();
    const inst = new EntityInstancer(scene);
    for (let id = 1; id <= 60; id++) addBoxEntity(inst, id, 'tank');
    inst.beginFrame();
    for (let id = 1; id <= 60; id++) writeAt(inst, id, id, id % 2 === 0);
    inst.endFrame();
    // 1 model pool + stripe + pennant + 2 bar pools = 5, for 60 entities.
    expect(inst.drawCallCount()).toBe(5);
    inst.dispose();
  });

  it('identical op sequences produce byte-identical instance matrices', () => {
    const build = (): Float32Array | null => {
      const scene = new THREE.Scene();
      const inst = new EntityInstancer(scene);
      for (const id of [7, 3, 9]) addBoxEntity(inst, id, 'tank');
      inst.removeEntity(3);
      inst.beginFrame();
      writeAt(inst, 7, 1.5, true);
      writeAt(inst, 9, -2.25, false);
      inst.endFrame();
      const mats = inst.debugMatrices('tank');
      const out = mats === null ? null : mats.slice();
      inst.dispose();
      return out;
    };
    const a = build();
    const b = build();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.length).toBe(b!.length);
    expect(Array.from(a!)).toEqual(Array.from(b!));
  });

  it('renders exactly the live instance count (no ghost slots)', () => {
    const scene = new THREE.Scene();
    const inst = new EntityInstancer(scene);
    const model = boxModel();
    const findMesh = (): THREE.InstancedMesh => {
      let found: THREE.InstancedMesh | null = null;
      scene.traverse((o) => {
        const m = o as THREE.InstancedMesh;
        if (m.isInstancedMesh && m.geometry === model.geometries[0]) {
          found = m;
        }
      });
      if (found === null) throw new Error('pool mesh not found');
      return found;
    };
    for (const id of [1, 2, 3]) addBoxEntity(inst, id, 'tank', model);
    inst.beginFrame();
    writeAt(inst, 1, 0);
    writeAt(inst, 2, 0);
    writeAt(inst, 3, 0);
    inst.endFrame();
    // InstancedMesh renders mesh.count instances: it must track the live
    // slot count, never the allocated capacity (stale slots render as
    // ghost geometry at the origin).
    expect(findMesh().count).toBe(3);
    inst.removeEntity(2);
    inst.beginFrame();
    writeAt(inst, 1, 0);
    writeAt(inst, 3, 0);
    inst.endFrame();
    expect(findMesh().count).toBe(2);
    inst.dispose();
  });

  it('dispose releases instance attributes, never shared geo/mat', () => {
    const scene = new THREE.Scene();
    const inst = new EntityInstancer(scene);
    const model = boxModel();
    let sharedDisposed = false;
    model.geometries[0]!.addEventListener('dispose', () => {
      sharedDisposed = true;
    });
    inst.definePool('tank', model);
    addBoxEntity(inst, 1, 'tank', model);
    inst.beginFrame();
    writeAt(inst, 1, 0);
    inst.endFrame();
    inst.dispose();
    expect(sharedDisposed).toBe(false);
    expect(inst.entityCount).toBe(0);
    // Use after dispose throws loudly instead of corrupting state.
    expect(() => inst.addEntity(2, [], { stripe: false, stripeScale: 0, team: '#fff' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EntityRenderer integration (instanced: true).
// ---------------------------------------------------------------------------

describe('EntityRenderer instanced mode', () => {
  it('routes views into pools: constant draws for N views of one kind', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>([['tank', boxModel()]]);
    const renderer = new EntityRenderer(scene, models, { instanced: true });
    const units = Array.from({ length: 12 }, () => fakeUnit('tank'));
    renderer.sync(fakeWorld(units, []));
    const inst = renderer.debugInstancer;
    expect(inst).not.toBeNull();
    expect(inst!.entityCount).toBe(12);
    // 1 model pool + stripe + pennant; all undamaged so no bar pools.
    expect(inst!.drawCallCount()).toBe(3);
    const { meshes, instanced, sprites } = countObjects(scene);
    expect(sprites).toBe(0);
    // 3 instancer pools + 3 chevron level meshes (always in the scene,
    // hidden while no veteran is alive — zero draw calls when empty)
    // + 1 blob-shadow InstancedMesh (final-review R5 visual lift).
    expect(instanced).toBe(7);
    expect(meshes).toBe(0);
    renderer.dispose();
  });

  it('legacy mode keeps per-view groups (control case)', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>([['tank', boxModel()]]);
    const renderer = new EntityRenderer(scene, models);
    const units = Array.from({ length: 12 }, () => fakeUnit('tank'));
    renderer.sync(fakeWorld(units, []));
    expect(renderer.debugInstancer).toBeNull();
    const { instanced, sprites } = countObjects(scene);
    // 3 chevron level meshes (hidden, no veterans) + 1 blob-shadow
    // InstancedMesh (final-review R5 visual lift); legacy bodies are
    // per-view meshes, never instanced.
    expect(instanced).toBe(4);
    // Per-view meshes exist (hull + stripe + pennant each); no sprites
    // (all undamaged, bars hidden — visibility, not absence).
    expect(sprites).toBe(24); // bg+fg sprites exist per view, hidden
    renderer.dispose();
  });

  it('damaged units add exactly 2 bar draws in instanced mode', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>([['tank', boxModel()]]);
    const renderer = new EntityRenderer(scene, models, { instanced: true });
    const units = [fakeUnit('tank', 1), fakeUnit('tank', 0.4), fakeUnit('tank', 0.2)];
    renderer.sync(fakeWorld(units, []));
    const inst = renderer.debugInstancer!;
    // 1 model pool + stripe + pennant + 2 bar pools = 5 for 3 units.
    expect(inst.drawCallCount()).toBe(5);
    renderer.dispose();
  });

  it('unit death frees instance slots', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>([['tank', boxModel()]]);
    const renderer = new EntityRenderer(scene, models, { instanced: true });
    const units = [fakeUnit('tank'), fakeUnit('tank'), fakeUnit('tank')];
    renderer.sync(fakeWorld(units, []));
    const inst = renderer.debugInstancer!;
    expect(inst.entityCount).toBe(3);
    renderer.sync(fakeWorld([units[0]!, units[2]!], []));
    expect(inst.entityCount).toBe(2);
    expect(inst.drawCallCount()).toBe(3);
    renderer.dispose();
  });

  it('constructing buildings stay legacy, then convert on completion', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>([['house', boxModel()]]);
    const renderer = new EntityRenderer(scene, models, { instanced: true });
    const building = fakeBuilding('house', 0.5);
    renderer.sync(fakeWorld([], [building]));
    const inst = renderer.debugInstancer!;
    // Still constructing: legacy per-view meshes, nothing instanced.
    expect(inst.entityCount).toBe(0);
    let counts = countObjects(scene);
    expect(counts.meshes).toBeGreaterThan(0);
    // Only the 3 hidden chevron level meshes + the 1 blob-shadow
    // InstancedMesh are instanced while the building is still legacy.
    expect(counts.instanced).toBe(4);
    // Completing construction converts the view into the pools.
    building.progress = 1;
    renderer.sync(fakeWorld([], [building]));
    expect(inst.entityCount).toBe(1);
    counts = countObjects(scene);
    // house model pool + pennant (no stripe) + 3 hidden chevron meshes
    // + 1 blob-shadow InstancedMesh (final-review R5 visual lift).
    expect(counts.instanced).toBe(6);
    expect(counts.meshes).toBe(0);
    expect(inst.drawCallCount()).toBe(2);
    renderer.dispose();
  });

  it('empty model map falls back to the legacy path without crashing', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, new Map(), { instanced: true });
    // 'tank' is a GLB kind: with no models loaded and no procedural gap
    // model, it resolves to the placeholder → legacy groups.
    const units = [fakeUnit('tank'), fakeUnit('tank')];
    renderer.sync(fakeWorld(units, []));
    const inst = renderer.debugInstancer!;
    expect(inst.entityCount).toBe(0);
    const { instanced, meshes } = countObjects(scene);
    // Only the 3 hidden chevron level meshes + the 1 blob-shadow
    // InstancedMesh; bodies fall back to legacy.
    expect(instanced).toBe(4);
    expect(meshes).toBeGreaterThan(0);
    renderer.dispose();
  });

  it('syncing the same world twice is stable (no slot leaks)', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>([
      ['tank', boxModel()],
      ['house', boxModel(0x99aa88)],
    ]);
    const renderer = new EntityRenderer(scene, models, { instanced: true });
    const units = [fakeUnit('tank'), fakeUnit('tank', 0.3)];
    const buildings = [fakeBuilding('house')];
    const world = fakeWorld(units, buildings);
    renderer.sync(world);
    const inst = renderer.debugInstancer!;
    const first = inst.drawCallCount();
    const firstEntities = inst.entityCount;
    renderer.sync(world);
    renderer.sync(world);
    expect(inst.entityCount).toBe(firstEntities);
    expect(inst.drawCallCount()).toBe(first);
    renderer.dispose();
  });
});
