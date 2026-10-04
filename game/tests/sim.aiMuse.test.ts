import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import {
  analyzePlayerForces,
  determineMuseDoctrine,
  thinkMuse,
  getMuseOpponentDialogue,
} from '../src/sim/aiMuse';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerUnitCommands } from '../src/sim/units';
import { getPlayer } from '../src/sim/city';
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
});
