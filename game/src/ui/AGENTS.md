# AGENTS.md — src/ui

HUD, menus, dialogs, camera, selection and orders. UI emits tick-aligned
command structs to sim/commands.ts — it never mutates sim state directly.

## Modules (0.1 Alpha)

- `session.ts` — canonical skirmish assembly (terrain, world, queue,
  driver, systems in fixed order, starting forces, AI rival). The one
  place the full game is wired; headless-safe (no DOM/three.js).
  `createSession({ snapshot })` restores a saved game: no re-seeded
  starting forces, no duplicate AI player. `createSession({ mapPreset })`
  selects a MAP_PRESETS entry by name (default 'Meridian Plains'; unknown
  names fall back). Starting forces find land per-unit (not just at the
  base center) so high-water maps never reject spawns. `session.cheated`
  is UI-owned metadata (never sim state), stamped into save files.
  Registers `registerUpgradeCommands` (sim/upgrades.ts) so the research
  panel's `researchUpgrade` orders execute, and `registerIntelCommands`
  (sim/intel.ts) for the covert-op commands (`infiltrateBuilding` /
  `sabotage` / `stealTech`); the intel mission system
  (`createIntelSystem`) runs in the fixed system order after the
  economy system. Campaign missions grant
  `startingResources` AFTER the initial spawn tick: mission resources
  are the designed opening stockpile, so e.g. northern-border always
  opens at exactly 5000 funds even though spawnUnit now deducts
  training costs. `sandbox: true` builds a peaceful world with no AI
  rival and no victory condition — the living menu demo uses it (the
  director is the sole author); default false, existing callers unchanged.
  `peaceful: true` (grand-expansion Phase 8, workstream A, 2026-09-30)
  builds a PEACEFUL skirmish: `world.peaceful` is set at tick 0 (never
  toggled mid-game; restored sessions carry the snapshot's flag) and the
  AI rival KEEPS PLAYING — it just plays peacefully (grand-expansion
  Phase 8, workstream C, 2026-09-30: the rival runs `thinkPeaceful`
  and no longer even FORMS military orders — the `canTrain` gate plus
  the peaceful dispatch mean zero military orders reach the command
  layer, not merely rejected ones). Starting forces swap the 4 rifles
  for 4 haulers
  (same count — the AI's cap headroom math is unchanged). Conquest is
  bypassed: `checkSkirmishVictory` / `checkSkirmishDefeat` return false
  and `getSkirmishOutcome` returns null for peaceful worlds (the
  peaceful victory `checkPeacefulVictory` in sim/peaceful.ts owns the
  outcome; `game.ts`'s `maybeShowConquestOutcome` early-returns). NOT
  the same as `sandbox`: sandbox skips the rival entirely; peaceful
  keeps the rival and has a builder's victory condition (8,000 housed
  residents, non-negative treasury). The peaceful victory UI panel
  (workstream B, 2026-09-30) is in: the skirmish-setup toggle
  (`menus.ts`) flows through `main.ts` → `GameOptions.peaceful` →
  `createSession`; `game.ts`'s `maybeShowConquestOutcome` routes
  peaceful worlds to `peacefulOutcome` / `peacefulEndCopy`
  (ui/peaceful.ts) and the existing `EndScreen` with peaceful copy —
  the rival winning the race first is a peaceful DEFEAT (same-tick
  ties go to the player). The Management tab heads with the live
  objectives section, the Military tab is hidden, and covert-op
  buttons are replaced by a note.
- `demoDirector.ts` — the living menu demo (workstream X, 2026-09-30).
  `createDemoSession()` = canonical `createSession()` (sandbox, fixed
  `DEMO_SEED`) + a designed opening stockpile (campaign
  `startingResources` precedent); `DemoDirector` then plays a scripted
  movie through the REAL command queue (`issuer: 'demo'`) paced to the
  menu camera's orbit (0.0011 rad/tick → 5,712 ticks/orbit; the movie
  sustains ~10.4 orbits, ~59,400 ticks): a 44×44-cell town site (zoned
  RES/COM/IND/UTL quarters) → roads → buildings → power/water →
  barracks/warFactory/fuelDepot → rifles/trucks/tanks/drones/fighters +
  resupply → four age advances → transit/rail/airport → Storm Array →
  storm strike → `done` (the menu restarts the movie). 128 commands,
  zero failures; the trial's final economy is solvent on all resources.
  Chapters fire on `world.tick` only (never frames/wall clock); the
  director's RNG is a director-owned `createRngBank(DEMO_SEED)` `'demo'`
  stream — `world.rng` is never touched. Rejections are recorded loudly
  in `failures` + console (never swallowed); the suite pins `failures`
  empty, command log + digest identical across runs, the movie still
  playing at tick 57,120 (ten orbits), and a fresh post-demo session
  digest-identical to pristine (entering a game discards the demo
  completely — `startGame` always builds its own session). Headless-safe
  (no DOM/three.js); covered by `tests/ui.demoDirector.test.ts`.
  Latent bug fixed alongside: `sim/pathfinding.ts` computed `GRID_CELLS`
  at module scope from `CITY_GRID_CELLS`, which reads NaN inside the
  city → world → pathfinding → city import cycle whenever pathfinding is
  first reached through city (a new entry point like this demo) — the
  first move order died with `RangeError: Invalid array length`. Now a
  lazily-computed `gridCells()`; every call site runs at sim time.
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
  (no win/lose condition). Grand-expansion Phase 8 (peaceful,
  workstream B, 2026-09-30): `showVictory(title?, detail?)` /
  `showDefeat(title?, detail?)` take optional copy overrides for the
  peaceful end screens (defaults = the existing conquest/cheat copy —
  existing callers pass nothing and see no change).
- `saveslots.ts` — save/load slot picker dialog + pure
  `formatSaveSummary`.
- `hud.ts` — top bar, advisor panel, selection panel, tabbed train/build
  palettes, research panel, toasts. Calls back into the controller; never
  touches sim. `update()` runs every frame but only touches the DOM when a
  displayed value actually changed — the selection panel rebuilds only
  when its content digest (`ui/paletteDigest.ts`) changes, so palette
  button nodes stay stable across frames (recreating them every sim tick
  broke real clicks: pointerdown + pointerup landed on different nodes and
  no click event ever fired). The bottom-left menu (workstream Y,
  2026-09-30) is three main tabs headed by a `menu-tabs` bar:
  **Civilian** (tools row + Housing / Civic / Commerce / Industry /
  Utilities / Power / Water build tabs), **Military** (unit-orders hints
  + TRAIN palette's 4 tabs + Logistics / Naval-Air / Special build tabs +
  superweapons), **Management** (tax steppers + city focus + cabinet +
  research panel). `menuTab` state is remembered per tab, and so is the
  build tab per main tab. Selecting a unit/building replaces the tab
  content with the contextual branch (as before). TRAIN palette has 4 tabs (Infantry / Armor / Air / Navy —
  the Navy tab lists 24 kinds; navalMine rides along but is never trained — its button stays disabled
  with the "Deployed by a Minelayer" reason, teaching the minelayer's `deployMine` order), BUILD palette has 10 tabs (Housing / Civic / Commerce / Industry /
  Utilities / Power / Water / Naval & Air / Special / Logistics) — the Naval & Air tab holds 8
  naval-air buildings (the 4 Phase 6 ports: commercialPort, containerPort, fishingHarbor, navalBase,
  plus the 4 airport buildings) — the spec groupings
  plus the Workstream Z civic tab (education buildings), plus the Phase 2
  utility tabs (the 13 new power/water buildings), plus the Phase 3
  logistics tab (the 7 new fuel/ammo production + depot buildings), see `palettes.ts`.
  The 10 build tabs are classified whole-tab into the menu via
  `BUILD_TAB_MENU_TABS` in `palettes.ts` (tsc-enforced exhaustive:
  Civilian = housing/civic/commerce/industry/utilities/power/waterNet,
  Military = logistics/navalAir/special) and served through
  `buildTabsForMenuTab()`; the tools row (road, powerLine, waterPipe,
  zones, demolish) is a Civilian-only element now, not a build tab.
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
  Topbar (Phase 4 RENDER workstream A, item 1): an "X-ray" toggle ghosts
  the terrain + water so buried water pipes read (bright blue lines, no
  depth test — see `render/xrayView.ts`); game.ts auto-enables it while
  the water-pipe build tool is armed and never fights a manual toggle.
  Topbar (Phase 4 RENDER workstream A, follow-up B): a "Grid" toggle
  (icon+text via `viewIcon('grid')`, `G` key) shows the subtle draped
  terrain grid — see `render/gridView.ts`. Both are registered in
  `HUD_PANEL_BRANCHES` (AD11) and never rebuild topbar DOM.
  Selected residential buildings show their land-value line
  ("Land: Nice (64) · tax ×1.3", via `ui/desirability.ts`
  `landValueLine`); digest-covered (`bv:` segment, AD11).
  Hangars (Phase 5 workstream B): a selected sheltered aircraft shows
  its `shelterLine` ("Parked in hangar" / "Embarked on carrier") plus a
  **Launch** button; a selected flying aircraft shows **Embark** (the
  nearest friendly carrier in range, via `ui/hangars.ts`
  `nearestCarrier`) and **Park in hangar** (the nearest building with a
  free compatible slot) buttons when the sim would accept them —
  disabled buttons name the reason from `embarkBlockReason` /
  `baseBlockReason` (never dead buttons). A selected carrier shows its
  wing manifest ("Wing 3/8" + one **Launch** button per embarked
  aircraft — embarked aircraft are invisible on the map, so the manifest
  is the only way to reach them); a selected hangar building shows its
  occupancy line ("Hangars 4/6") plus a parked-aircraft manifest with
  **Launch** buttons. All shelter state is digest-covered: per-unit
  `ue:` (f / w<carrierId> / h<buildingId>), carrier `ew:` (wing ids),
  building `bh:` (parked ids) — always emitted, `x` for non-applicable
  (AD11 contract-test states stay green).
  Tools row (Phase 2): "Power line" and "Water pipe" drag-paint tools ride
  the generic `linearNetworkDrag.ts` pipeline (see "Adding a
  linear-network kind" below) and emit `buildPowerLine` / `buildPipe`
  orders via `orders.ts`.
  Grand-expansion Phase 8 (peaceful, workstream B, 2026-09-30): the tab
  bar renders `menuTabsForWorld(world.peaceful)` — the Military tab is
  hidden entirely in peaceful worlds (a remembered 'military' selection
  falls back to Civilian for rendering; the stored state is untouched).
  The Civilian tab heads with the one-line "military units are disabled"
  note; the Management tab heads with the peaceful-objectives section
  (`peacefulObjectivesEl` — population / treasury / rival lines from
  ui/peaceful.ts, first in the tab); the intel panel skips the
  infiltrate / sabotage / steal-tech buttons and shows the
  "covert operations are disabled" note instead (the sim would reject
  them loudly — offering the buttons would be a lie).
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
  building, train/build palettes, tools row, research panel, menu-tabs,
  military-panel, management-panel, toast) with the digest segments it
  contributes (or a `noDigestReason` when it is static / never rebuilt /
  keyed separately). Workstream Y (2026-09-30) replaced the
  `phase3-panel` branch with the three menu branches; the digest gained
  an always-present `mt:` (active main tab) segment plus `tx:`
  (tax rates), `ms:` (city focus) and `mg:` (cabinet) segments that only
  appear while the Management tab renders them. Grand-expansion Phase 8
  (peaceful, workstream B, 2026-09-30): the Management tab's peaceful-
  objectives section contributes `po:` (player population, treasury
  flag, rival population — `po:x` when the section does not render, so
  the non-peaceful representative state covers the label).
  The contract test asserts each declared label really appears in digest
  output and scans hud.ts for unregistered panel methods / DOM classes —
  see "Adding a HUD panel" below.
- `menus.ts` — main menu (skirmish setup: map picker + difficulty picker),
  pause overlay, settings (quality, key list, accessibility, audio). Quality,
  colorblind mode, UI scale and audio persist in localStorage. Skirmish
  setup shows all 8 MAP_PRESETS (name
  + water %) and all 5 AI difficulties, plus the grand-expansion Phase 8
  (workstream B, 2026-09-30) **Peaceful mode** checkbox with its one-line
  explanation (no military, rivals build peacefully, win by growing your
  city); `onStartSkirmish(difficulty, mapPreset, peaceful)`. The setup
  column scrolls (`#menu .buttons` has
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
  The hangar builders (Phase 5 workstream B) shape the shelter command
  payloads exactly: `buildEmbarkOrder(unitId, carrierId, owner)` →
  `embarkAircraft`; `buildBaseOrder(unitId, buildingId, owner)` →
  `baseAircraft`; `buildLaunchOrder(unitId, owner)` → `launchAircraft`.
  Final-review R2 (2026-10-01): `buildAttackBuildingOrders(unitIds,
  owner, buildingId)` — one `attackBuilding` (siege order) per selected
  unit for right-click on an enemy building; the sim validates at
  enqueue + apply, rejections toast loudly.
- `palettes.ts` — headless-safe palette data + availability logic for
  the tabbed TRAIN/BUILD palettes and the research panel: `TRAIN_TABS`
  (6 tabs, 96 units — Phase 3 workstream 3 added the supplyTruck/fuelTruck;
  Phase 5 workstream B added the 16-aircraft air tab; the intel roster
  workstream (§3.8/S6, 2026-09-30) added the intel tab: spy + reconTeam;
  Phase 8 workstream D added the 28 Mk II/III tech variants next to their
  base kinds),
  `BUILD_TABS` (13 tabs, 99 buildings — workstream W added library+park, workstream P added the two parking buildings,
  the intel roster workstream added the intel tab: intelHQ/listeningPost/signalsStation/satelliteUplink;
  Phase 8 workstream E added 10 civilian buildings: 5 civic + 5 commerce),
  `UPGRADE_GROUPS` (military 8 / economy 4 / infrastructure 6 / logistics 1 / intel 2), `unitAvailability` /
  `buildingAvailability` / `upgradeAvailability` (ready | reason), cost
  formatters, and the
  Naval Yard coast-rule tooltip. Availability mirrors sim validation
  (age gate, production-building gate, affordability, manpower).
  Grand-expansion Phase 8 (peaceful, workstream B, 2026-09-30): the
  three availability functions gain a peaceful gate FIRST (mirroring
  the sim's `spawnUnit` / `placeBuilding` / `researchUpgrade` validate
  ordering) — military defs report not-ok/locked with
  `STRINGS.palettes.peacefulLocked` ("Not available in peaceful mode"),
  so buttons grey out instead of failing loudly at enqueue.
  `upgradeIsMilitary(id)` is the flag-keyed lockout predicate (the
  sim's `UpgradeDef.military` — never the visual group); the groups
  stay explicit thematics but the flag partition is pinned by the
  no-drift test (`tests/ui.peaceful.test.ts`): the war-apparatus
  groups (military/logistics/intel) hold exactly the military-flagged
  defs, economy/infrastructure hold none.
- `peaceful.ts` — **peaceful-mode UI contract (pure, tested,
  `tests/ui.peaceful.test.ts`).** The UI-side mirror of the sim's
  peaceful system (`sim/peaceful.ts`, grand-expansion Phase 8,
  workstream B, 2026-09-30): `menuTabsForWorld(peaceful)` (the Military
  tab list — hud.ts renders from this), `formatCount` (deterministic
  thousands separators, no `toLocaleString`), `peacefulObjectiveLines`
  (the Management tab's objectives section: population vs the 8,000
  target, treasury status, the rival's progress — the rival line is
  null when the rival isn't actually playing, detected via
  `world.ai.players`, NOT the city player record, which always creates
  a dormant 'Rival' shell), `peacefulOutcome` (the end-screen decider:
  the player is checked first, so a same-tick tie goes to the player —
  the opposite of the conquest tiebreak), and `peacefulEndCopy` (the
  victory/defeat title+detail, incl. the rival-won-first defeat).
  Reads sim state defensively, never writes it.
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
  `desirabilityOverlayData(t, world, owner)` (the read-only per-frame view the
  `DesirabilityOverlay` renders: sorted cells + the model cache key).
  Reads every sim field defensively (empty pre-sim → empty view), never
  writes sim state.
- `policies.ts` — **workstream E ordinances contract module (pure,
  tested, `tests/ui.policies.test.ts`).** The UI boundary for the sim's
  five city-wide policy toggles (`sim/city.ts` `POLICIES`/`POLICY_IDS`,
  funding in `sim/economy.ts`): `policyRows(world, owner)` (the
  Management tab's "City ordinances" section — five rows in POLICY_IDS
  order with name/effect/upkeep and the on/funded/unfunded states),
  `policyUpkeepLine` / `policyStatusLine` (the player-facing copy),
  `policiesPanelDigest(world, owner)` (the AD11 UI digest segment:
  `oc:` + 5 × 2-char states — on=1/off=0, funded=f/unfunded=u/off=- —
  e.g. `oc:1f,0-,1u,0-,0-`; `po:` was already claimed by workstream B's
  peaceful-objectives section). Reads every sim field defensively
  (null world / unknown owner → five off rows), never writes sim state.
- `hangars.ts` — **hangar/carrier UI contract module (pure, tested,
  `tests/ui.hangars.test.ts`).** The UI-side mirror of the sim's
  shelter system (`sim/units.ts` + `sim/city.ts`): `canEmbarkUI` /
  `canBaseUI` / `canLaunchUI` (the user requirements — carriers train
  EMPTY, only carrier-capable aircraft embark — mirrored as UI gates so
  buttons never promise what the sim would reject), `embarkBlockReason`
  / `baseBlockReason` (the disabled-button tooltip strings, in sim
  validate order — never a dead button), `nearestCarrier` /
  `nearestHangarBuilding` (in-range, compatible, friendly proposals),
  `parkedAircraft` / `embarkedAircraft` (id order), display lines
  `wingLine` ("Wing 3/8") / `hangarLine` ("Hangars 4/6") /
  `shelterLine` ("Parked in hangar" / "Embarked on carrier"), plus
  re-exports of `EMBARK_RANGE` / `HANGAR_BASE_RANGE` / `isSheltered`.
  Reads every sim field defensively (empty pre-sim → empty view), never
  writes sim state. Buildings are in cell coords, units in world coords
  — range math goes through `cellCenterWorld` (the 2026-09-30
  cell/world mixup that rejected every in-range basing).
- `intel.ts` — **intel UI contract module (pure, tested,
  `tests/ui.intel.test.ts`).** The UI-side mirror of the sim's intel
  system (`sim/intel.ts`): `intelAssetsOf` / `intelAccrualRatesOf`
  (exact mirrors of the sim's accrual — rates drift ⇒ sim drift, tests
  pin it), `intelAssetLines` / `intelChipValues` (the three asset
  counters + rates), `playerSpies` / `spyDisplayState` (precedence
  burned > infiltrating > embedded > detected-by-rival > hidden) /
  `spyMissionLine` / `spyHeader`, `intelWarnings` + `warningLine`
  (every warning carries countdown-or-null + what-happens-next — the
  no-gotcha rule), `rivalAirports` + `rivalAirportLine` (mixed
  airports display civilian → undiscovered/UNVERIFIED), `opTargetsOf`
  (enemy completed buildings within `INTEL_ADJACENCY`, id order),
  `stealPreviewTechId` (deterministic, lowest sim-stealable tech),
  the static copy builders (`sabotageLabel`, `stealTechLabel`,
  `stealPayoffLine`, `trainSpyHint` — costs come from the sim
  constants), plus the AD11 digest builders `ia:` / `ir:` / `is:` /
  `iw:` / `ig:` / `iu:` (quantized to whole seconds so digest
  rebuilds stay ≤1/sec per timer). The panel reads the sim through
  this module, never the records directly; **rejection strings from
  the sim are plain English — wrap/display them, never re-implement
  validation in the UI.** Payload authority: the sim's exact shapes
  (`{ unitId, buildingId, owner }` for all three covert ops —
  `stealTech` has no tech param; the sim picks it), built by
  `ui/orders.ts` (`buildInfiltrateOrder` / `buildSabotageOrder` /
  `buildStealTechOrder`).
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
  `unitIcon` / `buildingIcon` cover all 96 units + 99 buildings
  (`Record<UnitKind, string>` so a missing glyph is a compile error);
  `toolIcon` for the build tools row (incl. the Phase 2 powerLine /
  waterPipe tools); `viewIcon` for the top-bar view toggles (Phase 4
  RENDER workstream A: the terrain-grid toggle); `mapIcon(waterFraction)` for the
  8 map presets (5 terrain buckets); `difficultyIcon` (1–5 rank
  chevrons); `menuIcon` for skirmish/load/missions/settings/back/
  resume/save/exit plus the three main-tab icons (tabCivilian /
  tabMilitary / tabManagement, workstream Y). 24×24 viewBox, `stroke="currentColor"` so button
  CSS (including locked dimming) drives the color. Decision record:
  `docs/research/ui-icons.md`.
- `session.ts` also assembles campaign missions:
  `createSession({ campaignMission })` — map/AI/starting resources from
  the mission, no AI rival when difficulty is 'none', owner 1 always
  funded with manpower for scripted raids.
- `game.ts` (Phase 2): owns the mission run + `MuseController` +
  `MuseBox` + `MissionPanel`; polls the campaign director ~2×/sec and
  Muse ~1×/sec in the game loop. Victory/defeat → debrief overlay →
  `onMissionEnd` records progress. Muse settings (frequency + the
  disabled "hopefully coming" Live Muse checkbox) live in the settings
  panel, live-applied in game. (No API-key flow — removed entirely per
  the 2026-09-29 user directive.)
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
  all 96 unit names, 99 building names, palette/upgrade tab names, the
  21 upgrade names + one-line effects, cost labels, and lock reasons.
  Legacy Phase 3 strings are still English-only; they were never localized.
  Grand-expansion Phase 8 (peaceful, workstream B, 2026-09-30):
  `STRINGS.peaceful` (setup toggle + explanation, the Military-tab
  note, the objectives section lines, the victory/defeat titles and
  details, the covert-ops-disabled note) and
  `STRINGS.palettes.peacefulLocked` ("Not available in peaceful mode"
  — the greyed-out palette reason).
- Audio: `game.ts` owns an `AudioEngine` (see `src/audio/AGENTS.md`) —
  unlocked on first pointer/key gesture, `updateMusic(world, playerId)`
  polled ~2×/sec, SFX on select/orders/placement/age-advance/rejections/
  deaths/buildings/advisor changes, pause = `audio.suspend()`.
  `menus.ts` SettingsPanel has master/music/SFX sliders + mute (persisted,
  live-applied in game).

## Rules

- Right-click attacks are gated by `canTarget(def, target)` — the same
  rule the Classic AI follows. Right-click on an enemy BUILDING is gated
  by `canTargetBuilding(def)` (armed + targets ground/both — the same
  rule the sim and AI use for sieges) and issues `attackBuilding` when
  any selected unit can hit buildings; enemy units take precedence over
  buildings when both are under the cursor. Never order an impossible attack.
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
Sub-section helpers must not look like panel branches: keep them out of
the `append*/build*/update*` name pattern (workstream Y uses
`taxSectionEl` / `focusSectionEl` / `cabinetSectionEl`), or register
each one. When a branch renders only under a state the default
`digestForBranch` helper does not produce (e.g. the Management tab's
`menuTab='management'`), add a case for it in the helper.

## Adding a linear-network kind (Phase 2/4)

Power lines and water pipes (Phase 2, done) and rail (Phase 4, done)
reuse the road tool's drag gesture through `linearNetworkDrag.ts`: do not
copy the pipeline. `LinearNetworkKind` is `'road' | 'powerLine' |
'waterPipe' | 'rail'`; `orders.ts` has `buildPowerLineOrder` /
`buildWaterPipeOrder` / `buildRailOrder` (emitting `buildPowerLine` /
`buildPipe` / `buildRail` commands); `toolForKind` maps the kinds to the
`powerLine` / `waterPipe` / `rail` build tools; `networkKindForTool`
starts a drag for those tool strings. Steps for a NEW kind: (1) extend the
`LinearNetworkKind` union; (2) add the order builder in `orders.ts` and
wire it into the pipeline's `buildNetworkOrder` switch; (3) map the kind
to its build tool in the pipeline's `toolForKind` switch; (4) extend
`networkKindForTool` with the new tool string; (5) add the HUD tool
button (`hud.ts` tools row), its icon (`icons.ts`), its label
(`strings.ts`), and click resolution (`placement.ts`); (6) add unit
tests for the new kind (accumulation, order payload, click resolution).
The two switches are exhaustive with no default arm, so the compiler
fails after step 1 until steps 2–3 are done — a new kind can never
silently fall through. The controller wiring in `game.ts` (`bindInput`)
is already kind-agnostic and needs no change.

### Road classes (Phase 4)

The road tool carries an optional `roadClass` (dirt/country/paved/
highway, default `'paved'`) from the HUD's remembered picker
(`hud.ts selectedRoadClass`) through the drag pipeline to
`buildRoadOrder`. The sim rejects a mixed batch whole, so `game.ts`
splits drags with `partitionRoadCells(roads, cells, cls)` into
`buildRoad` (fresh cells) + `upgradeRoad` (existing lower-class cells);
cells already at-or-above the class are dropped silently. Clicks carry
the class to `resolveBuildToolClick(tool, owner, cell, roadClass)`.
