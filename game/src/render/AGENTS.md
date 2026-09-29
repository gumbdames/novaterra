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

## Entity rendering conventions (`render/entities.ts`, 0.1 Alpha)

- `EntityRenderer` is a read-only view: `sync(world)` rebuilds instance
  data from plain sim records every frame; `setSelected`/`updateSelectionRings`
  drive highlight state. It never writes to the world.
- One `InstancedMesh` per unit kind + one for buildings + one for roads;
  health bars and selection rings are instanced quads. Unit meshes are
  smooth placeholder silhouettes (capsule/cylinder/cone composites) —
  explicitly temporary 0.1 Alpha art, not final, and never blocky.
- Roads rebuild when the road digest changes (not just the count).
- Team colors: human = blue accent, AI = red accent (see `TEAM_COLORS`).
- `dispose()` releases every geometry/material it created.
- Superweapon FX (`syncSuperweaponFx`): reads the sim's deterministic
  `world.superweapons.fx` records each frame. The Aegis dome is a
  translucent hemisphere + wireframe shimmer (pulse phase from
  `world.tick`); each storm strike gets a gathering cloud, a lightning
  bolt, and an impact flash (phase from the fx expiry tick). Views are
  keyed by fx identity and disposed when the sim record expires.
