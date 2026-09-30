# AGENTS.md — src/render

three.js rendering only: a read-only view of the last two sim ticks plus the
interpolation alpha. No gameplay logic here, ever. See docs/ARCHITECTURE.md §6.

## Renderer creation (`render/renderer.ts`, 0.1 Alpha)

- `createRenderer(canvas, opts?)` is the ONLY way to build a renderer
  (menu boot, game start, and `?bench=1` all use it). WebGPU first, with
  automatic, time-bounded fallback to WebGL2.
- The hazard it guards: three.js r186 puts NO timeout on
  `navigator.gpu.requestAdapter()` / `adapter.requestDevice()`. Its WebGL2
  fallback only runs on *rejection* — a wedged GPU process makes
  `requestAdapter()` pend forever, which used to hang boot on a blank page.
  `createRenderer` probes the adapter channel with an 8s deadline
  (`ADAPTER_PROBE_TIMEOUT_MS`) and races the full init() against 20s
  (`RENDERER_INIT_TIMEOUT_MS`), then falls back to forced WebGL2 instead of
  hanging. Every path is bounded; total failure throws
  `RendererInitTimeoutError` for the caller's showFatal().
- `withTimeout` / `webgpuAdapterReachable` are exported for tests; both are
  unit-tested in `tests/render.renderer.test.ts`. The module stays
  import-safe under Node: the only `three/webgpu` import is type-only.

## Terrain meshing conventions (`render/terrain.ts`)

- Mesh data is built as **plain typed arrays first** (`buildChunkMeshData` is
  pure and unit-tested); three.js `BufferGeometry` is only the last-mile
  upload. This keeps meshing testable in Node and worker-portable later.
- One indexed mesh per chunk, chunk-local vertex indices, **counter-clockwise
  winding when viewed from above** (up-facing triangles; pinned by test).
- Vertex colors (linear space), not textures, in Phase 1: one shared
  `MeshStandardMaterial({ vertexColors: true })` for all chunks. Biome colors
  live in `PALETTE_SRGB` keyed by the `Biome` enum — if a biome id is added,
  the palette must grow with it (`biomeLinearColor` throws on unknown ids).
- Chunk grid math mirrors the sim: `vertsPerSide` is odd (shared vertices on
  chunk borders), so `buildChunkMeshData` asserts `size >= 2` and the origin
  stays in range — a rejected chunk is a loud throw, never a silent seam.
- The water plane is render-side decoration (animated wave bob); the water
  *level* itself is sim data (`TerrainData.waterLevel`).

## Model loading (`render/models.ts`, 0.1 Alpha)

- Texture-path rule (fixed 2026-09-30 — was 45 console 404s on every
  boot): `loadOneModel` passes the GLB's DIRECTORY (trailing slash) as
  `parseAsync`'s resource path, never the file URL — three's resolveURL
  string-concatenates (`path + uri`), so the file URL resolved embedded
  textures to `<name>.glbTextures/...`. Same fix in `natureTrees.ts`,
  which appended a second `models/` onto `modelBaseUrl()` (it already
  ends with `models/`). Pinned by `render.models.test.ts`.
- `MODEL_PATHS` is the key -> GLB mapping: **65 real CC0 entries**
  (Kenney + Quaternius; see THIRD_PARTY_NOTICES.md for the per-file
  listing). Four of them (`personCasualMan`, `personCasualWoman`,
  `personWorker`, `personWomanTwo` — the civilian pedestrians in
  `game/public/models/quaternius-civilians/`) are LAZY-only, never in
  the boot set (see `bootModelKeys` in `lazyModels.ts`), so the startup
  download below is unchanged by them. `path` is relative to `game/public/models/` (served at
  `<import.meta.env.BASE_URL>models/<file>`); `scale` is the uniform
  fit-to-footprint scale measured with the module's own `normalizeModel`
  against the `hullSizeFor` footprint convention (see `entities.ts`).
  Optional `rotY` bakes the authored-facing → game-forward (+z) yaw
  correction (tank barrel, truck cab, ship superstructure, jet nose);
  optional `yOffset` sinks boat hulls (negative) so the waterline sits
  partway up the hull instead of at the keel. Composite buildings
  assemble several keys at per-piece offsets (`warFactory`,
  `airfield`, `navalYard`, `oilRefinery`, `solarFarm`, `desalination`
  share the `industrialStack` / `industrialTank` pieces across kinds —
  one key each, loaded once). 4.56 MiB of GLB downloads at startup
  (61 keys, 58 unique files; rifleman.glb is keyed 3×, building-e.glb
  2× — per-key normalization, same as the pre-expansion mapping), plus
  ~0.83 MiB of CC0 tree textures for the procedural nature trees (see
  the Nature scatter section below). The 4 civilian-pedestrian keys add
  ~1.05 MiB but load lazily on first population, never at startup.
- `loadModels(paths, { timeoutMs })` fetches the GLBs CONCURRENTLY via a
  dynamically imported `GLTFLoader` (separate chunk — only downloaded when
  models load), each raced against `withTimeout` (default 15s, same
  never-pend-forever philosophy as `renderer.ts`). ANY failure — 404,
  timeout, parse error, bad scale — records the key in the returned
  `failed` list and the load CONTINUES. The result carries only successes;
  callers fall back per `modelSourceFor` for failed/missing keys.
  `loadModels` never throws and never pends forever. Game start wraps it
  in an additional ~20 s overall budget (`ui/game.ts` `loadEntityModels`).
- Each loaded scene is normalized (`normalizeModel`: rotY first, then
  centered horizontally on the origin, base at y=0, `spec.scale` applied —
  parent-independent via a premultiplied world-matrix transform; yOffset
  applied after), then `extractModelGeometry` bakes `matrixWorld` into the
  geometries, groups pieces by material (multi-material meshes are split
  along their geometry groups), and merges each group with
  `BufferGeometryUtils.mergeGeometries`. Returned materials are CLONES so
  callers can tint safely; the source scene is disposed after extraction.
- `disposeModels` releases every geometry/material in a loaded map. The
  map is caller-owned: the `EntityRenderer` borrows it and never disposes
  it; `ui/game.ts` disposes it once in the controller's `dispose()`.
- The module stays import-safe under Node: `three` core is static (no DOM
  at import), `GLTFLoader`/`BufferGeometryUtils` are dynamic imports.
  Tested in `tests/render.models.test.ts` with a mocked loader.

## Procedural gap models (`render/proceduralModels.ts`, 0.1 Alpha)

- 37 entity kinds have no CC0 source: artillery (wheeled howitzer),
  aa (missile truck), fighter (jet), transport (helicopter), drone
  (quadcopter), destroyer (warship, keel below the waterline),
  mediaCenter (lattice broadcast tower), stormArray (dish), apc (6×6
  armored carrier), mlrs (elevating 12-tube rocket pod), fighterBomber
  (strike jet), attackHeli (tandem gunship), submarine (teardrop hull,
  keel below the waterline), frigate (compact warship), carrier
  (flat-top), quarry (terraced rock face), monument (obelisk), plus the
  13 grand-expansion Phase 2 utility buildings: coalPlant (cooling-tower
  hall), gasPlant (turbine hall + stacks), windFarm (three turbines),
  hydroDam (arched dam wall + powerhouse), geothermalPlant (vent stacks
  + pipe manifold), fusionPlant (domed hall + tokamak torus ring),
  waterWell (A-frame derrick + pump house), waterTower (tank on legs),
  waterTreatment (clarifier basins), reservoir (embanked basin),
  powerSubstation (transformer yard), pumpingStation (pump hall),
  batteryStation (container batteries), plus the 7 grand-expansion
  Phase 3 logistics buildings: oilWell (derrick tower), oilRig (deck on
  legs), munitionsFactory (hall + shell prop), missilePlant (hall +
  missile on stand), missileSilo (concrete silo + dome), ordnanceDepot
  (crate stacks + sandbag ring), fuelDepot (twin horizontal tanks). Each
  builder is a detailed smooth (never blocky) composite;
  `PROCEDURAL_KINDS` / `buildProceduralModel(kind)` is the registry.
  Builders rest at y=0 (destroyer / submarine / frigate / carrier
  excepted — waterline at y=0 by design, keels below).
- Attach props: `buildInfantryGear` (rifle / hard-hat + tool pack /
  sniper scoped rifle + bipod / medic helmet + red-cross pack),
  `buildHqAntenna`, `buildRadarDishProp` (aegisControl's yard dish),
  `buildAwacsDome` (rotodome), `buildShipMast` (command-ship comms
  mast), `buildRunwayStrip` (airfield), `buildCoolingTower`
  (nuclearPlant), `buildHospitalCross` (hospital roof sign).

## Procedural surface library (`render/surfaceTextures.ts`, `surfaceMaterials.ts`, `boxProjectUVs.ts`, 0.1 Alpha)

- License-clean, fully procedural textures: `surfaceTextures.ts` generates
  16 surfaces (`paintedMetal`, `camoGreen/Desert/Navy`, `gunmetal`,
  `tireRubber`, `concrete`, `glassBlue`, `brickRed`, `woodPlank`,
  `canvasFabric`, `hullGray`, `rustMetal`, `hazardStripes`, `roofGravel`,
  `sandbag`) from a seeded mulberry32 PRNG — no third-party IP, no canvas
  DOM needed. `generateSurfacePixels` / `generateSurfaceRoughness` are pure
  (Node-testable); `surfaceTexture` / `surfaceRoughnessTexture` wrap them in
  cached `THREE.DataTexture`s (sRGB diffuse, single-channel roughness,
  `RepeatWrapping`). Same (category, seed) → byte-identical pixels everywhere.
- Tileability by construction: every feature is drawn through toroidal
  (wrapping) writes and analytic patterns use periods that divide the texture
  size; pinned by the seam-vs-grain test (`tests/render.surfaces.test.ts`).
- `surfaceMaterials.ts` exports ONE shared `THREE.MeshStandardMaterial` per
  category (`SURFACE_MATERIALS`, tuned metalness/roughness per surface).
  Team-color contract (documented in the module header): `tintable` surfaces
  (`paintedMetal`, `hullGray`, `canvasFabric`, `concrete`, `roofGravel`) are
  luminance-biased so a team tint reads; authored-color surfaces are used
  with white. NEVER mutate a shared instance — clone once per team.
- `boxProjectUVs.ts`: pure dominant-axis box projection for geometry without
  TEXCOORD_0; UVs in tile units (`worldScale` = world units per tile) so
  texel density is consistent across models. Missing/non-finite normals fall
  back to up-facing; never emits NaNs. `ensureBoxUVs` projects only when no
  `uv` attribute exists.
- Wired in by the texture-integration phase (`render/entitySurfaces.ts`,
  0.1 Alpha): `KEY_TREATMENTS` maps all 61 `MODEL_PATHS` keys to surface
  categories; `applySurfaceTreatment` runs once at load in `models.ts`
  (per-material, never per-view); procedural builders tag materials via
  `surfaceMaterial()` in `proceduralModels.ts`; roads emit world-scale UVs
  (`roads.ts` `ROAD_UV_WORLD_SCALE = 4`). `applyEnvironmentLighting`
  (`render/renderer.ts`) attaches a shared procedural equirect environment
  map at game start so metalness/roughness shade correctly on the unified
  renderer (its internal PMREM path handles equirect maps per backend —
  the legacy `THREE.PMREMGenerator` is WebGLRenderer-only and crashes on
  WebGPURenderer, do not use it). Pinned by
  `tests/render.entitySurfaces.test.ts` (13 tests).

## Roads (`render/roads.ts`, 0.1 Alpha)

- Pure deterministic builders: `buildRoadGeometry` (one asphalt quad per
  road cell, deduped, sorted emission — connected ribbons read as
  continuous) and `buildRoadMarkings` (pale center dash only for cells
  with exactly two OPPOSITE neighbors; ends/corners/junctions get none).
  An optional `heightAt` callback drapes both layers over the terrain:
  heights are sampled per quad corner (+0.08 ribbon / +0.11 dash
  offsets, shared corners sampled at identical coordinates so the ribbon
  never cracks) with geometric normals for correct slope lighting;
  without the callback the quads stay flat at `ROAD_Y` / `ROAD_DASH_Y`
  (legacy headless path). Tested in `tests/render.roads.test.ts` and
  `tests/render.entityHeights.test.ts`.

## Nature scatter (`render/nature.ts`, 0.1 Alpha)

- Deterministic render-only decoration: `buildNatureView({ terrain,
  models, isOccupied, seed })` scatters nature props (trees, rocks,
  bushes) as one `InstancedMesh` per prop geometry/material over
  scatter cells, rejecting water, shoreline, and occupied cells
  (buildings/roads/starting units at build time). Missing prop models
  degrade to no decoration. Returns null when nothing qualifies.
  `NatureView.dispose()` releases ONLY instance attributes — shared
  prop geometry/materials stay with the models map. Built once at game
  start in `ui/game.ts`; never affects the sim.
- Trees are NOT Kenney GLBs anymore: `ui/game.ts` `loadEntityModels`
  overlays the procedural textured trees from `render/natureTrees.ts`
  (lathe trunks with root flare, alpha-cut leaf-card canopies over dark
  cores, needle-frond conifers; Quaternius CC0 bark/leaf textures from
  `game/public/models/quaternius-nature/textures/`, ~0.83 MiB) onto the
  six `propTree*` map keys. The Kenney tree GLBs remain in `MODEL_PATHS`
  purely as a silent fallback if the texture fetch fails. Scatter
  placement is untouched (same keys, same weights, same order), so the
  same seed grows the same forest.

## Chevron overlay (`render/chevrons.ts`, 0.1 Alpha)

- Veterancy readability cue (grand-expansion Phase 1): floating gold
  chevron strips above living units at vetLevel 1..3 (Regular / Veteran /
  Elite). Three `THREE.InstancedMesh` (one per level), each with a
  deterministic canvas-free `THREE.DataTexture` (pure SDF rasterization —
  same level ⇒ byte-identical pixels, pinned by test).
- Per sync, instance lists rebuild from `world.units` directly — the
  overlay is independent of the unit-body render path (Phase 0 instanced
  or legacy). At most 3 draw calls; empty level meshes are hidden (0
  draws when no veteran is alive). Instances billboard via the camera
  quaternion (identity when headless).
- Anchor (pure, tested): terrain ground (`groundYAt`) + hover lift
  (`unitHoverY`) + per-kind model top (measured `modelTops`, placeholder
  hull height fallback) + `CHEVRON_BASE_OFFSET` (1.6 — clears the legacy
  health-bar band at modelTop+1.1) + half the strip height
  (bottom-anchored, so every level starts at the same height).
- `EntityRenderer` owns one `ChevronOverlay`: constructed in the
  constructor, synced at the end of `sync()`, disposed in `dispose()`.

## Zone overlay (`render/zoneOverlay.ts`, 0.1 Alpha)

- Zone readability (grand-expansion Workstream Z): zoning was
  previously invisible on the map. One translucent ground decal per
  zone cell — green (residential `0x43a047`), blue (commercial
  `0x1e88e5`), orange (industrial `0xfb8c00`) at 0.28 opacity so the
  terrain shows through. Visible by default.
- Pure builders, Node-testable: `zoneDigest` (FNV-1a over cell+zone
  pairs, order-independent) and `buildZoneDecalGeometry` (one
  up-facing quad per cell, per-corner vertex colors, sorted emission
  like the road ribbon). Corners drape on the terrain via the same
  `heightAt` callback the roads use (+0.05 offset — below the road
  ribbons' +0.08, so zones never z-fight paved cells); without the
  callback the decals stay flat at `ZONE_Y` (headless path).
- `ZoneOverlay` owns one merged `BufferGeometry` mesh (1 draw call, 0
  when no zones are painted) and rebuilds ONLY when the digest
  changes — repainting one cell rebuilds, an unchanged sync is a
  no-op. `EntityRenderer` constructs it in the constructor, syncs it
  in `sync()` with the terrain's `heightAt` sampler, and disposes it
  in `dispose()`. Tested in `tests/render.zoneOverlay.test.ts`
  (13 tests).

## Ambient city life (`render/cityLife.ts`, 0.1 Alpha)

- Render-side-only city decoration (Workstream P): painted zones get
  an automatic concrete paving wash, and completed homes fill the
  streets with instanced pedestrians and cars. Nothing for the player
  to manage — it is all derived from zones, roads, buildings, seed,
  and tick. Ambient entities NEVER enter sim state: not selectable,
  not in any entity list, never in the digest/snapshot (the no-leak
  test pins `digestWorld` across syncs).
- `PavingOverlay`: one merged translucent concrete decal
  (`surfaceTexture('concrete')`, 0.4 opacity, renderOrder 2 — above
  the zone tint at 1, below the road ribbon), rebuilt only when the
  zone digest changes. 0/1 draw calls.
- The crowd: `AmbientCrowd` owns one instanced layer for pedestrians
  (≤500) and one for cars (merged body+cabin, ≤150), each
  with per-instance coat/paint colors set at rebuild. Pedestrians render
  as capsules UNTIL the four Quaternius civilian GLBs lazy-load through
  the models map (`render/people.ts` bakes each variant to one
  vertex-colored geometry — 4 instanced layers max, all-or-nothing
  upgrade; a plain-`Map` test harness keeps capsules forever). Density
  scales with city population (1 walker per 4 residents, 1 car per 20).
  Poses are pure functions of (seed, index, tick) — ping-pong tracks
  with no per-agent state, so pause/seek/rebuild are exact.
  `EntityRenderer` constructs the overlay + crowd in its constructor,
  syncs both in `sync()`, and disposes them in `dispose()`.
- Transit hooks for Phases 4–6: `ambientTransitDensity(pop)` sizes
  bus/tram/ferry/airliner counts; phases register an
  `AmbientTransitProvider` per type (provider-owned geometry/material,
  pure `poseAt(index, tick)`) — the crowd renders one instanced layer
  per registered type.
- Tested in `tests/render.cityLife.test.ts` (29 tests): paving
  geometry/digest/rebuild contract, density scaling (0 pop ⇒ 0
  agents), zone-weighted homes, direction-biased targets, road-bound
  cars, pose purity/determinism, the no-sim-leakage rule, transit
  density pins + provider registry round-trip, and a 500/150 worst-
  case perf sync with headroom.
- Parking buildings (same workstream): `proceduralModels.ts` has
  `buildParkingLot` / `buildParkingGarage` (registered in
  `PROCEDURAL_KINDS` and the `buildProceduralModel` switch);
  `sim/city.ts` defs are civic/utility-zone/foundation (lot 180/60,
  garage 450/180); they are amenity rows in `sim/desirability.ts`
  (lot +3/8 cells, garage +4/10, same +20 cap — convenience scores
  below the +5 cultural types); `MODEL_SOURCES` maps both to
  `procedural`. Tested in `tests/sim.parking.test.ts`.

## Utility networks (`render/networks.ts`, 0.1 Alpha)

- Grand-expansion Phase 2: the visible power lines and water pipes.
  Pure builders, Node-testable: `buildPowerLineGeometry(cells, …)` →
  `{ poles, wires }` (wood poles with crossarms + sagging catenary wire
  runs between consecutive poles) and `buildPipeGeometry(cells, …)` (one
  merged ground-hugging pipe ribbon + valve boxes). Corners drape on the
  terrain via the same `heightAt` callback the roads use; without it the
  geometry stays flat (headless path). `networkDigest(cells)` is the
  FNV-1a rebuild key (order-independent).
- `NetworkOverlay` owns the merged meshes and rebuilds ONLY when a digest
  changes — static almost every frame. Rendered always-on like roads
  (players read the network at a glance); the toggle-able diagnosis tints
  live in `utilityOverlay.ts`. Owned by `EntityRenderer`: constructed in
  its constructor, synced in `sync()` from `world.city.powerLines` /
  `world.city.pipes`, disposed in `dispose()`. Tested in
  `tests/render.networks.test.ts`.

## Underground / x-ray view (`render/xrayView.ts`, 0.1 Alpha)

- Phase 4 RENDER workstream A (item 1): water pipes are hard to spot on
  the normal map (thin ground-hugging ribbons in terrain colors), so the
  x-ray mode ghosts the terrain (`XRAY_TERRAIN_OPACITY` 0.25, depthWrite
  off) + water (opacity 0.15) and lights the pipe network bright cyan
  (`NetworkOverlay.setXray`: emissive + depthTest off + renderOrder 10 —
  re-applied on every pipe rebuild while the flag is set). Coexists with
  every other overlay (zone/paving/utility/logistics/desirability/grid
  decals keep drawing over the ghosted terrain; entities untouched).
- `XrayView` owns no materials: terrain/water are late-bound borrowed
  refs via `setTerrainMaterials` (the `TerrainView` is built before the
  renderer), and the pipe treatment goes through a callback into the
  `NetworkOverlay`. Owned by `EntityRenderer` (`setXrayVisible` /
  `isXrayVisible` / `setXrayMaterials`); the HUD topbar owns the "X-ray"
  toggle (icon+text, `setXrayActive`) and `ui/game.ts` auto-enables x-ray
  while the water-pipe tool is armed (never fighting a manual toggle).
  Tested in `tests/render.xray.test.ts`.

## Terrain grid overlay (`render/gridView.ts`, 0.1 Alpha)

- Phase 4 RENDER workstream A (follow-up B): a subtle survey grid for the
  map — one draped `LineSegments` (1 draw call, hidden by default, topbar
  "Grid" button with icon+text via `viewIcon('grid')`, or the `G` key).
  Lines every 32 world units (16 cells) across the whole 512×512 map,
  subdivided every 8 units so they hug hills (`heightAt` drape, +0.09
  terrain offset — above the pipe (+0.06) and road (+0.08) ribbons, below
  the utility diagnosis tints (+0.12)). Subtle white 0.22 opacity,
  `depthWrite` off, never occludes entities. Unaffected by x-ray (stays
  legible over ghosted terrain). Owned by `EntityRenderer`
  (`setGridVisible` / `isGridVisible`); `buildGridGeometry` is pure and
  Node-testable. Tested in `tests/render.grid.test.ts`.

## Utility diagnosis overlay (`render/utilityOverlay.ts`, 0.1 Alpha)

- Grand-expansion Phase 2: the toggle-able diagnosis layer (topbar
  "Utilities" button). Three translucent ground tint decals (green =
  power-served cells, blue = water-served cells, purple = fouled-source
  cells) built by the pure `buildTintDecalGeometry` (+0.12 terrain offset —
  above the zone decals' +0.05 and the road ribbons' +0.08, so the
  diagnosis layer always reads) plus four
  instanced billboard marker sprites (red disconnected / amber shortage /
  orange stranded-producer / purple fouled) rasterized canvas-free via
  the pure `utilityMarkerPixels` (deterministic 64×64 SDF sprites, same
  kind ⇒ byte-identical pixels, pinned by test).
- `utilityOverlayDigest(data)` is the FNV-1a rebuild key over served /
  fouled cells + markers (the line/pipe cells are NOT in the digest —
  `NetworkOverlay` renders those). `UtilityOverlay.sync(data, opts)`
  rebuilds tints + marker lists only on digest change and billboards the
  markers every sync. Marker instanced meshes are created lazily — an
  empty scene keeps zero marker meshes instead of four empty ones (this
  keeps the instancing draw-call counts honest). Owned by
  `EntityRenderer`: constructed in its constructor, synced in `sync()`
  from `ui/utilities.ts` `utilityOverlayData(world, …)`, toggled by
  `setUtilityOverlayVisible(v)`, disposed in `dispose()`. Tested in
  `tests/render.utilityOverlay.test.ts`.

## Logistics overlay (`render/logisticsOverlay.ts`, 0.1 Alpha)

- Grand-expansion Phase 3: the toggle-able diagnosis layer (topbar
  "Logistics" button, next to Utilities). Two ground decal layers, both
  terrain-draped, both rebuilt only on digest change: one merged mesh of
  translucent olive coverage discs (one per completed reload point —
  the 4 production bases, 2 ammo producers, 3 depots — radius = the sim's
  `LOGISTICS_RADIUS` from `sim/economy.ts`, never an invented constant;
  +0.14 terrain offset, above the utility tints' +0.12) and one merged
  mesh of amber ground rings under living units below
  `LOGISTICS_LOW_SUPPLY` (+0.18 offset). 1 draw call per layer, 0 when
  empty (meshes are created lazily / removed when the data empties).
- Pure geometry builders (`buildCoverageDiscGeometry`,
  `buildLowSupplyRingGeometry`) are Node-testable: counter-clockwise
  winding from above (up-facing), flat headless fallback when no terrain
  sampler is passed. `logisticsOverlayDigest(data)` is the FNV-1a rebuild
  key. Owned by `EntityRenderer`: constructed in its constructor, synced
  in `sync()` from `ui/logistics.ts` `logisticsOverlayData(world)`,
  toggled by `setLogisticsOverlayVisible(v)`, disposed in `dispose()`.
  Tested in `tests/render.logistics.test.ts` (model validity + hoop-arch
  orientation + overlay geometry + digest stability).

## Logistics procedural models (render/proceduralModels.ts, 0.1 Alpha)

- Grand-expansion Phase 3: final-art procedural builders for the 7
  logistics buildings (`buildOilWell` pumpjack, `buildOilRig` offshore
  platform, `buildMunitionsFactory` brick hall, `buildMissilePlant` with
  transporter-erector, `buildMissileSilo` with open blast doors,
  `buildOrdnanceDepot` arched bunkers, `buildFuelDepot` bunded tanks)
  and the 2 supply trucks (`buildSupplyTruck` canvas hoop,
  `buildFuelTruck` tanker). All registered in `PROCEDURAL_KINDS` and
  `MODEL_SOURCES`. The truck canvas hoop is a half-cylinder shell rolled
  to the top (rotateX then rotateZ) — pinned by an arch-signature test
  (width ≈ diameter, height ≈ radius, sitting on the bed walls).

## Entity rendering conventions (`render/entities.ts`, 0.1 Alpha)

- `EntityRenderer` is a read-only view: `sync(world)` diffs the world
  against live three.js objects (create/move/dispose) every frame;
  `setSelected`/`updateSelectionRings` drive highlight state. It never
  writes to the world. Constructor: `new EntityRenderer(scene,
  models = new Map(), { waterLevel = 0, terrain })` — an empty map is
  fully supported (every entity falls back; the game stays playable),
  and `terrain` (the sim's `TerrainData`, passed from `ui/game.ts`)
  makes every ground-anchored view ride on the terrain — without it,
  entities keep the legacy flat y=0 placement (headless tests only).
- Terrain-riding Y rules (`render/terrainHeight.ts`, pure and tested):
  land units and buildings sit at `heightAt` (deterministic, O(1)
  bilinear lookup — units re-sample every frame as they move, buildings
  sample once at creation at the footprint center + 0.05); sea units
  float at `waterLevel`; aircraft ride the terrain beneath them with the
  14 hover applied group-relative (spectre gunship keeps 1.6, other land
  units 0.15 anti z-fight epsilon). Roads drape per corner (see below),
  selection rings sit at ground + 0.3 under the unit, and superweapon FX
  (Aegis dome, storm strikes) anchor on the terrain at their x/z.
- Model resolution per entity kind (`modelSourceFor`, tested for
  completeness over every UnitKind/BuildingKind): **GLB → procedural →
  placeholder**. When a GLB kind's pieces ALL fail to load, the renderer
  tries the procedural gap model for that kind before degrading to the
  placeholder (currently only kinds that are both GLB-mapped AND
  procedural-backed would use it — the mapping keeps them disjoint, so
  this is a safety net, not a live path). One `THREE.Group` per unit/building view; geometry AND
  materials are SHARED across all views of a kind (GLB assets arrive
  merged per material; procedural models are cached per kind;
  placeholder templates are cloned per view — `clone()` shares
  geo/mat). Per-view objects own ONLY health-bar sprites, the team
  pennant material, and (while constructing) cloned fade materials.
- Team identity: models keep their authored colors; each view adds a
  thin emissive team stripe above the model and a tiny glowing team
  pennant. Team colors: blue vs red, blue vs orange in colorblind mode
  (`teamColors()` reads the HTML class at view creation).
- Movement yaw: hulls face +z at rotation 0 (yaw baked at load);
  `updateUnitView` yaws toward the order destination. Health bars float
  above the model top; selection rings size from `hullSizeFor`.
- Construction: while `progress < 1`, a view's meshes use per-view
  transparent material CLONES; on completion the view swaps back to the
  shared materials and releases the clones — no cross-talk between two
  views of the same kind (pinned by test).
- Sea units float at `waterLevel` (boats/ships carry their waterline via
  baked `yOffset`); air units ride the terrain beneath them with the 14
  hover applied group-relative; land units sit on the terrain (+0.15,
  spectre gunship at 1.6). See the terrain-riding bullet above for the
  full rule set (`render/terrainHeight.ts`).
- Lazy-load arrival upgrade (0.1 Alpha): a view created while its
  kind's GLB pieces are still loading (or failed) carries
  `degraded: true`, computed at creation by the pure
  `isDegradedResolution(kind, resolved)` — true when a GLB kind
  resolved fewer GLB pieces than its source declares.
  Procedural/placeholder kinds are never degraded. `sync` re-checks
  degraded views every frame (`maybeUpgradeUnitView` /
  `maybeUpgradeBuildingView`): when the kind resolves whole, the
  fallback art is swapped for the real model in place — legacy unit
  hulls rebuild (stripe/pennant re-anchored), instanced units are
  removed and re-added to the pools, legacy buildings rebuild and
  re-apply the construction fade from the live progress, completed
  buildings go to instance slots. The kind's cached model top is
  invalidated before re-resolving so it is re-measured from the real
  pieces. Render-side only; a view still waiting keeps its fallback
  art. Pinned by `tests/render.entities.test.ts` (10 tests).
- Roads: ribbon + dash meshes rebuilt when the road digest changes (FNV
  over cell indices, not just the count).
- Utility overlays (grand-expansion Phase 2): `EntityRenderer` owns a
  `NetworkOverlay` (always-on power-line / water-pipe meshes, rebuilt on
  digest change) and a `UtilityOverlay` (toggle-able diagnosis tints +
  markers) — both constructed in the constructor, synced at the end of
  `sync()` from `world.city.powerLines` / `world.city.pipes` and
  `ui/utilities.ts` `utilityOverlayData(…)`, toggled via
  `setUtilityOverlayVisible(v)`, disposed in `dispose()`. See
  "Utility networks" / "Utility diagnosis overlay" above.
- `dispose()` releases per-view objects and every SHARED asset the
  renderer owns (procedural cache, prop cache, placeholder templates,
  stripe/pennant/road/FX assets) exactly once — but never the
  caller-owned models map.
- Superweapon FX (`syncSuperweaponFx`): reads the sim's deterministic
  `world.superweapons.fx` records each frame. The Aegis dome is a
  translucent hemisphere + wireframe shimmer (pulse phase from
  `world.tick`); each storm strike gets a gathering cloud, a lightning
  bolt, and an impact flash (phase from the fx expiry tick). Views are
  keyed by fx identity and disposed when the sim record expires.

## Entity instancing (`render/entityInstancing.ts`, 0.1 Alpha)

- The draw-call ceiling decision (Phase 0 workstream 1; see
  `docs/research/tech-stack.md` §3): one `THREE.InstancedMesh` per
  (model pool key × material) for model bodies, plus ONE instanced layer
  each for unit team stripes (per-instance scale + color), pennants
  (per-instance color), and health bars (two billboarded quads, only for
  damaged units). Draw calls scale with distinct kinds on the field —
  never with entity count.
- Opt-in: `new EntityRenderer(scene, models, { instanced: true })`. The
  legacy per-view path stays the default; kinds with no resolvable model
  (placeholder fallback) and buildings under construction stay legacy —
  per-instance transparency is not a thing, so construction keeps the
  per-view material-clone fade and converts into the pools on
  completion (`convertBuildingToInstanced`).
- Pool discipline: `definePool(key, model)` registers caller-owned
  geometry/material (never disposed by the instancer); `addEntity` /
  `removeEntity` manage dense swap-compacted slots (the moved instance's
  owner record is updated, including its stripe/pennant slot indices);
  pools double capacity preserving order. Frame protocol:
  `beginFrame()` → `writeTransform(id, …)` per entity → `endFrame(camera)`.
  Health-bar jobs accumulate per frame and flush as billboards in
  `endFrame` (two draw calls total when any damaged unit is shown, zero
  otherwise). All overlay layer pools (stripe/pennant/bars) are created
  lazily — an empty instancer adds no pools.
- Per-frame writes must reach EVERY live entity (matrices are upload-only
  when dirty; `flushPool` hides emptied pools). Colors upload only for
  colored pools (stripe/pennant/fg bars) via `setColorAt`; `instanceColor`
  buffers are pre-allocated so they never reallocate mid-frame.
- Scratch discipline: module-scope `_entity` / `_piece` / `_quat` /
  `_pos` / `_scl` / `_color` — no allocation on the write path (offsets
  are cloned once per slot at `addEntity`).
- Ownership: `dispose()` releases instance attributes and owned layer
  assets only; caller-owned pool geometries/materials are never touched
  (pinned by test). Use-after-dispose throws.
- Debug/test hooks: `entityCount`, `poolStats()`, `debugMatrices(poolKey)`
  (determinism: identical op sequences → byte-identical matrices),
  `drawCallCount()` (pools with count > 0). `EntityRenderer.debugInstancer`
  exposes the instancer (null in legacy mode). Covered by
  `tests/render.entityInstancing.test.ts` (14 tests).
