import { expressionValueFromNumber as number } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { SolidBody, SolidEdgeEntry } from '../../kernelBridge/solidContracts.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import { resolvePart } from '../../part/resolvePart.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { resolveJointOccurrence, type JointOccurrenceInputs } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import { resolveAssembly } from '../resolveAssembly.js';
import { applyPlacementToPoint, composePlacement, type RigidPlacement } from '../placementMath.js';
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
import { createCircularFilletWeldSource, readCircularFilletWeldSource } from './circularFilletWeldSource.js';

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

function movedDocument(document: AssemblyDocument, move: RigidPlacement, ids: readonly string[] = document.components.map(c => c.id)): AssemblyDocument {
  return { ...document, components: document.components.map(c => {
    if (!ids.includes(c.id)) return c;
    const pose = composePlacement(move, { position: [c.placement.position[0].value, c.placement.position[1].value, c.placement.position[2].value], rotation: c.placement.rotation });
    return { ...c, placement: weldTestPlacement(pose.position, pose.rotation) };
  }) };
}
function repick(context: JointOccurrenceCommandContext, choices: CircularFilletWeldRequest): CircularFilletWeldRequest {
  const current = (pick: CircularFilletWeldRequest['plane']) => {
    const r = resolveJointOccurrence(context.inputs, pick.path, context.view);
    if (!r.ok) throw new Error(r.code);
    return { ...pick, sourceKey: r.occurrence.sourceKey,
      placementKey: JSON.stringify([r.occurrence.worldPlacement.position, r.occurrence.worldPlacement.rotation]) };
  };
  return { ...choices, operation: 'replace', draftEpoch: 'current-rigid-edit', plane: current(choices.plane), cylinder: current(choices.cylinder) };
}

describe('circular rigid edit current reselection', () => {
  const moves: readonly RigidPlacement[] = [
    { position: [11, 13, 17], rotation: [.5, .5, .5, .5] },
    { position: [11, 13, 17], rotation: [0, 0, 0, 1] },
  ];
  it.each(moves)('replaces the complete moved group at current world pose %j', async move => {
    const f = await fixture();
    const choices = { ...f.choices, intervals: [{ beadId: 'a', fromParameter: 0, toParameter: Math.PI / 4 },
      { beadId: 'b', fromParameter: Math.PI / 2, toParameter: 3 * Math.PI / 4 }] };
    const first = applyCircularFilletWeld(f.context, choices, preview(f.context, choices));
    if (!first.ok) throw new Error(first.reason);
    const document = movedDocument(first.document, move), context = nextContext(f.context, document), before = JSON.stringify(document);
    const request = repick(context, choices), p = preview(context, request), result = applyCircularFilletWeld(context, request, p);
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.stringify(document)).toBe(before);
    expect(result.componentIds).toHaveLength(2); expect(new Set(result.componentIds).size).toBe(2);
    expect(result.document.components.some(c => first.componentIds.includes(c.id))).toBe(false);
    expect(result.componentIds.every(id => !first.componentIds.includes(id))).toBe(true);
    expect(result.document.mates).toBe(document.mates); expect(result.document.joints).toBe(document.joints);
    expect(result.document.jointOccurrenceConnections).toEqual([result.connection]);
    for (const id of ['plane', 'cylinder']) expect(result.document.components.find(c => c.id === id)).toBe(document.components.find(c => c.id === id));
    const bead = result.document.components.find(c => c.id === result.componentIds[0]);
    if (bead?.source.kind !== 'standardPart') throw new Error('Missing current bead');
    const saved = readCircularFilletWeldSource(bead.source);
    expect(saved?.options.parents.map(p => p.placementKey)).toEqual([request.plane.placementKey, request.cylinder.placementKey]);
    expect(bead.materialId).toBe('stainless'); expect(bead.rigidGroupId).toBe('fastening-1');
    const part = buildStandardPartFromSource(bead.source);
    if (part === null) throw new Error('Missing local saved geometry');
    const resolved = resolvePart(part), solid = resolved.steps[0]?.plan;
    expect(resolved.errors).toEqual([]);
    if (solid?.kind !== 'revolve') throw new Error('Missing revolved meridian');
    const tip = solid.profile[1];
    if (tip?.kind !== 'segment') throw new Error('Missing meridian segment');
    const pose: RigidPlacement = { position: [bead.placement.position[0].value, bead.placement.position[1].value, bead.placement.position[2].value], rotation: bead.placement.rotation };
    const expectedTip = move.rotation[0] === .5 ? [11, 26, 17] : [24, 13, 17];
    const expectedTop = move.rotation[0] === .5 ? [15, 23, 17] : [21, 13, 21];
    applyPlacementToPoint(pose, tip.from).forEach((v, i) => expect(v).toBeCloseTo(expectedTip[i], 9));
    applyPlacementToPoint(pose, tip.to).forEach((v, i) => expect(v).toBeCloseTo(expectedTop[i], 9));
    const stale = applyCircularFilletWeld(nextContext(context, movedDocument(document, { position: [1, 0, 0], rotation: [0, 0, 0, 1] })), request, p);
    expect(stale.ok).toBe(false);
  });
  it.each(['one-parent', 'one-bead', 'source', 'group'] as const)('rejects a non-common change: %s', async bad => {
    const f = await fixture(), choices = { ...f.choices, intervals: [{ beadId: 'a', fromParameter: 0, toParameter: Math.PI / 4 },
      { beadId: 'b', fromParameter: Math.PI / 2, toParameter: 3 * Math.PI / 4 }] };
    const first = applyCircularFilletWeld(f.context, choices, preview(f.context, choices));
    if (!first.ok) throw new Error(first.reason);
    // The parents and first bead move together; the second bead alone is left behind.
    const ids = bad === 'one-parent' ? ['plane'] : bad === 'one-bead'
      ? first.document.components.filter(c => c.id !== first.componentIds[1]).map(c => c.id) : undefined;
    const document = movedDocument(first.document, moves[0], ids), context = nextContext(f.context, document);
    let request = repick(context, choices);
    if (bad === 'source') request = { ...request, plane: { ...request.plane, sourceKey: 'different-parent-definition' } };
    if (bad === 'group') request = { ...request, weldId: 'another-group' };
    const before = JSON.stringify(document), p = planCircularFilletWeld(context, request);
    expect(p.ok).toBe(false); expect(JSON.stringify(document)).toBe(before);
  });
  it.each(['invalid-json', 'short-position', 'non-unit', 'extra-value', 'non-finite'] as const)('rejects malformed saved parent pose: %s', async bad => {
    const f = await fixture(), first = applyCircularFilletWeld(f.context, f.choices, preview(f.context, f.choices));
    if (!first.ok) throw new Error(first.reason);
    const bead = first.document.components.find(c => c.id === first.componentIds[0]);
    if (bead?.source.kind !== 'standardPart') throw new Error('Missing bead');
    const saved = readCircularFilletWeldSource(bead.source);
    if (saved === null) throw new Error('Missing source');
    const placementKey = bad === 'invalid-json' ? '{bad' : bad === 'short-position' ? '[[0,0],[0,0,0,1]]'
      : bad === 'non-unit' ? '[[0,0,0],[0,0,0,2]]' : bad === 'non-finite' ? '[[1e309,0,0],[0,0,0,1]]' : '[[0,0,0],[0,0,0,1],0]';
    const source = createCircularFilletWeldSource(3, 4, { ...saved.options,
      parents: [{ ...saved.options.parents[0], placementKey }, saved.options.parents[1]] });
    if (source === null) throw new Error('Saved wire values should reach strict association pose validation');
    const document = { ...first.document, components: first.document.components.map(c => c.id === bead.id ? { ...c, source } : c) };
    const context = nextContext(f.context, document), request = repick(context, f.choices);
    expect(planCircularFilletWeld(context, request).ok).toBe(false);
  });
  it('rejects a changed actual parent shape after current reselection', async () => {
    const f = await fixture(), first = applyCircularFilletWeld(f.context, f.choices, preview(f.context, f.choices));
    if (!first.ok) throw new Error(first.reason);
    const cylinder = first.document.components.find(c => c.id === 'cylinder');
    if (cylinder?.source.kind !== 'part') throw new Error('Missing actual parent');
    const part = f.context.inputs.library.parts.get(cylinder.source.partRef), solid = part?.solids[0];
    if (part === undefined || solid?.kind !== 'primitive' || solid.shape.kind !== 'cylinder') throw new Error('Missing actual cylinder feature');
    const embedded = await embedPart(f.context.inputs.library, { ...part,
      solids: [{ ...solid, shape: { ...solid.shape, radius: number(11) } }] }, 'changed-cylinder.pcad', 'changed', { importedAt: '2026-10-16T00:00:00.000Z' });
    const document = { ...first.document, components: first.document.components.map(c => c.id === cylinder.id
      ? { ...c, source: { kind: 'part' as const, partRef: embedded.partRef } } : c) };
    const inputs = { ...f.context.inputs, document, library: embedded.library };
    const context = { ...f.context, inputs, view: { source: inputs, resolved: resolveAssembly(document,
      { library: inputs.library, subAssemblies: inputs.subAssemblies, standardPart: buildStandardPartFromSource }) } };
    const request = repick(context, f.choices), before = JSON.stringify(document);
    expect(planCircularFilletWeld(context, request).ok).toBe(false); expect(JSON.stringify(document)).toBe(before);
  });
});

describe('circular root apply atomic create and complete replacement', () => {
  it.each([false, true])('creates one immutable root result and joins actual motion owners with nested=%s', async deep => {
    const f = await fixture(deep), original = f.context.inputs.document, before = JSON.stringify(original), p = preview(f.context, f.choices);
    const result = applyCircularFilletWeld(f.context, f.choices, p);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document).not.toBe(original); expect(JSON.stringify(original)).toBe(before);
    expect(result.componentIds).toHaveLength(1);
    expect(result.connection).toEqual({ kind: 'weld', firstPath: f.choices.plane.path, secondPath: f.choices.cylinder.path, componentIds: result.componentIds });
    const newBead = result.document.components.find(c => c.id === result.componentIds[0]);
    expect(newBead?.source).toEqual(p.beads[0].source); expect(newBead?.materialId).toBe('stainless');
    expect(newBead?.placement.position.map(v => v.value)).toEqual(deep ? [11, 13, 17] : [0, 0, 0]);
    const owners = deep ? ['owner-a', 'owner-b'] : ['plane', 'cylinder'];
    const group = newBead?.rigidGroupId; expect(group).toBe('fastening-1');
    for (const id of owners) {
      const old = original.components.find(c => c.id === id), current = result.document.components.find(c => c.id === id);
      expect(current).toEqual({ ...old, rigidGroupId: group });
    }
    expect(result.document.mates).toBe(original.mates); expect(result.document.joints).toBe(original.joints);
    expect(result.document.components.filter(c => c.id === result.componentIds[0])).toHaveLength(1);
    expect(applyCircularFilletWeld(nextContext(f.context, result.document), f.choices, p).ok).toBe(false);
    expect(f.context.inputs.subAssemblies.size).toBe(deep ? 1 : 0);
  });
  it('replaces all two beads with fresh IDs and preserves surviving originals/group/constraints', async () => {
    const f = await fixture();
    const choices = { ...f.choices, intervals: [{ beadId: 'a', fromParameter: 0, toParameter: Math.PI / 4 },
      { beadId: 'b', fromParameter: Math.PI / 2, toParameter: 3 * Math.PI / 4 }] };
    const first = applyCircularFilletWeld(f.context, choices, preview(f.context, choices));
    if (!first.ok) throw new Error(first.reason);
    const context = nextContext(f.context, first.document), original = JSON.stringify(first.document);
    const request: CircularFilletWeldRequest = { ...choices, operation: 'replace', draftEpoch: 'edit-2',
      section: { ...choices.section, radialLegMm: 2 }, materialId: 'steel' };
    const p = preview(context, request), result = applyCircularFilletWeld(context, request, p);
    if (!result.ok) throw new Error(result.reason);
    expect(p.replacedComponentIds).toEqual(first.componentIds);
    expect(result.componentIds).toHaveLength(2); expect(result.componentIds.every(id => !first.componentIds.includes(id))).toBe(true);
    expect(result.document.components.some(c => first.componentIds.includes(c.id))).toBe(false);
    expect(result.document.jointOccurrenceConnections).toEqual([result.connection]);
    for (const id of ['plane', 'cylinder']) expect(result.document.components.find(c => c.id === id)).toBe(first.document.components.find(c => c.id === id));
    for (const id of result.componentIds) {
      const bead = result.document.components.find(c => c.id === id);
      expect(bead?.materialId).toBe('steel'); expect(bead?.rigidGroupId).toBe('fastening-1');
      if (bead?.source.kind !== 'standardPart') throw new Error('Missing generated standard bead');
      expect(readCircularFilletWeldSource(bead.source)?.section.radialLegMm).toBe(2);
    }
    expect(result.document.mates).toBe(first.document.mates); expect(result.document.joints).toBe(first.document.joints);
    expect(JSON.stringify(first.document)).toBe(original);
    const again = applyCircularFilletWeld(nextContext(context, result.document), request, p);
    expect(again.ok).toBe(false); expect(again.document).toBe(result.document);
  });
  it.each(['section', 'interval', 'material', 'source', 'pose', 'library-reference', 'resolved-reference'])('rejects stale %s preview and returns the same document', async changed => {
    const f = await fixture(), p = preview(f.context, f.choices), document = f.context.inputs.document;
    let request = f.choices, context = f.context;
    if (changed === 'section') request = { ...request, section: { ...request.section, normalLegMm: 3 } };
    if (changed === 'interval') request = { ...request, intervals: [{ ...request.intervals[0], toParameter: Math.PI / 3 }] };
    if (changed === 'material') request = { ...request, materialId: 'aluminum' };
    if (changed === 'source') request = { ...request, plane: { ...request.plane, sourceKey: 'stale' } };
    if (changed === 'pose') request = { ...request, plane: { ...request.plane, placementKey: 'stale' } };
    if (changed === 'library-reference') context = { ...context, inputs: { ...context.inputs, library: { ...context.inputs.library } } };
    if (changed === 'resolved-reference') context = { ...context, view: { ...context.view, resolved: { ...context.view.resolved } } };
    const before = JSON.stringify(document), result = applyCircularFilletWeld(context, request, p);
    expect(result.ok).toBe(false); expect(result.document).toBe(document); expect(JSON.stringify(document)).toBe(before);
  });
  it.each(['missing', 'extra', 'group', 'pose', 'source', 'connection', 'material'])('rejects %s in an existing whole group', async bad => {
    const f = await fixture(), first = applyCircularFilletWeld(f.context, f.choices, preview(f.context, f.choices));
    if (!first.ok) throw new Error(first.reason);
    const bead = first.document.components.find(c => c.id === first.componentIds[0]);
    if (bead === undefined) throw new Error('Expected bead');
    let document = first.document;
    if (bad === 'missing') document = { ...document, components: document.components.filter(c => c.id !== bead.id) };
    if (bad === 'extra') document = { ...document, components: [...document.components, { ...bead, id: 'extra-bead' }] };
    if (bad === 'group') document = { ...document, components: document.components.map(c => c.id === bead.id ? { ...c, rigidGroupId: 'wrong' } : c) };
    if (bad === 'pose') document = { ...document, components: document.components.map(c => c.id === bead.id ? { ...c, placement: weldTestPlacement([1, 0, 0]) } : c) };
    if (bad === 'source' && bead.source.kind === 'standardPart') {
      const source = { ...bead.source, generatorRevision: 'fillet-weld-6' };
      document = { ...document, components: document.components.map(c => c.id === bead.id ? { ...c, source } : c) };
    }
    if (bad === 'connection') document = { ...document, jointOccurrenceConnections: [] };
    if (bad === 'material') document = { ...document, components: document.components.map(c => c.id === bead.id ? { ...c, materialId: 'invented-density' } : c) };
    const context = nextContext(f.context, document), request: CircularFilletWeldRequest = { ...f.choices, operation: 'replace' };
    expect(planCircularFilletWeld(context, request).ok).toBe(false);
  });
  it('does not append anything when a callback changes the current input object during commit', async () => {
    const f = await fixture(), p = preview(f.context, f.choices), document = f.context.inputs.document;
    let calls = 0;
    const context = { ...f.context, bodiesOf: (o: Parameters<typeof f.context.bodiesOf>[0]) => {
      if (++calls === 4) Reflect.set(f.context.inputs, 'document', { ...document });
      return f.context.bodiesOf(o);
    } };
    const result = applyCircularFilletWeld(context, f.choices, p);
    expect(result.ok).toBe(false); expect(result.document).toBe(document);
    expect(document.components).toHaveLength(2); expect(document.jointOccurrenceConnections).toBeUndefined();
  });
});
