import { expressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { absoluteCoordinate } from '../createSketchDocument.js';
import { WORK_PLANES } from '../planeMath.js';
import { resolveSketch } from '../resolveSketch.js';
import type { SketchDocument } from '../types.js';
import { buildResidualReport, buildResiduals } from './residuals.js';
import { resolveConstrainedSketch } from './solveSketch.js';
import type { SketchConstraint } from './types.js';
import { collectVariables } from './variables.js';

function sketch(): SketchDocument {
  return { id: 's', name: 's', features: [
    { id: 'a', name: 'a', kind: 'point', planeId: 'xy', at: absoluteCoordinate(2, 3, 0) },
    { id: 'b', name: 'b', kind: 'point', planeId: 'xy', at: absoluteCoordinate(-4, 8, 0) },
  ] };
}

function dimension(kind: 'horizontalDistance' | 'verticalDistance', value: number): SketchConstraint {
  return { id: kind, name: kind, kind, a: { kind: 'point', pointId: 'a' },
    b: { kind: 'point', pointId: 'b' }, length: num(value) };
}

describe('signed work-plane axis distances', () => {
  it('has independent signed residuals and analytic gradients for every variable', () => {
    const document = sketch(), set = collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
    const constraints = [dimension('horizontalDistance', -7), dimension('verticalDistance', 2)];
    const rows = buildResiduals(constraints, set, set.initial);
    expect(rows.map(row => row.value)).toEqual([1, 3]);
    for (let i = 0; i < set.initial.length; i++) {
      const plus = [...set.initial], minus = [...set.initial];
      plus[i] += 1e-6; minus[i] -= 1e-6;
      const forward = buildResiduals(constraints, set, plus), backward = buildResiduals(constraints, set, minus);
      rows.forEach((row, j) => expect(Math.abs((forward[j].value - backward[j].value) / 2e-6
        - (row.gradient.get(i) ?? 0))).toBeLessThan(1e-8));
    }
  });

  it('solves zero and negative offsets with one fixed endpoint and rank2', () => {
    const document: SketchDocument = { ...sketch(), constraints: [
      { id: 'fixed', name: 'fixed', kind: 'fix', target: { kind: 'point', pointId: 'a' } },
      dimension('horizontalDistance', -6), dimension('verticalDistance', 0),
    ] };
    const result = resolveConstrainedSketch(document);
    if (result.diagnosis === null) throw new Error('missing diagnosis');
    expect(result.diagnosis.rank).toBe(2);
    expect(result.diagnosis.degreesOfFreedom).toBe(0);
    const b = result.resolved.points.find(point => point.id === 'b');
    expect(b).toBeDefined();
    if (b === undefined) throw new Error('missing solved point');
    expect(Math.abs(b.position[0] + 4)).toBeLessThan(1e-8);
    expect(Math.abs(b.position[1] - 3)).toBeLessThan(1e-8);
    expect(sketch().features).toEqual(document.features);
  });

  it('refuses missing points and curve targets without producing rows', () => {
    const document = sketch(), set = collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
    const original = dimension('horizontalDistance', 0);
    if (!('length' in original)) throw new Error('not dimensional');
    const missing = { ...original, b: { kind: 'point', pointId: 'missing' } } satisfies SketchConstraint;
    const curve = { ...original, b: { kind: 'curve', element: { featureId: 'a' } } } satisfies SketchConstraint;
    expect(buildResidualReport([missing, curve], set, set.initial)).toMatchObject({ rows: [],
      skipped: [{ reason: 'dangling' }, { reason: 'unsupportedTarget' }] });
  });

  it('does not silently project an off-plane endpoint into an axis constraint', () => {
    const base = sketch();
    const document = { ...base, features: base.features.map(feature => feature.id === 'b'
      ? { ...feature, at: absoluteCoordinate(-4, 8, 6) } : feature) };
    const set = collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
    expect(buildResidualReport([dimension('horizontalDistance', -6)], set, set.initial).skipped[0]?.reason)
      .toBe('unsupportedTarget');
  });
});
