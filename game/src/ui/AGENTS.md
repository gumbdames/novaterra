# AGENTS.md — src/ui

HUD, menus, dialogs, camera, selection and orders. UI emits tick-aligned
command structs to sim/commands.ts — it never mutates sim state directly.
