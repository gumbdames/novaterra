# How to Play — novaterra

> The 0.1 Alpha guide. Kept **clear, short and simple** per the
> design brief. Last updated: 2026-09-30 (Workstream X: living menu demo).

## Your goal

**Missions** (recommended): play "The First Term", 8 story missions —
briefings, objectives, and two endings. Every mission has a peaceful
path (🕊).

**Skirmish**: build a city, grow an economy, raise an army, and destroy
the enemy base across the map. You start with 2 engineers and 4 soldiers.
Destroy every enemy unit and building to win.

**Sandbox**: start a skirmish with no AI rival to build freely with no
victory condition — just you, your cities, and the map.

## Starting a game

> The world behind this menu is alive: a scripted demo city builds
> itself there using the same rules you play by — zones, roads, power
> and water, an army, the four ages, and a storm strike at the end.
> It replays the same movie every time, and starting any game discards
> it completely.

**Missions** → pick an unlocked mission → read the **briefing** (it
lists every way to win — 🕊 is the peaceful one) → **Start Mission**.
The objective tracker (top-left) shows your progress. Win or lose,
the debrief explains what happened.

**Skirmish** → pick a **map** (8 to choose from, 5% to 60% water —
more water means more naval fighting) → pick your **rival**:

- **Cadet** — easy, learns with you.
- **Citizen** — a fair fight.
- **Commander** — hard, no mercy.
- **General** — very hard, uses land, air, and sea.
- **Marshal** — the ultimate fair challenge.

Tick **Peaceful mode** before picking your rival for a no-military
game: no armies for either side, no spies or sabotage, no superweapons
— the Military tab disappears and every military unit, building, and
upgrade is locked. See **Peaceful mode** below for how you win.

## Peaceful mode

Prefer building to fighting? A peaceful skirmish is pure city-building:
the Military tab is gone, military training/building/research buttons
are locked ("Not available in peaceful mode"), and spies, sabotage,
tech theft, and superweapons are all disabled. Everything civilian is
open — housing, economy, utilities, power and water, transport,
airlines, research, and city life.

Your rival still plays, peacefully: the Classic AI builds its own city
but no army. There is no conquest — instead it is a **race**. The
first side to reach **8,000 housed residents** with a non-negative
treasury wins. Reach it first for the victory screen; if the rival's
city gets there before yours, the game ends in defeat. The
**Management** tab's objectives section shows the race live: your
population against the target, your treasury status, and the rival's
progress.

## Mouse

- **Left-click** — select a unit or building.
- **Left-drag** — pan the map: grab and drag it (only when no build tool
  is armed — with a tool armed, dragging belongs to the tool).
- **Middle-drag** — orbit the camera: drag sideways to turn, up/down to tilt.
- **Screen edges** — rest the pointer at any screen edge to pan that way.
- **Shift + left-click** — add/remove one unit.
- **Right-click ground** — move your selected units there.
- **Right-click enemy** — attack it (only if your units can hit it).
- **Mouse wheel** — zoom in/out.
- **Q / E** — turn the camera.

## Keyboard

- **WASD / arrows** — move the camera.
- **S** — stop your selected units.
- **Space** — pause / unpause.
- **Esc** — cancel what you're doing, or close a menu.

(Change game speed with the 1× / 2× / 4× buttons at the top of the screen.)

## Training and building

The bottom-left panel has two tabs: **Train** (units) and **Build**
(buildings and zones). Train is split into **Infantry, Armor, Air,
Navy**; Build into **Housing, Civic, Commerce, Industry, Utilities,
Power, Water, Naval & Air, Special**.

Every unit button shows its cost in **funds + materials + manpower**;
every building shows **funds + materials**. Items you can't use yet
stay visible but greyed out — hover one to see why: a later age, a
missing production building, not enough resources, or not enough
manpower.

Units need a production building: **Barracks** (infantry), **War
Factory** (vehicles), **Airfield** (aircraft), **Shipyard** (ships),
**Naval Yard** (warships — coastal construction: at least one footprint
cell must touch water). Pick a unit, then click open ground (or water
for ships) to train it.

**Research:** build a **Research Lab** (Commerce tab), then select it
to open the research panel — 19 upgrades in **Military**, **Economy**,
**Infrastructure**, and **Logistics** groups, each with its cost and
effect shown. Research one at a time; researched upgrades are marked ✓.

## Power and water

Buildings need **power** and **water** to run at full strength. Build
generators on the **Power** tab (coal, gas, wind, hydro, geothermal,
fusion — each age unlocks stronger plants, researched in the
Infrastructure group) and water sources on the **Water** tab (wells,
towers, treatment plants, reservoirs). **Power lines** and **water
pipes** (the tools row, drag to paint) connect distant buildings to a
plant — without a connection, a building shows **Disconnected**; when a
plant can't meet demand it shows **Shortage**. Select any building to
see its Power/Water status, or hit the **Utilities** button in the top
bar for the full overlay: green = powered areas, blue = watered areas,
and marker flags over buildings in trouble. Water pipes run just under
the surface and are easy to lose — hit the **X-ray** button in the top
bar to ghost the terrain and see them as bright blue lines (it also
switches on automatically while you paint with the water-pipe tool).
The **Grid** button (or the **G** key) lays a subtle survey grid over
the terrain for judging distances while you plan.

## Money and ages

## Fuel and ammo (logistics)

Fossil-fuel vehicles burn **fuel** and missile units spend **ammo** —
watch the fuel/ammo bars on selected units. When a unit drops below 30%
it gets a **low-supply warning**, and the **Logistics** button in the top
bar shows amber rings under every thirsty unit plus olive discs for
reload-point coverage (army bases, ammo factories, depots).

Keep the chain running from the **Logistics** build tab: **Oil Well** /
**Offshore Oil Rig** pump crude, **Munitions Factory** and **Missile
Plant** make ammo, and **Ordnance Depot** / **Fuel Depot** / **Missile
Silo** stockpile it near the front. **Supply Trucks** (armor tab) haul
fuel + ammo to the field; **Fuel Trucks** haul fuel only. Select a truck
to set its field services (**Repair / Rearm / Refuel** toggles), and hit
**Resupply** on any low unit to send it to the nearest depot with stock.
The **Advanced Logistics** upgrade (Infrastructure group) expands depot
storage and ammo production ×1.5.

Watch the top bar: Funds, Materials, Food, Fuel, Goods, Influence,
Manpower, Population, and your age. Your advisor (left side) warns you
before things go wrong — listen to it.

Advance through five ages — **Foundation → Connectivity → Industry →
Information → Ascendance** — each with a permanent National Program
choice. Later ages cost Influence, so build Media Centers early. Ships
unlock at Industry; the strongest programs are in Ascendance.

## Hangars and carriers

Aircraft don't have to stay airborne. Select a flying aircraft and
press **Park** to store it in the nearest airfield hangar with a free
slot of its size (small/medium/large hangars live on the **Airports**
build tab; old airfields have 6 all-purpose slots). Parked aircraft
are invisible to the enemy, safe from attack, and burn no fuel —
select the airfield to see who is parked and **Launch** them back
into the sky.

**Carriers** train **empty**. Only carrier-capable aircraft (Naval
Fighter, Trainer, Armed UAV, Recon UAV) can **Embark** on a nearby
friendly carrier: select one, press **Embark**, and it parks on the
deck. The selection panel shows the carrier's wing (**Wing 3/8**) —
each embarked aircraft has its own **Launch** button. If the carrier
sinks, its wing goes down with it, so screen your carriers.

The **Tanker** (air tab) keeps your air force flying: it loads fuel
at depots and automatically refuels the thirstiest friendly
aircraft around it — bombers stay on station, fighters never flame
out over the ocean. Nuclear units (nuclear submarines, carriers)
never need fuel.

## Airports and airlines

Paint **airport zones** with the Airports zone tool, then open the
**Airports** build tab: Civil Airport, Military Airbase, Mixed
Airport, terminals, tower, hangars, and three runway sizes (S serves
light aircraft, M adds medium, L serves everything). Airports never
auto-build — every airport building is placed by you.

To run an **airline**: open the **Airlines** panel in the Civilian
tab, press **New route…**, and click two of your completed civil or
mixed airports. Each route costs 500 funds and pays you every
second — more for longer routes, more again for every completed
passenger/cargo terminal you own. The **Airports** button in the top
bar toggles the overlay: rings around your airports (blue civilian,
red military, violet mixed) and gold arcs for your routes. Airliners
start flying between your airports once your first civil airport is
done — decorative, but they make the city feel alive.

## Intel and spies

Open the **Management** tab and look for the **Intelligence** panel.
Three **asset counters** live in the top bar next to your resources:
**Surveillance** (watching the enemy), **Operational** (doing things
to the enemy), and **Counter-intel** (stopping enemy spies). They
grow over time from intel buildings — the **Intelligence HQ**,
**Listening Post**, **Signals Station**, and **Satellite Uplink** on
the build menu's intel tab. Counter-intel also raises your spies'
chances and makes sabotage against you less likely to land.

Train a **spy** at the Intelligence HQ (400 funds · 40 materials).
Move it next to a rival building, then come back to the
Intelligence panel to pick a covert action:

- **Infiltrate** — sneaks the spy inside the building (20 seconds).
  Failure burns the spy (exposed to everyone for 30 seconds);
  success leaves it **embedded**, ready to steal.
- **Sabotage · 25** — costs 25 operational assets and knocks the
  building offline for a while. Counter-intel and listening posts
  make failures likelier, so pick soft targets first.
- **Steal tech · 15** — only for an embedded spy; costs 15
  surveillance assets. The panel previews what the spy would grab
  (the lowest research you haven't finished yet). Success grants 40
  research; failure burns the spy.

**Warnings** at the top of the panel tell you what is going wrong
and what happens next: a burned spy (exposed — visible to all
enemies, 30 seconds left), a spy inside rival detection coverage
(counter-intel buildings see a radius around them — move it), or one of
your buildings sabotaged (offline with a countdown until it comes
back). Mixed rival airports **read as civilian until discovered** —
the panel marks them UNVERIFIED so you never mistake one for a
harmless neighbor.

## Tips

- Your first buildings should be farms (food) and a power plant.
- Scouts (drones) are cheap — send one across the map early.
- Only AA guns, fighters, drones, and destroyers can hit air units.
- Tanks beat infantry; artillery beats tanks; spectres are fast
  tank-hunters. Build counters, not just more of the same.
- On water maps, control the sea first — ships can't be touched by
  land armies.
- Ports must touch the coastline. A Commercial Port earns funds and
  trains shipyard ships; a Naval Base trains warships like a naval
  yard. Two or more trade ports bring decorative container ships to
  your sea lanes.
- Minelayers don't fight — they lay naval mines (50 Funds + 10
  Materials each) that detonate under enemy ships. Your own fleet
  sails over them safely.
- Big armies need manpower, which grows with population. Grow your
  city to grow your army.

## Sound

Music changes when your units enter combat. Open **Settings** (pause
menu) to adjust master, music, and sound-effect volumes, or mute all.
Music: "Meditation Impromptu 01" and "Volatile Reaction" by Kevin
MacLeod (incompetech.com), CC BY 4.0.

## Muse

Muse is your AI advisor — it comments on events, warns about threats,
and (if you're into that) taunts you lightly. Set its **Chattiness** in
Settings: **Off** (silent), **Quiet** (milestones only), **Normal**
(events and updates), or **Chatty** (taunts and commentary).

## Saving and loading

- The game **autosaves every 5 minutes** of game time.
- **Pause menu → Save game** — save to Slot 1, 2, or 3.
- **Main menu → Load game** — resume any save.
- Saves from an older version of the game can't be loaded — the game
  will tell you plainly instead of failing silently.
- Leaving via **Exit to menu** asks first: save and exit, or exit
  without saving.
- If your browser blocks storage (private mode), saves won't survive
  closing the tab — the game will tell you.

## Cheat console

Press **\`** (backtick) to open the cheat console. Commands:

- `prosperity now` — grants funds, materials, food, fuel, and goods.
- `fast build` — finishes all your buildings under construction.
- `reveal` — no fog of war in 0.1 Alpha; nothing to reveal.
- `win` / `lose` — show the victory / defeat screen (for testing).
- `help` — lists the commands.

Using any cheat marks the save as **cheated** (shown in the load list).

## Roads, rail, and transit (Phase 4)

**Road classes.** Pick the **Road** tool, then pick a class above it —
**Dirt**, **Country**, **Paved** (default), or **Highway**. Each button
shows its per-cell price; the game remembers your class when you switch
tabs. Drag to paint (click paints one cell). Dragging over an existing
lower-class road upgrades it in place for the price difference; roads
already at your class are left alone. Faster classes move units faster.

**Rail.** The **Rail** tool (Civilian tab, Networks group) works like
the road tool: click for one cell of track, drag for a line. Track is
standard gauge in 0.1 Alpha.

**Transit stops.** Bus stops, taxi stands, tram stops, and ferry piers
sit in the Civilian build tabs. Two completed, operational stops of the
same mode start a route — buses, trams, and ferries then run it on
their own, pausing at each stop. No routes to draw, no schedules to
set, nothing to manage.

## Phase 3 controls

The bottom-left menu has three tabs:

- **Civilian** — road / rail / power-line / water-pipe / zoning /
  demolish tools plus the Housing, Civic, Commerce, Industry,
  Utilities, Power and Water build tabs (all peaceful city building
  lives here).
- **Military** — unit **orders** (right-click to attack/move, **S** to
  stop), the **train** palette, the Logistics / Naval-Air / Special
  build tabs, and the **superweapons**: fire **Aegis**, enter **Storm
  targeting** (then click the map).
- **Management** — set **tax rates** per zone (0–50%; disabled while a
  mayor holds office — the mayor resets them each month), set the
  **city focus** (specialization), appoint/dismiss your **Mayor** (tax
  policy + housing/industry/balanced auto-construction) and **General**
  (select units first, then pick a stance), and **research** upgrades
  once you own a completed lab.

Trade routes: the sim commands exist but 0.1 Alpha has no menu surface
for them yet — routes cannot be established from the menu in this
version.

## Keyboard shortcuts

- **Space** — pause / resume.
- **1 / 2 / 4** — game speed (1× / 2× / 4×).
- **Esc** — cancel placement / close panels.
- **\`** (backtick) — cheat console.
- **Arrow keys / WASD** — pan the camera.
- **Mouse wheel** — zoom.
- **Left-click** — select units / place buildings.
- **Right-click** — move (open ground) or attack (enemy unit).

## Accessibility

**Settings** (pause menu) → **Accessibility**:

- **Colorblind-friendly team colors** — switches rival units from
  red to orange (blue vs orange is safe for red-green colorblindness).
- **UI scale** — enlarges all HUD text and buttons (80%–150%).

Both settings are saved and apply immediately. Touch/mobile is not
supported in 0.1 Alpha — desktop keyboard + mouse is required.
