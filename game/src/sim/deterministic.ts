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
 * NOVATERRA — sim/deterministic.ts — cross-engine deterministic math.
 *
 * Determinism hardening (2026-10-02). The sim's bar used to be "same bits on
 * the same engine build" (D5): IEEE-754 `+ - * /` and `Math.sqrt` are
 * correctly rounded, hence bit-identical everywhere, but the
 * implementation-approximated transcendentals (`Math.hypot/sin/cos/log10`
 * etc.) are only *specified* to be approximately correct — the ECMAScript
 * spec lets engines differ by ~1 ulp. That is the one known cross-engine
 * determinism blocker for future lockstep multiplayer
 * (docs/research/sim-architecture.md §3.1/§3.4).
 *
 * This module removes the blocker: every function here is built ONLY from
 * IEEE-754 correctly-rounded primitives (`+ - * /`, `%`, `Math.sqrt`,
 * comparisons) plus decimal literals (parsed correctly-rounded per spec).
 * The same input therefore yields the same double on every conforming
 * engine — no lookup tables seeded with `Math.sin` (that would bake one
 * engine's approximation into the "deterministic" path).
 *
 * Key invariants:
 *  - No `Math.hypot/sin/cos/tan/asin/acos/atan/exp/log/pow` anywhere in
 *    this file or in `src/sim/` (enforced by the B27 lint guard in
 *    game/scripts/check-import-cycles.mjs).
 *  - `Math.PI` is fine (a spec-fixed correctly-rounded constant).
 *  - Values intentionally differ from the old transcendental calls in the
 *    last ulps (sin/cos polynomial ≈ 1e-9 absolute error). Pinned digests
 *    that moved were rebaselined explicitly — see the determinism
 *    commit message.
 */

/** 2π, correctly rounded. */
const TAU = 6.283185307179586;
/** π/2, correctly rounded. */
const HALF_PI = 1.5707963267948966;
/** log10(2), correctly rounded. */
const LOG10_2 = 0.3010299956639812;
/** 1/ln(10), correctly rounded. */
const INV_LN10 = 0.4342944819032518;

// Taylor coefficients for sin through x^13 (1/3!, 1/5!, … as
// correctly-rounded decimal literals — never computed via division at
// module scope, so the constants are identical on every engine).
const SIN_C3 = -0.16666666666666666;
const SIN_C5 = 0.008333333333333333;
const SIN_C7 = -0.0001984126984126984;
const SIN_C9 = 2.7557319223985893e-6;
const SIN_C11 = -2.505210838544172e-8;
const SIN_C13 = 1.6059043836821613e-10;

/**
 * Squared 2D distance of the delta (dx, dz). Use when comparing against a
 * squared radius — avoids the sqrt entirely.
 */
export function dist2(dx: number, dz: number): number {
  return dx * dx + dz * dz;
}

/**
 * 2D distance of the delta (dx, dz). `Math.sqrt` of a sum of products is
 * IEEE-754 correctly rounded: same bits on every engine, unlike
 * `Math.hypot` (implementation-approximated, may differ ~1 ulp).
 */
export function dist(dx: number, dz: number): number {
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Reduce x into [-π/2, π/2] using only exact operations (`%` is the
 * IEEE-754 remainder, correctly specified; the folds use the
 * correctly-rounded `Math.PI`).
 */
function reduceToHalfPi(x: number): number {
  let r = x % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r < -Math.PI) r += TAU;
  // r ∈ [-π, π]; fold into [-π/2, π/2] via sin(π − r) = sin(r).
  if (r > HALF_PI) r = Math.PI - r;
  else if (r < -HALF_PI) r = -Math.PI - r;
  return r;
}

/**
 * Deterministic sine. Taylor polynomial through x^13 on the reduced
 * [-π/2, π/2] interval (Horner form: only `+`/`*`), absolute error
 * < 1e-9 vs the true sine — far below any gameplay threshold, and
 * bit-identical on every engine.
 */
export function detSin(x: number): number {
  const r = reduceToHalfPi(x);
  const r2 = r * r;
  return (
    r *
    (1 +
      r2 *
        (SIN_C3 +
          r2 * (SIN_C5 + r2 * (SIN_C7 + r2 * (SIN_C9 + r2 * (SIN_C11 + r2 * SIN_C13))))))
  );
}

/** Deterministic cosine, via detSin(x + π/2). Same accuracy guarantee. */
export function detCos(x: number): number {
  return detSin(x + HALF_PI);
}

/**
 * Deterministic log10 for v > 0 (mirrors `Math.log10`: 0 → -Infinity,
 * negative → NaN). Decimal exponent extraction is purely algebraic
 * (repeated `/10`, `*10`); the mantissa in [1, 2) uses the atanh series
 * ln(1+u) = 2·(w + w³/3 + …), w = u/(2+u) ∈ [0, 1/3), summed through
 * w^21/21 (error < 1e-12). No transcendental calls anywhere.
 */
export function detLog10(v: number): number {
  if (v <= 0) return v === 0 ? -Infinity : NaN;
  let k = 0;
  let m = v;
  while (m >= 10) {
    m /= 10;
    k += 1;
  }
  while (m < 1) {
    m *= 10;
    k -= 1;
  }
  // m ∈ [1, 10): extract the binary exponent, also algebraically.
  let j = 0;
  while (m >= 2) {
    m /= 2;
    j += 1;
  }
  // m ∈ [1, 2).
  const u = m - 1;
  const w = u / (2 + u);
  const w2 = w * w;
  let term = w;
  let sum = w;
  for (let n = 1; n <= 10; n++) {
    term *= w2;
    sum += term / (2 * n + 1);
  }
  return k + j * LOG10_2 + 2 * sum * INV_LN10;
}
