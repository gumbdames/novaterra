# How to Play — novaterra

> The 0.1 Alpha guide. Kept **clear, short and simple** per the
> design brief. Last updated: 2026-09-29 (Phase 3: delegation, superweapons, advanced economy, accessibility).

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

## Mouse

- **Left-click** — select a unit or building.
- **Drag left-click** — select many units at once.
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

## Building

Pick **Road**, a **Zone**, or a **Building** from the panel at the
bottom-left, then click (or drag) on the map to place it.

Buildings need roads and the right zone. You can also train new units
from the same panel: pick a unit type, then click open ground. **Ships**
must be placed on water — and you'll need the Industry age first.

Key buildings: **Farms** (food), **Power Plants** (power),
**Factories** (materials + goods), **Media Centers** (influence, needed
to advance ages), **Shipyards** (ships).

## Money and ages

Watch the top bar: Funds, Materials, Food, Fuel, Goods, Influence,
Manpower, Population, and your age. Your advisor (left side) warns you
before things go wrong — listen to it.

Advance through five ages — **Foundation → Connectivity → Industry →
Information → Ascendance** — each with a permanent National Program
choice. Later ages cost Influence, so build Media Centers early. Ships
unlock at Industry; the strongest programs are in Ascendance.

## Tips

- Your first buildings should be farms (food) and a power plant.
- Scouts (drones) are cheap — send one across the map early.
- Only AA guns, fighters, drones, and destroyers can hit air units.
- Tanks beat infantry; artillery beats tanks; spectres are fast
  tank-hunters. Build counters, not just more of the same.
- On water maps, control the sea first — ships can't be touched by
  land armies.
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

### Playing against Muse (your API key drives the rival)

1. Get an API key from [Anthropic](https://console.anthropic.com/)
   (usage is billed to your Anthropic account).
2. **Pause menu → Settings → Live Muse**: paste the key (it stays in
   your browser only), pick a model and how often Muse thinks
   (30 s / 60 s / 2 min), then **Test connection**.
3. Start a skirmish and choose **Muse — your API key drives the rival**
   as the difficulty.

While Muse thinks you'll see a small badge (top-right); the game never
waits on it. If anything goes wrong — no key, no network, rate limit —
the rival simply plays on as a Classic Commander, so you'll never get
a broken game.

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

## Phase 3 controls

**Command panel** (bottom of HUD): fire **Aegis**, enter **Storm
targeting** (then click the map), set city **Focus** (specialization),
appoint/dismiss **Mayor** (pick a tax policy), set **Mayor builds**
(housing/industry/balanced auto-construction), appoint/dismiss
**General** (select units first, pick a stance).

Trade routes: established from the command panel — pick a partner
player. Routes pay only while both sides have working shops.

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
