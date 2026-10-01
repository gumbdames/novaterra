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
 * NOVATERRA — sim/terrain.ts — deterministic terrain for Meridian Plains.
 *
 * Responsibilities:
 *  - The locked first map (Meridian Plains: Medium, ~5% water, 2 players —
 *    see docs/research/game-design.md §A4). Chunked uint16 heightfield,
 *    O(1) bilinear height lookup, water mask query, per-vertex biomes,
 *    spawn points.
 *  - A pure function of the map seed: `generateTerrain(seed)` always
 *    produces identical data for the same seed. Terrain is NOT part of the
 *    world snapshot — saves store the seed and regenerate it (cheap,
 *    deterministic).
 *
 * Determinism (the determinism contract, see sim/AGENTS.md):
 *  - All randomness flows through `rng.ts` stream `'terrain'`, drawn in a
 *    fixed order (noise lattice octave by octave, then river/lake params).
 *  - `Math.sin` shapes the river winding and `Math.hypot` the lake disc;
 *    both are deterministic in one engine build (same-machine bar, D5).
 *    They are documented here as the call sites.
 *  - The percentile sort uses an explicit numeric comparator; lattice
 *    lookups are bounds-clamped, never order-dependent.
 *
 * Layout (locked by this step; rationale in ARCHITECTURE.md D10):
 *  - 512×512 world units, 256×256 cells (257×257 vertices, 2-unit spacing).
 *  - 4×4 chunks of 64×64 cells → 16 chunks, one draw call each.
 *  - Heights: uint16 raw, world height = -10 + raw/65535 × 40.
 *  - Water: the 5th height percentile becomes the water level, so water
 *    coverage is ~5% by construction; the river + lake carves are deep and
 *    wide enough that the percentile always lands on carve slopes (never
 *    in natural noise), which keeps the river continuous and the lake wet.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import { createRngBank } from './rng';
import type { RngBank } from './rng';
import { fnv1a32 } from './rng';

/** Locked Meridian Plains constants (see docs/research/game-design.md §A4). */
export const MERIDIAN_PLAINS = {
  /** Display name. */
  name: 'Meridian Plains',
  /** Canonical map seed — the "hand-authored v1" identity of this map. */
  seed: 20260928,
  /** Square map extent in world units. */
  size: 512,
  /** Heightfield cells per side; vertices per side = cells + 1. */
  cellsPerSide: 256,
  /** World units between heightfield vertices (size / cellsPerSide). */
  spacing: 2,
  /** Chunks per side; chunk = 64×64 cells, 16 chunks total. */
  chunksPerSide: 4,
  /** Heightfield cells per chunk side. */
  chunkCells: 64,
  /** Target water coverage fraction (5% — locked map character). */
  waterTargetFraction: 0.05,
  /** Nominal spawn positions (world units); nudged to land at gen time. */
  spawnACandidate: { x: -128, z: -128 },
  spawnBCandidate: { x: 128, z: 128 },
} as const;

/**
 * Map preset definition: a named, seeded terrain configuration.
 * The 8 presets span 5%–60% water coverage for varied land/naval play.
 */
export interface MapPreset {
  /** Display name. */
  name: string;
  /** Canonical seed for this preset. */
  seed: number;
  /** Target water coverage fraction (0.05–0.60). */
  waterTargetFraction: number;
  /** Short description for the map select UI. */
  blurb: string;
}

export const MAP_PRESETS: readonly MapPreset[] = [
  { name: 'Meridian Plains', seed: 20260928, waterTargetFraction: 0.05, blurb: 'Classic land map — 5% water' },
  { name: 'Riverlands', seed: 20260929, waterTargetFraction: 0.12, blurb: 'Winding rivers — 12% water' },
  { name: 'Lake Country', seed: 20260930, waterTargetFraction: 0.20, blurb: 'Scattered lakes — 20% water' },
  { name: 'Coastline', seed: 20260931, waterTargetFraction: 0.30, blurb: 'Coastal waters — 30% water' },
  { name: 'Archipelago', seed: 20261001, waterTargetFraction: 0.40, blurb: 'Island chains — 40% water' },
  { name: 'Shattered Isles', seed: 20261002, waterTargetFraction: 0.50, blurb: 'Fragmented isles — 50% water' },
  { name: 'Inland Sea', seed: 20261003, waterTargetFraction: 0.55, blurb: 'Vast inland sea — 55% water' },
  { name: 'Ocean World', seed: 20261004, waterTargetFraction: 0.60, blurb: 'Mostly ocean — 60% water' },
] as const;

/** Get a preset by name, or the default (Meridian Plains). */
export function getMapPreset(name: string): MapPreset {
  return MAP_PRESETS.find((p) => p.name === name) ?? MAP_PRESETS[0]!;
}

/** Per-vertex biome ids. The renderer maps these to vertex colors. */
export const Biome = {
  WATER_BED: 0,
  SHORE: 1,
  GRASS_LOW: 2,
  GRASS: 3,
  GRASS_DRY: 4,
  HIGHLAND: 5,
} as const;

/** Raw uint16 height encoding range (world units). */
const HEIGHT_MIN = -10;
const HEIGHT_MAX = 30;

/** Plain-data terrain: regenerable from `seed` alone, never snapshotted. */
export interface TerrainData {
  name: string;
  seed: number;
  /** Square extent in world units; coordinates run [-size/2, +size/2]. */
  size: number;
  /** Vertices per side (cellsPerSide + 1). */
  vertsPerSide: number;
  /** World units between adjacent vertices. */
  spacing: number;
  /** Raw uint16 heights, row-major: index = vz * vertsPerSide + vx. */
  heights: Uint16Array;
  /** Per-vertex biome id (see `Biome`). Same layout as heights. */
  biomes: Uint8Array;
  /** World units; water wherever height < waterLevel. */
  waterLevel: number;
  /** Final spawn positions (on land, flattened discs around them). */
  spawns: Array<{ x: number; z: number }>;
}

/** Decode a raw uint16 height to world units. */
export function rawToWorldHeight(raw: number): number {
  return HEIGHT_MIN + (raw / 65535) * (HEIGHT_MAX - HEIGHT_MIN);
}

/** Encode a world-unit height to raw uint16 (clamped). Inverse of above. */
export function worldToRawHeight(h: number): number {
  const t = Math.min(Math.max((h - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN), 0), 1);
  return Math.round(t * 65535);
}

/** Vertex world-x for grid column vx. */
function vertexCoord(t: Pick<TerrainData, 'size' | 'spacing'>, v: number): number {
  return v * t.spacing - t.size / 2;
}

/** Smootherstep interpolation for value noise (deterministic polynomial). */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Bounds-clamped lattice read; throws loudly on internal inconsistency. */
function latticeValue(lattice: number[], cells: number, i: number, j: number): number {
  const ci = Math.min(Math.max(i, 0), cells);
  const cj = Math.min(Math.max(j, 0), cells);
  const v = lattice[cj * (cells + 1) + ci];
  if (v === undefined) {
    throw new Error(`terrain: lattice index out of range (${i},${j})`);
  }
  return v;
}

/**
 * One octave of value noise at map-cell coords (x, z in 0..cellsPerSide).
 * The lattice spans the whole map with `cells` cells per side.
 */
function sampleOctave(
  lattice: number[],
  cells: number,
  mapCells: number,
  x: number,
  z: number,
): number {
  const gx = (x / mapCells) * cells;
  const gz = (z / mapCells) * cells;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = smootherstep(gx - ix);
  const fz = smootherstep(gz - iz);
  const v00 = latticeValue(lattice, cells, ix, iz);
  const v10 = latticeValue(lattice, cells, ix + 1, iz);
  const v01 = latticeValue(lattice, cells, ix, iz + 1);
  const v11 = latticeValue(lattice, cells, ix + 1, iz + 1);
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fz;
}

/** Draw a full noise lattice in fixed (z, x) order from the terrain stream. */
function drawLattice(bank: RngBank, cells: number): number[] {
  const n = cells + 1;
  const out: number[] = new Array<number>(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out[j * n + i] = bank.next('terrain');
    }
  }
  return out;
}

/** River centerline x as a function of world z (call-site doc: Math.sin). */
function riverCenterX(z: number, p1: number, p2: number): number {
  // Deterministic in one engine build (D5); shapes the S-curves.
  return 60 * Math.sin(z * 0.008 + p1) + 25 * Math.sin(z * 0.021 + p2);
}

/** Smooth carve profile: 1 at center, 0 at radius. */
function carveProfile(d: number, radius: number): number {
  const t = Math.min(Math.max(1 - d / radius, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Find land near a candidate: deterministic ring search, throws if none. */
function findLand(
  heights: Float64Array,
  vertsPerSide: number,
  spacing: number,
  halfSize: number,
  waterLevel: number,
  cx: number,
  cz: number,
): { x: number; z: number } {
  const at = (x: number, z: number): number => {
    const vx = Math.round((x + halfSize) / spacing);
    const vz = Math.round((z + halfSize) / spacing);
    const c = Math.min(Math.max(vx, 0), vertsPerSide - 1);
    const r = Math.min(Math.max(vz, 0), vertsPerSide - 1);
    const v = heights[r * vertsPerSide + c];
    if (v === undefined) throw new Error('terrain: findLand index out of range');
    return v;
  };
  for (let ring = 0; ring <= 80; ring++) {
    const radius = ring * 3;
    const steps = ring === 0 ? 1 : 16;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * radius;
      const z = cz + Math.sin(a) * radius;
      if (at(x, z) >= waterLevel + 0.5) {
        return { x, z };
      }
    }
  }
  throw new Error(`terrain: no land found near spawn candidate (${cx},${cz})`);
}

/**
 * Generate Meridian Plains deterministically from a seed.
 * Pure function of `seed`: same seed ⇒ bit-identical TerrainData.
 */
export function generateTerrain(seed: number, preset?: MapPreset): TerrainData {
  const P = MERIDIAN_PLAINS;
  // Override the water target if a preset is given.
  const waterTarget = preset?.waterTargetFraction ?? P.waterTargetFraction;
  const V = P.cellsPerSide + 1; // 257
  const N = V * V;
  const bank = createRngBank(seed >>> 0);
  const layout = { size: P.size, spacing: P.spacing };

  // --- Base rolling plains: 3 octaves of value noise, fixed draw order. ---
  // Lattices are drawn octave by octave (z, then x) from the terrain stream;
  // the draw ORDER is part of the deterministic contract — never reorder.
  const octaveDefs = [
    { lattice: drawLattice(bank, 4), cells: 4, amp: 2.2 },
    { lattice: drawLattice(bank, 8), cells: 8, amp: 1.1 },
    { lattice: drawLattice(bank, 16), cells: 16, amp: 0.55 },
  ];
  const heights = new Float64Array(N);
  const moisture = new Float64Array(N); // mid octave, reused for biome variation
  for (let vz = 0; vz < V; vz++) {
    for (let vx = 0; vx < V; vx++) {
      let h = 6.5;
      for (const def of octaveDefs) {
        const s = sampleOctave(def.lattice, def.cells, P.cellsPerSide, vx, vz);
        h += (s - 0.5) * 2 * def.amp;
        if (def.cells === 8) moisture[vz * V + vx] = s;
      }
      heights[vz * V + vx] = h;
    }
  }

  // --- River carve: winding north→south channel, 16 deep. ---
  const p1 = bank.next('terrain') * Math.PI * 2;
  const p2 = bank.next('terrain') * Math.PI * 2;
  for (let vz = 0; vz < V; vz++) {
    const z = vertexCoord(layout, vz);
    const rcx = riverCenterX(z, p1, p2);
    for (let vx = 0; vx < V; vx++) {
      const x = vertexCoord(layout, vx);
      const d = Math.abs(x - rcx);
      const idx = vz * V + vx;
      const h = heights[idx] as number;
      heights[idx] = h - 16 * carveProfile(d, 16);
    }
  }

  // --- Lake carve: one disc, 14 deep, nudged off the river. ---
  let lx = (bank.next('terrain') * 2 - 1) * 90;
  const lz = (bank.next('terrain') * 2 - 1) * 90;
  if (Math.abs(lx - riverCenterX(lz, p1, p2)) < 50) {
    lx = lx >= 0 ? lx + 110 : lx - 110;
    lx = Math.min(Math.max(lx, -150), 150);
  }
  for (let vz = 0; vz < V; vz++) {
    const z = vertexCoord(layout, vz);
    for (let vx = 0; vx < V; vx++) {
      const x = vertexCoord(layout, vx);
      // Call-site doc: Math.hypot is deterministic in one engine build (D5).
      const r = Math.hypot(x - lx, z - lz);
      const idx = vz * V + vx;
      const h = heights[idx] as number;
      heights[idx] = h - 14 * carveProfile(r, 34);
    }
  }

  // --- Water level: 5th percentile ⇒ ~5% water by construction. ---
  const sorted = Array.from(heights).sort((a, b) => a - b);
  const pctIndex = Math.floor(waterTarget * N);
  const waterLevel = sorted[pctIndex] as number;

  // --- Spawns: land search + gentle flattening for future city placement. ---
  const spawns = [
    findLand(heights, V, P.spacing, P.size / 2, waterLevel, P.spawnACandidate.x, P.spawnACandidate.z),
    findLand(heights, V, P.spacing, P.size / 2, waterLevel, P.spawnBCandidate.x, P.spawnBCandidate.z),
  ];
  for (const s of spawns) {
    const cvx = Math.round((s.x + P.size / 2) / P.spacing);
    const cvz = Math.round((s.z + P.size / 2) / P.spacing);
    const centerH = heights[cvz * V + cvx] as number;
    const R = 20;
    const rv = Math.ceil(R / P.spacing);
    for (let dz = -rv; dz <= rv; dz++) {
      for (let dx = -rv; dx <= rv; dx++) {
        const vx = cvx + dx;
        const vz = cvz + dz;
        if (vx < 0 || vz < 0 || vx >= V || vz >= V) continue;
        const d = Math.hypot(dx * P.spacing, dz * P.spacing);
        if (d > R) continue;
        const idx = vz * V + vx;
        const h = heights[idx] as number;
        const blend = smootherstep(1 - d / R);
        heights[idx] = h + (centerH - h) * blend;
      }
    }
  }

  // --- Quantize to uint16 + classify biomes. ---
  const rawHeights = new Uint16Array(N);
  const biomes = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const h = heights[i] as number;
    rawHeights[i] = worldToRawHeight(h);
    let b: number;
    if (h < waterLevel) b = Biome.WATER_BED;
    else if (h < waterLevel + 1.0) b = Biome.SHORE;
    else if (h < waterLevel + 4.0) b = Biome.GRASS_LOW;
    else if (h > 13) b = Biome.HIGHLAND;
    else b = (moisture[i] as number) > 0.55 ? Biome.GRASS_DRY : Biome.GRASS;
    biomes[i] = b;
  }

  return {
    name: preset?.name ?? P.name,
    seed: seed >>> 0,
    size: P.size,
    vertsPerSide: V,
    spacing: P.spacing,
    heights: rawHeights,
    biomes,
    waterLevel,
    spawns,
  };
}

/**
 * Bilinear height lookup in world units. O(1); clamps to map bounds.
 * Vertex-exact at integer grid points; smooth between them.
 */
export function heightAt(t: TerrainData, x: number, z: number): number {
  const V = t.vertsPerSide;
  const max = V - 1;
  const gx = Math.min(Math.max((x + t.size / 2) / t.spacing, 0), max);
  const gz = Math.min(Math.max((z + t.size / 2) / t.spacing, 0), max);
  const ix = Math.min(Math.floor(gx), max - 1);
  const iz = Math.min(Math.floor(gz), max - 1);
  const fx = gx - ix;
  const fz = gz - iz;
  const h00 = rawToWorldHeight(t.heights[iz * V + ix] as number);
  const h10 = rawToWorldHeight(t.heights[iz * V + ix + 1] as number);
  const h01 = rawToWorldHeight(t.heights[(iz + 1) * V + ix] as number);
  const h11 = rawToWorldHeight(t.heights[(iz + 1) * V + ix + 1] as number);
  const top = h00 + (h10 - h00) * fx;
  const bottom = h01 + (h11 - h01) * fx;
  return top + (bottom - top) * fz;
}

/** Water mask query: true where the interpolated height is below water level. */
export function isWater(t: TerrainData, x: number, z: number): boolean {
  return heightAt(t, x, z) < t.waterLevel;
}

/** Fraction of vertices below the water level (sanity metric, ~0.05). */
export function waterFraction(t: TerrainData): number {
  let wet = 0;
  for (let i = 0; i < t.heights.length; i++) {
    if (rawToWorldHeight(t.heights[i] as number) < t.waterLevel) wet++;
  }
  return wet / t.heights.length;
}

/**
 * Deterministic digest of the terrain: name, seed, layout, water level,
 * spawns, heights, biomes. Same seed ⇒ identical digest, always.
 */
export function digestTerrain(t: TerrainData): number {
  const parts: string[] = [
    `novaterra-terrain/v1|${t.name}|seed=${t.seed}|size=${t.size}`,
    `|verts=${t.vertsPerSide}|spacing=${t.spacing}|water=${t.waterLevel}`,
    `|spawns=${t.spawns.map((s) => `${s.x},${s.z}`).join(';')}|h:`,
  ];
  const hex: string[] = new Array<string>(t.heights.length);
  for (let i = 0; i < t.heights.length; i++) {
    hex[i] = (t.heights[i] as number).toString(16);
  }
  parts.push(hex.join(','));
  parts.push('|b:');
  const bhex: string[] = new Array<string>(t.biomes.length);
  for (let i = 0; i < t.biomes.length; i++) {
    bhex[i] = (t.biomes[i] as number).toString(16);
  }
  parts.push(bhex.join(','));
  return fnv1a32(parts.join(''));
}
