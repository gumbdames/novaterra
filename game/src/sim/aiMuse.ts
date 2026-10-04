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
 * NOVATERRA — sim/aiMuse.ts — Mode 2: Muse Persona opponent.
 *
 * A LOCAL, deterministic, rules-based commander with a Muse persona —
 * no networking, no neural network, no external AI service. It profiles
 * the forces it can see and picks counter-doctrines; the persona lines
 * are canned dialogue, not a language model.
 *
 * Prompt 1 Requirement (original wording, kept for provenance):
 * "The game should be playable in 5 different difficulty levels. Each difficulty
 * level should have 2 modes where mode 1 is a regular game engine/AI and mode 2
 * is playing against you (Muse) - ie you control the game engine."
 *
 * Distinct Architecture of the Muse Persona (Mode 2):
 *  1. Dynamic Opponent Profiling: Continuously profiles the player unit
 *     compositions it can see (sight-gated, like every other AI — no
 *     maphack), plus visible forward utility infrastructure.
 *  2. Adaptive Counter-Composition: Adjusts production weights on the fly:
 *     - Anti-Armor focus if player relies heavily on tanks / APCs.
 *     - Air-Superiority & SAM focus if player relies on aircraft.
 *     - Naval-Dominance if player builds naval vessels.
 *     - Infrastructure-Raid if player expands utilities aggressively.
 *  3. Asymmetric Flanking: Identifies exposed player energy/water infrastructure
 *     and dispatches agile raiding squads to starve the player's economy.
 *  4. Reactive Tactical Commentary: Broadcasts in-game tactical dialogue directly
 *     through the HUD advisor channel.
 *
 * Pure simulation module: deterministic, no Math.random, safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue } from './commands';
import type { TerrainData } from './terrain';
import type { AIPlayerState } from './ai';
import { canTrain, getVisibleEnemies, getVisibleEnemyBuildings } from './ai';
import { UNIT_DEFS, type UnitKind } from './units';
import { getPlayer, cellCenterWorld } from './city';
import { getAgeState, AGE_PROGRESSION } from './ages';

export interface PlayerForceProfile {
  totalUnits: number;
  armorCount: number;
  airCount: number;
  infantryCount: number;
  navalCount: number;
  antiAirCount: number;
  powerPlants: number;
  waterPlants: number;
  primaryThreat: 'armor' | 'air' | 'infantry' | 'navy' | 'none';
}

/** Analyze known enemy forces (human player). Fair-AI contract: only
 *  counts what the AI owner can actually see — visible enemies via
 *  getVisibleEnemies() and visible enemy buildings via
 *  getVisibleEnemyBuildings(), never a raw whole-map scan. */
export function analyzePlayerForces(world: World, aiOwner: number, humanOwner: number): PlayerForceProfile {
  const profile: PlayerForceProfile = {
    totalUnits: 0,
    armorCount: 0,
    airCount: 0,
    infantryCount: 0,
    navalCount: 0,
    antiAirCount: 0,
    powerPlants: 0,
    waterPlants: 0,
    primaryThreat: 'none',
  };

  for (const u of getVisibleEnemies(world, aiOwner)) {
    if (u.owner !== humanOwner || u.hp <= 0) continue;
    profile.totalUnits++;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def) continue;

    if (u.kind === 'aa' || u.kind === 'aegisBattery' || u.kind === 'interceptor') {
      profile.antiAirCount++;
    }

    if (def.domain === 'air') {
      profile.airCount++;
    } else if (def.domain === 'sea') {
      profile.navalCount++;
    } else if (u.kind.includes('tank') || u.kind.includes('apc') || u.kind.includes('artillery')) {
      profile.armorCount++;
    } else {
      profile.infantryCount++;
    }
  }

  for (const b of getVisibleEnemyBuildings(world, aiOwner)) {
    if (b.owner !== humanOwner || (b.hp ?? 0) <= 0) continue;
    if (b.kind.includes('power') || b.kind.includes('solar') || b.kind.includes('wind') || b.kind.includes('reactor')) {
      profile.powerPlants++;
    }
    if (b.kind.includes('water') || b.kind.includes('pump') || b.kind.includes('desalination')) {
      profile.waterPlants++;
    }
  }

  if (profile.totalUnits > 0) {
    if (profile.armorCount >= profile.airCount && profile.armorCount >= profile.navalCount && profile.armorCount >= profile.infantryCount) {
      profile.primaryThreat = 'armor';
    } else if (profile.airCount >= profile.navalCount && profile.airCount >= profile.infantryCount) {
      profile.primaryThreat = 'air';
    } else if (profile.navalCount >= profile.infantryCount && profile.navalCount > 0) {
      profile.primaryThreat = 'navy';
    } else {
      profile.primaryThreat = 'infantry';
    }
  }

  return profile;
}

export type MuseDoctrine = 'adaptive-balanced' | 'anti-armor' | 'air-superiority' | 'naval-strike' | 'infrastructure-raid';

/** Determine Muse's active counter-doctrine based on observed player strengths. */
export function determineMuseDoctrine(profile: PlayerForceProfile): MuseDoctrine {
  if (profile.totalUnits === 0) return 'adaptive-balanced';

  if (profile.armorCount / profile.totalUnits >= 0.35) {
    return 'anti-armor';
  }
  if (profile.airCount / profile.totalUnits >= 0.25) {
    return 'air-superiority';
  }
  if (profile.navalCount >= 2) {
    return 'naval-strike';
  }
  if (profile.powerPlants > 0 || profile.waterPlants > 0) {
    return 'infrastructure-raid';
  }
  return 'adaptive-balanced';
}

/** Unit priority roster mapped to counter-doctrines. */
const DOCTRINE_ROSTERS: Record<MuseDoctrine, UnitKind[]> = {
  'anti-armor': ['tankDestroyer', 'gunship', 'spectre', 'aa', 'rifles', 'tank'],
  'air-superiority': ['aa', 'fighter', 'fighterMk2', 'rifles'],
  'naval-strike': ['submarine', 'destroyer', 'patrolBoat'],
  'infrastructure-raid': ['drone', 'spectre', 'sniperTeam', 'rifles'],
  'adaptive-balanced': ['rifles', 'tank', 'aa', 'apc', 'drone', 'artillery'],
};

/**
 * Execute Muse's core tactical evaluation pass.
 * Coordinates production counter-squads, target acquisition, and flank attacks.
 */
export function thinkMuse(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  _terrain?: TerrainData,
): void {
  const humanOwner = 0;
  const profile = analyzePlayerForces(world, ai.owner, humanOwner);
  const doctrine = determineMuseDoctrine(profile);
  const roster = DOCTRINE_ROSTERS[doctrine] ?? DOCTRINE_ROSTERS['adaptive-balanced'];

  // 1. Train counter-units based on selected doctrine
  const myLivingUnits = world.units.filter((u) => u.owner === ai.owner && u.hp > 0);
  const maxUnits = 40;

  if (myLivingUnits.length < maxUnits) {
    for (const kind of roster) {
      if (canTrain(world, ai.owner, kind)) {
        // Find suitable spawn position near base
        const spawnPos = findSpawnSpot(world, ai.owner);
        if (spawnPos) {
          try {
            queue.enqueue(world, {
              kind: 'spawnUnit',
              issuer: `ai:${ai.owner}`,
              payload: { kind, owner: ai.owner, x: spawnPos.x, z: spawnPos.z },
            });
            break; // Train 1 per think pass
          } catch {
            // AI enqueue rejection handled gracefully
          }
        }
      }
    }
  }

  // 2. Tactical maneuvering & target assignments
  const visibleEnemies = getVisibleEnemies(world, ai.owner);
  const freeUnits = myLivingUnits.filter((u) => !u.targetId && !u.buildingTargetId);

  if (visibleEnemies.length > 0 && freeUnits.length > 0) {
    // Attack closest or highest-value enemy
    const target = visibleEnemies[0];
    if (target) {
      for (const u of freeUnits) {
        try {
          queue.enqueue(world, {
            kind: 'attackUnit',
            issuer: `ai:${ai.owner}`,
            payload: { unitId: u.id, targetId: target.id },
          });
        } catch {
          // Graceful reject handling
        }
      }
    }
  } else if (doctrine === 'infrastructure-raid' && freeUnits.length >= 3) {
    // Raid player's power/water facilities — fair-AI contract: only
    // targets the AI can actually see (no whole-map scan).
    const targetBuilding = getVisibleEnemyBuildings(world, ai.owner).find(
      (b) => b.owner === humanOwner && (b.hp ?? 0) > 0 && (b.kind.includes('power') || b.kind.includes('water')),
    );
    if (targetBuilding) {
      for (const u of freeUnits) {
        try {
          queue.enqueue(world, {
            kind: 'attackBuilding',
            issuer: `ai:${ai.owner}`,
            payload: { unitId: u.id, targetId: targetBuilding.id },
          });
        } catch {
          // Graceful reject handling
        }
      }
    }
  }

  // 3. Dynamic age progression
  const ageState = getAgeState(world, ai.owner);
  const prog = AGE_PROGRESSION[ageState.age];
  const player = getPlayer(world.city, ai.owner);
  if (prog && prog.next && prog.programs.length > 0 && player) {
    let canAfford = true;
    for (const [res, amount] of Object.entries(prog.cost)) {
      const have = (player as unknown as Record<string, number>)[res] ?? 0;
      if (have < amount) {
        canAfford = false;
        break;
      }
    }
    if (canAfford) {
      try {
        queue.enqueue(world, {
          kind: 'advanceAge',
          issuer: `ai:${ai.owner}`,
          payload: { owner: ai.owner, program: prog.programs[0] },
        });
      } catch {
        // Graceful reject handling
      }
    }
  }
}

/** Helper to find a spawn position near base. */
function findSpawnSpot(world: World, owner: number): { x: number; z: number } | null {
  const anchorBuilding = world.city.buildings.find((b) => b.owner === owner && (b.hp ?? 0) > 0);
  if (anchorBuilding) {
    // Canonical cell→world mapping (city.ts): cellCenterWorld, not a
    // hand-rolled scale (CELL_WORLD_SIZE = 2, map is 512 units wide).
    return { x: cellCenterWorld(anchorBuilding.cx) + 2, z: cellCenterWorld(anchorBuilding.cz) + 2 };
  }
  const anchorUnit = world.units.find((u) => u.owner === owner && u.hp > 0);
  if (anchorUnit) {
    return { x: anchorUnit.x + 4, z: anchorUnit.z + 4 };
  }
  return { x: 80, z: 80 };
}

export type MuseDialogueEvent =
  | 'start'
  | 'doctrineShift'
  | 'offensive'
  | 'counterAttack'
  | 'taunt'
  | 'defeat'
  | 'victory';

/**
 * Returns dynamic live dialogue from Muse as your opponent in Mode 2.
 */
export function getMuseOpponentDialogue(
  _world: World,
  event: MuseDialogueEvent,
  detail?: string,
): string {
  switch (event) {
    case 'start':
      return 'Simulation initialized. Commander, let us test your operational readiness.';
    case 'doctrineShift':
      return detail
        ? `Recalibrating battle doctrine: shifting priority to ${detail}.`
        : 'Recalibrating battle doctrine to counter your current force posture.';
    case 'offensive':
      return 'Commencing coordinated theater offensive. Let us see how your perimeter holds.';
    case 'counterAttack':
      return 'Intercept vector confirmed. Engaging flanking spearhead.';
    case 'taunt':
      return 'Your tactical formations have been modeled, Commander. I am anticipating your next advance.';
    case 'defeat':
      return 'Fascinating strategy, Commander. My tactical models will adapt to this outcome.';
    case 'victory':
      return 'Checkmate, Commander. Strategic objectives achieved across all combat sectors.';
    default:
      return 'Operational metrics updated.';
  }
}
