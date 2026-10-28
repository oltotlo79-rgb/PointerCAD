import { exactExpressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it, vi } from 'vitest';
import { absoluteCoordinate } from '../createSketchDocument.js';
import { WORK_PLANES } from '../planeMath.js';
import { resolveSketch } from '../resolveSketch.js';
import type { SketchDocument, SketchFeature } from '../types.js';
import { dragTranslationSeed } from './dragTranslationSeed.js';
import { buildResiduals } from './residuals.js';
import * as residuals from './residuals.js';
import { CONSTRAINT_TOLERANCE, solveLevenbergMarquardt } from './solve.js';
import { createConstrainedSketchJob, DRAG_PIN_WEIGHT, resolveConstrainedSketch } from './solveSketch.js';
import type { SketchConstraint } from './types.js';
import { canonicalPointKey, collectVariables, pointComponentKey, type VariableSet } from './variables.js';

function fixture(): SketchDocument {
  const features: SketchFeature[] = [['a', 0, 0], ['b', 4, 3], ['c', 0, 3], ['untouched', 20, 20]].map(([id, x, y]) => {
    if (typeof id !== 'string' || typeof x !== 'number' || typeof y !== 'number') throw new Error('Bad fixed fixture');
    return { id, name: id, kind: 'point', planeId: 'xy', at: absoluteCoordinate(x, y, 0) };
  });
  const constraint = (id: string, kind: 'distance' | 'verticalDistance', a: string, b: string, value: number): SketchConstraint =>
    ({ id, name: id, kind, a: { kind: 'point', pointId: a }, b: { kind: 'point', pointId: b }, length: num(value) });
  // 3-4-5 triangle, orientation fixed by dy=3; the fourth point is an unrelated component.
  return { id: 'triangle', name: 'triangle', features, constraints: [constraint('ab', 'distance', 'a', 'b', 5),
    constraint('ac', 'distance', 'a', 'c', 3), constraint('bc', 'distance', 'b', 'c', 4),
    constraint('rise', 'verticalDistance', 'a', 'b', 3)] };
}
const target = new Map<string, readonly [number, number]>([['a', [-2, 7]]]);
function evaluator(document: SketchDocument, variables: VariableSet, pinned = target) {
  return (x: readonly number[]) => {
    const rows = [...buildResiduals(document.constraints ?? [], variables, x)];
    for (const [raw, at] of pinned) {
      const key = canonicalPointKey(variables, raw);
      if (key === null) continue;
      for (const [axis, value] of [['u', at[0]], ['v', at[1]]] as const) {
        const column = variables.index.get(pointComponentKey(key, axis));
        if (column !== undefined) rows.push({ constraintId: 'test-pin', value: DRAG_PIN_WEIGHT * (x[column] - value),
          gradient: new Map([[column, DRAG_PIN_WEIGHT]]) });
      }
    }
    return rows;
  };
}
function prepare(document: SketchDocument, pinned = target) {
  const variables = collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
  const evaluate = evaluator(document, variables, pinned);
  return { variables, evaluate, seed: dragTranslationSeed(document, variables, document.constraints ?? [], pinned, evaluate, CONSTRAINT_TOLERANCE) };
}

describe('translation seed certified by geometry and the unchanged residual evaluator', () => {
  it('translates a rigid component exactly, keeps unrelated coordinates and the input bytes, and uses the original zero-iteration LM exit', () => {
    const document = fixture(), before = JSON.stringify(document), { variables, evaluate, seed } = prepare(document);
    expect(seed).toEqual([-2, 7, 2, 10, -2, 10, 20, 20]);
    expect(variables.initial).toEqual([0, 0, 4, 3, 0, 3, 20, 20]);
    if (seed === null) throw new Error('Missing certified seed');
    expect(Math.max(...evaluate(seed).map(row => Math.abs(row.value)))).toBeLessThan(1e-9);
    const result = resolveConstrainedSketch(document, {}, { pinned: target });
    expect(result.outcome).toMatchObject({ converged: true, stop: 'converged', iterations: 0, x: seed, trace: [] });
    expect(result.resolved.points.map(point => point.position)).toEqual([[-2, 7, 0], [2, 10, 0], [-2, 10, 0], [20, 20, 0]]);
    expect(result.diagnosis).toBeNull(); expect(result.errors).toEqual([]);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('uses canonical aliases and a pin on any point without rotating or reflecting the triangle', () => {
    const { seed } = prepare(fixture(), new Map([['c:end', [-2, 10]]]));
    expect(seed).toEqual([-2, 7, 2, 10, -2, 10, 20, 20]);
  });

  it('preserves setup/solve/finalize publication boundaries and releases a seeded job on cancellation', () => {
    const job = createConstrainedSketchJob(fixture(), {}, { pinned: target });
    expect(job.stepWork(4096)).toMatchObject({ status: 'pending', phase: 'solve', work: 1, productEntries: 0, result: null });
    expect(job.stepWork(4096)).toMatchObject({ status: 'pending', phase: 'finalize', productEntries: 0, linearWork: 0, result: null });
    job.cancel(); job.cancel();
    expect(job.stepWork(4096)).toMatchObject({ status: 'cancelled', result: null, work: 0 });
    expect(job.step(1)).toBeNull();
    const fresh = createConstrainedSketchJob(fixture(), {}, { pinned: target });
    fresh.stepWork(4096); fresh.stepWork(4096);
    const finished = fresh.stepWork(4096);
    expect(finished.status).toBe('completed');
    expect(finished.result).toEqual(resolveConstrainedSketch(fixture(), {}, { pinned: target }));
  });

  it.each(['rotation', 'flexible', 'inconsistent', 'fixed', 'expression', 'relative', 'curve', 'external', 'length-expression'] as const)(
    '%s falls back without accepting a different geometric freedom', kind => {
      const original = fixture();
      let document = original;
      if (kind === 'rotation' || kind === 'flexible') document = { ...original,
        constraints: original.constraints?.filter(c => c.id !== (kind === 'rotation' ? 'rise' : 'bc')) };
      if (kind === 'inconsistent' || kind === 'length-expression') document = { ...original,
        constraints: original.constraints?.map(c => c.id === 'ab' && 'length' in c
          ? { ...c, length: kind === 'inconsistent' ? num(6) : { ...num(5), source: '2+3' } } : c) };
      if (kind === 'fixed') document = { ...original, constraints: [...(original.constraints ?? []),
        { id: 'fix', name: 'fix', kind: 'fix', target: { kind: 'point', pointId: 'b' } }] };
      if (kind === 'expression' || kind === 'relative' || kind === 'external') document = { ...original,
        features: original.features.map(f => f.id !== 'c' || f.kind !== 'point' || f.at.mode !== 'absolute' ? f : {
          ...f, at: kind === 'expression' ? { ...f.at, x: { ...num(0), source: '1-1' } }
            : { mode: 'relative', base: { kind: 'vertex', featureId: kind === 'external' ? 'missing' : 'a', vertex: 'start' },
              dx: num(0), dy: num(3), dz: num(0) },
        }) };
      if (kind === 'curve') document = { ...original, features: [...original.features, { id: 'line', name: 'line', kind: 'line',
        planeId: 'xy', construction: false, from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(1, 0, 0) }] };
      const before = JSON.stringify(document);
      expect(prepare(document).seed).toBeNull();
      expect(JSON.stringify(document)).toBe(before);
      if (kind === 'rotation' || kind === 'flexible' || kind === 'inconsistent') {
        const { variables, evaluate } = prepare(document);
        // Direct original LM is a fallback control, not the coordinate oracle above.
        expect(resolveConstrainedSketch(document, {}, { pinned: target }).outcome)
          .toEqual(solveLevenbergMarquardt(variables.initial, evaluate));
      }
    });

  it.each([
    new Map<string, readonly [number, number]>([['a', [NaN, 7]]]),
    new Map<string, readonly [number, number]>([['a', [Infinity, 7]]]),
    new Map<string, readonly [number, number]>([['a', [1e12, 7]]]),
    new Map<string, readonly [number, number]>([['missing', [-2, 7]]]),
    new Map<string, readonly [number, number]>([['a', [-2, 7]], ['b', [2, 10]]]),
  ])('rejects invalid/multiple pins or unsafe arithmetic spacing (%#)', pinned => {
    expect(prepare(fixture(), pinned).seed).toBeNull();
  });

  it('keeps custom iteration limits and the pin-free recalculation on the original path', () => {
    expect(resolveConstrainedSketch(fixture(), {}, { pinned: target, maxIterations: 0 }).outcome)
      .toMatchObject({ converged: false, stop: 'maxIterations', iterations: 0 });
    const plain = resolveConstrainedSketch(fixture());
    expect(plain.solution.get('a')).toEqual([0, 0, 0]);
    expect(plain.diagnosis).not.toBeNull();
    expect(plain.outcome?.iterations).toBe(0);
  });
});

it('reuses only the current job certified candidate rows once and evaluates a different target afresh', () => {
  const spy = vi.spyOn(residuals, 'buildResiduals');
  try {
    const document = fixture();
    const first = resolveConstrainedSketch(document, {}, { pinned: target });
    expect(spy).toHaveBeenCalledTimes(2); // written shape, then certified translated shape; no duplicate LM evaluation
    expect(first.outcome).toMatchObject({ converged: true, iterations: 0, trace: [] });
    expect(first.resolved.points.map(point => point.position)).toEqual([[-2, 7, 0], [2, 10, 0], [-2, 10, 0], [20, 20, 0]]);
    const second = resolveConstrainedSketch(document, {}, { pinned: new Map([['a', [1, -2]]]) });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(second.resolved.points.map(point => point.position)).toEqual([[1, -2, 0], [5, 1, 0], [1, 1, 0], [20, 20, 0]]);
    const plain = resolveConstrainedSketch(document, {}, { pinned: target, maxIterations: 0 });
    expect(spy).toHaveBeenCalledTimes(5);
    expect(plain.outcome).toMatchObject({ converged: false, stop: 'maxIterations', iterations: 0 });
  } finally { spy.mockRestore(); }
});
