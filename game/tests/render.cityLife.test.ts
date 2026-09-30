/**
 * Workstream P (ambient city life, 2026-09-30) — tests for
 * `game/src/render/cityLife.ts`.
 *
 * Covers: the deterministic integer hash; zone auto-paving geometry
 * (count, facing, terrain drape, texture tiling) and the PavingOverlay
 * digest/rebuild contract; population-driven density scaling (incl.
 * the zero-population case); the ambient agent model (zone-biased home
 * tiles, direction-biased targets, road-bound cars, determinism);
 * pose purity (pure functions of (seed, index, tick)); the hard
 * render-only rule — syncing the ambient crowd must not change the
 * world's digest, snapshot, or entity/building counts; and the
 * Phase 4–6 transit hooks (density scaling + provider registry).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { createWorld, type World } from '../src/sim/world';
import { PERSON_MODEL_KEYS } from '../src/render/people';
import type { LoadedModel } from '../src/render/models';
import { cellIndex, ZoneType, type BuildingKind, type BuildingRecord } from '../src/sim/city';
import { BUILDING_DEFS } from '../src/sim/city';
import { digestWorld } from '../src/sim/digest';
import {
  ambientHash,
  PAVING_TERRAIN_OFFSET,
  PAVING_OPACITY,
  buildPavingGeometry,
  PavingOverlay,
  ambientCityPopulation,
  MAX_AMBIENT_PEDESTRIANS,
  MAX_AMBIENT_CARS,
  PEDS_PER_PERSON,
  CARS_PER_PERSON,
  ambientPedestrianCount,
  ambientCarCount,
  buildAmbientModel,
  pedPoseAt,
  carPoseAt,
  ambientModelDigest,
  ambientTransitDensity,
  MAX_AMBIENT_BUS,
  MAX_AMBIENT_TRAM,
  MAX_AMBIENT_FERRY,
  MAX_AMBIENT_AIRLINER,
  MAX_AMBIENT_CARGOSHIP,
  registerAmbientTransitProvider,
  unregisterAmbientTransitProvider,
  ambientTransitProviderTypes,
  AmbientCrowd,
  type PedAgent,
  type CarAgent,
} from '../src/render/cityLife';

// ---------------------------------------------------------------------------
// Helpers: a small city with zones, completed houses, and a road.
// ---------------------------------------------------------------------------

const SEED = 424242;

let nextBuildingId = 1000;

function makeBuilding(kind: BuildingKind, cx: number, cz: number, progress = 1): BuildingRecord {
  return {
    id: nextBuildingId++,
    kind,
    owner: 0,
    cx,
    cz,
    facing: 0,
    progress,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  };
}

/** A world with a 6×6 residential zone, houses, a commercial corner, and one road. */
function makeCityWorld(): World {
  const world = createWorld(SEED);
  const city = world.city;
  for (let cx = 10; cx < 16; cx++) {
    for (let cz = 10; cz < 16; cz++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.RESIDENTIAL });
    }
  }
  city.zones.push({ cell: cellIndex(20, 10), zone: ZoneType.COMMERCIAL });
  city.zones.push({ cell: cellIndex(21, 10), zone: ZoneType.COMMERCIAL });
  city.zones.push({ cell: cellIndex(20, 11), zone: ZoneType.COMMERCIAL });
  // Two completed houses (6 people each) + one apartment (30 people).
  city.buildings.push(makeBuilding('house', 11, 11));
  city.buildings.push(makeBuilding('house', 13, 13));
  city.buildings.push(makeBuilding('apartment', 14, 12));
  // A straight road so cars have something to drive on.
  for (let cx = 8; cx < 24; cx++) city.roads.push({ cell: cellIndex(cx, 16), cls: 'paved' });
  city.roads.sort((a, b) => a.cell - b.cell);
  return world;
}

// ---------------------------------------------------------------------------
// The deterministic hash
// ---------------------------------------------------------------------------

describe('ambientHash', () => {
  it('is deterministic and stays in [0, 1)', () => {
    const a = ambientHash(123, 7, 42);
    expect(a).toBe(ambientHash(123, 7, 42));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('varies across seed / index / salt', () => {
    const samples = new Set<number>();
    for (let i = 0; i < 100; i++) samples.add(ambientHash(SEED, i, 7));
    // Not a proof of uniformity — just guards a degenerate constant hash.
    expect(samples.size).toBeGreaterThan(90);
  });
});

// ---------------------------------------------------------------------------
// Auto-paving
// ---------------------------------------------------------------------------

describe('buildPavingGeometry', () => {
  const zonesOf = (...cells: number[]) =>
    cells.map((cell) => ({ cell, zone: ZoneType.RESIDENTIAL }));

  it('emits one up-facing quad per zone cell, draped on the height fn', () => {
    const geo = buildPavingGeometry(
      zonesOf(cellIndex(4, 5), cellIndex(9, 2)),
      (x, z) => x + z, // sloped terrain
    );
    expect(geo).not.toBeNull();
    const g = geo!;
    expect(g.getAttribute('position').count).toBe(8);
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    // Every vertex sits on terrain + offset; every normal points up;
    // UVs tile with the world scale (no 0..1-per-quad stretch).
    const heights: number[] = [];
    for (let i = 0; i < 8; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      heights.push(x + z);
      // World coords are large (~±500) and positions are float32, so the
      // comparison stays at single-precision honesty (4 digits).
      expect(pos.getY(i)).toBeCloseTo(x + z + PAVING_TERRAIN_OFFSET, 4);
      expect(norm.getY(i)).toBe(1);
      expect(norm.getX(i)).toBe(0);
      expect(norm.getZ(i)).toBe(0);
      expect(uv.getX(i)).toBeCloseTo(x * 0.25, 4);
      expect(uv.getY(i)).toBeCloseTo(z * 0.25, 4);
    }
    // Two distinct quads, not one collapsed pad: the first vertex of
    // each quad sits on a different cell.
    const xFirst = [pos.getX(0), pos.getX(4)] as const;
    expect(Math.abs((xFirst[0] as number) - (xFirst[1] as number))).toBeGreaterThan(0);
    g.dispose();
  });

  it('returns null for an empty cell list', () => {
    expect(buildPavingGeometry([], () => 0)).toBeNull();
  });

  it('is deterministic: same cells ⇒ identical bytes', () => {
    const zones = zonesOf(cellIndex(1, 2), cellIndex(3, 4), cellIndex(5, 6));
    const a = buildPavingGeometry(zones, () => 0.5)!;
    const b = buildPavingGeometry(zones, () => 0.5)!;
    expect(Array.from(a.getAttribute('position').array)).toEqual(
      Array.from(b.getAttribute('position').array),
    );
    a.dispose();
    b.dispose();
  });

  it('emits quads in sorted order (stable draw regardless of input order)', () => {
    const zones = zonesOf(cellIndex(9, 9), cellIndex(1, 1), cellIndex(5, 5));
    const a = buildPavingGeometry(zones, () => 0)!;
    const b = buildPavingGeometry([...zones].reverse(), () => 0)!;
    expect(Array.from(a.getAttribute('position').array)).toEqual(
      Array.from(b.getAttribute('position').array),
    );
    a.dispose();
    b.dispose();
  });
});

describe('PavingOverlay', () => {
  let overlay: PavingOverlay | null = null;

  afterEach(() => {
    overlay?.dispose();
    overlay = null;
  });

  function make(): PavingOverlay {
    const scene = new THREE.Scene();
    overlay = new PavingOverlay(scene);
    return overlay;
  }

  it('draws 0 calls with no zones and 1 with zones, at renderOrder 2', () => {
    const o = make();
    o.sync([], () => 0);
    expect(o.drawCallCount()).toBe(0);
    const world = makeCityWorld();
    o.sync(world.city.zones, () => 0);
    expect(o.drawCallCount()).toBe(1);
  });

  it('rebuilds only when the zone digest changes', () => {
    const o = make();
    const world = makeCityWorld();
    o.sync(world.city.zones, () => 0);
    expect(o.debugRebuildCount()).toBe(1);
    o.sync(world.city.zones, () => 0);
    o.sync([...world.city.zones].reverse(), () => 0); // order-insensitive
    expect(o.debugRebuildCount()).toBe(1);
    world.city.zones.push({ cell: cellIndex(30, 30), zone: ZoneType.INDUSTRIAL });
    o.sync(world.city.zones, () => 0);
    expect(o.debugRebuildCount()).toBe(2);
  });

  it('the material is translucent at the documented opacity, polygon-offset', () => {
    const o = make();
    o.sync(makeCityWorld().city.zones, () => 0);
    const mat = o.materialForTests();
    expect(mat).not.toBeNull();
    expect(mat!.transparent).toBe(true);
    expect(mat!.opacity).toBeCloseTo(PAVING_OPACITY, 10);
    expect(mat!.polygonOffset).toBe(true);
  });

  it('dispose is idempotent and leaves 0 draw calls', () => {
    const o = make();
    o.sync(makeCityWorld().city.zones, () => 0);
    o.dispose();
    expect(o.drawCallCount()).toBe(0);
    expect(() => o.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Density scaling
// ---------------------------------------------------------------------------

describe('density scaling', () => {
  it('ambientCityPopulation sums only completed residential buildings', () => {
    const world = makeCityWorld();
    // house 6 + house 6 + apartment 30 = 42.
    expect(BUILDING_DEFS.house.population).toBe(6);
    expect(BUILDING_DEFS.apartment.population).toBe(30);
    expect(ambientCityPopulation(world)).toBe(42);
    // An under-construction house contributes nothing.
    world.city.buildings.push(makeBuilding('house', 12, 12, 0.5));
    expect(ambientCityPopulation(world)).toBe(42);
    // A commercial building contributes nothing.
    world.city.buildings.push(makeBuilding('market', 20, 10));
    expect(ambientCityPopulation(world)).toBe(42);
  });

  it('zero population ⇒ zero agents', () => {
    expect(ambientPedestrianCount(0)).toBe(0);
    expect(ambientCarCount(0)).toBe(0);
    const world = createWorld(SEED);
    expect(ambientCityPopulation(world)).toBe(0);
    const model = buildAmbientModel([], [], world.seed, 0);
    expect(model.peds).toHaveLength(0);
    expect(model.cars).toHaveLength(0);
  });

  it('scales linearly then clamps at the caps', () => {
    expect(ambientPedestrianCount(120)).toBe(Math.floor(120 / PEDS_PER_PERSON));
    expect(ambientCarCount(120)).toBe(Math.floor(120 / CARS_PER_PERSON));
    expect(ambientPedestrianCount(1_000_000)).toBe(MAX_AMBIENT_PEDESTRIANS);
    expect(ambientCarCount(1_000_000)).toBe(MAX_AMBIENT_CARS);
  });
});

// ---------------------------------------------------------------------------
// The ambient agent model
// ---------------------------------------------------------------------------

describe('buildAmbientModel', () => {
  it('peds live on zoned tiles, weighted toward residential', () => {
    const world = makeCityWorld();
    const pop = ambientCityPopulation(world); // 42
    const model = buildAmbientModel(world.city.zones, world.city.roads, world.seed, pop);
    expect(model.peds).toHaveLength(ambientPedestrianCount(pop));
    const zoneByCell = new Map(world.city.zones.map((z) => [z.cell, z.zone]));
    let residential = 0;
    for (const ped of model.peds) {
      const zone = zoneByCell.get(ped.cell);
      // Every walker has a zoned home tile (residential/commercial/
      // industrial are all walkable; the 3/2/1 weighting favors homes).
      expect(zone).toBeDefined();
      if (zone === ZoneType.RESIDENTIAL) residential += 1;
    }
    // Residential weight 3 vs commercial 2 + industrial 1 ⇒ most homes
    // are residential (this city has 36 residential + 3 commercial cells).
    expect(residential).toBeGreaterThan(model.peds.length / 2);
  });

  it('no roads ⇒ no cars; roads ⇒ cars drive along a segment', () => {
    const world = makeCityWorld();
    const pop = ambientCityPopulation(world);
    const withRoads = buildAmbientModel(world.city.zones, world.city.roads, world.seed, pop);
    expect(withRoads.cars.length).toBe(ambientCarCount(pop));
    const noRoads = buildAmbientModel(world.city.zones, [], world.seed, pop);
    expect(noRoads.cars).toHaveLength(0);
    for (const car of withRoads.cars) {
      expect(car.dist).toBeGreaterThan(0);
      expect(car.speed).toBeGreaterThan(0);
    }
  });

  it('direction bias: residential peds target commercial tiles when nearby', () => {
    const world = createWorld(SEED);
    // A residential block with a commercial block inside the 30-cell
    // target radius. Every home is residential, so every walker should
    // pick a commercial target (the direction bias).
    for (let cx = 48; cx <= 52; cx++) {
      for (let cz = 48; cz <= 52; cz++) {
        world.city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.RESIDENTIAL });
      }
    }
    for (let cx = 54; cx <= 56; cx++) {
      for (let cz = 54; cz <= 56; cz++) {
        world.city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.COMMERCIAL });
      }
    }
    world.city.buildings.push(makeBuilding('apartment', 50, 50)); // 30 people
    const pop = ambientCityPopulation(world);
    expect(pop).toBe(30);
    const model = buildAmbientModel(world.city.zones, [], world.seed, pop);
    expect(model.peds.length).toBeGreaterThan(0);
    const commCells = new Set(
      world.city.zones.filter((z) => z.zone === ZoneType.COMMERCIAL).map((z) => z.cell),
    );
    for (const ped of model.peds) {
      expect(commCells.has(ped.targetCell)).toBe(true);
    }
  });

  it('is deterministic: same seed ⇒ identical model', () => {
    const world = makeCityWorld();
    const pop = ambientCityPopulation(world);
    const a = buildAmbientModel(world.city.zones, world.city.roads, world.seed, pop);
    const b = buildAmbientModel(world.city.zones, world.city.roads, world.seed, pop);
    expect(a).toEqual(b);
    const c = buildAmbientModel(world.city.zones, world.city.roads, world.seed + 1, pop);
    expect(c.peds[0]).not.toEqual(a.peds[0]);
  });

  it('digest keys on zones + roads + completed ids + seed', () => {
    const world = makeCityWorld();
    const ids = world.city.buildings.map((b) => b.id);
    const d0 = ambientModelDigest(world.city.zones, world.city.roads, ids, world.seed);
    expect(ambientModelDigest(world.city.zones, world.city.roads, ids, world.seed)).toBe(d0);
    expect(ambientModelDigest(world.city.zones, world.city.roads, ids, world.seed + 1)).not.toBe(d0);
    expect(ambientModelDigest([], world.city.roads, ids, world.seed)).not.toBe(d0);
    expect(ambientModelDigest(world.city.zones, [], ids, world.seed)).not.toBe(d0);
    expect(ambientModelDigest(world.city.zones, world.city.roads, [999999], world.seed)).not.toBe(d0);
  });
});

// ---------------------------------------------------------------------------
// Pose purity (no per-agent state)
// ---------------------------------------------------------------------------

describe('pose purity', () => {
  it('pedPoseAt: pure in tick, moves along the track, ping-pongs', () => {
    const world = makeCityWorld();
    const pop = ambientCityPopulation(world);
    const model = buildAmbientModel(world.city.zones, world.city.roads, world.seed, pop);
    const ped = model.peds[0] as PedAgent;
    const t0 = pedPoseAt(ped, 0);
    const t1 = pedPoseAt(ped, 0);
    expect(t1).toEqual(t0); // pure — no hidden state
    const t10 = pedPoseAt(ped, 10);
    expect(t10.x === t0.x && t10.z === t0.z).toBe(false); // it walks
    // Same tick ⇒ same pose across independent model rebuilds.
    const model2 = buildAmbientModel(world.city.zones, world.city.roads, world.seed, pop);
    expect(pedPoseAt(model2.peds[0] as PedAgent, 10)).toEqual(t10);
  });

  it('carPoseAt: moves along the segment and reverses at the ends', () => {
    // A synthetic agent with exact math: 10 world units at 1 unit/tick,
    // no phase offset — the turnaround is exact at ticks 10 and 20.
    const car: CarAgent = {
      ax: 0, az: 0, dirX: 1, dirZ: 0, dist: 10, phase: 0, speed: 1, paint: 0,
    };
    expect(carPoseAt(car, 0)).toEqual({ x: 0, z: 0, yaw: Math.PI / 2 });
    const mid = carPoseAt(car, 5);
    expect(mid.x).toBeCloseTo(5, 10);
    const turn = carPoseAt(car, 10);
    expect(turn.x).toBeCloseTo(10, 10);
    const back = carPoseAt(car, 15);
    expect(back.x).toBeCloseTo(5, 10);
    expect(back.yaw).toBeCloseTo(-Math.PI / 2, 10); // yaw flips on return
    const home = carPoseAt(car, 20);
    expect(home.x).toBeCloseTo(0, 10);
    expect(home.yaw).toBeCloseTo(Math.PI / 2, 10);
    // Purity: same tick ⇒ same pose, forever.
    expect(carPoseAt(car, 10)).toEqual(turn);
  });
});

// One ambient crowd at a time: shared across the crowd tests so the
// layer owns its scene membership exactly once per test.
let crowd: AmbientCrowd | null = null;
afterEach(() => {
  crowd?.dispose();
  crowd = null;
});

// ---------------------------------------------------------------------------
// The hard rule: ambient is render-side only — the sim must not notice.
// ---------------------------------------------------------------------------

describe('AmbientCrowd — no sim leakage', () => {

  it('sync never mutates sim state: digest, buildings, units unchanged', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    const digestBefore = digestWorld(world);
    const buildingsBefore = world.city.buildings.length;
    const unitsBefore = world.units.length;
    // Multiple syncs at different ticks, including a zone change and a
    // model rebuild. The tick itself is digested, so it stays fixed —
    // the point is the crowd writes nothing back.
    crowd.sync(world, () => 0);
    crowd.sync(world, () => 0);
    world.city.zones.push({ cell: cellIndex(40, 40), zone: ZoneType.INDUSTRIAL });
    crowd.sync(world, () => 0);
    expect(world.city.buildings.length).toBe(buildingsBefore);
    expect(world.units.length).toBe(unitsBefore);
    // Restore the zone list, then the digest must match exactly.
    world.city.zones.pop();
    crowd.sync(world, () => 0);
    expect(digestWorld(world)).toBe(digestBefore);
  });

  it('rebuilt crowds produce identical poses to fresh ones (zero state)', () => {
    const world = makeCityWorld();
    const pop = ambientCityPopulation(world);
    const model = buildAmbientModel(world.city.zones, world.city.roads, world.seed, pop);
    const p0 = pedPoseAt(model.peds[0] as PedAgent, 25);
    // Force a rebuild through the crowd by changing zones.
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    crowd.sync(world, () => 0);
    world.city.zones.push({ cell: cellIndex(41, 41), zone: ZoneType.RESIDENTIAL });
    world.tick = 25;
    crowd.sync(world, () => 0);
    // Rebuild the same model independently and compare.
    const model2 = buildAmbientModel(world.city.zones.slice(0, -1), world.city.roads, world.seed, pop);
    expect(pedPoseAt(model2.peds[0] as PedAgent, 25)).toEqual(p0);
  });

  it('crowd is inert for an empty city: 0 agents, 0 draw calls', () => {
    const world = createWorld(SEED);
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    crowd.sync(world, () => 0);
    expect(crowd.debugAgentCounts()).toEqual({ peds: 0, cars: 0 });
    expect(crowd.drawCallCount()).toBe(0);
  });

  it('draw calls scale with content, capped by construction', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    crowd.sync(world, () => 0);
    const { peds, cars } = crowd.debugAgentCounts();
    expect(peds).toBeGreaterThan(0);
    expect(cars).toBeGreaterThan(0);
    expect(crowd.drawCallCount()).toBe(2); // peds + cars
  });

  it('perf: full-size model (500 peds + 150 cars) syncs with headroom', () => {
    const world = createWorld(SEED);
    // A big residential zone so the caps bind (500/150 ⇒ pop ≥ 6000).
    for (let cx = 0; cx < 100; cx++) {
      for (let cz = 0; cz < 40; cz++) {
        world.city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.RESIDENTIAL });
      }
    }
    for (let i = 0; i < 200; i++) {
      world.city.buildings.push(makeBuilding('apartment', i % 100, (i * 7) % 40));
    }
    for (let cx = 0; cx < 120; cx++) world.city.roads.push({ cell: cellIndex(cx, 45), cls: 'paved' });
    world.city.roads.sort((a, b) => a.cell - b.cell);
    const pop = ambientCityPopulation(world);
    expect(pop).toBe(6000);
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    crowd.sync(world, () => 0); // one rebuild + one instance write
    expect(crowd.debugAgentCounts()).toEqual({
      peds: MAX_AMBIENT_PEDESTRIANS,
      cars: MAX_AMBIENT_CARS,
    });
    // 120 frames of pure per-frame writes (no rebuilds), timed.
    const t0 = performance.now();
    for (let tick = 1; tick <= 120; tick++) {
      world.tick = tick;
      crowd.sync(world, () => 0);
    }
    const elapsed = performance.now() - t0;
    const perFrame = elapsed / 120;
    // Recorded, not flaky-pinned: 120 frames of the worst case must stay
    // well under a 60fps frame (16.6ms) on this VM.
    expect(perFrame).toBeLessThan(16.6);
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Transit hooks (Phase 4–6 wiring surface)
// ---------------------------------------------------------------------------

describe('ambient transit hooks', () => {
  afterEach(() => {
    for (const t of ambientTransitProviderTypes()) unregisterAmbientTransitProvider(t);
  });

  it('density pins: more people ⇒ more transit, in the documented order', () => {
    const empty = ambientTransitDensity(0);
    expect(empty).toEqual({ bus: 0, tram: 0, ferry: 0, airliner: 0, cargoShip: 0 });
    const town = ambientTransitDensity(3000);
    // Grand-expansion Phase 6 workstream C (2026-09-30): cargo ships
    // trail last — 1 per 800 residents (3000 → 3).
    expect(town).toEqual({ bus: 20, tram: 7, ferry: 5, airliner: 1, cargoShip: 3 });
    const metro = ambientTransitDensity(1_000_000);
    expect(metro).toEqual({
      bus: MAX_AMBIENT_BUS,
      tram: MAX_AMBIENT_TRAM,
      ferry: MAX_AMBIENT_FERRY,
      airliner: MAX_AMBIENT_AIRLINER,
      cargoShip: MAX_AMBIENT_CARGOSHIP,
    });
  });

  it('provider registry round-trip; re-register replaces', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial();
    const p1 = {
      geometry: geo,
      material: mat,
      count: 3,
      poseAt: (i: number, tick: number) => ({ x: i, y: 0, z: tick, yaw: 0 }),
    };
    registerAmbientTransitProvider('bus', p1);
    expect(ambientTransitProviderTypes()).toEqual(['bus']);
    registerAmbientTransitProvider('bus', { ...p1, count: 5 });
    expect(ambientTransitProviderTypes()).toEqual(['bus']);
    unregisterAmbientTransitProvider('bus');
    expect(ambientTransitProviderTypes()).toEqual([]);
    geo.dispose();
    mat.dispose();
  });

  it('a registered provider renders instances driven by the tick', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    crowd.sync(world, () => 0);
    const before = crowd.drawCallCount();
    const geo = new THREE.BoxGeometry(2, 1, 4);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const poses: number[] = [];
    registerAmbientTransitProvider('bus', {
      geometry: geo,
      material: mat,
      count: 2,
      poseAt: (i: number, tick: number) => {
        poses.push(tick);
        return { x: i * 10, y: 1, z: tick, yaw: i };
      },
    });
    world.tick = 5;
    crowd.sync(world, () => 0);
    expect(crowd.drawCallCount()).toBe(before + 1);
    expect(poses).toContain(5);
    // Unregistering removes the layer next sync; the provider's own
    // geometry/material are NOT disposed by the crowd.
    const disposed = vi.fn();
    geo.dispose = disposed as () => void;
    unregisterAmbientTransitProvider('bus');
    crowd.sync(world, () => 0);
    expect(crowd.drawCallCount()).toBe(before);
    expect(disposed).not.toHaveBeenCalled();
    geo.dispose = (() => undefined) as () => void;
    mat.dispose();
  });

  it('a null pose hides the vehicle (count: 0 hides the layer)', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial();
    registerAmbientTransitProvider('tram', {
      geometry: geo,
      material: mat,
      count: 2,
      poseAt: () => null,
    });
    crowd.sync(world, () => 0);
    // count>0 ⇒ a draw call for the layer (instances hidden via zero matrix).
    expect(crowd.drawCallCount()).toBe(3); // peds + cars + tram layer
    registerAmbientTransitProvider('tram', {
      geometry: geo,
      material: mat,
      count: 0,
      poseAt: () => null,
    });
    crowd.sync(world, () => 0);
    expect(crowd.drawCallCount()).toBe(2);
    geo.dispose();
    mat.dispose();
  });
});

// ---------------------------------------------------------------------------
// Civilian person models (Phase 4 RENDER workstream A, item 4): the crowd
// upgrades pedestrians from capsules to the four Quaternius variants once
// their GLBs lazy-load through the models map.
// ---------------------------------------------------------------------------

describe('AmbientCrowd — civilian person models', () => {
  /** One mock person variant: two colored boxes, base at y=0. */
  function mockPerson(color: number): LoadedModel {
    const torso = new THREE.BoxGeometry(0.4, 0.9, 0.25);
    torso.translate(0, 0.45, 0);
    return {
      geometries: [torso],
      materials: [new THREE.MeshStandardMaterial({ color })],
    };
  }

  function fullPersonMap(): Map<string, LoadedModel> {
    const map = new Map();
    PERSON_MODEL_KEYS.forEach((key, i) => map.set(key, mockPerson([0xc8a080, 0x804020, 0x406080, 0x908070][i] as number)));
    return map;
  }

  it('builds four person layers when all person keys are present', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene, fullPersonMap());
    crowd.sync(world, () => 0);
    expect(crowd.debugPersonLayers()).toBe(4);
    // 4 person layers + the car layer (makeCityWorld has roads ⇒ cars).
    expect(crowd.drawCallCount()).toBe(5);
  });

  it('keeps the capsule fallback when no models map is passed', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene);
    crowd.sync(world, () => 0);
    expect(crowd.debugPersonLayers()).toBe(0);
    expect(crowd.drawCallCount()).toBe(2); // capsule peds + cars
  });

  it('keeps the capsule fallback when only some person keys loaded', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    const map = fullPersonMap();
    map.delete(PERSON_MODEL_KEYS[2]);
    crowd = new AmbientCrowd(scene, map);
    crowd.sync(world, () => 0);
    expect(crowd.debugPersonLayers()).toBe(0);
    expect(crowd.drawCallCount()).toBe(2);
  });

  it('keeps the capsule fallback when a variant fails to build', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    const map = fullPersonMap();
    map.set(PERSON_MODEL_KEYS[0], { geometries: [], materials: [] });
    crowd = new AmbientCrowd(scene, map);
    crowd.sync(world, () => 0);
    expect(crowd.debugPersonLayers()).toBe(0);
  });

  it('person layers are stable across syncs (built once)', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    crowd = new AmbientCrowd(scene, fullPersonMap());
    crowd.sync(world, () => 0);
    const before = crowd.debugRebuildCount();
    crowd.sync(world, () => 0);
    crowd.sync(world, () => 0);
    expect(crowd.debugPersonLayers()).toBe(4);
    expect(crowd.debugRebuildCount()).toBe(before); // no model churn
  });

  it('late-arriving models upgrade a capsule crowd in place', () => {
    const world = makeCityWorld();
    const scene = new THREE.Scene();
    const map = new Map<string, LoadedModel>();
    crowd = new AmbientCrowd(scene, map);
    crowd.sync(world, () => 0);
    expect(crowd.debugPersonLayers()).toBe(0);
    // The lazy store delivers the models later — next sync picks them up.
    for (const [k, v] of fullPersonMap()) map.set(k, v);
    crowd.sync(world, () => 0);
    expect(crowd.debugPersonLayers()).toBe(4);
    expect(crowd.drawCallCount()).toBe(5);
  });
});
