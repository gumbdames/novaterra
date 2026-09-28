// NOVATERRA — Vite 8 build config.
//
// - `base` is the GitHub Pages project-site path. The repo is being renamed
//   to `novaterra` (user-confirmed 2026-09-28; GitHub-side rename pending),
//   so the site will live at https://gumbdames.github.io/novaterra/.
// - `vite build` emits plain static assets into game/dist (deployed as-is).
// - The vitest `test` section keeps one config file for build + test.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/novaterra/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Keep chunks predictable for the static Pages host.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // Headless sim/unit tests run in Node — no DOM, no GPU.
    // (The boot module is import-safe under Node by design; see main.ts.)
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
