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
 * Tests for terrain-riding entity Y placement.
 *
 * - `render/terrainHeight.ts` pure rules: `groundYAt` (land/air → terrain
 *   height, sea → water level, null terrain → 0) and `unitHoverY`
 *   (land 0.15, spectre 1.6, air 14, sea 0).
 * - `render/roads.ts` terrain drape: per-corner height sampling, offset
 *   above the surface, crack-free shared corners, geometric normals,
 *   flat legacy path preserved without a callback.
 * - `render/entities.ts` wiring: with a terrain passed via constructor
 *   opts, unit/building/road/FX views sit on the terrain (not at y=0);
 *   without terrain the legacy y=0 placement is kept.
 *
 * Headless (node env): `document` is stubbed for the health-bar canvas
 * texture; everything else is pure three.js scene graph work.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

import { EntityRenderer } from '../src/render/entities';
import {
  buildRoadGeometry,
  buildRoadMarkings,
  ROAD_Y,
  ROAD_DASH_Y,
  ROAD_RIBBON_TERRAIN_OFFSET,
  ROAD_DASH_TERRAIN_OFFSET,
} from '../src/render/roads';
import {
  groundYAt,
  unitHoverY,
  AIR_HOVER_Y,
  UNIT_GROUND_EPSILON,
  SPECTRE_HOVER_Y,
  BUILDING_GROUND_EPSILON,
  SELECTION_RING_OFFSET,
} from '../src/render/terrainHeight';
import {
  generateTerrain,
  getMapPreset,
  heightAt,
  type TerrainData,
} from '../src/sim/terrain';
import { cellCenterWorld, cellIndex, CELL_WORLD_SIZE, BUILDING_DEFS, type BuildingRecord } from '../src/sim/city';
import type { UnitRecord } from '../src/sim/units';
import type { World } from '../src/sim/world';

// ---------------------------------------------------------------------------
// DOM stub + fakes.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (_tag: string) => ({
      width: 1,
      height: 1,
      getContext: () => ({ fillStyle: '', fillRect: () => {} }),
    }),
    documentElement: { classList: { contains: () => false } },
  });
});

let nextId = 1;

function terrain(): TerrainData {
  const preset = getMapPreset('Meridian Plains');
  return generateTerrain(preset.seed, preset);
}

function fakeUnit(
  kind: string,
  domain: 'land' | 'air' | 'sea',
  x: number,
  z: number,
  owner = 0,
): UnitRecord {
  return {
    id: nextId++,
    kind,
    domain,
    owner,
    x,
    z,
    destX: x,
    destZ: z,
    hp: 100,
  } as unknown as UnitRecord;
}

function fakeBuilding(kind: string, cx: number, cz: number, owner = 0): BuildingRecord {
  return {
    id: nextId++,
    kind,
    owner,
    cx,
    cz,
    progress: 1,
  } as unknown as BuildingRecord;
}

function fakeWorld(parts: {
  units?: UnitRecord[];
  buildings?: BuildingRecord[];
  roads?: number[];
}): World {
  return {
    tick: 0,
    units: parts.units ?? [],
    city: { buildings: parts.buildings ?? [], roads: parts.roads ?? [] },
    superweapons: { fx: [] },
  } as unknown as World;
}

/** Find a land point with terrain height in [minH, maxH). */
function findLand(t: TerrainData, minH: number, maxH: number): { x: number; z: number } {
  return findLandPair(t, minH, maxH)[0] as { x: number; z: number };
}

/** Find two distinct land points with terrain height in [minH, maxH). */
function findLandPair(t: TerrainData, minH: number, maxH: number): [{ x: number; z: number }, { x: number; z: number }] {
  const found: Array<{ x: number; z: number }> = [];
  for (let z = -200; z <= 200 && found.length < 2; z += 10) {
    for (let x = -200; x <= 200 && found.length < 2; x += 10) {
      const h = heightAt(t, x, z);
      if (h >= minH && h < maxH && h >= t.waterLevel) found.push({ x, z });
    }
  }
  if (found.length < 2) throw new Error('no land pair in range');
  return [found[0] as { x: number; z: number }, found[1] as { x: number; z: number }];
}

/** Find a water point. */
function findWater(t: TerrainData): { x: number; z: number } {
  for (let z = -200; z <= 200; z += 10) {
    for (let x = -200; x <= 200; x += 10) {
      if (heightAt(t, x, z) < t.waterLevel) return { x, z };
    }
  }
  throw new Error('no water point');
}

// ---------------------------------------------------------------------------
// Pure placement rules.
// ---------------------------------------------------------------------------

describe('groundYAt', () => {
  it('land → terrain height; air → the same ground (hover is separate)', () => {
    const t = terrain();
    const { x, z } = findLand(t, 5, 25);
    expect(groundYAt(t, t.waterLevel, 'land', x, z)).toBeCloseTo(heightAt(t, x, z), 6);
    expect(groundYAt(t, t.waterLevel, 'air', x, z)).toBeCloseTo(heightAt(t, x, z), 6);
  });

  it('sea → water level regardless of position', () => {
    const t = terrain();
    const { x, z } = findWater(t);
    expect(groundYAt(t, t.waterLevel, 'sea', x, z)).toBe(t.waterLevel);
    expect(groundYAt(t, t.waterLevel, 'sea', 0, 0)).toBe(t.waterLevel);
  });

  it('null terrain → 0 (legacy headless behavior)', () => {
    expect(groundYAt(null, -2, 'land', 10, 20)).toBe(0);
    expect(groundYAt(null, -2, 'sea', 10, 20)).toBe(0);
    expect(groundYAt(null, -2, 'air', 10, 20)).toBe(0);
  });
});

describe('unitHoverY', () => {
  it('land units sit 0.15 above the ground; the spectre hovers at 1.6', () => {
    expect(unitHoverY('land', 'tank')).toBe(UNIT_GROUND_EPSILON);
    expect(unitHoverY('land', 'tank')).toBe(0.15);
    expect(unitHoverY('land', 'spectre')).toBe(SPECTRE_HOVER_Y);
    expect(unitHoverY('land', 'spectre')).toBe(1.6);
  });

  it('air units hover at 14; sea units ride the waterline (0 relative)', () => {
    expect(unitHoverY('air', 'fighter')).toBe(AIR_HOVER_Y);
    expect(unitHoverY('air', 'fighter')).toBe(14);
    expect(unitHoverY('sea', 'patrolBoat')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Road draping.
// ---------------------------------------------------------------------------

describe('road terrain drape', () => {
  const cells = [
    { x: 10, z: 20 },
    { x: 12, z: 20 },
    { x: 14, z: 20 },
  ];

  it('samples the height callback per corner, offset above the surface', () => {
    const t = terrain();
    const geo = buildRoadGeometry(cells, CELL_WORLD_SIZE, (x, z) => heightAt(t, x, z));
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    // First quad (cell 10,20): corners at x = 9/11, z = 19/21.
    for (let i = 0; i < 4; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      expect(y).toBeCloseTo(heightAt(t, x, z) + ROAD_RIBBON_TERRAIN_OFFSET, 6);
    }
  });

  it('shared corners of adjacent cells agree (no cracks)', () => {
    const t = terrain();
    const geo = buildRoadGeometry(cells, CELL_WORLD_SIZE, (x, z) => heightAt(t, x, z));
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    // Quad 0 corner (11, 19..21) and quad 1 corner (11, 19..21) share x=11.
    const heightsAtX11 = new Map<string, number>();
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i) - 11) < 1e-6) {
        const key = `${pos.getX(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
        const y = pos.getY(i);
        if (heightsAtX11.has(key)) {
          expect(y).toBe(heightsAtX11.get(key));
        } else {
          heightsAtX11.set(key, y);
        }
      }
    }
    expect(heightsAtX11.size).toBeGreaterThan(0);
  });

  it('normals follow the slope (unit length, pointing up)', () => {
    const t = terrain();
    const geo = buildRoadGeometry(cells, CELL_WORLD_SIZE, (x, z) => heightAt(t, x, z));
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    expect(nor.count).toBeGreaterThan(0);
    for (let i = 0; i < nor.count; i++) {
      const len = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i));
      expect(len).toBeCloseTo(1, 5);
      expect(nor.getY(i)).toBeGreaterThan(0);
    }
  });

  it('dashes sit the 0.03 step above the ribbon over terrain', () => {
    const t = terrain();
    const ribbon = buildRoadGeometry(cells, CELL_WORLD_SIZE, (x, z) => heightAt(t, x, z));
    const dash = buildRoadMarkings(cells, CELL_WORLD_SIZE, (x, z) => heightAt(t, x, z));
    const rp = ribbon.getAttribute('position') as THREE.BufferAttribute;
    const dp = dash.getAttribute('position') as THREE.BufferAttribute;
    expect(dp.count).toBeGreaterThan(0);
    // Middle cell (12,20) gets a dash; every dash vertex sits at its own
    // terrain height + the dash offset.
    let n = 0;
    let dashSum = 0;
    for (let i = 0; i < dp.count; i++) {
      const x = dp.getX(i);
      const z = dp.getZ(i);
      if (Math.abs(x - 12) > 1 || Math.abs(z - 20) > 1) continue;
      expect(dp.getY(i)).toBeCloseTo(heightAt(t, x, z) + ROAD_DASH_TERRAIN_OFFSET, 4);
      dashSum += dp.getY(i);
      n++;
    }
    expect(n).toBeGreaterThan(0);
    const dashAvg = dashSum / n;
    expect(ROAD_DASH_TERRAIN_OFFSET - ROAD_RIBBON_TERRAIN_OFFSET).toBeCloseTo(0.03, 9);
    // Sanity: the ribbon under the dash is lower — compare ribbon
    // vertices within half a cell of (12,20) against the dash average.
    let ribbonY = 0;
    let rn = 0;
    for (let i = 0; i < rp.count; i++) {
      if (Math.abs(rp.getX(i) - 12) <= 1 && Math.abs(rp.getZ(i) - 20) <= 1) {
        ribbonY += rp.getY(i);
        rn++;
      }
    }
    expect(rn).toBeGreaterThan(0);
    expect(ribbonY / rn).toBeLessThan(dashAvg);
    expect(dashAvg - ribbonY / rn).toBeCloseTo(0.03, 2);
    ribbon.dispose();
    dash.dispose();
  });

  it('without a height callback the flat legacy path is preserved', () => {
    const geo = buildRoadGeometry(cells, CELL_WORLD_SIZE);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeCloseTo(ROAD_Y, 6);
    }
    const dash = buildRoadMarkings(cells, CELL_WORLD_SIZE);
    const dp = dash.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < dp.count; i++) {
      expect(dp.getY(i)).toBeCloseTo(ROAD_DASH_Y, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// EntityRenderer wiring: views ride the terrain when it is provided.
// ---------------------------------------------------------------------------

describe('EntityRenderer terrain riding', () => {
  it('land unit groups sit on the terrain; sea units at water level; air at terrain + 14', () => {
    const t = terrain();
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, new Map(), {
      waterLevel: t.waterLevel,
      terrain: t,
    });
    const land = findLand(t, 5, 25);
    const water = findWater(t);
    const uLand = fakeUnit('tank', 'land', land.x, land.z);
    const uSea = fakeUnit('patrolBoat', 'sea', water.x, water.z);
    const uAir = fakeUnit('fighter', 'air', land.x, land.z);
    renderer.sync(fakeWorld({ units: [uLand, uSea, uAir] }));
    const groups = scene.getObjectByName('units')?.children as THREE.Group[];
    expect(groups).toHaveLength(3);
    // sync() preserves world order: land rides the terrain, sea floats at
    // the water level, air rides the terrain with the 14 hover applied
    // to the hull (group-relative).
    expect((groups[0] as THREE.Group).position.y).toBeCloseTo(
      heightAt(t, land.x, land.z),
      6,
    );
    expect((groups[1] as THREE.Group).position.y).toBe(t.waterLevel);
    const airGroup = groups[2] as THREE.Group;
    expect(airGroup.position.y).toBeCloseTo(heightAt(t, land.x, land.z), 6);
    const airHull = airGroup.children[0] as THREE.Group;
    expect(airHull.position.y).toBe(AIR_HOVER_Y);
    renderer.dispose();
  });

  it('moving land units re-ride the terrain every frame', () => {
    const t = terrain();
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, new Map(), {
      waterLevel: t.waterLevel,
      terrain: t,
    });
    const [a, b] = findLandPair(t, 5, 25);
    const u = fakeUnit('tank', 'land', a.x, a.z);
    renderer.sync(fakeWorld({ units: [u] }));
    const g = (scene.getObjectByName('units')?.children as THREE.Group[])[0] as THREE.Group;
    expect(g.position.y).toBeCloseTo(heightAt(t, a.x, a.z), 6);
    u.x = b.x;
    u.z = b.z;
    renderer.sync(fakeWorld({ units: [u] }));
    expect(g.position.y).toBeCloseTo(heightAt(t, b.x, b.z), 6);
    renderer.dispose();
  });

  it('buildings rest their foundation on the terrain at the footprint center', () => {
    const t = terrain();
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, new Map(), {
      waterLevel: t.waterLevel,
      terrain: t,
    });
    // house at cell (2,2): footprint center via the same math the
    // renderer uses.
    const b = fakeBuilding('house', 2, 2);
    renderer.sync(fakeWorld({ buildings: [b] }));
    const g = (scene.getObjectByName('buildings')?.children as THREE.Group[])[0] as THREE.Group;
    const def = BUILDING_DEFS['house'];
    const bx = cellCenterWorld(2) + (def.footprintW * CELL_WORLD_SIZE - CELL_WORLD_SIZE) / 2;
    const bz = cellCenterWorld(2) + (def.footprintH * CELL_WORLD_SIZE - CELL_WORLD_SIZE) / 2;
    expect(g.position.x).toBeCloseTo(bx, 9);
    expect(g.position.z).toBeCloseTo(bz, 9);
    expect(g.position.y).toBeCloseTo(
      heightAt(t, bx, bz) + BUILDING_GROUND_EPSILON,
      6,
    );
    renderer.dispose();
  });

  it('selection rings ride the ground under the unit', () => {
    const t = terrain();
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, new Map(), {
      waterLevel: t.waterLevel,
      terrain: t,
    });
    const land = findLand(t, 5, 25);
    const u = fakeUnit('tank', 'land', land.x, land.z);
    renderer.sync(fakeWorld({ units: [u] }));
    renderer.setSelected([u.id]);
    renderer.updateSelectionRings(EntityRenderer.unitMap(fakeWorld({ units: [u] })));
    const fx = scene.getObjectByName('fx') as THREE.Group;
    const ring = fx.children[0] as THREE.Mesh;
    expect(ring.position.x).toBeCloseTo(land.x, 9);
    expect(ring.position.z).toBeCloseTo(land.z, 9);
    expect(ring.position.y).toBeCloseTo(
      heightAt(t, land.x, land.z) + SELECTION_RING_OFFSET,
      6,
    );
    renderer.dispose();
  });

  it('road meshes drape over the terrain instead of lying flat at y=0', () => {
    const t = terrain();
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, new Map(), {
      waterLevel: t.waterLevel,
      terrain: t,
    });
    const land = findLand(t, 5, 25);
    // Road cells near the land point: convert world → cell index.
    const toCell = (w: number): number => Math.round((w + 256 - 1) / CELL_WORLD_SIZE);
    const cx = toCell(land.x);
    const cz = toCell(land.z);
    const roads = [cellIndex(cx, cz), cellIndex(cx + 1, cz), cellIndex(cx + 2, cz)];
    renderer.sync(fakeWorld({ roads }));
    const buildings = scene.getObjectByName('buildings') as THREE.Group;
    expect(buildings.children.length).toBeGreaterThan(0);
    const ribbon = buildings.children[0] as THREE.Mesh;
    const pos = ribbon.geometry.getAttribute('position') as THREE.BufferAttribute;
    // Every ribbon vertex must sit at its own terrain height + the offset
    // (not flat at y=0).
    expect(pos.count).toBeGreaterThan(0);
    let maxAbsY = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      expect(pos.getY(i)).toBeCloseTo(
        heightAt(t, x, z) + ROAD_RIBBON_TERRAIN_OFFSET,
        4,
      );
      maxAbsY = Math.max(maxAbsY, Math.abs(pos.getY(i)));
    }
    expect(maxAbsY).toBeGreaterThan(1); // actually draped, not flat
    renderer.dispose();
  });

  it('without terrain the legacy flat placement is kept (no crash, y≈0)', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene); // no opts at all
    const u = fakeUnit('tank', 'land', 10, 20);
    const b = fakeBuilding('house', 0, 0);
    renderer.sync(fakeWorld({ units: [u], buildings: [b], roads: [cellIndex(0, 0)] }));
    const ug = (scene.getObjectByName('units')?.children as THREE.Group[])[0] as THREE.Group;
    const bg = (scene.getObjectByName('buildings')?.children as THREE.Group[])[0] as THREE.Group;
    expect(ug.position.y).toBe(0);
    expect(bg.position.y).toBeCloseTo(BUILDING_GROUND_EPSILON, 9);
    renderer.dispose();
  });
});
