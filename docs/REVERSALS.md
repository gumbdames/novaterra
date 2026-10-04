# Reversals — novaterra

Design decisions that were reversed, ripped out, or deliberately not taken.
Kept so nobody re-litigates them. Last updated: 2026-10-02.

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

## 7. Fun-audit wave judgment calls (2026-10-02)

Decisions taken during the user-approved fun-audit build ("build it all",
`docs/research/fun-audit-2026-10-02.md`) that went softer, narrower, or
against the plan's letter. Each was deliberate; don't silently "fix" them.

- **Default drag: marquee box-select, not grab-pan** (2026-10-04,
  `8322253`). The fun-audit recorded "no restored full box-select / no
  gesture swap" as a dead end, and the standing instruction was not to
  alter the default grab-pan. The shipped design reverses that: primary
  (left) drag with no tool armed now creates a marquee selection box;
  grab-pan remains on right-drag / middle-drag and WASD. Per the user's
  2026-10-04 direction ("fix bugs only, leave design as-shipped") this
  stays as-shipped — don't restore left-drag grab-pan without fresh
  user direction.

- **End screens: realistic terrestrial, not sci-fi** (`f0a3076`). The first
  illustrated end-screen set was sci-fi; the user rejected it outright —
  "These images are too sci-fi. Make them more realistic and terrestrial."
  Six realistic terrestrial illustrations ship (four victory, two defeat).
  Don't commission another sci-fi set without fresh user direction.
- **Engineer: aura, not construction-gating** (`d4e4d4b`). The plan offered
  "meaningful construction/repair behavior"; the softened option shipped: a
  living same-owner engineer within 12 cells doubles build speed and repairs
  damaged buildings at 1 hp/s — automatic, no new orders or UI. Full
  engineer-gating of construction was deliberately NOT built: it would have
  broken AI physical building and every construction test. Recorded in
  `game/src/sim/AGENTS.md`.
- **Land trade deleted, not made physical** (`d4e4d4b`). The plan's option
  (b). Routes were player→player with no building endpoints; making them
  physical edged into the "no full traffic simulation" dead end
  (`establishTradeRoute`/`cancelTradeRoute`/`runTradeRoutes` and the
  `TradeRoute` state are gone; the 3/s income went with them — the fixed-rate
  market already serves that niche).
- **Civilian transports consolidated, not expanded** (`d4e4d4b`). The four
  mechanically duplicate civilian transports (`jumboAirliner`,
  `regionalJet`, `passengerHeli`, `seaplane`) were delisted from the train
  palette — kept as defs for save compatibility and AI/demo spawns. Trainable:
  one Cargo Plane, one Airliner, one Freighter.
- **Fog of war: real fog, fallback NOT used** (`7ae88f7`). The plan carried a
  documented fallback in case genuine player fog was unsuitable for the
  engine; the honest technical attempt succeeded, so the fallback was never
  needed. Shroud / dimmed / clear, on the AI's own sight model.
- **B7 acceptance passed on C1 as-shipped; base-zone-supremacy fallback not
  needed** (`5c70a02`). The AI is physically beatable by razing its forward
  base; the plan's fallback never fired. Don't re-add a supremacy shortcut.
- **Day/night: visual only, zero gameplay effects** (`42327ff`). Nights are
  readable by design; the trailer is pinned to golden hour. Future art must
  be checked at four times of day. No gameplay penalties or weather were
  added — that was the verdict, not an omission.
- **Vostok Combine: merchant-only, no raid — no stubs, no hooks**
  (`930b49d`). Raids are out of scope for 0.1 Alpha entirely; there is no
  raid code, no stubs, and no hooks for one. Don't wire a raid in through
  the Combine's visit state machine without a fresh user-approved plan.
