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
 * NOVATERRA — render/entities.ts — unit / building / road meshes.
 *
 * Responsibilities:
 *  - A read-only view of the sim's units, buildings, and roads: `sync()`
 *    diffs the world against live three.js objects, creating meshes for
 *    new ids, moving the rest, and disposing removed ones. Never touches
 *    sim state.
 *  - 0.1 Alpha look: clean, readable, team-colored — NOT final art. Units
 *    are simple smooth hulls (no voxel/blocky styling) with floating
 *    health bars; buildings are footprint boxes colored by zone; roads are
 *    a single instanced mesh. The art pass replaces geometries, not this
 *    module's structure.
 *  - Selection rings for the player's current selection.
 *  - Superweapon FX: the Aegis energy dome and Storm Engine strikes,
 *    driven by the sim's deterministic `world.superweapons.fx` records
 *    (animation phase derives from `world.tick`, never wall clock).
 *
 * Budgets: one Group per unit (hull + health bar sprites); buildings one
 * mesh each; roads one InstancedMesh rebuilt only when the road count
 * changes. Fine for the hundreds of entities Phase 1 targets.
 *
 * Render-side only: three.js here, never in sim/. See render/AGENTS.md.
 */

import * as THREE from 'three';
import type { World } from '../sim/world';
import type { UnitRecord } from '../sim/units';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  CELL_WORLD_SIZE,
  cellCoords,
  type BuildingKind,
  type ZoneType,
  UTILITY_ZONE,
} from '../sim/city';
import { STORM_FX_TICKS, type WeaponFx } from '../sim/superweapons';

/** Radius of the Aegis energy dome (world units). */
export const AEGIS_DOME_RADIUS = 55;

/** A live superweapon effect view. Keyed by fx identity. */
interface SuperweaponFxView {
  group: THREE.Group;
  /** For storm strikes: the tick the fx record expires (drives phase). */
  untilTick: number;
  kind: 'storm' | 'aegis';
}

/**
 * Team colors: human blue, rival red (default) or orange (colorblind).
 * Blue/orange is safe for the most common color-vision deficiencies
 * (deuteranopia/protanopia); the HTML `colorblind` class toggles it.
 */
function teamColors(): readonly [string, string] {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('colorblind')) {
    return ['#3aa0ff', '#ffaa00'] as const; // blue vs orange
  }
  return ['#3aa0ff', '#ff5544'] as const; // blue vs red
}

/** Hull colors per unit kind family (subtle variety under team tint). */
function hullColorFor(kind: string): number {
  switch (kind) {
    case 'tank':
      return 0x5a6b7d;
    case 'artillery':
      return 0x6b5a4a;
    case 'aa':
      return 0x4a6b5a;
    case 'hq':
      return 0x7d7d8a;
    case 'spectre':
      return 0x3a3a44;
    case 'fighter':
    case 'drone':
    case 'transport':
      return 0x8a94a6;
    default:
      return 0x6b7d8a;
  }
}

/** Approximate hull footprint per kind (x = width, z = length, y = height). */
function hullSizeFor(kind: string): { x: number; y: number; z: number } {
  switch (kind) {
    case 'tank':
      return { x: 3.2, y: 1.4, z: 4.6 };
    case 'artillery':
      return { x: 3.0, y: 1.6, z: 5.2 };
    case 'aa':
      return { x: 3.0, y: 2.2, z: 4.4 };
    case 'hq':
      return { x: 4.2, y: 2.4, z: 5.4 };
    case 'hauler':
      return { x: 3.4, y: 2.0, z: 5.6 };
    case 'fighter':
      return { x: 6.4, y: 0.9, z: 4.2 };
    case 'transport':
      return { x: 7.2, y: 1.6, z: 5.6 };
    case 'drone':
      return { x: 2.4, y: 0.6, z: 2.4 };
    default:
      return { x: 1.6, y: 2.2, z: 1.6 }; // infantry-ish
  }
}

/**
 * Smooth placeholder hull for a unit kind: capsule/cylinder/cone
 * composites, sized to the hull box. Air units get a fuselage + nose
 * cone; armored land units get a rounded hull + turret + barrel;
 * infantry-ish units get a single upright capsule. Group origin is at
 * the hull's vertical center.
 */
function createHullMesh(
  kind: string,
  domain: string,
  size: { x: number; y: number; z: number },
  mat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const add = (mesh: THREE.Mesh, y = 0): void => {
    mesh.position.y = y;
    g.add(mesh);
  };
  if (domain === 'air') {
    // Fuselage along X with a nose cone.
    const fus = new THREE.Mesh(
      new THREE.CapsuleGeometry(size.y / 2, size.x - size.y, 6, 16),
      mat,
    );
    fus.rotation.z = Math.PI / 2;
    add(fus);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(size.y / 2, size.x * 0.45, 16), mat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = size.x / 2 + size.x * 0.2;
    g.add(nose);
    return g;
  }
  switch (kind) {
    case 'tank':
    case 'artillery':
    case 'aa':
    case 'hq':
    case 'hauler': {
      // Rounded armored hull along Z + turret ring + barrel.
      const hullLen = size.z - size.y;
      const hull = new THREE.Mesh(
        new THREE.CapsuleGeometry(size.y / 2, Math.max(hullLen, 0.5), 6, 16),
        mat,
      );
      hull.rotation.x = Math.PI / 2;
      hull.scale.x = size.x / size.y;
      add(hull);
      const turret = new THREE.Mesh(
        new THREE.CylinderGeometry(size.y * 0.32, size.y * 0.38, size.y * 0.5, 16),
        mat,
      );
      add(turret, size.y * 0.55);
      if (kind === 'tank' || kind === 'artillery') {
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(size.y * 0.09, size.y * 0.11, size.z * 0.55, 10),
          mat,
        );
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, size.y * 0.6, size.z * 0.45);
        g.add(barrel);
      }
      return g;
    }
    default: {
      // Infantry-ish: upright capsule.
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(size.x / 2, Math.max(size.y - size.x, 0.4), 6, 12),
        mat,
      );
      add(body);
      return g;
    }
  }
}

/** Building box height per kind. */
function buildingHeightFor(kind: BuildingKind): number {
  switch (kind) {
    case 'house':
      return 3;
    case 'apartment':
      return 9;
    case 'shop':
      return 4;
    case 'lab':
      return 7;
    case 'factory':
      return 6;
    case 'farm':
      return 2;
    case 'powerPlant':
      return 10;
    case 'waterPump':
      return 4;
    default:
      return 4;
  }
}

/** Building tint by zone: residential warm, commercial cyan, industrial amber, utility gray. */
function buildingColorFor(zone: ZoneType | typeof UTILITY_ZONE): number {
  switch (zone) {
    case 0:
      return 0xd8b48a;
    case 1:
      return 0x8ad0d8;
    case 2:
      return 0xd8c48a;
    default:
      return 0x9aa0a8;
  }
}

/** One live unit's meshes. */
interface UnitView {
  group: THREE.Group;
  hull: THREE.Group;
  barBg: THREE.Sprite;
  barFg: THREE.Sprite;
}

/** One live building's mesh group. */
interface BuildingView {
  mesh: THREE.Group;
  id: number;
}

/**
 * Owns all entity meshes for a game scene. Call `sync(world)` every frame
 * (or when the sim ticks) and `setSelected(ids)` when selection changes.
 */
export class EntityRenderer {
  private readonly scene: THREE.Scene;
  private readonly unitGroup = new THREE.Group();
  private readonly buildingGroup = new THREE.Group();
  private readonly fxGroup = new THREE.Group();
  private readonly units = new Map<number, UnitView>();
  private readonly buildings = new Map<number, BuildingView>();
  private roadMesh: THREE.InstancedMesh | null = null;
  private roadDigest = -1;
  private readonly selectionRings = new Map<number, THREE.Mesh>();
  private readonly ringGeo = new THREE.RingGeometry(2.2, 2.8, 24);
  private readonly ringMat = new THREE.MeshBasicMaterial({
    color: 0x57c8ff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly barTexture: THREE.CanvasTexture;
  /** Live superweapon FX views, keyed by fx identity. */
  private readonly superweaponFx = new Map<string, SuperweaponFxView>();
  // Shared superweapon FX assets (created once, reused per view).
  private readonly aegisDomeGeo = new THREE.SphereGeometry(
    AEGIS_DOME_RADIUS, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2,
  );
  private readonly aegisDomeMat = new THREE.MeshBasicMaterial({
    color: 0x40c8ff,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly aegisWireMat = new THREE.MeshBasicMaterial({
    color: 0x80e0ff,
    wireframe: true,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly stormCloudGeo = new THREE.SphereGeometry(14, 18, 14);
  private readonly stormCloudMat = new THREE.MeshBasicMaterial({
    color: 0x23232e,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  private readonly boltGeo = new THREE.CylinderGeometry(0.7, 1.6, 44, 6);
  private readonly boltMat = new THREE.MeshBasicMaterial({
    color: 0xfff6c0,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  private readonly flashGeo = new THREE.SphereGeometry(9, 16, 12);
  private readonly flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd76a,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.unitGroup.name = 'units';
    this.buildingGroup.name = 'buildings';
    this.fxGroup.name = 'fx';
    scene.add(this.unitGroup, this.buildingGroup, this.fxGroup);
    // 1x1 white texture for health-bar sprites.
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d');
    if (ctx === null) throw new Error('entities: 2d canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1, 1);
    this.barTexture = new THREE.CanvasTexture(c);
  }

  /** Create/update/remove meshes to match the world. Render-side only. */
  sync(world: World): void {
    this.syncUnits(world);
    this.syncBuildings(world);
    this.syncRoads(world);
    this.syncSuperweaponFx(world);
  }

  /** Update which units show selection rings. */
  setSelected(ids: Iterable<number>): void {
    const wanted = new Set(ids);
    for (const [id, ring] of this.selectionRings) {
      if (!wanted.has(id)) {
        this.fxGroup.remove(ring);
        this.selectionRings.delete(id);
      }
    }
    for (const id of wanted) {
      if (this.selectionRings.has(id)) continue;
      const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.3;
      this.fxGroup.add(ring);
      this.selectionRings.set(id, ring);
    }
  }

  /** Move selection rings onto their units each frame. */
  updateSelectionRings(units: Map<number, UnitRecord>): void {
    for (const [id, ring] of this.selectionRings) {
      const u = units.get(id);
      if (!u) continue;
      ring.position.set(u.x, 0.3, u.z);
      const s = hullSizeFor(u.kind);
      const scale = Math.max(s.x, s.z) / 4;
      ring.scale.set(scale, scale, 1);
    }
  }

  /**
   * Superweapon FX, driven by the sim's deterministic `world.superweapons.fx`
   * records. Animation phase derives from `world.tick` (never wall clock),
   * so the visuals track the sim's timing exactly.
   */
  private syncSuperweaponFx(world: World): void {
    const seen = new Set<string>();
    for (const fx of world.superweapons.fx) {
      const key = `${fx.kind}:${fx.x.toFixed(1)}:${fx.z.toFixed(1)}:${fx.untilTick}`;
      seen.add(key);
      let view = this.superweaponFx.get(key);
      if (!view) {
        view = fx.kind === 'aegis' ? this.createAegisView(fx) : this.createStormView(fx);
        this.fxGroup.add(view.group);
        this.superweaponFx.set(key, view);
      }
      this.animateSuperweaponFx(view, world.tick);
    }
    for (const [key, view] of this.superweaponFx) {
      if (!seen.has(key)) {
        this.fxGroup.remove(view.group);
        if (view.kind === 'storm') {
          // Storm views own cloned materials; release them.
          view.group.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) (mesh.material as THREE.Material).dispose();
          });
        }
        this.superweaponFx.delete(key);
      }
    }
  }

  /** Translucent energy dome + wireframe shimmer over the shielded city. */
  private createAegisView(fx: WeaponFx): SuperweaponFxView {
    const group = new THREE.Group();
    const dome = new THREE.Mesh(this.aegisDomeGeo, this.aegisDomeMat);
    const wire = new THREE.Mesh(this.aegisDomeGeo, this.aegisWireMat);
    wire.scale.setScalar(1.01);
    group.add(dome, wire);
    group.position.set(fx.x, 0, fx.z);
    return { group, untilTick: fx.untilTick, kind: 'aegis' };
  }

  /** Storm cloud + lightning bolt + impact flash for one strike. */
  private createStormView(fx: WeaponFx): SuperweaponFxView {
    const group = new THREE.Group();
    const cloud = new THREE.Mesh(this.stormCloudGeo, this.stormCloudMat.clone());
    cloud.scale.set(1.4, 0.45, 1.4);
    cloud.position.y = 38;
    const bolt = new THREE.Mesh(this.boltGeo, this.boltMat.clone());
    bolt.position.y = 20;
    const flash = new THREE.Mesh(this.flashGeo, this.flashMat.clone());
    flash.position.y = 2;
    group.add(cloud, bolt, flash);
    group.position.set(fx.x, 0, fx.z);
    group.userData['cloud'] = cloud;
    group.userData['bolt'] = bolt;
    group.userData['flash'] = flash;
    return { group, untilTick: fx.untilTick, kind: 'storm' };
  }

  /** Advance one FX view's deterministic animation from the sim tick. */
  private animateSuperweaponFx(view: SuperweaponFxView, tick: number): void {
    if (view.kind === 'aegis') {
      // Gentle energy shimmer; pulse period ~2 sim-seconds.
      const pulse = 0.5 + 0.5 * Math.sin(tick * 0.105);
      this.aegisDomeMat.opacity = 0.14 + 0.08 * pulse;
      this.aegisWireMat.opacity = 0.08 + 0.08 * pulse;
      return;
    }
    // Storm strike: 0 = just spawned, 1 = expiring.
    const phase = 1 - Math.max(0, view.untilTick - tick) / STORM_FX_TICKS;
    const cloud = view.group.userData['cloud'] as THREE.Mesh;
    const bolt = view.group.userData['bolt'] as THREE.Mesh;
    const flash = view.group.userData['flash'] as THREE.Mesh;
    const cloudMat = cloud.material as THREE.MeshBasicMaterial;
    const boltMat = bolt.material as THREE.MeshBasicMaterial;
    const flashMat = flash.material as THREE.MeshBasicMaterial;
    if (phase < 0.25) {
      // Cloud gathers.
      const s = phase / 0.25;
      cloud.scale.set(1.4 * s, 0.45 * s, 1.4 * s);
      cloudMat.opacity = 0.88 * s;
      boltMat.opacity = 0;
      flashMat.opacity = 0;
    } else if (phase < 0.45) {
      // Lightning strike + impact flash.
      const s = (phase - 0.25) / 0.2;
      cloud.scale.set(1.4, 0.45, 1.4);
      cloudMat.opacity = 0.88;
      boltMat.opacity = 0.95;
      bolt.scale.set(1, s, 1);
      flashMat.opacity = 0.7 * s;
      flash.scale.setScalar(0.5 + s);
    } else {
      // Dissipate.
      const s = (phase - 0.45) / 0.55;
      cloudMat.opacity = 0.88 * (1 - s);
      boltMat.opacity = 0.95 * (1 - s * 2 > 0 ? 1 - s * 2 : 0);
      flashMat.opacity = 0.7 * (1 - s);
      flash.scale.setScalar(1.5 + s * 2);
    }
  }

  dispose(): void {
    this.scene.remove(this.unitGroup, this.buildingGroup, this.fxGroup);
    for (const v of this.units.values()) this.disposeUnitView(v);
    this.units.clear();
    for (const v of this.buildings.values()) disposeGroup(v.mesh);
    this.buildings.clear();
    this.selectionRings.clear();
    this.superweaponFx.clear();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.barTexture.dispose();
    this.aegisDomeGeo.dispose();
    this.aegisDomeMat.dispose();
    this.aegisWireMat.dispose();
    this.stormCloudGeo.dispose();
    this.stormCloudMat.dispose();
    this.boltGeo.dispose();
    this.boltMat.dispose();
    this.flashGeo.dispose();
    this.flashMat.dispose();
    this.disposeRoadMesh();
  }

  /** Release the road InstancedMesh and its geometry/material. */
  private disposeRoadMesh(): void {
    if (this.roadMesh) {
      this.buildingGroup.remove(this.roadMesh);
      this.roadMesh.dispose(); // instance attributes
      this.roadMesh.geometry.dispose();
      (this.roadMesh.material as THREE.Material).dispose();
      this.roadMesh = null;
    }
  }

  // ---- units ----

  private syncUnits(world: World): void {
    const seen = new Set<number>();
    for (const u of world.units) {
      if (u.hp <= 0) continue;
      seen.add(u.id);
      let view = this.units.get(u.id);
      if (!view) {
        view = this.createUnitView(u);
        this.units.set(u.id, view);
        this.unitGroup.add(view.group);
      }
      this.updateUnitView(view, u);
    }
    for (const [id, view] of this.units) {
      if (!seen.has(id)) {
        this.unitGroup.remove(view.group);
        this.disposeUnitView(view);
        this.units.delete(id);
      }
    }
  }

  private createUnitView(u: UnitRecord): UnitView {
    const group = new THREE.Group();
    const size = hullSizeFor(u.kind);
    const team = teamColors()[u.owner] ?? '#aaaaaa';
    const hullMat = new THREE.MeshStandardMaterial({
      color: hullColorFor(u.kind),
      roughness: 0.55,
      metalness: 0.35,
    });
    // Smooth placeholder silhouettes (0.1 Alpha art, not final): rounded
    // hulls per domain/role — never boxes, per the art direction.
    const hull = createHullMesh(u.kind, u.domain, size, hullMat);
    hull.position.y = size.y / 2 + (u.domain === 'air' ? 14 : 0.2);
    group.add(hull);
    // Team stripe: thin emissive disc on top so ownership reads at a glance.
    const stripe = new THREE.Mesh(
      new THREE.CylinderGeometry(size.x * 0.32, size.x * 0.32, 0.22, 20),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(team),
        emissive: new THREE.Color(team),
        emissiveIntensity: 0.7,
      }),
    );
    stripe.position.y = hull.position.y + size.y / 2 + 0.15;
    group.add(stripe);

    const barBg = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.barTexture, color: 0x1a1a1a, depthTest: false }),
    );
    const barFg = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.barTexture, color: 0x4ade80, depthTest: false }),
    );
    barBg.center.set(0, 0.5);
    barFg.center.set(0, 0.5);
    barBg.scale.set(4, 0.5, 1);
    barFg.scale.set(4, 0.5, 1);
    barBg.renderOrder = 10;
    barFg.renderOrder = 11;
    group.add(barBg, barFg);

    group.position.set(u.x, 0, u.z);
    return { group, hull, barBg, barFg };
  }

  private updateUnitView(view: UnitView, u: UnitRecord): void {
    view.group.position.set(u.x, 0, u.z);
    // Face the order destination when it has one; cheap orientation cue.
    const dx = u.destX - u.x;
    const dz = u.destZ - u.z;
    if (dx * dx + dz * dz > 0.5) {
      view.hull.rotation.y = Math.atan2(dx, dz);
    }
    const def = UNIT_DEFS[u.kind as UnitKind];
    const frac = def ? Math.max(0, Math.min(1, u.hp / def.hp)) : 1;
    const size = hullSizeFor(u.kind);
    const barY = size.y + (u.domain === 'air' ? 15 : 2.2);
    view.barBg.position.set(-2, barY, 0);
    view.barFg.position.set(-2, barY, 0);
    view.barFg.scale.set(4 * frac, 0.5, 1);
    (view.barFg.material as THREE.SpriteMaterial).color.setHex(
      frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfacc15 : 0xef4444,
    );
    const showBar = frac < 1;
    view.barBg.visible = showBar;
    view.barFg.visible = showBar;
  }

  private disposeUnitView(view: UnitView): void {
    view.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material;
        mat.dispose();
      }
      const sprite = o as THREE.Sprite;
      if (sprite.isSprite) (sprite.material as THREE.Material).dispose();
    });
  }

  // ---- buildings ----

  private syncBuildings(world: World): void {
    const seen = new Set<number>();
    for (const b of world.city.buildings) {
      seen.add(b.id);
      if (this.buildings.has(b.id)) continue;
      const def = BUILDING_DEFS[b.kind as BuildingKind];
      if (!def) continue;
      const w = def.footprintW * CELL_WORLD_SIZE;
      const d = def.footprintH * CELL_WORLD_SIZE;
      const h = buildingHeightFor(b.kind as BuildingKind);
      const mat = new THREE.MeshStandardMaterial({
        color: buildingColorFor(def.zone),
        roughness: 0.8,
        metalness: 0.1,
        transparent: true,
        opacity: b.progress < 1 ? 0.55 : 1,
      });
      const mesh = createBuildingMesh(b.kind as BuildingKind, w, h, d, mat);
      mesh.position.set(
        cellCenterWorld(b.cx) + (w - CELL_WORLD_SIZE) / 2,
        0,
        cellCenterWorld(b.cz) + (d - CELL_WORLD_SIZE) / 2,
      );
      this.buildingGroup.add(mesh);
      this.buildings.set(b.id, { mesh, id: b.id });
    }
    for (const [id, view] of this.buildings) {
      if (!seen.has(id)) {
        this.buildingGroup.remove(view.mesh);
        disposeGroup(view.mesh);
        this.buildings.delete(id);
      }
    }
  }

  // ---- roads ----

  private syncRoads(world: World): void {
    const roads = world.city.roads;
    // Digest, not just the count: replacing road cells with the same count
    // must still refresh the mesh.
    let digest = 2166136261;
    for (const cell of roads) {
      digest ^= cell as number;
      digest = Math.imul(digest, 16777619);
    }
    if (digest === this.roadDigest) return;
    this.roadDigest = digest;
    this.disposeRoadMesh();
    if (roads.length === 0) return;
    // Rounded pavers (flat cylinders), not boxes.
    const geo = new THREE.CylinderGeometry(
      CELL_WORLD_SIZE * 0.48,
      CELL_WORLD_SIZE * 0.48,
      0.25,
      12,
    );
    const mat = new THREE.MeshStandardMaterial({ color: 0x2e3440, roughness: 0.95 });
    const inst = new THREE.InstancedMesh(geo, mat, roads.length);
    const m = new THREE.Matrix4();
    for (let i = 0; i < roads.length; i++) {
      const { cx, cz } = cellCoords(roads[i] as number);
      m.makeTranslation(cellCenterWorld(cx), 0.15, cellCenterWorld(cz));
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.buildingGroup.add(inst);
    this.roadMesh = inst;
  }

  /** Unit records by id (for selection-ring updates). */
  static unitMap(world: World): Map<number, UnitRecord> {
    const map = new Map<number, UnitRecord>();
    for (const u of world.units) map.set(u.id, u);
    return map;
  }
}

/** Dispose every geometry/material in a group. */
function disposeGroup(root: THREE.Group): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  });
}

/**
 * Smooth placeholder building: cylinder/cone/sphere composites per kind,
 * sized to the footprint. Group origin at ground level. 0.1 Alpha art —
 * readable and rounded, not final.
 */
function createBuildingMesh(
  kind: BuildingKind,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const r = Math.min(w, d) / 2;
  const add = (mesh: THREE.Mesh, y: number): void => {
    mesh.position.y = y;
    g.add(mesh);
  };
  const body = (geo: THREE.BufferGeometry, y: number): void =>
    add(new THREE.Mesh(geo, mat), y);
  switch (kind) {
    case 'house':
    case 'apartment':
    case 'shop':
      // Round tower + cone roof.
      body(new THREE.CylinderGeometry(r * 0.92, r, h * 0.72, 20), h * 0.36);
      body(new THREE.ConeGeometry(r * 0.98, h * 0.34, 20), h * 0.72 + h * 0.17);
      break;
    case 'factory':
      // Wide hall + two stacks.
      body(new THREE.CylinderGeometry(r * 0.95, r, h * 0.55, 20), h * 0.275);
      body(new THREE.CylinderGeometry(r * 0.16, r * 0.2, h * 0.7, 12), h * 0.35);
      break;
    case 'farm':
      // Low dome greenhouse.
      body(new THREE.SphereGeometry(r * 0.95, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), 0);
      break;
    case 'powerPlant':
      // Tapered cooling tower.
      body(new THREE.CylinderGeometry(r * 0.62, r * 0.9, h, 20), h / 2);
      break;
    case 'waterPump':
      // Tank sphere on a drum base.
      body(new THREE.CylinderGeometry(r * 0.55, r * 0.6, h * 0.4, 16), h * 0.2);
      body(new THREE.SphereGeometry(r * 0.55, 18, 14), h * 0.4 + r * 0.5);
      break;
    case 'lab':
      // Drum + glass dome.
      body(new THREE.CylinderGeometry(r * 0.85, r * 0.9, h * 0.6, 20), h * 0.3);
      body(
        new THREE.SphereGeometry(r * 0.6, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        h * 0.6,
      );
      break;
    default:
      body(new THREE.CylinderGeometry(r * 0.9, r, h, 16), h / 2);
      break;
  }
  return g;
}
