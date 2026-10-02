/**
 * NOVATERRA — render/constructionDressing.ts — construction-site dressing.
 *
 * Roadmap B17 (2026-10-02): construction used to be a 55%-opacity ghost
 * fade only (the legacy `updateBuildingConstruction` path). Now every
 * building with `progress < 1` gets a scaffold frame + dust puffs:
 *
 * - Scaffold: one merged `LineSegments` for ALL constructing buildings
 *   (1 draw call, 0 when nothing is under construction), rebuilt only
 *   when the membership changes (placement/completion — never per
 *   frame). Each site gets 4 corner poles + 3 levels of horizontal
 *   frames in safety orange; the frame height scales with the footprint
 *   (bigger buildings read taller).
 * - Dust: pooled tan sprites puffing periodically at each site while it
 *   builds (16 max, shared pool).
 *
 * Path-independent: the overlay reads `world.city.buildings` directly,
 * so it dresses construction sites whether the building view itself is
 * on the legacy fade path or waiting for its instanced conversion —
 * the B17 requirement. Owned by `EntityRenderer` (constructed in its
 * constructor, synced in `sync()`, disposed in `dispose()`).
 *
 * Import-safe under Node/vitest (no document/canvas at module scope).
 */

import * as THREE from 'three';
import type { World } from '../sim/world';
import { BUILDING_DEFS, CELL_WORLD_SIZE, type BuildingRecord } from '../sim/city';
import { buildingCenterWorld } from '../sim/intel';
import { glowPixels } from './combatVfx';

/** Scaffold line color: safety orange. */
export const SCAFFOLD_COLOR = 0xe8821e;
/** Dust puff pool size. */
export const MAX_CONSTRUCTION_DUST = 16;
/** Seconds between dust puffs per site. */
export const CONSTRUCTION_DUST_INTERVAL = 0.8;
/** Dust puff lifetime, seconds. */
export const CONSTRUCTION_DUST_LIFE = 1.4;

/**
 * Membership key: sorted ids of buildings with progress < 1. The
 * scaffold mesh rebuilds only when this changes. Pure.
 */
export function constructionKey(buildings: readonly BuildingRecord[]): string {
  const ids: number[] = [];
  for (const b of buildings) {
    if (b.progress < 1) ids.push(b.id);
  }
  ids.sort((a, b) => a - b);
  return ids.join(',');
}

/** Scaffold frame height for a footprint (world units). Pure. */
export function scaffoldHeight(footprintW: number, footprintH: number): number {
  return 6 + Math.max(footprintW, footprintH) * CELL_WORLD_SIZE * 0.75;
}

/**
 * Line segments for one scaffold frame: 4 corner poles + 3 rectangular
 * levels (at 1/3, 2/3, full height). Appends into `positions` as pairs.
 * Pure geometry math — headless-testable.
 */
export function scaffoldSegments(
  minX: number,
  minZ: number,
  w: number,
  d: number,
  h: number,
  positions: number[],
): void {
  const x0 = minX;
  const x1 = minX + w;
  const z0 = minZ;
  const z1 = minZ + d;
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    positions.push(ax, ay, az, bx, by, bz);
  };
  // Corner poles.
  for (const [px, pz] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ] as const) {
    seg(px, 0, pz, px, h, pz);
  }
  // Horizontal frames at thirds + top.
  for (const y of [h / 3, (2 * h) / 3, h]) {
    seg(x0, y, z0, x1, y, z0);
    seg(x1, y, z0, x1, y, z1);
    seg(x1, y, z1, x0, y, z1);
    seg(x0, y, z1, x0, y, z0);
  }
}

interface DustPuff {
  sprite: THREE.Sprite;
  life: number;
}

export class ConstructionDressing {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private lines: THREE.LineSegments | null = null;
  private lastKey: string | null = null;
  private readonly dustPool: DustPuff[] = [];
  private readonly dustTexture: THREE.Texture;
  private readonly dustTimers = new Map<number, number>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = 'construction-dressing';
    scene.add(this.group);
    const dustTex = new THREE.DataTexture(glowPixels(64, 201, 177, 137), 64, 64);
    dustTex.colorSpace = THREE.SRGBColorSpace;
    dustTex.needsUpdate = true;
    this.dustTexture = dustTex;
    for (let i = 0; i < MAX_CONSTRUCTION_DUST; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.dustTexture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        opacity: 0.5,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this.dustPool.push({ sprite, life: 0 });
    }
  }

  /** Sync scaffolds (membership-keyed) + tick dust. */
  sync(world: World, dt: number): void {
    const key = constructionKey(world.city.buildings);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.rebuild(world);
    }
    // Dust: one puff per site on its own timer.
    const seen = new Set<number>();
    for (const b of world.city.buildings) {
      if (b.progress >= 1) continue;
      seen.add(b.id);
      const t = (this.dustTimers.get(b.id) ?? 0) - dt;
      if (t <= 0) {
        this.dustTimers.set(b.id, CONSTRUCTION_DUST_INTERVAL);
        const c = buildingCenterWorld(b);
        const def = BUILDING_DEFS[b.kind];
        const w = (def?.footprintW ?? 1) * CELL_WORLD_SIZE;
        this.puff(
          c.x + (Math.random() - 0.5) * w,
          c.z + (Math.random() - 0.5) * w,
        );
      } else {
        this.dustTimers.set(b.id, t);
      }
    }
    for (const id of this.dustTimers.keys()) {
      if (!seen.has(id)) this.dustTimers.delete(id);
    }
    for (const p of this.dustPool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      const t = 1 - p.life / CONSTRUCTION_DUST_LIFE;
      p.sprite.position.y += dt * 4;
      const s = 4 + t * 7;
      p.sprite.scale.set(s, s, 1);
      (p.sprite.material as THREE.SpriteMaterial).opacity = 0.5 * (1 - t);
    }
  }

  /** Rebuild the merged scaffold lines for the current membership. */
  private rebuild(world: World): void {
    if (this.lines !== null) {
      this.group.remove(this.lines);
      this.lines.geometry.dispose();
      (this.lines.material as THREE.Material).dispose();
      this.lines = null;
    }
    const positions: number[] = [];
    for (const b of world.city.buildings) {
      if (b.progress >= 1) continue;
      const def = BUILDING_DEFS[b.kind];
      const fw = def?.footprintW ?? 1;
      const fh = def?.footprintH ?? 1;
      const c = buildingCenterWorld(b);
      const w = fw * CELL_WORLD_SIZE;
      const d = fh * CELL_WORLD_SIZE;
      scaffoldSegments(
        c.x - w / 2,
        c.z - d / 2,
        w,
        d,
        scaffoldHeight(fw, fh),
        positions,
      );
    }
    if (positions.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    const mat = new THREE.LineBasicMaterial({ color: SCAFFOLD_COLOR, transparent: true, opacity: 0.9 });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
  }

  private puff(x: number, z: number): void {
    const p = this.dustPool.find((q) => q.life <= 0);
    if (!p) return;
    p.life = CONSTRUCTION_DUST_LIFE;
    p.sprite.visible = true;
    p.sprite.position.set(x, 2, z);
    p.sprite.scale.set(4, 4, 1);
    (p.sprite.material as THREE.SpriteMaterial).opacity = 0.5;
  }

  dispose(): void {
    if (this.lines !== null) {
      this.group.remove(this.lines);
      this.lines.geometry.dispose();
      (this.lines.material as THREE.Material).dispose();
      this.lines = null;
    }
    this.scene.remove(this.group);
    for (const p of this.dustPool) {
      this.scene.remove(p.sprite);
      (p.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.dustTexture.dispose();
  }
}
