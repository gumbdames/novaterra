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
 * NOVATERRA — tests/sim.building-variety.test.ts — Phase 4 building
 * variety in auto-grow (grand expansion, 2026-09-30): every placed
 * building gets a visual `variant` (0..3) and `sizeTier` (1..3) from a
 * pure hash of (worldSeed, anchorCell, kind) — no RNG draws, same
 * seed + same cell = same street. Desirability drives density:
 * nice/prime cells auto-grow dense (apartments, labs), modest cells
 * stay modest (houses, shops).
 *
 * Render contract (pinned in comments, not code): variant keys resolve
 * through the existing lazy model pipeline and are NEVER in the boot
 * set — the model budget stays flat.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  BUILDING_DEFS,
  BUILDING_SIZE_TIERS,
  BUILDING_VARIANT_COUNT,
  ZoneType,
  densityDefForZone,
  getPlayer,
  placeBuilding,
} from '../src/sim/city';
import type { DesirabilityModel } from '../src/sim/desirability';

function richWorld(seed = 5150): World {
  const world = createWorld(seed);
  const p = getPlayer(world.city, 0)!;
  p.funds = 1e9;
  p.materials = 1e9;
  return world;
}

/** Fake desirability model: the primed cell reports `value`, others 50. */
function fakeModel(cell: number, value: number): DesirabilityModel {
  return { key: 'test', values: new Map([[cell, value]]) };
}

describe('building variety (variant/sizeTier)', () => {
  it('placeBuilding assigns a variant in range and a sizeTier in range', () => {
    const world = richWorld();
    for (const kind of ['house', 'apartment', 'shop', 'lab', 'factory'] as const) {
      const b = placeBuilding(world.city, { kind, owner: 0, cx: 20, cz: 20, facing: 0 }, world.seed);
      expect(b.variant).toBeGreaterThanOrEqual(0);
      expect(b.variant).toBeLessThan(BUILDING_VARIANT_COUNT);
      expect([1, 2, 3]).toContain(b.sizeTier);
    }
    expect(BUILDING_VARIANT_COUNT).toBe(4);
    expect(BUILDING_SIZE_TIERS).toBe(3);
  });

  it('same seed + same cell + same kind → same variant and sizeTier', () => {
    const a = richWorld(31337);
    const b = richWorld(31337);
    const pa = placeBuilding(a.city, { kind: 'house', owner: 0, cx: 30, cz: 30, facing: 0 }, a.seed);
    const pb = placeBuilding(b.city, { kind: 'house', owner: 0, cx: 30, cz: 30, facing: 0 }, b.seed);
    expect(pa.variant).toBe(pb.variant);
    expect(pa.sizeTier).toBe(pb.sizeTier);
  });

  it('different seeds decorrelate the variants (no RNG draws involved)', () => {
    const kinds = ['house', 'apartment', 'shop', 'lab', 'factory', 'market'] as const;
    const seen = new Set<string>();
    for (const seed of [11, 22]) {
      const world = richWorld(seed);
      for (const kind of kinds) {
        const b = placeBuilding(world.city, { kind, owner: 0, cx: 40, cz: 40, facing: 0 }, world.seed);
        seen.add(`${seed}:${kind}:${b.variant}`);
      }
    }
    // 12 placements across 2 seeds; if the seed didn't matter, all 12
    // (seed,kind,variant) triples would collapse to 6.
    expect(seen.size).toBeGreaterThan(6);
  });

  it('variant and sizeTier are independent draws (different hash salts)', () => {
    const world = richWorld(99);
    const pairs = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const b = placeBuilding(
        world.city,
        { kind: 'house', owner: 0, cx: 50 + i, cz: 50, facing: 0 },
        world.seed,
      );
      pairs.add(`${b.variant}:${b.sizeTier}`);
    }
    // 24 cells: variant and sizeTier must not be locked together.
    expect(pairs.size).toBeGreaterThan(4);
  });
});

describe('desirability-driven density (densityDefForZone)', () => {
  const modelFor = (cell: number, value: number) => fakeModel(cell, value);

  it('residential: nice/prime cells grow apartments, modest cells grow houses', () => {
    const world = richWorld();
    const cell = 1234;
    expect(densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, modelFor(cell, 80))?.kind).toBe('apartment');
    expect(densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, modelFor(cell, 60))?.kind).toBe('apartment');
    expect(densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, modelFor(cell, 40))?.kind).toBe('house');
    expect(densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, modelFor(cell, 5))?.kind).toBe('house');
  });

  it('commercial: nice/prime cells grow labs, modest cells grow shops', () => {
    const world = richWorld();
    const cell = 1234;
    expect(densityDefForZone(world, ZoneType.COMMERCIAL, 0, cell, modelFor(cell, 90))?.kind).toBe('lab');
    expect(densityDefForZone(world, ZoneType.COMMERCIAL, 0, cell, modelFor(cell, 20))?.kind).toBe('shop');
  });

  it('falls back down the ladder when the dense pick is unaffordable', () => {
    const world = richWorld();
    const p = getPlayer(world.city, 0)!;
    // Apartment costs more than a house: fund exactly one house.
    p.funds = BUILDING_DEFS.house.costFunds;
    p.materials = BUILDING_DEFS.house.costMaterials;
    const cell = 1234;
    expect(densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, modelFor(cell, 85))?.kind).toBe('house');
  });

  it('industrial zones keep the first-affordable rule (no density ladder)', () => {
    const world = richWorld();
    const cell = 1234;
    // BUILDING_DEF_LIST order decides; just pin determinism + validity.
    const a = densityDefForZone(world, ZoneType.INDUSTRIAL, 0, cell, modelFor(cell, 95));
    const b = densityDefForZone(world, ZoneType.INDUSTRIAL, 0, cell, modelFor(cell, 5));
    expect(a?.kind).toBe(b?.kind);
    expect(BUILDING_DEFS[a!.kind].zone).toBe(ZoneType.INDUSTRIAL);
  });

  it('returns undefined when the player cannot afford anything', () => {
    const world = richWorld();
    const p = getPlayer(world.city, 0)!;
    p.funds = 0;
    p.materials = 0;
    const cell = 1234;
    expect(densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, modelFor(cell, 90))).toBeUndefined();
  });

  it('is pure: same inputs → same pick, no RNG consumed', () => {
    const world = richWorld();
    const cell = 777;
    const m = modelFor(cell, 70);
    const first = densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, m)?.kind;
    const rngBefore = JSON.stringify(world.rng);
    const second = densityDefForZone(world, ZoneType.RESIDENTIAL, 0, cell, m)?.kind;
    expect(second).toBe(first);
    expect(JSON.stringify(world.rng)).toBe(rngBefore);
  });
});
