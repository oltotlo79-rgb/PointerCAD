import { describe, expect, it } from 'vitest';

import { resolvePart } from '../../part/resolvePart.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { applyPlacementToPoint } from '../placementMath.js';
import { buildCircularFilletWeldGeometry, rebuildCircularFilletWeldPart, type CircularFilletWeldSection } from './circularFilletWeldGeometry.js';
import type { CircularWeldPathDefinition, CircularWeldPathEvidence } from './curvedWeldPath.js';

type CircularFilletWeldGeometry = NonNullable<ReturnType<typeof buildCircularFilletWeldGeometry>>;

function evidence(): CircularWeldPathEvidence {
  return { kind: 'circle-edge', source: { documentId: 'assembly', ownerId: 'leaf', occurrencePath: ['child', 'leaf'],
    sourceKey: 'part:revision-3', placementKey: 'pose-2', bodyFeatureId: 'revolve-1', bodyKey: 'body-7', edgeIndex: 4 },
  centerMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1],
  radiusMm: 10, parameterRange: [0, Math.PI / 2], orientation: 1 };
}
function definition(e = evidence()): CircularWeldPathDefinition {
  return { kind: 'circular-weld-path', evidence: e, intervals: [{ beadId: 'bead-a', beadSourceKey: 'bead-source-1',
    fromParameter: e.orientation === 1 ? e.parameterRange[0] : e.parameterRange[1],
    toParameter: e.orientation === 1 ? e.parameterRange[1] : e.parameterRange[0] }] };
}
function section(): CircularFilletWeldSection {
  return { beadId: 'bead-a', radialLegMm: 3, normalLegMm: 4, radialDirection: 1, normalDirection: 1 };
}
function build(d = definition(), s = section()) {
  return buildCircularFilletWeldGeometry(d, structuredClone(d.evidence), structuredClone(d.intervals), s);
}
function admitted(d = definition(), s = section()): CircularFilletWeldGeometry {
  const result = build(d, s);
  if (result === null) throw new Error('Independent circular triangle fixture refused');
  return result;
}
function planOf(g: CircularFilletWeldGeometry) {
  const resolved = resolvePart(g.part);
  expect(resolved.errors).toEqual([]);
  for (const sketch of resolved.sketches) expect(sketch.resolved.errors).toEqual([]);
  expect(resolved.steps).toHaveLength(1);
  const plan = resolved.steps[0]?.plan;
  if (plan?.kind !== 'revolve') throw new Error('Expected existing revolve plan');
  return plan;
}
function vertices(g: CircularFilletWeldGeometry): readonly Vec3[] {
  return planOf(g).profile.map(curve => {
    if (curve.kind !== 'segment') throw new Error('Expected exact triangle lines');
    return curve.from;
  });
}
function close(actual: Vec3, expected: Vec3) {
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 11));
}

describe('circular fillet geometry proposal: pure plans, no native volume claim', () => {
  it.each([1, -1] as const)('builds the radial %s meridian and independent Pappus volume 33pi/27pi', radialDirection => {
    const g = admitted(definition(), { ...section(), radialDirection });
    const plan = planOf(g), v = vertices(g);
    expect(v).toEqual([[10, 0, 0], [radialDirection === 1 ? 13 : 7, 0, 0], [10, 0, 4]]);
    expect(plan.axisOrigin).toEqual([0, 0, 0]); expect(plan.axisDirection).toEqual([0, 0, 1]);
    expect(plan.angle).toBeCloseTo(Math.PI / 2, 14);
    // Independent integral over the emitted meridian, not a builder volume result.
    const [a, b, c] = v;
    const area = Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2;
    const centroidRadius = (a[0] + b[0] + c[0]) / 3;
    expect(area).toBe(6); expect(centroidRadius).toBe(radialDirection === 1 ? 11 : 9);
    expect(plan.angle * area * centroidRadius).toBeCloseTo((radialDirection === 1 ? 33 : 27) * Math.PI, 11);
  });
  it('supports exactly one full turn with 132pi theoretical volume', () => {
    const g = admitted(definition({ ...evidence(), parameterRange: [0, 2 * Math.PI] }));
    expect(planOf(g).angle).toBeCloseTo(2 * Math.PI, 14);
    expect(g.part.solids[0]?.kind).toBe('revolve');
    expect(6 * 11 * planOf(g).angle).toBeCloseTo(132 * Math.PI, 11);
  });
  it.each([1, -1] as const)('keeps partial range and normal-side geometry under traversal %s', orientation => {
    const g = admitted(definition({ ...evidence(), orientation, parameterRange: [Math.PI / 2, Math.PI] }));
    expect(g.path.definition.evidence.parameterRange).toEqual([Math.PI / 2, Math.PI]);
    expect(planOf(g).axisDirection).toEqual([0, 0, orientation]);
    const start = orientation === 1 ? [0, 10, 0] : [-10, 0, 0];
    close(applyPlacementToPoint(g.placement, [10, 0, 0]), [start[0], start[1], start[2]]);
    close(applyPlacementToPoint(g.placement, [10, 0, 4]), [start[0], start[1], 4]);
    // The terminal local radial is rotated by +/-pi/2 before world placement.
    close(applyPlacementToPoint(g.placement, [0, orientation * 10, 0]), orientation === 1 ? [-10, 0, 0] : [0, 10, 0]);
  });
  it('applies already-world R(x,y,z)=(z,x,y)+[11,13,17] once', () => {
    const e = { ...evidence(), centerMm: [11, 13, 17], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0],
      parameterRange: [Math.PI / 2, Math.PI] } satisfies CircularWeldPathEvidence;
    const g = admitted(definition(e));
    close(g.placement.position, [11, 13, 17]);
    close(applyPlacementToPoint(g.placement, [10, 0, 0]), [11, 13, 27]);
    close(applyPlacementToPoint(g.placement, [13, 0, 0]), [11, 13, 30]);
    close(applyPlacementToPoint(g.placement, [10, 0, 4]), [15, 13, 27]);
    close(applyPlacementToPoint(g.placement, [0, 10, 0]), [11, 3, 17]);
  });
  it('uses the explicit negative normal side independently from reversed traversal', () => {
    const g = admitted(definition({ ...evidence(), orientation: -1 }), { ...section(), normalDirection: -1 });
    expect(vertices(g)[2]).toEqual([10, 0, -4]);
    close(applyPlacementToPoint(g.placement, [10, 0, -4]), [0, 10, -4]);
  });
  it('preserves all irregular intervals/gaps and builds only the named interval', () => {
    const e = { ...evidence(), parameterRange: [0, 2] } satisfies CircularWeldPathEvidence;
    const d = { ...definition(e), intervals: [
      { beadId: 'bead-a', beadSourceKey: 'a1', fromParameter: .1, toParameter: .4 },
      { beadId: 'bead-b', beadSourceKey: 'b1', fromParameter: .8, toParameter: 1.5 },
    ] };
    const g = admitted(d, { ...section(), beadId: 'bead-b' });
    expect(g.path.definition.intervals).toEqual(d.intervals);
    expect(g.path.gaps.map(row => [row.fromParameter, row.toParameter])).toEqual([[0, .1], [.4, .8], [1.5, 2]]);
    expect(planOf(g).angle).toBeCloseTo(.7, 14);
    expect(buildCircularFilletWeldGeometry(d, e, [d.intervals[1]], section())).toBeNull();
  });
  it.each(['documentId', 'ownerId', 'sourceKey', 'placementKey', 'bodyFeatureId', 'bodyKey'] as const)('rejects stale current %s', key => {
    const d = definition();
    const current = { ...d.evidence, source: { ...d.evidence.source, [key]: 'changed' } };
    expect(buildCircularFilletWeldGeometry(d, current, d.intervals, section())).toBeNull();
  });
  it('rejects stale occurrence/edge and stale, extra or missing bead identities', () => {
    const d = definition();
    for (const source of [{ ...d.evidence.source, occurrencePath: ['other', 'leaf'] }, { ...d.evidence.source, edgeIndex: 5 }]) {
      expect(buildCircularFilletWeldGeometry(d, { ...d.evidence, source }, d.intervals, section())).toBeNull();
    }
    for (const current of [[], [{ ...d.intervals[0], beadSourceKey: 'changed' }], [...d.intervals, { ...d.intervals[0], beadId: 'extra' }]]) {
      expect(buildCircularFilletWeldGeometry(d, d.evidence, current, section())).toBeNull();
    }
    expect(build(d, { ...section(), beadId: 'absent' })).toBeNull();
  });
  it.each([0, -1, NaN, Infinity, 1e-12, 1e308])('rejects invalid/degenerate section length %s', value => {
    expect(build(definition(), { ...section(), radialLegMm: value })).toBeNull();
    expect(build(definition(), { ...section(), normalLegMm: value })).toBeNull();
  });
  it.each([10, 11])('rejects inward radius crossing/touching with leg %s', radialLegMm => {
    expect(build(definition(), { ...section(), radialDirection: -1, radialLegMm })).toBeNull();
  });
  it('rejects zero/overturn/nonfinite ranges, overlap, wrong orientation and out-of-range intervals', () => {
    for (const parameterRange of [[0, 0], [0, 2 * Math.PI + .01], [0, Infinity]] as const) {
      expect(build(definition({ ...evidence(), parameterRange }))).toBeNull();
    }
    const d = definition(), base = d.intervals[0];
    for (const intervals of [
      [{ ...base, fromParameter: -.1 }], [{ ...base, toParameter: 2 }],
      [{ ...base, fromParameter: Math.PI / 2, toParameter: 0 }],
      [base, { ...base, beadId: 'overlap' }],
    ]) expect(build({ ...d, intervals })).toBeNull();
  });
  it('owns source/interval/placement snapshots and does not mutate caller input', () => {
    const d = structuredClone(definition()), before = JSON.stringify(d), s = section();
    const g = admitted(d, s);
    expect(JSON.stringify(d)).toBe(before); expect(s).toEqual(section());
    Reflect.set(d.evidence.centerMm, '0', 999);
    Reflect.set(d.evidence.source, 'bodyKey', 'late-change');
    Reflect.set(d.intervals[0], 'toParameter', .01);
    expect(g.placement.position).toEqual([0, 0, 0]);
    expect(g.path.definition.evidence.source.bodyKey).toBe('body-7');
    expect(g.interval.toParameter).toBe(Math.PI / 2);
    expect(Object.isFrozen(g.placement.rotation)).toBe(true);
  });
});

describe('circular saved geometry boundary', () => {
  it('reconstructs only a local part and retains independently rejected stale current evidence', () => {
    const d = definition(), g = admitted(d);
    expect(rebuildCircularFilletWeldPart(d, section())).toEqual(g.part);
    expect(buildCircularFilletWeldGeometry(d, { ...d.evidence, source: { ...d.evidence.source, sourceKey: 'later' } }, d.intervals, section())).toBeNull();
    expect(rebuildCircularFilletWeldPart(d, section())).not.toHaveProperty('placement');
  });
  it('still validates all saved intervals and refuses axes crossing', () => {
    const d = definition();
    expect(rebuildCircularFilletWeldPart({ ...d, intervals: [...d.intervals, d.intervals[0]] }, section())).toBeNull();
    expect(rebuildCircularFilletWeldPart(d, { ...section(), radialDirection: -1, radialLegMm: 10 })).toBeNull();
  });
});
