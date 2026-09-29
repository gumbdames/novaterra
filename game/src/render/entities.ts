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
 *  - 0.1 Alpha art: real CC0 models (GLB via `render/models.ts`) for most
 *    entities, detailed procedural models (`render/proceduralModels.ts`)
 *    for the 8 gap kinds, and the old smooth placeholder silhouettes as
 *    the final fallback — resolution order per entity is GLB →
 *    procedural → placeholder, so the game is never blank.
 *  - Sharing: geometry AND materials are shared across all views of the
 *    same kind (GLB assets arrive merged per material from the loader;
 *    procedural models are built once per kind and cached). Per-view
 *    objects own only their health-bar sprites, team pennant material,
 *    and (while constructing) cloned fade materials. Shared assets are
 *    never disposed per view.
 *  - Selection rings for the player's current selection.
 *  - Superweapon FX: the Aegis energy dome and Storm Engine strikes,
 *    driven by the sim's deterministic `world.superweapons.fx` records
 *    (animation phase derives from `world.tick`, never wall clock).
 *
 * Budgets: one Group per unit (model + team stripe + pennant + health
 * bars); buildings one group each; roads two meshes (ribbon + dashes).
 * No per-frame allocations on the hot path (`sync` only touches views
 * whose membership or construction state changed).
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
  type BuildingRecord,
  type ZoneType,
  UTILITY_ZONE,
} from '../sim/city';
import { STORM_FX_TICKS, type WeaponFx } from '../sim/superweapons';
import type { LoadedModel } from './models';
import {
  buildHqAntenna,
  buildInfantryGear,
  buildProceduralModel,
  buildRadarDishProp,
} from './proceduralModels';
import {
  buildRoadGeometry,
  buildRoadMarkings,
  ROAD_ASPHALT_COLOR,
  ROAD_DASH_COLOR,
} from './roads';

/** Radius of the Aegis energy dome (world units). */
export const AEGIS_DOME_RADIUS = 55;

/** A live superweapon effect view. Keyed by fx identity. */
interface SuperweaponFxView {
  group: THREE.Group;
  /** For storm strikes: the tick the fx record expires (drives phase). */
  untilTick: number;
  kind: 'storm' | 'aegis';
}

// ---------------------------------------------------------------------------
// Model resolution: GLB → procedural → placeholder (never blank)
// ---------------------------------------------------------------------------

/** One piece of a (possibly composite) GLB model view. */
export interface ModelPiece {
  /** Key into the loaded-models map (`MODEL_PATHS` key). */
  key: string;
  /** Offset of the piece within the entity's footprint, world units. */
  dx: number;
  dy: number;
  dz: number;
}

const piece = (key: string, dx = 0, dy = 0, dz = 0): ModelPiece => ({ key, dx, dy, dz });

/** Where an entity kind's visuals come from. */
export type ModelSource =
  | { type: 'glb'; pieces: readonly ModelPiece[] }
  | { type: 'procedural' }
  | { type: 'placeholder' };

/**
 * Entity kind → model source. Composite buildings assemble several GLB
 * pieces (offsets relative to the footprint center); every 1:1 kind has
 * a single piece keyed by its own name.
 */
const MODEL_SOURCES: Record<string, ModelSource> = {
  // ---- units ----
  engineer: { type: 'glb', pieces: [piece('engineer')] },
  rifles: { type: 'glb', pieces: [piece('rifles')] },
  tank: { type: 'glb', pieces: [piece('tank')] },
  hauler: { type: 'glb', pieces: [piece('hauler')] },
  spectre: { type: 'glb', pieces: [piece('spectre')] },
  hq: { type: 'glb', pieces: [piece('hq')] },
  patrolBoat: { type: 'glb', pieces: [piece('patrolBoat')] },
  transportShip: { type: 'glb', pieces: [piece('transportShip')] },
  artillery: { type: 'procedural' },
  aa: { type: 'procedural' },
  fighter: { type: 'procedural' },
  transport: { type: 'procedural' },
  drone: { type: 'procedural' },
  destroyer: { type: 'procedural' },
  // ---- buildings ----
  house: { type: 'glb', pieces: [piece('house')] },
  apartment: { type: 'glb', pieces: [piece('apartment')] },
  shop: { type: 'glb', pieces: [piece('shop')] },
  lab: { type: 'glb', pieces: [piece('lab')] },
  factory: { type: 'glb', pieces: [piece('factory')] },
  farm: {
    type: 'glb',
    pieces: [piece('farmBarn', -0.75, 0, -0.3), piece('farmSilo', 1.95, 0, 1.1)],
  },
  powerPlant: {
    type: 'glb',
    pieces: [piece('powerPlantMain', -0.8, 0, -0.5), piece('powerPlantChimney', 1.6, 0, 1.4)],
  },
  waterPump: { type: 'glb', pieces: [piece('waterPump')] },
  shipyard: {
    type: 'glb',
    pieces: [piece('shipyardCrane', -2.2, 0, 0), piece('shipyardMachine', 2.3, 0, 0.8)],
  },
  mediaCenter: { type: 'procedural' },
  // aegisControl: GLB main block + procedural radar dish prop (attached
  // in attachModelExtras).
  aegisControl: { type: 'glb', pieces: [piece('aegisMain', 0, 0, -1.0)] },
  stormArray: { type: 'procedural' },
};

/**
 * Resolve an entity kind to its model source. Unknown kinds fall back
 * to the placeholder builders — the game never renders a blank entity.
 * Exported for the mapping-completeness test (every UnitKind and
 * BuildingKind must resolve to `glb` or `procedural`).
 */
export function modelSourceFor(kind: string): ModelSource {
  return MODEL_SOURCES[kind] ?? { type: 'placeholder' };
}

// ---------------------------------------------------------------------------
// Sizing conventions (also the scale provenance for MODEL_PATHS)
// ---------------------------------------------------------------------------

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

/** Hull colors per unit kind family (placeholder tint only). */
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

/**
 * Approximate hull footprint per kind (x = width, z = length, y = height).
 * Drives model fit-to-footprint scales (see models.ts), selection-ring
 * sizing, and health-bar heights. Exported: the scale analysis and the
 * mapping test treat this as the footprint convention.
 */
export function hullSizeFor(kind: string): { x: number; y: number; z: number } {
  switch (kind) {
    case 'engineer':
    case 'rifles':
      return { x: 1.4, y: 1.8, z: 1.4 };
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
    case 'spectre':
      return { x: 4.5, y: 1.2, z: 5.5 };
    case 'fighter':
      return { x: 6.4, y: 0.9, z: 4.2 };
    case 'transport':
      return { x: 7.2, y: 1.6, z: 5.6 };
    case 'drone':
      return { x: 2.4, y: 0.6, z: 2.4 };
    case 'patrolBoat':
      return { x: 3.2, y: 2.0, z: 8.0 };
    case 'destroyer':
      return { x: 5.0, y: 3.5, z: 17.0 };
    case 'transportShip':
      return { x: 6.5, y: 4.0, z: 19.0 };
    default:
      return { x: 1.6, y: 2.2, z: 1.6 }; // infantry-ish
  }
}

/** Land units hover above the ground (gunship read); others sit on it. */
const HOVER_Y: Record<string, number> = {
  spectre: 1.6,
};

/**
 * Smooth placeholder hull for a unit kind: capsule/cylinder/cone
 * composites, sized to the hull box. Air units get a fuselage + nose
 * cone; armored land units get a rounded hull + turret + barrel;
 * infantry-ish units get a single upright capsule. Group origin is at
 * the hull's vertical center.
 *
 * Fallback only (used when neither GLB nor procedural model is
 * available); never the primary art path.
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

/** Building box height per kind. Exported: scale provenance for models.ts. */
export function buildingHeightFor(kind: BuildingKind): number {
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
    case 'mediaCenter':
      return 14;
    case 'shipyard':
      return 6;
    case 'aegisControl':
      return 8;
    case 'stormArray':
      return 8;
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
  /** Ground-relative base y of the hull (hover/sea level included). */
  baseY: number;
  /** Top of the model (stripe/pennant/bar anchor), world units above baseY. */
  modelTop: number;
  /**
   * Per-view disposables ONLY: health-bar + pennant materials. Shared
   * geometry/materials (model, stripe, placeholder templates) are never
   * disposed per view.
   */
  owned: Array<THREE.BufferGeometry | THREE.Material>;
}

/** One live building's mesh group. */
interface BuildingView {
  group: THREE.Group;
  id: number;
  kind: BuildingKind;
  /** Meshes whose materials swap between shared and construction clones. */
  modelMeshes: THREE.Mesh[];
  /** Shared materials parallel to modelMeshes (restored on completion). */
  sharedMaterials: THREE.Material[];
  /** True while the view's materials are per-view construction clones. */
  constructing: boolean;
  /** Per-view disposables: pennant material + active construction clones. */
  owned: THREE.Material[];
  /** Top of the model, for the pennant anchor. */
  modelTop: number;
}

/** Options for the EntityRenderer constructor. */
export interface EntityRendererOptions {
  /** Water level: sea-unit hulls float here (default 0). */
  waterLevel?: number;
}

/**
 * Owns all entity meshes for a game scene. Call `sync(world)` every frame
 * (or when the sim ticks) and `setSelected(ids)` when selection changes.
 *
 * @param scene the three.js scene to populate.
 * @param models loaded GLB models (MODEL_PATHS keys). The map is
 *   caller-owned: the renderer never disposes it (call `disposeModels`
 *   from `render/models.ts` when the game tears down). An empty map is
 *   fully supported — every entity falls back to procedural, then
 *   placeholder, art and the game stays playable.
 */
export class EntityRenderer {
  private readonly scene: THREE.Scene;
  private readonly models: Map<string, LoadedModel>;
  private readonly waterLevel: number;
  private readonly unitGroup = new THREE.Group();
  private readonly buildingGroup = new THREE.Group();
  private readonly fxGroup = new THREE.Group();
  private readonly units = new Map<number, UnitView>();
  private readonly buildings = new Map<number, BuildingView>();
  private roadMesh: THREE.Mesh | null = null;
  private roadDashMesh: THREE.Mesh | null = null;
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
  // ---- shared model assets (one copy per kind, never disposed per view) ----
  /** Procedural gap models, built once per kind. */
  private readonly proceduralCache = new Map<string, LoadedModel>();
  /** Procedural attach props (infantry gear, HQ antenna, radar dish). */
  private readonly propCache = new Map<string, LoadedModel>();
  /** Placeholder unit templates (GLB/procedural fallback), per kind+domain. */
  private readonly placeholderUnitTemplates = new Map<string, THREE.Group>();
  /** Placeholder building templates, per kind. */
  private readonly placeholderBuildingTemplates = new Map<string, THREE.Group>();
  /** Model top (max y) per kind, measured once from the built group. */
  private readonly modelTops = new Map<string, number>();
  /** Team stripe geometry per unit kind (shared across views). */
  private readonly stripeGeos = new Map<string, THREE.BufferGeometry>();
  /** Team stripe material per resolved team color (usually 2 entries). */
  private readonly stripeMats = new Map<string, THREE.Material>();
  /** Team pennant geometry (shared); the material is per view (tinted). */
  private readonly pennantGeo = new THREE.SphereGeometry(0.16, 8, 6);
  // ---- shared road assets ----
  private readonly roadAsphaltMat = new THREE.MeshStandardMaterial({
    color: ROAD_ASPHALT_COLOR,
    roughness: 0.95,
  });
  private readonly roadDashMat = new THREE.MeshStandardMaterial({
    color: ROAD_DASH_COLOR,
    roughness: 0.8,
  });
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

  constructor(
    scene: THREE.Scene,
    models: Map<string, LoadedModel> = new Map(),
    opts: EntityRendererOptions = {},
  ) {
    this.scene = scene;
    this.models = models;
    this.waterLevel = opts.waterLevel ?? 0;
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
    for (const v of this.buildings.values()) this.disposeBuildingView(v);
    this.buildings.clear();
    this.selectionRings.clear();
    this.superweaponFx.clear();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.barTexture.dispose();
    // Shared per-kind assets (never per-view): release once here.
    for (const m of this.proceduralCache.values()) {
      for (const g of m.geometries) g.dispose();
      for (const mat of m.materials) mat.dispose();
    }
    this.proceduralCache.clear();
    for (const m of this.propCache.values()) {
      for (const g of m.geometries) g.dispose();
      for (const mat of m.materials) mat.dispose();
    }
    this.propCache.clear();
    for (const t of this.placeholderUnitTemplates.values()) disposeGroup(t);
    this.placeholderUnitTemplates.clear();
    for (const t of this.placeholderBuildingTemplates.values()) disposeGroup(t);
    this.placeholderBuildingTemplates.clear();
    for (const g of this.stripeGeos.values()) g.dispose();
    this.stripeGeos.clear();
    for (const m of this.stripeMats.values()) m.dispose();
    this.stripeMats.clear();
    this.pennantGeo.dispose();
    this.roadAsphaltMat.dispose();
    this.roadDashMat.dispose();
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
    // NOTE: this.models is caller-owned — the caller disposes it with
    // disposeModels() from render/models.ts after teardown.
  }

  /** Release the road meshes (geometries; materials are shared). */
  private disposeRoadMesh(): void {
    if (this.roadMesh) {
      this.buildingGroup.remove(this.roadMesh);
      this.roadMesh.geometry.dispose();
      this.roadMesh = null;
    }
    if (this.roadDashMesh) {
      this.buildingGroup.remove(this.roadDashMesh);
      this.roadDashMesh.geometry.dispose();
      this.roadDashMesh = null;
    }
  }

  // ---- model resolution ----

  /**
   * Procedural gap model for a kind, built once and cached. Returns
   * undefined for non-gap kinds (caller falls through to placeholders).
   */
  private proceduralFor(kind: string): LoadedModel | undefined {
    let m = this.proceduralCache.get(kind);
    if (m === undefined) {
      const built = buildProceduralModel(kind);
      if (built === undefined) return undefined;
      this.proceduralCache.set(kind, built);
      m = built;
    }
    return m;
  }

  /**
   * Procedural attach prop, built once per key: 'gear:rifles',
   * 'gear:engineer', 'hqAntenna', 'radarDish'.
   */
  private propFor(key: string): LoadedModel {
    let m = this.propCache.get(key);
    if (m === undefined) {
      if (key === 'gear:rifles' || key === 'gear:engineer') {
        m = buildInfantryGear(key === 'gear:rifles' ? 'rifles' : 'engineer');
      } else if (key === 'hqAntenna') {
        m = buildHqAntenna();
      } else {
        m = buildRadarDishProp();
      }
      this.propCache.set(key, m);
    }
    return m;
  }

  /** Add the meshes of a LoadedModel-like to a group (shared geo/mat). */
  private static addModelMeshes(group: THREE.Group, model: LoadedModel): void {
    for (let i = 0; i < model.geometries.length; i++) {
      const geo = model.geometries[i];
      const mat = model.materials[i] ?? model.materials[0];
      if (geo === undefined || mat === undefined) continue;
      group.add(new THREE.Mesh(geo, mat));
    }
  }

  /**
   * Per-kind extras that make GLB models read correctly in game:
   * infantry gear (rifle / hard-hat), the HQ command antenna, and the
   * aegisControl radar dish. Shared geometry/materials; one `Mesh` per
   * view (a Mesh can only have one parent).
   */
  private attachModelExtras(group: THREE.Group, kind: string): void {
    if (kind === 'rifles' || kind === 'engineer') {
      EntityRenderer.addModelMeshes(group, this.propFor(`gear:${kind}`));
    } else if (kind === 'hq') {
      const antenna = new THREE.Group();
      EntityRenderer.addModelMeshes(antenna, this.propFor('hqAntenna'));
      // On the flatbed toward the rear (-z; the model faces +z).
      antenna.position.set(0, 1.5, -1.2);
      group.add(antenna);
    } else if (kind === 'aegisControl') {
      const dish = new THREE.Group();
      EntityRenderer.addModelMeshes(dish, this.propFor('radarDish'));
      // Beside the main block, clear of its footprint.
      dish.position.set(1.5, 0, 1.8);
      group.add(dish);
    }
  }

  /**
   * Build the visual model group for a kind: GLB pieces (shared) →
   * procedural gap model (shared, cached) → null (caller uses the
   * placeholder template). The group's base sits at y=0 and it faces
   * +z; geometry and materials are shared across all views of the kind.
   */
  private createModelGroup(kind: string): { group: THREE.Group; top: number } | null {
    const source = modelSourceFor(kind);
    const group = new THREE.Group();
    if (source.type === 'glb') {
      let placed = 0;
      for (const p of source.pieces) {
        const model = this.models.get(p.key);
        if (model === undefined) continue; // missing piece: show the rest
        const pieceGroup = new THREE.Group();
        EntityRenderer.addModelMeshes(pieceGroup, model);
        if (pieceGroup.children.length === 0) continue;
        pieceGroup.position.set(p.dx, p.dy, p.dz);
        group.add(pieceGroup);
        placed++;
      }
      if (placed === 0) return null;
    } else if (source.type === 'procedural') {
      const model = this.proceduralFor(kind);
      if (model === undefined) return null;
      EntityRenderer.addModelMeshes(group, model);
    } else {
      return null;
    }
    this.attachModelExtras(group, kind);
    return { group, top: this.modelTopFor(kind, group) };
  }

  /** Top (max y) of a kind's model group, measured once and cached. */
  private modelTopFor(kind: string, group: THREE.Group): number {
    let top = this.modelTops.get(kind);
    if (top === undefined) {
      const box = new THREE.Box3().setFromObject(group);
      top = box.isEmpty() ? 1 : box.max.y;
      this.modelTops.set(kind, top);
    }
    return top;
  }

  /**
   * Placeholder unit template (fallback art), built once per kind+domain
   * and CLONED per view — clone() shares geometry/material, so per-view
   * disposal never touches the shared assets. The template is shifted so
   * its base sits at y=0 like the real models.
   */
  private placeholderUnitTemplate(kind: string, domain: string): THREE.Group {
    const key = `${kind}:${domain}`;
    let t = this.placeholderUnitTemplates.get(key);
    if (t === undefined) {
      const size = hullSizeFor(kind);
      const mat = new THREE.MeshStandardMaterial({
        color: hullColorFor(kind),
        roughness: 0.55,
        metalness: 0.35,
      });
      const inner = createHullMesh(kind, domain, size, mat);
      inner.position.y = size.y / 2; // centered origin → base at y=0
      t = new THREE.Group();
      t.add(inner);
      this.placeholderUnitTemplates.set(key, t);
    }
    return t;
  }

  /** Placeholder building template (fallback art), per kind. */
  private placeholderBuildingTemplate(kind: BuildingKind): THREE.Group {
    let t = this.placeholderBuildingTemplates.get(kind);
    if (t === undefined) {
      const def = BUILDING_DEFS[kind];
      const w = def.footprintW * CELL_WORLD_SIZE;
      const d = def.footprintH * CELL_WORLD_SIZE;
      const h = buildingHeightFor(kind);
      const mat = new THREE.MeshStandardMaterial({
        color: buildingColorFor(def.zone),
        roughness: 0.8,
        metalness: 0.1,
      });
      t = createBuildingMesh(kind, w, h, d, mat);
      this.placeholderBuildingTemplates.set(kind, t);
    }
    return t;
  }

  /** Team stripe geometry for a unit kind, shared across views. */
  private stripeGeoFor(kind: string): THREE.BufferGeometry {
    let g = this.stripeGeos.get(kind);
    if (g === undefined) {
      const size = hullSizeFor(kind);
      g = new THREE.CylinderGeometry(size.x * 0.32, size.x * 0.32, 0.22, 20);
      this.stripeGeos.set(kind, g);
    }
    return g;
  }

  /** Team stripe material per resolved team color (shared across views). */
  private stripeMatFor(team: string): THREE.Material {
    let m = this.stripeMats.get(team);
    if (m === undefined) {
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(team),
        emissive: new THREE.Color(team),
        emissiveIntensity: 0.7,
      });
      this.stripeMats.set(team, m);
    }
    return m;
  }

  /**
   * Team pennant: a small glowing marker floating above the model so
   * ownership reads at a glance even though models keep their authored
   * colors. Geometry is shared; the material is per view (tinted) and
   * caller-owned for disposal.
   */
  private createPennant(team: string): { mesh: THREE.Mesh; material: THREE.Material } {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(team),
      emissive: new THREE.Color(team),
      emissiveIntensity: 1.2,
    });
    const mesh = new THREE.Mesh(this.pennantGeo, material);
    return { mesh, material };
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
    const owned: Array<THREE.BufferGeometry | THREE.Material> = [];

    // Hull: real model (GLB → procedural) or the shared placeholder
    // template. The hull group's base sits at y=0; baseY lifts it for
    // air hover, sea float, and gunship hover.
    const hull = new THREE.Group();
    const built = this.createModelGroup(u.kind);
    let modelTop: number;
    if (built !== null) {
      hull.add(built.group);
      modelTop = built.top;
    } else {
      hull.add(this.placeholderUnitTemplate(u.kind, u.domain).clone());
      modelTop = size.y;
    }
    const baseY = u.domain === 'air' ? 14 : u.domain === 'sea' ? this.waterLevel : (HOVER_Y[u.kind] ?? 0.15);
    hull.position.y = baseY;
    group.add(hull);

    // Team stripe: thin emissive disc above the model (shared geo/mat).
    const stripe = new THREE.Mesh(this.stripeGeoFor(u.kind), this.stripeMatFor(team));
    stripe.position.y = baseY + modelTop + 0.15;
    group.add(stripe);

    // Team pennant: tiny glowing marker above the stripe (per-view tint).
    const pennant = this.createPennant(team);
    pennant.mesh.position.y = baseY + modelTop + 0.55;
    group.add(pennant.mesh);
    owned.push(pennant.material);

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
    owned.push(barBg.material, barFg.material);

    group.position.set(u.x, 0, u.z);
    return { group, hull, barBg, barFg, baseY, modelTop, owned };
  }

  private updateUnitView(view: UnitView, u: UnitRecord): void {
    view.group.position.set(u.x, 0, u.z);
    // Face the order destination when it has one; cheap orientation cue.
    // Models face +z at rotation 0 (rotY baked at load), matching the
    // placeholder convention.
    const dx = u.destX - u.x;
    const dz = u.destZ - u.z;
    if (dx * dx + dz * dz > 0.5) {
      view.hull.rotation.y = Math.atan2(dx, dz);
    }
    const def = UNIT_DEFS[u.kind as UnitKind];
    const frac = def ? Math.max(0, Math.min(1, u.hp / def.hp)) : 1;
    const barY = view.baseY + view.modelTop + 1.1;
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

  /**
   * Release per-view objects only: health-bar + pennant materials.
   * Shared geometry/materials (models, stripes, templates) are owned by
   * the renderer and released once in dispose().
   */
  private disposeUnitView(view: UnitView): void {
    for (const o of view.owned) o.dispose();
    view.owned.length = 0;
  }

  // ---- buildings ----

  private syncBuildings(world: World): void {
    const seen = new Set<number>();
    for (const b of world.city.buildings) {
      seen.add(b.id);
      let view = this.buildings.get(b.id);
      if (!view) {
        view = this.createBuildingView(b);
        this.buildingGroup.add(view.group);
        this.buildings.set(b.id, view);
      }
      this.updateBuildingConstruction(view, b.progress);
    }
    for (const [id, view] of this.buildings) {
      if (!seen.has(id)) {
        this.buildingGroup.remove(view.group);
        this.disposeBuildingView(view);
        this.buildings.delete(id);
      }
    }
  }

  private createBuildingView(b: BuildingRecord): BuildingView {
    const kind = b.kind as BuildingKind;
    const def = BUILDING_DEFS[kind];
    const team = teamColors()[b.owner] ?? '#aaaaaa';
    const group = new THREE.Group();
    const modelMeshes: THREE.Mesh[] = [];
    const sharedMaterials: THREE.Material[] = [];
    const owned: THREE.Material[] = [];

    const built = this.createModelGroup(kind);
    let modelTop: number;
    if (built !== null) {
      group.add(built.group);
      modelTop = built.top;
    } else {
      const clone = this.placeholderBuildingTemplate(kind).clone();
      group.add(clone);
      modelTop = buildingHeightFor(kind);
    }
    // Meshes whose materials participate in the construction fade.
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) {
        modelMeshes.push(mesh);
        sharedMaterials.push(mesh.material as THREE.Material);
      }
    });

    // Team pennant above the roof (per-view tint; never faded).
    const pennant = this.createPennant(team);
    pennant.mesh.position.y = modelTop + 0.6;
    group.add(pennant.mesh);
    owned.push(pennant.material);

    const w = def.footprintW * CELL_WORLD_SIZE;
    const d = def.footprintH * CELL_WORLD_SIZE;
    group.position.set(
      cellCenterWorld(b.cx) + (w - CELL_WORLD_SIZE) / 2,
      0,
      cellCenterWorld(b.cz) + (d - CELL_WORLD_SIZE) / 2,
    );
    const view: BuildingView = {
      group,
      id: b.id,
      kind,
      modelMeshes,
      sharedMaterials,
      constructing: false,
      owned,
      modelTop,
    };
    // A building placed mid-construction starts faded.
    this.updateBuildingConstruction(view, b.progress);
    return view;
  }

  /**
   * Construction fade with shared materials: while a building is under
   * construction its meshes use per-view material CLONES (transparent);
   * on completion the view swaps back to the shared materials and the
   * clones are released. No cross-talk between views — two buildings of
   * the same kind never share a faded material.
   */
  private updateBuildingConstruction(view: BuildingView, progress: number): void {
    const wantConstructing = progress < 1;
    if (wantConstructing === view.constructing) return;
    view.constructing = wantConstructing;
    if (wantConstructing) {
      for (let i = 0; i < view.modelMeshes.length; i++) {
        const mesh = view.modelMeshes[i] as THREE.Mesh;
        const shared = view.sharedMaterials[i] as THREE.Material;
        const clone = shared.clone();
        clone.transparent = true;
        clone.opacity = 0.55;
        mesh.material = clone;
        view.owned.push(clone);
      }
    } else {
      for (let i = 0; i < view.modelMeshes.length; i++) {
        const mesh = view.modelMeshes[i] as THREE.Mesh;
        (mesh.material as THREE.Material).dispose(); // the construction clone
        mesh.material = view.sharedMaterials[i] as THREE.Material;
      }
      // Rebuild owned without the disposed clones: keep only materials
      // still attached to a live object (the pennant material). Shared
      // materials never enter `owned`, so this keeps exactly the pennant.
      const live = new Set<THREE.Material>();
      view.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !Array.isArray(mesh.material)) live.add(mesh.material as THREE.Material);
      });
      view.owned = view.owned.filter((m) => live.has(m as THREE.Material));
    }
  }

  /** Release per-view objects: pennant + any construction clones. */
  private disposeBuildingView(view: BuildingView): void {
    for (const m of view.owned) m.dispose();
    view.owned.length = 0;
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
    // Connected ribbon quads (one draw call) + center dashes (one more).
    const cells: Array<{ x: number; z: number }> = [];
    for (const c of roads) {
      const { cx, cz } = cellCoords(c as number);
      cells.push({ x: cellCenterWorld(cx), z: cellCenterWorld(cz) });
    }
    const ribbon = buildRoadGeometry(cells, CELL_WORLD_SIZE);
    this.roadMesh = new THREE.Mesh(ribbon, this.roadAsphaltMat);
    this.buildingGroup.add(this.roadMesh);
    const dashes = buildRoadMarkings(cells, CELL_WORLD_SIZE);
    if ((dashes.getAttribute('position') as THREE.BufferAttribute).count > 0) {
      this.roadDashMesh = new THREE.Mesh(dashes, this.roadDashMat);
      this.buildingGroup.add(this.roadDashMesh);
    } else {
      dashes.dispose();
    }
  }

  /** Unit records by id (for selection-ring updates). */
  static unitMap(world: World): Map<number, UnitRecord> {
    const map = new Map<number, UnitRecord>();
    for (const u of world.units) map.set(u.id, u);
    return map;
  }
}

/** Dispose every geometry/material in a group (shared-template teardown). */
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
 * sized to the footprint. Group origin at ground level. Fallback art —
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
