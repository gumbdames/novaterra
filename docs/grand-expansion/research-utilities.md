/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 */

/**
 * NOVATERRA — docs/grand-expansion/research-utilities.md
 *
 * External deep research: how classic city-builders modeled electricity
 * and water production, distribution networks, and zone servicing — what
 * was fun, what was tedious, and what a deterministic browser
 * RTS/city-builder hybrid should adopt or avoid.
 *
 * NOTE on naming: the repo's standing rule (no commercial game titles in
 * product, docs, or comments) has one formal exception — citations in
 * research docs with URLs. This file uses that exception; specific games
 * are named ONLY as cited sources. All mechanics are otherwise described
 * in neutral terms. No other doc, UI string, or comment may copy the
 * game names out of this file.
 *
 * Research conducted 2026-09-30 via web search + page reads.
 */

# Research: City-Builder Utility Simulation (Electricity + Water)

Context for NOVATERRA: the current sim uses a simple global pool —
plants contribute supply, buildings demand it, allocation is id-ordered
per player, and demand counts every building whether or not it is
actually reachable. The grand-expansion goal is: multiple electricity
production methods across tech levels, multiple water sources, power
LINES and water PIPES as buildable network links between areas, and
zone-level servicing (once a zone is hooked up to the network, every
building in it gets utilities via automatic underground distribution).
Everything must stay deterministic (fixed timestep) and fun, not
tedious.

---

## (a) Mechanics survey — how the genre has done it

### A1. Power distribution models (six distinct approaches)

**1. Flood-fill "power net" over conductors.**
Plants seed a flood fill (BFS) across tiles flagged as conductors —
power lines, zone centers, roads/rails adjacent to powered tiles.
Any tile reached by the fill is powered; zones without the power flag
show an "unpowered" icon. This is the classic 90s model (documented in
an open reimplementation spec): capacity is counted per plant, but
*reach* is purely topological. Cheap (integer BFS, order-independent),
and trivially deterministic. (See sources: SC3K mechanics spec.)

**2. Roads-as-conductors (low-voltage abstraction).**
The modern refinement: roads automatically carry low-voltage power,
water, and sewage, so a building on a connected road is served with no
extra player action. Power plants produce high-voltage power that must
be stepped down through transformer stations onto the road grid; long
high-voltage lines connect plants to those stations. Cables have
carrying capacity, so bottlenecks can form and must be relieved with
extra lines/stations. Wind turbines feed low-voltage directly and need
no transformer. (See sources: Cities: Skylines 2 dev-diary coverage,
CS2 utility-network reference.)

**3. Coverage radius along roads.**
A plant powers everything within a road-distance radius (e.g.
~33 tiles on dirt roads, ~49 on paved), with visible power poles on
served roads. Binary: fully served or not, no gradation. Fuel is the
real gameplay instead — plants burn oil delivered by train from an oil
harbor, so the logistics chain is the challenge, not the wiring. (See
sources: Anno 1800 electricity wiki.)

**4. Zone-adjacency conductivity.**
Zones adjacent to power sources or lines automatically conduct
electricity; no lines needed inside a contiguous built-up area, only to
bridge gaps. A later variant lets electricity travel between buildings
built close enough together, so power lines are only needed for
far-flung infrastructure. (See sources: SimCity 4 summary; Cities:
Skylines 1 review.)

**5. Heat/coverage radius with tech-extended range.**
A single generator heats a circular area; buildings outside it run at
reduced efficiency or shut down. Range is extended by research (bigger
generator radius) or by placing relay hubs. Fuel consumption rises with
output level. (See sources: Frostpunk reviews.)

**6. Agent-based resource flow.**
Power/water/sewage modeled as individual agents ("blobs") flowing
along the road network to buildings, like citizens. Universally
regarded as a design failure: a player could build a new plant and
still wait for agents to randomly wander to the right buildings before
power arrived — unpredictable and felt unfair. Also famously
unscalable, forcing tiny maps. (See sources: ResetEra postmortem
thread; PC Gamer GlassBox explainer.)

### A2. Water distribution models

**Underground pipe grids.** The classic model has a separate
underground layer: pipes are laid tile-by-tile (or dragged), pumps
draw from fresh water, and each building has small stub connections
that must join the pipe network. Low-density zones can survive on
wells; medium/high density require a pressurized pipe network. A
dedicated underground view shows pipes/subways. Players reported the
dual-layer mapping confusing ("hard to tell where a point on one map
corresponds to on the other"). (See sources: SC2000 strategy guide;
GameFAQs SC2000 guide.)

**Road-carried water (modern).** Same abstraction as power: most road
types carry water (and sewage) automatically; buildings on roads are
connected without extra pipes. Manually placed pipes remain for
off-road runs and map-edge connections. Eliminated the per-expansion
pipe-laying chore. (See sources: CS2 dev-diary coverage.)

**Groundwater + contamination.** Water drawn from an underground water
table (visible as wet/dry terrain), depletable but slowly renewing;
ground pollution can contaminate the table and shut down pumps.
Sewage must be dumped downstream of intakes. This turns water into a
placement puzzle (intakes vs. industry vs. sewage) rather than a
plumbing puzzle. (See sources: SC2013 GlassBox water video;
CS2 groundwater coverage.)

### A3. Production variety and tradeoffs (power)

The genre converged on a tradeoff triangle — **cost / output /
pollution** — with each plant type having a distinct personality:

- **Coal/oil/gas:** cheap to build, good output, heavy pollution.
  Best cost-per-unit; worst for land value and health.
- **Wind:** cheap, no pollution, weak and location/weather-dependent.
  Early-game starter or green niche.
- **Solar:** clean, moderate output, day-only (needs batteries or
  backup for night/winter demand spikes).
- **Hydro:** clean and strong, but buildable only on suitable terrain
  (rivers/dams).
- **Nuclear:** most output, no pollution, prohibitively expensive,
  plus a rare catastrophic meltdown risk. Universally the end-game
  goal.
- **Exotics:** microwave plants whose beam can miss and set fire to
  a nearby building (risk-as-personality); fusion as the ultimate
  clean giant. One classic also modeled *transmission loss*: more
  power-line tiles = more strain on the plant, so distant plants waste
  capacity. (See sources: SC2000 strategy guides; SC2013 plant list;
  CS2 development-tree guides.)

### A4. Water source variety

- **Pumps/wells:** placed adjacent to fresh water; cheap baseline.
- **Desalination:** must sit next to salt water, requires a power
  connection, produces ~2x a pump's output. Cross-utility dependency
  (water needs power) is a recurring genre mechanic — in one modern
  open-source design, water towers produce nothing unless themselves
  powered.
- **Treatment plants:** boost total system capacity and scrub
  pollution; require power; notably did NOT need to touch the pipe
  network in the classic implementation — a pure system-level upgrade.
- **Towers/tanks:** store surplus during times of plenty for droughts
  or demand spikes — i.e. buffer storage, the water equivalent of
  batteries. (See sources: SC2000 water guide; CS2 coverage.)

### A5. Tech progression models (how new plant types unlock)

1. **Date-based:** fusion unlocks in 2050 — the tech ladder is a
   timeline, giving late game an "era" feel. (SC2000.)
2. **Milestone/population-based:** better plants unlock as the city
   hits population thresholds. (CS1 milestones; mobile spin-off
   population gates.)
3. **Development/research tree:** spend earned development points on
   nodes — e.g. gas plant -> coal plant -> nuclear on one branch,
   battery -> geothermal/solar/hydro on another; nuclear locked
   behind its dirty predecessors. Vertical wind turbines unlocked by
   building a School of Engineering. (CS2; SC2013.)
4. **Upgrade tiers:** the same building upgraded in place through
   levels 1-10 for more capacity. (Mobile spin-off.)
5. **Module-based:** one plant footprint, swappable generator
   modules (conventional -> combustion turbine -> clean) with
   different output/pollution/price. (SC2013.)

### A6. Shortage and failure handling

- **Binary brownout:** buildings without power show an icon and go
  dark; zones can be left deliberately unpowered. Simple, legible.
- **Proportional degradation:** under-supply slows *every* consumer
  proportionally (e.g. 58% supply = everything runs at 58%).
  Graceful but opaque — "everything is slow and nothing tells you
  why" is a documented failure mode in automation-game design notes.
  (See sources: Factorio-bot design spec.)
- **Distance/id-ordered allocation:** a modern open-source design
  allocates scarce supply nearest-the-source first, ties broken by
  building id, and — crucially — distinguishes the *diagnosis*:
  `NoPower` (not on any network) vs `PowerShortage` (on a network
  that is too small). Growth is blocked until spare supply exists, so
  shortages never oscillate. Only buildings the network reaches count
  toward demand. (See sources: SlimCity utilities model — read in
  full; this is the closest design reference to NOVATERRA's needs.)
- **Plant aging + funding:** plants lose efficiency over time and
  risk explosion; budget sliders adjust output, but underfunding
  accelerates degradation. Adds management depth at the cost of
  per-plant micromanagement. (SC4.)
- **Random infrastructure failure:** cables/pipes can break in
  storms; rare, repairable, creates maintenance gameplay. Divisive —
  some players love the drama, others call it random punishment.
  (Surviving Mars community testing.)

### A7. Storage, spikes, and trade

- **Batteries/accumulators** store surplus for night/winter demand
  spikes and make intermittent sources (solar/wind) viable.
- **Seasonal/weather demand spikes** (heaters in winter, AC in
  summer) create the rhythm that storage exists to smooth. (CS2.)
- **Import/export:** surplus power/water sold to map-edge neighbors
  automatically once lines/pipes reach the map border — turns
  utilities into an economy lever, not just a cost center. Early
  game can also *buy* power instead of building a plant. (CS2; SC4
  regional deals.)

### A8. Feedback and UX patterns

- **Night lighting:** unpowered streets show no street lamps —
  "the network's reach reads directly off the street after dark."
  Blackout visuals are iconic genre feedback.
- **Overlays/lenses:** pollution, water, power-coverage overlays;
  per-building icons for unserved buildings.
- **Problem taxonomy:** the modern reference design flags
  generators that touch no conductor as "cut off" (a visible
  mistake), separate from "network too small" — the player always
  knows *which* problem they have.

---

## (b) FUN vs TEDIOUS — analysis with reasons

### FUN (keep these dynamics)

1. **The plant-type tradeoff triangle (cost/output/pollution).**
   Every classic's most praised decision layer. Coal is the best
   deal per unit and poisons your land value; nuclear is clean and
   mighty but bankrupts you early and can melt down; wind is free
   but feeble. *Why fun:* each option has a real personality and the
   "right" answer changes with city size, budget, and map — it is a
   strategy choice, not a chore. It stays interesting for hundreds
   of hours because it interacts with placement, economy, and tech.

2. **The tech ladder as an era change.** Unlocking solar, then
   nuclear, then fusion feels like the city entering a new age.
   *Why fun:* it is a reward for growth, paced by milestones or
   research, and each rung re-solves the power problem in a new way
   (clean but intermittent -> mighty but risky -> ultimate).

3. **Rare, dramatic, telegraphed failures.** Nuclear meltdowns,
   plant explosions from age/underfunding, a microwave beam missing
   and torching a building. *Why fun:* they are infrequent, they
   create stories, and good implementations telegraph risk (aging
   warnings) so they feel earned, not random. They make the safe
   choice (overbuilding clean capacity) a meaningful insurance
   decision.

4. **Storage smoothing intermittent sources.** Batteries + solar,
   water towers + droughts. *Why fun:* it turns a weakness
   (day-only solar) into a two-part strategy puzzle with a visible
   payoff when the city rides through a spike on stored power.

5. **Selling surplus / buying to bootstrap.** Exporting excess
   power for income, or buying map-edge power instead of building a
   dirty coal plant on day one. *Why fun:* converts utilities from
   pure cost center into economic strategy; the "buy early, build
   late" arc is a genuinely interesting opening decision.

6. **Water as a placement puzzle (contamination).** Intakes vs.
   industry vs. sewage placement, depletable groundwater.
   *Why fun:* the challenge is in *where* things go — a planning
   decision made once — not in repetitive construction.

### TEDIOUS (avoid these dynamics)

1. **Laying pipes/power lines under every new expansion.** The
   single most-cited tedium in the genre: "Adding in water pipes
   every time you expand isn't fun, in fact it does start to feel a
   little tedious to remember it, and do it every single time."
   *Why tedious:* it is pure repetition with a single correct
   answer — players build the lines along roads anyway — so it adds
   clicks without decisions. The genre's fix (roads carry utilities
   automatically) was celebrated as the biggest QoL win in the
   modern sequel.

2. **Unpredictable delivery (agent-based flow).** Building a plant
   and waiting for resource "blobs" to randomly reach buildings.
   *Why tedious/unfun:* the player's correct action does not
   reliably fix the problem; troubleshooting becomes superstition.
   Deterministic topological delivery (flood fill) is both more fun
   and more honest.

3. **Per-plant budget sliders and aging micromanagement.** Tuning
   funding per plant to squeeze output, replacing aging plants on
   individual timers. *Why tedious:* it is spreadsheet fiddling
   with no spatial or strategic dimension; underfunding traps
   punish inattention rather than bad planning.

4. **Retrofitting logistics chains through built-up areas.** The
   oil-train fuel chain is the cautionary tale: "my head hurts from
   the tetrising that had to be done in an area I'd already filled
   in to the last square." *Why tedious:* logistics chains demand
   corridor space that dense cities no longer have, turning a
   mid-game upgrade into demolition work. Lesson for NOVATERRA:
   keep fuel/missile logistics chains in the military/industrial
   sphere (where logistics IS the game), never as a requirement for
   civilian utilities.

5. **Opaque hidden rules.** Water "pressure" systems players cannot
   see or reason about ("my water system doesn't make sense to me").
   Automation that does a bad job (auto-lay pipes that miss
   connections). *Why tedious/unfun:* the player cannot form a
   correct mental model, so every failure feels like a bug.

6. **Proportional-everything-slows-down brownouts.** *Why bad:*
   silent, global, and hard to diagnose — "every lag edge wrong with
   no error anywhere." Binary per-zone/per-building states with a
   clear icon beat graceful degradation for legibility.

---

## (c) Adopt / Avoid — recommendations for NOVATERRA

NOVATERRA-specific grounding: deterministic fixed-timestep sim,
entity ids, zones, research upgrades already exist; current utility
model is a global pool with id-ordered allocation and demand counted
from all buildings. The target: buildable power LINES and water
PIPES between areas + zone-level servicing.

### ADOPT

**1. Connectivity = integer flood fill over conductor tiles; recompute on build/destroy, not per tick.**
*What:* plants seed a BFS over tiles flagged as conductors (roads +
power lines for electricity; roads + water pipes for water). A zone
is served if any of its tiles touches the served network; buildings
inside a served zone get utilities automatically (underground
distribution abstracted away).
*Why:* flood fill is order-independent and integer-based — deterministic
by construction on every platform, O(tiles) and cheap enough to run
on structural change only. It is the genre-proven model (the classic
power-net) and it directly implements the "zone hooked up -> whole
zone served" design goal. Never use agent-based flow (the genre's
biggest utility-sim failure).

**2. Roads conduct both utilities; lines/pipes are the long-hop tool.**
*What:* roads automatically conduct power and water (the modern
sequel's celebrated fix). Power lines and water pipes are cheap,
fast-to-drag links for: plant -> grid hookup, crossing wilderness or
water, reaching a far zone without building a road.
*Why:* this kills the genre's #1 tedium complaint (per-expansion pipe
laying) while preserving the requested "buildable network links
between areas" fantasy. Lines/pipes become interesting precisely
because they are *optional and situational*, not mandatory chores.
One caveat from the research: keep line/pipe dragging forgiving
(auto-connect at endpoints, no fiddly pylon placement).

**3. Keep allocation ordered and deterministic, but per network — and count demand only from reached buildings.**
*What:* each connected network sums its own plants' supply; served
buildings draw in a fixed order (keep the existing id-order, or
nearest-source-first with id tiebreak). Beyond supply -> binary
unpowered/unwatered with a clear icon. Demand = only buildings the
network reaches (unreached buildings draw nothing and flag as
disconnected).
*Why:* per-network allocation makes brownouts local and diagnosable
("the east grid is short" beats "the global pool is short"); counting
only reached demand avoids the documented trap where the numbers read
healthy while the city quietly refuses to grow. Binary states stay
legible in an RTS hybrid; proportional slowdown is a poor fit (see
Tedious #6). All of this is integer-ordered — determinism is free.

**4. Split the diagnosis: "disconnected" vs "shortage."**
*What:* a building/zone with no network path shows a
disconnected icon; one on a network whose supply is exhausted shows a
shortage icon. Stranded generators (touching no conductor) flag
themselves as mistakes.
*Why:* the research shows players tolerate utility problems exactly
in proportion to how fast they can identify them. Two icons + a
coverage overlay turn every outage into a 5-second fix instead of a
10-minute mystery. This is cheap to implement (both flags fall out of
the flood fill + allocation pass).

**5. Plant ladder across tech levels with real personalities, unlocked via research.**
*What:* e.g. wind/solar (clean, weak/intermittent) -> coal/oil
(cheap, strong, polluting) -> nuclear (mighty, clean, expensive,
tiny seeded meltdown risk, needs a water hookup) -> fusion (late
research, ultimate). Water: well -> pump (freshwater-adjacent) ->
desalination (seawater-adjacent, needs power, 2x output) ->
treatment plant (system-level capacity + decontamination, needs
power, no pipe adjacency required).
*Why:* the tradeoff triangle is the genre's most durable fun
mechanic; research-gated unlocks reuse NOVATERRA's existing upgrade
system and pace the "new era" feeling. Cross-utility hooks (water
needs power; nuclear needs water) create planning depth from
placement, not clicks. Keep each plant binary on/off with flat
upkeep — no per-plant funding sliders, no aging timers (Tedious #3).

**6. Storage buildings that smooth intermittency and spikes.**
*What:* battery stations (power) and water towers (water) as small,
cheap stock buffers; solar produces day-only, wind varies on a
seeded deterministic cycle; demand spikes are telegraphed (e.g.
seasonal or event-driven).
*Why:* storage is what makes weak/clean sources strategically viable
instead of trap choices, and riding out a spike on stored reserves
is a proven fun payoff. Implementation is a single integer stock per
network — deterministic and trivial.

**7. Map-edge import/export for surplus.**
*What:* run a line/pipe to the map edge to auto-sell surplus
power/water for income; optionally buy early-game power instead of
building a plant.
*Why:* converts utilities from cost center to economic lever and
gives the line/pipe tools a late-game purpose beyond hookups. Auto
once connected — no per-tick trading micro.

**8. Water contamination as a placement puzzle, kept simple.**
*What:* industrial pollution can foul adjacent water sources
(binary: clean/fouled, shown on overlay); treatment plants scrub
one source each; groundwater (if used) depletes slowly and renews.
*Why:* "where do I put the intake" is a planning decision made once
(Fun #6). Keep it binary and visible — never a hidden pressure
simulation (Tedious #5).

### AVOID

**1. Agent-based power/water flow.** Unpredictable, unfun,
unscalable, and hostile to determinism. Topological flood fill only.

**2. Mandatory per-block/per-building wiring.** Never require the
player to connect each building or re-lay pipes per expansion. Zone
touching the network = whole zone served, always.

**3. Per-plant funding sliders and aging/degradation timers.**
Flat upkeep, binary on/off. Depth should come from *which* plants
and *where*, not from babysitting sliders.

**4. Civilian fuel-logistics chains.** Do not make civilian power/water
depend on delivered fuel via transport corridors — retrofitting pain
is well documented. (NOVATERRA's planned missile/fuel logistics
belongs to military gameplay, where the chain IS the game, and
should be designed as its own system, not bolted onto civilian
utilities.)

**5. Proportional brownouts and hidden pressure mechanics.** Binary
served/unserved per zone with explicit icons; every number visible
in the UI. If the player cannot see why, it reads as a bug.

**6. A separate underground-layer UX as the only pipe interface.**
If pipes are surface-draggable and auto-connect, no second map
layer is needed; the classic dual-layer view confused players about
correspondence between layers.

### Determinism notes (for the implementation plan)

- Flood fill: pure function of (conductor tiles, plant tiles) —
  integer BFS, no floats, no iteration-order dependence. Recompute on
  structural changes (build/bulldoze), cache otherwise.
- Allocation: sort served consumers by (network id, distance from
  source, entity id) — fully ordered, no ties possible.
- Intermittency (wind/solar output curves): drive from the seeded
  sim RNG streams or closed-form functions of tick (e.g. day phase),
  never Math.random; identical inputs -> identical output.
- Storage stocks: integers (kW/water units), updated in fixed tick
  order.
- Rare failures (meltdown risk): gate on seeded RNG with a
  telegraphed warning state first, so outcomes are reproducible and
  feel fair.
- Snapshot impact: network id per zone + served flags are derived
  state (recomputable); only plant on/off, storage stocks, and
  fouled-source flags need persisting.

---

## (d) Sources

Full URLs, verbatim as returned by search:

**Classic power-net / flood-fill model:**
- https://github.com/jcbjcbjc/gamegen-verifier/blob/HEAD/spec/simcity.md
  (documented flood-fill distribution algorithm, conductor tile types,
  plant capacity/pollution/meltdown table)
- https://vectree.io/pdf/c/simcity-4
  (power net, plant aging, budget funding effects, water pipe grid,
  pollution shutting down pumps)

**Classic plants, water types, progression:**
- https://gamefaqs.gamespot.com/pc/356839-simcity-2000-streets-of-simcity/faqs/33520
  (plant roster incl. fusion date-unlock 2050, microwave miss-fire
  risk, power-line transmission loss)
- https://gamefaqs.gamespot.com/pc/203908-simcity-2000-scenarios-volume-1-great-disasters/faqs/6948
  (water: treatment plants, desalination 2x output + power
  requirement, water towers as drought storage)
- https://simcity.fandom.com/wiki/List_of_power_plants
  (module-based plant upgrades: coal/oil/wind/solar; wind amplifier;
  vertical turbines via School of Engineering)

**Modern sequel (roads carry utilities; voltage networks):**
- https://gamermatters.com/electricity-and-water-utilities-have-massively-changed-in-cities-skylines-2/
  (dev-diary summary: transformer stations, cable capacity
  bottlenecks, battery stations, seasonal demand spikes, groundwater
  depletion/renewal)
- https://github.com/lulu0119/cities-skylines-2-agent/blob/HEAD/Mod/Agent/Skills/utility-networks/SKILL.md
  (low/high voltage split, wind feeds low-voltage directly,
  transformer bridging rules)
- https://en.hocmarketing.org/unveiling-the-ultimate-urban-simulation-why-cities-skylines-2-ou-69350
  (roads-carry-utilities as the tedium fix)
- https://www.dexerto.com/gaming/cities-skylines-2-development-trees-unlockables-and-costs-2349659/
  (development-tree unlock costs: gas->coal->nuclear;
  battery->geothermal/solar/hydro)
- https://www.gamesradar.com/cities-skylines-2-development-nodes/
  (electricity/water development nodes)
- https://www.digitaltrends.com/gaming/cities-skylines-2-best-development-nodes/
  (strategy arc: coal early -> wind+battery -> solar -> nuclear
  end-game)
- https://www.pcgamer.com/cities-skylines-2-tips/
  ("don't build a power plant right away" — buy map-edge power early)
- https://playerassist.com/how-to-sell-excess-utilities-in-cities-skylines-2/
  (map-edge export of surplus power/water)

**Fun-vs-tedious evidence (reviews, postmortems, community):**
- https://www.gamingonlinux.com/2015/03/cities-skylines-city-builder-releases-today-some-thoughts-after-playing-it/
  (per-expansion pipe laying "starts to feel a little tedious")
- http://www.megabearsfan.net/post/2015/06/19/Cities-Skylines-game-review.aspx
  (power-line/pole placement annoyance; proximity conductivity
  compromise)
- https://www.resetera.com/threads/why-did-ea-ruin-the-simcity-franchise-by-releasing-simcity-2013.45888/
  (agent-based power/water delivery as "terrible design")
- https://www.pcgamer.com/simcity-inside-the-glassbox-engine/
  (GlassBox agent model description)
- https://www.vg247.com/simcity-scenario-video-shows-off-water-system
  (groundwater table, pollution -> undrinkable water)
- https://steamcommunity.com/app/916440/discussions/0/1680315447978023985/
  (fuel-logistics retrofit pain: "my head hurts from the tetrising")

**Coverage-radius / heat models:**
- https://anno1800.fandom.com/wiki/Electricity
  (road-distance coverage radius 33/49 tiles, binary served/unserved,
  oil-via-train fuel chain)
- https://www.gamereactor.eu/frostpunk-review/
  (generator heat radius, tech-extended range, efficiency falloff)

**Modern open-source design reference (read in full):**
- https://github.com/rbenzing/slimcitygame/blob/HEAD/docs/world-sim/utilities-model.md
  (BFS coverage walk along conducting roads, power lines as the
  long-hop tool, far-end-first brownout ordering by distance then
  id, demand counted only from reached buildings, stranded-generator
  visibility, NoPower vs PowerShortage diagnosis, street-lamp night
  feedback — the closest existing design to NOVATERRA's target)

**Adjacent mechanics (proportional brownout critique, random failures, opaque pressure):**
- https://github.com/arturh85/factorio-bot/blob/HEAD/docs/superpowers/specs/2026-09-03-starter-factory-design.md
  (proportional brownout "fails quietly" — coverage is not capacity)
- https://steamcommunity.com/app/464920/discussions/0/2949168687311698309/
  (community-tested random cable-break rates)
- https://steamcommunity.com/app/784150/discussions/0/3395176266129629374/
  (opaque water-pressure mechanics confusing players)
- https://forums.macrumors.com/threads/simcity-help-tips-ipad.1066678/
  (bad auto-pipe-laying automation worse than none)
