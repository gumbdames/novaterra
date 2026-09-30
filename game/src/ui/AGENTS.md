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
  BUILD palette has 6 tabs (Housing / Commerce / Industry / Utilities /
  Naval & Air / Special) — the exact spec groupings, see `palettes.ts`.
  Unavailable entries stay visible but disabled, with tooltip reasons
  (age, production building, cost, manpower, Naval Yard coast rule).
  Train buttons show funds + materials + manpower cost; build buttons
  show funds + materials. Selecting a completed Research Lab (or owning
  one with nothing selected) opens the research panel: all 12 upgrades
  in Military / Economy groups with one-line effects, cost, researched
  checkmark, and disabled reasons.
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
  `buildResearchUpgradeOrder(owner, upgrade)` for the research panel.
- `palettes.ts` — headless-safe palette data + availability logic for
  the tabbed TRAIN/BUILD palettes and the research panel: `TRAIN_TABS`
  (4 tabs, 28 units), `BUILD_TABS` (6 tabs, 28 buildings),
  `UPGRADE_GROUPS` (military 8 / economy 4), `unitAvailability` /
  `buildingAvailability` / `upgradeAvailability` (ready | reason), cost
  formatters, and the
  Naval Yard coast-rule tooltip. Availability mirrors sim validation
  (age gate, production-building gate, affordability, manpower).
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
  `unitIcon` / `buildingIcon` cover all 28 units + 28 buildings
  (`Record<UnitKind, string>` so a missing glyph is a compile error);
  `toolIcon` for the build tools row; `mapIcon(waterFraction)` for the
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
- `advisor.ts` — pure `evaluateAdvisor(world, playerId)`, worst-first.
- `strings.ts` — all NEW UI copy in one place, English-only (2026-09-30
  directive; see `docs/I18N.md` for how a future language is added):
  `LocalizedString` (`{en}` — the localization indirection, kept as the
  extension point), module-level language
  state (`setUiLanguage` / `getUiLanguage` / `loc` / `fillLoc`). Covers
  all 28 unit names, 28 building names, palette/upgrade tab names, the
  12 upgrade names + one-line effects, cost labels, and lock reasons.
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

Power lines, water pipes (Phase 2) and rail (Phase 4) reuse the road tool's
drag gesture through `linearNetworkDrag.ts` — do not copy the pipeline.
Steps: (1) extend the `LinearNetworkKind` union; (2) add the order builder in
`orders.ts` and wire it into the pipeline's `buildNetworkOrder` switch; (3)
map the kind to its build tool in the pipeline's `toolForKind` switch; (4)
extend `networkKindForTool` with the new tool string; (5) add unit tests for
the new kind (accumulation, order payload, click resolution). The two
switches are exhaustive with no default arm, so the compiler fails after
step 1 until steps 2–3 are done — a new kind can never silently fall
through. The controller wiring in `game.ts` (`bindInput`) is already
kind-agnostic and needs no change.
