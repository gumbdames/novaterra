/**
 * Civilian pedestrian variants (render/people.ts, 0.1 Alpha) — tests.
 *
 * Covers: the fixed key list, round-robin variant assignment, and
 * `buildPersonVariantGeometry` (per-material color baking, single merged
 * output, height normalization, null on unusable input).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PERSON_HEIGHT,
  PERSON_MODEL_KEYS,
  PERSON_VARIANT_CAPACITY,
  buildPersonVariantGeometry,
  personVariantForIndex,
} from '../src/render/people';
import { MAX_AMBIENT_PEDESTRIANS } from '../src/render/cityLife';
import type { LoadedModel } from '../src/render/models';

/** A two-part mock person: colored boxes, base at y=0, 1.4 tall. */
function mockPerson(colorA = 0xff0000, colorB = 0x00ff00): LoadedModel {
  const torso = new THREE.BoxGeometry(0.4, 0.9, 0.25);
  torso.translate(0, 0.45, 0);
  const head = new THREE.BoxGeometry(0.25, 0.5, 0.25);
  head.translate(0, 1.15, 0);
  return {
    geometries: [torso, head],
    materials: [
      new THREE.MeshStandardMaterial({ color: colorA }),
      new THREE.MeshStandardMaterial({ color: colorB }),
    ],
  };
}

describe('PERSON_MODEL_KEYS', () => {
  it('lists four civilian variants in fixed order', () => {
    expect(PERSON_MODEL_KEYS).toEqual([
      'personCasualMan',
      'personCasualWoman',
      'personWorker',
      'personWomanTwo',
    ]);
  });
});

describe('personVariantForIndex', () => {
  it('round-robins across the four variants', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(personVariantForIndex)).toEqual([
      0, 1, 2, 3, 0, 1, 2, 3,
    ]);
  });

  it('handles negative indices deterministically', () => {
    expect(personVariantForIndex(-1)).toBe(3);
    expect(personVariantForIndex(-4)).toBe(0);
  });
});

describe('buildPersonVariantGeometry', () => {
  it('merges parts into one vertex-colored geometry at person height', () => {
    const geo = buildPersonVariantGeometry(mockPerson());
    expect(geo).not.toBeNull();
    const g = geo as THREE.BufferGeometry;
    expect(g.attributes['color']).toBeDefined();
    expect(g.attributes['uv']).toBeUndefined(); // UVs are dropped
    g.computeBoundingBox();
    const box = g.boundingBox as THREE.Box3;
    expect(box.max.y - box.min.y).toBeCloseTo(PERSON_HEIGHT, 5);
    expect(box.min.y).toBeCloseTo(0, 5); // base stays at y=0
  });

  it('bakes each part material color into its vertices', () => {
    const geo = buildPersonVariantGeometry(mockPerson(0xff0000, 0x0000ff));
    const g = geo as THREE.BufferGeometry;
    const colors = g.attributes['color'] as THREE.BufferAttribute;
    // Torso verts are red, head verts are blue — every vertex is one of
    // the two, never a blend (parts don't share vertices after merge).
    let red = 0;
    let blue = 0;
    let other = 0;
    for (let i = 0; i < colors.count; i++) {
      const r = colors.getX(i);
      const b = colors.getZ(i);
      if (r > 0.9 && b < 0.1) red++;
      else if (b > 0.9 && r < 0.1) blue++;
      else other++;
    }
    expect(other).toBe(0); // no blended vertices — parts stay distinct
    expect(red).toBeGreaterThan(0);
    expect(blue).toBeGreaterThan(0);
    expect(red + blue).toBe(colors.count);
  });

  it('does not mutate the input geometries', () => {
    const loaded = mockPerson();
    const first = loaded.geometries[0] as THREE.BufferGeometry;
    const before = first.attributes['position']!.count;
    buildPersonVariantGeometry(loaded);
    expect(first.attributes['position']!.count).toBe(before);
    expect(first.attributes['color']).toBeUndefined();
  });

  it('returns null for an empty model (caller keeps capsules)', () => {
    expect(buildPersonVariantGeometry({ geometries: [], materials: [] })).toBeNull();
  });

  it('returns null when a part has no position attribute', () => {
    const bad = new THREE.BufferGeometry(); // empty
    const loaded: LoadedModel = {
      geometries: [bad],
      materials: [new THREE.MeshStandardMaterial({ color: 0xffffff })],
    };
    expect(buildPersonVariantGeometry(loaded)).toBeNull();
  });

  it('falls back to white for materials without a color', () => {
    const torso = new THREE.BoxGeometry(0.4, 1.4, 0.25);
    torso.translate(0, 0.7, 0);
    const loaded: LoadedModel = {
      geometries: [torso],
      materials: [new THREE.Material()], // bare Material has no .color
    };
    const geo = buildPersonVariantGeometry(loaded);
    expect(geo).not.toBeNull();
    const colors = (geo as THREE.BufferGeometry).attributes['color'] as THREE.BufferAttribute;
    expect(colors.getX(0)).toBeCloseTo(1, 5);
    expect(colors.getY(0)).toBeCloseTo(1, 5);
    expect(colors.getZ(0)).toBeCloseTo(1, 5);
  });
});

describe('person capacity', () => {
  it('four variant layers cover the pedestrian cap', () => {
    expect(PERSON_VARIANT_CAPACITY * PERSON_MODEL_KEYS.length).toBeGreaterThanOrEqual(
      MAX_AMBIENT_PEDESTRIANS,
    );
  });
});
