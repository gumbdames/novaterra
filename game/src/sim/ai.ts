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

/**
 * NOVATERRA — sim/ai.ts — Classic AI (deterministic, fair).
 *
 * Five difficulty levels for the single-player skirmish opponent:
 *  - cadet:     reacts every ~8s (240 ticks), trickles basic rifles,
 *               never builds, never researches, never counters, never attacks.
 *  - citizen:   reacts every ~4s (120 ticks), virtually constructs
 *               barracks → warFactory, fields a foundation-age combined
 *               force, attacks visible enemies, simple counters (AA vs air).
 *  - commander: reacts every ~2s (60 ticks), adds a lab + upgrade
 *               research, scouts with drones, builds the full counter
 *               table, and expands to a forward position.
 *  - commander:  reacts every ~2s (60 ticks), medium army, naval probe,
 *               advances ages (roadmap B6, 2026-10-02).
 *  - general:   reacts every ~1.5s (45 ticks), larger army, basic navy
 *               (fishing economy + patrol boats) on coastal maps, advances
 *               ages.
 *  - marshal:   reacts every ~1s (30 ticks), largest army, advances ages,
 *               full navy on coastal maps, uses superweapons fairly.
 *
 * Production buildings (spec docs/research/roster-expansion.md §7.1):
 * in military worlds the AI never paints zones or lays roads, so it
 * *virtually* constructs production buildings in priority order as
 * funds allow: it pays the full funds/materials cost upfront and the building unlocks after the
 * real build time — the exact precedent of the Phase 3 superweapon
 * facilities below. Until a building unlocks, the kinds it gates are
 * skipped in composition (the same fallback pattern as the old
 * fighter→aa fallback). Virtual buildings also yield their def.output
 * rates (the lab's research income is what funds upgrade research);
 * upkeep is waived — the AI's abstract economy has no tax loop to pay
 * it from, and charging upkeep against a fixed stockpile would punish
 * the AI for building rather than reward it.
 *
 * Fairness (no cheating, no fog-of-war omniscience):
 *  - The AI only "sees" enemy units within sight range of its own units.
 *    All unit decisions flow through `getVisibleEnemies()` — the AI never
 *    reads enemy positions directly. ENEMY BUILDING positions are public
 *    knowledge, not omniscience: there is no fog of war in 0.1 Alpha (the
 *    whole map is visible to the human player), so the AI's spy targeting
 *    reads the same building list the human sees. What stays hidden is
 *    the mixed airport's true nature: the AI learns it only through its
 *    own `BuildingRecord.discovery` viewer records (suspected/revealed),
 *    never by reading the true airportType.
 *  - The AI issues the same commands a human player would (spawnUnit,
 *    moveUnit, moveGroup, attackUnit, attackBuilding, researchUpgrade)
 *    through the command queue. It does not mutate world state directly
 *    (except its own `world.ai` record and the virtual-economy credit,
 *    which mirrors what the economy system does for real buildings).
 *  - Water detection is by trial, not maphack: the AI probes for water by
 *    attempting real fishing-boat spawns around its base. Failed probes
 *    cost nothing (rejected at enqueue); a successful probe IS the first
 *    fishing boat.
 *
 * Final-review R2-B (AI siege doctrine, 2026-10-01):
 *  - When no enemy units are visible for N consecutive thinks (the
 *    "army destroyed" signal), the AI escalates from whack-a-mole to a
 *    SIEGE: it picks the highest-value known enemy building (sticky
 *    target) and orders a siege force onto it via `attackBuilding`,
 *    while a difficulty-scaled home guard stays back to defend the
 *    base. Wars can now end in elimination, not stalemate.
 *
 * Grand-expansion Phase 7 (AI intel play, 2026-09-30):
 *  - The AI's intel infrastructure is VIRTUAL (a second one-at-a-time
 *    construction queue, `ai.intel.constructing`, parallel to the
 *    production queue so intel never stalls the war pipeline).
 *    Construction starts only after the production base is complete
 *    (barracks + warFactory) AND the AI holds twice the building's cost
 *    (the other half stays in the war chest) — documented priority:
 *    intel never starves the early economy. Per difficulty: cadet/
 *    citizen build none; commander/general build
 *    listeningPost → intelHQ → signalsStation; marshal adds
 *    satelliteUplink. Completed virtual intel buildings join
 *    `virtualBuildings.completed` (unlocking spy training via
 *    `hasProductionBuilding`) and accrue intel assets through
 *    `creditVirtualIntel` (the `creditVirtualEconomy` mirror, same
 *    cadence, same upgrade multipliers). Their SIGINT detection is
 *    anchored at the AI's base — see `sim/intel.ts`
 *    `virtualDetectorEntries`.
 *  - Spy doctrine (commander+, quota 1/2/3): train spies while under
 *    the army cap; free spies move to the highest-value enemy building
 *    (id-order tiebreak) and infiltrate on arrival; embedded spies
 *    steal tech when surveillance ≥ 15 and a stealable tech exists,
 *    sabotage the host when operational ≥ 25 and the host is a
 *    high-value unsabotaged building. The AI also researches
 *    signalsIntel (with listeningPost) and counterIntel (with
 *    signalsStation) through the queue.
 *  - Counter-intel defense: `ai.intel.counterIntelSurge` latches when a
 *    burned/detected rival spy enters `getVisibleEnemies` or when the
 *    AI's own discovery records warn of a suspected/revealed rival
 *    mixed airport — signalsStation then jumps the intel build queue,
 *    and the AI's stockpiled counter-intel sharpens its spot checks
 *    (the sim-core rule in sim/intel.ts).
 *
 * C1 (AI physical forward base, 2026-10-02):
 *  - Once the AI has established its forward-base coordinates,
 *    commander+ owns REAL forward-base buildings there: commander a
 *    fuelDepot; general + an ordnanceDepot; marshal + a radarStation.
 *    Cadet/citizen build none. The buildings are placed with the real
 *    `placeBuilding` command (real costs, real construction time) at a
 *    deterministic center-out site near the forward base.
 *  - The virtual land-depot path is retired for commander+: the virtual
 *    depot STOCKS are anchored to the physical buildings — they accrue
 *    only while the matching depot is live, complete and operational,
 *    and destroying the depot zeroes the reserve
 *    (`thinkForwardDepots` / `creditVirtualDepotStocks` /
 *    `findLiveForwardDepot`). The virtual navalBase sea chain is
 *    unchanged.
 *  - Rebuilds wait a 2700-tick (90s) cooldown AND a 4-unit army floor
 *    (the forward detachment supplies the defense). The depots are
 *    military buildings, so conquest now requires razing them too.
 *  - Tracked in `ai.forwardDepots` (plain data, snapshotted +
 *    digested); the kind leaves `virtualBuildings.completed` as it
 *    goes physical (no double-counting).
 *
 * Per-match personality (seeded, deterministic — not "entirely deterministic"
 * across matches):
 *  - At `addAIPlayer` time each AI draws a small personality record from
 *    its own named RNG stream (`ai-<owner>`, derived from the world seed
 *    via rng.ts). Per-owner streams mean AI players never shift each
 *    other's draws: adding a second AI doesn't change the first's
 *    personality.
 *  - The personality holds raw traits (aggression, expansionEagerness,
 *    both 0..1) plus derived knobs: per-kind composition weight jitter
 *    (±30% on the base-mix shares — the counter table itself is
 *    untouched), a per-match order for the economy-line upgrades (the
 *    combat/support research head keeps the spec §7.4 priority),
 *    attack-timing jitter (low-aggression personalities issue attack
 *    orders every other think instead of every think), a forward-base
 *    unit threshold (6..10) plus a fallback expansion direction, and a
 *    scout waypoint rotation start. Cadet's personality is inert: cadet
 *    still trains only rifles and never builds, researches, counters,
 *    or attacks.
 *  - All draws happen once at registration; think functions only read
 *    the stored personality and draw nothing, so per-think RNG
 *    consumption is trivially deterministic (zero). Same seed + same
 *    commands ⇒ identical play; different seeds ⇒ different playstyles
 *    at the same difficulty tier. The personality is plain JSON-safe
 *    data, snapshotted and digested like the rest of the AI state.
 *
 * Determinism:
 *  - Decisions run on a fixed tick cadence per difficulty. All randomness
 *    flows through the named `ai-<owner>` RNG streams (see above).
 *    Iteration order is by stable unit id (or fixed tables). AI state is
 *    plain JSON-safe data, snapshotted and digested like everything else.
 *
 * Pure module: no DOM, no three.js, no wall clock, no Math.random.
 * Safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue } from './commands';
import type { SimSystem } from './tick';
import { TICK_HZ } from './tick';
import { detSin, detCos } from './deterministic';
import { findUnit, isSheltered, isNeutralNonCombatant, UNIT_DEFS, type UnitKind, type UnitRecord } from './units';
import { chooseVariant, variantBaseOf } from './variants';
import { rngBank } from './world';
import type { RngBank } from './rng';
import { canTarget, canTargetBuilding } from './combat';
import { isUnitAvailableForAge, getSightBonus, getAgeState, AGE_PROGRESSION } from './ages';
import { effectiveSight, hasUpgrade, registerUpgradeCommands, UPGRADE_DEFS, type UpgradeId } from './upgrades';
import {
  effectiveAmmoProduction,
  effectiveAmmoStorage,
  effectiveFuelStorage,
  upgradeResearchCost,
} from './upgrades';
import {
  isDetected,
  isStealthAsset,
  buildingSightCoverage,
  isSpyUnit,
  getIntelAssets,
  pickStealableTech,
  isSabotaged,
  buildingCenterWorld,
  registerIntelCommands,
  INTEL_ADJACENCY,
  SABOTAGE_COST_OPERATIONAL,
  STEAL_COST_SURVEILLANCE,
  SIGNALS_INTEL_SURVEILLANCE_MULT,
  COUNTER_INTEL_ASSET_MULT,
} from './intel';
import { vetSightMult } from './veterancy';
import {
  getPlayer,
  hasProductionBuilding,
  isBuildingAgeMet,
  cellCenterWorld,
  defaultHangarSlots,
  BUILDING_DEFS,
  MAP_HALF_SIZE,
  CITY_GRID_CELLS,
  CELL_WORLD_SIZE,
  ZoneType,
  UTILITY_ZONE,
  zoneAt,
  cellIsWater,
  cellIndex,
  footprintCells,
  validatePlacement,
  FOOD_PER_POP_PER_SEC,
  peacefulTreasuryFloor,
  buildingAtCell,
  DEFAULT_TAX_RATE,
  NUCLEAR_MAX_REACTORS,
  type BuildingKind,
  type BuildingRecord,
  type HangarClass,
  type IntelAssets,
  type Placement,
} from './city';
import type { TerrainData } from './terrain';
import { isWater } from './terrain';
// From the seaTrade LEAF, not economy.ts: an ai→economy value import
// completes the ai→economy→city→world→ai evaluation cycle that breaks
// module init (the market.ts precedent — economy reads city at module
// scope via SPEC_ZONE/ZoneType).
import { SEA_ROUTE_SETUP_COST } from './seaTrade';
import { STORM_RADIUS, isAegisReady, isStormReady } from './superweapons';
import { CommandRejectedError } from './commands';
// R1 final-review C2 (2026-10-01): the AI's virtual economy converts
// part of its tax stipend into materials at the fixed market rate —
// the same buy price a human player pays. Priced from the leaf module
// sim/market.ts (no sim imports): ai.ts must NOT value-import
// economy.ts — economy reads city.ts at module scope (SPEC_ZONE over
// ZoneType), and ai→economy completes the ai→economy→city→world→ai
// evaluation cycle that breaks module init.
import { marketBuyCost } from './market';
import { ceasefireActive } from './diplomacy';

/** Classic AI difficulty levels. */
export type AIDifficulty = 'cadet' | 'citizen' | 'commander' | 'general' | 'marshal';

/** Think cadence in ticks per difficulty (30 Hz: 240 = 8s, 120 = 4s, 60 = 2s). */
export const AI_THINK_TICKS: Record<AIDifficulty, number> = {
  cadet: 240,
  citizen: 120,
  commander: 60,
  general: 45,
  marshal: 30,
};

/**
 * Max army sizes per difficulty (soft caps for production).
 * Roster grew 14→28 kinds; caps grew ~40% per spec §7.5.
 * The cap counts ALL of the AI's units, so starting forces must leave
 * headroom — `ui/session.ts` gives cadet 2 starters (cap 6), everyone
 * else 6.
 */
export const AI_MAX_UNITS: Record<AIDifficulty, number> = {
  cadet: 6,
  citizen: 14,
  commander: 26,
  general: 34,
  marshal: 48,
};

/** What the AI knows about nearby water (found by probing, never maphack). */
export type AINavalStatus = 'unknown' | 'landlocked' | 'coastal';

// ---------------------------------------------------------------------------
// Per-match personality (seeded playstyle variation)
// ---------------------------------------------------------------------------

/**
 * Per-match AI personality: a small set of playstyle parameters drawn
 * once from the sim RNG when the AI player is registered. Two matches
 * with the same seed produce the same personality (deterministic
 * replay); different seeds play differently at the same difficulty.
 *
 * Difficulty keeps its meaning: personality varies HOW the AI plays, not
 * its skill tier. Think cadence, army caps, the counter table, upgrade
 * prereqs, and cadet's "rifles only, never attack" profile are all
 * untouched — personality only jitters timing, composition weights,
 * expansion eagerness, and the order of flavor-tier upgrades.
 *
 * Plain data — snapshotted + digested. Old snapshots (no personality)
 * decode to NEUTRAL_PERSONALITY, which reproduces pre-personality
 * behavior exactly.
 */
export interface AIPersonality {
  /** Raw trait 0..1: higher attacks every think, lower every other think. */
  aggression: number;
  /** Raw trait 0..1: higher establishes the forward base with fewer units. */
  expansionEagerness: number;
  /**
   * Per-kind multipliers (0.7..1.3) applied to the base-mix shares in
   * chooseUnitKind. Missing kinds count as 1. The counter table is NOT
   * jittered — counters stay exactly as designed.
   */
  mixWeights: Record<string, number>;
  /**
   * This match's order for the economy-line upgrades (the tail of
   * RESEARCH_PRIORITY). The combat/support head keeps the spec §7.4
   * priority. Empty (legacy snapshots) falls back to the default order.
   */
  researchOrder: UpgradeId[];
  /** Fallback expansion direction (radians) when no enemy is visible. */
  expansionAngle: number;
  /** Derived from aggression: attack orders every think (1) or every other think (2). */
  attackEveryNthThink: 1 | 2;
  /** Derived from expansionEagerness: units needed before the forward base (6..10). */
  expansionUnitThreshold: number;
  /** Initial scout waypoint rotation (0..3). */
  scoutStartIndex: number;
}

/** Neutral personality: reproduces pre-personality AI behavior exactly. */
export const NEUTRAL_PERSONALITY: AIPersonality = {
  aggression: 0.5,
  expansionEagerness: 0.5,
  mixWeights: {},
  researchOrder: [],
  expansionAngle: 0,
  attackEveryNthThink: 1,
  expansionUnitThreshold: 8,
  scoutStartIndex: 0,
};

/**
 * Named RNG stream for one AI player's personality draws. Per-owner (not
 * one shared stream) so AI players never shift each other's draws:
 * adding a second AI player doesn't change the first's personality.
 */
function personalityStream(owner: number): string {
  return `ai-${owner}`;
}

/** Kinds jittered by personality: the union of both base mixes. */
const MIX_JITTER_KINDS: UnitKind[] = [
  'rifles', 'tank', 'artillery', 'aa', 'spectre',
  'apc', 'sniperTeam', 'fighter', 'attackHeli',
];

/**
 * First N entries of RESEARCH_PRIORITY are the spec §7.4 combat/support
 * order (pinned by regression tests: apRounds first, …); the rest is the
 * economy line, which the personality reorders per match.
 */
const RESEARCH_HEAD_COUNT = 7;

/** Fisher-Yates shuffle of a copy, drawing from the named stream. */
function shuffled<T>(rng: RngBank, stream: string, items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.intBelow(stream, i + 1);
    // B27: no `!` — i, j < arr.length by construction.
    const ai = arr[i];
    const aj = arr[j];
    if (ai === undefined || aj === undefined) continue;
    arr[i] = aj;
    arr[j] = ai;
  }
  return arr;
}

/**
 * Derive one AI player's personality from the sim RNG. Called once at
 * registration (never during ticks): draw counts are a deterministic
 * function of (owner, difficulty), and think functions draw nothing.
 */
function derivePersonality(world: World, owner: number, difficulty: AIDifficulty): AIPersonality {
  const stream = personalityStream(owner);
  const rng = rngBank(world);
  const aggression = rng.next(stream);
  const expansionEagerness = rng.next(stream);
  const p: AIPersonality = {
    aggression,
    expansionEagerness,
    mixWeights: {},
    researchOrder: [],
    expansionAngle: 0,
    attackEveryNthThink: aggression >= 0.5 ? 1 : 2,
    expansionUnitThreshold: 8,
    scoutStartIndex: 0,
  };
  // Cadet's personality is inert (it never builds/researches/counters/
  // attacks/expands): the two raw traits are still drawn so the stream
  // shape is uniform, but nothing reads them.
  if (difficulty === 'cadet') return p;
  for (const kind of MIX_JITTER_KINDS) {
    p.mixWeights[kind] = rng.range(stream, 0.7, 1.3);
  }
  if (difficulty === 'citizen') return p;
  // commander+: shuffle the economy-line research tail. Repeatable
  // sinks (roadmap B9: Advanced Research) are NOT shuffled — they are
  // the fixed end-of-line research dump, appended after the tail by
  // researchOrderFor, so the tail stays a permutation of the 5 economy
  // upgrades and the seeded stream draws stay stable.
  p.researchOrder = shuffled(
    rng,
    stream,
    RESEARCH_PRIORITY.slice(RESEARCH_HEAD_COUNT)
      .filter((c) => UPGRADE_DEFS[c.id].repeatable !== true)
      .map((c) => c.id),
  );
  p.expansionAngle = rng.range(stream, 0, Math.PI * 2);
  // Inverse mapping: higher eagerness ⇒ expands with fewer units.
  p.expansionUnitThreshold = 10 - Math.floor(p.expansionEagerness * 5);
  p.scoutStartIndex = rng.intBelow(stream, 4);
  return p;
}

/** Per-player AI state. Plain data — snapshotted + digested. */
export interface AIPlayerState {
  /** Owner id this AI controls. */
  owner: number;
  /** Difficulty level. */
  difficulty: AIDifficulty;
  /**
   * Opponent mode (Mode 1 classic AI vs Mode 2 Muse AI, 2026-10-04):
   * behavior-affecting (selects the think function) ⇒ snapshotted +
   * digested like difficulty (AD9).
   */
  opponentMode: OpponentMode;
  /** Where new units are spawned. */
  baseX: number;
  baseZ: number;
  /** Next world.tick at which this AI thinks. */
  nextThinkTick: number;
  /** Forward position for commander expansion (null until established). */
  forwardBase: { x: number; z: number } | null;
  /** Scout waypoint index (commander cycles through waypoints). */
  scoutIndex: number;
  /** How many of each kind this AI has built (for composition logic). */
  builtCounts: Record<string, number>;
  /**
   * Phase 3 superweapon construction (Marshal only). The AI places no
   * physical buildings in 0.1 Alpha; it pays the facility's full cost
   * upfront and the facility comes online after the building's build
   * time. 0 = not built. Plain data — snapshotted + digested.
   */
  superweapons: { aegisReadyTick: number; stormReadyTick: number };
  /**
   * Virtually-constructed production buildings (spec §7.1). The AI pays
   * the full cost upfront; `constructing` completes at `readyTick`
   * (buildSeconds × 30 ticks), then joins `completed` and unlocks the
   * gated roster via `hasProductionBuilding` (city.ts). One at a time.
   */
  virtualBuildings: {
    completed: BuildingKind[];
    constructing: { kind: BuildingKind; readyTick: number } | null;
  };
  /**
   * Phase 3 logistics (workstream 3): abstract supply stocks yielded by
   * the AI's depots. C1 (2026-10-02): commander+ owns REAL forward-base
   * depot buildings, and these stocks are ANCHORED to them — they accrue
   * only while the matching physical depot is live, complete and
   * operational, and destroying the depot zeros the reserve
   * (thinkForwardDepots / creditVirtualDepotStocks). The legacy virtual
   * navalBase sea chain is unchanged. Consumer units draw top-ups from
   * these stocks (thinkLogistics), exactly as `creditVirtualEconomy`
   * credits virtual-building output. Plain data — snapshotted + digested
   * (missing decodes to 0, the AD9 precedent).
   */
  virtualAmmoStock?: number;
  virtualFuelStock?: number;
  /**
   * C1 (AI physical forward base, 2026-10-02): the AI's REAL forward-base
   * buildings. Commander+ builds its difficulty-roster depots as physical
   * buildings at its forward base once the coordinates are established
   * (cadet/citizen build none — their roster is empty). Each entry tracks
   * one roster building: its kind, the physical building id (0 = ordered
   * but not yet observed — commands apply at the next tick start), and
   * the tick its last physical instance was destroyed (-1 = never) for
   * the rebuild cooldown. The virtual depot stocks above are ANCHORED to
   * these buildings: they accrue only while the matching depot is live,
   * complete and operational, and destroying the depot zeros the reserve
   * (see thinkForwardDepots / creditVirtualDepotStocks).
   * Plain data — snapshotted + digested (AD9: missing decodes to []).
   */
  forwardDepots?: Array<{
    kind: 'fuelDepot' | 'ordnanceDepot' | 'radarStation';
    buildingId: number;
    destroyedTick: number;
  }>;
  /**
   * Fun-audit B6 (scheduled, escalating, telegraphed AI offensives,
   * 2026-10-02): the AI's war schedule — border probes ~8 min, a genuine
   * offensive ~15 min, an all-in ~25 min, each telegraphed ~60 s ahead
   * (the UI narrates `telegraphed`; the force commits while
   * `activePhase` runs). Diplomacy can delay a phase, never cancel it
   * (thinkOffensive pushes deadlines forward while a ceasefire holds).
   * Cadet never schedules (maxPhase 0); citizen probes only (maxPhase
   * 1). Plain data — snapshotted + digested (AD9: missing → the
   * schedule (re)initializes on the next think).
   */
  offensive?: {
    /** Next phase to launch: 1 = probe, 2 = offensive, 3 = all-in, 4 = schedule exhausted. */
    nextPhase: number;
    /** Tick the next phase launches. */
    launchTick: number;
    /** Tick the telegraph for the next phase fires (launch − lead). */
    telegraphTick: number;
    /** Telegraph recorded — the UI narrates it, then the flag stays. */
    telegraphed: boolean;
    /** Currently executing phase (0 = none). */
    activePhase: number;
    /** Tick the active phase ends. */
    activeUntilTick: number;
  };
  /** Water scouting result: found by probe spawns, never by maphack. */
  navalStatus: AINavalStatus;
  /** Index into the deterministic naval probe ring. */
  navalProbeIndex: number;
  /** Where the probe found water (null until coastal). Navy spawns here. */
  navalWater: { x: number; z: number } | null;
  /** Set once a submarine is ever seen — gates the Sonar Suite priority. */
  seenSubmarine: boolean;
  /**
   * Latched IDs of enemy buildings this AI has ever SEEN (A2, 2026-10-01).
   * The AI's intel picture: once a scout/sensor sees a building, the AI
   * remembers it — it doesn't forget when the scout leaves (the
   * airport-discovery precedent). `getKnownEnemyBuildings` maintains
   * this; siege and spy targeting read the latched picture, not a
   * maphack. Plain data — snapshotted + digested (AD9: missing decodes
   * to empty).
   */
  seenBuildingIds: number[];
  /**
   * Per-match personality (seeded playstyle variation). Drawn once from
   * the `ai-<owner>` RNG stream at registration; think functions read it
   * but never draw from it. Plain data — snapshotted + digested.
   */
  personality: AIPersonality;
  /**
   * Grand-expansion Phase 7 (AI intel play, 2026-09-30): the AI's
   * virtual intel infrastructure. The AI's intel buildings are all
   * virtual (C1, 2026-10-02, gives it physical forward-base
   * depots/radar — logistics/sensor, not intel), so its listeningPost
   * / intelHQ / signalsStation / satelliteUplink are virtual — a SECOND one-at-a-time construction
   * queue (parallel to `virtualBuildings`, so intel never stalls the
   * war-production pipeline) whose completed kinds join
   * `virtualBuildings.completed` (unlocking spy training and the
   * virtual SIGINT detection that `sim/intel.ts` anchors at the AI's
   * base). `counterIntelSurge` latches when a rival spy is spotted or
   * a discovery warning arrives, and jumps signalsStation to the head
   * of the intel queue. `ops` counts covert ops the AI ordered
   * (infiltrate/sabotage/steal) — soak metrics, snapshotted + digested.
   * Plain data — snapshotted + digested (AD9: missing decodes to the
   * default below).
   */
  intel: AIIntelState;
  /**
   * Final-review R2-B (AI siege doctrine, 2026-10-01): the siege
   * campaign state. `siegeQuietThinks` counts consecutive thinks with
   * no visible enemy units (the "army destroyed" signal); once it
   * reaches the difficulty's quiet threshold the AI escalates from
   * whack-a-mole to attacking the enemy base. `siegeTargetBuildingId`
   * is the sticky siege target (0 = none) so the whole siege force
   * converges instead of flapping between targets each think.
   * Plain data — snapshotted + digested (AD9: missing decodes to 0).
   */
  siegeQuietThinks?: number;
  siegeTargetBuildingId?: number;
}

/**
 * Grand-expansion Phase 7 (AI intel play, 2026-09-30): the AI player's
 * virtual intel state. See the `intel` field on `AIPlayerState`.
 */
export interface AIIntelState {
  /** Virtual intel construction slot (one at a time, parallel to production). */
  constructing: { kind: BuildingKind; readyTick: number } | null;
  /** Latched on spotted rival spy / discovery warning: signalsStation jumps the queue. */
  counterIntelSurge: boolean;
  /** Covert ops ordered (infiltrate/sabotage/steal) — soak metrics. */
  ops: { infiltrate: number; sabotage: number; steal: number };
}

/** Default intel state (AD9: pre-Phase-6 snapshots decode to this). */
export function defaultAIIntelState(): AIIntelState {
  return {
    constructing: null,
    counterIntelSurge: false,
    ops: { infiltrate: 0, sabotage: 0, steal: 0 },
  };
}

/** AI state for the world. Plain data — snapshotted + digested. */
export interface AIState {
  players: AIPlayerState[];
}

/** Create empty AI state. */
export function initAI(): AIState {
  return { players: [] };
}

/**
 * Register an AI player. The base position is where it spawns units.
 * Called during game setup, not during ticks.
 */
export function addAIPlayer(
  world: World,
  owner: number,
  difficulty: AIDifficulty,
  baseX: number,
  baseZ: number,
  opponentMode: OpponentMode = 'classic',
): void {
  // The personality is drawn from the sim RNG here at registration
  // (setup time, never mid-tick): same seed ⇒ same personality, and the
  // draws land in world.rng so they are part of snapshots and digests.
  const personality = derivePersonality(world, owner, difficulty);
  world.ai.players.push({
    owner,
    difficulty,
    opponentMode,
    baseX,
    baseZ,
    nextThinkTick: world.tick + AI_THINK_TICKS[difficulty],
    forwardBase: null,
    scoutIndex: personality.scoutStartIndex,
    builtCounts: {},
    superweapons: { aegisReadyTick: 0, stormReadyTick: 0 },
    virtualBuildings: { completed: [], constructing: null },
    navalStatus: 'unknown',
    // C1 (2026-10-02): initialized to [] (never undefined) so snapshot
    // round-trips are stable. Pre-C1 snapshots (missing field) decode
    // to [] via the ?? [] in decodeAIState (AD9).
    forwardDepots: [],
    navalProbeIndex: 0,
    navalWater: null,
    seenSubmarine: false,
    seenBuildingIds: [],
    // Phase 3 logistics (workstream 3): virtual depot stocks start empty.
    // Initialized here (not just in decode) so a fresh AI player deep-equals
    // its own save/load round trip (netSaveload).
    virtualAmmoStock: 0,
    virtualFuelStock: 0,
    personality,
    // Grand-expansion Phase 7 (AI intel play): the virtual intel queue
    // starts empty; cadet/citizen never touch it (empty priority table).
    intel: defaultAIIntelState(),
    // Final-review R2-B (AI siege doctrine): no siege in progress at
    // registration — initialized here (not just in decode) so a fresh
    // AI player deep-equals its own save/load round trip.
    siegeQuietThinks: 0,
    siegeTargetBuildingId: 0,
  });
}

/**
 * Enemies visible to `owner`: any enemy unit within sight range of any
 * of the owner's units, PLUS any enemy unit inside the owner's
 * building surveillance coverage (the S6 building sight term —
 * listeningPost / signalsStation SIGINT and radarStation radar, via
 * `buildingSightCoverage` in sim/intel.ts). This is the ONLY way the
 * AI perceives enemies — no omniscience.
 *
 * The building term runs here, at AI think cadence, never per-tick in
 * combat (PLAN §4 S6): combat's `acquireTarget` consults unit sight
 * only, so a radar contact the AI "knows about" still has to be
 * engaged by a unit that can see it.
 */

/**
 * The sight discs for one owner: per-own-unit sight radii plus building
 * surveillance coverage. Shared by `getVisibleEnemies` (units) and
 * `getVisibleEnemyBuildings` (buildings, A2) — one sight model, no
 * divergence. Also shared by the fog-of-war system (sim/fog.ts), which
 * rasterizes the same discs into the explored grid — the render shroud
 * and the AI's perception can never disagree. Returns null when the
 * owner has no perception at all.
 */
export function getSightDiscs(
  world: World,
  owner: number,
): { ownRadii: { x: number; z: number; r2: number }[]; coverage: { x: number; z: number; radius: number; seesStealth: boolean }[] } | null {
  const own = world.units.filter((u) => u.owner === owner && u.hp > 0);
  // Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30): the
  // building sight term — completed, operational, unsabotaged
  // SIGINT/radar buildings extend perception where the owner's units
  // can't see. (satelliteUplink contributes through the effectiveSight
  // hook instead; reconTeam/reconUAV/reconPlane through their high
  // platform sight on the unit path below.)
  const coverage = buildingSightCoverage(world, owner);
  if (own.length === 0 && coverage.length === 0) return null;
  // Signals Grid (Connectivity age) grants +sight to all units; upgrade
  // effects (Drone Optics, Advanced Avionics, Sonar Suite) stack on top.
  // Veterancy (Phase 1) multiplies the unit's own sight — the Signals
  // Grid bonus is a network effect and stays flat.
  const sightBonus = getSightBonus(world, owner); // per-side ages: the AI's OWN Signals Grid bonus
  // Final-review R3 (2026-10-01): hoist the per-own-unit sight radius out
  // of the enemy loop — effectiveSight depends only on (world, owner,
  // kind) and vetSightMult only on the own unit, so the radius is
  // constant across enemies. Behavior-identical; turns the inner loop
  // from O(enemies x own) effectiveSight calls into O(own) + compares.
  const ownRadii = own.map((o) => {
    const def = UNIT_DEFS[o.kind as UnitKind];
    // (?? 0: hand-built records without the field count as Recruit.)
    const sight = effectiveSight(world, owner, def) * vetSightMult(o.vetLevel ?? 0) + sightBonus;
    return { x: o.x, z: o.z, r2: sight * sight };
  });
  return { ownRadii, coverage };
}

export function getVisibleEnemies(world: World, owner: number): UnitRecord[] {
  const discs = getSightDiscs(world, owner);
  if (discs === null) return [];
  const { ownRadii, coverage } = discs;
  const out: UnitRecord[] = [];
  const seen = new Set<number>();
  for (const e of world.units) {
    if (e.owner === owner || e.hp <= 0) continue;
    // Fun-audit Tier 4 (E1/E2/E3, 2026-10-02): neutral non-combatants
    // (the envoy, luminary guests, the Combine freighter) are never
    // enemies — the AI must never target, chase, or siege them. Same
    // shared gate as combat's acquireTarget (`neutralNonCombatant`).
    if (isNeutralNonCombatant(e)) continue;
    // Grand-expansion Phase 7 (S6 intel): stealthed units (spies) are
    // invisible to the AI unless detected — the AI perceives exactly
    // what its side can see (the `isDetected` stealth contract in
    // intel.ts). No omniscience, no cheating.
    if (!isDetected(e, owner, world)) continue;
    let visible = false;
    for (const r of ownRadii) {
      const dx = e.x - r.x;
      const dz = e.z - r.z;
      // Compare squared distances; sight is in world units.
      if (dx * dx + dz * dz <= r.r2) {
        visible = true;
        break;
      }
    }
    if (!visible) {
      // The building sight term: SIGINT coverage sees everything
      // (including spies — consistent with the isDetected gate above);
      // conventional radar sees non-stealthed enemies only, by design.
      const stealth = isStealthAsset(e);
      for (const c of coverage) {
        if (stealth && !c.seesStealth) continue;
        const dx = e.x - c.x;
        const dz = e.z - c.z;
        if (dx * dx + dz * dz <= c.radius * c.radius) {
          visible = true;
          break;
        }
      }
    }
    if (visible && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  // Deterministic order: by id.
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** Count the AI's living units by kind. */
function countUnits(world: World, owner: number): Map<UnitKind, number> {
  const m = new Map<UnitKind, number>();
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    const kind = u.kind as UnitKind;
    m.set(kind, (m.get(kind) ?? 0) + 1);
  }
  return m;
}

/** Total living units for an owner. */
function totalUnits(world: World, owner: number): number {
  let n = 0;
  for (const u of world.units) {
    if (u.owner === owner && u.hp > 0) n++;
  }
  return n;
}

/**
 * Enqueue a command, swallowing rejections. A rejected enqueue (failed
 * validation, or a race at apply time) is "couldn't do it this tick" —
 * the AI must never crash the tick on a rejected command. Non-rejection
 * errors still throw: those are real bugs.
 */
/**
 * Enqueue a command, swallowing `CommandRejectedError` (the validator
 * said no — e.g. a water spawn — so the AI simply doesn't get the
 * order). Returns false when the command was rejected, true when it
 * was accepted into the queue. Any other error is re-thrown: only
 * validation rejections are non-fatal.
 */
function issue(world: World, queue: CommandQueue, kind: string, payload: Record<string, unknown>): boolean {
  try {
    queue.enqueue(world, { issuer: 'ai', kind, payload });
    return true;
  } catch (e) {
    if (e instanceof CommandRejectedError) return false;
    throw e;
  }
}

/**
 * Per-think spend ledger (grand-expansion Phase 7).
 *
 * The AI can enqueue several resource-spending commands in one think
 * (research + spy + production unit + age advancement). Each checks
 * affordability at ENQUEUE against the live stockpile — but the
 * commands apply at the NEXT tick start, sequentially, each deducting.
 * Without a ledger, two commands whose SUM exceeds the stockpile both
 * pass enqueue and the second goes stale at apply — and a stale
 * command THROWS (the queue's loud-rejection contract), which would
 * crash the tick. The ledger reserves each committed spend for the
 * rest of the think, so a think's batch can never go stale at apply.
 *
 * Pure scratch: reset at the start of every think (see
 * createAISystem), never snapshotted — thinks run synchronously, so no
 * snapshot can observe a mid-think ledger. Keyed by the AI player
 * object (WeakMap): no cross-match leakage, no digest cost. An
 * over-reservation (enqueue rejected after reserving) only makes the
 * AI underspend one think — safe, never a crash.
 */
interface ThinkLedger {
  funds: number;
  materials: number;
  manpower: number;
  research: number;
  influence: number;
  // Intel assets reserved by queued ops this think (sabotage spends
  // operational, steal spends surveillance — prevents the second op
  // going stale at apply when the first spends the assets).
  operational: number;
  surveillance: number;
}

const thinkLedgers = new WeakMap<AIPlayerState, ThinkLedger>();

/** The current think's ledger for `ai` (created on first use). */
function thinkLedger(ai: AIPlayerState): ThinkLedger {
  let l = thinkLedgers.get(ai);
  if (!l) {
    l = { funds: 0, materials: 0, manpower: 0, research: 0, influence: 0, operational: 0, surveillance: 0 };
    thinkLedgers.set(ai, l);
  }
  return l;
}

/**
 * Can the AI pay an immediate (non-queued) construction cost right
 * now? The payment must leave the stockpile covering the think's
 * queued commits (the ledger) — the AI mixes immediate deductions
 * (virtual construction) with queued commands (spawns), and an
 * immediate payment that undercuts an earlier enqueue would make that
 * command go stale at apply, throwing and crashing the tick.
 */
function canPayImmediate(
  ai: AIPlayerState,
  player: { funds: number; materials: number },
  costFunds: number,
  costMaterials: number,
): boolean {
  const l = thinkLedger(ai);
  return (
    player.funds - costFunds >= l.funds &&
    player.materials - costMaterials >= l.materials
  );
}

/**
 * Issue a spawnUnit command through the queue. Skips if the AI lacks
 * manpower or cannot afford the training cost — affordability is
 * checked against the live stockpile MINUS this think's committed
 * spends (the per-think ledger), and the cost is reserved on issue so
 * a later spend in the same think can't push this command stale.
 */
/**
 * Train one unit of the mix. Returns true when the spawn command was
 * accepted into the queue; false when unaffordable or the validator
 * rejected it (e.g. a water spawn — the caller must NOT count it).
 * The per-think ledger is reserved only on acceptance: a rejected
 * command spends nothing, so the rest of the think keeps its budget.
 */
function spawn(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  kind: UnitKind,
  x: number,
  z: number,
): boolean {
  const def = UNIT_DEFS[kind];
  const player = getPlayer(world.city, ai.owner);
  if (!player) return false;
  const l = thinkLedger(ai);
  if (player.manpower - l.manpower < def.manpowerCost) return false;
  if (player.funds - l.funds < def.trainFunds) return false;
  if (player.materials - l.materials < def.trainMaterials) return false;
  if (!issue(world, queue, 'spawnUnit', { kind, owner: ai.owner, x, z })) return false;
  l.manpower += def.manpowerCost;
  l.funds += def.trainFunds;
  l.materials += def.trainMaterials;
  return true;
}

/**
 * Issue a researchUpgrade command through the queue, reserving the
 * cost in the per-think ledger (see thinkLedger). Skips when the live
 * stockpile minus this think's commits can't cover it.
 */
function researchForAI(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  id: UpgradeId,
): void {
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  const l = thinkLedger(ai);
  // Roadmap B9: repeatable upgrades price the next level (200×level
  // research) — the static def cost would under-reserve the ledger.
  const cost = upgradeResearchCost(world, ai.owner, id);
  if (player.funds - l.funds < cost.costFunds) return;
  if (player.research - l.research < cost.costResearch) return;
  issue(world, queue, 'researchUpgrade', { owner: ai.owner, upgrade: id });
  l.funds += cost.costFunds;
  l.research += cost.costResearch;
}

/**
 * Attempt a spawn and report the outcome: null when the spawn was
 * accepted (it applies at the next tick start), otherwise the rejection
 * reason. Used by the naval probe, which must distinguish "no water
 * here" (keep searching) from "can't afford it" (try again later).
 */
function trySpawn(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  kind: UnitKind,
  x: number,
  z: number,
): string | null {
  const def = UNIT_DEFS[kind];
  const player = getPlayer(world.city, ai.owner);
  if (!player) return 'trySpawn: unknown owner';
  const l = thinkLedger(ai);
  if (player.manpower - l.manpower < def.manpowerCost) {
    return `spawnUnit: not enough manpower (need ${def.manpowerCost})`;
  }
  if (
    player.funds - l.funds < def.trainFunds ||
    player.materials - l.materials < def.trainMaterials
  ) {
    return `spawnUnit: cannot afford training cost for ${kind}`;
  }
  try {
    queue.enqueue(world, { issuer: 'ai', kind: 'spawnUnit', payload: { kind, owner: ai.owner, x, z } });
  } catch (e) {
    if (e instanceof CommandRejectedError) return e.reason;
    throw e;
  }
  l.manpower += def.manpowerCost;
  l.funds += def.trainFunds;
  l.materials += def.trainMaterials;
  return null;
}

/** Issue an attackUnit command through the queue. */
function attack(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitId: number,
  targetId: number,
): void {
  issue(world, queue, 'attackUnit', { unitId, targetId, owner });
}

// ---------------------------------------------------------------------------
// AI siege doctrine (final-review R2-B, 2026-10-01).
//
// Before this workstream the AI's wars ended as whack-a-mole: the attack
// loops issued only `attackUnit`, so after wiping the visible enemy army
// the AI idled (and cold-war standoffs were structural — scouts only
// reach 120–220 units out on a 512-wide map). The new doctrine: when no
// enemy units have been visible for N consecutive thinks (the army is
// destroyed or hiding), the AI escalates to a siege — it picks the
// highest-value known enemy building and orders a siege force to attack
// it via the `attackBuilding` command, while a difficulty-scaled home
// guard stays back to defend the base.
//
// The command contract (R2-A, final-review C3 — landed): command name
// `attackBuilding`, payload `{ unitId, buildingId, owner }` — the same
// payload shape as the building-targeted covert-op commands
// (`infiltrateBuilding` / `sabotage` / `stealTech`). Apply sets the
// unit's `buildingTargetId` + `chasing` and moves it onto the
// building's footprint center; the combat loop chases and fires
// `fireWeaponAtBuilding` in range, re-validating per tick (a destroyed
// building clears the order instead of throwing). Verified against the
// real command at sign-off: the name, payload, and `buildingTargetId`
// semantics here match combat.ts exactly.
//
// "Known enemy infrastructure" uses `getKnownEnemyBuildings` — the
// AI's latched intel picture of the enemy's completed buildings (A2:
// sight-gated, never a maphack). Siege targeting is therefore
// consistent with the spy doctrine, and it is what makes 220+ base
// separations eliminable instead of permanent stalemates.
// ---------------------------------------------------------------------------

/**
 * The attack-building command name this doctrine issues. R2-A
 * (final-review C3) provides it; see the section header for the
 * coordination contract.
 */
export const ATTACK_BUILDING_COMMAND = 'attackBuilding';

/**
 * Consecutive thinks with zero visible enemy units before the AI
 * starts a siege. Higher difficulties escalate faster (marshal: the
 * very first quiet think).
 */
export const SIEGE_QUIET_THINKS: Record<AIDifficulty, number> = {
  cadet: Infinity, // cadet never attacks — no siege either
  citizen: 3,
  commander: 2,
  general: 2,
  marshal: 1,
};

/**
 * Fraction of the siege-capable force that stays home as the base
 * guard while the rest sieges. The AI must not strip its base bare:
 * higher difficulties commit more to the siege but always keep a
 * guard.
 */
export const SIEGE_HOME_GUARD_FRACTION: Record<AIDifficulty, number> = {
  cadet: 1,
  citizen: 0.5,
  commander: 0.4,
  general: 0.3,
  marshal: 0.2,
};

// ---------------------------------------------------------------------------
// Fun-audit B6 (2026-10-02): scheduled, escalating, telegraphed AI
// offensives.
//
// The AI runs a visible war schedule independent of contact — border
// probes ~8 min, a genuine offensive ~15 min, an all-in ~25 min while
// the game is still live. Each phase is telegraphed ~60 s ahead (the
// `telegraphed` flag on `AIPlayerState.offensive`, narrated UI-side)
// and then commits an escalating fraction of the siege-capable force
// through the existing siege machinery (sight-gated targeting — the
// schedule decides WHEN, never WHERE; fairness is structural).
// Diplomacy can delay a phase, never cancel it: while a ceasefire
// holds, thinkOffensive pushes every deadline forward instead of
// launching. Ticks are 30 Hz simulation ticks — never wall clock.
// ---------------------------------------------------------------------------

/** Phase launch ticks: [probe, offensive, all-in] ≈ 8/15/25 min. */
export const OFFENSIVE_PHASE_LAUNCH_TICKS: readonly [number, number, number] = [
  8 * 60 * 30,
  15 * 60 * 30,
  25 * 60 * 30,
];

/** Telegraph lead time before each phase launch (60 s of warning). */
export const OFFENSIVE_TELEGRAPH_LEAD_TICKS = 60 * 30;

/** How long a launched phase keeps pushing (5 min). */
export const OFFENSIVE_DURATION_TICKS = 5 * 60 * 30;

/**
 * Highest scheduled phase per difficulty. Cadet never attacks (0);
 * citizen probes only (1); commander/general/marshal run the full
 * schedule (3).
 */
export const OFFENSIVE_MAX_PHASE: Record<AIDifficulty, number> = {
  cadet: 0,
  citizen: 1,
  commander: 3,
  general: 3,
  marshal: 3,
};

/**
 * Fraction of the siege-capable force committed while a phase is
 * active (escalates: probe 0.3 → offensive 0.55 → all-in 0.8). The
 * remainder stays home as the guard.
 */
export const OFFENSIVE_COMMIT_FRACTION: Record<number, number> = {
  1: 0.3,
  2: 0.55,
  3: 0.8,
};

/**
 * When a siege campaign starts, guard units farther than this (world
 * units) from the base are recalled once — the guard defends the base
 * area, it doesn't wander the midfield.
 */
const SIEGE_GUARD_RECALL_RADIUS = 150;

/**
 * Siege target value for an enemy building kind: production and war
 * apparatus first (killing production ends the whack-a-mole), then
 * research, intel, and utility plants; civilian buildings are the
 * fallback — a base of only houses must still be removable, or
 * elimination stays structurally unreachable.
 */
export function siegeTargetValue(kind: BuildingKind): number {
  const def = BUILDING_DEFS[kind];
  if (!def) return 0;
  if (def.military === true) return 100;
  if (kind === 'lab') return 90;
  if (def.intelOutput) return 85;
  if ((def.powerSupply ?? 0) > 0 || (def.waterSupply ?? 0) > 0) return 70;
  if (def.storageKind) return 60;
  if (kind === 'ordnanceDepot' || kind === 'fuelDepot') return 55;
  return 10;
}

/** Issue an attackBuilding order through the queue (rejections swallowed). */
function siegeBuilding(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitId: number,
  buildingId: number,
): void {
  issue(world, queue, ATTACK_BUILDING_COMMAND, { unitId, buildingId, owner });
}

/**
 * Pick the siege target: the sticky target while it still stands
 * (completed, still enemy-owned), otherwise the best known enemy
 * building. Citizen aims at the nearest building (dumb but effective);
 * commander+ aim at the highest siege value. Deterministic tiebreaks
 * (lowest id) — no RNG in thinks. Returns null when no enemy
 * infrastructure is known.
 */
function pickSiegeTarget(
  world: World,
  ai: AIPlayerState,
  currentId: number,
): BuildingRecord | null {
  const owner = ai.owner;
  const difficulty = ai.difficulty;
  if (currentId > 0) {
    const cur = world.city.buildings.find((b) => b.id === currentId);
    if (cur && cur.owner !== owner && cur.progress >= 1) return cur;
  }
  let target: BuildingRecord | null = null;
  if (difficulty === 'citizen') {
    let best = Infinity;
    for (const b of getKnownEnemyBuildings(world, ai)) {
      if (b.owner === owner) continue;
      const c = buildingCenterWorld(b);
      const dx = c.x - ai.baseX;
      const dz = c.z - ai.baseZ;
      const d = dx * dx + dz * dz;
      if (d < best || (d === best && target !== null && b.id < target.id)) {
        best = d;
        target = b;
      }
    }
    return target;
  }
  let best = -1;
  for (const b of getKnownEnemyBuildings(world, ai)) {
    if (b.owner === owner) continue;
    const v = siegeTargetValue(b.kind);
    if (v > best || (v === best && target !== null && b.id < target.id)) {
      best = v;
      target = b;
    }
  }
  return target;
}

/**
 * How many of a siege force of `n` units stay home as the base guard.
 * The guard is the difficulty-scaled fraction, but it never exceeds
 * n-1: a lone unit still sieges (a one-unit "guard" defends nothing,
 * and the siege needs at least one attacker). Exported for tests.
 */
export function siegeGuardCount(n: number, difficulty: AIDifficulty): number {
  const frac = SIEGE_HOME_GUARD_FRACTION[difficulty] ?? 0;
  return Math.min(Math.ceil(n * frac), Math.max(0, n - 1));
}

/**
 * Fun-audit B6: fraction of the siege-capable force committed right
 * now (0 when no offensive phase is active). Read by thinkSiege to
 * override the normal home-guard fraction during a launched phase.
 */
export function offensiveCommitOf(world: World, ai: AIPlayerState): number {
  const o = ai.offensive;
  if (o === undefined) return 0;
  if (o.activePhase < 1 || o.activePhase > 3) return 0;
  if (world.tick >= o.activeUntilTick) return 0;
  return OFFENSIVE_COMMIT_FRACTION[o.activePhase] ?? 0;
}

/**
 * Fun-audit B6: advance the AI's war schedule. Initializes the
 * schedule on the first think (AD9: a missing `offensive` field —
 * e.g. pre-B6 snapshots — schedules from scratch), records the
 * telegraph flag ~60 s before each phase (the UI narrates it), and
 * launches each phase at its tick.
 *
 * Diplomacy delays, never cancels: while a ceasefire holds, every
 * pending/active deadline moves forward one think and nothing
 * launches. Deterministic: all deadlines derive from world.tick and
 * the fixed schedule — no RNG.
 */
export function thinkOffensive(world: World, ai: AIPlayerState): void {
  const maxPhase = OFFENSIVE_MAX_PHASE[ai.difficulty] ?? 0;
  if (maxPhase === 0) return; // cadet: no war schedule, ever
  let o = ai.offensive;
  if (o === undefined) {
    const first = OFFENSIVE_PHASE_LAUNCH_TICKS[0] ?? 8 * 60 * 30;
    o = {
      nextPhase: 1,
      launchTick: first,
      telegraphTick: first - OFFENSIVE_TELEGRAPH_LEAD_TICKS,
      telegraphed: false,
      activePhase: 0,
      activeUntilTick: 0,
    };
    ai.offensive = o;
  }
  const thinkTicks = AI_THINK_TICKS[ai.difficulty] ?? 60;
  if (ceasefireActive(world)) {
    if (o.nextPhase <= maxPhase) {
      o.launchTick += thinkTicks;
      o.telegraphTick += thinkTicks;
      o.telegraphed = false; // re-telegraph after the delay
    }
    if (o.activePhase !== 0) o.activeUntilTick += thinkTicks;
    return;
  }
  if (o.activePhase !== 0 && world.tick >= o.activeUntilTick) o.activePhase = 0;
  if (!o.telegraphed && o.nextPhase <= maxPhase && world.tick >= o.telegraphTick) {
    o.telegraphed = true;
  }
  if (o.nextPhase <= maxPhase && world.tick >= o.launchTick) {
    o.activePhase = o.nextPhase;
    o.activeUntilTick = world.tick + OFFENSIVE_DURATION_TICKS;
    o.nextPhase += 1;
    if (o.nextPhase <= maxPhase) {
      const scheduled = OFFENSIVE_PHASE_LAUNCH_TICKS[o.nextPhase - 1] ?? o.launchTick;
      // A delayed phase never schedules its successor in the past —
      // the telegraph always gets its full lead time.
      o.launchTick = Math.max(scheduled, world.tick + OFFENSIVE_TELEGRAPH_LEAD_TICKS + 1);
      o.telegraphTick = o.launchTick - OFFENSIVE_TELEGRAPH_LEAD_TICKS;
      o.telegraphed = false;
    } else {
      o.nextPhase = 4; // schedule exhausted
      o.telegraphed = false;
    }
  }
}

/**
 * The siege think: called when no enemy units are visible and the
 * quiet has persisted past the difficulty threshold (checked by the
 * caller). Splits the siege-capable force into a home guard (stays,
 * recalled once toward the base when the campaign starts) and a siege
 * force (ordered onto the sticky target building). Cadet never sieges.
 */
function thinkSiege(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  const difficulty = ai.difficulty;
  if (difficulty === 'cadet') return;
  // Fun-audit B6: a launched offensive phase pushes immediately — no
  // waiting for the quiet to persist. The schedule decides WHEN; the
  // sight-gated targeting below still decides WHERE.
  const commit = offensiveCommitOf(world, ai);
  const quiet = ai.siegeQuietThinks ?? 0;
  if (commit === 0 && quiet < SIEGE_QUIET_THINKS[difficulty]) return;

  // Siege-capable combat units, id order (deterministic). Same gates
  // as the attack loops: armed, ground-targeting weapons (R2-A's
  // `canTargetBuilding` — the same predicate the command validates),
  // loaded magazines, no scouts, no empty-wing carriers.
  // Final-review R2-B: siege uses GROUND and NAVAL units only — air
  // units (especially carrier-based) are managed by the wing/hangar
  // systems, and their embark/park state races with queued siege
  // orders (the command rejects parked/embarked aircraft).
  const fighters: UnitRecord[] = [];
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!canTargetBuilding(def)) continue;
    if (u.kind === 'drone' || u.kind === 'awacs') continue; // scouts don't fight
    if (u.domain === 'air') continue; // air power is wing-managed, not siege
    // Embarked (on a carrier) or parked (in a hangar) aircraft can't
    // attack — the command rejects them. Launch first via the carrier/
    // hangar systems, don't siege with them.
    if ((u.embarkedOn ?? 0) !== 0) continue;
    if ((u.hangarBuildingId ?? 0) !== 0) continue;
    // Dry magazines don't get new attack orders — they fall back in
    // thinkAmmoRetreats instead (they can't shoot anyway).
    if ((def.ammoCapacity ?? 0) > 0 && u.ammo <= 0) continue;
    // Carriers with unfilled wings never sail into combat (their wings
    // are filled by thinkCarrierWings first).
    if (isEmptyWingCarrier(world, u)) continue;
    fighters.push(u);
  }
  if (fighters.length === 0) return;

  const target = pickSiegeTarget(world, ai, ai.siegeTargetBuildingId ?? 0);
  if (!target) return; // no enemy infrastructure known — hold position
  const campaignStart = (ai.siegeTargetBuildingId ?? 0) !== target.id;
  ai.siegeTargetBuildingId = target.id;

  // Home guard: the first K units by id stay on defense; the rest form
  // the siege force (siegeGuardCount: never more than n-1). Fun-audit
  // B6: a launched offensive phase commits its escalating fraction
  // instead (never more than n-1 either — the base is never stripped
  // bare).
  const guard =
    commit > 0
      ? Math.min(Math.ceil(fighters.length * (1 - commit)), Math.max(0, fighters.length - 1))
      : siegeGuardCount(fighters.length, difficulty);
  for (let i = 0; i < fighters.length; i++) {
    // B27: no `!` — i < fighters.length by loop bound.
    const u = fighters[i];
    if (u === undefined) continue;
    if (i < guard) {
      // Home guard: on campaign start, recall stragglers toward the
      // base so the guard actually defends the base area. One order
      // per campaign start — no per-think churn.
      if (campaignStart) {
        const dx = u.x - ai.baseX;
        const dz = u.z - ai.baseZ;
        if (dx * dx + dz * dz > SIEGE_GUARD_RECALL_RADIUS * SIEGE_GUARD_RECALL_RADIUS) {
          moveTo(world, queue, ai.owner, u.id, ai.baseX, ai.baseZ);
        }
      }
      continue;
    }
    // Only re-issue if not already sieging this building (mirrors the
    // attack loop's `targetId`/`chasing` dedup — R2-A's command sets
    // `buildingTargetId` + `chasing` at apply, and the combat loop
    // clears `buildingTargetId` when the building falls).
    if ((u.buildingTargetId ?? 0) === target.id && u.chasing) continue;
    siegeBuilding(world, queue, ai.owner, u.id, target.id);
  }
}

/** Issue a moveUnit command through the queue. */
function moveTo(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitId: number,
  x: number,
  z: number,
): void {
  issue(world, queue, 'moveUnit', { unitId, owner, x, z });
}

/** Issue a moveGroup command through the queue. */
function moveGroupTo(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitIds: number[],
  x: number,
  z: number,
): void {
  issue(world, queue, 'moveGroup', { unitIds, owner, x, z });
}

/**
 * True when the AI can currently train `kind`: the def exists, the age
 * gate is met, and any required production building is held (real or
 * virtually constructed). Composition skips anything false here — this
 * is what keeps the AI from stalling on locked kinds (the old "stuck at
 * 6 units" failure: citizen kept ordering tanks it could never receive).
 *
 * Unknown kinds (the Phase 5/6 airport/naval/aircraft roster — workers
 * A/B/C haven't landed their defs yet) are never trainable: composition
 * skips them instead of crashing on `def.minAge`. This is what keeps
 * the AI safe-but-inactive on the unlanded roster (PLAN §6: "canTrain
 * auto-skips locked kinds, so new content is safe but dead until each
 * think function learns it").
 */
export function canTrain(world: World, owner: number, kind: UnitKind): boolean {
  const def = UNIT_DEFS[kind];
  if (!def) return false;
  // Fun-audit Tier 4 (E1/E2/E3, 2026-10-02): scripted neutral
  // non-combatants (envoy, luminary guests, the Combine freighter)
  // enter the world through their own systems — the AI never trains
  // them (the spawnUnit validator rejects them loudly as well).
  if (def.neutralNonCombatant === true) return false;
  // Grand-expansion Phase 8 (peaceful mode, workstream C): military
  // defs are unbuildable in a peaceful world — the trainUnit command
  // rejects them loudly (workstream A), so every composition check
  // must skip them first. (The drone/scout wrinkle: the armed scout
  // `drone` is military (unbuildable), and the civilian
  // reconUAV/reconPlane need a military-locked airfield — in practice
  // the peaceful AI has no scouts. It needs none: with no combat and
  // no forward base, no think branch requires vision.)
  if (world.peaceful === true && def.military === true) return false;
  if (!isUnitAvailableForAge(world, owner, def.minAge)) return false;
  if (def.requiredBuilding && !hasProductionBuilding(world, owner, def.requiredBuilding)) return false;
  // Hangar-aware (grand-expansion Phase 5, S4): aircraft that need a
  // hangar slot only train while the AI has a free one. The Classic
  // AI's production buildings are all virtual (C1, 2026-10-02, adds
  // physical forward-base depots/radar only — no hangars), so the
  // capacity is virtual (PLAN §6: "virtual airfields get virtual
  // capacity").
  // The gate applies only to infrastructure-based aircraft — units
  // with a requiredBuilding (airfield-trained). Field-operated
  // micro-UAVs like the scout drone (no requiredBuilding,
  // hand-launched) are exempt: gating them would ground the
  // commander's approved early-game scouting behind a 1500-fund
  // airfield the commander never builds (caught by sim.ai.test.ts
  // "scouts with a drone", 2026-09-30). Thematically consistent: no
  // building to train from ⇒ no hangar needed to park in.
  if (def.hangarClass && def.requiredBuilding &&
      !hasVirtualHangarRoom(world, owner, def.hangarClass)) return false;
  return true;
}

/**
 * The AI's virtual hangar capacity, in slots by class. The Classic
 * AI's production buildings are all virtual (C1, 2026-10-02, adds
 * physical forward-base depots/radar only — no hangars), so hangar
 * parking is virtual too: each completed
 * virtual building yields `defaultHangarSlots(kind)` virtual slots,
 * exactly the legacy decode default the snapshot module gives real
 * buildings (snapshot.ts v8). Deterministic: no RNG, fixed order.
 */
function virtualHangarCapacity(ai: AIPlayerState): Record<HangarClass | 'generic', number> {
  const cap: Record<HangarClass | 'generic', number> = {
    light: 0, medium: 0, heavy: 0, generic: 0,
  };
  for (const kind of ai.virtualBuildings.completed) {
    for (const s of defaultHangarSlots(kind) ?? []) cap[s.cls]++;
  }
  return cap;
}

/**
 * True when the AI has a free virtual hangar slot for one more aircraft
 * of `hangarClass`. Aircraft already embarked on a carrier ride the
 * carrier, not a hangar slot. Slot assignment is deterministic and
 * greedy: class-exact slots fill first, 'generic' slots take the
 * overflow (generic accepts any class — the pre-class-system behavior).
 * No RNG; id-ordered iteration.
 */
function hasVirtualHangarRoom(world: World, owner: number, hangarClass: HangarClass): boolean {
  const ai = world.ai.players.find((p) => p.owner === owner);
  if (!ai) return false;
  const cap = virtualHangarCapacity(ai);
  // Recompute the greedy assignment from scratch: exact[hc] aircraft of
  // each class take exact slots first, the rest take generic slots.
  const exactUsed: Record<HangarClass, number> = { light: 0, medium: 0, heavy: 0 };
  let genericUsed = 0;
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    if ((u.embarkedOn ?? 0) !== 0) continue;
    const uhc = UNIT_DEFS[u.kind as UnitKind]?.hangarClass;
    if (!uhc) continue;
    if (exactUsed[uhc] < cap[uhc]) exactUsed[uhc]++;
    else if (genericUsed < cap.generic) genericUsed++;
    // else: no slot for this aircraft — it still flies (the AI has no
    // physical parking to deny it), but it blocks further training.
  }
  return exactUsed[hangarClass] < cap[hangarClass] || genericUsed < cap.generic;
}

// ---------------------------------------------------------------------------
// Virtual construction (spec §7.1)
// ---------------------------------------------------------------------------

/**
 * Construction priority per difficulty, in order. Skipped entries: kinds
 * already held (real or virtual), kinds whose minAge isn't met yet, and
 * shipyard/navalYard/navalBase until water is found (no point without
 * a coast).
 * Cadet builds nothing — consistent with its "no decisions" profile.
 * Exported for tests (the marshal civilAirport entry is pinned).
 */
export const CONSTRUCTION_PRIORITY: Record<AIDifficulty, BuildingKind[]> = {
  cadet: [],
  citizen: ['barracks', 'warFactory'],
  commander: ['barracks', 'warFactory', 'lab'],
  general: ['barracks', 'warFactory', 'lab'],
  // Phase 5 (airports + airline): marshal also builds a civil airport.
  // R1 final-review C2 (2026-10-01): the old comment here claimed the
  // airport's income flowed through creditVirtualEconomy's def.output
  // credit — FALSE. The civilAirport def has no funds output; its
  // landing fees are def.harvest ({ funds: 1.0 }), which the virtual
  // economy now credits (see creditVirtualEconomy).
  // The kind is in the BuildingKind union (airport workstream landed);
  // thinkConstruction's unknown-def guard still skips it while
  // BUILDING_DEFS has no entry — no crash, no stall, no behavior
  // change until the def exists.
  // Phase 9 balance pass (pathology 5): marshal also builds a media
  // center after the airport. 0.8 influence/s unlocks the industry age
  // (100 influence) in ~125 sim-seconds; without it the marshal
  // dead-ends at the age gate — intelHQ, signalsStation,
  // ordnanceDepot, missileSilo, and navalYard never unlock.
  // Naval-building model (2026-10-01): the marshal builds the naval
  // docks right after the yards that build the fleet — the navalBase
  // is the military shipping interface where its fuelTanker/ammoShip
  // tail loads (a completed virtual navalBase feeds the fleet's fuel
  // chain and is the AI's virtual docks for `loadCargoVirtual`).
  // Coastal-gated like the yards, below.
  marshal: ['barracks', 'warFactory', 'lab', 'airfield', 'radarStation', 'shipyard', 'navalYard', 'navalBase', 'civilAirport', 'mediaCenter'],
};

/** Complete whatever finished building; start the next priority kind. */
function thinkConstruction(world: World, ai: AIPlayerState): void {
  const vb = ai.virtualBuildings;
  // Complete finished construction.
  if (vb.constructing && world.tick >= vb.constructing.readyTick) {
    vb.completed.push(vb.constructing.kind);
    vb.constructing = null;
  }
  thinkUtilityConnections(world, ai);
  // One building at a time.
  if (vb.constructing) return;
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  for (const kind of CONSTRUCTION_PRIORITY[ai.difficulty]) {
    if (vb.completed.includes(kind)) continue;
    if (hasProductionBuilding(world, ai.owner, kind)) continue;
    const def = BUILDING_DEFS[kind];
    // Unknown defs (the Phase 5/6 airport roster — workers A/B/C
    // haven't landed them yet) are skipped, not crashed on: the AI
    // stays safe-but-inactive on unlanded buildings (PLAN §6).
    if (!def) continue;
    // Age-gated kinds wait for the age (marshal may get there).
    if (!isBuildingAgeMet(getAgeState(world, ai.owner).age, def.minAge)) continue;
    // Naval production only makes sense with a coast to use it from.
    // Naval-building model (2026-10-01): the navalBase is the yards'
    // shipping interface — same coastal gate.
    if ((kind === 'shipyard' || kind === 'navalYard' || kind === 'navalBase') && ai.navalStatus !== 'coastal') continue;
    // Ledger-aware: the payment must not undercut commands already
    // queued this think (see canPayImmediate).
    if (!canPayImmediate(ai, player, def.costFunds, def.costMaterials)) continue;
    // Pay the full cost upfront (superweapon virtual-construction precedent).
    player.funds -= def.costFunds;
    player.materials -= def.costMaterials;
    vb.constructing = { kind, readyTick: world.tick + def.buildSeconds * 30 };
    return;
  }
}

/**
 * Utility-connection sub-phase (grand-expansion Phase 2, §AD2).
 *
 * 0.1 Alpha verdict: the Classic AI owns no physical PLANTS — every
 * production building is virtual (a kind name in
 * `ai.virtualBuildings.completed`, no footprint, no grid position).
 * C1 (2026-10-02) gives it physical forward-base depots/radar, but
 * those are logistics/sensor buildings, not power/water plants, and
 * the AI still places no plants anywhere (see the module header and
 * game/src/sim/AGENTS.md). A "stranded plant" is a
 * physical plant touching no conductor; with no physical plants, the
 * stranded condition cannot arise for the AI, so there is nothing to
 * connect and no line order to issue.
 *
 * Virtual buildings stay on the global utility pool (the §AD2 fallback):
 * `creditVirtualEconomy` credits their def.output unconditionally, and
 * the pool allocator serves every completed funded physical plant, so
 * the AI never starves for power/water and never needs lines. This is
 * the plan's accepted outcome ("or stays on the pool fallback per §AD2
 * — explicitly tested either way", PLAN.md §9 Phase 2) — pinned by
 * game/tests/sim.ai-utilities.test.ts.
 *
 * Extension hook: if the AI ever gains physical PLANTS (power/water
 * producers), the stranded check goes here. C1 (2026-10-02) gives the
 * AI physical forward-base buildings, but they are logistics/sensor
 * depots — not plants — so the stranded-plant condition still cannot
 * arise and the hook stays a no-op. The sim workstream's network model
 * is `sim/utilityNetworks.ts` (`getUtilityModel(city, input)` →
 * `UtilityModel`; per-player `UtilitySideModel` carries
 * `plantNetwork: Map<plantId, networkId>` and
 * `unreached: number[]` — buildings reached by no network, which the
 * sim serves from the AD2 pool fallback by design). Names verified
 * against the workstream's source 2026-09-30 — the module was still
 * uncommitted then, so re-verify before wiring. For each completed
 * AI-owned physical plant absent from `plantNetwork` (or listed in
 * `unreached`), issue a line-building order from the plant toward the
 * nearest conductor (nearest existing network cell, else the road
 * grid), one attempt per think. Constraints for that future work: think
 * cadence only (never per-tick), seeded `ai-<owner>` stream draws only
 * (never the shared streams), and no mid-tick world mutation (orders
 * through the queue like every other AI action).
 */
function thinkUtilityConnections(world: World, ai: AIPlayerState): void {
  // No-op by design in 0.1 Alpha: virtual buildings have no footprint,
  // so the pool fallback (AD2) covers the AI completely. The arguments
  // are intentionally unused — they define the hook's signature for the
  // future physical-builder work described above.
  void world;
  void ai;
}

// ---------------------------------------------------------------------------
// Phase 3 logistics (workstream 3): forward-base depots, truck ratios,
// abstract resupply, ammo-dry retreats.
//
// Honest abstraction statement: the Classic AI's production buildings
// are all virtual (a kind name in `ai.virtualBuildings.completed`, no
// footprint, no grid position). C1 (2026-10-02) gives commander+ REAL
// forward-base depot buildings (fuelDepot/ordnanceDepot/radarStation —
// see thinkForwardDepots), and the virtual land-depot path is retired:
// the physical depots are the single source of truth. The virtual
// depot STOCKS (`virtualAmmoStock` / `virtualFuelStock`) remain an
// abstraction, but they are now ANCHORED to the physical buildings —
// they accrue only while the matching depot is live, complete and
// operational, and destroying the depot zeros the reserve
// (creditVirtualDepotStocks). So:
//  - live physical ordnance/fuel depots yield ABSTRACT stocks
//    (`virtualAmmoStock` / `virtualFuelStock`, credited per think at
//    honest production economics — the physical chain's rates and
//    input costs, never minted from nothing; see
//    creditVirtualDepotStocks);
//  - the AI's consumer units draw top-ups from those stocks at think
//    cadence (thinkAbstractResupply) — the same virtual-building
//    abstraction as `creditVirtualEconomy`, which credits virtual
//    building output into the AI's resources;
//  - supply/fuel trucks are still trained at the documented ratios (they
//    count toward the army cap and get role-specialized toggles via the
//    real `setSupplyToggles` command) — they are the visible logistics
//    tail whose work the abstraction stands in for.
// This is the automated layer the Phase 3 plan calls for ("logistics via
// the automated layer (no physical builder required)"). The human
// player's path — physical depots, reservations, the refill aura — is the
// real one; the AI's stocks never touch the map. No RNG in any of it;
// id-ordered iteration throughout.
// ---------------------------------------------------------------------------

/**
 * C1 (2026-10-02): the retired virtual land-depot path used this as its
 * consumer floor ("the AI starts depot-building once it fields this many
 * consumers of one supply type: 4 = a real squad, not a stray or two").
 * Forward depots are now physical and gated on the army floor
 * (FORWARD_DEPOT_MIN_ARMY); the constant is kept for the logistics
 * soak test's consumer-count assertion.
 */
export const LOGISTICS_CONSUMER_THRESHOLD = 4;
/** One supply truck per this many ammo consumers (rounded up). */
const SUPPLY_TRUCK_RATIO = 6;
/** One fuel truck per this many fuel consumers (rounded up). */
const FUEL_TRUCK_RATIO = 6;
/**
 * Honest virtual-depot economics (A10, 2026-10-01). The old flat
 * 12-ammo / 24-fuel per-think trickle was a ~6x hidden cheat: the
 * player mints ammunition at a munitionsFactory's 2.0/s while paying
 * materials 0.4/s + funds 0.6/s of input, and the physical fuelDepot /
 * navalBase PRODUCE nothing — they only pull from the owner's fuel
 * stockpile at FUEL_DEPOT_PULL_RATE_PER_SEC (economy.ts).
 *
 * C1 (AI physical forward base, 2026-10-02): the land-depot chains are
 * ANCHORED to the AI's physical forward-base buildings — stocks accrue
 * ONLY while the matching depot is live, complete and operational
 * (progress >= 1 && operational && hp > 0; see findLiveForwardDepot).
 * Destroying the depot zeros the reserve (thinkForwardDepots). The
 * virtual land-depot construction path is retired; the virtual navalBase
 * sea chain is unchanged (out of C1 scope).
 *
 * A live physical depot is the AI's abstraction for the whole
 * production chain behind it, so it yields that chain's physical rates
 * and pays that chain's physical input costs — never minting from
 * nothing:
 *  - virtual ordnanceDepot ~= one virtual munitionsFactory: yields
 *    effectiveAmmoProduction (2.0/s, Advanced Logistics x1.5 included)
 *    and pays the factory's input (materials 0.4/s + funds 0.6/s);
 *  - virtual fuelDepot / navalBase ~= one virtual oilRefinery: yields
 *    1.5 fuel/s and pays the refinery's input (materials 0.3/s). One
 *    chain per resource — a second depot is a second cache, not a
 *    second refinery (the physical depots only pull from the stockpile).
 *
 * Credited per think, scaled by the think cadence (dtSec), all-or-
 * nothing per think: a chain the AI can't pay for produces nothing
 * that think, exactly like the physical factory's starved-input
 * `continue`. Abstract stocks are capped at the depots' effective
 * storage, like the physical buildings. No RNG; deterministic.
 *
 * Exported for testing (the economics pins call it directly).
 */
export function creditVirtualDepotStocks(world: World, ai: AIPlayerState): void {
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  const dtSec = AI_THINK_TICKS[ai.difficulty] / TICK_HZ;
  // Ammo chain: the live physical ordnanceDepot stands in for the
  // munitionsFactory + depot chain behind it (C1 anchor).
  if (findLiveForwardDepot(world, ai.owner, 'ordnanceDepot') !== undefined) {
    const factoryDef = BUILDING_DEFS.munitionsFactory;
    const ratePerSec = effectiveAmmoProduction(world, ai.owner, factoryDef);
    const materialsCost = (factoryDef.input.materials ?? 0) * dtSec;
    const fundsCost = (factoryDef.input.funds ?? 0) * dtSec;
    if (ratePerSec > 0 && player.materials >= materialsCost && player.funds >= fundsCost) {
      player.materials -= materialsCost;
      player.funds -= fundsCost;
      const cap = effectiveAmmoStorage(world, ai.owner, BUILDING_DEFS.ordnanceDepot);
      ai.virtualAmmoStock = Math.min(cap, (ai.virtualAmmoStock ?? 0) + ratePerSec * dtSec);
    }
  }
  // Fuel chain: the live physical fuelDepot — or the legacy virtual
  // navalBase sea chain (unchanged) — stands in for the oilRefinery +
  // depot chain behind it.
  const fuelDepotLive = findLiveForwardDepot(world, ai.owner, 'fuelDepot') !== undefined;
  const navalBaseVirtual = ai.virtualBuildings.completed.includes('navalBase');
  if (fuelDepotLive || navalBaseVirtual) {
    const refineryDef = BUILDING_DEFS.oilRefinery;
    const ratePerSec = refineryDef.output.fuel ?? 0;
    const materialsCost = (refineryDef.input.materials ?? 0) * dtSec;
    if (ratePerSec > 0 && player.materials >= materialsCost) {
      player.materials -= materialsCost;
      const caps: number[] = [];
      if (fuelDepotLive) {
        caps.push(effectiveFuelStorage(world, ai.owner, BUILDING_DEFS.fuelDepot));
      }
      if (navalBaseVirtual) {
        caps.push(effectiveFuelStorage(world, ai.owner, BUILDING_DEFS.navalBase));
      }
      const cap = Math.max(...caps);
      ai.virtualFuelStock = Math.min(cap, (ai.virtualFuelStock ?? 0) + ratePerSec * dtSec);
    }
  }
}

// ---------------------------------------------------------------------------
// C1 (AI physical forward base, 2026-10-02): the military AI owns REAL
// forward-base buildings once it has established its forward-base
// coordinates. Commander builds a fuelDepot; general adds an
// ordnanceDepot; marshal adds a radarStation; cadet/citizen build none.
// The virtual depot stocks (virtualAmmoStock/virtualFuelStock) are
// ANCHORED to these buildings: they accrue only while the matching
// depot is live, complete and operational, and destroying the depot
// zeros the reserve (creditVirtualDepotStocks).
// ---------------------------------------------------------------------------

/** C1: the physical forward-base building kinds. Exported for tests. */
export type ForwardDepotKind = 'fuelDepot' | 'ordnanceDepot' | 'radarStation';

/**
 * C1: difficulty → physical forward-base roster, in build-priority
 * order. Cadet/citizen: none — they never establish the physical
 * logistics hub.
 */
export const FORWARD_DEPOT_ROSTER: Record<AIDifficulty, ForwardDepotKind[]> = {
  cadet: [],
  citizen: [],
  commander: ['fuelDepot'],
  general: ['fuelDepot', 'ordnanceDepot'],
  marshal: ['fuelDepot', 'ordnanceDepot', 'radarStation'],
};

/**
 * Ticks before a destroyed forward depot may be rebuilt (90
 * sim-seconds): long enough that killing the depot matters, short
 * enough that the AI recovers inside a session. Deterministic.
 */
export const FORWARD_DEPOT_REBUILD_COOLDOWN_TICKS = 2700;

/**
 * Minimum living army to (re)build a forward depot. The 4-unit forward
 * detachment the AI sends when it establishes the base supplies the
 * defense — below that the base can't be held, so don't build.
 */
export const FORWARD_DEPOT_MIN_ARMY = 4;

/**
 * Siting search half-extent, in cells, around the forward-base point.
 * The scan is center-out and deterministic; a think that finds no
 * legal site retries next think (bounded retries on unsuitable
 * terrain — the placePeaceful siting pattern).
 */
const FORWARD_DEPOT_SITE_RADIUS = 10;

/**
 * C1: find a legal site for a forward-depot building near the AI's
 * forward-base point. Bounded center-out scan over the
 * (2*R+1)^2-cell square: candidates are ordered by (dist^2, dz, dx)
 * so the closest legal site wins deterministically, and every
 * candidate goes through validatePlacement (terrain, overlap,
 * affordability — the placePeaceful siting contract). `claimed` holds
 * footprint cells already taken by earlier orders this think.
 * Returns null when no legal site exists — the caller retries next
 * think. No RNG.
 */
function findForwardDepotSite(
  world: World,
  terrain: TerrainData,
  ai: AIPlayerState,
  kind: ForwardDepotKind,
  claimed: Set<number>,
): { cx: number; cz: number } | null {
  const def = BUILDING_DEFS[kind];
  if (!def || !ai.forwardBase) return null;
  const ccx = worldToCell(ai.forwardBase.x);
  const ccz = worldToCell(ai.forwardBase.z);
  const cands: Array<{ cx: number; cz: number; d2: number }> = [];
  for (let dz = -FORWARD_DEPOT_SITE_RADIUS; dz <= FORWARD_DEPOT_SITE_RADIUS; dz++) {
    for (let dx = -FORWARD_DEPOT_SITE_RADIUS; dx <= FORWARD_DEPOT_SITE_RADIUS; dx++) {
      cands.push({ cx: ccx + dx, cz: ccz + dz, d2: dx * dx + dz * dz });
    }
  }
  cands.sort((a, b) => a.d2 - b.d2 || a.cz - b.cz || a.cx - b.cx);
  for (const c of cands) {
    let taken = false;
    for (const cell of footprintCells(c.cx, c.cz, def.footprintW, def.footprintH)) {
      if (claimed.has(cell)) {
        taken = true;
        break;
      }
    }
    if (taken) continue;
    const err = validatePlacement(terrain, world.city, {
      kind,
      owner: ai.owner,
      cx: c.cx,
      cz: c.cz,
      facing: 0,
    });
    // placePeaceful precedent: accept on clean validation; affordability
    // is ledger-guarded by the caller and the command re-validates at
    // apply (loud rejection, never silent).
    if (err === null || err.includes('cannot afford')) {
      return { cx: c.cx, cz: c.cz };
    }
  }
  return null;
}

/**
 * C1: the AI's live forward-depot building of a kind — live means
 * complete (progress >= 1), operational (funded upkeep, not sabotaged)
 * and standing (hp > 0). This is the exact liveness the virtual-stock
 * anchor requires (creditVirtualDepotStocks). Exported for tests.
 */
export function findLiveForwardDepot(
  world: World,
  owner: number,
  kind: ForwardDepotKind,
): BuildingRecord | undefined {
  for (const b of world.city.buildings) {
    if (b.owner === owner && b.kind === kind && b.progress >= 1 && b.operational && (b.hp ?? 0) > 0) {
      return b;
    }
  }
  return undefined;
}

/**
 * C1: reconcile + build the AI's physical forward-base buildings.
 * Called from thinkLogistics (military difficulties) BEFORE
 * creditVirtualDepotStocks, so a destroyed depot's virtual reserve is
 * zeroed before any accrual runs.
 *
 * Per roster kind, in priority order:
 *  1. Adopt: a live building of the kind owned by the AI that isn't
 *     tracked yet (ordered last think — commands apply at the next
 *     tick start — or predating the tracker) is adopted into the
 *     tracker.
 *  2. Reconcile: a tracked building that is gone (destroyBuilding
 *     removes the record) or at 0 hp was destroyed — clear the track,
 *     stamp destroyedTick, and ZERO the matching virtual reserve (the
 *     non-negotiable anchor: no depot, no stock).
 *  3. Build: when nothing is tracked or standing, the rebuild cooldown
 *     has elapsed, the army meets the floor (the 4-unit detachment
 *     supplies defense), the age gate is met and the treasury covers
 *     the cost (ledger-guarded, like placePeaceful), site the building
 *     and issue placeBuilding through the queue. The kind is purged
 *     from virtualBuildings.completed as it goes physical — the real
 *     depot replaces the virtual one, never doubling it.
 *
 * No RNG: siting is a deterministic scan, ordering is roster order.
 * Peaceful worlds never reach here (military defs are locked out there
 * and the military thinks are gated on !world.peaceful). Exported for
 * tests.
 */
export function thinkForwardDepots(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain: TerrainData | undefined,
  armySize: number,
): void {
  if (world.peaceful === true) return;
  const roster = FORWARD_DEPOT_ROSTER[ai.difficulty];
  if (roster.length === 0) return;
  if (!ai.forwardBase) return;
  if (!terrain) return; // no siting without terrain — retry next think
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  const ledger = thinkLedger(ai);
  const tracked = (ai.forwardDepots ??= []);
  // Claim the footprints of tracked live buildings so a new site never
  // overlaps them (validatePlacement would reject anyway; the claim
  // just skips the wasted check).
  const claimed = new Set<number>();
  for (const e of tracked) {
    if (e.buildingId === 0) continue;
    const b = world.city.buildings.find((x) => x.id === e.buildingId);
    if (!b || (b.hp ?? 0) <= 0) continue;
    const def = BUILDING_DEFS[e.kind];
    if (!def) continue;
    for (const cell of footprintCells(b.cx, b.cz, def.footprintW, def.footprintH)) {
      claimed.add(cell);
    }
  }
  for (const kind of roster) {
    let entry = tracked.find((e) => e.kind === kind);
    if (!entry) {
      entry = { kind, buildingId: 0, destroyedTick: -1 };
      tracked.push(entry);
    }
    // --- Adopt / reconcile -----------------------------------------
    if (entry.buildingId === 0) {
      // Ordered but not yet observed (applies next tick), or standing
      // from before the tracker existed: adopt it.
      const existing = world.city.buildings.find(
        (b) => b.owner === ai.owner && b.kind === kind && (b.hp ?? 0) > 0,
      );
      if (existing) entry.buildingId = existing.id;
    } else {
      const b = world.city.buildings.find((x) => x.id === entry.buildingId);
      if (!b || (b.hp ?? 0) <= 0 || b.owner !== ai.owner) {
        // Destroyed. Stamp the cooldown and zero the reserve — the
        // non-negotiable anchor (no depot, no stock).
        entry.buildingId = 0;
        entry.destroyedTick = world.tick;
        if (kind === 'ordnanceDepot') ai.virtualAmmoStock = 0;
        else if (kind === 'fuelDepot') ai.virtualFuelStock = 0;
        // (radarStation anchors no virtual stock.)
      }
    }
    if (entry.buildingId !== 0) continue; // held or building — nothing to do
    // --- Build gates -------------------------------------------------
    if (
      entry.destroyedTick >= 0 &&
      world.tick - entry.destroyedTick < FORWARD_DEPOT_REBUILD_COOLDOWN_TICKS
    ) {
      continue;
    }
    if (armySize < FORWARD_DEPOT_MIN_ARMY) continue;
    const def = BUILDING_DEFS[kind];
    if (!def) continue;
    // The placeBuilding command enforces the age gate at validate; the
    // pre-check avoids futile orders (the thinkVirtualDepot precedent).
    if (!isBuildingAgeMet(getAgeState(world, ai.owner).age, def.minAge)) continue;
    if (player.funds - ledger.funds < def.costFunds) continue;
    if (player.materials - ledger.materials < def.costMaterials) continue;
    const site = findForwardDepotSite(world, terrain, ai, kind, claimed);
    if (!site) continue; // unsuitable terrain — retry next think
    const ok = issue(world, queue, 'placeBuilding', {
      kind,
      owner: ai.owner,
      cx: site.cx,
      cz: site.cz,
      facing: 0,
    });
    if (!ok) continue; // rejected at enqueue — retry next think
    ledger.funds += def.costFunds;
    ledger.materials += def.costMaterials;
    for (const cell of footprintCells(site.cx, site.cz, def.footprintW, def.footprintH)) {
      claimed.add(cell);
    }
    // The physical depot replaces the virtual one: purge the kind from
    // the virtual completed list so creditVirtualEconomy and the stock
    // credit never count it twice (no double-taxing).
    const vc = ai.virtualBuildings.completed;
    const vi = vc.indexOf(kind);
    if (vi >= 0) vc.splice(vi, 1);
  }
}

/**
 * Virtually construct a logistics depot through the same one-at-a-time
 * virtual-building path as production buildings: full cost upfront, online
 * after buildSeconds × 30 ticks, completing in thinkConstruction. No-op
 * when already held (real or virtual), when another construction is in
 * flight, when the def is absent, or when the age gate isn't met.
 */
function thinkVirtualDepot(world: World, ai: AIPlayerState, kind: BuildingKind): void {
  // C1 (AI physical forward base, 2026-10-02): the land-depot kinds are
  // retired from the virtual path — commander+ builds them as physical
  // forward-base buildings (thinkForwardDepots), and cadet/citizen build
  // no depots at all. The virtual navalBase sea chain is unchanged.
  if (kind === 'fuelDepot' || kind === 'ordnanceDepot') return;
  if (hasProductionBuilding(world, ai.owner, kind)) return;
  const vb = ai.virtualBuildings;
  if (vb.constructing) return;
  const def = BUILDING_DEFS[kind];
  if (!def) return;
  if (!isBuildingAgeMet(getAgeState(world, ai.owner).age, def.minAge)) return;
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  // Ledger-aware (see canPayImmediate): the facility payment must not
  // undercut commands already queued this think.
  if (!canPayImmediate(ai, player, def.costFunds, def.costMaterials)) return;
  // Pay the full cost upfront (the virtual-construction precedent).
  player.funds -= def.costFunds;
  player.materials -= def.costMaterials;
  vb.constructing = { kind, readyTick: world.tick + def.buildSeconds * 30 };
}

/**
 * Train the logistics tail: 1 supply truck per 6 ammo consumers, 1 fuel
 * truck per 6 fuel consumers (rounded up), within the army cap. Trucks
 * already fielded get role-specialized service toggles through the real
 * `setSupplyToggles` command (supply trucks: repair+rearm; fuel trucks:
 * refuel only) — idempotent, skipped once set.
 */
function thinkSupplyTrucks(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  ammoConsumers: number,
  fuelConsumers: number,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const cap = AI_MAX_UNITS[ai.difficulty];
  const wantSupply = Math.ceil(ammoConsumers / SUPPLY_TRUCK_RATIO);
  const wantFuel = Math.ceil(fuelConsumers / FUEL_TRUCK_RATIO);
  if ((counts.get('supplyTruck') ?? 0) < wantSupply && n < cap && canTrain(world, ai.owner, 'supplyTruck')) {
    const p = spawnPoint(ai, 'supplyTruck', n);
    if (spawn(world, queue, ai, 'supplyTruck', p.x, p.z)) {
      ai.builtCounts['supplyTruck'] = (ai.builtCounts['supplyTruck'] ?? 0) + 1;
    }
  } else if ((counts.get('fuelTruck') ?? 0) < wantFuel && n < cap && canTrain(world, ai.owner, 'fuelTruck')) {
    const p = spawnPoint(ai, 'fuelTruck', n);
    if (spawn(world, queue, ai, 'fuelTruck', p.x, p.z)) {
      ai.builtCounts['fuelTruck'] = (ai.builtCounts['fuelTruck'] ?? 0) + 1;
    }
  }
  // Role-specialize via the real command (rejections — e.g. the truck
  // died between think and apply — are swallowed by issue()).
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    if (u.supplyServices !== undefined) continue;
    if (u.kind === 'supplyTruck') {
      issue(world, queue, 'setSupplyToggles', {
        unitId: u.id, owner: ai.owner, repair: true, rearm: true, refuel: false,
      });
    } else if (u.kind === 'fuelTruck') {
      issue(world, queue, 'setSupplyToggles', {
        unitId: u.id, owner: ai.owner, repair: false, rearm: false, refuel: true,
      });
    }
  }
}

/**
 * Abstract resupply: consumer units draw top-ups from the AI's virtual
 * depot stocks (id order). This is the one sanctioned exception to "the
 * AI never mutates world state directly" besides its own `world.ai`
 * record and the virtual-economy credit: it does exactly what the
 * production workstream's refill aura does for physical depots, for an AI
 * that has no physical depots to route to. No RNG.
 */
function thinkAbstractResupply(world: World, ai: AIPlayerState): void {
  let ammoStock = ai.virtualAmmoStock ?? 0;
  let fuelStock = ai.virtualFuelStock ?? 0;
  if (ammoStock <= 0 && fuelStock <= 0) return;
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def) continue;
    if (ammoStock > 0 && (def.ammoCapacity ?? 0) > 0 && u.ammo < (def.ammoCapacity as number)) {
      const take = Math.min((def.ammoCapacity as number) - u.ammo, ammoStock);
      u.ammo += take;
      ammoStock -= take;
    }
    if (
      fuelStock > 0 &&
      def.fuelType === 'fossil' &&
      (def.fuelCapacity ?? 0) > 0 &&
      u.fuel < (def.fuelCapacity as number)
    ) {
      const take = Math.min((def.fuelCapacity as number) - u.fuel, fuelStock);
      u.fuel += take;
      fuelStock -= take;
    }
  }
  ai.virtualAmmoStock = ammoStock;
  ai.virtualFuelStock = fuelStock;
}

/**
 * Ammo-dry retreats: magazine units at 0 ammo break off and fall back
 * toward the base instead of chasing enemies they cannot shoot. Called
 * from the combat thinks (citizen, commander — general/marshal inherit
 * via thinkCommander). Units already holding (idle, no target) stay put.
 * No RNG; id-ordered.
 */
function thinkAmmoRetreats(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def || (def.ammoCapacity ?? 0) <= 0) continue;
    if (u.ammo > 0) continue;
    if (u.chasing || u.targetId !== 0) {
      moveTo(world, queue, ai.owner, u.id, ai.baseX, ai.baseZ);
    }
  }
}

// ---------------------------------------------------------------------------
// Sea-logistics Half B (2026-10-01): marshal's naval supply tail.
// ---------------------------------------------------------------------------

/** One fleet oiler per this many sea combat units (rounded up). */
const NAVAL_FUEL_SHIP_RATIO = 6;
/** One ammunition ship per this many missile-armed sea units (rounded up). */
const NAVAL_AMMO_SHIP_RATIO = 4;
/**
 * A supply ship further than this (world units) from the fleet centroid
 * gets a moveTo toward it; closer ships hold station — no order spam
 * every think, since the mobile-supply aura does the work in radius.
 */
const NAVAL_SUPPLY_RALLY_DISTANCE = 40;

/**
 * Marshal-only naval logistics (coastal maps only): train the fleet's
 * supply tail — 1 fuelTanker per 6 sea combat units, 1 ammoShip per 4
 * missile-armed sea units (rounded up, within the army cap, one per
 * think like thinkProduction) — then service the existing tail:
 *   - role-specialize through the real `setSupplyToggles` command
 *     (fuelTanker: refuel only; ammoShip: rearm only — idempotent,
 *     skipped once set, like the truck tail);
 *   - load the holds from the virtual depot stocks through the real
 *     `loadCargoVirtual` command (the AI's virtual docks — a completed
 *     virtual navalBase; validated at enqueue AND at apply like the
 *     player's `loadCargo`, per-ship takes reserved so a queued load
 *     can never go stale). Materials deliberately skipped: the AI's
 *     materials are a global stockpile, so a visible materials hold
 *     would be theater;
 *   - sail idle supply ships toward the fleet centroid (or the probed
 *     water when no combat fleet exists yet) — the real
 *     `runMobileSupply` aura discharges their holds automatically in
 *     radius 30, honoring the toggles above.
 * Called from thinkMarshal after thinkGeneral (which runs the land
 * logistics thinks first — the ships load from the virtual stocks'
 * remainder). No RNG; id-ordered iteration.
 */
function thinkNavalSupply(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  if (ai.difficulty !== 'marshal') return;
  if (ai.navalStatus !== 'coastal') return;
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const cap = AI_MAX_UNITS[ai.difficulty];
  let seaCombat = 0;
  let seaMissile = 0;
  let cx = 0;
  let cz = 0;
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def || def.domain !== 'sea') continue;
    if (def.damage > 0) {
      seaCombat++;
      cx += u.x;
      cz += u.z;
    }
    if ((def.ammoCapacity ?? 0) > 0) seaMissile++;
  }
  // Train the tail (one ship per think at most — the else-if).
  const wantFuel = Math.ceil(seaCombat / NAVAL_FUEL_SHIP_RATIO);
  const wantAmmo = Math.ceil(seaMissile / NAVAL_AMMO_SHIP_RATIO);
  if (seaCombat > 0 && (counts.get('fuelTanker') ?? 0) < wantFuel && n < cap && canTrain(world, ai.owner, 'fuelTanker')) {
    const p = spawnPoint(ai, 'fuelTanker', n);
    if (spawn(world, queue, ai, 'fuelTanker', p.x, p.z)) {
      ai.builtCounts['fuelTanker'] = (ai.builtCounts['fuelTanker'] ?? 0) + 1;
    }
  } else if (
    seaMissile > 0 &&
    (counts.get('ammoShip') ?? 0) < wantAmmo &&
    n < cap &&
    canTrain(world, ai.owner, 'ammoShip')
  ) {
    const p = spawnPoint(ai, 'ammoShip', n);
    if (spawn(world, queue, ai, 'ammoShip', p.x, p.z)) {
      ai.builtCounts['ammoShip'] = (ai.builtCounts['ammoShip'] ?? 0) + 1;
    }
  }
  // Naval-building model (2026-10-01, Worker B): the marshal's
  // forward naval logistics. The navalBase sits on the marshal's
  // construction priority right after the navalYard (coastal-gated,
  // like the yards); this call is the top-up for thinks where the
  // slot is free and the priority pass hasn't reached it yet — the
  // same pattern as the land depots in thinkLogistics. A completed
  // virtual navalBase feeds the fleet's fuel chain (credited in
  // thinkLogistics' creditVirtualDepotStocks, at honest refinery
  // economics — never minted from nothing) and is the AI's virtual
  // docks: supply ships load their holds through the `loadCargoVirtual`
  // command below. Deterministic: no RNG, id-ordered, through the
  // standard virtual-construction path (the AI never owns physical
  // buildings, so physical loadCargo orders are impossible for it).
  if (seaCombat > 0) {
    thinkVirtualDepot(world, ai, 'navalBase');
  }
  // Service the tail. Per-ship hold takes are reserved against the
  // virtual stocks as they are issued (below): a same-think sibling
  // must not be able to drain the stock first and leave a queued
  // `loadCargoVirtual` stale at apply — a stale command throws out of
  // applyDue and crashes runTick.
  let fuelReserved = 0;
  let ammoReserved = 0;
  // Service the tail.
  let rallyX = ai.navalWater?.x ?? ai.baseX;
  let rallyZ = ai.navalWater?.z ?? ai.baseZ;
  if (seaCombat > 0) {
    rallyX = cx / seaCombat;
    rallyZ = cz / seaCombat;
  }
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    if (u.kind !== 'fuelTanker' && u.kind !== 'ammoShip') continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (u.supplyServices === undefined) {
      if (u.kind === 'fuelTanker') {
        issue(world, queue, 'setSupplyToggles', {
          unitId: u.id, owner: ai.owner, repair: false, rearm: false, refuel: true,
        });
      } else {
        issue(world, queue, 'setSupplyToggles', {
          unitId: u.id, owner: ai.owner, repair: false, rearm: true, refuel: false,
        });
      }
    }
    // A10: hold-loading goes through the `loadCargoVirtual` command
    // (the AI's virtual docks) instead of direct mutation — validated
    // at enqueue AND at apply, like the player's `loadCargo`, with the
    // same economics (hold caps, stock limits, ammo floored). The take
    // is reserved against the virtual stock on issue so the command
    // cannot go stale at apply.
    if (u.kind === 'fuelTanker') {
      const holdCap = def?.cargoFuelCapacity ?? 0;
      const need = holdCap - u.cargoFuel;
      const take = Math.min(Math.max(0, need), (ai.virtualFuelStock ?? 0) - fuelReserved);
      if (take > 0) {
        if (issue(world, queue, 'loadCargoVirtual', { unitId: u.id, owner: ai.owner })) {
          fuelReserved += take;
        }
      }
    } else {
      const holdCap = def?.cargoAmmoCapacity ?? 0;
      const need = Math.floor(holdCap - u.cargoAmmo);
      const take = Math.min(Math.max(0, need), Math.floor(ai.virtualAmmoStock ?? 0) - ammoReserved);
      if (take >= 1) {
        if (issue(world, queue, 'loadCargoVirtual', { unitId: u.id, owner: ai.owner })) {
          ammoReserved += take;
        }
      }
    }
    if (u.state === 'idle' && u.targetId === 0) {
      const dx = u.x - rallyX;
      const dz = u.z - rallyZ;
      if (dx * dx + dz * dz > NAVAL_SUPPLY_RALLY_DISTANCE * NAVAL_SUPPLY_RALLY_DISTANCE) {
        moveTo(world, queue, ai.owner, u.id, rallyX, rallyZ);
      }
    }
  }
}

/**
 * Phase 4 transport (S7, grand expansion): the civilian-transport AI
 * hook — deliberately a NO-OP in 0.1 Alpha. PLAN §6 requires every new
 * unit/building to ship with its AI entry in the same change; when the
 * entry is "the AI doesn't touch this", it is documented here instead
 * of left silent.
 *
 * Why the Classic AI ignores the whole transport roster:
 * - The Classic AI is a MILITARY rival (cadet…marshal). Buses, trams,
 *   passenger/freight trains and ferries are civilian fare/freight
 *   movers with no combat role (targets 'none') — training them would
 *   burn army-cap slots for zero military value.
 * - PLAN §6 defers the civilian AI trader rival ("transport/airline/
 *   peaceful: civilian AI trader rival is a later feature"). The think
 *   function that will actually run civilian transit belongs to that
 *   future rival, not to this one.
 * - The AI owns no physical buildings (C1 forward depots excepted),
 *   roads or rails in 0.1 Alpha (all virtual), so it cannot lay the
 *   networks civilian transport needs. railStation / busDepot / ferryTerminal / marina stay off
 *   CONSTRUCTION_PRIORITY for the same reason — and so do the seven
 *   tiered transit stops/stations (busStop, taxiStand, tramStop,
 *   ferryPier, neighborhoodStation, centralStation,
 *   airportInterchange): they are civilian passenger infrastructure
 *   with no military value, and the AI has no passengers to serve.
 * - `canTrain` already auto-skips the gated kinds (bus/tram need a
 *   busDepot, trains a railStation, ferries a ferryTerminal), so the
 *   production composition code needs no changes to stay safe.
 *
 * Exported so tests can pin the no-op (world digest unchanged across a
 * think with transport units AND transit stops present).
 */
export function thinkCivilianTransport(world: World, ai: AIPlayerState): void {
  void world;
  void ai;
}

/**
 * Phase 4 transport: road classes need NO AI-side wiring — documented
 * here as a deliberate no-op (same convention as thinkCivilianTransport
 * above) rather than left silent. Reasons:
 * - Pathfinding reads the per-class move cost directly
 *   (`cellMoveCost` consults ROAD_CLASS_STATS), so AI units already
 *   prefer highways over dirt without any AI code knowing about classes.
 * - The Classic AI never lays roads at all (roads are optional since
 *   the 2026-09-30 directive — the AI's cities develop with zero roads),
 *   so there is no build/upgrade decision to make.
 * - `upgradeRoad` is a player-initiated in-place upgrade (difference
 *   pricing); the AI has no roads to upgrade and no economy reason to
 *   want any.
 * Exported so tests can pin the no-op (world digest unchanged across a
 * think with mixed road classes present).
 */
export function thinkRoadClasses(world: World, ai: AIPlayerState): void {
  void world;
  void ai;
}

/**
 * Per-think logistics: depot construction, truck ratios, abstract
 * resupply, ammo-dry retreats. Called from thinkCitizen and
 * thinkCommander (general/marshal inherit); cadet never calls it —
 * cadet fields rifles only, which track neither fuel nor ammo.
 */
function thinkLogistics(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain?: TerrainData,
): void {
  let ammoConsumers = 0;
  let fuelConsumers = 0;
  let n = 0;
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    n++;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def) continue;
    if ((def.ammoCapacity ?? 0) > 0) ammoConsumers++;
    if (def.fuelType === 'fossil' && (def.fuelCapacity ?? 0) > 0) fuelConsumers++;
  }
  // C1 (AI physical forward base): reconcile + build the real
  // forward-base depots BEFORE the stock credit, so a destroyed depot's
  // reserve is zeroed before any accrual runs. The retired virtual
  // land-depot path no longer serves fuelDepot/ordnanceDepot — the
  // physical buildings are the single source of truth (no
  // double-building, no double-crediting).
  thinkForwardDepots(world, queue, ai, terrain, n);
  // Completed physical depots yield abstract stocks each think, at
  // honest production economics (creditVirtualDepotStocks): physical
  // rates, physical input costs, storage-capped — never from nothing.
  creditVirtualDepotStocks(world, ai);
  thinkSupplyTrucks(world, queue, ai, ammoConsumers, fuelConsumers);
  thinkAbstractResupply(world, ai);
  thinkAmmoRetreats(world, queue, ai);
}

/**
 * Per-difficulty virtual tax stipend factors (R1 final-review C2,
 * 2026-10-01). The Classic AI's funds-income paths in economy.ts are
 * effectively closed to it even under C1 (2026-10-02): its physical
 * forward-base buildings sit in UTILITY_ZONE (runTaxes skips them),
 * none has a harvest (runHarvest), and the marshal's radarStation earns
 * only a negligible research trickle via runProduction. Trade routes
 * need physical commercial buildings; kill bounties don't exist.
 * Without a stipend the age ladder is arithmetically unreachable
 * (industry costs 6000 funds against the 4000 starting-funds lifetime
 * budget — the Phase 9 soak's "marshals reached connectivity; industry
 * never reached"). Cadet keeps 0: it builds nothing and spends nothing,
 * by design.
 */
const VIRTUAL_TAX_FACTOR: Record<AIDifficulty, number> = {
  cadet: 0,
  citizen: 0.5,
  commander: 1.0,
  general: 1.5,
  marshal: 2.0,
};

/**
 * Share of the virtual tax stipend the AI's abstract industry
 * reinvests as materials each economy tick, at the fixed market buy
 * price (`marketBuyCost`). Funds alone don't reach industry age (6000
 * funds + 2500 materials + 100 influence): the warFactory's 0.5
 * materials/s trickle covers barely a fifth of the lifetime materials
 * bill, so the virtual economy buys the rest on the market exactly as
 * a human player would. Deterministic — a pure function of the
 * completed virtual buildings and the difficulty factor.
 */
const VIRTUAL_MATERIALS_REINVEST_SHARE = 0.5;

/**
 * Virtual-building economy: completed virtual buildings yield their
 * def.output rates (per sim-second), credited on the 1 Hz economy
 * cadence — the same tick the economy system runs for real buildings.
 * This is what gives the AI lab research income (and the barracks /
 * warFactory trickles). Upkeep is intentionally waived (see header).
 *
 * R1 final-review C2 (2026-10-01) — the AI's real economy path. Two
 * funds credits close the zero-income gap:
 *
 * 1. def.harvest — completed virtual buildings credit their harvest
 *    rates (per sim-second, mirroring runHarvest's economy-tick
 *    credit). This is what makes the marshal's civilAirport landing
 *    fees real (harvest: { funds: 1.0 }).
 * 2. A modest virtual tax stipend, scaled by difficulty. Each
 *    completed virtual building pays tax on its def.taxBasePerSec
 *    exactly like a physical building (runTaxes: rate × taxBasePerSec
 *    × period), at the fixed 10% DEFAULT_TAX_RATE (the AI runs no tax
 *    policy) times VIRTUAL_TAX_FACTOR[difficulty]. Formula, per
 *    economy tick (1 sim-second):
 *      funds += Σ taxBasePerSec × 0.10 × factor
 *    e.g. a late-game marshal (≈66 tax base across 9 production
 *    buildings + intel + depots) × 0.10 × 2.0 ≈ 13 funds/s — enough
 *    to accumulate toward the industry age over a long soak without
 *    flooding the early game. The peaceful AI holds no virtual
 *    buildings, so the stipend is a no-op for it (no cross-mode
 *    impact).
 *
 * Materials leg: half the stipend is reinvested as materials at the
 * market buy price (VIRTUAL_MATERIALS_REINVEST_SHARE × stipend ÷
 * marketBuyCost('materials', 1) materials per sim-second) — the
 * industry age's 2500-material cost is unreachable on the warFactory
 * trickle alone. Influence still comes from the mediaCenter's
 * def.output (0.8/s → 100 influence in ~125 s), unchanged.
 *
 * Deterministic: no RNG, owner-ordered iteration, pure function of
 * (completed virtual buildings, difficulty).
 */
function creditVirtualEconomy(world: World): void {
  if (world.tick % 30 !== 0) return;
  for (const ai of world.ai.players) {
    const player = getPlayer(world.city, ai.owner);
    if (!player) continue;
    const stocks = player as unknown as Record<string, number>;
    let taxBase = 0;
    for (const kind of ai.virtualBuildings.completed) {
      const def = BUILDING_DEFS[kind];
      for (const [res, rate] of Object.entries(def.output)) {
        stocks[res] = (stocks[res] ?? 0) + (rate ?? 0);
      }
      // R1 C2: harvest income (the marshal's civilAirport landing
      // fees) — mirrors runHarvest's per-economy-tick credit.
      if (def.harvest) {
        for (const [res, rate] of Object.entries(def.harvest)) {
          if ((rate ?? 0) > 0) stocks[res] = (stocks[res] ?? 0) + (rate ?? 0);
        }
      }
      taxBase += def.taxBasePerSec ?? 0;
    }
    const factor = VIRTUAL_TAX_FACTOR[ai.difficulty] ?? 0;
    if (factor > 0 && taxBase > 0) {
      const stipend = taxBase * DEFAULT_TAX_RATE * factor;
      player.funds += stipend;
      // Materials leg: buy on the fixed-rate market, like a player.
      player.materials += (stipend * VIRTUAL_MATERIALS_REINVEST_SHARE) / marketBuyCost('materials', 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Composition (spec §7.2): counters first, then base-mix shares of the cap
// ---------------------------------------------------------------------------

/** Base-mix shares of the army cap (spec §7.2), per decision level. */
const BASE_MIX: Record<'citizen' | 'commander', Array<{ kind: UnitKind; share: number }>> = {
  citizen: [
    { kind: 'rifles', share: 0.35 },
    { kind: 'tank', share: 0.25 },
    { kind: 'artillery', share: 0.15 },
    { kind: 'aa', share: 0.15 },
    { kind: 'spectre', share: 0.1 },
  ],
  commander: [
    { kind: 'rifles', share: 0.25 },
    { kind: 'tank', share: 0.17 },
    { kind: 'artillery', share: 0.1 },
    { kind: 'aa', share: 0.1 },
    { kind: 'apc', share: 0.1 },
    { kind: 'sniperTeam', share: 0.05 },
    { kind: 'spectre', share: 0.05 },
    { kind: 'fighter', share: 0.05 },
    { kind: 'attackHeli', share: 0.05 },
    // Grand-expansion Phase 5 (aircraft expansion, S4): heavy CAS and
    // long-range strike join the commander's air arm in small shares.
    // (Deliberately NOT in MIX_JITTER_KINDS — adding kinds there would
    // shift the per-match personality RNG stream. They default to
    // weight 1 via the `?? 1` in the mix consumer above.)
    { kind: 'gunship', share: 0.04 },
    { kind: 'strategicBomber', share: 0.03 },
    // Phase 9 balance pass (pathology 6): recon and command. The
    // reconTeam gives the commander eyes (it was never in the mix —
    // the AI scouted with combat units or not at all). The hq's
    // +25% damage aura (radius 20) is worth a small share; the AI
    // only ever needs one, so the share is tiny.
    { kind: 'reconTeam', share: 0.03 },
    { kind: 'hq', share: 0.02 },
  ],
};

const KIND_OF = (u: UnitRecord): UnitKind => u.kind as UnitKind;
const DOMAIN_OF = (u: UnitRecord): string => UNIT_DEFS[KIND_OF(u)].domain;
const ARMOR_OF = (u: UnitRecord): string => UNIT_DEFS[KIND_OF(u)].armor;

/**
 * Enemy heavy armor for counter purposes (A6, 2026-10-01): matches the
 * variant BASE kind, so a Mk3 tank still triggers the tank counter.
 * Exported for testing.
 */
export function isCounterHeavy(kind: UnitKind): boolean {
  const base = variantBaseOf(kind);
  return base === 'tank' || base === 'tankDestroyer';
}

/**
 * Enemy artillery for counter purposes (A6, 2026-10-01): variant-aware,
 * as above. Exported for testing.
 */
export function isCounterArty(kind: UnitKind): boolean {
  const base = variantBaseOf(kind);
  return base === 'artillery' || base === 'mlrs';
}

/**
 * Pick the next unit kind to train. Counter logic (spec §7.2) runs
 * first — each branch gated by canTrain so locked kinds are skipped —
 * then the base mix fills whatever is furthest below its share.
 * Always returns a trainable kind (rifles is the un-gated backbone).
 */
function chooseUnitKind(
  world: World,
  ai: AIPlayerState,
  counts: Map<UnitKind, number>,
  visible: UnitRecord[],
): UnitKind {
  const owner = ai.owner;
  const fullCounters = ai.difficulty !== 'citizen';
  const get = (k: UnitKind): number => counts.get(k) ?? 0;

  if (visible.length > 0) {
    const enemyAir = visible.filter((e) => DOMAIN_OF(e) === 'air');
    // Phase 6: the sub/capital sets include the §3.6 roster kinds
    // (coastalSub, missileSub, cruiser, battleship, heavyDestroyer) —
    // def-guarded via SUB_KINDS/CAPITAL_KINDS, so today's behavior is
    // unchanged until the naval workstream lands.
    const enemySubs = visible.filter((e) => SUB_KINDS.has(e.kind));
    const enemyCapitals = visible.filter((e) => CAPITAL_KINDS.has(e.kind));
    const enemyHeavy = visible.filter(
      // A6 (2026-10-01): variant-aware via isCounterHeavy — a Mk3 tank
      // is still a tank for counter purposes.
      (e) => DOMAIN_OF(e) === 'land' && isCounterHeavy(KIND_OF(e)),
    );
    const enemyLight = visible.filter(
      (e) =>
        DOMAIN_OF(e) === 'land' &&
        (KIND_OF(e) === 'rifles' || KIND_OF(e) === 'sniperTeam') &&
        ARMOR_OF(e) === 'light',
    );
    const enemyArty = visible.filter(
      // A6 (2026-10-01): variant-aware via isCounterArty.
      (e) => isCounterArty(KIND_OF(e)),
    );
    const enemyNavy = visible.filter((e) => DOMAIN_OF(e) === 'sea');

    // vs air: aa up to air+1, then fighters.
    if (enemyAir.length > 0 && get('aa') < enemyAir.length + 1 && canTrain(world, owner, 'aa')) {
      return 'aa';
    }
    if (fullCounters && enemyAir.length > 0 && get('fighter') < 2 && canTrain(world, owner, 'fighter')) {
      return 'fighter';
    }
    // vs subs: frigate screen, ×2 per sub.
    if (
      fullCounters &&
      enemySubs.length > 0 &&
      get('frigate') < enemySubs.length * 2 &&
      canTrain(world, owner, 'frigate')
    ) {
      return 'frigate';
    }
    // vs capitals: submarines, else a missile-boat pack.
    if (fullCounters && enemyCapitals.length > 0) {
      if (get('submarine') < 2 && canTrain(world, owner, 'submarine')) return 'submarine';
      if (get('missileBoat') < 3 && canTrain(world, owner, 'missileBoat')) return 'missileBoat';
    }
    // vs heavy armor: tank destroyers first, then artillery.
    if (fullCounters && enemyHeavy.length >= 3) {
      if (
        get('tankDestroyer') < Math.min(enemyHeavy.length, 4) &&
        canTrain(world, owner, 'tankDestroyer')
      ) {
        return 'tankDestroyer';
      }
      if (get('artillery') < 3 && canTrain(world, owner, 'artillery')) return 'artillery';
    }
    // vs light masses: apc, else mlrs, else artillery.
    if (fullCounters && enemyLight.length >= 4) {
      if (canTrain(world, owner, 'apc')) return 'apc';
      if (canTrain(world, owner, 'mlrs')) return 'mlrs';
      if (canTrain(world, owner, 'artillery')) return 'artillery';
    }
    // vs artillery parks: spectres slip inside minRange; snipers outrange
    // the crews; fighter-bombers strike from above.
    if (fullCounters && enemyArty.length >= 2) {
      if (canTrain(world, owner, 'spectre')) return 'spectre';
      if (canTrain(world, owner, 'sniperTeam')) return 'sniperTeam';
      if (canTrain(world, owner, 'fighterBomber')) return 'fighterBomber';
    }
    // vs any navy on a coastal map: a frigate screen before capitals.
    if (
      fullCounters &&
      enemyNavy.length > 0 &&
      ai.navalStatus === 'coastal' &&
      get('frigate') === 0 &&
      canTrain(world, owner, 'frigate')
    ) {
      return 'frigate';
    }
  }

  // Force multiplier: one medic per ~12 land combat units (commander+).
  if (fullCounters && canTrain(world, owner, 'combatMedic')) {
    let landCombat = 0;
    for (const [kind, n] of counts) {
      const def = UNIT_DEFS[kind];
      if (def.domain === 'land' && def.damage > 0) landCombat += n;
    }
    const want = landCombat >= 8 ? Math.max(1, Math.floor(landCombat / 12)) : 0;
    if (get('combatMedic') < want) return 'combatMedic';
  }

  // Basic navy maintenance on coastal maps (general+ only). The probe
  // itself (thinkNavalProbe) runs for commander+ so the naval counters
  // above can find water to launch from.
  if (
    (ai.difficulty === 'general' || ai.difficulty === 'marshal') &&
    ai.navalStatus === 'coastal'
  ) {
    if (get('fishingBoat') < 4 && canTrain(world, owner, 'fishingBoat')) return 'fishingBoat';
    if (get('patrolBoat') < 3 && canTrain(world, owner, 'patrolBoat')) return 'patrolBoat';
    if (get('missileBoat') < 3 && canTrain(world, owner, 'missileBoat')) return 'missileBoat';
    // Phase 6 (PLAN §3.6): the corvette joins the coastal screen once
    // the naval workstream lands its def — canTrain is false until
    // then, so this line is inert today (the def-guard convention).
    const corvette = 'corvette' as UnitKind;
    if ((counts.get(corvette) ?? 0) < 2 && canTrain(world, owner, corvette)) return corvette;
  }

  // Base mix: the trainable kind furthest below its share of the cap.
  const mix = BASE_MIX[ai.difficulty === 'citizen' ? 'citizen' : 'commander'];
  const cap = AI_MAX_UNITS[ai.difficulty];
  let best: UnitKind | null = null;
  let bestScore = -Infinity;
  for (const { kind, share } of mix) {
    if (!canTrain(world, owner, kind)) continue;
    // Personality jitters each kind's share ±30% (missing kinds count as
    // 1): matches feel different, while the counter framework above — the
    // part that defines the difficulty's skill — is untouched.
    const weight = ai.personality.mixWeights[kind] ?? 1;
    const score = share * cap * weight - get(kind);
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }
  // Everything at share (or nothing trainable): keep building the rifles
  // backbone — the one kind that is never gated.
  if (best === null || bestScore <= 0) return 'rifles';
  return best;
}

/**
 * Nearest dry point to (x, z) within `radius` world units, or null when
 * everything in reach is water. Deterministic expanding-square spiral
 * (4-unit steps — the land-unit spawn jitter is ±6, so a dry 4-grid
 * point is a usable rally). Used for the forward-base water check
 * (Phase 9 soak finding 6.2): the midpoint toward a visible enemy can
 * be a river, and a water forward base rejects every land-unit spawn.
 */
function nearestLand(
  terrain: TerrainData,
  x: number,
  z: number,
  radius: number,
): { x: number; z: number } | null {
  if (!isWater(terrain, x, z)) return { x, z };
  const step = 4;
  for (let r = step; r <= radius; r += step) {
    for (let dz = -r; dz <= r; dz += step) {
      for (let dx = -r; dx <= r; dx += step) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!isWater(terrain, x + dx, z + dz)) return { x: x + dx, z: z + dz };
      }
    }
  }
  return null;
}

/** How far the forward-base water check searches for dry land. */
const FORWARD_BASE_WATER_SEARCH_RADIUS = 48;

/** Where a new unit spawns: sea kinds at the probed water, else base. */
function spawnPoint(ai: AIPlayerState, kind: UnitKind, n: number): { x: number; z: number } {
  if (UNIT_DEFS[kind].domain === 'sea' && ai.navalWater) {
    return { x: ai.navalWater.x, z: ai.navalWater.z };
  }
  const bx = ai.forwardBase ? ai.forwardBase.x : ai.baseX;
  const bz = ai.forwardBase ? ai.forwardBase.z : ai.baseZ;
  return { x: bx + (n % 4) * 4 - 6, z: bz + Math.floor(n / 4) * 4 - 6 };
}

/** Train one unit per think tick (the production step). */
function thinkProduction(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  counts: Map<UnitKind, number>,
  n: number,
  visible: UnitRecord[],
): void {
  if (n >= AI_MAX_UNITS[ai.difficulty]) return;
  // Grand-expansion Phase 8 (tech levels, workstream D, 2026-09-30),
  // M15 tradeoff redesign (2026-10-01): substitute the SITUATIONAL pick
  // for the chosen kind — variants are tactical tradeoffs, not ladders,
  // so `chooseVariant` takes the top tier when rich and the best
  // value/cost otherwise (the AI must actually use the new content —
  // PLAN §6 "no AI capability cliff"). The ledger is passed so
  // affordability is judged on the same reservations `spawn` enforces
  // below; when nothing qualifies the chosen kind returns unchanged
  // (base kinds without variants included). The counter/base-mix logic
  // above is untouched — this is a substitution, not a rewrite.
  const kind = chooseVariant(world, ai.owner, chooseUnitKind(world, ai, counts, visible), thinkLedger(ai));
  const p = spawnPoint(ai, kind, n);
  if (spawn(world, queue, ai, kind, p.x, p.z)) {
    ai.builtCounts[kind] = (ai.builtCounts[kind] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Upgrade research (spec §7.4, commander+)
// ---------------------------------------------------------------------------

interface ResearchCandidate {
  id: UpgradeId;
  /** Extra condition beyond the def's own prereqs (force shape). */
  when: (world: World, ai: AIPlayerState, counts: Map<UnitKind, number>) => boolean;
}

const always: ResearchCandidate['when'] = () => true;
const vehiclesAtLeast =
  (n: number): ResearchCandidate['when'] =>
  (_w, _a, counts) => {
    let v = 0;
    for (const k of ['tank', 'apc', 'tankDestroyer', 'artillery', 'mlrs', 'aa'] as UnitKind[]) {
      v += counts.get(k) ?? 0;
    }
    return v >= n;
  };
const aircraftAtLeast =
  (n: number): ResearchCandidate['when'] =>
  (_w, _a, counts) => {
    let v = 0;
    for (const k of ['fighter', 'fighterBomber', 'attackHeli', 'awacs'] as UnitKind[]) {
      v += counts.get(k) ?? 0;
    }
    return v >= n;
  };

/** Research priority (spec §7.4), then the economy line by cost order. */
const RESEARCH_PRIORITY: ResearchCandidate[] = [
  { id: 'apRounds', when: always },
  { id: 'compositeArmor', when: always },
  { id: 'engineTuning', when: vehiclesAtLeast(4) },
  { id: 'sonarSuite', when: (w, ai) => ai.seenSubmarine },
  { id: 'advancedAvionics', when: aircraftAtLeast(3) },
  { id: 'droneOptics', when: always },
  {
    id: 'fieldMedicine',
    when: (_w, _a, counts) => {
      let infantry = 0;
      for (const k of ['rifles', 'sniperTeam', 'spectre'] as UnitKind[]) infantry += counts.get(k) ?? 0;
      return (counts.get('combatMedic') ?? 0) >= 1 || infantry >= 6;
    },
  },
  { id: 'precisionManufacturing', when: always },
  { id: 'smartGrid', when: always },
  { id: 'verticalFarming', when: always },
  { id: 'cruiseMissiles', when: always },
  { id: 'freeTrade', when: always },
  // Roadmap B9 (2026-10-02): Advanced Research is the repeatable
  // endgame sink — last in RESEARCH_PRIORITY so every one-shot upgrade
  // comes first. It is EXCLUDED from the personality shuffle
  // (derivePersonality) and re-appended fixed-last by researchOrderFor:
  // a repeatable sink must never be shuffled ahead of the economy
  // upgrades it is meant to follow.
  { id: 'advancedResearch', when: always },
];

/** ResearchCandidate lookup by id (for personality-ordered iteration). */
const RESEARCH_BY_ID = new Map<UpgradeId, ResearchCandidate>(
  RESEARCH_PRIORITY.map((c) => [c.id, c]),
);

/**
 * This match's research order: the spec'd combat/support head (pinned),
 * then the economy line in the AI's personality order. A legacy/empty
 * personality falls back to the default RESEARCH_PRIORITY order.
 */
function researchOrderFor(ai: AIPlayerState): ResearchCandidate[] {
  const head = RESEARCH_PRIORITY.slice(0, RESEARCH_HEAD_COUNT);
  // The economy tail (personality-shuffled, or priority order when the
  // personality carries none). Repeatable sinks are excluded here —
  // they are appended fixed-last below, never shuffled.
  const tailPool = RESEARCH_PRIORITY.slice(RESEARCH_HEAD_COUNT).filter(
    (c) => UPGRADE_DEFS[c.id].repeatable !== true,
  );
  const tailIds =
    ai.personality.researchOrder.length > 0
      ? ai.personality.researchOrder
      : tailPool.map((c) => c.id);
  const tail: ResearchCandidate[] = [];
  for (const id of tailIds) {
    const cand = RESEARCH_BY_ID.get(id);
    if (cand) tail.push(cand);
  }
  // Roadmap B9: repeatable upgrades (Advanced Research) are the fixed
  // end-of-line sink — researched dead last, after every one-shot, in
  // priority order among themselves. thinkResearch's hasUpgrade skip
  // never fires for them (levels live on world.upgradeLevels), so the
  // AI keeps converting surplus research into factory output until the
  // 200×level price outruns its research income.
  const sinks = RESEARCH_PRIORITY.filter((c) => UPGRADE_DEFS[c.id].repeatable === true);
  return [...head, ...tail, ...sinks];
}

/** Research one upgrade per think tick, by priority, when prereqs allow. */
function thinkResearch(world: World, queue: CommandQueue, ai: AIPlayerState, counts: Map<UnitKind, number>): void {
  // Research happens at the lab (real or virtually constructed).
  if (!hasProductionBuilding(world, ai.owner, 'lab')) return;
  for (const { id, when } of researchOrderFor(ai)) {
    if (hasUpgrade(world, ai.owner, id)) continue;
    if (!when(world, ai, counts)) continue;
    // Mirror researchUpgrade's own validation (age, building prereqs)
    // so we only enqueue commands that should pass; affordability is
    // checked against the per-think ledger inside researchForAI, and a
    // rejection just means "not this tick".
    const def = UPGRADE_DEFS[id];
    if (!isUnitAvailableForAge(world, ai.owner, def.minAge)) continue;
    let prereqsMet = true;
    for (const kind of def.requiredBuildings) {
      if (!hasProductionBuilding(world, ai.owner, kind)) {
        prereqsMet = false;
        break;
      }
    }
    if (!prereqsMet) continue;
    researchForAI(world, queue, ai, id);
    return;
  }
}

// ---------------------------------------------------------------------------
// Grand-expansion Phase 7: AI intel play (spies, sabotage, counter-intel).
//
// The AI's intel infrastructure is virtual (the C1 forward depots are
// logistics/sensor buildings, not intel ones): a second one-at-a-time
// construction queue (`ai.intel.constructing`) that runs PARALLEL to the production queue —
// intel construction never stalls the war-production pipeline, and the
// production queue never stalls intel. Completed virtual intel kinds
// join `virtualBuildings.completed` (so `hasProductionBuilding`
// unlocks spy training) and accrue intel assets through
// `creditVirtualIntel` (the `creditVirtualEconomy` mirror).
// ---------------------------------------------------------------------------

/**
 * Virtual intel construction priority per difficulty, in order. Cadet
 * and citizen build no intel — consistent with their profiles.
 * Exported for tests.
 */
export const INTEL_CONSTRUCTION_PRIORITY: Record<AIDifficulty, BuildingKind[]> = {
  cadet: [],
  citizen: [],
  commander: ['listeningPost', 'intelHQ', 'signalsStation'],
  general: ['listeningPost', 'intelHQ', 'signalsStation'],
  marshal: ['listeningPost', 'intelHQ', 'signalsStation', 'satelliteUplink'],
};

/**
 * Spy quotas per difficulty: how many spies the AI keeps in the field.
 * Spies count against the army cap (`AI_MAX_UNITS`) like any unit.
 */
export const INTEL_SPY_QUOTA: Record<AIDifficulty, number> = {
  cadet: 0,
  citizen: 0,
  commander: 1,
  general: 2,
  marshal: 3,
};

/** The production base that must be complete before intel construction starts. */
const INTEL_PRODUCTION_BASE: BuildingKind[] = ['barracks', 'warFactory'];

/**
 * Funds buffer for intel construction: the AI only starts an intel
 * building while holding INTEL_COST_BUFFER_MULT × its cost — the other
 * half stays in the war chest. Documented priority: intel never
 * starves the early economy.
 */
const INTEL_COST_BUFFER_MULT = 2;

/**
 * The intel build order for this AI: the difficulty's priority table
 * minus completed kinds, with signalsStation jumped to the head while
 * the counter-intel surge is latched (and not yet answered).
 */
function intelBuildOrder(ai: AIPlayerState): BuildingKind[] {
  const order = INTEL_CONSTRUCTION_PRIORITY[ai.difficulty].filter(
    (k) => !ai.virtualBuildings.completed.includes(k),
  );
  if (ai.intel.counterIntelSurge) {
    const idx = order.indexOf('signalsStation');
    if (idx > 0) {
      order.splice(idx, 1);
      order.unshift('signalsStation');
    }
  }
  return order;
}

/**
 * Virtual intel construction (commander+). Gates, in order: the AI has
 * an intel queue at all (cadet/citizen: none), the production base is
 * complete (barracks + warFactory — intel never starves the early
 * economy), the kind's age is met, and the funds buffer holds (2× the
 * cost). Pays the full cost upfront and completes after the real build
 * time — the production virtual-construction precedent.
 */
function thinkIntelConstruction(world: World, ai: AIPlayerState): void {
  const intel = ai.intel;
  // Complete whatever finished building.
  if (intel.constructing && world.tick >= intel.constructing.readyTick) {
    ai.virtualBuildings.completed.push(intel.constructing.kind);
    intel.constructing = null;
  }
  // One intel building at a time (parallel to the production queue).
  if (intel.constructing) return;
  if (INTEL_CONSTRUCTION_PRIORITY[ai.difficulty].length === 0) return;
  // Don't starve the early economy: the production base comes first.
  for (const kind of INTEL_PRODUCTION_BASE) {
    if (!hasProductionBuilding(world, ai.owner, kind)) return;
  }
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  for (const kind of intelBuildOrder(ai)) {
    if (hasProductionBuilding(world, ai.owner, kind)) continue;
    const def = BUILDING_DEFS[kind];
    if (!def) continue;
    if (!isBuildingAgeMet(getAgeState(world, ai.owner).age, def.minAge)) continue;
    // The funds buffer: keep 2× the cost on hand (materials 1× — the
    // buffer guards the war chest, which is funds-denominated).
    // Ledger-aware: the buffer is measured against funds not already
    // committed to queued commands (the 2× buffer implies the payment
    // can't undercut the ledger — see canPayImmediate).
    const l = thinkLedger(ai);
    if (player.funds - l.funds < def.costFunds * INTEL_COST_BUFFER_MULT) continue;
    if (player.materials - l.materials < def.costMaterials) continue;
    player.funds -= def.costFunds;
    player.materials -= def.costMaterials;
    intel.constructing = { kind, readyTick: world.tick + def.buildSeconds * 30 };
    return;
  }
}

/**
 * The virtual intel asset credit: completed virtual intel buildings
 * accrue surveillance/operational/counter-intel assets into the AI
 * player's stockpile — the `creditVirtualEconomy` mirror (same 1 Hz
 * cadence, same upgrade multipliers as `runIntelAccrual` in
 * sim/intel.ts). Called from `createAISystem`, not from a think.
 */
function creditVirtualIntel(world: World): void {
  if (world.tick % 30 !== 0) return;
  for (const ai of world.ai.players) {
    const player = getPlayer(world.city, ai.owner);
    if (!player) continue;
    const survMult = hasUpgrade(world, ai.owner, 'signalsIntel')
      ? SIGNALS_INTEL_SURVEILLANCE_MULT
      : 1;
    const counterMult = hasUpgrade(world, ai.owner, 'counterIntel')
      ? COUNTER_INTEL_ASSET_MULT
      : 1;
    for (const kind of ai.virtualBuildings.completed) {
      const rates = BUILDING_DEFS[kind]?.intelOutput;
      if (!rates) continue;
      // Virtual buildings are never sabotaged or unpowered — they
      // always accrue (the "completed + operational" gate in
      // runIntelAccrual is trivially met).
      player.intel.operational += rates.operational ?? 0;
      player.intel.surveillance += (rates.surveillance ?? 0) * survMult;
      player.intel.counterIntel += (rates.counterIntel ?? 0) * counterMult;
    }
  }
}

/**
 * Enemy buildings the AI knows about. There is no fog of war in 0.1
 * Alpha — the whole map is visible to the human player — so building
 * POSITIONS are public knowledge, and the AI reads the same building
 * list the human sees. What stays hidden is the mixed airport's true
 * NATURE: the AI learns it only through its own
 * `BuildingRecord.discovery` viewer records (suspected/revealed),
 * never by reading the true `airportType`. Completed buildings only —
 * a construction site is not a target.
 */
/**
 * Enemy buildings the owner's forces can CURRENTLY see (A2, 2026-10-01).
 * The old version returned ALL completed enemy buildings with zero
 * sight filtering — a maphack: the marshal knew the lab/power-plant
 * locations from tick 0. Now gated on real detection: a building is
 * visible only when inside an own-unit sight disc or building
 * surveillance coverage (the same sight model as `getVisibleEnemies`).
 * For the AI's remembered picture (latched once seen), use
 * `getKnownEnemyBuildings`.
 */
export function getVisibleEnemyBuildings(world: World, owner: number): BuildingRecord[] {
  const discs = getSightDiscs(world, owner);
  if (discs === null) return [];
  const { ownRadii, coverage } = discs;
  const out: BuildingRecord[] = [];
  for (const b of world.city.buildings) {
    if (b.owner === owner || b.progress < 1) continue;
    const c = buildingCenterWorld(b);
    let visible = false;
    for (const r of ownRadii) {
      const dx = c.x - r.x;
      const dz = c.z - r.z;
      if (dx * dx + dz * dz <= r.r2) {
        visible = true;
        break;
      }
    }
    if (!visible) {
      for (const cov of coverage) {
        const dx = c.x - cov.x;
        const dz = c.z - cov.z;
        if (dx * dx + dz * dz <= cov.radius * cov.radius) {
          visible = true;
          break;
        }
      }
    }
    if (visible) out.push(b);
  }
  return out;
}

/**
 * Enemy buildings the AI KNOWS about (A2, 2026-10-01): currently
 * visible ones plus any latched in `ai.seenBuildingIds` from earlier
 * sightings (the airport-discovery precedent — the AI doesn't forget
 * when the scout leaves). Updates the latch. Siege and spy targeting
 * use this, never the raw maphack.
 */
export function getKnownEnemyBuildings(world: World, ai: AIPlayerState): BuildingRecord[] {
  const owner = ai.owner;
  const visible = getVisibleEnemyBuildings(world, owner);
  const latched = ai.seenBuildingIds ?? [];
  const latchedSet = new Set(latched);
  for (const b of visible) {
    if (!latchedSet.has(b.id)) {
      latchedSet.add(b.id);
      latched.push(b.id);
    }
  }
  ai.seenBuildingIds = latched;
  const out: BuildingRecord[] = [];
  for (const b of world.city.buildings) {
    // Still standing, still enemy-owned, and in the intel picture.
    if (b.owner !== owner && b.progress >= 1 && latchedSet.has(b.id)) out.push(b);
  }
  return out;
}

/**
 * Covert-op target value of an enemy building kind (higher = the AI's
 * spies prefer it). Intel buildings top the list (blinding the rival's
 * intel hurts most), then airports (military-capable infrastructure —
 * an undiscovered mixed airport values as an airport: the AI knows the
 * SITE is an airport, only its true nature is hidden), then
 * production, then depots and power/water plants; everything else is
 * opportunistic. Exported for tests.
 */
export function intelTargetValue(kind: BuildingKind): number {
  const def = BUILDING_DEFS[kind];
  if (def?.intelOutput) return 100;
  if (def?.airportType !== undefined) return 80;
  if (
    kind === 'barracks' ||
    kind === 'warFactory' ||
    kind === 'airfield' ||
    kind === 'navalYard' ||
    kind === 'shipyard' ||
    kind === 'lab' ||
    kind === 'missilePlant'
  ) {
    return 70;
  }
  if (kind === 'ordnanceDepot' || kind === 'fuelDepot') return 65;
  if ((def?.powerSupply ?? 0) > 0 || (def?.waterSupply ?? 0) > 0) return 60;
  return 10;
}

/**
 * Issue an intel command and count it as an ordered op (soak metrics).
 * Rejections are swallowed like every other AI-issued command; only a
 * successfully enqueued op is counted.
 *
 * Intel asset costs (sabotage: 25 operational, steal: 15 surveillance)
 * are reserved in the per-think ledger BEFORE enqueue: two spies acting
 * in one think each pass the enqueue-time affordability check, but the
 * second would go stale at apply after the first spends the assets
 * (stale commands throw). The ledger makes the second spy see the
 * reservation and skip. Over-reservation (enqueue rejected after
 * reserving) only makes the AI underspend one think — safe, never a
 * crash.
 */
function issueIntelOp(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  op: 'infiltrate' | 'sabotage' | 'steal',
  kind: string,
  payload: Record<string, unknown>,
): void {
  // Reserve intel asset costs in the ledger before enqueue.
  const ledger = thinkLedger(ai);
  const assets = getIntelAssets(world, ai.owner);
  if (op === 'sabotage') {
    if (assets.operational - ledger.operational < SABOTAGE_COST_OPERATIONAL) return;
  } else if (op === 'steal') {
    if (assets.surveillance - ledger.surveillance < STEAL_COST_SURVEILLANCE) return;
  }
  try {
    queue.enqueue(world, { issuer: 'ai', kind, payload });
    ai.intel.ops[op]++;
    // Reserve on successful enqueue only.
    if (op === 'sabotage') ledger.operational += SABOTAGE_COST_OPERATIONAL;
    else if (op === 'steal') ledger.surveillance += STEAL_COST_SURVEILLANCE;
  } catch (e) {
    if (e instanceof CommandRejectedError) return;
    throw e;
  }
}

/**
 * Pick the highest-value enemy building (id-order tiebreak — no RNG in
 * thinks). Returns null when there is nothing worth infiltrating.
 */
function pickSpyTarget(world: World, ai: AIPlayerState): BuildingRecord | null {
  let target: BuildingRecord | null = null;
  let best = -1;
  for (const b of getKnownEnemyBuildings(world, ai)) {
    const v = intelTargetValue(b.kind);
    if (v > best) {
      best = v;
      target = b;
    }
  }
  return target;
}

/**
 * Direct one spy (commander+ doctrine):
 *  - Embedded: steal tech when surveillance ≥ 15 and a stealable tech
 *    exists (intel first), otherwise sabotage the host when
 *    operational ≥ 25 and the host is high-value and not already
 *    sabotaged (disruption second). Otherwise hold — the spy keeps its
 *    cover while assets accrue.
 *  - Free: move to the highest-value enemy building; infiltrate on
 *    arrival (INTEL_ADJACENCY). A mission in progress is left alone;
 *    a spy already moving keeps its orders (no churn).
 */
function directSpy(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  spy: UnitRecord,
  sabotagedThisThink: Set<number>,
  stolenThisThink: Set<string>,
): void {
  const owner = ai.owner;
  // A mission in progress (infiltration embedding) is left alone.
  if ((spy.missionEndsAt ?? 0) > world.tick) return;
  const embeddedId = spy.embeddedIn ?? 0;
  if (embeddedId > 0) {
    const host = world.city.buildings.find((b) => b.id === embeddedId);
    if (!host || host.owner === owner) return;
    const assets = getIntelAssets(world, owner);
    const c = buildingCenterWorld(host);
    const dx = c.x - spy.x;
    const dz = c.z - spy.z;
    const adjacent = dx * dx + dz * dz <= INTEL_ADJACENCY * INTEL_ADJACENCY;
    if (!adjacent) return;
    // Intel first: steal when a tech is stealable and assets cover it.
    // The per-think set prevents two spies queueing a steal of the same
    // tech (the second would find "nothing left to steal" at apply and
    // throw).
    const stealable = pickStealableTech(world, owner, host.owner);
    if (
      assets.surveillance >= STEAL_COST_SURVEILLANCE &&
      stealable !== null &&
      !stolenThisThink.has(host.owner + ':' + stealable)
    ) {
      issueIntelOp(world, queue, ai, 'steal', 'stealTech', {
        unitId: spy.id,
        buildingId: host.id,
        owner,
      });
      stolenThisThink.add(host.owner + ':' + stealable);
      return;
    }
    // Disruption second: sabotage a high-value unsabotaged host.
    // The per-think set prevents two spies from queueing sabotage on
    // the same building (the second would go stale at apply and throw).
    if (
      assets.operational >= SABOTAGE_COST_OPERATIONAL &&
      !isSabotaged(host, world.tick) &&
      !sabotagedThisThink.has(host.id) &&
      intelTargetValue(host.kind) >= 60
    ) {
      issueIntelOp(world, queue, ai, 'sabotage', 'sabotage', {
        unitId: spy.id,
        buildingId: host.id,
        owner,
      });
      sabotagedThisThink.add(host.id);
    }
    return;
  }
  // Free spy: converge on the highest-value enemy building.
  const target = pickSpyTarget(world, ai);
  if (!target) return;
  const c = buildingCenterWorld(target);
  const dx = c.x - spy.x;
  const dz = c.z - spy.z;
  if (dx * dx + dz * dz <= INTEL_ADJACENCY * INTEL_ADJACENCY) {
    issueIntelOp(world, queue, ai, 'infiltrate', 'infiltrateBuilding', {
      unitId: spy.id,
      buildingId: target.id,
      owner,
    });
  } else if (spy.state === 'idle') {
    moveTo(world, queue, owner, spy.id, c.x, c.z);
  }
}

/**
 * Spy doctrine (commander+): train spies up to the difficulty quota
 * while under the army cap (spies need a completed intelHQ — real or
 * virtual — via `canTrain`), then direct each spy in id order. Also
 * scans for counter-intel triggers: a burned/detected rival spy in
 * `getVisibleEnemies`, or a suspected/revealed discovery record on a
 * rival mixed airport with this AI as viewer — either latches
 * `counterIntelSurge`, jumping signalsStation to the head of the
 * intel build queue.
 */
function thinkIntelSpies(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  visible: UnitRecord[],
): void {
  const quota = INTEL_SPY_QUOTA[ai.difficulty];
  if (quota === 0) return;
  const owner = ai.owner;
  const spies: UnitRecord[] = [];
  for (const u of world.units) {
    if (u.owner === owner && u.hp > 0 && isSpyUnit(u)) spies.push(u);
  }
  // Train up to quota (spies count against the army cap like any unit).
  if (spies.length < quota && canTrain(world, owner, 'spy')) {
    if (totalUnits(world, owner) < AI_MAX_UNITS[ai.difficulty]) {
      const p = spawnPoint(ai, 'spy', spies.length);
      if (spawn(world, queue, ai, 'spy', p.x, p.z)) {
        ai.builtCounts['spy'] = (ai.builtCounts['spy'] ?? 0) + 1;
      }
    }
  }
  // Counter-intel triggers (latch — the surge is answered when
  // signalsStation completes).
  if (!ai.intel.counterIntelSurge) {
    if (visible.some((e) => isStealthAsset(e))) {
      ai.intel.counterIntelSurge = true;
    } else {
      for (const b of world.city.buildings) {
        const discovery = b.discovery;
        if (!discovery) continue;
        for (const d of discovery) {
          if (
            d.viewer === owner &&
            (d.state === 'suspected' || d.state === 'revealed')
          ) {
            ai.intel.counterIntelSurge = true;
            break;
          }
        }
        if (ai.intel.counterIntelSurge) break;
      }
    }
  }
  // Direct each spy (world.units is id order — no RNG in thinks).
  // The per-think sets stop two spies queueing sabotage on the same
  // building or a steal of the same tech (the second would go stale at
  // apply and throw).
  const sabotagedThisThink = new Set<number>();
  const stolenThisThink = new Set<string>();
  for (const spy of spies) directSpy(world, queue, ai, spy, sabotagedThisThink, stolenThisThink);
}

/**
 * Intel research (commander+): signalsIntel once a listeningPost is
 * held (real or virtual), counterIntel once a signalsStation is held —
 * both need the information age and a lab, like every upgrade. Handled
 * here (not in the personality-shuffled RESEARCH_PRIORITY tail) so the
 * intel upgrades never shift the personality stream's draws.
 */
function thinkIntelResearch(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  if (INTEL_SPY_QUOTA[ai.difficulty] === 0) return;
  if (!hasProductionBuilding(world, ai.owner, 'lab')) return;
  const order: { id: UpgradeId; prereq: BuildingKind }[] = [
    { id: 'signalsIntel', prereq: 'listeningPost' },
    { id: 'counterIntel', prereq: 'signalsStation' },
  ];
  for (const { id, prereq } of order) {
    if (hasUpgrade(world, ai.owner, id)) continue;
    if (!hasProductionBuilding(world, ai.owner, prereq)) continue;
    const def = UPGRADE_DEFS[id];
    if (!isUnitAvailableForAge(world, ai.owner, def.minAge)) continue;
    // Affordability runs through the per-think ledger (researchForAI):
    // the intel upgrades share the think's budget with the main
    // research line and production.
    researchForAI(world, queue, ai, id);
    return;
  }
}

/**
 * The intel think (commander+): virtual construction, spy doctrine,
 * intel research. Cadet/citizen skip everything (empty tables).
 */
function thinkIntel(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  visible: UnitRecord[],
): void {
  // Peaceful worlds: no spies, no covert ops, no intel construction —
  // the AI must not even try (defense in depth; the peaceful dispatch
  // in createAISystem never reaches this branch).
  if (world.peaceful === true) return;
  thinkIntelConstruction(world, ai);
  thinkIntelSpies(world, queue, ai, visible);
  thinkIntelResearch(world, queue, ai);
}

// ---------------------------------------------------------------------------
// Naval (general+): probe for water, then work the coast
// ---------------------------------------------------------------------------

/** Deterministic probe ring: radii × 8 compass directions = 32 points. */
const PROBE_RADII = [40, 80, 140, 220];
const PROBE_DIRS = 8;
const PROBE_COUNT = PROBE_RADII.length * PROBE_DIRS;

/** Probe candidate #i around the base (deterministic, no RNG). */
function probePoint(ai: AIPlayerState, i: number): { x: number; z: number } {
  // B27: no `!` — the fallback is the last radius (always defined).
  const r = PROBE_RADII[Math.floor(i / PROBE_DIRS)] ?? PROBE_RADII[PROBE_RADII.length - 1] ?? 220;
  const a = ((i % PROBE_DIRS) / PROBE_DIRS) * Math.PI * 2;
  return { x: ai.baseX + Math.round(detCos(a) * r), z: ai.baseZ + Math.round(detSin(a) * r) };
}

/**
 * Water scouting by trial (no maphack): attempt real fishing-boat
 * spawns (cheap, foundation-age, un-gated) at probe points around the
 * base, two per think. A rejection for terrain ("sea unit on land")
 * advances the probe; an economic rejection retries later; a success
 * marks the map coastal and the probe point becomes the naval base.
 */
function thinkNavalProbe(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  if (ai.navalStatus !== 'unknown') return;
  for (let t = 0; t < 2 && ai.navalProbeIndex < PROBE_COUNT; t++) {
    const p = probePoint(ai, ai.navalProbeIndex);
    // Off-map candidates count as misses (deterministic).
    if (Math.abs(p.x) >= MAP_HALF_SIZE || Math.abs(p.z) >= MAP_HALF_SIZE) {
      ai.navalProbeIndex++;
      continue;
    }
    const reason = trySpawn(world, queue, ai, 'fishingBoat', p.x, p.z);
    if (reason === null) {
      ai.navalStatus = 'coastal';
      ai.navalWater = { x: p.x, z: p.z };
      ai.builtCounts['fishingBoat'] = (ai.builtCounts['fishingBoat'] ?? 0) + 1;
      return;
    }
    if (reason.includes('sea unit on land')) {
      ai.navalProbeIndex++;
    }
    // Economic/age rejections: don't advance — retry the same point later.
  }
  if (ai.navalProbeIndex >= PROBE_COUNT) ai.navalStatus = 'landlocked';
}

// ---------------------------------------------------------------------------
// Grand-expansion Phase 5/6 air + naval AI (workstream D).
//
// The airport (A), aircraft/hangar (B), and naval (C) workstreams land
// in parallel; their defs (civilAirport, hangar classes,
// carrierCapable kinds, wingCapacity, the §3.6 roster) do not exist
// yet. Every reference below is def-guarded: with no defs present the
// new paths are inert (documented here and pinned by tests), and they
// activate the moment the defs land — no AI-side changes needed then.
// New roster kinds are named as raw strings (UnitKind doesn't include
// them yet) and always resolved through UNIT_DEFS before use.
// ---------------------------------------------------------------------------

/** Escorts kept per carrier (Phase 6 AI work: "AI builds escorts"). */
const CARRIER_ESCORT_COUNT = 2;
/** Idle escorts station within this range of their carrier (world units). */
const ESCORT_STATION_RANGE = 40;
/** Aircraft within this range of a carrier get embark orders. */
const EMBARK_ORDER_RANGE = 60;

/**
 * Submarine kinds for the counter table (PLAN §3.6: the roster's
 * submarine plus coastalSub + missileSub). Exported for tests; the
 * counter table reads through UNIT_DEFS at use so unlanded names are
 * inert.
 */
export const SUB_KINDS: ReadonlySet<string> = new Set(['submarine', 'coastalSub', 'missileSub']);

/**
 * Capital-ship kinds for the counter table (PLAN §3.6: destroyer,
 * carrier, commandShip plus cruiser + battleship + heavyDestroyer).
 * Exported for tests; same def-guard convention as SUB_KINDS.
 */
export const CAPITAL_KINDS: ReadonlySet<string> = new Set([
  'destroyer',
  'carrier',
  'commandShip',
  'cruiser',
  'battleship',
  'heavyDestroyer',
]);

/**
 * Escort-screen kinds, cheapest first (PLAN §3.6: the corvette and
 * heavyDestroyer join the frigate screen; 'destroyer' is the roster's
 * existing heavy). Exported for tests; filtered through UNIT_DEFS at
 * use — unlanded kinds simply aren't in the pool yet.
 */
export const ESCORT_KINDS = ['frigate', 'corvette', 'heavyDestroyer', 'destroyer'];

/** Unit kinds whose defs mark them carrier-capable (PLAN §3.7). Empty until the aircraft workstream lands. Deterministic: UNIT_DEFS insertion order. */
function carrierCapableKinds(): UnitKind[] {
  const out: UnitKind[] = [];
  for (const key of Object.keys(UNIT_DEFS) as UnitKind[]) {
    if (UNIT_DEFS[key].carrierCapable) out.push(key);
  }
  return out;
}

/** True once the naval workstream gives carriers a wing (PLAN §4 S4). */
function wingSystemActive(): boolean {
  return (UNIT_DEFS.carrier.wingCapacity ?? 0) > 0;
}

/**
 * The wing embarked on `carrierId`: the AI's living aircraft with
 * embarkedOn === carrierId. world.units is spawn (id) order, so the
 * wing is id-ordered. Empty until the naval workstream lands (no
 * embarkAircraft command, no wingCapacity).
 */
function carrierWing(world: World, owner: number, carrierId: number): UnitRecord[] {
  const wing: UnitRecord[] = [];
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    if ((u.embarkedOn ?? 0) === carrierId) wing.push(u);
  }
  return wing;
}

/**
 * Choose the next aircraft kind to train for a carrier's wing
 * (final-review R5 H3, 2026-10-01): armed-first composition.
 *
 * - Armed kinds (`damage > 0`: armedUAV, navalFighter) train before
 *   unarmed ones — a carrier wing that can't fight is a liability.
 * - At most ONE spotter (recon kind) per wing: the wing's existing
 *   aircraft count toward the cap, embarked or still converging, so
 *   the AI never queues a second spotter while one is flying in.
 * - Fallback order within a tier follows `capKinds` (def) order.
 *
 * Returns null when every kind is composition-blocked (e.g. the only
 * kinds left are spotters and the wing already has one) — the caller
 * then trains nothing this think.
 *
 * Exported for the wing-composition tests.
 */
export function pickWingAircraftKind(
  world: World,
  owner: number,
  carrierId: number,
  capKinds: UnitKind[],
): UnitKind | null {
  let spotters = 0;
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def?.carrierCapable) continue;
    // Embarked on this carrier, or still converging on it.
    if ((u.embarkedOn ?? 0) !== carrierId && !isConvergingOnCarrier(u)) continue;
    if (def.recon === true) spotters++;
  }
  const spotterBlocked = spotters >= 1;
  const armed: UnitKind[] = [];
  const unarmed: UnitKind[] = [];
  for (const kind of capKinds) {
    const def = UNIT_DEFS[kind];
    if (def.recon === true && spotterBlocked) continue;
    if ((def.damage ?? 0) > 0) armed.push(kind);
    else unarmed.push(kind);
  }
  return armed[0] ?? unarmed[0] ?? null;
}

/**
 * True when an aircraft looks like it is already joining a carrier
 * wing: carrier-capable, alive, not embarked, and holding no combat
 * target (thinkCarrierWings' 2b loop issues embark/moveTo orders to
 * exactly these units — the convergence heuristic mirrors it).
 */
function isConvergingOnCarrier(u: UnitRecord): boolean {
  if ((u.embarkedOn ?? 0) !== 0) return false;
  return u.state === 'idle' && u.targetId === 0;
}

/** Living escort-screen ships of `owner` (the ESCORT_KINDS pool, def-guarded). */
function countEscorts(world: World, owner: number): number {
  const pool = ESCORT_KINDS.filter((k) => UNIT_DEFS[k as UnitKind]);
  let n = 0;
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    if ((pool as string[]).includes(u.kind)) n++;
  }
  return n;
}

/**
 * True when `u` is a carrier that must NOT sail yet: the wing system is
 * active, the roster has carrier-capable kinds to fill it with, and the
 * wing isn't full. Used by the attack loops — an empty-wing carrier
 * never sails into combat (PLAN §6: "AI fills carrier wings before
 * sailing (never sails empty into combat)"). Pre-B (no wingCapacity)
 * this is always false and the attack loops are byte-identical to
 * before; it is also false when the roster has nothing to fill the
 * wing with (can't fill what doesn't exist — no deadlock).
 *
 * Exported for tests (the attack-loop skip is pinned: a fresh carrier
 * never sails into combat until its wing fills).
 */
export function isEmptyWingCarrier(world: World, u: UnitRecord): boolean {
  if (u.kind !== 'carrier') return false;
  if (!wingSystemActive()) return false;
  if (carrierCapableKinds().length === 0) return false;
  const wingCapacity = UNIT_DEFS.carrier.wingCapacity as number;
  return carrierWing(world, u.owner, u.id).length < wingCapacity;
}

/**
 * Phase 5 airline (PLAN §6 AI work: "AI builds civil airports and runs
 * routes (static income)"). Deliberately minimal in 0.1 Alpha —
 * documented here rather than left silent:
 * - Build: 'civilAirport' is on the marshal construction priority;
 *   thinkConstruction's unknown-def guard skips it until the airport
 *   workstream's defs land (no crash, no stall).
 * - Income: static airline income flows through creditVirtualEconomy's
 *   def.harvest credit — the S5 civilian-income pattern (civil
 *   buildings pay harvest, like the fishingBoat's runHarvest
 *   precedent; R1 final-review C2 fixed the old comment claiming
 *   def.output covered it — the civilAirport def carries no funds
 *   output). No separate route ledger exists in 0.1 Alpha.
 * - Schedules and pricing are the "later" half of PLAN §3.5 and belong
 *   to the future civilian trader rival (PLAN §6: "transport/airline/
 *   peaceful: civilian AI trader rival is a later feature"), not to
 *   the military Classic AI.
 * So this function issues no commands and changes no state today
 * (digest-neutral); it is the hook where per-route orders would live
 * once the airline system exists. Exported so tests can pin the
 * digest-neutrality (the thinkCivilianTransport precedent).
 */
export function thinkAirlineRoutes(world: World, ai: AIPlayerState): void {
  void world;
  void ai;
}

/**
 * Fill carrier wings before sailing (PLAN §6, Phase 6 AI work).
 * Called from thinkCommander (general/marshal inherit); cadet/citizen
 * never field carriers.
 *
 * Per living own carrier, on a coastal map:
 *  1. Acquire: if the AI has no carrier yet and can train one
 *     (information age, navalYard held — marshal in practice), train
 *     one — but only after the escort screen exists (the escort-first
 *     rule): carriers sail with escorts or not at all.
 *  2. Fill: while the wing has room, train carrier-capable aircraft
 *     (army cap + hangar-aware canTrain) and order idle
 *     carrier-capable aircraft to the carrier — embark when close,
 *     moveTo when far (they converge over a few thinks). The wing
 *     trains ARMED-FIRST (final-review R5 H3, 2026-10-01): armed
 *     kinds (armedUAV, navalFighter) before unarmed ones, and at
 *     most one spotter (recon) per wing — a wing that can't fight
 *     is a liability.
 *  3. Never sails empty: the attack loops skip empty-wing carriers
 *     (isEmptyWingCarrier), so a carrier with an unfilled wing holds
 *     at the naval base until its wing is complete. A full-wing
 *     carrier needs no special sail order — the normal attack loop
 *     sends it after visible enemies via chasing.
 *
 * Pre-B (no wingCapacity on the carrier def) the whole function is a
 * documented no-op — including no carrier acquisition, because an
 * embark-less carrier is a gun platform the composition never asked
 * for and the user's design says carriers come empty with
 * carrier-capable wings only.
 */
export function thinkCarrierWings(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  if (!wingSystemActive()) return;
  if (ai.navalStatus !== 'coastal' || !ai.navalWater) return;
  const capKinds = carrierCapableKinds();
  if (capKinds.length === 0) return;
  const carriers = world.units.filter(
    (u) => u.owner === ai.owner && u.hp > 0 && u.kind === 'carrier',
  );
  // 1. Acquire one carrier once the escort screen exists.
  if (carriers.length === 0) {
    const n = totalUnits(world, ai.owner);
    if (
      countEscorts(world, ai.owner) >= CARRIER_ESCORT_COUNT &&
      n < AI_MAX_UNITS[ai.difficulty] &&
      canTrain(world, ai.owner, 'carrier')
    ) {
      if (spawn(world, queue, ai, 'carrier', ai.navalWater.x, ai.navalWater.z)) {
        ai.builtCounts['carrier'] = (ai.builtCounts['carrier'] ?? 0) + 1;
      }
    }
    return;
  }
  const wingCapacity = UNIT_DEFS.carrier.wingCapacity as number;
  for (const c of carriers) {
    const wing = carrierWing(world, ai.owner, c.id);
    if (wingCapacity - wing.length <= 0) continue;
    // 2a. Train wing aircraft (army cap + hangar-aware canTrain).
    // Final-review R5 H3 (2026-10-01): armed-first composition —
    // armed kinds (armedUAV, navalFighter) before unarmed ones, and
    // at most one spotter (recon) per wing. Walk the preference order
    // and train the first kind the AI can actually train this think
    // (age/building/affordability), so the wing keeps filling even
    // when the top pick is locked.
    const n = totalUnits(world, ai.owner);
    if (n < AI_MAX_UNITS[ai.difficulty]) {
      const kind = pickWingAircraftKind(world, ai.owner, c.id, capKinds);
      if (kind !== null && canTrain(world, ai.owner, kind)) {
        const p = spawnPoint(ai, kind, n);
        if (spawn(world, queue, ai, kind, p.x, p.z)) {
          ai.builtCounts[kind] = (ai.builtCounts[kind] ?? 0) + 1;
        }
      }
    }
    // 2b. Idle carrier-capable aircraft converge on the carrier:
    // embark when close (the range gate itself lives in the command's
    // validate; rejections are swallowed), moveTo when far.
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      if (!UNIT_DEFS[u.kind as UnitKind]?.carrierCapable) continue;
      if ((u.embarkedOn ?? 0) !== 0) continue;
      if (u.state !== 'idle' || u.targetId !== 0) continue;
      const dx = u.x - c.x;
      const dz = u.z - c.z;
      if (dx * dx + dz * dz <= EMBARK_ORDER_RANGE * EMBARK_ORDER_RANGE) {
        issue(world, queue, 'embarkAircraft', { unitId: u.id, carrierId: c.id, owner: ai.owner });
      } else {
        moveTo(world, queue, ai.owner, u.id, c.x, c.z);
      }
    }
  }
}

/**
 * Build escorts for carriers (PLAN §6, Phase 6 AI work). For every
 * living own carrier, keep CARRIER_ESCORT_COUNT escorts in the screen
 * and order idle escorts to station near their carrier (the fleet
 * sails together). Escorts already fighting are never pulled off.
 *
 * The escort screen is live TODAY (frigates are in the roster): the
 * moment the naval workstream lets the AI field a carrier,
 * thinkCarrierWings' escort-first rule trains the screen before the
 * carrier, and this function keeps it topped up and stationed.
 */
export function thinkCarrierEscorts(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  const carriers = world.units.filter(
    (u) => u.owner === ai.owner && u.hp > 0 && u.kind === 'carrier',
  );
  if (carriers.length === 0) return;
  const pool = ESCORT_KINDS.filter((k) => UNIT_DEFS[k as UnitKind]) as UnitKind[];
  if (pool.length === 0) return;
  // B27: no `!` — pool is non-empty by the guard above.
  const escortKind = pool[0];
  if (escortKind === undefined) return;
  for (const c of carriers) {
    const screen = world.units.filter(
      (u) =>
        u.owner === ai.owner &&
        u.hp > 0 &&
        (pool as string[]).includes(u.kind),
    );
    // Top up the screen (army cap respected).
    const n = totalUnits(world, ai.owner);
    if (
      screen.length < CARRIER_ESCORT_COUNT &&
      n < AI_MAX_UNITS[ai.difficulty] &&
      canTrain(world, ai.owner, escortKind)
    ) {
      const p = spawnPoint(ai, escortKind, n);
      if (spawn(world, queue, ai, escortKind, p.x, p.z)) {
        ai.builtCounts[escortKind] = (ai.builtCounts[escortKind] ?? 0) + 1;
      }
    }
    // Idle escorts station near the carrier.
    for (const e of screen) {
      if (e.state !== 'idle' || e.targetId !== 0) continue;
      const dx = e.x - c.x;
      const dz = e.z - c.z;
      if (dx * dx + dz * dz > ESCORT_STATION_RANGE * ESCORT_STATION_RANGE) {
        moveTo(world, queue, ai.owner, e.id, c.x + 12, c.z);
      }
    }
  }
}

/**
 * Phase 6 naval mines: a DOCUMENTED no-op in 0.1 Alpha (PLAN Phase 6
 * AI work: "minesweeping (later)"). The AI neither deploys naval
 * mines nor sweeps them: the minelayer/navalMine defs haven't landed,
 * and mine counter-play is explicitly deferred behind carrier wings
 * and escorts. This function is the hook where mine-laying
 * (minelayers seeding straits) and minesweeping (a sweeper escort
 * ahead of the fleet) will live. Exported so tests can pin the
 * no-op (the thinkCivilianTransport precedent).
 */
export function thinkNavalMines(world: World, ai: AIPlayerState): void {
  void world;
  void ai;
}

// ---------------------------------------------------------------------------
// Per-level think functions
// ---------------------------------------------------------------------------

/**
 * Attack-timing jitter around the think cadence: low-aggression
 * personalities issue attack orders every other think instead of every
 * think. Units already chasing keep chasing via the combat system, so
 * this only staggers NEW orders — it never cancels an ongoing attack.
 * The think index is floor(tick / cadence): deterministic, no RNG draws.
 *
 * Roadmap B3 (2026-10-02): an active ceasefire also suppresses new
 * attack orders (and therefore the siege escalation, which routes
 * through the same call sites). Ongoing engagements still resolve —
 * the engine never cancels an ongoing attack.
 */
function attacksThisThink(world: World, ai: AIPlayerState): boolean {
  if (ceasefireActive(world)) return false;
  const every = ai.personality.attackEveryNthThink;
  if (every <= 1) return true;
  return Math.floor(world.tick / AI_THINK_TICKS[ai.difficulty]) % every === 0;
}

/** Cadet think: trickle rifles, never attack, never expand, never build. */
function thinkCadet(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const n = totalUnits(world, ai.owner);
  if (n >= AI_MAX_UNITS.cadet) return;
  // Rifles only: cadet builds no production buildings, so gated kinds
  // (tank, …) could never unlock — ordering them would stall the AI.
  const p = spawnPoint(ai, 'rifles', n);
  if (spawn(world, queue, ai, 'rifles', p.x, p.z)) {
    ai.builtCounts['rifles'] = (ai.builtCounts['rifles'] ?? 0) + 1;
  }
  // Phase 4 transport (S7): civilian-transport AI hook — a documented
  // no-op in 0.1 Alpha (see thinkCivilianTransport).
  thinkCivilianTransport(world, ai);
}

/** Shared per-think bookkeeping: construction, sub sightings. */
function thinkUpkeep(world: World, ai: AIPlayerState, visible: UnitRecord[]): void {
  thinkConstruction(world, ai);
  // Phase 6: any submarine kind (SUB_KINDS) trips the Sonar Suite
  // priority — same behavior as before until the new defs land.
  if (!ai.seenSubmarine && visible.some((e) => SUB_KINDS.has(e.kind))) {
    ai.seenSubmarine = true;
  }
}

/** Citizen think: basic army, simple counters, attacks visible enemies. */
function thinkCitizen(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const visible = getVisibleEnemies(world, ai.owner);
  thinkUpkeep(world, ai, visible);

  // Production: one unit per think, counters then base mix.
  thinkProduction(world, queue, ai, counts, n, visible);

  // Phase 3 logistics (workstream 3): virtual depots, truck ratios,
  // abstract resupply, ammo-dry retreats.
  thinkLogistics(world, queue, ai);

  // Phase 4 transport (S7): civilian-transport AI hook — a documented
  // no-op in 0.1 Alpha (see thinkCivilianTransport).
  thinkCivilianTransport(world, ai);

  // Fun-audit B6 (scheduled, escalating, telegraphed offensives):
  // advance the war schedule before the siege/attack sections read it.
  // Citizen runs the probe phase only (OFFENSIVE_MAX_PHASE).
  thinkOffensive(world, ai);

  // Siege state (final-review R2-B): no visible enemy units means the
  // army is destroyed or hiding — count the quiet thinks; visible
  // enemies reset the count and drop any siege target.
  if (visible.length > 0) {
    ai.siegeQuietThinks = 0;
    ai.siegeTargetBuildingId = 0;
  } else {
    ai.siegeQuietThinks = (ai.siegeQuietThinks ?? 0) + 1;
  }

  // Attack: order all combat units to attack the nearest visible enemy.
  // (Personality may stagger new attack orders to every other think.)
  if (visible.length > 0 && attacksThisThink(world, ai)) {
    // Nearest to base (deterministic). The length check above guarantees [0] exists.
    const firstVisible = visible[0];
    if (firstVisible === undefined) {
      // B27: no `!` — visible.length > 0 above guarantees [0] exists; unreachable.
      throw new Error('ai: expected at least one visible enemy');
    }
    let nearest: UnitRecord = firstVisible;
    let best = Infinity;
    for (const e of visible) {
      const dx = e.x - ai.baseX;
      const dz = e.z - ai.baseZ;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        nearest = e;
      }
    }
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      const def = UNIT_DEFS[u.kind as UnitKind];
      if (def.damage <= 0) continue; // unarmed (hauler, transport, medics)
      // Dry magazines don't get new attack orders — they fall back in
      // thinkAmmoRetreats instead (they can't shoot anyway).
      if ((def.ammoCapacity ?? 0) > 0 && u.ammo <= 0) continue;
      // Skip units whose weapons can't engage this target's domain
      // (e.g. tanks can't target air) — the attackUnit command would reject.
      if (!canTarget(def, nearest)) continue;
      // Wing-managed aircraft stay out of the generic attack loop:
      // thinkCarrierWings 2b embarks idle carrier-capable aircraft in
      // the same think and the embark applies first — a same-think
      // attackUnit for the same aircraft would go stale at apply and
      // throw (loud-rejection contract). Sheltered aircraft can't
      // attack at all.
      if (isSheltered(u)) continue;
      if (def.carrierCapable === true && isConvergingOnCarrier(u)) continue;
      // Phase 6: carriers with unfilled wings never sail into combat
      // (their wings are filled by thinkCarrierWings first). Pre-B this
      // is always false — the loop is byte-identical to before.
      if (isEmptyWingCarrier(world, u)) continue;
      // Only re-issue if not already attacking this target.
      if (u.targetId === nearest.id && u.chasing) continue;
      attack(world, queue, ai.owner, u.id, nearest.id);
    }
  } else if (visible.length === 0 && attacksThisThink(world, ai)) {
    // No visible enemies: escalate to a siege of the enemy base once
    // the quiet persists past the difficulty threshold (thinkSiege
    // checks it) — the R2-B answer to whack-a-mole wars.
    thinkSiege(world, queue, ai);
  }
}

/** Clamp a scout waypoint inside the map (off-map orders reject). */
function clampWaypoint(x: number, z: number): { x: number; z: number } {
  const lim = MAP_HALF_SIZE - 10;
  return {
    x: Math.max(-lim, Math.min(lim, x)),
    z: Math.max(-lim, Math.min(lim, z)),
  };
}

/** Commander think: scout, balanced force, full counters, expansion. */
/**
 * Building upgrades (2026-10-05): fair-AI reactor upgrades. When the
 * AI is comfortably rich it upgrades its first eligible nuclear plant
 * (owned, completed, below max reactors, no upgrade in flight) — the
 * same upgrade the player gets, keeping the fair-AI contract. One
 * upgrade per think at most; the command's own validation is the
 * backstop (issue() swallows rejections).
 */
export function thinkNuclearUpgrades(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  const player = getPlayer(world.city, ai.owner);
  if (player === undefined) return;
  if (player.funds < 3000 || player.materials < 800) return;
  for (const b of world.city.buildings) {
    if (b.owner !== ai.owner || b.kind !== 'nuclearPlant' || b.progress < 1) continue;
    if (b.upgradeProgress !== undefined) return;
    if ((b.reactors ?? 1) >= NUCLEAR_MAX_REACTORS) continue;
    issue(world, queue, 'upgradeBuilding', { owner: ai.owner, buildingId: b.id });
    return;
  }
}

function thinkCommander(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain?: TerrainData,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const visible = getVisibleEnemies(world, ai.owner);
  thinkUpkeep(world, ai, visible);
  thinkResearch(world, queue, ai, counts);
  // Building upgrades (2026-10-05): upgrade nuclear plants when rich
  // (fair-AI — the player gets the same upgrade).
  thinkNuclearUpgrades(world, queue, ai);

  // Phase 3 logistics (workstream 3): physical forward depots (C1),
  // truck ratios, abstract resupply, ammo-dry retreats.
  thinkLogistics(world, queue, ai, terrain);

  // Phase 4 transport (S7): civilian-transport AI hook — a documented
  // no-op in 0.1 Alpha (see thinkCivilianTransport).
  thinkCivilianTransport(world, ai);

  // --- Scouting: keep one scout probing outward waypoints. At the
  // information age the awacs replaces the drone (spec §7.2).
  const scoutKind: UnitKind = canTrain(world, ai.owner, 'awacs') ? 'awacs' : 'drone';
  const scouts = (counts.get('drone') ?? 0) + (counts.get('awacs') ?? 0) + (counts.get('fighter') ?? 0);
  if (scouts === 0 && n < AI_MAX_UNITS[ai.difficulty] && canTrain(world, ai.owner, scoutKind)) {
    const p = spawnPoint(ai, scoutKind, n);
    if (spawn(world, queue, ai, scoutKind, p.x, p.z)) {
      ai.builtCounts[scoutKind] = (ai.builtCounts[scoutKind] ?? 0) + 1;
    }
  } else {
    // Order idle scouts to waypoints (cycle through 4 compass points at
    // standoff distance); skip waypoints near visible enemy clusters.
    const waypoints = [
      clampWaypoint(ai.baseX + 120, ai.baseZ),
      clampWaypoint(ai.baseX, ai.baseZ + 120),
      clampWaypoint(ai.baseX - 120, ai.baseZ),
      clampWaypoint(ai.baseX, ai.baseZ - 120),
    ];
    // Modulo guarantees a valid index.
    const firstWp = waypoints[ai.scoutIndex % waypoints.length];
    if (firstWp === undefined) {
      // B27: no `!` — modulo guarantees a valid index; unreachable.
      throw new Error('ai: scout waypoint index out of range');
    }
    let wp = firstWp;
    for (let tries = 0; tries < waypoints.length; tries++) {
      const crowded = visible.some((e) => {
        const dx = e.x - wp.x;
        const dz = e.z - wp.z;
        return dx * dx + dz * dz <= 50 * 50;
      });
      if (!crowded) break;
      ai.scoutIndex++;
      const nextWp = waypoints[ai.scoutIndex % waypoints.length];
      if (nextWp === undefined) {
        // B27: no `!` — modulo guarantees a valid index; unreachable.
        throw new Error('ai: scout waypoint index out of range');
      }
      wp = nextWp;
    }
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      if (u.kind !== 'drone' && u.kind !== 'fighter' && u.kind !== 'awacs') continue;
      // Only redirect idle scouts (don't interrupt combat).
      if (u.state === 'idle' && u.targetId === 0) {
        moveTo(world, queue, ai.owner, u.id, wp.x, wp.z);
      }
    }
    ai.scoutIndex++;
  }

  // --- Water reconnaissance: commanders and above probe for water by
  //     trial (never maphack). The probe is what lets the naval counter
  //     table (frigates vs subs, ...) function; the economic navy
  //     (fishing fleet, patrol boats) stays general+ (see chooseUnitKind).
  thinkNavalProbe(world, queue, ai);

  // --- Grand-expansion Phase 5/6 air + naval (workstream D): the
  //     airline hook (static income via def.output — documented
  //     minimal), carrier wings (fill before sailing, escort-first
  //     acquisition), carrier escorts (screen top-up + stationing),
  //     and naval mines (documented no-op — minesweeping deferred
  //     per PLAN Phase 6). All def-guarded: inert until workers A/B/C
  //     land, then active with no AI-side changes.
  thinkAirlineRoutes(world, ai);
  thinkCarrierWings(world, queue, ai);
  thinkCarrierEscorts(world, queue, ai);
  thinkNavalMines(world, ai);

  // --- Grand-expansion Phase 7 (AI intel play): virtual intel
  //     construction, spy doctrine, intel research, counter-intel
  //     surge. Runs before production so a spy training order lands
  //     in the same think as the regular unit.
  thinkIntel(world, queue, ai, visible);

  // --- Production: one unit per think, counters then base mix.
  thinkProduction(world, queue, ai, counts, n, visible);

  // --- Medics: attach to the land force (centroid), never attack.
  // (The attack loop below already skips damage-0 units.)
  let cx = 0;
  let cz = 0;
  let landCombat = 0;
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (def.domain === 'land' && def.damage > 0) {
      cx += u.x;
      cz += u.z;
      landCombat++;
    }
  }
  if (landCombat > 0) {
    cx /= landCombat;
    cz /= landCombat;
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0 || u.kind !== 'combatMedic') continue;
      moveTo(world, queue, ai.owner, u.id, cx, cz);
    }
  }

  // --- Expansion: once we have enough units (personality threshold
  //     6..10, was a flat 8), establish a forward base toward the
  //     nearest visible enemy — or in this match's personality direction
  //     when no enemy is visible.
  if (!ai.forwardBase && n >= ai.personality.expansionUnitThreshold) {
    let fx: number;
    let fz: number;
    if (visible.length > 0) {
      const firstVisible = visible[0];
      if (firstVisible === undefined) {
        // B27: no `!` — visible.length > 0 above guarantees [0] exists; unreachable.
        throw new Error('ai: expected at least one visible enemy');
      }
      let nearest: UnitRecord = firstVisible;
      let best = Infinity;
      for (const e of visible) {
        const dx = e.x - ai.baseX;
        const dz = e.z - ai.baseZ;
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          nearest = e;
        }
      }
      // Forward base halfway toward the enemy.
      fx = (ai.baseX + nearest.x) / 2;
      fz = (ai.baseZ + nearest.z) / 2;
    } else {
      const a = ai.personality.expansionAngle;
      fx = ai.baseX + Math.round(detCos(a) * 80);
      fz = ai.baseZ + Math.round(detSin(a) * 80);
    }
    // Phase 9 balance pass (soak finding 6.2): the midpoint can be
    // water (e.g. a river between the bases). A water forward base
    // rejects every land-unit spawn at validateSpawnUnit, permanently
    // capping the AI's army while builtCounts keeps counting the
    // attempts. Nudge the rally point to the nearest dry land in a
    // bounded spiral (deterministic). Fairness note: the map itself is
    // visible to every player (no terrain fog) — this only asks whether
    // land units can rally at the chosen point, the same question the
    // spawn validator answers loudly; the AI still finds naval water
    // by probe spawns, never by scanning the map.
    const dry = terrain
      ? nearestLand(terrain, fx, fz, FORWARD_BASE_WATER_SEARCH_RADIUS)
      : { x: fx, z: fz };
    // No dry rally point in reach (an all-water gap): leave the base
    // unset and retry next think — a later visible enemy may give a
    // better midpoint. Everything below (detachment, attack) still runs.
    if (dry) {
      ai.forwardBase = dry;
      // Send a small detachment to the forward base.
      const detachment: number[] = [];
      for (const u of world.units) {
        if (u.owner !== ai.owner || u.hp <= 0) continue;
        if (UNIT_DEFS[u.kind as UnitKind].domain !== 'land') continue;
        if (u.targetId !== 0) continue; // don't pull units already fighting
        detachment.push(u.id);
        if (detachment.length >= 4) break;
      }
      if (detachment.length > 0) {
        moveGroupTo(world, queue, ai.owner, detachment, dry.x, dry.z);
      }
    }
  }

  // --- Fun-audit B6 (scheduled, escalating, telegraphed offensives):
  //     advance the war schedule before the siege/attack sections read
  //     it. General and marshal inherit this via thinkGeneral /
  //     thinkMarshal.
  thinkOffensive(world, ai);

  // --- Siege state (final-review R2-B): like citizen — count the
  //     quiet thinks with no visible enemy units; visible enemies reset
  //     the count and drop any siege target.
  if (visible.length > 0) {
    ai.siegeQuietThinks = 0;
    ai.siegeTargetBuildingId = 0;
  } else {
    ai.siegeQuietThinks = (ai.siegeQuietThinks ?? 0) + 1;
  }

  // --- Attack: like citizen, but fighters prefer air targets and
  //     missile boats stay in their pack (group order already issued).
  //     (Personality may stagger new attack orders to every other think.)
  if (visible.length > 0 && attacksThisThink(world, ai)) {
    const firstVisible = visible[0];
    if (firstVisible === undefined) {
      // B27: no `!` — visible.length > 0 above guarantees [0] exists; unreachable.
      throw new Error('ai: expected at least one visible enemy');
    }
    let nearest: UnitRecord = firstVisible;
    let best = Infinity;
    for (const e of visible) {
      const dx = e.x - ai.baseX;
      const dz = e.z - ai.baseZ;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        nearest = e;
      }
    }
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      const def = UNIT_DEFS[u.kind as UnitKind];
      if (def.damage <= 0) continue;
      if (u.kind === 'drone' || u.kind === 'awacs') continue; // scouts don't fight
      // Dry magazines don't get new attack orders — they fall back in
      // thinkAmmoRetreats instead (they can't shoot anyway).
      if ((def.ammoCapacity ?? 0) > 0 && u.ammo <= 0) continue;
      // Wing-managed aircraft stay out of the generic attack loop (see
      // the citizen loop above): a same-think embark would go stale at
      // apply and throw.
      if (isSheltered(u)) continue;
      if (def.carrierCapable === true && isConvergingOnCarrier(u)) continue;
      if (u.targetId === nearest.id && u.chasing) continue;
      // Fighters prefer air targets; others take the nearest.
      const targetIsAir = UNIT_DEFS[nearest.kind as UnitKind].domain === 'air';
      if (u.kind === 'fighter' && !targetIsAir) {
        const airTarget = visible.find((e) => UNIT_DEFS[e.kind as UnitKind].domain === 'air');
        if (airTarget) {
          if (u.targetId === airTarget.id && u.chasing) continue;
          // Fighters can target air; the find above guarantees domain.
          attack(world, queue, ai.owner, u.id, airTarget.id);
          continue;
        }
      }
      // Skip units whose weapons can't engage this target's domain.
      if (!canTarget(def, nearest)) continue;
      // Phase 6: carriers with unfilled wings never sail into combat
      // (their wings are filled by thinkCarrierWings first). Pre-B this
      // is always false — the loop is byte-identical to before.
      if (isEmptyWingCarrier(world, u)) continue;
      attack(world, queue, ai.owner, u.id, nearest.id);
    }
  } else if (visible.length === 0 && attacksThisThink(world, ai)) {
    // No visible enemies: escalate to a siege of the enemy base once
    // the quiet persists (final-review R2-B).
    thinkSiege(world, queue, ai);
  }

  // --- Capital ships (marshal, coastal): keep the command ship and
  //     carrier back with the fleet; retreat under 40% hp (spec §7.3).
  if (ai.difficulty === 'marshal' && ai.navalWater) {
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      if (u.kind !== 'commandShip' && u.kind !== 'carrier') continue;
      const def = UNIT_DEFS[u.kind as UnitKind];
      const dx = u.x - ai.navalWater.x;
      const dz = u.z - ai.navalWater.z;
      const hurt = u.hp < def.hp * 0.4;
      const strayed = dx * dx + dz * dz > 60 * 60;
      if ((hurt || strayed) && u.targetId === 0) {
        moveTo(world, queue, ai.owner, u.id, ai.navalWater.x, ai.navalWater.z);
      }
    }
  }

  // --- Age advancement (roadmap B6, 2026-10-02): commander and general
  //     advance ages too — below marshal ~40% of the roster was
  //     unreachable (age-gated units/buildings). Called here so general
  //     and marshal inherit it via thinkGeneral/thinkMarshal. Placed
  //     last so production, research, and logistics have already drawn
  //     from the think's ledger.
  thinkMilitaryAges(world, queue, ai);
}

/**
 * Military age advancement (roadmap B6, 2026-10-02): if the AI can
 * afford the next age, it takes it. Was marshal-only; now shared by
 * commander, general, and marshal. The lower difficulties advance
 * later naturally — their virtual-tax stipend factors (commander 1.0,
 * general 1.5, marshal 2.0) mean the same ledger gate takes longer to
 * clear, which keeps the difficulty curve honest.
 *
 * Choose programs that boost military: Heavy Industry, Cyber Command,
 * Arsenal. Affordability is ledger-aware: the age cost shares the
 * think's budget with research and production (see thinkLedger).
 */
function thinkMilitaryAges(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  const prog = getAgeProgression(getAgeState(world, ai.owner).age);
  if (prog.next && canAffordAgeLedger(world, ai, prog.cost)) {
    let program: string;
    if (prog.next === 'industry') program = 'heavyIndustry';
    else if (prog.next === 'information') program = 'cyberCommand';
    else if (prog.next === 'ascendance') program = 'arsenalProgram';
    else program = prog.programs[0] ?? 'fiberGrid';
    reserveAgeCost(ai, prog.cost);
    advanceAge(world, queue, ai.owner, program);
  }
}

/**
 * General (level 4): faster than Commander, larger army, basic navy.
 * Naval probing + fishing economy on coastal maps (spec §7.3).
 */
function thinkGeneral(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain?: TerrainData,
): void {
  thinkCommander(world, queue, ai, terrain);
  thinkNavalProbe(world, queue, ai);
}

/**
 * Marshal (level 5): hardest fair AI. Combined arms, naval play.
 * Thinks fastest, fields the largest army. (Age advancement is no
 * longer marshal-only — commander and general advance ages too, see
 * thinkMilitaryAges, roadmap B6, 2026-10-02.)
 */
function thinkMarshal(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain?: TerrainData,
): void {
  // Start with General's behavior (includes Commander base + naval probe).
  thinkGeneral(world, queue, ai, terrain);

  // Sea-logistics Half B (2026-10-01): marshal's naval supply tail —
  // fuelTanker/ammoShip ratios, abstract hold-loading, and rallying to
  // the fleet centroid. After thinkGeneral so the land logistics thinks
  // (thinkAbstractResupply) draw first; the ships load from the
  // virtual stocks' remainder.
  thinkNavalSupply(world, queue, ai);

  // --- Superweapons: build the facilities, then use them fairly.
  thinkSuperweapons(world, queue, ai);
}

/**
 * Facility-building defs for the ledger guard below. Costs mirror the
 * player's `stormArray` / `aegisControl` buildings exactly (the
 * constructFacilitySpec in superweapons.ts deducts these at apply).
 */
const SUPERWEAPON_FACILITY_DEFS: Record<'storm' | 'aegis', { costFunds: number; costMaterials: number }> = {
  storm: { costFunds: 6000, costMaterials: 2500 },
  aegis: { costFunds: 5000, costMaterials: 2000 },
};

/**
 * Enqueue a `constructSuperweaponFacility` command with its cost
 * reserved in the per-think ledger (R1 final-review H2). The command
 * deducts at apply (next tick), after the think's earlier ledger-
 * covered spends (production, research, age) have applied — without
 * the reservation those can drain the treasury first and the facility
 * command goes stale at apply, throwing CommandRejectedError out of
 * applyDue → crash in runTick. When the ledger says the cost isn't
 * covered, the facility simply isn't enqueued this think (it retries
 * on the next think tick) — no stale command, no crash.
 */
function reserveSuperweaponFacility(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  kind: 'storm' | 'aegis',
): void {
  const def = SUPERWEAPON_FACILITY_DEFS[kind];
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  const ledger = thinkLedger(ai);
  if (player.funds - ledger.funds < def.costFunds) return;
  if (player.materials - ledger.materials < def.costMaterials) return;
  if (issue(world, queue, 'constructSuperweaponFacility', { owner: ai.owner, kind })) {
    ledger.funds += def.costFunds;
    ledger.materials += def.costMaterials;
  }
}

/**
 * Marshal-only superweapon play (Phase 3). Construction goes through the
 * `constructSuperweaponFacility` command (same cost and build time as the
 * player's buildings); firing goes through `fireAegis` / `fireStorm`.
 * Targeting uses only visible enemies — no fog cheating — and the Storm
 * needs a real cluster (3+ visible enemies) so it isn't wasted.
 *
 * R1 final-review H2 (2026-10-01): the facility command deducts its
 * cost at APPLY (next tick), so the cost is reserved in the per-think
 * ledger BEFORE issue — the same pattern as spawn()/researchForAI().
 * Without the reservation, a same-think spend that applies first
 * (production/research/age, all ledger-covered and enqueued earlier)
 * can push this command stale at apply, and a stale command throws
 * CommandRejectedError out of applyDue → crash in runTick. The guard
 * below makes an unaffordable facility fizzle at think time instead.
 */
function thinkSuperweapons(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  // Peaceful worlds: the AI must not even try — no storm/aegis
  // facilities, no launches (defense in depth; the peaceful dispatch
  // in createAISystem never reaches this branch).
  if (world.peaceful === true) return;
  if (getAgeState(world, ai.owner).age !== 'ascendance') return; // per-side ages: the AI's own age
  // Firing is costless (no ledger needed); the facility construction
  // above is ledger-guarded.
  const enqueue = (kind: string, payload: Record<string, unknown>): void => {
    issue(world, queue, kind, payload);
  };
  // Build each facility once, storm first (offense wins games).
  // Ledger-guarded (see header): the reservation keeps the think's
  // batch from going stale at apply.
  if (ai.superweapons.stormReadyTick === 0) {
    reserveSuperweaponFacility(world, queue, ai, 'storm');
  } else if (ai.superweapons.aegisReadyTick === 0) {
    reserveSuperweaponFacility(world, queue, ai, 'aegis');
  }
  // Fire the Storm at the largest visible enemy cluster.
  // Final-review R5 (2026-10-01): largest-cluster targeting replaces the
  // old all-visible centroid — the centroid of two far-apart skirmishes
  // lands on empty ground between them. For each visible enemy, count
  // neighbors within STORM_RADIUS; fire at the enemy with the most
  // (ties break by lowest unit id — deterministic).
  if (isStormReady(world, ai.owner)) {
    const visible = getVisibleEnemies(world, ai.owner);
    if (visible.length >= 3) {
      let best: (typeof visible)[number] | null = null;
      let bestCount = -1;
      for (const e of visible) {
        let count = 0;
        for (const o of visible) {
          const dx = o.x - e.x;
          const dz = o.z - e.z;
          if (dx * dx + dz * dz <= STORM_RADIUS * STORM_RADIUS) count++;
        }
        if (count > bestCount || (count === bestCount && best !== null && e.id < best.id)) {
          best = e;
          bestCount = count;
        }
      }
      if (best !== null) {
        enqueue('fireStorm', { owner: ai.owner, x: best.x, z: best.z });
      }
    }
  }
  // Raise the Aegis when the army is hurting.
  if (isAegisReady(world, ai.owner)) {
    const hurt = world.units.some((u) => {
      if (u.owner !== ai.owner || u.hp <= 0) return false;
      const def = UNIT_DEFS[u.kind as UnitKind];
      return def !== undefined && u.hp < def.hp * 0.5;
    });
    if (hurt) {
      enqueue('fireAegis', { owner: ai.owner });
    }
  }
}

/** Get age progression info for the current age. */
function getAgeProgression(age: string): { next: string | null; cost: Record<string, number>; programs: string[] } {
  const prog = (AGE_PROGRESSION as Record<string, { next: string | null; cost: Record<string, number>; programs: string[] }>)[age];
  return prog ?? { next: null, cost: {}, programs: [] };
}

/**
 * Ledger-aware age affordability (grand-expansion Phase 6): the age
 * cost shares the think's budget with research and production (see
 * thinkLedger), so the think's batch can never go stale at apply.
 */
function canAffordAgeLedger(world: World, ai: AIPlayerState, cost: Record<string, number>): boolean {
  const player = getPlayer(world.city, ai.owner);
  if (!player) return false;
  const l = thinkLedger(ai);
  for (const [res, amt] of Object.entries(cost)) {
    const have = (player as unknown as Record<string, number>)[res] ?? 0;
    const committed = (l as unknown as Record<string, number>)[res] ?? 0;
    if (have - committed < amt) return false;
  }
  return true;
}

/** Reserve an age cost in the per-think ledger (call after a successful check). */
function reserveAgeCost(ai: AIPlayerState, cost: Record<string, number>): void {
  const l = thinkLedger(ai) as unknown as Record<string, number>;
  for (const [res, amt] of Object.entries(cost)) {
    l[res] = (l[res] ?? 0) + amt;
  }
}

/** Issue an age advancement command. */
function advanceAge(world: World, queue: CommandQueue, owner: number, program: string): void {
  // fromAge makes a same-owner double-advance idempotent: a second
  // enqueue by the same owner on the same tick fizzles instead of going
  // stale at apply (the Phase 9 soak 6.1 race). Per-side ages: the age
  // the OWNER saw — another side's advancement is never a duplicate.
  issue(world, queue, 'advanceAge', { owner, program, fromAge: getAgeState(world, owner).age });
}

// ---------------------------------------------------------------------------
// Grand-expansion Phase 8 (peaceful mode, workstream C): the peaceful AI.
//
// In a peaceful world the Classic AI plays a city-builder, not a
// warlord. Every military think branch is gated behind `!world.peaceful`
// (the canTrain gate above plus the dispatch in createAISystem below),
// and the AI instead grows a real physical city toward the peaceful
// victory (8,000 housed residents + non-negative treasury —
// sim/peaceful.ts):
//  - thinkPeacefulZoning paints three districts once (residential /
//    commercial / industrial) plus a utility rect near the base, using
//    the same validated command a human uses;
//  - thinkPeacefulConstruction places buildings through `placeBuilding`
//    in a fixed economic priority (utilities → commercial engine →
//    housing), scaling power/water/food with measured demand;
//  - thinkPeacefulResearch researches the civilian upgrades at a
//    physical lab; thinkPeacefulAges advances ages with the civilian
//    programs (fiberGrid / greenTech / globalMedia / prosperityProgram).
//
// Owning physical buildings is the one sanctioned exception to the
// "all virtual" rule — and only in peaceful worlds: population is
// counted from physical residential buildings (economy.ts
// recountPopulation), so a virtual-only AI could never win the
// peaceful victory. Sites come from a deterministic scan with
// validatePlacement (never RNG); affordability is ledger-guarded so
// the think's command batch never goes stale at apply. No new AI
// state: the city itself is the record, so snapshots/digests are
// untouched.
//
// The armed scout `drone` is military (unbuildable, see canTrain) and
// the civilian reconUAV/reconPlane need a military-locked airfield —
// in practice the peaceful AI has no scouts. It needs none: with no
// combat and no forward base, no think branch requires vision.
// ---------------------------------------------------------------------------

/** World-coordinate → cell-coordinate (inverse of cellCenterWorld). */
function worldToCell(x: number): number {
  return Math.round((x + MAP_HALF_SIZE - CELL_WORLD_SIZE / 2) / CELL_WORLD_SIZE);
}

/** One peaceful district: a zone-painted rectangle near the base. */
interface PeacefulDistrict {
  zone: number;
  w: number;
  h: number;
  /** Top-left offset (cells) from the AI's base cell. */
  dx: number;
  dz: number;
}

/**
 * Residential / commercial / industrial districts, nominally disjoint.
 *
 * Lazily built (the pathfinding.ts `gridCells()` precedent): ai.ts sits
 * inside the units→city→world→ai import cycle, so reading `ZoneType`
 * (a city.ts value import) at module-eval time sees undefined when ai
 * is first reached through city/world. The first call always lands
 * after the module graph is fully evaluated.
 */
let _peacefulDistricts: PeacefulDistrict[] | undefined;
function peacefulDistricts(): PeacefulDistrict[] {
  if (!_peacefulDistricts) {
    // Compact starter districts. Every painted cell is an invitation
    // for organic growth (workstream Z) to spend the AI's funds — the
    // AI keeps the early footprint tight and expands only once its
    // income engine is solvent. Sizes fit the phase-B engine plus
    // headroom: the commercial district fits the AI's markets plus
    // organic shops (organic builds the cheapest commercial def);
    // the industrial district fits 2 factories + farm + quarry with
    // room for organic farms (it builds the cheapest industrial def).
    // Smaller = less paint cost, less organic spend, more buffer.
    _peacefulDistricts = [
      { zone: ZoneType.RESIDENTIAL, w: 8, h: 8, dx: -12, dz: -12 },
      { zone: ZoneType.COMMERCIAL, w: 6, h: 6, dx: 0, dz: -12 },
      { zone: ZoneType.INDUSTRIAL, w: 8, h: 8, dx: -12, dz: 0 },
    ];
  }
  return _peacefulDistricts;
}

/** Utility buildings need no zoning; they search this rect near the base. */
const PEACEFUL_UTILITY_RECT = { w: 14, h: 14, dx: 0, dz: 0 };

/** Find an all-land, in-bounds w×h rect: nominal first, then a bounded row-major scan. Deterministic. */
function findLandRect(
  t: TerrainData,
  cx0: number,
  cz0: number,
  w: number,
  h: number,
  avoid?: (cx: number, cz: number) => boolean,
): { x0: number; z0: number; x1: number; z1: number } | null {
  const fits = (x: number, z: number): boolean => {
    if (x < 0 || z < 0 || x + w > CITY_GRID_CELLS || z + h > CITY_GRID_CELLS) return false;
    for (let cz = z; cz < z + h; cz++)
      for (let cx = x; cx < x + w; cx++) {
        if (cellIsWater(t, cx, cz)) return false;
        if (avoid && avoid(cx, cz)) return false;
      }
    return true;
  };
  if (fits(cx0, cz0)) return { x0: cx0, z0: cz0, x1: cx0 + w - 1, z1: cz0 + h - 1 };
  for (let dz = -10; dz <= 10; dz++)
    for (let dx = -10; dx <= 10; dx++) {
      if (dx === 0 && dz === 0) continue;
      if (fits(cx0 + dx, cz0 + dz))
        return { x0: cx0 + dx, z0: cz0 + dz, x1: cx0 + dx + w - 1, z1: cz0 + dz + h - 1 };
    }
  return null;
}

/** Resolve one district rect for this AI (null when no all-land rect fits). */
function peacefulDistrictRect(
  terrain: TerrainData,
  ai: AIPlayerState,
  d: PeacefulDistrict,
  avoid?: (cx: number, cz: number) => boolean,
): { x0: number; z0: number; x1: number; z1: number } | null {
  const bcx = worldToCell(ai.baseX);
  const bcz = worldToCell(ai.baseZ);
  return findLandRect(terrain, bcx + d.dx, bcz + d.dz, d.w, d.h, avoid);
}

/**
 * All three district rects, computed in fixed order with each avoiding
 * the earlier ones. Terrain shifts (findLandRect's ±10 search) can push
 * two districts onto the same cells; without this, a later paintZone
 * overwrites the earlier zone and buildings placed on it go stale at
 * apply (the queue's loud-rejection contract crashes the tick).
 * Deterministic: fixed district order, pure terrain reads.
 */
function peacefulDistrictRects(
  terrain: TerrainData,
  ai: AIPlayerState,
): Map<number, { x0: number; z0: number; x1: number; z1: number }> {
  const rects = new Map<number, { x0: number; z0: number; x1: number; z1: number }>();
  const avoid = (cx: number, cz: number): boolean => {
    for (const r of rects.values()) {
      if (cx >= r.x0 && cx <= r.x1 && cz >= r.z0 && cz <= r.z1) return true;
    }
    return false;
  };
  for (const d of peacefulDistricts()) {
    const rect = peacefulDistrictRect(terrain, ai, d, avoid);
    if (rect) rects.set(d.zone, rect);
  }
  return rects;
}

/** True when every cell of the rect already carries the district's zone. */
function peacefulDistrictZoned(
  world: World,
  rect: { x0: number; z0: number; x1: number; z1: number },
  zone: number,
): boolean {
  for (let cz = rect.z0; cz <= rect.z1; cz++)
    for (let cx = rect.x0; cx <= rect.x1; cx++)
      if (zoneAt(world.city, cellIndex(cx, cz)) !== zone) return false;
  return true;
}

/** Paint the three districts once (skips what is already zoned). */
function thinkPeacefulZoning(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain: TerrainData,
): void {
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  const l = thinkLedger(ai);
  const rects = peacefulDistrictRects(terrain, ai);
  for (const d of peacefulDistricts()) {
    const rect = rects.get(d.zone);
    if (!rect || peacefulDistrictZoned(world, rect, d.zone)) continue;
    // paintZone charges 1 fund per newly-painted cell; the ledger keeps
    // the think's batch affordable (paintZone validates affordability
    // at apply, which would otherwise go stale on a multi-district
    // think — the per-think ledger exists precisely for this).
    let fresh = 0;
    for (let cz = rect.z0; cz <= rect.z1; cz++)
      for (let cx = rect.x0; cx <= rect.x1; cx++)
        if (zoneAt(world.city, cellIndex(cx, cz)) !== d.zone) fresh++;
    if (player.funds - l.funds < fresh) continue;
    issue(world, queue, 'paintZone', {
      owner: ai.owner,
      zone: d.zone,
      x0: rect.x0,
      z0: rect.z0,
      x1: rect.x1,
      z1: rect.z1,
    });
    l.funds += fresh;
  }
}

/**
 * Scan a rect row-major for a legal `kind` site (deterministic), skipping
 * cells claimed earlier this think. Affordability is ledger-checked by
 * the caller, so a site that fails validatePlacement only on funds
 * still counts.
 */
/**
 * Phase 9 balance pass (death-spiral fix): fouling avoidance for site
 * selection. A completed, funded plant with `fouling` (the oil-burning
 * powerPlant) fouls orthogonally-adjacent water sources, halving their
 * output (floored). The AI's old sequential scan put the powerPlant
 * right next to the waterPump: 25 → 12 water supply against 16 demand,
 * so the shops (allocated last, highest ids) went unwatered, shop
 * income halved, and the treasury bled out. Returns true when placing
 * `kind` at (cx, cz) would create a fouler↔water-source adjacency in
 * either direction — such sites are skipped.
 */
function peacefulSiteFouls(
  world: World,
  kind: BuildingKind,
  cx: number,
  cz: number,
  /** Cells claimed by buildings placed earlier THIS think (not yet applied). */
  claimed: Map<number, BuildingKind>,
): boolean {
  const def = BUILDING_DEFS[kind];
  if (def.fouling !== true && def.waterSupply <= 0) return false;
  const city = world.city;
  // Orthogonal neighbors of the footprint (diagonals don't foul):
  // the rows/columns just outside each edge.
  const neighbors: Array<[number, number]> = [];
  for (let z = cz; z < cz + def.footprintH; z++) {
    neighbors.push([cx - 1, z]);
    neighbors.push([cx + def.footprintW, z]);
  }
  for (let x = cx; x < cx + def.footprintW; x++) {
    neighbors.push([x, cz - 1]);
    neighbors.push([x, cz + def.footprintH]);
  }
  // A neighbor fouls (or is fouled) when it is a water source next to a
  // fouler, in either direction — whether already applied or merely
  // claimed earlier this think.
  const neighborFouls = (nkind: BuildingKind): boolean => {
    const bdef = BUILDING_DEFS[nkind];
    return (def.fouling === true && bdef.waterSupply > 0) ||
           (def.waterSupply > 0 && bdef.fouling === true);
  };
  for (const [x, z] of neighbors) {
    const cell = cellIndex(x, z);
    const b = buildingAtCell(city, cell);
    if (b !== undefined && neighborFouls(b.kind)) return true;
    const ck = claimed.get(cell);
    if (ck !== undefined && neighborFouls(ck)) return true;
  }
  return false;
}

function findPeacefulSite(
  world: World,
  terrain: TerrainData,
  ai: AIPlayerState,
  kind: BuildingKind,
  rect: { x0: number; z0: number; x1: number; z1: number },
  claimed: Map<number, BuildingKind>,
): { cx: number; cz: number } | null {
  const def = BUILDING_DEFS[kind];
  for (let cz = rect.z0; cz <= rect.z1 - def.footprintH + 1; cz++) {
    for (let cx = rect.x0; cx <= rect.x1 - def.footprintW + 1; cx++) {
      const cells = footprintCells(cx, cz, def.footprintW, def.footprintH);
      let taken = false;
      for (const c of cells) if (claimed.has(c)) { taken = true; break; }
      if (taken) continue;
      const p: Placement = { kind, owner: ai.owner, cx, cz, facing: 0 };
      const err = validatePlacement(terrain, world.city, p);
      if (err === null || err.includes('cannot afford')) {
        // Don't foul your own water (or plant a well next to a fouler).
        if (peacefulSiteFouls(world, kind, cx, cz, claimed)) continue;
        return { cx, cz };
      }
    }
  }
  return null;
}

/** Resolve the search rect for a kind: its district, or the utility rect. */
function peacefulSearchRect(
  world: World,
  terrain: TerrainData,
  ai: AIPlayerState,
  kind: BuildingKind,
): { x0: number; z0: number; x1: number; z1: number } | null {
  const def = BUILDING_DEFS[kind];
  if (def.zone === UTILITY_ZONE) {
    const bcx = worldToCell(ai.baseX);
    const bcz = worldToCell(ai.baseZ);
    const r = PEACEFUL_UTILITY_RECT;
    return findLandRect(terrain, bcx + r.dx, bcz + r.dz, r.w, r.h);
  }
  const d = peacefulDistricts().find((x) => x.zone === def.zone);
  if (!d) return null;
  // The district must actually be painted — not just planned. If the
  // paintZone hasn't applied yet (or failed), validatePlacement would
  // pass at think time on a stale read and go stale at apply, which
  // crashes the tick (the queue's loud-rejection contract).
  const rect = peacefulDistrictRects(terrain, ai).get(d.zone);
  if (!rect || !peacefulDistrictZoned(world, rect, d.zone)) return null;
  return rect;
}

/**
 * Issue one `placeBuilding` for a legal site, ledger-guarding the cost.
 * Never spends the treasury below the peaceful floor
 * (peacefulTreasuryFloor, city.ts): the upkeep shutoff kills the newest
 * buildings first, so spending the last funds darkens the oldest — the
 * power/water the city runs on — and the city can never earn its way
 * back (Phase 9 death-spiral fix). Returns true when a command was issued.
 */
function placePeaceful(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  kind: BuildingKind,
  rect: { x0: number; z0: number; x1: number; z1: number },
  claimed: Map<number, BuildingKind>,
  terrain: TerrainData,
): boolean {
  const player = getPlayer(world.city, ai.owner);
  if (!player) return false;
  const def = BUILDING_DEFS[kind];
  const l = thinkLedger(ai);
  if (player.funds - l.funds - def.costFunds < peacefulTreasuryFloor(world, ai.owner)) return false;
  if (player.materials - l.materials < def.costMaterials) return false;
  const site = findPeacefulSite(world, terrain, ai, kind, rect, claimed);
  if (!site) return false;
  issue(world, queue, 'placeBuilding', {
    kind,
    owner: ai.owner,
    cx: site.cx,
    cz: site.cz,
    facing: 0,
  });
  l.funds += def.costFunds;
  l.materials += def.costMaterials;
  for (const c of footprintCells(site.cx, site.cz, def.footprintW, def.footprintH)) claimed.set(c, kind);
  return true;
}

/**
 * Phase A: survival infrastructure. Utility-zone (no zoning needed),
 * so this is all the AI can place on its first think (zones apply at
 * the next tick start). Nothing else is wanted until this is done —
 * otherwise the walk falls through to civic buildings and the AI
 * spends its opening funds on a school before it has any income.
 */
const PEACEFUL_UTILITIES: Array<{ kind: BuildingKind; max: number }> = [
  { kind: 'waterPump', max: 1 },
  // The only foundation-age power plant (windFarm needs connectivity —
  // it arrives via peacefulNeedKinds once the age advances).
  { kind: 'powerPlant', max: 1 },
];

/**
 * Phase B: the income engine. Needs the painted zones (think 2+).
 * The AI builds the factories — the goods producers that organic
 * growth cannot provide. Two factories (3.0 goods/s) support up to 6
 * shops; organic typically builds 3-4 shops on the commercial
 * district, so two factories guarantee the goods supply never
 * starves the income engine. Shops themselves are built by organic
 * growth (cheapest commercial def), with the AI as fallback if
 * organic doesn't deliver (see peacefulNeedKinds). This keeps the
 * AI's spend lean and leaves the treasury for organic to work with.
 */
const PEACEFUL_ENGINE: Array<{ kind: BuildingKind; max: number }> = [
  { kind: 'factory', max: 2 },
];

/**
 * Phase C: civic core. Wanted only once the engine is placed —
 * education first (completed schools lift organic growth, workstream Z;
 * the lab unlocks the civilian research line).
 */
const PEACEFUL_CIVIC: Array<{ kind: BuildingKind; max: number }> = [
  { kind: 'school', max: 1 },
  { kind: 'lab', max: 1 },
  // Late-game materials scaling: the 1500 starting stock + factory
  // output (2.5/s each) covers the opening; the quarry arrives only
  // when the treasury is rich enough to afford the 350 funds.
  { kind: 'quarry', max: 1 },
];

/**
 * The commercial engine keeps scaling — funds are the binding
 * constraint on the 8,000-resident victory, so commerce is the best
 * investment until the treasury is rich enough to push housing.
 */
const PEACEFUL_COMMERCE_SCALE: Array<{ kind: BuildingKind; max: number }> = [
  { kind: 'market', max: 6 },
  { kind: 'shop', max: 8 },
];

/** Amenities: desirability for organic apartments and land value. */
const PEACEFUL_AMENITIES: Array<{ kind: BuildingKind; max: number }> = [
  { kind: 'library', max: 1 },
  { kind: 'park', max: 2 },
  { kind: 'kindergarten', max: 1 },
  { kind: 'college', max: 1 },
  { kind: 'hospital', max: 1 },
  { kind: 'mediaCenter', max: 1 },
];

/**
 * While the treasury holds this much, housing outranks further
 * commerce: the victory is residents, and a rich AI should convert
 * funds into apartments instead of a seventh market.
 */
const PEACEFUL_HOUSING_FUNDS = 2000;

/** Max placements per think — actions are cheap; funds are the limit. */
const PEACEFUL_PLACEMENTS_PER_THINK = 4;

/**
 * Demand-driven needs, evaluated before the fixed tables every slot:
 * power/water shortfalls first (unserved buildings pay no taxes and
 * produce nothing), then food scaled to population. Deterministic:
 * plain sums over the AI's buildings in stored order.
 */
function peacefulNeedKinds(world: World, ai: AIPlayerState, counts: Map<BuildingKind, number>): BuildingKind[] {
  let powerDemand = 0;
  let powerSupply = 0;
  let waterDemand = 0;
  let waterSupply = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== ai.owner) continue;
    const def = BUILDING_DEFS[b.kind];
    powerDemand += def.powerDemand;
    powerSupply += def.powerSupply;
    waterDemand += def.waterDemand;
    waterSupply += def.waterSupply;
  }
  // Fuel is counted from the caller's map (existing buildings PLUS
  // placements earlier this think): world.city.buildings doesn't have
  // this-think's queued placements yet, so a recount from buildings
  // alone would re-order the same oilWell every slot (the farm
  // precedent above).
  let fuelDemand = 0;
  let fuelSupply = 0;
  for (const [kind, n] of counts) {
    if (n <= 0) continue;
    const def = BUILDING_DEFS[kind];
    fuelDemand += (def.input.fuel ?? 0) * n;
    fuelSupply += (def.output.fuel ?? 0) * n;
  }
  // Farm count comes from the caller's map (which includes buildings
  // placed earlier in THIS think — world.city.buildings doesn't have
  // them yet, so a recount would re-order the same farm every slot).
  const farms = counts.get('farm') ?? 0;
  const needs: BuildingKind[] = [];
  // Cheaper windFarm as the fallback when the big plant is out of reach
  // this think — the placement loop skips unaffordable kinds.
  if (powerSupply < powerDemand) needs.push('powerPlant', 'windFarm');
  if (waterSupply < waterDemand) needs.push('waterPump');
  const player = getPlayer(world.city, ai.owner);
  // Phase 9 balance pass (death-spiral fix): the fuel leg, PACED.
  // The powerPlant (1.0/s) and each factory (0.4/s) burn fuel, and
  // nothing in the opening build produces it. The 400 starting stock
  // is a bridge, not a supply. Build ONE well early (the deficit
  // trigger) — 0.6/s supply against 1.8/s demand stretches the 400
  // stock to ~333 sim-seconds. More wells come only when the stock
  // drops below 200 (about 160s of burn left): by then the shops are
  // earning and the treasury can afford them. Building all three at
  // once (900 funds) during the fragile ramp tips the city into the
  // very death spiral the floor is meant to prevent.
  const wells = counts.get('oilWell') ?? 0;
  if (fuelSupply < fuelDemand && (wells < 1 || (player !== undefined && player.fuel < 200))) {
    needs.push('oilWell');
  }
  const pop = player ? player.population : 0;
  const farmsNeeded = Math.ceil((pop * FOOD_PER_POP_PER_SEC) / 3) + 1;
  if (farms < farmsNeeded) needs.push('farm');
  // Materials: the 1500 starting stock covers the engine (factories
  // produce 2.5 materials/s each, so the stock recovers while the
  // city runs). The quarry is NOT a need — it's late-game scaling,
  // built only when rich (see PEACEFUL_CIVIC below). The old
  // materials-threshold trigger fired during the fragile income ramp
  // (the opening spends ~1340 materials on build costs alone),
  // wasting 350 funds + 0.7/s upkeep on a building the city doesn't
  // need yet.
  return needs;
}

/**
 * The command layer gates placeBuilding on more than validatePlacement:
 * age (minAge), requiredBuilding, requiredUpgrade, and the peaceful
 * military lock. The site pre-check only runs validatePlacement, so
 * filter candidates here — otherwise the AI issues commands the
 * enqueue validate rejects (swallowed by issue(), but the slot and the
 * ledger reservation are wasted). Deterministic: pure world reads.
 */
function peacefulKindAvailable(world: World, ai: AIPlayerState, kind: BuildingKind): boolean {
  const def = BUILDING_DEFS[kind];
  if (world.peaceful === true && def.military === true) return false;
  if (!isBuildingAgeMet(getAgeState(world, ai.owner).age, def.minAge)) return false;
  if (def.requiredBuilding && !hasProductionBuilding(world, ai.owner, def.requiredBuilding)) return false;
  if (def.requiredUpgrade && !hasUpgrade(world, ai.owner, def.requiredUpgrade)) return false;
  return true;
}

/**
 * The peaceful construction brain: for each placement slot, walk the
 * priority and place the first kind that is wanted, ledger-affordable
 * (above the funds reserve), and has a legal site. Order:
 * demand needs (unserved buildings earn nothing) → one-time bootstrap
 * → commerce scale while the treasury is lean → amenities → apartments.
 * While the treasury is rich (>= PEACEFUL_HOUSING_FUNDS) commerce is
 * skipped: the victory is residents, so a rich AI converts funds into
 * apartments instead of a seventh market. Apartments are the infinite
 * sink and always "wanted", so a built-out city grows housing every
 * slot it can afford.
 */
function thinkPeacefulConstruction(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain: TerrainData,
  // Civilian sea trade (Half A, 2026-10-01): the sea-trade harbor phase
  // shares this map (see thinkPeaceful). Optional so existing
  // callers/tests keep compiling.
  claimed: Map<number, BuildingKind> = new Map<number, BuildingKind>(),
): void {
  const counts = new Map<BuildingKind, number>();
  for (const b of world.city.buildings) {
    if (b.owner !== ai.owner) continue;
    counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  }
  // Counts include buildings still under construction (progress < 1):
  // records exist from apply time, so the AI never over-orders while
  // a kind is being built.
  const wanted = (kind: BuildingKind, max: number): boolean =>
    (counts.get(kind) ?? 0) < max;
  const player = getPlayer(world.city, ai.owner);
  const rich = player !== undefined && player.funds >= PEACEFUL_HOUSING_FUNDS;
  // `claimed` is the thinkPeaceful-shared claim map (Half A) — no local
  // redeclaration.
  for (let slot = 0; slot < PEACEFUL_PLACEMENTS_PER_THINK; slot++) {
    const candidates: BuildingKind[] = [...peacefulNeedKinds(world, ai, counts)];
    // Phase gating: utilities → engine → everything else. The phases
    // are checked on PLACED counts (any progress), so a phase that is
    // mid-construction still counts — the AI doesn't stall waiting for
    // build times. Without this, the first think (before the zones
    // apply) falls through to civic buildings and the AI spends its
    // opening funds on a school before it has any income.
    const utilitiesDone =
      (counts.get('waterPump') ?? 0) >= 1 && (counts.get('powerPlant') ?? 0) >= 1;
    // The engine is the factories; shops are built by organic growth —
    // but if organic hasn't built any by the time the factories are up,
    // the AI builds them itself (fallback, not the primary plan).
    const engineDone = (counts.get('factory') ?? 0) >= 2;
    // Phase C (civic, commerce-scale, amenities, housing) also needs a
    // rich treasury — not just a placed engine. The engine takes ~60
    // sim-seconds to come online (build times); spending on non-earners
    // before the income stabilizes tips the city into the upkeep death
    // spiral (funds hit 0 → nothing operational → no income → permanent
    // stall). The rich threshold (2000) is the same one that gates
    // housing: if the AI can't afford apartments, it can't afford
    // amenities either.
    for (const r of PEACEFUL_UTILITIES) if (wanted(r.kind, r.max)) candidates.push(r.kind);
    if (utilitiesDone) {
      for (const r of PEACEFUL_ENGINE) if (wanted(r.kind, r.max)) candidates.push(r.kind);
    }
    // Income scaling: once the engine is placed but the treasury isn't
    // rich yet, build more commerce (shops/markets) — not civic or
    // housing. Commerce earns; everything else spends.
    if (engineDone && !rich) {
      for (const r of PEACEFUL_COMMERCE_SCALE) if (wanted(r.kind, r.max)) candidates.push(r.kind);
    }
    // Early housing: the AI guarantees population growth itself instead
    // of relying on organic growth. Houses are cheap (120 funds) and
    // ensure the city grows even if organic builds slowly. Built when
    // the treasury has a comfortable buffer (500+) — not the full rich
    // threshold, which takes too long to reach.
    if (engineDone && player !== undefined && player.funds >= 500) {
      if (wanted('house', 10)) candidates.push('house');
    }
    if (engineDone && rich) {
      for (const r of PEACEFUL_CIVIC) if (wanted(r.kind, r.max)) candidates.push(r.kind);
      for (const r of PEACEFUL_AMENITIES) if (wanted(r.kind, r.max)) candidates.push(r.kind);
      candidates.push('apartment');
    }
    let placed = false;
    for (const kind of candidates) {
      if (!peacefulKindAvailable(world, ai, kind)) continue;
      const rect = peacefulSearchRect(world, terrain, ai, kind);
      if (!rect) continue;
      if (placePeaceful(world, queue, ai, kind, rect, claimed, terrain)) {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        placed = true;
        break;
      }
    }
    if (!placed) break;
  }
}
/**
 * Civilian sea trade (Half A, 2026-10-01; naval-building model,
 * 2026-10-01): the peaceful AI's sea-trade program. Three phases, in
 * fixed order:
 *
 *  1. Shipyard + docks: build ONE commercialHarbor (the civilian
 *     shipyard — cargoFreighters/barges REQUIRE it, so the AI must
 *     have one) and up to 2 commercialPort docks (the route
 *     endpoints — the no-blur rule: routes anchor at docks, never at
 *     the shipyard). Base-centered sweep (the coastal rule is enforced
 *     by validatePlacement, so the site search only accepts shoreline
 *     footprints). Rich-treasury gated — a shipyard is 1000 funds +
 *     400 materials, a dock 800 + 300, a civic-scale spend.
 *  2. Route: once 2 docks are completed, establish one 'funds' route
 *     between them (the 500 setup is ledger-reserved like any spend).
 *  3. Ships: spawn up to 2 cargoFreighters at the shipyard's water
 *     cell and assign every unassigned AI freighter to the route.
 *
 * No new AI state (everything is derived from the world), no RNG (the
 * site scan is row-major, the phases are fixed) — same seed, same game.
 * Runs inside thinkPeaceful's terrain branch, after construction, and
 * shares its claim map so a shipyard/dock can never overlap a
 * same-think construction placement.
 */
const PEACEFUL_SEA_SHIPYARD_MAX = 1;
const PEACEFUL_SEA_DOCK_MAX = 2;
const PEACEFUL_SEA_FREIGHTERS_PER_ROUTE = 2;
/** Base-centered coastal site search radius, in cells. */
const PEACEFUL_SEA_SITE_RADIUS = 30;

/**
 * The water cell a shipyard's ships spawn at: the lowest-index water
 * cell in the footprint ring. Mirrors movement.harborWaterCell's
 * deterministic pick, reimplemented here on cellIsWater (already
 * imported) so ai.ts needs no new module edge.
 */
function peacefulHarborWaterCell(
  t: TerrainData,
  b: { cx: number; cz: number },
): { x: number; z: number } | null {
  const def = BUILDING_DEFS['commercialHarbor'];
  let best = -1;
  for (let dx = -1; dx <= def.footprintW; dx++) {
    for (let dz = -1; dz <= def.footprintH; dz++) {
      // Ring only: skip the footprint interior.
      if (dx >= 0 && dx < def.footprintW && dz >= 0 && dz < def.footprintH) continue;
      const cx = b.cx + dx;
      const cz = b.cz + dz;
      if (cx < 0 || cz < 0 || cx >= CITY_GRID_CELLS || cz >= CITY_GRID_CELLS) continue;
      const cell = cz * CITY_GRID_CELLS + cx;
      if (cellIsWater(t, cx, cz) && (best < 0 || cell < best)) best = cell;
    }
  }
  if (best < 0) return null;
  return {
    x: cellCenterWorld(best % CITY_GRID_CELLS),
    z: cellCenterWorld(Math.floor(best / CITY_GRID_CELLS)),
  };
}

function thinkPeacefulSeaTrade(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain: TerrainData,
  claimed: Map<number, BuildingKind>,
): void {
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  const rich = player.funds >= PEACEFUL_HOUSING_FUNDS;
  const bcx = worldToCell(ai.baseX);
  const bcz = worldToCell(ai.baseZ);
  const r = PEACEFUL_SEA_SITE_RADIUS;
  // Base-centered sweep (row-major, deterministic): the first coastal
  // site wins. findPeacefulSite validates through validatePlacement,
  // so the portType coastal rule is enforced — inland sweeps simply
  // find nothing and the AI stays landlocked.
  const rect = { x0: bcx - r, z0: bcz - r, x1: bcx + r, z1: bcz + r };
  // Phase 1: the shipyard (one only — freighters/barges require it),
  // then the docks. Counts include this think's placements (records
  // don't exist until the command applies, like
  // thinkPeacefulConstruction's counts). One placement per kind per
  // think — the treasury-floor guard runs per placement.
  let shipyards = world.city.buildings.filter(
    (b) => b.owner === ai.owner && b.kind === 'commercialHarbor',
  ).length;
  if (
    shipyards < PEACEFUL_SEA_SHIPYARD_MAX &&
    rich &&
    peacefulKindAvailable(world, ai, 'commercialHarbor')
  ) {
    if (placePeaceful(world, queue, ai, 'commercialHarbor', rect, claimed, terrain)) {
      shipyards++;
    }
  }
  let docks = world.city.buildings.filter(
    (b) => b.owner === ai.owner && b.kind === 'commercialPort',
  ).length;
  if (
    docks < PEACEFUL_SEA_DOCK_MAX &&
    rich &&
    peacefulKindAvailable(world, ai, 'commercialPort')
  ) {
    if (placePeaceful(world, queue, ai, 'commercialPort', rect, claimed, terrain)) {
      docks++;
    }
  }
  // Phase 2: the route. Completed docks only (the no-blur rule — the
  // sim's establishSeaRoute validation is authoritative: issue()
  // swallows the rejection if a dock was demolished between think and
  // apply).
  const completed = world.city.buildings.filter(
    (b) => b.owner === ai.owner && b.kind === 'commercialPort' && b.progress >= 1,
  );
  const route = (world.city.seaRoutes ?? []).find((x) => x.owner === ai.owner) ?? null;
  if (route === null && completed.length >= 2 && rich) {
    const a = completed[0];
    const c = completed[1];
    if (a === undefined || c === undefined) {
      // B27: no `!` — completed.length >= 2 above guarantees both exist; unreachable.
      throw new Error('ai: expected two completed commercial ports');
    }
    const l = thinkLedger(ai);
    // Ledger-reserve the 500 setup (the Phase 7 rule: a think's batch
    // can never go stale at apply) without dropping below the peaceful
    // treasury floor — placePeaceful's guard, applied to the route.
    if (player.funds - l.funds - SEA_ROUTE_SETUP_COST >= peacefulTreasuryFloor(world, ai.owner)) {
      if (
        issue(world, queue, 'establishSeaRoute', {
          owner: ai.owner,
          from: a.id,
          to: c.id,
          policy: 'funds',
        })
      ) {
        l.funds += SEA_ROUTE_SETUP_COST;
      }
    }
  }
  // Phase 3: the ships. Spawn idle freighters at the completed
  // shipyard's water cell (spawn() ledger-guards manpower/funds/
  // materials; the spawnUnit validator enforces the commercialHarbor
  // gate and the water spawn loudly), then assign every unassigned AI
  // freighter to the route.
  const completedShipyards = world.city.buildings.filter(
    (b) => b.owner === ai.owner && b.kind === 'commercialHarbor' && b.progress >= 1,
  );
  if (route !== null && completedShipyards.length >= 1) {
    const assigned = world.units.filter(
      (u) => u.owner === ai.owner && (u.seaRouteId ?? 0) === route.id,
    ).length;
    let want = PEACEFUL_SEA_FREIGHTERS_PER_ROUTE - assigned;
    if (want > 0) {
      // Freighters are built at the civilian shipyard, not the docks
      // (the no-blur rule) — the shipyard's water cell is the spawn
      // point.
      const anchor = completedShipyards[0];
      if (anchor === undefined) {
        // B27: no `!` — completedShipyards.length >= 1 above guarantees [0] exists; unreachable.
        throw new Error('ai: expected a completed commercial harbor');
      }
      const water = peacefulHarborWaterCell(terrain, anchor);
      if (water !== null) {
        while (want > 0) {
          if (!spawn(world, queue, ai, 'cargoFreighter', water.x, water.z)) break;
          want--;
        }
      }
    }
    for (const u of world.units) {
      if (u.owner !== ai.owner) continue;
      if (u.kind !== 'cargoFreighter') continue;
      if ((u.seaRouteId ?? 0) !== 0) continue;
      issue(world, queue, 'assignSeaRoute', {
        owner: ai.owner,
        unitId: u.id,
        routeId: route.id,
      });
    }
  }
}

/**
 * The civilian research line, in fixed priority order (workstream A's
 * classification: these 10 upgrades are all non-military). Needs a
 * completed physical lab — researchForAI checks availability and
 * affordability; military defs are filtered defensively even though
 * the table holds none.
 */
const PEACEFUL_RESEARCH_PRIORITY: UpgradeId[] = [
  'precisionManufacturing',
  'smartGrid',
  'verticalFarming',
  'freeTrade',
  'combustionTech',
  'groundwaterSurvey',
  'desalinationTech',
  'gridStorage',
  'advancedNuclear',
  'fusionResearch',
];

function thinkPeacefulResearch(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  // researchUpgrade needs a completed physical lab (hasProductionBuilding
  // requires progress >= 1 for real buildings).
  if (!hasProductionBuilding(world, ai.owner, 'lab')) return;
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  const l = thinkLedger(ai);
  for (const id of PEACEFUL_RESEARCH_PRIORITY) {
    const def = UPGRADE_DEFS[id];
    if (!def || def.military === true) continue;
    if (hasUpgrade(world, ai.owner, id)) continue;
    if (!isUnitAvailableForAge(world, ai.owner, def.minAge)) continue;
    if (player.funds - l.funds < def.costFunds) continue;
    if (player.research - l.research < def.costResearch) continue;
    researchForAI(world, queue, ai, id);
    return; // one upgrade per think — the lab trickles research income
  }
}

/** Civilian age programs — the peaceful counterparts to the war paths. */
const PEACEFUL_AGE_PROGRAMS: Record<string, string> = {
  connectivity: 'fiberGrid',
  industry: 'greenTech',
  information: 'globalMedia',
  ascendance: 'prosperityProgram',
};

function thinkPeacefulAges(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  // Per-side ages (2026-10-01, roadmap A1): every side advances (and
  // pays) independently — the peaceful AI advances its own age state,
  // racing nobody. The command validates (wrong program for the
  // current age, unaffordable → loud rejection, swallowed by issue),
  // so a same-owner double-enqueue is harmless.
  const prog = AGE_PROGRESSION[getAgeState(world, ai.owner).age];
  if (!prog || !prog.next) return;
  const program = PEACEFUL_AGE_PROGRAMS[prog.next];
  if (!program) return;
  if (!canAffordAgeLedger(world, ai, prog.cost)) return;
  reserveAgeCost(ai, prog.cost);
  advanceAge(world, queue, ai.owner, program);
}

/**
 * The peaceful think: a city-builder playing to win the peaceful
 * victory. Runs instead of every military think branch (see the
 * dispatch in createAISystem). Without terrain there is nothing safe
 * to site — zoning and construction are skipped, but research and
 * ages still run.
 */
function thinkPeaceful(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain?: TerrainData,
): void {
  if (terrain) {
    thinkPeacefulZoning(world, queue, ai, terrain);
    // Civilian sea trade (Half A, 2026-10-01): construction and the
    // sea-trade harbor phase share one claim map so a harbor can never
    // overlap a same-think construction placement.
    const claimed = new Map<number, BuildingKind>();
    thinkPeacefulConstruction(world, queue, ai, terrain, claimed);
    thinkPeacefulSeaTrade(world, queue, ai, terrain, claimed);
  }
  thinkPeacefulResearch(world, queue, ai);
  thinkPeacefulAges(world, queue, ai);
}

/**
 * The AI system. Runs every tick; each AI player thinks on its own
 * cadence. Issues commands through the queue — never mutates world
 * state directly (except its own `world.ai` state, which is plain data,
 * and the virtual-building economy credit, which mirrors the economy
 * system for real buildings).
 *
 * Grand-expansion Phase 8 (peaceful mode, workstream C): `terrain` is
 * optional for legacy callers, but the peaceful AI needs it to site
 * physical buildings — without it, zoning and construction are
 * skipped (research and ages still run). In a peaceful world every AI
 * player runs thinkPeaceful instead of the military thinks below; the
 * military branches are never reached, so the AI cannot even attempt
 * a rejected military order (canTrain gates the defs too).
 */
export type OpponentMode = 'classic' | 'muse';

export type MuseThinker = (
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  terrain?: TerrainData,
) => void;

export function createAISystem(
  queue: CommandQueue,
  terrain?: TerrainData,
  opponentMode: OpponentMode = 'classic',
  museThinker?: MuseThinker,
): SimSystem {
  // The AI researches upgrades via `researchUpgrade`; make sure the kind
  // is registered even if session setup hasn't wired it (registering
  // twice throws, so tolerate the already-registered case — the UI may
  // wire it independently later).
  try {
    registerUpgradeCommands(queue);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('already registered')) throw e;
  }
  // Grand-expansion Phase 7 (AI intel play): the AI issues covert-op
  // commands (infiltrateBuilding/sabotage/stealTech) through the queue —
  // make sure the intel commands are registered too (same
  // already-registered tolerance; the UI wires them independently).
  try {
    registerIntelCommands(queue);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('already registered')) throw e;
  }
  return (world: World) => {
    creditVirtualEconomy(world);
    // Grand-expansion Phase 6: the virtual intel asset credit (same
    // 1 Hz cadence as the virtual economy credit).
    creditVirtualIntel(world);
    // Deterministic iteration: AI players in fixed owner order. A sorted
    // COPY — the stored registration order is never mutated; the player
    // objects (and their nextThinkTick updates) are shared references.
    const players = [...world.ai.players].sort((a, b) => a.owner - b.owner);
    for (const ai of players) {
      if (world.tick < ai.nextThinkTick) continue;
      ai.nextThinkTick = world.tick + AI_THINK_TICKS[ai.difficulty];
      // Reset the per-think spend ledger (see thinkLedger): the think's
      // command batch must never go stale at apply.
      thinkLedgers.set(ai, { funds: 0, materials: 0, manpower: 0, research: 0, influence: 0, operational: 0, surveillance: 0 });
      if (world.peaceful === true) {
        // Grand-expansion Phase 8 (peaceful mode): the AI plays a
        // city-builder toward the peaceful victory — none of the
        // military thinks below run, so no military order can even be
        // formed (canTrain also gates military defs at the source).
        thinkPeaceful(world, queue, ai, terrain);
        continue;
      }
      if (opponentMode === 'muse' && museThinker) {
        museThinker(world, queue, ai, terrain);
        continue;
      }
      switch (ai.difficulty) {
        case 'cadet':
          thinkCadet(world, queue, ai);
          break;
        case 'citizen':
          thinkCitizen(world, queue, ai);
          break;
        case 'commander':
          thinkCommander(world, queue, ai, terrain);
          break;
        case 'general':
          thinkGeneral(world, queue, ai, terrain);
          break;
        case 'marshal':
          thinkMarshal(world, queue, ai, terrain);
          break;
      }
    }
  };
}

/** Canonical JSON-safe encoding of one AI personality (key order fixed). */
function encodePersonality(p: AIPersonality): unknown {
  const weights = Object.keys(p.mixWeights)
    .sort()
    .reduce<Record<string, number>>((acc, k) => {
      const v = p.mixWeights[k];
      if (v !== undefined) acc[k] = v;
      return acc;
    }, {});
  return {
    aggression: p.aggression,
    expansionEagerness: p.expansionEagerness,
    mixWeights: weights,
    researchOrder: [...p.researchOrder],
    expansionAngle: p.expansionAngle,
    attackEveryNthThink: p.attackEveryNthThink,
    expansionUnitThreshold: p.expansionUnitThreshold,
    scoutStartIndex: p.scoutStartIndex,
  };
}

/**
 * Restore a personality from a snapshot payload. Missing fields (legacy
 * snapshots pre-personality) or malformed values fall back to
 * NEUTRAL_PERSONALITY, which reproduces pre-personality behavior
 * exactly — so old saves load without a snapshot version bump (the
 * step-7 precedent for AI-state additions).
 */
function decodePersonality(data: unknown): AIPersonality {
  const d = (data ?? {}) as Partial<Record<keyof AIPersonality, unknown>>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const clamp01 = (v: unknown, fallback: number): number =>
    Math.min(1, Math.max(0, num(v, fallback)));
  const mixWeights: Record<string, number> = {};
  const mw = d.mixWeights;
  if (mw !== null && typeof mw === 'object') {
    for (const [k, v] of Object.entries(mw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) mixWeights[k] = v;
    }
  }
  const validResearch = new Set<UpgradeId>(
    RESEARCH_PRIORITY.slice(RESEARCH_HEAD_COUNT).map((c) => c.id),
  );
  const researchOrder: UpgradeId[] = [];
  if (Array.isArray(d.researchOrder)) {
    for (const id of d.researchOrder) {
      if (
        typeof id === 'string' &&
        validResearch.has(id as UpgradeId) &&
        !researchOrder.includes(id as UpgradeId)
      ) {
        researchOrder.push(id as UpgradeId);
      }
    }
  }
  const eut = d.expansionUnitThreshold;
  const ssi = d.scoutStartIndex;
  return {
    aggression: clamp01(d.aggression, NEUTRAL_PERSONALITY.aggression),
    expansionEagerness: clamp01(d.expansionEagerness, NEUTRAL_PERSONALITY.expansionEagerness),
    mixWeights,
    researchOrder,
    expansionAngle: num(d.expansionAngle, NEUTRAL_PERSONALITY.expansionAngle),
    attackEveryNthThink: d.attackEveryNthThink === 2 ? 2 : 1,
    expansionUnitThreshold:
      typeof eut === 'number' && Number.isInteger(eut) && eut >= 1
        ? eut
        : NEUTRAL_PERSONALITY.expansionUnitThreshold,
    scoutStartIndex:
      typeof ssi === 'number' && Number.isInteger(ssi) && ssi >= 0
        ? ssi
        : NEUTRAL_PERSONALITY.scoutStartIndex,
  };
}

/**
 * Canonical JSON-safe encoding of AI state for snapshots and digests.
 * Players in registration order; builtCounts and mixWeights keys sorted.
 */
export function encodeAIState(ai: AIState): unknown {
  return {
    players: ai.players.map((p) => ({
      owner: p.owner,
      difficulty: p.difficulty,
      // Mode 2 (2026-10-04): behavior-affecting ⇒ snapshotted.
      // Missing (pre-Mode-2 snapshots) decodes to 'classic' — no
      // version bump (AD9).
      opponentMode: p.opponentMode ?? 'classic',
      baseX: p.baseX,
      baseZ: p.baseZ,
      nextThinkTick: p.nextThinkTick,
      forwardBase: p.forwardBase ? { x: p.forwardBase.x, z: p.forwardBase.z } : null,
      scoutIndex: p.scoutIndex,
      superweapons: {
        aegisReadyTick: p.superweapons?.aegisReadyTick ?? 0,
        stormReadyTick: p.superweapons?.stormReadyTick ?? 0,
      },
      virtualBuildings: {
        completed: [...(p.virtualBuildings?.completed ?? [])],
        constructing: p.virtualBuildings?.constructing
          ? { ...p.virtualBuildings.constructing }
          : null,
      },
      navalStatus: p.navalStatus ?? 'unknown',
      navalProbeIndex: p.navalProbeIndex ?? 0,
      navalWater: p.navalWater ? { x: p.navalWater.x, z: p.navalWater.z } : null,
      seenSubmarine: p.seenSubmarine ?? false,
      // A2 (2026-10-01): the seen-building latch. The array is mutated
      // in place by getKnownEnemyBuildings (latched.push), so it MUST be
      // copied here — capturing the reference would alias the live AI
      // state, and a snapshot taken mid-game would silently absorb
      // post-snapshot sightings (caught by the phase9 save/load soak).
      seenBuildingIds: [...(p.seenBuildingIds ?? [])],
      // Phase 3 logistics (workstream 3): virtual depot stocks. ?? 0 so
      // pre-logistics snapshots decode to empty — no version bump (AD9).
      virtualAmmoStock: p.virtualAmmoStock ?? 0,
      virtualFuelStock: p.virtualFuelStock ?? 0,
      // C1 (AI physical forward base, 2026-10-02): the tracked
      // forward-depot buildings. Missing (pre-C1 snapshots) decodes
      // to [] — no version bump (AD9).
      forwardDepots: (p.forwardDepots ?? []).map((e) => ({
        kind: e.kind,
        buildingId: e.buildingId,
        destroyedTick: e.destroyedTick,
      })),
      // Grand-expansion Phase 7 (AI intel play): the virtual intel
      // queue. Missing (pre-Phase-6 snapshots) decodes to the default —
      // no version bump (AD9).
      intel: encodeAIIntelState(p.intel),
      // Final-review R2-B (AI siege doctrine): the siege campaign
      // state. ?? 0 so pre-siege snapshots decode to "no siege in
      // progress" — no version bump (AD9).
      siegeQuietThinks: p.siegeQuietThinks ?? 0,
      siegeTargetBuildingId: p.siegeTargetBuildingId ?? 0,
      // Fun-audit B6 (scheduled AI offensives): the war schedule.
      // Missing (pre-B6 snapshots) decodes to undefined — the schedule
      // (re)initializes on the next think, no version bump (AD9). The
      // object is never mutated in place after decode... it IS mutated
      // by thinkOffensive, so copy it here like seenBuildingIds (the
      // phase9 aliasing lesson).
      offensive: p.offensive
        ? {
            nextPhase: p.offensive.nextPhase,
            launchTick: p.offensive.launchTick,
            telegraphTick: p.offensive.telegraphTick,
            telegraphed: p.offensive.telegraphed,
            activePhase: p.offensive.activePhase,
            activeUntilTick: p.offensive.activeUntilTick,
          }
        : undefined,
      personality: encodePersonality(p.personality ?? NEUTRAL_PERSONALITY),
      builtCounts: Object.keys(p.builtCounts).sort().reduce<Record<string, number>>(
        (acc, k) => {
          const v = p.builtCounts[k];
          if (v !== undefined) acc[k] = v;
          return acc;
        },
        {},
      ),
    })),
  };
}

/** Restore AI state from a snapshot payload (see snapshot.ts). */
export function decodeAIState(data: unknown): AIState {
  const d = data as {
    players: {
      owner: number;
      difficulty: AIDifficulty;
      // Mode 2 (2026-10-04): pre-Mode-2 snapshots carry no mode —
      // decodes to 'classic' (AD9).
      opponentMode?: OpponentMode;
      baseX: number;
      baseZ: number;
      nextThinkTick: number;
      forwardBase: { x: number; z: number } | null;
      scoutIndex: number;
      builtCounts: Record<string, number>;
      superweapons?: { aegisReadyTick: number; stormReadyTick: number };
      virtualBuildings?: {
        completed?: BuildingKind[];
        constructing?: { kind: BuildingKind; readyTick: number } | null;
      };
      navalStatus?: AINavalStatus;
      navalProbeIndex?: number;
      navalWater?: { x: number; z: number } | null;
      seenSubmarine?: boolean;
      // A2 (2026-10-01): pre-A2 snapshots have no latch — decodes to
      // empty (AD9).
      seenBuildingIds?: number[];
      virtualAmmoStock?: number;
      virtualFuelStock?: number;
      // C1 (AI physical forward base, 2026-10-02): pre-C1 snapshots
      // carry no forward-depot tracker — decodes to [] (AD9).
      forwardDepots?: Array<{
        kind: 'fuelDepot' | 'ordnanceDepot' | 'radarStation';
        buildingId?: number;
        destroyedTick?: number;
      }>;
      // Final-review R2-B (AI siege doctrine): pre-siege snapshots
      // carry neither field (AD9).
      siegeQuietThinks?: number;
      siegeTargetBuildingId?: number;
      // Fun-audit B6 (scheduled AI offensives): pre-B6 snapshots carry
      // no schedule — decodes to undefined and the schedule
      // (re)initializes on the next think (AD9).
      offensive?: {
        nextPhase?: number;
        launchTick?: number;
        telegraphTick?: number;
        telegraphed?: boolean;
        activePhase?: number;
        activeUntilTick?: number;
      };
      personality?: unknown;
      // Grand-expansion Phase 7 (AI intel play): pre-Phase-6 snapshots
      // have no intel block — it decodes to the default (AD9).
      intel?: {
        constructing?: { kind: BuildingKind; readyTick: number } | null;
        counterIntelSurge?: boolean;
        ops?: { infiltrate?: number; sabotage?: number; steal?: number };
      };
    }[];
  };
  return {
    players: (d.players ?? []).map((p) => ({
      owner: p.owner,
      difficulty: p.difficulty,
      // Mode 2 (2026-10-04): missing decodes to 'classic' — no version
      // bump (AD9).
      opponentMode: p.opponentMode ?? 'classic',
      baseX: p.baseX,
      baseZ: p.baseZ,
      nextThinkTick: p.nextThinkTick,
      forwardBase: p.forwardBase ? { x: p.forwardBase.x, z: p.forwardBase.z } : null,
      scoutIndex: p.scoutIndex,
      builtCounts: { ...p.builtCounts },
      superweapons: {
        aegisReadyTick: p.superweapons?.aegisReadyTick ?? 0,
        stormReadyTick: p.superweapons?.stormReadyTick ?? 0,
      },
      virtualBuildings: {
        completed: [...(p.virtualBuildings?.completed ?? [])],
        constructing: p.virtualBuildings?.constructing
          ? { ...p.virtualBuildings.constructing }
          : null,
      },
      navalStatus: p.navalStatus ?? 'unknown',
      navalProbeIndex: p.navalProbeIndex ?? 0,
      navalWater: p.navalWater ? { x: p.navalWater.x, z: p.navalWater.z } : null,
      seenSubmarine: p.seenSubmarine ?? false,
      // A2 (2026-10-01): copy the latch — restoreSnapshot promises the
      // result shares no references with the snapshot, and a restored
      // world that keeps ticking mutates this array in place.
      seenBuildingIds: [...(p.seenBuildingIds ?? [])],
      // Phase 3 logistics (workstream 3): ?? 0 keeps pre-logistics saves
      // loading with empty virtual stocks — no version bump (AD9).
      virtualAmmoStock: p.virtualAmmoStock ?? 0,
      virtualFuelStock: p.virtualFuelStock ?? 0,
      // C1 (AI physical forward base): pre-C1 saves have no tracker —
      // decode to [] (no version bump, AD9).
      forwardDepots: (p.forwardDepots ?? []).map((e) => ({
        kind: e.kind,
        buildingId: e.buildingId ?? 0,
        destroyedTick: e.destroyedTick ?? -1,
      })),
      // Grand-expansion Phase 7 (AI intel play): missing (pre-Phase-6
      // snapshots) decodes to the default — no version bump (AD9).
      intel: decodeAIIntelState(p.intel),
      // Final-review R2-B (AI siege doctrine): missing (pre-siege
      // snapshots) decodes to "no siege in progress" — no version
      // bump (AD9).
      siegeQuietThinks: p.siegeQuietThinks ?? 0,
      siegeTargetBuildingId: p.siegeTargetBuildingId ?? 0,
      // Fun-audit B6 (scheduled AI offensives): missing (pre-B6
      // snapshots) decodes to undefined — the schedule (re)initializes
      // on the next think (AD9). Copy the object: thinkOffensive
      // mutates it in place, and restoreSnapshot promises no shared
      // references (the phase9 aliasing lesson).
      offensive: p.offensive
        ? {
            nextPhase: p.offensive.nextPhase ?? 1,
            launchTick: p.offensive.launchTick ?? 0,
            telegraphTick: p.offensive.telegraphTick ?? 0,
            telegraphed: p.offensive.telegraphed ?? false,
            activePhase: p.offensive.activePhase ?? 0,
            activeUntilTick: p.offensive.activeUntilTick ?? 0,
          }
        : undefined,
      personality: decodePersonality(p.personality),
    })),
  };
}

/** Encode the AI's virtual intel state (plain data, AD9-safe). */
export function encodeAIIntelState(intel: AIIntelState | undefined): unknown {
  const d = intel ?? defaultAIIntelState();
  return {
    constructing: d.constructing ? { ...d.constructing } : null,
    counterIntelSurge: d.counterIntelSurge,
    ops: { ...d.ops },
  };
}

/** Decode the AI's virtual intel state (missing ⇒ default, AD9). */
export function decodeAIIntelState(
  data:
    | {
        constructing?: { kind: BuildingKind; readyTick: number } | null;
        counterIntelSurge?: boolean;
        ops?: { infiltrate?: number; sabotage?: number; steal?: number };
      }
    | undefined,
): AIIntelState {
  const d = defaultAIIntelState();
  if (!data) return d;
  return {
    constructing: data.constructing ? { ...data.constructing } : null,
    counterIntelSurge: data.counterIntelSurge ?? false,
    ops: {
      infiltrate: data.ops?.infiltrate ?? 0,
      sabotage: data.ops?.sabotage ?? 0,
      steal: data.ops?.steal ?? 0,
    },
  };
}

// Re-export for tests that need the UnitRecord type.
export type { UnitRecord };
export { findUnit };
