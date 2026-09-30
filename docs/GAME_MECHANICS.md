# Game Mechanics — novaterra

> Player-facing mechanics reference. Written alongside implementation in
> Phase 1 — kept **clear, short and simple** per the design brief.
> Last updated: 2026-09-29 (Phase 3: delegation, superweapons, advanced economy, accessibility).

## Building your city

- **Roads** are optional — paved at 5 Funds + 2 Materials per tile for
  looks and future traffic systems. Buildings place, grow, and run
  with or without them.
- **Zones** decide what goes where. Paint residential, commercial, or
  industrial zones (1 Fund per tile), then place matching buildings on
  them. Power plants and water pumps fit anywhere.
- **Buildings** take time to construct and cost upkeep every second.
  Demolishing is free but you get nothing back — plan before you place.
- **Production buildings** unlock your military: the **Barracks**
  trains advanced infantry, the **War Factory** builds armor, the
  **Airfield** builds aircraft, and the **Naval Yard** (must touch the
  coastline) builds warships.
- **Power**: Power Plant (burns fuel), **Solar Farm** (free sun, less
  dense), **Nuclear Plant** (huge output, late game). **Water**:
  Water Pump, **Desalination Plant** (coastal, huge output).
- **Industry chain**: **Quarry** digs raw materials → Factory refines
  them → **Oil Refinery** makes fuel → **Recycling Center** turns
  goods back into materials.
- **Services**: **Hospital** supports manpower, **Market** turns surplus
  food and goods into funds, **Radar Station** feeds your intel upgrades,
  and the **Monument** is pure prestige for the late game. Education
  buildings (below) are their own family.

## The eight resources

- **Funds** — spent on everything; earned from shops and taxes.
- **Materials** — building material; produced by factories.
- **Fuel** — burned by factories and power plants; buy it or run short.
- **Food** — grown by farms; your people eat it every second.
- **Research** — produced by labs; unlocks progress later.
- **Goods** — made by factories, bought by shops and turned into
  funds. No goods, no shop income.
- **Influence** — produced by Media Centers. Spent to advance ages;
  more influence means faster progress.
- **Manpower** — grows with your population. Training soldiers and
  ships spends it — a big army needs a big city behind it.

## Power and water

Power and water flow through **networks**, not a shared pool. A network
is a connected grid of conductors — roads, power lines, water pipes, and
the footprints of substations (power) and pumping stations (water).
Power plants and water plants feed the network they touch; buildings
draw from it if they touch it (or sit in a zoned district the network
reaches, which gets underground pipes for free).

- **Build the grid.** Lay power lines and pipes (3 funds + 1 material per
  cell, up to 512 cells per order) to reach far-flung districts. A plant
  with no connection still helps: a stranded plant shares its output
  with any unconnected building, oldest first.
- **The plant ladder.** Basic power plants (25) and pumps (25) fit
  anywhere. Research unlocks better ones: coal (30) and gas (35) with
  Combustion Tech, hydro dams (45, needs shoreline), geothermal (40),
  and fusion (120) at the top of the Nuclear chain. Wells, treatment
  works, batteries, water towers, and reservoirs round out the roster.
- **Storage.** Batteries bank surplus power; water towers and reservoirs
  bank water. Stored utilities cover shortfalls automatically.
- **Trade the surplus.** A network touching the map edge auto-sells
  spare power and water for funds. Shortages are never auto-imported —
  build more supply.
- **Keep it clean.** Coal, gas, and oil plants foul adjacent wells and
  pumps (output halved). Water treatment works scrub the fouling away.
- **Respect the atom.** Nuclear plants need water cooling and melt down
  only when attacked (a Storm Engine strike on the plant is the current
  attack path) — never at random. A meltdown takes the plant offline for
  3 minutes; the 1-in-20 risk per attack is seeded and reproducible.
  Advanced Nuclear (research) cuts the risk 4x.
- **Mind the sky.** Solar farms only produce by day (4-minute day);
  wind farms rise and fall with the wind.

If demand exceeds supply, the nearest buildings get served first. A
building without power produces at 25%; without water, another 25%.
The overlay shows each building's state: ok, shortage, or disconnected.
Keep headroom as you grow.

## Upkeep and taxes

Every building charges upkeep. If funds run dry, your newest buildings
shut down first. Taxes are your main income: set a rate per zone
(0–100%), collected every minute. Higher taxes mean more money but
slower growth — low taxes grow your city faster.

## The market

Trade materials, fuel, food, or research for funds at fixed prices.
Buying costs 20% extra, selling pays 20% less — so only trade when you
need to, not for profit. (Goods, influence, and manpower can't be traded.)

## Growth

A healthy city grows on its own: new buildings appear in zoned areas
every few seconds, as long as people are fed and you can afford them.
If food runs out, growth stops until farms catch up. Desirable blocks
fill in fastest — see Land value and desirability.

## Land value and desirability

Every residential block has a desirability score from 0 to 100 — how
nice an area is to live in. It shapes two things: where your city grows
fastest, and the tax rate each home effectively pays.

**What makes an area desirable:**
- **Elevation** — higher ground scores better, up to +10.
- **Water** — living near the shore or a lake, up to +15 (shoreline
  counts; marinas and beaches will add more when they arrive).
- **Clean air** — distance from smoke and smog (coal plants and the
  like): up to −25 right next to a polluter, fading with distance.
- **Amenities** — a nearby library, park, school, kindergarten,
  college, or university: +5 per type, up to +20 total. Civic
  parking counts too, as a convenience: a **Parking Lot** adds +3
  within 8 cells, a **Parking Garage** +4 within 10 — toward the same
  +20 cap. Parking is convenient, not beloved: it scores below the
  cultural buildings.

**Land value tiers.** The score maps to a land-value tier, and homes pay
tax on their land value: Low (×0.8), Modest (×1.0), Nice (×1.3),
Prime (×1.7). A home in a prime spot pays 70% more tax than the same
home elsewhere. Shops, factories, and civic buildings always pay the
flat rate. Select any home to see its line, e.g.
"Land: Nice (64) · tax ×1.3".

**Migration.** People move toward nicer areas, so desirable blocks fill
in faster — but prime land is pricey, which cools demand a little. The
sweet spot is nice-but-affordable: those blocks grow fastest of all.

Toggle the **Land value** button in the top bar to tint residential
blocks red (low) → green (prime).

## City life (decorative)

Your city is alive — and you don't have to manage any of it. Three
things happen automatically, purely as decoration:

- **Auto-paved zones.** Painted residential, commercial, and
  industrial zones get a concrete sidewalk wash under the zone tint,
  so built-up areas read as city ground. No tool, no toggle, no cost.
- **Pedestrians and cars.** Completed homes fill the streets with
  walkers and drivers — more people means a busier city (roughly one
  walker per 4 residents, one car per 20, up to 500 walkers and 150
  cars). Walkers stroll between home, shops, and workplaces; cars
  drive the roads. They are pure decoration: they can't be selected,
  they don't affect the simulation, and pausing pauses them.
- **Civic parking.** The **Civic** tab also holds the **Parking Lot**
  (180 Funds, 60 Materials) and **Parking Garage** (450 Funds, 180
  Materials): 3×3 buildings that add a little desirability nearby
  (see above). Ambient buses, trams, ferries, and airliners join the
  bustle in later expansions — their hooks are already in the code,
  sized by population.

## Education

Four buildings form the education ladder, all found on the **Civic**
tab of the build palette. They need no zone — place them anywhere on
land:

- **Kindergarten** (150 Funds, 50 Materials): researches 0.1 per second.
- **School** (was on the Housing tab, now Civic): researches 0.25 per
  second.
- **College** (400 Funds, 120 Materials): researches 0.5 per second.
- **University** (was on the Commerce tab, now Civic): researches 1.0
  per second.

Each finished **Kindergarten** or **School** you own also speeds up
residential growth everywhere: +0.05 growth desirability per building,
stacking up to +0.25. And every school kind (kindergarten, school,
college, university) makes nearby homes more desirable — see Land
value and desirability. (The Hospital stays on the Commerce tab and is
unchanged.)

## Ages: Foundation → Connectivity → Industry → Information → Ascendance

Your nation develops through five ages. You start in the **Foundation**
age. Each age advance costs resources and asks you to pick one
**National Program** — a permanent choice:

- **Connectivity** (3,000 Funds + 1,200 Materials):
  - **Fiber Grid** (economy): +25% income from taxes.
  - **Signals Grid** (intel): your units see 8 units farther.
  - Unlocks **fighters** (fast air units).
- **Industry** (6,000 Funds + 2,500 Materials + 100 Influence):
  - **Heavy Industry**: factories make +50% materials and goods, but
    all upkeep costs +25%.
  - **Green Tech**: buildings use 30% less power and water, and Media
    Centers make +50% influence.
  - Unlocks **ships** (see Navy below).
- **Information** (12,000 Funds + 5,000 Materials + 250 Influence):
  - **Cyber Command**: spectres deal +50% damage, military units see
    +4 farther.
  - **Global Media**: Media Centers make +100% influence.
- **Ascendance** (25,000 Funds + 10,000 Materials + 500 Influence):
  - **Arsenal Program**: military units cost 30% less manpower and
    deal +25% damage.
  - **Prosperity Program**: +50% tax income and +50% goods output.

Choose carefully: you can't switch programs later. Each age builds on
the last — a rich, well-powered city advances fastest.

## Your army

Training is organized in four tabs. Every unit is strongest against
something and weak against something else — scout first, then build
the counter. Advanced units need a production building (barracks, war
factory, airfield, naval yard) before they can be trained.

**Infantry**
- **Engineer** — builds everything. Protect yours.
- **Rifles** — cheap infantry, good against other infantry.
- **Sniper Team** — long-range precision; deletes infantry and
  raiders, dies to anything that touches it (needs a barracks).
- **Spectre** — fast stealthy raider, hunts tanks and artillery.
- **Combat Medic** — unarmed; heals nearby friendly troops over time.
  Keep it behind the line (needs a barracks).
- **Hauler** — supply truck; keeps your war machine moving.

**Armor**
- **Tank** — tough all-rounder, eats infantry for breakfast (needs a
  war factory).
- **APC** — fast armored carrier; shreds infantry, outruns everything
  on wheels (needs a war factory).
- **Tank Destroyer** — glass cannon: outranges and murders tanks, but
  infantry walk all over it (needs a war factory).
- **Artillery** — very long range, shreds tanks; helpless up close
  (needs a war factory).
- **MLRS** — rocket artillery: devastating salvos against clumps of
  enemies, long reload (needs a war factory).
- **AA** — the only ground unit that can hit aircraft (needs a war
  factory).
- **Mobile HQ** — moving command post that makes nearby units fight
  better.

The rule of thumb: **tanks beat infantry, artillery beats tanks, tank
destroyers beat tanks at range, AA beats anything that flies**.

**Air force**
- **Drone** — cheap flying scout, sees far.
- **Fighter** — fast air superiority (needs the Connectivity age).
- **Fighter-Bomber** — heavy strike aircraft; cripples armor in one
  pass, then must rearm (needs an airfield).
- **Attack Helicopter** — flying tank-hunter; evaporates under AA
  fire, so clear the skies first (needs an airfield).
- **AWACS** — unarmed radar plane with enormous sight range. Losing
  it blinds you (needs an airfield).
- **Transport** — airlifts units across the map.

## Navy

Water is not just scenery. Build a **Shipyard** (small boats) or a
**Naval Yard** (warships — must touch the coastline), reach the
Industry age, and rule the seas:

- **Patrol Boat** — fast scout, good against light ships.
- **Missile Boat** — packs a punch far above its weight; swarms kill
  destroyers (needs a naval yard).
- **Frigate** — the submarine hunter; also screens against aircraft
  (needs a naval yard).
- **Submarine** — long-range torpedoes murder capital ships; only
  frigates reliably answer it (needs a naval yard).
- **Destroyer** — heavy warship; shreds ships and aircraft alike.
- **Carrier** — the ultimate capital ship and fleet anchor (needs a
  naval yard).
- **Command Ship** — makes every nearby warship fight better (needs a
  naval yard).
- **Transport Ship** — unarmed, carries your plans across the water.
- **Fishing Boat** — harvests food from the sea; a water economy.

Ships can only be placed on water and can only fight on water — they
can't attack land targets, and tanks can't shoot back at them. On
water-heavy maps, the navy decides the game.

## Veterancy

Units that survive combat get better at it. Every kill earns the killer
experience points (XP) equal to the destroyed unit's training cost —
killing a Rifles squad (60 funds) is worth 60 XP, killing a tank
(400 funds + 60 materials) is worth 460 XP. XP thresholds promote the
unit through four ranks:

- **Recruit** (0 XP) — fresh off the line.
- **Regular** (200 XP) — +10% damage, +10% sight, reloads 10% faster.
- **Veteran** (500 XP) — +20% damage, +20% sight, reloads 20% faster,
  +15% max health.
- **Elite** (1000 XP) — +30% damage, +30% sight, reloads 30% faster,
  +30% max health, and regenerates 2 health per second.

Build a **Military Academy** (industrial zone, needs a completed
Barracks first: 600 funds + 200 materials, 30 seconds to build) and
every armed unit you train graduates as a Regular instead of a
Recruit. Unarmed units — haulers, medics, transports — don't benefit;
there's nothing to drill them in.

An Elite unit can't learn any more itself, so its kill XP spills over
to nearby friendly troops that still can: units within 40 meters split
it evenly (leftovers go to the lowest-numbered units first). With no
eligible allies nearby, the XP is simply lost. And death erases
everything — a replacement starts over as a Recruit.

Your buildings progress too, in their own way: a thriving, powered,
supplied building slowly develops from level 1 to level 3, producing
25% more per level. Crews earn their chevrons in battle; buildings earn
theirs by thriving.

## Upgrades

Build a **Research Lab** (the **University** supercharges your
research income) and spend research points on upgrades — military
might or economic boom, your choice:

- **AP Rounds** — vehicles hit heavy armor 40% harder.
- **Composite Armor** — +30% health for tanks, tank destroyers, APCs,
  artillery and MLRS.
- **Engine Tuning** — +25% speed for all ground vehicles.
- **Advanced Avionics** — +25% sight and +20% anti-air for aircraft;
  AWACS sees even further.
- **Sonar Suite** — frigates and destroyers hunt submarines better;
  all ships see further.
- **Cruise Missiles** — +range for MLRS and artillery.
- **Drone Optics** — drones and spectres see much further.
- **Field Medicine** — medics heal twice as fast; infantry tougher.
- **Precision Manufacturing** — factories produce +25%.
- **Smart Grid** — power plants, solar farms and nuclear plants
  supply more power.
- **Vertical Farming** — farms grow +50% more food on less water.
- **Free Trade Policy** — markets, shops and trade routes earn more.

Each upgrade has prerequisites — buildings, ages, sometimes another
upgrade — shown in the research panel with the reason when locked.

## Maps

Eight battlefields, from nearly all land to mostly ocean:

- **Meridian Plains** (5% water) — classic land war.
- **Riverlands** (12%), **Lake Country** (20%), **Coastline** (30%).
- **Archipelago** (40%), **Shattered Isles** (50%).
- **Inland Sea** (55%), **Ocean World** (60% water) — bring a navy.

Pick your map on the skirmish setup screen. More water means more naval
play and trickier land routes.

## The enemy

In skirmish you face the **Classic AI** at one of five levels:

- **Cadet** — learns the ropes with you. A handful of riflemen, no
  buildings, no research, no attacks.
- **Citizen** — a fair fight. Raises a barracks and war factory, fields
  rifles, tanks, artillery and AA, and builds AA when you bring air power.
- **Commander** — ruthless. A research lab, upgrade research, drone
  scouts, full counter-play (tank destroyers vs your armor, spectres vs
  your artillery, frigates vs your submarines), and a forward base.
- **General** — combined arms. Everything the Commander does, faster and
  bigger, plus a working navy (fishing boats, patrol boats) on maps with
  usable water.
- **Marshal** — all-out war. The largest armies, age advancement, the full
  navy, and fair superweapon use.

The AI never cheats: it sees only what its own units see, finds water by
scouting (never maphack), pays full price for everything it builds —
including its production buildings — and gives the same orders a human
player would. Destroy every enemy unit and building to win the
**conquest victory** screen — but if you lose all of your own units and
buildings first, the **defeat** screen ends your run. (If both sides fall
on the same tick, defeat takes precedence: you must survive your victory
to claim it.)

## The campaign: "The First Term"

From the main menu, **Missions** starts the 8-mission story campaign.
Each mission has a briefing, one or more ways to win, and scripted
events (raids, warnings, milestones). **Every mission can be completed
peacefully** — look for the 🕊 path on the briefing screen.

- Mission 1 is a tutorial with no enemy: learn to select, move, build,
  and grow.
- Later missions add food pressure, border raids, naval warfare, age
  races, two-front wars, an influence contest, and a final confrontation
  with Marshal Dain.
- Winning bloodlessly (no kills, no losses) earns **Diplomat** points;
  destroying enemies earns **Commander** points. After the final
  mission, your tally decides the ending: **The Peacemaker** or
  **The Commander** (ties go to the Peacemaker).
- Progress saves automatically between missions.

## Muse — your chief of staff

**Muse** watches your game and comments on it: buildings finished,
ages advanced, enemies spotted, battles starting. They also run the
**threat meter** (bottom-right): the enemy's share of total military
power, from safe to danger.

Muse is charming, never annoying: how often they speak is your call —
**Off / Quiet / Normal / Chatty** in Settings. Quiet means milestones
only. In campaign missions Muse also delivers the story's scripted
messages.

**Live Muse (hopefully coming):** connect your own language-model API key
in Settings and Muse will offer strategic advice from a live summary
of your game. The key stays in your browser only, and the live model
is advisory — it can never take over your game. Not wired yet in
0.1 Alpha; the offline Muse covers you meanwhile.

## Phase 3: Chain of command

**Mayors** (opt-in): appoint a mayor to automate your tax policy. Three
policies: **Balanced** (15% all zones), **Growth** (low taxes to attract
people), **Revenue** (high taxes for maximum income). Your mayor also
builds for you: pick a build focus — **Housing** (homes and apartments),
**Industry** (factories and farms), or **Balanced** (whatever the city
needs most) — and the mayor places one building every 10 seconds,
zoning new blocks when the city runs out of room. Dismiss anytime
to take back manual control. No mayor = no automation (the default).

**Generals** (opt-in): select units, then appoint a general to command
them. Three stances: **Aggressive** (hunts visible enemies),
**Defensive** (engages near your base, radius 45), **Hold** (stays put,
never chases). The general reassesses every 2 seconds using only what
your units can see — no fog cheating. Dismiss to resume direct control.

## Phase 3: Superweapons (Ascendance age)

**Aegis Control** (5,000 funds + 2,000 materials, 120s build): fire the
**Aegis** shield — blocks ALL damage to your units for 60 seconds.
10-minute cooldown. A glowing energy dome covers your city while the
shield holds. The Marshal AI builds and uses it fairly.

**Storm Array** (6,000 funds + 2,500 materials, 150s build): fire the
**Storm Engine** — 8 lightning strikes over ~8 seconds at your target
point (±3 scatter, 120 damage, radius 10). Storm clouds gather, lightning
flashes, and each strike kicks up a fireball. 10-minute cooldown. Aegis
shields block storm damage too.

## Phase 3: Advanced economy

**City specialization**: focus your city — **Industrial** (+25% factory
output, −10% other zones), **Commercial** (+25% shops), **Residential**
(+25% homes), or **Balanced** (no bonus, no penalty). Utility buildings
are unaffected.

**Trade routes**: the sim commands exist (establish for 500 funds
setup; each active route pays 3 funds/sec — but only while both you
and your partner have working commercial buildings; cancel anytime),
but 0.1 Alpha has no menu surface for them yet — routes cannot be
established from the menu in this version.

## Phase 3: Logistics (fuel and ammo)

Vehicles burn **fuel** and missile weapons spend **ammo**; infantry and
nuclear-powered ships are exempt. Keep them supplied or they fight worse
(damage ×0.6–1.0) and slower.

**Make it.** The **Oil Well** (Foundation) pumps 0.6 fuel/s; the offshore
**Oil Rig** (Industry, coastal) makes 2.5 fuel/s but eats materials. The
**Munitions Factory** (Industry) produces 2.0 ammo/s; the **Missile Plant**
(Industry, needs a finished Munitions Factory) makes 5.0 ammo/s. Both fill
their own stockpile — units can even resupply at the factory gate.

**Store it.** The **Missile Silo** holds 400 ammo, the **Ordnance Depot**
150, and the **Fuel Depot** 250 fuel. Fuel depots pull from your stockpile
automatically (5/s), caching fuel forward near the front.

**Use it.** Any unit parked within 18 world units of a stocked reload
point (barracks, war factory, naval yard, airfield, the two producers,
and the three depots) refills its magazine and tank passively — no
orders needed. Units on a resupply run are served first.

**Advanced Logistics** (research, needs a Munitions Factory): +50% ammo
production and +50% storage on every producer and depot.
