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
 * Tests for render/entitySurfaces.ts (0.1 Alpha): the per-model surface
 * treatment table, its application at load time, the procedural
 * `surfaceMaterial()` helper, and road-ribbon UVs.
 *
 * Headless-safe: every texture in the surface library is a
 * `THREE.DataTexture` (no canvas/DOM).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  KEY_TREATMENTS,
  applySurfaceTreatment,
  surfaceMaterial,
  type MaterialTreatment,
} from '../src/render/entitySurfaces';
import { MODEL_PATHS } from '../src/render/models';
import {
  PROCEDURAL_KINDS,
  buildProceduralModel,
  buildInfantryGear,
  buildRadarDishProp,
  buildHqAntenna,
  buildAwacsDome,
  buildShipMast,
  buildRunwayStrip,
  buildCoolingTower,
  buildHospitalCross,
  buildSignalMast,
} from '../src/render/proceduralModels';
import { SURFACE_CATEGORIES, surfaceTexture, surfaceRoughnessTexture } from '../src/render/surfaceTextures';
import { SURFACE_MATERIALS } from '../src/render/surfaceMaterials';
import {
  buildRoadGeometry,
  buildRoadMarkings,
  ROAD_UV_WORLD_SCALE,
} from '../src/render/roads';

/** Fresh standard material with a GLB-style name, like the loader mints. */
function namedMat(name: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial();
  m.name = name;
  return m;
}

/** Box geometry with UVs stripped, mimicking the UV-less Quaternius GLBs. */
function uvLessBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.deleteAttribute('uv');
  return g;
}

describe('KEY_TREATMENTS coverage', () => {
  it('covers every MODEL_PATHS key', () => {
    const missing = Object.keys(MODEL_PATHS).filter(
      (k) => !(k in KEY_TREATMENTS),
    );
    expect(missing).toEqual([]);
  });

  it('references only real surface categories', () => {
    const valid = new Set<string>(SURFACE_CATEGORIES);
    const check = (t: MaterialTreatment, where: string) => {
      if (t.map !== undefined) {
        expect(valid.has(t.map), `${where}: bad map ${t.map}`).toBe(true);
      }
      if (t.roughnessMap !== undefined) {
        expect(valid.has(t.roughnessMap), `${where}: bad roughnessMap ${t.roughnessMap}`).toBe(true);
      }
    };
    for (const [key, treatment] of Object.entries(KEY_TREATMENTS)) {
      check(treatment.default, key);
      for (const rule of treatment.byName ?? []) {
        expect(() => new RegExp(rule.pattern.source), `${key}: bad regex`).not.toThrow();
        check(rule.treatment, `${key} /${rule.pattern.source}/`);
      }
      if (treatment.uvWorldScale !== undefined) {
        expect(treatment.uvWorldScale).toBeGreaterThan(0);
      }
    }
  });
});

describe('applySurfaceTreatment', () => {
  it('leaves unknown keys completely untouched', () => {
    const geo = uvLessBox();
    const mat = namedMat('colormap');
    const before = { metalness: mat.metalness, roughness: mat.roughness };
    applySurfaceTreatment('no-such-key', [geo], [mat]);
    expect(geo.getAttribute('uv')).toBeUndefined();
    expect(mat.map).toBeNull();
    expect(mat.roughnessMap).toBeNull();
    expect(mat.metalness).toBe(before.metalness);
    expect(mat.roughness).toBe(before.roughness);
  });

  it('treats the tank by material name (hull camo / details gunmetal / wheels rubber)', () => {
    const geo = uvLessBox();
    const main = namedMat('Main');
    const details = namedMat('Main_Details');
    const wheels = namedMat('Wheels');
    const skin = namedMat('Skin');
    applySurfaceTreatment('tank', [geo], [main, details, wheels, skin]);

    // Quaternius has no UVs: treatment must project them first.
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    expect(uv).toBeDefined();
    expect(uv.count).toBe(geo.getAttribute('position').count);
    for (let i = 0; i < uv.array.length; i++) {
      expect(Number.isFinite(uv.array[i])).toBe(true);
    }

    expect(main.map).toBe(surfaceTexture('camoDesert'));
    expect(main.roughnessMap).toBe(surfaceRoughnessTexture('camoDesert'));
    expect(main.metalness).toBeCloseTo(0.25, 5);
    expect(main.color.r).toBeCloseTo(1, 5); // authored tan discarded → white

    expect(details.map).toBe(surfaceTexture('gunmetal'));
    expect(details.metalness).toBeCloseTo(0.7, 5);

    expect(wheels.map).toBe(surfaceTexture('tireRubber'));
    expect(wheels.metalness).toBe(0);

    // Unlisted names get the default treatment, maps untouched.
    expect(skin.map).toBeNull();
    expect(skin.metalness).toBeCloseTo(0.1, 5);
  });

  it('gives solar PV cells (colormap-specular) the glass treatment', () => {
    const cells = namedMat('colormap-specular');
    const frame = namedMat('colormap');
    applySurfaceTreatment('solarFarmA', [], [cells, frame]);
    expect(cells.roughness).toBeCloseTo(0.22, 5);
    expect(cells.metalness).toBeCloseTo(0.7, 5);
    expect(cells.envMapIntensity).toBeCloseTo(1.6, 5);
    expect(frame.roughness).toBeCloseTo(1.0, 5);
    expect(frame.metalness).toBeCloseTo(0.4, 5);
  });

  it('maps the barn reds to wood planks tinted to the authored red', () => {
    const red = namedMat('DarkRed');
    applySurfaceTreatment('farmBarn', [], [red]);
    expect(red.map).toBe(surfaceTexture('woodPlank'));
    expect(red.roughnessMap).toBe(surfaceRoughnessTexture('woodPlank'));
    // woodPlank mid-brown × tint ≈ authored DarkRed (linear 0.202/0.0425/0.0321)
    expect(red.color.r).toBeCloseTo(0.202 / 0.304, 2);
    expect(red.color.g).toBeCloseTo(0.0425 / 0.163, 2);
    expect(red.color.b).toBeCloseTo(0.0321 / 0.08, 2);
  });

  it('de-blacks space-kit metal (metalness 1 → tame) while keeping the orange accent', () => {
    const metal = namedMat('metal');
    const dark = namedMat('dark');
    const accent = namedMat('metalRed');
    accent.color.setHex(0xffa133); // the GLB's authored orange
    applySurfaceTreatment('spectre', [], [metal, dark, accent]);
    for (const m of [metal, dark, accent]) {
      expect(m.metalness).toBeLessThan(1);
      expect(m.map).not.toBeNull();
    }
    // metalRed keeps its authored orange (no tint override in the table).
    expect(accent.color.getHex()).toBe(0xffa133);
  });

  it('skips non-standard materials without throwing', () => {
    const basic = new THREE.MeshBasicMaterial();
    basic.name = 'colormap';
    expect(() =>
      applySurfaceTreatment('factory', [uvLessBox()], [basic]),
    ).not.toThrow();
    expect(basic.map).toBeNull();
  });
});

describe('surfaceMaterial', () => {
  it('clones (never mutates) the shared library material', () => {
    const shared = SURFACE_MATERIALS['paintedMetal'];
    const m = surfaceMaterial('paintedMetal', {
      color: 0x5c6247,
      flatShading: true,
    });
    expect(m).not.toBe(shared);
    expect(m.map).toBe(shared.map); // texture instance shared
    expect(m.roughnessMap).toBe(shared.roughnessMap);
    expect(m.flatShading).toBe(true);
    expect(m.userData.surfaceCategory).toBe('paintedMetal');
    expect(m.color.getHex()).toBe(0x5c6247);
    // The library entry itself is untouched.
    expect(shared.flatShading).toBe(false);
    expect(shared.userData.surfaceCategory).toBeUndefined();
  });
});

describe('procedural builders wear surfaces', () => {
  const builders: Array<[string, () => { materials: THREE.Material[] }]> = [
    ...PROCEDURAL_KINDS.map(
      (k) => [k, () => buildProceduralModel(k)!] as [string, () => { materials: THREE.Material[] }],
    ),
    ['infantryGear/engineer', () => buildInfantryGear('engineer')],
    ['infantryGear/rifles', () => buildInfantryGear('rifles')],
    ['infantryGear/sniper', () => buildInfantryGear('sniper')],
    ['infantryGear/medic', () => buildInfantryGear('medic')],
    ['radarDishProp', buildRadarDishProp],
    ['hqAntenna', buildHqAntenna],
    ['awacsDome', buildAwacsDome],
    ['shipMast', buildShipMast],
    ['runwayStrip', buildRunwayStrip],
    ['coolingTower', buildCoolingTower],
    ['hospitalCross', buildHospitalCross],
    ['signalMast', buildSignalMast],
  ];

  it('every non-emissive part is tagged with a surface category', () => {
    for (const [name, build] of builders) {
      const model = build();
      expect(model.materials.length, `${name}: no materials`).toBeGreaterThan(0);
      for (const mat of model.materials) {
        const std = mat as THREE.MeshStandardMaterial;
        const tagged =
          typeof std.userData?.surfaceCategory === 'string' &&
          (SURFACE_CATEGORIES as readonly string[]).includes(
            std.userData.surfaceCategory,
          );
        const emissiveAccent =
          std.emissive !== undefined &&
          (std.emissive.r + std.emissive.g + std.emissive.b > 0);
        expect(
          tagged || emissiveAccent,
          `${name}: untagged non-emissive material`,
        ).toBe(true);
      }
    }
  });

  it('shares texture instances across builds (no per-build texture memory)', () => {
    const a = buildProceduralModel('fighter')!;
    const b = buildProceduralModel('fighter')!;
    const am = a.materials[0] as THREE.MeshStandardMaterial;
    const bm = b.materials[0] as THREE.MeshStandardMaterial;
    expect(a.materials[0]).not.toBe(b.materials[0]); // clones…
    expect(am.map).toBe(bm.map); // …sharing one texture
    expect(am.roughnessMap).toBe(bm.roughnessMap);
  });
});

describe('road ribbon UVs', () => {
  const cells = [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 2, z: 0 },
  ];

  it('buildRoadGeometry emits world-scale UVs matching positions', () => {
    const geo = buildRoadGeometry(cells, 4);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    expect(uv).toBeDefined();
    expect(uv.itemSize).toBe(2);
    expect(uv.count).toBe(pos.count);
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(
        pos.getX(i) / ROAD_UV_WORLD_SCALE,
        5,
      );
      expect(uv.getY(i)).toBeCloseTo(
        pos.getZ(i) / ROAD_UV_WORLD_SCALE,
        5,
      );
    }
  });

  it('buildRoadMarkings emits UVs too', () => {
    const geo = buildRoadMarkings(cells, 4);
    const uv = geo.getAttribute('uv');
    expect(uv).toBeDefined();
    expect((uv as THREE.BufferAttribute).count).toBe(
      geo.getAttribute('position').count,
    );
  });
});
