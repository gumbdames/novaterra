# NOVATERRA entity texture audit (0.1 Alpha)

**Date:** 2026-09-30 · **Scope:** `main` · **Author:** texture-audit worker

Answers exactly what we're working with so the texturing integration assigns
the right surface treatment to every model. Audited files:
- `game/public/models/` (55 unique mapped GLBs)
- `game/src/render/models.ts` (the mapping)
- `game/src/render/entities.ts` (material handling, team colors)
- `game/src/render/proceduralModels.ts` (procedural shading)
- `game/src/render/nature.ts`, `game/src/render/natureTrees.ts` (props)

## 1. Methodology

GLTFLoader does not run headless cleanly, so the audit parses the GLB
binary directly. `tools/audit-glb-textures.mjs` (new, kept in repo) reads
the 12-byte GLB header, extracts the JSON chunk, and for every mapped file
inspects:

- `meshes[].primitives[].attributes` → `TEXCOORD_0` (UVs?) and `COLOR_0`
  (vertex colors?)
- `materials[]` → `pbrMetallicRoughness` (baseColorTexture,
  metallicRoughnessTexture, factors), normal/occlusion/emissive textures
- `images[]`/`textures[]` → embedded (`bufferView`) vs external (`uri`);
  every external URI is resolved relative to its GLB and checked on disk

The mapped-file set comes from parsing `path:` entries out of
`MODEL_PATHS` in `models.ts` — 58 keys → **55 unique files** (rifleman.glb
is keyed 3×, building-e.glb 2×; industrialStack/industrialTank are shared
pieces). Raw JSON: `/tmp/glb-audit.json` (ephemeral; re-run the script to
regenerate).

## 2. Headline numbers (mapped set)

| Class | Files | Keys | Description |
|---|---|---|---|
| Textured (colormap) | 33 | 34 | 100% UV coverage, 1 baseColor texture each (external shared `Textures/colormap.png`), no other maps, metal=0 / rough≈1 |
| UV'd but untextured | 16 | 16 | 100% UV coverage, zero images, flat named PBR materials |
| No UVs at all | 6 | 8 | POSITION+NORMAL only — no TEXCOORD_0, no COLOR_0, no textures |

- **Vertex colors (COLOR_0): 0 mapped files.** The MANIFEST's
  "vertex-colored" claim is wrong for the mapped set — color lives in
  named flat materials (baseColorFactor), not vertex attributes.
- Metallic/roughness maps, normal maps, occlusion, emissive maps: **none
  anywhere** in the mapped set.
- All 33 external image references resolve on disk (`Textures/colormap.png`
  exists in every pack that needs one; see §3).
- Partial-UV-coverage files: **none** — every file is all-or-nothing on UVs.

Per-kit findings (§3) and the full key→entity→category table (§5).

## 3. Per-kit findings

### 3.1 Kenney colormap-textured packs (33 files, 34 keys)

Packs: kenney-car (2), kenney-commercial (7), kenney-factory (3),
kenney-industrial (11), kenney-suburban (2), kenney-watercraft (5).
Manifest sizes: 9–12 KiB PNGs per pack.

- Every primitive has TEXCOORD_0; UVs index into the pack's shared
  `Textures/colormap.png` (a small flat-color palette atlas, per Kenney's
  kit convention). All 33 references resolve to a real PNG on disk.
- Materials are named `colormap`, or `colormap` + `colormap-specular`
  (kenney-industrial buildings, solar panels). **Despite the name,
  `colormap-specular` carries NO specular/metal/roughness data** — it is a
  plain baseColor texture reference, visually identical in treatment to
  `colormap`. metallicFactor=0 explicitly everywhere; roughnessFactor unset
  (→ 1.0). **Everything in this class is matte today.**
- Only one image per file, always external, never embedded.

Texturing implications: these are the *easiest* wins. The colormap atlas is
flat colors, so a higher-detail replacement atlas (grime, panel lines,
window strips) maps 1:1 onto existing UVs. Per-pack atlases already exist,
so each kit can be tuned independently. But note the atlas is *shared
within a pack* — editing `kenney-commercial/Textures/colormap.png`
changes the shop, market, lab, apartment, university, hospital, and
aegisMain all at once.

### 3.2 Kenney space kit (5 files, 5 keys) — UVs, no textures

Files: `craft_racer` (spectre), `craft_cargoA` (awacs),
`hangar_largeA` / `hangar_smallA` (airfield), `satelliteDish_large`
(radarStation).

- 100% UV coverage, but **zero images** and **no `Textures/colormap.png`
  on disk for kenney-space at all** (confirmed missing — the only pack of
  the seven without one).
- Materials are named flat PBR: `metal`, `metalDark`, `dark`, `metalRed`
  with **metallicFactor=1, roughnessFactor=1** — i.e. fully metallic but
  with no env map, which renders these as dark/gray (metal with nothing
  to reflect is just dark). These models will look *better* the moment
  they get either a real metalness map + env lighting or saner factors.
- The UVs are authored (probably for Kenney's space-kit texture that was
  never converted into these GLBs) — they are usable as-is for a new
  applied texture, but their layout is unverified; a triplanar/procedural
  treatment may be safer than trusting them blindly.

### 3.3 Quaternius (6 files, 8 keys) — NO UVs, NO vertex colors, NO textures

Files: `engineer`, `rifleman` (×3 keys), `tank-1` (tankDestroyer), `tank-2`
(tank), `farm-barn`, `farm-silo`.

- Primitives carry **only POSITION+NORMAL**. No TEXCOORD_0, no COLOR_0, no
  images — the strongest possible constraint in the mapped set.
- Color comes entirely from **named flat materials** (metallicFactor=0,
  roughnessFactor≈0.904), with semantically useful names:
  - infantry: `Skin`, `Eyes`, `Hair`, `Shirt`, `Shirt2`, `Pants`,
    `Socks`, `Shoes`
  - tanks: `Main`, `Main_Dark`, `Main_Light`, `Main_Details`, `Wheels`
    (tank-2 is tan/desert; tank-1 is green)
  - barn/silo: `DarkRed`, `LightRed`, `White`, `RoofBlack`, `Brown`, `Grey`
- **You cannot apply a 2D texture to these without generating UVs first.**
  Options: (a) leave them flat — they're authored as flat low-poly and
  already match the art direction; (b) generate box-projected UVs at load
  time keyed off material name (e.g. fabric weave on `Shirt`, tread on
  `Wheels`); (c) vertex-color detail via a bake step. Any UV generation
  must happen *before* `extractModelGeometry` merges per-material buckets
  (models.ts), and on **every** primitive piece, or `mergeGeometries`
  fails its attribute-consistency check (it returns null → the loader
  keeps pieces unmerged; not fatal, but wasteful).
- baseColorFactor values are in **linear space** — any generated texture
  must be flagged sRGB or colors will shift.
- Note: `tank-3.glb` / `tank-4.glb` exist in the pack but are unmapped.

### 3.4 Kenney nature props (11 files, 11 keys) — UVs, no textures

Files: 6 trees, 3 rocks, 2 bushes.

- 100% UV coverage, zero images, flat named materials: `woodBark`,
  `woodBarkDark`, `leafsGreen`, `leafsDark`, `dirt`, `grass`
  (metallicFactor=1, roughnessFactor=1 — again fully metallic flat color).
- **The six tree GLBs are a silent fallback only**: `ui/game.ts`
  `loadEntityModels` overlays the procedural textured trees from
  `render/natureTrees.ts` (real Quaternius bark/leaf CC0 textures,
  ~0.83 MiB) onto the same `propTree*` keys whenever the texture fetch
  succeeds. The Kenney trees render only if that fetch fails.
- Rocks/bushes render as Kenney GLBs in all cases. Their UVs are usable
  for a bark/rock/leaf texture, or they can stay flat — they're tiny at
  RTS distance.

### 3.5 The 942-file inventory

Only 55 of 942 GLBs are mapped. The unmapped remainder (kenney-nature's
330 files, kenney-roads' 97, etc.) is spare CC0 inventory if the
integration needs alternates. The five CC0 tree textures already in use
live at `game/public/models/quaternius-nature/textures/`
(`tree_bark.jpg`, `birch_bark.png`, `tree_leaves.png`,
`birch_leaves_green.png`, `pine_leaves.png`) — the established pattern
for adding new textures is a `textures/` dir under the pack.

## 4. How materials work today (file:line)

### 4.1 GLB materials — kept as-is, cloned per load

- `models.ts` `extractModelGeometry` (~line 415): traverses the loaded
  scene, bakes `matrixWorld` into geometry, buckets pieces by material,
  merges each bucket with `mergeGeometries`, and returns **cloned**
  materials 1:1 with the merged geometries (`materials.push(material.clone())`).
- `entities.ts` `addModelMeshes` (~line 943): builds one `THREE.Mesh` per
  geometry/material pair, using the shared material directly. **No tinting,
  no material replacement** — GLB models render with authored colors.
- Sharing: geometry AND materials are shared across all views of a kind
  (entities.ts:30-34). Per-view objects own only health-bar sprites, the
  team pennant material, and construction-fade clones.

### 4.2 Construction fade — texture-safe

`entities.ts` `updateBuildingConstruction` (~line 1346): while
`progress < 1`, each mesh's material is swapped for `shared.clone()` with
`transparent=true, opacity=0.55`; on completion the clones are disposed
and the shared materials restored. `Material.clone()` **shares the
texture reference** (it does not clone the GPU texture), so adding maps to
shared materials is fully compatible with the fade — the only cost is
that a faded building keeps its map bound, which is correct behavior.

### 4.3 Procedural gap models — flat-shaded standard materials

`proceduralModels.ts` `pmat()` (lines 55–68): `MeshStandardMaterial`
with `flatShading: true`, `roughness: 0.7` (default), `metalness: 0.25`
(default), solid `color`, optional emissive. `ModelBuilder` merges per
material exactly like the GLB path. 17 kinds: artillery, aa, fighter,
transport, drone, destroyer, mediaCenter, stormArray, apc, mlrs,
fighterBomber, attackHeli, submarine, frigate, carrier, quarry, monument —
plus attach props (infantry gear, HQ antenna, radar dish, AWACS rotodome,
ship mast, runway strip, cooling tower, hospital cross).

Note: three.js primitive geometries *do* carry generated UVs, so
procedural models are texture-capable (their materials just have no maps
today). `flatShading` + a texture is fine — normals are per-face, UVs
per-vertex; no conflict.

### 4.4 Placeholders, roads, water, terrain

- Placeholders (entities.ts ~1075, ~1097): `MeshStandardMaterial`, solid
  `color` (`hullColorFor` / `buildingColorFor`), roughness 0.55,
  metalness 0.35. Render only when GLB *and* procedural both fail.
- Roads (entities.ts ~616): `roadAsphaltMat` / `roadDashMat` —
  MeshStandardMaterial with solid `ROAD_ASPHALT_COLOR` /
  `ROAD_DASH_COLOR`. Pure geometry ribbons (`render/roads.ts`); no UVs
  needed unless we want asphalt detail.
- Water: render-side plane in `render/terrain.ts` (animated bob; level is
  sim data). Terrain chunks use one shared vertex-colored
  `MeshStandardMaterial` — no textures in Phase 1 by design
  (render/AGENTS.md).

### 4.5 Team colors — the hard constraint

Team identity is **never baked into model materials** (entities.ts:232-236,
1119-1145):

- Models keep authored colors. Each unit/building view adds a **thin
  emissive team stripe above the model** (shared geometry; material per
  team color via `stripeMatFor` — `MeshStandardMaterial` with
  color+emissive = team color, emissiveIntensity 0.7) and a **tiny glowing
  team pennant** (per-view material, emissiveIntensity 1.2).
- Colors: human blue, rival red — blue vs **orange** in colorblind mode
  (reads `document.documentElement.classList('colorblind')` at view
  creation).

**Texturing constraints from this:**
1. Never tint model materials toward a team color — the stripe+pennant are
   the *only* team-color carriers. A texture that makes e.g. all tanks
   reddish would read as "enemy" regardless of owner.
2. Keep textures' emissive contribution at ~0. An emissive-heavy texture
   would visually compete with the stripe/pennant glow.
3. The stripe sits *above* the model, so roof textures just need to not
   clash with blue/red/orange glow — avoid strong saturated
   blue/red/orange on top surfaces where cheap.

## 5. Key → entity → surface-category table

Categories are the integration worker's assignment vocabulary. `source`
is the per-key source from `modelSourceFor` (entities.ts:122-214):
`glb-tex` (colormap textured), `glb-flat` (UVs, no texture), `glb-nouv`
(no UVs), `proc` (procedural builder).

### 5.1 Units — GLB-mapped (15 keys)

| Key | Entity | GLB file | Class | Proposed category |
|---|---|---|---|---|
| engineer | engineer (infantry) | quaternius/engineer.glb | glb-nouv | **fabric** (uniform/shirt/pants; skin/eyes keep flat) |
| rifles | rifles (infantry) | quaternius/rifleman.glb | glb-nouv | **fabric** |
| sniperTeam | sniperTeam (infantry) | quaternius/rifleman.glb | glb-nouv | **fabric** — consider **camo** tint variant to distinguish from rifles |
| combatMedic | combatMedic (infantry) | quaternius/rifleman.glb | glb-nouv | **fabric** — white/red-cross accent is on the attached prop (`buildInfantryGear`), not the GLB |
| tank | tank (MBT) | quaternius/tank-2.glb | glb-nouv | **camo** (desert-tan Main_* materials) / **darkMetal** for Wheels+Main_Details |
| tankDestroyer | tankDestroyer | quaternius/tank-1.glb | glb-nouv | **camo** (green Main_* materials) / **darkMetal** for Wheels+Main_Details |
| hauler | hauler (truck) | kenney-car/truck.glb | glb-tex | **paintedMetal** (cab/chassis via colormap) / **rubber** (tires — same atlas, needs atlas edit or second material) |
| hq | hq (command truck) | kenney-car/truck-flat.glb | glb-tex | **paintedMetal** |
| spectre | spectre (gunship) | kenney-space/craft_racer.glb | glb-flat | **paintedMetal** (aircraft) — fix metal=1/rough=1 → ~0.35/0.45; `metalRed` accent keep |
| awacs | awacs (recon plane) | kenney-space/craft_cargoA.glb | glb-flat | **paintedMetal** (aircraft) |
| patrolBoat | patrolBoat | kenney-watercraft/boat-speed-a.glb | glb-tex | **hullPaint** (above waterline) |
| missileBoat | missileBoat | kenney-watercraft/boat-speed-d.glb | glb-tex | **hullPaint** |
| fishingBoat | fishingBoat | kenney-watercraft/boat-fishing-small.glb | glb-tex | **hullPaint** + **wood** (deck/cabin accents via atlas) |
| transportShip | transportShip (cargo) | kenney-watercraft/ship-cargo-a.glb | glb-tex | **hullPaint** + **rustMetal** (hull weathering) |
| commandShip | commandShip | kenney-watercraft/ship-cargo-b.glb | glb-tex | **hullPaint** + **rustMetal** |

### 5.2 Units — procedural (13 kinds, `proceduralModels.ts`)

All `proc`; all currently flat `pmat()` — texture application is optional
polish, UVs exist on the primitive geos.

| Kind | Builder | Proposed category |
|---|---|---|
| artillery | buildArtillery | **paintedMetal** (gun) / **rubber** (wheels) |
| aa | buildAA | **paintedMetal** (missile truck) |
| fighter | buildFighter | **paintedMetal** (jet) + **glass** (canopy) |
| fighterBomber | buildFighterBomber | **paintedMetal** + **glass** (canopy) |
| transport | buildTransport (heli) | **paintedMetal** + **glass** (cockpit) |
| attackHeli | buildAttackHeli | **camo** or **paintedMetal** + **glass** |
| drone | buildDrone | **darkMetal** / **plastic** |
| apc | buildAPC | **camo** / **paintedMetal** |
| mlrs | buildMLRS | **paintedMetal** (launch tubes **darkMetal**) |
| destroyer | buildDestroyer | **hullPaint** |
| frigate | buildFrigate | **hullPaint** |
| submarine | buildSubmarine | **hullPaint** (dark, low-roughness) |
| carrier | buildCarrier | **hullPaint** + **darkMetal** (deck) |

### 5.3 Buildings — GLB-mapped (35 keys → 24 kinds)

| Key | Entity kind | GLB file | Class | Proposed category |
|---|---|---|---|---|
| house | house | kenney-suburban/building-type-f.glb | glb-tex | **brick** + **roofTile** (suburban house) |
| apartment | apartment | kenney-commercial/building-g.glb | glb-tex | **concrete** + **glass** (curtain-wall strips via atlas) |
| shop | shop | kenney-commercial/building-a.glb | glb-tex | **concrete** + **glass** (storefront) |
| lab | lab | kenney-commercial/building-i.glb | glb-tex | **concrete** + **glass** |
| hospital | hospital | kenney-commercial/building-d.glb | glb-tex | **concrete** + **glass** (white/clean variant; red-cross prop is separate) |
| university | university | kenney-commercial/building-f.glb | glb-tex | **concrete** + **glass** |
| market | market | kenney-commercial/building-b.glb | glb-tex | **concrete** + **glass** (awning color via atlas) |
| aegisMain | aegisControl | kenney-commercial/building-k.glb | glb-tex | **concrete** + **glass** (+ procedural radar dish prop) |
| school | school | kenney-suburban/building-type-h.glb | glb-tex | **brick** + **roofTile** |
| factory | factory | kenney-industrial/building-e.glb | glb-tex | **corrugatedMetal** / **paintedMetal** |
| powerPlantMain | powerPlant | kenney-industrial/building-e.glb | glb-tex | **concrete** (industrial) |
| powerPlantChimney | powerPlant | kenney-industrial/chimney-large.glb | glb-tex | **concrete** (chimney banding via atlas) |
| waterPump | waterPump | kenney-industrial/water-tower.glb | glb-tex | **paintedMetal** (tank) |
| shipyardCrane | shipyard | kenney-factory/crane.glb | glb-tex | **paintedMetal** (safety-yellow via atlas) |
| shipyardMachine | shipyard | kenney-factory/machine.glb | glb-tex | **darkMetal** |
| navalYardCrane | navalYard | kenney-factory/crane-lift.glb | glb-tex | **paintedMetal** (safety-yellow via atlas) |
| navalYardHall | navalYard | kenney-industrial/building-k.glb | glb-tex | **corrugatedMetal** |
| barracks | barracks | kenney-industrial/building-d.glb | glb-tex | **concrete** — or **camo** paint to read military |
| warFactoryMain | warFactory | kenney-industrial/building-a.glb | glb-tex | **corrugatedMetal** / **darkMetal** |
| industrialStack | warFactory, oilRefinery (shared) | kenney-industrial/chimney-medium.glb | glb-tex | **concrete** |
| recyclingCenter | recyclingCenter | kenney-industrial/building-i.glb | glb-tex | **corrugatedMetal** |
| oilRefineryTank | oilRefinery | kenney-industrial/detail-tank-large.glb | glb-tex | **paintedMetal** + **rustMetal** (weathering) |
| industrialTank | oilRefinery, desalination (shared) | kenney-industrial/detail-tank.glb | glb-tex | **paintedMetal** + **rustMetal** |
| desalinationHall | desalination | kenney-industrial/building-s.glb | glb-tex | **concrete** |
| nuclearPlantMain | nuclearPlant | kenney-industrial/building-f.glb | glb-tex | **concrete** (+ procedural cooling tower prop) |
| solarFarmA / solarFarmB | solarFarm | kenney-industrial/solar-panel-*-group.glb | glb-tex | **glass** (PV panels — low rough, dark blue; the key visual payoff) |
| farmBarn | farm | quaternius/farm-barn.glb | glb-nouv | **wood** (barn red — flat color carries it; UV-gen optional) |
| farmSilo | farm | quaternius/farm-silo.glb | glb-nouv | **paintedMetal** (galvanized) |
| radarStation | radarStation | kenney-space/satelliteDish_large.glb | glb-flat | **paintedMetal** — fix metal=1/rough=1 → ~0.6/0.4 |
| airfieldHangar | airfield | kenney-space/hangar_largeA.glb | glb-flat | **corrugatedMetal** — fix metal/rough |
| airfieldHangar2 | airfield | kenney-space/hangar_smallA.glb | glb-flat | **corrugatedMetal** — fix metal/rough |

### 5.4 Buildings — procedural (4 kinds)

| Kind | Builder | Proposed category |
|---|---|---|
| mediaCenter | buildMediaCenter (lattice tower) | **darkMetal** + emissive beacon (already emissive in builder) |
| stormArray | buildStormArray (dish) | **paintedMetal** + **glass** |
| quarry | buildQuarry (rock face) | **rock** |
| monument | buildMonument (obelisk) | **stone** / **marble** |

### 5.5 Nature props (11 keys — render-only scatter, `render/nature.ts`)

| Key | GLB | Class | Proposed category |
|---|---|---|---|
| propTreeOak, propTreeBirch, propTreePineTall, propTreePine, propTreeOldOak, propTreePoplar | kenney-nature/tree_*.glb | glb-flat | **bark** + **leaf** — fallback only; the live trees are the textured procedural ones (`natureTrees.ts`); keep fallback minimal |
| propRockLarge, propRockTall, propRockSmall | kenney-nature/rock_*.glb | glb-flat | **rock** |
| propBushDetailed, propBushLarge | kenney-nature/plant_*.glb | glb-flat | **leaf** |

## 6. Surprises and blockers

1. **Quaternius = the hard blocker class** (6 files, 8 keys — all
   infantry, both tanks, farm). No UVs, no vertex colors, no textures:
   2D texturing is impossible without generating UVs. The flat named
   materials already look intentional (they're authored low-poly flat),
   so "leave flat, fix nothing" is a legitimate integration outcome for
   this class. If the integration wants texture detail here, it must
   generate UVs (box projection keyed off material names like `Shirt`,
   `Wheels`, `Main`) *before* `extractModelGeometry` merges buckets —
   and every primitive needs them or the merge degrades to unmerged
   pieces.
2. **`colormap-specular` is a lie** — no specular/metal/roughness data
   anywhere in the mapped set despite the name. All 33 textured files are
   metal=0/rough≈1 matte. Any shininess (solar panels, vehicle paint,
   glass) is a *material-factor* change, not a texture change, and is
   arguably the bigger visual win.
3. **Space kit + nature props are authored metal=1/rough=1 with no env
   map** — 16 files render darker than intended today. Assigning
   categories to these should reset metal/rough to sane values
   (e.g. paintedMetal ≈ 0.35/0.45); the texture itself is secondary.
4. **Kenney space has no colormap.png on disk** (only pack of the seven
   without one). Its UVs reference a texture that was never shipped —
   don't trust those UV layouts blindly; verify or go procedural.
5. **Shared atlases couple buildings together.** Editing one pack's
   `colormap.png` retouches every building in that pack at once
   (e.g. kenney-commercial covers shop/market/lab/apartment/university/
   hospital/aegisMain). Per-building looks need either atlas-region
   discipline or per-model texture overrides.
6. **Shared keys/files couple entities.** rifleman.glb serves 3 infantry
   kinds, building-e.glb serves factory+powerPlantMain, industrialStack /
   industrialTank are shared pieces. Per-load processing (current design)
   means per-key UV work won't leak across kinds — keep it that way.
7. **sniperTeam/combatMedic/rifles are the same mesh.** They read as
   different units only via attached gear props (`buildInfantryGear`) and
   UI. A camo/fabric tint variant for sniperTeam would help battlefield
   readability — but it must stay team-neutral (see §4.5).
8. **Construction fade is texture-safe** (`Material.clone()` shares the
   map), and **team colors are fully decoupled** from model materials —
   texturing can't break either as long as it doesn't tint toward
   blue/red/orange or add emissive.
9. **Quaternius colors are linear-space baseColorFactor.** Any texture
   authored for those models must be marked sRGB or the colors shift.
10. **Don't texture the fallback Kenney trees** beyond flat — the live
    trees are the procedural textured ones; the GLBs only render when
    that texture fetch fails.

## 7. Integration decisions (implemented 2026-09-30, 0.1 Alpha)

How each audit finding was resolved in `game/src/render/entitySurfaces.ts`
(plus wiring in `models.ts`, `proceduralModels.ts`, `roads.ts`,
`entities.ts`, `renderer.ts`, `ui/game.ts`):

- **Once at load, never per-view.** `applySurfaceTreatment(key, geometries,
  materials)` runs inside `loadModels` after `extractModelGeometry`, on the
  per-load material clones. Zero hot-path cost; the per-view sharing
  contract in `entities.ts` is untouched.
- **All 58 `MODEL_PATHS` keys covered** by `KEY_TREATMENTS` (pinned by
  `tests/render.entitySurfaces.test.ts`, 13 tests — the table test fails if
  a key is added without a treatment). Unknown keys pass through unchanged.
- **Quaternius flat class (§6.1):** NOT left flat. Name-keyed treatments
  re-skin them: tanks get procedural `camoDesert` + `gunmetal` details +
  `tireRubber` wheels with box-projected UVs (`uvWorldScale: 2`); infantry
  gets `canvasFabric` uniforms + skin/gunmetal accents. The "leave flat"
  option was rejected — screenshots showed the re-skin reads clearly
  better while staying stylized.
- **Space-kit de-blacking (§6.3):** `metal=1/rough=1` materials are reset to
  sane painted-metal values (e.g. `hullGray` 0.35/0.45); solar-panel
  `colormap-specular` materials become glassy (`glassBlue` roughness map,
  metal 0.7, rough 0.22, envMapIntensity 1.6) so panels catch a sky
  reflection. Authored orange accents preserved (team-color contract:
  no blue/red/orange tints, no emissive on model materials).
- **Env map (§6.2's "bigger visual win"):** `applyEnvironmentLighting`
  attaches a shared procedural equirect environment texture
  (64×32 sky/ground/sun-blob, 8 KB, process-lifetime) at game start with
  `environmentIntensity 0.5` — fill, not key light. The unified renderer
  PMREM-processes equirect maps internally per backend. **Dead end
  documented:** the legacy `THREE.PMREMGenerator` from `three` core is
  WebGLRenderer-only and crashes on the unified `WebGPURenderer`
  (`renderer.state` undefined); do not use it here.
- **Barn red (§5):** `woodPlank` tinted to match the authored DarkRed
  (linear-space multiply: plank mid (0.304,0.163,0.080) × tint
  (0.664,0.261,0.401) ≈ authored (0.202,0.0425,0.0321)).
- **Roads:** `QuadList` now emits world-scale UVs
  (`ROAD_UV_WORLD_SCALE = 4`); `roadAsphaltMat` gets the `tireRubber`
  roughness map; dashes stay flat.
- **Procedural builders:** `surfaceMaterial(category, tint?)` tags every
  builder material with `userData.surfaceCategory` (emissive accents keep
  `pmat`); the test pins that all 17 `PROCEDURAL_KINDS` + 4 infantry-gear +
  7 props are tagged or emissive.
- **Bench scene and menus:** untouched (no 3D entity scene there).
- **Verified:** before/after screenshots (headless Chromium, SwiftShader)
  for tank, factory, fighter, destroyer, solarFarm in
  `~/workspace/novaterra-screenshots/entity-textures/` — each pair differs
  visibly: tank flat-tan → desert camo; factory flat → corrugated walls;
  fighter flat gray → brushed-metal panel lines + glass canopy; destroyer
  flat dark → hull panel variation; solar panels flat → blue reflective
  sheen.
- **Still flat, deliberately:** prop rocks/bushes (tiny, distant), Kenney
  tree GLB fallbacks (never rendered live), water (out of scope).
