import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import {
  registerDelegationCommands,
  createGeneralSystem,
  getGeneral,
  encodeDelegationState,
  decodeDelegationState,
} from '../src/sim/delegation';
import { registerUnitCommands, spawnUnit } from '../src/sim/units';
import { registerCombatCommands } from '../src/sim/combat';
import { generateTerrain } from '../src/sim/terrain';

describe('delegation — Theatres of Command', () => {
  it('assigns general to specific theatre (Northern Command)', () => {
    const world = createWorld(789);
    const terrain = generateTerrain(789);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerCombatCommands(queue, terrain);
    registerDelegationCommands(queue);

    const friendly = spawnUnit(world, 'tank', 0, 0, 0);

    queue.enqueue(world, {
      kind: 'assignGeneral',
      issuer: 'player',
      payload: { owner: 0, unitIds: [friendly.id], stance: 'aggressive', theatre: 'northern' },
    });
    queue.applyDue(world, world.tick);

    const general = getGeneral(world, 0);
    expect(general).toBeDefined();
    expect(general?.theatre).toBe('northern');
    expect(general?.stance).toBe('aggressive');
  });

  it('encodes and decodes theatre assignments properly across saves', () => {
    const world = createWorld(101);
    world.delegation.generals.push({
      owner: 0,
      unitIds: [1, 2],
      stance: 'defensive',
      theatre: 'naval',
    });

    const encoded = encodeDelegationState(world.delegation);
    const decoded = decodeDelegationState(encoded);

    expect(decoded.generals.length).toBe(1);
    expect(decoded.generals[0]?.theatre).toBe('naval');
    expect(decoded.generals[0]?.stance).toBe('defensive');
  });

  it('prioritizes northern threats when assigned to Northern Command', () => {
    const world = createWorld(202);
    const terrain = generateTerrain(202);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerCombatCommands(queue, terrain);
    registerDelegationCommands(queue);

    const generalUnit = spawnUnit(world, 'tank', 0, 0, 0);
    const northEnemy = spawnUnit(world, 'tank', 1, 0, -25); // northern threat (z < 0)
    const southEnemy = spawnUnit(world, 'tank', 1, 0, 20);  // southern threat (z > 0), slightly closer

    queue.enqueue(world, {
      kind: 'assignGeneral',
      issuer: 'player',
      payload: { owner: 0, unitIds: [generalUnit.id], stance: 'aggressive', theatre: 'northern' },
    });
    queue.applyDue(world, world.tick);

    const generalSystem = createGeneralSystem(queue);
    world.tick = 60; // trigger GENERAL_THINK_TICKS
    generalSystem(world, 33.3);

    // Should enqueue attack order against northEnemy
    const applied = queue.applyDue(world, 60);
    expect(
      applied.some(
        (cmd) => cmd.command.kind === 'attackUnit' && cmd.command.payload?.['targetId'] === northEnemy.id,
      ),
    ).toBe(true);
  });
});
