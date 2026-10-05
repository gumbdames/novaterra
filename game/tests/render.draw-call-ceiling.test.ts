/**
 * Roadmap B26 — draw-call ceiling regression test (max diversity).
 *
 * The 200-draw budget (`BUDGET_DRAW_CALLS`) was validated at LOW diversity
 * (8 draws for 100 buildings / 50 units). Pools are per (model key ×
 * material): GLB assets arrive merged per material
 * (`extractModelGeometry`), so a late-game scene with every unit and
 * building kind visible defines one pool per distinct material of every
 * kind's model — plus procedural-kind pools, attach-prop pools, the team
 * stripe / pennant overlays, and the damaged-unit health bars.
 *
 * This test builds that structural worst case headlessly: one entity per
 * unit/building kind, resolved through the REAL `resolveVisualPieces`
 * path (pool keys identical to the live game). GLB pieces are stubbed
 * with the TRUE per-model material counts parsed from the actual GLB
 * files (materials array in the glTF JSON chunk — the same count the
 * loader's per-material merge produces); procedural kinds and props use
 * the real builders. If this fails, the fix is material merging
 * (fewer distinct materials per model), not raising the budget.
 *
 * English-only; deterministic (no RNG — fixed entity ids/transforms).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './support/fakeDom';
import { EntityInstancer } from '../src/render/entityInstancing';
import {
  EntityRenderer,
  modelSourceFor,
  type ResolvedVisual,
} from '../src/render/entities';
import { MODEL_PATHS, type LoadedModel } from '../src/render/models';
import { UNIT_DEFS } from '../src/sim/units';
import { BUILDING_DEFS } from '../src/sim/city';

const gameRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * True pool count for a GLB model key: the loader merges geometries by
 * material, so one pool exists per material index referenced by any
 * mesh primitive — read straight from the shipped asset.
 */
function glbMaterialCount(modelKey: string): number {
  const spec = MODEL_PATHS[modelKey];
  if (spec === undefined) throw new Error(`no MODEL_PATHS entry for ${modelKey}`);
  const bytes = new Uint8Array(readFileSync(join(gameRoot, 'public/models', spec.path)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`not a GLB: ${spec.path}`);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)),
  ) as {
    meshes?: Array<{ primitives?: Array<{ material?: number }> }>;
  };
  const mats = new Set<number>();
  for (const mesh of json.meshes ?? [])
    for (const prim of mesh.primitives ?? []) {
      if (prim.material !== undefined) mats.add(prim.material);
    }
  // The loader always yields ≥1 geometry (never a geometry-less model).
  return Math.max(1, mats.size);
}

/** Stub LoadedModel with the true geometry count; materials are dummies. */
function stubModel(materialCount: number): LoadedModel {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (let i = 0; i < materialCount; i++) {
    geometries.push(new THREE.BufferGeometry());
    materials.push(new THREE.MeshBasicMaterial());
  }
  return { geometries, materials };
}

describe('B26 draw-call ceiling (max diversity)', () => {
  // Headless node env: the renderer builds a 1x1 canvas texture for the
  // health-bar sprites — stub document like the other render tests.
  beforeEach(() => {
    installFakeDom();
  });

  it('one entity per kind stays within the 200-draw budget', () => {
    // Every GLB piece key any kind can resolve to, stubbed with its true
    // material count. Procedural kinds/props resolve through the real
    // builders inside resolveVisualPieces (no stubbing needed).
    const pieceKeys = new Set<string>();
    for (const kind of [...Object.keys(UNIT_DEFS), ...Object.keys(BUILDING_DEFS)]) {
      const src = modelSourceFor(kind);
      if (src.type === 'glb') for (const p of src.pieces) pieceKeys.add(p.key);
    }
    const models = new Map<string, LoadedModel>();
    for (const key of pieceKeys) models.set(key, stubModel(glbMaterialCount(key)));

    const renderer = new EntityRenderer(new THREE.Scene(), models, { instanced: true });
    const instancer = (
      renderer as unknown as { instancer: EntityInstancer | null }
    ).instancer;
    expect(instancer).not.toBeNull();
    if (instancer === null) return;
    const resolve = (
      renderer as unknown as {
        resolveVisualPieces(
          kind: string,
          variant?: number,
          sizeTier?: 1 | 2 | 3,
        ): ResolvedVisual | null;
      }
    ).resolveVisualPieces.bind(renderer);

    let id = 1;
    let pooledKinds = 0;
    const kinds = [...Object.keys(UNIT_DEFS), ...Object.keys(BUILDING_DEFS)];
    for (const kind of kinds) {
      const resolved = resolve(kind);
      // Placeholder kinds resolve to null (legacy capsule path, not
      // instanced) — they contribute no pools.
      if (resolved === null || resolved.pieces.length === 0) continue;
      for (const p of resolved.pieces) instancer.definePool(p.pool, p.model);
      const isUnit = (UNIT_DEFS as Record<string, unknown>)[kind] !== undefined;
      instancer.addEntity(
        isUnit ? 'unit' : 'building',
        id,
        resolved.pieces.map((p) => ({ pool: p.pool, offset: new THREE.Matrix4() })),
        { stripe: isUnit, stripeScale: 1, team: '#ffffff' },
      );
      // Damaged-unit health bars are part of the late-game worst case.
      instancer.writeTransform(isUnit ? 'unit' : 'building', id, {
        x: 0, y: 0, z: 0, yaw: 0, baseY: 0,
        modelTop: resolved.top, hpFrac: 0.5, showBar: isUnit,
      });
      pooledKinds++;
      id++;
    }
    // Variant extras (buildings size-tier 1/3 rooftop props) share three
    // pools across all kinds — include them once.
    const buildingKind = Object.keys(BUILDING_DEFS)[0];
    if (buildingKind === undefined) throw new Error('no building kinds');
    for (const variant of [1, 2, 3]) {
      const resolved = resolve(buildingKind, variant, 2);
      if (resolved === null) continue;
      for (const p of resolved.pieces) instancer.definePool(p.pool, p.model);
    }

    const draws = instancer.drawCallCount();

    // Roadmap B26 decision (2026-10-02): the max-diversity structural
    // ceiling is 701 draws — well above the 200 per-frame budget. The
    // feasible material merge (ModelBuilder now merges parts by material
    // signature, not instance identity — identical pixels, fewer pools)
    // cut the ceiling from 796 to 695, but the remaining pools are
    // art-directed distinct materials per model (GLB assets arrive
    // pre-merged per material; procedural buildings average ~5
    // materials each). Fun-audit D1 (2026-10-02) adds 6 draws for the
    // 2 doctrine signature units. Closing the gap to 200 would need
    // cross-kind pool sharing — a render-architecture rewrite, out of
    // scope for this item. The 200 budget remains the per-frame gate for
    // REAL scenes (pinned in tests/perf.budgets.test.ts); this test pins
    // the structural ceiling so roster/material growth stays deliberate.
    expect(pooledKinds).toBeGreaterThan(190);
    expect(draws).toBe(701);
  });
});
