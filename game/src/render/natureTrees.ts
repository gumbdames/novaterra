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
 * NOVATERRA — render/natureTrees.ts — procedural TEXTURED trees for the
 * nature scatter (0.1 Alpha).
 *
 * Purpose: replace the crude vertex-colored Kenney cone/blob trees the
 * nature scatter used to draw (user directive 2026-09-30: "too
 * square/pointy", "lack proper texture") with smooth, textured trees:
 * lathe-turned trunks with root flare and taper, broadleaf canopies of
 * layered alpha-cut leaf cards over a dark inner core, and conifers built
 * from drooping needle-frond tiers. No cones, no blob clusters.
 *
 * Textures are Quaternius's hand-painted CC0 bark/leaf set
 * (`game/public/models/quaternius-nature/textures/`, evidence in
 * `LICENSE-CC0.txt` there) — the same artist's hand as the game's tanks
 * and infantry, so the trees sit with the existing cast instead of
 * fighting it. See docs/research/trees.md for the full evaluation
 * (rejected: Kenney variants, Poly Pizza, OpenGameArt models, Poly Haven
 * scans; deferred: Quaternius Stylized Nature MegaKit — itch.io download
 * friction).
 *
 * Determinism: every builder takes a fixed per-species seed through
 * `mulberry32` — no `Math.random` anywhere, all ops plain float math —
 * so the geometry bytes are identical on every platform and every load.
 * Placement determinism lives in `render/nature.ts` (untouched): same
 * seed → same cells, species, rotations, scales.
 *
 * Perf: ~140–380 tris per tree (measured in tests), one static
 * `InstancedMesh` per (species × part) in `nature.ts` — 6 species × 3
 * parts = 18 draw calls worst case, ~54k tris for a full scatter.
 * Foliage uses `alphaTest` cutout (no transparent sorting, no overdraw
 * spiral); the 5 textures are GPU-resident once and shared by all
 * instances.
 *
 * Fallback: `loadNatureTreeModels` throws when a texture can't be
 * fetched in time; the caller (`ui/game.ts`) keeps the Kenney tree GLBs
 * already in the model map, so the worst case is yesterday's look —
 * never missing trees.
 *
 * Import-safe under Node/vitest: `three` core + `BufferGeometryUtils`
 * touch no DOM at import time. `TextureLoader` is only constructed
 * inside `loadNatureTreeModels` (browser-only path).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { modelBaseUrl, type LoadedModel } from './models';
import { withTimeout } from './renderer';

/** Tree species keyed exactly like the nature-scatter prop keys they fill. */
export type NatureTreeKind =
  | 'propTreeOak'
  | 'propTreeBirch'
  | 'propTreePineTall'
  | 'propTreePine'
  | 'propTreeOldOak'
  | 'propTreePoplar';

/** All six species, in PROP_TABLE order (render/nature.ts). */
export const NATURE_TREE_KINDS: readonly NatureTreeKind[] = [
  'propTreeOak',
  'propTreeBirch',
  'propTreePineTall',
  'propTreePine',
  'propTreeOldOak',
  'propTreePoplar',
];

/** Texture files under `game/public/models/` (served at `<base>/models/`). */
export const NATURE_TREE_TEXTURE_PATHS = {
  bark: 'quaternius-nature/textures/tree_bark.jpg',
  birchBark: 'quaternius-nature/textures/birch_bark.png',
  leaves: 'quaternius-nature/textures/tree_leaves.png',
  birchLeaves: 'quaternius-nature/textures/birch_leaves_green.png',
  pineLeaves: 'quaternius-nature/textures/pine_leaves.png',
} as const;

/** Per-texture load deadline inside `loadNatureTreeModels`. */
export const NATURE_TREE_TEXTURE_TIMEOUT_MS = 8000;

/**
 * Deterministic PRNG (mulberry32): identical sequences on every platform
 * for the same seed. Geometry builders never touch `Math.random`.
 */
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

interface TrunkOpts {
  height: number;
  rBase: number;
  rTop: number;
  /** Root-flare multiplier at the very base (1 = none). */
  flare: number;
  /** Sideways lean of the crown, in world units at the top. */
  lean: number;
  /** Fixed seed — identical geometry on every load. */
  seed: number;
}

/**
 * Smooth tapered trunk with a flared root base and a slight lean.
 * `LatheGeometry` gives clean bark UVs (u = around, v = up); the base
 * rests exactly at y=0.
 */
export function buildTrunkGeometry(opts: TrunkOpts): THREE.BufferGeometry {
  const rng = mulberry32(opts.seed);
  const wobble = rng() * Math.PI * 2;
  const leanAngle = rng() * Math.PI * 2;
  const leanX = Math.cos(leanAngle) * opts.lean;
  const leanZ = Math.sin(leanAngle) * opts.lean;
  const profile: THREE.Vector2[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Taper: full at the base, narrowing toward the top; extra flare
    // right at ground level; a whisper of radial wobble so the
    // silhouette never reads as a turned table leg.
    let r = opts.rBase + (opts.rTop - opts.rBase) * Math.pow(t, 0.85);
    r += opts.rBase * (opts.flare - 1) * Math.exp(-t * 8);
    r *= 1 + 0.05 * Math.sin(t * 9 + wobble);
    profile.push(new THREE.Vector2(Math.max(r, 0.01), t * opts.height));
  }
  const geo = new THREE.LatheGeometry(profile, 9);
  // Bake the lean in (shear grows with height² — roots stay planted).
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = (y / opts.height) * (y / opts.height);
    pos.setX(i, pos.getX(i) + leanX * k);
    pos.setZ(i, pos.getZ(i) + leanZ * k);
  }
  geo.computeVertexNormals();
  return geo;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  s: number;
}

/**
 * Broadleaf canopy: each puff becomes 6 alpha-cut leaf cards at varied
 * yaws/tilts/offsets plus a dark inner icosahedron core so gaps between
 * cards read as shadowed depth instead of sky. The cards are larger than
 * the core and fill the puff volume, so the textured foliage — not the
 * core — defines the silhouette. Merged into one geometry per part.
 */
export function buildCanopyGeometry(
  puffs: Puff[],
  seed: number,
  coreScale = 0.55,
): { cards: THREE.BufferGeometry; core: THREE.BufferGeometry } {
  const rng = mulberry32(seed);
  const cardGeos: THREE.BufferGeometry[] = [];
  const coreGeos: THREE.BufferGeometry[] = [];
  for (const p of puffs) {
    for (let c = 0; c < 6; c++) {
      const yaw = (c / 3) * Math.PI + rng() * 0.5;
      const tiltX = (rng() - 0.5) * 0.7;
      const tiltZ = (rng() - 0.5) * 0.7;
      // Offset each card inside the puff volume so the foliage has
      // depth instead of six planes crossing at a single point.
      const ox = (rng() - 0.5) * 0.5 * p.s;
      const oy = (rng() - 0.5) * 0.4 * p.s;
      const oz = (rng() - 0.5) * 0.5 * p.s;
      const card = new THREE.PlaneGeometry(p.s * 1.45, p.s * 1.45);
      card.applyMatrix4(tr(p.x + ox, p.y + oy, p.z + oz, tiltX, yaw, tiltZ));
      cardGeos.push(card);
    }
    const core = new THREE.IcosahedronGeometry(p.s * coreScale, 0);
    core.applyMatrix4(tr(p.x, p.y, p.z));
    coreGeos.push(core);
  }
  const cards = mergeGeometries(cardGeos, false) as THREE.BufferGeometry;
  const core = mergeGeometries(coreGeos, false) as THREE.BufferGeometry;
  for (const g of cardGeos) g.dispose();
  for (const g of coreGeos) g.dispose();
  return { cards, core };
}

interface ConiferTierOpts {
  /** Trunk-top height where the lowest tier starts. */
  baseY: number;
  /** Vertical gap between tiers. */
  tierGap: number;
  /** Number of foliage tiers. */
  tiers: number;
  /** Outer radius of the lowest tier. */
  rBase: number;
  /** Outer radius of the top tier. */
  rTop: number;
  /** Cards per tier ring. */
  cardsPerTier: number;
  /** Card width/height (the frond texture is portrait). */
  cardW: number;
  cardH: number;
  /** How far the fronds droop (radians of downward pitch). */
  droop: number;
  seed: number;
}

/**
 * Conifer: rings of drooping needle-frond cards, shrinking toward the
 * top, plus one upright leader card. Merged into one geometry.
 */
export function buildConiferGeometry(opts: ConiferTierOpts): THREE.BufferGeometry {
  const rng = mulberry32(opts.seed);
  const geos: THREE.BufferGeometry[] = [];
  for (let t = 0; t < opts.tiers; t++) {
    const f = opts.tiers === 1 ? 0 : t / (opts.tiers - 1);
    const y = opts.baseY + t * opts.tierGap;
    const r = opts.rBase + (opts.rTop - opts.rBase) * f;
    for (let c = 0; c < opts.cardsPerTier; c++) {
      const a = (c / opts.cardsPerTier) * Math.PI * 2 + rng() * 0.4 + t * 0.45;
      const px = Math.cos(a) * r * 0.62;
      const pz = Math.sin(a) * r * 0.62;
      const card = new THREE.PlaneGeometry(opts.cardW, opts.cardH);
      // Face outward, pitch down into the droop, slight random roll.
      card.applyMatrix4(
        tr(px, y, pz, -opts.droop - rng() * 0.25, -a + Math.PI / 2, (rng() - 0.5) * 0.3),
      );
      geos.push(card);
    }
  }
  // Leader: one upright frond closing the top.
  const topY = opts.baseY + (opts.tiers - 1) * opts.tierGap;
  const leader = new THREE.PlaneGeometry(opts.cardW * 0.7, opts.cardH * 1.1);
  leader.applyMatrix4(tr(0, topY + opts.cardH * 0.35, 0, 0, rng() * Math.PI, 0));
  geos.push(leader);
  const merged = mergeGeometries(geos, false) as THREE.BufferGeometry;
  for (const g of geos) g.dispose();
  return merged;
}

/** Scatter `count` canopy puffs inside an ellipsoid crown. */
function crownPuffs(
  rng: () => number,
  count: number,
  cy: number,
  rx: number,
  ry: number,
  rz: number,
  sMin: number,
  sMax: number,
): Puff[] {
  const puffs: Puff[] = [];
  for (let i = 0; i < count; i++) {
    // Rejection-free ellipsoid pick via normalized random direction.
    const th = rng() * Math.PI * 2;
    const ph = Math.acos(2 * rng() - 1);
    const rr = 0.35 + 0.65 * rng();
    puffs.push({
      x: rr * rx * Math.sin(ph) * Math.cos(th),
      y: cy + rr * ry * Math.cos(ph),
      z: rr * rz * Math.sin(ph) * Math.sin(th),
      s: sMin + rng() * (sMax - sMin),
    });
  }
  return puffs;
}

export interface BuiltTreeParts {
  trunk: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
}

/**
 * Build one species' three parts (trunk / foliage cards / inner core).
 * Pure + deterministic: the same kind always yields the same bytes.
 * Base at y=0; overall heights ≈ 5.5–7 units to match the old scatter's
 * visual footprint.
 */
export function buildNatureTreeGeometry(kind: NatureTreeKind): BuiltTreeParts {
  switch (kind) {
    case 'propTreeOak': {
      const trunk = buildTrunkGeometry({
        height: 3.4, rBase: 0.3, rTop: 0.16, flare: 1.6, lean: 0.35,
        seed: 1101,
      });
      const rng = mulberry32(1102);
      const { cards, core } = buildCanopyGeometry(
        crownPuffs(rng, 8, 4.7, 2.3, 1.5, 2.3, 1.9, 2.6),
        1103,
      );
      return { trunk, foliage: cards, core };
    }
    case 'propTreeBirch': {
      const trunk = buildTrunkGeometry({
        height: 4.2, rBase: 0.16, rTop: 0.1, flare: 1.35, lean: 0.3,
        seed: 1201,
      });
      const rng = mulberry32(1202);
      const { cards, core } = buildCanopyGeometry(
        crownPuffs(rng, 6, 5.1, 1.5, 1.2, 1.5, 1.5, 2.0),
        1203,
      );
      return { trunk, foliage: cards, core };
    }
    case 'propTreePineTall': {
      const trunk = buildTrunkGeometry({
        height: 5.4, rBase: 0.22, rTop: 0.1, flare: 1.5, lean: 0.2,
        seed: 1301,
      });
      const foliage = buildConiferGeometry({
        baseY: 2.6, tierGap: 0.95, tiers: 5, rBase: 1.9, rTop: 0.35,
        cardsPerTier: 6, cardW: 1.15, cardH: 1.7, droop: 0.5, seed: 1302,
      });
      // Conifers are dense: a slim dark core hides the trunk behind fronds.
      const core = new THREE.CylinderGeometry(0.28, 0.55, 3.6, 7);
      core.translate(0, 4.2, 0);
      return { trunk, foliage, core };
    }
    case 'propTreePine': {
      const trunk = buildTrunkGeometry({
        height: 3.8, rBase: 0.24, rTop: 0.11, flare: 1.5, lean: 0.25,
        seed: 1401,
      });
      const foliage = buildConiferGeometry({
        baseY: 1.7, tierGap: 0.9, tiers: 4, rBase: 2.2, rTop: 0.45,
        cardsPerTier: 6, cardW: 1.25, cardH: 1.8, droop: 0.55, seed: 1402,
      });
      const core = new THREE.CylinderGeometry(0.3, 0.62, 2.9, 7);
      core.translate(0, 3.0, 0);
      return { trunk, foliage, core };
    }
    case 'propTreeOldOak': {
      const trunk = buildTrunkGeometry({
        height: 2.8, rBase: 0.48, rTop: 0.26, flare: 1.8, lean: 0.4,
        seed: 1501,
      });
      const rng = mulberry32(1502);
      const { cards, core } = buildCanopyGeometry(
        crownPuffs(rng, 10, 4.0, 3.0, 1.7, 3.0, 2.0, 2.8),
        1503,
      );
      return { trunk, foliage: cards, core };
    }
    case 'propTreePoplar': {
      const trunk = buildTrunkGeometry({
        height: 4.6, rBase: 0.2, rTop: 0.11, flare: 1.4, lean: 0.15,
        seed: 1601,
      });
      // Columnar crown: small puffs stacked along the trunk.
      const rng = mulberry32(1602);
      const puffs: Puff[] = [];
      for (let i = 0; i < 7; i++) {
        const y = 3.3 + i * 0.48;
        puffs.push({
          x: (rng() - 0.5) * 0.5,
          y,
          z: (rng() - 0.5) * 0.5,
          s: 1.2 + rng() * 0.45,
        });
      }
      const { cards, core } = buildCanopyGeometry(puffs, 1603);
      return { trunk, foliage: cards, core };
    }
  }
}

export interface NatureTreeTextures {
  bark: THREE.Texture;
  birchBark: THREE.Texture;
  leaves: THREE.Texture;
  birchLeaves: THREE.Texture;
  pineLeaves: THREE.Texture;
}

/** One shared material set for all six species (created once per load). */
export interface NatureTreeMaterials {
  bark: THREE.MeshStandardMaterial;
  birchBark: THREE.MeshStandardMaterial;
  leaves: THREE.MeshStandardMaterial;
  birchLeaves: THREE.MeshStandardMaterial;
  pineLeaves: THREE.MeshStandardMaterial;
  core: THREE.MeshStandardMaterial;
  pineCore: THREE.MeshStandardMaterial;
}

function foliageMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    alphaTest: 0.45, // cutout: no transparent sorting, no overdraw spiral
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });
}

function barkMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
}

/** Assemble the shared materials from loaded textures. Pure (testable). */
export function makeNatureTreeMaterials(tex: NatureTreeTextures): NatureTreeMaterials {
  const core = new THREE.MeshStandardMaterial({ color: 0x143d1c, roughness: 1, metalness: 0 });
  const pineCore = new THREE.MeshStandardMaterial({ color: 0x0f3318, roughness: 1, metalness: 0 });
  return {
    bark: barkMaterial(tex.bark),
    birchBark: barkMaterial(tex.birchBark),
    leaves: foliageMaterial(tex.leaves),
    birchLeaves: foliageMaterial(tex.birchLeaves),
    pineLeaves: foliageMaterial(tex.pineLeaves),
    core,
    pineCore,
  };
}

/** Which (material, texture) each species' three parts use. */
const SPECIES_MATERIALS: Record<NatureTreeKind, readonly ['bark' | 'birchBark', 'leaves' | 'birchLeaves' | 'pineLeaves', 'core' | 'pineCore']> = {
  propTreeOak: ['bark', 'leaves', 'core'],
  propTreeBirch: ['birchBark', 'birchLeaves', 'core'],
  propTreePineTall: ['bark', 'pineLeaves', 'pineCore'],
  propTreePine: ['bark', 'pineLeaves', 'pineCore'],
  propTreeOldOak: ['bark', 'leaves', 'core'],
  propTreePoplar: ['bark', 'leaves', 'core'],
};

/**
 * Load the 5 CC0 textures (bounded by `timeoutMs`) and build the 6
 * species as `LoadedModel`s keyed for `render/nature.ts`.
 *
 * Throws when any texture fails — the caller keeps the Kenney GLB models
 * as fallback (see `ui/game.ts`), so trees never vanish.
 */
export async function loadNatureTreeModels(
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<Map<string, LoadedModel>> {
  const base = opts.baseUrl ?? modelBaseUrl();
  const timeoutMs = opts.timeoutMs ?? NATURE_TREE_TEXTURE_TIMEOUT_MS;
  const loader = new THREE.TextureLoader();
  const loadOne = (path: string): Promise<THREE.Texture> => {
    const url = `${base}models/${path}`;
    return withTimeout(
      loader.loadAsync(url).then((tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        return tex;
      }),
      timeoutMs,
      `nature-tree-texture:${path}`,
    );
  };
  const [bark, birchBark, leaves, birchLeaves, pineLeaves] = await Promise.all([
    loadOne(NATURE_TREE_TEXTURE_PATHS.bark),
    loadOne(NATURE_TREE_TEXTURE_PATHS.birchBark),
    loadOne(NATURE_TREE_TEXTURE_PATHS.leaves),
    loadOne(NATURE_TREE_TEXTURE_PATHS.birchLeaves),
    loadOne(NATURE_TREE_TEXTURE_PATHS.pineLeaves),
  ]);
  const mats = makeNatureTreeMaterials({ bark, birchBark, leaves, birchLeaves, pineLeaves });
  const out = new Map<string, LoadedModel>();
  for (const kind of NATURE_TREE_KINDS) {
    const parts = buildNatureTreeGeometry(kind);
    const [barkKey, leafKey, coreKey] = SPECIES_MATERIALS[kind];
    out.set(kind, {
      geometries: [parts.trunk, parts.foliage, parts.core],
      materials: [mats[barkKey], mats[leafKey], mats[coreKey]],
    });
  }
  return out;
}
