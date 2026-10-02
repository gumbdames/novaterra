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
 * NOVATERRA — render/luminaryMarkers.ts — luminary ceremony markers.
 *
 * Fun-audit Tier 4 (E2, 2026-10-02): two tiny markers, both gold (the
 * luminary palette):
 *  - a flat gold ring under the luminary guest (kind `luminary`) — the
 *    plan's "a real unit with a gold ring", so the player can find the
 *    guest at their capital;
 *  - small floating gold diamonds above enemy production buildings
 *    marked by a turned Defector (`world.luminaries.productionMarks`).
 *
 * At most 1 ring + 6 diamonds: plain THREE meshes (no instancing),
 * hidden when idle (0 draw calls when no luminary is active). Reads
 * `world` directly in `sync`; the sim owns the marks.
 *
 * Import-safe under Node/vitest: `three` core has no DOM at import
 * time; geometry/material construction happens in the constructor
 * (browser-only, like the other overlays).
 */
import * as THREE from 'three';
import type { World } from '../sim/world';
import type { TerrainData } from '../sim/terrain';
import { cellCenterWorld } from '../sim/city';
import { groundYAt } from './terrainHeight';

/** Gold material color for the luminary markers. */
export const LUMINARY_GOLD = 0xc9a227;
/** Ring radius under the guest (world units). */
export const LUMINARY_RING_RADIUS = 2.2;
/** Diamond size above marked buildings (world units). */
export const MARK_DIAMOND_SIZE = 1.2;
/** Diamond hover height above the building top (world units). */
export const MARK_DIAMOND_HOVER = 3.0;

export class LuminaryMarkers {
  private readonly ring: THREE.Mesh;
  private readonly diamonds: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene) {
    const gold = new THREE.MeshBasicMaterial({
      color: LUMINARY_GOLD,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    // The guest's gold ring: flat on the ground.
    const ringGeo = new THREE.RingGeometry(
      LUMINARY_RING_RADIUS - 0.25,
      LUMINARY_RING_RADIUS,
      40,
    );
    this.ring = new THREE.Mesh(ringGeo, gold);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    scene.add(this.ring);
    // The Defector's mark diamonds (max 6, the sim's cap).
    const diamondGeo = new THREE.OctahedronGeometry(MARK_DIAMOND_SIZE);
    for (let i = 0; i < 6; i++) {
      const d = new THREE.Mesh(diamondGeo, gold);
      d.visible = false;
      d.renderOrder = 5;
      scene.add(d);
      this.diamonds.push(d);
    }
  }

  /**
   * Refresh the markers from the world. `fogHides` mirrors the
   * entity-visibility gate (a marker never leaks what the shroud
   * hides — but Defector marks are INTEL, so they show through fog
   * by design; the guest ring follows the normal unit visibility).
   */
  sync(
    world: World,
    terrain: TerrainData | null,
    waterLevel: number,
    fogHidesUnit: (unitId: number) => boolean,
  ): void {
    // 1. The guest's gold ring.
    const guest = world.units.find((u) => u.kind === 'luminary' && u.hp > 0);
    if (guest && !fogHidesUnit(guest.id)) {
      const y = groundYAt(terrain, waterLevel, 'land', guest.x, guest.z);
      this.ring.position.set(guest.x, y + 0.15, guest.z);
      this.ring.visible = true;
    } else {
      this.ring.visible = false;
    }
    // 2. The Defector's mark diamonds (intel — visible through fog).
    const marks = world.luminaries?.productionMarks ?? [];
    for (let i = 0; i < this.diamonds.length; i++) {
      const d = this.diamonds[i];
      if (!d) continue;
      const mark = marks[i];
      const building =
        mark !== undefined
          ? world.city.buildings.find((b) => b.id === mark.buildingId)
          : undefined;
      if (building && mark !== undefined && world.tick < mark.untilTick) {
        const bx = cellCenterWorld(building.cx);
        const bz = cellCenterWorld(building.cz);
        const y = groundYAt(terrain, waterLevel, 'land', bx, bz);
        // Gentle bob (pure function of tick — deterministic, visual only).
        const bob = Math.sin(world.tick * 0.05 + i) * 0.4;
        d.position.set(bx, y + MARK_DIAMOND_HOVER + bob, bz);
        d.rotation.y = world.tick * 0.02;
        d.visible = true;
      } else {
        d.visible = false;
      }
    }
  }

  /** Release GPU resources (the disposeModels path). */
  dispose(): void {
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    for (const d of this.diamonds) {
      d.geometry.dispose();
    }
  }
}
