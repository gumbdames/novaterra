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
 * NOVATERRA — render/entityInstancing.ts — per-kind instanced entity views
 * (Phase 0 workstream 1: the draw-call ceiling decision).
 *
 * The legacy entity path (`render/entities.ts`) builds one THREE.Group per
 * entity view — model meshes + team stripe + pennant + health-bar sprites —
 * at ~2–8 draw calls per view. Measured on the WebGL2 fallback path that
 * caps a 60fps frame at a few dozen views (see
 * docs/research/tech-stack.md §3.1), two orders of magnitude short of the
 * "thousands of entities" budget (AGENTS.md §2). View caps and far-field
 * impostors were considered and rejected: caps break the game's promise,
 * and impostors only pay off for triangle-bound scenes — ours are
 * draw-call-bound (low-poly models, ~0.1ms CPU per draw call).
 *
 * This module replaces per-view Groups with instanced pools:
 *  - one InstancedMesh per (model pool key × material) for every model
 *    body: GLB pieces (`MODEL_PATHS` keys), procedural gap models
 *    (`procedural:<kind>`), and attach props (`prop:<propKey>`);
 *  - one InstancedMesh for team stripes (unit cylinder, per-instance
 *    scale + team color), one for team pennants (per-instance color);
 *  - two InstancedMeshes for health bars (bg + fg), billboarded per
 *    frame, fg colored per instance by hp fraction — only damaged units
 *    write bar instances, so bars cost 2 draw calls total, not 2/view.
 *
 * Draw calls then scale with DISTINCT KINDS on the field (~58 GLB keys +
 * gap models in the absolute worst case, typically a dozen), never with
 * entity count. Selection rings and superweapon FX stay individual meshes
 * (bounded counts, transient), and buildings under construction keep the
 * legacy per-view fade path (per-instance transparency is not a thing).
 *
 * Ownership: pool geometries/materials are caller-owned (the models map,
 * the renderer's procedural cache) and are NEVER disposed here —
 * `dispose()` releases only instance attributes plus the geometries and
 * materials this module creates itself (stripe/pennant/bar layers).
 * Render-side only: instance slot order follows world iteration order
 * (deterministic); nothing here touches sim state.
 */

import * as THREE from 'three';
import type { LoadedModel } from './models';

/** Initial instance capacity per pool; doubles on overflow (amortized). */
const INITIAL_POOL_CAPACITY = 8;
/** Preallocated health-bar job slots; doubles on overflow (rare). */
const INITIAL_BAR_JOBS = 256;

/** One model piece of an entity: pool key + entity-local offset. */
export interface InstancedPiece {
  /** Pool key: a MODEL_PATHS key, `procedural:<kind>`, or `prop:<propKey>`. */
  pool: string;
  /** Entity-local offset (piece dx/dy/dz); yaw is applied at write time. */
  offset: THREE.Matrix4;
}

/** Options for `EntityInstancer.addEntity`. */
export interface AddEntityOpts {
  /** Units show the team stripe; buildings don't. */
  stripe: boolean;
  /** Stripe radius multiplier (per kind; the shared stripe is r=1). */
  stripeScale: number;
  /** Team color for stripe + pennant. */
  team: THREE.ColorRepresentation;
}

/** Per-frame transform write for one live entity. */
export interface InstanceWrite {
  /** World position of the entity origin (ground/water Y, pre-hover). */
  x: number;
  y: number;
  z: number;
  /** Yaw in radians; hulls face +z at 0. */
  yaw: number;
  /** Hover lift above y (the legacy hull-group offset). */
  baseY: number;
  /** Model top above the base: stripe/pennant/bar anchor. */
  modelTop: number;
  /** 0..1. */
  hpFrac: number;
  /** Health bar visible (damaged units only). */
  showBar: boolean;
}

/** One live InstancedMesh pool: dense, swap-compacted instance storage. */
interface ModelPool {
  key: string;
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Live instance count; instances are dense in [0, count). */
  count: number;
  /** owners[i] = entity id owning instance i (for swap-compaction). */
  owners: number[];
  /** True when matrices/colors changed since the last upload. */
  dirty: boolean;
  /** True when the pool uses per-instance colors. */
  colored: boolean;
}

/** Slot bookkeeping for one instanced entity. */
interface InstancedEntity {
  id: number;
  modelSlots: Array<{ pool: ModelPool; index: number }>;
  /** Entity-local piece offsets, parallel to modelSlots. */
  pieceOffsets: THREE.Matrix4[];
  stripe: { pool: ModelPool; index: number } | null;
  pennant: { pool: ModelPool; index: number } | null;
  stripeScale: number;
}

/** One pending health-bar write (appended during the frame, flushed after). */
interface BarJob {
  x: number;
  y: number;
  z: number;
  frac: number;
}

// Module-scope scratch: no per-frame allocation on the hot path.
const _entity = new THREE.Matrix4();
const _piece = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _color = new THREE.Color();

/** Team-stripe Y offsets, matching the legacy view layout in entities.ts. */
const STRIPE_Y = 0.15;
const PENNANT_Y = 0.55;
const BAR_Y = 1.1;
const BAR_W = 4;
const BAR_H = 0.5;

/** hp-fraction → bar color (green → yellow → red), as in entities.ts. */
function barColorFor(frac: number): number {
  return frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfacc15 : 0xef4444;
}

/**
 * Per-kind instanced entity views. Owns one THREE.Group in the scene;
 * the caller (EntityRenderer) drives add/remove/write per frame and calls
 * endFrame(camera) after the last write.
 */
export class EntityInstancer {
  private readonly group = new THREE.Group();
  private readonly pools = new Map<string, ModelPool>();
  private readonly entities = new Map<number, InstancedEntity>();
  /**
   * Owned overlay layers (stripe / pennant / health bars), created lazily
   * on first use so an empty instancer (or one driving only complete
   * buildings, which have no stripe) adds no pools at all.
   */
  private stripePool: ModelPool | null = null;
  private pennantPool: ModelPool | null = null;
  private barBgPool: ModelPool | null = null;
  private barFgPool: ModelPool | null = null;
  /** Reusable bar-job buffer (length reset per frame). */
  private barJobs: BarJob[] = [];
  private barJobCount = 0;
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.group.name = 'instancedEntities';
    scene.add(this.group);
    for (let i = 0; i < INITIAL_BAR_JOBS; i++) {
      this.barJobs.push({ x: 0, y: 0, z: 0, frac: 1 });
    }
  }

  /**
   * Register a model's geometry/material pairs under a pool key. One
   * InstancedMesh is created per (key × material) — GLB assets arrive
   * merged per material, so this is usually one pool per key. Idempotent;
   * geometries/materials stay caller-owned (never disposed here).
   */
  definePool(key: string, model: LoadedModel): void {
    for (let i = 0; i < model.geometries.length; i++) {
      const poolKey = `${key}#${i}`;
      if (this.pools.has(poolKey)) continue;
      const geo = model.geometries[i];
      const mat = model.materials[i] ?? model.materials[0];
      if (geo === undefined || mat === undefined) continue;
      const mesh = new THREE.InstancedMesh(geo, mat, INITIAL_POOL_CAPACITY);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // All-or-nothing culling would pop instances mid-pan; the real game
      // culls per chunk later (tech-stack.md §3). Measure full throughput.
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.pools.set(poolKey, {
        key: poolKey,
        mesh,
        capacity: INITIAL_POOL_CAPACITY,
        count: 0,
        owners: [],
        dirty: false,
        colored: false,
      });
    }
  }

  /**
   * Add an entity's instance slots. Every piece pool must have been
   * registered with definePool first. Re-adding an existing id replaces
   * it (remove + add).
   */
  addEntity(id: number, pieces: InstancedPiece[], opts: AddEntityOpts): void {
    this.assertLive();
    if (this.entities.has(id)) this.removeEntity(id);
    const entity: InstancedEntity = {
      id,
      modelSlots: [],
      pieceOffsets: [],
      stripe: null,
      pennant: null,
      stripeScale: opts.stripeScale,
    };
    _color.set(opts.team);
    for (const piece of pieces) {
      // A model key may own several material pools (#0, #1, …): the
      // piece contributes one instance to EACH of its key's pools.
      for (const pool of this.pools.values()) {
        if (!pool.key.startsWith(`${piece.pool}#`)) continue;
        const index = this.alloc(pool, id);
        entity.modelSlots.push({ pool, index });
        entity.pieceOffsets.push(piece.offset.clone());
      }
    }
    if (opts.stripe) {
      const stripePool = this.stripeLayer();
      const index = this.alloc(stripePool, id);
      stripePool.mesh.setColorAt(index, _color);
      entity.stripe = { pool: stripePool, index };
    }
    const pennantPool = this.pennantLayer();
    const pennantIndex = this.alloc(pennantPool, id);
    pennantPool.mesh.setColorAt(pennantIndex, _color);
    entity.pennant = { pool: pennantPool, index: pennantIndex };
    this.entities.set(id, entity);
  }

  /** Release an entity's slots (swap-compacted; unknown ids are ignored). */
  removeEntity(id: number): void {
    const entity = this.entities.get(id);
    if (entity === undefined) return;
    for (const slot of entity.modelSlots) this.free(slot.pool, slot.index);
    if (entity.stripe !== null) this.free(entity.stripe.pool, entity.stripe.index);
    if (entity.pennant !== null) this.free(entity.pennant.pool, entity.pennant.index);
    this.entities.delete(id);
  }

  /** Live entity count (tests + bench). */
  get entityCount(): number {
    return this.entities.size;
  }

  /**
   * Write one entity's per-frame transform: model pieces, stripe,
   * pennant, and (when damaged) a health-bar job for the endFrame flush.
   * Must be called every frame for every visible entity; call
   * beginFrame() first and endFrame(camera) after the last write.
   */
  writeTransform(id: number, w: InstanceWrite): void {
    const entity = this.entities.get(id);
    if (entity === undefined) return;
    // Entity matrix: world position (with hover lift) × yaw.
    _quat.setFromAxisAngle(_yAxis, w.yaw);
    _pos.set(w.x, w.y + w.baseY, w.z);
    _scl.set(1, 1, 1);
    _entity.compose(_pos, _quat, _scl);
    for (let i = 0; i < entity.modelSlots.length; i++) {
      const slot = entity.modelSlots[i] as { pool: ModelPool; index: number };
      const offset = entity.pieceOffsets[i] as THREE.Matrix4;
      _piece.multiplyMatrices(_entity, offset);
      slot.pool.mesh.setMatrixAt(slot.index, _piece);
      slot.pool.dirty = true;
    }
    if (entity.stripe !== null) {
      _pos.set(w.x, w.y + w.baseY + w.modelTop + STRIPE_Y, w.z);
      _scl.set(entity.stripeScale, 1, entity.stripeScale);
      _quat.identity();
      _piece.compose(_pos, _quat, _scl);
      entity.stripe.pool.mesh.setMatrixAt(entity.stripe.index, _piece);
      entity.stripe.pool.dirty = true;
    }
    if (entity.pennant !== null) {
      _pos.set(w.x, w.y + w.baseY + w.modelTop + PENNANT_Y, w.z);
      _scl.set(1, 1, 1);
      _piece.compose(_pos, _quat, _scl);
      entity.pennant.pool.mesh.setMatrixAt(entity.pennant.index, _piece);
      entity.pennant.pool.dirty = true;
    }
    if (w.showBar) {
      if (this.barJobCount >= this.barJobs.length) {
        const grown: BarJob[] = new Array(this.barJobs.length * 2);
        for (let i = 0; i < this.barJobs.length; i++) {
          grown[i] = this.barJobs[i] as BarJob;
        }
        for (let i = this.barJobs.length; i < grown.length; i++) {
          grown[i] = { x: 0, y: 0, z: 0, frac: 1 };
        }
        this.barJobs = grown;
      }
      const job = this.barJobs[this.barJobCount] as BarJob;
      job.x = w.x - BAR_W / 2;
      job.y = w.y + w.baseY + w.modelTop + BAR_Y;
      job.z = w.z;
      job.frac = Math.max(0, Math.min(1, w.hpFrac));
      this.barJobCount++;
    }
  }

  /** Reset the per-frame bar-job cursor. Call before the frame's writes. */
  beginFrame(): void {
    this.barJobCount = 0;
  }

  /**
   * Flush the frame: billboard health bars toward the camera, upload
   * dirty instance buffers, and hide empty pools (0 draw calls). The
   * camera is optional — without it (headless tests) bars face +z.
   */
  endFrame(camera?: THREE.Camera): void {
    this.assertLive();
    if (camera !== undefined) {
      _quat.copy(camera.quaternion);
    } else {
      _quat.identity();
    }
    if (this.barJobCount > 0) {
      const { bg, fg } = this.barLayers();
      this.ensureBarCapacity(this.barJobCount);
      for (let i = 0; i < this.barJobCount; i++) {
        const job = this.barJobs[i] as BarJob;
        // bg: full-width dark quad, centered.
        _pos.set(job.x + BAR_W / 2, job.y, job.z);
        _scl.set(BAR_W, BAR_H, 1);
        _piece.compose(_pos, _quat, _scl);
        bg.mesh.setMatrixAt(i, _piece);
        // fg: hp-scaled quad, left-anchored like the legacy sprite.
        const w = BAR_W * job.frac;
        _pos.set(job.x + w / 2, job.y, job.z);
        _scl.set(Math.max(w, 0.0001), BAR_H, 1);
        _piece.compose(_pos, _quat, _scl);
        fg.mesh.setMatrixAt(i, _piece);
        fg.mesh.setColorAt(i, _color.setHex(barColorFor(job.frac)));
      }
      bg.mesh.count = this.barJobCount;
      fg.mesh.count = this.barJobCount;
      bg.mesh.visible = true;
      fg.mesh.visible = true;
      bg.mesh.instanceMatrix.needsUpdate = true;
      fg.mesh.instanceMatrix.needsUpdate = true;
      if (fg.mesh.instanceColor !== null) {
        fg.mesh.instanceColor.needsUpdate = true;
      }
    }
    // Upload dirty model/stripe/pennant pools; hide emptied ones.
    for (const pool of this.pools.values()) this.flushPool(pool);
    if (this.stripePool !== null) this.flushPool(this.stripePool);
    if (this.pennantPool !== null) this.flushPool(this.pennantPool);
  }

  /**
   * Draw calls this instancer contributes this frame: one per non-empty
   * pool. Scales with distinct kinds, never with entity count.
   */
  drawCallCount(): number {
    let n = 0;
    for (const pool of this.pools.values()) {
      if (pool.count > 0) n++;
    }
    if (this.stripePool !== null && this.stripePool.count > 0) n++;
    if (this.pennantPool !== null && this.pennantPool.count > 0) n++;
    if (this.barJobCount > 0) n += 2;
    return n;
  }

  /** Per-pool live instance counts (tests + bench). */
  poolStats(): Array<{ key: string; count: number; capacity: number }> {
    const out: Array<{ key: string; count: number; capacity: number }> = [];
    for (const pool of this.pools.values()) {
      out.push({ key: pool.key, count: pool.count, capacity: pool.capacity });
    }
    return out;
  }

  /**
   * Copy of one pool's instance matrices (tests: determinism checks).
   * Returns null for unknown pools.
   */
  debugMatrices(poolKey: string, materialIndex = 0): Float32Array | null {
    const pool = this.pools.get(`${poolKey}#${materialIndex}`);
    if (pool === undefined) return null;
    return pool.mesh.instanceMatrix.array.slice(
      0,
      pool.count * 16,
    ) as Float32Array;
  }

  /** Release instance attributes + owned layer assets. Never touches
   * caller-owned pool geometries/materials. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pool of this.pools.values()) {
      this.group.remove(pool.mesh);
      pool.mesh.dispose(); // instance attributes only; geo/mat are shared
    }
    this.pools.clear();
    for (const pool of [
      this.stripePool,
      this.pennantPool,
      this.barBgPool,
      this.barFgPool,
    ]) {
      if (pool === null) continue;
      this.group.remove(pool.mesh);
      pool.mesh.dispose();
      pool.mesh.geometry.dispose();
      (pool.mesh.material as THREE.Material).dispose();
    }
    this.stripePool = null;
    this.pennantPool = null;
    this.barBgPool = null;
    this.barFgPool = null;
    this.entities.clear();
    this.group.removeFromParent();
  }

  // ---- internals ----

  /** Lazy team-stripe layer: unit cylinder r=1 h=0.22 (legacy: per-kind
   * radius size.x*0.32, applied here as per-instance scale). */
  private stripeLayer(): ModelPool {
    if (this.stripePool === null) {
      this.stripePool = this.createOwnedPool(
        'stripe',
        new THREE.CylinderGeometry(1, 1, 0.22, 20),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
        true,
      );
    }
    return this.stripePool;
  }

  /** Lazy team-pennant layer: same sphere the legacy path uses,
   * per-instance color. */
  private pennantLayer(): ModelPool {
    if (this.pennantPool === null) {
      this.pennantPool = this.createOwnedPool(
        'pennant',
        new THREE.SphereGeometry(0.16, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
        true,
      );
    }
    return this.pennantPool;
  }

  /** Lazy health-bar layer: camera-facing quads; bg dark, fg hp-colored. */
  private barLayers(): { bg: ModelPool; fg: ModelPool } {
    if (this.barBgPool === null || this.barFgPool === null) {
      const barGeo = new THREE.PlaneGeometry(1, 1);
      this.barBgPool = this.createOwnedPool(
        'barBg',
        barGeo,
        new THREE.MeshBasicMaterial({
          color: 0x1a1a1a,
          depthTest: false,
          transparent: true,
        }),
        false,
      );
      this.barFgPool = this.createOwnedPool(
        'barFg',
        barGeo.clone(),
        new THREE.MeshBasicMaterial({
          color: 0x4ade80,
          depthTest: false,
          transparent: true,
        }),
        true,
      );
      this.barBgPool.mesh.renderOrder = 10;
      this.barFgPool.mesh.renderOrder = 11;
    }
    return { bg: this.barBgPool, fg: this.barFgPool };
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('EntityInstancer: used after dispose()');
  }

  /** An instancer-owned layer pool (stripe/pennant/bars): geometry and
   * material are created here and disposed in dispose(). */
  private createOwnedPool(
    key: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    colored: boolean,
  ): ModelPool {
    const mesh = new THREE.InstancedMesh(geometry, material, INITIAL_POOL_CAPACITY);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.visible = false;
    if (colored) {
      // Allocate the instanceColor buffer up front so setColorAt never
      // reallocates mid-frame.
      mesh.setColorAt(0, _color.set(0xffffff));
      if (mesh.instanceColor !== null) {
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
    }
    this.group.add(mesh);
    return {
      key,
      mesh,
      capacity: INITIAL_POOL_CAPACITY,
      count: 0,
      owners: [],
      dirty: false,
      colored,
    };
  }

  private alloc(pool: ModelPool, entityId: number): number {
    if (pool.count >= pool.capacity) this.grow(pool);
    const index = pool.count++;
    pool.owners[index] = entityId;
    pool.dirty = true;
    return index;
  }

  /** Swap-compacted free: the last instance moves into the freed slot and
   * its owner's record is updated, keeping storage dense. */
  private free(pool: ModelPool, index: number): void {
    const last = --pool.count;
    if (index !== last) {
      pool.mesh.getMatrixAt(last, _piece);
      pool.mesh.setMatrixAt(index, _piece);
      if (pool.colored && pool.mesh.instanceColor !== null) {
        pool.mesh.getColorAt(last, _color);
        pool.mesh.setColorAt(index, _color);
      }
      const movedId = pool.owners[last] as number;
      pool.owners[index] = movedId;
      const moved = this.entities.get(movedId);
      if (moved !== undefined) {
        for (const slot of moved.modelSlots) {
          if (slot.pool === pool && slot.index === last) slot.index = index;
        }
        if (moved.stripe?.pool === pool && moved.stripe.index === last) {
          moved.stripe.index = index;
        }
        if (moved.pennant?.pool === pool && moved.pennant.index === last) {
          moved.pennant.index = index;
        }
      }
    }
    pool.dirty = true;
  }

  /** Double a pool's capacity, preserving instance order. */
  private grow(pool: ModelPool): void {
    const next = Math.max(INITIAL_POOL_CAPACITY, pool.capacity * 2);
    const mesh = new THREE.InstancedMesh(
      pool.mesh.geometry,
      pool.mesh.material,
      next,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = pool.mesh.renderOrder;
    mesh.visible = pool.mesh.visible;
    const src = pool.mesh.instanceMatrix.array as Float32Array;
    (mesh.instanceMatrix.array as Float32Array).set(src.subarray(0, pool.count * 16));
    if (pool.colored && pool.mesh.instanceColor !== null) {
      for (let i = 0; i < pool.count; i++) {
        pool.mesh.getColorAt(i, _color);
        mesh.setColorAt(i, _color);
      }
      if (mesh.instanceColor !== null) {
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
    }
    const parent = pool.mesh.parent;
    if (parent !== null) parent.remove(pool.mesh);
    pool.mesh.dispose();
    this.group.add(mesh);
    pool.mesh = mesh;
    pool.capacity = next;
    pool.dirty = true;
  }

  private ensureBarCapacity(jobs: number): void {
    const { bg, fg } = this.barLayers();
    if (jobs <= bg.capacity) return;
    let next = bg.capacity;
    while (next < jobs) next *= 2;
    for (const pool of [bg, fg]) {
      const mesh = new THREE.InstancedMesh(
        pool.mesh.geometry,
        pool.mesh.material,
        next,
      );
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = pool.mesh.renderOrder;
      if (pool.colored) {
        mesh.setColorAt(0, _color.set(0xffffff));
        if (mesh.instanceColor !== null) {
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
      }
      this.group.remove(pool.mesh);
      pool.mesh.dispose();
      this.group.add(mesh);
      pool.mesh = mesh;
      pool.capacity = next;
    }
  }

  private flushPool(pool: ModelPool): void {
    pool.mesh.visible = pool.count > 0;
    // The mesh's render count must track the live slot count exactly:
    // InstancedMesh renders mesh.count instances, and uninitialized
    // slots past pool.count hold stale matrices (ghosts at the origin).
    pool.mesh.count = pool.count;
    if (!pool.dirty) return;
    pool.dirty = false;
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.colored && pool.mesh.instanceColor !== null) {
      pool.mesh.instanceColor.needsUpdate = true;
    }
  }
}
