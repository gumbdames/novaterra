# Simulation architecture research

**Workstream owner:** sim-architecture (senior staff principal, research)
**Status:** draft complete — all 9 topics researched, recommendations recorded;
pending Phase 1 prototype validation (perf harness) and cross-workstream review.
**Last updated:** 2026-09-28

This note investigates how the deterministic simulation at the heart of
novaterra should be built: fixed-timestep loop, ECS vs OOP, determinism
in JS/TS, save/load design, pathfinding at scale, spatial partitioning, and
whether WASM / Web Workers earn their complexity. Every recommendation below is
sourced; dead ends are recorded in §12.

> Rule from `AGENTS.md`: exotic tech (WASM, WebGPU compute, workers) only where
> profiling proves it earns its complexity. This note is the record of those
> decisions.

---

## 1. Fixed-timestep deterministic simulation, decoupled from rendering

### 1.1 The canonical pattern

The accumulator pattern (Glenn Fiedler, "Fix Your Timestep!", gafferongames.com;
also Nystrom's *Game Programming Patterns*, "Game Loop" chapter) is the
industry-standard answer, and every source below converges on it:

```ts
const STEP = 1 / 60;                    // sim always advances in exact slices
let accumulator = 0, last = performance.now();

function frame(now: number) {
  let dt = (now - last) / 1000; last = now;
  accumulator += Math.min(dt, 0.25);    // clamp: never spiral-of-death after a hitch
  while (accumulator >= STEP) {
    simulate(STEP);                     // same input -> same output, always
    accumulator -= STEP;
  }
  render(accumulator / STEP);           // alpha in [0,1): blend prev/curr state
  requestAnimationFrame(frame);
}
```

Properties that matter for us:
- **Frame-rate independence:** sim advances identically on 60 Hz and 144 Hz
  displays; variable-`dt` physics is non-deterministic and tunnels through
  walls on long frames.
- **Testability:** a fixed `simulate(DT)` step can be unit-tested with a
  scripted sequence of steps asserting exact state — no clock mocking needed.
- **Overrun policy:** cap catch-up steps (e.g. max 5, or clamp `dt` at
  100–250 ms). A tick that can't keep up is a *performance* signal, not a
  correctness failure; degrading gracefully (slow-motion under load) beats
  freezing.
- Sources: Gaffer On Games "Fix Your Timestep!"; open-mmorpg tick-loop spec
  (fixed-diff authoritative loop + overrun clamp + log);
  godot-ecs-gamedev-playbook fixed-timestep skill (spiral-of-death prevention,
  input buffering for fixed steps, deterministic-sim considerations).

### 1.2 Pitfalls

- **Spiral of death:** if one `simulate()` costs longer than `STEP` and we try
  to catch up fully, each frame does *more* work than it has time for.
  Mitigation: clamp per-frame catch-up to N steps; log/slow-mo when exceeded.
- **Timer resolution:** `performance.now()` sub-ms resolution is fine; never use
  `Date.now()` for the loop (coarser, and historically clamped in some
  browsers).
- **Background tabs:** rAF stops when the tab is hidden → the clamp converts a
  huge gap into "resume from paused-ish state". For an RTS, treat tab-hide as
  an auto-pause trigger (see §4), because a long clamp window silently fast-
  forwards the sim and the AI while the player isn't watching.
- **Input timing:** commands issued between ticks must be buffered and applied
  at tick boundaries (tick-aligned input queue), never read mid-tick —
  otherwise the same command lands on different ticks on different runs and
  determinism breaks. Same for AI outputs.

### 1.3 Interpolation / render decoupling

The renderer draws `alpha = accumulator / STEP` of the way from the *previous*
sim state to the *current* one, so motion is smooth at any refresh rate
(144 Hz displays would otherwise show duplicated sim frames as stutter).
Consequences for the sim/render contract:
- The sim must retain **two position/orientation snapshots** (prev + current)
  for every interpolated entity — or the render layer must cache them itself
  from consecutive ticks. Budget: 2× the transform data, trivial next to
  geometry.
- Only *continuous* state interpolates (position, rotation, animation phase,
  resource counts animating). *Discrete* state (unit alive/dead, building
  complete, ownership) never interpolates — it flips at the tick boundary.
- The sim never knows the render exists: sim writes plain state; render reads
  a read-only view of the last two ticks. This is also what makes headless sim
  testing possible (run ticks without any renderer at all).

**Decision (recording early):** adopt the accumulator pattern verbatim,
`STEP = 1/30` or `1/60` (tbd by profiling in Phase 1 — many RTS sims run at
10–30 Hz and interpolate; AoE2 ran ~10 ticks/s logic). Input commands are
tick-aligned. Tab-hide → auto-pause.

---

## 2. ECS vs OOP for game entities in TypeScript

### 2.1 The tradeoff

- **OOP (entities as objects, behavior as methods)** is fastest to write and
  reads naturally for city-builder logic (a `City`, `Mayor`, `Building` with
  rich behavior). Its cost: scattered memory, GC churn, and combinatorial
  complexity when thousands of heterogeneous units/buildings/citizens need the
  same few hot queries ("all combat units in region", "all production
  buildings"). Sources converge on: *adopt ECS when entity count /
  combinatorial complexity actually bites — premature ECS adds boilerplate for
  no gain* (meditalk ecs-architecture reference).
- **ECS (entities = integer ids; components = plain data in SoA/typed arrays;
  systems = functions over queries)** wins on cache locality, iteration speed,
  and determinism-friendly data flow. It shines for *hot, numerous,
  homogeneous* things: units, projectiles, citizens, resource nodes.
- Our game has **both**: hot/dense (units, citizens, projectiles — thousands)
  and sparse/rich (cities, cabinets, tech tree, missions — dozens). The right
  call is **hybrid**: ECS-style data-oriented storage + systems for the hot
  simulation core; plain OOP objects for the strategic/civil layer that talks
  to the ECS core. This matches how real engines separate "sim entities" from
  "game objects".

### 2.2 Existing TS ECS libraries vs hand-rolled

Field surveyed 2026 (benchmarks: apecs `bench/compare/REPORT.md`, measured
2026-09-06 on Apple M1, Node 20; strata-ecs rival benchmarks 2026-07):

| Library | Design | Notes |
|---|---|---|
| **apecs** (0.1.0) | Archetype + SoA typed columns | Fastest of 4 measured on 5/8 benchmarks; 18 kB min+gzip; 38 bytes/entity for Position+Velocity (next-lightest measured: 155); React/Solid bindings. New (2026) — API churn risk. |
| **bitECS** (0.4.0) | Sparse sets, user-owned typed arrays indexed by entity id | Performance-first veteran (~5 kB, zero deps, used in Mozilla Hubs/Third Room); less ergonomic; entity-id-indexed arrays couple capacity planning to ids. |
| **koota** (0.6.6) | Archetype-ish query cache over plain JS arrays | Ergonomic, React bindings, but SoA in *plain arrays* — slower at extreme counts. |
| **becsy** (0.15.5) | Archetype + typed columns, scheduler-first | Fast, but scheduler-centric design imposes its execution model on us (we want our own fixed-step schedule + determinism contract). |
| **miniplex** | Plain JS objects as entities, live archetype queries | DX-first; object property access slightly slower at extreme counts; no scheduler (we call systems ourselves — a plus). |

Key considerations beyond raw benchmarks:
- **Determinism contract:** we need total control of iteration order and
  system scheduling (fixed, data-independent order — "never iterate a hash
  map"). A scheduler-first library (becsy) fights this; a "dumb query store"
  (bitECS/miniplex/apecs `each`) composes with it.
- **Save/load:** components as plain data serialize trivially; any library
  with hidden internal state (versioned entity recycling, deferred structural
  change queues) must be flushed/excluded deterministically before snapshot.
- **Hand-rolled option:** the apecs benchmark's "hand-written" baseline (typed
  arrays + index arithmetic, no entity ids/queries) is the fastest thing
  measured — but it forfeits queries and ergonomics. A thin hand-rolled
  SoA store (~200 lines: id pool, component columns, archetype-free filtered
  iteration) is a legitimate choice if our query needs stay simple.

**Decision (leaning, needs prototype validation in Phase 1):** hand-rolled
minimal ECS core for the hot sim (units/citizens/projectiles/economy agents)
— we own the iteration order, serialization, and determinism contract — with
plain OOP for the strategic layer (cities, governments, tech, missions).
Re-evaluate apecs/bitECS only if our hand-rolled store proves insufficient;
do not adopt a scheduler-first ECS.

### 2.3 Change detection & structural changes

ECS footguns to design around from day one: structural changes (add/remove
component, spawn/destroy) during iteration must be deferred to tick-end
command buffers (deterministic order: spawn → kill → add → remove), and entity
ids should be versioned (index + generation) so stale references fail loudly.
A per-tick digest (see §3) catches violations.

---

## 3. Determinism in JS/TS

### 3.1 What determinism level do we actually need?

Classic RTS lockstep multiplayer (AoE, StarCraft) needs **bit-identical**
state across different machines/CPUs/OSes — the hardest bar, historically
requiring fixed-point math and FPU control registers (Supreme Commander even
restricted to one compiler/OS/arch). **We don't need that bar**: our game is
single-player, offline, all in one browser on one machine. We need:

1. **Same-seed + same commands ⇒ same state**, on the *same* machine/browser.
   This buys us: free replays (command log = replay file), reproducible bug
   reports ("seed 4471 + these commands"), save/load integrity checks,
   deterministic AI ("Muse persona" mode replayable), and a tick-hash desync
   detector for our own bugs.
2. The door left open for future cross-machine determinism if a later
   multiplayer/leaderboard feature demands it.

Consequences:
- **IEEE-754 doubles in one JS engine are deterministic.** V8's arithmetic
  (`+ - * /`) is exactly IEEE-754 round-to-nearest, so the same operation
  sequence on the same engine gives the same bits, every time. This is the
  bedrock of all JS deterministic sims.
- **Transcendentals are the trap:** `Math.sin/cos/sqrt/pow/atan2` are
  *implementation-approximated* per spec — bit-identical within one engine
  build, but *may differ across engines/versions*. For our single-machine
  bar they're fine; for a future cross-machine bar we'd wrap or table them.
  Note: engines change rarely, but a Chrome update mid-campaign could
  theoretically alter a replay — acceptable risk, documented.
- **Never in the sim:** `Math.random()` (unseeded), `Date.now()`,
  `performance.now()`, wall-clock anything, object identity / pointer values,
  iteration over plain `Object`/`Map` in **insertion-order-unsafe** ways
  (JS Maps *are* insertion-ordered, so a Map built deterministically iterates
  deterministically — but prefer arrays/sorted order for anything that feeds
  state), `Array.prototype.sort` without a total-order comparator (V8's
  TimSort is stable, so it's deterministic *given* a deterministic comparator
  and input order — still, keep comparators total).

### 3.2 Seeded RNG

One generator, owned by the simulation, seeded once per game; its state is
*part of the save*. **mulberry32** (single uint32 of state) is the standard
choice for JS sims — tiny, fast, readable, good enough statistically for
gameplay (not crypto). sfc32/xoshiro128** are fine alternatives; mulberry32
wins on "fits in one integer of save state". Pattern:

```ts
class Rng {
  state: number;                    // uint32, serialized with the save
  next(): number { /* mulberry32 */ }
  intBelow(n: number): number { return Math.floor(this.next() * n); }
}
```

Rules: two RNG instances drawn in different orders = the same bug as
`Math.random()`. Either one global sim RNG (simplest, deterministic order
guaranteed by fixed system order) or per-subsystem RNGs with their draw order
pinned by the tick schedule. Prefer **one global RNG**; split only if
profiling shows contention (it won't — it's a few integer ops).

### 3.3 What determinism buys us (concrete features)

- **Replay:** save the seed + command log; re-simulating reproduces the game.
  Enables the "watch your campaign as a movie" feature and post-game analysis.
- **Save/load integrity:** hash the state at save time; re-hash after load —
  mismatch means the serializer dropped something. This is our strongest
  save/load test.
- **Desync detection during development:** compute a cheap 32-bit state digest
  every N ticks in dev builds; any two runs with same inputs must match.
  Catches determinism violations (accidental `Math.random`, unordered
  iteration) within seconds instead of "the AI behaved differently in hour 3".
- **Deterministic AI modes:** both the "regular AI" and the "Muse persona" AI
  become pure functions of (state, tick, rng) — testable, replayable, and
  difficulty levels stay comparable across runs.

### 3.4 Fixed-point: when would we need it?

Only if we ever need **cross-machine bit-exactness** (multiplayer lockstep,
cross-device replays). Q16.16 in JS doubles works for values < 2^31; BigInt
Q32.32 for more range. Cost: every arithmetic op becomes a function call,
transcendentals need lookup tables, and it's a pervasive code-style tax.
**Verdict: not now.** Floats-in-one-engine satisfy our bar; keep a
`math.ts` seam (wrap `sin/cos/sqrt` in named functions) so a future
fixed-point swap touches one module, not the world.

Sources: popyapp multiplayer-netcode SKILL (determinism contract: fixed-point
*or* deterministic soft-float, one seeded PRNG, fixed update order);
openvic-simulation ecs pitfalls (worker-count invariance gate — relevant to
§8); monada determinism contract; uvucs3660 determinism-and-replay cheat
sheet (same seed + same commands ⇒ same hash; command log = replay);
dev.to "A pure, seeded game engine gives you multiplayer almost for free"
(RNG state inside GameState, serializes with everything else);
endel/prediction-multiplayer-research (fixed-point in TS, cross-platform
float warning, Supreme Commander restricted compiler/OS/arch).

---

## 4. Save / load / resume + pause

### 4.1 Snapshot serialization design

The sim state must be a **plain-data graph**: typed arrays, plain objects,
numbers, strings, integer entity ids. The snapshot boundary is a hard
architectural seam — everything the sim needs to continue a game must be
inside it, everything transient stays outside.

**Inside the snapshot (serializable):**
- Tick counter, map seed, difficulty, mode (AI persona), game options
  (war enabled/disabled), elapsed game-time.
- The sim RNG state (one uint32 for mulberry32 — see §3.2).
- Entity store: component columns (positions, health, orders, …) + entity
  id/generation table + deferred-command buffers (emptied at tick end, but
  snapshot at a tick boundary so they're always empty — pick the invariant:
  **snapshots are only taken at tick boundaries**).
- Economy state (per-city treasuries, resource stockpiles, trade routes,
  production queues), tech/age state, AI state (both AI modes must serialize
  their brains — an AI with hidden closures is an unloadable save).
- Map state: terrain grids, resource nodes, explored/fog state, buildings.
- **Command log** (seed + input history) if we want replay support — cheap
  relative to full snapshots, and enables §3.3's "replay is free".

**Outside the snapshot (rebuilt on load, never serialized):**
- Renderer state, interpolation buffers (prev/current transforms), textures,
  meshes, audio graph, UI state (camera can be saved as a convenience, but
  must not be *required* for a valid load).
- Derived/cached data: spatial grid (§6 — rebuilt each tick anyway),
  flow-field caches (§5), pathfinding queues (or: drain them before snapshot
  so in-flight requests are re-issued deterministically after load).

### 4.2 Versioned save format

```ts
interface SaveFile {
  saveVersion: number;        // bump on any breaking sim-state change
  gameVersion: string;        // informational
  createdAt: number;          // wall clock, informational only
  meta: { mapName, difficulty, mode, playtimeTicks, … };  // for the load menu
  stateHash: number;          // tick digest at save time — integrity check
  state: unknown;             // the snapshot, versioned by saveVersion
}
```

- **Migrations:** `migrate[v → v+1](state)` functions, chained. Old saves
  load through the chain; if a migration can't be written (fundamental
  change), the save is rejected with a clear message, never silently corrupted.
- **Integrity check:** recompute the state digest after load and compare with
  `stateHash` — mismatch = serializer bug, caught immediately (§3.3).
- **Autosave + named slots.** Autosave every N game-minutes into a rotating
  slot; writes go to IndexedDB asynchronously so they never hitch the sim.

### 4.3 IndexedDB for large saves

- **IndexedDB, not localStorage:** async (no main-thread block),
  structured-clone storage (typed arrays, Maps, Dates survive natively —
  note: class instances do NOT; the snapshot must already be plain data),
  quota is a large share of free disk (vs localStorage's ~5 MB hard cap).
- **Perf rules:** transaction overhead is the bottleneck, not throughput —
  one save = one transaction, one `put`. For large saves, store the snapshot
  as a `Blob` (browsers store blobs as separate files, avoiding inline
  structured-clone size limits). Compress large snapshots (e.g. gzip via
  `CompressionStream`) — terrain grids compress well.
- **Durability:** request `navigator.storage.persist()` so the browser treats
  saves as persistent, not best-effort evictable. Note Safari's 7-day
  non-visit eviction policy for site data — our game is a destination site,
  acceptable risk; offer **export/import save as file** as the belt-and-
  braces path (also enables save sharing).
- Use the tiny `idb` promise wrapper, not raw IndexedDB event soup.

### 4.4 Pause

Pause = stop advancing the accumulator; rendering and UI keep running
(frozen battlefield behind the pause menu, camera still orbit-able — good
game feel, and matches the "tab-hide → auto-pause" rule from §1.2). Input
during pause is queued and applied on resume at the next tick boundary.
Determinism note: pause/resume must not inject sim-visible events — the
command stream is identical with or without a pause in the middle (test this).

Sources: the-cyber-boardroom storage-apis research (transaction overhead
25×, Blob storage, Chromium IPC bottleneck, Chrome optimizes reads not
writes); dev.to "localStorage Isn't Free" (IndexedDB async + structured
clone + quota); vectree.io persistence models (ACID transactions, persistent
storage permission); pplancq ADR-003 (repository pattern, versioned
migrations); kumaratul60 QA (IndexedDB vs localStorage limits, Safari
7-day eviction).

---

## 5. Pathfinding at scale

### 5.1 How modern RTS games do it

- **Supreme Commander, Company of Heroes, Planetary Annihilation** use
  **flow fields**: compute one Dijkstra flood-fill from the destination over
  the grid, producing a vector field; then *every* unit heading there just
  samples the field at its cell. Cost is **O(grid cells), independent of unit
  count** — the defining property for "hundreds of units, one destination".
  PA's dev videos explicitly show flow fields for dynamic obstacle bypass
  (pcgamer.com coverage).
- **Formations** compose with this: the leader paths once (flow field or
  A*), followers take offsets — one expensive query, N cheap ones.
- **StarCraft II / AoE IV / Total War** layer: **JPS (Jump Point Search)** for
  individual long paths (3–30× faster than A*, optimal, zero memory overhead),
  plain **A*** for short/unique paths, and a **pathfinding coordinator** that
  picks the method by distance + clustering, with a path-result cache and
  invalidation on dynamic-obstacle change.
- **Unity DOTS / UE5 Mass** push flow fields onto GPU compute for 10k-agent
  crowds; we don't have that scale target and shouldn't pay that complexity
  (see §7/§8 reasoning — profile first).

### 5.2 What fits our game

Our maps are **very big** (design requirement: playable without war even in
war mode), with land/sea/air domains, and unit counts in the hundreds to low
thousands. Recommended layered design:

1. **Domain grids (static, per map):** land / water / air traversability.
   Air ignores terrain (straight lines + separation steering); sea uses the
   water grid; land uses the land grid. Big maps + water-heavy maps make
   separate coarse grids essential.
2. **Hierarchical A\* / JPS for long-range routing:** coarse-region graph
   (e.g. 32×32-cell regions) for the "which regions" path, then JPS/A* within
   regions for the detailed path. Keeps per-request cost bounded on huge maps.
3. **Flow fields for group moves:** when ≥K units (tune K, start with 8)
   share a destination, build one flow field instead of N paths. Cache fields
   by (destination cell, obstacle-generation counter); invalidate on terrain
   change (building placed/destroyed).
4. **Local steering for separation:** flow field/A* gives the *route*; a
   cheap local avoidance layer (spatial grid neighbors, §6) prevents unit
   stacking and gives the "army flows around obstacles" feel without
   replanning.
5. **Time-sliced pathfinding budget:** path requests go into a queue; the sim
   spends at most B ms per tick on the queue (B≈2 ms at 30 Hz), leftover
   requests wait. Units show a "thinking" acknowledgment immediately (RTS
   convention: salute now, move when the command lands). This bounds
   worst-case tick cost no matter how many orders the player spams — a hard
   requirement for the 60fps budget.

**Decision (leaning):** layered — domain grids + hierarchical routing (JPS/A*)
+ flow fields for groups + local steering + time-sliced request budget.
Prototype the flow-field layer in Phase 1; measure before adding GPU/worker
variants.

---

## 6. Spatial partitioning

### 6.1 Verdict: uniform spatial hash grid as the default

For combat queries (who's in weapon range?), economy queries (nearest
resource depot?), selection (units in drag rectangle?), and steering
neighbors, the evidence converges on a **uniform spatial hash grid**:

- O(1) insert/move, O(n) full rebuild, ~O(1) neighbor queries; flat arrays =
  cache-friendly; trivially deterministic (iterate cells in index order);
  simplest correct implementation (fs.gg.game collision-design report uses it
  as default with a stability argument: grid results are more cache-stable
  under small movements than tree results — a good fit for a rebuild-each-
  tick design).
- Benchmarks (vectorial-hash-kit, 50k points): on uniform data the
  pointer-free Morton grid is the fastest index measured (14.5× over brute
  force), beating octree (12.6×) — trees' adaptivity is wasted when one
  resolution fits.
- Rule of thumb (makone skill): <50 entities brute force is fine; 50–200
  uniform grid; 200–1000 grid or quadtree; 1000–10k quadtree/octree; >10k
  BVH. Our hot counts sit squarely in "grid" territory.

Where a quadtree *would* win (clustered, wildly varied density — e.g. a
mega-city next to empty ocean), consider the **dual-structure** pattern used
by modern RTS-likes: moving entities in the hash grid (O(1) updates),
*static* entities (buildings) in a separate structure or just the same grid
with a static layer. Simplicity first: one grid with separate static/dynamic
registration; split only if profiling demands.

### 6.2 Design notes

- **Cell size ≈ largest common query radius** (e.g. weapon range / steering
  radius). Multi-cell-spanning entities register in every overlapped cell;
  dedupe pairs with canonical ordered keys `(min(idA,idB), max(idA,idB))`.
- **Determinism:** candidate pairs must be emitted in a **stable sorted
  order** regardless of hash iteration (sort by id, or iterate cells in index
  order and ids ascending within a cell).
- Rebuild the dynamic grid each tick (O(n), cache-friendly) rather than
  incremental move updates — simpler, deterministic, and incremental
  bookkeeping has bitten many projects.
- The grid also serves the **flow-field obstacle layer** (§5) and the
  **render culling** query (which entities are on screen) — one structure,
  three consumers.

Sources: wormholeportal/makone spatial-partitioning skill; fs-gg collision
detection design (broad-phase table, determinism note); s-parfeniuc
quadtree-vs-grid comparison; vectorial-hash-kit Morton grid benchmarks;
cahyaong ai.odin dual-partitioning survey (moving hash grid + static
quadtree, "inspired by modern RTS, Factorio, AoE IV").

---

## 7. WASM / Rust for sim hotspots

### 7.1 The honest evidence

WASM (Rust → wasm32) runs tight numerical loops at ~70–90% of native speed
and beats JS by 4–50× on dense numerics (image blur 12×, CSV parsing 47×,
SHA-256 10× — dev.to benchmarks; Fibonacci(40) 10.6× Rust-vs-JS on Chrome
126/M3). **But** the advantage evaporates — or reverses — at the JS↔WASM
boundary:

- **Boundary tax is the dominant cost.** Every call crossing the boundary
  pays: primitive call ~50–100 ns; 1 MB array copy 1–3 ms; serde
  JSON-in/JSON-out round-trips; wasm-bindgen's `&[f64]` slices *copy*.
  A 2025 DEV benchmark: `modify array` — JS **1.403 ms**, wasm-bindgen
  **1.623 ms (slower than JS!)**, raw WASM 0.353 ms (4×), raw+SIMD 0.231 ms
  (6×). Naïve wasm-bindgen use can be a *pessimization*.
- **serde-wasm-bindgen can be slower than JSON.** A real production case
  (openui rust-wasm-parser): returning a `JsValue` directly via
  serde-wasm-bindgen was **30% slower** than `serde_json::to_string()` +
  one memcpy + V8's native `JSON.parse` — many small crossings lose to one
  big optimized one. Lesson: WASM only wins with **coarse-grained APIs and
  shared/typed-array memory**, never chatty fine-grained calls.
- **WASM is NOT faster for:** DOM, JS API calls, branchy game logic, memory
  patterns that don't fit linear memory — "tasks where JS JIT has already
  optimized well."
- **Threading needs SharedArrayBuffer → COOP/COEP headers → impossible on
  GitHub Pages**, which cannot set custom HTTP headers (confirmed by
  multiple sources; workarounds like coi-serviceworker are flaky,
  Safari-incompatible, and force a first-load reload). Our deploy target
  rules out WASM threads and SAB-based designs outright.

### 7.2 What this means for our sim

Our sim is dominated by **branchy game logic** — AI decisions, economy
rules, order processing, tech trees — exactly the workload class where V8's
JIT is excellent and WASM gains nothing. The numerically dense candidates
(flow-field flood fills, spatial queries) are:
1. already cheap in JS (a 256×256 Dijkstra flood fill is ~58 ms
   unchunked / ~34k pops on the dev VM — NOT sub-millisecond as first
   assumed; the sim therefore time-slices it at 600 pops/tick ≈ 0.5 ms,
   see step 6),
2. called infrequently relative to per-entity logic,
3. subject to the boundary tax if moved out.

**Decision: NO WASM in Phase 1. Revisit only if profiling (§9) proves a
hotspot where (a) the work is dense numerics, (b) the API can be
coarse-grained over shared typed arrays, and (c) measured speedup ≥3× after
subtracting boundary costs.** If that day comes, the seam is a single module
(e.g. `sim/pathing/flowfield.ts`) with a JS fallback so the game never
*requires* WASM to run. Debugging cost (source maps, separate toolchain,
two-language stack traces) and build complexity (wasm-pack in CI, Pages
artifact size) are real and must be re-justified each time.

Sources: photrez rust-ts-interop forum research (boundary costs, Stepanov
2026 figures, "collect work into one call that does 50 ms of work");
thesysdev/openui rust-wasm-parser (the WASM boundary tax, serde-wasm-bindgen
30% slower); dev.to "WebAssembly in Practice" (70–90% native; NOT faster for
DOM/JS APIs/JIT-friendly code); dev.to "WebAssembly is Ready" (benchmark
table); tanuki intro (when NOT to use WASM); mtdeveloper dual-engine
blueprint (zero-copy pipeline as the *only* way it pays off); auris,
mp3-splitter, openmf/gh-pages READMEs (GitHub Pages: no custom headers →
no SharedArrayBuffer); emalenchek 3d-rendering-engine research (coi-serviceworker
caveats); qnbs/cannaguide ADRs (SAB rejected on Pages, progressive
enhancement fallback).

### 7.3 Future WASM candidates (noted 2026-10-01 — revisit only if profiling proves a hotspot)

In priority order, if the game ever needs WASM:

0. **Combat target acquisition** (`sim/combat.ts`) — the per-tick
   dense grid landed in TS (R1 final-review H1, 2026-10-01); the
   grid build + radius query are the natural compiled boundary, marked
   with a WASM-seam comment in `targetGridFor`. (A first version used
   the generic `SpatialHash`; profiling showed its per-candidate
   overhead was ~7x the legacy scan in dense battles, so combat uses a
   purpose-built grid with integer keys and inline reduction.) Candidate
   only if battles ever outgrow the TS grid.
1. **Pathfinding** (`sim/pathfinding.ts`) — if battles ever scale to hundreds of units pathing at once, a compiled A* would be ~3–5× faster.
2. **Desirability/migration** (`sim/desirability.ts`, `sim/city.ts`) — the map-wide per-building scans on big cities could move off the main thread into a WASM worker.
3. **AI think** (`sim/ai/`) — the rival AI's decision pass is the heaviest per-tick CPU cost.

> **R3 profiling note (2026-10-01, dev VM, Node-measured):** the worst-case
> stress test (`tests/perf.budgets.test.ts`, "worst-case combined sim load")
> empirically characterized candidates 1 and 3 at ~1100 units (~20x the
> marshal army cap of 48): a 200-pathfind burst spiked the pathfinding
> system to 162 ms in one tick, and marshal think passes measured
> 98–275 ms. Per-system breakdown and follow-ups in
> `docs/research/perf-r3.md`. The decision stands — TS unless a real
> gameplay scenario (not a 20x-over-cap stress) proves otherwise — but the
> numbers above are now the baseline to beat, and `getVisibleEnemies`'s
> O(enemies × own) `effectiveSight` inner loop is the first thing to hoist
> if the think ever needs it.

---

## 8. Web Workers for sim work

### 8.1 The cost model (measured)

- `postMessage` round-trip: **~10 µs**; structured clone of 8 MB: **~1.53 ms**
  (~2–5 GB/s); *transferring* an 8 MB ArrayBuffer: **~0.096 ms** (near-free —
  neutering, but the sender loses access); worker spawn+boot: ~0.6 ms
  amortized. Rule of thumb: **any task >~1 ms is worth offloading** (100:1
  work-to-overhead); below ~0.1 ms it's a loss (tomlarkworthy cost model).
- **The clone runs on the sending thread.** A large `postMessage` blocks
  exactly the thread you were trying to free — cost is proportional to
  payload size (dev.to "JavaScript in parallel"; webpronews/Inngest: moving
  data to a worker can exceed the processing time).
- **Chatty protocols destroy the benefit** — one big job per message beats a
  hundred small round trips (skovoroda worker-threads notes).
- **Class identity doesn't survive the clone** — instances arrive as plain
  objects. Another reason the sim state must be plain data (§4.1).
- Debugging tax: separate DevTools context, harder profiling, duplicated
  module graphs per isolate.

### 8.2 The determinism problem (decisive for the sim)

Worker completion order is **nondeterministic** (OS scheduling). If sim
results depend on *when* a worker finishes, determinism (§3) dies. Safe
patterns exist — results buffered and applied at tick boundaries in
request-id order — but they convert every worker interaction into an async
protocol with its own ordering, timeout, and failure semantics. The
openvic-simulation project gates this explicitly: multi-tick digests must be
identical at worker counts 1, 2, 4, 8, 16. We would need the same gate.

### 8.3 Decision: sim stays single-threaded; workers for the periphery

The sim is a **tightly coupled, branchy, deterministic** workload — the
worst fit for workers (fine-grained, order-sensitive) and the best fit for
one fast thread with a time-sliced budget (§5.5). Workers are approved for
**determinism-irrelevant, coarse-grained** jobs only:

| Candidate | Why it's safe |
|---|---|
| Audio decode/synthesis | No sim state; drop/glitch = cosmetic |
| Save serialization + IndexedDB write | Snapshot is immutable once taken; async by design (§4.3) |
| Asset loading / texture decode | Pre-sim, or streamed with explicit versioning |
| Procedural map generation | Seeded; must *complete before tick 0* (await the worker, then start) |
| (Later, if proven) pathfinding service | Only behind a deterministic request-id-ordered apply barrier — deferred until in-sim time-slicing proves insufficient |

`SharedArrayBuffer`+`Atomics` patterns are **not available** on our deploy
target (GitHub Pages can't send COOP/COEP — §7.1), so worker designs must use
`postMessage` + transferables, with feature-detection if SAB is ever
considered for other hosts.

Sources: tomlarkworthy worker-offload cost model (10 µs round-trip, clone
vs transfer figures, ≥1 ms rule); dev.to "JavaScript in parallel" (clone
runs on sender, transferables); webpronews/Inngest (serialization tax can
exceed compute); skovoroda worker-threads (isolate model, chatty-protocol
warning, pool sizing); crs48/xnet ADR (17-week complexity estimate for a
worker migration, debugging tax); xt-ml/shadow-claw ADR (SAB unavailable
without COEP/COOP); verekia/webgamedev workers page (pathfinding/physics
as classic candidates; comlink/workerpool libraries).

---

## 9. Profiling strategy

Principle: **profile before optimizing, record the numbers here** (AGENTS.md).
The slowest thing is rarely where you expect it.

### 9.1 Headless sim benchmarks (primary tool)

Because the sim is decoupled from rendering (§1), it can run **headless in
Node** — no browser, no GPU, fully scripted. This is our most important
profiling asset:
- **Scenario harness:** `game/tests/perf/scenarios/` — scripted scenarios
  (e.g. "1000-unit battle", "8-city economy at 2h game-time", "pathfinding
  storm: 200 simultaneous group orders"). Each runs N ticks and reports
  per-system timings.
- **Methodology:** warm up the JIT (discard first runs), repeat, report
  **median and p95/p99 — not mean**; change one thing at a time; record
  environment (CPU, Node version) alongside numbers.
- **Perf budgets as tests:** CI fails if a scenario exceeds its tick budget
  (e.g. p95 tick ≤ 8 ms at 30 Hz sim on the reference machine) — regression
  protection from day one.

### 9.2 In-browser profiling

- **Chrome DevTools Performance panel:** record 5–10 s of play; read the
  frames track (red = dropped), the main-thread flame chart, and the
  **Bottom-Up** view sorted by self time. Always profile with **4× CPU
  throttling** (dev machines are 4–10× faster than user devices) and on
  **production builds**. Incognito to exclude extensions.
- **User Timing API:** `performance.mark`/`performance.measure` around
  `simulate`, per-system spans, `render`, save/load — our spans show up in
  the DevTools timeline's User Timing track. Keep a `PROFILE` compile flag
  so instrumentation compiles out of release builds if it ever shows in
  profiles.
- **Memory panel:** *Allocation instrumentation on timeline* shows who
  allocates during play (GC pauses are a classic RTS hitch source);
  heap-snapshot diffs find leaks (entities never removed, listeners never
  detached).
- **Long Tasks:** `PerformanceObserver` on `longtask` entries in automated
  playtests — any main-thread task >50 ms is a bug against our budget.

### 9.3 What to measure first (Phase 1 order)

1. Sim tick breakdown by system (movement, combat, economy, AI, pathing) in
   the headless harness — establishes the real hotspot ranking.
2. Render cost separately (draw calls, instancing) — never confuse render
   cost with sim cost; they're different budgets.
3. Save/load wall time + IndexedDB write time on a late-game save.
4. Memory: per-entity bytes, snapshot size, GC pause frequency.

### 9.4 Budget targets (initial, to be refined by measurement)

| Budget | Target |
|---|---|
| Sim tick (30 Hz) | p95 ≤ 8 ms (leaves headroom for render + GC) |
| Pathfinding queue | ≤ 2 ms/tick (time-sliced, §5.5) |
| Render frame | 60 fps on mid-range laptop @ 1080p |
| Save (late game) | no visible hitch (async IndexedDB, §4.3) |
| Load | ≤ 3 s to interactive |

Sources: rezmequick performance-engineer agent (baseline → profile → fix
→ verify; optimize the biggest number first); rmalkevy lab-07
(engine-performance-testing: Performance + Memory panels, User Timing
marks, allocation instrumentation, median/p95 methodology, CPU throttling);
leahycc profiling resources (flame chart reading, 4× throttling rule,
production builds); einverne/luizedupp chrome-devtools performance guides
(longtask observer, recording setup).

---

## 10. Recommended architecture

### 10.1 Module map

```
game/src/
├── sim/                        # DETERMINISTIC CORE — no DOM, no Date, no Math.random
│   ├── AGENTS.md               # sim conventions (tick order, determinism contract)
│   ├── tick.ts                 # fixed-step driver: accumulator, input queue, system schedule
│   ├── rng.ts                  # mulberry32, owned by sim, state in snapshot
│   ├── math.ts                 # seam for sin/cos/sqrt (future fixed-point swap)
│   ├── world.ts                # entity store: hand-rolled SoA + versioned ids
│   ├── commands.ts             # player/AI orders: validate → buffer → apply at tick boundary
│   ├── systems/
│   │   ├── movement.ts         # flow-field/A* following + local steering
│   │   ├── combat.ts           # targeting, damage, spatial-grid queries
│   │   ├── economy.ts          # production, trade, treasuries, resource nodes
│   │   ├── construction.ts     # build queues, placement validation
│   │   ├── tech.ts             # ages / research
│   │   ├── ai_classic.ts       # difficulty-scaled classic AI (pure fn of state)
│   │   ├── ai_persona.ts       # "Muse persona" adaptive AI (pure fn of state)
│   │   └── diplomacy.ts        # war/peace, alliances (incl. war-disabled mode)
│   ├── pathing/
│   │   ├── grid.ts             # domain grids (land/sea/air traversability)
│   │   ├── astar.ts            # hierarchical A* / JPS for single requests
│   │   ├── flowfield.ts        # Dijkstra fields for group moves (WASM seam here)
│   │   └── queue.ts            # time-sliced request queue (≤2 ms/tick)
│   ├── spatial.ts              # uniform hash grid; rebuilt per tick; 3 consumers
│   ├── strategic/              # OOP layer: cities, mayors, generals, cabinet
│   │   └── ...                # talks to ECS core; rich behavior, low entity count
│   ├── digest.ts               # per-N-tick 32-bit state hash (dev desync detector)
│   └── serialize.ts            # snapshot ↔ SaveFile (versioned, plain data only)
├── render/                     # reads last two ticks, interpolates; never mutates sim
│   ├── scene.ts, instancing.ts, effects.ts, culling.ts (uses sim spatial grid view)
├── ui/                         # HUD, menus, pause, load/save screens
├── audio/                      # adaptive music + SFX (worker for decode/synth)
├── net_save/                   # IndexedDB repo (idb wrapper), export/import file,
│                               #   compression, migrations, autosave rotation
└── tests/
    ├── unit/                   # sim systems: scripted tick sequences, exact-state asserts
    ├── headless/               # full-game sim without renderer (replay verification)
    └── perf/scenarios/         # budget-gated perf tests (see §9.1)
```

### 10.2 Data flow (one tick)

```
player input ─┐
              ├─→ commands.ts (validate + buffer, tick-aligned)
AI output  ───┘
                       ┌─ world.ts (SoA store, versioned ids)
tick.ts:               │
 for each system       ├─ spatial.ts (grid rebuilt at tick start)
 in FIXED ORDER:       ├─ systems/* read grid + store, write intents
   movement → combat   │
   → economy → …       └─ deferred structural changes applied in
 AI runs as a system        fixed order (spawn→kill→add→remove)
 (pure fn of state)
                       └─ digest.ts every N ticks (dev only)
render reads tick[t-1], tick[t] + alpha → interpolated frame
```

Invariants: systems run in a fixed, data-independent order; iteration order
is always id-ascending or cell-index-ascending; no system reads wall-clock,
`Math.random`, or render state; structural changes are deferred to a
tick-end command buffer.

### 10.3 Tick design

- `STEP = 1/30` s initial (tune in Phase 1; 30 Hz is the RTS sweet spot —
  AoE2-class logic ran ~10 Hz; interpolation covers the render side).
- Accumulator loop per §1.1; catch-up clamped (max 5 steps/frame, then
  slow-motion + log). Tab hidden → auto-pause.
- Pathfinding time-slice: ≤2 ms/tick from the request queue; overflow waits.
- AI (both modes) executes *inside* the tick as pure functions of
  `(state, tick, rng)` — same code path for classic and persona AI, so
  difficulty levels stay comparable and replays stay valid.

### 10.4 Save format sketch

```ts
interface SaveFile {
  saveVersion: 3;                 // integer, migrations chained in net_save/migrations/
  gameVersion: "0.3.0";
  createdAt: number;              // informational
  meta: { mapId, difficulty: 1-5, aiMode: "classic"|"persona",
          warEnabled: boolean, playtimeTicks: number };
  stateHash: number;              // digest at save → verified on load
  seed: number;                   // map + rng seed
  commandLog: Command[];          // for replay (rotating tail if huge)
  state: {                        // plain-data snapshot at a tick boundary
    tick: number; rngState: number;
    entities: { [componentName]: TypedArray-as-number[] };
    idTable: number[];            // index+generation
    economy: …; tech: …; ai: { classic: …, persona: … };
    map: { terrain: CompressedGrid, resources: …, buildings: … };
    diplomacy: …;
  };
}
```

Stored as one compressed `Blob` per save in a single IndexedDB transaction
(`saves` object store, key = slot id); `meta` duplicated in a small
`save-meta` store for the load menu without deserializing bodies.
`navigator.storage.persist()` requested; export/import as `.json.gz` file.

### 10.5 The WASM / worker decision (final, evidence-driven)

| Question | Decision | Evidence |
|---|---|---|
| WASM for sim hotspots? | **No in Phase 1.** Revisit only if profiling proves a ≥3× win on dense numerics behind a coarse-grained typed-array API, with a JS fallback. | §7: wasm-bindgen can be *slower* than JS (1.623 ms vs 1.403 ms); serde boundary tax; our workload is branchy logic where V8 excels; GitHub Pages can't do WASM threads (no COOP/COEP). |
| Sim in a Web Worker? | **No.** Sim stays single-threaded. | §8: worker completion order is nondeterministic (kills §3 unless we build an ordering barrier); clone costs run on the sender thread; time-sliced in-sim budgets already bound worst-case tick cost. |
| Workers at all? | **Yes, periphery only:** audio decode/synth, save serialization+IDB write, asset loading, seeded map-gen (awaited before tick 0). | §8.3: coarse-grained, determinism-irrelevant jobs where ~10 µs round-trip is noise. |
| SharedArrayBuffer? | **No** on our deploy target. | §7.1: GitHub Pages cannot send COOP/COEP; design everything on postMessage+transferables. |

This is the "boring technology" the AGENTS.md asks for: one fast thread,
fixed timestep, plain-data sim, workers and WASM parked behind profiling
gates — each with a named seam (`sim/pathing/flowfield.ts`,
`sim/math.ts`) so a future reversal touches one module.

### 10.6 What Phase 1 must build first (architecture order)

1. `tick.ts` + accumulator loop + tick-aligned command queue (the skeleton
   everything hangs on).
2. `world.ts` hand-rolled SoA store + `rng.ts` + `digest.ts` (determinism
   contract + its test).
3. `spatial.ts` grid + `serialize.ts` + one component round-trip
   (save/load from the very first playable build — AGENTS.md §3).
4. `pathing/queue.ts` time-sliced stub (straight-line + steering) behind the
   real interface; flow fields land when scenarios demand them.
5. Headless perf harness (`tests/perf/scenarios/`) before the first
   "thousands of entities" claim — the numbers go in this note.

---

## 11. Open questions

- Mode 2 "play against Muse": a live LLM opponent is infeasible offline; the
  design workstream is investigating a "Muse persona" adaptive AI instead.
  Architecture note: whichever design wins, the persona AI must be a pure
  function of sim state (serializable brain, §4.1) — an LLM *inside* the tick
  would break determinism, offline play, and the tick budget simultaneously.
- Tick rate: 30 Hz proposed (§10.3); validate against the perf harness in
  Phase 1 (20 Hz halves AI/pathing cost if needed).
- Hand-rolled ECS vs apecs/bitECS: leaning hand-rolled (§2.2); prototype both
  against the perf harness before committing — one afternoon of measurement
  beats a week of debate.
- Flow fields vs hierarchical A* emphasis: both are in the design (§5.2);
  the ratio will be set by scenario measurements.

## 12. Dead ends

- **Cross-machine bit-exact determinism (fixed-point everywhere):** rejected
  for Phase 1. Needed only for lockstep multiplayer; we are single-player.
  Cost (pervasive code-style tax, lookup-table transcendentals) far exceeds
  benefit. Kept as a future option behind the `sim/math.ts` seam (§3.4).
- **WASM-first sim:** rejected — boundary tax dominates for branchy game
  logic; naive wasm-bindgen measured *slower* than JS; GitHub Pages blocks
  the threading story (§7).
- **Sim in a Web Worker:** rejected — nondeterministic completion order vs
  the determinism contract; in-sim time-slicing bounds tick cost more
  simply (§8).
- **SharedArrayBuffer / Atomics fast paths:** rejected for our deploy target
  — GitHub Pages cannot send COOP/COEP (§7.1). All worker designs use
  postMessage + transferables.
- **Scheduler-first ECS (becsy-style):** rejected — we need to own system
  order for the determinism contract; a "dumb query store" composes, a
  scheduler dictates (§2.2).
- **localStorage for saves:** rejected — 5 MB cap, synchronous (blocks main
  thread), string-only. IndexedDB is the save store (§4.3).

## 13. Key sources (verbatim URLs)

**§1 Fixed timestep**
- https://github.com/developerz-ai/open-mmorpg/blob/HEAD/docs/specs/game-server/tick-loop/README.md
- https://github.com/xyrces/godot-ecs-gamedev-playbook/blob/HEAD/skills/fixed_timestep_game_loop/SKILL.md
- https://github.com/bufatechno/bufatechno-webgamedev/blob/HEAD/references/game-architecture.md
- https://github.com/rmalkevy/programming-practice-projects/blob/HEAD/courses/javascript/lab-01-event-loop-and-game-loop.md
- Glenn Fiedler, "Fix Your Timestep!" (Gaffer On Games) and Robert Nystrom,
  *Game Programming Patterns*, "Game Loop" — cited by name; canonical
  references echoed across all of the above.

**§2 ECS**
- https://github.com/diffusionstudio/apecs/blob/HEAD/bench/compare/REPORT.md (benchmarks, measured 2026-09-06)
- https://github.com/diffusionstudio/apecs/blob/HEAD/README.md
- https://github.com/rafeez1819/meditalk/blob/HEAD/.MediTalk/skills/building-games/references/ecs-architecture.md
- https://github.com/verekia/webgamedev/blob/HEAD/src/pages/code-architecture/ecs.mdx
- https://github.com/builder-group/community/blob/HEAD/packages/ecsify/README.md

**§3 Determinism**
- https://github.com/popyapp/agent-skills/blob/HEAD/multiplayer-netcode/SKILL.md
- https://github.com/openvicproject/openvic-simulation/blob/HEAD/docs/ecs/pitfalls.md
- https://github.com/ncrashed/monada/blob/HEAD/book/src/determinism.md
- https://github.com/uvucs3660/summer_2026/blob/HEAD/content/cs3540/2026/cheatsheets/determinism-and-replay.md
- http://dev.to/mighty840/a-pure-seeded-game-engine-gives-you-multiplayer-almost-for-free-4412
- https://github.com/endel/prediction-multiplayer-research/blob/HEAD/TECHNIQUES/deterministic-lockstep.md

**§4 Save/load**
- https://github.com/the-cyber-boardroom/sgraph-ai__app__send/blob/HEAD/library/sgraph-send/file-transfer-engine/research/03-browser-storage-apis.md
- https://dev.to/parsajiravand/localstorage-isnt-free-its-blocking-your-main-thread-nmn
- https://vectree.io/pdf/c/web-persistence-and-security-models
- https://github.com/pplancq/lab-clean-architecture-react/blob/HEAD/docs/architecture/adr/ADR-003-indexeddb-storage-strategy.md
- https://github.com/kumaratul60/system-design/blob/HEAD/Database&Caching/Database_Caching_QA.md

**§5 Pathfinding**
- https://github.com/cahyaong/ai.odin/blob/HEAD/.ai-context/IDEA_PathFinding.md
- https://www.pcgamer.com/planetary-annihilation-devs-show-planet-creation-tech-clever-unit-pathfinding/
- https://www.thefreelibrary.com/A+review+of+real-time+strategy+game+AI-a0396137268
- https://github.com/firzus/agent-skills/blob/HEAD/skills/enemy-ai-framework/techniques.md

**§6 Spatial partitioning**
- https://github.com/wormholeportal/makone/blob/HEAD/skills/three/spatial-partitioning.md
- https://github.com/fs-gg/fs.gg.game/blob/HEAD/docs/reports/2026-07-05-game-logic-collision-detection-design.md
- https://github.com/s-parfeniuc/asteroids-on-steroids/blob/HEAD/info/04_quadtree_spatial_grid.md
- https://github.com/orlandoluque/vectorial-hash-kit/blob/HEAD/docs/THREE_D.md

**§7 WASM**
- https://github.com/photrez/photrez/blob/HEAD/docs/research/2026-08-23-rust-ts-interop-forum-research.md
- https://github.com/thesysdev/openui/blob/HEAD/docs/content/blog/rust-wasm-parser.mdx
- http://dev.to/toolzip/webassembly-in-practice-what-it-is-when-to-use-it-and-when-not-to-52na
- https://dev.to/polliog/webassembly-is-ready-and-you-should-use-it-3n9a
- https://github.com/AndreaGalatolo/auris (GitHub Pages: no custom headers → no SharedArrayBuffer)
- https://github.com/maulikpokiya/mp3-splitter (same)
- https://github.com/emalenchek/3d-rendering-engine/blob/HEAD/docs/research/10-wasm-threads-hosting.md

**§8 Workers**
- https://github.com/tomlarkworthy/lopecode-dev/blob/HEAD/plan/worker-offload-reactive-runtime.md
- https://dev.to/g33konaut/javascript-in-parallel-web-workers-explained-5588
- https://www.webpronews.com/the-hidden-bottleneck-why-node-js-worker-threads-dont-work-the-way-you-think-they-do/
- https://github.com/stansys8/skovoroda/blob/HEAD/agent/instructions/node-event-loop/13-worker-threads.md
- https://github.com/verekia/webgamedev/blob/HEAD/src/pages/performance/web-workers.mdx

**§9 Profiling**
- https://github.com/rmalkevy/programming-practice-projects/blob/HEAD/courses/javascript/lab-07-engine-performance-testing.md
- https://github.com/rezmequick-dot/claude-team-config/blob/HEAD/agents/performance-engineer.md
- https://github.com/albertogalca/claude-commands-backup/blob/HEAD/skills/browser-runtime-performance-profiling/SKILL.md
