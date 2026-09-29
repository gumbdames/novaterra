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
 * NOVATERRA — render/proceduralModels.ts — procedural 3D models for the
 * entities no CC0 GLB covers (0.1 Alpha).
 *
 * Purpose: detailed, NON-cube procedural builders for the 8 gap kinds in
 * the entity→model mapping (see docs/research/real-models.md §2): the
 * military units artillery / aa / fighter / transport / drone /
 * destroyer, and the buildings mediaCenter / stormArray. Each builder
 * returns a `LoadedModel`-compatible `{ geometries, materials }` with
 * merged per-material geometry, base at y=0, forward = +z — the same
 * contract as `models.ts`, so `render/entities.ts` can treat GLB and
 * procedural models identically.
 *
 * Also home to small procedural *props* attached to GLB models:
 * infantry gear (rifleman's rifle, engineer's hard-hat), the HQ command
 * antenna, and the aegisControl radar dish.
 *
 * Style: flat-shaded low-poly (flatShading: true) to sit with the
 * Kenney/Quaternius GLBs; every model must read clearly at RTS camera
 * distance — silhouette first, ≥3 parts, no plain cubes.
 *
 * Import-safe under Node/vitest: `three` core + `BufferGeometryUtils`
 * touch no DOM at import time. Builders allocate fresh geometry per
 * call; `render/entities.ts` caches one copy per kind and shares it
 * across all views.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { LoadedModel } from './models';

/** Flat-shaded standard material shared within one built model. */
function pmat(
  color: number,
  opts: { emissive?: number; emissiveIntensity?: number; roughness?: number; metalness?: number } = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.7,
    metalness: opts.metalness ?? 0.25,
    flatShading: true,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
}

/** Compose a transform matrix from position / euler / scale. */
function tr(
  px = 0,
  py = 0,
  pz = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy?: number,
  sz?: number,
): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    q,
    new THREE.Vector3(sx, sy ?? sx, sz ?? sx),
  );
}

/** Accumulates transformed parts, merges per material on build(). */
class ModelBuilder {
  private readonly buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(geo: THREE.BufferGeometry, mat: THREE.Material, m?: THREE.Matrix4): this {
    if (m !== undefined) geo.applyMatrix4(m);
    const arr = this.buckets.get(mat);
    if (arr !== undefined) arr.push(geo);
    else this.buckets.set(mat, [geo]);
    return this;
  }

  /** Cylinder beam between two points (trail legs, braces, masts...). */
  beam(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    radius: number,
    mat: THREE.Material,
    radialSegs = 8,
  ): this {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(radius, radius, len, radialSegs);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.normalize(),
    );
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    return this.add(
      geo,
      mat,
      new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)),
    );
  }

  build(): LoadedModel {
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    for (const [mat, geos] of this.buckets) {
      const merged = mergeGeometries(geos, false);
      if (merged !== null) {
        for (const g of geos) g.dispose();
        geometries.push(merged);
        materials.push(mat);
      } else {
        // Attribute mismatch (shouldn't happen: all parts carry
        // position/normal/uv) — keep pieces unmerged rather than drop.
        for (const g of geos) {
          geometries.push(g);
          materials.push(mat);
        }
      }
    }
    return { geometries, materials };
  }
}

// ---------------------------------------------------------------------------
// artillery — tracked howitzer (target hull {3.0, 1.6, 5.2})
// ---------------------------------------------------------------------------

function buildArtillery(): LoadedModel {
  const b = new ModelBuilder();
  const olive = pmat(0x5c6247);
  const dark = pmat(0x2c2c30, { roughness: 0.5, metalness: 0.6 });
  const tire = pmat(0x1d1d20, { roughness: 0.95, metalness: 0 });

  // Gun platform: low rounded turntable base.
  b.add(new THREE.CylinderGeometry(1.05, 1.2, 0.35, 14), olive, tr(0, 0.35, 0.2));
  // Spoked road wheels: tire + hub, both sides.
  for (const sx of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.55, 0.55, 0.28, 14), tire, tr(sx * 1.0, 0.55, -0.5, 0, 0, Math.PI / 2));
    b.add(new THREE.CylinderGeometry(0.22, 0.22, 0.32, 10), dark, tr(sx * 1.0, 0.55, -0.5, 0, 0, Math.PI / 2));
  }
  // Split trail legs splayed back to the ground (tips rest at y=0).
  for (const sx of [-1, 1]) {
    b.beam(0, 0.55, -0.4, sx * 1.05, 0.14, -2.3, 0.14, olive);
    // Spade plate at the leg tip.
    b.add(new THREE.BoxGeometry(0.4, 0.3, 0.08), dark, tr(sx * 1.05, 0.15, -2.32));
  }
  // Armored shield: partial cylinder shell facing forward.
  const shield = new THREE.CylinderGeometry(1.0, 1.0, 1.0, 12, 1, true, Math.PI * 0.72, Math.PI * 0.56);
  b.add(shield, olive, tr(0, 1.0, 0.35, 0, Math.PI, 0));
  // Breech block + elevating cradle.
  b.add(new THREE.BoxGeometry(0.5, 0.45, 0.7), dark, tr(0, 1.05, 0.1));
  // Long barrel, slightly elevated, with muzzle brake.
  const barrelLen = 3.1;
  const elev = 0.21; // ~12°
  const pivot = new THREE.Vector3(0, 1.1, 0.3);
  const dir = new THREE.Vector3(0, Math.sin(elev), Math.cos(elev));
  const tip = pivot.clone().addScaledVector(dir, barrelLen);
  b.beam(pivot.x, pivot.y, pivot.z, tip.x, tip.y, tip.z, 0.11, dark, 10);
  b.beam(tip.x, tip.y, tip.z, tip.x + dir.x * 0.35, tip.y + dir.y * 0.35, tip.z + dir.z * 0.35, 0.16, dark, 10);
  return b.build();
}

// ---------------------------------------------------------------------------
// aa — mobile AA missile launcher (target hull {3.0, 2.2, 4.4})
// ---------------------------------------------------------------------------

/**
 * Mobile AA missile launcher (target hull {3.0, 2.2, 4.4}): truck base
 * with a rotating twin missile-pod launcher elevated skyward.
 */
function buildAA(): LoadedModel {
  const b = new ModelBuilder();
  const green = pmat(0x4d5c50);
  const dark = pmat(0x2a2d33, { roughness: 0.5, metalness: 0.6 });
  const glass = pmat(0x18242e, { roughness: 0.25, metalness: 0.4 });

  b.add(new THREE.BoxGeometry(2.1, 0.5, 3.6), green, tr(0, 0.62, 0));
  b.add(new THREE.BoxGeometry(1.9, 0.85, 1.1), green, tr(0, 1.25, 1.35));
  b.add(new THREE.BoxGeometry(1.7, 0.5, 0.12), glass, tr(0, 1.35, 1.92, -0.25, 0, 0));
  for (const sx of [-1, 1]) {
    for (const wz of [-1.25, 0.1, 1.35]) {
      b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12), dark, tr(sx * 1.02, 0.42, wz, 0, 0, Math.PI / 2));
    }
  }
  b.add(new THREE.CylinderGeometry(0.95, 1.05, 0.3, 14), dark, tr(0, 1.0, -0.5));
  b.add(new THREE.CylinderGeometry(0.55, 0.7, 0.5, 12), green, tr(0, 1.35, -0.5));

  // Twin pods, each a 2x2 cluster of missile tubes elevated ~57°.
  const elev = 1.0;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-(Math.PI / 2 - elev), 0, 0));
  for (const sx of [-1, 1]) {
    // Pivot cheeks.
    b.add(new THREE.BoxGeometry(0.16, 0.8, 0.6), dark, tr(sx * 0.68, 1.75, -0.5));
    // Pod frame box.
    const podLen = 2.2;
    const center = new THREE.Vector3(sx * 0.45, 2.5, -0.75);
    b.add(
      new THREE.BoxGeometry(0.5, 0.5, podLen),
      green,
      new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1)),
    );
    // Four tube mouths (dark rings) at the pod's skyward end.
    const dir = new THREE.Vector3(0, Math.sin(elev), Math.cos(elev));
    const mouth = center.clone().addScaledVector(dir, podLen / 2);
    for (const ox of [-0.13, 0.13]) {
      for (const oy of [-0.13, 0.13]) {
        const off = new THREE.Vector3(ox, oy, 0).applyQuaternion(q);
        b.add(
          new THREE.CylinderGeometry(0.11, 0.11, 0.18, 8),
          dark,
          new THREE.Matrix4().compose(
            mouth.clone().add(off),
            q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))),
            new THREE.Vector3(1, 1, 1),
          ),
        );
      }
    }
  }
  // Small search-radar mast behind the launcher.
  b.beam(0, 1.1, -1.7, 0, 2.1, -1.7, 0.06, dark);
  b.add(new THREE.BoxGeometry(0.7, 0.08, 0.18), dark, tr(0, 2.15, -1.7));
  return b.build();
}

// ---------------------------------------------------------------------------
// fighter — jet (target hull {6.4 wingspan, 0.9, 4.2 length})
// ---------------------------------------------------------------------------

function buildFighter(): LoadedModel {
  const b = new ModelBuilder();
  const gray = pmat(0x9aa2ad, { roughness: 0.45, metalness: 0.55 });
  const dark = pmat(0x2c3138, { roughness: 0.5, metalness: 0.6 });
  const glass = pmat(0x141e28, { roughness: 0.15, metalness: 0.5 });
  const glow = pmat(0xff7a2a, { emissive: 0xff5a1a, emissiveIntensity: 1.6 });

  // Tapered fuselage along z + nose cone.
  b.add(new THREE.CylinderGeometry(0.26, 0.4, 3.2, 12), gray, tr(0, 0.45, 0, Math.PI / 2, 0, 0));
  b.add(new THREE.ConeGeometry(0.26, 0.9, 12), gray, tr(0, 0.45, 2.05, Math.PI / 2, 0, 0));
  // Canopy: squashed dark sphere.
  b.add(new THREE.SphereGeometry(0.3, 12, 10), glass, tr(0, 0.72, 0.55, 0, 0, 0, 1, 0.62, 1.5));
  // Swept wings: flattened boxes, swept back.
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(2.7, 0.07, 1.15), gray, tr(sx * 1.55, 0.38, -0.45, 0, sx * -0.5, 0));
    // Wingtip missile rails.
    b.add(new THREE.CylinderGeometry(0.07, 0.07, 0.8, 8), dark, tr(sx * 2.75, 0.38, -0.75, Math.PI / 2, 0, 0));
  }
  // Tail: vertical fin + horizontal stabilizers.
  b.add(new THREE.BoxGeometry(0.08, 0.75, 0.95), gray, tr(0, 0.85, -1.55, -0.25, 0, 0));
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(1.1, 0.06, 0.6), gray, tr(sx * 0.7, 0.42, -1.6, 0, sx * -0.35, 0));
  }
  // Twin engine nozzles with afterburner glow.
  for (const sx of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.2, 0.24, 0.5, 10), dark, tr(sx * 0.3, 0.35, -1.75, Math.PI / 2, 0, 0));
    b.add(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 10), glow, tr(sx * 0.3, 0.35, -2.0, Math.PI / 2, 0, 0));
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// transport — helicopter (target hull {7.2 rotor, 1.6, 5.6})
// ---------------------------------------------------------------------------

function buildTransport(): LoadedModel {
  const b = new ModelBuilder();
  const body = pmat(0x7a8494, { roughness: 0.5, metalness: 0.4 });
  const dark = pmat(0x2c3138, { roughness: 0.5, metalness: 0.6 });
  const glass = pmat(0x141e28, { roughness: 0.15, metalness: 0.5 });

  // Rounded body + cockpit glass.
  b.add(new THREE.SphereGeometry(1, 16, 12), body, tr(0, 1.05, 0.3, 0, 0, 0, 1.05, 0.78, 1.55));
  b.add(new THREE.SphereGeometry(0.55, 12, 10), glass, tr(0, 1.2, 1.55, 0, 0, 0, 1, 0.75, 0.9));
  // Belly cargo box hint.
  b.add(new THREE.BoxGeometry(1.5, 0.5, 1.8), dark, tr(0, 0.45, -0.2));
  // Tail boom tapering back + vertical fin.
  b.beam(0, 1.15, -1.2, 0, 1.45, -3.6, 0.22, body, 10);
  b.add(new THREE.BoxGeometry(0.1, 0.8, 0.6), body, tr(0, 1.75, -3.55));
  // Tail rotor: two crossed thin blades on the fin side.
  b.add(new THREE.BoxGeometry(0.04, 0.9, 0.12), dark, tr(0.12, 1.6, -3.6));
  b.add(new THREE.BoxGeometry(0.04, 0.12, 0.9), dark, tr(0.12, 1.6, -3.6));
  // Main mast + 4-blade rotor.
  b.add(new THREE.CylinderGeometry(0.1, 0.12, 0.5, 8), dark, tr(0, 2.0, 0.2));
  for (let i = 0; i < 4; i++) {
    b.add(new THREE.BoxGeometry(3.4, 0.045, 0.3), dark, tr(0, 2.28, 0.2, 0, (i * Math.PI) / 2, 0));
  }
  b.add(new THREE.SphereGeometry(0.14, 8, 8), dark, tr(0, 2.3, 0.2));
  // Skids: two tubes + four struts.
  for (const sx of [-1, 1]) {
    b.beam(sx * 0.95, 0.12, 1.5, sx * 0.95, 0.12, -1.3, 0.06, dark);
    b.beam(sx * 0.95, 0.12, 1.1, sx * 0.6, 0.6, 0.9, 0.05, dark);
    b.beam(sx * 0.95, 0.12, -0.9, sx * 0.6, 0.6, -0.7, 0.05, dark);
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// drone — quadcopter (target hull {2.4, 0.6, 2.4})
// ---------------------------------------------------------------------------

function buildDrone(): LoadedModel {
  const b = new ModelBuilder();
  const frame = pmat(0x3a3f47, { roughness: 0.5, metalness: 0.5 });
  const accent = pmat(0x57c8ff, { emissive: 0x2266aa, emissiveIntensity: 0.8 });
  const rotorMat = pmat(0x22262c, { roughness: 0.4, metalness: 0.3 });

  // Central body + camera eye.
  b.add(new THREE.SphereGeometry(0.32, 12, 10), frame, tr(0, 0.38, 0, 0, 0, 0, 1, 0.62, 1));
  b.add(new THREE.SphereGeometry(0.1, 8, 8), accent, tr(0, 0.3, 0.3));
  // Four arms with motors and rotor discs.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const ex = sx * 0.85;
      const ez = sz * 0.85;
      b.beam(0, 0.36, 0, ex, 0.4, ez, 0.055, frame);
      b.add(new THREE.CylinderGeometry(0.09, 0.11, 0.14, 8), frame, tr(ex, 0.44, ez));
      b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.025, 14), rotorMat, tr(ex, 0.54, ez));
      // Tiny nav light on two arms.
      if (sx < 0) b.add(new THREE.SphereGeometry(0.045, 6, 6), accent, tr(ex, 0.42, ez));
    }
  }
  // Landing feet.
  for (const sx of [-1, 1]) {
    b.beam(sx * 0.2, 0.22, 0.25, sx * 0.2, 0.02, 0.25, 0.03, frame);
    b.beam(sx * 0.2, 0.22, -0.25, sx * 0.2, 0.02, -0.25, 0.03, frame);
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// destroyer — warship (target hull {5.0, 3.5, 17.0}); waterline at y=0
// ---------------------------------------------------------------------------

function buildDestroyer(): LoadedModel {
  const b = new ModelBuilder();
  const hullMat = pmat(0x6e7885, { roughness: 0.55, metalness: 0.45 });
  const deckMat = pmat(0x3d434c, { roughness: 0.8, metalness: 0.2 });
  const dark = pmat(0x2c3138, { roughness: 0.5, metalness: 0.6 });

  // Hull: octagonal tapered tube along z (bow +z), keel below waterline.
  const hullGeo = new THREE.CylinderGeometry(1.15, 1.7, 13.5, 8);
  b.add(hullGeo, hullMat, tr(0, 0.15, 0, Math.PI / 2, 0, 0, 0.78, 1, 1));
  // Deck plate.
  b.add(new THREE.BoxGeometry(2.35, 0.14, 12.2), deckMat, tr(0, 1.85, -0.2));
  // Bow deck taper cap.
  b.add(new THREE.CylinderGeometry(0.9, 1.15, 1.2, 8), hullMat, tr(0, 1.35, 6.4, Math.PI / 2, 0, 0, 0.78, 1, 1));
  // Superstructure: two stacked blocks.
  b.add(new THREE.BoxGeometry(1.7, 1.1, 2.8), hullMat, tr(0, 2.5, 0.6));
  b.add(new THREE.BoxGeometry(1.3, 0.9, 1.8), deckMat, tr(0, 3.45, 0.4));
  // Bridge windows band.
  b.add(new THREE.BoxGeometry(1.34, 0.28, 1.5), dark, tr(0, 3.6, 0.75));
  // Funnel.
  b.add(new THREE.CylinderGeometry(0.35, 0.45, 1.0, 10), dark, tr(0, 4.2, -0.7));
  // Two gun turrets with barrels (forward faces +z, aft faces -z).
  for (const [tz, dir] of [[4.3, 1], [-4.6, -1]] as const) {
    b.add(new THREE.CylinderGeometry(0.62, 0.72, 0.5, 10), hullMat, tr(0, 2.15, tz));
    b.beam(0, 2.35, tz, 0, 2.5, tz + dir * 2.0, 0.09, dark, 8);
  }
  // Mast + yard + radar bar.
  b.beam(0, 3.9, 0.4, 0, 6.0, 0.4, 0.07, dark);
  b.beam(-0.8, 5.2, 0.4, 0.8, 5.2, 0.4, 0.05, dark);
  b.add(new THREE.BoxGeometry(0.9, 0.1, 0.22), dark, tr(0, 6.05, 0.4));
  return b.build();
}

// ---------------------------------------------------------------------------
// mediaCenter — broadcast tower (footprint 8×8 world, ~13 tall)
// ---------------------------------------------------------------------------

function buildMediaCenter(): LoadedModel {
  const b = new ModelBuilder();
  const steel = pmat(0x8a8f96, { roughness: 0.45, metalness: 0.65 });
  const hutMat = pmat(0xb0b5bc, { roughness: 0.8, metalness: 0.1 });
  const beacon = pmat(0xff2222, { emissive: 0xff2222, emissiveIntensity: 2.2 });

  // Four tapering legs.
  const legBase = 2.3;
  const legTop = 0.85;
  const legH = 7.2;
  const corners: Array<[number, number]> = [
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];
  const legPosAt = (sx: number, sz: number, y: number): [number, number] => {
    const t = y / legH;
    const c = legBase + (legTop - legBase) * t;
    return [sx * c, sz * c];
  };
  for (const [sx, sz] of corners) {
    const [bx, bz] = legPosAt(sx, sz, 0);
    const [tx, tz] = legPosAt(sx, sz, legH);
    // Legs start a hair above y=0 so the beam's lower rim rests at y=0.
    b.beam(bx, 0.05, bz, tx, legH, tz, 0.16, steel);
  }
  // Cross braces at two heights (horizontal ring beams between legs).
  for (const y of [2.4, 4.8]) {
    const pts = corners.map(([sx, sz]) => legPosAt(sx, sz, y));
    for (let i = 0; i < 4; i++) {
      const [ax, az] = pts[i] as [number, number];
      const [bx2, bz2] = pts[(i + 1) % 4] as [number, number];
      b.beam(ax, y, az, bx2, y, bz2, 0.07, steel);
    }
  }
  // Top platform + antenna mast + red beacon.
  b.add(new THREE.CylinderGeometry(1.25, 1.25, 0.3, 12), steel, tr(0, legH + 0.15, 0));
  b.beam(0, legH + 0.3, 0, 0, legH + 5.2, 0, 0.1, steel);
  // Mast cross-arms (antenna bays).
  for (const y of [legH + 2.2, legH + 3.4, legH + 4.4]) {
    b.add(new THREE.BoxGeometry(1.1, 0.09, 0.09), steel, tr(0, y, 0));
  }
  b.add(new THREE.SphereGeometry(0.22, 10, 8), beacon, tr(0, legH + 5.45, 0));
  // Equipment hut at the base + door detail.
  b.add(new THREE.BoxGeometry(1.7, 1.3, 1.7), hutMat, tr(0, 0.65, 0));
  b.add(new THREE.BoxGeometry(1.9, 0.18, 1.9), steel, tr(0, 1.38, 0));
  b.add(new THREE.BoxGeometry(0.5, 0.9, 0.06), steel, tr(0, 0.45, 0.88));
  return b.build();
}

// ---------------------------------------------------------------------------
// stormArray — radar installation (footprint 8×8 world, ~6 tall)
// ---------------------------------------------------------------------------

function buildStormArray(): LoadedModel {
  const b = new ModelBuilder();
  const concrete = pmat(0x9a9a94, { roughness: 0.95, metalness: 0 });
  const housing = pmat(0x5a6068, { roughness: 0.6, metalness: 0.4 });
  const dishMat = pmat(0xd8dce0, { roughness: 0.35, metalness: 0.55 });
  const dark = pmat(0x2c3138, { roughness: 0.5, metalness: 0.6 });

  // Concrete pad + pedestal + rotating housing.
  b.add(new THREE.CylinderGeometry(2.7, 2.9, 0.8, 18), concrete, tr(0, 0.4, 0));
  b.add(new THREE.BoxGeometry(1.5, 1.7, 1.5), housing, tr(0, 1.65, 0));
  b.add(new THREE.CylinderGeometry(1.05, 1.2, 0.7, 14), dark, tr(0, 2.8, 0));
  // Dish: shallow spherical cap, tilted ~35° toward +z.
  const dishR = 2.3;
  const tilt = 0.6;
  const dishQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, 0));
  const dishCenter = new THREE.Vector3(0, 3.6, 0.35);
  b.add(
    new THREE.SphereGeometry(dishR, 20, 10, 0, Math.PI * 2, 0, 0.62),
    dishMat,
    new THREE.Matrix4().compose(dishCenter, dishQ, new THREE.Vector3(1, 1, 1)),
  );
  // Dish back ribs (two arcs behind the cap).
  for (const a of [-0.5, 0.5]) {
    const ribQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, a));
    b.add(
      new THREE.TorusGeometry(dishR * 0.99, 0.05, 6, 20, 1.1),
      housing,
      new THREE.Matrix4().compose(dishCenter, ribQ, new THREE.Vector3(1, 1, 1)),
    );
  }
  // Feed arm along the dish axis + feed horn.
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(dishQ);
  const feedTip = dishCenter.clone().addScaledVector(axis, 1.7);
  b.beam(dishCenter.x, dishCenter.y, dishCenter.z, feedTip.x, feedTip.y, feedTip.z, 0.06, dark);
  b.add(new THREE.BoxGeometry(0.28, 0.28, 0.4), dark, tr(feedTip.x, feedTip.y, feedTip.z));
  // Perimeter fence posts (corner detail, cheap).
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.beam(sx * 3.4, 0, sz * 3.4, sx * 3.4, 1.1, sz * 3.4, 0.05, housing, 6);
    }
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// Props attached to GLB models
// ---------------------------------------------------------------------------

/** Radar dish prop for aegisControl (~2.8 tall, base y=0 at placement). */
export function buildRadarDishProp(): LoadedModel {
  const b = new ModelBuilder();
  const housing = pmat(0x5a6068, { roughness: 0.6, metalness: 0.4 });
  const dishMat = pmat(0xd8dce0, { roughness: 0.35, metalness: 0.55 });
  const dark = pmat(0x2c3138, { roughness: 0.5, metalness: 0.6 });

  b.add(new THREE.CylinderGeometry(0.4, 0.5, 0.5, 10), housing, tr(0, 0.25, 0));
  b.beam(0, 0.5, 0, 0, 1.7, 0, 0.09, housing);
  b.add(new THREE.SphereGeometry(0.16, 8, 8), dark, tr(0, 1.75, 0));
  const tilt = 0.7;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0.5, 0));
  const c = new THREE.Vector3(0, 2.15, 0.1);
  b.add(
    new THREE.SphereGeometry(0.95, 14, 8, 0, Math.PI * 2, 0, 0.7),
    dishMat,
    new THREE.Matrix4().compose(c, q, new THREE.Vector3(1, 1, 1)),
  );
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const tip = c.clone().addScaledVector(axis, 0.75);
  b.beam(c.x, c.y, c.z, tip.x, tip.y, tip.z, 0.035, dark, 6);
  return b.build();
}

/**
 * Infantry gear so the two Quaternius men read differently:
 * rifleman gets a rifle (held at chest height, pointing +z — the models'
 * authored forward), engineer gets a yellow hard-hat + tool backpack.
 * Built at world scale for the normalized infantry height (~1.8).
 */
export function buildInfantryGear(kind: 'engineer' | 'rifles'): LoadedModel {
  const b = new ModelBuilder();
  if (kind === 'rifles') {
    const gunmetal = pmat(0x23262b, { roughness: 0.4, metalness: 0.7 });
    const wood = pmat(0x6b4a2e, { roughness: 0.85, metalness: 0 });
    // Barrel + receiver + wooden stock, held across the chest.
    b.beam(0.3, 1.08, -0.15, 0.3, 1.12, 0.85, 0.032, gunmetal, 8);
    b.add(new THREE.BoxGeometry(0.07, 0.1, 0.3), gunmetal, tr(0.3, 1.06, 0.1));
    b.add(new THREE.BoxGeometry(0.075, 0.13, 0.32), wood, tr(0.3, 1.04, -0.28));
    b.add(new THREE.BoxGeometry(0.05, 0.14, 0.08), gunmetal, tr(0.3, 0.97, 0.12));
  } else {
    const yellow = pmat(0xe8b820, { roughness: 0.5, metalness: 0.15 });
    const olive = pmat(0x5c6247, { roughness: 0.85, metalness: 0 });
    // Hard-hat: squashed sphere + brim.
    b.add(new THREE.SphereGeometry(0.165, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), yellow, tr(0, 1.6, 0.02, 0, 0, 0, 1, 0.75, 1));
    b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.035, 12), yellow, tr(0, 1.6, 0.02));
    // Tool backpack.
    b.add(new THREE.BoxGeometry(0.32, 0.42, 0.2), olive, tr(0, 1.05, -0.3));
    b.add(new THREE.BoxGeometry(0.34, 0.08, 0.22), olive, tr(0, 1.28, -0.3));
  }
  return b.build();
}

/**
 * Command antenna for the HQ truck-flat: mast + tilted dish + red
 * beacon. Base y=0 at the attach point; entities.ts positions it on the
 * truck bed (roof height baked per MODEL_PATHS scale).
 */
export function buildHqAntenna(): LoadedModel {
  const b = new ModelBuilder();
  const mastMat = pmat(0x3a3f47, { roughness: 0.5, metalness: 0.6 });
  const dishMat = pmat(0xd8dce0, { roughness: 0.35, metalness: 0.55 });
  const beacon = pmat(0xff2222, { emissive: 0xff2222, emissiveIntensity: 2.0 });

  b.add(new THREE.CylinderGeometry(0.09, 0.12, 0.25, 8), mastMat, tr(0, 0.12, 0));
  b.beam(0, 0.2, 0, 0, 1.7, 0, 0.045, mastMat, 8);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.8, 0.4, 0));
  b.add(
    new THREE.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, 0, 0.8),
    dishMat,
    new THREE.Matrix4().compose(new THREE.Vector3(0.12, 1.45, 0), q, new THREE.Vector3(1, 1, 1)),
  );
  b.add(new THREE.SphereGeometry(0.07, 8, 8), beacon, tr(0, 1.82, 0));
  return b.build();
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

/** The 8 gap kinds with procedural builders (see module header). */
export const PROCEDURAL_KINDS = [
  'artillery',
  'aa',
  'fighter',
  'transport',
  'drone',
  'destroyer',
  'mediaCenter',
  'stormArray',
] as const;

export type ProceduralKind = (typeof PROCEDURAL_KINDS)[number];

/**
 * Build the procedural model for a gap kind. Returns undefined for any
 * other kind — callers fall through to the placeholder builders.
 */
export function buildProceduralModel(kind: string): LoadedModel | undefined {
  switch (kind) {
    case 'artillery':
      return buildArtillery();
    case 'aa':
      return buildAA();
    case 'fighter':
      return buildFighter();
    case 'transport':
      return buildTransport();
    case 'drone':
      return buildDrone();
    case 'destroyer':
      return buildDestroyer();
    case 'mediaCenter':
      return buildMediaCenter();
    case 'stormArray':
      return buildStormArray();
    default:
      return undefined;
  }
}
