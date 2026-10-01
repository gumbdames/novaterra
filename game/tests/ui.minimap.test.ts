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
 * NOVATERRA — minimap tests (ui/minimap.ts, roadmap B12).
 *
 * The minimap is a 2D-canvas tactical overview: terrain relief, entity
 * dots, the camera viewport box, click/drag camera jumps. The canvas
 * itself can't be asserted headless, so these tests pin the pure layer
 * underneath it:
 *  - world↔minimap coordinate mapping (corners, center, round-trip),
 *  - the terrain relief palette (water vs land, depth shading),
 *  - the team dot colors (incl. colorblind mode),
 *  - the fog-of-war collector: rival dots appear only when the sim's
 *    sight model actually reveals them (no maphack).
 */
import { describe, expect, it } from 'vitest';

import {
  worldToMinimap,
  minimapToWorld,
  terrainMinimapColor,
  teamDotColor,
  collectMinimapDots,
  MINIMAP_SIZE_PX,
} from '../src/ui/minimap';
import {
  createSession,
  HUMAN_PLAYER_ID,
  AI_PLAYER_ID,
} from '../src/ui/session';
import { spawnUnit } from '../src/sim/units';
import { placeBuilding } from '../src/sim/city';

const WORLD = 1024; // standard 512-cell map, 2 world units per cell
const SIZE = MINIMAP_SIZE_PX;

describe('worldToMinimap / minimapToWorld', () => {
  it('maps the map corners to the canvas corners', () => {
    expect(worldToMinimap(-512, -512, SIZE, WORLD)).toEqual({ px: 0, py: 0 });
    expect(worldToMinimap(512, 512, SIZE, WORLD)).toEqual({
      px: SIZE,
      py: SIZE,
    });
    expect(worldToMinimap(-512, 512, SIZE, WORLD)).toEqual({
      px: 0,
      py: SIZE,
    });
  });

  it('maps the map center to the canvas center', () => {
    const { px, py } = worldToMinimap(0, 0, SIZE, WORLD);
    expect(px).toBeCloseTo(SIZE / 2, 9);
    expect(py).toBeCloseTo(SIZE / 2, 9);
  });

  it('round-trips through minimapToWorld', () => {
    for (const [x, z] of [
      [-511, -511],
      [123.5, -456.25],
      [0, 0],
      [511, 511],
    ] as const) {
      const { px, py } = worldToMinimap(x, z, SIZE, WORLD);
      const back = minimapToWorld(px, py, SIZE, WORLD);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.z).toBeCloseTo(z, 9);
    }
  });
});

describe('terrainMinimapColor', () => {
  it('paints water below the water level, land at/above it', () => {
    const [wr, wg, wb] = terrainMinimapColor(4, 10);
    const [lr, lg, lb] = terrainMinimapColor(10, 10);
    // Water is blue-dominant; land is green-dominant at low height.
    expect(wb).toBeGreaterThan(wr);
    expect(wb).toBeGreaterThan(wg);
    expect(lg).toBeGreaterThan(lr);
    expect(lg).toBeGreaterThan(lb);
  });

  it('shades deeper water darker', () => {
    const shallow = terrainMinimapColor(9, 10);
    const deep = terrainMinimapColor(-2, 10);
    const lum = ([r, g, b]: readonly [number, number, number]) => r + g + b;
    expect(lum(deep)).toBeLessThan(lum(shallow));
  });

  it('moves from green lowlands toward gray at altitude', () => {
    const low = terrainMinimapColor(2, 0);
    const high = terrainMinimapColor(60, 0);
    // Lowland is green-dominant; peaks desaturate toward gray.
    expect(low[1]).toBeGreaterThan(low[0]);
    const spread = (c: readonly [number, number, number]) =>
      Math.max(...c) - Math.min(...c);
    expect(spread(high)).toBeLessThan(spread(low));
  });
});

describe('teamDotColor', () => {
  it('paints the human side blue and rivals red by default', () => {
    expect(teamDotColor(HUMAN_PLAYER_ID, false)).toBe('#3aa0ff');
    expect(teamDotColor(AI_PLAYER_ID, false)).toBe('#ff5544');
  });

  it('switches rivals to orange in colorblind mode', () => {
    expect(teamDotColor(HUMAN_PLAYER_ID, true)).toBe('#3aa0ff');
    expect(teamDotColor(AI_PLAYER_ID, true)).toBe('#ffaa00');
  });
});

describe('collectMinimapDots (fog of war)', () => {
  it("always shows the player's own units and buildings", () => {
    const session = createSession({ seed: 1201 });
    const world = session.world;
    const own = spawnUnit(world, 'engineer', HUMAN_PLAYER_ID, 0, 0);
    const hall = placeBuilding(world.city, {
      kind: 'farm',
      owner: HUMAN_PLAYER_ID,
      cx: 250,
      cz: 250,
      facing: 0,
    });
    hall.progress = 1;
    const dots = collectMinimapDots(world, HUMAN_PLAYER_ID);
    const byId = new Map(dots.map((d) => [d.id, d]));
    expect(byId.get(own.id)).toMatchObject({ owner: HUMAN_PLAYER_ID, building: false });
    expect(byId.get(hall.id)).toMatchObject({ owner: HUMAN_PLAYER_ID, building: true });
  });

  it('shows a rival unit only inside the sight model, never a maphack', () => {
    const session = createSession({ seed: 1202 });
    const world = session.world;
    spawnUnit(world, 'engineer', HUMAN_PLAYER_ID, 0, 0);
    const near = spawnUnit(world, 'engineer', AI_PLAYER_ID, 10, 10);
    const far = spawnUnit(world, 'engineer', AI_PLAYER_ID, 200, 200);
    const dots = collectMinimapDots(world, HUMAN_PLAYER_ID);
    const ids = new Set(dots.map((d) => d.id));
    // 10 world units away: well inside any unit's sight disc.
    expect(ids.has(near.id)).toBe(true);
    // 400+ away: far beyond sight — the minimap must not reveal it.
    expect(ids.has(far.id)).toBe(false);
  });

  it('shows a rival building only when the sight model reveals it', () => {
    const session = createSession({ seed: 1203 });
    const world = session.world;
    spawnUnit(world, 'engineer', HUMAN_PLAYER_ID, 0, 0);
    const nearHall = placeBuilding(world.city, {
      kind: 'farm',
      owner: AI_PLAYER_ID,
      cx: 126,
      cz: 127,
      facing: 0,
    });
    nearHall.progress = 1;
    const farHall = placeBuilding(world.city, {
      kind: 'farm',
      owner: AI_PLAYER_ID,
      cx: 10,
      cz: 10,
      facing: 0,
    });
    farHall.progress = 1;
    const dots = collectMinimapDots(world, HUMAN_PLAYER_ID);
    const ids = new Set(dots.map((d) => d.id));
    expect(ids.has(nearHall.id)).toBe(true);
    expect(ids.has(farHall.id)).toBe(false);
  });

  it('skips destroyed units', () => {
    const session = createSession({ seed: 1204 });
    const world = session.world;
    const dead = spawnUnit(world, 'engineer', HUMAN_PLAYER_ID, 0, 0);
    dead.hp = 0;
    const dots = collectMinimapDots(world, HUMAN_PLAYER_ID);
    expect(dots.some((d) => d.id === dead.id)).toBe(false);
  });
});
