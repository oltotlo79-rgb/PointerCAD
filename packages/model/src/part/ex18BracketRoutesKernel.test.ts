/** EX18 A: distinct model construction histories, measured independently on their real cached B-reps. */
import { stdout } from 'node:process';
import { createKernelApi } from '@pointercad/kernel';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { createDirectKernelBridge, type KernelBridge } from '../kernelBridge.js';
import { buildEx18ExpressionBracket, buildEx18SewnBracket, buildEx18SketchBracket,
  editEx18ExpressionDiameter, editEx18SewnDiameter, editEx18SketchHoleDiameter,
  moveEx18ExpressionHole, type Ex18BuiltRoute } from './ex18RouteBuilders.js';
import { EX18_ORACLE_A_DIAMETER_EIGHT, EX18_ORACLE_A_HOLE_X_TWELVE, EX18_ORACLE_EXPECTATIONS } from './ex18RouteFixtures.js';
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
  stdout.write(`EX18 W03 ${label}: ${JSON.stringify(value)}\n`);
}

function session() {
  const cache = createShapeCache<CachedSolid>(64);
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode, cache));
  releases.push(() => { try { bridge.dispose(); } finally { cache.clear(); } });
  return { bridge, cache };
}

async function measured(document: PartDocument, finalId: string, context: ReturnType<typeof session>,
  expectedKinds: readonly string[]): Promise<Ex18ShapeMeasurement> {
  let resolved: ResolvedPart | undefined;
  const result = await recomputePart(document, context.bridge, { onResolved: value => { resolved = value; } });
  expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
  expect(result.bodies.map(body => body.featureId)).toEqual([finalId]);
  if (resolved === undefined) throw new Error('EX18 missing completed resolution');
  expect(resolved.steps.map(step => step.plan.kind)).toEqual(expectedKinds);
  const step = resolved.steps.find(entry => entry.featureId === finalId);
  if (step === undefined) throw new Error('EX18 final step missing');
  const cached = context.cache.get(step.key);
  if (cached === undefined) throw new Error('EX18 current kernel shape missing');
  // Borrow synchronously; never delete the cache-owned shape or retain it over another recompute.
  return measureEx18Shape(oc, cached.shape);
}

function expectShape(label: string, actual: Ex18ShapeMeasurement, expected: Ex18ShapeExpectation): void {
  const comparison = compareEx18Shape(actual, expected);
  record(label, { ...comparison, volume: actual.volume, bounds: actual.bounds, throughHoles: actual.throughHoleCount,
    holes: actual.holes, validity: actual.validity, limitations: actual.limitations });
  expect(actual.validity.valid).toBe(true); expect(actual.validity.solidCount).toBe(1);
  expect(actual.validity.closed).toBe(true); expect(actual.holesComplete).toBe(true);
  expect(actual.throughHoleCount).toBe(1); expect(actual.volumeMethod).toBe('occt-gprop');
  expect(actual.boundsMethod).toBe('analytic-brep'); expect(actual.meshApproximation).toBeNull();
  expect(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9);
  expect(comparison.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeAxisMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(comparison.holeDirectionMaximumError).toBeLessThanOrEqual(1e-6);
  expect(comparison.failures).toEqual([]); expect(comparison.matches).toBe(true);
}

interface RouteCase {
  readonly route: string;
  readonly build: (bridge: KernelBridge) => Promise<Ex18BuiltRoute>;
  readonly edit: (built: Ex18BuiltRoute) => PartDocument;
  readonly kinds: readonly string[];
}
const routes: readonly RouteCase[] = [
  { route: 'a sketch/extrude', build: buildEx18SketchBracket, edit: editEx18SketchHoleDiameter, kinds: ['extrude', 'hole'] },
  { route: 'b points/faces/sew', build: buildEx18SewnBracket, edit: editEx18SewnDiameter, kinds: ['sew', 'hole'] },
  { route: 'd expression/box', build: buildEx18ExpressionBracket, edit: editEx18ExpressionDiameter, kinds: ['primitive', 'hole'] },
];

describe('EX18 A distinct model routes against W02 independent oracle', () => {
  it.each(routes)('$route: original diameter 6 matches analytic shape A', async route => {
    const context = session(), built = await route.build(context.bridge);
    expectShape(`${route.route} diameter 6`, await measured(built.part, built.finalId, context, route.kinds), EX18_ORACLE_EXPECTATIONS.A);
  }, TIMEOUT_MS);

  it.each(routes)('$route: edit diameter 6 -> 8; recompute keeps envelope and axis exactly unchanged', async route => {
    const context = session(), built = await route.build(context.bridge);
    const before = await measured(built.part, built.finalId, context, route.kinds);
    expectShape(`${route.route} before edit`, before, EX18_ORACLE_EXPECTATIONS.A);
    const original = JSON.stringify(built.part), edited = route.edit(built);
    expect(JSON.stringify(built.part)).toBe(original);
    expect(edited.solids.map(feature => feature.id)).toEqual(built.part.solids.map(feature => feature.id));
    const after = await measured(edited, built.finalId, context, route.kinds);
    expectShape(`${route.route} diameter 8`, after, EX18_ORACLE_A_DIAMETER_EIGHT);
    expect(after.bounds).toEqual(before.bounds);
    expect(after.holes[0].axisOrigin).toEqual(before.holes[0].axisOrigin);
    expect(after.holes[0].direction).toEqual(before.holes[0].direction);
    expect(after.holes[0].ends).toEqual(before.holes[0].ends);
    expect(compareEx18Shape(after, EX18_ORACLE_EXPECTATIONS.A).matches).toBe(false);
    record(`${route.route} edit invariant`, { envelopeDifferenceMm: 0, axisDifferenceMm: 0 });
  }, TIMEOUT_MS);

  it('d: changing only the hole X formula is rejected despite the same volume, radius and envelope', async () => {
    const context = session(), built = await buildEx18ExpressionBracket(context.bridge);
    const original = JSON.stringify(built.part), moved = moveEx18ExpressionHole(built);
    expect(JSON.stringify(built.part)).toBe(original);
    const actual = await measured(moved, built.finalId, context, ['primitive', 'hole']);
    expectShape('d shifted axis x=12', actual, EX18_ORACLE_A_HOLE_X_TWELVE);
    const comparison = compareEx18Shape(actual, EX18_ORACLE_EXPECTATIONS.A);
    expect(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9);
    expect(comparison.boundsMaximumErrorMm).toBe(0); expect(comparison.holeRadiusMaximumErrorMm).toBe(0);
    expect(comparison.holeAxisMaximumErrorMm).toBe(2);
    expect(comparison.failures).toEqual(['hole-axis']); expect(comparison.matches).toBe(false);
    record('d shifted-axis negative control', comparison);
  }, TIMEOUT_MS);
});
