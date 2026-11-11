import { expressionValueFromNumber as number } from '@pointercad/expression';
import type { SubShapeRef } from '@pointercad/model';
import type { SolidBody, SolidEdgeEntry } from '@pointercad/model';
import { appendSolid, createEmptyPartDocument } from '@pointercad/model';
import type { PrimitiveFeature } from '@pointercad/model';
import { absoluteCoordinate } from '@pointercad/model';
import type { Vec3 } from '@pointercad/model';
import { createAssemblyDocument } from '@pointercad/model';
import { resolveJointOccurrence, type JointOccurrenceInputs } from '@pointercad/model';
import { embedPart, EMPTY_PART_LIBRARY } from '@pointercad/model';
import { resolveAssembly } from '@pointercad/model';
import type { AssemblyComponent, AssemblyDocument } from '@pointercad/model';
import { resolveCircularWeldSelection, type CircularWeldSelectionContext } from '@pointercad/model';
import { type CircularWeldContactRequest } from '@pointercad/model/testing/ui-fixtures';
import { weldTestBox, weldTestPlacement } from '@pointercad/model/testing/ui-fixtures';

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
async function physicalFixture(deep = false) {
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
  const document = deep ? { ...createAssemblyDocument('root'), components: ['owner-a', 'owner-b'].map(id => ({ id, name: id,
    source: { kind: 'subAssembly' as const, assemblyRef: 'child' }, placement: weldTestPlacement([11, 13, 17], [.5, .5, .5, .5]),
    fixed: true, visible: true, suppressed: false })) } : child;
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
  const path = (id: string): string[] => deep ? [id === 'cylinder' ? 'owner-b' : 'owner-a', id] : [id];
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

import type { JointOccurrenceCommandContext } from '@pointercad/model';
import { buildStandardPartFromSource } from '@pointercad/model';
import { type CircularFilletWeldRequest } from '@pointercad/model';

export async function circularWeldFixture(deep = false) {
  const f = await physicalFixture(deep);
  const context: JointOccurrenceCommandContext = { ...f.context,
    partDocument: o => f.context.inputs.library.parts.get(o.partKey) ?? null,
    resolveFace: () => { throw new Error('Unused bolt-only resolution must not run'); },
    resolveWeldGeometry: () => { throw new Error('Old straight weld binding must not run'); },
  };
  const choices: CircularFilletWeldRequest = { operation: 'create', weldId: 'weld-circle-1', draftEpoch: 'authored-1',
    edge: f.request.edge, plane: f.request.plane, cylinder: f.request.cylinder,
    intervals: [{ beadId: 'a', fromParameter: 0, toParameter: Math.PI / 2 }], section: f.request.section, materialId: 'stainless' };
  return { ...f, context, choices };
}
export function nextCircularWeldContext(context: JointOccurrenceCommandContext, document: AssemblyDocument): JointOccurrenceCommandContext {
  const inputs = { ...context.inputs, document };
  return { ...context, inputs, view: { source: inputs, resolved: resolveAssembly(document,
    { library: inputs.library, subAssemblies: inputs.subAssemblies, standardPart: buildStandardPartFromSource }) } };
}

