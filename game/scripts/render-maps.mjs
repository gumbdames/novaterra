import { register } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./ts-resolve-hooks.mjs', import.meta.url);

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.dirname(SCRIPTS_DIR);
const outDir = path.join(GAME_DIR, 'public', 'img', 'art', 'skirmish');
mkdirSync(outDir, { recursive: true });

const [{ encodePng }, { MAP_PRESETS, generateTerrain, rawToWorldHeight }] = await Promise.all([
  import('./portrait-atlas.ts'),
  import('../src/sim/terrain.ts'),
]);

const SIZE = 256;

for (let idx = 0; idx < MAP_PRESETS.length; idx++) {
  const mapIndex = idx + 1;
  const targetFile = path.join(outDir, `map-${mapIndex}.png`);
  
  // If map 1, 2, 3 already exist from the image-generator, we don't need to overwrite them,
  // but if we want to ensure maps 4..8 exist, let's generate them!
  if (mapIndex <= 3) {
    console.log(`Skipping map-${mapIndex} (already generated)`);
    continue;
  }

  const preset = MAP_PRESETS[idx];
  console.log(`Rendering map-${mapIndex} (${preset.name})...`);
  const terrain = generateTerrain(preset.seed);

  const rgba = new Uint8Array(SIZE * SIZE * 4);
  const verts = terrain.vertsPerSide;

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const vx = Math.floor((px / SIZE) * (verts - 1));
      const vz = Math.floor((py / SIZE) * (verts - 1));
      const vi = vz * verts + vx;
      const raw = terrain.heights[vi] ?? 0;
      const h = rawToWorldHeight(raw);
      const isWater = h < terrain.waterLevel;

      // Calculate simple lighting / hillshade
      const vxNext = Math.min(vx + 1, verts - 1);
      const vzNext = Math.min(vz + 1, verts - 1);
      const hX = rawToWorldHeight(terrain.heights[vz * verts + vxNext] ?? 0);
      const hZ = rawToWorldHeight(terrain.heights[vzNext * verts + vx] ?? 0);
      const slope = (h - hX) * 3 + (h - hZ) * 3;
      const shade = Math.max(0.6, Math.min(1.4, 1.0 + slope * 0.15));

      let r = 0, g = 0, b = 0;
      if (isWater) {
        const depth = Math.min(1, (terrain.waterLevel - h) / 6);
        r = Math.floor(18 * (1 - depth) + 8 * depth);
        g = Math.floor(45 * (1 - depth) + 20 * depth);
        b = Math.floor(95 * (1 - depth) + 55 * depth);
      } else {
        const alt = h - terrain.waterLevel;
        if (alt < 0.6) {
          // Beach / Sand
          r = Math.floor(190 * shade);
          g = Math.floor(175 * shade);
          b = Math.floor(125 * shade);
        } else if (alt < 6) {
          // Plains / Grass
          r = Math.floor(48 * shade);
          g = Math.floor(95 * shade);
          b = Math.floor(42 * shade);
        } else if (alt < 14) {
          // Hills / Forest
          r = Math.floor(75 * shade);
          g = Math.floor(100 * shade);
          b = Math.floor(55 * shade);
        } else {
          // Mountain / Snow peaks
          r = Math.floor(140 * shade);
          g = Math.floor(145 * shade);
          b = Math.floor(155 * shade);
        }
      }

      // Add tactical radar grid lines
      const isGrid = (px % 32 === 0 || py % 32 === 0);
      if (isGrid) {
        r = Math.min(255, r + 25);
        g = Math.min(255, g + 35);
        b = Math.min(255, b + 50);
      }

      // Add circular radar range ring overlay
      const dx = px - SIZE / 2;
      const dy = py - SIZE / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const isRing = Math.abs(dist - 50) < 1 || Math.abs(dist - 100) < 1;
      if (isRing) {
        r = Math.min(255, r + 30);
        g = Math.min(255, g + 50);
        b = Math.min(255, b + 60);
      }

      const o = (py * SIZE + px) * 4;
      rgba[o] = Math.min(255, Math.max(0, r));
      rgba[o + 1] = Math.min(255, Math.max(0, g));
      rgba[o + 2] = Math.min(255, Math.max(0, b));
      rgba[o + 3] = 255;
    }
  }

  const png = encodePng(SIZE, SIZE, rgba);
  writeFileSync(targetFile, png);
  console.log(`Saved ${targetFile}`);
}

console.log('All skirmish maps ready!');
