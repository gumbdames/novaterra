# AGENTS.md — src/sim

Deterministic fixed-timestep simulation lives here: plain-data world state,
tick driver, commands, systems, pathfinding, spatial index, digest, serialize.
No DOM, no three.js, no Web Audio — the sim must run headless in Node for
tests and the perf harness. See docs/ARCHITECTURE.md §1–§5.

## Module map

- `rng.ts` — mulberry32 + named streams via `createRngBank` / `rngBank`.
- `world.ts` — the `World` store; owns `city: CityState` (imports
  `initCity` from `city.ts`).
- `tick.ts` — 30 Hz accumulator driver, fixed system registration order.
- `commands.ts` — tick-aligned queue, `{ validate, apply }` specs,
  validate-at-enqueue-AND-apply, loud rejections.
- `city.ts` — city grid, roads, zones, buildings, players, placement
  validation, growth. Registers `buildRoad`, `paintZone`,
  `placeBuilding`, `demolish`, `setTaxRate`. Imports `World` type-only —
  this is what breaks the `world.ts` ⇄ `city.ts` cycle (`city.ts` takes
  `createRngBank` directly from `rng.ts` instead of `rngBank` from
  `world.ts`).
- `economy.ts` — the 1 Hz economy system (`createEconomySystem`),
  fixed-rate market (`marketTrade`), tax collection. Pure w.r.t.
  rendering.
- `digest.ts` — FNV-1a canonical encoding, including full city state.
- `snapshot.ts` — versioned snapshots (v4: units + pathfinding + Classic AI state).
- `terrain.ts` — seeded mapgen (not snapshotted); `spatial.ts` — hash grid.
- `units.ts` — `UnitRecord` store (stable ids, owner/kind/speed/state),
  `spawnUnit` command. The 11-unit MVP roster (8 land: engineer, rifles,
  tank, artillery, aa, hauler, spectre, hq; 3 air: fighter, transport,
  drone) with combat stats (`UnitDef`: hp, speed, armor, damage, range,
  minRange, targets, vsArmor/vsAir multipliers, sight). Movement state
  (`path`, `fieldId`, `destX/Z`, `arriveX/Z`) and combat state (`domain`,
  `hp`, `cooldownLeft`, `targetId`, `chasing`) live here too.
- `combat.ts` — deterministic combat resolution: `canTarget` (domain
  checks), `damageMultiplier` (armor counters, vsAir, HQ aura),
  nearest-target acquisition with stable-id tiebreaks, weapon firing with
  cooldowns, opportunistic fire, explicit `attackUnit` chase orders, death
  cleanup. No RNG — fully deterministic.
- `ai.ts` — Classic AI levels 1–3 (cadet/citizen/commander). Deterministic,
  fair (only sees enemies via `getVisibleEnemies()`, never reads enemy
  positions directly). Issues standard commands (`spawnUnit`, `moveUnit`,
  `moveGroup`, `attackUnit`) through the queue. Think cadence: 240/120/60
  ticks. State (`AIPlayerState`: owner, difficulty, base, nextThinkTick,
  forwardBase, scoutIndex, builtCounts) is plain data — snapshotted (v4)
  and digested. `getVisibleEnemies` adds the Signals Grid sight bonus.
  The AI stays in Foundation: its spawn choices are filtered by
  `isUnitAvailableForAge` (commander falls back from fighter to AA).
- `ages.ts` — Ages (Foundation → Connectivity) + National Program choice
  (Step 8). `AgeState` (`age`, `program`) lives on `World.ages`, plain
  data — snapshotted (v4) and digested. `advanceAge` command validates:
  current age is Foundation, program is fiberGrid/signalsGrid, and the
  player can afford the cost (3000 funds + 1200 materials). The choice is
  permanent. Effects: Fiber Grid ×1.25 tax income (`getTaxMultiplier`,
  applied in `economy.ts` `runTaxes`); Signals Grid +8 sight
  (`getSightBonus`, applied in `ai.ts` `getVisibleEnemies`). `UnitDef`
  carries `minAge`; fighter requires Connectivity (gated in `spawnUnit`
  validation).
- `pathfinding.ts` — deterministic 8-direction A* (octile heuristic,
  corner-cut prevention, water blocking, roads ×0.5) + chunked Dijkstra
  flow fields with early exit + the time-sliced coordinator
  (`PATHS_PER_TICK=3` A*, `FIELD_POPS_PER_TICK=600`).
- `movement.ts` — the pathfinding + movement systems (registered in that
  order), `moveUnit` / `moveGroup` / `stopUnit` commands, waypoint and
  field following, arrival slowdown, formation slots, spatial-hash
  separation.

## City/economy conventions
- All rates in `BUILDING_DEFS` are **per sim-second**; the economy system
  advances them once per 30 ticks (`ECONOMY_TICKS`).
- Utility allocation is id-ordered and per-player; providers (plants,
  pumps) must be road-adjacent to count.
- Growth draws only from the `'city'` RNG stream.
- Balance numbers in `BUILDING_DEFS` / `MARKET_PRICES` are Phase 1
  engineering choices — tune them, but keep the tests' reference-city
  invariants (net-positive materials/food, tax differential) green.

## Movement/pathfinding conventions
- **System order: pathfinding BEFORE movement** every tick. Movement
  consumes freshly completed paths/fields the same tick they land.
- **A* is for single units; flow fields for groups.** A* caps at
  `ASTAR_MAX_EXPANDED` (1000) and falls back to a chunked field; the
  field flood is reverse Dijkstra (charge cost of *entering* the popped
  cell) with early exit at a one-cell margin around waiting units.
- **Directions are derived, not stored during the flood:** each reached
  cell points along argmin(forward step cost + neighbor dist), ties to
  the lowest direction index, with the corner-cut rule. Never point at
  raw neighbor dist alone — road/diagonal costs make that suboptimal.
- **Groups arrive on formation slots** (`slotOffset`: concentric square
  rings, 2.5 apart, no trig) — one unit per slot, never stacked.
  `arriveX/Z` is the unit's own slot; `destX/Z` the ordered point.
- **Separation never fights arrival:** only `moving` units are in the
  separation hash (parked units are invisible to it), and a unit inside
  `SLOW_RADIUS` of its slot ignores pushes. Separation radius (6) >
  slot spacing (2.5) would otherwise deadlock arrival.
- **Loud failures:** unreachable destinations fail at the coordinator
  (`no path`, `unreachable by flow field`) with the unit unmoved — never
  silent, never partial.

## Combat/AI conventions

- **Combat is deterministic and RNG-free.** Target acquisition is nearest
  in range with stable-id tiebreaks. Damage uses armor/domain multipliers
  and the HQ aura (+25% damage within 20 units) — no dice rolls.
- **Explicit vs opportunistic targeting:** `attackUnit` sets `targetId` +
  `chasing = true` (the unit pursues out-of-range targets). The combat
  system may set `targetId` opportunistically for in-range fire without
  setting `chasing`. Tests distinguishing "AI ordered an attack" must
  check `chasing`, not just `targetId`.
- **AI fairness is structural.** The AI never reads enemy positions
  directly — all perception flows through `getVisibleEnemies()`, which
  filters by sight range from the AI's own units. The AI issues the same
  commands a human would; it never mutates world state directly (except
  its own `world.ai` record).
- **AI respects command validation.** Before issuing `attackUnit`, the AI
  checks `canTarget()` — a rejected command throws `CommandRejectedError`,
  which would break determinism if unhandled. The AI only orders units
  whose weapons can engage the target's domain.
- **AI state is sim state.** `world.ai` is plain JSON-safe data, covered
  by snapshots (v4) and the canonical digest. Deterministic replay and
  save/resume tests must include AI players.

## Determinism contract (non-negotiable)

Same seed + same commands ⇒ identical state, on the same machine/engine.
Everything in this directory serves that:

- **No wall clock, no `Math.random`.** Time enters only through
  `tick.step(world, frameMs)`; randomness only through `rng.ts`. Grep for
  `Math.random`, `Date.now`, `performance.now` before committing — the only
  allowed hits are comments.
- **Fixed system order.** Systems run in registration order every tick
  (`tick.ts`). Never reorder at runtime, never branch order on state.
- **Deterministic iteration.** Iterate `world.entities` (spawn order) or
  explicitly sorted structures. Never iterate a `Map`/`Set` for sim logic
  unless you built it deterministically and can prove the order.
- **Tick-aligned input.** Commands apply at tick starts via
  `commands.ts`, sorted by (tick, issuer, seq). Nothing reads UI/AI state
  mid-tick.
- **Floats are fine, dust is not.** IEEE-754 doubles are deterministic in
  one engine; transcendental use is documented per call site. The
  accumulator epsilon in `tick.ts` exists because float subtraction dust
  (~1e-13/tick) can lose whole ticks — see D9 in ARCHITECTURE.md.
- **RNG streams are named and independent.** `rngBank(world).next('combat')`
  never shifts `'economy'`. Stream state lives in `world.rng` — part of
  every snapshot and digest.
- **`world.time` is derived** (`tick / TICK_HZ`), never accumulated.

## Module conventions

- State is interfaces + factory functions; no methods on state, nothing
  unserializable. If it can't survive `JSON.parse(JSON.stringify(x))`, it
  doesn't belong in the world.
- Snapshots are taken at tick boundaries. The driver's accumulator is
  wall-clock-derived and intentionally excluded.
- Rejections are loud: `CommandRejectedError` / `SnapshotVersionError`
  carry reasons. Never silently skip, coerce, or default.
- New command kinds register a `{ validate, apply }` spec in `commands.ts`.
  Validate at enqueue AND at apply (state may have changed); stale commands
  throw, deterministically.
- Digest changes are significant: if `digestWorld` output changes for the
  same script, something in the sim changed — investigate, don't update
  the test blindly.
