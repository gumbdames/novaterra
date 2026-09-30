#!/usr/bin/env node
// NOVATERRA entity-texture audit: parse GLB binary headers, extract the glTF
// JSON chunk, and report per file: UV presence (TEXCOORD_0), vertex colors
// (COLOR_0), material texture references (baseColorTexture, metallicRoughness,
// normal/occlusion/emissive), and whether images are embedded (bufferView) vs
// external (URI). No three.js needed — pure Node binary parsing.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MODELS_DIR = new URL('../game/public/models/', import.meta.url);
const MODELS_PATH = decodeURIComponent(MODELS_DIR.pathname);

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  return json;
}

function auditFile(relPath) {
  const abs = join(MODELS_PATH, relPath);
  const buf = readFileSync(abs);
  let json;
  try { json = parseGlb(buf); } catch (e) { return { file: relPath, error: String(e.message || e) }; }

  const prims = [];
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      prims.push({
        material: p.material ?? -1,
        uv: !!(p.attributes && 'TEXCOORD_0' in p.attributes),
        color0: !!(p.attributes && 'COLOR_0' in p.attributes),
        hasIndex: !!p.indices,
      });
    }
  }
  const nUv = prims.filter(p => p.uv).length;
  const nCol = prims.filter(p => p.color0).length;

  const texRefs = new Map(); // texture index -> usage
  const mats = (json.materials ?? []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const info = { index: i, name: m.name ?? '', baseColorFactor: pbr.baseColorFactor ?? null,
      metallicFactor: pbr.metallicFactor, roughnessFactor: pbr.roughnessFactor, textured: [] };
    const add = (texInfo, kind) => {
      if (texInfo) { info.textured.push(kind); const ti = texInfo.index; texRefs.set(ti, (texRefs.get(ti) ?? []).concat(kind)); }
    };
    add(pbr.baseColorTexture, 'baseColor');
    add(pbr.metallicRoughnessTexture, 'metalRough');
    add(m.normalTexture, 'normal');
    add(m.occlusionTexture, 'occlusion');
    add(m.emissiveTexture, 'emissive');
    return info;
  });

  const images = (json.images ?? []).map((im, i) => ({
    index: i, name: im.name ?? '',
    embedded: im.bufferView !== undefined,
    uri: im.uri ?? null,
    mimeType: im.mimeType ?? null,
  }));
  const textureUsages = {};
  for (const [ti, kinds] of texRefs) textureUsages[ti] = kinds;

  return {
    file: relPath,
    sizeKiB: +(statSync(abs).size / 1024).toFixed(1),
    meshes: (json.meshes ?? []).length,
    primitives: prims.length,
    primsWithUv: nUv,
    primsWithColor0: nCol,
    uvCoverage: prims.length ? `${nUv}/${prims.length}` : 'n/a',
    colorCoverage: prims.length ? `${nCol}/${prims.length}` : 'n/a',
    materials: mats.length,
    materialDetail: mats,
    texturedMaterials: mats.filter(m => m.textured.length > 0).length,
    images,
    textureUsages,
    imagesTotal: images.length,
    embeddedImages: images.filter(i => i.embedded).length,
    externalImages: images.filter(i => !i.embedded).length,
    // resolve external image URIs relative to the GLB dir
    externalResolved: images.filter(i => !i.embedded).map(i => {
      const p = join(dirname(abs), i.uri ?? '');
      return { uri: i.uri, onDisk: existsSync(p) };
    }),
  };
}

// Gather the set of mapped files from models.ts MODEL_PATHS (parse paths).
const modelsTs = readFileSync(new URL('../game/src/render/models.ts', import.meta.url), 'utf8');
const pathRe = /path:\s*'([^']+)'/g;
const mappedPaths = new Set();
let m;
while ((m = pathRe.exec(modelsTs)) !== null) mappedPaths.add(m[1]);

const results = [];
for (const p of [...mappedPaths].sort()) {
  try { results.push(auditFile(p)); } catch (e) { results.push({ file: p, error: String(e.message || e) }); }
}

process.stdout.write(JSON.stringify({ generated: new Date().toISOString(), count: results.length, results }, null, 1));

// Also verify all Texture colormap.png files exist.
for (const d of readdirSync(MODELS_PATH, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
  const t = join(MODELS_PATH, d, 'Textures', 'colormap.png');
  if (existsSync(t)) console.error(`[disk] ${d}/Textures/colormap.png exists (${(statSync(t).size / 1024).toFixed(0)} KiB)`);
}
