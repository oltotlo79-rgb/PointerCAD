/** EX18 C: extrusion, sewn numeric vertices and expression coordinates, measured independently. */
import { stdout } from 'node:process';
import { createKernelApi } from '@pointercad/kernel';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { buildEx18ExpressionOblique, buildEx18ExtrudedOblique, buildEx18SewnOblique,
  editEx18ObliqueDepth, type Ex18BCRoute } from './ex18RouteBuilders.js';
import { EX18_ORACLE_C_DEPTH_TWELVE, EX18_ORACLE_EXPECTATIONS } from './ex18RouteFixtures.js';
import { compareEx18Shape, measureEx18Shape, type Ex18ShapeExpectation, type Ex18ShapeMeasurement } from './ex18ShapeOracle.js';
import { recomputePart } from './recomputePart.js';
import type { ResolvedPart } from './resolvePart.js';
import type { PartDocument } from './types.js';

const TIMEOUT_MS = 180_000;
let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
const releases: (() => void)[] = [];
beforeAll(async () => {
  const started = performance.now(); oc = await loadOcctForNode();
  record('OCCT initialization', { durationMs: performance.now() - started });
}, TIMEOUT_MS);
afterEach(() => { for (const release of releases.splice(0)) release(); });

function record(label: string, value: object): void {
  stdout.write(`EX18 W04 C ${label}: ${JSON.stringify(value)}\n`);
}

function session() {
  const cache = createShapeCache<CachedSolid>(64);
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode, cache));
  releases.push(() => { try { bridge.dispose(); } finally { cache.clear(); } });
  return { bridge, cache };
}

async function measured(part: PartDocument, finalId: string, context: ReturnType<typeof session>,
  kinds: readonly string[]): Promise<Ex18ShapeMeasurement> {
  let resolved: ResolvedPart | undefined;
  const result = await recomputePart(part, context.bridge, { onResolved: value => { resolved = value; } });
  expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
  expect(result.bodies.map(body => body.featureId)).toEqual([finalId]);
  if (resolved === undefined) throw new Error('EX18 C missing completed resolution');
  expect(resolved.steps.map(step => step.plan.kind)).toEqual(kinds);
  for (const { plan } of resolved.steps) {
    if (plan.kind === 'extrude') expect(plan.direction).toEqual([0, 1, 0]);
    if (plan.kind === 'sew') expect(plan.profiles).toHaveLength(6);
  }
  const step = resolved.steps.find(entry => entry.featureId === finalId);
  if (step === undefined) throw new Error('EX18 C missing final plan');
  const cached = context.cache.get(step.key);
  if (cached === undefined) throw new Error('EX18 C missing current B-rep');
  // Borrow synchronously from this test's cache; do not delete or retain the borrowed shape.
  return measureEx18Shape(oc, cached.shape);
}

function expectShape(label: string, actual: Ex18ShapeMeasurement, expected: Ex18ShapeExpectation): void {
  const comparison = compareEx18Shape(actual, expected);
  record(label, { ...comparison, volume: actual.volume, bounds: actual.bounds,
    throughHoles: actual.throughHoleCount, validity: actual.validity, limitations: actual.limitations });
  expect(actual.validity.valid).toBe(true); expect(actual.validity.solidCount).toBe(1);
  expect(actual.validity.closed).toBe(true); expect(actual.holesComplete).toBe(true);
  expect(actual.throughHoleCount).toBe(0); expect(actual.holes).toEqual([]);
  expect(actual.volumeMethod).toBe('occt-gprop'); expect(actual.boundsMethod).toBe('analytic-brep');
  expect(actual.meshApproximation).toBeNull();
  expect(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9);
  expect(comparison.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.failures).toEqual([]); expect(comparison.matches).toBe(true);
}

interface RouteCase {
  readonly route: string;
  readonly build: () => Ex18BCRoute;
  readonly editFormula: string;
  readonly kinds: readonly string[];
}
const routes: readonly RouteCase[] = [
  { route: 'a parallelogram/extrude', build: buildEx18ExtrudedOblique, editFormula: '12', kinds: ['extrude'] },
  { route: 'b eight vertices/six faces/sew', build: buildEx18SewnOblique, editFormula: '12', kinds: ['sew'] },
  { route: 'd coordinate expressions/sew', build: buildEx18ExpressionOblique, editFormula: '3*4', kinds: ['sew'] },
];

describe('EX18 C oblique prism routes against W02 independent oracle', () => {
  it.each(routes)('$route: initial depth 10 matches analytic C', async route => {
    const context = session(), built = route.build();
    expect(built.part.solids.map(feature => feature.kind)).toEqual(route.kinds);
    if (route.route.startsWith('d')) {
      const points = built.part.sketches[0].features.filter(feature => feature.kind === 'point');
      expect(points).toHaveLength(8);
      expect(points.every(point => point.planeId === 'free')).toBe(true);
      expect(points[6].at.mode === 'absolute' ? points[6].at.x.source : null).toBe('4*5+5');
    }
    expectShape(`${route.route} depth 10`, await measured(built.part, built.finalId, context, route.kinds), EX18_ORACLE_EXPECTATIONS.C);
  }, TIMEOUT_MS);

  it.each(routes)('$route: saved depth 10 -> 12 recomputes the same oblique section', async route => {
    const context = session(), built = route.build();
    const before = await measured(built.part, built.finalId, context, route.kinds);
    expectShape(`${route.route} before edit`, before, EX18_ORACLE_EXPECTATIONS.C);
    const original = JSON.stringify(built.part), edited = editEx18ObliqueDepth(built, route.editFormula);
    expect(JSON.stringify(built.part)).toBe(original);
    expect(edited.solids.map(feature => feature.id)).toEqual(built.part.solids.map(feature => feature.id));
    expect(edited.sketches[0].features.map(feature => feature.id)).toEqual(built.part.sketches[0].features.map(feature => feature.id));
    const after = await measured(edited, built.finalId, context, route.kinds);
    expectShape(`${route.route} depth 12`, after, EX18_ORACLE_C_DEPTH_TWELVE);
    expect(after.bounds?.low).toEqual(before.bounds?.low);
    expect(after.bounds?.high[0]).toBe(before.bounds?.high[0]); expect(after.bounds?.high[2]).toBe(before.bounds?.high[2]);
    expect(compareEx18Shape(after, EX18_ORACLE_EXPECTATIONS.C).matches).toBe(false);
    if (route.route.startsWith('d')) {
      const depthPoints = edited.sketches[0].features.filter(point => point.kind === 'point'
        && point.at.mode === 'absolute' && point.at.y.value === 12);
      expect(depthPoints).toHaveLength(4);
      for (const point of depthPoints) {
        expect(point.kind === 'point' && point.at.mode === 'absolute' ? point.at.y.source : null).toBe('3*4');
      }
    }
  }, TIMEOUT_MS);

  it('negative: a wrong depth formula is detected by volume and envelope', async () => {
    const context = session(), built = buildEx18ExpressionOblique();
    const actual = await measured(editEx18ObliqueDepth(built, '3*4'), built.finalId, context, ['sew']);
    expectShape('d wrong-depth control actual depth 12', actual, EX18_ORACLE_C_DEPTH_TWELVE);
    const comparison = compareEx18Shape(actual, EX18_ORACLE_EXPECTATIONS.C);
    expect(comparison.volumeRelativeError).toBeCloseTo(0.2, 12);
    expect(comparison.boundsMaximumErrorMm).toBe(2);
    expect(comparison.failures).toEqual(['volume', 'bounds']); expect(comparison.matches).toBe(false);
    record('wrong-depth formula negative control', comparison);
  }, TIMEOUT_MS);
});
