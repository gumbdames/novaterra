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
 * Procedural surface texture library (0.1 Alpha).
 *
 * Deterministic, license-clean canvas-free textures for the game's flat-shaded
 * low-poly models: every surface is generated from a seeded PRNG (mulberry32,
 * never `Math.random`) into a raw RGBA pixel buffer, so the same
 * (category, seed) pair yields byte-identical pixels on every platform and
 * every run — render determinism is preserved.
 *
 * Architecture (mirrors `natureTrees.ts`'s headless-safe pattern):
 * - `generateSurfacePixels` / `generateSurfaceRoughness` are PURE pixel
 *   generators: no DOM, no three.js, fully unit-testable in Node.
 * - `surfaceTexture` / `surfaceRoughnessTexture` are thin browser-safe
 *   factories that wrap the pixel buffers in `THREE.DataTexture`
 *   (DataTexture needs no canvas element, so even the factories are
 *   headless-safe). Textures are cached per (category, seed) and shared.
 *
 * Tileability: every feature (blotches, cracks, specks, panel lines) is drawn
 * through toroidal (wrapping) writes, and analytic patterns (brick, planks,
 * hazard stripes, tire chevrons, glass streaks) use periods that divide the
 * texture size. Edge pixels always match, so `RepeatWrapping` never seams.
 *
 * Team-color contract (see `surfaceMaterials.ts`): tint-friendly surfaces are
 * luminance-biased (near-white detail, no strong hue); strongly colored
 * surfaces (camos, glass, brick, hazard stripes) are meant to be used with a
 * white material color.
 */
import * as THREE from 'three';

/** Deterministic PRNG (mulberry32): identical sequences on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 16 surfaces in the library. */
export const SURFACE_CATEGORIES = [
  'paintedMetal',
  'camoGreen',
  'camoDesert',
  'camoNavy',
  'gunmetal',
  'tireRubber',
  'concrete',
  'glassBlue',
  'brickRed',
  'woodPlank',
  'canvasFabric',
  'hullGray',
  'rustMetal',
  'hazardStripes',
  'roofGravel',
  'sandbag',
] as const;

export type SurfaceCategory = (typeof SURFACE_CATEGORIES)[number];

/** Texture resolution per surface. Pattern-heavy surfaces get 256px. */
export const SURFACE_TEXTURE_SIZE: Record<SurfaceCategory, number> = {
  paintedMetal: 128,
  camoGreen: 128,
  camoDesert: 128,
  camoNavy: 128,
  gunmetal: 128,
  tireRubber: 128,
  concrete: 256,
  glassBlue: 128,
  brickRed: 256,
  woodPlank: 256,
  canvasFabric: 128,
  hullGray: 128,
  rustMetal: 128,
  hazardStripes: 256,
  roofGravel: 128,
  sandbag: 128,
};

/** Default seed per category (deterministic across sessions). */
export function defaultSurfaceSeed(category: SurfaceCategory): number {
  return 1000 + SURFACE_CATEGORIES.indexOf(category) * 7919;
}

export interface SurfacePixels {
  width: number;
  height: number;
  /** RGBA, row-major, 8 bits per channel. */
  data: Uint8Array;
}

export interface SurfaceRoughness {
  width: number;
  height: number;
  /** Single channel (0 = mirror-smooth, 255 = fully rough), row-major. */
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Pixel-buffer helpers (pure, no DOM)
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

/** RGBA pixel grid with toroidal (wrapping) writes for seamless tiling. */
class PixelGrid {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  /** Wrapped write with source-over alpha blending. */
  set(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    const xi = ((Math.round(x) % this.width) + this.width) % this.width;
    const yi = ((Math.round(y) % this.height) + this.height) % this.height;
    const i = (yi * this.width + xi) * 4;
    const d = this.data;
    if (a >= 255) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    } else {
      const t = a / 255;
      const dr = d[i] ?? 0;
      const dg = d[i + 1] ?? 0;
      const db = d[i + 2] ?? 0;
      d[i] = Math.round(dr * (1 - t) + r * t);
      d[i + 1] = Math.round(dg * (1 - t) + g * t);
      d[i + 2] = Math.round(db * (1 - t) + b * t);
      d[i + 3] = 255;
    }
  }

  fill(r: number, g: number, b: number): void {
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
}

/** Single-channel grid with toroidal writes (for roughness). */
class GrayGrid {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }

  set(x: number, y: number, v: number): void {
    const xi = ((Math.round(x) % this.width) + this.width) % this.width;
    const yi = ((Math.round(y) % this.height) + this.height) % this.height;
    this.data[yi * this.width + xi] = Math.max(0, Math.min(255, Math.round(v)));
  }

  fill(v: number): void {
    this.data.fill(Math.max(0, Math.min(255, Math.round(v))));
  }
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Soft circular blotch, drawn at toroidal offsets so it tiles seamlessly. */
function blotch(
  grid: PixelGrid,
  cx: number,
  cy: number,
  radius: number,
  color: Rgb,
  alpha: number,
  /** 0 = hard disc edge, 1 = fully soft falloff. */
  softness = 0.6,
): void {
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy) / radius;
      if (d > 1) continue;
      const falloff = 1 - smoothstep(1 - softness, 1, d);
      if (falloff <= 0) continue;
      grid.set(cx + dx, cy + dy, color[0], color[1], color[2], alpha * falloff);
    }
  }
}

/** Per-pixel uniform noise added to RGB. */
function addNoise(grid: PixelGrid, rng: () => number, amp: number): void {
  const d = grid.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() * 2 - 1) * amp;
    d[i] = clampByte((d[i] ?? 0) + n);
    d[i + 1] = clampByte((d[i + 1] ?? 0) + n);
    d[i + 2] = clampByte((d[i + 2] ?? 0) + n);
  }
}

/**
 * Large-scale value noise on a wrapped lattice: adds low-frequency mottling
 * that tiles seamlessly (lattice indices wrap mod `period`).
 */
function addWrappedValueNoise(
  grid: PixelGrid,
  rng: () => number,
  period: number,
  amp: number,
): void {
  const lattice: number[] = [];
  for (let i = 0; i < period * period; i++) lattice.push(rng());
  const { width: w, height: h, data: d } = grid;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * period;
      const gy = (y / h) * period;
      const x0 = Math.floor(gx) % period;
      const y0 = Math.floor(gy) % period;
      const x1 = (x0 + 1) % period;
      const y1 = (y0 + 1) % period;
      const fx = smoothstep(0, 1, gx - Math.floor(gx));
      const fy = smoothstep(0, 1, gy - Math.floor(gy));
      const v00 = lattice[y0 * period + x0] ?? 0;
      const v10 = lattice[y0 * period + x1] ?? 0;
      const v01 = lattice[y1 * period + x0] ?? 0;
      const v11 = lattice[y1 * period + x1] ?? 0;
      const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy + v11 * fx * fy;
      const n = (v - 0.5) * 2 * amp;
      const i = (y * w + x) * 4;
      d[i] = clampByte((d[i] ?? 0) + n);
      d[i + 1] = clampByte((d[i + 1] ?? 0) + n);
      d[i + 2] = clampByte((d[i + 2] ?? 0) + n);
    }
  }
}

/** Thin wrapped line segment (for panel lines, cracks, seams). */
function wrappedLine(
  grid: PixelGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Rgb,
  alpha: number,
  widthPx = 1,
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const half = Math.floor(widthPx / 2);
  for (let s = 0; s <= steps; s++) {
    const x = x0 + ((x1 - x0) * s) / steps;
    const y = y0 + ((y1 - y0) * s) / steps;
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        grid.set(x + ox, y + oy, color[0], color[1], color[2], alpha);
      }
    }
  }
}

/** Random-walk crack: jittery polyline, wrapped for tiling. */
function crack(
  grid: PixelGrid,
  rng: () => number,
  sx: number,
  sy: number,
  length: number,
  color: Rgb,
): void {
  let x = sx;
  let y = sy;
  let ang = rng() * Math.PI * 2;
  const stepLen = 3;
  for (let i = 0; i < length; i++) {
    const nx = x + Math.cos(ang) * stepLen;
    const ny = y + Math.sin(ang) * stepLen;
    wrappedLine(grid, x, y, nx, ny, color, 200, 1);
    x = nx;
    y = ny;
    ang += (rng() - 0.5) * 1.1;
  }
}

/** Fills a gray grid with noise around a base value. */
function roughNoise(grid: GrayGrid, rng: () => number, base: number, amp: number): void {
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      grid.set(x, y, base + (rng() * 2 - 1) * amp);
    }
  }
}

// ---------------------------------------------------------------------------
// Surface painters — each fills a PixelGrid (+ roughness GrayGrid).
// Every painter is deterministic: same seed → same RNG call order.
// ---------------------------------------------------------------------------

interface PaintCtx {
  grid: PixelGrid;
  rough: GrayGrid;
  rng: () => number;
  size: number;
}

function paintPaintedMetal({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(202, 203, 208); // near-white: team-color tint carries the hue
  addWrappedValueNoise(grid, rng, 4, 7);
  addNoise(grid, rng, 5);
  // Panel lines: a few long seams at wrapped positions.
  for (let i = 0; i < 3; i++) {
    const p = Math.floor(rng() * size);
    wrappedLine(grid, p, 0, p, size, [150, 152, 158], 160, 2);
    wrappedLine(grid, 0, p, size, p, [150, 152, 158], 120, 1);
  }
  // Wear specks: sparse dark chips where paint wore through.
  for (let i = 0; i < 46; i++) {
    grid.set(rng() * size, rng() * size, 120, 118, 116, 190);
  }
  roughNoise(rough, rng, 150, 30);
  // Worn chips are rougher.
}

function paintCamo(
  base: Rgb,
  blotchColors: Rgb[],
  { grid, rough, rng, size }: PaintCtx,
): void {
  grid.fill(base[0], base[1], base[2]);
  const count = 16;
  for (let i = 0; i < count; i++) {
    const c = blotchColors[i % blotchColors.length];
    if (!c) continue; // unreachable: blotchColors is non-empty by construction
    blotch(
      grid,
      rng() * size,
      rng() * size,
      10 + rng() * 18,
      c,
      225,
      0.45,
    );
  }
  addNoise(grid, rng, 6);
  roughNoise(rough, rng, 200, 25);
}

function paintGunmetal({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(72, 74, 80);
  // Brushed streaks: every 4th row slightly lighter.
  for (let y = 0; y < size; y += 4) {
    for (let x = 0; x < size; x++) {
      grid.set(x, y, 84, 86, 92, 120);
    }
  }
  addNoise(grid, rng, 6);
  roughNoise(rough, rng, 110, 25);
}

function paintTireRubber({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(34, 34, 37);
  // Chevron tread: analytic, period 32 divides 128 → tiles seamlessly.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x + Math.abs(y - size / 2) * 1.6) % 32;
      if (v < 13) {
        grid.set(x, y, 58, 58, 62, 255);
      } else if (v < 16) {
        grid.set(x, y, 22, 22, 24, 255);
      }
    }
  }
  addNoise(grid, rng, 4);
  roughNoise(rough, rng, 235, 15);
}

function paintConcrete({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(172, 170, 163); // luminance-biased: tintable
  addWrappedValueNoise(grid, rng, 5, 10);
  // Stains: large soft dark blotches, low alpha.
  for (let i = 0; i < 6; i++) {
    blotch(
      grid,
      rng() * size,
      rng() * size,
      22 + rng() * 30,
      [128, 126, 120],
      70,
      0.85,
    );
  }
  addNoise(grid, rng, 7);
  // Cracks: jittery random walks, wrapped.
  for (let i = 0; i < 4; i++) {
    crack(grid, rng, rng() * size, rng() * size, 26, [105, 103, 98]);
  }
  roughNoise(rough, rng, 225, 20);
}

function paintGlassBlue({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(96, 148, 198);
  // Diagonal reflection streaks, period 64 divides 128 → tiles.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x * 0.5 + y) % 64;
      if (v < 9) {
        grid.set(x, y, 150, 195, 235, 255);
      } else if (v < 12) {
        grid.set(x, y, 70, 120, 170, 255);
      }
    }
  }
  addNoise(grid, rng, 4);
  rough.fill(48); // glass reads smooth
  for (let i = 0; i < 300; i++) {
    rough.set(rng() * size, rng() * size, 48 + rng() * 40);
  }
}

function paintBrickRed({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(150, 142, 134); // mortar
  const bw = 32;
  const bh = 16;
  const mortar = 2;
  for (let row = 0; row < size / bh; row++) {
    const offset = row % 2 === 0 ? 0 : bw / 2;
    for (let col = -1; col < size / bw + 1; col++) {
      const bx = col * bw + offset;
      const by = row * bh;
      // Per-brick hue jitter (deterministic draw order).
      const jr = (rng() - 0.5) * 36;
      const jg = (rng() - 0.5) * 22;
      const r = 168 + jr;
      const g = 74 + jg;
      const b = 58 + jg * 0.6;
      for (let y = mortar; y < bh - mortar; y++) {
        for (let x = mortar; x < bw - mortar; x++) {
          // Subtle top-light shading per brick.
          const shade = 1 - (y / bh) * 0.12;
          grid.set(bx + x, by + y, r * shade, g * shade, b * shade, 255);
        }
      }
    }
  }
  addNoise(grid, rng, 8);
  roughNoise(rough, rng, 215, 25);
}

function paintWoodPlank({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(60, 44, 30); // gaps between planks
  const plankH = 32;
  for (let p = 0; p < size / plankH; p++) {
    const jr = (rng() - 0.5) * 30;
    const base: Rgb = [150 + jr, 112 + jr * 0.7, 78 + jr * 0.5];
    for (let y = 2; y < plankH - 1; y++) {
      for (let x = 0; x < size; x++) {
        const shade = 1 - (y / plankH) * 0.1;
        grid.set(x, p * plankH + y, base[0] * shade, base[1] * shade, base[2] * shade, 255);
      }
    }
    // Grain: 3 wavy darker lines per plank.
    for (let ln = 0; ln < 3; ln++) {
      const gy = p * plankH + 4 + rng() * (plankH - 8);
      const phase = rng() * Math.PI * 2;
      const amp = 1 + rng() * 2;
      for (let x = 0; x < size; x++) {
        const yy = gy + Math.sin((x / size) * Math.PI * 4 + phase) * amp;
        grid.set(x, yy, base[0] * 0.72, base[1] * 0.72, base[2] * 0.72, 200);
      }
    }
  }
  addNoise(grid, rng, 6);
  roughNoise(rough, rng, 195, 25);
}

function paintCanvasFabric({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(196, 182, 152); // near-white tan: tintable
  // Woven checker: alternating ±5 per pixel.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const w = (x + y) % 2 === 0 ? 6 : -6;
      grid.set(x, y, 196 + w, 182 + w, 152 + w, 255);
    }
  }
  addWrappedValueNoise(grid, rng, 4, 6);
  // Seams every 64px.
  for (let s = 0; s < size; s += 64) {
    wrappedLine(grid, 0, s, size, s, [150, 136, 108], 200, 2);
  }
  roughNoise(rough, rng, 235, 15);
}

function paintHullGray({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(186, 189, 194); // near-white: tintable
  addWrappedValueNoise(grid, rng, 4, 6);
  // Hull plate grid + rivets. Spacings divide 128 so the grid is periodic.
  const step = 32;
  for (let p = 0; p < size; p += step) {
    wrappedLine(grid, p, 0, p, size, [140, 143, 148], 150, 1);
    wrappedLine(grid, 0, p, size, p, [140, 143, 148], 150, 1);
  }
  for (let y = 0; y < size; y += step) {
    for (let x = 8; x < size; x += 16) {
      grid.set(x, y + 2, 130, 133, 138, 220); // rivet dots
      grid.set(x + 2, y, 130, 133, 138, 220);
    }
  }
  addNoise(grid, rng, 5);
  roughNoise(rough, rng, 160, 30);
}

function paintRustMetal({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(96, 76, 60);
  // Rust blooms.
  for (let i = 0; i < 22; i++) {
    const palette: Rgb[] = [
      [152, 96, 54],
      [130, 78, 44],
      [66, 52, 44],
      [170, 112, 66],
    ];
    const c = palette[Math.floor(rng() * palette.length)];
    if (!c) continue; // unreachable: palette is non-empty by construction
    blotch(
      grid,
      rng() * size,
      rng() * size,
      6 + rng() * 16,
      c,
      200,
      0.7,
    );
  }
  addNoise(grid, rng, 10);
  roughNoise(rough, rng, 225, 25);
}

function paintHazardStripes({ grid, rough, rng, size }: PaintCtx): void {
  // 45° stripes, period 32 divides 256 → tiles seamlessly.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x + y) % 32;
      if (v < 16) {
        grid.set(x, y, 232, 192, 44, 255);
      } else {
        grid.set(x, y, 26, 26, 28, 255);
      }
    }
  }
  addNoise(grid, rng, 7);
  // Grunge: worn patches.
  for (let i = 0; i < 30; i++) {
    blotch(grid, rng() * size, rng() * size, 4 + rng() * 10, [90, 88, 84], 90, 0.8);
  }
  roughNoise(rough, rng, 175, 30);
}

function paintRoofGravel({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(92, 90, 86); // luminance-biased: tintable
  // Gravel stones: light dots with dark shadow offset.
  for (let i = 0; i < 1100; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const light = rng() > 0.5;
    const s = 1 + Math.floor(rng() * 2);
    const c: Rgb = light ? [140, 138, 132] : [58, 56, 53];
    for (let oy = 0; oy < s; oy++) {
      for (let ox = 0; ox < s; ox++) {
        grid.set(x + ox, y + oy, c[0], c[1], c[2], 255);
      }
    }
  }
  addNoise(grid, rng, 8);
  roughNoise(rough, rng, 240, 15);
}

function paintSandbag({ grid, rough, rng, size }: PaintCtx): void {
  grid.fill(120, 104, 80); // shadow gaps
  const bagW = 64;
  const bagH = 32;
  for (let row = 0; row < size / bagH; row++) {
    const offset = row % 2 === 0 ? 0 : bagW / 2;
    for (let col = -1; col < size / bagW + 1; col++) {
      const bx = col * bagW + offset;
      const by = row * bagH;
      const jr = (rng() - 0.5) * 24;
      const base: Rgb = [182 + jr, 166 + jr * 0.8, 132 + jr * 0.6];
      for (let y = 3; y < bagH - 3; y++) {
        for (let x = 3; x < bagW - 3; x++) {
          // Bag bulge shading: lighter center, darker edges.
          const ex = Math.min(x - 3, bagW - 4 - x) / (bagW / 2);
          const ey = Math.min(y - 3, bagH - 4 - y) / (bagH / 2);
          const shade = 0.82 + 0.18 * Math.min(ex, ey);
          grid.set(bx + x, by + y, base[0] * shade, base[1] * shade, base[2] * shade, 255);
        }
      }
      // Stitched seam.
      for (let x = 8; x < bagW - 8; x += 6) {
        grid.set(bx + x, by + bagH / 2, base[0] * 0.7, base[1] * 0.7, base[2] * 0.7, 255);
      }
    }
  }
  addNoise(grid, rng, 7);
  roughNoise(rough, rng, 230, 20);
}

const PAINTERS: Record<SurfaceCategory, (ctx: PaintCtx) => void> = {
  paintedMetal: paintPaintedMetal,
  camoGreen: (ctx) =>
    paintCamo(
      [108, 118, 78],
      [
        [70, 90, 54],
        [112, 96, 62],
        [140, 148, 108],
        [88, 78, 58],
      ],
      ctx,
    ),
  camoDesert: (ctx) =>
    paintCamo(
      [202, 182, 142],
      [
        [176, 150, 110],
        [142, 116, 82],
        [222, 206, 172],
        [160, 132, 96],
      ],
      ctx,
    ),
  camoNavy: (ctx) =>
    paintCamo(
      [96, 106, 122],
      [
        [62, 72, 88],
        [132, 142, 158],
        [112, 118, 128],
        [80, 88, 104],
      ],
      ctx,
    ),
  gunmetal: paintGunmetal,
  tireRubber: paintTireRubber,
  concrete: paintConcrete,
  glassBlue: paintGlassBlue,
  brickRed: paintBrickRed,
  woodPlank: paintWoodPlank,
  canvasFabric: paintCanvasFabric,
  hullGray: paintHullGray,
  rustMetal: paintRustMetal,
  hazardStripes: paintHazardStripes,
  roofGravel: paintRoofGravel,
  sandbag: paintSandbag,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the diffuse pixel buffer for a surface. Pure and deterministic:
 * same (category, seed) → byte-identical `data` on every call and platform.
 */
export function generateSurfacePixels(
  category: SurfaceCategory,
  seed: number = defaultSurfaceSeed(category),
): SurfacePixels {
  const size = SURFACE_TEXTURE_SIZE[category];
  const grid = new PixelGrid(size, size);
  const rough = new GrayGrid(size, size);
  PAINTERS[category]({ grid, rough, rng: mulberry32(seed), size });
  return { width: size, height: size, data: grid.data };
}

/**
 * Generate the matching roughness buffer (single channel). Same determinism
 * contract as `generateSurfacePixels`; uses the same seed stream so diffuse
 * and roughness features line up (wear = rougher, streaks = smoother).
 */
export function generateSurfaceRoughness(
  category: SurfaceCategory,
  seed: number = defaultSurfaceSeed(category),
): SurfaceRoughness {
  const size = SURFACE_TEXTURE_SIZE[category];
  const grid = new PixelGrid(size, size);
  const rough = new GrayGrid(size, size);
  PAINTERS[category]({ grid, rough, rng: mulberry32(seed), size });
  return { width: size, height: size, data: rough.data };
}

const textureCache = new Map<string, THREE.DataTexture>();
const roughnessCache = new Map<string, THREE.DataTexture>();

/**
 * Shared diffuse texture for a surface (cached per category+seed).
 * `THREE.DataTexture` needs no canvas/DOM — headless-safe.
 */
export function surfaceTexture(
  category: SurfaceCategory,
  seed: number = defaultSurfaceSeed(category),
): THREE.DataTexture {
  const key = `${category}:${seed}`;
  let tex = textureCache.get(key);
  if (!tex) {
    const px = generateSurfacePixels(category, seed);
    tex = new THREE.DataTexture(px.data, px.width, px.height);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    textureCache.set(key, tex);
  }
  return tex;
}

/** Shared roughness texture for a surface (cached per category+seed). */
export function surfaceRoughnessTexture(
  category: SurfaceCategory,
  seed: number = defaultSurfaceSeed(category),
): THREE.DataTexture {
  const key = `${category}:${seed}`;
  let tex = roughnessCache.get(key);
  if (!tex) {
    const px = generateSurfaceRoughness(category, seed);
    tex = new THREE.DataTexture(px.data, px.width, px.height, THREE.RedFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    roughnessCache.set(key, tex);
  }
  return tex;
}
