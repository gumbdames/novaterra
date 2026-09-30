/**
 * Terrain grid overlay tests (Phase 4 RENDER workstream A, follow-up B,
 * 0.1 Alpha). `buildGridGeometry` is pure (Node-safe); `GridView`
 * constructs on a headless THREE.Scene (no DOM, no renderer).
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CELL_WORLD_SIZE, CITY_GRID_CELLS } from '../src/sim/city';
import {
  GRID_DRAPE_STEP,
  GRID_HALF_EXTENT,
  GRID_OPACITY,
  GRID_SPACING,
  GRID_TERRAIN_OFFSET,
  GridView,
  buildGridGeometry,
} from '../src/render/gridView';

describe('grid constants', () => {
  it('spans the whole map with district-scale spacing', () => {
    expect(GRID_HALF_EXTENT).toBe((CITY_GRID_CELLS * CELL_WORLD_SIZE) / 2);
    expect(GRID_HALF_EXTENT).toBe(256);
    expect(GRID_SPACING).toBe(16 * CELL_WORLD_SIZE);
    expect(GRID_SPACING).toBe(32);
    expect(GRID_TERRAIN_OFFSET).toBeGreaterThan(0);
    expect(GRID_OPACITY).toBeGreaterThan(0);
    expect(GRID_OPACITY).toBeLessThan(0.5); // subtle
  });
});

describe('buildGridGeometry', () => {
  it('covers [-half, +half]² with lines every spacing', () => {
    const geo = buildGridGeometry(GRID_HALF_EXTENT, GRID_SPACING);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      expect(x).toBeGreaterThanOrEqual(-GRID_HALF_EXTENT);
      expect(x).toBeLessThanOrEqual(GRID_HALF_EXTENT);
      expect(z).toBeGreaterThanOrEqual(-GRID_HALF_EXTENT);
      expect(z).toBeLessThanOrEqual(GRID_HALF_EXTENT);
    }
    // Each segment pair shares one coordinate — the line's position —
    // which must sit on the spacing lattice; the other coordinate walks
    // the drape step.
    for (let i = 0; i < pos.count; i += 2) {
      const ax = pos.getX(i);
      const az = pos.getZ(i);
      const bx = pos.getX(i + 1);
      const bz = pos.getZ(i + 1);
      const linePos = ax === bx ? ax : az; // x-line ⇒ z = c; z-line ⇒ x = c
      if (ax !== bx) expect(az).toBe(bz);
      const lattice = (linePos + GRID_HALF_EXTENT) / GRID_SPACING;
      expect(Math.abs(lattice - Math.round(lattice))).toBeLessThan(1e-6);
    }
    // 17 lines per direction × 64 drape segments × 2 endpoints.
    const segments = (GRID_HALF_EXTENT * 2) / GRID_DRAPE_STEP; // 64
    const lines = (GRID_HALF_EXTENT * 2) / GRID_SPACING + 1; // 17
    expect(pos.count).toBe(lines * segments * 2 * 2);
  });

  it('is flat at the offset with no height sampler', () => {
    const geo = buildGridGeometry(GRID_HALF_EXTENT, GRID_SPACING);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i += 1) {
      // Float32 storage: compare with tolerance.
      expect(pos.getY(i)).toBeCloseTo(GRID_TERRAIN_OFFSET, 6);
    }
  });

  it('drapes on the height sampler', () => {
    const heightFn = (x: number, z: number): number => x * 0.1 + z * 0.05;
    const geo = buildGridGeometry(GRID_HALF_EXTENT, GRID_SPACING, heightFn);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Float32 storage: 4-digit tolerance at these magnitudes.
      expect(pos.getY(i)).toBeCloseTo(heightFn(x, z) + GRID_TERRAIN_OFFSET, 4);
    }
  });
});

describe('GridView', () => {
  it('starts hidden with zero extra draw calls, toggles on/off', () => {
    const scene = new THREE.Scene();
    const view = new GridView(scene);
    expect(view.visible).toBe(false);
    const mesh = scene.getObjectByName('terrain-grid');
    expect(mesh).toBeDefined();
    expect(mesh?.visible).toBe(false);
    view.setVisible(true);
    expect(view.visible).toBe(true);
    expect(mesh?.visible).toBe(true);
    view.setVisible(false);
    expect(view.visible).toBe(false);
    expect(mesh?.visible).toBe(false);
    // One LineSegments draw call total (the whole grid is one mesh).
    const lineMeshes = scene.children.filter(
      (c) => c instanceof THREE.LineSegments,
    );
    expect(lineMeshes).toHaveLength(1);
    view.dispose();
  });

  it('is a subtle transparent overlay that never occludes entities', () => {
    const scene = new THREE.Scene();
    const view = new GridView(scene);
    const mesh = scene.getObjectByName(
      'terrain-grid',
    ) as THREE.LineSegments;
    const mat = mesh.material as THREE.LineBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBe(GRID_OPACITY);
    expect(mat.depthWrite).toBe(false);
    view.dispose();
  });

  it('dispose removes the mesh from the scene', () => {
    const scene = new THREE.Scene();
    const view = new GridView(scene);
    expect(scene.getObjectByName('terrain-grid')).toBeDefined();
    view.dispose();
    expect(scene.getObjectByName('terrain-grid')).toBeUndefined();
  });
});
