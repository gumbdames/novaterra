# UI icons: icons AND text on menu/palette buttons

Date: 2026-09-30. Workstream D (0.1 Alpha).

## Requirement

User directive (2026-09-30): menus must show icons AND text so it is easy
to see what is being selected. The 28-unit / 28-building palettes, the
build tools row, and the menu option buttons (maps, difficulties) were
text-only. Language rule: the entire game is English-only; zero new
user-facing strings were added — every label already existed.

## Options considered

**(a) Build-time 3D thumbnails** (render each GLB/procedural model to PNG
and use as button art). Rejected: needs a headless-render pipeline (56
framed shots with a per-model camera rig), ~150–400KB of PNGs that must
load before menus render, and at 32px a 3D thumbnail is less legible than
a bold silhouette.

**(b) Hand-made inline SVGs** — chosen. New pure module
`game/src/ui/icons.ts`: 24×24 viewBox, `stroke="currentColor"`,
`aria-hidden="true"` on every glyph. Icons are always paired with a text
label, never icon-only (accessibility). `Record<UnitKind, string>` /
`Record<BuildingKind, string>` make a missing icon a compile error.

**(c) CC0 icon set.** Rejected: no single CC0 set covers this roster
(MLRS, desalination plant, storm array, …) in one consistent style;
vetting 56 licenses is more work than drawing a coherent set.

## Coverage

- `unitIcon`: 28 units — silhouette reads the domain at a glance
  (person / tracked hull / aircraft / ship hull).
- `buildingIcon`: 30 buildings (28 roster-expansion + kindergarten/college, Workstream Z).
- `toolIcon`: road, zoneR, zoneC, zoneI, demolish.
- `mapIcon(waterFraction)`: 5 terrain buckets (pond / river / lakes /
  coast / isles) covering the 8 map presets.
- `difficultyIcon`: 1–5 filled rank chevrons.
- `menuIcon`: skirmish, load, missions, settings, back, resume, save, exit.

## Rendering changes (presentational only — no event wiring touched)

- `hud.ts`: `iconSpan()` helper; train buttons prepend `unitIcon(kind)`,
  build buttons prepend `buildingIcon(kind)`, tools row gets icon + label.
- `menus.ts`: `menuButton()` gained an optional 4th param `iconMarkup?`;
  main menu, map picker, difficulty picker, pause and exit-confirm
  buttons pass icons.
- `style.css`: palette buttons become icon-left grid (icon + name/cost
  stacked); tools row and menu buttons use inline-flex with gaps.

## Verification

- `game/tests/ui.icons.test.ts` (8 tests): 28+28 coverage, glyph
  uniqueness, SVG well-formedness (aria-hidden, no scripts/text, tag
  balance), 5 distinct map buckets over the 8 presets, difficulty
  chevron counts 1..5, no non-English strings. Green.
- `npx tsc --noEmit` clean for all touched files; `npm run build` clean.
- Headless Chromium screenshots (1600×1000, `~/workspace/novaterra-ui-icons/`):
  `menu.png`, `skirmish-setup.png`, `hud-train-infantry.png`,
  `hud-navy-industry.png` — all show icon + text, no layout overlap
  (an apparent text-doubling in one early navy capture was a transient
  compositor artifact; DOM measurements and re-captures confirm clean
  layout).

## Screenshot tooling notes (environment, 2026-09-30)

Kept in `~/workspace/novaterra-ui-icons/work/` (NOT /tmp — tmpfs is wiped
on reboot): `driver.mjs` (CDP screenshot driver), `start-chrome.sh`,
`prep-site.sh` (rewrites the `/novaterra/` vite base to `./` in a
`file://` copy of `game/dist`).

- Chromium 152 blocks `localhost` navigations (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`);
  `--disable-features=LocalNetworkAccessChecks` does not lift it. Use `file://`.
- `file://` needs `--allow-file-access-from-files` for module scripts.
- Always launch with a FRESH profile: a reused profile once wedged
  `file://` module loading (`net::ERR_FAILED` on every module script).
- Kill Chrome by exact PID from the pidfile/ss — never `pkill -f` with a
  pattern that also appears in your own command line (it SIGKILLs your
  own shell).
