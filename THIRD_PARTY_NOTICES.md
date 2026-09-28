# Third-Party Notices — novaterra

NOVATERRA itself is licensed **AGPL-3.0-only** (see [LICENSE](LICENSE),
Copyright (C) 2026 Gumb Dames). The project bundles the following third-party
packages; each remains under its own license, which applies to that package only.

## three.js — MIT License
- Version used: 0.186.1
- Copyright (c) 2010-2026 three.js authors
- https://github.com/mrdoob/three.js

## @types/three — MIT License
- Version used: 0.186.0
- https://github.com/DefinitelyTyped/DefinitelyTyped

## TypeScript — Apache License 2.0
- Version used: 7.0.2
- Copyright (c) Microsoft Corporation
- https://github.com/microsoft/TypeScript

## Vite — MIT License
- Version used: 8.3.1
- Copyright (c) 2019-present VoidZero Inc. & Vite Contributors
- https://github.com/vitejs/vite

## Vitest — MIT License
- Version used: 3.2.7
- Copyright (c) 2021-present Vitest Contributors
- https://github.com/vitest-dev/vitest

Full license texts: MIT — https://opensource.org/licenses/MIT ;
Apache-2.0 — https://www.apache.org/licenses/LICENSE-2.0

## Game audio assets (shipped in game/public/audio/)

Both tracks by Kevin MacLeod (https://incompetech.com), licensed
**CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/) — free for
commercial use including games, with attribution (this notice and the
Sound section of docs/HOW_TO_PLAY.md).

- `peace.mp3` — "Meditation Impromptu 01" by Kevin MacLeod.
  Source: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Meditation%20Impromptu%2001.mp3
  License: CC BY 4.0. Re-encoded to 96 kbps with 2 s baked fades.
- `war.mp3` — "Volatile Reaction" by Kevin MacLeod.
  Source: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Volatile%20Reaction.mp3
  License: CC BY 4.0. Re-encoded to 128 kbps with 2 s baked fades.

All sound effects are synthesized procedurally at runtime with the Web Audio
API (game/src/audio/sfx.ts) — no third-party samples.
