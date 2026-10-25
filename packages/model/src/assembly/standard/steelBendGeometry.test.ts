import { describe, expect, it } from 'vitest';

import { STEEL_PRODUCTS } from './steelCatalog.js';
import { planSteelBend, steelBendSection, type SteelBendDimensions, type SteelBendSection } from './steelBendGeometry.js';

// W05: independent input boundaries. In particular, a rectangle's enclosing radius
// is not its projected half width; the conservative native sweep criterion uses both.
const rejectionBoundaries = [
  { name: 'nonfinite radius', key: 'SGP:steelPipe:15A', bad: { radius: Infinity }, good: { radius: 30 }, reason: 'invalidRadius', offset: 10.85, width: 21.7 },
  { name: 'nonpositive inside radius', key: 'SGP:steelPipe:15A', bad: { radius: 0 }, good: { radius: 1e-9 }, reason: 'invalidRadius', offset: 10.85, width: 21.7 },
  { name: 'zero first leg', key: 'SS400:flatBar:FB 50×6', bad: { firstLeg: 0 }, good: { firstLeg: 1e-9 }, reason: 'invalidLength', offset: 25, width: 50 },
  { name: '180 degree turn', key: 'SS400:flatBar:FB 50×6', bad: { angleDegrees: 180 }, good: { angleDegrees: 179.999 }, reason: 'invalidAngle', offset: 25, width: 50 },
  { name: 'conservative self intersection bound', key: 'SS400:flatBar:FB 50×6',
    bad: { radius: Math.hypot(50, 6) / 2 - 25 }, good: { radius: Math.hypot(50, 6) / 2 - 25 + 1e-8 }, reason: 'radiusTooTight', offset: 25, width: 50 },
  { name: 'zero tangent after setback', key: 'SS400:flatBar:FB 50×6', bad: { legDimension: 'inside', firstLeg: 30 },
    good: { legDimension: 'inside', firstLeg: 30 + 1e-8 }, reason: 'insufficientLegLength', offset: 25, width: 50 },
] satisfies readonly { name: string; key: string; bad: Partial<SteelBendDimensions>; good: Partial<SteelBendDimensions>;
  reason: string; offset: number; width: number }[];

function section(key = 'SS400:flatBar:FB 50×6'): SteelBendSection {
  const product = STEEL_PRODUCTS.find((row) => row.key === key);
  if (product === undefined) throw new Error('Missing section fixture');
  const result = steelBendSection(product);
  if (result === null) throw new Error('Unsupported section fixture');
  return result;
}
const dimensions: SteelBendDimensions = { radius: 30, radiusConvention: 'inside', angleDegrees: 90,
  firstLeg: 100, secondLeg: 200, legDimension: 'tangent' };

describe('W05 geometric refusal boundaries leave the section and input intact', () => {
  it.each(rejectionBoundaries)('$name rejects at the bound and preserves the positive side', (test) => {
    const profile = section(test.key), bad = { ...dimensions, ...test.bad }, good = { ...dimensions, ...test.good };
    const before = structuredClone({ profile, bad, good });
    expect(planSteelBend(profile, bad)).toEqual({ ok: false, reason: test.reason });
    const result = planSteelBend(profile, good);
    if (!result.ok) throw new Error(result.reason);
    const g = result.geometry, theta = good.angleDegrees * Math.PI / 180;
    const rc = good.radius + test.offset;
    const setback = good.legDimension === 'inside' ? good.radius : 0; // Both setback fixtures use exactly 90 degrees.
    const l1 = good.firstLeg - setback, l2 = good.secondLeg - setback;
    expect(g.insideRadiusMm).toBe(good.radius);
    expect(g.outsideRadiusMm).toBeCloseTo(good.radius + test.width, 11);
    expect(g.centrelineRadiusMm).toBeCloseTo(rc, 11);
    expect(g.firstTangentLengthMm).toBeGreaterThan(0);
    expect(g.firstTangentLengthMm).toBeCloseTo(l1, 11);
    expect(g.secondTangentLengthMm).toBeCloseTo(l2, 11);
    expect(g.firstTangent).toEqual([0, 0, g.firstTangentLengthMm]);
    expect(g.secondTangent[0]).toBeCloseTo(rc * (1 - Math.cos(theta)), 11);
    expect(g.secondTangent[2]).toBeCloseTo(l1 + rc * Math.sin(theta), 11);
    expect(g.end[0]).toBeCloseTo(rc * (1 - Math.cos(theta)) + l2 * Math.sin(theta), 11);
    expect(g.end[2]).toBeCloseTo(l1 + rc * Math.sin(theta) + l2 * Math.cos(theta), 11);
    expect(g.arcLengthMm).toBeCloseTo(rc * theta, 11);
    expect(g.centrelineLengthMm).toBeCloseTo(l1 + l2 + rc * theta, 11);
    expect({ profile, bad, good }).toEqual(before);
  });
});

describe('steel bend dimensions independently derived from tangent circles', () => {
  it.each([
    { direction: 0, width: 50, dx: 1, dy: 0 },
    { direction: 90, width: 6, dx: 0, dy: 1 },
    { direction: 180, width: 50, dx: -1, dy: 0 },
    { direction: 270, width: 6, dx: 0, dy: -1 },
    { direction: 45, width: 56 / Math.sqrt(2), dx: Math.SQRT1_2, dy: Math.SQRT1_2 },
  ])('fixed rectangle at $direction degrees uses projected thickness and independently oriented endpoints', ({ direction, width, dx, dy }) => {
    const result = planSteelBend(section(), { ...dimensions, directionDegrees: direction });
    if (!result.ok) throw new Error(result.reason);
    const radius = 30 + width / 2;
    expect(result.geometry.insideRadiusMm).toBe(30);
    expect(result.geometry.outsideRadiusMm).toBeCloseTo(30 + width, 11);
    expect(result.geometry.centrelineRadiusMm).toBeCloseTo(radius, 11);
    expect(result.geometry.arcCentre[0]).toBeCloseTo(dx * radius, 11);
    expect(result.geometry.arcCentre[1]).toBeCloseTo(dy * radius, 11);
    expect(result.geometry.end[0]).toBeCloseTo(dx * (radius + 200), 11);
    expect(result.geometry.end[1]).toBeCloseTo(dy * (radius + 200), 11);
    expect(result.geometry.end[2]).toBeCloseTo(100 + radius, 11);
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(300 + radius * Math.PI / 2, 11);
    const outside = planSteelBend(section(), { ...dimensions, directionDegrees: direction,
      radius: 30 + width, radiusConvention: 'outside' });
    if (!outside.ok) throw new Error(outside.reason);
    expect(outside.geometry.insideRadiusMm).toBeCloseTo(30, 11);
    expect(outside.geometry.centrelineLengthMm).toBeCloseTo(result.geometry.centrelineLengthMm, 11);
  });

  it('keeps omitted and periodic zero byte-compatible and canonicalizes equivalent directions', () => {
    const old = planSteelBend(section(), dimensions);
    for (const directionDegrees of [0, -0, 360, -720]) {
      expect(planSteelBend(section(), { ...dimensions, directionDegrees })).toEqual(old);
    }
    expect(planSteelBend(section(), { ...dimensions, directionDegrees: -90 }))
      .toEqual(planSteelBend(section(), { ...dimensions, directionDegrees: 630 }));
  });

  it.each(['inside', 'outside'] as const)('90 degree direction retains %s leg setback and strict zero-leg refusal', (legDimension) => {
    const setback = legDimension === 'inside' ? 30 : 36;
    const result = planSteelBend(section(), { ...dimensions, directionDegrees: 90, legDimension,
      firstLeg: 100 + setback, secondLeg: 200 + setback });
    if (!result.ok) throw new Error(result.reason);
    expect(result.geometry.firstTangentLengthMm).toBeCloseTo(100, 12);
    expect(result.geometry.secondTangentLengthMm).toBeCloseTo(200, 12);
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(300 + 33 * Math.PI / 2, 12);
    expect(planSteelBend(section(), { ...dimensions, directionDegrees: 90, legDimension,
      firstLeg: setback, secondLeg: 200 + setback })).toEqual({ ok: false, reason: 'insufficientLegLength' });
  });

  it('uses the rounded L tip interior extremum at 45 degrees and reverses its asymmetric centroid offset', () => {
    const k = 1 - Math.PI / 4;
    const area = 564 + k * (6.5 ** 2 - 2 * 4.5 ** 2);
    const centroid = (8292 + k * 6.5 ** 2 * 12.5 - 6.5 ** 3 / 6
      - k * 4.5 ** 2 * 47 - 4.5 ** 3 / 3) / area;
    // Tip circle center (45.5,1.5), radius4.5; 45deg support lies inside its quarter arc.
    const support45 = 47 / Math.sqrt(2) + 4.5;
    for (const [directionDegrees, width, offset] of [
      [0, 50, 50 - centroid], [180, 50, centroid],
      [45, support45, support45 - Math.SQRT2 * centroid], [225, support45, Math.SQRT2 * centroid],
    ]) {
      const result = planSteelBend(section('SS400:equalAngle:L 50×50×6'),
        { ...dimensions, radius: 100, directionDegrees });
      if (!result.ok) throw new Error(result.reason);
      expect(result.geometry.outsideRadiusMm).toBeCloseTo(100 + width, 10);
      expect(result.geometry.centrelineRadiusMm).toBeCloseTo(100 + offset, 10);
    }
  });

  it.each([0, 45, 90, 180, 270, -315])('pipe circular support is invariant at %s degrees', (directionDegrees) => {
    const result = planSteelBend(section('SGP:steelPipe:15A'), { ...dimensions, directionDegrees });
    if (!result.ok) throw new Error(result.reason);
    expect(result.geometry.outsideRadiusMm).toBeCloseTo(51.7, 12);
    expect(result.geometry.centrelineRadiusMm).toBeCloseTo(40.85, 12);
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(300 + 40.85 * Math.PI / 2, 12);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite direction %s', (directionDegrees) => {
    expect(planSteelBend(section(), { ...dimensions, directionDegrees })).toEqual({ ok: false, reason: 'invalidDirection' });
  });

  it('keeps the orientation-independent tight-radius refusal and rejects degenerate directional sections', () => {
    expect(planSteelBend(section(), { ...dimensions, directionDegrees: 90, radius: 1 }))
      .toEqual({ ok: false, reason: 'radiusTooTight' });
    for (const loops of [[], [[]]]) {
      expect(planSteelBend({ ...section(), loops }, { ...dimensions, directionDegrees: 45 }))
        .toEqual({ ok: false, reason: 'invalidSection' });
    }
  });

  it('90 degrees: radius conversion, two tangent points, endpoints and arc length', () => {
    const result = planSteelBend(section(), dimensions);
    if (!result.ok) throw new Error(result.reason);
    expect(result.geometry).toMatchObject({ insideRadiusMm: 30, outsideRadiusMm: 80,
      centrelineRadiusMm: 55, firstTangentLengthMm: 100, secondTangentLengthMm: 200,
      firstTangent: [0, 0, 100], arcCentre: [55, 0, 100] });
    expect(result.geometry.secondTangent[0]).toBeCloseTo(55, 12);
    expect(result.geometry.secondTangent[2]).toBeCloseTo(155, 12);
    expect(result.geometry.end[0]).toBeCloseTo(255, 12);
    expect(result.geometry.end[2]).toBeCloseTo(155, 12);
    expect(result.geometry.arcLengthMm).toBeCloseTo(55 * Math.PI / 2, 12);
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(300 + 55 * Math.PI / 2, 12);
    expect(planSteelBend(section(), { ...dimensions, radius: 80, radiusConvention: 'outside' })).toEqual(result);
  });

  it.each([60, 120])('%s-degree bend uses circle endpoints and has tangent continuity at both joins', (angle) => {
    const result = planSteelBend(section(), { ...dimensions, angleDegrees: angle });
    if (!result.ok) throw new Error(result.reason);
    const { geometry: g } = result;
    const cosine = angle === 60 ? 0.5 : -0.5;
    const sine = Math.sqrt(3) / 2;
    expect(g.secondTangent[0]).toBeCloseTo(55 * (1 - cosine), 12);
    expect(g.secondTangent[2]).toBeCloseTo(100 + 55 * sine, 12);
    expect(g.end[0]).toBeCloseTo(55 * (1 - cosine) + 200 * sine, 12);
    expect(g.end[2]).toBeCloseTo(100 + 55 * sine + 200 * cosine, 12);
    const firstRadius = [g.firstTangent[0] - g.arcCentre[0], g.firstTangent[2] - g.arcCentre[2]];
    const lastRadius = [g.secondTangent[0] - g.arcCentre[0], g.secondTangent[2] - g.arcCentre[2]];
    expect(firstRadius[1]).toBe(0); // incoming +Z is perpendicular to the first radius
    expect(lastRadius[0] * g.endDirection[0] + lastRadius[1] * g.endDirection[2]).toBeCloseTo(0, 12);
    expect(Math.hypot(...lastRadius)).toBeCloseTo(55, 12);
    expect(g.arcLengthMm).toBeCloseTo(55 * Math.PI * angle / 180, 12);
  });

  it.each(['inside', 'outside'] as const)('%s virtual-intersection leg dimensions subtract that surface setback', (convention) => {
    const radius = convention === 'inside' ? 30 : 80;
    const result = planSteelBend(section(), { ...dimensions, legDimension: convention,
      firstLeg: 100 + radius, secondLeg: 200 + radius });
    if (!result.ok) throw new Error(result.reason);
    expect(result.geometry.firstTangentLengthMm).toBeCloseTo(100, 12);
    expect(result.geometry.secondTangentLengthMm).toBeCloseTo(200, 12);
    expect(result.geometry.end[0]).toBeCloseTo(255, 12);
    expect(result.geometry.end[2]).toBeCloseTo(155, 12);
    expect(result.geometry.centrelineLengthMm).toBeCloseTo(300 + 55 * Math.PI / 2, 12);
    const sixty = planSteelBend(section(), { ...dimensions, angleDegrees: 60, legDimension: convention,
      firstLeg: 100 + radius / Math.sqrt(3), secondLeg: 200 + radius / Math.sqrt(3) });
    if (!sixty.ok) throw new Error(sixty.reason);
    expect(sixty.geometry.firstTangentLengthMm).toBeCloseTo(100, 12);
    expect(sixty.geometry.secondTangentLengthMm).toBeCloseTo(200, 12);
  });


  it.each(['inside', 'outside'] as const)('%s setback rejects both zero-leg boundaries without swallowing representable positive legs', (convention) => {
    const radius = convention === 'inside' ? 30 : 80;
    for (const angleDegrees of [60, 90, 120]) {
      // Independent exact-angle identities, not the implementation's tan calculation.
      const factor = angleDegrees === 60 ? 1 / Math.sqrt(3) : angleDegrees === 90 ? 1 : Math.sqrt(3);
      const boundary = radius * factor;
      const delta = 1e-8; // Below OCCT confusion (1e-7mm), far above double roundoff here.
      for (const leg of ['firstLeg', 'secondLeg'] as const) {
        for (const offset of [-delta, 0]) {
          expect(planSteelBend(section(), { ...dimensions, angleDegrees, legDimension: convention,
            firstLeg: boundary + 100, secondLeg: boundary + 100, [leg]: boundary + offset })).toEqual({ ok: false, reason: 'insufficientLegLength' });
        }
        const positive = planSteelBend(section(), { ...dimensions, angleDegrees, legDimension: convention,
          firstLeg: boundary + 100, secondLeg: boundary + 100, [leg]: boundary + delta });
        if (!positive.ok) throw new Error(positive.reason);
        const length = leg === 'firstLeg' ? positive.geometry.firstTangentLengthMm : positive.geometry.secondTangentLengthMm;
        expect(length).toBeGreaterThan(0);
        expect(length).toBeCloseTo(delta, 12);
      }
    }
  });

  it('uses area centroid rather than bounding-box center for the sourced rounded L', () => {
    const actual = section('SS400:equalAngle:L 50×50×6');
    // Independent decomposition: two rectangles, inner square-minus-quarter-disc addition,
    // and two outer square-minus-quarter-disc removals. No generated segments in this expectation.
    const k = 1 - Math.PI / 4;
    const expectedArea = 564 + k * (6.5 ** 2 - 2 * 4.5 ** 2);
    const expectedMoment = 50 * 6 * 25 + 6 * 44 * 3
      + k * 6.5 ** 2 * 12.5 - 6.5 ** 3 / 6
      - k * 4.5 ** 2 * (45.5 + 1.5) - 4.5 ** 3 / 3;
    const centroid = expectedMoment / expectedArea;
    expect(actual.areaMm2).toBeCloseTo(expectedArea, 10);
    expect(actual.centroid[0]).toBeCloseTo(centroid, 10);
    expect(actual.centroid[1]).toBeCloseTo(centroid, 10);
    expect(actual.centroid[0]).not.toBeCloseTo(25, 2);
    const plan = planSteelBend(actual, { ...dimensions, radius: 100 });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.geometry.centrelineRadiusMm).toBeCloseTo(150 - centroid, 10);
  });

  it('preserves actual analytic section radii, tapered channel and two concentric pipe loops', () => {
    const angle = section('SS400:equalAngle:L 50×50×6');
    const channel = section('SS400:channel:[ 100×50×5×7.5');
    const beam = section('SS400:hBeam:H 150×150×7×10');
    const radii = (input: SteelBendSection) => input.loops[0].flatMap((edge) => edge.kind === 'arc' ? [edge.radius] : []);
    expect(radii(angle)).toEqual([4.5, 6.5, 4.5]);
    expect(radii(channel).sort((a, b) => a - b)).toEqual([4, 4, 8, 8]);
    expect(radii(beam)).toEqual([8, 8, 8, 8]);
    expect(channel.centroid[1]).toBeCloseTo(50, 10);
    expect(beam.centroid[0]).toBeCloseTo(75, 10);
    expect(beam.centroid[1]).toBeCloseTo(75, 10);
    const pipe = section('SGP:steelPipe:15A');
    expect(pipe.loops).toHaveLength(2);
    expect(pipe.loops[0][0]).toMatchObject({ kind: 'arc', radius: 10.85 });
    expect(pipe.loops[1][0].kind === 'arc' ? pipe.loops[1][0].radius : NaN).toBeCloseTo(8.05, 12);
    expect(pipe.areaMm2).toBeCloseTo(Math.PI * (10.85 ** 2 - 8.05 ** 2), 12);
  });

  it.each([0, -1, 180, 360, NaN, Infinity, 1e-300])('rejects invalid/unrepresentable angle %s', (angleDegrees) => {
    expect(planSteelBend(section(), { ...dimensions, angleDegrees })).toEqual({ ok: false, reason: 'invalidAngle' });
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid radius %s', (radius) => {
    expect(planSteelBend(section(), { ...dimensions, radius })).toEqual({ ok: false, reason: 'invalidRadius' });
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid leg %s', (firstLeg) => {
    expect(planSteelBend(section(), { ...dimensions, firstLeg })).toEqual({ ok: false, reason: 'invalidLength' });
  });
  it('refuses nonpositive inside radius, insufficient straight legs and the existing conservative sweep limit', () => {
    expect(planSteelBend(section(), { ...dimensions, radius: 50, radiusConvention: 'outside' }))
      .toEqual({ ok: false, reason: 'invalidRadius' });
    expect(planSteelBend(section(), { ...dimensions, legDimension: 'outside', firstLeg: 80 }))
      .toEqual({ ok: false, reason: 'insufficientLegLength' });
    expect(planSteelBend(section(), { ...dimensions, radius: 0.01 }))
      .toEqual({ ok: false, reason: 'radiusTooTight' });
    expect(planSteelBend(section(), { ...dimensions, firstLeg: Number.MAX_VALUE, secondLeg: Number.MAX_VALUE }))
      .toEqual({ ok: false, reason: 'invalidLength' });
    expect(planSteelBend({ ...section(), centroid: [NaN, 0] }, dimensions))
      .toEqual({ ok: false, reason: 'invalidSection' });
  });
});
