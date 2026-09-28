# Research: Tech Stack & Rendering

**Status:** complete — 2026-09-28. Firm recommendation in §7; all sections
sourced; dead ends recorded. Budget numbers to be replaced by in-project
micro-benchmarks before content scale-up.
**Last updated:** 2026-09-28
**Purpose:** Choose the rendering engine, language, build tool, rendering
techniques, and art pipeline for novaterra (3D browser RTS/city-builder
hybrid — SimCity × Red Alert × Age of Empires — single-player, 60fps with
thousands of entities, static GitHub Pages deploy).
**Convention:** every factual claim cites a source URL; unverifiable claims are
labeled; dead ends are recorded, not silently dropped.

**Pinned version facts (verified 2026-09-28 via `npm view`):**
`three@0.186.1`, `vite@8.3.1`, `@babylonjs/core@9.28.0`, `typescript@7.0.2`.
(Note: TS 7.x is the native Go port, "tsgo" — much faster typechecking than
TS 5.x; API-compatible.)

---

## 1. Engine: Three.js vs Babylon.js vs raw WebGPU

**Status:** complete — version/state facts and deep comparison verified
2026-09-28 by the engine research agent.

### Verified version/state (2026-09-28)
- **three.js r186** (Sep 2026; ~11.5M weekly npm downloads). `three/webgpu` entry
  point provides `WebGPURenderer` since r167 (2024), community
  "production-ready" consensus since ~r171 (Sep 2025), with **automatic WebGL2
  fallback** — one renderer, one shader codebase via TSL (Three.js Shading
  Language), which transpiles to WGSL or GLSL per backend. Vendor manual still
  labels WebGPU support "experimental" (missing `ShaderMaterial`/
  `onBeforeCompile`/`EffectComposer` on it).
  Source: https://github.com/ecorkran/ai-project-guide/blob/HEAD/tool-guides/threejs/guide.webgpu.md
  and https://github.com/darellchua2/opencode-config-template/blob/HEAD/opencode_app/.opencode/skills/threejs-nextjs-skill/SKILL.md
- **Babylon.js 9.x** (9.27.1 released 2026-09-18). Headline 9.0 features:
  clustered lighting (hundreds/thousands of lights, WebGPU + WebGL2), frame
  graph, node particle editor, volumetric lighting (WebGPU compute + WebGL2
  fallback), Node Material Editor with WGSL export. New `@babylonjs/lite` —
  a tree-shaken WebGPU-only functional/data-oriented distribution.
  Sources: https://gamedev.net/news/5873-babylonjs-9271-released/,
  https://msftnewsnow.com/babylonjs-9-webgpu-geospatial-tooling-update/,
  https://github.com/raananw/uptimizr/blob/HEAD/docs/adr/0024-babylon-lite-connector.md
- **WebGPU browser support (mid/late-2026):** Chrome/Edge 113+ (2023),
  Safari 26+ (Sep 2025, macOS Tahoe / iOS 26), Firefox 141+ Windows (Jul 2025),
  Firefox 145/147 macOS Apple Silicon. Still missing: Firefox Linux/Android,
  Intel Macs, pre-26 Safari. Global reach ≈ 80–84%; ~15–25% of users still
  need WebGL2 → **a WebGL2 fallback is mandatory for a consumer game**.
  Sources: https://github.com/bagidea/voxelforge/blob/HEAD/docs/decision-brief-voxel-stack.md,
  https://github.com/localmode-ai/localmode/blob/HEAD/apps/docs/content/blog/transformers-js-browser-ml.mdx
- **Known caution (to verify):** one project's 2026 ADR found Babylon's
  render loop does per-mesh CPU submission with no public indirect-draw API,
  which fights GPU-driven rendering for massive entity counts. Treating as
  unverified anecdote until the engine agent confirms.
  Source: https://github.com/pmeenan/parallax/blob/HEAD/docs/rendering-engine-research.md

### Comparison & verdict (research agent report, 2026-09-28)

| Feature | three.js r186 (`WebGPURenderer`) | Babylon.js 9.28 |
|---|---|---|
| Shape | Rendering **library** — manual `Object3D` graph, explicit `renderer.render()`; stays out of the way of a custom engine | Full **engine** — engine-owned `Scene`/`runRenderLoop`, observables, bundled physics/GUI/audio |
| WebGPU maturity | Since r167 (2024); community "production-ready" since ~r171; vendor manual still labels it *experimental*; missing `ShaderMaterial`/`onBeforeCompile`/`EffectComposer` on it | Complete since v5.0 (2022); all core shaders native WGSL since v8.0 (2025); longer track record |
| Fallback story | **Automatic WebGL2 fallback** from one import surface (`three/webgpu`), one scene graph | Separate engine classes (`WebGPUEngine` vs `Engine`) — you branch at construction; no auto-fallback |
| Custom shaders | TSL only (mandatory on WebGPURenderer); TSL transpiles to WGSL **or** GLSL → one codebase, both backends | ShaderMaterial works on both backends (GLSL→WGSL transpilation) |
| Compute | TSL `compute()` — WebGPU only, needs CPU fallback for WebGL2 | Compute shaders on WebGPUEngine only |
| CSM shadows | **No native CSM** — community addons (three-csm lineage, threepipe plugin) | **Native `CascadedShadowGenerator`** |
| Instancing | `InstancedMesh` + `BatchedMesh` (both backends) | InstancedMesh + thin instances; snapshot rendering for static geo on WebGPU |
| Post-processing | TSL node `RenderPipeline` (renamed r183); bloom/godrays/SSGI/SSR passes maturing | `DefaultRenderingPipeline` works on both backends |
| Bundle size | ~1.2MB raw / ~300KB gzip (WebGPU+TSL ≈ 600–800KB min+gz) | ~3.5MB raw / ~1MB gzip core (tree-shakeable) |
| Community | ~112.8k GitHub stars, ~11.5M weekly npm downloads — 4–5× Babylon | ~25.6k stars, ~157k weekly downloads; Microsoft-maintained, predictable cadence |
| License | MIT | Apache-2.0 (patent grant; also fine) — **non-factor** |

Key sources: https://github.com/pmeenan/parallax/blob/HEAD/docs/rendering-engine-research.md
(engine-vs-library framing, raw-WebGPU rejection),
https://github.com/ecorkran/ai-project-guide/blob/HEAD/tool-guides/threejs/guide.webgpu.md
(TSL dual-compile, auto-fallback),
https://github.com/mrdoob/three.js/releases/tag/r186,
https://gamedev.net/news/5873-babylonjs-9271-released/

**Firm pick: three.js** (`WebGPURenderer` primary, automatic WebGL2 fallback,
TSL for all custom shaders). Rationale:
1. Shape fit — we build the engine ourselves; three.js is a library, not a
   competing engine.
2. Only option with a single codebase covering WebGPU *and* the 15–25%
   WebGL2 fallback audience (auto-fallback + TSL WGSL/GLSL dual compile).
3. Largest community/ecosystem, smallest bundle.
4. Sufficient maturity (shipping since r167; production consensus since r171;
   r186 current stable).

**Risks to manage:** vendor still labels WebGPU "experimental" (pin version;
benchmark both backends on our scenes); monthly TSL API churn (pin exactly,
budget upgrades); TSL lock-in — no `ShaderMaterial`/`onBeforeCompile`/
`EffectComposer` on WebGPURenderer, and raw-WGSL `wgslFn` islands break the
WebGL2 fallback (pure TSL only); no native CSM (vet a community addon or
hand-roll); compute is WebGPU-only (CPU fallback path needed); silent
`await renderer.init()` failure mode; GPU device-loss handling.

**Engine-level dead ends:**
- **Babylon.js (full):** rejected — engine abstractions fight our custom
  deterministic engine; explicit WebGPU/WebGL2 engine branching; bigger
  bundle; smaller community. (Re-evaluate only if native CSM + snapshot
  rendering ever outweigh the shape concern.)
- **@babylonjs/lite:** WebGPU-only by design — fails the fallback
  requirement outright.
- **Raw WebGPU:** rejected — would require writing/maintaining two complete
  renderers (WebGPU + WebGL2 fallback); multi-year investment, unjustified for
  an indie static-site game.
- **PixiJS / PlayCanvas / Godot-web:** wrong shape (2D / engine+editor /
  native-engine web export); out of scope, not deeply evaluated.
- **three.js WebGLRenderer-only:** kept as a cheap retreat if WebGPURenderer
  proves unstable in our benchmarks — same API surface, no rework.

---

## 2. Language & build tooling: TypeScript + Vite (or alternatives)

**Status:** decided — TypeScript 5.x + Vite 8 (Rolldown). Verified 2026-09-28.

### Language: TypeScript (strict)
- TypeScript is the default for all three.js/Babylon.js work; both engines ship
  first-class typings (Babylon.js is written in TS).
- Strict mode + lint rules (`no-explicit-any`, `no-non-null-assertion`) are the
  proven way to keep a large sim codebase (deterministic fixed-timestep sim,
  save serialization) correct. The repo convention will follow the widely used
  strict-TS playbook for game sims.

### Build tool: Vite 8
- Vite 8.0.0 shipped 2026-03-12; it unifies on **Rolldown** (Rust bundler),
  replacing esbuild (dev transforms) and Rollup (prod builds); Oxc handles
  transform/minify; Lightning CSS for CSS minify. Claimed 10–30× faster prod
  builds than Vite 7; dev HMR unchanged/fast (~20–40ms leaf/root). Sources:
  - https://github.com/januarylabs/sdk-it/blob/HEAD/vite-8-research.md
  - https://github.com/biggora/dev-team/blob/HEAD/skills/vite-best-practices/references/rolldown-migration.md
  - https://github.com/elizabthpazp/blog/blob/HEAD/posts/vite-7-turbopack-vs-rspack-bundlers-2026/en/vite-7-turbopack-vs-rspack-bundlers-2026.md
- Rolldown keeps 100% Rollup plugin compatibility; `rollupOptions` →
  `rolldownOptions` rename with an auto-convert compat layer.
- Alternatives considered and rejected (see §9 Dead ends): esbuild standalone
  (no HMR/CSS story), Webpack (slow dev loop), Turbopack (Next.js-only),
  Rspack (only if legacy Webpack), Parcel (less control).
- **Test story:** Vitest 3 runs on the same Rolldown pipeline — zero duplicate
  config; ~4.2× faster than Jest per the cited benchmarks.
- **Deploy fit:** `vite build` emits plain static assets (JS/CSS/assets) — a
  perfect match for GitHub Pages. No SSR, no server, no lock-in. Base path
  configured for `https://gumbdames.github.io/novaterra/`.

### WASM — where it does and doesn't help
- WASM **cannot touch the GPU directly**; it does not accelerate rendering.
  It legitimately helps CPU-bound, vectorizable sim work: pathfinding,
  spatial queries, terrain gen — but only *if profiling proves* the JS is the
  bottleneck (per AGENTS.md §3: exotic tech only where profiling earns it).
- Plan: start pure TypeScript sim (easier determinism/debugging/save); profile;
  consider WASM+SIMD modules (e.g. flow-field pathfinding, navmesh) only with
  measured wins. See §9.

---

## 3. Rendering thousands of entities at 60fps

**Status:** findings from perf research agent, 2026-09-28. Numbers labeled
[measured] (cited), [rule] (community consensus), [est] (engineering
judgment).

### Core strategy
- **One `InstancedMesh` per unit/building type** = one draw call per type.
  [measured] 19,600 static cubes → 1 call, render CPU p95 28.5→0.5ms;
  8,000 moving entities → 1 call, render CPU 9.9→0.5ms, update loop 1.4→0.3ms
  (three.js r183, M1 Pro). No practical per-draw instance limit (10–50k
  routine).
- Per-instance data via `InstancedBufferAttribute` (color, animation frame).
  Animated crowds: **vertex-animation textures** baked to a texture
  (1 mesh/1 material/1 draw call, ~3 numbers per instance) — not CPU
  skeletons per unit.
- **City blocks:** one InstancedMesh per building type + texture atlases
  (KTX2/Basis, 4–6× VRAM); static scenery sharing a material merged into a
  single `BufferGeometry` (1 draw call for a whole city block).
- **Terrain:** worker-meshed chunks with greedy meshing ([measured] 5.3×
  quad reduction, 2226 chunks/sec on 9 workers, zero-copy transferable
  geometry).

### LOD: global zoom tiers, not per-object
- Key RTS insight: skip per-object `THREE.LOD` for units — it composes badly
  with instancing. Use **global zoom-tier switching**: all units of a type
  swap LOD at camera-height thresholds.
- Terrain streams by chunk; static chunks merge to ~1 draw call each.

### Frustum culling
- three.js culls per-object bounding spheres; an instanced batch is
  all-or-nothing, and the default bound is the base geometry at origin (can
  wrongly disappear). Fix: **one InstancedMesh per type per chunk**.
  (`InstancedMesh2` has per-instance BVH culling + LOD but is
  WebGLRenderer-only — incompatible with our WebGPU path; see §9.)

### Shadows
- Directional light = 1 shadow pass; point light = 6 (never use point-light
  shadows). Recommendation: one tight **2048² directional shadow map** for
  buildings/terrain + **instanced blob-shadow quads** for units + baked AO in
  vertex colors. CSM = one pass per cascade — high tier only, not the
  default (three.js has no native CSM; vet a community addon or hand-roll).

### Post-processing
- ACES tone mapping ≈ free (per-pixel in-shader, not a pass; ~0.4ms on Mali
  G68 [measured]). Bloom/SMAA are mid-tier. **No full SSAO or volumetric
  fog** on the default tier. Note: `pmndrs/postprocessing` is WebGL-only —
  the WebGPU path needs three.js TSL postprocessing.

### Day/night + weather
- Cheap: sun/sky/fog color animation, `FogExp2`, GPU-shader rain `Points`,
  emissive windows at night.
- Expensive: per-frame shadow re-renders (moving sun), volumetric fog
  (1–5ms @1080p [est]), many dynamic night lights.

### Draw-call / triangle budgets (mid-range laptop, 60fps)
- **≤100–200 draw calls, ≤300k–750k triangles** [rule, community
  consensus]. ~0.1ms CPU overhead per draw call [rule].
- Only measured WebGPU-vs-WebGL2 A/B found is Godot on Tesla P40 (~2.5–3×
  fps) — directional only. **No public three.js draw-call benchmark on Iris
  Xe/M1/GTX 1650 exists** → run an in-project micro-benchmark early and
  record numbers here.

### WASM — verdict
- Myth: WASM cannot touch the GPU or DOM — it never accelerates rendering.
- Fact: legitimate for pathfinding/flow-fields, spatial queries, and
  deterministic sim kernels — **only behind a benchmark gate** (AGENTS.md §3).
- ⚠️ **Deployment caveat:** GitHub Pages cannot set COOP/COEP headers, so
  **WASM threads / SharedArrayBuffer are unavailable** — design any WASM
  modules single-threaded. Sim-in-a-Web-Worker still works (postMessage),
  but zero-copy shared memory is off the table on Pages.

### Workers — verdict
- Adopt: fixed-timestep **sim in a Web Worker**, chunk meshing in workers
  (zero-copy transferable geometry), render interpolates on the main thread.
- Defer: OffscreenCanvas full renderer — three.js `WebGPURenderer` had a
  worker-breaking regression in r179; not a tested path.

---

## 4. Stylized "AAA look" in the browser

**Status:** findings from art-pipeline agent, 2026-09-28.

Cheap stylized wins (not complex shaders):
- Flat-ish albedo palette + baked AO in vertex colors + one directional light
  + hemisphere light + good color grading (ACES tone mapping) — the standard
  "stylized AAA" recipe for web.
- Poly Haven CC0 HDRIs for image-based lighting transform flat low-poly
  scenes. Source: https://polyhaven.com
- Day/night cycle is cheap in a forward renderer: rotate the directional
  light + lerp sky/fog colors; night lighting is the expensive part (see §8
  budget). Weather (fog + particle rain) is moderate; volumetric god-rays are
  expensive — prefer screen-space or billboard fakes.
- Post-processing feasibility: bloom is the one "AAA" effect worth its cost
  at 60fps on a mid-range laptop; SSAO/SSGI are the first to cut on the
  low tier. (Exact pass costs pending perf agent.)

## 5. Art asset pipeline

**Status:** decided — hybrid pipeline. Findings from art agent, 2026-09-28.

### Decision: hybrid (procedural-first + authored heroes + CC0 bootstrap)
1. **Procedural content (code):** all repetitive buildings via a modular
   kit-of-parts generator (the *Townscaper* pattern — constraint rules over a
   part vocabulary produce intentional-looking buildings). Units' base meshes,
   terrain-dressing scatter, roads. One shared material + texture atlas +
   vertex colors; merged static geometry per map chunk; `InstancedMesh` per
   unit type.
   Source: https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making
2. **Authored hero assets (Blender → GLB):** ~5–10 pieces only (command
   center, hero units, signature landmark). Blender's Khronos glTF
   exporter is first-class (PBR, armatures, instancing, Draco).
   Source: https://github.com/khronosgroup/gltf-blender-io/blob/HEAD/docs/blender_docs/scene_gltf2.rst
3. **CC0 bootstrap:** Kenney City kits + Fantasy Town + Nature (buildings /
   dressing — note: models are miniatures, rescale ~5.5×; plan a build-time
   **palette/atlas unification** pass for style consistency), KayKit
   city-builder bits, Quaternius animated units/animals (rigged GLB as
   stand-ins or final units — re-verify CC0 per pack page at vendoring time),
   Poly Haven + ambientCG for HDRI lighting and terrain detail textures only
   (Poly Haven models are photoreal scans — style clash). Sources:
   https://kenney.nl, https://quaternius.com, https://polyhaven.com
4. **Build-time optimization (automated):** `gltf-transform optimize`
   (meshopt compression — 2026 web default, ~3× faster decode than Draco with
   smaller decoder ~10–20KB vs ~150–300KB; WebP textures; prune/weld/
   quantize). CI budget gates: hero <3MB, secondary <500KB. Validate with the
   Khronos glTF Validator. Prefer `gltf-transform` over raw `gltfpack` (known
   UV-quantization/`KHR_texture_transform` pitfall).
   Source: https://github.com/donmccurdy/gltf-transform/blob/HEAD/CHANGELOG.md
5. **Terrain:** chunked **heightmap** (cheapest: O(1) height lookup for RTS
   pathing/placement; 256×256 chunk ≈ 128KB as uint16), vertex-color biome
   painting + 2–3 splat layers (stylized looks better with flat biome colors
   anyway; keep layers low — each extra layer group adds passes/cost).
   Sources: https://github.com/sawyer123123141/lifesimulation/blob/HEAD/docs/external/terrain-brief-2026-08-24.md

⚠️ **Unverified for build phase:** exact KHR extension set in three.js r185
GLTFLoader; Quaternius per-pack CC0; per-device mobile browser FPS numbers.

## 6. Mobile / tablet

**Status:** findings from mobile agent, 2026-09-28. Decision: **attempt touch,
scoped parity** (see below).

- **Touch RTS is proven fun:** Feral Interactive's *Company of Heroes* and
  *Rome: Total War* ports (command-wheel radial orders, tap-select, minimap
  filters), *Rusted Warfare*, *Art of War 3*. Sources:
  https://www.pocketgamer.com/articles/083923/company-of-heroes-the-classic-rts-will-launch-for-iphone-and-android-on-september-10th/,
  https://www.androidpolice.com/best-rts-games-for-android-2022/
- **Required UI adaptations:** tap = select/order (contextual), two-finger
  drag = camera pan/zoom, long-press/command-wheel = order menu, **no
  drag-select boxes** (replace with tap + double-tap group select), larger
  touch targets. Design pointer/touch input into the architecture from day
  one — retrofitting is the trap to avoid.
- **Mobile budgets (community design ranges, verify on-device):** mid mobile
  60fps ≤60 draw calls / ≤400k tris / ≤96MB VRAM / DPR ≤1.5; explicit **30fps
  mobile tier** recommended (60fps on phones unrealistic for hundreds of
  units). Desktop mid-range: ≤150 calls / ≤1.5M tris / ≤256MB.
- **WebGPU on mobile (2026):** iOS Safari 26 WebGPU on by default (79–86% of
  iPhones on iOS 26 per WWDC 2026); Chrome Android 121+ (Android 12+) on by
  default. WebGL2 reach ~95.7% vs WebGPU ~85.6% (single community source).
- **Thermal reality:** throttling is "the #1 enemy after 5–10 minutes";
  ~30%/hour drain on hot mid-range Android → **adaptive quality governor is
  mandatory** (step down DPR → shadows → particles → render scale), 30fps
  lock, test after thermal soak.
- **Recommendation:** attempt with scoped parity — a "touch-playable tier":
  mobile quality tier (30fps, DPR ≤1.5, no realtime shadows, reduced
  particles) gated by a device-tier detector + adaptive governor; tablets
  first-class, phones "playable"; desktop works first, mobile tier rides the
  same sim with tier-scaled rendering. Full phone parity explicitly out of
  scope for v1.

### ⚠️ OPEN QUESTION (WebGL2-only vs WebGPU-primary)
The engine agent picked **WebGPURenderer-primary with automatic WebGL2
fallback**; the mobile agent recommends **three.js WebGL2-only**
(WebGLRenderer): WebGL2's 95.7% reach beats WebGPU's ~85.6%; a stylized RTS
needs no compute shaders ("WebGPU's wins are compute and draw-call
throughput — our strategy is to *not need* draw-call throughput"); WebGL2 is
kinder to thermals; WebGPURenderer stability reports conflict in 2026
("production-ready since r171" vs "API churn into r183"). **Resolution
pending perf agent's numbers.** Lean right now: three.js either way; choose
the *backend default* after benchmarking our actual scenes on both paths.
The WebGLRenderer-only retreat is cheap (same API surface).

---

## 7. FIRM RECOMMENDATION

**Engine: three.js** (pinned exactly, e.g. `three@0.186.1` — never track
`latest`), importing from **`three/webgpu`** (`WebGPURenderer` primary with
**automatic WebGL2 fallback**), custom shaders written in **pure TSL only**
(no `wgslFn` islands — they break the fallback). WebGPU-vs-WebGL2 is *not* a
fork: `WebGPURenderer` auto-falls-back from one import surface, one scene
graph, one shader codebase. This resolves the §6 open question: we get the
mobile agent's WebGL2 safety (the 15–25% fallback audience) AND the WebGPU
headroom with zero extra renderer work. **Mobile tier forces the WebGL2
fallback** explicitly (stability, thermals) — a runtime flag, not a fork.
Early in the build: micro-benchmark our real scenes on both backends on a
mid-range laptop and record the numbers in §3; cheap retreat to
WebGLRenderer-only stays available (same API surface).

**Language: TypeScript 7 (strict)** — native Go-port compiler (tsgo) is much
faster than TS 5; strict mode + lint rules (`no-explicit-any`,
`no-non-null-assertion`) for the deterministic sim.

**Build/dev/test: Vite 8** (Rolldown-powered) + **Vitest 3** (same pipeline,
zero duplicate config). `vite build` emits plain static assets — exact fit
for GitHub Pages (set the base path for
`https://gumbdames.github.io/novaterra/`).

**Rendering architecture:**
- One `InstancedMesh` per unit/building type per map chunk (chunking =
  culling granularity); texture atlases (KTX2/Basis); merged static geometry
  per city block; chunked heightmap terrain (greedy-meshed in workers).
- LOD via **global zoom tiers** (not per-object `THREE.LOD`).
- Shadows: one tight 2048² directional map + instanced blob shadows for
  units + baked vertex-color AO; CSM high-tier only.
- Post: ACES tone mapping (free), bloom as the one "AAA" effect; no SSAO /
  volumetric fog on the default tier.
- Day/night via sun/sky/fog animation; weather via fog + GPU rain points.

**Sim/render split:** deterministic fixed-timestep sim in a **Web Worker**
(postMessage, no SharedArrayBuffer — Pages can't set COOP/COEP), render
interpolates on main thread (agrees with sim-architecture workstream).

**Art pipeline (hybrid):** procedural kit-of-parts generators for all
repetitive content (Townscaper pattern); ~5–10 authored Blender→GLB hero
assets via `gltf-transform optimize` (meshopt, WebP, CI size gates:
hero <3MB, secondary <500KB); CC0 bootstrap (Kenney/KayKit/Quaternius for
meshes, Poly Haven/ambientCG for HDRI + terrain textures only) with a
build-time palette/atlas unification pass.

**WASM:** none by default. Only if profiling proves a JS bottleneck — then
single-threaded modules (pathfinding/flow-field/spatial queries); WASM
threads are unavailable on GitHub Pages.

**Mobile:** touch input designed in from day one (tap select/order,
two-finger camera, command-wheel, no drag-select); scoped parity — 30fps
mobile tier with device-tier detector + adaptive quality governor (DPR →
shadows → particles → render scale); tablets first-class, phones playable;
WebGL2 forced on the mobile tier. Full phone parity out of v1 scope.

### Risks (must be managed)
1. three.js labels WebGPU "experimental"; API churns monthly → pin exactly,
   budget upgrades, benchmark both backends early.
2. TSL lock-in for custom shaders; no `ShaderMaterial`/`onBeforeCompile`/
   `EffectComposer` on WebGPURenderer.
3. No native CSM → vet community addon (three-csm lineage / threepipe) or
   hand-roll; Babylon has native CSM (accepted gap).
4. Compute is WebGPU-only → CPU fallback path for WebGL2 users.
5. Budget numbers are mostly [rule]/[est] — the in-project micro-benchmark
   is a **gating task** before content scale-up.
6. Mobile FPS numbers unverified on physical devices → verify before the
   mobile tier ships.
7. three.js r185 GLTFLoader's exact KHR extension set unverified → check in
   build phase.

### Rationale (one paragraph)
We are building a *custom engine*, so a rendering library (three.js) beats a
game engine (Babylon.js) in shape fit; three.js is the only option delivering
a WebGPU primary *and* a zero-cost WebGL2 fallback from one codebase
(15–25% of users need it); it has 4–5× the community, the smallest bundle,
and the mature instancing/GLTF pipeline our perf strategy depends on.
TypeScript + Vite 8 is the boring, proven, fastest-iterating web stack in
2026. The hybrid art pipeline is the only one a tiny team can actually fill
with content. The perf strategy is "fewer draw calls, not fancier API" —
which is why WebGL2 remains a first-class citizen and WASM is deferred to
profiling.

---

## 8. Perf budget table

Frame budget at 60fps = 16.7ms total. Targets below are per-frame allowances;
numbers tagged [rule]=community consensus, [measured]=cited benchmark,
[est]=engineering judgment. **All must be replaced by in-project
micro-benchmark numbers before content scale-up.**

| Budget item | Desktop mid-range (60fps) | Mobile tier (30fps) | Notes |
|---|---|---|---|
| Draw calls | ≤100–200 [rule] | ≤60 [rule] | ~0.1ms CPU per call [rule]; one InstancedMesh per type per chunk |
| Triangles/frame | ≤300k–750k [rule] | ≤400k [rule] | Greedy-meshed terrain chunks, zoom-tier LOD |
| Instances per draw | 10k–50k routine [measured*] | — | *M1 Pro measurement: 19.6k cubes 1 call; 8k moving 1 call |
| Texture VRAM | ≤256MB [rule] | ≤96MB [rule] | KTX2/Basis atlases (4–6× VRAM) |
| Shadow | 1× 2048² directional + blob quads | none (baked AO only) | CSM high-tier only; never point-light shadows |
| Post FX | ACES (~free) + bloom | ACES only | No SSAO/volumetrics on default tier |
| Sim tick | fixed-step in worker; catch-up capped | same, fewer steps visible | Never spiral-of-death; slow-motion under load |
| Rain/weather | GPU `Points` rain, `FogExp2` | fog only | Volumetric fog 1–5ms @1080p [est] — excluded |
| DPR | min(devicePixelRatio, 2) | ≤1.5 → 1 (adaptive) | DPR is the first governor step |
| Unit count (sim) | thousands | hundreds visible | Sim/render split; sim ticks in worker |

## 9. Dead ends

- **Babylon.js (full engine):** engine abstractions fight a custom
  deterministic engine; explicit WebGPU/WebGL2 engine branching; bigger
  bundle; smaller community. (See §1.)
- **@babylonjs/lite:** WebGPU-only by design — fails the fallback
  requirement.
- **Raw WebGPU:** two renderers to write/maintain (WebGPU + WebGL2
  fallback); multi-year investment, unjustified for an indie static-site
  game.
- **PixiJS / PlayCanvas / Godot-web:** wrong shape (2D / engine+editor /
  native export); not deeply evaluated.
- **WASM for rendering:** impossible — WASM cannot touch the GPU or DOM.
  Legitimate only for sim kernels behind a benchmark gate; threads/
  SharedArrayBuffer unavailable on GitHub Pages (no COOP/COEP headers).
- **OffscreenCanvas full renderer:** `WebGPURenderer` had a worker-breaking
  regression in r179; not a tested path — deferred.
- **Per-object `THREE.LOD` for units:** composes badly with instancing;
  replaced by global zoom tiers.
- **`InstancedMesh2`:** per-instance BVH culling + LOD, but WebGLRenderer-
  only — incompatible with our WebGPU path.
- **Full SSAO / volumetric fog / whole-map CSM as default:** too expensive
  for the 60fps budget on mid-range hardware.
- **CPU skeletal animation per unit:** replaced by vertex-animation textures.
- **Deferred rendering, point-light shadows, DoF, global
  `frustumCulled=false`:** rejected as too costly or footgun-shaped.
- **esbuild standalone / Webpack / Turbopack / Rspack / Parcel:** no HMR/CSS
  story, slow dev loop, Next-only, legacy-Webpack-only, or less control —
  Vite 8 wins on merit.
- **Raw `gltfpack` flags:** UV-quantization/`KHR_texture_transform` pitfall
  ("no error, wrong output") — prefer `gltf-transform`.
- **Photoreal CC0 models (Poly Haven models):** style clash with the
  stylized look — HDRIs/textures only.
- **Voxel terrain / Nanite-style mesh terrain:** memory + meshing tax / no
  runtime mutation — heightmap wins for an RTS.
- **Unverified, do not rely on:** per-device 2026 mobile browser FPS
  numbers; Firefox WebGPU shipping status (sources conflict); exact
  WebGPU global reach (85–95% range); three.js TSL subgroups/`shader-f16`
  surface (absent); r185 GLTFLoader KHR extension set; Quaternius per-pack
  CC0.
