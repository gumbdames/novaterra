# AGENTS.md — bench

Render benchmark harness (Phase 1, step 2). Gating tool before content
scale-up: measures frame time / draw calls / triangles over an instanced
entity sweep on both renderer backends.

- Pure, Node-testable logic: `config.ts` (URL params, sweep), `layout.ts`
  (deterministic instance placement), `stats.ts` (avg/p95 aggregation),
  `format.ts` (report JSON shape, tables, budget verdict).
- Browser-only: `scene.ts` (three.js bench scene), `runner.ts` (sweep loop,
  `window.__novaterra_bench`).
- Entry: main.ts dynamically imports `./bench/runner` only when `?bench=1`
  is present — the normal boot path must stay byte-identical in behavior.
- Run: `?bench=1&auto=1&backend=webgpu` (or `webgl2`); single point with
  `&count=N`; see `config.ts` header for all params.
- Conventions: every number the harness reports is defined in `format.ts`;
  budgets live there too (mirroring ARCHITECTURE.md §6). Keep the layout
  seeds fixed — comparable numbers across runs depend on it.
