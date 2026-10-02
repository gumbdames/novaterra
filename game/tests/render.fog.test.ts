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
 * NOVATERRA — tests/render.fog.test.ts — fun-audit C3 (2026-10-02):
 * the fog-of-war render side.
 *
 * Covers:
 *  - `fogCellColor`: the single source of truth for shroud styling
 *    (visible = transparent, explored = dim memory, unexplored = dark);
 *  - `paintFogTexture`: the 64x64 RGBA paint from explored memory +
 *    the visibility grid (pure);
 *  - `FogShroud` (headless three.js): exactly one scene object (+1
 *    draw call), 65x65 height-conforming verts, update() repaints from
 *    sim state, dispose() removes the mesh;
 *  - `collectBlobShadows`' fog gate: hidden entities cast no shadow
 *    (a shadow with no body would leak positions through the fog).
 *
 * All headless — no DOM, no canvas, no wall clock.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FOG_EXPLORED,
  FOG_UNEXPLORED,
  FOG_VISIBLE,
  fogCellColor,
  FogShroud,
  paintFogTexture,
} from '../src/render/fog';
import { FOG_GRID } from '../src/sim/fog';
import { collectBlobShadows } from '../src/render/blobShadows';
import { createWorld, type World } from '../src/sim/world';
import { spawnUnit, type UnitRecord } from '../src/sim/units';
import { computeVisibleCells, fogCellIndex, updateFog } from '../src/sim/fog';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';

describe('fogCellColor', () => {
  it('visible always wins (fully transparent)', () => {
    expect(fogCellColor(false, true)).toEqual(FOG_VISIBLE);
    expect(fogCellColor(true, true)).toEqual(FOG_VISIBLE);
    expect(FOG_VISIBLE[3]).toBe(0);
  });

  it('explored-but-unseen is a dim memory tint', () => {
    expect(fogCellColor(true, false)).toEqual(FOG_EXPLORED);
    expect(FOG_EXPLORED[3]).toBeGreaterThan(0);
    expect(FOG_EXPLORED[3]).toBeLessThan(FOG_UNEXPLORED[3]);
  });

  it('unexplored is the dark shroud', () => {
    expect(fogCellColor(false, false)).toEqual(FOG_UNEXPLORED);
  });
});

describe('paintFogTexture', () => {
  function worldWithFog(): { world: World; out: Uint8Array } {
    const world = createWorld(20261002);
    // One tank at the origin: explores its own neighbourhood.
    spawnUnit(world, 'tank', 0, 0, 0);
    updateFog(world);
    // Move the tank away (staying on the map) so its old cell is
    // explored-but-not-visible.
    world.units[0]!.x = 200;
    world.units[0]!.z = 0;
    updateFog(world);
    return { world, out: new Uint8Array(FOG_GRID * FOG_GRID * 4) };
  }

  it('paints visible transparent, explored dim, unexplored dark', () => {
    const { world, out } = worldWithFog();
    const visible = computeVisibleCells(world, 0);
    paintFogTexture(world, 0, visible, out);
    const at = (x: number, z: number): number[] => {
      const o = fogCellIndex(x, z) * 4;
      return [out[o] ?? -1, out[o + 1] ?? -1, out[o + 2] ?? -1, out[o + 3] ?? -1];
    };
    // Currently visible (under the moved tank): transparent.
    expect(at(200, 0)).toEqual([...FOG_VISIBLE]);
    // Explored earlier, not visible now: dim memory tint.
    expect(at(0, 0)).toEqual([...FOG_EXPLORED]);
    // Never seen: dark shroud.
    expect(at(-200, -200)).toEqual([...FOG_UNEXPLORED]);
  });

  it('writes exactly one RGBA quad per cell', () => {
    const { world, out } = worldWithFog();
    paintFogTexture(world, 0, computeVisibleCells(world, 0), out);
    expect(out.length).toBe(FOG_GRID * FOG_GRID * 4);
  });
});

describe('FogShroud (headless)', () => {
  function shroudScene() {
    const scene = new THREE.Scene();
    const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
    const shroud = new FogShroud(scene, terrain);
    return { scene, shroud };
  }

  it('adds exactly one object to the scene (+1 draw call)', () => {
    const { scene, shroud } = shroudScene();
    const shrouds = scene.children.filter((c) => c.name === 'fogShroud');
    expect(shrouds).toHaveLength(1);
    shroud.dispose();
    expect(scene.children.filter((c) => c.name === 'fogShroud')).toHaveLength(0);
  });

  it('builds a 65x65 height-conforming grid', () => {
    const { shroud } = shroudScene();
    const mesh = (shroud as unknown as { mesh: THREE.Mesh }).mesh;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe((FOG_GRID + 1) * (FOG_GRID + 1));
    // The shroud floats above the terrain (lift 0.6 over the heightfield).
    for (let i = 0; i < pos.count; i += 97) {
      expect(pos.getY(i)).toBeGreaterThan(-50);
    }
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.fog).toBe(false);
    shroud.dispose();
  });

  it('update() repaints from sim state; setVisible toggles the mesh', () => {
    const { scene, shroud } = shroudScene();
    const world = createWorld(20261002);
    spawnUnit(world, 'tank', 0, 0, 0);
    updateFog(world);
    const cells = computeVisibleCells(world, 0);
    shroud.update(world, 0, cells);
    const paint = (shroud as unknown as { paint: Uint8Array }).paint;
    const o = fogCellIndex(0, 0) * 4;
    // The tank's own cell is visible: transparent.
    expect(paint[o + 3]).toBe(0);
    const far = fogCellIndex(-200, -200) * 4;
    // Far away and unexplored: dark shroud.
    expect(paint[far + 3]).toBe(FOG_UNEXPLORED[3]);
    // Visibility toggle.
    shroud.setVisible(false);
    const mesh = scene.children.find((c) => c.name === 'fogShroud')!;
    expect(mesh.visible).toBe(false);
    shroud.setVisible(true);
    expect(mesh.visible).toBe(true);
    shroud.dispose();
  });
});

describe('collectBlobShadows fog gate', () => {
  let nextId = 1000;
  const unit = (owner: number, x: number): UnitRecord =>
    ({
      id: nextId++,
      kind: 'tank',
      domain: 'land',
      owner,
      x,
      z: 10,
      hp: 100,
    }) as unknown as UnitRecord;
  const flat = (_x: number, _z: number, _d: 'land' | 'air' | 'sea') => 5;

  it('skips entities the fog gate flags as hidden', () => {
    const seen = unit(0, 0);
    const hidden = unit(1, 50);
    const world = { units: [seen, hidden], city: { buildings: [] } } as unknown as World;
    const entries = collectBlobShadows(world, flat, 512, (owner, id) => owner === 1 && id === hidden.id);
    expect(entries.map((e) => e.x)).toEqual([seen.x]);
  });

  it('without a gate every living unit shadows as before', () => {
    const world = { units: [unit(0, 0), unit(1, 50)], city: { buildings: [] } } as unknown as World;
    expect(collectBlobShadows(world, flat)).toHaveLength(2);
  });
});
