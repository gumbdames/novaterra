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
Keep headroom as you grow. Buried pipes are easy to lose on the normal
map — the **X-ray** view (top bar) ghosts the terrain so pipes show as
bright blue lines, and it switches on by itself while you paint pipes.
The **Grid** view (top bar, or the **G** key) drapes a subtle survey grid
over the terrain for planning distances.

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
  college, university, museum, or theater: +5 per type, up to +20
  total. A **Botanical Garden** adds +6 within 16 cells; a **Sports
  Stadium** +7 within 17 — the biggest civic draw in the game. Civic
  parking counts too, as a convenience: a **Parking Lot** adds +3
  within 8 cells, a **Parking Garage** +4 within 10 — toward the same
  +20 cap. A **Fire Station** is the same kind of reassurance: +3
  within 10 cells. Parking and fire stations are convenient, not
  beloved: they score below the cultural buildings. A **Marina** on
  the coast is the biggest draw of all: +10 within 15 cells, toward
  the same +20 cap.

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

Your city is alive — and you don't have to manage any of it. Four
things happen automatically, purely as decoration:

- **Auto-paved zones.** Painted residential, commercial, and
  industrial zones get a concrete sidewalk wash under the zone tint,
  so built-up areas read as city ground. No tool, no toggle, no cost.
- **Pedestrians and cars.** Completed homes fill the streets with
  walkers and drivers — more people means a busier city (roughly one
  walker per 4 residents, one car per 20, up to 500 walkers and 150
  cars). Walkers are real 3D people (four civilian variants: man, two
  women, worker — they stream in once their models load, until then a
  simple figure stands in); they stroll between home, shops, and
  workplaces; cars drive the roads. They are pure decoration: they
  can't be selected, they don't affect the simulation, and pausing
  pauses them.
- **Living nature.** Trees sway in the wind, water shimmers and
  breathes as it flows, and flocks of birds (ten kinds — swifts,
  gulls, crows, hawks, herons, and more) cross the sky every so often
  on their own curved paths. All decorative, all automatic, all
  frozen while the game is paused — just like the pedestrians.
- **Civic parking.** The **Civic** tab also holds the **Parking Lot**
  (180 Funds, 60 Materials) and **Parking Garage** (450 Funds, 180
  Materials): 3×3 buildings that add a little desirability nearby
  (see above). **Public transit** works the same hands-off way: place
  bus stops, tram stops, and ferry piers (Civilian tab) and completed,
  operational stops start running amber buses, red trams, and white
  ferries through the streets and water — more of them as your
  population grows. No routes to draw, no schedules to set: two stops
  make a route, and the vehicles loop it. Airliners stay decorative
  for now.

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

## City ordinances

The Management tab's **City ordinances** section holds five city-wide
policies. Each one is a single toggle for your whole city — no
per-building micromanagement — and each one costs real upkeep every
second it runs. The treasury funds buildings first; whatever is left
funds your ordinances, in a fixed order. An ordinance the treasury
cannot afford is charged nothing and does nothing — the panel warns
you ("On, but unfunded — effects off"). Turning one on needs a
60-second upkeep cushion in the treasury; turning one off is always
free.

- **Green Initiative** (0.6/s): parks and botanical gardens are worth
  +2 more desirability, and pollution hurts 20% less.
- **Transit Subsidy** (0.5/s): transit stops are worth +2 more
  desirability, riders bring in 25% more fare income, and 15% more
  migrants arrive.
- **Business Incentives** (0.8/s): commercial buildings earn +15%
  funds.
- **Nightlife Ordinance** (0.3/s): commercial buildings earn +10%
  funds — but homes within 8 cells of them lose up to −3 desirability.
  The city that never sleeps is loud.
- **Education Grants** (0.4/s): the school growth bonus doubles
  (+0.10 per kindergarten/school, up to +0.50), and education
  buildings (including the Museum) research 25% faster.

Business Incentives and the Nightlife Ordinance stack: run both for
+26.5% commercial income at a combined 1.1/s — if your residential
zones can take the noise.

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
- **Strategic Bomber** — long-range level bomber; flattens
  buildings and armies from high altitude, slow to turn (needs an
  airfield).
- **Maritime Patrol** — long-endurance patrol aircraft; hunts
  submarines over open water (needs an airfield).
- **Recon UAV** — tiny unarmed spotter; even cheaper than a drone,
  sees almost as far (carrier-capable).
- **Armed UAV** — small hunter-killer drone with a light missile
  rack; cheap precision strikes (carrier-capable).
- **Recon Plane** — fast manned spotter with long legs (needs an
  airfield).
- **Gunship** — heavy helicopter gun platform; melts armor, terrified
  of AA (needs an airfield).
- **Tanker** — flying fuel depot; refuels friendly aircraft in flight
  so they never have to turn back (needs an airfield).
- **Military Cargo** — heavy airlifter; hauls the biggest loads
  across the map (needs an airfield).
- **Trainer** — light training jet; cheap flight hours, and it can
  embark on a carrier (carrier-capable).
- **Naval Fighter** — carrier-capable multirole jet; the fleet's
  fighter arm (needs an airfield).
- **Airliner** — civilian passenger jet; keep it away from wars
  (needs an airfield).
- **Jumbo Airliner** — the biggest civilian passenger jet (needs an
  airfield).
- **Regional Jet** — smaller civilian airliner for short hops
  (needs an airfield).
- **Cargo Plane** — civilian freighter (needs an airfield).
- **Passenger Heli** — civilian helicopter shuttle (needs an
  airfield).
- **Seaplane** — civilian floatplane; lands on water (needs an
  airfield).

Aircraft burn fuel while they fly — a fighter gets about a minute
and a half of flight before it must refuel — and most carry a
limited ammo load, so they must rearm and refuel at a friendly
airfield. Nuclear-powered submarines and carriers never burn fuel.

## Hangars and carriers

Aircraft don't have to stay airborne. Build **hangars** at your
airfields (the **Airports** build tab: hangars come in Light, Medium
and Heavy sizes for different aircraft) and select a flying
aircraft to **park it in a hangar** — parked aircraft are invisible
to the enemy, safe from attack, and burn no fuel. Select it again
(or open the airfield) to **launch** it back into the sky.

**Carriers** are floating airfields, and they train **empty** —
every aircraft on a carrier's deck got there the hard way. Only
**carrier-capable** aircraft — the Naval Fighter, Trainer, Armed
UAV and Recon UAV — can **embark** on a carrier: select the
aircraft, press **Embark** near a friendly carrier, and it parks on
the deck. Embarked aircraft move with the ship and are safe from
attack — but if the carrier sinks, its whole wing goes down with it.

- **Embark** — park a carrier-capable aircraft on a nearby carrier.
- **Park** — store an aircraft in a ground hangar.
- **Launch** — return a parked or embarked aircraft to the sky.

The **Tanker** keeps your air force flying: it carries fuel in its
holds and automatically refuels the thirstiest friendly aircraft
around it, so bombers can stay on station and fighters never flame
out over the ocean. Tankers refuel from depots between missions.

## Airports and airlines

**Airport zones** are the fourth zone type, painted like the others
with the Airports zone tool (the tax panel has a fourth rate for
them — airport buildings pay it). Airports are player-placed only:
the city never auto-builds on airport zoning. The **Airports** build
tab holds the full roster:

- **Civil Airport** — civilian airline hub (landing-fee income).
- **Military Airbase** — trains military aircraft exactly like an
  airfield.
- **Mixed Airport** — both: civilian airline hub *and* trains like an
  airfield. To everyone else it reads as a civilian airport — the
  military side only shows to you.
- **Passenger / Cargo Terminals** — boost every airline route you run
  (+funds per second each); the cargo terminal pays a little more.
- **Control Tower, Fuel Farm, Maintenance Hangar** — airport
  build-out (the tower also props up the three anchors' models).
- **Hangars S / M / L** — park Light, Medium, Heavy aircraft (the
  hangar system from above).
- **Runways S / M / L** — short strips serve light aircraft, medium
  strips add medium, long strips serve everything.

**Airlines** turn airports into income. Open the **Airlines** panel
(Civilian tab), press **New route…**, and click two of your
completed civil or mixed airports: the route costs 500 funds to
establish and pays every second — a base rate, plus a distance
bonus, plus your completed passenger/cargo terminal bonuses. Demolish
an endpoint and the route closes. Flip the **Airports** toggle in
the top bar to see airport sites ringed by type (blue civilian, red
military, violet mixed) with your airline routes arcing gold between
them — and once your first civil airport completes, decorative
airliners start flying circuits between your airports.

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
  naval yard). Carriers train **empty** — only carrier-capable
  aircraft can embark on them (see Hangars and carriers above).
- **Command Ship** — makes every nearby warship fight better (needs a
  naval yard).
- **Transport Ship** — unarmed, carries your plans across the water.
- **Fishing Boat** — harvests food from the sea; a water economy.

**The expanded navy.** Beyond the classic fleet, the naval yard
(Industry age and later) unlocks a full order of battle:

- **Coastal Sub** — a cheaper, shorter-ranged boat for defending
  home waters.
- **Missile Sub** — a nuclear boat: it **never burns fuel and never
  refuels**, and its long-range missiles reach 40 cells. The fleet's
  ultimate deterrent (Information age).
- **Corvette** — a fast, cheap escort that screens against light ships
  and aircraft (Connectivity age, from a shipyard).
- **Heavy Destroyer** — a tougher, longer-ranged destroyer.
- **Cruiser** — a heavy gun platform with strong anti-air cover.
- **Battleship** — the heaviest surface guns afloat: 800 hull points
  and 110-damage salvos (Information age).

And a support fleet that keeps the war machine — and the economy —
moving:

- **Cargo Freighter** — earns funds on the sea lanes (civilian sea
  income); trains without a production building.
- **Fuel Tanker** — a floating fuel depot for the Phase 3 naval
  logistics chain.
- **Ammo Ship** — a floating munitions store (needs a shipyard).
- **Repair Ship** — heals friendly **sea** units in a 15-cell radius
  (the combat medic still owns land).
- **Minelayer** — lays **Naval Mines** (see below).

Plus a civilian side: the **Coast Guard Cutter** (fast patrol),
the **Cruise Liner** (prestige on the waves), and the **Yacht**
(cheap and quick). Civilian ships need no production building — once
you reach their age, train them straight from the Navy tab.

**Naval mines.** Mines are never trained: the Navy tab shows the mine
greyed out with *"Deployed by a Minelayer"*. Order a minelayer's
**Deploy Mine** action and it lays a mine at its position for 50 Funds
+ 10 Materials. The mine sits on the seabed and detonates when an
**enemy** sea unit closes within 8 cells — 150 damage, worse against
light hulls, blunted by heavy armor. Friendly ships sail over your own
mines unharmed. Mines earn no academy XP: they are expendable
ordnance, not sailors.

## Ports

**Ports go on the coast.** All four ports must be built on land that
touches the water — the game rejects inland placement outright. Each
port earns its keep, and each unlocks part of the navy:

- **Commercial Port** (Connectivity, 4×3) — harvests **+1.5
  Funds/sec**, upkeep 0.8/sec. Counts as a **shipyard** for training:
  build one and you can train shipyard ships without a shipyard.
- **Container Port** (Industry, 5×4) — harvests **+2.5 Funds/sec**,
  upkeep 1.5/sec. The big trade hub.
- **Fishing Harbor** (Foundation, 3×2) — harvests **+1.2 Food/sec**,
  upkeep 0.35/sec. A water economy from the very first age.
- **Naval Base** (Industry, 5×4) — no harvest, upkeep 2.0/sec. Counts
  as a **naval yard** for training: your warship program without the
  full naval yard.

Build **two or more** commercial/container ports and the sea lanes
come alive: decorative container ships start sailing between your
ports — pausing 90 ticks at each to "load cargo" — purely for show.
More residents means more ships (one per 800, up to 10). They are
render-only: they never fight, never carry cargo, and never touch the
simulation.

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
- **Signals Intelligence** — surveillance income ×1.5; all units +4
  sight.
- **Counter-Intelligence** — counter-intel income ×1.25; +25
  detection radius; sabotage against you lasts half as long.
- **Precision Manufacturing** — factories produce +25%.
- **Smart Grid** — power plants, solar farms and nuclear plants
  supply more power.
- **Vertical Farming** — farms grow +50% more food on less water.
- **Free Trade Policy** — markets, shops and trade routes earn more.

Each upgrade has prerequisites — buildings, ages, sometimes another
upgrade — shown in the research panel with the reason when locked.

## Intel and spies

Knowledge is a resource. The **Intel** tab in the build menu holds
four buildings that quietly generate intel assets over time:

- **Listening Post** (Connectivity age) — 500 funds. Generates
  surveillance and watches a 60-unit radius for hidden units.
- **Signals Station** (Information age) — 900 funds. Generates
  counter-intel (your defense) and detects spies in a 45-unit radius.
- **Intelligence Headquarters** (Information age) — 1400 funds.
  Generates surveillance *and* operational assets, and it is the only
  building that can train **spies**.
- **Satellite Uplink** (Ascendance age) — 2500 funds. The late-game
  eye: heavy surveillance income plus +12 sight for all your units.

The three assets do different jobs: **surveillance** is your passive
picture of the battlefield, **operational** funds spy missions, and
**counter-intel** protects you — your detection posts see further
and sabotage against your buildings ends sooner.

Your **Spy** (400 funds + 40 materials, Information age, from the
Intelligence Headquarters) is the only unit built to go unseen: it
stays hidden from the enemy unless it walks inside one of their
detection radii. Your **Recon Team** (150 + 15, Connectivity age,
from the Barracks) is the honest alternative — great eyes (44 sight),
but the enemy can see it too.

Two lab upgrades sharpen the whole system: **Signals Intelligence**
(surveillance income ×1.5, all units +4 sight) and
**Counter-Intelligence** (counter-intel income ×1.25, +25 detection
radius, sabotage lasts half as long).

Spy missions spend the assets above: a spy standing next to an enemy
building can **infiltrate** it (20 seconds, interrupted if the spy
moves away), then **sabotage** it (25 operational assets — the target
goes dark for 45 seconds, 22.5 if the victim researched
Counter-intelligence) or **steal a technology** (15 surveillance
assets, +40 research on success). Getting caught burns the spy: it
becomes visible to everyone for 30 seconds. Keep your spies inside
your own detection coverage and research Counter-intelligence to
catch theirs. Stockpiling counter-intel assets also pays off
passively: a deep stockpile makes enemy sabotage more likely to burn
the spy and enemy tech-steals more likely to fail.

Your detection buildings are also your eyes on the battlefield: a
working Listening Post or Signals Station reports every enemy unit
inside its radius — even spies — and the **Radar Station** (90-unit
radar sweep) reports every enemy except spies, which only SIGINT can
catch. Fly a **Recon UAV** or **Recon Plane** over enemy territory for
long-range eyes, or march the Recon Team there. What your buildings
and recon see, your side knows — but combat still needs a unit that
can reach the target: a radar contact doesn't aim your guns by itself.

Not every airport is what it claims to be. A **mixed-use airport**
looks exactly like a civilian one until you discover it: park a spy
inside it, cover it with your detection net, or fly recon over it,
and your analysts flag it — "suspicious military activity." You get
60 seconds of warning while they confirm the site; when they do, the
airport reads as mixed-use on your map and may be treated as a
military target. No ambushes: the warning always comes first.

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
  your artillery, frigates vs your submarines), a forward base, and the
  intel game: listening posts, an intel HQ, and a spy that infiltrates
  your best buildings to steal tech or sabotage production.
- **General** — combined arms. Everything the Commander does, faster and
  bigger, plus a working navy (fishing boats, patrol boats) on maps with
  usable water, and two spies working your territory.
- **Marshal** — all-out war. The largest armies, age advancement, the full
  navy, fair superweapon use, and the full intel apparatus: signals
  stations, satellite uplinks, three spies, and counter-intel surges when
  it catches your spies.

The AI never cheats: it sees only what its own units see, finds water by
scouting (never maphack), pays full price for everything it builds —
including its production buildings — and gives the same orders a human
player would. Destroy every enemy unit and building to win the
**conquest victory** screen — but if you lose all of your own units and
buildings first, the **defeat** screen ends your run. (If both sides fall
on the same tick, defeat takes precedence: you must survive your victory
to claim it.)

## Peaceful mode

Prefer building to fighting? A **peaceful** skirmish disables war
entirely: every military unit, building, and upgrade — plus spies,
sabotage, and the superweapons — is locked out (orders for them are
rejected with a clear message, never silently), while the full civilian
roster stays open: housing, the economy, utilities, power and water,
transport, civilian airlines and shipping, research, and city life.

Your rival still plays — peacefully. The Classic AI builds its own city
beside yours but fields no army and launches no attacks; there is no way
for either side to conquer the other, so the conquest and defeat screens
never appear. Instead it is a **race**: the first side to reach **8,000
housed residents** with a non-negative treasury wins. Reach it first and
you claim the peaceful victory; if your rival's city gets there before
yours, the game ends in defeat — watch the Management tab's objectives
section to see how the race is going. Grow a genuinely great city —
roughly 270 apartment blocks' worth of people on under 4% of the map —
and the win is yours.

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

**Live Muse (hopefully coming):** an optional live-language-model link
for strategic advice from a live summary of your game — marked
"hopefully coming" in Settings, NOT wired yet in 0.1 Alpha. When it
ships it will be advisory only: it can never take over your game.
There is no API-key flow in the game (removed entirely per the
2026-09-29 directive), no endpoint, no networking, and no third-party
AI API surface — the offline Muse covers you meanwhile.

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

## Phase 4: Transport

**Road classes.** Roads come in four classes — **Dirt** (cheapest),
**Country**, **Paved** (the default), and **Highway** (fastest, most
expensive). Pick the class in the road tool's picker before you drag;
the picker shows the per-cell price and remembers your choice across
tabs. Dragging over an existing lower-class road **upgrades it in
place** (you pay only the difference), and dragging over a road already
at or above your class leaves it alone — a drag never fails because it
crossed an old road. Faster roads move your units faster; the
pathfinder prefers them on its own.

**Rail.** The **Rail** tool (Civilian tab, Networks group) drag-paints
standard track the same way you drag roads — click for one cell, drag
for a line. Track cells carry passengers and freight for the trains of
later expansions; laying the network early is the investment.

**Transit stops.** Place **bus stops**, **taxi stands**, **tram
stops**, and **ferry piers** (Civilian tab) wherever people live and
work. Two completed, operational stops of a mode start a route, and
ambient buses, trams, and ferries begin running it — pausing at each
stop, looping forever, purely decorative. Bigger stations (the
neighborhood station, the central station, the airport interchange)
also raise nearby land value, like parks and schools do.

**Marinas.** The **Marina** (300 Funds, 100 Materials) and **Grand
Marina** (900/350) go on the coast and make the whole neighborhood
more desirable (+10 desirability within 15 cells), which pushes nearby
land value — and your tax income — up.

**Occupancy.** Select any building and the panel now shows who lives
and works there: "Residents 12/50 · Workers 8/20" (hidden for buildings
with no housing or jobs). Watch your houses fill as people migrate
toward the nice streets.
