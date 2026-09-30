# AGENTS.md — src/ui

HUD, menus, dialogs, camera, selection and orders. UI emits tick-aligned
command structs to sim/commands.ts — it never mutates sim state directly.

## Modules (0.1 Alpha)

- `session.ts` — canonical skirmish assembly (terrain, world, queue,
  driver, 5 systems in fixed order, starting forces, AI rival). The one
  place the full game is wired; headless-safe (no DOM/three.js).
  `createSession({ snapshot })` restores a saved game: no re-seeded
  starting forces, no duplicate AI player. `createSession({ mapPreset })`
  selects a MAP_PRESETS entry by name (default 'Meridian Plains'; unknown
  names fall back). Starting forces find land per-unit (not just at the
  base center) so high-water maps never reject spawns. `session.cheated`
  is UI-owned metadata (never sim state), stamped into save files.
  Registers `registerUpgradeCommands` (sim/upgrades.ts) so the research
  panel's `researchUpgrade` orders execute. Campaign missions grant
  `startingResources` AFTER the initial spawn tick: mission resources
  are the designed opening stockpile, so e.g. northern-border always
  opens at exactly 5000 funds even though spawnUnit now deducts
  training costs.
- `game.ts` — the game controller: renderer, daylight scene, camera
  input, selection, placement modes, fixed-timestep loop, pause menu.
  DOM + three.js; never imported by headless tests. `startGame()` tags
  its canvas (`data-novaterra="game"`) and removes any stale tagged game
  canvases first, so a leftover canvas can never paint over or swallow
  input for the live one (the menu's untagged backdrop canvas is hidden,
  not removed, and survives). `?inputdebug=1` turns on verbose
  pointer-event console logging for diagnosis.
  Step 11: owns the save store, the cheat console (backtick), the end
  screen, and autosave (every 5 game-minutes, tick-based).
- `cheatconsole.ts` — the cheat console overlay. `parseCheatCommand` is
  pure and tested (case/whitespace-tolerant); the `CheatConsole` class is
  DOM-only and emits parsed actions to the controller. Sim-affecting
  cheats go through the command queue with `issuer: 'cheat'`; `reveal`,
  `win`, `lose`, `help` are UI-only.
- `endscreen.ts` — victory/defeat overlay. Skirmish conquest victory
  (rival has no units/buildings) calls `showVictory()` and conquest
  defeat (player has no units/buildings) calls `showDefeat()`, both via
  `checkSkirmishVictory()` / `checkSkirmishDefeat()` in `session.ts`;
  `getSkirmishOutcome()` adds the 30-tick grace period and the
  mutual-elimination tiebreak (defeat takes precedence). The
  `win`/`lose` cheats also use it. No-rival skirmishes are sandbox
  (no win/lose condition).
- `saveslots.ts` — save/load slot picker dialog + pure
  `formatSaveSummary`.
- `hud.ts` — top bar, advisor panel, selection panel, tabbed train/build
  palettes, research panel, toasts. Calls back into the controller; never
  touches sim. `update()` runs every frame but only touches the DOM when a
  displayed value actually changed — the selection panel rebuilds only
  when its content digest (`ui/paletteDigest.ts`) changes, so palette
  button nodes stay stable across frames (recreating them every sim tick
  broke real clicks: pointerdown + pointerup landed on different nodes and
  no click event ever fired). TRAIN palette has 4 tabs (Infantry / Armor / Air / Navy),
  BUILD palette has 10 tabs (Housing / Civic / Commerce / Industry /
  Utilities / Power / Water / Naval & Air / Special / Logistics) — the spec groupings
  plus the Workstream Z civic tab (education buildings), plus the Phase 2
  utility tabs (the 13 new power/water buildings), plus the Phase 3
  logistics tab (the 7 new fuel/ammo production + depot buildings), see `palettes.ts`.
  Unavailable entries stay visible but disabled, with tooltip reasons
  (age, production building, cost, manpower, Naval Yard coast rule).
  Train buttons show funds + materials + manpower cost; build buttons
  show funds + materials. Selecting a completed Research Lab (or owning
  one with nothing selected) opens the research panel: all 19 upgrades
  in Military / Economy / Infrastructure / Logistics groups with one-line effects, cost,
  researched checkmark, and disabled reasons (the Phase 2 Infrastructure
  group is the utility research ladder: combustion → advanced nuclear →
  fusion, groundwater survey, desalination tech, grid storage). Selected
  military units show a veterancy line (Phase 1: rank + ▲ chevrons + XP
  progress, e.g. "Veteran ▲▲ · 320/500 XP" via `ui/veterancy.ts`); selected
  buildings show their crew training level ("Level 2/3", from economy.ts)
  AND a Phase 2 power/water diagnosis line ("Power: Shortage", "Water:
  Disconnected" — from the sim's `powerDiag`/`waterDiag`). All are
  digest-covered (`uv:` / `bl:` / `bu:` segments, AD11).
  Topbar (Phase 2): a "Utilities" toggle shows the utility overlay —
  served-power / served-water / fouled-source tint decals plus marker
  sprites over disconnected / shortage / stranded / fouled buildings
  (see `render/utilityOverlay.ts`). The power lines and water pipes
  themselves render always-on like roads (see `render/networks.ts`).
  Topbar (Phase 3): a "Logistics" toggle shows the logistics overlay —
  olive reload-point coverage discs (radius = the sim's
  `LOGISTICS_RADIUS`) plus amber ground rings under low-supply units
  (see `render/logisticsOverlay.ts`). Selected tracked units show
  fuel/ammo bars + a low-supply warning; supply units add the cargo
  line, Repair/Rearm/Refuel toggles, and a Resupply button (depot from
  `nearestDepot`, disabled with the named blocker from
  `resupplyBlockReason`); depots show their stock line. Digest-covered
  (`uf:` / `us:` / `bq:` segments, AD11).
  Topbar (workstream W): a "Land value" toggle shows the desirability
  overlay — the residential ground tint, red (low) → green (prime)
  (see `render/desirabilityOverlay.ts`, data via `ui/desirability.ts`).
  Selected residential buildings show their land-value line
  ("Land: Nice (64) · tax ×1.3", via `ui/desirability.ts`
  `landValueLine`); digest-covered (`bv:` segment, AD11).
  Tools row (Phase 2): "Power line" and "Water pipe" drag-paint tools ride
  the generic `linearNetworkDrag.ts` pipeline (see "Adding a
  linear-network kind" below) and emit `buildPowerLine` / `buildPipe`
  orders via `orders.ts`.
- `paletteDigest.ts` — **selection-panel content digest (pure, tested,
  `tests/ui.paletteDigest.test.ts`).** `hud.ts` rebuilds the selection
  panel only when this digest changes: it covers everything the panel
  renders (selection identity, active train/build tabs, per-button
  availability, research states, selected unit/building vitals), so costs
  and availability still refresh the moment they actually change while
  button nodes survive across frames (clicks need pointerdown + pointerup
  on the same node). Headless-safe; mirrors the `updateSelection` render
  branches — a branch that renders a value must digest it.
  Also exports `HUD_PANEL_BRANCHES`, the AD11 UI digest contract registry:
  every hud.ts panel branch (topbar, advisor, selection empty/units/
  building, train/build palettes, tools row, research panel, phase3
  panel, toast) with the digest segments it contributes (or a
  `noDigestReason` when it is static / never rebuilt / keyed separately).
  The contract test asserts each declared label really appears in digest
  output and scans hud.ts for unregistered panel methods / DOM classes —
  see "Adding a HUD panel" below.
- `menus.ts` — main menu (skirmish setup: map picker + difficulty picker),
  pause overlay, settings (quality, key list, accessibility, audio). Quality,
  colorblind mode, UI scale and audio persist in localStorage. Skirmish
  setup shows all 8 MAP_PRESETS (name
  + water %) and all 5 AI difficulties; `onStartSkirmish(difficulty,
  mapPreset)`. The setup column scrolls (`#menu .buttons` has
  `overflow-y: auto`) so every map/difficulty stays clickable on short
  viewports.
- `camera.ts` / `selection.ts` — pure state + transitions, fully tested.
- `orders.ts` — gesture → `OrderIntent` (`NewCommand` minus issuer);
  the controller stamps `issuer: 'player'` at enqueue. Includes
  `buildResearchUpgradeOrder(owner, upgrade)` for the research panel, and
  the Phase 3 logistics builders `buildResupplyOrder(unitId, depotId,
  owner)` / `buildSupplyTogglesOrder(unitId, owner, { repair, rearm,
  refuel })` — flat payloads, the exact shapes `registerLogisticsCommands`
  validates. Until the sim wires registration at boot, enqueue throws
  `CommandRejectedError` and the controller toasts loudly — never silent.
- `palettes.ts` — headless-safe palette data + availability logic for
  the tabbed TRAIN/BUILD palettes and the research panel: `TRAIN_TABS`
  (4 tabs, 30 units — Phase 3 workstream 3 added the supplyTruck/fuelTruck),
  `BUILD_TABS` (10 tabs, 53 buildings — workstream W added library+park),
  `UPGRADE_GROUPS` (military 8 / economy 4 / infrastructure 6 / logistics 1), `unitAvailability` /
  `buildingAvailability` / `upgradeAvailability` (ready | reason), cost
  formatters, and the
  Naval Yard coast-rule tooltip. Availability mirrors sim validation
  (age gate, production-building gate, affordability, manpower).
- `utilities.ts` — **Phase 2 utility contract module (pure, tested,
  `tests/ui.utilities.test.ts`).** The UI/render boundary for the sim's
  utility networks: the 13-building roster (`UTILITY_BUILDING_KINDS`),
  English names, diagnosis readers (`buildingPowerDiag` /
  `buildingWaterDiag` — the sim's `powerDiag`/`waterDiag` fields with a
  `powered`/`watered` fallback), producer sets derived from the sim's
  `BUILDING_DEFS` (`POWER_PRODUCER_KINDS` / `WATER_PRODUCER_KINDS`),
  `isStrandedPlant` (mirrors the sim's disconnected-producer rule), the
  two utility build tabs (derived from `BUILD_TABS` — never a second copy
  of the kind lists), `allBuildTabs()` (the canonical tab list hud.ts
  renders), and `utilityOverlayData(world, …)` — the read-only per-frame
  view the `UtilityOverlay` renders (served/fouled tint cells + marker
  list). Reads every sim field defensively (empty pre-sim → empty view),
  never writes sim state.
- `logistics.ts` — **Phase 3 logistics contract module (pure, tested,
  `tests/ui.logistics.test.ts`).** The UI/render boundary for the sim's
  missile/fuel logistics: `RELOAD_POINT_KINDS` / `SUPPLY_UNIT_KINDS`
  derived from the sim defs (never hand-maintained — the sim's canonical
  9 reload points: 4 production bases + 2 ammo producers + 3 depots; the
  cargo-carrying units: supplyTruck, fuelTruck, hauler),
  `LOGISTICS_LOW_SUPPLY` (0.3), defensive stock/cargo/fraction readers,
  `isDepotBuilding` (mirrors the `resupply` validation rule),
  `availableAmmo` / `availableFuel` (stock − reserved, crediting the
  unit's own live reservation — re-issue parity with the sim),
  `nearestDepot` (same owner, completed, available stock of something
  the unit needs, Euclidean nearest; null when nothing can help),
  `resupplyBlockReason` (the disabled-button tooltip — never a dead
  button), `serviceTogglesOf`, `depotStockLine`, `cargoLine`, and
  `logisticsOverlayData(world)` + FNV-1a `logisticsOverlayDigest` — the
  read-only per-frame view the `LogisticsOverlay` renders. Reads every
  sim field defensively, never writes sim state.
- `desirability.ts` — **workstream W desirability contract module (pure,
  tested, `tests/ui.desirability.test.ts`).** The UI/render boundary for
  the sim's derived desirability model (`sim/desirability.ts`):
  `landValueLine(model, b)` (the selection panel's "Land: Nice (64) ·
  tax ×1.3" line — residential buildings only, null-safe),
  `landValueTaxMultOf` (the `bv:` digest segment driver),
  `desirabilityOverlayData(t, world)` (the read-only per-frame view the
  `DesirabilityOverlay` renders: sorted cells + the model cache key).
  Reads every sim field defensively (empty pre-sim → empty view), never
  writes sim state.
- `linearNetworkDrag.ts` — **generic linear-network gesture pipeline (pure,
  tested, `tests/ui.linearNetworkDrag.test.ts`).** One drag-paint pipeline
  shared by every linear network tool: road today, power lines / water pipes
  (Phase 2) and rail (Phase 4) later (§AD10) — the network kind is a
  parameter, never a copy. `new LinearNetworkDrag({ kind, owner, gridWidth })`
  on pointerdown, `addCell` on pointermove (gap-fills an 8-connected walk so
  fast drags don't leave holes; identity for adjacent cells, so behavior
  matches the old road code), `finish(gesture)` on pointerup emitting exactly
  one outcome: an order (≥1 cell), a click fall-through (zero cells + click),
  or a swallow (zero cells, not a click). Click-vs-drag classification stays
  in `pointer.ts`; the click resolver (`resolveNetworkToolClick`) returns an
  order or a hint — nothing fails silently. `networkKindForTool` decides
  which build tools start a drag.
- `placement.ts` — **placement click resolution (pure, tested).** Every map
  click in a placement mode resolves here to either an `OrderIntent` (built
  with the `orders.ts` builders — the exact structs the controller
  enqueues) or a human-readable hint. Nothing fails silently: zone-tool
  clicks hint "drag a rectangle", off-grid/sky clicks hint train/build
  failed. `game.ts` enqueues orders / toasts hints via `placeResolution`.
  Invariants: a drag in train/building mode places at the release point
  (never becomes a box-select); a linear-network drag-paint is owned by
  `linearNetworkDrag.ts` from canvas pointerdown and finishes on pointerup
  before the select path.
- `pointer.ts` — **pointer-gesture classification (pure, tested).**
  `classifyPointerUp` decides click vs drag vs ignore for the
  controller's `pointerup` handler. The click rule is anchored on the
  PRESS: a primary-button press that started on the canvas and moved at
  most 6px counts as a click even when the release event's target is not
  the canvas (covers synthetic/automated events and sub-pixel drift onto
  a HUD edge — the old strict `e.target === canvas` gate silently
  swallowed these).
- `campaignui.ts` — campaign screens (Phase 2): `MissionSelect`
  (locked/unlocked/done), `MissionBriefing` (paths with 🕊/⚔ markers),
  `MissionDebrief` (debrief copy + diplomat/commander score + the two
  campaign endings), `MissionPanel` (in-HUD objective tracker).
- `musebox.ts` — the Muse widget: portrait, speech bubble, threat
  meter. Pure DOM; `MuseController` decides what to say.
- `icons.ts` — **hand-drawn inline SVG icon set (pure, tested,
  `tests/ui.icons.test.ts`).** Every button shows icon AND text (user
  directive 2026-09-30) — icons are `aria-hidden`, never icon-only.
  `unitIcon` / `buildingIcon` cover all 30 units + 53 buildings
  (`Record<UnitKind, string>` so a missing glyph is a compile error);
  `toolIcon` for the build tools row (incl. the Phase 2 powerLine /
  waterPipe tools); `mapIcon(waterFraction)` for the
  8 map presets (5 terrain buckets); `difficultyIcon` (1–5 rank
  chevrons); `menuIcon` for skirmish/load/missions/settings/back/
  resume/save/exit. 24×24 viewBox, `stroke="currentColor"` so button
  CSS (including locked dimming) drives the color. Decision record:
  `docs/research/ui-icons.md`.
- `session.ts` also assembles campaign missions:
  `createSession({ campaignMission })` — map/AI/starting resources from
  the mission, no AI rival when difficulty is 'none', owner 1 always
  funded with manpower for scripted raids.
- `game.ts` (Phase 2): owns the mission run + `MuseController` +
  `MuseBox` + `MissionPanel`; polls the campaign director ~2×/sec and
  Muse ~1×/sec in the game loop. Victory/defeat → debrief overlay →
  `onMissionEnd` records progress. Muse settings (frequency + live key)
  live in the settings panel, live-applied in game.
- `veterancy.ts` — **veterancy display helpers (Phase 1, pure, tested,
  `tests/ui.veterancy.test.ts`).** `vetXpLine(u)` formats the selection
  panel's per-unit line (rank + ▲ glyphs + XP progress, Elite shows the
  total); thresholds come from the sim's `VET_XP_THRESHOLDS`
  (single source of truth), rank copy from `STRINGS.veterancy.ranks`
  (pinned equal to the sim's `VET_RANK_NAMES` by test).
- `advisor.ts` — pure `evaluateAdvisor(world, playerId)`, worst-first.
- `strings.ts` — all NEW UI copy in one place, English-only (2026-09-30
  directive; see `docs/I18N.md` for how a future language is added):
  `LocalizedString` (`{en}` — the localization indirection, kept as the
  extension point), module-level language
  state (`setUiLanguage` / `getUiLanguage` / `loc` / `fillLoc`). Covers
  all 30 unit names, 53 building names, palette/upgrade tab names, the
  19 upgrade names + one-line effects, cost labels, and lock reasons.
  Legacy Phase 3 strings are still English-only; they were never localized.
- Audio: `game.ts` owns an `AudioEngine` (see `src/audio/AGENTS.md`) —
  unlocked on first pointer/key gesture, `updateMusic(world, playerId)`
  polled ~2×/sec, SFX on select/orders/placement/age-advance/rejections/
  deaths/buildings/advisor changes, pause = `audio.suspend()`.
  `menus.ts` SettingsPanel has master/music/SFX sliders + mute (persisted,
  live-applied in game).

## Rules

- Right-click attacks are gated by `canTarget(def, target)` — the same
  rule the Classic AI follows. Never order an impossible attack.
- Rejected commands toast loudly (`CommandRejectedError`); nothing fails
  silently.
- `S` is Stop, never camera-back. Camera back is ArrowDown.
- Starting forces live in `session.ts`, not in the controller.

## Adding a HUD panel (AD11 UI digest contract)

The 2026-09-30 click bug: `hud.ts` rebuilt the selection panel every sim
tick, recreating every palette button several times a second, so real
clicks (pointerdown + pointerup on the same node) never fired. The fix
rebuilds only when `selectionDigest()` changes — and the contract test
(`tests/ui.paletteDigest.test.ts`) keeps it that way as panels grow:

1. Render the panel in `hud.ts`.
2. Add every dynamic value it renders to `selectionDigest()` in
   `paletteDigest.ts` (additive: new segments only — never change an
   existing segment's meaning; the digest is the panel's rebuild key).
3. Register the branch in `HUD_PANEL_BRANCHES` (`paletteDigest.ts`):
   id, `renderedIn` (hud.ts method), the `domClasses` it creates, and the
   `digestLabels` it contributes — or `noDigestReason` when the branch is
   truly static / never rebuilt.

The test enforces all three: any `append*/build*/update*` method or
`el()/className` DOM class in hud.ts that is not registered fails the
suite, and each declared `digestLabels` entry must literally appear in
digest output for a representative state. (The advisor panel's key was
extended to severity+title+detail on 2026-09-30 so it cannot go stale.)

## Adding a linear-network kind (Phase 2/4)

Power lines and water pipes (Phase 2, done) — and rail (Phase 4) later —
reuse the road tool's drag gesture through `linearNetworkDrag.ts`: do not
copy the pipeline. `LinearNetworkKind` is `'road' | 'powerLine' |
'waterPipe'`; `orders.ts` has `buildPowerLineOrder` / `buildWaterPipeOrder`
(emitting `buildPowerLine` / `buildPipe` commands); `toolForKind` maps the
kinds to the `powerLine` / `waterPipe` build tools; `networkKindForTool`
starts a drag for those tool strings. Steps for a NEW kind: (1) extend the
`LinearNetworkKind` union; (2) add the order builder in `orders.ts` and
wire it into the pipeline's `buildNetworkOrder` switch; (3) map the kind
to its build tool in the pipeline's `toolForKind` switch; (4) extend
`networkKindForTool` with the new tool string; (5) add unit tests for the
new kind (accumulation, order payload, click resolution). The two
switches are exhaustive with no default arm, so the compiler fails after
step 1 until steps 2–3 are done — a new kind can never silently fall
through. The controller wiring in `game.ts` (`bindInput`) is already
kind-agnostic and needs no change.
