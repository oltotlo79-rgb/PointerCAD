import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { absoluteCoordinate } from '../createSketchDocument.js';
import type { SketchDocument, SketchFeature } from '../types.js';
import type { SketchConstraint } from './types.js';
import { createConstrainedSketchJob, resolveConstrainedSketch } from './solveSketch.js';
import type { ConstrainedSketchJob, ConstrainedSketchProgress } from './solveSketch.js';

function fixture(): SketchDocument {
  const features: SketchFeature[] = Array.from({ length: 70 }, (_, i) => ({
    id: `p${i}`, name: `p${i}`, kind: 'point', planeId: 'xy', at: absoluteCoordinate(20 * i, 0, 0),
  }));
  const constraints: SketchConstraint[] = [];
  for (let i = 1; i < features.length; i += 1) {
    for (const kind of ['horizontalDistance', 'verticalDistance'] as const) constraints.push({
      id: `${kind}${i}`, name: kind, kind, a: { kind: 'point', pointId: 'p0' },
      b: { kind: 'point', pointId: `p${i}` }, length: expressionValueFromNumber(kind === 'horizontalDistance' ? 20 * i : 0),
    });
  }
  return { id: 's', name: 's', features, constraints };
}
const options = { pinned: new Map<string, readonly [number, number]>([['p0', [5, 3]]]) };
// Original 50 nonlinear iterations, 24 damping trials, 2*n CG iterations. See INTEGRATION work census.
const n = 140, rows = 140, entries = 278;
const workLimit = 50 * 24 * (2 * n * (50 * n + 8 * entries + 8 * rows + 64) + 50 * n + 64) + 10;

function finish(job: ConstrainedSketchJob): ConstrainedSketchProgress {
  for (let call = 0; call < Math.ceil(workLimit / 4096) + 3; call += 1) {
    const progress = job.stepWork(4096);
    expect(progress.work).toBeLessThanOrEqual(4096);
    if (progress.status !== 'pending') return progress;
    expect(progress.result).toBeNull();
  }
  throw new Error('Finite constrained job failed to finish');
}

describe('public constrained sketch work stages', () => {
  it('cancels before setup without running the work-plane resolver', () => {
    let lookups = 0;
    const base = fixture();
    const document = { ...base, features: base.features.map(feature => ({ ...feature, planeId: 'custom' })) };
    const resolution = { workPlane: () => { lookups += 1; return null; } };
    const job = createConstrainedSketchJob(document, resolution, options);
    expect(lookups).toBe(0);
    job.cancel();
    expect(job.stepWork(4096)).toMatchObject({ status: 'cancelled', result: null, work: 0, totalWork: 0 });
    expect(job.step(1)).toBeNull();
    expect(lookups).toBe(0);
    createConstrainedSketchJob(document, resolution, options).stepWork(1);
    expect(lookups).toBeGreaterThan(0);
  });

  it('cancels after real sparse visits with no partial result, then solves the unchanged document', () => {
    const document = fixture(), saved = JSON.stringify(document);
    const job = createConstrainedSketchJob(document, {}, options);
    expect(job.stepWork(4096)).toMatchObject({ status: 'pending', phase: 'solve', productEntries: 0, result: null, work: 1 });
    let before: ConstrainedSketchProgress | null = null;
    for (let call = 0; call < workLimit; call += 1) {
      before = job.stepWork(1);
      expect(before.result).toBeNull();
      if (before.productEntries === 17) break;
    }
    expect(before?.productEntries).toBe(17);
    expect(before?.phase).toBe('solve');
    job.cancel(); job.cancel();
    expect(job.stepWork(4096)).toEqual({ ...before, status: 'cancelled', result: null, work: 0 });
    expect(JSON.stringify(document)).toBe(saved);
    const progress = finish(createConstrainedSketchJob(document, {}, options));
    expect(progress.status).toBe('completed');
    if (progress.status !== 'completed') throw new Error('No constrained result');
    expect(progress.result).toEqual(resolveConstrainedSketch(document, {}, options));
    expect(progress.result.errors).toEqual([]);
    for (let i = 0; i < 70; i += 1) {
      const point = progress.result.resolved.points.find(entry => entry.id === `p${i}`);
      expect(Math.abs((point?.position[0] ?? NaN) - 20 * i - 5)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs((point?.position[1] ?? NaN) - 3)).toBeLessThanOrEqual(1e-6);
    }
  });

  it('returns control before finalization and can discard a solved but unpublished job', () => {
    const job = createConstrainedSketchJob(fixture(), {}, options);
    let ready = false;
    for (let call = 0; call < Math.ceil(workLimit / 4096) + 3; call += 1) {
      const progress = job.stepWork(4096);
      expect(progress.result).toBeNull();
      if (progress.phase === 'finalize') { ready = true; break; }
    }
    expect(ready).toBe(true);
    job.cancel();
    expect(job.stepWork(4096)).toMatchObject({ status: 'cancelled', result: null, work: 0 });
  });

  it('preserves the exact synchronous result when legacy and work calls are mixed', () => {
    const document = fixture(), job = createConstrainedSketchJob(document, {}, options);
    expect(job.stepWork(1)).toMatchObject({ status: 'pending', phase: 'solve' });
    const legacy = job.step(1);
    const result = legacy ?? finish(job).result;
    expect(result).toEqual(resolveConstrainedSketch(document, {}, options));
    expect(job.stepWork(1)).toMatchObject({ status: 'completed', phase: 'finalize', work: 0, result });
    job.cancel();
    expect(job.step(1)).toBe(result);
  });
});
