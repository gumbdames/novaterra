# Research: Logistics / Supply Chains & Unit Veterancy

**Date:** 2026-09-30 · **Purpose:** grand-expansion design grounding
**Scope:** external research only — how other games did (a) ammo/fuel/supply logistics
(production → transport → frontline reload) and (b) unit veterancy/progression, plus whether
civilian units deserve a progression analogue.
**Constraint note:** per standing rules, commercial game titles are not named anywhere in
product/docs/comments; this research doc is the permitted exception (formal citations with
URLs). Mechanics are described neutrally in the design sections; titles appear only as
sources below.

---

## A. Mechanics survey — logistics / supply chains

### A1. The Wargame-series model (Eugen Systems): the gold standard for tactical supply
The most-cited implementation in the genre. Every unit carries an **ammo meter** and a
**health meter**; mechanized units additionally carry a **fuel meter**. Movement burns fuel;
firing burns ammo. The key design features:

- **Supply is one abstract resource.** Supply units (trucks, helicopters, ships, amphibious
  units) carry generic *supply points* (a float). When parked near a unit they
  **repair, rearm, and refuel simultaneously**; each service can be **toggled off** per
  supply unit so scarce points go to ammo instead of armor repair, etc.
- **Missiles are supply-expensive by design.** One cheap supply truck's full load refills
  only ~1–2 anti-air missiles on a launcher. Heavy weapons create disproportionate
  logistical demand — this is a deliberate balance lever, not an accident.
- **Forward Operating Bases (FOBs)** are immobile, hard-to-kill buildings holding enormous
  supply pools. Supply units must shuttle back to a FOB to refill (which depletes the FOB).
  Ships skip fuel entirely but rearm at coastal FOBs or from naval supply ships, which
  themselves refill at FOBs — a **two-tier chain** (FOB → carrier → frontline).
- **Transfer is proximity-based and requires the supplier to be stationary** on the ground;
  no manual load/unload UI.
- **Ammunition weight varies per weapon**, set by a per-weapon "supply cost" — a single
  float per weapon type, not per shell. Deterministic-friendly by construction.

The design consequence the community articulates most clearly: *in any single engagement
logistics barely matters; over repeated operations it decides who holds territory.*
Fuel is tuned so vehicles can reach objectives on internal tanks but cannot maneuver after
arriving — logistics governs **tempo and sustainment**, not moment-to-moment shooting.

### A2. Herzog Zwei (1989, Sega Genesis): logistics as physical play
One of the earliest RTSes already shipped fuel + ammunition + supply trucks: units burn both,
supply trucks drive out to refuel and rearm them, and the player's command unit is itself
the transport. Logistics was a physical, moment-to-moment problem because the commander was
physically present. Lesson: when the player *is* the convoy, logistics is the game; when the
player commands hundreds of units, it must recede into automation.

### A3. Hearts of Iron IV: supply radii and hubs (grand-strategy scale)
The 2021 supply rework replaced point-to-point convoys with:
- **Supply hubs** with a **fixed overland range** (radius), modified by terrain, weather,
  infrastructure, and **motorization** (trucks assigned to a hub extend its reach).
- **Railways** carry supply from the capital hub to regional hubs; hub capacity caps the
  total supply a region can draw.
- Divisions draw from **multiple overlapping hubs**; when a hub is overdrawn, the **deficit
  is shared evenly** across all drawing units (graceful degradation, not hard failure).
- Naval variant: supply bases transfer supply to fleets **within range** automatically.

Two takeaways: (1) **radii turn logistics into placement/geometry decisions** (where do I
put hubs? where do railways run?) rather than driving decisions; (2) the devs explicitly
**removed a compounding distance penalty** during development because it interacted badly
with overlapping hubs and produced unpredictable, feel-bad outcomes — a caution against
layered multiplicative supply penalties.

### A4. Total Conflict: Resistance — the cautionary tale (micromanagement hell)
Ships the *full* logistics fantasy: manufacture ammunition, weapons, vehicles, food, and
supplies in a production chain, then equip squads and disperse stocks. Player verdicts:
"I love that all elements of logistics are in this game... However the way the game handles
this is absolutely exhausting. As a new player I almost refunded due to sheer
micromanaging required to keep track of your supplies and equip your squads." Workarounds
players invented: dump everything at the capital, standardize every squad to one rifle,
sell off everything else. **The chain itself was loved; the manual handling was hated.**
The product lesson: production chains are a macro-planning pleasure, but any step that
requires per-truck, per-squad handling must be automated or it becomes the game — and not
the fun part.

### A5. Systemic War (in development): automation as the fix
Their logistics prototype: deployment trucks carry supplies, attacking them destroys the
cargo, lower-tier trucks repair slower — and critically, **"you can automate supply truck
routes to reduce micromanagement."** The emerging consensus in new titles: the fun is in
*designing* the logistics network; the *execution* belongs to automation.

### A6. Anno 1800 / The New Cycle: abstraction vs physicality
Community debate over whether warehouses should teleport goods map-wide (Anno-style
island storage) or require physical conveyors (New Cycle). Logistics-focused players call
map-wide teleportation "shallow" and consider physical chains "a major fun factor"; others
prefer the lighter model. Lesson: the audience for a city-builder/RTS hybrid **expects
visible, physical supply movement** — but only if it doesn't demand babysitting.

### A7. Avalon Hill board-game lineage (the oldest model)
Classic wargame supply rules: a unit must trace a supply line through friendly-controlled
areas back to a friendly city. Cut-off units fight at reduced capacity, then are
eliminated. The mechanic that survived 50 years of iteration is **zone-of-control
interdiction** — supply matters because it can be *threatened*, not just because it runs
out.

### A8. A useful rule of thumb (from designer discussion)
Real-world combat-to-support troop ratios run ~3:1 to 10:1. If your game makes the player
"herd 3 supply lorries for every tank," you have built a logistics simulator, not an RTS.
**The player should command a handful of supply *systems*, not dozens of supply *units*.**

---

## B. Mechanics survey — veterancy / progression

### B1. Warzone 2100 (Pumpkin Studios): the attachment benchmark
Nine ranks from Rookie to Hero, earned by kills, each giving a small (~5%) accuracy/HP
bonus with **chevron visual markers** — and critically, **units persisted across the whole
campaign**, and recycled veterans' experience transferred to the commander's next unit.
Players report campaigns built around a single strike group carried "from rookies in the
first mission to 3-gold-chevron elites." The famous summary: *"losing the experience
always hurt worse than losing the resources — it represented an investment of time and
effort."* Takeaway: **attachment comes from persistence + visible identity**, and bonuses
can be small if the story is personal.

### B2. Company of Heroes (Relic): asymmetric, per-unit, death-erases
Three veterancy stars earned by dealing *and receiving* damage (damage given weights more).
Bonuses are **per-unit-type and per-level** (e.g. grenadiers gain accuracy, then reload
speed, then incoming-damage reduction; tanks unlock new abilities like flares or strafing
fire at certain levels). Factions differ in *how* they earn it: one earns by kills, one
**buys** it from a building, one **chooses offensive vs defensive** paths, one requires a
command vehicle nearby when kills happen. Losing a squad **erases its veterancy** —
which is exactly why players protect veterans. Top-tier units can auto-heal. Takeaway:
death-erases plus distinctive per-level bonuses makes veterancy a **unit-preservation
economy**, and letting *how you earn it* differ by faction is a design knob NOVATERRA
doesn't need but can admire from afar.

### B3. Command & Conquer series: crisp tiers, purchasable rank, XP math
Three crisp tiers — Veteran (+20% HP, +15% damage) / Elite (+40% HP, +25% damage) /
Heroic (+50% HP, +100% attack speed, **auto-heal**, immunities). XP required scales with
the *target's* cost-equivalent value, and killing a higher-tier unit pays a multiplier
(veteran 2x, elite 3x, heroic 4x XP) — **killing veterans is worth more**, a built-in
anti-snowball reward for hunting them. Two standout mechanisms:
- **Veterancy crates** on the map grant instant ranks (exploration reward).
- **Veteran Academies**: neutral structures that, when captured, make all
  **subsequently-produced units start at Veteran** — stackable to Heroic. This ties the
  *economy/territory* game directly into unit progression.

### B4. Wargame series: "veterancy affects the human, not the machine"
Five levels (Rookie → Trained → Hardened → Veteran → Elite) giving **accuracy multipliers**
(100/110/126/136/160%). Explicit design philosophy: experience does not make the tank's
gun bigger or armor thicker; it makes the *crew* aim quicker, reload faster (manual
loaders only), spot farther, and **recover from morale shocks faster**. Earned from
surviving combat — including taking damage and merely being near enemies — weighted toward
higher-cost-ratio kills. Kept across campaign battles, **not** in skirmish. Takeaway for
NOVATERRA: crew-flavored bonuses (accuracy, reload, sight, morale) are more legible and
less balance-breaking than raw HP/damage stacking.

### B5. Stormgate (Frost Giant): modern anti-snowball touches
One faction earns XP by **last-hitting**, with nearby allies receiving a share, and **all
XP that would go to a maxed unit is redistributed to nearby allies** — veterancy becomes
partly a team resource. A top-bar ability can grant instant XP ("Promote"). Bonuses are
+20% HP / +10% damage per rank plus one **signature perk per unit type per rank**
(range, speed, armor). Takeaway: overflow-sharing and team XP are elegant answers to
"the rich get richer."

---

## C. Civilian-side progression analogues

### C1. Dwarf Fortress: the gold standard for civilian attachment
Dwarves gain **skill levels through doing labor**; legendary skill produces higher-quality
goods (up to named artifacts via "strange moods") and massively faster work. Players plan
around specific named dwarves ("my legendary weaponsmith"), and skill is inseparable from
identity — names, personalities, moods, death. It works because every civilian is a
**simulated individual with a name and a story**. Without per-agent identity, per-worker
XP is invisible.

### C2. Anno 1800: progression lives in buildings, not workers
Workers are abstract **population tiers** (farmers → workers → artisans → engineers →
investors), never leveled individuals. Progression comes from **named specialists** and
items slotted into **Trade Unions**, each with flavorful tradeoffs (+120% productivity,
+100% maintenance, +25% fire chance...). The lesson: in city builders, players bond with
**places and named characters**, not with individual laborers. The lever is
*staffing/equipping the building*, not leveling the worker.

### C3. Civilization VII: the removal lesson
The newest entry **deleted the Worker unit entirely** — tile improvements now happen
through city growth. The stated reason: workers had become late-game micromanagement
where *"the best option is to not strategize"* — and a unit you automate isn't adding
anything. This is the cautionary endpoint of civilian per-unit progression: if it doesn't
generate decisions, it's UI tax.

### C4. Synthesis
No surveyed city-builder levels individual civilian workers. Civilian progression appears
at three levels instead: **population tiers** (Anno), **building equipment/staffing**
(Anno specialists), and **named individuals** (Dwarf Fortress, only where individuals
are simulated). All three are deterministic-friendly.

---

## D. FUN vs TEDIOUS analysis

**What was consistently fun:**
1. **Planning the network, not driving the trucks.** Choosing where FOBs, hubs, and
   factories go; deciding rail vs road; positioning supply near the front. Geometry and
   investment decisions, made at city scale.
2. **Supply as a tempo constraint.** "My tanks can reach the objective but not exploit
   past it" creates real operational decisions (advance now or wait for the convoy?)
   without punishing any single fight.
3. **Interdiction as a weapon.** Cutting supply lines — raiding convoys, capturing FOBs,
   threatening sea lanes — is consistently cited as one of the most satisfying plays in
   logistics games. It only works if supply is *physical and visible*.
4. **Attachment through persistence.** Veterancy works when units have identity (chevrons,
   names, campaign persistence) and when loss *hurts* (death erases the investment).
   Small bonuses suffice when the story is personal.
5. **Killing veterans pays.** XP multipliers for destroying high-tier units (C&C) and
   team XP sharing (Stormgate) keep progression from becoming runaway snowball.

**What consistently became tedium:**
1. **Manual loading/unloading and per-truck routing.** The #1 refund-adjacent complaint
   (Total Conflict: Resistance). Anything the player must do per-convoy per-trip must be
   automated; the player sets policy (routes, priorities), the sim executes.
2. **Logistics that taxes every skirmish.** If a normal 2-minute fight can end because
   someone forgot a truck, the system punishes attention rather than rewarding planning.
   (Wargame avoids this by making one engagement's logistics irrelevant.)
3. **Spreadsheet-invisible numbers.** Bonuses the player can't see or feel (tiny
   multiplicative stacks with no visual marker) read as noise. Chevrons, new abilities,
   auto-heal, and floating rank icons are what make progression *felt*.
4. **Compounding multiplicative penalties** that interact unpredictably (HOI4 devs
   removed exactly this). Keep the math legible: additive deficits, shared evenly.
5. **Civilian micro with no decisions.** Per-worker XP on anonymous populations is the
   endpoint Civ VII deleted.

---

## E. Adopt / avoid recommendations for NOVATERRA

Each recommendation is judged against: deterministic fixed-timestep sim, seeded RNG,
browser performance, city-builder/RTS hybrid scale, and the North Star (no bugs, flowing,
fun).

### ADOPT

**1. One abstract supply resource per carrier, with per-service toggles (Wargame model).**
Supply trucks, supply ships, and tanker aircraft carry generic *supply points* (one float
each). Parked within a radius of a friendly unit, they repair / rearm / refuel; the
player can toggle each service to prioritize scarce points (ammo over armor, say).
*Why:* a single float per carrier keeps the deterministic sim trivially cheap; per-weapon
supply costs (one float per weapon type, paid per shot) give the missile-vs-bullet weight
difference without per-shell bookkeeping. It maps 1:1 onto the planned design (missile
plants → specialization → trucks/ships/aircraft → reload at bases or in the field) — the
only addition is the *toggle*, which is the cheapest possible tactical depth.

**2. Automate the last mile; let the player design the network (Systemic War lesson).**
Depots auto-load supply vehicles; vehicles auto-shuttle between depots and forward staging
posts; field units draw automatically in radius. The player's decisions are *where* to
build depots, *which* routes to motorize, *what* to prioritize — never "drive this truck."
*Why:* the Total Conflict: Resistance postmortem is unambiguous — a beloved production
chain becomes refund-tier when its execution is manual. Automation is also
determinism-friendly (routes are state, not input streams).

**3. Tune supply as a strategic-layer constraint, not a per-skirmish tax (Wargame lesson).**
Internal tanks/magazines sized for a normal engagement; logistics decides sustained
operations, defense-in-depth, exploitation after breakthrough, and counter-attack
readiness. Out-of-supply degrades (shared evenly across drawing units, HOI4-style), never
hard-stops a fight mid-click.
*Why:* protects moment-to-moment fun (the click bug era taught us how fragile the feel
layer is), keeps the sim cheap (depletion ticks are slow state), and makes logistics
matter exactly where the design wants it: operational tempo across a long playable game.

**4. Veterancy: per-unit XP from damage dealt, crew-flavored bonuses, visible chevrons,
capped with overflow sharing (Wargame + C&C + Stormgate synthesis).**
- XP accrues from damage dealt, weighted by target cost (killing expensive/veteran targets
  pays more — built-in anti-snowball).
- 3–5 tiers; bonuses are crew-flavored: accuracy, reload speed, sight range, morale
  recovery — *not* raw HP/damage stacking ("veterancy affects the human, not the machine").
- Visible chevrons/insignia on the unit; a small auto-regen at max tier (the C&C Heroic
  reward that makes max rank *feel* different).
- XP that would go to a maxed unit redistributes to nearby allies (Stormgate) — rewards
  keeping veteran formations together.
- Death erases veterancy (CoH lesson) — this is what makes players protect veterans.
*Why:* deterministic-friendly (XP events derive from damage events, which the sim already
emits); bonuses are multipliers on existing stats, so balance stays legible; the
anti-snowball rules keep a long game from tipping irreversibly.

**5. Tie progression to the city-builder side: academies that produce pre-ranked units
(C&C Veteran Academy).**
A military academy building (or upgrade line) lets newly produced units start at
Veteran — or lets max-tier veterans be stationed as trainers to accelerate a garrison's
XP. *Why:* gives the economic/builder half of the hybrid a direct lever on military
quality; creates a real "quality vs quantity" strategic choice; avoids late-game
veterancy grind (fresh units don't start from zero in hour six).

### AVOID

**1. Itemized per-shell / per-missile physical inventory on the field.**
*Why:* bookkeeping explosion in a deterministic sim, invisible to the player (spreadsheet
noise), and the Wargame per-weapon supply-cost float achieves the same balance effect
for ~1% of the complexity. Missiles are distinguished by *cost*, not by SKU.

**2. Manual load/unload or per-convoy driving.**
*Why:* the single most-cited fun-killer in the survey; also an input-stream nightmare
for determinism and replays. Policy UI (routes, priorities, staging posts), automated
execution.

**3. Hard failure states from empty supply (dead-instant units, eliminated armies).**
Out-of-ammo → fall back to secondary weapons or hold fire; out-of-fuel → stationary but
still combat-capable in place; overdrawn hub → deficit shared evenly. Interdiction should
*degrade*, not delete.
*Why:* hard failures cascade (one raided convoy ends the game), feel arbitrary, and
punish attention rather than planning. Avalon Hill-style elimination belongs to
turn-based wargames, not a flowing hybrid.

**4. Compounding multiplicative supply penalties.**
*Why:* HOI4's developers removed exactly this after finding it unpredictable and
feel-bad, especially with overlapping supply radii. Additive, evenly-shared deficits only.

**5. Making basic missile production a bottleneck the player must constantly feed.**
The chain (basic plants → specialization factories → transport → reload) is a *planning*
pleasure; if plants need per-batch player input to keep running, it's a chore. Continuous
production with stockpile caps, player sets ratios/priorities.
*Why:* same automation principle as #2, applied one level up the chain.

---

## F. Verdict: civilian veterancy — SKIP per-unit, ADOPT building-level progression

**Recommendation: do not give individual civilian workers veterancy/XP. Implement
civilian progression at the building and infrastructure level instead.**

Reasons:
1. **No identity, no attachment.** The Dwarf Fortress lesson is that civilian
   progression works through *named individuals with stories*. NOVATERRA's civilians are
   abstract populations; XP on invisible workers is spreadsheet noise with zero legibility
   — the exact failure mode the FUN vs TEDIOUS analysis flags.
2. **No decisions, no game.** Civ VII deleted worker units outright because per-worker
   management had become decisions-free micro. A leveled worker the player never sees or
   commands adds UI without adding play.
3. **Sim cost with no payoff.** Per-worker XP means per-agent state and per-agent UI in
   a game whose civilians number in the hundreds-to-thousands. Building-level state
   (one float per building) is orders of magnitude cheaper in a deterministic sim.
4. **The city-builder genre already solved this** at the right level: Anno-style
   **named specialists and equipment slotted into buildings** (trade-union model),
   population tiers, and infrastructure tech levels. These give the same strategic depth
   (staff this plant with an expert crew, motorize that depot) with legible, place-based
   identity.

**What to build instead (civilian-side):**
- **Experienced crews as building upgrades/items:** assignable specialists or crew
  training levels per production building (missile plant, refinery, port) — productivity
  and throughput bonuses with flavorful tradeoffs, in the Anno specialist tradition.
- **Infrastructure tech levels:** depots, petrol stations, and ports level up (capacity,
  loading speed, service radius) — the civilian analogue of veterancy, and it's *places*
  the player already cares about.
- **The veteran bridge:** max-tier military units can be stationed at academies as
  trainers (ties the two systems together and gives old veterans a second career instead
  of a death sentence).

This keeps the design's asymmetry clean: **units earn veterancy through danger;
places earn capability through investment.** Both reward the player's long-term
planning, neither demands babysitting.

---

## G. Sources

- Wargame Wiki — Logistic:
  https://wargame.fandom.com/wiki/Logistic
- Wargame Wiki — Morale and Veterancy:
  https://wargame.fandom.com/wiki/Morale_and_Veterancy
- Wargame: Red Dragon Mechanics Manual (supply rates):
  https://raw.githubusercontent.com/ResidentMario/wargame/master/Wargame_Values_Manual.pdf
- Wargame: Red Dragon TV Tropes (naval supply ships, FOB resupply):
  https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/WargameRedDragon
- Wargame: Red Dragon support-player logistics guide (Spacebattles):
  https://forums.spacebattles.com/threads/wargame-red-dragon.292596/page-136
- Wargame: Red Dragon "rearmer ships" discussion (Steam):
  https://steamcommunity.com/app/251060/discussions/0/135508292188528416/
- CivFanatics — "Logistics and supply lines" (Wargame supply analysis):
  https://forums.civfanatics.com/threads/logistics-and-supply-lines.569377/
- Wargame: Red Dragon supply/logistics debate (Steam):
  https://steamcommunity.com/app/251060/discussions/0/558753804005160813/?l=brazilian
- Herzog Zwei retrospective (fuel/ammo/supply trucks, 1989):
  http://dev.to/retrorom/herzog-zwei-the-genesis-rts-that-invented-a-genre-before-the-word-existed-1g5e
- Systemic War — fuel/ammo/repair logistics prototype (YouTube):
  https://www.youtube.com/watch?v=68FbQ3bFwP4
- gamedev.net — "Logistics in a Strategy Game" (design discussion, support ratios):
  https://www.gamedev.net/forums/topic/640847-logistics-in-a-strategy-game/5050169/
- Total Conflict: Resistance — "Logistics... is a nightmare" (Steam):
  https://steamcommunity.com/app/1860510/discussions/0/601898176917553660/
- The New Cycle — logistics/storage discussion (Steam):
  https://steamcommunity.com/app/2198510/discussions/0/4133808904484142959/?l=italian
- Hearts of Iron IV supply guide (hubs, railways, motorization):
  https://gamerempire.net/hearts-of-iron-4-supply-guide/
- HOI4 dev diary — supply system overhaul with trains (PCGamesN):
  https://www.pcgamesn.com/hearts-of-iron-iv/supply-trains
- HOI4 — hub-to-province distribution changes (AltChar):
  https://www.altchar.com/game-news/hearts-of-iron-iv-changes-the-hub-to-province-supply-distribution-assRE3A00KXi
- HOI4 — supply vehicles and Mulberry Harbors (AltChar):
  https://www.altchar.com/game-news/hearts-of-iron-4-introduces-supply-vehicles-and-mulberry-harbors-akBqY4E66SsR
- Company of Heroes 2 veterancy guide (per-unit bonuses, COH2.ORG):
  https://www.coh2.org/guides/29892/the-company-of-heroes-2-veterancy-guide
- Company of Heroes veterancy mechanics Q&A (GameFAQs):
  https://gamefaqs.gamespot.com/pc/300298-company-of-heroes/answers/122712-veterancy-points
- Command & Conquer Wiki — Veterancy (tiers, XP math, academies):
  https://cnc.fandom.com/wiki/Veterancy
- Stormgate Wiki — Veterancy (XP sharing, Promote ability):
  https://liquipedia.net/stormgate/Veterancy
- Warzone 2100 — ERA ONE discussion on persistent campaign veterancy (Steam):
  https://steamcommunity.com/app/2509200/discussions/0/592898719119076578
- Warzone 2100 review — rank persistence across campaign:
  http://www.sonic.net/mnitepub/pccafe/reviews/warzone2100/warzone2100.html
- Dwarf Fortress beginner's guide — legendary skills, quality (PC Gamer):
  https://www.pcgamer.com/dwarf-fortress-beginners-guide/
- Dwarf Fortress Wiki — Skill mechanics:
  https://github.com/magnus-isu/df-wiki/blob/HEAD/display/Main/Skill.md
- Dwarf Fortress — legendary worker discussion (Steam):
  https://steamcommunity.com/app/975370/discussions/0/3727323721762375239/
- Anno 1800 Wiki — Assembly Line items (specialist/productivity tradeoffs):
  https://anno1800.fandom.com/wiki/Assembly_Line
- Sid Meier design principle / interesting-decisions analysis:
  https://github.com/tedneward/research/blob/HEAD/content/gamedev/challenges-for-game-developers.md

*All URLs accessed 2026-09-30. Titles appear here as formal citations; the standing
no-commercial-titles rule continues to apply everywhere else.*
