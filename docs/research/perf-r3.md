# R3 Performance Hardening — Combat Targeting (0.1 Alpha)

Date: 2026-10-01. Scope: final-review R3 item "combat grid verification +
worst-case test". Code: `game/src/sim/combat.ts`, `game/src/sim/superweapons.ts`.
Tests: `game/tests/sim.combat-spatial.test.ts` (2 new R3 perf scenarios).

## Method

- Reference VM: 2 vCPU shared dev box. Timing is noisy (GC + worker
  contention — a sibling's full-suite run pushed load past 6 during
  measurement); every figure below is best-of-N after warmup, and the
  committed regression tests use best-of-N + `retry` for the same reason.
- Harness: `vite-node` scripts in `/tmp` (disposable; see list below),
  plus the vitest scenarios themselves.
- Budget: one sim tick = 33.3ms (30 ticks/s). Perf scenarios are tests,
  not aspirations — CI fails over budget.

## Change 1 — target grid cell 64 → 16 with nearest-cell-first exact pruning

### Why

R1's per-tick dense grid (`targetGridFor`, cell 64) made every short-range
query scan a 128×128 area. In a dense engagement (units at formation-slot
spacing 2.5) a rifles unit with range 8 swept ~700 units per query — a
2000-unit army spent 100ms+ per tick just acquiring targets, 3× the tick
budget. Smaller cells shrink each query's candidate set; visiting cells
nearest-first with an exact prune skips cells that cannot improve the
current best.

### The prune (exact, not heuristic)

Cells are visited in order of minimum possible distance from the shooter.
Once `bestDist` is known, a cell whose closest point is farther than
`bestDist + 1e-9` is skipped. This is **exact**: every candidate in a
pruned cell sits strictly farther than `bestDist + 1e-9`, so none can
strictly improve the distance, and none can win an id tiebreak (a tie
needs distance ≤ bestDist). The result is bit-identical to the legacy
full scan — proven in the code comments and pinned by the R1 identity
test (seeded mixed configurations, stealth/shelter/domain filters) and
the digest-stability suite.

### Results (2000 units, acquireTarget sweep, best-of-5, ms)

| Scenario | Before (cell 64) | After (cell 16 + prune) |
|---|---|---|
| Formation density (2.5 spacing, realistic worst case) | 100.83 | **17.44** |
| Sparse (maneuver warfare) | 1.37 | 5.84 |
| Pathological 100×100 all-mutually-in-range | 50.6 | 35.7 |

Sparse got slower in absolute terms (1.37 → 5.84) — smaller cells mean
more cell visits per query — but 5.84ms is 5.7× under budget and the
formation case improved 5.8×. Trade accepted.

The pathological case (every unit in range of every other) is
**physically unreachable**: separation radius 6 means 2000 movers need a
≥249×249 box, so a 100×100 mutual-range brawl cannot happen. It improved
1.4× anyway; documented here as a known limit, not a target.

### Rejected variants (all measured, all documented)

| Variant | Formation 2000 | Sparse | Dense-100 | Verdict |
|---|---|---|---|---|
| Prune-only at cell 64 (no cell shrink) | 84.6 (was 50.6 dense) | 1.69 | — | **Rejected**: allocation+sort overhead, no gain |
| Cell 16, no sorting (corner-first loop order) | 103.9 | — | — | **Rejected**: loop order kills pruning; worse than before |
| Cell 16, two-phase (own cell, then sorted rest) | 25.2 | 6.5 | 28.3 | **Rejected**: less headroom than sorted in the realistic case |

## Change 2 — batched mass-kill target cleanup

### Why

`killUnit` used to clear each dead unit's attackers with an O(units)
scan per kill. A storm strike killing 500 units in one tick made that
O(kills × units): **52.84ms** for 500/2000 on the reference VM — over the
tick budget by itself.

### The fix

`killUnit` no longer scans; it records the dead id in a module-level
`WeakMap<World, Set<number>>`. `flushDeadTargetRefs(world)` runs one
O(units) sweep at the end of the combat system (after the dead-list
kills) and after each superweapon strike loop, clearing stale `targetId`
/ `chasing`. Two companion cleanups in the same pass:

- `world.units.includes(d)` → O(1) `findUnit(world, d.id) === d`
  (the R1 id→unit index; ids are never reused, `nextId` is monotonic).
- Dropped the redundant roster `.sort()` — `world.units` is always
  id-ascending (append-only spawns, order-preserving splices).

End-of-tick state is identical to the eager scan: the combat loop's
per-tick validation already drops dead targets, and both flush points
run before any AI read of `targetId`.

### Results (500 kills / 2000 units, ms): 52.84 → **4.49** (11.8×), zero stale refs.

## Determinism

No `Math.random` / `Date.now` / `performance.now` in sim code (the tests
use `performance.now` only for timing, never for sim state). The prune is
exact (bit-identical targets); kill batching preserves end-of-tick
state. `digestWorld` output is unchanged for the same scripts — pinned by
the digest suite plus the new spawn/kill-heavy digest-stability test
(R3 item 2).

## Regression tests added

`game/tests/sim.combat-spatial.test.ts`:

- `acquireTarget worst case (R3)`: 2000 units at formation density
  (2.5 spacing), full sweep must complete under 33.3ms (best-of-7 after
  3 warmups, `retry: 3` — shared runners are noisy).
- `mass-kill target cleanup (R3)`: 500 kills in one tick; asserts all
  1500 survivors have zero stale `targetId` and the whole kill+flush
  completes under 33.3ms (measured ~0.7–4.5ms).

## Scratch scripts (disposable, /tmp)

`measure-dense.ts`, `measure-sparse.ts`, `measure-formation.ts`,
`measure-kill*.ts`, `profile-acquire.ts`, `profile-formation.ts`;
variant patches `r3_prune2.py`, `r3_nosort.py`, `r3_twophase.py`,
`r3_killbatch.py`, `r3_docs.py`, `new_acquire.py`. None are part of the
repo; the committed tests above are the durable record.
