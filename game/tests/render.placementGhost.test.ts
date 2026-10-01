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
 * NOVATERRA — tests/render.placementGhost.test.ts (0.1 Alpha).
 *
 * Roadmap B11 (2026-10-02): the build-tool placement ghost —
 * `render/placementGhost.ts`. Pure layout math (headless) plus the
 * thin three.js shell's show/hide/validity coloring (three.js core is
 * import-safe under Node — no renderer, no DOM).
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PlacementGhost,
  ghostCenterWorld,
  ghostSizeWorld,
  GHOST_COLOR_INVALID,
  GHOST_COLOR_VALID,
  GHOST_HEIGHT,
  GHOST_OPACITY,
} from '../src/render/placementGhost';
import { CELL_WORLD_SIZE, cellCenterWorld } from '../src/sim/city';

describe('ghost layout math', () => {
  it('centers the footprint over its cells (min-corner anchor)', () => {
    // A 3-wide footprint anchored at cell 10 spans cells 10..12 —
    // the center is the middle cell's center.
    expect(ghostCenterWorld(10, 3)).toBeCloseTo(cellCenterWorld(11), 9);
    // A 1-wide footprint is just the cell's own center.
    expect(ghostCenterWorld(10, 1)).toBeCloseTo(cellCenterWorld(10), 9);
  });

  it('sizes the footprint in world units', () => {
    expect(ghostSizeWorld(2, 3)).toEqual({
      w: 2 * CELL_WORLD_SIZE,
      d: 3 * CELL_WORLD_SIZE,
    });
  });
});

describe('PlacementGhost shell', () => {
  it('is hidden until shown (two children = two draw calls)', () => {
    const ghost = new PlacementGhost();
    expect(ghost.group.visible).toBe(false);
    expect(ghost.group.children).toHaveLength(2);
    ghost.dispose();
  });

  it('shows green for legal placements at the footprint center', () => {
    const ghost = new PlacementGhost();
    ghost.show(10, 20, 2, 3, true, 5);
    expect(ghost.group.visible).toBe(true);
    const { w, d } = ghostSizeWorld(2, 3);
    expect(ghost.group.position.x).toBeCloseTo(
      cellCenterWorld(10) + ((2 - 1) * CELL_WORLD_SIZE) / 2,
      9,
    );
    expect(ghost.group.position.z).toBeCloseTo(
      cellCenterWorld(20) + ((3 - 1) * CELL_WORLD_SIZE) / 2,
      9,
    );
    // The box floats at ghost height above the ground (+0.05 ground
    // epsilon so it never z-fights the terrain).
    expect(ghost.group.position.y).toBeCloseTo(5 + GHOST_HEIGHT / 2 + 0.05, 9);
    const fill = ghost.group.children[0] as THREE.Mesh<
      THREE.BoxGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(fill.scale.x).toBeCloseTo(w, 9);
    expect(fill.scale.z).toBeCloseTo(d, 9);
    expect(fill.scale.y).toBeCloseTo(GHOST_HEIGHT, 9);
    expect(fill.material.color.getHex()).toBe(GHOST_COLOR_VALID);
    expect(fill.material.opacity).toBeCloseTo(GHOST_OPACITY, 9);
    const edges = ghost.group.children[1] as THREE.LineSegments<
      THREE.EdgesGeometry,
      THREE.LineBasicMaterial
    >;
    expect(edges.material.color.getHex()).toBe(GHOST_COLOR_VALID);
    ghost.dispose();
  });

  it('recolors red for illegal placements and stays shown', () => {
    const ghost = new PlacementGhost();
    ghost.show(10, 20, 2, 3, true, 5);
    ghost.show(11, 21, 2, 3, false, 6);
    expect(ghost.group.visible).toBe(true);
    const fill = ghost.group.children[0] as THREE.Mesh<
      THREE.BoxGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(fill.material.color.getHex()).toBe(GHOST_COLOR_INVALID);
    const edges = ghost.group.children[1] as THREE.LineSegments<
      THREE.EdgesGeometry,
      THREE.LineBasicMaterial
    >;
    expect(edges.material.color.getHex()).toBe(GHOST_COLOR_INVALID);
    ghost.dispose();
  });

  it('hides without losing its position (reshow is allocation-free)', () => {
    const ghost = new PlacementGhost();
    ghost.show(10, 20, 2, 3, true, 5);
    ghost.hide();
    expect(ghost.group.visible).toBe(false);
    ghost.show(10, 20, 2, 3, true, 5);
    expect(ghost.group.visible).toBe(true);
    ghost.dispose();
  });

  it('disposes geometry and materials without throwing', () => {
    const ghost = new PlacementGhost();
    expect(() => ghost.dispose()).not.toThrow();
  });
});
