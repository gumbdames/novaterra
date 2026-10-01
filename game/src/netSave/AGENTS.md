# AGENTS.md — src/net_save

Save / load / resume (Phase 1, step 11). See docs/ARCHITECTURE.md §4.

## Modules (0.1 Alpha)

- `savefile.ts` — the `SaveFile` envelope: `{ version, metadata,
  snapshot }`. `SAVEFILE_VERSION` (1) is the envelope version, independent
  of the sim snapshot version (sim/snapshot.ts v6, accepting v5) — slot metadata can
  evolve without touching the sim. `SaveMetadata` is everything the load
  UI shows without reading the snapshot: slot id, name, savedAt (ISO),
  tick, seed, AI difficulty, age, National Program, and the `cheated`
  flag. `createSaveFile(session, slotId, name, savedAtIso)` deep-copies
  via `takeSnapshot` — the file never aliases live world state.
- `store.ts` — `SaveStore` CRUD (`list`/`read`/`write`/`remove`) keyed by
  slot id, plus `createSaveStore()`. IndexedDB when available (one record
  per slot, single transaction per op); in-memory Map fallback when
  IndexedDB is missing or throws (private mode, Node/vitest). The memory
  backend deep-copies on write (mirrors structured-clone). A slotId /
  metadata.slotId mismatch is rejected (`false`). **Never throws** —
  every op degrades to null/empty/false; the UI toasts failures instead.

Slots: `autosave` + `slot-1..3` (`SAVE_SLOTS`, `AUTOSAVE_SLOT`).

## Rules

- The store never touches sim state — only SaveFiles.
- `savedAt` is display-only wall clock; it never enters the sim.
- Export/import file fallback and save-format migrations are future work
  (Phase 2+), not 0.1 Alpha scope.
