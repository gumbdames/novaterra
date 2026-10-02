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
 * NOVATERRA — envoy UI contract tests (fun-audit Tier 4 / E1, 0.1 Alpha).
 *
 * Covers the pure banner-view contract (`ui/envoy.ts`): hidden when no
 * envoy visits, the four display phases (inbound / waiting /
 * refusalWaiting / departing), the whole-seconds answer countdown, the
 * owner gate, and defensive reads on malformed worlds.
 */
import { describe, expect, it } from 'vitest';
import { envoyBannerView } from '../src/ui/envoy';
import type { World } from '../src/sim/world';
import type { EnvoyStatus } from '../src/sim/diplomacy';

const HUMAN = 0;

function baseEnvoy(over: Partial<EnvoyStatus> = {}): EnvoyStatus {
  return {
    state: 'waiting',
    offer: { kind: 'ceasefire', verdict: 'accepted', owner: HUMAN, aiOwner: 1 },
    unitId: 42,
    deadlineTick: 1900,
    parkX: 10,
    parkZ: 20,
    exitX: -100,
    exitZ: 200,
    inboundSinceTick: 100,
    departByTick: 0,
    resolution: null,
    dovesPending: false,
    ...over,
  };
}

function worldWith(envoy: EnvoyStatus | null, tick = 100): World {
  return {
    tick,
    diplomacy: { envoy, pendingEnvoyDispatch: null },
  } as unknown as World;
}

describe('envoyBannerView', () => {
  it('is null when no envoy visits', () => {
    expect(envoyBannerView(worldWith(null), HUMAN)).toBeNull();
  });

  it('is null for a malformed world', () => {
    expect(envoyBannerView({} as World, HUMAN)).toBeNull();
    expect(envoyBannerView({ diplomacy: {} } as unknown as World, HUMAN)).toBeNull();
  });

  it('shows inbound while the SUV drives in', () => {
    const view = envoyBannerView(worldWith(baseEnvoy({ state: 'inbound' })), HUMAN);
    expect(view?.phase).toBe('inbound');
    expect(view?.secondsLeft).toBeNull();
    expect(view?.unitId).toBe(42);
  });

  it('shows waiting with the whole-seconds countdown', () => {
    // deadline 1900, tick 100 → 1800 ticks = 60 s.
    const view = envoyBannerView(worldWith(baseEnvoy(), 100), HUMAN);
    expect(view?.phase).toBe('waiting');
    expect(view?.secondsLeft).toBe(60);
  });

  it('reads a refusal as its own phase', () => {
    const envoy = baseEnvoy({
      offer: { kind: 'ceasefire', verdict: 'declined', owner: HUMAN, aiOwner: 1 },
    });
    expect(envoyBannerView(worldWith(envoy), HUMAN)?.phase).toBe('refusalWaiting');
  });

  it('shows departing after the ceremony resolves', () => {
    const view = envoyBannerView(
      worldWith(baseEnvoy({ state: 'departing', resolution: 'accepted' })),
      HUMAN,
    );
    expect(view?.phase).toBe('departing');
    expect(view?.secondsLeft).toBeNull();
  });

  it('hides the countdown once the deadline passes', () => {
    const view = envoyBannerView(worldWith(baseEnvoy({ deadlineTick: 50 }), 100), HUMAN);
    expect(view?.secondsLeft).toBeNull();
  });

  it('is null for another owner\'s visit', () => {
    const envoy = baseEnvoy({
      offer: { kind: 'ceasefire', verdict: 'accepted', owner: 1, aiOwner: HUMAN },
    });
    expect(envoyBannerView(worldWith(envoy), HUMAN)).toBeNull();
  });
});
