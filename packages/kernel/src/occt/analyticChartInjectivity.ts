/**
 * Premise P4 of DECISION.md (AUTHOR-ONLY, UNEXECUTED candidate, not yet wired into analysisSurfaceCertificate.ts):
 * an analytic face chart must lie inside one injectivity domain of its local primitive parameterization, so that the
 * t=1 end of the homotopy is the trimmed CAD face with degree exactly 1 (a chart lifted across more than one period
 * would make the chain a multiple of the face while every local 2D check still passes).
 *
 * Parameterizations are those of analyticSurfaceInterval (boundary-06 K 574-608): u is the angle around the axis for
 * cylinder/cone/sphere/torus; sphere v is latitude; cone radius is referenceRadius + v*sin(semiAngle); torus v is the
 * minor angle. Closed full revolutions are allowed: their two seam lifts are distinct boundary occurrences that the
 * native seam ledger pairs. A pole/apex may only be a chart boundary value that the caller has bound to the native
 * degenerate vertex; it may never be interior.
 */

/** Largest double not above the true value: 2*pi and pi/2 as doubles are below the exact constants. */
const TWO_PI_BELOW = 6.283185307179586;
const HALF_PI_BELOW = 1.5707963267948966;

export interface AnalyticChartExtent {
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
}

export type AnalyticInjectivitySurface =
  | { readonly kind: 'plane' }
  | { readonly kind: 'cylinder' }
  | { readonly kind: 'sphere' }
  | { readonly kind: 'torus' }
  | { readonly kind: 'cone'; readonly referenceRadius: number; readonly semiAngle: number };

/** Native degenerate boundary values bound by the caller to the actual pole/apex vertex (never inferred here). */
export interface AnalyticPoleBinding {
  readonly atMinV: boolean;
  readonly atMaxV: boolean;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error('analytic-chart: nonfinite ' + label);
  return value;
}

/** Exact value of a finite double as mantissa * 2^(exponent), exponent >= -1074 (subnormals included). */
function exactDouble(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = (bits >> 63n) === 1n;
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (biased === 0x7ff) throw new Error('analytic-chart: nonfinite double');
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  return { mantissa: negative ? -mantissa : mantissa, exponent };
}

/** Exact test that (high - low) <= limit for doubles; no rounded operation decides the result. */
function spanAtMost(low: number, high: number, limit: number): boolean {
  const values = [exactDouble(high), exactDouble(low), exactDouble(limit)];
  const base = Math.min(...values.map(value => value.exponent));
  const [h, l, m] = values.map(value => value.mantissa << BigInt(value.exponent - base));
  return h >= l && h - l <= m;
}

/** Adjacent doubles by bit stepping (finite inputs only); used for outward rounding of single operations. */
function nextUp(value: number): number {
  if (value === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}
const nextDown = (value: number): number => -nextUp(-value);
const up = (value: number): number => nextUp(finite(value, 'rounded value'));
const down = (value: number): number => nextDown(finite(value, 'rounded value'));

/**
 * Rigorous enclosure of sin(x) for 0 < |x| <= pi/2 without Math.sin (C line 48):
 * x - x^3/6 <= sin x <= x - x^3/6 + x^5/120 (alternating Taylor series, terms decreasing for x <= pi/2).
 * Each rounded operation is pushed one ulp outward.
 */
function sinEnclosure(x: number): readonly [number, number] {
  const magnitude = Math.abs(x);
  const square = [down(magnitude * magnitude), up(magnitude * magnitude)] as const;
  const cube = [down(square[0] * magnitude), up(square[1] * magnitude)] as const;
  const fifth = up(up(cube[1] * square[1]) / 120);
  const low = Math.max(0, down(magnitude - up(cube[1] / 6)));
  const high = Math.min(magnitude, up(up(magnitude - down(cube[0] / 6)) + fifth));
  return x > 0 ? [low, high] : [-high, -low];
}

/** Outward enclosure of referenceRadius + v*sin(semiAngle), deciding only signs that survive the enclosure. */
function coneRadiusSigns(surface: { referenceRadius: number; semiAngle: number }, v: number): { surelyPositive: boolean; surelyNegative: boolean } {
  const [lowS, highS] = sinEnclosure(surface.semiAngle);
  const products = [v * lowS, v * highS];
  const low = down(surface.referenceRadius + down(Math.min(...products)));
  const high = up(surface.referenceRadius + up(Math.max(...products)));
  return { surelyPositive: low > 0, surelyNegative: high < 0 };
}

export function assertAnalyticChartInjective(surface: AnalyticInjectivitySurface, extent: AnalyticChartExtent,
  poles: AnalyticPoleBinding): void {
  const minU = finite(extent.minU, 'minU'), maxU = finite(extent.maxU, 'maxU');
  const minV = finite(extent.minV, 'minV'), maxV = finite(extent.maxV, 'maxV');
  if (!(maxU >= minU) || !(maxV >= minV)) throw new Error('analytic-chart: inverted extent');
  if (surface.kind === 'plane') {
    if (poles.atMinV || poles.atMaxV) throw new Error('analytic-chart: plane has no pole');
    return;
  }
  if (!spanAtMost(minU, maxU, TWO_PI_BELOW)) throw new Error('analytic-chart: u lift exceeds one period');
  switch (surface.kind) {
    case 'cylinder':
      if (poles.atMinV || poles.atMaxV) throw new Error('analytic-chart: cylinder has no pole');
      return;
    case 'torus':
      if (poles.atMinV || poles.atMaxV) throw new Error('analytic-chart: torus has no pole');
      if (!spanAtMost(minV, maxV, TWO_PI_BELOW)) throw new Error('analytic-chart: v lift exceeds one period');
      return;
    case 'sphere': {
      if (minV < -HALF_PI_BELOW || maxV > HALF_PI_BELOW) throw new Error('analytic-chart: latitude crosses a pole');
      if (poles.atMinV !== (minV === -HALF_PI_BELOW) || poles.atMaxV !== (maxV === HALF_PI_BELOW)) {
        throw new Error('analytic-chart: pole boundary not bound to the native pole vertex');
      }
      return;
    }
    case 'cone': {
      finite(surface.referenceRadius, 'cone radius'); finite(surface.semiAngle, 'cone angle');
      if (!(Math.abs(surface.semiAngle) > 0 && Math.abs(surface.semiAngle) < HALF_PI_BELOW)) {
        throw new Error('analytic-chart: unsupported cone angle');
      }
      // Radius is linear in v: positive on the open chart iff each end is positive or is the bound apex.
      for (const [v, bound] of [[minV, poles.atMinV], [maxV, poles.atMaxV]] as const) {
        const sign = coneRadiusSigns(surface, v);
        if (sign.surelyNegative) throw new Error('analytic-chart: chart crosses the cone apex');
        if (!sign.surelyPositive && !bound) throw new Error('analytic-chart: unresolved apex not bound to native vertex');
        if (sign.surelyPositive && bound) throw new Error('analytic-chart: apex binding at a nonzero radius');
      }
      if (minV === maxV) throw new Error('analytic-chart: empty cone chart');
      return;
    }
  }
}
