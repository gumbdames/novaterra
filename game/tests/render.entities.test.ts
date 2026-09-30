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
 * Tests for render/entities.ts — the entity view layer.
 *
 * - `modelSourceFor` resolves EVERY UnitKind and BuildingKind to a real
 *   source (`glb` or `procedural`): the game never renders a blank
 *   entity, and unknown kinds degrade to the placeholder.
 * - The 17 procedural gap models are non-empty with sane, finite,
 *   non-degenerate bounds (the warships submarine / frigate / carrier
 *   and the destroyer keep their below-water keels; everything else
 *   stays above y=0).
 * - Empty-model fallback: with NO GLB loaded, syncing every unit kind
 *   and every building kind builds views without throwing (GLB →
 *   procedural → placeholder resolution).
 * - Shared-asset discipline: two views of one kind share geometry and
 *   materials; construction clones materials per view (no cross-talk)
 *   and restores the shared instances on completion.
 * - Roads: syncing road cells adds ribbon + dash meshes; clearing them
 *   removes the meshes.
 *
 * Headless (node env): `document` is stubbed for the health-bar canvas
 * texture; everything else is pure three.js scene graph work.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

import { EntityRenderer, modelSourceFor, isDegradedResolution } from '../src/render/entities';
import type { ResolvedVisual } from '../src/render/entities';
import { buildProceduralModel } from '../src/render/proceduralModels';
import type { LoadedModel } from '../src/render/models';
import { UNIT_DEFS, type UnitKind, type UnitRecord } from '../src/sim/units';
import {
  BUILDING_DEFS,
  cellIndex,
  type BuildingKind,
  type BuildingRecord,
  type RoadCell,
} from '../src/sim/city';
import type { World } from '../src/sim/world';

// ---------------------------------------------------------------------------
// Minimal DOM stub (health-bar CanvasTexture only).
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

// ---------------------------------------------------------------------------
// Fake world.
// ---------------------------------------------------------------------------

let nextId = 1;

function fakeUnit(kind: UnitKind, domain: 'land' | 'air' | 'sea', owner = 0): UnitRecord {
  return {
    id: nextId++,
    kind,
    domain,
    owner,
    x: 10,
    z: 20,
    destX: 10,
    destZ: 20,
    hp: 100,
  } as unknown as UnitRecord;
}

function fakeBuilding(kind: BuildingKind, progress: number, owner = 0): BuildingRecord {
  return {
    id: nextId++,
    kind,
    owner,
    cx: 0,
    cz: 0,
    progress,
  } as unknown as BuildingRecord;
}

function fakeWorld(parts: {
  units?: UnitRecord[];
  buildings?: BuildingRecord[];
  roads?: RoadCell[];
}): World {
  return {
    tick: 0,
    units: parts.units ?? [],
    city: { buildings: parts.buildings ?? [], roads: parts.roads ?? [] },
    superweapons: { fx: [] },
  } as unknown as World;
}

/** Phase 4 (S7): roads carry a class now; test fixtures pave plain cells. */
function paved(cells: number[]): RoadCell[] {
  return cells.map((cell) => ({ cell, cls: 'paved' as const }));
}

/** Find a named child group of the scene (units / buildings / fx). */
function namedGroup(scene: THREE.Scene, name: string): THREE.Group {
  const g = scene.getObjectByName(name);
  expect(g).toBeDefined();
  return g as THREE.Group;
}

/** All Mesh materials under a group (for construction-fade assertions). */
function meshMaterials(root: THREE.Object3D): THREE.Material[] {
  const out: THREE.Material[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material)) {
      out.push(mesh.material as THREE.Material);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// modelSourceFor: mapping completeness.
// ---------------------------------------------------------------------------

describe('modelSourceFor', () => {
  it('resolves every UnitKind to glb or procedural (never placeholder)', () => {
    for (const kind of Object.keys(UNIT_DEFS)) {
      const src = modelSourceFor(kind);
      expect(['glb', 'procedural']).toContain(src.type);
    }
  });

  it('resolves every BuildingKind to glb or procedural (never placeholder)', () => {
    for (const kind of Object.keys(BUILDING_DEFS)) {
      const src = modelSourceFor(kind);
      expect(['glb', 'procedural']).toContain(src.type);
    }
  });

  it('returns placeholder for unknown kinds (never blank, never throws)', () => {
    expect(modelSourceFor('definitely-not-a-kind').type).toBe('placeholder');
  });

  it('composes farm / powerPlant / shipyard / aegisControl from GLB pieces', () => {
    const piecesOf = (kind: string): string[] => {
      const src = modelSourceFor(kind);
      expect(src.type).toBe('glb');
      return src.type === 'glb' ? src.pieces.map((p) => p.key) : [];
    };
    expect(piecesOf('farm')).toEqual(['farmBarn', 'farmSilo']);
    expect(piecesOf('powerPlant')).toEqual(['powerPlantMain', 'powerPlantChimney']);
    expect(piecesOf('shipyard')).toEqual(['shipyardCrane', 'shipyardMachine']);
    expect(piecesOf('aegisControl')).toEqual(['aegisMain']);
  });

  it('composes the roster-expansion buildings from GLB pieces', () => {
    const piecesOf = (kind: string): string[] => {
      const src = modelSourceFor(kind);
      expect(src.type).toBe('glb');
      return src.type === 'glb' ? src.pieces.map((p) => p.key) : [];
    };
    expect(piecesOf('warFactory')).toEqual(['warFactoryMain', 'industrialStack']);
    expect(piecesOf('airfield')).toEqual(['airfieldHangar', 'airfieldHangar2']);
    expect(piecesOf('navalYard')).toEqual(['navalYardCrane', 'navalYardHall']);
    expect(piecesOf('oilRefinery')).toEqual(['oilRefineryTank', 'industrialTank', 'industrialStack']);
    expect(piecesOf('solarFarm')).toEqual(['solarFarmA', 'solarFarmB']);
    expect(piecesOf('desalination')).toEqual(['industrialTank', 'desalinationHall']);
    // 1:1 pieces (nuclearPlant's piece key is nuclearPlantMain).
    expect(piecesOf('nuclearPlant')).toEqual(['nuclearPlantMain']);
    for (const kind of ['barracks', 'radarStation', 'recyclingCenter', 'market', 'hospital', 'university', 'school']) {
      expect(piecesOf(kind)).toEqual([kind]);
    }
    // 1:1 unit pieces.
    for (const kind of ['sniperTeam', 'combatMedic', 'tankDestroyer', 'awacs', 'missileBoat', 'commandShip', 'fishingBoat']) {
      expect(piecesOf(kind)).toEqual([kind]);
    }
  });

  it('marks the 17 gap kinds procedural', () => {
    for (const kind of [
      'artillery', 'aa', 'fighter', 'transport',
      'drone', 'destroyer', 'mediaCenter', 'stormArray',
      // NOVATERRA roster expansion
      'apc', 'mlrs', 'fighterBomber', 'attackHeli',
      'submarine', 'frigate', 'carrier', 'quarry', 'monument',
    ]) {
      expect(modelSourceFor(kind).type).toBe('procedural');
    }
  });
});

// ---------------------------------------------------------------------------
// Procedural gap models: non-empty, sane bounds.
// ---------------------------------------------------------------------------

describe('procedural gap models', () => {
  const gaps = [
    'artillery', 'aa', 'fighter', 'transport',
    'drone', 'destroyer', 'mediaCenter', 'stormArray',
    // NOVATERRA roster expansion
    'apc', 'mlrs', 'fighterBomber', 'attackHeli',
    'submarine', 'frigate', 'carrier', 'quarry', 'monument',
    // Grand-expansion Phase 2 (utilities): the 12 new utility buildings.
    'coalPlant', 'gasPlant', 'windFarm', 'hydroDam',
    'geothermalPlant', 'fusionPlant', 'waterWell', 'waterTower',
    'waterTreatment', 'reservoir', 'powerSubstation', 'pumpingStation',
    'batteryStation',
  ];
  // Warships rest at the waterline (keel below y=0) instead of on the ground.
  const waterlineKinds = new Set(['destroyer', 'submarine', 'frigate', 'carrier']);
  for (const kind of gaps) {
    it(`${kind}: non-empty with finite, non-degenerate bounds`, () => {
      const model = buildProceduralModel(kind);
      expect(model).toBeDefined();
      expect(model?.geometries.length).toBeGreaterThan(0);
      expect(model?.materials.length).toBeGreaterThan(0);
      const box = new THREE.Box3();
      for (const g of model?.geometries ?? []) {
        g.computeBoundingBox();
        expect(g.boundingBox).not.toBeNull();
        box.union(g.boundingBox as THREE.Box3);
      }
      const size = new THREE.Vector3();
      box.getSize(size);
      for (const v of [box.min.x, box.min.y, box.min.z, size.x, size.y, size.z]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(size.x).toBeGreaterThan(0.01);
      expect(size.y).toBeGreaterThan(0.01);
      expect(size.z).toBeGreaterThan(0.01);
      if (waterlineKinds.has(kind)) {
        // Warship: keel below the waterline is intentional.
        expect(box.min.y).toBeLessThan(0);
        expect(box.min.y).toBeGreaterThan(-3);
      } else {
        // Everything else rests on/above the ground.
        expect(box.min.y).toBeGreaterThanOrEqual(-0.01);
      }
    });
  }

  it('returns undefined for non-gap kinds', () => {
    expect(buildProceduralModel('tank')).toBeUndefined();
    expect(buildProceduralModel('house')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty-model fallback: playable with zero GLBs loaded.
// ---------------------------------------------------------------------------

describe('empty-model fallback', () => {
  it('builds a view for every unit kind without throwing', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene); // empty model map
    const domains: Record<string, 'land' | 'air' | 'sea'> = {
      fighter: 'air',
      transport: 'air',
      drone: 'air',
      fighterBomber: 'air',
      attackHeli: 'air',
      awacs: 'air',
      patrolBoat: 'sea',
      destroyer: 'sea',
      transportShip: 'sea',
      missileBoat: 'sea',
      frigate: 'sea',
      submarine: 'sea',
      carrier: 'sea',
      commandShip: 'sea',
      fishingBoat: 'sea',
    };
    const units = (Object.keys(UNIT_DEFS) as UnitKind[]).map((kind) =>
      fakeUnit(kind, domains[kind] ?? 'land'),
    );
    expect(() => renderer.sync(fakeWorld({ units }))).not.toThrow();
    // One view group per unit (plus stripe/pennant/bars inside each).
    expect(namedGroup(scene, 'units').children).toHaveLength(units.length);
    // Movement orientation + health bars survive the fallback path.
    const moving = fakeUnit('tank', 'land');
    moving.destX = 100;
    moving.destZ = 100;
    moving.hp = 10;
    expect(() => renderer.sync(fakeWorld({ units: [moving] }))).not.toThrow();
    renderer.dispose();
  });

  it('builds a view for every building kind without throwing', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene);
    const buildings = (Object.keys(BUILDING_DEFS) as BuildingKind[]).map((kind) =>
      fakeBuilding(kind, 1),
    );
    expect(() => renderer.sync(fakeWorld({ buildings }))).not.toThrow();
    expect(namedGroup(scene, 'buildings').children).toHaveLength(buildings.length);
    renderer.dispose();
  });

  it('mid-construction buildings render faded without throwing', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene);
    const buildings = (Object.keys(BUILDING_DEFS) as BuildingKind[]).map((kind) =>
      fakeBuilding(kind, 0.5),
    );
    expect(() => renderer.sync(fakeWorld({ buildings }))).not.toThrow();
    renderer.dispose();
  });
});

// ---------------------------------------------------------------------------
// Shared-asset discipline.
// ---------------------------------------------------------------------------

function fakeLoadedModel(): LoadedModel {
  return {
    geometries: [new THREE.BoxGeometry(1, 2, 3)],
    materials: [new THREE.MeshStandardMaterial({ color: 0x112233 })],
  };
}

describe('shared assets', () => {
  it('two views of one GLB kind share the loaded geometry and material', () => {
    const scene = new THREE.Scene();
    const model = fakeLoadedModel();
    const renderer = new EntityRenderer(scene, new Map([['tank', model]]));
    renderer.sync(fakeWorld({ units: [fakeUnit('tank', 'land'), fakeUnit('tank', 'land', 1)] }));
    const units = namedGroup(scene, 'units').children;
    expect(units).toHaveLength(2);
    const modelMesh = (unitGroup: THREE.Object3D): THREE.Mesh => {
      // unit group → hull group → model group → piece group → mesh.
      // Traverse: the first Mesh under the hull is the model mesh
      // (stripe/pennant/bars are siblings of the hull, not inside it).
      const hull = unitGroup.children[0] as THREE.Group;
      let found: THREE.Mesh | null = null;
      hull.traverse((o) => {
        if (found === null && (o as THREE.Mesh).isMesh) {
          found = o as THREE.Mesh;
        }
      });
      expect(found).not.toBeNull();
      return found as unknown as THREE.Mesh;
    };
    const a = modelMesh(units[0] as THREE.Group);
    const b = modelMesh(units[1] as THREE.Group);
    expect(a.geometry).toBe(model.geometries[0]);
    expect(b.geometry).toBe(model.geometries[0]);
    expect(a.material).toBe(b.material);
    renderer.dispose();
  });

  it('two views of one procedural kind share geometry and material', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene); // no GLBs: procedural path
    renderer.sync(
      fakeWorld({ units: [fakeUnit('artillery', 'land'), fakeUnit('artillery', 'land', 1)] }),
    );
    const units = namedGroup(scene, 'units').children;
    expect(units).toHaveLength(2);
    const modelGeos = (unitGroup: THREE.Object3D): THREE.BufferGeometry[] => {
      const out: THREE.BufferGeometry[] = [];
      (unitGroup.children[0] as THREE.Group).traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) out.push(mesh.geometry);
      });
      return out;
    };
    const a = modelGeos(units[0] as THREE.Group);
    const b = modelGeos(units[1] as THREE.Group);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
    renderer.dispose();
  });

  it('construction clones materials per view and restores shared on completion', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene);
    const a = fakeBuilding('house', 0.5);
    const b = fakeBuilding('house', 1);
    renderer.sync(fakeWorld({ buildings: [a, b] }));
    const groups = namedGroup(scene, 'buildings').children as THREE.Group[];
    expect(groups).toHaveLength(2);
    // Model meshes = all meshes except the trailing team pennant.
    const modelMats = (g: THREE.Group): THREE.Material[] => meshMaterials(g).slice(0, -1);
    const matsA = modelMats(groups[0] as THREE.Group);
    const matsB = modelMats(groups[1] as THREE.Group);
    expect(matsA.length).toBeGreaterThan(0);
    expect(matsA.length).toBe(matsB.length);
    // Under construction: per-view transparent clones, no cross-talk.
    for (let i = 0; i < matsA.length; i++) {
      expect(matsA[i]).not.toBe(matsB[i]);
      expect(matsA[i]?.transparent).toBe(true);
      expect(matsB[i]?.transparent).not.toBe(true);
    }
    // Complete construction: both views share the SAME material instances.
    a.progress = 1;
    renderer.sync(fakeWorld({ buildings: [a, b] }));
    const matsA2 = modelMats(groups[0] as THREE.Group);
    const matsB2 = modelMats(groups[1] as THREE.Group);
    expect(matsA2.length).toBe(matsB2.length);
    for (let i = 0; i < matsA2.length; i++) {
      expect(matsA2[i]).toBe(matsB2[i]);
      expect(matsA2[i]?.transparent).not.toBe(true);
    }
    renderer.dispose();
  });
});

// ---------------------------------------------------------------------------
// Roads through the renderer.
// ---------------------------------------------------------------------------

describe('roads', () => {
  it('syncing road cells adds ribbon + dash meshes; clearing removes them', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene);
    const roads = [cellIndex(0, 0), cellIndex(1, 0), cellIndex(2, 0)];
    renderer.sync(fakeWorld({ roads: paved(roads) }));
    const buildings = namedGroup(scene, 'buildings');
    // Ribbon + one dash mesh (middle cell is straight-through).
    expect(buildings.children).toHaveLength(2);
    renderer.sync(fakeWorld({ roads: [] }));
    expect(buildings.children).toHaveLength(0);
    renderer.dispose();
  });

  it('an isolated road cell adds a ribbon but no dash mesh', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene);
    renderer.sync(fakeWorld({ roads: paved([cellIndex(5, 5)]) }));
    expect(namedGroup(scene, 'buildings').children).toHaveLength(1);
    renderer.dispose();
  });
});

// ---------------------------------------------------------------------------
// Lazy-load arrival upgrade: a view created while its kind's GLB pieces
// are still loading renders fallback art, then swaps to the real model in
// place once the pieces land (render-side only — the sim never sees it).
// ---------------------------------------------------------------------------

/** First mesh under a view group, in traversal order (the model body). */
function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (found === null && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

function resolvedWith(pools: string[]): ResolvedVisual {
  return {
    pieces: pools.map((pool) => ({
      pool,
      model: fakeLoadedModel(),
      dx: 0,
      dy: 0,
      dz: 0,
    })),
    top: 1,
    // Phase 4 (transport): the size-tier scale (1 = authored size).
    scale: 1,
  };
}

describe('isDegradedResolution', () => {
  it('procedural kinds are never degraded (nothing to wait for)', () => {
    expect(modelSourceFor('artillery').type).toBe('procedural');
    expect(isDegradedResolution('artillery', null)).toBe(false);
    expect(isDegradedResolution('artillery', resolvedWith([]))).toBe(false);
  });

  it('a glb kind with no resolution is degraded', () => {
    expect(modelSourceFor('tank').type).toBe('glb');
    expect(isDegradedResolution('tank', null)).toBe(true);
  });

  it('a glb kind with only fallback pieces is degraded', () => {
    expect(isDegradedResolution('tank', resolvedWith(['procedural:tank']))).toBe(true);
    expect(isDegradedResolution('tank', resolvedWith(['prop:hqAntenna']))).toBe(true);
  });

  it('a glb kind with all of its pieces resolved is whole', () => {
    expect(isDegradedResolution('tank', resolvedWith(['tank']))).toBe(false);
  });

  it('a partially resolved composite stays degraded until every piece lands', () => {
    const source = modelSourceFor('warFactory');
    if (source.type !== 'glb') throw new Error('warFactory must be glb-mapped');
    const keys = source.pieces.map((p) => p.key);
    expect(keys.length).toBeGreaterThan(1);
    const first = keys[0] as string;
    expect(isDegradedResolution('warFactory', resolvedWith([first]))).toBe(true);
    expect(isDegradedResolution('warFactory', resolvedWith(keys))).toBe(false);
  });
});

describe('lazy-load arrival upgrade', () => {
  it('a legacy unit swaps placeholder art for the real model when the GLB arrives', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>();
    const renderer = new EntityRenderer(scene, models);
    const unit = fakeUnit('tank', 'land');
    renderer.sync(fakeWorld({ units: [unit] }));
    const group = namedGroup(scene, 'units').children[0] as THREE.Group;
    const before = firstMesh(group);
    expect(before).not.toBeNull();

    // The lazy load finishes: the same map the renderer borrows gains the key.
    const model = fakeLoadedModel();
    models.set('tank', model);
    renderer.sync(fakeWorld({ units: [unit] }));

    const after = firstMesh(group);
    expect(after).not.toBeNull();
    expect(after!.geometry).toBe(model.geometries[0]);
    expect(after!.geometry).not.toBe(before!.geometry);
    // The view group itself is stable: same object, still tracked.
    expect(namedGroup(scene, 'units').children[0]).toBe(group);
    renderer.dispose();
  });

  it('a unit that is still waiting keeps fallback art without throwing', () => {
    const scene = new THREE.Scene();
    const renderer = new EntityRenderer(scene, new Map());
    const unit = fakeUnit('tank', 'land');
    renderer.sync(fakeWorld({ units: [unit] }));
    const group = namedGroup(scene, 'units').children[0] as THREE.Group;
    const before = firstMesh(group);
    expect(before).not.toBeNull();
    // Still loading (or failed): repeated syncs must not throw or swap.
    expect(() => {
      renderer.sync(fakeWorld({ units: [unit] }));
      renderer.sync(fakeWorld({ units: [unit] }));
    }).not.toThrow();
    expect(firstMesh(group)).toBe(before);
    renderer.dispose();
  });

  it('an instanced unit claims instance slots when the GLB arrives', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>();
    const renderer = new EntityRenderer(scene, models, { instanced: true });
    const instancer = renderer.debugInstancer;
    expect(instancer).not.toBeNull();
    const unit = fakeUnit('tank', 'land');
    renderer.sync(fakeWorld({ units: [unit] }));
    // No resolvable model yet: legacy fallback view, no instance slots.
    expect(instancer!.entityCount).toBe(0);

    models.set('tank', fakeLoadedModel());
    renderer.sync(fakeWorld({ units: [unit] }));
    expect(instancer!.entityCount).toBe(1);
    renderer.dispose();
  });

  it('a legacy building swaps fallback art for the real model when the GLB arrives', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>();
    const renderer = new EntityRenderer(scene, models);
    const building = fakeBuilding('house', 1);
    renderer.sync(fakeWorld({ buildings: [building] }));
    const group = namedGroup(scene, 'buildings').children[0] as THREE.Group;
    const before = firstMesh(group);
    expect(before).not.toBeNull();

    const model = fakeLoadedModel();
    models.set('house', model);
    renderer.sync(fakeWorld({ buildings: [building] }));

    const after = firstMesh(group);
    expect(after).not.toBeNull();
    expect(after!.geometry).toBe(model.geometries[0]);
    expect(after!.geometry).not.toBe(before!.geometry);
    renderer.dispose();
  });

  it('a mid-construction building keeps its fade through the upgrade', () => {
    const scene = new THREE.Scene();
    const models = new Map<string, LoadedModel>();
    const renderer = new EntityRenderer(scene, models);
    const building = fakeBuilding('house', 0.5);
    renderer.sync(fakeWorld({ buildings: [building] }));
    const group = namedGroup(scene, 'buildings').children[0] as THREE.Group;

    models.set('house', fakeLoadedModel());
    renderer.sync(fakeWorld({ buildings: [building] }));

    // The model body (first mesh) renders the real model, still faded.
    const body = firstMesh(group);
    expect(body).not.toBeNull();
    expect(body!.geometry).toBe(models.get('house')!.geometries[0]);
    const mat = body!.material as THREE.Material;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeLessThan(1);
    renderer.dispose();
  });
});
