import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import {
  analyzePlayerForces,
  determineMuseDoctrine,
  thinkMuse,
  getMuseOpponentDialogue,
  findSpawnSpot,
} from '../src/sim/aiMuse';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerUnitCommands } from '../src/sim/units';
import { getPlayer, BUILDING_DEFS, footprintCells, cellIndex, cellIsWater } from '../src/sim/city';
import { generateTerrain } from '../src/sim/terrain';
import { registerAgeCommands } from '../src/sim/ages';

function makeUnit(id: number, kind: string, owner: number) {
  return {
    id,
    kind,
    owner,
    x: 10,
    z: 10,
    domain: kind === 'fighter' || kind === 'bomber' ? 'air' : kind === 'destroyer' || kind === 'submarine' ? 'sea' : 'land',
    speed: 10,
    hp: 100,
    cooldownLeft: 0,
    targetId: 0,
    chasing: false,
    state: 'idle',
    failReason: null,
    destX: 0,
    destZ: 0,
    arriveX: 0,
    arriveZ: 0,
    path: [],
    pathAt: 0,
    fieldId: 0,
  } as never;
}

describe('aiMuse — Mode 2: Playing Against Muse', () => {
  it('analyzes player force compositions accurately', () => {
    const world = createWorld(42);
    // Player 0 (human) forces
    world.units.push(
      makeUnit(1, 'tank', 0),
      makeUnit(2, 'tank', 0),
      makeUnit(3, 'fighter', 0),
      makeUnit(4, 'rifles', 0),
    );
    // AI (owner 1) scout co-located so the human forces are visible —
    // analyzePlayerForces only counts what the AI owner can see.
    world.units.push(makeUnit(5, 'reconTeam', 1));

    const analysis = analyzePlayerForces(world, 1, 0);
    expect(analysis.totalUnits).toBe(4);
    expect(analysis.armorCount).toBe(2);
    expect(analysis.airCount).toBe(1);
    expect(analysis.infantryCount).toBe(1);
    expect(analysis.navalCount).toBe(0);
    expect(analysis.primaryThreat).toBe('armor');
  });

  it('determines adaptive counter-doctrines based on threat analysis', () => {
    const world = createWorld(42);

    // Heavy armor threat -> anti-armor doctrine
    world.units.push(
      makeUnit(1, 'tank', 0),
      makeUnit(2, 'tank', 0),
      makeUnit(3, 'tank', 0),
      makeUnit(9, 'reconTeam', 1),
    );
    let analysis = analyzePlayerForces(world, 1, 0);
    expect(determineMuseDoctrine(analysis)).toBe('anti-armor');

    // Heavy air threat -> air-superiority doctrine
    world.units = [
      makeUnit(1, 'fighter', 0),
      makeUnit(2, 'bomber', 0),
      makeUnit(3, 'fighter', 0),
      makeUnit(9, 'reconTeam', 1),
    ];
    analysis = analyzePlayerForces(world, 1, 0);
    expect(determineMuseDoctrine(analysis)).toBe('air-superiority');

    // Heavy naval threat -> naval-strike doctrine
    world.units = [
      makeUnit(1, 'destroyer', 0),
      makeUnit(2, 'submarine', 0),
      makeUnit(9, 'reconTeam', 1),
    ];
    analysis = analyzePlayerForces(world, 1, 0);
    expect(determineMuseDoctrine(analysis)).toBe('naval-strike');
  });

  it('provides flavorful Muse opponent dialogue for all combat states', () => {
    const world = createWorld(42);
    expect(getMuseOpponentDialogue(world, 'start')).toContain('Commander');
    expect(getMuseOpponentDialogue(world, 'doctrineShift', 'anti-armor')).toContain('anti-armor');
    expect(getMuseOpponentDialogue(world, 'offensive')).toBeTruthy();
    expect(getMuseOpponentDialogue(world, 'counterAttack')).toBeTruthy();
    expect(getMuseOpponentDialogue(world, 'taunt')).toBeTruthy();
    expect(getMuseOpponentDialogue(world, 'defeat')).toContain('Fascinating');
    expect(getMuseOpponentDialogue(world, 'victory')).toContain('Checkmate');
  });

  it('runs thinkMuse and generates orders under AISystem with opponentMode muse', () => {
    const world = createWorld(999);
    addAIPlayer(world, 1, 'commander', 80, 80);

    const terrain = generateTerrain(999);
    const player1 = getPlayer(world.city, 1);
    if (player1) {
      player1.funds = 10000;
      player1.materials = 5000;
      player1.fuel = 500;
    }

    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerAgeCommands(queue);

    const aiSystem = createAISystem(queue, terrain, 'muse', thinkMuse);

    // Run simulation ticks through aiSystem
    for (let t = 0; t < 100; t++) {
      world.tick++;
      aiSystem(world, 33.3);
    }

    // AI state should exist and have executed
    expect(world.ai.players.length).toBeGreaterThan(0);
    const museAi = world.ai.players[0];
    expect(museAi?.owner).toBe(1);
  });

  it('findSpawnSpot nudges the anchor-building spot out of ≥2×2 footprints (Fix 5)', () => {
    const world = createWorld(78);
    const terrain = generateTerrain(78);
    // Dry land for the anchor (the nudge needs dry cells nearby).
    let ax = 128;
    let az = 128;
    let found = false;
    for (let r = 0; r < 40 && !found; r++) {
      for (let dz = -r; dz <= r && !found; dz++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (!cellIsWater(terrain, 128 + dx, 128 + dz)) {
            ax = 128 + dx;
            az = 128 + dz;
            found = true;
          }
        }
      }
    }
    expect(found).toBe(true);
    // AI-owned 3×3 barracks as the spawn anchor.
    const def = BUILDING_DEFS['barracks'];
    world.city.buildings.push({
      id: 1,
      kind: 'barracks',
      owner: 1,
      cx: ax,
      cz: az,
      facing: 0,
      progress: 1,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
      hp: def.hp,
    } as never);
    const cells = new Set(footprintCells(ax, az, def.footprintW, def.footprintH));
    const cellOf = (p: { x: number; z: number }): number =>
      cellIndex(Math.floor((p.x + 256) / 2), Math.floor((p.z + 256) / 2));
    // Without terrain the legacy spot stands (inside the 3×3 footprint)
    // — the spawnUnit command is the backstop there.
    const legacy = findSpawnSpot(world, 1, 'rifles');
    expect(legacy).not.toBeNull();
    expect(cells.has(cellOf(legacy!))).toBe(true);
    // With terrain the spot is nudged outside the footprint.
    const spot = findSpawnSpot(world, 1, 'rifles', terrain);
    expect(spot).not.toBeNull();
    expect(cells.has(cellOf(spot!))).toBe(false);
  });
});
