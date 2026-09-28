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

/**
 * NOVATERRA — sim/digest.ts — deterministic state hash.
 *
 * Responsibilities:
 *  - Prove determinism: same seed + same commands ⇒ identical digest after
 *    N ticks. The digest is the desync detector (dev builds), the save/load
 *    integrity check, and the replay verifier.
 *  - FNV-1a 32-bit over a canonical encoding of the world. Canonical means:
 *    fixed field order, entities in array (spawn) order, RNG streams sorted
 *    by name, numbers via a canonical float encoding. No `JSON.stringify`
 *    on unordered structures anywhere in this path.
 *
 * Notes:
 *  - Float encoding uses V8's shortest-round-trip `String(n)`, which is
 *    deterministic within one engine build — exactly our determinism bar
 *    (same machine; see research §3.1). `-0` is normalized to `'0'`.
 *  - FNV-1a is not cryptographic; it only needs to be a good change
 *    detector, which 32 bits of avalanche are.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';

/** FNV-1a 32-bit hash of a string. Returns an unsigned uint32. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Canonical float encoding: shortest round-trip, -0 normalized. */
function canonicalNumber(n: number): string {
  return n === 0 ? '0' : String(n);
}

/**
 * Canonical string encoding of the world. Field order is fixed by this
 * function (not by object key order); entity order is the array's spawn
 * order; RNG stream names are sorted. Two worlds with equal sim state
 * produce byte-identical strings regardless of how they were built.
 */
export function canonicalizeWorld(world: World): string {
  let out = `novaterra/v1|tick=${world.tick}|time=${canonicalNumber(world.time)}`;
  out += `|seed=${world.seed >>> 0}|nextId=${world.nextId}|entities=${world.entities.length}|`;
  for (const e of world.entities) {
    out += `${e.id},${e.kind},${canonicalNumber(e.x)},${canonicalNumber(e.z)};`;
  }
  out += '|rng:';
  const names = Object.keys(world.rng).sort();
  for (const name of names) {
    out += `${name}=${(world.rng[name] as number) >>> 0}|`;
  }
  // City state: sorted structures serialize in canonical order already;
  // buildings are in placement (id) order; floats use canonicalNumber.
  out += '|city:';
  out += `roads=${world.city.roads.join(',')};`;
  out += `zones=${world.city.zones.map((z) => `${z.cell}:${z.zone}`).join(',')};`;
  out += `nextBldg=${world.city.nextBuildingId}|`;
  for (const b of world.city.buildings) {
    out += `b${b.id},${b.kind},${b.owner},${b.cx},${b.cz},${b.facing},`;
    out += `${canonicalNumber(b.progress)},${b.level},`;
    out += `${b.operational ? 1 : 0},${b.powered ? 1 : 0},${b.watered ? 1 : 0};`;
  }
  out += '|players:';
  for (const p of world.city.players) {
    out += `p${p.id},${p.name},${canonicalNumber(p.funds)},${canonicalNumber(p.materials)},`;
    out += `${canonicalNumber(p.fuel)},${canonicalNumber(p.food)},${canonicalNumber(p.research)},`;
    out += `${canonicalNumber(p.goods)},${canonicalNumber(p.influence)},${canonicalNumber(p.manpower)},`;
    out += `${p.taxRates.join(',')},${p.population},${p.specialization};`;
  }
  out += `|shortage=${world.city.foodShortage ? 1 : 0}`;
  // Trade routes: owner→partner pairs in establishment order.
  out += `|trade=${world.city.tradeRoutes.map((r) => `${r.owner}>${r.partner}@${r.establishedTick}`).join(',')};`;
  // Units: spawn order; floats canonicalized. failReason is a plain string.
  out += `|units=${world.units.length}|`;
  for (const u of world.units) {
    out += `u${u.id},${u.kind},${u.owner},${canonicalNumber(u.x)},${canonicalNumber(u.z)},`;
    out += `${u.domain},${canonicalNumber(u.hp)},${u.cooldownLeft},${u.targetId},${u.chasing ? 1 : 0},`;
    out += `${canonicalNumber(u.speed)},${u.state},${u.failReason ?? ''},`;
    out += `${canonicalNumber(u.destX)},${canonicalNumber(u.destZ)},`;
    out += `${canonicalNumber(u.arriveX)},${canonicalNumber(u.arriveZ)},`;
    out += `${u.path.join('.')},${u.pathAt},${u.fieldId};`;
  }
  // Pathfinding: queues in FIFO order, fields in creation order; dirs are
  // small ints so they join cheaply. The active build's dist array is
  // included (canonicalized) so digests diverge if flood progress differs.
  const pf = world.pathfinding;
  out += `|pfq=${pf.queue.map((r) => `${r.unitId}:${r.destCell}`).join(',')};`;
  out += `pffq=${pf.fieldQueue.map((r) => `${r.fieldId}:${r.destCell}:${r.unitIds.join('.')}`).join(',')};`;
  out += `nextF=${pf.nextFieldId}|`;
  const ab = pf.activeBuild;
  if (ab) {
    out += `build=${ab.fieldId},${ab.destCell},${ab.unitIds.join('.')},${ab.waitingCount},${ab.nextTie},${ab.earlyExit ? 1 : 0},`;
    out += `${ab.dist.map(canonicalNumber).join(',')};`;
  } else {
    out += `build=-;`;
  }
  for (const f of pf.fields) {
    out += `f${f.id},${f.destCell},${f.dirs.join('')};`;
  }
  // AI: players in registration order; builtCounts keys sorted.
  out += `|ai=${world.ai.players.length}|`;
  for (const p of world.ai.players) {
    out += `a${p.owner},${p.difficulty},${canonicalNumber(p.baseX)},${canonicalNumber(p.baseZ)},`;
    out += `${p.nextThinkTick},`;
    out += p.forwardBase ? `${canonicalNumber(p.forwardBase.x)},${canonicalNumber(p.forwardBase.z)},` : '-,';
    out += `${p.scoutIndex},${p.superweapons.aegisReadyTick},${p.superweapons.stormReadyTick},`;
    const keys = Object.keys(p.builtCounts).sort();
    out += keys.map((k) => `${k}:${p.builtCounts[k]}`).join(',') + ';';
  }
  // Ages: current age + chosen National Program.
  out += `|ages=${world.ages.age},${world.ages.program ?? '-'}|`;
  // Programs chosen for past ages (sorted for determinism).
  const progEntries = Object.entries(world.ages.programs).sort(([a], [b]) => a < b ? -1 : 1);
  out += '|agePrograms=';
  for (const [age, prog] of progEntries) {
    out += `${age}:${prog};`;
  }
  out += '|';
  // Delegation: mayors then generals, in assignment order.
  out += '|deleg=';
  for (const m of world.delegation.mayors) {
    out += `m${m.owner}:${m.policy};`;
  }
  for (const g of world.delegation.generals) {
    out += `g${g.owner}:${g.stance}:${g.unitIds.join('.')};`;
  }
  out += '|';
  // Superweapons: slots per player, pending strikes, live fx.
  out += '|sw=';
  for (const p of world.superweapons.players) {
    out += `s${p.owner},a${p.aegis.cooldownUntil}/${p.aegis.activeUntil},t${p.storm.cooldownUntil};`;
  }
  out += `|strikes=${world.superweapons.strikes.map((s) => `${s.owner}:${canonicalNumber(s.x)},${canonicalNumber(s.z)}@${s.atTick}`).join(',')};`;
  out += `|fx=${world.superweapons.fx.map((f) => `${f.kind}:${canonicalNumber(f.x)},${canonicalNumber(f.z)}@${f.untilTick}`).join(',')};`;
  out += '|';
  return out;
}

/** Deterministic 32-bit digest of the world state. */
export function digestWorld(world: World): number {
  return fnv1a32(canonicalizeWorld(world));
}
