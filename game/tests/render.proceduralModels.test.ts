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
 * Tests for render/proceduralModels.ts — registry/switch agreement.
 *
 * The module has two sources of truth for "which kinds have a procedural
 * model": the PROCEDURAL_KINDS registry and the buildProceduralModel
 * switch. They must agree — a kind in the switch but missing from the
 * registry (the historical 'library'/'park' gap, final-review R6/L3)
 * silently falls back to the placeholder path in callers that consult
 * the registry first.
 */
import { describe, expect, it } from 'vitest';

import {
  PROCEDURAL_KINDS,
  buildProceduralModel,
} from '../src/render/proceduralModels';

describe('render/proceduralModels — registry/switch agreement', () => {
  it('every PROCEDURAL_KINDS entry builds a model (registry ⇒ switch)', () => {
    for (const kind of PROCEDURAL_KINDS) {
      const model = buildProceduralModel(kind);
      expect(
        model,
        `${kind} is registered in PROCEDURAL_KINDS but buildProceduralModel has no case for it`,
      ).toBeDefined();
    }
  });

  it("registers 'library' and 'park' (final-review R6/L3 regression)", () => {
    // The builder switch handled these two civic amenities long before
    // the registry listed them; the registry is what callers check.
    for (const kind of ['library', 'park'] as const) {
      expect(
        (PROCEDURAL_KINDS as readonly string[]).includes(kind),
        `${kind} missing from PROCEDURAL_KINDS`,
      ).toBe(true);
      expect(buildProceduralModel(kind)).toBeDefined();
    }
  });

  it('returns undefined for unknown kinds (placeholder fall-through)', () => {
    expect(buildProceduralModel('notARealKind')).toBeUndefined();
  });
});

describe('render/proceduralModels — final-review R5 civic gap models', () => {
  const SPECS = [
    { kind: 'sportsStadium', footprintCells: 4 },
    { kind: 'botanicalGarden', footprintCells: 4 },
    { kind: 'fireStation', footprintCells: 2 },
  ] as const;

  function extents(kind: string): { x: number; z: number; parts: number } {
    const model = buildProceduralModel(kind);
    expect(model, `${kind} should build`).toBeDefined();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const g of model!.geometries) {
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      minX = Math.min(minX, bb.min.x);
      maxX = Math.max(maxX, bb.max.x);
      minZ = Math.min(minZ, bb.min.z);
      maxZ = Math.max(maxZ, bb.max.z);
    }
    return { x: maxX - minX, z: maxZ - minZ, parts: model!.geometries.length };
  }

  it('builds all three (no placeholder fall-through)', () => {
    for (const { kind } of SPECS) {
      expect(buildProceduralModel(kind)).toBeDefined();
    }
  });

  it('fits the sim footprint (CELL_WORLD_SIZE = 2 world units per cell)', () => {
    for (const { kind, footprintCells } of SPECS) {
      const { x, z } = extents(kind);
      const worldSize = footprintCells * 2;
      expect(
        x,
        `${kind}: x extent ${x.toFixed(2)} exceeds ${worldSize}-unit footprint`,
      ).toBeLessThanOrEqual(worldSize + 0.01);
      expect(
        z,
        `${kind}: z extent ${z.toFixed(2)} exceeds ${worldSize}-unit footprint`,
      ).toBeLessThanOrEqual(worldSize + 0.01);
    }
  });

  it('is deterministic: two builds give identical extents and part counts', () => {
    for (const { kind } of SPECS) {
      expect(extents(kind)).toEqual(extents(kind));
    }
  });

  it('has real substance (more than a placeholder box)', () => {
    for (const { kind } of SPECS) {
      expect(extents(kind).parts).toBeGreaterThan(8);
    }
  });
});
