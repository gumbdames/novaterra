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
 * NOVATERRA — fun-audit B5 (2026-10-02) tests: the pure halves of the
 * event-ping system. `PingDirector` (per-class throttle, pool slots,
 * TTL expiry) and `projectPing` (world→screen math with an injectable
 * projector) are fully headless; the DOM shell (`EventPings`) is
 * browser-only and covered by inspection.
 */
import { describe, expect, it } from 'vitest';
import {
  PING_POOL_SIZE,
  PING_THROTTLE_MS,
  PING_TTL_MS,
  PingDirector,
  projectPing,
} from '../src/render/eventPings';

function makeDirector() {
  let now = 0;
  const director = new PingDirector(PING_POOL_SIZE, () => now);
  return { director, advance: (ms: number) => { now += ms; } };
}

/** A stub projector: NDC = world/100, never behind. */
const flatProjector = (x: number, _y: number, z: number) => ({
  nx: x / 100,
  ny: z / 100,
  behind: false,
});

describe('PingDirector (fun-audit B5)', () => {
  it('places a ping and reports it active', () => {
    const { director } = makeDirector();
    const p = director.request('attack', 10, 20);
    expect(p).not.toBeNull();
    expect(p!.x).toBe(10);
    expect(p!.z).toBe(20);
    expect(director.active()).toHaveLength(1);
  });

  it('throttles one ping per class per few seconds (no late-game fireworks)', () => {
    const { director, advance } = makeDirector();
    expect(director.request('attack', 0, 0)).not.toBeNull();
    expect(director.request('attack', 50, 50)).toBeNull();
    // A different class is its own bucket.
    expect(director.request('build', 50, 50)).not.toBeNull();
    advance(PING_THROTTLE_MS);
    expect(director.request('attack', 50, 50)).not.toBeNull();
  });

  it('expires pings after the TTL', () => {
    const { director, advance } = makeDirector();
    director.request('trained', 0, 0);
    expect(director.active()).toHaveLength(1);
    advance(PING_TTL_MS - 1);
    expect(director.active()).toHaveLength(1);
    advance(1);
    expect(director.active()).toHaveLength(0);
  });

  it('drops pings when the pool is exhausted (never allocates)', () => {
    const { director, advance } = makeDirector();
    const kinds = ['attack', 'build', 'trained'] as const;
    for (let i = 0; i < PING_POOL_SIZE; i++) {
      advance(PING_THROTTLE_MS);
      const kind = kinds[i % 3] ?? 'attack';
      expect(director.request(kind, i, i)).not.toBeNull();
    }
    advance(PING_THROTTLE_MS);
    // Pool full (none expired yet) — the 13th ping drops.
    expect(director.request('attack', 999, 999)).toBeNull();
  });
});

describe('projectPing (fun-audit B5)', () => {
  it('maps the world center to the screen center', () => {
    const { sx, sy, onScreen } = projectPing(0, 0, flatProjector, 800, 600);
    expect(sx).toBeCloseTo(400);
    expect(sy).toBeCloseTo(300);
    expect(onScreen).toBe(true);
  });

  it('clamps off-screen pings to the edge instead of dropping them', () => {
    const { sx, sy, onScreen } = projectPing(500, 0, flatProjector, 800, 600);
    // nx = 5 → clamped to the 0.92 margin.
    expect(sx).toBeCloseTo((0.92 * 0.5 + 0.5) * 800);
    expect(sy).toBeCloseTo(300);
    expect(onScreen).toBe(false);
  });

  it('treats behind-camera pings as off-screen', () => {
    const behind = (_x: number, _y: number, _z: number) => ({ nx: 0, ny: 0, behind: true });
    const { onScreen } = projectPing(0, 0, behind, 800, 600);
    expect(onScreen).toBe(false);
  });
});
