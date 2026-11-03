import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { createDirectKernelBridge, type SolidBody } from '../../kernelBridge.js';
import { appendSolid, nextSolidId, nextSolidName } from '../../part/createPartDocument.js';
import { recomputePart } from '../../part/recomputePart.js';
import { resolvePart } from '../../part/resolvePart.js';
import type { PartDocument } from '../../part/types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { applyPlacementToDirection, applyPlacementToPoint, composePlacement, placementToRigidTransform, type RigidPlacement } from '../placementMath.js';
import { buildCircularFilletWeldGeometry, type CircularFilletWeldGeometry, type CircularFilletWeldSection } from './circularFilletWeldGeometry.js';
import type { CircularWeldPathDefinition, CircularWeldPathEvidence } from './curvedWeldPath.js';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { resolveAssembly, type StandardPartSource } from '../resolveAssembly.js';
import { buildStandardPartFromSource } from '../standard/buildStandardPart.js';
import { readCircularFilletWeldSource } from './circularFilletWeldSource.js';

// Ownership and precision follow filletWeldKernel.test.ts: beforeAll 180s,
// releasePart in finally, relative native volume 1e-8 (line270), world digits4.
// A=3*4/2=6, centroid radii11/9, angle=pi/2: V=33pi/27pi mm^3.
// These are geometry tests, not current native-edge selection/contact/strength proof.
const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

function evidence(orientation: 1 | -1 = 1, placed = false): CircularWeldPathEvidence {
  const parent: RigidPlacement = { position: [10, 20, 30], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] };
  const child: RigidPlacement = { position: [3, 5, 7], rotation: [0, 0, 0, 1] };
  const world = composePlacement(parent, child);
  return {
    kind: 'circle-edge', source: { documentId: 'circular-native', ownerId: 'leaf', occurrencePath: ['parent', 'leaf'],
      sourceKey: 'part:revision-3', placementKey: placed ? 'parent-z90-child-offset' : 'identity',
      bodyFeatureId: 'source-revolve', bodyKey: 'source-body-3', edgeIndex: 4 },
    centerMm: placed ? applyPlacementToPoint(world, [0, 0, 0]) : [0, 0, 0],
    xAxis: placed ? applyPlacementToDirection(world, [1, 0, 0]) : [1, 0, 0],
    yAxis: placed ? applyPlacementToDirection(world, [0, 1, 0]) : [0, 1, 0],
    normal: [0, 0, 1], radiusMm: 10, parameterRange: [0, Math.PI / 2], orientation,
  };
}

function definition(e = evidence()): CircularWeldPathDefinition {
  return { kind: 'circular-weld-path', evidence: e, intervals: [{ beadId: 'bead-a', beadSourceKey: 'bead-revision-1',
    fromParameter: e.orientation === 1 ? e.parameterRange[0] : e.parameterRange[1],
    toParameter: e.orientation === 1 ? e.parameterRange[1] : e.parameterRange[0] }] };
}

function section(radialDirection: 1 | -1 = 1, beadId = 'bead-a'): CircularFilletWeldSection {
  return { beadId, radialLegMm: 3, normalLegMm: 4, radialDirection, normalDirection: 1 };
}

function admitted(d: CircularWeldPathDefinition, current: CircularWeldPathEvidence, s = section()): CircularFilletWeldGeometry {
  const result = buildCircularFilletWeldGeometry(d, current, structuredClone(d.intervals), s);
  if (result === null) throw new Error('Independent circle fixture rejected');
  return result;
}

function close(actual: Vec3, expected: Vec3): void {
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 4));
}

/** Apply the already-world placement through the EXISTING native transform feature once.
 * The fixtures rotate only about Z. No occurrence/parent composition follows this step. */
function worldPart(g: CircularFilletWeldGeometry, id: string): PartDocument {
  const resolved = resolvePart(g.part);
  expect(resolved.errors).toEqual([]);
  const [step, ...others] = resolved.steps;
  if (step?.plan.kind !== 'revolve' || others.length !== 0) throw new Error('Expected one existing revolve step');
  close(step.plan.axisOrigin, [0, 0, 0]);
  close(step.plan.axisDirection, [0, 0, g.path.definition.evidence.orientation]);
  const transform = placementToRigidTransform(g.placement);
  close(transform.rotationOrigin, [0, 0, 0]); close(transform.rotationAxis, [0, 0, 1]);
  return appendSolid({ ...g.part, id }, { id: nextSolidId(g.part, 'transform'), name: nextSolidName(g.part, 'transform'),
    kind: 'transform', suppressed: false, targetFeatureId: step.featureId,
    translation: [exactExpressionValueFromNumber(transform.translation[0]), exactExpressionValueFromNumber(transform.translation[1]),
      exactExpressionValueFromNumber(transform.translation[2])],
    rotationAxis: { kind: 'world', axis: 'z' }, rotationAngle: exactExpressionValueFromNumber(transform.rotationAngle * 180 / Math.PI) });
}

async function withBodies(parts: readonly PartDocument[], read: (bodies: readonly SolidBody[]) => void): Promise<void> {
  try {
    const bodies: SolidBody[] = [];
    for (const part of parts) {
      const result = await recomputePart(part, bridge);
      expect(result.errors, part.id).toEqual([]); expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0];
      if (body === undefined) throw new Error('Missing native body');
      expect(body.isValid).toBe(true); expect(body.mesh.positions.length).toBeGreaterThan(0);
      bodies.push(body);
    }
    read(bodies);
  } finally {
    for (const part of parts) await bridge.releasePart(part.id);
  }
}

function bodyAt(bodies: readonly SolidBody[], index = 0): SolidBody {
  const body = bodies[index]; if (body === undefined) throw new Error('Missing native body'); return body;
}

function volume(body: SolidBody, expected: number): void {
  expect(Number.isFinite(body.volume)).toBe(true);
  expect(Math.abs(body.volume - expected) / expected).toBeLessThan(1e-8);
}

function expectVertex(body: SolidBody, expected: Vec3): void {
  const first = body.vertices[0]; if (first === undefined) throw new Error('No native vertices');
  const distance = (point: Vec3): number => Math.hypot(point[0] - expected[0], point[1] - expected[1], point[2] - expected[2]);
  const nearest = body.vertices.reduce((best, row) => distance(row.position) < distance(best.position) ? row : best, first);
  close(nearest.position, expected);
}

function sector(body: SolidBody, radialDirection: 1 | -1, from: number, to: number, local: (point: Vec3) => Vec3 = point => point): void {
  const origin = body.coordinateFrame?.origin ?? [0, 0, 0], positions = body.mesh.positions;
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    const [x, y, z] = local([origin[0] + positions[offset], origin[1] + positions[offset + 1], origin[2] + positions[offset + 2]]);
    const r = Math.hypot(x, y), u = radialDirection * (r - 10);
    expect([x, y, z].every(Number.isFinite)).toBe(true);
    expect(u).toBeGreaterThanOrEqual(-1e-4); expect(z).toBeGreaterThanOrEqual(-1e-4);
    expect(u / 3 + z / 4).toBeLessThanOrEqual(1 + 1e-4);
    // Signed distances in mm to the two exact radial half-planes, not a chord/polyline path.
    expect(-Math.sin(from) * x + Math.cos(from) * y).toBeGreaterThanOrEqual(-1e-4);
    expect(-Math.sin(to) * x + Math.cos(to) * y).toBeLessThanOrEqual(1e-4);
  }
}

// Independently authored saved wire, matching the fixed IO fixture's source vocabulary.
// These historical references permit geometry restoration, never current contact admission.
function savedCircularSource(radialDirection: 1 | -1, orientation: 1 | -1): StandardPartSource {
  const parent = { documentId: 'assembly-1', ownerId: 'cylinder', occurrencePath: ['child', 'cylinder'], sourceKey: 'part:c@3',
    placementKey: 'pose-2', bodyFeatureId: 'primitive-1', bodyKey: 'body-c' };
  const payload = { weldId: 'weld-1', beadId: 'bead-1', radialDirection, normalDirection: 1,
    path: { kind: 'circular-weld-path', evidence: { kind: 'circle-edge', source: { ...parent, edgeIndex: 0 },
      centerMm: [11, 13, 17], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0], radiusMm: 10,
      parameterRange: [Math.PI / 2, Math.PI], orientation },
    intervals: [{ beadId: 'bead-1', beadSourceKey: 'draft-epoch-7', fromParameter: orientation === 1 ? Math.PI / 2 : Math.PI,
      toParameter: orientation === 1 ? Math.PI : Math.PI / 2 }] },
    parents: [
      { ...parent, role: 'plane', ownerId: 'plate', occurrencePath: ['child', 'plate'], sourceKey: 'part:p@4', bodyKey: 'body-p',
        reference: { bodyFeatureId: 'primitive-1', index: 1, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1600,
          position: [0, 0, 0], axis: [0, 0, 1], radius: null } } },
      { ...parent, role: 'cylinder', reference: { bodyFeatureId: 'primitive-1', index: 2,
        fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 200 * Math.PI, position: [0, 0, 5], axis: [0, 0, 1], radius: 10 } } },
    ] };
  const weldCircular = JSON.stringify(payload, (_key: string, value: unknown): unknown => typeof value !== 'object' || value === null || Array.isArray(value)
    ? value : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  return { kind: 'standardPart', catalog: 'filletWeld', catalogRevision: 'weld-1', generatorRevision: 'fillet-weld-5', size: '3x4', options: { weldCircular } };
}

function savedWorldVertex(body: SolidBody, placement: RigidPlacement, expected: Vec3): void {
  const first = body.vertices[0];
  if (first === undefined) throw new Error('No native saved vertices');
  const distance = (point: Vec3): number => Math.hypot(point[0] - expected[0], point[1] - expected[1], point[2] - expected[2]);
  const nearest = body.vertices.reduce((best, vertex) => distance(applyPlacementToPoint(placement, vertex.position))
    < distance(applyPlacementToPoint(placement, best.position)) ? vertex : best, first);
  close(applyPlacementToPoint(placement, nearest.position), expected);
}

async function savedCircularNative(radialDirection: 1 | -1): Promise<void> {
  const fixtures = ([1, -1] as const).map(orientation => {
    const source = savedCircularSource(radialDirection, orientation), saved = readCircularFilletWeldSource(source);
    if (saved === null) throw new Error('Strict saved v5 reader refused independent wire');
    expect(saved.section).toEqual({ beadId: 'bead-1', radialLegMm: 3, normalLegMm: 4, radialDirection, normalDirection: 1 });
    expect(saved.options.path.evidence.parameterRange).toEqual([Math.PI / 2, Math.PI]);
    expect(saved.options.path.evidence.orientation).toBe(orientation);
    const assembly = createAssemblyDocument('saved circular native');
    // Base R(x,y,z)=(z,x,y), composed with the explicit start angle once.
    const rotation: readonly [number, number, number, number] = orientation === 1
      ? [Math.SQRT1_2, 0, Math.SQRT1_2, 0] : [-.5, .5, -.5, .5];
    const component = createComponentFor(assembly, source, { partName: 'saved circular', placement: {
      position: [exactExpressionValueFromNumber(11), exactExpressionValueFromNumber(13), exactExpressionValueFromNumber(17)], rotation,
    } });
    const document = addComponent(assembly, component), resolved = resolveAssembly(document, { standardPart: buildStandardPartFromSource });
    expect(resolved.errors).toEqual([]);
    const placement = resolved.placements.get(component.id);
    if (placement === undefined) throw new Error('Saved component placement missing');
    close(placement.position, [11, 13, 17]);
    // resolveAssembly normalises the quaternion; allow only four double-precision ulps.
    // The independent native world vertices below still reject any wrong rotation.
    placement.rotation.forEach((value, axis) => expect(Math.abs(value - rotation[axis])).toBeLessThanOrEqual(4 * Number.EPSILON));
    const part = buildStandardPartFromSource(source);
    if (part === null) throw new Error('Saved standard source did not reconstruct');
    const local = resolvePart(part); expect(local.errors).toEqual([]);
    const plan = local.steps[0]?.plan;
    if (plan?.kind !== 'revolve' || local.steps.length !== 1) throw new Error('Expected local saved revolve only');
    expect(plan.profile.map(row => row.kind === 'segment' ? row.from : null))
      .toEqual([[10, 0, 0], [radialDirection === 1 ? 13 : 7, 0, 0], [10, 0, 4]]);
    expect(plan.angle).toBeCloseTo(Math.PI / 2, 14);
    return { orientation, placement, part: { ...part, id: `saved-circle-${String(radialDirection)}-${String(orientation)}` } };
  });
  await withBodies(fixtures.map(row => row.part), bodies => {
    expect(bodies).toHaveLength(2);
    const tip = radialDirection === 1 ? 13 : 7;
    // Raw [pi/2,pi], mapped independently by R=(z,x,y)+[11,13,17].
    const expectedWorld: readonly Vec3[] = [[11, 13, 27], [11, 13, 17 + tip], [15, 13, 27],
      [11, 3, 17], [11, 13 - tip, 17], [15, 3, 17]];
    fixtures.forEach(({ orientation, placement }, index) => {
      const body = bodyAt(bodies, index); volume(body, (radialDirection === 1 ? 33 : 27) * Math.PI);
      const endSign = orientation === 1 ? 1 : -1;
      for (const point of [[10, 0, 0], [tip, 0, 0], [10, 0, 4], [0, endSign * 10, 0],
        [0, endSign * tip, 0], [0, endSign * 10, 4]] satisfies Vec3[]) expectVertex(body, point);
      sector(body, radialDirection, orientation === 1 ? 0 : -Math.PI / 2, orientation === 1 ? Math.PI / 2 : 0);
      for (const vertex of body.vertices) {
        const world = applyPlacementToPoint(placement, vertex.position);
        // Independent inverse base map, keeping the original nonzero parameter range.
        const x = world[1] - 13, y = world[2] - 17, z = world[0] - 11, u = radialDirection * (Math.hypot(x, y) - 10);
        expect(world.every(Number.isFinite)).toBe(true);
        expect(x).toBeLessThanOrEqual(1e-4); expect(y).toBeGreaterThanOrEqual(-1e-4);
        expect(u).toBeGreaterThanOrEqual(-1e-4); expect(z).toBeGreaterThanOrEqual(-1e-4);
        expect(u / 3 + z / 4).toBeLessThanOrEqual(1 + 1e-4);
      }
      for (const point of expectedWorld) savedWorldVertex(body, placement, point);
      const cylinders = body.faces.filter(face => face.surfaceKind === 'cylinder'); expect(cylinders).toHaveLength(1);
      const cylinder = cylinders[0];
      if (cylinder?.axisOrigin == null || cylinder.axis === null) throw new Error('Missing saved native cylinder axis');
      expect(Math.hypot(cylinder.axisOrigin[0], cylinder.axisOrigin[1])).toBeCloseTo(0, 4);
      close([cylinder.axis[0], cylinder.axis[1], Math.abs(cylinder.axis[2])], [0, 0, 1]);
      expect(cylinder.radius).toBeCloseTo(10, 4);
      const worldOrigin = applyPlacementToPoint(placement, cylinder.axisOrigin), worldAxis = applyPlacementToDirection(placement, cylinder.axis);
      expect(Math.hypot(worldOrigin[1] - 13, worldOrigin[2] - 17)).toBeCloseTo(0, 4);
      close([Math.abs(worldAxis[0]), worldAxis[1], worldAxis[2]], [1, 0, 0]);
    });
  });
}

describe('native circular fillet meridian revolution: geometry only', () => {
  it.each([1, -1] as const)('has independent 33pi/27pi volume and exact endpoints for radial side %s', async radialDirection => {
    const d = definition(), g = admitted(d, evidence(), section(radialDirection));
    await withBodies([worldPart(g, `circle-radial-${String(radialDirection)}`)], bodies => {
      const body = bodyAt(bodies); volume(body, (radialDirection === 1 ? 33 : 27) * Math.PI);
      const tip = radialDirection === 1 ? 13 : 7;
      for (const p of [[10, 0, 0], [tip, 0, 0], [10, 0, 4], [0, 10, 0], [0, tip, 0], [0, 10, 4]] satisfies Vec3[]) expectVertex(body, p);
      sector(body, radialDirection, 0, Math.PI / 2);
    });
  });

  it('reversed traversal produces the same real quarter-circle geometry', async () => {
    const forward = admitted(definition(), evidence()), reverse = admitted(definition(evidence(-1)), evidence(-1));
    await withBodies([worldPart(forward, 'circle-forward'), worldPart(reverse, 'circle-reverse')], bodies => {
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        volume(body, 33 * Math.PI); sector(body, 1, 0, Math.PI / 2);
        for (const p of [[10, 0, 0], [13, 0, 0], [10, 0, 4], [0, 10, 0], [0, 13, 0], [0, 10, 4]] satisfies Vec3[]) expectVertex(body, p);
      }
    });
  });

  it('keeps the original nonzero partial-circle endpoints and native rotation axis', async () => {
    const saved = { ...evidence(), parameterRange: [Math.PI / 2, Math.PI] } satisfies CircularWeldPathEvidence;
    const current = { ...evidence(), parameterRange: [Math.PI / 2, Math.PI] } satisfies CircularWeldPathEvidence;
    const g = admitted(definition(saved), current);
    await withBodies([worldPart(g, 'circle-partial')], bodies => {
      const body = bodyAt(bodies); volume(body, 33 * Math.PI); sector(body, 1, Math.PI / 2, Math.PI);
      for (const p of [[0, 10, 0], [0, 13, 0], [0, 10, 4], [-10, 0, 0], [-13, 0, 0], [-10, 0, 4]] satisfies Vec3[]) expectVertex(body, p);
      const cylinders = body.faces.filter(face => face.surfaceKind === 'cylinder'); expect(cylinders).toHaveLength(1);
      const cylinder = cylinders[0];
      if (cylinder?.axisOrigin == null || cylinder.axis === null) throw new Error('Missing native cylinder axis');
      // An analytic axis may use any point along its line (OCCT returns z=4 here).
      // Compare perpendicular distance and direction; a shifted axis still fails.
      expect(Math.hypot(cylinder.axisOrigin[0], cylinder.axisOrigin[1])).toBeCloseTo(0, 4);
      close([cylinder.axis[0], cylinder.axis[1], Math.abs(cylinder.axis[2])], [0, 0, 1]);
      expect(cylinder.radius).toBeCloseTo(10, 4);
    });
  });

  it('applies parent Z90 and child translation as already-world geometry exactly once', async () => {
    const g = admitted(definition(evidence(1, true)), evidence(1, true));
    // Parent(10,20,30) + Rz90*(3,5,7) = (5,23,37), independent of builder output.
    close(g.placement.position, [5, 23, 37]);
    await withBodies([worldPart(g, 'circle-nested-world')], bodies => {
      const body = bodyAt(bodies); volume(body, 33 * Math.PI);
      for (const p of [[5, 33, 37], [5, 36, 37], [5, 33, 41], [-5, 23, 37], [-8, 23, 37], [-5, 23, 41]] satisfies Vec3[]) expectVertex(body, p);
      sector(body, 1, 0, Math.PI / 2, point => [point[1] - 23, 5 - point[0], point[2] - 37]);
    });
  });

  it('retains a pi/6 gap as two separate native solids with independent total22pi', async () => {
    const d = { ...definition(), intervals: [
      { beadId: 'bead-a', beadSourceKey: 'a-1', fromParameter: 0, toParameter: Math.PI / 6 },
      { beadId: 'bead-b', beadSourceKey: 'b-1', fromParameter: Math.PI / 3, toParameter: Math.PI / 2 },
    ] } satisfies CircularWeldPathDefinition;
    const first = admitted(d, evidence()), second = admitted(d, evidence(), section(1, 'bead-b'));
    await withBodies([worldPart(first, 'circle-gap-a'), worldPart(second, 'circle-gap-b')], bodies => {
      expect(bodies).toHaveLength(2); volume(bodyAt(bodies, 0), 11 * Math.PI); volume(bodyAt(bodies, 1), 11 * Math.PI);
      expect(Math.abs(bodies.reduce((sum, body) => sum + body.volume, 0) - 22 * Math.PI) / (22 * Math.PI)).toBeLessThan(1e-8);
      sector(bodyAt(bodies, 0), 1, 0, Math.PI / 6); sector(bodyAt(bodies, 1), 1, Math.PI / 3, Math.PI / 2);
      expectVertex(bodyAt(bodies, 0), [5 * Math.sqrt(3), 5, 0]); expectVertex(bodyAt(bodies, 1), [5, 5 * Math.sqrt(3), 0]);
    });
  });

  it('rejects stale source, placement and complete bead group before any recompute', () => {
    const d = definition(), recompute = vi.spyOn(bridge, 'recomputeSolids');
    try {
      for (const key of ['sourceKey', 'placementKey', 'bodyKey', 'ownerId'] as const) {
        const current = evidence();
        expect(buildCircularFilletWeldGeometry(d, { ...current, source: { ...current.source, [key]: 'changed' } }, d.intervals, section())).toBeNull();
      }
      expect(buildCircularFilletWeldGeometry(d, evidence(), [], section())).toBeNull();
      expect(buildCircularFilletWeldGeometry(d, evidence(), [{ ...d.intervals[0], beadSourceKey: 'changed' }], section())).toBeNull();
      expect(recompute).not.toHaveBeenCalled();
    } finally { recompute.mockRestore(); }
  });

  it('native saved circular v5 outer', async () => { await savedCircularNative(1); });

  it('native saved circular v5 inner', async () => { await savedCircularNative(-1); });
});
