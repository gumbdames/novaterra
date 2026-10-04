# CHANGELOG — NOVATERRA

All notable changes to the 0.1 Alpha. Commit hashes are the local `main`
history (`gumbdames/novaterra`).

## 2026-10-04 — RTS controls, Mode 2 Muse Persona, art, audio + bug-fix pass

- **RTS controls** (`8322253`, `781773d`): multi-cell structure click
  selection, WASD camera, marquee box-select on left-drag (reverses the
  fun-audit "no gesture swap" dead end — recorded in `docs/REVERSALS.md`
  §7), Stop on `H` / `Shift+S` / `Ctrl+S`, select-all-military on `X` /
  `Ctrl+A`, control groups (`Ctrl+1..9`, `1..9`, `Shift+1..9` union,
  double-tap camera focus), double-click type selection, attack-move
  (`T` / `Alt+A`), command theatres (sim support; no player UI yet).
- **Mode 2: Muse Persona** (`c46a7ee`): local deterministic heuristic
  opponent with adaptive counter-doctrines and persona dialogue. Honest
  wording throughout — it is NOT a neural network and NOT the real Muse.
- **Art** (`f5d5a3d`): menu hero, 8 mission briefings, 8 skirmish cards,
  Muse portrait — all wired and lazy-loaded.
- **Audio** (`a0c6415`): layered weapon concussion, tactical radio chatter.
- **Bug-fix pass** (2026-10-04): attack-move keeps its destination
  through chase/back-off; Mode 2 saves load as Mode 2 (`opponentMode`
  in save metadata + `AIPlayerState`, snapshotted + digested, AD9);
  Mode 2 AI sight-gated (fair-AI contract, no maphack); digest gaps
  closed (theatres, attack-move state); `Shift+1..9` works via `e.code`;
  `Ctrl+S` no longer opens the browser Save dialog; right-click during
  a marquee cancels it; docs corrected (bindings, five ages, key list).

## 2026-10-02 — Fun audit (C6/C7/C1 + Phases 1–2, determinism, Phase 4 Tiers 1–4)

User-approved plan ("build it all", `docs/research/fun-audit-2026-10-02.md`):
the game should be fun, exciting, and interesting to play.

- **C6** (`f0a3076`): illustrated victory/defeat end screens — six realistic
  terrestrial illustrations (one per victory kind + annihilation /
  lost-the-race), lazy-loaded, cinematic camera drift, camera restored on
  dismiss.
- **Fun-audit Phase 1** (`dfe0b29`): Tier 0 (A1–A5) + B1/B4/B5 — correct age
  toasts, named Muse announcements for units/buildings/research, a war-core
  warning before defeat, an opening camera sweep with an objective, a rival
  victory-progress strip, off-screen event pings.
- **C7** (`42327ff`, B27 fix `97f9453`): visual day/night cycle driven by the
  sim tick (pause/save-safe) — interpolated sky/light/fog/exposure/water,
  glass glow, one-draw-call stars; visual only, zero gameplay effects.
- **C1** (`6249810`): AI physical forward bases — commander gets a fuel depot,
  general + ordnance depot, marshal + radar; virtual fuel/ammo stocks accrue
  only while the matching depot stands complete and operational, and a
  destroyed depot zeroes its reserve. Exposed and fixed a pre-existing
  snapshot bug (`seenBuildingIds` captured by reference in `encodeAIState`).
- **Fun-audit Phase 2** (`1e3304c` B2+B3, `5c70a02` B7): 5-minute wonder
  countdown (Monument completion / 80% of economic-population targets — the
  leader must defend, escalating warnings), endgame statistics on the end
  screen and in the campaign debrief. B7 acceptance passed: the AI is
  physically beatable by razing its forward base (no fallback needed).
- **Determinism hardening** (`86080cc`): new `sim/deterministic.ts`; all 34
  `Math.hypot` sites and the sin/cos/log uses replaced with deterministic
  equivalents; the B27 lint guard bans transcendentals in `src/sim/` (verified
  against a planted violation); no digest pins changed.
- **Phase 4 Tier 1** (`4e8a8ef` B6, `87dd909` B8): scheduled escalating
  telegraphed AI offensives (probe ~8 min, offensive ~15 min, all-in ~25 min;
  1-minute warnings via Muse/HUD/threat flash/pings at real muster points;
  ceasefires delay waves, never cancel them) + rival age-ups as announced
  global events with a vulnerability-window message.
- **Phase 4 Tier 2** (`7201c8f` queues, `d4e4d4b` triage): real production
  queues — per-unit train times (5–20s), visible queue with progress bars,
  pause, cancel with full refund, rally flags; `spawnUnit` kept for
  AI/campaign/demo. Dead-system triage: engineer construction/repair aura
  (2× build speed + 1 hp/s repair within 12 cells, automatic), influence-cost
  diplomacy (tribute 20, ceasefire 40 — paid whether the AI accepts or not),
  land trade deleted (routes had no physical endpoints), civilian transports
  consolidated (one trainable Cargo Plane/Airliner/Freighter; the rest delisted
  but kept for save compatibility).
- **Phase 4 Tier 3** (`7ae88f7` fog, `07fc8df` onboarding, `e1c1c2a` doctrines,
  `c44bbcf` networks): genuine player fog of war (shroud / dimmed / clear,
  using the AI's own sight model — no fallback needed); onboarding that
  teaches the game's verbs and the economy's mental model; Republic/Kestrel
  doctrine asymmetry (Republic: better sensors, stronger engineers, the
  Aegis Battery missile shield; Kestrel: tougher armor/artillery, the
  very-long-range Tempest Cannon, weaker AA); quantitative utility networks —
  power-line capacity, ×1.25 road-frontage throughput bonus, data-driven
  adjacency synergies — while roads stay purely optional.
- **Phase 4 Tier 4** (`1b79789` E1, `1ad4153` E2, `930b49d` E3): the Envoy at
  the Gates (a neutral SUV drives to your gates when the AI answers a
  ceasefire — 60-second answer window, dove release over the capital); six
  Luminary cards (Defector, War Hero, Whistleblower, Tycoon, Logistics
  Prodigy, Cartographer — once per age, a 3-minute audience with costs on
  both sides); the Vostok Combine merchant-only freighter (visits every
  12–18 min, anchors 3 min, emergency stock at 2× market, no sell-back, no
  raid in 0.1 Alpha). All three share the single `neutralNonCombatant` gate.

Final: 3075/3075 tests (199 files), tsc/build/check:cycles clean, hosted CI
green on every commit, deployed to gh-pages.

## 2026-10-02 — Phase 3 roadmap B23–B29

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
