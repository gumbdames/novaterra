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
 * NOVATERRA — render/combatVfx.ts — combat visual effects.
 *
 * Consumes the sim's `CombatEvent` stream (`world.combatEvents`,
 * B16 2026-10-01) and renders pooled sprite VFX:
 * - muzzle flash (brief, at the attacker)
 * - tracer (stretched sprite from attacker toward the target)
 * - impact flash (small, at the hit point)
 * - explosion (flash + rising smoke, at the destroyed unit/building)
 *
 * Pooled: zero allocation during battle. Textures are `THREE.DataTexture`
 * radial gradients (no canvas, no assets — Node-safe import). The sim
 * clears the event buffer each tick; this system drains it each frame.
 *
 * Owned by `EntityRenderer` (constructed in its constructor, synced in
 * `sync()`, disposed in `dispose()`), following the overlay pattern.
 */

import * as THREE from 'three';
import type { CombatEvent } from '../sim/combat';

interface PooledSprite {
  sprite: THREE.Sprite;
  life: number; // seconds remaining
  maxLife: number; // seconds total
  vx: number; // velocity x (for smoke rise / tracer travel)
  vz: number;
  grow: number; // scale growth per second
}

/** Radial-gradient pixel data (white core → transparent edge). Pure, Node-safe. */
export function glowPixels(size: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const alpha = d >= 1 ? 0 : Math.pow(1 - d, 2);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return data;
}

function makeGlowTexture(r: number, g: number, b: number): THREE.Texture {
  const size = 64;
  const tex = new THREE.DataTexture(glowPixels(size, r, g, b), size, size);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class CombatVfx {
  private scene: THREE.Scene;
  private pool: PooledSprite[] = [];
  private muzzleTex: THREE.Texture;
  private tracerTex: THREE.Texture;
  private explosionTex: THREE.Texture;
  private smokeTex: THREE.Texture;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.muzzleTex = makeGlowTexture(255, 220, 120);
    this.tracerTex = makeGlowTexture(255, 255, 200);
    this.explosionTex = makeGlowTexture(255, 180, 80);
    this.smokeTex = makeGlowTexture(80, 80, 80);
    // Pre-allocate the pool (B16: pooled sprites, zero per-frame alloc).
    for (let i = 0; i < 96; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.muzzleTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.pool.push({ sprite, life: 0, maxLife: 1, vx: 0, vz: 0, grow: 0 });
    }
  }

  /** Spawn VFX for new sim events, then advance all active sprites. */
  update(events: CombatEvent[], dt: number): void {
    for (const e of events) {
      if (e.kind === 'muzzle') {
        this.spawn(e.x, e.z, 0.12, 3, this.muzzleTex, 0, 0, 8);
        // Tracer: stretched sprite halfway to the target.
        const mx = (e.x + e.targetX) / 2;
        const mz = (e.z + e.targetZ) / 2;
        this.spawn(mx, mz, 0.18, 6, this.tracerTex, 0, 0, 0);
      } else if (e.kind === 'impact') {
        this.spawn(e.x, e.z, 0.15, 2.5, this.explosionTex, 0, 0, 6);
      } else if (e.kind === 'explosion') {
        const size = e.large ? 10 : 6;
        this.spawn(e.x, e.z, 0.5, size, this.explosionTex, 0, 0, 12);
        // Smoke: rises and fades (non-additive).
        this.spawn(e.x, e.z, 2.0, size * 0.8, this.smokeTex, 0, 0, 4, true);
      }
    }
    // Advance active sprites.
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      const t = p.life / p.maxLife; // 1 → 0
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.z += p.vz * dt;
      const s = p.sprite.scale.x + p.grow * dt;
      p.sprite.scale.set(s, s, 1);
      (p.sprite.material as THREE.SpriteMaterial).opacity = t;
    }
  }

  private spawn(
    x: number,
    z: number,
    life: number,
    size: number,
    tex: THREE.Texture,
    vx: number,
    vz: number,
    grow: number,
    smoke = false,
  ): void {
    const p = this.pool.find((q) => q.life <= 0);
    if (!p) return; // pool exhausted — drop (better than alloc)
    const mat = p.sprite.material as THREE.SpriteMaterial;
    mat.map = tex;
    mat.blending = smoke ? THREE.NormalBlending : THREE.AdditiveBlending;
    mat.needsUpdate = true;
    p.sprite.position.set(x, 2, z); // y=2: above ground clutter
    p.sprite.scale.set(size, size, 1);
    p.sprite.visible = true;
    mat.opacity = 1;
    p.life = life;
    p.maxLife = life;
    p.vx = vx;
    p.vz = vz;
    p.grow = grow;
  }

  dispose(): void {
    for (const p of this.pool) {
      this.scene.remove(p.sprite);
      (p.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.pool.length = 0;
    this.muzzleTex.dispose();
    this.tracerTex.dispose();
    this.explosionTex.dispose();
    this.smokeTex.dispose();
  }
}
