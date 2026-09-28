/**
 * NOVATERRA — scaffold smoke tests.
 *
 * These prove the two things Phase 1 step 1 must guarantee:
 *  1. The entry module imports cleanly with no DOM and no GPU (vitest runs
 *     in Node) — i.e. renderer creation is correctly deferred to boot().
 *  2. Game identity constants are present and well-formed.
 *
 * Per the repo step gate (AGENTS.md §2), every later step re-runs these.
 */
import { describe, expect, it } from 'vitest';

import { GAME_TAGLINE, GAME_TITLE, GAME_VERSION } from '../src/config';
import { boot } from '../src/main';

describe('scaffold smoke', () => {
  it('exposes game identity constants', () => {
    expect(GAME_TITLE).toBe('NOVATERRA');
    expect(GAME_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(GAME_TAGLINE.length).toBeGreaterThan(0);
  });

  it('main module imports cleanly under Node and exports boot', () => {
    // If the static import graph touched the DOM or GPU, this import
    // itself would have thrown before we got here.
    expect(typeof boot).toBe('function');
  });
});
