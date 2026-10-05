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
 * NOVATERRA — sim/cheats.ts — cheat command specs (Phase 1, step 11).
 *
 * Responsibilities:
 *  - `registerCheatCommands(queue, terrain)`: registers `cheatGrantResources`
 *    (`prosperity now`) and `cheatInstantBuild` (`fast build`) as ordinary
 *    command specs. They validate at enqueue AND apply, reject loudly,
 *    and run through the same tick-aligned queue as everything else —
 *    the sim stays deterministic; only the *player's decision* to cheat
 *    is out-of-band.
 *  - `CHEAT_GRANT_AMOUNTS`: the fixed `prosperity now` package.
 *  - Cheat-use metadata (`cheated`) is NOT sim state: the UI session
 *    owns it (ui/session.ts) and records it in save metadata
 *    (netSave/savefile.ts). Digests and replays never see it.
 *
 * Cheats that need no sim state (`reveal`, `win`, `lose`, `help`) are
 * handled entirely by the UI cheat console (ui/cheatConsole.ts) and
 * never reach this module.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { CommandQueue } from './commands';
import { getPlayer, ejectUnitsFromFootprints, cellIsWater, type ResourceKey } from './city';
import { addStock } from './economy';
import type { World } from './world';
import type { TerrainData } from './terrain';

/** Fixed `prosperity now` grant: funds, materials, food, fuel. */
export const CHEAT_GRANT_AMOUNTS: Record<ResourceKey, number> = {
  funds: 5000,
  materials: 2000,
  food: 1000,
  fuel: 1000,
  research: 0,
  goods: 500,
  influence: 0,
  manpower: 0,
};

/** Grant resources to a player. Deterministic: fixed amounts, no RNG. */
export function cheatGrantResources(world: World, owner: number): void {
  const player = getPlayer(world.city, owner);
  if (!player) throw new Error(`cheatGrantResources: unknown owner ${owner}`);
  for (const key of Object.keys(CHEAT_GRANT_AMOUNTS) as ResourceKey[]) {
    const amount = CHEAT_GRANT_AMOUNTS[key] ?? 0;
    if (amount !== 0) addStock(player, key, amount);
  }
}

/**
 * Finish every unfinished building owned by a player. Deterministic.
 *
 * Unit/building-overlap rescue (2026-10-05, Fix 4): instant completion
 * skips runConstruction's eject-on-completion, so anyone standing on a
 * finished site is displaced to the nearest free cell — the same
 * deterministic spiral as the normal path (ejectUnitsFromFootprints).
 * Terrain is threaded from the cheat spec (registerCheatCommands);
 * direct callers without terrain get the legacy complete-only
 * behavior.
 */
export function cheatInstantBuild(world: World, owner: number, terrain?: TerrainData): void {
  for (const b of world.city.buildings) {
    if (b.owner === owner && b.progress < 1) b.progress = 1;
  }
  if (terrain !== undefined) {
    ejectUnitsFromFootprints(world.city, world.units, (cx, cz) => cellIsWater(terrain, cx, cz));
  }
}

function payloadOwner(cmd: { payload: Record<string, unknown> }): number | null {
  const owner = cmd.payload['owner'];
  if (typeof owner !== 'number' || !Number.isInteger(owner)) return null;
  return owner;
}

/** Register the sim-affecting cheat command specs. */
export function registerCheatCommands(queue: CommandQueue, terrain: TerrainData): void {
  queue.register('cheatGrantResources', {
    validate(cmd, world): string | null {
      if (cmd.issuer !== 'cheat') {
        return 'cheatGrantResources: must be issued by the cheat console';
      }
      const owner = payloadOwner(cmd);
      if (owner === null || !getPlayer(world.city, owner)) {
        return 'cheatGrantResources: unknown owner';
      }
      return null;
    },
    apply(cmd, world): unknown {
      cheatGrantResources(world, payloadOwner(cmd) as number);
      return null;
    },
  });

  queue.register('cheatInstantBuild', {
    validate(cmd, world): string | null {
      if (cmd.issuer !== 'cheat') {
        return 'cheatInstantBuild: must be issued by the cheat console';
      }
      const owner = payloadOwner(cmd);
      if (owner === null || !getPlayer(world.city, owner)) {
        return 'cheatInstantBuild: unknown owner';
      }
      return null;
    },
    apply(cmd, world): unknown {
      cheatInstantBuild(world, payloadOwner(cmd) as number, terrain);
      return null;
    },
  });
}
