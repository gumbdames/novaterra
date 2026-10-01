# Reversals — novaterra

Design decisions that were reversed, ripped out, or deliberately not taken.
Kept so nobody re-litigates them. Last updated: 2026-10-01.

## 1. Muse Commander / Anthropic API-key flow — ripped out (2026-09-29)

A "play against Muse" rival was built (`d9582f5`) that let players enter an
Anthropic API key so an LLM could play as a sixth rival. The user rejected
it outright:

> "I do not want any connection to Anthropic — only to Meta's Muse (you!)!!
> ... rip out that functionality entirely!"

The whole feature was reverted (`d59a602`), the deploy restored
(`dac5867`), and the UI flow deleted (`b429d1c`). What remains:

- **Five Classic AI rivals only** (seeded personalities, fair-by-construction).
- **Live Muse = offline "hopefully coming" placeholder** (`game/src/muse/live.ts`).
  Honest status text, zero networking surface: no API-key field, no endpoint,
  no SDK, no connection of any kind to Anthropic or any third party.
- The user correction stands as law: when they say "Muse" they mean their
  Meta Muse agent — never Anthropic's Claude. No third-party AI ever goes
  into NOVATERRA.

## 2. Roads are optional (2026-09-30)

Early placement rules required road adjacency for buildings and utility
service. The user directed: roads should be purely optional. Commit
`71e8dea` removed the road-adjacency requirement from `validatePlacement`,
`tryAutoDevelop` (zoned houses grow with zero roads), and power/water supply
in `economy.ts`; `isRoadAdjacent` was deleted (zero callers). Kept:
`areRoadsConnected` for future traffic work. Consequences:

- Zones auto-pave (concrete) so pedestrians can walk while plots are empty;
  buildings pop up on paved ground; roads can be laid over later.
- A building is never rejected, and a utility never refuses service, for
  lack of a road.

## 3. No WASM anywhere (2026-09-28)

Measured, not assumed: the compiled candidates were slower on this workload
than tuned TypeScript, and threading complicates the single-machine
determinism contract (see ARCHITECTURE.md). The game is TypeScript-only.
Future candidates are recorded — not decided — in
`docs/research/sim-architecture.md` §7.3, priority-ordered by the user
(2026-10-01): pathfinding (`sim/pathfinding.ts`), desirability/migration
scans, the AI think pass. If profiling ever shows a hot path that WASM wins
by a wide margin, the snapshot boundary makes the move a transport change —
but the bar is evidence, not fashion.

## 4. Commercial game-title purge (2026-09-29)

All commercial game-title references were removed from README, player docs,
UI strings, code comments, ARCHITECTURE, PLAN, and GAME_MECHANICS
(`10a1c7e`) — the game is now described entirely in its own terms.
Deliberately kept: the ~60 uses of "general(s)" = the game's own
appointable-bureaucrat rank mechanic, and formal citations in
`docs/research/*.md` (the user was told and can override).

## 5. Peaceful mode is endless — the 8000-pop victory is gone (2026-10-01)

Peaceful mode originally ended in victory at 8000 residents. Final-review R2
(`dd3d7e0`) removed it: a race with no racer, and "win at a population
number" was arbitrary next to the mode's actual promise — build for its own
sake. Peaceful mode is now **endless**: no win screen, no defeat screen, no
end screen at all. The Management tab's status section shows housed
population and treasury health as plain information, not as progress toward
a goal.

## 6. Not taken (but recorded)

- **Re-adding an API-key play-against-AI flow** — refused by standing user
  directive (§1). Not a roadmap item.
- **Fixed road-requirement for buildings** — refused by standing user
  directive (§2).
- **Cross-machine lockstep / multiplayer determinism** — the determinism
  contract is same-machine only (ARCHITECTURE.md D5). Not needed.
- **Non-English shipped UI** — refused by standing user directive
  (ARCHITECTURE.md D9). Localization indirection stays for a future that
  may never come.
