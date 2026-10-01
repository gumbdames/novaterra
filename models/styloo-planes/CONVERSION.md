# styloo "Tiny Plane Asset Pack" FBX → GLB conversion

Source: https://styloo.itch.io/plane (styloo, "Tiny Plane Asset Pack"),
**CC0 1.0 Universal** — the itch.io asset page's license metadata states
"Creative Commons Zero v1.0 Universal" (see `THIRD_PARTY_NOTICES.md`).
Downloaded 2026-09-30 (15 FBX files, `fbxtinyplanesbystyloo.zip`,
6,093,830 bytes).

> License-file note: the zip contains **no license file** — only `fbx/`
> with the 15 `.fbx` files. The CC0 statement lives on the itch.io page
> (asset-license metadata). The same files are mirrored on itch.io by
> ECGaming (https://ecgaming.itch.io/free-tiny-planes) also marked CC0.

## Converter

- **Tool:** Blender 4.2.17 LTS headless (portable tarball), Cycles CPU
- **Per-file command:** `blender --background --python convert.py` where the
  script runs
  `bpy.ops.import_scene.fbx(filepath=<src>)` then
  `bpy.ops.export_scene.gltf(filepath=<out>.glb, export_format='GLB',
  export_materials='EXPORT', export_yup=True, export_apply=True)`
  (no modifiers are applied beyond the import defaults).

## Texture note

The 15 FBX files reference an embedded 256×256 palette texture
(`ImphenziaPalette01-256-Gradient.png`, shipped inside the FBX media, part
of the same CC0 pack): the low-poly meshes carry `UVMap` UVs into this
palette instead of vertex colors. The GLBs embed the palette as
`baseColorTexture` (single `Material.001`, `TEXCOORD_0` present). Do **not**
overwrite `map` in the render treatments for these keys — the
`STYLOO_CIVIL` / `STYLOO_MIL` treatments only adjust roughness/metalness so
the authored liveries survive (see `game/src/render/entitySurfaces.ts`).

## Source → output mapping

| Output GLB | Source FBX | Depicts (distinct type) | Tris | Size |
|---|---|---|---|---|
| `planehuge.glb` | planehuge.fbx | Large swept-wing airliner | 20,916 | 771 KiB |
| `planesty.glb` | planesty.fbx | Small stylized prop plane (purple/orange) | 16,108 | 408 KiB |
| `planesty_001.glb` | planesty_001.fbx | Same type, alternate livery | 18,472 | 464 KiB |
| `planesty_002.glb` | planesty_002.fbx | Same type, alternate livery | 16,108 | 415 KiB |
| `planesty_003.glb` | planesty_003.fbx | Same type, alternate livery | 16,108 | 416 KiB |
| `planeazer.glb` | planeazer.fbx | Red high-wing prop plane | 17,580 | 457 KiB |
| `planeazer_001.glb` | planeazer_001.fbx | Same type, alternate livery | 17,580 | 454 KiB |
| `planeazer_002.glb` | planeazer_002.fbx | Same type, alternate livery | 17,580 | 458 KiB |
| `plancestylized.glb` | plancestylized.fbx | WWII-fighter-style prop (green/red) | 16,704 | 461 KiB |
| `plancestylized_001.glb` | plancestylized_001.fbx | Same type, alternate livery | 16,704 | 461 KiB |
| `planeanimal.glb` | planeanimal.fbx | Dark-gray stealth flying wing | 6,716 | 158 KiB |
| `planeanimal_001.glb` | planeanimal_001.fbx | Same type, alternate livery | 9,696 | 229 KiB |
| `planestylized_001.glb` | planestylized_001.fbx | Spare — same type as plancestylized, unmapped | 16,704 | 461 KiB |
| `planehelice.glb` | planehelice.fbx | Spare — stylized helicopter, unmapped | 13,904 | 352 KiB |
| `planehelice_001.glb` | planehelice_001.fbx | Spare — stylized helicopter, unmapped | 17,232 | 432 KiB |

6 distinct types across the 15 files (the `_001`/`_002`/`_003` variants are
livery/geometry variants of the same type). The two `planehelice`
helicopters and `planestylized_001` are vendored as spares — they are not
referenced by any `MODEL_PATHS` key (the helicopter roles went procedural
per the Phase 5 art direction).

## Orientation

Top-view renders of all 6 types show the nose at authored **−X** (z-up
Blender space; the glTF exporter converts to y-up, nose stays −X). Every
`MODEL_PATHS` key for these models uses `rotY: Math.PI / 2` so the nose
faces game-forward **+Z**, matching the normalizeModel convention.

## Verification

- All 15 files have valid GLB magic bytes (`glTF`), version 2, non-trivial
  sizes, and parseable JSON chunks with real mesh/primitive data and the
  embedded palette texture.
- Authored bounding boxes measured in Blender (post `export_yup`, glTF
  y-up — x = length, y = height, z = wingspan):
  planehuge 34.24×5.60×20.85 · planesty 8.29×1.82×7.29 ·
  planeazer 8.30×2.02×5.42 · plancestylized 4.38×2.43×4.43 ·
  planeanimal 6.19×1.52×6.89 · planehelice 7.96×1.92×11.43 (rotor span).
  Per-key scales in `game/src/render/models.ts` are fit-to-hull from these
  measurements.
- The per-variant livery differences were confirmed visually in the
  Cycles thumbnails (`/tmp/styloo/thumbs/`, not shipped).

Intermediate FBX files were kept out of the repo (scratch in /tmp); the
GLBs above are the shipped artifacts.
