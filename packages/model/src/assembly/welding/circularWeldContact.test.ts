import { expressionValueFromNumber as number } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { SolidBody, SolidEdgeEntry } from '../../kernelBridge/solidContracts.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { resolveJointOccurrence, type JointOccurrenceInputs } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import { resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { resolveCircularWeldSelection, type CircularWeldSelectionContext } from './circularWeldSelection.js';
import { resolveCircularWeldContact, type CircularWeldContactRequest } from './circularWeldContact.js';
import { weldTestBox, weldTestPlacement } from './filletWeld.testSupport.js';

function circle(index: number, radius: number, z = 0, center: Vec3 = [0, 0, z]): SolidEdgeEntry {
  return { index, curveKind: 'circle', length: 2 * Math.PI * radius, midpoint: center,
    start: [center[0] + radius, center[1], z], end: [center[0] + radius, center[1], z], axis: [0, 0, 1], axisOrigin: center, radius,
    circleBasis: { origin: center, xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1], parameterRange: [0, 2 * Math.PI], orientation: 1 },
    segmentOffset: 0, segmentCount: 1 };
}
function reference(body: SolidBody, index: number): SubShapeRef {
  const f = body.faces.find(face => face.index === index);
  if (f === undefined) throw new Error('Missing fixture face');
  return { bodyFeatureId: body.featureId, index, fingerprint: { kind: 'face', surfaceKind: f.surfaceKind, area: f.area,
    position: f.centroid, axis: f.axis, radius: f.radius } };
}
async function fixture(deep = false) {
  const primitive = (cylinder: boolean): PrimitiveFeature => ({ id: 'extrude-1', name: 'material', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, cylinder ? 0 : -5) }, axis: { kind: 'world', axis: 'z' },
    shape: cylinder ? { kind: 'cylinder', radius: number(10), height: number(10) }
      : { kind: 'box', sizeX: number(40), sizeY: number(40), sizeZ: number(10) } });
  const first = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), primitive(true)), 'cylinder.pcad', 'cylinder', { importedAt: '2026-10-16T00:00:00.000Z' });
  const second = await embedPart(first.library, appendSolid(createEmptyPartDocument(), primitive(false)), 'base.pcad', 'base', { importedAt: '2026-10-16T00:00:00.000Z' });
  const component = (id: string, partRef: string): AssemblyComponent => ({ id, name: id, source: { kind: 'part', partRef },
    placement: weldTestPlacement([0, 0, 0]), fixed: true, visible: true, suppressed: false });
  const child = { ...createAssemblyDocument('pair'), components: [component('cylinder', first.partRef), component('plane', second.partRef)] };
  const subAssemblies = new Map<string, AssemblyDocument>();
  const document = deep ? { ...createAssemblyDocument('root'), components: [{ id: 'parent', name: 'parent',
    source: { kind: 'subAssembly' as const, assemblyRef: 'child' }, placement: weldTestPlacement([11, 13, 17], [.5, .5, .5, .5]),
    fixed: true, visible: true, suppressed: false }] } : child;
  if (deep) subAssemblies.set('child', child);
  const inputs: JointOccurrenceInputs = { document, library: { ...second.library, assemblies: subAssemblies }, subAssemblies };
  const plane = { ...weldTestBox([-20, -20, -10], [20, 20, 0]), bodyKind: 'solid' as const };
  const top = { ...plane.faces[5], planarBasis: { origin: [0, 0, 0] as Vec3, xAxis: [1, 0, 0] as Vec3,
    yAxis: [0, 1, 0] as Vec3, normal: [0, 0, 1] as Vec3 }, boundaryEdgeIndices: [4, 5, 6, 7] };
  plane.faces = plane.faces.map(face => face.index === 5 ? top : face);
  const cylinder: SolidBody = { ...weldTestBox([-10, -10, 0], [10, 10, 10]), bodyKind: 'solid',
    edges: [circle(0, 10), circle(1, 10, 10), { index: 2, curveKind: 'line', start: [10, 0, 0], end: [10, 0, 10],
      midpoint: [10, 0, 5], length: 10, axis: [0, 0, 1], radius: null, segmentOffset: 0, segmentCount: 1 }],
    faces: [{ index: 0, surfaceKind: 'cylinder', area: 200 * Math.PI, centroid: [0, 0, 5], axis: [0, 0, 1],
      axisOrigin: [0, 0, 0], radius: 10, cylinderSpan: [0, 10], cylinderExterior: true, triangleOffset: 0, triangleCount: 0,
      boundaryEdgeIndices: [0, 1, 2] }] };
  const bodies = new Map<string, readonly SolidBody[]>([[first.partRef, [cylinder]], [second.partRef, [plane]]]);
  const context: CircularWeldSelectionContext = { inputs, view: { source: inputs, resolved: resolveAssembly(document, { library: inputs.library, subAssemblies }) },
    bodiesOf: occurrence => bodies.get(occurrence.partKey) ?? null };
  const path = (id: string): string[] => deep ? ['parent', id] : [id];
  const pick = (id: string, body: SolidBody, index: number) => {
    const result = resolveJointOccurrence(inputs, path(id), context.view);
    if (!result.ok) throw new Error(result.code);
    const o = result.occurrence, step = o.resolvedPart.steps.find(step => step.featureId === body.featureId);
    if (step === undefined) throw new Error('Missing current key');
    return { path: path(id), reference: reference(body, index), sourceKey: o.sourceKey, bodyKey: step.key,
      placementKey: JSON.stringify([o.worldPlacement.position, o.worldPlacement.rotation]) };
  };
  const edge = { path: path('cylinder'), reference: { bodyFeatureId: cylinder.featureId, index: 0, fingerprint: { kind: 'edge' as const,
    curveKind: 'circle' as const, length: 20 * Math.PI, position: [0, 0, 0] as Vec3, axis: [0, 0, 1] as Vec3, radius: 10 } } };
  const evidence = resolveCircularWeldSelection(context, edge.path, edge.reference);
  if (evidence === null) throw new Error('Missing current circle');
  const beads = [{ beadId: 'bead', beadSourceKey: 'cad-bead-source', fromParameter: 0, toParameter: Math.PI / 2 }];
  const request: CircularWeldContactRequest = { edge, plane: pick('plane', plane, 5), cylinder: pick('cylinder', cylinder, 0),
    definition: { kind: 'circular-weld-path', evidence, intervals: beads }, currentBeads: beads,
    section: { radialLegMm: 3, normalLegMm: 4, radialDirection: 1, normalDirection: 1 } };
  return { context, request, plane, cylinder, bodies, planeKey: second.partRef, cylinderKey: first.partRef, evidence };
}
function success(value: ReturnType<typeof resolveCircularWeldContact>) {
  expect(value.reason).toBeNull(); expect(value.contacts).toHaveLength(1); return value.contacts[0];
}
describe('finite circular weld contact', () => {
  it.each([false, true])('proves independent sector areas with parent placement %s applied once', async deep => {
    const f = await fixture(deep), before = JSON.stringify(f.request), result = resolveCircularWeldContact(f.context, f.request);
    const row = success(result);
    expect(row.planeAreaMm2).toBeCloseTo(69 * Math.PI / 4, 10);
    expect(row.cylinderAreaMm2).toBeCloseTo(20 * Math.PI, 10);
    expect(row.coveredRatio).toBeCloseTo(1, 10);
    expect(JSON.stringify(f.request)).toBe(before); expect(Object.isFrozen(result.contacts)).toBe(true);
  });
  it.each([1, -1] as const)('keeps nonzero raw range and orientation %s', async orientation => {
    const f = await fixture(), edge = f.cylinder.edges[0], basis = edge.circleBasis;
    if (basis === undefined) throw new Error('Missing basis');
    f.bodies.set(f.cylinderKey, [{ ...f.cylinder, edges: [{ ...edge, circleBasis: { ...basis, orientation } }, ...f.cylinder.edges.slice(1)] }]);
    const evidence = resolveCircularWeldSelection(f.context, f.request.edge.path, f.request.edge.reference);
    const bead = { beadId: 'offset', beadSourceKey: 'actual-cad', fromParameter: orientation === 1 ? Math.PI / 2 : Math.PI,
      toParameter: orientation === 1 ? Math.PI : Math.PI / 2 };
    const result = success(resolveCircularWeldContact(f.context, { ...f.request,
      definition: { kind: 'circular-weld-path', evidence, intervals: [bead] }, currentBeads: [bead] }));
    expect(result.planeAreaMm2).toBeCloseTo(69 * Math.PI / 4, 10);
  });
  it('checks disjoint actual beads independently and does not fill gaps', async () => {
    const f = await fixture();
    const hole = circle(12, .01, 0, [0, 11, 0]), top = { ...f.plane.faces[5], boundaryEdgeIndices: [4, 5, 6, 7, 12] };
    f.bodies.set(f.planeKey, [{ ...f.plane, edges: [...f.plane.edges, hole], faces: f.plane.faces.map(face => face.index === 5 ? top : face) }]);
    const beads = [{ beadId: 'a', beadSourceKey: 'a', fromParameter: 0, toParameter: Math.PI / 4 },
      { beadId: 'b', beadSourceKey: 'b', fromParameter: Math.PI, toParameter: 5 * Math.PI / 4 }];
    const result = resolveCircularWeldContact(f.context, { ...f.request,
      definition: { kind: 'circular-weld-path', evidence: f.evidence, intervals: beads }, currentBeads: beads });
    expect(result.reason).toBeNull(); expect(result.contacts).toHaveLength(2);
    expect(result.contacts.map(row => row.planeAreaMm2)).toEqual([69 * Math.PI / 8, 69 * Math.PI / 8]);
  });
  it.each(['small-hole', 'face-end', 'unsupported', 'missing-boundary', 'invalid-index', 'empty-boundary', 'wrong-normal', 'empty-mesh'])('refuses selected plane %s', async bad => {
    const f = await fixture(); let plane = f.plane, top = plane.faces[5];
    if (bad === 'small-hole') {
      const hole = circle(12, .00001, 0, [8, 8, 0]);
      plane = { ...plane, edges: [...plane.edges, hole] };
      top = { ...top, boundaryEdgeIndices: [4, 5, 6, 7, 12] };
    }
    if (bad === 'face-end') {
      plane = { ...weldTestBox([-20, -20, -10], [12.9, 20, 0]), bodyKind: 'solid' };
      top = { ...plane.faces[5], planarBasis: top.planarBasis, boundaryEdgeIndices: [4, 5, 6, 7] };
    }
    if (bad === 'unsupported') plane = { ...plane, edges: plane.edges.map(e => e.index === 4 ? { ...e, curveKind: 'ellipse' } : e) };
    if (bad === 'missing-boundary') { const copy = { ...top }; Reflect.deleteProperty(copy, 'boundaryEdgeIndices'); top = copy; }
    if (bad === 'invalid-index') top = { ...top, boundaryEdgeIndices: [4, 5, 6, 999] };
    if (bad === 'empty-boundary') top = { ...top, boundaryEdgeIndices: [] };
    if (bad === 'wrong-normal') top = { ...top, planarBasis: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, -1, 0], normal: [0, 0, -1] } };
    if (bad === 'empty-mesh') top = { ...top, triangleCount: 0 };
    f.bodies.set(f.planeKey, [{ ...plane, faces: plane.faces.map(face => face.index === 5 ? top : face) }]);
    expect(resolveCircularWeldContact(f.context, f.request).reason).not.toBeNull();
  });
  it('distinguishes analytic containment from display triangles when the selected face has a large hole', async () => {
    const f = await fixture(), hole = circle(12, 18), top = { ...f.plane.faces[5], boundaryEdgeIndices: [4, 5, 6, 7, 12] };
    f.bodies.set(f.planeKey, [{ ...f.plane, edges: [...f.plane.edges, hole], faces: f.plane.faces.map(face => face.index === 5 ? top : face) }]);
    // The uncut display triangles deliberately still cover the sector: they cannot certify the missing material.
    expect(resolveCircularWeldContact(f.context, f.request).reason).toBe('notInsideSelectedFace');
  });
  it.each(['partial-cylinder', 'short-band', 'interior-wall', 'wrong-radius', 'missing-cylinder-boundary'])('refuses %s', async bad => {
    const f = await fixture(), face = f.cylinder.faces[0];
    const changed = { ...face, ...(bad === 'partial-cylinder' ? { cylinderSpan: null, cylinderAxialExtent: [0, 10] as const } : {}),
      ...(bad === 'short-band' ? { cylinderSpan: [0, 3.9] as const } : {}), ...(bad === 'interior-wall' ? { cylinderExterior: false } : {}),
      ...(bad === 'wrong-radius' ? { radius: 11 } : {}) };
    if (bad === 'missing-cylinder-boundary') Reflect.deleteProperty(changed, 'boundaryEdgeIndices');
    f.bodies.set(f.cylinderKey, [{ ...f.cylinder, faces: [changed] }]);
    expect(resolveCircularWeldContact(f.context, f.request).reason).not.toBeNull();
  });
  it.each(['sourceKey', 'bodyKey', 'placementKey'] as const)('refuses stale face %s even if geometry looks identical', async key => {
    const f = await fixture();
    expect(resolveCircularWeldContact(f.context, { ...f.request, plane: { ...f.request.plane, [key]: 'stale' } }).reason).not.toBeNull();
  });
  it.each(['stale-definition', 'wrong-path', 'empty-path', 'same-owner', 'stale-view', 'double-world'])('refuses %s', async bad => {
    const f = await fixture(bad === 'double-world'); let request = f.request, context = f.context;
    if (bad === 'stale-definition') request = { ...request, definition: { kind: 'circular-weld-path', evidence: { ...f.evidence, radiusMm: 11 }, intervals: request.currentBeads } };
    if (bad === 'wrong-path') request = { ...request, plane: { ...request.plane, path: ['cylinder'] } };
    if (bad === 'empty-path') request = { ...request, edge: { ...request.edge, path: [] } };
    if (bad === 'same-owner') request = { ...request, plane: request.cylinder };
    if (bad === 'stale-view') context = { ...context, inputs: { ...context.inputs, document: { ...context.inputs.document } } };
    if (bad === 'double-world') {
      const top = f.plane.faces[5], basis = top.planarBasis;
      if (basis === undefined) throw new Error('Missing material basis');
      f.bodies.set(f.planeKey, [{ ...f.plane, faces: f.plane.faces.map(face => face.index === 5 ? { ...top,
        planarBasis: { ...basis, origin: [11, 13, 17] } } : face) }]);
    }
    expect(resolveCircularWeldContact(context, request).reason).not.toBeNull();
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid leg %s', async leg => {
    const f = await fixture();
    expect(resolveCircularWeldContact(f.context, { ...f.request, section: { ...f.request.section, radialLegMm: leg } }).reason).toBe('invalidSection');
  });
});

describe('circular contact admission snapshots', () => {
  it('checks a whole revolution using its independent complete areas', async () => {
    const f = await fixture(), bead = { beadId: 'ring', beadSourceKey: 'ring-source', fromParameter: 0, toParameter: 2 * Math.PI };
    const row = success(resolveCircularWeldContact(f.context, { ...f.request,
      definition: { kind: 'circular-weld-path', evidence: f.evidence, intervals: [bead] }, currentBeads: [bead] }));
    expect(row.planeAreaMm2).toBeCloseTo(69 * Math.PI, 10);
    expect(row.cylinderAreaMm2).toBeCloseTo(80 * Math.PI, 10);
  });
  it('rejects a selection changed by a synchronous body lookup without publishing partial success', async () => {
    const f = await fixture(); let calls = 0;
    const context = { ...f.context, bodiesOf: (o: Parameters<typeof f.context.bodiesOf>[0]) => {
      if (++calls === 4) {
        const top = { ...f.plane.faces[5], boundaryEdgeIndices: [] };
        f.bodies.set(f.planeKey, [{ ...f.plane, faces: f.plane.faces.map(face => face.index === 5 ? top : face) }]);
      }
      return f.context.bodiesOf(o);
    } };
    const result = resolveCircularWeldContact(context, f.request);
    expect(result.reason).toBe('selectionChanged'); expect(result.contacts).toEqual([]);
  });
});

describe('circular contact review regression', () => {
  it.each(['beads-only', 'definition-and-beads', 'section'])('rejects %s changed during final lookup', async changed => {
    const f = await fixture();
    const authored = [{ beadId: 'bead', beadSourceKey: 'cad-bead-source', fromParameter: 0, toParameter: Math.PI / 2 }];
    const current = changed === 'definition-and-beads' ? authored : authored.map(bead => ({ ...bead }));
    const section = { radialLegMm: 3, normalLegMm: 4, radialDirection: 1 as const, normalDirection: 1 as const };
    const request = { ...f.request, definition: { kind: 'circular-weld-path', evidence: f.evidence, intervals: authored },
      currentBeads: current, section };
    let calls = 0;
    const context = { ...f.context, bodiesOf: (o: Parameters<typeof f.context.bodiesOf>[0]) => {
      if (++calls === 4) {
        if (changed === 'section') section.normalLegMm = 5;
        else current[0].toParameter = Math.PI / 3;
      }
      return f.context.bodiesOf(o);
    } };
    const result = resolveCircularWeldContact(context, request);
    // The admitted quarter-sector was 69*pi/4 and 20*pi before the callback.
    // Changed authored/current values must never publish that earlier admission.
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(result.reason).toBe('selectionChanged'); expect(result.contacts).toEqual([]);
  });
});
