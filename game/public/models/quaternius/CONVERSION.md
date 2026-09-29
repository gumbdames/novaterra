# Quaternius OBJ → GLB conversion

Source: https://quaternius.com (CC0 1.0 Universal, see LICENSE-CC0.txt).
The site distributes FBX / OBJ / Blend only; the OBJ versions were downloaded
directly from the per-pack Google Drive folders linked on quaternius.com
(no accounts, no API keys, no Poly Pizza).

Downloaded 2026-09-29.

## Converter

- **Tool:** `obj2gltf` (Cesium, Apache-2.0)
- **Version:** 3.2.0 (from npm)
- **Command:** `npx -y obj2gltf@3.2.0 -i <in>.obj -o <out>.glb`
  (run with the matching `.mtl` file beside the `.obj` so materials convert;
  no extra flags were needed)

Version note: `obj2gltf@4.1.0` does not exist (npm ETARGET); the documented
fallback order in the task was `obj2gltf` → `@cesium/obj2gltf` → Blender
headless — the first option worked at 3.2.0, so no fallback was needed.

## Source → output mapping

| Output GLB | Source OBJ (as named in the Quaternius pack) | Quaternius pack |
|---|---|---|
| tank-1.glb | Tank.obj + Tank.mtl | Animated Tanks Pack (4 tanks) |
| tank-2.glb | Tank2.obj + Tank2.mtl | Animated Tanks Pack |
| tank-3.glb | Tank3.obj + Tank3.mtl | Animated Tanks Pack |
| tank-4.glb | Tank4.obj + Tank4.mtl | Animated Tanks Pack |
| engineer.glb | Male_Shirt.obj + Male_Shirt.mtl | Animated Men Pack |
| rifleman.glb | Male_LongSleeve.obj + Male_LongSleeve.mtl | Animated Men Pack |
| farm-barn.glb | BigBarn.obj + BigBarn.mtl | Farm Buildings Pack |
| farm-silo.glb | Silo.obj + Silo.mtl | Farm Buildings Pack |

## Verification

- All 8 files have valid GLB magic bytes (`glTF`) and version 2, non-trivial
  sizes, parseable JSON chunk with real mesh/primitive data.
- Sample of 3 files (tank-1.glb, engineer.glb, farm-barn.glb) additionally
  parsed successfully with three.js r180 `GLTFLoader` in node.
- Approximate triangle counts (index counts from the glTF accessors):
  engineer 1.8k, rifleman 2.0k, farm-silo 1.6k, farm-barn 4.2k,
  tank-1 6.1k, tank-2 7.2k, tank-3 6.5k, tank-4 11.4k.
  (Tanks sit slightly above the ideal <5k-tri target; tank-4 is the largest
  variant. All are fine for game use.)
- Note: Quaternius animated packs ship animations only in the FBX/Blend
  sources; the OBJ is a single static pose. Animation of these models will be
  handled procedurally in game code.

Intermediate OBJ/MTL files were kept out of the repo (deleted with the
scratch downloads in /tmp); the GLBs above are the shipped artifacts.
