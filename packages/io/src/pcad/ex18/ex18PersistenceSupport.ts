/** Test-only W08 support. Inputs come from existing builders; expectations never feed them. */
import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';
import { createKernelApi } from '@pointercad/kernel';
import { createDirectKernelBridge, recomputePart, replaceSolid, resolveSubShapeReference,
  type ImportedShapeBytes, type KernelBridge, type PartDocument, type ResolvedPart } from '@pointercad/model';
import { expect } from 'vitest';
import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import type { CachedSolid } from '../../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../../kernel/src/worker/shapeCache.js';
import { buildEx18SketchBracket, buildEx18SewnBracket, buildEx18ExpressionBracket,
  buildEx18RevolvedFlange, buildEx18RuledFlange, buildEx18ExpressionFlange,
  buildEx18ExtrudedOblique, buildEx18SewnOblique, buildEx18ExpressionOblique,
  editEx18SketchHoleDiameter, editEx18SewnDiameter, editEx18ExpressionDiameter,
  editEx18RevolvedFlangeRadius, editEx18FlangeBore, editEx18ObliqueDepth,
  routeExpression } from '../../../../model/src/part/ex18RouteBuilders.js';
import { importEx18DirectSeed, directPlanarFace, directFaceReference, appendEx18DirectEdit,
  type Ex18DirectShape } from '../../../../model/src/part/ex18RouteBuildersDirect.js';
import { EX18_ORACLE_EXPECTATIONS, EX18_ORACLE_A_DIAMETER_EIGHT,
  EX18_ORACLE_B_RADIUS_FOUR, EX18_ORACLE_C_DEPTH_TWELVE } from '../../../../model/src/part/ex18RouteFixtures.js';
import { compareEx18Shape, measureEx18Shape, type Ex18ShapeExpectation } from '../../../../model/src/part/ex18ShapeOracle.js';

export const W08_TIMEOUT = 180_000;
export const W08_SAVED_AT = '2026-10-26T00:00:00.000Z';
export type W08Shape = Ex18DirectShape;
export type W08Route = 'sketch' | 'surface/wire' | 'expression' | 'direct STEP';
export const W08_CASES = (['A', 'B', 'C'] as const).flatMap(shape =>
  (['sketch', 'surface/wire', 'expression', 'direct STEP'] as const).map(route => ({ shape, route })));

export function w08Session() {
  const cache = createShapeCache<CachedSolid>(128);
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode, cache));
  return { cache, bridge, dispose: () => { try { bridge.dispose(); } finally { cache.clear(); } } };
}

export async function w08Compute(part: PartDocument, finalId: string, session: ReturnType<typeof w08Session>,
  shapes: ImportedShapeBytes = new Map()) {
  let resolved: ResolvedPart | undefined;
  const result = await recomputePart(part, session.bridge, { importedShapes: shapes,
    onResolved: next => { resolved = next; } });
  expect(result.cancelled).toBe(false); expect(result.errors).toEqual([]);
  expect(result.bodies.map(body => body.featureId)).toEqual([finalId]);
  const step = resolved?.steps.find(entry => entry.featureId === finalId), body = result.bodies[0];
  if (step === undefined || body === undefined) throw new Error('W08 completed body/plan missing');
  const cached = session.cache.get(step.key);
  if (cached === undefined) throw new Error('W08 real cached B-rep missing');
  const oc = await loadOcctForNode();
  return { result, body, key: step.key, measured: measureEx18Shape(oc, cached.shape) };
}

export function w08Expect(label: string, actual: Awaited<ReturnType<typeof w08Compute>>, expected: Ex18ShapeExpectation): void {
  const m = actual.measured, c = compareEx18Shape(m, expected);
  stdout.write(`EX18 W08 ${label}: ${JSON.stringify({ ...c, cacheHits: actual.result.cacheHits,
    volume: m.volume, bounds: m.bounds, holes: m.holes, validity: m.validity, meshApproximation: m.meshApproximation })}\n`);
  expect(m.validity.valid).toBe(true); expect(m.validity.closed).toBe(true); expect(m.validity.solidCount).toBe(1);
  expect(m.holesComplete).toBe(true); expect(m.throughHoleCount).toBe(expected.holes.length);
  expect(m.boundsMethod).toBe('analytic-brep'); expect(m.meshApproximation).toBeNull(); expect(m.limitations).toEqual([]);
  expect(c.volumeRelativeError).toBeLessThanOrEqual(1e-9); expect(c.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(c.holeAxisMaximumErrorMm).toBeLessThanOrEqual(1e-6); expect(c.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(c.holeDirectionMaximumError).toBeLessThanOrEqual(1e-6); expect(c.failures).toEqual([]); expect(c.matches).toBe(true);
}

export const W08_CHANGED: Readonly<Record<W08Shape, Ex18ShapeExpectation>> = {
  A: EX18_ORACLE_A_DIAMETER_EIGHT, B: EX18_ORACLE_B_RADIUS_FOUR, C: EX18_ORACLE_C_DEPTH_TWELVE,
};
/** Independent analytic targets after doubling each STEP route's entered displacement. */
export const W08_DIRECT_CHANGED: Readonly<Record<W08Shape, Ex18ShapeExpectation>> = {
  A: { volume: 14400 - 108 * Math.PI, low: [0, 0, 0], high: [40, 30, 12],
    holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 3 }] },
  B: { volume: 3355 * Math.PI, low: [-15, -15, 0], high: [15, 15, 30],
    holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 3 }] },
  C: { volume: 3000, low: [0, 0, 0], high: [25, 15, 10], holes: [] },
};

export async function w08Build(shape: W08Shape, route: W08Route, session: ReturnType<typeof w08Session>) {
  if (route === 'direct STEP') {
    const url = new URL(`../../../../model/src/part/fixtures/ex18/direct-seed-${shape}.step`, import.meta.url);
    const seed = await importEx18DirectSeed(session.bridge, `direct-seed-${shape}.step`, readFileSync(url));
    const initial = await w08Compute(seed.part, seed.targetId, session, seed.importedShapes);
    const normal = shape === 'C' ? [0, 1, 0] as const : [0, 0, 1] as const;
    const face = directFaceReference(initial.body, directPlanarFace(initial.body, normal, shape === 'A' ? 8 : shape === 'B' ? 20 : 5));
    expect(resolveSubShapeReference(initial.body, face).status).toBe('matched');
    const offset = shape === 'A' ? '2' : '5';
    const part = appendEx18DirectEdit(seed, face, offset);
    return { part, finalId: 'direct-edit', shapes: seed.importedShapes ?? new Map<string, Uint8Array>(),
      edit: (current: PartDocument): PartDocument => {
        const feature = current.solids.find(entry => entry.id === 'direct-edit');
        if (feature?.kind !== 'faceOffset') throw new Error('W08 direct edit missing');
        return replaceSolid(current, feature.id, { ...feature, offset: routeExpression(shape === 'A' ? '4' : '10') });
      } };
  }
  const built = await build(shape, route, session.bridge);
  return { ...built, shapes: new Map<string, Uint8Array>(), edit: (part: PartDocument): PartDocument => {
    const input = { ...built, part };
    if (shape === 'A') {
      const hole = part.solids.find(feature => feature.id === built.finalId);
      if (hole?.kind !== 'hole' || hole.centers[0] === undefined) throw new Error('W08 bracket point missing');
      const bracket = { ...input, centerId: hole.centers[0].pointFeatureId };
      return route === 'sketch' ? editEx18SketchHoleDiameter(bracket) : route === 'surface/wire'
        ? editEx18SewnDiameter(bracket) : editEx18ExpressionDiameter(bracket);
    }
    if (shape === 'B') return route === 'sketch' ? editEx18RevolvedFlangeRadius(input)
      : editEx18FlangeBore(input, route === 'expression' ? '2*4' : '8');
    return editEx18ObliqueDepth(input, route === 'expression' ? '3*4' : '12');
  } };
}

async function build(shape: W08Shape, route: Exclude<W08Route, 'direct STEP'>, bridge: KernelBridge) {
  if (shape === 'A') return route === 'sketch' ? buildEx18SketchBracket(bridge)
    : route === 'surface/wire' ? buildEx18SewnBracket(bridge) : buildEx18ExpressionBracket(bridge);
  if (shape === 'B') return route === 'sketch' ? buildEx18RevolvedFlange()
    : route === 'surface/wire' ? buildEx18RuledFlange(bridge) : buildEx18ExpressionFlange(bridge);
  return route === 'sketch' ? buildEx18ExtrudedOblique() : route === 'surface/wire' ? buildEx18SewnOblique() : buildEx18ExpressionOblique();
}

export { EX18_ORACLE_EXPECTATIONS };
