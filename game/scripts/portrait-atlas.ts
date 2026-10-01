/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This file is part of NOVATERRA. NOVATERRA is free software: you can
 * redistribute it and/or modify it under the terms of the GNU Affero General
 * Public License as published by the Free Software Foundation, either version
 * 3 of the License, or (at your option) any later version.
 *
 * NOVATERRA is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — game/scripts/portrait-atlas.ts — 0.1 Alpha.
 *
 * Build-time entity portrait atlas (the deterministic core).
 *
 * Renders one 96×96 2.5D portrait per entity art kind — a 3/4 angled view
 * on a transparent background — and packs them into a sprite atlas PNG +
 * JSON manifest for the command-menu cards (`src/ui/entityPortraits.ts`).
 *
 * Why a CPU rasterizer instead of WebGL (see docs/research/menu-imagery.md
 * for the full decision record):
 *  - three.js r186 requires WebGL2; the `gl` (headless-gl) npm package only
 *    does WebGL1 and has no Node 24 prebuilds (its node-gyp fallback cannot
 *    fetch headers in this environment), and no system Chromium exists here.
 *  - A small software renderer over the game's OWN processed geometry
 *    (GLTFLoader parse → normalizeModel → extractModelGeometry →
 *    applySurfaceTreatment, plus the procedural builders) is fully
 *    deterministic, needs no GPU, and reuses the exact materials the game
 *    renders with — so thumbnails match in-game appearance.
 *
 * Pipeline (all deterministic — no RNG, no wall-clock, no timestamps):
 *   PortraitPiece[] (geometry + material + offset, model-local space)
 *     → renderPortrait(): 3/4 perspective view, 2× supersampled z-buffer
 *       rasterizer, Lambert + hemisphere + camera fill + fake env-for-metals
 *       lighting, ACES-ish tone map, sRGB output, transparent background
 *     → 96×96 RGBA
 *   buildAtlas(): fixed 16-column grid of 96px tiles → atlas RGBA
 *     → encodePngPaletted(): paletted PNG (median-cut to a 256-entry global
 *       palette, PLTE + tRNS chunks, zlib level 9 — the source textures'
 *       painted grain is invisible at 96px but costs dearly as RGBA, so
 *       quantization keeps the atlas under the 400KB budget; encodePng()
 *       keeps the lossless RGBA path for tests/debug)
 *     → manifestJson(): { version, image, tile, atlasWidth, atlasHeight,
 *       sprites } with sorted keys — the contract in
 *       src/ui/entityPortraits.ts.
 *
 * Rendering conventions mirror the game: models face +z, +y up; the camera
 * sits at azimuth 45° (front-right), elevation 26°. Per-kind overrides
 * ({ distance, angle, yOffset }) live in scripts/portrait-overrides.json.
 *
 * Budgets: the whole atlas must stay under PORTRAIT_ATLAS_BUDGET_BYTES
 * (pinned by tests/render.portraitAtlas.test.ts) so menu imagery can never
 * silently eat the 8 MiB boot budget.
 */

/// <reference path="./node-shim.d.ts" />
import * as THREE from 'three';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** Portrait tile size in px (also the manifest `tile`). */
export const PORTRAIT_TILE = 96;
/** Fixed atlas grid width in tiles. */
export const ATLAS_COLS = 16;
/** Supersample factor: rasterize at 192px, box-downsample to 96px. */
const SUPERSAMPLE = 2;
const RENDER_PX = PORTRAIT_TILE * SUPERSAMPLE;
/** Atlas PNG size cap — a few hundred KB (see budget note above). */
export const PORTRAIT_ATLAS_BUDGET_BYTES = 400 * 1024;

/** Per-kind render overrides (scripts/portrait-overrides.json). */
export interface PortraitOverride {
  /** Multiplier on the auto-fit camera distance (default 1). */
  distance?: number;
  /** Camera azimuth in degrees, 0 = +z front, 90 = +x side (default 45). */
  angle?: number;
  /** World units added to the camera target height (default 0). */
  yOffset?: number;
}

/**
 * One visual piece of a kind: a baked geometry with its material, placed
 * at an entity-local offset (GLB composite pieces, attach props). Normals
 * are already baked — offsets are translations only.
 */
export interface PortraitPiece {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  dx: number;
  dy: number;
  dz: number;
}

/** A rasterizer-friendly texture sampled from a THREE.DataTexture image. */
interface SampledTexture {
  data: Uint8Array;
  w: number;
  h: number;
  flipY: boolean;
  repeatS: boolean;
  repeatT: boolean;
  /** True when the texel bytes are sRGB and need linearizing. */
  srgb: boolean;
}

interface ShadingMaterial {
  r: number;
  g: number;
  b: number;
  map: SampledTexture | null;
  vertexColors: boolean;
  metalness: number;
  /** 0 = front, 1 = back, 2 = double (mirrors THREE.Side). */
  side: number;
}

interface RasterTri {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z0: number;
  z1: number;
  z2: number;
  nx0: number;
  ny0: number;
  nz0: number;
  nx1: number;
  ny1: number;
  nz1: number;
  nx2: number;
  ny2: number;
  nz2: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  u2: number;
  v2: number;
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
  r2: number;
  g2: number;
  b2: number;
  area: number;
  mat: ShadingMaterial;
}

// ---------------------------------------------------------------------------
// Material / texture adaptation
// ---------------------------------------------------------------------------

/** sRGB byte (0..255) → linear 0..1. Matches three.js sRGBTransfer. */
function srgbToLinearByte(b: number): number {
  const s = b / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Linear 0..1 → sRGB 0..255. */
function linearToSrgbByte(l: number): number {
  const c = l <= 0 ? 0 : l >= 1 ? 1 : l;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Adapt a THREE.Texture to the sampler. Only DataTexture-style images
 * ({ data: Uint8Array, width, height }) are supported — that covers the
 * game's procedural surface DataTextures and the portrait script's
 * PNG-decoded GLB colormaps. Anything else → null (untextured).
 */
function adaptTexture(tex: THREE.Texture | null): SampledTexture | null {
  if (!tex) return null;
  const img = tex.image as { data?: unknown; width?: unknown; height?: unknown } | undefined;
  if (!img || !(img.data instanceof Uint8Array) || typeof img.width !== 'number' || typeof img.height !== 'number') {
    return null;
  }
  return {
    data: img.data,
    w: img.width,
    h: img.height,
    flipY: tex.flipY,
    repeatS: tex.wrapS === THREE.RepeatWrapping,
    repeatT: tex.wrapT === THREE.RepeatWrapping,
    srgb: tex.colorSpace === THREE.SRGBColorSpace,
  };
}

function adaptMaterial(mat: THREE.Material): ShadingMaterial {
  const std = mat as THREE.MeshStandardMaterial;
  const c = std.color instanceof THREE.Color ? std.color : new THREE.Color(1, 1, 1);
  const mapTex = (std.map as THREE.Texture | null | undefined) ?? null;
  const side = mat.side === THREE.BackSide ? 1 : mat.side === THREE.DoubleSide ? 2 : 0;
  return {
    r: c.r,
    g: c.g,
    b: c.b,
    map: adaptTexture(mapTex),
    vertexColors: (std as { vertexColors?: boolean }).vertexColors === true,
    metalness: typeof std.metalness === 'number' ? std.metalness : 0,
    side,
  };
}

function sampleTexture(t: SampledTexture, u: number, v: number, out: number[]): void {
  let uu = t.repeatS ? u - Math.floor(u) : Math.min(1, Math.max(0, u));
  let vv = t.repeatT ? v - Math.floor(v) : Math.min(1, Math.max(0, v));
  if (t.flipY) vv = 1 - vv;
  const x = Math.min(t.w - 1, Math.max(0, Math.round(uu * (t.w - 1))));
  const y = Math.min(t.h - 1, Math.max(0, Math.round(vv * (t.h - 1))));
  const i = (y * t.w + x) * 4;
  const d = t.data;
  if (t.srgb) {
    out[0] = srgbToLinearByte(d[i] ?? 0);
    out[1] = srgbToLinearByte(d[i + 1] ?? 0);
    out[2] = srgbToLinearByte(d[i + 2] ?? 0);
  } else {
    out[0] = (d[i] ?? 0) / 255;
    out[1] = (d[i + 1] ?? 0) / 255;
    out[2] = (d[i + 2] ?? 0) / 255;
  }
}

// ---------------------------------------------------------------------------
// Camera + triangle setup
// ---------------------------------------------------------------------------

interface Camera {
  /** Camera position (world). */
  cx: number;
  cy: number;
  cz: number;
  /** Unit vector from target toward the camera (for the fill light). */
  fdx: number;
  fdy: number;
  fdz: number;
  /** View basis rows: right, up, minus-forward. */
  rxx: number;
  rxy: number;
  rxz: number;
  rux: number;
  ruy: number;
  ruz: number;
  rfx: number;
  rfy: number;
  rfz: number;
  /** Perspective scale: screenPx = NDC * focal + center. */
  focal: number;
  half: number;
}

function buildCamera(
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
  override: PortraitOverride | undefined,
): Camera {
  const az = ((override?.angle ?? 45) * Math.PI) / 180;
  const el = (26 * Math.PI) / 180;
  const distMul = override?.distance ?? 1;
  const targetY = centerY + (override?.yOffset ?? 0);
  const fov = (30 * Math.PI) / 180;
  const dist = (radius / Math.tan(fov / 2)) * 1.12 * distMul;
  const dx = Math.sin(az) * Math.cos(el);
  const dy = Math.sin(el);
  const dz = Math.cos(az) * Math.cos(el);
  const cx = centerX + dx * dist;
  const cy = targetY + dy * dist;
  const cz = centerZ + dz * dist;
  // forward = target - pos, normalized
  let fx = centerX - cx;
  let fy = targetY - cy;
  let fz = centerZ - cz;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = forward × worldUp(0,1,0)
  let rx = fy * 0 - fz * 1;
  let ry = fz * 0 - fx * 0;
  let rz = fx * 1 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // up = right × forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  const focal = RENDER_PX / 2 / Math.tan(fov / 2);
  return {
    cx,
    cy,
    cz,
    fdx: dx,
    fdy: dy,
    fdz: dz,
    rxx: rx,
    rxy: ry,
    rxz: rz,
    rux: ux,
    ruy: uy,
    ruz: uz,
    rfx: fx,
    rfy: fy,
    rfz: fz,
    focal,
    half: RENDER_PX / 2,
  };
}

/** Project a world point to screen px + view depth. Returns null behind camera. */
function project(
  cam: Camera,
  x: number,
  y: number,
  z: number,
  out: { sx: number; sy: number; depth: number },
): boolean {
  const vx = x - cam.cx;
  const vy = y - cam.cy;
  const vz = z - cam.cz;
  const vzc = vx * cam.rfx + vy * cam.rfy + vz * cam.rfz;
  if (vzc <= 0.001) return false;
  const vxc = vx * cam.rxx + vy * cam.rxy + vz * cam.rxz;
  const vyc = vx * cam.rux + vy * cam.ruy + vz * cam.ruz;
  out.sx = cam.half + (vxc / vzc) * cam.focal;
  out.sy = cam.half - (vyc / vzc) * cam.focal;
  out.depth = vzc;
  return true;
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

const _proj = { sx: 0, sy: 0, depth: 0 };
const _texel = [0, 0, 0];

/**
 * ACES filmic approximation (Stephen Hill fit) on linear RGB — the game
 * renders with THREE.ACESFilmicToneMapping, so thumbnails get the same
 * highlight rolloff to match in-game appearance.
 */
function aces(x: number): number {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  return Math.min(1, Math.max(0, ((x * (a * x + b)) / (x * (c * x + d) + e))));
}

// Key light: direction TOWARD the light (upper-left-front), linear-space color.
const SUN_X = -0.5;
const SUN_Y = 0.8;
const SUN_Z = 0.6;
const SUN_LEN = Math.hypot(SUN_X, SUN_Y, SUN_Z);
const SUN = { x: SUN_X / SUN_LEN, y: SUN_Y / SUN_LEN, z: SUN_Z / SUN_LEN, r: 1.25, g: 1.18, b: 1.08 };
// Hemisphere: sky/ground tints, strength mirrors a soft studio HDRI.
const HEMI_SKY = { r: 0.42, g: 0.47, b: 0.55 };
const HEMI_GROUND = { r: 0.3, g: 0.28, b: 0.26 };
const HEMI_STRENGTH = 0.75;
// Fake environment reflection for metals (the game uses a procedural
// equirect env map at runtime; thumbnails approximate it analytically).
const ENV_TINT = { r: 0.55, g: 0.62, b: 0.72 };
// Fill light from the camera direction: lifts the faces turned away from
// the key sun so dark models stay readable at thumbnail size.
const FILL = { r: 0.32, g: 0.34, b: 0.38 };

/**
 * Render one portrait: pieces → 96×96 RGBA (transparent background).
 * Deterministic: identical pieces + override → identical bytes.
 */
export function renderPortrait(pieces: PortraitPiece[], override?: PortraitOverride): Uint8Array {  const W = RENDER_PX;
  // --- bounding sphere (bbox center + max radius; deterministic) ---
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let anyVerts = false;
  for (const p of pieces) {
    const pos = p.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    anyVerts = true;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + p.dx;
      const y = pos.getY(i) + p.dy;
      const z = pos.getZ(i) + p.dz;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!anyVerts) {
    return new Uint8Array(PORTRAIT_TILE * PORTRAIT_TILE * 4); // blank, transparent
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let radius = 0.001;
  for (const p of pieces) {
    const pos = p.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i) + p.dx - cx, pos.getY(i) + p.dy - cy, pos.getZ(i) + p.dz - cz);
      if (d > radius) radius = d;
    }
  }
  const cam = buildCamera(cx, cy, cz, radius, override);

  // --- triangle setup ---
  const tris: RasterTri[] = [];
  for (const p of pieces) {
    const g = p.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const mat = adaptMaterial(p.material);
    const idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? (idx.getX(t * 3) as number) : t * 3;
      const b = idx ? (idx.getX(t * 3 + 1) as number) : t * 3 + 1;
      const c = idx ? (idx.getX(t * 3 + 2) as number) : t * 3 + 2;
      const ax = pos.getX(a) + p.dx;
      const ay = pos.getY(a) + p.dy;
      const az = pos.getZ(a) + p.dz;
      const bx = pos.getX(b) + p.dx;
      const by = pos.getY(b) + p.dy;
      const bz = pos.getZ(b) + p.dz;
      const cxp = pos.getX(c) + p.dx;
      const cyp = pos.getY(c) + p.dy;
      const czp = pos.getZ(c) + p.dz;
      const pa = project(cam, ax, ay, az, _proj);
      const sx0 = _proj.sx;
      const sy0 = _proj.sy;
      const z0 = _proj.depth;
      const pb = project(cam, bx, by, bz, _proj);
      const sx1 = _proj.sx;
      const sy1 = _proj.sy;
      const z1 = _proj.depth;
      const pc = project(cam, cxp, cyp, czp, _proj);
      const sx2 = _proj.sx;
      const sy2 = _proj.sy;
      const z2 = _proj.depth;
      if (!pa || !pb || !pc) continue;
      const area = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
      // Backface culling honoring material.side (three.js convention:
      // counter-clockwise winding in screen space is front-facing).
      if (mat.side === 0 && area <= 0) continue;
      if (mat.side === 1 && area >= 0) continue;
      if (area === 0) continue;
      const n = (i: number, attr: THREE.BufferAttribute | undefined, k: number, fallback: number): number =>
        attr ? attr.getComponent(i, k) : fallback;
      const nn = (i: number, k: number): number => {
        const v = n(i, nor, k, k === 1 ? 1 : 0);
        return Number.isFinite(v) ? v : k === 1 ? 1 : 0;
      };
      tris.push({
        x0: sx0,
        y0: sy0,
        x1: sx1,
        y1: sy1,
        x2: sx2,
        y2: sy2,
        z0,
        z1,
        z2,
        nx0: nn(a, 0),
        ny0: nn(a, 1),
        nz0: nn(a, 2),
        nx1: nn(b, 0),
        ny1: nn(b, 1),
        nz1: nn(b, 2),
        nx2: nn(c, 0),
        ny2: nn(c, 1),
        nz2: nn(c, 2),
        u0: n(a, uv, 0, 0),
        v0: n(a, uv, 1, 0),
        u1: n(b, uv, 0, 0),
        v1: n(b, uv, 1, 0),
        u2: n(c, uv, 0, 0),
        v2: n(c, uv, 1, 0),
        r0: n(a, col, 0, 1),
        g0: n(a, col, 1, 1),
        b0: n(a, col, 2, 1),
        r1: n(b, col, 0, 1),
        g1: n(b, col, 1, 1),
        b1: n(b, col, 2, 1),
        r2: n(c, col, 0, 1),
        g2: n(c, col, 1, 1),
        b2: n(c, col, 2, 1),
        area,
        mat,
      });
    }
  }

  // --- rasterize ---
  const fb = new Uint8Array(W * W * 4);
  const zb = new Float32Array(W * W).fill(Infinity);
  for (const t of tris) {
    const minPx = Math.max(0, Math.floor(Math.min(t.x0, t.x1, t.x2)));
    const maxPx = Math.min(W - 1, Math.ceil(Math.max(t.x0, t.x1, t.x2)));
    const minPy = Math.max(0, Math.floor(Math.min(t.y0, t.y1, t.y2)));
    const maxPy = Math.min(W - 1, Math.ceil(Math.max(t.y0, t.y1, t.y2)));
    if (maxPx < minPx || maxPy < minPy) continue;
    const invArea = 1 / t.area;
    const m = t.mat;
    for (let py = minPy; py <= maxPy; py++) {
      for (let px = minPx; px <= maxPx; px++) {
        const pxf = px + 0.5;
        const pyf = py + 0.5;
        const w0 = ((t.x1 - pxf) * (t.y2 - pyf) - (t.x2 - pxf) * (t.y1 - pyf)) * invArea;
        const w1 = ((t.x2 - pxf) * (t.y0 - pyf) - (t.x0 - pxf) * (t.y2 - pyf)) * invArea;
        const w2 = ((t.x0 - pxf) * (t.y1 - pyf) - (t.x1 - pxf) * (t.y0 - pyf)) * invArea;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const depth = w0 * t.z0 + w1 * t.z1 + w2 * t.z2;
        const fi = py * W + px;
        if (depth >= (zb[fi] ?? Infinity)) continue;
        // Interpolated normal (renormalized per pixel).
        let nx = w0 * t.nx0 + w1 * t.nx1 + w2 * t.nx2;
        let ny = w0 * t.ny0 + w1 * t.ny1 + w2 * t.ny2;
        let nz = w0 * t.nz0 + w1 * t.nz1 + w2 * t.nz2;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        // Albedo: material color × vertex color × map.
        let ar = m.r;
        let ag = m.g;
        let ab = m.b;
        if (m.vertexColors) {
          ar *= w0 * t.r0 + w1 * t.r1 + w2 * t.r2;
          ag *= w0 * t.g0 + w1 * t.g1 + w2 * t.g2;
          ab *= w0 * t.b0 + w1 * t.b1 + w2 * t.b2;
        }
        if (m.map) {
          const u = w0 * t.u0 + w1 * t.u1 + w2 * t.u2;
          const v = w0 * t.v0 + w1 * t.v1 + w2 * t.v2;
          sampleTexture(m.map, u, v, _texel);
          ar *= _texel[0] ?? 1;
          ag *= _texel[1] ?? 1;
          ab *= _texel[2] ?? 1;
        }
        // Lighting (linear space): hemisphere + key sun + camera fill +
        // fake env for metals.
        const ndotl = Math.max(0, nx * SUN.x + ny * SUN.y + nz * SUN.z);
        const ndotf = Math.max(0, nx * cam.fdx + ny * cam.fdy + nz * cam.fdz);
        const hemiMix = ny * 0.5 + 0.5;
        const lr =
          ar * (HEMI_STRENGTH * (HEMI_GROUND.r + (HEMI_SKY.r - HEMI_GROUND.r) * hemiMix) + SUN.r * ndotl + FILL.r * ndotf) +
          ar * m.metalness * ENV_TINT.r * (0.35 + 0.65 * Math.max(0, ny));
        const lg =
          ag * (HEMI_STRENGTH * (HEMI_GROUND.g + (HEMI_SKY.g - HEMI_GROUND.g) * hemiMix) + SUN.g * ndotl + FILL.g * ndotf) +
          ag * m.metalness * ENV_TINT.g * (0.35 + 0.65 * Math.max(0, ny));
        const lb =
          ab * (HEMI_STRENGTH * (HEMI_GROUND.b + (HEMI_SKY.b - HEMI_GROUND.b) * hemiMix) + SUN.b * ndotl + FILL.b * ndotf) +
          ab * m.metalness * ENV_TINT.b * (0.35 + 0.65 * Math.max(0, ny));
        const o = fi * 4;
        fb[o] = linearToSrgbByte(aces(lr));
        fb[o + 1] = linearToSrgbByte(aces(lg));
        fb[o + 2] = linearToSrgbByte(aces(lb));
        fb[o + 3] = 255;
        zb[fi] = depth;
      }
    }
  }

  // --- box downsample 192 → 96 ---
  const T = PORTRAIT_TILE;
  const out = new Uint8Array(T * T * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          const si = ((y * SUPERSAMPLE + dy) * W + (x * SUPERSAMPLE + dx)) * 4;
          r += fb[si] ?? 0;
          g += fb[si + 1] ?? 0;
          b += fb[si + 2] ?? 0;
          a += fb[si + 3] ?? 0;
        }
      }
      const o = (y * T + x) * 4;
      const n = SUPERSAMPLE * SUPERSAMPLE;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG encoding (deterministic: IHDR + IDAT + IEND only, fixed zlib level)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pushBytes(out: number[], bytes: ArrayLike<number>): void {
  // Chunked: spreading a multi-MB typed array into push() blows the
  // call stack (RangeError), so append in slices.
  const CHUNK = 65536;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    for (let j = i; j < end; j++) out.push(bytes[j] ?? 0);
  }
}

function pngChunk(type: string, data: Uint8Array, out: number[]): void {
  const len = data.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  const crcInput = new Uint8Array(4 + len);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  pushBytes(out, typeBytes);
  pushBytes(out, data);
  const crc = crc32(crcInput);
  out.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

/**
 * Encode RGBA bytes as a minimal PNG. Deterministic: identical input →
 * identical bytes (no timestamps, no encoder tags, fixed zlib level,
 * filter 0 on every row — measured smaller than adaptive filtering on
 * this atlas's noisy sprite content).
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const out: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  pngChunk('IHDR', ihdr, out);
  // Scanlines with filter byte 0 (None).
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const compressed = deflateSync(raw, { level: 9 });
  pngChunk('IDAT', new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength), out);
  pngChunk('IEND', new Uint8Array(0), out);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Palette quantization (median-cut) + paletted PNG encoding.
//
// The atlas's source textures (Kenney colormaps, procedural surfaces) carry
// fine painted grain that is invisible at 96px but costs dearly as RGBA
// PNG entropy (~840KB). Reducing the atlas to a 256-entry global palette
// (median-cut, deterministic) brings it under the 400KB budget with no
// visible change at thumbnail size. Fully transparent pixels reserve
// palette index 0; alpha for every other entry rides in tRNS.
// ---------------------------------------------------------------------------

interface QuantColor {
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

/**
 * Median-cut `rgba` down to at most `maxColors` palette entries.
 * Returns the palette (index 0 = transparent) and a function mapping an
 * RGBA quadruplet to its palette index. Deterministic: boxes are split
 * along the widest channel at the weighted median with fully ordered
 * tie-breaks; box choice is first-maximum over creation order.
 */
export function medianCutPalette(
  rgba: Uint8Array,
  maxColors: number,
): { palette: { r: number; g: number; b: number; a: number }[]; indexOf: (r: number, g: number, b: number, a: number) => number } {
  // Histogram of unique non-transparent colors.
  const hist = new Map<number, QuantColor>();
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] ?? 0;
    if (a === 0) continue;
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const key = ((r * 256 + g) * 256 + b) * 256 + a;
    const e = hist.get(key);
    if (e) e.count++;
    else hist.set(key, { r, g, b, a, count: 1 });
  }
  const colors = [...hist.values()];
  // A box is a slice of `colors` sorted by the split channel.
  interface Box {
    start: number;
    end: number;
  }
  const boxes: Box[] = colors.length ? [{ start: 0, end: colors.length }] : [];
  const channelRange = (box: Box): { ch: number; range: number } => {
    let rMin = 255;
    let rMax = 0;
    let gMin = 255;
    let gMax = 0;
    let bMin = 255;
    let bMax = 0;
    let aMin = 255;
    let aMax = 0;
    for (let i = box.start; i < box.end; i++) {
      const c = colors[i];
      if (!c) continue;
      if (c.r < rMin) rMin = c.r;
      if (c.r > rMax) rMax = c.r;
      if (c.g < gMin) gMin = c.g;
      if (c.g > gMax) gMax = c.g;
      if (c.b < bMin) bMin = c.b;
      if (c.b > bMax) bMax = c.b;
      if (c.a < aMin) aMin = c.a;
      if (c.a > aMax) aMax = c.a;
    }
    const ranges = [rMax - rMin, gMax - gMin, bMax - bMin, aMax - aMin];
    let ch = 0;
    for (let k = 1; k < 4; k++) {
      if ((ranges[k] ?? 0) > (ranges[ch] ?? 0)) ch = k;
    }
    return { ch, range: ranges[ch] ?? 0 };
  };
  const boxPixels = (box: Box): number => {
    let n = 0;
    for (let i = box.start; i < box.end; i++) n += colors[i]?.count ?? 0;
    return n;
  };
  const channelOf = (c: QuantColor, ch: number): number =>
    ch === 0 ? c.r : ch === 1 ? c.g : ch === 2 ? c.b : c.a;
  while (boxes.length < maxColors) {
    // Pick the splittable box with the most pixels × widest range.
    let pick = -1;
    let pickScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!box || box.end - box.start < 2) continue;
      const { range } = channelRange(box);
      if (range === 0) continue;
      const score = boxPixels(box) * (range + 1);
      if (score > pickScore) {
        pickScore = score;
        pick = i;
      }
    }
    if (pick < 0) break;
    const box = boxes[pick]!;
    const { ch } = channelRange(box);
    const slice = colors.slice(box.start, box.end);
    slice.sort((p, q) => {
      const d = channelOf(p, ch) - channelOf(q, ch);
      if (d !== 0) return d;
      if (p.r !== q.r) return p.r - q.r;
      if (p.g !== q.g) return p.g - q.g;
      if (p.b !== q.b) return p.b - q.b;
      return p.a - q.a;
    });
    for (let i = 0; i < slice.length; i++) colors[box.start + i] = slice[i]!;
    // Split at the weighted median pixel.
    const total = boxPixels(box);
    let acc = 0;
    let mid = box.start;
    for (let i = box.start; i < box.end; i++) {
      acc += colors[i]?.count ?? 0;
      if (acc * 2 >= total) {
        mid = i + 1;
        break;
      }
      mid = i + 1;
    }
    if (mid <= box.start || mid >= box.end) break;
    boxes[pick] = { start: box.start, end: mid };
    boxes.push({ start: mid, end: box.end });
  }
  // Palette: index 0 = transparent, then the count-weighted box averages.
  const palette = [{ r: 0, g: 0, b: 0, a: 0 }];
  for (const box of boxes) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let n = 0;
    for (let i = box.start; i < box.end; i++) {
      const c = colors[i];
      if (!c) continue;
      r += c.r * c.count;
      g += c.g * c.count;
      b += c.b * c.count;
      a += c.a * c.count;
      n += c.count;
    }
    if (n === 0) continue;
    palette.push({
      r: Math.round(r / n),
      g: Math.round(g / n),
      b: Math.round(b / n),
      a: Math.round(a / n),
    });
  }
  // Nearest-entry lookup with an exact-color cache (the atlas has far
  // fewer unique colors than pixels).
  const cache = new Map<number, number>();
  const indexOf = (r: number, g: number, b: number, a: number): number => {
    if (a === 0) return 0;
    const key = ((r * 256 + g) * 256 + b) * 256 + a;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let bestIdx = 1;
    let bestD = Infinity;
    for (let i = 1; i < palette.length; i++) {
      const p = palette[i]!;
      const dr = r - p.r;
      const dg = g - p.g;
      const db = b - p.b;
      const da = (a - p.a) * 2; // alpha errors show as halos; weight them up
      const d = dr * dr + dg * dg + db * db + da * da;
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    cache.set(key, bestIdx);
    return bestIdx;
  };
  return { palette, indexOf };
}

/**
 * Encode RGBA bytes as a paletted PNG (color type 3, 8-bit indices):
 * median-cut to 255 colors + transparent, PLTE + tRNS, filter 0 rows,
 * zlib level 9. Deterministic like encodePng.
 */
export function encodePngPaletted(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePngPaletted: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const { palette, indexOf } = medianCutPalette(rgba, 255);
  const out: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: paletted
  pngChunk('IHDR', ihdr, out);
  const plte = new Uint8Array(palette.length * 3);
  const trns = new Uint8Array(palette.length);
  palette.forEach((p, i) => {
    plte[i * 3] = p.r;
    plte[i * 3 + 1] = p.g;
    plte[i * 3 + 2] = p.b;
    trns[i] = p.a;
  });
  pngChunk('PLTE', plte, out);
  pngChunk('tRNS', trns, out);
  const raw = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      raw[rowOff + 1 + x] = indexOf(rgba[o] ?? 0, rgba[o + 1] ?? 0, rgba[o + 2] ?? 0, rgba[o + 3] ?? 0);
    }
  }
  const compressed = deflateSync(raw, { level: 9 });
  pngChunk('IDAT', new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength), out);
  pngChunk('IEND', new Uint8Array(0), out);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Atlas packing + manifest
// ---------------------------------------------------------------------------

export interface AtlasTiles {
  [kind: string]: { x: number; y: number };
}

/**
 * Pack rendered portraits (keyed by ART kind — tech variants share their
 * base kind's tile) into the fixed 96px grid. Kinds are laid out in sorted
 * order so the atlas is deterministic. Returns the atlas PNG bytes, its
 * pixel dimensions, and the per-kind tile origins (pixel top-left).
 */
export function buildAtlas(renders: Map<string, Uint8Array>): {
  png: Uint8Array;
  width: number;
  height: number;
  tiles: AtlasTiles;
} {
  const kinds = [...renders.keys()].sort();
  const T = PORTRAIT_TILE;
  const rows = Math.ceil(kinds.length / ATLAS_COLS);
  const width = ATLAS_COLS * T;
  const height = rows * T;
  const atlas = new Uint8Array(width * height * 4); // transparent
  const tiles: AtlasTiles = {};
  kinds.forEach((kind, i) => {
    const px = renders.get(kind);
    if (!px || px.length !== T * T * 4) {
      throw new Error(`buildAtlas: bad portrait bytes for ${kind}`);
    }
    const tx = (i % ATLAS_COLS) * T;
    const ty = Math.floor(i / ATLAS_COLS) * T;
    for (let y = 0; y < T; y++) {
      atlas.set(px.subarray(y * T * 4, (y + 1) * T * 4), (ty + y) * width * 4 + tx * 4);
    }
    tiles[kind] = { x: tx, y: ty };
  });
  const png = encodePngPaletted(width, height, atlas);
  return { png, width, height, tiles };
}

/**
 * Serialize the manifest (sorted keys, deterministic). Shape: Worker B's
 * ui/entityPortraits.ts contract ({ image, tile, atlasWidth,
 * atlasHeight, sprites }) plus `version: 1` — the consumer's
 * parseAtlasManifest tolerates the extra field. `sprites` maps every
 * ENTITY kind (variants included — they share their base kind's tile)
 * to its 96px tile rect.
 */
export function manifestJson(
  tiles: AtlasTiles,
  entityKinds: string[],
  artKindOf: (kind: string) => string,
  width: number,
  height: number,
): string {
  const sprites: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const kind of entityKinds) {
    const t = tiles[artKindOf(kind)];
    if (!t) throw new Error(`manifestJson: no tile for art kind of ${kind}`);
    sprites[kind] = { x: t.x, y: t.y, w: PORTRAIT_TILE, h: PORTRAIT_TILE };
  }
  const sorted: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const k of Object.keys(sprites).sort()) {
    const s = sprites[k];
    if (s) sorted[k] = s;
  }
  const manifest = {
    version: 1,
    image: 'entity-atlas.png',
    tile: PORTRAIT_TILE,
    atlasWidth: width,
    atlasHeight: height,
    sprites: sorted,
  };
  return JSON.stringify(manifest) + '\n';
}

/** sha256 hex of bytes (used by the determinism test). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
