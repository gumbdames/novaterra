/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

# Sea logistics — civilian sea trade (Half A, 0.1 Alpha)

Workstream: civilian sea trade — the `commercialHarbor` production
building, the civilian `fuelBarge`, harbor-to-harbor `SeaRoute`s with
per-voyage ship sailing, physical fuel/materials hauling on the Phase 3
logistics rails, peaceful-AI adoption, and the Management → Trade UI.
Half B (military vessels, minesweeping) is a parallel worker's scope and
is deliberately untouched here.

## 1. What already existed (survey 2026-10-01)

- **Phase 6 naval expansion** (workstream C, 2026-09-30) shipped four
  ports: `commercialPort` / `containerPort` / `fishingHarbor`
  (all `portType: 'civilian'`, coastal via the `portType` rule in
  `validatePlacement`) and `navalBase` (`portType: 'military'`).
  `commercialPort` has `harvest: { funds: 1.5 }` passive income,
  `fuelStorage: 200`, `reloadPoint: true`, and `countsAs: ['shipyard']`.
- **Civilian sea units** already trainable with NO building gate:
  `cargoFreighter` (industry, 500+150, `harvest: { funds: 0.5 }`
  passive), `cruiseLiner` (connectivity, 800+250, harvest 0.6),
  `yacht` (connectivity, 200+60, harvest 0.15), `transportShip`
  (industry, 400+100, no harvest). All are civilian
  (`military` unset) — peaceful-mode legal at the sim layer, but the
  Train palette lives under Military → Train, which peaceful mode
  hides, so peaceful players effectively could not train ships.
- **Military sea logistics** existed: `fuelTanker` (`military: true`,
  `cargoFuelCapacity: 400`), `ammoShip` (`cargoAmmoCapacity: 80`).
- **Phase 3 holds**: `UnitRecord.cargoFuel` / `cargoAmmo`
  (required fields, spawn 0, snapshot `?? 0`, digested). **No
  materials hold existed** — only `cargoFuelCapacity` /
  `cargoAmmoCapacity` on defs.
- **Airline routes** (`establishAirlineRoute` / `cancelAirlineRoute`,
  `AirlineRoute`, `airlineRouteIncome`): own-airports-only, 500 funds
  setup, `1.5/s + 0.005×distance` passive income while both endpoints
  are completed + operational, dead endpoints removed at the economy
  tick. The Classic AI's `thinkAirlineRoutes` is a documented no-op
  (its economy is virtual — no physical airports).
- **Ferry shuttle** (`advanceFerryRoutes` in movement.ts): the pattern
  for route-following ships — idle ship flips `leg`, dispatches via
  `orderMoveTo`, transient 'out of fuel' failures retry every
  `FERRY_RETRY_TICKS`, permanent 'no path' failures stay loud.
- **Fixed market** (`sim/market.ts`): materials 2, fuel 3, food 1,
  research 12 funds/unit; spread 0.2 → materials buy 2.4 / sell 1.6,
  fuel buy 3.6 / sell 2.4.
- **Truck logistics baseline**: fuelTruck cargo 220, supplyTruck
  100/40, hauler 40/20; tanker (air) cargo 200 with a 40-unit
  refuel aura.

## 2. Design decisions

### 2.1 The harbor, not the port, builds ships

New building **`commercialHarbor`** (`sim/city.ts`): the civilian
counterpart to the military `shipyard`. Civilian (no `military`
flag — peaceful-buildable), `portType: 'civilian'` (coastal rule
automatic, the `navalYard` precedent), and the `requiredBuilding`
gate for `cargoFreighter` and the new `fuelBarge`.

Why a new building when `commercialPort` exists: the port is an
*income* building (flat 1.5 funds/s harvest); the harbor is a
*production* building (trains ships, anchors trade routes, forward
fuel depot). One building doing both would collapse the
production/economy distinction the roster keeps everywhere else
(barracks vs market, shipyard vs commercialPort). `countsAs` was
considered (letting `commercialPort` count as a harbor) and rejected:
it would let a pure-income building train ships, and it muddies the
peaceful story (the harbor is the one civilian production building
peaceful players can always reach).

### 2.2 Gating the freighter (backward compatibility)

`cargoFreighter` had no `requiredBuilding` — it trained anywhere via
the `spawnUnit` validator's "no gate" path. It now requires a
completed `commercialHarbor`. Backward compatibility for
saves/snapshots holds because `requiredBuilding` lives on the **def**,
not the record: existing saved freighters decode untouched; only new
training orders go through the gate. (The AD9 additive precedent —
no snapshot bump; see §5.)

`cruiseLiner` / `yacht` stay ungated: they are leisure craft with
passive harvest income, not working cargo ships. Gating them would
force every pleasure yacht through an industrial harbor for no
gameplay reason.

### 2.3 Own harbors only (the airline rule)

`establishSeaRoute` requires **both endpoints to be the owner's
completed civilian ports** — the exact `airlineEndpointProblem`
shape (unknown / not-yours / not-completed / not-civilian-port),
undirected dedup, 500 funds setup. Rival-harbor trade was considered
and deferred: it needs a trade-treaty/diplomacy layer that does not
exist (the partner `TradeRoute` system is funds-only and abstract),
and consistency with the airline rule keeps one mental model. Noted
as a future extension in §7.

Civilian port types accepted: `commercialHarbor`, `commercialPort`,
`containerPort`, `fishingHarbor` — anything with
`portType: 'civilian'`. `navalBase` (`portType: 'military'`) is
rejected loudly, mirroring the military-airbase rejection.

### 2.4 Ships sail; income is per voyage, not per tick

Unlike airline routes (passive per-tick income, no aircraft
simulated), sea routes are **sailed by real ships**: the player
assigns cargo vessels (`assignSeaRoute`) and they shuttle
harbor↔harbor through the normal sea A* (`orderMoveTo`), advancing in
`advanceSeaTrade` inside the movement system — the `advanceFerryRoutes`
shape (unit-id order, idle dispatch, transient-vs-permanent failure
handling). Per-voyage economics (not per-tick) is the point: sea
trade rewards keeping hulls on the water, and a sunk/idle/fuel-
stranded ship visibly stops earning.

### 2.5 Cargo policies (no per-crate micromanagement)

Each route carries one policy, set at establishment:

- **`funds`** — general freight. On arrival at the destination, the
  ship earns `SEA_TRADE_VOYAGE_BASE + distance ×
  SEA_TRADE_VOYAGE_PER_UNIT` funds (see §4 for numbers).
- **`fuel`** — physical ferrying on the Phase 3 rails: at the origin
  the ship loads `min(need, harbor.fuelStock)` into `cargoFuel`; at
  the destination it unloads into `harbor.fuelStock` (capped by
  `fuelStorage`). The harbor is a `reloadPoint` with `fuelStorage:
  300`, so the supply-truck chain stocks it — barges plug straight
  into the existing depot economy. No reservations (harbor stocks
  are first-come, id-ordered — documented simplification, §6).
- **`materials`** — export runs. Buildings hold no materials stock
  (materials are a global treasury stock, unlike depot fuel/ammo),
  so a physical A→B transfer between same-owner harbors would be a
  no-op. Instead the ship loads `min(need, owner.materials)` at the
  origin and **sells at the destination at the mid-market price**
  (`MARKET_PRICES.materials`, no spread) — better than the instant
  `marketSellValue` (1.6), slower, needs hulls and harbors. This is
  the "efficient for bulk" sea advantage over the instant market.

Ammo is deliberately excluded: civilian ships carry no ammo, ever
(the military `ammoShip` keeps that role; arming civilian trade
would leak military logistics into the peaceful economy).

### 2.6 The fuel barge

New civilian unit **`fuelBarge`**: `cargoFuelCapacity: 250`, cheap
(350 funds + 120 materials), slow-ish (speed 9), unarmed, industry
age, `requiredBuilding: 'commercialHarbor'`. It is the sea
counterpart to the land `fuelTruck` (220) — a touch more hold for
the "bulk" identity, but no refuel aura (the air tanker's 40-radius
aura stays the fleet-support tool) and no ammo hold. Civilian →
peaceful-trainable.

### 2.7 The materials hold (save-format decision)

Added `UnitDef.cargoMaterialsCapacity?` and `UnitRecord.cargoMaterials`
(optional, spawn 0, snapshot `?? 0`, digested via `canonicalNumber`).
**No snapshot version bump** (stays v8): the repo's AD9 precedent
(hangar fields, `buildingTargetId`, R2 building HP) is that purely
additive optional fields with neutral decode defaults do not bump —
legacy saves decode to "empty hold", which is exactly correct. The
digest DOES cover it (behavior-affecting, PLAN §11).

### 2.8 AI

- **Peaceful AI** (`thinkPeacefulSeaTrade`, no new AI state, no RNG):
  once the treasury is rich (the existing 2000-funds `rich`
  threshold), it wants up to 2 `commercialHarbor`s on the coast, then
  establishes one `funds`-policy route between its two completed
  harbors, trains up to 2 `cargoFreighter`s (spawned at harbor water
  cells), and assigns them. Everything derives from world state, so
  the dispatch stays digest-neutral when there is no coast.
- **Military Classic AI**: no sea-trade orders — the documented
  `thinkAirlineRoutes` precedent. Its economy is virtual by design
  (no physical buildings), so it cannot own harbor endpoints; giving
  it virtual routes would be income the player cannot see or
  interact with. Recorded here so the asymmetry is a decision, not
  an oversight.

### 2.9 UI

- Management → Trade gains a **sea-trade block**: route list
  (endpoints · policy · est. income/voyage · assigned ships · Cancel)
  plus the two-click "New sea route…" gesture (arm → click two
  civilian ports) with a policy picker. Same gesture shape as the
  airline tool.
- Harbor building detail: its routes + fuel stock line + a **Train
  ships** section (cargoFreighter / fuelBarge buttons arming the
  normal train placement) — this is the peaceful-mode training path,
  since the Train palette hides with the Military tab.
- Ship detail: cargo hold bars (fuel / materials / ammo — ammo always
  empty on civilian hulls, shown for the shared component), route
  assignment control (route dropdown + Assign/Unassign).
- All copy through `loc()` (`STRINGS.seaTrade`); AD11 branches
  registered in `paletteDigest.ts` (additive segments only).

## 3. Sim mechanics (as implemented)

- `SeaRoute { id, owner, from, to, policy, establishedTick }` on
  `CityState.seaRoutes` (+ `nextSeaRouteId`); snapshot `?? []` / `??
  1`; digest `|sea=id:owner:from>to:policy@tick` + `,nextSeaId=`.
- Commands (registered in `registerEconomyCommands`):
  `establishSeaRoute { owner, from, to, policy }`,
  `cancelSeaRoute { owner, id }`,
  `assignSeaRoute { owner, unitId, routeId }` (`routeId: 0` =
  unassign). All validate loudly at enqueue AND apply.
- `advanceSeaTrade` (movement system, after `advanceFerryRoutes`):
  per living assigned ship in id order — if idle, run the port action
  for the current leg, flip the leg, dispatch via `orderMoveTo` to a
  water cell ringing the target harbor. Manual `moveUnit` is a
  detour (the ferry precedent): the loop resumes when the ship idles.
- Endpoint water cells: `harborWaterCell(world, terrain, buildingId)`
  — the footprint ring's water cells, lowest cell index wins
  (deterministic). Dispatch fails loud ('no path') when the harbors
  sit in disconnected sea components — same fail-fast as ferries.
- Dead routes: the economy tick removes routes whose endpoint is
  gone/incomplete/non-operational (the `runAirlineIncome` dead-set
  shape) and clears assignments with `failReason 'sea route ended'`.
- Fuel for the voyage: ships burn their own tanks normally
  (`fuelPerSecond`); an empty tank fails the dispatch loudly and
  retries every `SEA_TRADE_RETRY_TICKS` (30, the ferry constant's
  twin) — a stranded ship is visible, not silently dropped.

## 4. Balance

Comparison baselines (per sim-second unless noted):

| Source | Income / effect | Cost to set up |
|---|---|---|
| Airline route (200u) | 2.5/s passive | 500 + 2 airports |
| Partner trade route | 3.0/s passive | 500 |
| commercialPort harvest | 1.5/s passive | 800+300 |
| cargoFreighter harvest | 0.5/s passive | 500+150, no gate (before) |
| **Sea route voyage (200u, freighter)** | **~90/voyage ≈ 2.0/s per ship** | 500 + 2 harbors + ship |
| Materials instant sell | 1.6/unit, instant | — |
| **Materials export voyage (200u)** | **2.0/unit on 200 hold = 400/voyage** | ship + harbors + time |
| Fuel instant buy | 3.6/unit | — |
| Fuel barge haul (250) | redistribution, no creation | 350+120 + harbors |

Numbers chosen:

- `SEA_ROUTE_SETUP_COST = 500` (airline parity).
- `SEA_TRADE_VOYAGE_BASE = 40`, `SEA_TRADE_VOYAGE_PER_UNIT = 0.25`:
  a 200-unit voyage pays 90 funds. At freighter speed 8 (25 s/leg,
  50 s round trip) that is ~1.8/s per ship — **below** the airline's
  2.5/s and the partner route's 3.0/s, because sea trade stacks per
  ship (two freighters ≈ 3.6/s) while costing hulls, fuel, and
  harbor upkeep. Sea wins on bulk/long distance (the per-unit term
  dominates past ~150 units); air wins on speed-to-income and needs
  no ships. Trucks stay the short-haul answer (no harbor needed).
- `MATERIALS_EXPORT_PRICE = 2.0` (mid-market): beats instant sell
  (1.6) by 25% — the "slow but better rate" bulk identity — while
  staying below buy price (2.4), so no arbitrage loop with the
  market exists (buy 2.4 → export 2.0 loses money).
- `fuelBarge` 250 hold vs fuelTruck 220: the barge hauls ~14% more
  per trip but needs two coastal harbors and a sea lane; trucks keep
  every inland route.
- `commercialHarbor`: 1000 funds / 400 materials, 50 s build,
  1.0/s upkeep, 25 jobs, HP 500, industry age — between `shipyard`
  (1200/500, 1.5/s, 20 jobs, military) and `commercialPort`
  (800/300, 0.8/s, 30 jobs). Cheaper than the shipyard because it
  produces unarmed hulls; pricier than the port because it is a
  production building.

## 5. Snapshot / digest impact

- **No version bump (stays v8).** New state is AD9-additive:
  `seaRoutes` / `nextSeaRouteId` (decode `[]` / `1`),
  `UnitRecord.cargoMaterials` (decode `0`),
  `UnitRecord.seaRouteId` / `seaRouteLeg` (decode unassigned).
  Legacy saves load; new saves round-trip exactly.
- Digest covers all of it (behavior-affecting, PLAN §11): the
  `|sea=` city segment (+ `,nextSeaId=`), per-unit `cargoMaterials`,
  `seaRouteId`/`seaRouteLeg`. Sensitivity tests pin that toggling
  each changes the digest.

## 6. Deliberate simplifications (with why)

1. **Own harbors only** — the airline consistency rule (§2.3).
   Rival-harbor trade needs diplomacy that does not exist.
2. **No harbor fuel reservations** — barge loading is first-come in
   unit-id order against `fuelStock - reservedFuel`… actually first-
   come against the raw stock, ignoring the reservation pool the
   `resupply` command uses. Reason: barges are scheduled shuttles,
   not on-demand resupply orders; adding them to the reservation
   ledger would tangle the release paths (`demolish`'s inline mirror
   in city.ts must stay in sync manually). Documented; revisit if
   harbor fuel contention becomes a real gameplay pain.
3. **Instant load/unload** — no docking timers. A timer would add
   state + digest surface for little gameplay (the voyage itself is
   the time cost).
4. **Materials export instead of physical A→B materials hauling** —
   buildings hold no materials stock (§2.5); the export price gives
   the policy real meaning without inventing a building stock.
5. **Military AI does not run sea trade** — virtual economy, no
   physical harbors (§2.8).
6. **One policy per route** — a mixed manifest (funds + fuel on one
   hull) would need per-ship cargo manifests; the route-level policy
   keeps the standing "no per-crate micromanagement" rule.
7. **Art reuse** — `fuelBarge` renders the `fuelTanker` pieces,
   `commercialHarbor` the `commercialPort` pieces (the
   infantry-variety precedent: distinct props, shared base). No new
   GLB weight; the atlas stays in budget.

## 7. Dead ends & future work

- **Rival-harbor routes**: deferred for the diplomacy layer (§2.3).
- **Per-ship cargo manifests / mixed policies**: rejected per the
  no-micromanagement rule (§6.6).
- **Harbor fuel reservations**: considered, rejected for now (§6.2).
- **Gating cruiseLiner/yacht at the harbor**: rejected — leisure
  craft, no gameplay reason (§2.2).
- **`commercialPort countsAs commercialHarbor`**: rejected — keeps
  the income/production building distinction clean (§2.1).
- **Military-AI virtual sea routes**: rejected — invisible income
  the player cannot interact with (§2.8).
- **Docking timers / port congestion**: no state added; the voyage
  time is the cost (§6.3).

## 8. Test summary

- `game/tests/sim.seatrade.test.ts` (new): establishment validation
  (ownership/completion/civilian-port/dedup/policy/funds),
  cancellation, assignment gating (civilian cargo hulls only),
  voyage income math, fuel load/unload against harbor stocks,
  materials export pricing, dead-route cleanup + assignment clearing,
  peaceful-mode harbor build + ship training, digest sensitivity,
  snapshot round-trip incl. legacy-decode defaults, determinism
  (two runs, identical digests).
- `game/tests/ui.seatrade.test.ts` (new): the `ui/seatrade.ts`
  contract (endpoint detection, route views, income estimate,
  assignment views) + AD11 branch registration.
- AI soak: peaceful AI-vs-AI on a coastal map — routes established,
  ships assigned, income flows; digest-identical across runs.
- Regression: full `npx vitest run`, `npx tsc --noEmit`,
  `npm run build`; count-pinning tests updated (97 units / 100
  buildings); atlas regenerated byte-deterministically under the
  400 KB budget.

## 9. Balance follow-ups (open, not blocking)

- Watch whether two-freighter `funds` routes (~3.6/s at 200u)
  obsolete the `commercialPort` 1.5/s harvest; if so, trim
  `SEA_TRADE_VOYAGE_PER_UNIT` to 0.2.
- Watch harbor fuel contention (§6.2) once barges are common.
