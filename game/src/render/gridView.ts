/**
 * Terrain grid overlay (0.1 Alpha).
 *
 * Phase 4 RENDER workstream A (follow-up B): a subtle always-draped
 * survey grid for the map — one `LineSegments` draw call, hidden by
 * default, toggled from the top bar ("Grid" button) or the `G` key.
 *
 * Layering contract (shared with the x-ray view in `render/xrayView.ts`
 * and the utility indicators in `render/utilityIndicators.ts`):
 *   - terrain chunks: opaque normally; x-ray ⇒ transparent 0.25.
 *   - ground decals: zone +0.05, pipes +0.06, roads +0.08, grid +0.09,
 *     utility tints +0.12 (all terrain-draped, none z-fight: the grid
 *     sits above the pipes and roads, below the diagnosis tints).
 *   - entities (units/buildings/people): 3D, always above the grid.
 *   - x-ray mode: the grid is unaffected (its own opacity) and stays
 *     legible over the ghosted terrain; the glowing pipes
 *     (renderOrder 10, no depth test) draw after it.
 *
 * The lines drape on the terrain via a `heightFn` (the same `heightAt`
 * callback the roads and pipes use); without it the grid is built flat
 * (headless path). Built once — the terrain never changes mid-session.
 *
 * Import-safe under Node/vitest.
 */

import * as THREE from 'three';

import { CELL_WORLD_SIZE, CITY_GRID_CELLS } from '../sim/city';

/** Half the map extent in world units (the grid spans the whole map). */
export const GRID_HALF_EXTENT = (CITY_GRID_CELLS * CELL_WORLD_SIZE) / 2;
/** Line spacing in world units (16 cells — a district-scale survey grid). */
export const GRID_SPACING = 16 * CELL_WORLD_SIZE;
/** Subdivision step along each line for terrain draping. */
export const GRID_DRAPE_STEP = 8;
/**
 * Terrain offset: above the zone decals (+0.05), pipes (+0.06) and road
 * ribbons (+0.08), below the utility diagnosis tints (+0.12).
 */
export const GRID_TERRAIN_OFFSET = 0.09;
/** Subtle white lines (they annotate, never shout). */
export const GRID_OPACITY = 0.22;

/**
 * Build the draped grid geometry: lines every `GRID_SPACING` world
 * units across [-half, +half]², subdivided every `GRID_DRAPE_STEP`
 * units so they hug hills. Pure — Node-testable without a renderer.
 */
export function buildGridGeometry(
  half: number,
  spacing: number,
  heightFn?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const step = GRID_DRAPE_STEP;
  const y = (x: number, z: number): number =>
    (heightFn !== undefined ? heightFn(x, z) : 0) + GRID_TERRAIN_OFFSET;
  // One vertex pair per drape segment, both line directions.
  for (let c = -half; c <= half + 1e-6; c += spacing) {
    for (let a = -half; a < half - 1e-6; a += step) {
      const b = Math.min(a + step, half);
      // Line along x at z = c.
      positions.push(a, y(a, c), c, b, y(b, c), c);
      // Line along z at x = c.
      positions.push(c, y(c, a), a, c, y(c, b), b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

export class GridView {
  private readonly mesh: THREE.LineSegments;
  private isVisible = false;

  /**
   * @param heightFn terrain height sampler (drapes the lines); omit
   *   for a flat grid (headless/tests).
   */
  constructor(scene: THREE.Scene, heightFn?: (x: number, z: number) => number) {
    const geo = buildGridGeometry(GRID_HALF_EXTENT, GRID_SPACING, heightFn);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: GRID_OPACITY,
      depthWrite: false,
    });
    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.name = 'terrain-grid';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false; // hidden by default — toggle to show
    this.mesh.renderOrder = 3; // above ground decals, below markers
    scene.add(this.mesh);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  /** Toggle the grid (top-bar "Grid" button / the G key). */
  setVisible(v: boolean): void {
    this.isVisible = v;
    this.mesh.visible = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
