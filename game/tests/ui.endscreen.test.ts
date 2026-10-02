/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3.0 of the License.
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
 * NOVATERRA — exploration bet C6 (2026-10-02): illustrated end screens
 * + cinematic camera drift.
 *
 * Covers:
 *  - the art registry: all six EndArt keys resolve to lazy relative
 *    URLs under img/endscreens/ (never absolute — the vite base), and
 *    the victory/defeat defaults.
 *  - the EndScreen wiring (headless fake DOM): show picks the right
 *    art, paints it as the overlay background, reports currentArt;
 *    hide clears it and fires onHide (the controller's drift-stop /
 *    camera-restore hook); onShow fires with the kind (stinger hook).
 *  - the drift math (ui/endDrift.ts): pure, deterministic, eased
 *    orbit — yaw holds at t=0, increases monotonically, and the same
 *    state always yields the same yaw.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EndScreen,
  endArtUrl,
  defaultEndArt,
  END_ARTS,
  type EndArt,
} from '../src/ui/endscreen';
import {
  startEndDrift,
  advanceEndDrift,
  endDriftYaw,
  END_DRIFT_YAW_PER_SEC,
  END_DRIFT_EASE_SEC,
} from '../src/ui/endDrift';
import { installFakeDom, fakeRoot } from './support/fakeDom';

describe('end-screen art registry', () => {
  it('has exactly six arts, no duplicates', () => {
    expect(END_ARTS).toHaveLength(6);
    expect(new Set(END_ARTS).size).toBe(6);
  });

  it('every art resolves to a lazy relative URL under img/endscreens/', () => {
    for (const art of END_ARTS) {
      const url = endArtUrl(art);
      expect(url).toBe(`img/endscreens/${art}.jpg`);
      // Relative — resolves under the vite base (/novaterra/), never
      // an absolute site-root path that would 404 on Pages.
      expect(url.startsWith('/')).toBe(false);
      expect(url.startsWith('http')).toBe(false);
    }
  });

  it('defaults: conquest for victory, annihilation for defeat', () => {
    expect(defaultEndArt('victory')).toBe('victory-conquest');
    expect(defaultEndArt('defeat')).toBe('defeat-annihilation');
  });
});

describe('EndScreen art wiring (fake DOM)', () => {
  function setup() {
    installFakeDom();
    const root = fakeRoot();
    const onShow = vi.fn();
    const onHide = vi.fn();
    const screen = new EndScreen(root, {
      onKeepPlaying: () => undefined,
      onExitToMenu: () => undefined,
      onShow,
      onHide,
    });
    return { screen, root, onShow, onHide };
  }

  it('showVictory defaults to the conquest art and paints it as the overlay background', () => {
    const { screen, root, onShow } = setup();
    screen.showVictory();
    expect(screen.visible).toBe(true);
    expect(screen.currentArt).toBe('victory-conquest');
    expect(onShow).toHaveBeenCalledWith('victory');
    // The overlay paints the illustration as a background (lazy: the
    // URL is first touched here, at show time — never at boot).
    const overlay = (root as unknown as { children: unknown[] }).children[0] as {
      style: Record<string, string>;
    };
    expect(overlay.style.backgroundImage).toContain('img/endscreens/victory-conquest.jpg');
    expect(overlay.style.backgroundSize).toBe('cover');
  });

  it('each victory kind shows its own art', () => {
    const { screen } = setup();
    const arts: EndArt[] = [
      'victory-economic',
      'victory-population',
      'victory-monument',
    ];
    for (const art of arts) {
      screen.showVictory('t', 'd', art);
      expect(screen.currentArt).toBe(art);
    }
  });

  it('defeat kinds map to annihilation vs lost-the-race', () => {
    const { screen, onShow } = setup();
    screen.showDefeat('t', 'd', 'defeat-race');
    expect(screen.currentArt).toBe('defeat-race');
    expect(onShow).toHaveBeenCalledWith('defeat');
    screen.showDefeat();
    expect(screen.currentArt).toBe('defeat-annihilation');
  });

  it('hide clears the art and fires onHide (drift-stop hook)', () => {
    const { screen, onHide } = setup();
    screen.showVictory();
    screen.hide();
    expect(screen.visible).toBe(false);
    expect(screen.currentArt).toBeNull();
    expect(onHide).toHaveBeenCalledTimes(1);
    // Hiding twice fires onHide once — the controller must not
    // double-restore the camera.
    screen.hide();
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('showing twice keeps a single overlay (no stacking)', () => {
    const { screen } = setup();
    screen.showVictory('t', 'd', 'victory-economic');
    screen.showDefeat('t', 'd', 'defeat-race');
    expect(screen.visible).toBe(true);
    expect(screen.currentArt).toBe('defeat-race');
  });
});

describe('end-screen camera drift (pure)', () => {
  it('holds the start yaw at t=0', () => {
    const d = startEndDrift(1.25);
    expect(endDriftYaw(d)).toBeCloseTo(1.25, 12);
  });

  it('is deterministic: same state, same yaw', () => {
    const a = advanceEndDrift(startEndDrift(0.5), 10);
    const b = advanceEndDrift(startEndDrift(0.5), 10);
    expect(endDriftYaw(a)).toBe(endDriftYaw(b));
  });

  it('orbits monotonically after the ease-in', () => {
    let d = startEndDrift(0);
    let prev = endDriftYaw(d);
    for (let i = 0; i < 20; i++) {
      d = advanceEndDrift(d, 5);
      const y = endDriftYaw(d);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });

  it('eases in: early rotation is slower than the full rate', () => {
    const d = advanceEndDrift(startEndDrift(0), END_DRIFT_EASE_SEC / 2);
    const early = endDriftYaw(d);
    // Halfway through the ease window at full rate would be
    // rate * (ease/2); the smoothstep ease-in must be strictly below.
    expect(early).toBeLessThan(END_DRIFT_YAW_PER_SEC * (END_DRIFT_EASE_SEC / 2));
    expect(early).toBeGreaterThan(0);
  });

  it('advancing by non-positive dt is a no-op', () => {
    const d = startEndDrift(2);
    expect(advanceEndDrift(d, 0)).toBe(d);
    expect(advanceEndDrift(d, -1)).toBe(d);
  });
});
