# AGENTS.md — src/render

three.js rendering only: a read-only view of the last two sim ticks plus the
interpolation alpha. No gameplay logic here, ever. See docs/ARCHITECTURE.md §6.

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
