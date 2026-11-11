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
import { type CircularWeldContactRequest } from './circularWeldContact.js';
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

import type { JointOccurrenceCommandContext } from '../jointOccurrenceSelection.js';
import { buildStandardPartFromSource } from '../standard/buildStandardPart.js';
import { planCircularFilletWeld, type CircularFilletWeldRequest } from './planCircularFilletWeld.js';
import { applyCircularFilletWeld } from './applyCircularFilletWeld.js';
import { readCircularFilletWeldSource } from './circularFilletWeldSource.js';
import { resolvePart } from '../../part/resolvePart.js';
import { applyPlacementToPoint } from '../placementMath.js';

async function fixture(deep = false) {
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
function preview(context: JointOccurrenceCommandContext, choices: CircularFilletWeldRequest) {
  const result = planCircularFilletWeld(context, choices);
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}
function nextContext(context: JointOccurrenceCommandContext, document: AssemblyDocument): JointOccurrenceCommandContext {
  const inputs = { ...context.inputs, document };
  return { ...context, inputs, view: { source: inputs, resolved: resolveAssembly(document,
    { library: inputs.library, subAssemblies: inputs.subAssemblies, standardPart: buildStandardPartFromSource }) } };
}

describe('circular root plan current admission', () => {
  it.each([false, true])('captures actual world source/parents/quarter-sector and material with nested=%s', async deep => {
    const f = await fixture(deep), before = JSON.stringify(f.context.inputs.document), p = preview(f.context, f.choices);
    expect(p.beads).toHaveLength(1); expect(p.contacts).toHaveLength(1);
    expect(p.contacts[0].planeAreaMm2).toBeCloseTo(69 * Math.PI / 4, 10);
    expect(p.contacts[0].cylinderAreaMm2).toBeCloseTo(20 * Math.PI, 10);
    const bead = p.beads[0], saved = readCircularFilletWeldSource(bead.source);
    if (saved === null) throw new Error('Generated source must decode');
    expect(bead.materialId).toBe('stainless'); expect(bead.source.size).toBe('3x4');
    expect(saved.options.parents.map(parent => parent.occurrencePath)).toEqual([f.choices.plane.path, f.choices.cylinder.path]);
    expect(saved.options.path.evidence.source).toEqual(f.evidence.source);
    expect(saved.options.path.intervals[0].beadSourceKey.startsWith('draft:')).toBe(true);
    expect(saved.options.path.intervals[0].beadSourceKey).not.toContain('filletWeld@');
    expect(bead.placement.position.map(value => value.value)).toEqual(deep ? [11, 13, 17] : [0, 0, 0]);
    if (deep) {
      const placement = { position: [bead.placement.position[0].value, bead.placement.position[1].value, bead.placement.position[2].value] as Vec3,
        rotation: bead.placement.rotation };
      const tip = applyPlacementToPoint(placement, [13, 0, 0]);
      [11, 26, 17].forEach((value, axis) => expect(tip[axis]).toBeCloseTo(value, 11));
      const normalTip = applyPlacementToPoint(placement, [10, 0, 4]);
      [15, 23, 17].forEach((value, axis) => expect(normalTip[axis]).toBeCloseTo(value, 11));
    }
    expect(JSON.stringify(f.context.inputs.document)).toBe(before);
    expect(Object.isFrozen(p.request.section)).toBe(true);
  });
  it('uses the explicit inward material side and independent 27pi geometry rather than exterior contact', async () => {
    const f = await fixture();
    // Pure current-body certificate only; this is not a native hollow-cylinder claim.
    f.bodies.set(f.cylinderKey, [{ ...f.cylinder, faces: f.cylinder.faces.map(face => ({ ...face, cylinderExterior: false })) }]);
    const request: CircularFilletWeldRequest = { ...f.choices, section: { ...f.choices.section, radialDirection: -1 } };
    const p = preview(f.context, request), part = buildStandardPartFromSource(p.beads[0].source);
    if (part === null) throw new Error('Inward saved part missing');
    const plan = resolvePart(part).steps[0]?.plan;
    if (plan?.kind !== 'revolve') throw new Error('Expected exact existing revolve');
    expect(plan.profile.map(row => row.kind === 'segment' ? row.from : null)).toEqual([[10, 0, 0], [7, 0, 0], [10, 0, 4]]);
    expect(plan.angle * 6 * 9).toBeCloseTo(27 * Math.PI, 11);
    expect(p.contacts[0].planeAreaMm2).toBeCloseTo(51 * Math.PI / 4, 10);
    expect(p.contacts[0].cylinderAreaMm2).toBeCloseTo(20 * Math.PI, 10);
  });
  it('plans both actual intervals and their gap without inventing a continuous bead', async () => {
    const f = await fixture(), choices = { ...f.choices, intervals: [
      { beadId: 'a', fromParameter: 0, toParameter: Math.PI / 4 },
      { beadId: 'b', fromParameter: Math.PI / 2, toParameter: 3 * Math.PI / 4 }] };
    const p = preview(f.context, choices);
    expect(p.beads).toHaveLength(2);
    expect(p.contacts.reduce((sum, row) => sum + row.planeAreaMm2, 0)).toBeCloseTo(69 * Math.PI / 4, 10);
    expect(p.contacts.reduce((sum, row) => sum + row.cylinderAreaMm2, 0)).toBeCloseTo(20 * Math.PI, 10);
    const source = p.beads.map(bead => readCircularFilletWeldSource(bead.source));
    expect(source.map(row => row?.options.beadId)).toEqual(['a', 'b']);
    expect(source[0]?.options.path.intervals.map(row => [row.fromParameter, row.toParameter]))
      .toEqual([[0, Math.PI / 4], [Math.PI / 2, 3 * Math.PI / 4]]);
    // Independent Pappus integral: each interval pi/4 * A6 * centroidR11.
    expect(2 * Math.PI / 4 * 6 * 11).toBeCloseTo(33 * Math.PI, 11);
  });
  it.each(['missing-material', 'zero-leg', 'overlap', 'duplicate', 'out-of-range', 'missing-interval'])('rejects %s without producing partial beads', async bad => {
    const f = await fixture(), row = f.choices.intervals[0]; let request = f.choices;
    if (bad === 'missing-material') request = { ...request, materialId: 'invented-density' };
    if (bad === 'zero-leg') request = { ...request, section: { ...request.section, normalLegMm: 0 } };
    if (bad === 'overlap') request = { ...request, intervals: [row, { ...row, beadId: 'b' }] };
    if (bad === 'duplicate') request = { ...request, intervals: [row, row] };
    if (bad === 'out-of-range') request = { ...request, intervals: [row, { beadId: 'b', fromParameter: 10, toParameter: 11 }] };
    if (bad === 'missing-interval') request = { ...request, intervals: [] };
    const before = JSON.stringify(f.context.inputs.document), result = planCircularFilletWeld(f.context, request);
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('plan');
    expect(JSON.stringify(f.context.inputs.document)).toBe(before);
  });
  it.each(['sourceKey', 'placementKey', 'bodyKey'] as const)('refuses stale face %s rather than admitting saved evidence', async key => {
    const f = await fixture();
    expect(planCircularFilletWeld(f.context, { ...f.choices, plane: { ...f.choices.plane, [key]: 'past' } }).ok).toBe(false);
  });
  it('keeps same-motion-owner rejection for deep shared child leaves', async () => {
    const f = await fixture(true);
    const result = planCircularFilletWeld(f.context, { ...f.choices, plane: { ...f.choices.plane, path: ['owner-b', 'plane'] } });
    expect(result).toEqual({ ok: false, reason: 'same-owner-unsupported' });
  });
  it.each(['section', 'document-reference', 'body'])('rejects %s mutation during body lookup', async kind => {
    const f = await fixture(), request = structuredClone(f.choices); let calls = 0;
    const context = { ...f.context, bodiesOf: (o: Parameters<typeof f.context.bodiesOf>[0]) => {
      if (++calls === 4) {
        if (kind === 'section') Reflect.set(request.section, 'normalLegMm', 5);
        if (kind === 'document-reference') Reflect.set(f.context.inputs, 'document', { ...f.context.inputs.document });
        if (kind === 'body') f.bodies.set(f.planeKey, [{ ...f.plane, faces: f.plane.faces.map(face => ({ ...face, boundaryEdgeIndices: [] })) }]);
      }
      return f.context.bodiesOf(o);
    } };
    expect(planCircularFilletWeld(context, request).ok).toBe(false);
  });
  it('returns an owned author snapshot unaffected by later request edits and never calls old straight planning', async () => {
    const f = await fixture(), request = structuredClone(f.choices), p = preview(f.context, request);
    Reflect.set(request.section, 'normalLegMm', 5); Reflect.set(request.intervals[0], 'toParameter', .1);
    expect(p.request.section.normalLegMm).toBe(4); expect(p.request.intervals[0].toParameter).toBe(Math.PI / 2);
    expect(Object.isFrozen(p.beads[0].source.options)).toBe(true);
    const applied = applyCircularFilletWeld(f.context, f.choices, p);
    if (!applied.ok) throw new Error(applied.reason);
    expect(planCircularFilletWeld(nextContext(f.context, applied.document), f.choices).ok).toBe(false);
  });
});
