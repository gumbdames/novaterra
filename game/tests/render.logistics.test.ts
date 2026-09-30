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
 * render/logisticsOverlay.ts + the Phase 3 procedural models (0.1 Alpha).
 *
 * Grand-expansion Phase 3 (logistics): the 7 logistics buildings and 2
 * supply trucks get final-art procedural models (render/AGENTS.md), and
 * the toggleable overlay renders reload-point coverage discs + low-supply
 * ground rings. These tests assert:
 *  - every new builder returns valid, finite, deterministic geometry
 *    (no NaN, sane bounds — the anti-placeholder check);
 *  - the 9 kinds are registered in PROCEDURAL_KINDS (the dispatch the
 *    entity renderer uses);
 *  - the supply truck's canvas hoop arches OVER the bed (the rotation
 *    fix: half-shell rolled to the top), and the fuel truck's tanker
 *    barrel reads as a horizontal barrel;
 *  - the overlay geometry builders emit correctly-sized, up-facing
 *    (CCW-from-above) triangle sets, drape on the terrain sampler, and
 *    fall back to the flat headless path;
 *  - the LogisticsOverlay rebuilds only when the data digest changes
 *    (the node-stable / click-bug invariant for overlays too).
 *
 * Headless: three.js geometry only, no renderer or DOM needed.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  buildFuelDepot,
  buildFuelTruck,
  buildMissilePlant,
  buildMissileSilo,
  buildMunitionsFactory,
  buildOilRig,
  buildOilWell,
  buildOrdnanceDepot,
  buildSupplyTruck,
  PROCEDURAL_KINDS,
  type LoadedModel,
} from '../src/render/proceduralModels';
import {
  buildCoverageDiscGeometry,
  buildLowSupplyRingGeometry,
  LOGISTICS_DISC_SEGMENTS,
  LOGISTICS_FLAT_Y,
  LOGISTICS_RING_INNER,
  LOGISTICS_RING_OUTER,
  LOGISTICS_RING_SEGMENTS,
  LOGISTICS_RING_TERRAIN_OFFSET,
  LOGISTICS_TINT_TERRAIN_OFFSET,
  LogisticsOverlay,
} from '../src/render/logisticsOverlay';
import { LOGISTICS_RADIUS } from '../src/sim/economy';
import type { LogisticsOverlayData } from '../src/ui/logistics';

type Builder = () => LoadedModel;

const BUILDERS: Record<string, Builder> = {
  oilWell: buildOilWell,
  oilRig: buildOilRig,
  munitionsFactory: buildMunitionsFactory,
  missilePlant: buildMissilePlant,
  missileSilo: buildMissileSilo,
  ordnanceDepot: buildOrdnanceDepot,
  fuelDepot: buildFuelDepot,
  supplyTruck: buildSupplyTruck,
  fuelTruck: buildFuelTruck,
};

interface BBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function bboxOf(geo: THREE.BufferGeometry): BBox {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (bb === null) throw new Error('geometry has no bounding box');
  return {
    minX: bb.min.x,
    minY: bb.min.y,
    minZ: bb.min.z,
    maxX: bb.max.x,
    maxY: bb.max.y,
    maxZ: bb.max.z,
  };
}

function positionsFinite(geo: THREE.BufferGeometry): boolean {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (pos === undefined || pos.count === 0) return false;
  for (let i = 0; i < pos.count; i++) {
    if (
      !Number.isFinite(pos.getX(i)) ||
      !Number.isFinite(pos.getY(i)) ||
      !Number.isFinite(pos.getZ(i))
    ) {
      return false;
    }
  }
  return true;
}

describe('Phase 3 procedural models', () => {
  it.each(Object.keys(BUILDERS))('%s builds valid, finite geometry', (kind) => {
    const model = BUILDERS[kind]!();
    expect(model.geometries.length).toBeGreaterThanOrEqual(3);
    expect(model.geometries.length).toBe(model.materials.length);
    for (const geo of model.geometries) {
      expect(positionsFinite(geo), `${kind}: NaN/non-finite positions`).toBe(true);
      const bb = bboxOf(geo);
      for (const v of [bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ]) {
        expect(Number.isFinite(v), `${kind}: non-finite bounds`).toBe(true);
      }
    }
  });

  it.each(Object.keys(BUILDERS))('%s has sane model bounds (nothing buried, nothing absurd)', (kind) => {
    const model = BUILDERS[kind]!();
    let minY = Infinity;
    let maxY = -Infinity;
    for (const geo of model.geometries) {
      const bb = bboxOf(geo);
      minY = Math.min(minY, bb.minY);
      maxY = Math.max(maxY, bb.maxY);
    }
    // Nothing sunk absurdly deep; nothing towering past a skyscraper.
    // (The offshore rig's legs run to y=-5 below the waterline — correct
    // for a platform; everything else sits on grade.)
    expect(minY).toBeGreaterThan(kind === 'oilRig' ? -6 : -1.5);
    expect(maxY).toBeLessThan(60);
    // Substantial, not a stub: every model rises at least a meter.
    expect(maxY - minY).toBeGreaterThan(1);
  });

  it.each(Object.keys(BUILDERS))('%s is deterministic (same bounds twice)', (kind) => {
    const a = BUILDERS[kind]!();
    const b = BUILDERS[kind]!();
    const bounds = (m: LoadedModel): BBox[] => m.geometries.map(bboxOf);
    expect(bounds(a)).toEqual(bounds(b));
  });

  it('registers all 9 kinds in PROCEDURAL_KINDS', () => {
    for (const kind of Object.keys(BUILDERS)) {
      expect(
        (PROCEDURAL_KINDS as readonly string[]).includes(kind),
        `${kind} missing from PROCEDURAL_KINDS`,
      ).toBe(true);
    }
  });

  it('supplyTruck: the canvas hoop arches OVER the bed (half-shell rolled to the top)', () => {
    // The hoop is merged into the canvas-material geometry together with
    // the flat canvas sheet: its signature is a part with max.y above the
    // cab roof (2.47), an x-span of ~2.04 (the shell diameter) and a
    // y-span of ~1.05 (the shell radius + sheet) — a sideways or missing
    // shell cannot produce all three.
    const model = buildSupplyTruck();
    const hoops = model.geometries.filter((g) => {
      const bb = bboxOf(g);
      return (
        bb.maxY > 2.6 &&
        bb.maxX - bb.minX > 1.9 &&
        bb.maxX - bb.minX < 2.2 &&
        bb.maxY - bb.minY > 0.9 &&
        bb.maxY - bb.minY < 1.2
      );
    });
    expect(hoops.length).toBe(1);
    const bb = bboxOf(hoops[0]!);
    // The shell covers the bed length (z from -2.6 to 0.3) and sits on the
    // bed walls (base at y ≈ 1.75), arching to ≈ 2.77.
    expect(bb.minZ).toBeCloseTo(-2.6, 1);
    expect(bb.maxZ).toBeCloseTo(0.3, 1);
    expect(bb.minY).toBeCloseTo(1.72, 1);
    expect(bb.maxY).toBeCloseTo(2.77, 1);
  });

  it('fuelTruck: the tanker reads as a horizontal barrel', () => {
    // Barrel (r=0.95, length 3.4) + hemisphere caps merged: y-span is the
    // diameter (~1.9), z-span covers barrel + caps (> 4.5).
    const model = buildFuelTruck();
    const barrels = model.geometries.filter((g) => {
      const bb = bboxOf(g);
      return (
        bb.maxY - bb.minY > 1.8 &&
        bb.maxY - bb.minY < 2.0 &&
        bb.maxZ - bb.minZ > 4.5
      );
    });
    expect(barrels.length).toBeGreaterThanOrEqual(1);
  });
});

describe('buildCoverageDiscGeometry', () => {
  const depots = [
    { x: 10, z: 20, radius: LOGISTICS_RADIUS },
    { x: -5, z: 7, radius: LOGISTICS_RADIUS },
  ];

  it('emits one triangle fan per depot with the sim radius', () => {
    const g = buildCoverageDiscGeometry(depots);
    const vertsPer = 1 + (LOGISTICS_DISC_SEGMENTS + 1);
    expect(g.positions.length).toBe(depots.length * vertsPer * 3);
    expect(g.indices.length).toBe(depots.length * LOGISTICS_DISC_SEGMENTS * 3);
    // Rim vertices sit exactly on the sim's LOGISTICS_RADIUS.
    for (let d = 0; d < depots.length; d++) {
      const base = d * vertsPer;
      for (let i = 1; i <= LOGISTICS_DISC_SEGMENTS; i += 7) {
        const vx = g.positions[(base + i) * 3]!;
        const vz = g.positions[(base + i) * 3 + 2]!;
        const dist = Math.hypot(vx - depots[d]!.x, vz - depots[d]!.z);
        expect(dist).toBeCloseTo(LOGISTICS_RADIUS, 4); // Float32-stored
      }
    }
  });

  it('winds counter-clockwise from above (up-facing)', () => {
    const g = buildCoverageDiscGeometry(depots);
    for (let d = 0; d < depots.length; d++) {
      const base = (d * (1 + (LOGISTICS_DISC_SEGMENTS + 1))) * 3;
      // First triangle: (center, ring[i+1], ring[i]).
      const ax = g.positions[base]!;
      const ay = g.positions[base + 1]!;
      const az = g.positions[base + 2]!;
      const bIdx = base + 2 * 3;
      const cIdx = base + 1 * 3;
      const ux = g.positions[bIdx]! - ax;
      const uz = g.positions[bIdx + 2]! - az;
      const vx = g.positions[cIdx]! - ax;
      const vz = g.positions[cIdx + 2]! - az;
      // y-component of u × v must be positive (up-facing).
      const ny = uz * vx - ux * vz;
      void ay;
      expect(ny).toBeGreaterThan(0);
    }
  });

  it('drapes on the terrain sampler, else uses the flat headless path', () => {
    const draped = buildCoverageDiscGeometry(depots, () => 42);
    for (let i = 1; i < draped.positions.length; i += 3) {
      expect(draped.positions[i]).toBeCloseTo(42 + LOGISTICS_TINT_TERRAIN_OFFSET, 5); // Float32-stored
    }
    const flat = buildCoverageDiscGeometry(depots);
    for (let i = 1; i < flat.positions.length; i += 3) {
      // Float32Array stores 0.2 as 0.20000000298023224 — approximate.
      expect(flat.positions[i]).toBeCloseTo(LOGISTICS_FLAT_Y, 5);
    }
  });

  it('emits nothing for no depots', () => {
    const g = buildCoverageDiscGeometry([]);
    expect(g.positions.length).toBe(0);
    expect(g.indices.length).toBe(0);
  });
});

describe('buildLowSupplyRingGeometry', () => {
  const units = [
    { x: 3, z: -4 },
    { x: 100, z: 55 },
  ];

  it('emits one ring per unit between the inner/outer radii', () => {
    const g = buildLowSupplyRingGeometry(units);
    const vertsPer = (LOGISTICS_RING_SEGMENTS + 1) * 2;
    expect(g.positions.length).toBe(units.length * vertsPer * 3);
    expect(g.indices.length).toBe(units.length * LOGISTICS_RING_SEGMENTS * 6);
    for (let u = 0; u < units.length; u++) {
      const base = u * vertsPer * 3;
      const ix = g.positions[base]!;
      const iz = g.positions[base + 2]!;
      const ox = g.positions[base + 3]!;
      const oz = g.positions[base + 5]!;
      expect(Math.hypot(ix - units[u]!.x, iz - units[u]!.z)).toBeCloseTo(
        LOGISTICS_RING_INNER,
        5, // Float32-stored
      );
      expect(Math.hypot(ox - units[u]!.x, oz - units[u]!.z)).toBeCloseTo(
        LOGISTICS_RING_OUTER,
        5, // Float32-stored
      );
    }
  });

  it('winds counter-clockwise from above (up-facing)', () => {
    const g = buildLowSupplyRingGeometry(units);
    // First quad: (inner0, outer1, outer0).
    const ax = g.positions[0]!;
    const az = g.positions[2]!;
    const bIdx = 2 * 3; // outer1
    const cIdx = 1 * 3; // outer0
    const ux = g.positions[bIdx]! - ax;
    const uz = g.positions[bIdx + 2]! - az;
    const vx = g.positions[cIdx]! - ax;
    const vz = g.positions[cIdx + 2]! - az;
    expect(uz * vx - ux * vz).toBeGreaterThan(0);
  });

  it('drapes on the terrain sampler, else uses the flat headless path', () => {
    const draped = buildLowSupplyRingGeometry(units, () => -7);
    for (let i = 1; i < draped.positions.length; i += 3) {
      expect(draped.positions[i]).toBeCloseTo(-7 + LOGISTICS_RING_TERRAIN_OFFSET, 5); // Float32-stored
    }
    const flat = buildLowSupplyRingGeometry(units);
    for (let i = 1; i < flat.positions.length; i += 3) {
      // Float32Array stores 0.2 as 0.20000000298023224 — approximate.
      expect(flat.positions[i]).toBeCloseTo(LOGISTICS_FLAT_Y, 5);
    }
  });

  it('emits nothing for no units', () => {
    const g = buildLowSupplyRingGeometry([]);
    expect(g.positions.length).toBe(0);
    expect(g.indices.length).toBe(0);
  });
});

describe('LogisticsOverlay', () => {
  function data(): LogisticsOverlayData {
    return {
      depots: [{ x: 0, z: 0, radius: LOGISTICS_RADIUS }],
      lowUnits: [{ x: 5, z: 5 }],
    };
  }

  it('starts hidden and toggles visibility', () => {
    const scene = new THREE.Scene();
    const overlay = new LogisticsOverlay(scene);
    expect(overlay.isVisible()).toBe(false);
    overlay.setVisible(true);
    expect(overlay.isVisible()).toBe(true);
    overlay.setVisible(false);
    expect(overlay.isVisible()).toBe(false);
    overlay.dispose();
  });

  it('rebuilds only when the digest changes', () => {
    const scene = new THREE.Scene();
    const overlay = new LogisticsOverlay(scene);
    overlay.setVisible(true);
    overlay.sync(data());
    expect(overlay.rebuildCount).toBe(1);
    // Identical data, many syncs: no rebuild (the click-bug lesson —
    // static overlays must not churn geometry per frame).
    for (let i = 0; i < 10; i++) overlay.sync(data());
    expect(overlay.rebuildCount).toBe(1);
    // A changed unit set rebuilds exactly once.
    overlay.sync({ depots: data().depots, lowUnits: [{ x: 6, z: 5 }] });
    expect(overlay.rebuildCount).toBe(2);
    overlay.sync({ depots: data().depots, lowUnits: [{ x: 6, z: 5 }] });
    expect(overlay.rebuildCount).toBe(2);
    overlay.dispose();
  });

  it('handles empty data without meshes', () => {
    const scene = new THREE.Scene();
    const overlay = new LogisticsOverlay(scene);
    overlay.setVisible(true);
    overlay.sync({ depots: [], lowUnits: [] });
    expect(overlay.rebuildCount).toBe(1);
    // Syncing real data afterwards still works.
    overlay.sync(data());
    expect(overlay.rebuildCount).toBe(2);
    overlay.dispose();
  });
});
