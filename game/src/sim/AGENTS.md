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
- `snapshot.ts` — versioned snapshots (v3 adds units + pathfinding state).
- `terrain.ts` — seeded mapgen (not snapshotted); `spatial.ts` — hash grid.
- `units.ts` — `UnitRecord` store (stable ids, owner/kind/speed/state),
  `spawnUnit` command. Placeholder kinds `civilian` (6 u/s) / `soldier`
  (8 u/s); the real roster lands in step 7. Movement state (`path`,
  `fieldId`, `destX/Z`, `arriveX/Z`) lives here too.
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
