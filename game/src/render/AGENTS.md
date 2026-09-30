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

- `MODEL_PATHS` is the key -> GLB mapping: **58 real CC0 entries**
  (Kenney + Quaternius; see THIRD_PARTY_NOTICES.md for the per-file
  listing). `path` is relative to `game/public/models/` (served at
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
  one key each, loaded once). ~4.6 MiB of GLB downloads at startup
  (58 keys, 55 unique files; rifleman.glb is keyed 3×, building-e.glb
  2× — per-key normalization, same as the pre-expansion mapping), plus
  ~0.83 MiB of CC0 tree textures for the procedural nature trees (see
  the Nature scatter section below).
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

- 17 entity kinds have no CC0 source: artillery (wheeled howitzer),
  aa (missile truck), fighter (jet), transport (helicopter), drone
  (quadcopter), destroyer (warship, keel below the waterline),
  mediaCenter (lattice broadcast tower), stormArray (dish), apc (6×6
  armored carrier), mlrs (elevating 12-tube rocket pod), fighterBomber
  (strike jet), attackHeli (tandem gunship), submarine (teardrop hull,
  keel below the waterline), frigate (compact warship), carrier
  (flat-top), quarry (terraced rock face), monument (obelisk). Each
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

## Roads (`render/roads.ts`, 0.1 Alpha)

- Pure deterministic builders: `buildRoadGeometry` (one asphalt quad per
  road cell, deduped, sorted emission — connected ribbons read as
  continuous) and `buildRoadMarkings` (pale center dash only for cells
  with exactly two OPPOSITE neighbors; ends/corners/junctions get none).
  Tested in `tests/render.roads.test.ts`.

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

## Entity rendering conventions (`render/entities.ts`, 0.1 Alpha)

- `EntityRenderer` is a read-only view: `sync(world)` diffs the world
  against live three.js objects (create/move/dispose) every frame;
  `setSelected`/`updateSelectionRings` drive highlight state. It never
  writes to the world. Constructor: `new EntityRenderer(scene,
  models = new Map(), { waterLevel = 0 })` — an empty map is fully
  supported (every entity falls back; the game stays playable).
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
  baked `yOffset`); air units hover at y=14; the spectre gunship hovers
  at 1.6 (`HOVER_Y`).
- Roads: ribbon + dash meshes rebuilt when the road digest changes (FNV
  over cell indices, not just the count).
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
