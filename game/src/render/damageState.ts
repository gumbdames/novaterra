/**
 * NOVATERRA — render/damageState.ts — on-map building damage state.
 *
 * Roadmap B13 (2026-10-02): damaged buildings finally show it. Every
 * building below full HP gets a floating HP bar (green → red by
 * fraction) and periodic gray smoke puffs that thicken as the building
 * nears destruction. Repaired buildings lose the bar; destroyed ones are
 * cleaned up.
 *
 * Pooled: one bar-bg + bar-fg sprite pair per tracked building (24 max)
 * and a shared smoke pool (24 puffs). Zero allocation while burning.
 * Smoke reuses CombatVfx's radial-gradient pixel baker (Node-safe).
 *
 * Owned by `EntityRenderer` (constructed in its constructor, synced in
 * `sync()`, disposed in `dispose()`).
 */

import * as THREE from 'three';
import type { World } from '../sim/world';
import { BUILDING_DEFS, type BuildingRecord } from '../sim/city';
import { buildingCenterWorld } from '../sim/intel';
import { glowPixels } from './combatVfx';

/** Max simultaneously tracked damaged buildings. */
export const MAX_DAMAGED_BUILDINGS = 24;
/** HP bar width in world units. */
export const HP_BAR_WIDTH = 10;
/** HP bar height in world units. */
export const HP_BAR_HEIGHT = 1.1;
/** Bar height above the ground. */
export const HP_BAR_Y = 14;
/** Seconds between smoke puffs per damaged building. */
export const DAMAGE_SMOKE_INTERVAL = 0.45;
/** Smoke puff lifetime, seconds. */
export const DAMAGE_SMOKE_LIFE = 1.6;
/** Shared smoke pool size. */
export const MAX_DAMAGE_SMOKE = 24;

/**
 * HP fraction 0..1, or null when the building is at full health (no bar).
 * Missing hp/maxHp fall back to the def (the AD9 `??` precedent).
 * Pure — headless-testable.
 */
export function buildingHpFraction(b: BuildingRecord): number | null {
  const max = b.maxHp ?? BUILDING_DEFS[b.kind].hp;
  const hp = b.hp ?? max;
  if (max <= 0) return null;
  const frac = hp / max;
  return frac >= 1 ? null : Math.max(0, frac);
}

/** Bar color: green → yellow → red as the fraction drops. Pure. */
export function hpBarColor(frac: number): string {
  if (frac > 0.55) return '#58d858';
  if (frac > 0.28) return '#e8c832';
  return '#e04848';
}

interface Tracked {
  id: number;
  bg: THREE.Sprite;
  fg: THREE.Sprite;
  smokeTimer: number;
  /** Returned to the free-list on release. */
  pair: [THREE.Sprite, THREE.Sprite];
}

interface SmokePuff {
  sprite: THREE.Sprite;
  life: number;
}

/** One hidden HP-bar sprite, added to the scene. */
function makeBarSprite(scene: THREE.Scene, tex: THREE.Texture): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.visible = false;
  sprite.renderOrder = 49;
  scene.add(sprite);
  return sprite;
}

export class DamageStateOverlay {
  private readonly scene: THREE.Scene;
  private readonly tracked = new Map<number, Tracked>();
  /** Free (bg, fg) sprite pairs; entries return their pair on release. */
  private readonly freePairs: Array<[THREE.Sprite, THREE.Sprite]> = [];
  private readonly smokePool: SmokePuff[] = [];
  private readonly smokeTexture: THREE.Texture;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const smokeTex = new THREE.DataTexture(
      glowPixels(64, 96, 96, 100),
      64,
      64,
    );
    smokeTex.colorSpace = THREE.SRGBColorSpace;
    smokeTex.needsUpdate = true;
    this.smokeTexture = smokeTex;

    const barTex = new THREE.DataTexture(
      (() => {
        const data = new Uint8Array(4 * 4);
        data.fill(255);
        return data;
      })(),
      2,
      2,
    );
    barTex.needsUpdate = true;
    for (let i = 0; i < MAX_DAMAGED_BUILDINGS; i++) {
      const pair: [THREE.Sprite, THREE.Sprite] = [
        makeBarSprite(this.scene, barTex),
        makeBarSprite(this.scene, barTex),
      ];
      this.freePairs.push(pair);
    }
    for (let i = 0; i < MAX_DAMAGE_SMOKE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.smokeTexture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        opacity: 0.55,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.smokePool.push({ sprite, life: 0 });
    }
  }

  /** Reconcile tracked buildings with the world; tick smoke. */
  sync(world: World, dt: number): void {
    const seen = new Set<number>();
    for (const b of world.city.buildings) {
      if (b.progress < 1) continue; // rising buildings don't burn
      const frac = buildingHpFraction(b);
      if (frac === null) continue;
      seen.add(b.id);
      let t = this.tracked.get(b.id);
      if (!t) {
        const pair = this.freePairs.pop();
        if (!pair) continue; // all bars in use — skip, never allocate
        const [bg, fg] = pair;
        t = { id: b.id, bg, fg, smokeTimer: 0, pair };
        this.tracked.set(b.id, t);
      }
      const c = buildingCenterWorld(b);
      const w = HP_BAR_WIDTH;
      const fgw = w * frac;
      t.bg.visible = true;
      t.bg.position.set(c.x, HP_BAR_Y, c.z);
      t.bg.scale.set(w, HP_BAR_HEIGHT, 1);
      (t.bg.material as THREE.SpriteMaterial).color.set('#101418');
      (t.bg.material as THREE.SpriteMaterial).opacity = 0.85;
      t.fg.visible = true;
      // Left-align the fill: shrink from the right as HP drops.
      t.fg.position.set(c.x - (w - fgw) / 2, HP_BAR_Y, c.z);
      t.fg.scale.set(Math.max(0.01, fgw), HP_BAR_HEIGHT * 0.7, 1);
      (t.fg.material as THREE.SpriteMaterial).color.set(hpBarColor(frac));
      (t.fg.material as THREE.SpriteMaterial).opacity = 1;
      // Smoke thickens as the building dies: interval shrinks with frac.
      t.smokeTimer -= dt;
      if (t.smokeTimer <= 0) {
        t.smokeTimer = DAMAGE_SMOKE_INTERVAL * (0.4 + frac);
        this.puff(c.x, c.z);
      }
    }
    // Drop repaired / destroyed / removed buildings, returning pairs.
    for (const [id, t] of this.tracked) {
      if (!seen.has(id)) {
        t.bg.visible = false;
        t.fg.visible = false;
        this.freePairs.push(t.pair);
        this.tracked.delete(id);
      }
    }
    for (const p of this.smokePool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      const t = 1 - p.life / DAMAGE_SMOKE_LIFE;
      p.sprite.position.y += dt * 7;
      const s = 6 + t * 10;
      p.sprite.scale.set(s, s, 1);
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.55 * (1 - t);
    }
  }

  private puff(x: number, z: number): void {
    const p = this.smokePool.find((q) => q.life <= 0);
    if (!p) return;
    p.life = DAMAGE_SMOKE_LIFE;
    p.sprite.visible = true;
    p.sprite.position.set(x + (Math.random() - 0.5) * 4, 8, z + (Math.random() - 0.5) * 4);
    p.sprite.scale.set(6, 6, 1);
    (p.sprite.material as THREE.SpriteMaterial).opacity = 0.55;
  }

  dispose(): void {
    for (const t of this.tracked.values()) {
      this.scene.remove(t.bg);
      this.scene.remove(t.fg);
      (t.bg.material as THREE.SpriteMaterial).dispose();
      (t.fg.material as THREE.SpriteMaterial).dispose();
    }
    for (const [bg, fg] of this.freePairs) {
      this.scene.remove(bg);
      this.scene.remove(fg);
      (bg.material as THREE.SpriteMaterial).dispose();
      (fg.material as THREE.SpriteMaterial).dispose();
    }
    for (const p of this.smokePool) {
      this.scene.remove(p.sprite);
      (p.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.smokeTexture.dispose();
  }
}
