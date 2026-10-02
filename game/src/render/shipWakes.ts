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
 * NOVATERRA — render/shipWakes.ts — foam wakes behind moving ships
 * (roadmap B21, 2026-10-02: small juice).
 *
 * One THREE.InstancedMesh (1 draw call) of flat foam streaks. Each
 * moving sea unit owns one wake quad glued to its stern: the streak
 * stretches with speed and fades (shrinks) over ~1s after the ship
 * stops. Pool of 24 — more moving ships than that simply share nothing
 * (the busiest naval battles stay legible without unbounded cost).
 *
 * Per-instance fade is done by shrinking (instanceColor has no alpha
 * channel); the streak texture itself fades head→tail so a fresh wake
 * reads as dissipating foam, not a solid bar.
 *
 * Render-side only: never touches sim state. Headless-safe (no DOM —
 * the foam texture is a DataTexture, like the combat-VFX glow).
 */

import * as THREE from 'three';

import type { World } from '../sim/world';
import { UNIT_DEFS } from '../sim/units';
import { isSheltered } from '../sim/units';

/** Maximum simultaneous wake quads (1 draw call total). */
export const MAX_WAKES = 24;
/** Ships slower than this (world units/sec) leave no wake. */
export const WAKE_MIN_SPEED = 3;
/** Seconds a wake takes to shrink away after its ship stops. */
export const WAKE_FADE_SEC = 1;

/** One live wake quad. */
interface Wake {
  unitId: number;
  /** 1 = full streak, 0 = gone (shrinking after the ship stopped). */
  strength: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
}

/**
 * Foam streak texture: bright at the head (stern side), fading to
 * transparent at the tail, soft across the width. Deterministic
 * sin-based streaking — no RNG, no canvas.
 */
export function wakeTextureData(size = 64): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1); // across the width
      const v = y / (size - 1); // along the length: 0 = head, 1 = tail
      const across = Math.cos((u - 0.5) * Math.PI);
      const along = Math.pow(1 - v, 1.5);
      const streak = 0.75 + 0.25 * Math.sin(u * 43 + v * 17) * Math.sin(v * 31);
      const a = Math.max(0, Math.min(1, across * across * along * streak));
      const i = (y * size + x) * 4;
      data[i] = 235;
      data[i + 1] = 242;
      data[i + 2] = 250;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return data;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

export class ShipWakes {
  private readonly mesh: THREE.InstancedMesh;
  private readonly wakes = new Map<number, Wake>();
  private readonly lastPos = new Map<number, { x: number; z: number }>();
  private readonly waterY: number;

  constructor(scene: THREE.Scene, waterY: number) {
    this.waterY = waterY;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const texSize = 64;
    const tex = new THREE.DataTexture(
      wakeTextureData(texSize),
      texSize,
      texSize,
    );
    tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_WAKES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Recompute wakes from the world. `dt` is frame seconds (the caller
   * passes the fixed 1/60 juice tick like the other overlays).
   */
  sync(world: World, dt: number): void {
    const seen = new Set<number>();
    for (const u of world.units) {
      if (u.hp <= 0 || isSheltered(u)) continue;
      const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
      if (def?.domain !== 'sea') continue;
      seen.add(u.id);
      const last = this.lastPos.get(u.id);
      const speed =
        last !== undefined && dt > 0
          ? Math.hypot(u.x - last.x, u.z - last.z) / dt
          : 0;
      this.lastPos.set(u.id, { x: u.x, z: u.z });
      let wake = this.wakes.get(u.id);
      if (speed >= WAKE_MIN_SPEED) {
        if (wake === undefined) {
          if (this.wakes.size >= MAX_WAKES) continue;
          wake = { unitId: u.id, strength: 0, x: u.x, z: u.z, yaw: 0, speed: 0 };
          this.wakes.set(u.id, wake);
        }
        // Yaw from movement (models face +z at yaw 0).
        const dx = u.x - (last?.x ?? u.x);
        const dz = u.z - (last?.z ?? u.z);
        if (dx * dx + dz * dz > 1e-6) wake.yaw = Math.atan2(dx, dz);
        wake.x = u.x;
        wake.z = u.z;
        wake.speed = speed;
        wake.strength = Math.min(1, wake.strength + dt * 4);
      } else if (wake !== undefined) {
        // Ship slowed below wake speed: let the fade loop shrink it.
        wake.speed = 0;
      }
    }
    // Drop tracking for gone units; fade their wakes.
    for (const id of this.lastPos.keys()) {
      if (!seen.has(id)) this.lastPos.delete(id);
    }
    let i = 0;
    for (const [id, wake] of this.wakes) {
      if (!seen.has(id) || wake.speed < WAKE_MIN_SPEED) {
        // Ship stopped or gone: shrink away, then release.
        wake.strength -= dt / WAKE_FADE_SEC;
        wake.speed = 0;
        if (wake.strength <= 0) {
          this.wakes.delete(id);
          continue;
        }
      }
      // Stern position: behind the direction of travel.
      const fx = Math.sin(wake.yaw);
      const fz = Math.cos(wake.yaw);
      const sternBack = 3 + wake.speed * 0.12;
      const len = (7 + wake.speed * 0.4) * wake.strength;
      const wid = (2.6 + wake.speed * 0.05) * wake.strength;
      _p.set(
        wake.x - fx * sternBack - fx * len * 0.35,
        this.waterY + 0.06,
        wake.z - fz * sternBack - fz * len * 0.35,
      );
      _q.setFromAxisAngle(_yAxis, wake.yaw);
      _s.set(wid, 1, len);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      i++;
    }
    this.mesh.count = i;
    this.mesh.visible = i > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Live wake count (tests). */
  get wakeCount(): number {
    return this.wakes.size;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    const tex = (this.mesh.material as THREE.MeshBasicMaterial).map;
    tex?.dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
    this.wakes.clear();
    this.lastPos.clear();
  }
}
