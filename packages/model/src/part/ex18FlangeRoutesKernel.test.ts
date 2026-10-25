/** EX18 B: three real model histories, independently measured on their completed kernel B-reps. */
import { stdout } from 'node:process';
import { createKernelApi } from '@pointercad/kernel';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { createDirectKernelBridge, type KernelBridge } from '../kernelBridge.js';
import { buildEx18ExpressionFlange, buildEx18RevolvedFlange, buildEx18RuledFlange,
  editEx18FlangeBore, editEx18RevolvedFlangeRadius, type Ex18BCRoute } from './ex18RouteBuilders.js';
import { EX18_ORACLE_B_RADIUS_FOUR, EX18_ORACLE_EXPECTATIONS } from './ex18RouteFixtures.js';
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
  stdout.write(`EX18 W04 B ${label}: ${JSON.stringify(value)}\n`);
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
  if (resolved === undefined) throw new Error('EX18 B missing completed resolution');
  expect(resolved.steps.map(step => step.plan.kind)).toEqual(kinds);
  for (const { plan } of resolved.steps) {
    if (plan.kind === 'thruSections') {
      expect(plan.ruled).toBe(true); expect(plan.smooth).toBe(false); expect(plan.closed).toBe(true);
    }
    if (plan.kind === 'revolve') {
      expect(plan.axisOrigin).toEqual([0, 0, 0]); expect(plan.axisDirection).toEqual([0, 0, 1]);
      expect(plan.angle).toBe(2 * Math.PI);
    }
    if (plan.kind === 'boolean') expect(plan.operation).toBe('union');
  }
  const step = resolved.steps.find(entry => entry.featureId === finalId);
  if (step === undefined) throw new Error('EX18 B missing final plan');
  const cached = context.cache.get(step.key);
  if (cached === undefined) throw new Error('EX18 B missing current B-rep');
  // Synchronous borrowing only. The cache owns and releases this shape after the test.
  const measurement = measureEx18Shape(oc, cached.shape);
  if (measurement.limitations.length > 0) {
    const map = new oc.TopTools_IndexedMapOfShape_1();
    try {
      oc.TopExp.MapShapes_2(cached.shape, map, true, true);
      for (let index = 1; index <= map.Size(); index++) {
        const member = map.FindKey(index);
        try {
          if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
          const edge = oc.TopoDS.Edge_1(member), curve = new oc.BRepAdaptor_Curve_2(edge);
          try {
            const first = curve.Value(curve.FirstParameter()), last = curve.Value(curve.LastParameter());
            const kind = curve.GetType();
            const curveKind = kind === oc.GeomAbs_CurveType.GeomAbs_Line ? 'line'
              : kind === oc.GeomAbs_CurveType.GeomAbs_Circle ? 'circle'
                : kind === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve ? 'bspline'
                  : kind === oc.GeomAbs_CurveType.GeomAbs_BezierCurve ? 'bezier' : 'other';
            try { record('unsupported route boundary diagnostic', { index, curveKind,
              degree: curveKind === 'bezier' || curveKind === 'bspline' ? curve.Degree() : null,
              first: [first.X(), first.Y(), first.Z()], last: [last.X(), last.Y(), last.Z()] });
            } finally { first.delete(); last.delete(); }
          } finally { curve.delete(); edge.delete(); }
        } finally { member.delete(); }
      }
    } finally { map.delete(); }
  }
  return measurement;
}

function expectShape(label: string, actual: Ex18ShapeMeasurement, expected: Ex18ShapeExpectation): void {
  const comparison = compareEx18Shape(actual, expected);
  record(label, { ...comparison, volume: actual.volume, bounds: actual.bounds, holes: actual.holes,
    throughHoles: actual.throughHoleCount, validity: actual.validity, limitations: actual.limitations });
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
  readonly build: (bridge: KernelBridge) => Ex18BCRoute | Promise<Ex18BCRoute>;
  readonly edit: (built: Ex18BCRoute) => PartDocument;
  readonly kinds: readonly string[];
  readonly features: readonly string[];
}
const routes: readonly RouteCase[] = [
  { route: 'a half-section/revolve', build: buildEx18RevolvedFlange, edit: editEx18RevolvedFlangeRadius,
    kinds: ['revolve'], features: ['revolve'] },
  { route: 'b circles/straight ruled/union', build: buildEx18RuledFlange, edit: editEx18FlangeBore,
    kinds: ['thruSections', 'thruSections', 'boolean', 'hole'], features: ['ruled', 'ruled', 'boolean', 'hole'] },
  { route: 'd expressions/cylinders/union', build: buildEx18ExpressionFlange, edit: built => editEx18FlangeBore(built, '2*4'),
    kinds: ['primitive', 'primitive', 'boolean', 'hole'], features: ['primitive', 'primitive', 'boolean', 'hole'] },
];

describe('EX18 B flange routes against W02 independent oracle', () => {
  it.each(routes)('$route: initial radius 3 matches analytic B', async route => {
    const context = session(), built = await route.build(context.bridge);
    expect(built.part.solids.map(feature => feature.kind)).toEqual(route.features);
    expectShape(`${route.route} radius 3`, await measured(built.part, built.finalId, context, route.kinds), EX18_ORACLE_EXPECTATIONS.B);
  }, TIMEOUT_MS);

  it.each(routes)('$route: saved dimension radius 3 -> 4 recomputes and preserves envelope/axis', async route => {
    const context = session(), built = await route.build(context.bridge);
    const before = await measured(built.part, built.finalId, context, route.kinds);
    const original = JSON.stringify(built.part), edited = route.edit(built);
    expect(JSON.stringify(built.part)).toBe(original);
    expect(edited.solids.map(feature => feature.id)).toEqual(built.part.solids.map(feature => feature.id));
    expect(edited.sketches[0].features.map(feature => feature.id)).toEqual(built.part.sketches[0].features.map(feature => feature.id));
    const after = await measured(edited, built.finalId, context, route.kinds);
    // Record both states even when the unchanged W02 oracle cannot certify a ruled boundary representation.
    record(`${route.route} edited measurement`, { volume: after.volume, bounds: after.bounds,
      holes: after.holes, limitations: after.limitations, validity: after.validity,
      comparison: compareEx18Shape(after, EX18_ORACLE_B_RADIUS_FOUR) });
    expectShape(`${route.route} before edit`, before, EX18_ORACLE_EXPECTATIONS.B);
    expectShape(`${route.route} radius 4`, after, EX18_ORACLE_B_RADIUS_FOUR);
    expect(after.bounds).toEqual(before.bounds);
    expect(after.holes[0].axisOrigin).toEqual(before.holes[0].axisOrigin);
    expect(after.holes[0].direction).toEqual(before.holes[0].direction);
    expect(after.holes[0].ends).toEqual(before.holes[0].ends);
    expect(after.volume).toBeLessThan(before.volume);
    expect(compareEx18Shape(after, EX18_ORACLE_EXPECTATIONS.B).matches).toBe(false);
    if (route.route.startsWith('d')) {
      const hole = edited.solids.find(feature => feature.id === built.finalId);
      expect(hole?.kind === 'hole' ? hole.diameter.source : null).toBe('2*4');
    }
  }, TIMEOUT_MS);

  it('negative: an unchanged outer envelope cannot hide a wrong bore radius', async () => {
    const context = session(), built = await buildEx18ExpressionFlange(context.bridge);
    const actual = await measured(editEx18FlangeBore(built, '2*4'), built.finalId, context, routes[2].kinds);
    const comparison = compareEx18Shape(actual, EX18_ORACLE_EXPECTATIONS.B);
    expectShape('d wrong-bore control actual radius 4', actual, EX18_ORACLE_B_RADIUS_FOUR);
    expect(comparison.boundsMaximumErrorMm).toBe(0); expect(comparison.holeAxisMaximumErrorMm).toBe(0);
    expect(comparison.holeRadiusMaximumErrorMm).toBe(1);
    expect(comparison.failures).toEqual(['volume', 'hole-radius']); expect(comparison.matches).toBe(false);
    record('wrong-bore negative control', comparison);
  }, TIMEOUT_MS);
});
