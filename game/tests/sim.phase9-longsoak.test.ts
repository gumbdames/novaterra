/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This file is part of NOVATERRA. NOVATERRA is free software: you can
 * redistribute it and/or modify it under the terms of the GNU Affero General
 * Public License as published by the Free Software Foundation, either version
 * 3 of the License, or (at your option) any later version.
 *
 * NOVATERRA is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with NOVATERRA. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — Phase 9, workstream A: long AI-vs-AI soaks with headline-system
 * usage metrics.
 *
 * Unlike the 3600-tick soaks elsewhere in this directory (about 2 game-minutes
 * each), these games run to a natural conclusion — victory/defeat — or a
 * generous tick cap (20–50k ticks, i.e. 11–28 game-minutes), whichever comes
 * first. Each game wires the full production stack exactly as the real game
 * session does (`ui/session.ts`): core, city, economy, unit, movement, combat,
 * intel, logistics, age, superweapon and upgrade commands plus the pathfinding,
 * movement, combat, superweapon, economy, intel, mayor, general and AI systems.
 *
 * Metrics collected per game (no sim changes — sampling only):
 *   - units trained per kind (unit ids are never reused, so a sampled id Set
 *     counts every training event), kills inflicted, live army value
 *   - AI virtual buildings completed, physical buildings placed per kind
 *   - upgrades researched, intel ops run (infiltrate/sabotage/steal)
 *   - peak embarked wings and peak hangar-parked aircraft
 *   - virtual depot stocks: peak and final (draw-down signal)
 *   - airline routes, roads, rails present at game end
 *   - power/water plants built per ladder rung
 *   - veterancy: peak vet level, live veterans
 *
 * From the aggregate, the report derives the dead roster (units/buildings/
 * upgrades never used in any game) and the dominant roster (used in every
 * game or far above the median).
 *
 * Known dynamics, documented here rather than worked around:
 *   1. AI-vs-AI at 220+ unit base separation is a cold war: each marshal
 *      builds to the 48-unit cap and holds. Scouts only ever see the enemy's
 *      recon drone (air — rifles cannot target it) and fishing boats (sea —
 *      land forces cannot target them), so land armies never make contact and
 *      no natural elimination is reachable. The headline config therefore
 *      places bases 200 units apart on open land so patrols can make contact.
 *   2. Two same-cadence AIs can both enqueue the world-global `advanceAge`
 *      command on the same tick. FIXED in the Phase 9 balance pass
 *      (pathology 1): the command carries the age the issuer saw
 *      (`fromAge`), so the second apply fizzles instead of going stale —
 *      no crash, no double charge. The old stagger workaround has been
 *      removed; the two AIs share think ticks freely now.
 *   3. The peaceful AI's economy death-spirals: it spends its starting funds
 *      on ~10 buildings, upkeep drains the treasury to zero, nothing is
 *      funded, every building goes non-operational, and with no operational
 *      buildings there is zero tax/production income — permanent stall.
 *
 * Console output: each game prints a metrics block, and an `afterAll` hook
 * prints the aggregate dead/dominant roster analysis. The durable write-up
 * lives in docs/research/phase9-soak-metrics.md.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import {
  createCommandQueue,
  registerCoreCommands,
  registerLogisticsCommands,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
} from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';
import {
  registerCityCommands,
  MAP_HALF_SIZE,
  getPlayer,
  BUILDING_DEFS,
} from '../src/sim/city';
import { createEconomySystem, registerEconomyCommands } from '../src/sim/economy';
import { registerUnitCommands, UNIT_DEFS } from '../src/sim/units';
import type { UnitKind } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { createIntelSystem, registerIntelCommands } from '../src/sim/intel';
import { registerUpgradeCommands } from '../src/sim/upgrades';
import { registerAgeCommands } from '../src/sim/ages';
import {
  createSuperweaponSystem,
  registerSuperweaponCommands,
} from '../src/sim/superweapons';
import { createMayorSystem, createGeneralSystem } from '../src/sim/delegation';
import {
  addAIPlayer,
  createAISystem,
} from '../src/sim/ai';
import type { AIDifficulty } from '../src/sim/ai';
import { grantAllTrainingResources } from './sim.roster-fixtures';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Terrain is expensive to generate; all configs share Meridian Plains. */
let cachedTerrain: TerrainData | null = null;
function terrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** Nearest land cell to (x, z) — the AI needs a dry base site. */
function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 120; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > MAP_HALF_SIZE - 1 || Math.abs(cz) > MAP_HALF_SIZE - 1) continue;
        if (!isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error('phase9-longsoak: no land near requested base');
}

/**
 * Conquest elimination predicate, inlined from the game session
 * (`checkSkirmishVictory`/`checkSkirmishDefeat` in ui/session.ts): no live
 * units AND no buildings. The session module is a UI module and is not
 * imported by sim tests.
 */
function isEliminated(world: World, owner: number): boolean {
  const hasUnits = world.units.some((u) => u.owner === owner);
  const hasBuildings = world.city.buildings.some((b) => b.owner === owner);
  return !hasUnits && !hasBuildings;
}

/** Power/water plant ladder rungs, for the per-rung usage metric. */
const PLANT_RUNGS: Array<{ rung: string; kinds: string[] }> = [
  { rung: 'coal', kinds: ['coalPlant'] },
  { rung: 'oil/gas', kinds: ['gasPlant'] },
  { rung: 'wind/solar', kinds: ['windFarm', 'solarFarm'] },
  { rung: 'hydro', kinds: ['hydroDam'] },
  { rung: 'nuclear', kinds: ['nuclearPlant'] },
  { rung: 'geothermal', kinds: ['geothermalPlant'] },
  { rung: 'fusion', kinds: ['fusionPlant'] },
  { rung: 'legacy power', kinds: ['powerPlant'] },
  { rung: 'well/pump', kinds: ['waterWell', 'waterPump'] },
  { rung: 'water advanced', kinds: ['waterTower', 'waterTreatment', 'reservoir', 'desalination'] },
];

// ---------------------------------------------------------------------------
// Metrics types
// ---------------------------------------------------------------------------

interface OwnerMetrics {
  /** Units trained per kind over the whole game (id Sets are cumulative). */
  trained: Record<string, number>;
  /** Total units ever trained. */
  trainedTotal: number;
  /** Enemy units killed (trained-by-us minus still-alive, per id Sets). */
  kills: number;
  /** Live units at game end. */
  liveUnits: number;
  /** Sum of trainFunds over live units at game end. */
  armyValue: number;
  /** AI virtual buildings completed (cumulative list at game end). */
  virtualBuildings: string[];
  /** Physical buildings placed per kind (id Sets are cumulative). */
  physicalBuildings: Record<string, number>;
  /** Upgrades researched at game end. */
  upgrades: string[];
  /** Intel ops run at game end. */
  intelOps: { infiltrate: number; sabotage: number; steal: number };
  /** Peak sampled aircraft embarked on carriers. */
  maxEmbarked: number;
  /** Peak sampled aircraft parked in hangars. */
  maxHangarParked: number;
  /** Virtual ammo stock: peak and final. */
  ammoStockPeak: number;
  ammoStockFinal: number;
  /** Virtual fuel stock: peak and final. */
  fuelStockPeak: number;
  fuelStockFinal: number;
  /** Peak vet level seen on any live unit; live veterans at game end. */
  vetMax: number;
  veterans: number;
  /** Funds at game end. */
  funds: number;
  /** Population at game end (peaceful games). */
  population: number;
}

interface LongGameResult {
  name: string;
  seed: number;
  difficulty: AIDifficulty;
  peaceful: boolean;
  ticks: number;
  wallMs: number;
  /** Human-readable conclusion, e.g. 'elimination: owner 0 at tick 18420'. */
  conclusion: string;
  winner: string | null;
  owners: [OwnerMetrics, OwnerMetrics];
  airlineRoutes: number;
  roadsBuilt: number;
  railsBuilt: number;
  plantsByRung: Record<string, number>;
  finalAge: string;
}

interface LongGameOptions {
  name: string;
  seed: number;
  difficulty: AIDifficulty;
  peaceful: boolean;
  tickCap: number;
  /** Base sites; verified to be on land before the AIs are added. */
  bases: Array<{ x: number; z: number }>;
  /** Whether to grant the standard training-resource stockpile (soak norm). */
  grant: boolean;
  sampleEvery: number;
}

/** Mutable per-owner sampling state (ids are never reused). */
interface OwnerSample {
  owner: number;
  seenUnits: Set<number>;
  trainedKind: Map<string, number>;
  seenBuildings: Set<number>;
  builtKind: Map<string, number>;
  maxEmbarked: number;
  maxHangar: number;
  ammoPeak: number;
  fuelPeak: number;
}

// ---------------------------------------------------------------------------
// Game runner
// ---------------------------------------------------------------------------

/**
 * All results, for the afterAll aggregate dead/dominant roster analysis.
 * (Populated by every test that runs a game; the aggregate is printed once.)
 */
const allResults: LongGameResult[] = [];

function runLongGame(opts: LongGameOptions): LongGameResult {
  const t = terrain();
  const world = createWorld(opts.seed);
  if (opts.peaceful) world.peaceful = true;

  for (let i = 0; i < 2; i++) {
    const base = opts.bases[i];
    if (!base) throw new Error('phase9-longsoak: expected two bases');
    const spot = findLandNear(t, base.x, base.z);
    addAIPlayer(world, i, opts.difficulty, spot.x, spot.z);
    const ai = world.ai.players.find((p) => p.owner === i);
    if (!ai) throw new Error(`phase9-longsoak: AI player ${i} missing`);
    // (Header note 2: the advanceAge same-tick race was fixed in the
    // Phase 9 balance pass — the duplicate fizzles via `fromAge`, so no
    // stagger is needed and the two AIs share think ticks freely.)
  }

  // Full production stack, mirroring ui/session.ts.
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, t);
  registerEconomyCommands(queue);
  registerUnitCommands(queue, t);
  registerMovementCommands(queue, t);
  registerCombatCommands(queue);
  registerIntelCommands(queue);
  registerLogisticsCommands(queue, t);
  registerAgeCommands(queue);
  registerSuperweaponCommands(queue);
  registerUpgradeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(t),
      createMovementSystem(t),
      createCombatSystem(),
      createSuperweaponSystem(),
      createEconomySystem(t),
      createIntelSystem(),
      createMayorSystem(queue, t),
      createGeneralSystem(queue),
      createAISystem(queue, t),
    ],
  });

  if (opts.grant) {
    grantAllTrainingResources(world);
  }

  // ---- Sampling state (ids are never reused, so id Sets count everything) --
  const perOwner: OwnerSample[] = [0, 1].map((owner) => ({
    owner,
    seenUnits: new Set<number>(),
    trainedKind: new Map<string, number>(),
    seenBuildings: new Set<number>(),
    builtKind: new Map<string, number>(),
    maxEmbarked: 0,
    maxHangar: 0,
    ammoPeak: 0,
    fuelPeak: 0,
  }));
  let vetMax = 0;

  const aiOf = (o: number) => {
    const ai = world.ai.players.find((p) => p.owner === o);
    if (!ai) throw new Error(`phase9-longsoak: AI player ${o} missing`);
    return ai;
  };

  let conclusion = '';
  let ticks = 0;
  const wallStart = Date.now();
  for (let tick = 1; tick <= opts.tickCap; tick++) {
    driver.step(world, TICK_MS); // must never throw
    ticks = tick;
    if (tick % opts.sampleEvery !== 0) continue;

    for (const s of perOwner) {
      const o = s.owner;
      for (const u of world.units) {
        if (u.owner !== o) continue;
        if (!s.seenUnits.has(u.id)) {
          s.seenUnits.add(u.id);
          s.trainedKind.set(u.kind, (s.trainedKind.get(u.kind) ?? 0) + 1);
        }
        if (u.vetLevel > vetMax) vetMax = u.vetLevel;
      }
      let embarked = 0;
      let hangared = 0;
      for (const u of world.units) {
        if (u.owner !== o) continue;
        if (u.embarkedOn !== 0) embarked++;
        if (u.hangarBuildingId !== 0) hangared++;
      }
      if (embarked > s.maxEmbarked) s.maxEmbarked = embarked;
      if (hangared > s.maxHangar) s.maxHangar = hangared;
      for (const b of world.city.buildings) {
        if (b.owner !== o) continue;
        if (!s.seenBuildings.has(b.id)) {
          s.seenBuildings.add(b.id);
          s.builtKind.set(b.kind, (s.builtKind.get(b.kind) ?? 0) + 1);
        }
      }
      const ai = aiOf(o);
      const ammo = ai.virtualAmmoStock ?? 0;
      const fuel = ai.virtualFuelStock ?? 0;
      if (ammo > s.ammoPeak) s.ammoPeak = ammo;
      if (fuel > s.fuelPeak) s.fuelPeak = fuel;
    }

    // Natural conclusion checks. Peaceful mode is endless
    // (2026-10-01): no victory condition, so a peaceful soak never
    // concludes — it just runs to the tick budget.
    if (!opts.peaceful && tick > 30) {
      for (const o of [0, 1] as const) {
        if (isEliminated(world, o)) {
          conclusion = `elimination: owner ${1 - o} wins at tick ${tick}`;
          break;
        }
      }
    }
    if (conclusion) break;
  }
  const wallMs = Date.now() - wallStart;

  // ---- Finalize metrics -----------------------------------------------------
  const owners = perOwner.map((s): OwnerMetrics => {
    const o = s.owner;
    const ai = aiOf(o);
    const live = world.units.filter((u) => u.owner === o);
    const trained: Record<string, number> = {};
    let trainedTotal = 0;
    for (const [k, n] of s.trainedKind) {
      trained[k] = n;
      trainedTotal += n;
    }
    const physicalBuildings: Record<string, number> = {};
    for (const [k, n] of s.builtKind) physicalBuildings[k] = n;
    let armyValue = 0;
    let veterans = 0;
    for (const u of live) {
      armyValue += UNIT_DEFS[u.kind as UnitKind].trainFunds ?? 0;
      if (u.vetLevel > 0) veterans++;
    }
    const player = getPlayer(world.city, o);
    const enemyLive = world.units.filter((u) => u.owner === 1 - o).length;
    const enemySample = perOwner.find((x) => x.owner === 1 - o);
    return {
      trained,
      trainedTotal,
      kills: (enemySample ? enemySample.seenUnits.size : 0) - enemyLive,
      liveUnits: live.length,
      armyValue: Math.round(armyValue),
      virtualBuildings: [...ai.virtualBuildings.completed],
      physicalBuildings,
      upgrades: [...(world.upgrades[o] ?? [])],
      intelOps: { ...ai.intel.ops },
      maxEmbarked: s.maxEmbarked,
      maxHangarParked: s.maxHangar,
      ammoStockPeak: Math.round(s.ammoPeak),
      ammoStockFinal: Math.round(ai.virtualAmmoStock ?? 0),
      fuelStockPeak: Math.round(s.fuelPeak),
      fuelStockFinal: Math.round(ai.virtualFuelStock ?? 0),
      vetMax,
      veterans,
      funds: player ? player.funds : NaN,
      population: player ? Math.round(player.population) : 0,
    };
  });
  if (owners.length !== 2 || owners[0] === undefined || owners[1] === undefined) {
    throw new Error('phase9-longsoak: expected two owners');
  }
  const ownerPair: [OwnerMetrics, OwnerMetrics] = [owners[0], owners[1]];

  // Scoreboard winner when nobody was eliminated.
  let winner: string | null = null;
  if (!conclusion) {
    conclusion = `tick cap (${ticks} ticks) — no natural conclusion`;
    if (ownerPair[0].kills !== ownerPair[1].kills) {
      const w = ownerPair[0].kills > ownerPair[1].kills ? 0 : 1;
      const l = w === 0 ? 1 : 0;
      winner = `owner ${w} on kills (${ownerPair[w].kills} vs ${ownerPair[l].kills})`;
    } else if (ownerPair[0].armyValue !== ownerPair[1].armyValue) {
      const w = ownerPair[0].armyValue > ownerPair[1].armyValue ? 0 : 1;
      const l = w === 0 ? 1 : 0;
      winner = `owner ${w} on army value (${ownerPair[w].armyValue} vs ${ownerPair[l].armyValue})`;
    } else {
      winner = 'draw';
    }
  } else {
    const m = /owner (\d) wins/.exec(conclusion);
    winner = m ? `owner ${m[1]} by elimination` : null;
  }

  const plantsByRung: Record<string, number> = {};
  for (const { rung, kinds } of PLANT_RUNGS) {
    let n = 0;
    for (const s of perOwner) {
      for (const kind of aiOf(s.owner).virtualBuildings.completed) {
        if (kinds.includes(kind)) n++;
      }
      for (const [k, c] of Object.entries(ownerPair[s.owner === 0 ? 0 : 1].physicalBuildings)) {
        if (kinds.includes(k)) n += c;
      }
    }
    plantsByRung[rung] = n;
  }

  const result: LongGameResult = {
    name: opts.name,
    seed: opts.seed,
    difficulty: opts.difficulty,
    peaceful: opts.peaceful,
    ticks,
    wallMs,
    conclusion,
    winner,
    owners: ownerPair,
    airlineRoutes: world.city.airlineRoutes.length,
    roadsBuilt: world.city.roads.length,
    railsBuilt: world.city.rails.length,
    plantsByRung,
    finalAge: world.ages.age,
  };
  allResults.push(result);
  printGameReport(result);
  return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function topEntries(rec: Record<string, number>, n: number): string {
  return Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}

function printGameReport(r: LongGameResult): void {
  // eslint-disable-next-line no-console
  console.log(`\n[phase9-longsoak] ${r.name} seed=${r.seed} difficulty=${r.difficulty} peaceful=${r.peaceful}`);
  // eslint-disable-next-line no-console
  console.log(`  ticks=${r.ticks} wall=${(r.wallMs / 1000).toFixed(1)}s conclusion=${r.conclusion} winner=${r.winner}`);
  // eslint-disable-next-line no-console
  console.log(`  finalAge=${r.finalAge} airlineRoutes=${r.airlineRoutes} roads=${r.roadsBuilt} rails=${r.railsBuilt}`);
  for (const o of [0, 1] as const) {
    const m = r.owners[o];
    // eslint-disable-next-line no-console
    console.log(
      `  owner ${o}: trained=${m.trainedTotal} [${topEntries(m.trained, 6)}] kills=${m.kills} live=${m.liveUnits} ` +
        `armyValue=${m.armyValue} virtBld=${m.virtualBuildings.length} physBld=${Object.values(m.physicalBuildings).reduce((a, b) => a + b, 0)} ` +
        `upgrades=${m.upgrades.length} intel=${m.intelOps.infiltrate}/${m.intelOps.sabotage}/${m.intelOps.steal} ` +
        `embarked≤${m.maxEmbarked} hangar≤${m.maxHangarParked} ammo=${m.ammoStockPeak}→${m.ammoStockFinal} ` +
        `fuel=${m.fuelStockPeak}→${m.fuelStockFinal} vetMax=${m.vetMax} vets=${m.veterans} ` +
        `funds=${m.funds.toFixed(0)} pop=${m.population}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`  plantsByRung: ${Object.entries(r.plantsByRung).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

/** Aggregate dead/dominant roster analysis across every game run so far. */
function printAggregateReport(): void {
  const standard = allResults.filter((r) => !r.peaceful);
  if (standard.length === 0) return;
  const trainedGames = new Map<string, number>();
  const trainedCounts: number[] = [];
  const virtGames = new Map<string, number>();
  const upgradeGames = new Map<string, number>();
  let totalKills = 0;
  let totalTrained = 0;
  for (const r of standard) {
    for (const o of [0, 1] as const) {
      const m = r.owners[o];
      totalKills += m.kills;
      totalTrained += m.trainedTotal;
      for (const k of Object.keys(m.trained)) {
        trainedGames.set(k, (trainedGames.get(k) ?? 0) + 1);
        trainedCounts.push(m.trained[k] ?? 0);
      }
      for (const k of m.virtualBuildings) virtGames.set(k, (virtGames.get(k) ?? 0) + 1);
      for (const k of m.upgrades) upgradeGames.set(k, (upgradeGames.get(k) ?? 0) + 1);
    }
  }
  const games = standard.length * 2; // owner-games
  const allUnitKinds = Object.keys(UNIT_DEFS);
  const dead = allUnitKinds.filter((k) => !trainedGames.has(k));
  const dominant = [...trainedGames.entries()]
    .filter(([, g]) => g === games)
    .map(([k]) => k)
    .sort();
  const sortedCounts = trainedCounts.sort((a, b) => a - b);
  const median = sortedCounts.length > 0 ? sortedCounts[Math.floor(sortedCounts.length / 2)] : 0;
  // eslint-disable-next-line no-console
  console.log(`\n[phase9-longsoak] AGGREGATE over ${standard.length} standard games (${games} owner-games)`);
  // eslint-disable-next-line no-console
  console.log(`  total units trained=${totalTrained} total kills=${totalKills} median per-kind count=${median}`);
  // eslint-disable-next-line no-console
  console.log(`  DEAD units (${dead.length}): ${dead.join(', ') || '—'}`);
  // eslint-disable-next-line no-console
  console.log(`  DOMINANT units (trained in every owner-game): ${dominant.join(', ') || '—'}`);
  const allVirt = new Set<string>();
  for (const [, v] of virtGames) void v;
  const deadVirt = [
    'barracks', 'warFactory', 'airfield', 'radarStation', 'shipyard', 'navalYard',
    'civilAirport', 'lab', 'listeningPost', 'intelHQ', 'fuelDepot', 'ordnanceDepot',
    'missileSilo', 'supplyDepot',
  ].filter((k) => !virtGames.has(k));
  // eslint-disable-next-line no-console
  console.log(`  virtual buildings used in ≥1 owner-game: ${[...virtGames.keys()].sort().join(', ') || '—'}`);
  // eslint-disable-next-line no-console
  console.log(`  DEAD virtual buildings: ${deadVirt.join(', ') || '—'}`);
  // eslint-disable-next-line no-console
  console.log(`  upgrades researched in ≥1 owner-game: ${[...upgradeGames.keys()].sort().join(', ') || '—'}`);
  void allVirt;
}

// ---------------------------------------------------------------------------
// Sanity assertions shared by every game
// ---------------------------------------------------------------------------

function assertSaneGame(r: LongGameResult): void {
  for (const o of [0, 1] as const) {
    const m = r.owners[o];
    // Funds must stay finite, non-negative, and bounded (existing soak norm).
    expect(Number.isFinite(m.funds)).toBe(true);
    expect(m.funds).toBeGreaterThanOrEqual(0);
    expect(m.funds).toBeLessThan(1e12);
    // Id sets are cumulative: trained total can never be below live units.
    expect(m.trainedTotal).toBeGreaterThanOrEqual(m.liveUnits);
    // Kills cannot exceed what the enemy ever trained.
    expect(m.kills).toBeLessThanOrEqual(r.owners[o === 0 ? 1 : 0].trainedTotal);
    expect(m.kills).toBeGreaterThanOrEqual(0);
  }
  expect(r.ticks).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Headline bases: 100 units apart on verified open land (both sites probed
 * at 100% land over an 80×80-unit box on the Meridian Plains seed), west of
 * the river so the AI's forward-base expansion (halfway toward the enemy)
 * stays on dry land. Close enough that scout patrols make contact.
 */
const CLOSE_BASES = [
  { x: -180, z: 80 },
  { x: -80, z: 80 },
];
/** Peaceful-mode bases: the repo's peaceful-soak convention. */
const PEACEFUL_BASES = [
  { x: -110, z: 0 },
  { x: 110, z: 0 },
];

/**
 * Add a marshal pair on the close bases. Shared by the two determinism
 * tests so both exercise the identical fixture. (The old think-stagger
 * was removed with the advanceAge race fix — header note 2.)
 */
function addMarshalPair(world: World, t: TerrainData): void {
  const spots = CLOSE_BASES.map((b) => findLandNear(t, b.x, b.z));
  const west = spots[0];
  const east = spots[1];
  if (west === undefined || east === undefined) {
    throw new Error('phase9-longsoak: base spots missing');
  }
  addAIPlayer(world, 0, 'marshal', west.x, west.z);
  addAIPlayer(world, 1, 'marshal', east.x, east.z);
}

describe('phase 9 long AI-vs-AI soaks', () => {
  it(
    'headline: marshal-vs-marshal full-length standard games (3 seeds)',
    () => {
      for (const seed of [20260930, 424242, 777001]) {
        const r = runLongGame({
          name: 'marshal-vs-marshal',
          seed,
          difficulty: 'marshal',
          peaceful: false,
          tickCap: 30000,
          bases: CLOSE_BASES,
          grant: true,
          sampleEvery: 300,
        });
        // Both marshals must field real armies — catches bad spawn placement.
        expect(r.owners[0].trainedTotal).toBeGreaterThan(20);
        expect(r.owners[1].trainedTotal).toBeGreaterThan(20);
        assertSaneGame(r);
      }
    },
    600000,
  );

  it(
    'peaceful: marshal-vs-marshal full-length peaceful games (3 seeds)',
    () => {
      for (const seed of [7, 42, 99]) {
        const r = runLongGame({
          name: 'peaceful marshal-vs-marshal',
          seed,
          difficulty: 'marshal',
          peaceful: true,
          tickCap: 30000,
          bases: PEACEFUL_BASES,
          grant: false,
          sampleEvery: 300,
        });
        // Peaceful AI must found a real city — catches placement stalls.
        expect(r.owners[0].population).toBeGreaterThan(5);
        expect(r.owners[1].population).toBeGreaterThan(5);
        assertSaneGame(r);
      }
    },
    600000,
  );

  it(
    'spot-check: commander-vs-commander full-length standard games (2 seeds)',
    () => {
      for (const seed of [31337, 271828]) {
        const r = runLongGame({
          name: 'commander-vs-commander',
          seed,
          difficulty: 'commander',
          peaceful: false,
          tickCap: 20000,
          bases: CLOSE_BASES,
          grant: true,
          sampleEvery: 300,
        });
        expect(r.owners[0].trainedTotal).toBeGreaterThan(10);
        expect(r.owners[1].trainedTotal).toBeGreaterThan(10);
        assertSaneGame(r);
      }
    },
    600000,
  );

  it(
    'spot-check: general-vs-general full-length standard games (2 seeds)',
    () => {
      for (const seed of [161803, 141421]) {
        const r = runLongGame({
          name: 'general-vs-general',
          seed,
          difficulty: 'general',
          peaceful: false,
          tickCap: 20000,
          bases: CLOSE_BASES,
          grant: true,
          sampleEvery: 300,
        });
        expect(r.owners[0].trainedTotal).toBeGreaterThan(10);
        expect(r.owners[1].trainedTotal).toBeGreaterThan(10);
        assertSaneGame(r);
      }
    },
    600000,
  );

  it(
    'determinism: mid-game save/load preserves the world digest',
    () => {
      const t = terrain();
      const world = createWorld(90210);
      addMarshalPair(world, t);
      const queue = createCommandQueue();
      registerCoreCommands(queue);
      registerCityCommands(queue, t);
      registerUnitCommands(queue, t);
      registerMovementCommands(queue, t);
      registerCombatCommands(queue);
      registerAgeCommands(queue);
      const driver = createTickDriver({
        queue,
        systems: [
          createPathfindingSystem(t),
          createMovementSystem(t),
          createCombatSystem(),
          createEconomySystem(t),
          createAISystem(queue, t),
        ],
      });
      grantAllTrainingResources(world);
      for (let i = 0; i < 15000; i++) driver.step(world, TICK_MS);
      const midDigest = digestWorld(world);
      const mid = takeSnapshot(world);
      for (let i = 0; i < 15000; i++) driver.step(world, TICK_MS);
      const afterDigest = digestWorld(world);
      const restored = restoreSnapshot(mid);
      const restoredDigest = digestWorld(restored);
      expect(restoredDigest).toBe(midDigest);
      expect(afterDigest).not.toBe(midDigest);
    },
    600000,
  );

  it(
    'determinism: the same seed produces an identical digest',
    () => {
      const digests: number[] = [];
      for (let run = 0; run < 2; run++) {
        const t = terrain();
        const world = createWorld(90210);
        addMarshalPair(world, t);
        const queue = createCommandQueue();
        registerCoreCommands(queue);
        registerCityCommands(queue, t);
        registerUnitCommands(queue, t);
        registerMovementCommands(queue, t);
        registerCombatCommands(queue);
        registerAgeCommands(queue);
        const driver = createTickDriver({
          queue,
          systems: [
            createPathfindingSystem(t),
            createMovementSystem(t),
            createCombatSystem(),
            createEconomySystem(t),
            createAISystem(queue, t),
          ],
        });
        grantAllTrainingResources(world);
        for (let i = 0; i < 8000; i++) driver.step(world, TICK_MS);
        digests.push(digestWorld(world));
      }
      expect(digests[0]).toBe(digests[1]);
    },
    600000,
  );

  afterAll(() => {
    printAggregateReport();
  });
});
