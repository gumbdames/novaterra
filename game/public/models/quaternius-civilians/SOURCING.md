# Quaternius civilian pedestrians — sourcing & preparation

Source: Quaternius (https://quaternius.com), **CC0 1.0 Universal** (see
LICENSE-CC0.txt). Quaternius's own site declares all of their assets CC0;
each poly.pizza model page below also lists "Creative Commons Attribution"
and "Public Domain (CC0)".

Downloaded 2026-09-30. Note: quaternius.com distributes its packs via
per-pack Google Drive folders, which are off-limits for this project (the
user declined Drive access), and the itch.io project page for the animated
character packs exposes no direct download. The same author's CC0 models
are mirrored on **poly.pizza** with direct `https://static.poly.pizza/…`
CDN downloads (no accounts, no API keys, no Drive), which is what was used.

## Source → output mapping

| Output GLB | poly.pizza model page | poly.pizza title |
|---|---|---|
| civilian-man.glb | https://poly.pizza/m/fjHyMd5Wxw | Man — by Quaternius |
| civilian-woman.glb | https://poly.pizza/m/jpKRgGDxhk | Woman Casual — by Quaternius |
| civilian-worker.glb | https://poly.pizza/m/E8079Ahx7k | Worker — by Quaternius (Ultimate Modular Women Pack bundle) |
| civilian-woman-2.glb | https://poly.pizza/m/nIItLV9nxS | Animated Woman — by Quaternius (Ultimate Modular Women Pack bundle) |

Direct CDN URLs at download time (for the record; the GLBs below are the
vendored copies):

- `https://static.poly.pizza/985eacbf-9dde-44b7-9270-4e35c8400b13.glb` (Man)
- `https://static.poly.pizza/51d5abdd-bb87-4b8d-9967-21738ffb8437.glb` (Woman Casual)
- `https://static.poly.pizza/c0253218-85f2-4d67-b3f2-a4611a7901fe.glb` (Worker)
- `https://static.poly.pizza/46d6db5a-3c9f-4238-8cdf-8eb7194498dc.glb` (Animated Woman)

## Preparation (why the vendored GLBs differ from the downloads)

The poly.pizza GLBs are **rigged** (SkinnedMesh) with the skeleton posed
away from bind pose, and carry 11–24 embedded animation tracks each
(~40% of every file). NOVATERRA renders pedestrians as
`THREE.InstancedMesh` (no skinning support) and animates the walk
procedurally in game code, so both the rig and the animations are dead
weight — and using the raw vertex positions without the skin would render
the wrong pose (a wide bind stance instead of the relaxed standing pose).

Each model was therefore run through a two-stage offline transform
(scripts kept with the agent's working notes, not vendored):

1. **Bake the skinning** (`bake-pedestrians.mjs`, three.js): applies the
   exact three.js skinning math (`bindMatrix → boneMatrices →
   bindMatrixInverse`, same formula as the skinning vertex-shader chunk)
   to positions and normals, replaces every SkinnedMesh with a static
   Mesh, and drops `skinIndex`/`skinWeight`/`uv` attributes (the materials
   are untextured flat PBR colors, so UVs are dead weight).
2. **Re-export** via three.js `GLTFExporter` (binary). No geometry or
   material was otherwise altered.

Verification (three.js GLTFLoader, 2026-09-30): triangle counts identical
to the downloads (1854 / 2776 / 6112 / 6108), world-space bounding boxes
identical to the originals' rendered pose (e.g. 1.43×4.84×0.82 for the
man), zero skinned meshes remain. Sizes: 130 KB + 178 KB + 371 KB +
367 KB ≈ **1.05 MB total** (downloads were ≈ 4.0 MB).

## Runtime use

The four models are **lazy-loaded** (see `MODEL_PATHS` keys
`personCasualMan`, `personCasualWoman`, `personWorker`,
`personWomanTwo`): they are NOT part of the boot set, so the 8 MiB
startup gate is unaffected. `render/people.ts` bakes each variant's
per-material parts into a single vertex-colored geometry (one
InstancedMesh per variant — 4 draw calls max) and `render/cityLife.ts`
upgrades pedestrians from capsules once the models arrive. If loading
fails, pedestrians stay capsules — the game never depends on these files.
