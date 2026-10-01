/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 */

/**
 * NOVATERRA — docs/grand-expansion/audit-render-ui.md
 *
 * Internal audit of the render + UI architecture (`game/src/render/`,
 * `game/src/ui/`, `main` as of 2026-09-30), done to ground the grand-expansion
 * plan. Covers: the exact pipeline a new unit/building follows from sim def
 * to model to texture to palette to placement (with the real functions and
 * files); what one new entity costs (download, draw calls, texture memory,
 * using the real budget numbers); asset-sourcing strategy options for "many
 * new great-looking models + textures"; which UI patterns must scale; and
 * the top 5 render/UI risks.
 *
 * Conventions: all names below (modules, functions, types) were read from
 * the source files named; nothing here is guessed. The render/UI AGENTS.md
 * rules apply — render is a read-only view of sim state (no gameplay logic
 * in render, no rendering assumptions in sim), deterministic procedural
 * generation only, DOM only touched when values change (the digest rule).
 *
 * Reading order used: repo AGENTS.md → game/src/render/AGENTS.md →
 * game/src/ui/AGENTS.md → game/src/sim/AGENTS.md → models.ts →
 * entitySurfaces.ts → surfaceTextures.ts → surfaceMaterials.ts →
 * boxProjectUVs.ts → proceduralModels.ts → entities.ts → natureTrees.ts →
 * palettes.ts → hud.ts → placement.ts → orders.ts → icons.ts →
 * session.ts → THIRD_PARTY_NOTICES.md → MANIFEST.md.
 */

// ===========================================================================
// 1. THE NEW-ENTITY PIPELINE (def → model → texture → palette → placement)
// ===========================================================================
//
// A new unit or building touches 8–10 files in a fixed order. Missing any
// step degrades silently (placeholder model) or loudly (compile error), as
// noted per step.
//
// STEP 1 — sim def (the authority).
//   Units: `UNIT_DEFS` in game/src/sim/units.ts — one entry keyed by the new
//   `UnitKind`: hp/speed/armor, damage/range/cooldown/targets,
//   vsLight/vsMedium/vsHeavy/vsAir multipliers, sight, domain
//   ('land'|'air'|'sea'), trainFunds/trainMaterials/manpowerCost,
//   requiredBuilding (production gate, e.g. warFactory), minAge
//   ('foundation'|'connectivity'|'industry'|'information'|'ascendance').
//   Buildings: `BUILDING_DEFS` in game/src/sim/city.ts — kind, name, zone
//   (residential/commercial/industrial/utility), footprintW/H (in city
//   cells), costFunds/costMaterials, buildSeconds, upkeepFundsPerSec,
//   powerDemand/powerSupply, waterDemand/waterSupply, output/input resource
//   rates (per sim-second), population, taxBasePerSec, minAge.
//   Adding the kind to the `UnitKind`/`BuildingKind` unions is what the rest
//   of the pipeline keys off.
//
// STEP 2 — model mapping (render/models.ts).
//   Add a row to `MODEL_PATHS: Record<string, ModelSpec>`: the GLB path
//   relative to game/public/models/ (served at
//   `<import.meta.env.BASE_URL>models/<file>`), a measured `scale` (the
//   convention: load the GLB through `normalizeModel` and fit it inside the
//   `hullSizeFor` footprint from entities.ts — see the scale-provenance
//   comments in models.ts), optional `rotY` (bakes authored-facing →
//   game-forward +z yaw correction, e.g. tank barrel, jet nose, ship
//   superstructure), optional `yOffset` (sinks boat hulls so the waterline
//   sits partway up the hull instead of at the keel).
//   Vendor the GLB under game/public/models/<kit>/, and record license
//   evidence: THIRD_PARTY_NOTICES.md (author, license, source URL) +
//   game/public/models/MANIFEST.md (depicts/tris/size per file).
//   `loadModels` fetches all keys CONCURRENTLY via a dynamically imported
//   GLTFLoader (separate bundle chunk), each raced against a 15s timeout
//   (`MODEL_LOAD_TIMEOUT_MS`); any failure records the key in `failed` and
//   continues — callers degrade via `modelSourceFor` (see next step).
//
// STEP 3 — model source resolution (render/entities.ts).
//   Add a row to `MODEL_SOURCES: Record<string, ModelSource>`: 1:1 kinds map
//   to `{ type: 'glb', pieces: [piece('<MODEL_PATHS key>')] }`; composite
//   buildings assemble several keys at per-piece dx/dy/dz offsets (the
//   pattern used by farm, powerPlant, warFactory, oilRefinery, airfield,
//   navalYard, solarFarm, desalination). Kinds with no GLB use
//   `{ type: 'procedural' }` and a builder in proceduralModels.ts registered
//   in `PROCEDURAL_KINDS` (today: 17 kinds — artillery, aa, fighter,
//   transport, drone, destroyer, apc, mlrs, fighterBomber, attackHeli,
//   frigate, submarine, carrier, quarry, monument, mediaCenter, stormArray,
//   plus attach props like buildHqAntenna, buildRadarDishProp, buildAwacsDome).
//   Resolution order per entity: GLB → procedural → placeholder
//   (`modelSourceFor`); unknown kinds render the placeholder — never blank.
//   NOTE: `MODEL_SOURCES` is `Record<string, ...>` — a forgotten row is NOT
//   a compile error (a test pins completeness over every UnitKind and
//   BuildingKind: it must resolve to glb or procedural).
//   Also add a `hullSizeFor(kind)` case — the render footprint convention
//   that MODEL_PATHS scales are measured against (there is a default
//   'infantry-ish' fallback, so a missing case is silent, not loud).
//
// STEP 4 — surface treatment (render/entitySurfaces.ts).
//   Add a row to `KEY_TREATMENTS: Record<string, KeyTreatment>` for the new
//   MODEL_PATHS key: which of the 16 procedural surfaces to layer
//   (paintedMetal, camoGreen/Desert/Navy, gunmetal, tireRubber, concrete,
//   glassBlue, brickRed, woodPlank, canvasFabric, hullGray, rustMetal,
//   hazardStripes, roofGravel, sandbag), roughness/metalness/env response,
//   plus name-based overrides (e.g. Quaternius 'Shirt') and `uvWorldScale`
//   for UV-less geometry (box-projected via boxProjectUVs.ts at a fixed
//   world-units-per-tile so texel density is consistent).
//   `applySurfaceTreatment` runs ONCE at load inside `loadModels` —
//   per-load material clones, never per-view, so the hot path pays nothing.
//   The 16 surfaces live in surfaceTextures.ts (seeded mulberry32 pixel
//   generation — pure/Node-testable, zero third-party IP, zero download
//   weight; tileable by construction, pinned by the seam-vs-grain test) and
//   the shared materials in surfaceMaterials.ts (ONE shared
//   THREE.MeshStandardMaterial per category; tintable surfaces are
//   luminance-biased for the team-color contract; never mutate a shared
//   instance — clone once per team).
//   Procedural builders tag materials via `surfaceMaterial()` (and
//   `userData.surfaceCategory` — a test proves no builder part was left on
//   a bare flat material). A metals-shading prerequisite: `renderer.ts`
//   `applyEnvironmentLighting` attaches a shared procedural equirect
//   environment map at game start, so metalness/roughness shade correctly
//   (legacy THREE.PMREMGenerator is WebGLRenderer-only and crashes on
//   WebGPURenderer — do not use it).
//   NOTE: KEY_TREATMENTS is `Record<string, ...>` too — a forgotten row is
//   not a compile error, but `tests/render.entitySurfaces.test.ts` has a
//   'covers every MODEL_PATHS key' test. Without a row, a GLB wears its
//   authored materials raw — for space-kit models that means
//   metalness=1 shading almost black.
//
// STEP 5 — palette registration (ui/palettes.ts).
//   Add the kind to `TRAIN_TABS` (4 tabs: infantry/armor/air/navy) or
//   `BUILD_TABS` (7 tabs: housing/civic/commerce/industry/utilities/
//   navalAir/special). Every kind must appear in exactly one tab; a missing entry
//   means the entity exists in the sim but no UI can train/place it.
//   `unitAvailability` / `buildingAvailability` mirror the sim command
//   validation (age → production building → affordability → manpower) so
//   buttons grey out exactly what the sim would reject; cost formatters and
//   tooltips (`formatTrainCost`, `buildTooltip`, coast rule for navalYard)
//   come along automatically.
//
// STEP 6 — icon + strings (ui/icons.ts, ui/strings.ts).
//   Add a glyph to `UNIT_ICONS: Record<UnitKind, string>` /
//   `BUILDING_ICONS: Record<BuildingKind, string>` — these ARE compile-
//   enforced (`tsc` fails on a missing entry). Icons are hand-drawn inline
//   SVGs (24×24 viewBox, stroke=currentColor), always paired with a text
//   label (user directive 2026-09-30; aria-hidden, never icon-only). Adding
//   an icon is ~1 line; the deliberate rejection of rendered GLB
//   thumbnails is recorded in the icons.ts header (build pipeline cost,
//   150–400KB of PNGs, worse legibility at button size).
//   Add names to `STRINGS.unitNames` / `STRINGS.buildingNames` in
//   ui/strings.ts — English-only UI copy with the `{en}` localization
//   indirection kept as the extension point (see docs/I18N.md).
//
// STEP 7 — placement / orders (ui/orders.ts, ui/placement.ts, ui/game.ts).
//   Training and building reuse existing commands: `buildTrainOrder` →
//   `spawnUnit`, `buildPlaceBuildingOrder` → `placeBuilding`
//   (ui/orders.ts builders are the only place command shapes are defined;
//   the sim re-validates at enqueue AND apply). Map clicks resolve through
//   the pure resolvers in ui/placement.ts
//   (`resolveBuildToolClick`/`resolveTrainClick`) to either an OrderIntent
//   or a human-readable hint — nothing fails silently. The controller
//   (ui/game.ts) arms placement modes per tool; the `BuildTool` union
//   ('road'|'zoneR'|'zoneC'|'zoneI'|`building:${BuildingKind}`|'demolish')
//   plus the build-tools row in hud.ts (5 tools: road, 3 zones, demolish)
//   is where new drag-paint tools (power-line, pipe) hook in.
//   Road drag-paint is the precedent: `game.ts` accumulates `roadDragCells`
//   from canvas pointerdown and emits one `buildRoadOrder` on pointerup
//   before the select path runs.
//
// STEP 8 — session + AI awareness (ui/session.ts, game/src/sim/ai.ts).
//   New production buildings/units need the AI to know about them: the
//   Classic AI builds virtual production buildings in priority order and
//   trains from counter tables + base-mix shares (`game/src/sim/ai.ts` —
//   see the sim audit). A unit no AI table references is trained by no AI
//   and countered by no AI. Upgrade research flows through
//   `registerUpgradeCommands` in session.ts (wires `buildResearchUpgradeOrder`
//   → sim `researchUpgrade`).
//
// STEP 9 — tests (game/tests/).
//   The completeness tests above run automatically; add unit tests for any
//   new sim mechanics (command validate/apply, digest/snapshot stability),
//   surface-treatment correctness for the new key, and paletteDigest
//   coverage if new panels render new values (see §5).
//
// Checksum rule of thumb: a new entity is ~10 small edits across these
// files; 8 of the 10 degrade loudly (compile error or a failing
// completeness test) and 2 degrade silently (MODEL_SOURCES row →
// placeholder; hullSizeFor case → 'infantry-ish' default).

// ===========================================================================
// 2. COST PER NEW ENTITY (the budget math)
// ===========================================================================
//
// DOWNLOAD (startup)
//   Today: 58 MODEL_PATHS keys → 55 unique GLB files → ~4.62 MiB at game
//   start (rifleman.glb keyed 3×, building-e.glb 2× — per-key normalization,
//   loaded once per unique file) + ~0.83 MiB of CC0 tree textures =
//   ~5.45 MiB total startup asset download, against an 8 MiB startup budget
//   gate (docs/research/trees.md:139). Time budget: ~20 s overall
//   (`MODEL_LOAD_ALL_TIMEOUT_MS` in ui/game.ts); all 58 loads run
//   concurrently, each with its own 15 s deadline — boot never hangs.
//   R3 (2026-10-01): the 5.45 MiB was raw bytes with no gzip credit;
//   byte-measured boot payload transfers 4.11 MiB (51.3% of the gate),
//   pinned by game/tests/render.boot-budget.test.ts.
//   Per-key average: 4.62 MiB / 58 ≈ 80 KiB/key (the packs are low-poly:
//   hundreds–low-thousands of triangles per model, max 11.4k in the
//   library; 350,308 tris across all 942 vendored files, but only the 55
//   mapped files download at runtime).
//   HEADROOM: ~2.55 MiB ≈ ~30 more average-size GLB keys before the 8 MiB
//   gate is hit. The expansion wants dozens more of each — it does NOT fit
//   in the current all-at-boot `loadModels(MODEL_PATHS)` shape. Options:
//   (a) lazy-load per tab/age (models load when the palette tab first
//   opens), (b) run gltf-transform optimize (meshopt, ~3× decode —
//   recommended in docs/research/tech-stack.md §4; CI gates: hero <3MB,
//   secondary <500KB), (c) procedural-first for infrastructure (zero
//   download), (d) raise the budget with measurement on target hardware.
//
// GPU MEMORY / TEXTURES
//   The 16 procedural surfaces are cached THREE.DataTextures shared across
//   every key — ~0 marginal VRAM per new entity. GLB textures: Kenney kits
//   share one `colormap.png` atlas per pack; per-load materials are clones
//   but textures are shared per file (disposeModels guards double-dispose
//   with a Set). Rule-of-thumb budget: ≤256 MB texture VRAM (tech-stack.md
//   §8). Procedural trees: 5 CC0 textures (~0.83 MiB download).
//
// DRAW CALLS (the binding constraint)
//   Entity views are per-view THREE.Groups — NOT instanced. Per visible
//   entity: merged meshes per distinct material (Kenney colormap models =
//   1 mesh; Quaternius multi-material = several; procedural composites =
//   1 per surface category) + 1 health-bar sprite + 1 selection ring when
//   selected ≈ 2–8 draw calls per entity. Geometry AND materials are
//   SHARED across all views of a kind (GLB assets arrive merged per
//   material via extractModelGeometry + BufferGeometryUtils.mergeGeometries;
//   procedural models cached per kind), so the 2nd copy of a kind is cheap
//   GPU-side — but it still costs its own draw calls.
//   Mid-range budget: ≤100–200 draw calls at 60 fps (tech-stack.md §8
//   rule; ~0.1 ms CPU per call). "Thousands of entities" at 2–8 calls each
//   is 2,000–16,000 calls — an order of magnitude over budget. The nature
//   scatter shows the escape hatch: one InstancedMesh per (prop × part) —
//   the whole forest (~300 props worst case, ~90k tris) is 18 static draw
//   calls. Entity rendering has NO such path today.
//
// TRIANGLES
//   Hundreds–low-thousands per model (library max 11.4k). In-scene rule:
//   ≤300k–750k tris/frame desktop (tech-stack.md §8). Trees: ~186–428
//   tris/tree (docs/research/trees.md: tri budget ≈ 250–350/tree).
//
// CPU PER FRAME
//   EntityRenderer.sync diffs the world against live views every frame:
//   per entity ≈ one `heightAt` bilinear sample (O(1), terrainHeight.ts —
//   buildings sample once at creation at footprint center +0.05, units
//   re-sample per frame as they move; sea units float at waterLevel, air
//   keep their hover), yaw + matrix update. Construction views use
//   transient per-view material clones (released on completion — no
//   cross-talk, pinned by test). Road ribbon + dashes rebuild only when
//   the road digest changes (FNV over cell indices). Per-kind costs are
//   one-time; per-view costs are O(entities). Fine today; watch the sync
//   loop if entity counts ×3 with richer per-view objects.

// ===========================================================================
// 3. ASSET-SOURCING STRATEGY OPTIONS for "many new great-looking models"
// ===========================================================================
//
// Option A — more CC0 kits (Kenney/Quaternius/poly.pizza), same pattern.
//   The proven path: vendor into game/public/models/<kit>/, license
//   evidence per file in THIRD_PARTY_NOTICES.md + MANIFEST.md (CC0 1.0
//   Universal — public domain, attribution not legally required; credited
//   anyway), runtime mapping in models.ts. Strengths: AAA-adjacent look,
//   no modeling labor, license-verifiable for AGPL distribution, coherent
//   low-poly style. Weaknesses: finite coverage — the current roster
//   already exhausts the obvious fits (artillery, aa, fighter, transport,
//   drone, destroyer, apc, mlrs, fighterBomber, attackHeli, frigate,
//   submarine, carrier, quarry, monument, mediaCenter, stormArray are all
//   procedural gap models precisely because no good CC0 fit existed).
//   The 942 vendored files (~27.4 MiB, only 55 mapped) are a spares pool:
//   `kenney-roads/` (already vendored, 1.7 MiB — electricity poles + wires,
//   road tiles, street lamps, bridges, traffic signs) covers power-line and
//   road-class visuals with zero new sourcing; `kenney-watercraft/` has
//   cargo ships/ocean liners for cargo/fuel ships; `kenney-space/` has
//   turrets (AA/sentry candidates) and dishes (radar candidates);
//   `kenney-industrial/` has solar panels/wind turbines for more plant
//   variants. But the next 40–60 entities will hit the coverage wall hard
//   (civilian airliners, submarines variants, carriers with detail, missile
//   plants...), and every sourced model needs manual scale fitting
//   (normalizeModel measurement) + a surface-treatment row + triage of its
//   material family (colormap / flat / UV-less / metalness=1-black).
//
// Option B — procedural builders (proceduralModels.ts pattern).
//   Zero download, deterministic by construction, no license to vet, and
//   the team already ships 17 gap kinds this way with real surface
//   materials. Ideal for infrastructure: power poles/wires, pipes,
//   runways, hangars, missile silos, depots — linear/repetitive geometry
//   where authored meshes buy little. The honest limit (recorded
//   2026-09-30): "base models are low-poly by authorship — textures make
//   materials read but can't fix faceted silhouettes." The user directive
//   is AAA-feeling, explicitly not blocky — procedural must stay
//   smooth/detailed (the existing builders are never blocky per the
//   module contract) or it will read as placeholder.
//
// Option C — generated/AI-made 3D models.
//   Rejected for this project. Training-data provenance is unverifiable,
//   which breaks the THIRD_PARTY_NOTICES.md license-evidence pattern the
//   project relies on for AGPL-3.0-only distribution, and style coherence
//   across dozens of generated assets is poor. Do not source here.
//
// Option D — commission bespoke models.
//   Best visual ceiling, but a procurement/labor step outside the current
//   workflow; not the default.
//
// Recommendation: hybrid A+B. Mine the vendored spares first (kenney-roads
// poles/wires/road tiles, watercraft cargo ships, industrial tanks/turbines)
// for anything they cover; procedural-first for networks and infrastructure
// (power lines, pipes, rail, runways) where linear geometry dominates; new
// CC0 sourcing only for hero entities (airliners, carriers, submarines,
// bombers) with the full license-evidence workflow. Whatever the mix, the
// download budget forces one of: lazy per-tab/per-age loading, gltf-transform
// optimize (meshopt, per tech-stack.md §4), or a raised budget — decide
// before the roster doubles.

// ===========================================================================
// 4. UI PATTERNS THAT MUST SCALE
// ===========================================================================
//
// TABBED PALETTES (ui/palettes.ts + ui/hud.ts)
//   4 train tabs / 6 build tabs hold 28+28 today; the expansion wants 2–3×
//   the entries. Adding entries is data-only (append to TRAIN_TABS /
//   BUILD_TABS), but the tab bar itself needs a design answer at 8–12 tabs
//   and 10–15 entries per tab: more tabs (e.g. split naval/air, a
//   logistics tab), scrollable tab rows, or sub-tabs. The BUILD_TABS 6-tab
//   spec grouping (housing/commerce/industry/utilities/navalAir/special)
//   will not survive 60+ buildings unchanged — plan a new grouping.
//   Availability grey-out (unitAvailability/buildingAvailability mirrors)
//   stays correct automatically as long as new defs carry minAge /
//   requiredBuilding / costs.
//
// THE DIGEST CONTRACT (ui/paletteDigest.ts)
//   hud.ts rebuilds the selection panel ONLY when the content digest
//   changes — node-stable buttons across frames is what makes real clicks
//   work (the 2026-09-30 click-bug root cause: per-tick DOM rebuilds).
//   paletteDigest.ts mirrors the updateSelection render branches: any new
//   panel (airline management, logistics overlay, intel panel, veterancy
//   display) that renders a value MUST digest it, or it will either go
//   stale or need a per-frame rebuild that reintroduces the bug. New panel
//   types should follow the research-panel precedent (hud.ts appendResearch
//   pattern) with their own digest branches.
//
// NEW DRAG-PAINT TOOLS (power lines, pipes, rail)
//   The road tool is the pattern: BuildTool union + hud.ts tools row +
//   game.ts pointerdown→pointerup cell accumulation (`roadDragCells`) +
//   a single order on pointerup (buildRoadOrder) + pure placement.ts
//   resolver. Power-line/pipe tools are a second and third instance of
//   this pattern — factor a generic linear-network gesture path instead of
//   copy-pasting roadDragCells twice, because each copy is a new place to
//   break click-vs-drag classification (ui/pointer.ts classifyPointerUp).
//   The sim side needs the network layers themselves (topology, zone-level
//   hookup) — see the sim audit.
//
// AIRPORT ZONES / AIRLINE MANAGEMENT / LOGISTICS OVERLAYS / INTEL PANEL /
// VETERANCY / PEACEFUL MODE
//   These are new UI surfaces, not palette entries: they need new HUD panel
//   types (hud.ts), new order builders (ui/orders.ts) + new sim commands
//   (game/src/sim/commands.ts specs, validate at enqueue AND apply), new
//   tabs/panels with digest coverage, and icons.ts additions (toolIcon for
//   new tools). Overlays (logistics, power grid) follow the render-side
//   precedent of selection rings and superweapon FX
//   (entities.ts syncSuperweaponFx: sim-published fx records → per-frame
//   read-only views, keyed by identity, disposed on expiry) — overlays are
//   render views of sim data, never sim state in the UI.
//
// STRINGS + ICONS (user directives 2026-09-30)
//   English-only game copy via ui/strings.ts ({en} indirection kept for
//   future languages — docs/I18N.md); every palette/menu button shows icon
//   AND text (Record<UnitKind>/Record<BuildingKind> make missing glyphs a
//   compile error).

// ===========================================================================
// 5. TOP 5 RENDER/UI RISKS
// ===========================================================================
//
// RISK 1 — Draw-call ceiling vs. entity-count ambition (SEVERITY: high).
//   Entity views are per-view THREE.Groups, not instanced: ~2–8 draw calls
//   per visible entity (merged per-material meshes + health sprite +
//   selection ring) against a ≤100–200 call budget at 60 fps on mid-range
//   (docs/research/tech-stack.md §8). Dozens of new kinds × 2–3× more
//   entities will blow past this long before the triangle budget binds.
//   Mitigation: an instancing path for entity views (the nature scatter
//   proves the pattern: 18 static draw calls for the whole forest), LOD or
//   far-field impostors, or capping simultaneous visible entities. This
//   needs a benchmarked decision before the roster grows — it is the one
//   risk that can make the expansion's core promise ("many more units")
//   unshippable at 60 fps.
//
// RISK 2 — Startup download budget (SEVERITY: high).
//   8 MiB gate; 5.45 MiB already spent (4.62 MiB GLB + 0.83 MiB tree
//   textures). ~30 more average-size keys fit; the expansion wants 60+.
//   R3 (2026-10-01): the 5.45 MiB was raw bytes; byte-measured boot
//   payload transfers 4.11 MiB (51.3% of the gate) — the lazy-loading
//   mitigation this risk called for already landed and holds.
//   `loadModels(MODEL_PATHS)` is all-at-boot today. Mitigation: per-tab /
//   per-age lazy loading, gltf-transform optimize with meshopt + WebP
//   (already the documented direction in tech-stack.md §4), procedural-first
//   for infrastructure. Pick the mechanism before adding keys.
//
// RISK 3 — The digest contract at panel scale (SEVERITY: high).
//   The 2026-09-30 click bug (per-tick DOM rebuilds breaking real clicks)
//   is one careless panel away from returning. Every new management panel
//   (airline, logistics, intel, veterancy) must digest its rendered values
//   in paletteDigest.ts; a branch that renders without digesting either
//   goes stale or forces a rebuild that breaks clicks. Mitigation: a
//   checklist in the panel-building workflow + a test that every hud
//   panel branch is digest-covered (the digest module is pure and
//   headless-testable).
//
// RISK 4 — Surface-treatment coverage at 2–3× roster (SEVERITY: medium).
//   Each new GLB needs material-family triage (Kenney colormap / flat
//   PBR / UV-less Quaternius / metalness=1-that-shades-black) + a
//   KEY_TREATMENTS row + box-projection scale choice; a wrong row ships a
//   black or flat model. Coverage is test-pinned (every MODEL_PATHS key)
//   but correctness is manual review per model — it scales linearly with
//   the roster. Mitigation: default-treatment heuristics per kit family
//   (most Kenney kits share the colormap treatment), plus a visual review
//   pass per batch in the plan's step gates.
//
// RISK 5 — Linear-network tools multiply gesture paths (SEVERITY: medium).
//   Power lines, pipes, and rail are three more drag-paint tools on top of
//   roads. The road path (roadDragCells in game.ts → buildRoadOrder →
//   sim buildRoad) is one-off, not generic; three copies of it triple the
//   surface for click-vs-drag misclassification (ui/pointer.ts) and
//   placement-mode bugs. Mitigation: generalize one linear-network gesture
//   pipeline (accumulate cells → emit network order) that all line/pipe/
//   rail tools share, with the network kind as a parameter; the sim side
//   needs matching network layers (see the sim audit).
//
// Honorable mention — kit style drift: every new CC0 kit must be vetted
// against the low-poly, non-blocky art bar; Quaternius/Kenney mix today
// because both read as the same hand-painted family. A kit that clashes
// (photoreal scans, voxel sets) breaks the AAA-feeling bar the user set.
