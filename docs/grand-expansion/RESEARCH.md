/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 */

/**
 * NOVATERRA — docs/grand-expansion/RESEARCH.md
 *
 * Synthesis of the five grand-expansion research workstreams (utilities,
 * logistics + veterancy, transport/airline + intel, sim audit, render/UI
 * audit + content inventory). Neutral mechanics language throughout;
 * formal game-title citations live only in the per-topic worker docs.
 * Per the 2026-09-30 project instruction these notes live under
 * docs/grand-expansion/ (the repo default is docs/research/).
 *
 * Worker docs (the evidence; read them for sources and full reasoning):
 * - research-utilities.md            — utility sim design (28.5 KB)
 * - research-logistics-veterancy.md  — supply chains + unit progression (26 KB)
 * - research-transport-intel.md      — airports/airline/transport/espionage (~31 KB)
 * - audit-sim.md                     — sim architecture mapping, 11 systems (908 lines)
 * - audit-render-ui.md               — render/UI pipeline, budgets, risks
 * - content-inventory.md             — current 28/28/12 roster + per-pillar gaps
 */

# Grand Expansion — Research Synthesis

Version: 0.1 Alpha. Synthesized 2026-09-30.

## 1. What the research converged on (design decisions, with reasons)

### Utilities — connectivity as integer flood fill; roads conduct automatically

1. **Connectivity = integer BFS over conductor tiles, recomputed on
   build/destroy only.** Plants seed the fill; a zone is served if any
   of its tiles touches the served network; every building inside a
   served zone gets power/water automatically (underground distribution
   abstracted). Order-independent, deterministic by construction, cheap.
   Agent-based per-unit resource flow is a documented genre failure —
   unpredictable, unscalable, hostile to determinism. Never use it.
2. **Roads conduct both utilities automatically; lines/pipes are the
   long-hop tool.** This is the genre's celebrated tedium fix: mandatory
   per-expansion pipe-laying is the single most-cited chore in
   city-builders. Power lines and water pipes are cheap drag-painted
   links for plant→grid hookup, crossing wilderness/water, reaching a
   far zone without a road. They become interesting precisely because
   they are optional and situational, not chores.
3. **Per-network allocation in fixed order; count demand only from
   reached buildings.** Each connected network sums its own plants'
   supply; served consumers draw in a fixed order (keep the existing
   id-order). Beyond supply → binary unserved with a clear icon.
   Per-network allocation makes brownouts local and diagnosable ("the
   east grid is short"); counting only reached demand avoids the trap
   where numbers read healthy while zones quietly refuse to grow.
4. **Split the diagnosis: "disconnected" vs "shortage."** A zone with
   no network path shows a disconnected icon; one on an undersized
   network shows a shortage icon. Stranded generators (touching no
   conductor) flag themselves as player mistakes. Both flags fall out
   of the flood fill + allocation pass for free.
5. **Plant ladder across tech levels with real personalities, unlocked
   via research.** wind/solar (clean, weak/intermittent) → coal/oil
   (cheap, strong, polluting) → nuclear (mighty, clean, expensive,
   tiny seeded meltdown risk, needs a water hookup) → fusion (late
   research, ultimate). Water: well → pump (freshwater-adjacent) →
   desalination (seawater-adjacent, needs power, 2× output) →
   treatment plant (system-level capacity + decontamination, needs
   power, no pipe adjacency required). The cost/output/pollution
   tradeoff triangle is the genre's most durable fun mechanic.
   Cross-utility hooks (water needs power; nuclear needs water) create
   planning depth from *placement*, not clicks. Keep plants binary
   on/off with flat upkeep — no per-plant funding sliders, no aging
   timers (both documented as spreadsheet tedium).
6. **Storage buildings smooth intermittency.** Battery stations
   (power) and water towers (water) as small cheap integer-stock
   buffers; solar produces day-only, wind varies on a seeded cycle;
   spikes are telegraphed. Riding out a spike on stored reserves is a
   proven fun payoff; implementation is one integer stock per network.
7. **Map-edge import/export.** Run a line/pipe to the map edge to
   auto-sell surplus for income; optionally buy early-game power
   instead of building a plant. Turns utilities into an economy lever.
8. **Water contamination as a binary placement puzzle.** Industrial
   pollution can foul adjacent sources (clean/fouled, shown on an
   overlay); treatment plants scrub one source each. Never a hidden
   pressure simulation — if the player can't see why, it reads as a bug.

### Logistics — one abstract supply resource; automate the last mile

1. **One abstract supply resource per carrier, with per-service
   toggles.** Supply trucks/ships carry generic *supply points* (one
   float each). Parked within a radius they repair/rearm/refuel
   simultaneously; the player toggles each service to prioritize
   scarce points (ammo over armor). Per-weapon supply costs (one float
   per weapon type, paid per shot) make missiles supply-expensive by
   design without per-shell bookkeeping.
2. **Automate the last mile; the player designs the network.** Depots
   auto-load supply vehicles; vehicles auto-shuttle between depots
   and forward staging posts; field units draw automatically in
   radius. The player's decisions are *where* to build depots, *which*
   routes to motorize, *what* to prioritize — never "drive this
   truck." The genre postmortem is unambiguous: a beloved production
   chain becomes refund-tier when its execution is manual.
3. **Supply as strategic-layer constraint, never per-skirmish tax.**
   Internal tanks/magazines sized for a normal engagement; logistics
   governs tempo and sustainment across a long game. Out-of-supply
   **degrades** (deficit shared evenly, never hard-stops): out-of-ammo
   falls back to secondary weapons or holds fire; out-of-fuel goes
   stationary but still fights in place. Interdiction should degrade,
   not delete.
4. **Nuclear exemption.** Nuclear subs/carriers skip fuel logistics
   entirely (per the brief).
5. **Ammo/fuel state lives on units and depot inventories, not a
   global resource key.** A global `ammo` stockpile would touch the
   8-resource const-enum machinery (market, digest, def I/O typing)
   for no gameplay gain; carrier-local points + building-record depot
   inventories are cheaper and map 1:1 onto the intended design.

### Veterancy — units earn through danger; places earn through investment

1. **Per-unit XP from damage dealt, weighted by target cost**
   (killing expensive/veteran targets pays more — built-in
   anti-snowball). 3–5 tiers. Bonuses are crew-flavored — reload
   speed, sight range, small damage efficiency — not raw HP/damage
   stacking ("veterancy affects the human, not the machine"). Visible
   chevrons; a small auto-regen at max tier makes max rank *feel*
   different. XP that would go to a maxed unit redistributes to nearby
   allies. **Death erases veterancy** — this is what makes players
   protect veterans.
2. **Tie progression to the city-builder side:** a military academy
   building lets newly produced units start at Veteran (or station
   max-tier veterans as trainers). Quality-vs-quantity strategic
   choice; avoids the late-game veterancy grind.
3. **Civilian veterancy: SKIP per-unit; adopt building-level
   progression.** No surveyed city-builder levels individual civilian
   workers — without per-agent identity, worker XP is spreadsheet
   noise (the endpoint one major series hit was deleting worker units
   outright). Instead: experienced crews as building upgrades,
   infrastructure tech levels (depots/ports level up capacity and
   service radius). The asymmetry is clean: **units earn veterancy
   through danger; places earn capability through investment.**

### Airports/airline + carriers + transport — capability gates, never decoration

1. **Airport zones with capability-gated tiers, never time-gated.**
   Paint a zone; tier = the modules built inside (runway class → stands
   → hangars → fuel depot → terminal/cargo). Each tier visibly unlocks
   capability: bigger runway classes accept bigger plane classes (show
   the rule in the build UI *before* purchase — hidden class rules are
   a documented fun-killer). Every module must change a visible number
   or unlock a capability; decorative modules are a documented failure.
2. **Carriers come empty; the player fills the slots.** Carrier-capable
   aircraft (built at airfields) embark via land-on-carrier; the
   carrier refuels/rearms/repairs in the field and extends effective
   range, making carriers strategically necessary on large maps rather
   than decorative. Carriers are slow and near-defenseless → escorts
   mandatory → combined-arms fleet play. Carrier *training* (pilots
   trained for carrier ops) maps onto the veterancy system with zero
   new UI. Design decision recorded: a destroyed carrier destroys its
   embarked wing (simplest, deterministic).
3. **Transport classes as a 3-knob triangle.** Road classes
   dirt/country → paved → highway: speed cap, capacity, cost; each
   visibly changes outcomes. Rail classes standard → electric →
   high-speed gate train quality (infrastructure investment unlocks
   better vehicles). Trams: slow, huge capacity, cheap street-running
   — the urban workhorse. Ferries: cheap point-to-point water
   crossings between small boat stations, not full ports. Every class
   changes exactly speed cap, capacity, cost.
4. **Civilian transport feeds a demand loop.** Trams/buses/ferries move
   population/goods numbers the player can see; reliable service grows
   zones. Transport is interesting when it feeds town growth, not when
   vehicles are stat cards. Player manages routes and fleet mix, never
   per-vehicle checklists ("clone with orders," default shuttles,
   depot-level auto-maintenance).

### Intel — deterministic asset economy, positional, telegraphed

1. **Intel as a deterministic asset economy.** Three currencies per
   region: *surveillance assets* (from recon units, radar stations,
   recon aircraft, spies in place), *operational assets* (spent on
   missions: sabotage, steal tech, expose a hidden military section),
   *counter-intel assets* (spent to block missions and degrade enemy
   networks). Counters and timers are exactly what a deterministic sim
   does well — no RNG needed. This gives peaceful-mode gameplay real
   teeth: intel races are the no-military conflict.
2. **Spies are named, promotable units assigned to regions; they build
   networks over time** (deterministic progress bars, not instant dice
   rolls). Recon units feed the surveillance stock — valuable even in
   peacetime. Counter-intel degrades and blocks; spy death is rare,
   costly, memorable — never routine. No global espionage point pools.
3. **Mixed-use discovery is warned and counterable.** A mixed
   airport/port reads as civilian until enemy surveillance against
   that region passes a threshold (reduced by your counter-intel,
   camouflage tech, physical separation). On suspicion: warning +
   grace period (relocate, surge counter-intel, or accept risk); only
   then does it become a priority target. This mechanic is novel — no
   surveyed game implements it — so prototype the UX early.
4. **Stealth as a pure function of positions.** Detection computed
   per-tick from positions (no stored state → no snapshot/digest
   impact). All perception flows through `getVisibleEnemies()` — the
   AI fairness invariant is never bypassed.

## 2. Fun vs tedious — the distilled ledger

**Fun (build these):** the plant tradeoff triangle; tech-ladder era
changes; rare dramatic telegraphed failures (seeded meltdown risk);
storage smoothing intermittent sources; surplus export / early import;
water as a placement puzzle; planning the logistics network (not
driving trucks); supply as a tempo constraint; interdiction as a
weapon (needs physical, visible supply); attachment through
persistence (chevrons, death erases); killing veterans pays more;
the first-plane moment (every transport investment needs a visible
"it works!" payoff); the jigsaw puzzle of connections; legible
capacity/speed/cost triangles; intel as resource management with
readable stakes; spy fantasy moments (named agents, specific
missions); surprise projection (carriers enabling unseen strikes);
demand feedback loops.

**Tedious (avoid these):** mandatory per-expansion pipe/wire laying;
agent-based resource flow; per-plant funding sliders and aging
micro; retrofitting logistics corridors through built-up areas
(keep fuel/missile chains military/industrial, never civilian);
opaque hidden rules and bad auto-plumbing; proportional everything-
slows-down brownouts (binary served/unserved with icons instead);
per-truck routing and manual load/unload; logistics taxing every
skirmish; invisible stat stacks with no visual marker; compounding
multiplicative penalties; placebo mechanics and time-based leveling;
per-vehicle/per-staff micro; global espionage point pools and instant
dice-roll spy missions; hyper-lethal counter-intel; bolt-from-the-blue
punishments; civilian worker XP micro with no decisions.

## 3. Determinism notes (for the implementation plan)

- Flood fill: pure function of (conductor tiles, plant tiles) —
  integer BFS, id-ordered, no `Set` iteration for sim logic. Recompute
  on structural change only; cache otherwise.
- Allocation order: (network id, distance from source, entity id) —
  fully ordered, no ties possible.
- Intermittency (wind/solar curves): seeded RNG streams or closed-form
  functions of tick (day phase); new systems get **new named streams**
  (`'logistics'`, `'intel'`, …) — never reuse `'city'`/`'combat'`, and
  never draw during AI thinks (think functions draw nothing).
- Storage stocks: integers per network, updated in fixed tick order.
- Rare failures (meltdown): seeded RNG, telegraphed warning state
  first — reproducible and fair.
- Snapshot strategy: prefer additive optional fields with neutral
  decode defaults, **no version bump** (v6→v7 only for shape changes
  like road classes or the tax-rate 4-tuple). Digest must cover every
  new field that affects future sim behavior; the round-trip gate is
  `digest(restore(take(w))) === digest(w)`.
- New UI panels must digest their rendered values in
  `ui/paletteDigest.ts` (the 2026-09-30 click bug was per-tick DOM
  rebuilds; every new panel is one careless branch away from
  reintroducing it).
- Import-cycle discipline: data on `World`, logic in the owning
  module, direct reads with documented reasons (the codebase already
  works around real cycles: city↔ages, combat→superweapons).

## 4. Open questions for early prototyping (riskiest unknowns)

1. **Mixed-use discovery UX.** No surveyed game implements
   civilian-with-hidden-military-section discovery. The hiding half
   (stealth vs detectors) and the consequence half (discovery →
   targeting change) are proven separately; their combination is not.
   Prototype the warning/grace-period UX before building the systems
   behind it.
2. **The draw-call ceiling.** Entity views are per-view groups
   (~2–8 calls each) against a ≤100–200 call budget; there is no
   instancing path for entities today. Dozens of new kinds × 2–3× more
   entities blow past this before the triangle budget binds. Benchmark
   and decide (instancing path vs. entity caps vs. impostors) before
   the roster grows — this can make the expansion's core promise
   unshippable at 60 fps.
3. **The download budget.** 8 MiB gate; ~5.45 MiB already spent
   (~30 more average-size keys fit; the expansion wants ~90). Decide
   the mechanism before adding keys: per-tab/per-age lazy loading,
   gltf-transform optimize (meshopt), or a raised budget — and use
   the vendored spares pool + procedural-first infrastructure +
   *(R3, 2026-10-01: the 5.45 MiB was raw bytes; byte-measured boot
   payload transfers 4.11 MiB — 51.3% of the gate — and the lazy-loading
   mitigation already landed. See `docs/research/perf-r3.md`.)*
   art-sharing for tech-level variants (Mk II/III sharing one GLB).
4. **The utility cutover vs. the AI.** A hard connectivity requirement
   silently starves the AI (its virtual buildings bypass placement).
   Mitigation adopted: keep the global pool as the fallback, teach the
   AI line-building as its own phase, gate any hard requirement behind
   a game option.
5. **Airline management depth.** Static income per route is the safe
   Phase-1 model (like the `market` precedent); scheduled fleets with
   ticket pricing are the fun-risky version. Start static, measure
   whether players want the deeper game before building it.
