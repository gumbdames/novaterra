/**
 * Underground / x-ray view (0.1 Alpha).
 *
 * Water pipes are hard to spot on the normal map (thin ground-hugging
 * ribbons in terrain colors), so this mode ghosts the terrain + water
 * and draws the pipe network bright with depth testing off — the pipes
 * read through the faded ground. It coexists with every other overlay:
 * the zone decals, paving, utility/logistics/desirability tints and the
 * grid overlay keep drawing (they are translucent ground decals that
 * stay legible over ghosted terrain), and entities are untouched.
 *
 * Layering contract (documented here because three modes share the
 * ground plane):
 *   - terrain chunks: opaque normally; x-ray ⇒ transparent, opacity
 *     `XRAY_TERRAIN_OPACITY`, depthWrite off (renderOrder 0).
 *   - water plane: opacity 0.72 normally; x-ray ⇒ `XRAY_WATER_OPACITY`.
 *   - pipe ribbon: x-ray ⇒ emissive-bright + depthTest off +
 *     renderOrder 10 (drawn after the ghosted terrain, always legible).
 *   - zone/paving/utility/logistics/desirability/grid decals: unchanged
 *     (their +0.05…+0.18 terrain offsets already stack above the pipes'
 *     +0.06, so nothing z-fights).
 *
 * `XrayView` owns no materials — it borrows the terrain/water materials
 * (late-bound via `setTerrainMaterials`, because the `TerrainView` is
 * built before the `EntityRenderer`) and drives the pipe treatment
 * through a callback into `NetworkOverlay.setXray`. Owned by
 * `EntityRenderer` (`setXrayVisible`); the HUD topbar owns the toggle
 * button and game.ts auto-enables x-ray while the water-pipe tool is
 * armed.
 *
 * Import-safe under Node/vitest.
 */

import * as THREE from 'three';

/** Ghosted-terrain opacity in x-ray mode (terrain still reads as land). */
export const XRAY_TERRAIN_OPACITY = 0.25;
/** Water opacity in x-ray mode (down from the normal 0.72). */
export const XRAY_WATER_OPACITY = 0.15;

interface SavedMaterialState {
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
}

/**
 * Ghost a material for x-ray mode, saving its state for restoration.
 * Pure helper — Node-testable without a renderer.
 */
export function ghostMaterialForXray(
  mat: THREE.Material,
  opacity: number,
): SavedMaterialState {
  const saved: SavedMaterialState = {
    transparent: mat.transparent,
    opacity: mat.opacity,
    depthWrite: mat.depthWrite,
  };
  mat.transparent = true;
  mat.opacity = opacity;
  mat.depthWrite = false;
  mat.needsUpdate = true;
  return saved;
}

/** Restore a material ghosted by `ghostMaterialForXray`. */
export function restoreMaterial(mat: THREE.Material, saved: SavedMaterialState): void {
  mat.transparent = saved.transparent;
  mat.opacity = saved.opacity;
  mat.depthWrite = saved.depthWrite;
  mat.needsUpdate = true;
}

export class XrayView {
  private terrain: THREE.Material | null = null;
  private water: THREE.Material | null = null;
  private savedTerrain: SavedMaterialState | null = null;
  private savedWater: SavedMaterialState | null = null;
  private readonly applyPipeXray: (on: boolean) => void;
  private isVisible = false;

  /**
   * @param applyPipeXray callback into the pipe network's x-ray
   *   treatment (`NetworkOverlay.setXray` via the EntityRenderer).
   */
  constructor(applyPipeXray: (on: boolean) => void) {
    this.applyPipeXray = applyPipeXray;
  }

  /** Late-bind the terrain + water materials (borrowed, never disposed). */
  setTerrainMaterials(terrain: THREE.Material, water: THREE.Material): void {
    // If x-ray is on while materials are swapped, restore-then-reghost
    // so the saved state always matches the live material.
    const wasVisible = this.isVisible;
    if (wasVisible) this.setVisible(false);
    this.terrain = terrain;
    this.water = water;
    if (wasVisible) this.setVisible(true);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  setVisible(v: boolean): void {
    if (v === this.isVisible) return;
    this.isVisible = v;
    if (v) {
      if (this.terrain !== null) {
        this.savedTerrain = ghostMaterialForXray(this.terrain, XRAY_TERRAIN_OPACITY);
      }
      if (this.water !== null) {
        this.savedWater = ghostMaterialForXray(this.water, XRAY_WATER_OPACITY);
      }
    } else {
      if (this.terrain !== null && this.savedTerrain !== null) {
        restoreMaterial(this.terrain, this.savedTerrain);
        this.savedTerrain = null;
      }
      if (this.water !== null && this.savedWater !== null) {
        restoreMaterial(this.water, this.savedWater);
        this.savedWater = null;
      }
    }
    this.applyPipeXray(v);
  }
}
