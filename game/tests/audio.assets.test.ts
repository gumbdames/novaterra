// NOVATERRA — audio/assets.test.ts — licensed music tracks must ship (0.1 Alpha).
//
// Regression test for the found bug (2026-10-02): `public/audio/peace.mp3`
// and `public/audio/war.mp3` were documented in THIRD_PARTY_NOTICES.md and
// referenced by `audio/music.ts`, but the files were never committed — so the
// live site 404'd on both tracks and the game played in silence. This test
// pins their presence, size, and mp3 framing so the pipeline can never break
// silently again.
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Track specs from THIRD_PARTY_NOTICES.md (Kevin MacLeod, CC BY 4.0).
const TRACKS: ReadonlyArray<{
  readonly name: string;
  readonly minBytes: number;
  readonly minSeconds: number;
}> = [
  { name: 'peace.mp3', minBytes: 2_000_000, minSeconds: 200 }, // 96 kbps, 212 s
  { name: 'war.mp3', minBytes: 2_000_000, minSeconds: 150 }, // 128 kbps, 165 s
];

/** Very rough duration estimate from file bytes at the given bitrate. */
function estDurationSeconds(bytes: number, bitrateKbps: number): number {
  return (bytes * 8) / (bitrateKbps * 1000);
}

describe('licensed music tracks ship in public/audio', () => {
  for (const track of TRACKS) {
    it(`${track.name} exists, is a real mp3, and is long enough`, () => {
      const path = join(gameRoot, 'public', 'audio', track.name);
      const stat = statSync(path); // throws if the file is missing
      expect(stat.size).toBeGreaterThan(track.minBytes);
      const head = readFileSync(path).subarray(0, 4);
      const b0 = head[0] ?? 0;
      const b1 = head[1] ?? 0;
      const b2 = head[2] ?? 0;
      // ID3v2 header ("ID3") or an MPEG frame-sync byte pair (0xFF 0xE0..0xFF).
      const isId3 = b0 === 0x49 && b1 === 0x44 && b2 === 0x33;
      const isFrameSync = b0 === 0xff && (b1 & 0xe0) === 0xe0;
      expect(isId3 || isFrameSync).toBe(true);
    });
  }

  it('both tracks survive the production build into dist/audio', async () => {
    // The build must copy public/ verbatim; read the dist tree without
    // requiring a rebuild here (CI builds before tests).
    const distAudio = join(gameRoot, 'dist', 'audio');
    const stat = statSync(distAudio); // throws if dist/ has no audio dir
    expect(stat.isDirectory()).toBe(true);
    for (const track of TRACKS) {
      const f = statSync(join(distAudio, track.name));
      expect(f.size).toBeGreaterThan(track.minBytes);
      expect(estDurationSeconds(f.size, track.name === 'peace.mp3' ? 96 : 128))
        .toBeGreaterThan(track.minSeconds);
    }
  }, 30_000);
});
