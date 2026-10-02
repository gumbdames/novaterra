# CHANGELOG — NOVATERRA

All notable changes to the 0.1 Alpha. Commit hashes are the local `main`
history (`gumbdames/novaterra`).

## [Unreleased] — Phase 3 roadmap B23–B29 (2026-10-02)

- **B23** (`a3cbd0f`): soak tests split into their own CI job
  (30-min timeout, verbose reporter, per-file timing budgets) — targets
  the `onTaskUpdate` RPC flake that correlated with long reporter-quiet
  stretches.
- **B24** (`bc36296`): tests for the last untested surfaces —
  `ui/hud.ts`, `ui/seatrade.ts`, `sim/market.ts` (27 tests) + shared
  `fakeDom` headless harness. Fixed 2 real bugs: `seaTradeCargoLine`
  "Hold: empty" contract, advisor all-clear first-paint.
- **B25** (`43e073f`): autosave hygiene — snapshot v9 slims flow-field
  internals out of the save (was 1.5 MB of 1.88 MB); pathfinding
  rebuilds on load; pre-write size log + explicit `SaveQuotaExceededError`
  with a player-facing toast.
- **B26** (`3e64e1f`): max-diversity draw-call regression test
  (structural ceiling pinned at 695; procedural model builder now merges
  parts by material signature). The 200/frame budget stays the per-frame
  gate; full-diversity scenes remain structurally over it (documented).
- **B27** (`a1adad8`): zero-`any` / zero-`!` / strict +
  `noUncheckedIndexedAccess` locked in CI via the extended A8 cycle
  guard (~88 `!` assertions removed across sim/render/ui).
- **B28** (`8f2b54b`): docs punchlist — 14 false/stale items fixed and
  verified against code (corvette copy, naval paragraphs, air-defense
  tip, trade-route menu surface, roster counts 97/100, upgrade docs,
  PLAN.md naval entry, entity-instancing header, all toasts + Muse-box
  copy through `loc()`).
- **B29**: `docs/MODDING.md` (data-driven add-a-unit/building/upgrade
  recipes) + this changelog.
- **Fix** (`3096a90`): licensed music `peace.mp3`/`war.mp3` 404ing on
  the live site — restored via the asset pipeline + a build-time guard
  test.

## 2026-10-02 — Phase 3 roadmap B13–B22

- **B13** (`c5a570e`): on-map combat feedback — floating damage numbers,
  screen shake, building damage state (HP bars + smoke).
- **B14** (`9dad5a5`): advisor diagnosis coverage — fuel root causes,
  stranded aircraft, sabotage, burned spies.
- **B15** (`6b821ee`): settings gaps — edge-pan toggle, key-list docs,
  topbar wrap, colorblind desirability.
- **B17** (`724478f`): construction dressing — scaffold frames + dust
  puffs on buildings under construction.
- **B18** (`8f3cf6c`): per-tab menu color identity
  (Civilian/Military/Management accents).
- **B19** (`4d3a65f`): per-instance building hue jitter on the
  instancing layer.
- **B20** (`143dacf`): tension music — enemy-proximity driver +
  procedural tension bed.
- **B21** (`45d5843`): aircraft banking, ship bob, ship wakes, richer
  ambient bed.
- **B22** (`9362385`): route-lifecycle unification — shared
  endpoint-route abstraction + cargo kernel.

## 2026-10-01/02 — Phase 3 roadmap B1–B12

- **B1** (`2525ed7`): peaceful-mode score + milestones.
- **B2** (`daa128d`): alternative skirmish victories (economic,
  population, monument).
- **B3** (`edd6781`): minimal diplomacy — tribute, demands, ceasefires.
- **B4** (`6b6e671`): select-all-military hotkey (rally points
  deliberately not built — no production queues exist).
- **B5** (`4e54eea`): veterancy curve softened (300/800/1600).
- **B6** (`97fd167`): Commander/General age advancement via shared
  `thinkMilitaryAges`.
- **B7** (`5ae7c80`): storm retune (STORM_DAMAGE 120 → 200).
- **B8** (`7be9f1e`): capital / war-weariness defeat rule.
- **B9** (`289f042`): repeatable late research — Advanced Research
  +2%/level.
- **B10** (`4919145`): per-resource income/outflow + Economy overview.
- **B11** (`1e4ac08`): build-complete feedback — SFX cue, placement
  ghost, armed-tool indicator.
- **B12** (`510de4d`): tactical minimap.

## 2026-10-01 — Phase 3 remediation (A-track)

- **A10** (`79177b3`): Marshal logistics — honest virtual-depot
  economics, queue-based naval loading; 6× cheat removed.
- **A9** (`df6194b`): advisor false advice — materials copy fix, removed
  engineer-construction myth.
- **A8**: import-cycle guard in CI.
- Per-side ages, tutorial repair, AI fairness (fog-of-war + variant
  counters), combat VFX, desirability hitch fix (top-5).

## 2026-10-01 — Grand expansion

The big long-playable game: utilities, transport, airports-as-zones with
civilian airlines, veterancy, expanded navy/air, fuel/ammo logistics
chains, intel/spies, civilian deep-dive, peaceful no-military mode.
Roster: 97 units / 100 buildings / 21 upgrades. Notable: naval-model
military half (`a16200d` — Naval Shipyard / Naval Base / Civilian
Shipyard / Commercial Harbor reframe).

## 2026-09-29/30 — Post-launch remediation R1–R6

Spectre stealth flag, API-key UI rip-out, destructible buildings + AI
siege doctrine, endless peaceful mode, spatial combat index, CI live,
docs rewritten, victory/defeat stingers, polish.

## 2026-09-28 — 0.1 Alpha launch

Initial release: 3D city-builder × RTS hybrid — build cities, wage war,
advance through five ages. 8-mission campaign "The First Term",
skirmish vs 5 Classic AI difficulties, deterministic sim, 8 maps.
