/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// check-import-cycles: fail CI on NEW value-import cycles in game/src/sim/
// AND on lint-invariant regressions (roadmap B27).
//
// ESM cycles work via live bindings, but one module-level `const`
// initialized from a cross-cycle import = an import-time TDZ crash, so the
// cycle surface must never grow silently. Type-only imports are erased at
// compile time and excluded. Any strongly-connected group (size > 1) whose
// exact member set is not in ALLOWLIST fails the run. Shrinking an
// allowlisted group (intentional cleanup) also fails — update the
// allowlist in that commit, documenting why the remaining cycles are
// intentional.
//
// Lint invariants (B27, 2026-10-02): the codebase holds zero `any` types,
// zero `!` non-null assertions, and strict + noUncheckedIndexedAccess —
// previously by convention only (tsconfig even said "enforced by
// convention + review"). This script locks them in CI: any new `any` or
// `!` in game/src, or a tsconfig that drops strict/noUncheckedIndexedAccess,
// fails the run. Run: `node scripts/check-import-cycles.mjs` (CI runs it too).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const simDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sim');
const names = new Set(readdirSync(simDir).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)));

const graph = new Map();
for (const mod of names) {
  const src = readFileSync(join(simDir, `${mod}.ts`), 'utf8');
  const deps = new Set();
  for (const m of src.matchAll(/^\s*(?:import|export)(?!\s+type\b)[^;]*?from\s*['"]\.\/([\w-]+)['"]/gm)) {
    if (names.has(m[1]) && m[1] !== mod) deps.add(m[1]);
  }
  graph.set(mod, [...deps].sort());
}

// Tarjan's algorithm: strongly-connected components of the value-import graph.
let n = 0;
const idx = new Map(), low = new Map(), stack = [], onStack = new Set(), sccs = [];
function visit(v) {
  idx.set(v, n); low.set(v, n); n++; stack.push(v); onStack.add(v);
  for (const w of graph.get(v)) {
    if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) sccs.push(comp.sort().join(','));
  }
}
for (const v of names) if (!idx.has(v)) visit(v);

// ALLOWLIST — intentional value-import cycles (roadmap A8, 2026-10-01).
// Each entry is the EXACT sorted member list of a permitted cycle group.
// 'sim-core': the deterministic sim's core systems are mutually recursive
// by design — world owns the stores, systems operate on world, defs and
// helpers cross-reference through plain-data records. Safe by discipline:
// no module-level `const` is ever initialized from a cross-cycle import
// (the lazified `getVariantKinds()` / `ai.ts` precedents in
// src/sim/AGENTS.md), and the FORBIDDEN city→commands→movement→
// pathfinding edge stays absent. Shrinking this group is welcome cleanup;
// growing it (a new member) fails CI.
// 2026-10-02 (fun-audit C3): `fog` joins sim-core — fog.ts reads the
// sight model from ai.ts (getSightDiscs, function-body use only) while
// world.ts owns the FogState store (createFogState, called inside
// createWorld, never at module level). No TDZ hazard; the shroud and
// the AI perception model share one sight source by construction.
// 2026-10-02 (fun-audit E2): `luminaries` joins sim-core — the luminary
// state lives on world (initLuminaries, called inside createWorld,
// never at module level) while ages.ts hooks the draw (maybeDrawLuminary),
// economy.ts reads the upkeep cut, and veterancy.ts reads the XP aura
// (all function-body use). No TDZ hazard; `capitalCenter` was moved to
// city.ts specifically so no luminaries→envoy edge pulls `envoy` into
// the group (envoy stays a leaf).
// 2026-10-02 (fun-audit E3): `combine` joins sim-core — the Combine
// visit state lives on world (initCombine, called inside createWorld,
// never at module level) while the system sails the freighter via
// movement.orderMoveTo (function-body use). No TDZ hazard; the freighter
// is spawned by the system, never at module level.
const ALLOWLIST = new Set([
  'ages,ai,city,combat,combine,commands,delegation,desirability,diplomacy,fog,intel,luminaries,movement,pathfinding,rail,seaTrade,shipyardRepair,superweapons,units,upgrades,utilityNetworks,variants,veterancy,world',
]);

const bad = sccs.filter((s) => !ALLOWLIST.has(s));
if (bad.length > 0) {
  console.error('NEW import cycle(s) in game/src/sim/ — failing CI:');
  for (const s of bad) console.error(`  cycle group: ${s}`);
  console.error('If intentional, document the group in scripts/check-import-cycles.mjs ALLOWLIST.');
  process.exit(1);
}
console.log(`import-cycle check OK: ${sccs.length} cycle group(s), all allowlisted.`);

// ---------------------------------------------------------------------------
// Roadmap B27: lint-invariant guards (zero `any`, zero `!`, strict config).
// ---------------------------------------------------------------------------

/** Strip comments and string literals so the English word "any" in prose
 *  and "Victory!" in UI strings never trip the guards. Single-pass state
 *  machine (regex stripping misaligns when backticks appear in comments).
 *  Template literals are removed wholesale. */
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // Newlines in stripped regions are preserved so reported line numbers
  // match the original file.
  const keepNewlines = (from, to) => {
    for (let k = from; k < to; k++) if (src[k] === '\n') out += '\n';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    // Line comment.
    if (c === '/' && d === '/') {
      const from = i;
      while (i < n && src[i] !== '\n') i++;
      keepNewlines(from, i);
      continue;
    }
    // Block comment.
    if (c === '/' && d === '*') {
      const from = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      keepNewlines(from, i);
      continue;
    }
    // String literal (', ", `) with backslash escapes.
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      const from = i;
      i++;
      while (i < n) {
        if (src[i] === '\\') i += 2;
        else if (src[i] === q) { i++; break; }
        else i++;
      }
      keepNewlines(from, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** All .ts files under game/src (not tests — tests may use looser idioms). */
function allSrcFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allSrcFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

let lintFailed = false;
// `any` as a type: after noise-stripping, the identifier `any` can only be
// the any-type (no variable is named `any`; the English word lived in
// comments/strings, now stripped).
for (const f of allSrcFiles(srcDir)) {
  const clean = stripNoise(readFileSync(f, 'utf8'));
  const m = clean.match(/\bany\b/);
  if (m) {
    const line = clean.slice(0, m.index).split('\n').length;
    console.error(`B27 lint guard: \`any\` type in ${f}:${line} — use a precise type.`);
    lintFailed = true;
  }
}
// `!` non-null assertion: postfix `!` after an identifier, `)`, or `]`,
// not followed by `=` (excludes `!=` / `!==`). Prefix logical-not (`!x`)
// has no identifier before the `!`, so it never matches.
for (const f of allSrcFiles(srcDir)) {
  const clean = stripNoise(readFileSync(f, 'utf8'));
  for (const m of clean.matchAll(/[A-Za-z0-9_$)\]]!(?!=)/g)) {
    const line = clean.slice(0, m.index).split('\n').length;
    console.error(
      `B27 lint guard: non-null assertion \`!\` in ${f}:${line} — narrow with an explicit check.`,
    );
    lintFailed = true;
  }
}
// tsconfig must keep strict + noUncheckedIndexedAccess. The file carries
// `//` comments, so strip them (string-aware) before JSON.parse.
function stripJsonComments(json) {
  let out = '';
  let i = 0;
  const n = json.length;
  while (i < n) {
    const c = json[i];
    const d = json[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && json[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(json[i] === '*' && json[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        if (json[i] === '\\') { out += json.slice(i, i + 2); i += 2; }
        else { out += json[i]; i++; if (json[i - 1] === '"') break; }
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
const tsconfigRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'tsconfig.json'),
  'utf8',
);
const tsconfig = JSON.parse(stripJsonComments(tsconfigRaw));
for (const flag of ['strict', 'noUncheckedIndexedAccess']) {
  if (tsconfig.compilerOptions?.[flag] !== true) {
    console.error(`B27 lint guard: tsconfig compilerOptions.${flag} must stay true.`);
    lintFailed = true;
  }
}
// Determinism hardening (2026-10-02): no implementation-approximated
// transcendentals in the sim. `Math.hypot/sin/cos/tan/asin/acos/atan/exp/`
// `log`/`log10`/`pow` may differ ~1 ulp across JS engines (the spec only
// requires approximate correctness), which is the one known cross-engine
// determinism blocker. Sim code must use `src/sim/deterministic.ts`
// (`dist`/`dist2`, `detSin`/`detCos`, `detLog10`) — built only from
// IEEE-754 correctly-rounded primitives. `Math.sqrt`, `Math.PI`,
// `Math.abs/min/max/floor/round/imul` stay allowed (exact or correctly
// rounded per spec). Comments/strings are stripped first, so prose about
// the ban never trips it.
for (const f of allSrcFiles(join(srcDir, 'sim'))) {
  const clean = stripNoise(readFileSync(f, 'utf8'));
  for (const m of clean.matchAll(
    /\bMath\.(hypot|sin|cos|tan|asin|acos|atan|exp|log10|log|pow)\b/g,
  )) {
    const line = clean.slice(0, m.index).split('\n').length;
    console.error(
      `B27 lint guard: transcendental \`Math.${m[1]}\` in ${f}:${line} — use src/sim/deterministic.ts.`,
    );
    lintFailed = true;
  }
}
if (lintFailed) process.exit(1);
console.log('lint-invariant check OK: zero `any`, zero `!`, strict + noUncheckedIndexedAccess.');
