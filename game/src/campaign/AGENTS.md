# AGENTS.md — src/campaign

"The First Term" campaign (Phase 2). Pure logic here is headless-safe
(no DOM); DOM screens live in `src/ui/campaignui.ts`.

## Modules (0.1 Alpha)

- `missions.ts` — the 8 missions as JSON-safe data (`MissionDef`):
  briefing, victory **paths** (a mission is won by completing every
  objective of ANY one path, so each mission has a peaceful path),
  scripted events, map preset, AI difficulty (`'none'` = no rival),
  starting resources. `getMission` / `missionsInOrder` helpers.
- `objectives.ts` — pure `checkObjective` / `checkPath` against world
  state. Cumulative counters (enemy units destroyed) come from the
  mission run state — the sim never counts kills.
- `director.ts` — `MissionRunState` (UI-owned: kill/loss counters, fired
  events, pending raids; never sim state) + `updateMissionRun`, which
  fires scripted events and reports victory/defeat as directives. Raids
  enqueue `spawnUnit` with issuer `'mission'`; movement is two-phase
  (spawn now, `moveGroup` once the fresh unit ids appear) because
  `moveGroup` validates unit existence at enqueue time. Raid positions
  derive from the mission seed — deterministic for equal tick streams.
- `progress.ts` — `CampaignProgress` (completed ids, diplomat/commander
  points), pure `scoreMission` / `recordCompletion` /
  `isMissionUnlocked` / `campaignEnding` ('peacemaker' wins ties), and
  `createCampaignStore()` — IndexedDB (`novaterra-campaign`) with an
  in-memory fallback; never throws, mirroring net_save/store.

## Rules

- The director observes and commands; it never mutates sim state
  directly. Every sim change goes through the command queue.
- Mission 1 is always unlocked; mission N unlocks when N−1 completes.
- The campaign never changes sim determinism: same seed + same player
  commands ⇒ same mission outcome.
- Mission session setup MUST grant the AI player a manpower stockpile:
  scripted raids enqueue `spawnUnit` for the AI owner, and the command
  validates manpower — without it raids are silently rejected.
