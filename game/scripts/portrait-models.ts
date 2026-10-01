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

/// <reference path="./pngjs.d.ts" />
/// <reference path="./node-shim.d.ts" />

/**
 * NOVATERRA — game/scripts/portrait-models.ts — 0.1 Alpha.
 *
 * Game wiring for the build-time portrait atlas (see portrait-atlas.ts for
 * the deterministic rasterizer/packer core, and render-portraits.mjs for
 * the CLI that drives this module).
 *
 * Responsibilities:
 *  - Load every GLB key the atlas needs from `game/public/models/`,
 *    running the game's OWN per-key pipeline — rotY → `normalizeModel`
 *    → yOffset → `extractModelGeometry` → `applySurfaceTreatment` — so
 *    thumbnails use exactly the geometry/materials the game renders
 *    (mirrors `loadOneModel` in render/models.ts, minus fetch/timeout).
 *  - Compose one `PortraitPiece[]` per entity kind: GLB composite pieces
 *    at their `MODEL_SOURCES` offsets, procedural gap models via
 *    `buildProceduralModel`, and the attach props
 *    (`EntityRenderer.propSpecsFor` — infantry gear, HQ antenna, runway
 *    strips, …) every kind the game decorates with.
 *  - Resolve tech-level variants (Mk II/III) to their base kind's art
 *    through `variantArtBase`, exactly like `modelSourceFor` does, so a
 *    variant portrait is pixel-identical to its base kind's.
 *
 * Node texture hook: GLB external textures (the Kenney `colormap.png`
 * files) are decoded with the pngjs devDependency into `THREE.DataTexture`
 * via a `TextureLoader.prototype.load` patch — GLTFLoader picks
 * `TextureLoader` over `ImageBitmapLoader` here because
 * `createImageBitmap` is undefined under Node. The patch sets
 * `flipY = false`, matching what GLTFLoader assigns to parsed GLB
 * textures in the browser path.
 *
 * Import graph note: this module imports render/entities.ts (for
 * `modelSourceFor` + `propSpecsFor`), which pulls the full render graph —
 * proven import-safe under Node (the render test suites do the same).
 * Determinism: the seeded procedural builders never touch Math.random;
 * PNG decoding and GLB parsing are byte-deterministic.
 */

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import { UNIT_DEFS, type UnitKind } from '../src/sim/units';
import { BUILDING_DEFS } from '../src/sim/city';
import { variantArtBase } from '../src/sim/variants';
import {
  MODEL_PATHS,
  normalizeModel,
  extractModelGeometry,
  type LoadedModel,
} from '../src/render/models';
import { modelSourceFor, EntityRenderer } from '../src/render/entities';
import {
  buildProceduralModel,
  buildInfantryGear,
  buildHqAntenna,
  buildRadarDishProp,
  buildAwacsDome,
  buildShipMast,
  buildRunwayStrip,
  buildControlTower,
  buildCoolingTower,
  buildHospitalCross,
  buildSeaplaneFloats,
  buildMineRails,
  buildNavalMineSpikes,
  buildSignalMast,
} from '../src/render/proceduralModels';
import { applySurfaceTreatment } from '../src/render/entitySurfaces';
import type { PortraitPiece } from './portrait-atlas';

/** Absolute directory of game/public/models (resolved from this file). */
export const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');

/**
 * Patch THREE.TextureLoader.load so GLB external texture URIs resolve to
 * local files and decode via pngjs. Must run before any GLTFLoader parse.
 * The GLTFLoader calls load() with the resource-path-prefixed URI (a
 * file:// URL when the resource path is one); both file:// URLs and plain
 * relative paths are handled.
 */
export function installNodeTextureHook(): void {
  // GLTFLoader references the browser/worker global `self` (for
  // `self.URL`) — shim it to globalThis under Node.
  (globalThis as Record<string, unknown>)['self'] ??= globalThis;

  // Embedded GLB images reach TextureLoader as blob: URLs: GLTFLoader
  // wraps the bufferView bytes in `new Blob([bytes])` and mints an object
  // URL. Node's Blob.arrayBuffer() is async, so capture the constructor
  // parts synchronously via a Blob subclass and map the object URL back
  // to its bytes here.
  const blobBytes = new Map<string, Uint8Array>();
  const OrigBlob = globalThis.Blob;
  const blobParts = new WeakMap<Blob, unknown[]>();
  class SpyBlob extends OrigBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      blobParts.set(this, (parts ?? []) as unknown[]);
    }
  }
  (globalThis as Record<string, unknown>)['Blob'] = SpyBlob;
  const URL_ = globalThis.URL;
  const origCreateObjectURL = URL_.createObjectURL.bind(URL_);
  URL_.createObjectURL = (blob: Blob): string => {
    const url = origCreateObjectURL(blob as unknown as Parameters<typeof origCreateObjectURL>[0]);
    const chunks: Uint8Array[] = [];
    for (const p of blobParts.get(blob) ?? []) {
      if (p instanceof Uint8Array) chunks.push(p);
      else if (p instanceof ArrayBuffer) chunks.push(new Uint8Array(p));
      else if (typeof p === 'string') chunks.push(new TextEncoder().encode(p));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    blobBytes.set(url, out);
    return url;
  };
  const origRevokeObjectURL = URL_.revokeObjectURL.bind(URL_);
  URL_.revokeObjectURL = (url: string): void => {
    blobBytes.delete(url);
    origRevokeObjectURL(url);
  };

  const proto = THREE.TextureLoader.prototype as unknown as {
    load(
      url: string,
      onLoad?: (texture: THREE.Texture) => void,
      onProgress?: (event: unknown) => void,
      onError?: (err: unknown) => void,
    ): THREE.Texture;
  };
  proto.load = (url, onLoad, _onProgress, onError) => {
    const placeholder = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    try {
      let png: { data: Uint8Array; width: number; height: number };
      if (url.startsWith('blob:')) {
        const buf = blobBytes.get(url);
        if (!buf) throw new Error(`portrait-models: unknown blob URL ${url}`);
        // pngjs needs a Node Buffer (it calls readUInt32BE), not a bare
        // Uint8Array.
        png = PNG.sync.read(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
      } else {
        let local: string;
        if (url.startsWith('file://')) {
          local = fileURLToPath(url);
        } else {
          local = path.resolve(MODELS_DIR, url);
        }
        png = PNG.sync.read(readFileSync(local));
      }
      const data = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
      const tex = new THREE.DataTexture(data, png.width, png.height);
      tex.needsUpdate = true;
      // GLTFLoader assigns flipY = false to parsed GLB textures in the
      // browser path; set it here so the rasterizer samples identically.
      tex.flipY = false;
      if (onLoad) onLoad(tex);
      return tex;
    } catch (err) {
      if (onError) onError(err);
      return placeholder;
    }
  };
}

/**
 * Load + process one MODEL_PATHS key: the exact per-key steps of
 * `loadOneModel` (render/models.ts) minus fetch/timeout — rotY first,
 * normalize (center xz, base at y=0, uniform scale), yOffset, extract
 * merged per-material geometry, surface treatment. Throws on failure
 * (fail loud at build time — a broken model must not silently degrade
 * the atlas).
 */
export async function loadPortraitModel(
  loader: { parseAsync(data: ArrayBuffer, path: string): Promise<{ scene: THREE.Object3D }> },
  key: string,
): Promise<LoadedModel> {
  const spec = MODEL_PATHS[key];
  if (!spec) throw new Error(`loadPortraitModel: unknown model key ${key}`);
  const glbPath = path.join(MODELS_DIR, spec.path);
  const buf = readFileSync(glbPath);
  // buf is a Node Buffer (an ArrayBuffer-backed Uint8Array); slice out exactly
  // its view as a fresh ArrayBuffer for GLTFLoader.parseAsync.
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  // Resource path = the GLB's DIRECTORY (trailing slash), exactly like
  // loadOneModel — three string-concatenates it with texture URIs.
  const resourcePath = pathToFileURL(path.dirname(glbPath) + path.sep).href;
  const gltf = await loader.parseAsync(bytes, resourcePath);
  if (spec.rotY !== undefined && spec.rotY !== 0) {
    gltf.scene.rotateY(spec.rotY);
  }
  normalizeModel(gltf.scene, spec.scale);
  if (spec.yOffset !== undefined && spec.yOffset !== 0) {
    gltf.scene.position.y += spec.yOffset;
    gltf.scene.updateMatrixWorld(true);
  }
  const { geometries, materials } = await extractModelGeometry(gltf.scene);
  applySurfaceTreatment(key, geometries, materials);
  return { geometries, materials };
}

/** Load every model key in `keys` (sequentially — deterministic order). */
export async function loadPortraitModels(
  loader: { parseAsync(data: ArrayBuffer, path: string): Promise<{ scene: THREE.Object3D }> },
  keys: string[],
  onProgress?: (done: number, total: number, key: string) => void,
): Promise<Map<string, LoadedModel>> {
  const out = new Map<string, LoadedModel>();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    out.set(key, await loadPortraitModel(loader, key));
    if (onProgress) onProgress(i + 1, keys.length, key);
  }
  return out;
}

/**
 * The kind whose art `kind` resolves through — tech-level variants share
 * their base kind's art (mirrors the private artBaseKindFor in
 * render/entities.ts, which modelSourceFor uses).
 */
export function artKindFor(kind: string): string {
  const def = UNIT_DEFS[kind as UnitKind];
  return def ? variantArtBase(def.kind) : kind;
}

/** Every unit + building kind that needs a manifest entry (def order). */
export function allPortraitKinds(): string[] {
  return [...Object.keys(UNIT_DEFS), ...Object.keys(BUILDING_DEFS)];
}

/**
 * Build one attach prop's LoadedModel. Mirrors the private
 * EntityRenderer.propFor switch (render/entities.ts) — the specs come
 * from the public EntityRenderer.propSpecsFor(kind).
 */
function buildProp(key: string): LoadedModel {
  if (key === 'gear:rifles' || key === 'gear:engineer' || key === 'gear:sniper' || key === 'gear:medic') {
    return buildInfantryGear(key.slice('gear:'.length) as 'rifles' | 'engineer' | 'sniper' | 'medic');
  }
  if (key === 'hqAntenna') return buildHqAntenna();
  if (key === 'signalMast') return buildSignalMast();
  if (key === 'awacsDome') return buildAwacsDome();
  if (key === 'shipMast') return buildShipMast();
  if (key === 'runwayStrip') return buildRunwayStrip();
  if (key === 'controlTower') return buildControlTower();
  if (key === 'coolingTower') return buildCoolingTower();
  if (key === 'hospitalCross') return buildHospitalCross();
  if (key === 'seaplaneFloats') return buildSeaplaneFloats();
  if (key === 'mineRails') return buildMineRails();
  if (key === 'navalMineSpikes') return buildNavalMineSpikes();
  return buildRadarDishProp();
}

function pushModel(pieces: PortraitPiece[], model: LoadedModel, dx: number, dy: number, dz: number): void {
  for (let i = 0; i < model.geometries.length; i++) {
    const geometry = model.geometries[i];
    const material = model.materials[i] ?? model.materials[0];
    if (geometry === undefined || material === undefined) continue;
    pieces.push({ geometry, material, dx, dy, dz });
  }
}

/**
 * Compose the full visual for a kind: GLB pieces at their MODEL_SOURCES
 * offsets (or the procedural gap model), plus every attach prop the game
 * decorates the kind with. Throws when a kind cannot be composed — the
 * generator fails loud instead of shipping a silent gap.
 */
export function piecesForKind(kind: string, models: Map<string, LoadedModel>): PortraitPiece[] {
  const pieces: PortraitPiece[] = [];
  const artKind = artKindFor(kind);
  const source = modelSourceFor(kind);
  if (source.type === 'glb') {
    for (const piece of source.pieces) {
      const model = models.get(piece.key);
      if (!model) {
        throw new Error(`piecesForKind(${kind}): model key ${piece.key} not loaded`);
      }
      pushModel(pieces, model, piece.dx ?? 0, piece.dy ?? 0, piece.dz ?? 0);
    }
  } else if (source.type === 'procedural') {
    const model = buildProceduralModel(artKind);
    if (!model) {
      throw new Error(`piecesForKind(${kind}): no procedural builder for art kind ${artKind}`);
    }
    pushModel(pieces, model, 0, 0, 0);
  } else {
    throw new Error(`piecesForKind(${kind}): placeholder source — no art to render`);
  }
  for (const spec of EntityRenderer.propSpecsFor(kind)) {
    pushModel(pieces, buildProp(spec.prop), spec.dx, spec.dy, spec.dz);
  }
  if (pieces.length === 0) {
    throw new Error(`piecesForKind(${kind}): composed zero pieces`);
  }
  return pieces;
}

/**
 * The MODEL_PATHS keys the atlas needs: every piece key of every
 * glb-sourced kind (deduped, sorted for deterministic load order).
 */
export function portraitModelKeys(): string[] {
  const keys = new Set<string>();
  for (const kind of allPortraitKinds()) {
    const source = modelSourceFor(kind);
    if (source.type === 'glb') {
      for (const piece of source.pieces) keys.add(piece.key);
    }
  }
  return [...keys].sort();
}
