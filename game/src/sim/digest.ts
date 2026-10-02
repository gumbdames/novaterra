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
import { POLICY_IDS, BUILDING_DEFS } from './city';
import { fnv1a32 } from './rng';

/**
 * Re-export: the canonical home of `fnv1a32` is sim/rng.ts (an acyclic
 * leaf). digest.ts used to define it, which pulled terrain.ts and city.ts
 * into a value-import cycle with digest (roadmap A8, 2026-10-01); the
 * definition moved so digest stays out of the core cycle group. Existing
 * importers of `fnv1a32` from this module (e.g. tests/sim.digest.test.ts)
 * keep working.
 */
export { fnv1a32 };

/** Canonical float encoding: shortest round-trip, -0 normalized. */
function canonicalNumber(n: number): string {
  return n === 0 ? '0' : String(n);
}

/**
 * Sparse index list for 0/1 flag arrays (closed, waitMark): only the set
 * indices join. Cheap when the build is young (few popped cells); bounded
 * by the cell count in the worst case.
 */
function sparseIndexList(flags: number[]): string {
  const idx: number[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === 1) idx.push(i);
  }
  return idx.join('.');
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
  // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): the peaceful
  // flag is behavior-affecting (command lockout + victory routing) ⇒
  // digest-covered (PLAN §11). `?? false` keeps hand-built fixture
  // worlds (which predate the field) digesting identically.
  out += `|peaceful=${world.peaceful === true ? 1 : 0}|`;
  // Roadmap B2 (2026-10-02): the victory kind is behavior-affecting
  // (victory routing) ⇒ digest-covered (PLAN §11). `?? 'conquest'`
  // keeps hand-built fixture worlds (which predate the field)
  // digesting identically.
  out += `|victoryKind=${world.victoryKind ?? 'conquest'}|`;
  // Roadmap B3 (2026-10-02): diplomacy is behavior-affecting
  // (ceasefire gates AI attacks; disposition drives AI verdicts) ⇒
  // digest-covered (PLAN §11). The `??` chain keeps hand-built fixture
  // worlds (which predate the field) digesting identically.
  {
    const d = world.diplomacy;
    const parties = d?.parties;
    out +=
      `|diplomacy=${d?.disposition ?? 50},${d?.ceasefireUntilTick ?? 0},` +
      `${d?.totalTributeSent ?? 0},${d?.totalTributeReceived ?? 0},` +
      `${d?.demandsRefused ?? 0},${d?.lastDemand ?? '-'},${d?.lastDemandAmount ?? 0},` +
      `${d?.lastCeasefireAsk ?? '-'},` +
      `${parties ? `${parties.owner}:${parties.aiOwner}` : '-'}|`;
  }
  // Fun-audit B2 (2026-10-02): the wonder countdown is
  // behavior-affecting (it decides race victories) ⇒ digest-covered.
  // `?? null` keeps hand-built fixture worlds (which predate the field)
  // digesting identically.
  {
    const w = world.wonderCountdown ?? null;
    out += `|wonder=${w === null ? '-' : `${w.kind},${w.leader},${w.endsAtTick}`}|`;
  }
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
  // Phase 4 (S7, v7): roads serialize with their class (cell:cls) and
  // the new rail layer gets its own segment — both sorted by cell, so
  // the digest stays canonical. A class change or a re-rail changes
  // the digest (behavior-affecting, as it should).
  out += `roads=${world.city.roads.map((r) => `${r.cell}:${r.cls}`).join(',')};`;
  out += `rails=${(world.city.rails ?? []).map((r) => `${r.cell}:${r.cls}`).join(',')};`;
  // Phase 2: utility conductors + topology epoch (derived model itself
  // is not digested — it is a pure function of these inputs).
  out += `powerLines=${(world.city.powerLines ?? []).join(',')};`;
  out += `pipes=${(world.city.pipes ?? []).join(',')};`;
  out += `utilityEpoch=${world.city.utilityEpoch ?? 0};`;
  out += `zones=${world.city.zones.map((z) => `${z.cell}:${z.zone}`).join(',')};`;
  out += `nextBldg=${world.city.nextBuildingId}|`;
  for (const b of world.city.buildings) {
    out += `b${b.id},${b.kind},${b.owner},${b.cx},${b.cz},${b.facing},`;
    out += `${canonicalNumber(b.progress)},${b.level},`;
    out += `${b.operational ? 1 : 0},${b.powered ? 1 : 0},${b.watered ? 1 : 0},`;
    // Final-review R2 (2026-10-01): structural HP — destruction is
    // behavior-affecting ⇒ digest-covered (PLAN §11). Buildings are in
    // placement (id) order; floats use canonicalNumber. Legacy decode
    // default is the def's full HP (snapshot.ts), so pre-R2 saves
    // digest stably.
    out += `${canonicalNumber(b.hp ?? BUILDING_DEFS[b.kind].hp)},${canonicalNumber(b.maxHp ?? BUILDING_DEFS[b.kind].hp)},`;
    // Phase 2 utility diagnostics (legacy decode default 'disconnected').
    out += `${b.powerDiag ?? 'disconnected'},${b.waterDiag ?? 'disconnected'},`;
    // Phase 3 logistics stocks, plus the Half-B materials stock
    // (integers; legacy decode default 0).
    out += `${b.ammoStock ?? 0},${b.fuelStock ?? 0},${b.materialsStock ?? 0},`;
    // Phase 3 resupply reservations (legacy decode default 0).
    out += `${b.reservedAmmo ?? 0},${b.reservedFuel ?? 0},`;
    // Workstream M: meltdown outage state (legacy decode default 0).
    out += `${b.meltdownUntilTick ?? 0},`;
    // Grand-expansion Phase 6 (S6 intel): sabotage outage state
    // (legacy decode default 0). Behavior-affecting (sabotaged
    // buildings produce nothing) ⇒ digest-covered (PLAN §11).
    out += `${b.sabotagedUntil ?? 0},`;
    // Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30):
    // mixed-airport discovery state — display-affecting (a revealed
    // airport reads as mixed to the discovering viewer) ⇒
    // digest-covered (PLAN §11). `viewer:revealedFlag:warnedTick:
    // revealedTick` per record, viewer order; legacy decode default is
    // no records (the empty string).
    out += `${(b.discovery ?? []).map((d) => `${d.viewer}:${d.state === 'revealed' ? 1 : 0}:${d.warnedTick}:${d.revealedTick}`).join('.')},`;
    // Phase 4 occupancy + variety (2026-09-30): behavior-affecting
    // (occupancy) and selection-panel-visible (variant), so both are
    // digest-covered (legacy decode defaults 0/0/0/1).
    out += `${b.residents ?? 0},${b.workers ?? 0},${b.variant ?? 0},${b.sizeTier ?? 1},`;
    // v8 (grand-expansion Phase 5/6, S4): hangar slots — parked aircraft
    // change what the building can do ⇒ digest-covered (PLAN §11).
    // Legacy decode default: the airfield's 6 generic slots /
    // undefined — digests of legacy saves are stable because the
    // default is deterministic, not because the slots are absent.
    out += `${(b.hangars ?? []).map((s) => `${s.cls}:${s.occupant}`).join('.')};`;
  }
  out += '|players:';
  for (const p of world.city.players) {
    out += `p${p.id},${p.name},${canonicalNumber(p.funds)},${canonicalNumber(p.materials)},`;
    out += `${canonicalNumber(p.fuel)},${canonicalNumber(p.food)},${canonicalNumber(p.research)},`;
    out += `${canonicalNumber(p.goods)},${canonicalNumber(p.influence)},${canonicalNumber(p.manpower)},`;
    out += `${p.taxRates.join(',')},${p.population},${p.specialization};`;
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
    // per-player intel asset counters — behavior-affecting (they fund
    // infiltrate/sabotage missions) ⇒ digest-covered (PLAN §11).
    const intel = p.intel ?? { surveillance: 0, operational: 0, counterIntel: 0 };
    out += `|intel${p.id}=${canonicalNumber(intel.surveillance)},${canonicalNumber(intel.operational)},${canonicalNumber(intel.counterIntel)};`;
    // Grand-expansion Phase 8 (civilian ordinances, workstream E,
    // 2026-09-30): policy toggles are behavior-affecting (they change
    // funding, desirability, production, migration) ⇒ digest-covered
    // (PLAN §11). Toggled-on ids in POLICY_IDS order; fundedPolicies is
    // NOT digested (pure function of funds + toggles + buildings, which
    // are all covered). Legacy saves decode policies to {} (the empty
    // string).
    const policies = p.policies ?? {};
    out += `|pol${p.id}=${POLICY_IDS.filter((pid) => policies[pid] === true).join(',')};`;
  }
  out += `|shortage=${world.city.foodShortage ? 1 : 0}`;
  // Trade routes: owner→partner pairs in establishment order.
  out += `|trade=${world.city.tradeRoutes.map((r) => `${r.owner}>${r.partner}@${r.establishedTick}`).join(',')};`;
  // Grand-expansion Phase 5 (S5, 2026-09-30): airline routes — route
  // income is behavior-affecting ⇒ digest-covered (PLAN §11).
  // Establishment order; legacy saves decode to [] (the empty string).
  out += `|airline=${(world.city.airlineRoutes ?? []).map((r) => `${r.id}:${r.owner}:${r.from}>${r.to}@${r.establishedTick}`).join(',')}`;
  // Final-review R6 (L1, 2026-10-01): the route-id counter drives the
  // NEXT route's id, so two worlds with identical routes but different
  // counters diverge the moment a new route is established —
  // behavior-affecting ⇒ digest-covered.
  out += `,nextId=${world.city.nextAirlineRouteId ?? 1};`;
  // Civilian sea trade (Half A, 2026-10-01): sea routes — per-voyage
  // income is behavior-affecting ⇒ digest-covered (PLAN §11).
  // Establishment order; legacy saves decode to [] (the empty string).
  // The id counter drives the NEXT route's id ⇒ covered (the R6
  // nextAirlineRouteId precedent).
  out += `|sea=${(world.city.seaRoutes ?? []).map((r) => `${r.id}:${r.owner}:${r.from}>${r.to}:${r.policy}@${r.establishedTick}`).join(',')}`;
  out += `,nextSeaId=${world.city.nextSeaRouteId ?? 1};`;
  // Units: spawn order; floats canonicalized. failReason is a plain string.
  out += `|units=${world.units.length}|`;
  for (const u of world.units) {
    out += `u${u.id},${u.kind},${u.owner},${canonicalNumber(u.x)},${canonicalNumber(u.z)},`;
    out += `${u.domain},${canonicalNumber(u.hp)},${u.cooldownLeft},${u.targetId},${u.chasing ? 1 : 0},`;
    // Final-review R2 (2026-10-01): siege target linkage — which
    // building this unit is ordered to destroy changes behavior ⇒
    // digest-covered (PLAN §11). Legacy decode default 0.
    out += `${u.buildingTargetId ?? 0},`;
    out += `${canonicalNumber(u.speed)},${u.state},${u.failReason ?? ''},`;
    out += `${canonicalNumber(u.destX)},${canonicalNumber(u.destZ)},`;
    out += `${canonicalNumber(u.arriveX)},${canonicalNumber(u.arriveZ)},`;
    out += `${u.path.join('.')},${u.pathAt},${u.fieldId},${u.xp ?? 0},${u.vetLevel ?? 0},`;
    // Phase 3 logistics (floats via canonicalNumber; services as 3 bits,
    // absent = all on). Behavior-affecting ⇒ digest-covered (PLAN §11).
    const svc = u.supplyServices ?? { repair: true, rearm: true, refuel: true };
    out += `${canonicalNumber(u.fuel ?? 0)},${canonicalNumber(u.ammo ?? 0)},`;
    out += `${svc.repair ? 1 : 0}${svc.rearm ? 1 : 0}${svc.refuel ? 1 : 0},`;
    // Phase 3 resupply linkage (0 = none) + the exact reserved amounts
    // (workstream 3: per-unit reservation ledger — released exactly on
    // fulfill/timeout/death/demolish; floats via canonicalNumber).
    out += `${u.resupplyDepotId ?? 0},`;
    out += `${canonicalNumber(u.resupplyReservedAmmo ?? 0)},${canonicalNumber(u.resupplyReservedFuel ?? 0)},`;
    // Phase 3 cargo holds, plus the sea-logistics materials hold (floats
    // via canonicalNumber; legacy decode 0). Behavior-affecting ⇒
    // digest-covered (PLAN §11).
    out += `${canonicalNumber(u.cargoFuel ?? 0)},${canonicalNumber(u.cargoAmmo ?? 0)},${canonicalNumber(u.cargoMaterials ?? 0)},`;
    // Civilian sea trade (2026-10-01): the sea-route assignment
    // (0 = unassigned, leg absent = no route). Behavior-affecting ⇒
    // digest-covered.
    out += `${u.seaRouteId ?? 0},${u.seaRouteLeg ?? '-'},`;
    // Phase 4 (S7): the ferry's shipping lane (endpoints via
    // canonicalNumber, leg as a/b; absent = no route). Behavior-
    // affecting ⇒ digest-covered.
    const r = u.route;
    out += r === undefined
      ? '-'
      : `${canonicalNumber(r.ax)},${canonicalNumber(r.az)},${canonicalNumber(r.bx)},${canonicalNumber(r.bz)},${r.leg},`;
    // v8 (grand-expansion Phase 5/6, S4): hangar parking + carrier embark
    // state. 0 = unparked / unembarked (the legacy decode default).
    // Behavior-affecting (parked/embarked units are skipped by target
    // acquisition and move with their carrier) ⇒ digest-covered.
    out += `${u.hangarBuildingId ?? 0},${u.embarkedOn ?? 0},`;
    // v8 (grand-expansion Phase 6, S6 intel): spy mission state (0 = no
    // mission / unembedded / unspotted — the legacy decode default).
    // Behavior-affecting (embedded spies steal tech, spotted spies are
    // targetable) ⇒ digest-covered (PLAN §11).
    out += `${u.missionEndsAt ?? 0},${u.missionTargetId ?? 0},${u.infiltrationProgress ?? 0},`;
    out += `${u.embeddedIn ?? 0},${u.spottedUntil ?? 0};`;
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
    out += `${ab.dist.map(canonicalNumber).join(',')},`;
    // Final-review R6 (L1, 2026-10-01): the Dijkstra heap internals are
    // behavior-affecting — the (cell, priority, tie) frontier entries
    // plus the tie counter decide which cell pops next, so they change
    // how many ticks the build takes and, via early-exit timing, the
    // finished field's directions. closed/waitMark join as sparse index
    // lists (dense joins of two more 65k arrays would triple the
    // mid-flood digest cost).
    out += `heap=${ab.heapCells.join('.')}:${ab.heapPris.map(canonicalNumber).join('.')}:${ab.heapTies.join('.')},`;
    out += `closed=${sparseIndexList(ab.closed)},wait=${sparseIndexList(ab.waitMark)};`;
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
    const vb = p.virtualBuildings ?? { completed: [], constructing: null };
    out += `vb=${[...vb.completed].sort().join(',')}|`;
    out += vb.constructing ? `${vb.constructing.kind}:${vb.constructing.readyTick},` : '-,';
    out += `nav=${p.navalStatus ?? 'unknown'},${p.navalProbeIndex ?? 0},`;
    out += p.navalWater
      ? `${canonicalNumber(p.navalWater.x)},${canonicalNumber(p.navalWater.z)},`
      : '-,';
    out += `${p.seenSubmarine ? 1 : 0},`;
    // A2 (2026-10-01): latched seen-building IDs. Behavior-affecting
    // (siege/spy targeting reads the latch) ⇒ digest-covered.
    out += `sb=${(p.seenBuildingIds ?? []).join('.')},`;
    // Phase 3 logistics (workstream 3): virtual depot stocks. Behavior-
    // affecting (they refill AI units) ⇒ digest-covered (PLAN §11).
    out += `vls=${canonicalNumber(p.virtualAmmoStock ?? 0)},${canonicalNumber(p.virtualFuelStock ?? 0)},`;
    // C1 (AI physical forward base, 2026-10-02): the tracked
    // forward-depot buildings — behavior-affecting (they gate stock
    // accrual and rebuilds) ⇒ digest-covered (PLAN §11).
    out += `fd=${(p.forwardDepots ?? []).map((e) => `${e.kind}:${e.buildingId}:${e.destroyedTick}`).join('.')},`;
    // Final-review R2-B (AI siege doctrine): the quiet-think counter
    // drives when a siege starts and the target id drives where the
    // force converges — both behavior-affecting ⇒ digest-covered.
    out += `sie=${p.siegeQuietThinks ?? 0},${p.siegeTargetBuildingId ?? 0},`;
    // Grand-expansion Phase 7 (AI intel play): the virtual intel queue —
    // construction slot, surge latch, and ordered-op counts all drive
    // future behavior ⇒ digest-covered (PLAN §11).
    const aiIntel = p.intel;
    out += `int=${aiIntel?.constructing ? `${aiIntel.constructing.kind}:${aiIntel.constructing.readyTick}` : '-'},`;
    out += `${aiIntel?.counterIntelSurge ? 1 : 0},`;
    out += `${aiIntel?.ops.infiltrate ?? 0}.${aiIntel?.ops.sabotage ?? 0}.${aiIntel?.ops.steal ?? 0},`;
    // Personality (per-match seeded playstyle): covered so same-seed
    // replays digest identically and different seeds digest differently.
    const pers = p.personality;
    if (pers) {
      out += `pers=${canonicalNumber(pers.aggression)},${canonicalNumber(pers.expansionEagerness)},`;
      out += `${pers.attackEveryNthThink},${pers.expansionUnitThreshold},${pers.scoutStartIndex},`;
      out += `${canonicalNumber(pers.expansionAngle)},`;
      const mwKeys = Object.keys(pers.mixWeights).sort();
      out += `mw=${mwKeys.map((k) => `${k}:${canonicalNumber(pers.mixWeights[k] as number)}`).join('.')},`;
      out += `ro=${pers.researchOrder.join('.')},`;
    } else {
      out += 'pers=-,';
    }
    const keys = Object.keys(p.builtCounts).sort();
    out += keys.map((k) => `${k}:${p.builtCounts[k]}`).join(',') + ';';
  }
  // Ages: per-side (roadmap A1, 2026-10-01) — current age + chosen
  // National Program for every owner that has age state, owner-id
  // sorted for determinism. Owners with no entry are Foundation.
  const ageOwners = Object.keys(world.ages).map(Number).sort((a, b) => a - b);
  for (const o of ageOwners) {
    const st = world.ages[o];
    if (!st) continue;
    out += `|ages=${o}:${st.age},${st.program ?? '-'}|`;
    // Programs chosen for past ages (sorted for determinism).
    const progEntries = Object.entries(st.programs).sort(([a], [b]) => a < b ? -1 : 1);
    out += `|agePrograms=${o}:`;
    for (const [age, prog] of progEntries) {
      out += `${age}:${prog};`;
    }
    out += '|';
  }
  // Delegation: mayors then generals, in assignment order.
  out += '|deleg=';
  for (const m of world.delegation.mayors) {
    // buildPolicy is sim write-only today (only the HUD reads it), but it
    // is plain state the snapshot covers — encoding it here keeps the
    // "snapshotted ⇒ digested" invariant whole for a trivial cost.
    // Behavior-affecting when the mayor system consumes it ⇒
    // digest-covered (PLAN §11).
    out += `m${m.owner}:${m.policy}:${m.buildPolicy};`;
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
  // Upgrades: per-owner id lists, owners sorted numerically, ids sorted
  // (research appends, so world lists are already sorted — sort defensively
  // for hand-built states). Missing owners digest as empty.
  out += '|upg=';
  const upgradeOwners = Object.keys(world.upgrades ?? {})
    .map(Number)
    .sort((a, b) => a - b);
  for (const owner of upgradeOwners) {
    const ids = [...(world.upgrades[owner] ?? [])].sort();
    out += `u${owner}:${ids.join(',')};`;
  }
  out += '|';
  // Roadmap B9: repeatable-upgrade levels — behavior-affecting (factory
  // output) ⇒ digest-covered. Owners sorted numerically, ids sorted;
  // missing owners / zero levels digest as empty.
  out += '|upglvl=';
  const levelOwners = Object.keys(world.upgradeLevels ?? {})
    .map(Number)
    .sort((a, b) => a - b);
  for (const owner of levelOwners) {
    const ids = Object.keys(world.upgradeLevels[owner] ?? {}).sort();
    const parts = ids.map((id) => `${id}=${world.upgradeLevels[owner]?.[id] ?? 0}`);
    out += `u${owner}:${parts.join(',')};`;
  }
  out += '|';
  return out;
}

/** Deterministic 32-bit digest of the world state. */
export function digestWorld(world: World): number {
  return fnv1a32(canonicalizeWorld(world));
}
