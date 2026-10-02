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
 * NOVATERRA — render/placementGhost.ts — build-tool placement ghost
 * (roadmap B11, 2026-10-02).
 *
 * While a `building:<kind>` palette tool is armed, the map shows a
 * translucent footprint box under the cursor: green where the sim's
 * `validatePlacement` would accept the order, red where it would
 * reject it. The controller (ui/game.ts) owns one instance, feeds it
 * the hovered cell + validity each frame, and hides it when no
 * building tool is armed.
 *
 * Layout math (`ghostCenterWorld`, `GHOST_HEIGHT`) is pure and
 * headless-testable; the `PlacementGhost` class is the thin three.js
 * shell (one translucent box + edge lines = 2 draw calls, visible only
 * while a building tool is armed). Import-safe under Node/vitest:
 * `three` core has no DOM at import time.
 */

import * as THREE from 'three';
import { CELL_WORLD_SIZE, cellCenterWorld } from '../sim/city';

/** Ghost box height in world units — reads as a building volume. */
export const GHOST_HEIGHT = 3;
/** Ghost fill opacity (valid and invalid share it; color carries meaning). */
export const GHOST_OPACITY = 0.32;
/** Ghost colors: green = placement legal, red = the sim would reject. */
export const GHOST_COLOR_VALID = 0x51d651;
export const GHOST_COLOR_INVALID = 0xe04848;

/**
 * World-space center of a footprint anchored at cell (cx, cz) with the
 * given footprint (in cells). Pure — the controller and tests share it.
 */
export function ghostCenterWorld(c: number, footprintCells: number): number {
  return cellCenterWorld(c) + ((footprintCells - 1) * CELL_WORLD_SIZE) / 2;
}

/** Footprint of the ghost in world units (cells × CELL_WORLD_SIZE). */
export function ghostSizeWorld(footprintW: number, footprintH: number): { w: number; d: number } {
  return { w: footprintW * CELL_WORLD_SIZE, d: footprintH * CELL_WORLD_SIZE };
}

export class PlacementGhost {
  /** Add to the scene once; `show`/`hide` toggle visibility. */
  readonly group = new THREE.Group();
  private readonly fill: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private readonly edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;

  constructor() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: GHOST_COLOR_VALID,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false,
        // Exploration bet C7 (2026-10-02): the placement ghost is
        // gameplay information — immune to the day/night exposure lerp
        // so it stays readable at night (zero per-frame cost).
        toneMapped: false,
      }),
    );
    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({
        color: GHOST_COLOR_VALID,
        transparent: true,
        opacity: 0.9,
        // Exploration bet C7 (2026-10-02): see fill above.
        toneMapped: false,
      }),
    );
    this.edges.renderOrder = 5;
    this.fill.renderOrder = 4;
    this.group.add(this.fill, this.edges);
    this.group.visible = false;
  }

  /**
   * Show the ghost for a footprint anchored at (cx, cz). `groundY` is
   * the terrain height under the footprint center; `valid` colors it
   * green/red. Reused every frame — no allocations on the hot path
   * beyond the scale/position writes.
   */
  show(
    cx: number,
    cz: number,
    footprintW: number,
    footprintH: number,
    valid: boolean,
    groundY: number,
  ): void {
    const { w, d } = ghostSizeWorld(footprintW, footprintH);
    this.fill.scale.set(w, GHOST_HEIGHT, d);
    this.edges.scale.set(w, GHOST_HEIGHT, d);
    const color = valid ? GHOST_COLOR_VALID : GHOST_COLOR_INVALID;
    this.fill.material.color.setHex(color);
    this.edges.material.color.setHex(color);
    this.group.position.set(
      ghostCenterWorld(cx, footprintW),
      groundY + GHOST_HEIGHT / 2 + 0.05,
      ghostCenterWorld(cz, footprintH),
    );
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    this.fill.geometry.dispose();
    this.fill.material.dispose();
    this.edges.geometry.dispose();
    this.edges.material.dispose();
  }
}
