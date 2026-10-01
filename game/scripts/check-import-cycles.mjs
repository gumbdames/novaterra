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

// check-import-cycles: fail CI on NEW value-import cycles in game/src/sim/.
//
// ESM cycles work via live bindings, but one module-level `const`
// initialized from a cross-cycle import = an import-time TDZ crash, so the
// cycle surface must never grow silently. Type-only imports are erased at
// compile time and excluded. Any strongly-connected group (size > 1) whose
// exact member set is not in ALLOWLIST fails the run. Shrinking an
// allowlisted group (intentional cleanup) also fails — update the
// allowlist in that commit, documenting why the remaining cycles are
// intentional. Run: `node scripts/check-import-cycles.mjs` (CI runs it too).

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
const ALLOWLIST = new Set([
  'ages,ai,city,combat,commands,delegation,desirability,intel,movement,pathfinding,rail,seaTrade,shipyardRepair,superweapons,units,upgrades,utilityNetworks,variants,veterancy,world',
]);

const bad = sccs.filter((s) => !ALLOWLIST.has(s));
if (bad.length > 0) {
  console.error('NEW import cycle(s) in game/src/sim/ — failing CI:');
  for (const s of bad) console.error(`  cycle group: ${s}`);
  console.error('If intentional, document the group in scripts/check-import-cycles.mjs ALLOWLIST.');
  process.exit(1);
}
console.log(`import-cycle check OK: ${sccs.length} cycle group(s), all allowlisted.`);
