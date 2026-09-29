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
 * Tests for the Muse Commander rival (muse/digest.ts, muse/live.ts
 * commander protocol + API client, muse/commander.ts).
 *
 * No real API calls are ever made: `fetch` is mocked in every client
 * test. Fog-of-war fairness is tested structurally: the digest must
 * never contain an enemy the Muse owner's units cannot see.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import { createCommandQueue } from '../src/sim/commands';
import type { CommandQueue } from '../src/sim/commands';
import { getPlayer, placeBuilding } from '../src/sim/city';
import { spawnUnit } from '../src/sim/units';
import { registerUnitCommands } from '../src/sim/units';
import { registerCityCommands } from '../src/sim/city';
import { registerMovementCommands } from '../src/sim/movement';
import { registerAgeCommands } from '../src/sim/ages';
import { generateTerrain, MERIDIAN_PLAINS, isWater, type TerrainData } from '../src/sim/terrain';
import { buildCommanderDigest } from '../src/muse/digest';
import {
  parseDirectives,
  directivesToCommands,
  createLiveMuseClient,
  testLiveConnection,
  setLiveKey,
  LiveMuseError,
  type CommanderDirective,
  type DirectiveContext,
} from '../src/muse/live';
import { MuseCommander } from '../src/muse/commander';

const HUMAN = 0;
const AI = 1;
const TEST_KEY = 'sk-ant-test-key-12345';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** In-memory localStorage stub (vitest runs in Node: no DOM storage). */
function stubLocalStorage(initial: Record<string, string> = {}): void {
  const store = new Map<string, string>(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** A land position on the test terrain (spawn/move validation needs land). */
function findLand(terrain: TerrainData): { x: number; z: number } {
  const candidates: Array<[number, number]> = [
    [0, 0], [24, 0], [0, 24], [-24, 0], [0, -24], [48, 48], [-48, -48], [80, 0],
  ];
  // The build directive spawns at ±4 offsets around the base — the whole
  // 9-point disc must be land for the success-path tests.
  const offsets = [-4, 0, 4];
  for (const [x, z] of candidates) {
    let ok = true;
    for (const dx of offsets) for (const dz of offsets) {
      if (isWater(terrain, x + dx, z + dz)) ok = false;
    }
    if (ok) return { x, z };
  }
  throw new Error('test terrain has no land near the origin');
}

function setupCommanderWorld(): { world: World; queue: CommandQueue; terrain: TerrainData; base: { x: number; z: number } } {
  const terrain = getTerrain();
  const world = createWorld(424242);
  const queue = createCommandQueue();
  registerUnitCommands(queue, terrain);
  registerCityCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerAgeCommands(queue);
  const base = findLand(terrain);
  const aiPlayer = getPlayer(world.city, AI)!;
  aiPlayer.manpower = 200;
  aiPlayer.funds = 20000;
  aiPlayer.materials = 10000;
  return { world, queue, terrain, base };
}

function directiveCtx(world: World, queue: CommandQueue, base: { x: number; z: number }): DirectiveContext {
  return { world, queue, owner: AI, baseX: base.x, baseZ: base.z };
}

/** Let pending promise callbacks run. */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function mockFetchResponse(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ));
}

// ---------------------------------------------------------------------------
// Digest: own state + fog-filtered enemies + JSON safety + compactness.
// ---------------------------------------------------------------------------

describe('muse/digest — buildCommanderDigest', () => {
  it('carries the owner\'s full state (resources, unit counts, building counts)', () => {
    const world = createWorld(7);
    const aiPlayer = getPlayer(world.city, AI)!;
    aiPlayer.funds = 5123.7;
    aiPlayer.materials = 2100;
    aiPlayer.food = 900;
    aiPlayer.fuel = 120;
    aiPlayer.goods = 40;
    aiPlayer.influence = 15;
    aiPlayer.manpower = 60;
    aiPlayer.population = 350;
    spawnUnit(world, 'rifles', AI, 0, 0);
    spawnUnit(world, 'rifles', AI, 4, 0);
    spawnUnit(world, 'tank', AI, 8, 0);
    placeBuilding(world.city, { kind: 'house', owner: AI, cx: 128, cz: 128, facing: 0 });
    placeBuilding(world.city, { kind: 'house', owner: AI, cx: 130, cz: 128, facing: 0 });

    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });

    expect(digest.game).toBe('novaterra');
    expect(digest.tick).toBe(world.tick);
    expect(digest.age).toBe(world.ages.age);
    // placeBuilding deducts construction costs — the digest reports live resources.
    const live = getPlayer(world.city, AI)!;
    expect(digest.me.funds).toBe(Math.round(live.funds));
    expect(digest.me.materials).toBe(Math.round(live.materials));
    expect(digest.me.food).toBe(900);
    expect(digest.me.manpower).toBe(60);
    expect(digest.me.population).toBe(350);
    expect(digest.me.units).toEqual({ rifles: 2, tank: 1 });
    expect(digest.me.buildings).toEqual({ house: 2 });
  });

  it('reveals only visible enemy units (fog of war is structural)', () => {
    const world = createWorld(7);
    // AI scout at the origin (rifles sight = 22).
    spawnUnit(world, 'rifles', AI, 0, 0);
    // Visible enemy, well inside sight range.
    spawnUnit(world, 'tank', HUMAN, 10, 0);
    // Hidden enemy, far beyond any AI sight range.
    spawnUnit(world, 'tank', HUMAN, 200, 200);
    spawnUnit(world, 'artillery', HUMAN, -200, -200);

    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });

    expect(digest.enemy.units).toHaveLength(1);
    expect(digest.enemy.units[0]!.kind).toBe('tank');
    expect(digest.enemy.units[0]!.x).toBeCloseTo(10, 1);
  });

  it('reveals only visible enemy buildings', () => {
    const world = createWorld(7);
    spawnUnit(world, 'rifles', AI, 0, 0);
    // Cell (128,128) → world (1,1): visible from the origin.
    placeBuilding(world.city, { kind: 'house', owner: HUMAN, cx: 128, cz: 128, facing: 0 });
    // Cell (200,200) → world (145,145): far beyond sight.
    placeBuilding(world.city, { kind: 'factory', owner: HUMAN, cx: 200, cz: 200, facing: 0 });

    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });

    expect(digest.enemy.buildings).toHaveLength(1);
    expect(digest.enemy.buildings[0]!.kind).toBe('house');
  });

  it('is JSON-safe and stays under 2 KB even with a crowded battlefield', () => {
    const world = createWorld(7);
    spawnUnit(world, 'rifles', AI, 0, 0);
    // 60 visible enemies in a ring around the origin (sight 22).
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2;
      spawnUnit(world, 'tank', HUMAN, Math.cos(angle) * 15, Math.sin(angle) * 15);
    }
    for (let i = 0; i < 60; i++) {
      placeBuilding(world.city, { kind: 'house', owner: HUMAN, cx: 126 + (i % 5), cz: 126 + Math.floor(i / 5) % 5, facing: 0 });
    }

    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });
    const json = JSON.stringify(digest);

    expect(() => JSON.parse(json)).not.toThrow();
    expect(digest.enemy.units.length).toBeLessThanOrEqual(20);
    expect(digest.enemy.buildings.length).toBeLessThanOrEqual(20);
    expect(json.length).toBeLessThan(2048);
  });
});

// ---------------------------------------------------------------------------
// Directive parser.
// ---------------------------------------------------------------------------

describe('muse/live — parseDirectives (commander protocol)', () => {
  it('parses build/train with counts', () => {
    const d = parseDirectives('MUSE: build: tank\nMUSE: train: rifles x4\nMUSE: build: drone');
    expect(d).toEqual([
      { kind: 'build', unitKind: 'tank', count: 1 },
      { kind: 'build', unitKind: 'rifles', count: 4 },
      { kind: 'build', unitKind: 'drone', count: 1 },
    ]);
  });

  it('parses construct / attack / defend / advance-age', () => {
    const d = parseDirectives(
      'MUSE: construct: house\nMUSE: attack: 120, 80\nMUSE: defend\nMUSE: advance-age: signalsGrid\nMUSE: advance-age',
    );
    expect(d).toEqual([
      { kind: 'construct', buildingKind: 'house' },
      { kind: 'attack', x: 120, z: 80 },
      { kind: 'defend' },
      { kind: 'advanceAge', program: 'signalsGrid' },
      { kind: 'advanceAge', program: null },
    ]);
  });

  it('keeps MUSE: advise: working (backward compatible)', () => {
    const d = parseDirectives('MUSE: advise: Hold the northern pass.');
    expect(d).toEqual([{ kind: 'advise', text: 'Hold the northern pass.' }]);
  });

  it('ignores malformed lines, unknown verbs, and unknown kinds — never throws', () => {
    const d = parseDirectives(
      [
        'MUSE: build: deathstar x3', // unknown unit kind
        'MUSE: construct: moonbase', // unknown building kind
        'MUSE: attack: here, now', // malformed coords
        'MUSE: attack: 10', // malformed coords
        'MUSE: dance: wildly', // unknown verb
        'MUSE: build:', // missing kind
        'MUSE: defend the base at all costs', // defend takes no args
        'Just a chatty model being chatty.', // not a directive
        '', // blank
        'MUSE: build: tank', // the one valid line
      ].join('\n'),
    );
    expect(d).toEqual([{ kind: 'build', unitKind: 'tank', count: 1 }]);
  });

  it('resolves camelCase kinds case-insensitively (patrolBoat, signalsGrid)', () => {
    const d = parseDirectives('MUSE: build: PATROLBOAT\nMUSE: advance-age: signalsgrid');
    expect(d).toEqual([
      { kind: 'build', unitKind: 'patrolBoat', count: 1 },
      { kind: 'advanceAge', program: 'signalsGrid' },
    ]);
  });

  it('skips advance-age with an unknown program (no silent default)', () => {
    expect(parseDirectives('MUSE: advance-age: nonsense')).toEqual([]);
    expect(parseDirectives('MUSE: advance-age')).toEqual([
      { kind: 'advanceAge', program: null },
    ]);
  });

  it('caps parsed directives per round', () => {
    const text = Array.from({ length: 30 }, () => 'MUSE: defend').join('\n');
    expect(parseDirectives(text)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// directivesToCommands: ordinary validated commands, never direct mutation.
// ---------------------------------------------------------------------------

describe('muse/live — directivesToCommands', () => {
  it('build trains units near the base through spawnUnit', () => {
    const { world, queue, base } = setupCommanderWorld();
    const unitsBefore = world.units.length;
    directivesToCommands([{ kind: 'build', unitKind: 'rifles', count: 2 }], directiveCtx(world, queue, base));
    expect(queue.pendingCount()).toBe(2);
    expect(world.units).toHaveLength(unitsBefore); // nothing applied yet — queue only
  });

  it('swallows rejections: unaffordable builds never throw', () => {
    const { world, queue, base } = setupCommanderWorld();
    getPlayer(world.city, AI)!.manpower = 0; // rifles cost 2 manpower each
    expect(() =>
      directivesToCommands([{ kind: 'build', unitKind: 'rifles', count: 3 }], directiveCtx(world, queue, base)),
    ).not.toThrow();
    expect(queue.pendingCount()).toBe(0);
  });

  it('skips unknown kinds without throwing', () => {
    const { world, queue, base } = setupCommanderWorld();
    const bad: CommanderDirective[] = [
      { kind: 'build', unitKind: 'deathstar', count: 1 },
      { kind: 'construct', buildingKind: 'moonbase' },
    ];
    expect(() => directivesToCommands(bad, directiveCtx(world, queue, base))).not.toThrow();
    expect(queue.pendingCount()).toBe(0);
  });

  it('attack orders combat units only (haulers stay)', () => {
    const { world, queue, terrain, base } = setupCommanderWorld();
    spawnUnit(world, 'rifles', AI, base.x, base.z);
    spawnUnit(world, 'tank', AI, base.x + 2, base.z);
    spawnUnit(world, 'hauler', AI, base.x - 2, base.z); // unarmed: damage 0
    const target = findLand(terrain);
    directivesToCommands([{ kind: 'attack', x: target.x, z: target.z }], directiveCtx(world, queue, base));
    // rifles + tank get orders; the unarmed hauler does not.
    expect(queue.pendingCount()).toBe(2);
  });

  it('defend pulls combat units back to the base', () => {
    const { world, queue, base } = setupCommanderWorld();
    spawnUnit(world, 'rifles', AI, base.x, base.z);
    directivesToCommands([{ kind: 'defend' }], directiveCtx(world, queue, base));
    expect(queue.pendingCount()).toBe(1);
  });

  it('attack with no combat units is a silent no-op', () => {
    const { world, queue, base } = setupCommanderWorld();
    spawnUnit(world, 'hauler', AI, base.x, base.z); // unarmed: damage 0
    expect(() =>
      directivesToCommands([{ kind: 'attack', x: 10, z: 10 }], directiveCtx(world, queue, base)),
    ).not.toThrow();
    expect(queue.pendingCount()).toBe(0);
  });

  it('advance-age enqueues with the default program; invalid programs are skipped', () => {
    const { world, queue, base } = setupCommanderWorld();
    directivesToCommands([{ kind: 'advanceAge', program: null }], directiveCtx(world, queue, base));
    expect(queue.pendingCount()).toBe(1);
    directivesToCommands([{ kind: 'advanceAge', program: 'bogus' }], directiveCtx(world, queue, base));
    expect(queue.pendingCount()).toBe(1); // unchanged
  });

  it('advise directives enqueue nothing', () => {
    const { world, queue, base } = setupCommanderWorld();
    directivesToCommands([{ kind: 'advise', text: 'hello' }], directiveCtx(world, queue, base));
    expect(queue.pendingCount()).toBe(0);
  });

  it('mixed valid/invalid directives: one bad apple never blocks the rest', () => {
    const { world, queue, base } = setupCommanderWorld();
    spawnUnit(world, 'rifles', AI, base.x, base.z);
    const directives: CommanderDirective[] = [
      { kind: 'build', unitKind: 'rifles', count: 1 },
      { kind: 'advanceAge', program: 'bogus' }, // skipped
      { kind: 'defend' },
    ];
    expect(() => directivesToCommands(directives, directiveCtx(world, queue, base))).not.toThrow();
    expect(queue.pendingCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// API client: headers, error mapping, no real calls (fetch is mocked).
// ---------------------------------------------------------------------------

describe('muse/live — API client', () => {
  function stubKey(): void {
    stubLocalStorage({ 'novaterra.muse.liveKey': TEST_KEY });
  }

  it('command() POSTs with the required headers and parses directives', async () => {
    stubKey();
    mockFetchResponse(200, { content: [{ type: 'text', text: 'MUSE: build: tank\nMUSE: defend' }] });
    const client = createLiveMuseClient();
    const world = createWorld(9);
    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });

    const directives = await client.command(digest);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(TEST_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(init.body as string) as { model: string; system: string; messages: unknown[] };
    expect(typeof body.model).toBe('string');
    expect(body.system).toContain('MUSE:');
    expect(body.messages).toHaveLength(1);
    expect(directives).toEqual([
      { kind: 'build', unitKind: 'tank', count: 1 },
      { kind: 'defend' },
    ]);
  });

  it('401 → "invalid API key" error; the key never appears in the message', async () => {
    stubKey();
    mockFetchResponse(401, { error: { message: 'invalid x-api-key' } });
    const client = createLiveMuseClient();
    const world = createWorld(9);
    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });

    const err = await client.command(digest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveMuseError);
    expect((err as Error).message).toMatch(/invalid api key/i);
    expect((err as Error).message).not.toContain(TEST_KEY);
  });

  it('429 and 500 map to LiveMuseError without the key', async () => {
    stubKey();
    const client = createLiveMuseClient();
    const world = createWorld(9);
    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });

    mockFetchResponse(429, {});
    const e429 = await client.command(digest).catch((e: unknown) => e);
    expect(e429).toBeInstanceOf(LiveMuseError);
    expect((e429 as Error).message).toMatch(/rate limited/i);
    expect((e429 as Error).message).not.toContain(TEST_KEY);

    mockFetchResponse(500, {});
    const e500 = await client.command(digest).catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(LiveMuseError);
    expect((e500 as Error).message).toMatch(/request failed \(500\)/);
  });

  it('network failure → LiveMuseError', async () => {
    stubKey();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const client = createLiveMuseClient();
    const world = createWorld(9);
    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });
    await expect(client.command(digest)).rejects.toBeInstanceOf(LiveMuseError);
  });

  it('timeout → LiveMuseError (aborted request)', async () => {
    stubKey();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (_url: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const e = new DOMException('aborted', 'AbortError');
            reject(e);
          });
        }),
    ));
    const client = createLiveMuseClient();
    const world = createWorld(9);
    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });
    const err = await client.command(digest, { timeoutMs: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveMuseError);
    expect((err as Error).message).toMatch(/timed out/i);
  });

  it('no key → LiveMuseError and fetch is never called', async () => {
    stubLocalStorage(); // empty
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createLiveMuseClient();
    const world = createWorld(9);
    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });
    await expect(client.command(digest)).rejects.toBeInstanceOf(LiveMuseError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('advise() returns advise lines only', async () => {
    stubKey();
    mockFetchResponse(200, {
      content: [{ type: 'text', text: 'MUSE: advise: Build farms.\nMUSE: build: tank' }],
    });
    const client = createLiveMuseClient();
    const lines = await client.advise({
      game: 'novaterra', tick: 1, age: 'foundation', funds: 0, population: 0,
      food: 0, influence: 0, manpower: 0, buildings: 0, units: 0, enemyUnits: 0,
      myMilitary: 0, enemyMilitary: 0, threat: 0, mission: null, objectives: [],
    });
    expect(lines).toEqual(['Build farms.']);
  });

  it('testLiveConnection: ok on advise reply, clean failure otherwise', async () => {
    // No key.
    stubLocalStorage();
    expect(await testLiveConnection()).toEqual({ ok: false, message: 'No API key set.' });

    // Happy path.
    stubKey();
    mockFetchResponse(200, { content: [{ type: 'text', text: 'MUSE: advise: ok' }] });
    expect(await testLiveConnection()).toEqual({ ok: true, message: 'Connected — Muse is ready.' });

    // 401.
    mockFetchResponse(401, {});
    const bad = await testLiveConnection();
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/invalid api key/i);
    expect(bad.message).not.toContain(TEST_KEY);
  });

  it('setLiveKey stores the key; errors never include it', async () => {
    stubLocalStorage();
    setLiveKey(TEST_KEY);
    mockFetchResponse(500, {});
    const client = createLiveMuseClient();
    const world = createWorld(9);
    const digest = buildCommanderDigest(world, AI, { size: 512, waterPct: 5 });
    const err = await client.command(digest).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(TEST_KEY);
  });
});

// ---------------------------------------------------------------------------
// MuseCommander: cadence, single in-flight call, silent fallback.
// ---------------------------------------------------------------------------

describe('muse/commander — MuseCommander', () => {
  function commanderSetup(opts?: { key?: boolean; cadenceSec?: number }) {
    stubLocalStorage({
      ...(opts?.key === false ? {} : { 'novaterra.muse.liveKey': TEST_KEY }),
      'novaterra.muse.liveCadenceSec': String(opts?.cadenceSec ?? 30),
    });
    const { world, queue, base } = setupCommanderWorld();
    world.tick = 1000; // past the 30s cadence (900 ticks)
    const thinking: boolean[] = [];
    const commandMock = vi.fn();
    const commander = new MuseCommander({
      queue,
      owner: AI,
      baseX: base.x,
      baseZ: base.z,
      mapSize: 512,
      waterPct: 5,
      onThinkingChange: (t) => thinking.push(t),
      createClient: () => ({ advise: async () => [], command: commandMock }),
    });
    return { world, queue, commander, thinking, commandMock };
  }

  it('does nothing without a key (Classic fallback covers the game)', () => {
    const { world, commander, thinking, commandMock } = commanderSetup({ key: false });
    expect(() => commander.update(world)).not.toThrow();
    expect(commandMock).not.toHaveBeenCalled();
    expect(thinking).toEqual([]);
  });

  it('fires at cadence, buffers directives, applies them at the next update()', async () => {
    const { world, queue, commander, thinking, commandMock } = commanderSetup();
    commandMock.mockResolvedValue([{ kind: 'build', unitKind: 'rifles', count: 1 }]);

    commander.update(world);
    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(thinking).toEqual([true]);

    await flush();
    // Controlled application point: resolved directives wait for the
    // next update() — they are never applied inside the Promise callback.
    expect(queue.pendingCount()).toBe(0);

    commander.update(world);
    expect(queue.pendingCount()).toBe(1);
    expect(thinking).toEqual([true, false]);
  });

  it('does not fire twice while a request is in flight', () => {
    const { world, commander, commandMock } = commanderSetup();
    commandMock.mockReturnValue(new Promise(() => {})); // hangs
    commander.update(world);
    commander.update(world);
    commander.update(world);
    expect(commandMock).toHaveBeenCalledTimes(1);
  });

  it('API failure is silent: no throw, thinking resets, queue untouched', async () => {
    const { world, queue, commander, thinking, commandMock } = commanderSetup();
    commandMock.mockRejectedValue(new LiveMuseError('boom', 'network'));

    expect(() => commander.update(world)).not.toThrow();
    await flush();
    expect(queue.pendingCount()).toBe(0);
    expect(thinking).toEqual([true, false]);
  });

  it('401 latches the key: no retries until the stored key changes', async () => {
    const { world, commander, commandMock } = commanderSetup();
    commandMock.mockRejectedValue(new LiveMuseError('invalid', 'invalid_key'));

    commander.update(world);
    expect(commandMock).toHaveBeenCalledTimes(1);
    await flush();

    // Same key, next cadence: latched, no call.
    world.tick += 30 * 30;
    commander.update(world);
    expect(commandMock).toHaveBeenCalledTimes(1);

    // Key changes: latch clears, calls resume.
    localStorage.setItem('novaterra.muse.liveKey', 'sk-ant-fresh-key');
    commander.update(world);
    expect(commandMock).toHaveBeenCalledTimes(2);
    commander.dispose();
  });

  it('waits for the cadence interval between calls', async () => {
    const { world, commander, commandMock } = commanderSetup({ cadenceSec: 120 });
    commandMock.mockResolvedValue([]);
    world.tick = 100; // 120s cadence = 3600 ticks; far too early
    commander.update(world);
    expect(commandMock).not.toHaveBeenCalled();
    world.tick = 4000;
    commander.update(world);
    expect(commandMock).toHaveBeenCalledTimes(1);
  });

  it('dispose() stops further calls and discards buffered directives', async () => {
    const { world, queue, commander, commandMock } = commanderSetup();
    commandMock.mockResolvedValue([{ kind: 'build', unitKind: 'rifles', count: 1 }]);
    commander.update(world);
    await flush();
    commander.dispose(); // buffered directives are dropped, never applied
    commander.update(world);
    expect(queue.pendingCount()).toBe(0);
  });
});
