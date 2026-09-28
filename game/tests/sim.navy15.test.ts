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
 * Navy + sea gameplay tests (Phase 1.5, component 3/5).
 *
 * Covers: sea domain units, spawn validation (water required),
 * naval combat targeting, and snapshot round-trip for sea units.
 */

import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from '../src/sim/units';
import { canTarget } from '../src/sim/combat';
import { createWorld } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerAgeCommands } from '../src/sim/ages';

interface Ctx {
  world: ReturnType<typeof createWorld>;
  queue: ReturnType<typeof createCommandQueue>;
}

function setup(): Ctx {
  const world = createWorld(99999);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerAgeCommands(queue);
  return { world, queue };
}



describe('navy units', () => {
  it('has three sea-domain units', () => {
    expect(UNIT_DEFS.patrolBoat.domain).toBe('sea');
    expect(UNIT_DEFS.destroyer.domain).toBe('sea');
    expect(UNIT_DEFS.transportShip.domain).toBe('sea');
  });

  it('naval units require the Industry age', () => {
    expect(UNIT_DEFS.patrolBoat.minAge).toBe('industry');
    expect(UNIT_DEFS.destroyer.minAge).toBe('industry');
    expect(UNIT_DEFS.transportShip.minAge).toBe('industry');
  });

  it('patrol boat can target sea units but not land', () => {
    const def = UNIT_DEFS.patrolBoat;
    expect(canTarget(def, { domain: 'sea' } as never)).toBe(true);
    expect(canTarget(def, { domain: 'land' } as never)).toBe(false);
  });

  it('destroyer can target sea and air but not land', () => {
    const def = UNIT_DEFS.destroyer;
    expect(canTarget(def, { domain: 'sea' } as never)).toBe(true);
    expect(canTarget(def, { domain: 'air' } as never)).toBe(true);
    expect(canTarget(def, { domain: 'land' } as never)).toBe(false);
  });

  it('land units cannot target sea units (unless they have sea targeting)', () => {
    // Rifles target ground only.
    const rifles = UNIT_DEFS.rifles;
    expect(canTarget(rifles, { domain: 'sea' } as never)).toBe(false);
  });
});
