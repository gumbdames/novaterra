/**
 * NOVATERRA — render/damageNumbers.ts — floating combat damage numbers.
 *
 * Roadmap B13 (2026-10-02): every impact/explosion CombatEvent now
 * carries `damage` + both owners (sim/combat.ts), and this pooled sprite
 * system floats the number above the hit: gold when the human side dealt
 * it, red when the human side took it, white for AI-vs-AI exchanges.
 *
 * Rendering: digits 0-9 are rasterized ONCE onto canvas textures in the
 * constructor (browser-only — the module imports Node-safe); each active
 * number composes up to 4 digit sprites from a pool (20 numbers max, 80
 * sprites). Numbers rise ~6 world units over 0.9s while fading, then
 * release back to the pool. Zero allocation during battle.
 *
 * Owned by `EntityRenderer` (constructed in its constructor, updated in
 * `sync()`, disposed in `dispose()`), next to `CombatVfx`.
 */

import * as THREE from 'three';
import type { CombatEvent } from '../sim/combat';

/** Max simultaneous floating numbers. */
export const MAX_DAMAGE_NUMBERS = 20;
/** Seconds a number stays alive. */
export const DAMAGE_NUMBER_LIFE = 0.9;
/** World units a number rises over its life. */
export const DAMAGE_NUMBER_RISE = 6;
/** Digit sprite height in world units. */
export const DIGIT_HEIGHT = 3;
/** Horizontal advance per digit, in world units. */
export const DIGIT_ADVANCE = 1.9;
/** Damage above this is clamped for display (no 6-digit spam). */
export const MAX_DISPLAY_DAMAGE = 9999;

/**
 * Rounded, clamped digit list for a damage value, most-significant
 * first. Pure — headless-testable.
 */
export function splitDamageDigits(damage: number): number[] {
  const n = Math.max(
    0,
    Math.min(MAX_DISPLAY_DAMAGE, Math.round(damage)),
  );
  return String(n).split('').map((ch) => Number(ch));
}

/**
 * Number color by involvement: gold = the human side dealt it, red =
 * the human side took it, white = neither (AI-vs-AI). Pure.
 */
export function damageNumberColor(
  victimOwner: number,
  attackerOwner: number,
  humanOwner: number,
): string {
  if (attackerOwner === humanOwner) return '#ffd76a';
  if (victimOwner === humanOwner) return '#ff6a5e';
  return '#ffffff';
}

interface Floater {
  active: boolean;
  life: number;
  x: number;
  y: number;
  z: number;
  /** How many of the 4 digit sprites are visible for this number. */
  count: number;
  digits: THREE.Sprite[];
}

/**
 * True when the 2D canvas can rasterize text. Headless test envs may
 * provide a stub canvas without text methods (or no document at all) —
 * the overlay then stays inert instead of throwing, so EntityRenderer
 * stays constructible headless (the B16 CombatVfx precedent: render
 * modules must never break the headless suite).
 */
function canRasterizeText(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const ctx = document.createElement('canvas').getContext('2d');
    return !!ctx && typeof ctx.strokeText === 'function';
  } catch {
    return false;
  }
}

export class DamageNumbers {
  private readonly scene: THREE.Scene;
  private readonly digitTextures: THREE.Texture[] = [];
  private readonly floaters: Floater[] = [];
  private readonly humanOwner: number;

  constructor(scene: THREE.Scene, humanOwner: number) {
    this.scene = scene;
    this.humanOwner = humanOwner;
    // Headless (or stub-canvas) environments can't rasterize digits —
    // stay inert: update() and dispose() tolerate the empty pool.
    if (!canRasterizeText()) return;
    // Rasterize 0-9 once: bold white glyphs with a dark outline so the
    // number reads over any terrain. Tinted per-floater via material
    // color (white texture × color = colored digits).
    for (let d = 0; d <= 9; d++) {
      const c = document.createElement('canvas');
      c.width = 48;
      c.height = 64;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('damageNumbers: 2D canvas unavailable');
      ctx.font = 'bold 52px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(String(d), 24, 34);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(d), 24, 34);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.digitTextures.push(tex);
    }
    for (let i = 0; i < MAX_DAMAGE_NUMBERS; i++) {
      const digits: THREE.Sprite[] = [];
      for (let k = 0; k < 4; k++) {
        const mat = new THREE.SpriteMaterial({
          map: this.digitTextures[0],
          transparent: true,
          depthTest: false,
          depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.visible = false;
        sprite.renderOrder = 50;
        sprite.scale.set(
          (DIGIT_HEIGHT * 48) / 64,
          DIGIT_HEIGHT,
          1,
        );
        this.scene.add(sprite);
        digits.push(sprite);
      }
      this.floaters.push({
        active: false,
        life: 0,
        x: 0,
        y: 0,
        z: 0,
        count: 0,
        digits,
      });
    }
  }

  /** Drain this frame's combat events; advance live floaters. */
  update(events: CombatEvent[], dt: number): void {
    if (this.floaters.length === 0) return; // inert in headless envs
    for (const e of events) {
      if (e.kind !== 'impact' && e.kind !== 'explosion') continue;
      if (!(e.damage >= 1)) continue;
      this.spawn(
        e.x,
        e.z,
        e.damage,
        damageNumberColor(e.victimOwner, e.attackerOwner, this.humanOwner),
      );
    }
    for (const f of this.floaters) {
      if (!f.active) continue;
      f.life -= dt;
      if (f.life <= 0) {
        this.release(f);
        continue;
      }
      const t = 1 - f.life / DAMAGE_NUMBER_LIFE; // 0 → 1
      const y = f.y + t * DAMAGE_NUMBER_RISE;
      const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      for (let i = 0; i < f.count; i++) {
        // B27: no `!` — i < f.count <= f.digits.length (4 sprites per floater).
        const s = f.digits[i];
        if (s === undefined) continue;
        s.position.set(f.x + (i - (f.count - 1) / 2) * DIGIT_ADVANCE, y, f.z);
        (s.material as THREE.SpriteMaterial).opacity = alpha;
      }
    }
  }

  private spawn(x: number, z: number, damage: number, color: string): void {
    const f = this.floaters.find((fl) => !fl.active);
    if (!f) return; // pool exhausted — drop the number, never allocate
    const digits = splitDamageDigits(damage);
    f.active = true;
    f.life = DAMAGE_NUMBER_LIFE;
    f.x = x;
    f.y = 6;
    f.z = z;
    f.count = digits.length;
    for (let i = 0; i < f.digits.length; i++) {
      // B27: no `!` — i is bounded by f.digits.length.
      const s = f.digits[i];
      if (s === undefined) continue;
      const mat = s.material as THREE.SpriteMaterial;
      if (i < digits.length) {
        // B27: no `!` — i < digits.length, so the digit exists.
        const digit = digits[i];
        if (digit === undefined) continue;
        mat.map = this.digitTextures[digit] ?? null;
        mat.color.set(color);
        mat.opacity = 1;
        s.visible = true;
      } else {
        s.visible = false;
      }
    }
  }

  private release(f: Floater): void {
    f.active = false;
    for (const s of f.digits) s.visible = false;
  }

  dispose(): void {
    for (const f of this.floaters) {
      for (const s of f.digits) {
        this.scene.remove(s);
        (s.material as THREE.SpriteMaterial).dispose();
      }
    }
    for (const t of this.digitTextures) t.dispose();
  }
}
