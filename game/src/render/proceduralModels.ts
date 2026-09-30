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
 * Purpose: detailed, NON-cube procedural builders for the 17 gap kinds in
 * the entity→model mapping (see docs/research/real-models.md §2): the
 * military units artillery / aa / fighter / transport / drone /
 * destroyer / apc / mlrs / fighterBomber / attackHeli / submarine /
 * frigate / carrier, and the buildings mediaCenter / stormArray /
 * quarry / monument. Each builder returns a `LoadedModel`-compatible
 * `{ geometries, materials }` with merged per-material geometry, base at
 * y=0, forward = +z — the same contract as `models.ts`, so
 * `render/entities.ts` can treat GLB and procedural models identically.
 * (destroyer / submarine / frigate / carrier instead rest at the
 * waterline y=0 with the keel below, like real hulls.)
 *
 * Also home to small procedural *props* attached to GLB models:
 * infantry gear (rifleman's rifle, engineer's hard-hat, sniper's scoped
 * rifle, medic's helmet), the HQ command antenna, the aegisControl
 * radar dish, the AWACS rotodome, the command-ship mast, the airfield
 * runway strip, the nuclear cooling tower, and the hospital cross.
 *
 * Style: flat-shaded low-poly (flatShading: true) to sit with the
 * Kenney/Quaternius GLBs; every model must read clearly at RTS camera
 * distance — silhouette first, ≥3 parts, no plain cubes. Non-emissive
 * parts wear the shared procedural surface library via `smat()`
 * (render/entitySurfaces.ts); `pmat` stays only for pure emissive
 * accents (beacons, nav lights, afterburner glow).
 *
 * Import-safe under Node/vitest: `three` core + `BufferGeometryUtils`
 * touch no DOM at import time. Builders allocate fresh geometry per
 * call; `render/entities.ts` caches one copy per kind and shares it
 * across all views.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { LoadedModel } from './models';
import { surfaceMaterial } from './entitySurfaces';
import type { SurfaceCategory } from './surfaceTextures';

/** Flat-shaded standard material shared within one built model. */
/**
 * Surface-backed flat-shaded material: the shared procedural texture
 * library (`render/entitySurfaces.ts`) with the same crisp facets as
 * `pmat`. Prefer this for every NON-emissive builder part; keep `pmat`
 * only for pure emissive accents (beacons, nav lights, deck markings).
 */
function smat(
  category: SurfaceCategory,
  opts: { color?: number } = {},
): THREE.MeshStandardMaterial {
  return surfaceMaterial(category, { ...opts, flatShading: true });
}

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
  const olive = smat('paintedMetal', { color: 0x5c6247 });
  const dark = smat('gunmetal');
  const tire = smat('tireRubber');

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
  const green = smat('paintedMetal', { color: 0x4d5c50 });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x18242e });

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
  const gray = smat('paintedMetal', { color: 0x9aa2ad });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x141e28 });
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
  const body = smat('paintedMetal', { color: 0x7a8494 });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x141e28 });

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
  const frame = smat('gunmetal');
  const accent = pmat(0x57c8ff, { emissive: 0x2266aa, emissiveIntensity: 0.8 });
  const rotorMat = smat('gunmetal', { color: 0x777d85 });

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
  const hullMat = smat('hullGray', { color: 0x6e7885 });
  const deckMat = smat('concrete', { color: 0x3d434c });
  const dark = smat('gunmetal');

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
  const steel = smat('paintedMetal', { color: 0x8a8f96 });
  const hutMat = smat('concrete', { color: 0xb0b5bc });
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
  const concrete = smat('concrete');
  const housing = smat('paintedMetal', { color: 0x5a6068 });
  const dishMat = smat('paintedMetal');
  const dark = smat('gunmetal');

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
  const housing = smat('paintedMetal', { color: 0x5a6068 });
  const dishMat = smat('paintedMetal');
  const dark = smat('gunmetal');

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
/**
 * Infantry gear so the four Quaternius men read differently:
 * rifleman gets a rifle (held at chest height, pointing +z — the models'
 * authored forward), engineer gets a yellow hard-hat + tool backpack,
 * sniper gets a long scoped rifle with a bipod, medic gets a white
 * helmet + medical backpack with a red cross.
 * Built at world scale for the normalized infantry height (~1.8).
 */
export function buildInfantryGear(kind: 'engineer' | 'rifles' | 'sniper' | 'medic'): LoadedModel {
  const b = new ModelBuilder();
  if (kind === 'rifles') {
    const gunmetal = smat('gunmetal');
    const wood = smat('woodPlank', { color: 0x6b4a2e });
    // Barrel + receiver + wooden stock, held across the chest.
    b.beam(0.3, 1.08, -0.15, 0.3, 1.12, 0.85, 0.032, gunmetal, 8);
    b.add(new THREE.BoxGeometry(0.07, 0.1, 0.3), gunmetal, tr(0.3, 1.06, 0.1));
    b.add(new THREE.BoxGeometry(0.075, 0.13, 0.32), wood, tr(0.3, 1.04, -0.28));
    b.add(new THREE.BoxGeometry(0.05, 0.14, 0.08), gunmetal, tr(0.3, 0.97, 0.12));
  } else if (kind === 'sniper') {
    const gunmetal = smat('gunmetal');
    const wood = smat('woodPlank', { color: 0x6b4a2e });
    // Long precision barrel + receiver + stock + scope, held across chest.
    b.beam(0.3, 1.08, -0.55, 0.3, 1.14, 1.25, 0.028, gunmetal, 8);
    b.add(new THREE.BoxGeometry(0.07, 0.1, 0.3), gunmetal, tr(0.3, 1.06, 0.1));
    b.add(new THREE.BoxGeometry(0.075, 0.13, 0.35), wood, tr(0.3, 1.04, -0.32));
    b.add(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8), gunmetal, tr(0.3, 1.2, 0.05, Math.PI / 2, 0, 0));
    // Bipod legs angling down-forward from the barrel.
    b.beam(0.3, 1.02, 0.95, 0.14, 0.5, 1.15, 0.02, gunmetal, 6);
    b.beam(0.3, 1.02, 0.95, 0.46, 0.5, 1.15, 0.02, gunmetal, 6);
  } else if (kind === 'medic') {
    const white = smat('paintedMetal');
    const red = smat('paintedMetal', { color: 0xd8332a });
    // White helmet: squashed sphere + brim, worn on the head (~1.6).
    b.add(new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), white, tr(0, 1.62, 0.02, 0, 0, 0, 1, 0.75, 1));
    b.add(new THREE.CylinderGeometry(0.22, 0.22, 0.035, 12), white, tr(0, 1.62, 0.02));
    // Medical backpack with a red cross on its back face.
    b.add(new THREE.BoxGeometry(0.34, 0.44, 0.2), white, tr(0, 1.05, -0.32));
    b.add(new THREE.BoxGeometry(0.22, 0.08, 0.02), red, tr(0, 1.08, -0.43));
    b.add(new THREE.BoxGeometry(0.08, 0.22, 0.02), red, tr(0, 1.08, -0.43));
  } else {
    const yellow = smat('paintedMetal', { color: 0xe8b820 });
    const olive = smat('canvasFabric', { color: 0x5c6247 });
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
  const mastMat = smat('gunmetal');
  const dishMat = smat('paintedMetal');
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
// NOVATERRA roster expansion — ground units
// ---------------------------------------------------------------------------

/**
 * apc — 6×6 wheeled armored personnel carrier (target hull {3.0, 2.2, 4.6}):
 * sloped-nose hull, six road wheels, roof troop hatch, small autocannon
 * turret. Reads instantly vs the tracked tank/tankDestroyer.
 */
function buildAPC(): LoadedModel {
  const b = new ModelBuilder();
  const armor = smat('camoGreen');
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x1c2733 });
  // Sloped-nose hull: main box + angled nose plate + side skirts.
  b.add(new THREE.BoxGeometry(2.4, 1.1, 3.4), armor, tr(0, 1.05, -0.3));
  b.add(new THREE.BoxGeometry(2.4, 0.9, 1.1), armor, tr(0, 0.85, 1.85, -0.45, 0, 0));
  b.add(new THREE.BoxGeometry(2.5, 0.4, 3.8), dark, tr(0, 0.45, -0.2));
  // Six wheels.
  for (const wz of [-1.5, -0.2, 1.1]) {
    for (const sx of [-1, 1]) {
      b.add(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 14), dark, tr(sx * 1.15, 0.45, wz, 0, 0, Math.PI / 2));
    }
  }
  // Roof troop compartment + hatch + windshield band.
  b.add(new THREE.BoxGeometry(2.2, 0.5, 2.6), armor, tr(0, 1.85, -0.6));
  b.add(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 12), dark, tr(0, 2.15, -0.6));
  b.add(new THREE.BoxGeometry(2.0, 0.35, 0.15), glass, tr(0, 1.5, 1.28));
  // Small autocannon turret.
  b.add(new THREE.CylinderGeometry(0.5, 0.6, 0.4, 12), armor, tr(0, 2.3, 0.5));
  b.beam(0, 2.4, 0.9, 0, 2.45, 2.2, 0.08, dark, 8);
  // Headlights.
  const lamp = pmat(0xfff2c0, { emissive: 0x998844 });
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.25, 0.18, 0.1), lamp, tr(sx * 0.9, 1.0, 2.32));
  }
  return b.build();
}

/**
 * mlrs — truck chassis with an elevating 12-tube rocket pod (4×3 grid on
 * a turntable, tilted skyward). Distinct from the aa twin pods and the
 * single-barrel artillery piece. Target hull: { 3.0, 2.4, 5.0 }.
 */
function buildMLRS(): LoadedModel {
  const b = new ModelBuilder();
  const olive = smat('paintedMetal', { color: 0x5c6247 });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x1c2733 });
  // Chassis + cab-over cab.
  b.add(new THREE.BoxGeometry(2.4, 0.5, 4.6), dark, tr(0, 0.75, 0));
  b.add(new THREE.BoxGeometry(2.3, 1.2, 1.3), olive, tr(0, 1.5, 1.65));
  b.add(new THREE.BoxGeometry(2.0, 0.5, 0.15), glass, tr(0, 1.75, 2.32, -0.15, 0, 0));
  // Eight wheels.
  for (const wz of [-1.7, -0.6, 0.7, 1.7]) {
    for (const sx of [-1, 1]) {
      b.add(new THREE.CylinderGeometry(0.4, 0.4, 0.35, 14), dark, tr(sx * 1.15, 0.4, wz, 0, 0, Math.PI / 2));
    }
  }
  // Turntable + pivot cheeks.
  b.add(new THREE.CylinderGeometry(0.9, 1.0, 0.25, 14), dark, tr(0, 1.15, -0.7));
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.16, 0.7, 0.6), dark, tr(sx * 1.15, 1.55, -0.7));
  }
  // Launcher pod elevated ~22°, long axis along local +z.
  const elev = 0.38;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-(Math.PI / 2 - elev), 0, 0));
  const center = new THREE.Vector3(0, 1.6, -0.7);
  b.add(
    new THREE.BoxGeometry(2.0, 0.9, 2.2),
    olive,
    new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1)),
  );
  // 12 tubes in a 4×3 grid, mouths protruding from the pod front.
  const tubeGeo = new THREE.CylinderGeometry(0.15, 0.15, 2.4, 10);
  const tubeMat = smat('gunmetal');
  const tubeQ = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
  for (let ix = 0; ix < 4; ix++) {
    for (let iy = 0; iy < 3; iy++) {
      const off = new THREE.Vector3(-0.66 + ix * 0.44, -0.24 + iy * 0.24, 0.4).applyQuaternion(q);
      b.add(
        tubeGeo.clone(),
        tubeMat,
        new THREE.Matrix4().compose(center.clone().add(off), tubeQ, new THREE.Vector3(1, 1, 1)),
      );
    }
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// NOVATERRA roster expansion — aircraft
// ---------------------------------------------------------------------------

/**
 * fighterBomber — heavier strike jet: long fuselage, big swept wings,
 * twin canted tails, four underwing bombs, afterburner nozzle glow.
 * Target hull: { 7.0, 1.2, 5.0 }, centered at y≈0.6 like `fighter`.
 */
function buildFighterBomber(): LoadedModel {
  const b = new ModelBuilder();
  const gray = smat('paintedMetal', { color: 0x7a8a9a });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x16202e });
  // Fuselage + nose cone + canopy.
  b.add(new THREE.CylinderGeometry(0.45, 0.5, 4.2, 14), gray, tr(0, 0.7, 0, Math.PI / 2, 0, 0));
  b.add(new THREE.ConeGeometry(0.42, 1.2, 14), gray, tr(0, 0.7, 2.7, Math.PI / 2, 0, 0));
  b.add(new THREE.SphereGeometry(0.35, 12, 10), glass, tr(0, 1.05, 0.9, 0, 0, 0, 0.8, 0.6, 1.6));
  for (const sx of [-1, 1]) {
    // Big swept wings.
    b.add(new THREE.BoxGeometry(2.9, 0.12, 1.3), gray, tr(sx * 1.7, 0.6, -0.2, 0, -sx * 0.45, 0));
    // Twin canted tail fins.
    b.add(new THREE.BoxGeometry(0.12, 0.9, 0.9), gray, tr(sx * 0.5, 1.15, -1.8, 0, 0, sx * 0.25));
    // Two bombs per wing.
    for (const bx of [1.2, 2.2]) {
      b.add(new THREE.CapsuleGeometry(0.12, 0.5, 4, 8), dark, tr(sx * bx, 0.38, -0.1, Math.PI / 2, 0, 0));
    }
  }
  // Afterburner nozzle + glow.
  b.add(new THREE.CylinderGeometry(0.35, 0.42, 0.5, 12), dark, tr(0, 0.7, -2.1, Math.PI / 2, 0, 0));
  const glow = pmat(0xff7733, { emissive: 0xcc4400 });
  b.add(new THREE.CircleGeometry(0.28, 12), glow, tr(0, 0.7, -2.36, 0, Math.PI, 0));
  return b.build();
}

/**
 * attackHeli — tandem-seat gunship: slim armored body, stub wings with
 * rocket pods, chin gun turret, four-blade main rotor, tail rotor,
 * skids. Target hull: { 6.5, 1.8, 5.5 }. Base at y=0 (skids).
 */
function buildAttackHeli(): LoadedModel {
  const b = new ModelBuilder();
  const olive = smat('paintedMetal', { color: 0x4a5a48 });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x16202e });
  // Slim tandem body + two canopy bubbles.
  b.add(new THREE.CylinderGeometry(0.5, 0.42, 3.4, 12), olive, tr(0, 1.2, 0.3, Math.PI / 2, 0, 0));
  b.add(new THREE.SphereGeometry(0.38, 12, 10), glass, tr(0, 1.5, 1.15, 0, 0, 0, 0.75, 0.6, 1.1));
  b.add(new THREE.SphereGeometry(0.38, 12, 10), glass, tr(0, 1.5, 0.35, 0, 0, 0, 0.75, 0.6, 1.1));
  // Chin gun turret + barrel.
  b.add(new THREE.SphereGeometry(0.22, 10, 8), dark, tr(0, 0.85, 1.9));
  b.beam(0, 0.85, 2.0, 0, 0.8, 2.9, 0.06, dark, 8);
  // Stub wings + rocket pods.
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(1.5, 0.12, 0.55), olive, tr(sx * 1.05, 1.1, 0.3));
    for (const px of [1.15, 1.75]) {
      b.add(new THREE.CylinderGeometry(0.16, 0.16, 1.3, 10), dark, tr(sx * px, 1.05, 0.3, Math.PI / 2, 0, 0));
    }
  }
  // Tail boom + fin + side tail rotor.
  b.add(new THREE.CylinderGeometry(0.14, 0.3, 2.0, 10), olive, tr(0, 1.35, -2.2, Math.PI / 2, 0, 0));
  b.add(new THREE.BoxGeometry(0.1, 0.9, 0.5), olive, tr(0, 1.8, -3.1));
  b.add(new THREE.BoxGeometry(0.06, 0.7, 0.12), dark, tr(0.14, 1.9, -3.1, 0.6, 0, 0));
  b.add(new THREE.BoxGeometry(0.06, 0.7, 0.12), dark, tr(0.14, 1.9, -3.1, -0.6, 0, 0));
  // Main rotor mast + four blades.
  b.add(new THREE.CylinderGeometry(0.12, 0.12, 0.35, 8), dark, tr(0, 1.8, 0.3));
  for (let i = 0; i < 4; i++) {
    const bladeGeo = new THREE.BoxGeometry(3.0, 0.05, 0.28);
    bladeGeo.translate(1.5, 0, 0);
    b.add(bladeGeo, dark, tr(0, 2.05, 0.3, 0, (i * Math.PI) / 2, 0));
  }
  // Skids + struts.
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.12, 0.1, 2.6), dark, tr(sx * 0.75, 0.1, 0.3));
    b.beam(sx * 0.75, 0.15, 1.0, sx * 0.55, 0.8, 1.0, 0.05, dark, 6);
    b.beam(sx * 0.75, 0.15, -0.5, sx * 0.55, 0.8, -0.5, 0.05, dark, 6);
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// NOVATERRA roster expansion — warships (waterline at y=0, keel below)
// ---------------------------------------------------------------------------

/**
 * submarine — teardrop pressure hull with sail, periscope, bow planes,
 * cruciform stern and a three-blade propeller. Waterline at y=0 (keel
 * below, like `destroyer`). Target hull: { 4.0, 3.0, 13.0 }.
 */
function buildSubmarine(): LoadedModel {
  const b = new ModelBuilder();
  const steel = smat('hullGray', { color: 0x3a4048 });
  const dark = smat('gunmetal');
  // Pressure hull: cylinder + bow hemisphere + tapered stern.
  b.add(new THREE.CylinderGeometry(1.3, 1.3, 9, 16), steel, tr(0, 0.2, 0, Math.PI / 2, 0, 0));
  b.add(new THREE.SphereGeometry(1.3, 16, 12), steel, tr(0, 0.2, 4.5, 0, 0, 0, 1, 1, 0.8));
  b.add(new THREE.CylinderGeometry(0.25, 1.3, 2.4, 16), steel, tr(0, 0.2, -5.6, -Math.PI / 2, 0, 0));
  // Sail + periscope + sail planes.
  b.add(new THREE.BoxGeometry(1.4, 1.5, 2.4), steel, tr(0, 2.1, 0.6));
  b.beam(0, 2.8, 0.9, 0, 3.2, 0.9, 0.08, dark, 8);
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.9, 0.1, 0.7), steel, tr(sx * 1.0, 2.0, 0.6));
  }
  // Bow planes + stern cruciform.
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(1.1, 0.12, 0.8), steel, tr(sx * 1.5, 0.1, 3.4));
    b.add(new THREE.BoxGeometry(1.2, 0.12, 0.8), steel, tr(sx * 0.9, 0.2, -6.2));
  }
  b.add(new THREE.BoxGeometry(0.14, 1.8, 0.9), steel, tr(0, 0.4, -6.2));
  // Propeller: hub + three blades.
  b.add(new THREE.CylinderGeometry(0.18, 0.18, 0.5, 10), dark, tr(0, 0.2, -7.0, Math.PI / 2, 0, 0));
  for (let i = 0; i < 3; i++) {
    const bladeGeo = new THREE.BoxGeometry(0.5, 1.1, 0.08);
    bladeGeo.translate(0, 0.65, 0);
    b.add(bladeGeo, dark, tr(0, 0.2, -7.2, 0, 0, (i * 2 * Math.PI) / 3));
  }
  return b.build();
}

/**
 * frigate — compact gray warship: octagonal hull with raked bow,
 * forward gun turret, superstructure with bridge windows, funnel, radar
 * mast, aft helicopter deck. Waterline at y=0.
 * Target hull: { 4.5, 3.5, 14.0 }.
 */
function buildFrigate(): LoadedModel {
  const b = new ModelBuilder();
  const gray = smat('hullGray', { color: 0x6e7885 });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x16202e });
  // Hull: octagonal tube + raked bow (top radius → +z after rotX π/2).
  b.add(new THREE.CylinderGeometry(1.5, 1.1, 10.5, 8), gray, tr(0, 0.2, -0.5, Math.PI / 2, 0, 0, 1.15, 1, 0.85));
  b.add(new THREE.CylinderGeometry(0.15, 1.28, 2.2, 8), gray, tr(0, 0.2, 5.8, Math.PI / 2, 0, 0, 1.15, 1, 0.85));
  // Deck.
  b.add(new THREE.BoxGeometry(2.9, 0.2, 11.5), dark, tr(0, 1.25, -0.3));
  // Forward gun turret + barrel.
  b.add(new THREE.CylinderGeometry(0.7, 0.8, 0.55, 12), gray, tr(0, 1.6, 3.6));
  b.beam(0, 1.7, 4.0, 0, 1.75, 5.8, 0.14, dark, 10);
  // Superstructure + bridge windows.
  b.add(new THREE.BoxGeometry(2.2, 1.4, 3.0), gray, tr(0, 2.15, -1.2));
  b.add(new THREE.BoxGeometry(2.24, 0.4, 0.2), glass, tr(0, 2.5, 0.32));
  // Funnel + radar mast + rotating bar.
  b.add(new THREE.CylinderGeometry(0.5, 0.6, 1.2, 12), dark, tr(0, 3.4, -2.4));
  b.beam(0, 2.8, -0.6, 0, 4.5, -0.6, 0.09, dark, 8);
  b.add(new THREE.BoxGeometry(1.6, 0.1, 0.3), gray, tr(0, 4.55, -0.6));
  // Aft helicopter deck marking.
  b.add(new THREE.CylinderGeometry(1.1, 1.1, 0.06, 20), smat('concrete', { color: 0x59616c }), tr(0, 1.38, -4.2));
  return b.build();
}

/**
 * carrier — flat-top: wide hull, full-length flight deck with markings,
 * starboard island with bridge windows, radar mast and whip antennas.
 * Waterline at y=0. Target hull: { 9.0, 4.5, 22.0 }.
 */
function buildCarrier(): LoadedModel {
  const b = new ModelBuilder();
  const gray = smat('hullGray', { color: 0x6e7885 });
  const deckMat = smat('concrete', { color: 0x4a5058 });
  const dark = smat('gunmetal');
  const glass = smat('glassBlue', { color: 0x16202e });
  const lineMat = smat('paintedMetal');
  // Hull + tapered bow block.
  b.add(new THREE.BoxGeometry(7.0, 2.6, 17.5), gray, tr(0, 0.1, -0.5));
  b.add(new THREE.BoxGeometry(5.0, 2.6, 3.0), gray, tr(0, 0.1, 9.0, 0, 0, 0, 0.72, 1, 1));
  // Flight deck overhanging the hull.
  b.add(new THREE.BoxGeometry(8.6, 0.3, 21.0), deckMat, tr(0, 1.55, 0));
  // Deck markings: center dashes + edge lines.
  for (let i = 0; i < 6; i++) {
    b.add(new THREE.BoxGeometry(0.25, 0.04, 1.2), lineMat, tr(0, 1.72, -7.5 + i * 2.6));
  }
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.2, 0.04, 20.0), lineMat, tr(sx * 3.9, 1.72, 0));
  }
  // Starboard island + bridge windows.
  b.add(new THREE.BoxGeometry(1.8, 2.6, 3.6), gray, tr(2.9, 3.0, -1.0));
  b.add(new THREE.BoxGeometry(1.84, 0.5, 3.0), glass, tr(2.9, 3.9, -1.0));
  // Radar mast + rotating bar + whip antennas.
  b.beam(2.9, 4.3, -1.0, 2.9, 5.6, -1.0, 0.1, dark, 8);
  b.add(new THREE.BoxGeometry(1.8, 0.12, 0.35), gray, tr(2.9, 5.65, -1.0));
  b.beam(2.9, 4.3, -2.4, 2.9, 5.2, -2.4, 0.03, dark, 6);
  b.beam(2.9, 4.3, 0.6, 2.9, 5.2, 0.6, 0.03, dark, 6);
  return b.build();
}

// ---------------------------------------------------------------------------
// NOVATERRA roster expansion — buildings
// ---------------------------------------------------------------------------

/**
 * quarry — surface stone operation (kept above y=0 so it never clips
 * the terrain): stepped rock face, stone rubble piles, crusher hut
 * with a conveyor beam. Footprint 6×6.
 */
function buildQuarry(): LoadedModel {
  const b = new ModelBuilder();
  const rock = smat('concrete', { color: 0x8a8078 });
  const rockDark = smat('concrete', { color: 0x6e675e });
  const hut = smat('woodPlank', { color: 0x9a8a6a });
  const belt = smat('tireRubber');
  // Stepped rock face receding upward.
  b.add(new THREE.BoxGeometry(5.5, 1.0, 1.8), rock, tr(0, 0.5, -1.9));
  b.add(new THREE.BoxGeometry(5.5, 2.0, 1.8), rockDark, tr(0, 1.0, -0.3));
  b.add(new THREE.BoxGeometry(5.5, 3.0, 1.8), rock, tr(0, 1.5, 1.3));
  // Stone rubble piles (icosahedrons, not cubes).
  const pileSpots: Array<[number, number, number]> = [
    [-1.9, 0.45, 1.8],
    [-1.1, 0.45, 2.3],
    [0.2, 0.45, 2.1],
  ];
  for (const [px, py, pz] of pileSpots) {
    b.add(new THREE.IcosahedronGeometry(0.7, 0), rockDark, tr(px, py, pz, 0, px * 2.1, 0, 1, 0.6, 1));
  }
  // Crusher hut + conveyor beam to the face.
  b.add(new THREE.BoxGeometry(1.6, 1.4, 1.6), hut, tr(1.9, 0.7, 2.2));
  b.add(new THREE.BoxGeometry(1.7, 0.15, 1.7), rockDark, tr(1.9, 1.48, 2.2));
  b.add(new THREE.BoxGeometry(0.5, 0.25, 3.4), belt, tr(1.2, 1.1, 0.2, 0.18, 0, 0));
  return b.build();
}

/**
 * monument — civic landmark: three-step plinth, tapered four-sided
 * obelisk with a gold pyramidion, plaza ring, corner pillars with orbs.
 * Footprint 6×6, ~9 tall.
 */
function buildMonument(): LoadedModel {
  const b = new ModelBuilder();
  const stone = smat('concrete', { color: 0xd8d4c8 });
  const stoneDark = smat('concrete', { color: 0xb0aca0 });
  const gold = pmat(0xd8a833, { emissive: 0x664411 });
  // Stepped plinth.
  b.add(new THREE.BoxGeometry(4.4, 0.5, 4.4), stoneDark, tr(0, 0.25, 0));
  b.add(new THREE.BoxGeometry(3.6, 0.5, 3.6), stone, tr(0, 0.75, 0));
  b.add(new THREE.BoxGeometry(2.8, 0.5, 2.8), stoneDark, tr(0, 1.25, 0));
  // Tapered obelisk + gold cap.
  b.add(new THREE.CylinderGeometry(0.45, 0.95, 6.5, 4), stone, tr(0, 4.75, 0));
  b.add(new THREE.ConeGeometry(0.5, 0.9, 4), gold, tr(0, 8.45, 0, 0, Math.PI / 4, 0));
  // Plaza ring + corner pillars.
  b.add(new THREE.CylinderGeometry(2.9, 2.9, 0.1, 24), stoneDark, tr(0, 0.05, 0));
  for (const px of [-2.4, 2.4]) {
    for (const pz of [-2.4, 2.4]) {
      b.add(new THREE.CylinderGeometry(0.16, 0.2, 0.9, 8), stone, tr(px, 0.45, pz));
      b.add(new THREE.SphereGeometry(0.18, 10, 8), gold, tr(px, 1.0, pz));
    }
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// NOVATERRA roster expansion — attach props (built once, shared per kind)
// ---------------------------------------------------------------------------

/**
 * AWACS rotodome: strut + flattened radar disc + whip. Base y=0 at the
 * attach point; entities.ts positions it on the fuselage crown.
 */
export function buildAwacsDome(): LoadedModel {
  const b = new ModelBuilder();
  const gray = smat('paintedMetal', { color: 0x9aa2ad });
  const dark = smat('gunmetal');
  b.add(new THREE.CylinderGeometry(0.12, 0.16, 0.7, 10), dark, tr(0, 0.35, 0));
  b.add(new THREE.CylinderGeometry(0.99, 0.99, 0.06, 20), dark, tr(0, 0.72, 0));
  b.add(new THREE.CylinderGeometry(0.95, 0.95, 0.16, 20), gray, tr(0, 0.78, 0));
  b.beam(0, 0.86, 0, 0, 1.36, 0, 0.03, dark, 6);
  return b.build();
}

/**
 * Command-ship communications mast: pole, yardarms, radar bar, red
 * beacon. Base y=0 at the attach point.
 */
export function buildShipMast(): LoadedModel {
  const b = new ModelBuilder();
  const gray = smat('paintedMetal', { color: 0x8a949e });
  const dark = smat('gunmetal');
  b.beam(0, 0, 0, 0, 3.0, 0, 0.09, gray, 8);
  b.add(new THREE.BoxGeometry(1.4, 0.06, 0.06), gray, tr(0, 2.2, 0));
  b.add(new THREE.BoxGeometry(1.0, 0.06, 0.06), gray, tr(0, 2.65, 0));
  b.add(new THREE.BoxGeometry(1.2, 0.08, 0.25), dark, tr(0, 3.0, 0));
  const beacon = pmat(0xff3333, { emissive: 0xaa1111 });
  b.add(new THREE.SphereGeometry(0.1, 8, 6), beacon, tr(0, 3.2, 0));
  return b.build();
}

/**
 * Airfield runway strip with edge lines and threshold bars.
 * Base y=0; entities.ts lays it beside the hangars.
 */
export function buildRunwayStrip(): LoadedModel {
  const b = new ModelBuilder();
  const asphalt = smat('concrete', { color: 0x3a3d42 });
  const white = smat('paintedMetal');
  b.add(new THREE.BoxGeometry(9.0, 0.06, 1.6), asphalt, tr(0, 0.03, 0));
  for (const sz of [-1, 1]) {
    b.add(new THREE.BoxGeometry(9.0, 0.02, 0.08), white, tr(0, 0.07, sz * 0.68));
  }
  for (const ex of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      b.add(new THREE.BoxGeometry(0.4, 0.02, 0.14), white, tr(ex * 4.0, 0.07, -0.45 + i * 0.3));
    }
  }
  return b.build();
}

/**
 * Nuclear-plant hyperboloid cooling tower: lathe shell + top rim, dark
 * inner disc. Base y=0; entities.ts places it beside the reactor hall.
 */
export function buildCoolingTower(): LoadedModel {
  const b = new ModelBuilder();
  const concrete = smat('concrete');
  const profile = [
    new THREE.Vector2(1.7, 0),
    new THREE.Vector2(1.5, 0.8),
    new THREE.Vector2(1.25, 2.0),
    new THREE.Vector2(1.12, 3.2),
    new THREE.Vector2(1.2, 4.4),
    new THREE.Vector2(1.38, 5.2),
    new THREE.Vector2(1.45, 5.5),
  ];
  const shell = new THREE.Mesh(new THREE.LatheGeometry(profile, 20), concrete);
  shell.castShadow = true;
  // Route through a bucket directly (lathe has no tr helper need).
  b.add(shell.geometry, concrete);
  b.add(new THREE.TorusGeometry(1.42, 0.09, 8, 20), concrete, tr(0, 5.5, 0, Math.PI / 2, 0, 0));
  b.add(new THREE.CircleGeometry(1.3, 20), smat('concrete', { color: 0x4a4640 }), tr(0, 4.95, 0, -Math.PI / 2, 0, 0));
  return b.build();
}

/**
 * Hospital roof sign: white panel with a red cross. Base y=0 at the
 * attach point (roof level, set by entities.ts).
 */
export function buildHospitalCross(): LoadedModel {
  const b = new ModelBuilder();
  const white = smat('paintedMetal');
  const red = pmat(0xd8332a, { emissive: 0x550000 });
  b.add(new THREE.BoxGeometry(0.18, 0.5, 0.18), white, tr(0, 0.25, 0));
  b.add(new THREE.BoxGeometry(1.2, 0.9, 0.12), white, tr(0, 0.95, 0));
  b.add(new THREE.BoxGeometry(0.7, 0.22, 0.14), red, tr(0, 0.95, 0.01));
  b.add(new THREE.BoxGeometry(0.22, 0.7, 0.14), red, tr(0, 0.95, 0.01));
  return b.build();
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

/** The 17 gap kinds with procedural builders (see module header). */
export const PROCEDURAL_KINDS = [
  'artillery',
  'aa',
  'fighter',
  'transport',
  'drone',
  'destroyer',
  'mediaCenter',
  'stormArray',
  // NOVATERRA roster expansion
  'apc',
  'mlrs',
  'fighterBomber',
  'attackHeli',
  'submarine',
  'frigate',
  'carrier',
  'quarry',
  'monument',
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
    case 'apc':
      return buildAPC();
    case 'mlrs':
      return buildMLRS();
    case 'fighterBomber':
      return buildFighterBomber();
    case 'attackHeli':
      return buildAttackHeli();
    case 'submarine':
      return buildSubmarine();
    case 'frigate':
      return buildFrigate();
    case 'carrier':
      return buildCarrier();
    case 'quarry':
      return buildQuarry();
    case 'monument':
      return buildMonument();
    default:
      return undefined;
  }
}
