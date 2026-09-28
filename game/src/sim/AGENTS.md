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
- `snapshot.ts` — versioned snapshots (v2 adds city state).
- `terrain.ts` — seeded mapgen (not snapshotted); `spatial.ts` — hash grid.

## City/economy conventions

- All rates in `BUILDING_DEFS` are **per sim-second**; the economy system
  advances them once per 30 ticks (`ECONOMY_TICKS`).
- Utility allocation is id-ordered and per-player; providers (plants,
  pumps) must be road-adjacent to count.
- Growth draws only from the `'city'` RNG stream.
- Balance numbers in `BUILDING_DEFS` / `MARKET_PRICES` are Phase 1
  engineering choices — tune them, but keep the tests' reference-city
  invariants (net-positive materials/food, tax differential) green.

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
