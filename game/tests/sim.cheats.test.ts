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
 * NOVATERRA — cheat tests (Phase 1, step 11).
 *
 * Covers the sim-affecting cheats and the console parser:
 *  - `prosperity now` grants the fixed CHEAT_GRANT_AMOUNTS package to the
 *    player through the ordinary tick-aligned command queue.
 *  - `fast build` finishes every unfinished building of the player.
 *  - Cheat commands only accept `issuer: 'cheat'`; anything else is
 *    rejected loudly. Unknown owners are rejected too.
 *  - `parseCheatCommand` maps every documented command (case- and
 *    whitespace-tolerant) and flags unknown input.
 *  - Sessions start un-cheated (`cheated === false`).
 */
import { describe, expect, it } from 'vitest';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import {
  CHEAT_GRANT_AMOUNTS,
  cheatGrantResources,
  cheatInstantBuild,
} from '../src/sim/cheats';
import { parseCheatCommand } from '../src/ui/cheatConsole';
import { CommandRejectedError } from '../src/sim/commands';
import {
  getPlayer,
  placeBuilding,
  BUILDING_DEFS,
  cellCenterWorld,
  footprintCells,
  cellIndex,
  cellIsWater,
  CELL_WORLD_SIZE,
  MAP_HALF_SIZE,
  type BuildingRecord,
} from '../src/sim/city';
import { spawnUnit } from '../src/sim/units';
import type { TerrainData } from '../src/sim/terrain';

function enqueueCheat(session: ReturnType<typeof createSession>, kind: string): void {
  session.queue.enqueue(session.world, {
    kind,
    issuer: 'cheat',
    payload: { owner: HUMAN_PLAYER_ID },
  });
}

/** Nearest dry cell to a starting cell (the sim.construction-eject idiom). */
function findLandCell(terrain: TerrainData, fromCx: number, fromCz: number): { cx: number; cz: number } {
  for (let r = 0; r < 40; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = fromCx + dx;
        const cz = fromCz + dz;
        if (!cellIsWater(terrain, cx, cz)) return { cx, cz };
      }
    }
  }
  throw new Error('no land');
}

describe('cheat commands', () => {
  it('prosperity now grants the fixed resource package via the queue', () => {
    const session = createSession({ seed: 11 });
    const before = { ...getPlayer(session.world.city, HUMAN_PLAYER_ID)! };
    enqueueCheat(session, 'cheatGrantResources');
    session.tick(); // commands apply at tick starts
    const after = getPlayer(session.world.city, HUMAN_PLAYER_ID)!;
    expect(after.funds).toBe(before.funds + CHEAT_GRANT_AMOUNTS.funds);
    expect(after.materials).toBe(before.materials + CHEAT_GRANT_AMOUNTS.materials);
    expect(after.food).toBe(before.food + CHEAT_GRANT_AMOUNTS.food);
    expect(after.fuel).toBe(before.fuel + CHEAT_GRANT_AMOUNTS.fuel);
    expect(after.research).toBe(before.research); // grant is 0
  });

  it('fast build finishes every unfinished building of the player', () => {
    const session = createSession({ seed: 12 });
    const unfinished: BuildingRecord = {
      id: 9001,
      kind: 'house',
      owner: HUMAN_PLAYER_ID,
      cx: 10,
      cz: 10,
      facing: 0,
      progress: 0.4,
      level: 1,
      operational: false,
      powered: false,
      watered: false,
    };
    session.world.city.buildings.push(unfinished);
    enqueueCheat(session, 'cheatInstantBuild');
    session.tick();
    expect(unfinished.progress).toBe(1);
  });

  it('fast build ejects a unit standing on the finished site (Fix 4)', () => {
    const session = createSession({ seed: 21 });
    const { world, terrain } = session;
    const site = findLandCell(terrain, 120, 120);
    const def = BUILDING_DEFS['house'];
    const b = placeBuilding(
      world.city,
      { kind: 'house', owner: HUMAN_PLAYER_ID, cx: site.cx, cz: site.cz, facing: 0 },
      21,
    );
    expect(b.progress).toBeLessThan(1);
    // An engineer standing in the middle of the construction site.
    const fx = cellCenterWorld(site.cx + Math.floor(def.footprintW / 2));
    const fz = cellCenterWorld(site.cz + Math.floor(def.footprintH / 2));
    const eng = spawnUnit(world, 'engineer', HUMAN_PLAYER_ID, fx, fz);
    enqueueCheat(session, 'cheatInstantBuild');
    session.tick();
    // The building completed AND the engineer is outside the footprint.
    expect(b.progress).toBe(1);
    const cells = new Set(footprintCells(b.cx, b.cz, def.footprintW, def.footprintH));
    const ecx = Math.floor((eng.x + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
    const ecz = Math.floor((eng.z + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
    expect(cells.has(cellIndex(ecx, ecz))).toBe(false);
    expect(eng.state).toBe('idle');
    expect(eng.hp).toBeGreaterThan(0);
  });

  it('rejects cheat commands not issued by the cheat console', () => {
    const session = createSession({ seed: 13 });
    expect(() =>
      session.queue.enqueue(session.world, {
        kind: 'cheatGrantResources',
        issuer: 'player',
        payload: { owner: HUMAN_PLAYER_ID },
      }),
    ).toThrow(CommandRejectedError);
  });

  it('rejects cheat commands for unknown owners', () => {
    const session = createSession({ seed: 14 });
    expect(() =>
      session.queue.enqueue(session.world, {
        kind: 'cheatGrantResources',
        issuer: 'cheat',
        payload: { owner: 999 },
      }),
    ).toThrow(CommandRejectedError);
  });

  it('cheat helpers throw on unknown owners (direct use)', () => {
    const session = createSession({ seed: 15 });
    expect(() => cheatGrantResources(session.world, 999)).toThrow();
    // instant build on an unknown owner is a silent no-op over buildings.
    expect(() => cheatInstantBuild(session.world, 999)).not.toThrow();
  });

  it('sessions start un-cheated', () => {
    expect(createSession({ seed: 16 }).cheated).toBe(false);
  });
});

describe('parseCheatCommand', () => {
  it('parses every documented command', () => {
    expect(parseCheatCommand('prosperity now')).toEqual({ kind: 'grant' });
    expect(parseCheatCommand('fast build')).toEqual({ kind: 'instantBuild' });
    expect(parseCheatCommand('reveal')).toEqual({ kind: 'reveal' });
    expect(parseCheatCommand('fow off')).toEqual({ kind: 'reveal' });
    expect(parseCheatCommand('win')).toEqual({ kind: 'win' });
    expect(parseCheatCommand('lose')).toEqual({ kind: 'lose' });
    expect(parseCheatCommand('help')).toEqual({ kind: 'help' });
  });

  it('is case- and whitespace-tolerant', () => {
    expect(parseCheatCommand('  Prosperity   NOW ')).toEqual({ kind: 'grant' });
    expect(parseCheatCommand('FAST BUILD')).toEqual({ kind: 'instantBuild' });
    expect(parseCheatCommand('Reveal')).toEqual({ kind: 'reveal' });
  });

  it('flags unknown input instead of guessing', () => {
    expect(parseCheatCommand('give me gold')).toEqual({
      kind: 'unknown',
      input: 'give me gold',
    });
    expect(parseCheatCommand('win now')).toEqual({ kind: 'unknown', input: 'win now' });
    expect(parseCheatCommand('')).toEqual({ kind: 'unknown', input: '' });
  });
});
