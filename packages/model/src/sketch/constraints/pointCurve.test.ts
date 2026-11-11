import { expressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { absoluteCoordinate as at } from '../createSketchDocument.js';
import { mapSketchConstraintExpressions } from '../mapExpressions.js';
import { WORK_PLANES } from '../planeMath.js';
import { resolveSketch } from '../resolveSketch.js';
import type { SketchDocument, SketchFeature } from '../types.js';
import { buildResidualReport, buildResiduals } from './residuals.js';
import { resolveConstrainedSketch } from './solveSketch.js';
import type { SketchConstraint } from './types.js';
import { collectVariables } from './variables.js';

function document(): SketchDocument {
  return { id: 's', name: 's', features: [
    { id: 'p', name: 'p', planeId: 'xy', kind: 'point', at: at(7, 5, 0) },
    { id: 'l', name: 'l', planeId: 'xy', kind: 'line', from: at(1, 1, 0), to: at(5, 3, 0), construction: false },
    { id: 'c', name: 'c', planeId: 'xy', kind: 'arc', center: at(1, 1, 0), radius: num(3),
      startAngle: num(0), endAngle: num(360), construction: false },
  ] };
}
function constraint(kind: 'midpoint' | 'pointOnCurve', curve = 'l'): SketchConstraint {
  return { id: kind, name: kind, kind, a: { kind: 'point', pointId: 'p' },
    b: { kind: 'curve', element: { featureId: curve } } };
}

describe('point midpoint and supporting line/full circle', () => {
  it.each(['midpoint', 'line', 'circle'] as const)('%s residual and all analytic derivatives agree with independent geometry', mode => {
    const doc = document(), set = collectVariables(doc, resolveSketch(doc), WORK_PLANES.xy);
    const c = constraint(mode === 'midpoint' ? 'midpoint' : 'pointOnCurve', mode === 'circle' ? 'c' : 'l');
    const rows = buildResiduals([c], set, set.initial);
    const expected = mode === 'midpoint' ? [4, 3] : mode === 'line' ? [-4 / Math.sqrt(20)] : [Math.sqrt(52) - 3];
    expect(rows.length).toBe(expected.length);
    rows.forEach((row, j) => expect(Math.abs(row.value - expected[j])).toBeLessThan(1e-12));
    for (let i = 0; i < set.initial.length; i++) {
      const plus = [...set.initial], minus = [...set.initial]; plus[i] += 1e-6; minus[i] -= 1e-6;
      const forward = buildResiduals([c], set, plus), backward = buildResiduals([c], set, minus);
      rows.forEach((row, j) => expect(Math.abs((forward[j].value - backward[j].value) / 2e-6
        - (row.gradient.get(i) ?? 0))).toBeLessThan(1e-8));
    }
  });

  it('solves an actual midpoint with a fixed line and exactly zero remaining freedom', () => {
    const doc = document();
    const solved = resolveConstrainedSketch({ ...doc, features: doc.features.filter(f => f.id !== 'c'), constraints: [
      { id: 'fixed', name: 'fixed', kind: 'fix', target: { kind: 'curve', element: { featureId: 'l' } } },
      constraint('midpoint'),
    ] });
    expect(solved.diagnosis?.rank).toBe(2);
    expect(solved.diagnosis?.degreesOfFreedom).toBe(0);
    const p = solved.resolved.points.find(point => point.id === 'p');
    if (p === undefined) throw new Error('missing point');
    expect(Math.abs(p.position[0] - 3)).toBeLessThan(1e-8);
    expect(Math.abs(p.position[1] - 2)).toBeLessThan(1e-8);
  });

  it('accepts points beyond the line ends without clamping and retains one degree of freedom', () => {
    const doc = document();
    const solved = resolveConstrainedSketch({ ...doc, features: doc.features.filter(f => f.id !== 'c'), constraints: [
      { id: 'fixed', name: 'fixed', kind: 'fix', target: { kind: 'curve', element: { featureId: 'l' } } },
      constraint('pointOnCurve'),
    ] });
    expect(solved.diagnosis?.rank).toBe(1);
    expect(solved.diagnosis?.degreesOfFreedom).toBe(1);
    const p = solved.resolved.points.find(point => point.id === 'p');
    if (p === undefined) throw new Error('missing point');
    expect(p.position[0]).toBeGreaterThan(5);
    expect(Math.abs(2 * (p.position[0] - 1) - 4 * (p.position[1] - 1))).toBeLessThan(1e-8);
  });

  it('refuses zero-length iterations, ellipse, partial arc, spline chord and stale curve', () => {
    const doc = document();
    const extras: SketchFeature[] = [
      { id: 'e', name: 'e', planeId: 'xy', kind: 'ellipse', center: at(0, 0, 0), majorRadius: num(4),
        minorRadius: num(2), rotation: num(0), startAngle: num(0), endAngle: num(360), construction: false },
      { id: 'spline', name: 'spline', planeId: 'xy', kind: 'spline', mode: 'interpolate',
        points: [at(0, 0, 0), at(2, 3, 0), at(4, 0, 0)], closed: false, construction: false },
    ];
    const partial = { ...doc, features: [...doc.features.map(f => f.kind === 'arc' ? { ...f, endAngle: num(90) } : f), ...extras] };
    const set = collectVariables(partial, resolveSketch(partial), WORK_PLANES.xy);
    for (const id of ['e', 'c', 'spline']) {
      expect(buildResidualReport([constraint('pointOnCurve', id)], set, set.initial).skipped[0]?.reason).toBe('unsupportedTarget');
    }
    expect(buildResidualReport([constraint('midpoint', 'missing')], set, set.initial).skipped[0]?.reason).toBe('dangling');
    const x = [...set.initial];
    for (const axis of ['u', 'v']) {
      const end = set.index.get(`l:end.${axis}`), start = set.index.get(`l:start.${axis}`);
      if (end === undefined || start === undefined) throw new Error('missing line variables');
      x[end] = x[start];
    }
    expect(buildResidualReport([constraint('midpoint')], set, x).skipped[0]?.reason).toBe('degenerate');
  });

  it('solves a full circle with an independent horizontal coordinate and refuses its centre singularity', () => {
    const doc = document();
    const features = doc.features.filter(f => f.id !== 'l');
    const constraints: SketchConstraint[] = [
      { id: 'fixed', name: 'fixed', kind: 'fix', target: { kind: 'curve', element: { featureId: 'c' } } },
      constraint('pointOnCurve', 'c'),
      { id: 'u', name: 'u', kind: 'horizontalDistance', a: { kind: 'vertex', featureId: 'c', vertex: 'center' },
        b: { kind: 'point', pointId: 'p' }, length: num(0) },
    ];
    const solved = resolveConstrainedSketch({ ...doc, features, constraints });
    expect(solved.diagnosis?.rank).toBe(2);
    expect(solved.diagnosis?.degreesOfFreedom).toBe(0);
    const p = solved.resolved.points.find(point => point.id === 'p');
    if (p === undefined) throw new Error('missing point');
    expect(Math.abs(p.position[0] - 1)).toBeLessThan(1e-8);
    expect(Math.abs(p.position[1] - 4)).toBeLessThan(1e-8);
    const set = collectVariables(doc, resolveSketch(doc), WORK_PLANES.xy), x = [...set.initial];
    for (const axis of ['u', 'v']) {
      const column = set.index.get(`p.${axis}`);
      if (column === undefined) throw new Error('missing point variable');
      x[column] = 1;
    }
    expect(buildResidualReport([constraint('pointOnCurve', 'c')], set, x).skipped[0]?.reason).toBe('degenerate');
  });

  it('maps signed dimensional expressions and preserves geometric identity', () => {
    const geometric = constraint('midpoint');
    expect(mapSketchConstraintExpressions(geometric, () => num(9))).toBe(geometric);
    const axis: SketchConstraint = { id: 'axis', name: 'axis', kind: 'horizontalDistance',
      a: { kind: 'point', pointId: 'p' }, b: { kind: 'vertex', featureId: 'c', vertex: 'center' }, length: num(-6) };
    expect(mapSketchConstraintExpressions(axis, () => num(-9))).toMatchObject({ length: { value: -9 } });
    expect(axis.length.value).toBe(-6);
  });
});
