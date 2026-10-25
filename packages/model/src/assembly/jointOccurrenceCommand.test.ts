import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from '../part/createPartDocument.js';
import type { HoleFeature, PrimitiveFeature } from '../part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../sketch/createSketchDocument.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { prepareJointOccurrencePair, type JointOccurrenceCommandContext } from './jointOccurrenceSelection.js';
import { embedPart, EMPTY_PART_LIBRARY } from './partLibrary.js';
import { resolveAssembly } from './resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, Mate, Placement } from './types.js';
import { commitOccurrenceFilletWeld, previewOccurrenceFilletWeld, type OccurrenceWeldPicks } from './welding/bindWeldSelection.js';
import { BASE_BOX, STANDING_BOX, teeRequest, weldTestPlacement } from './welding/filletWeld.testSupport.js';
import { filletWeldSegmentOptions } from './welding/filletWeldPart.js';
import { commitOccurrenceBoltedJoint, previewOccurrenceBoltedJoint, type BoltedJointChoices, type OccurrenceHolePick } from './fastening/boltedJointCommand.js';

const A = 'A/子,"α', B = 'B/子,"β';

function leaf(id: string, ref: string, placement: Placement): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: ref }, placement,
    fixed: false, visible: true, suppressed: false };
}

async function fixture(rootPlacement = DEFAULT_COMPONENT_PLACEMENT) {
  const box = (name: string, x: number, y: number, z: number) => {
    const feature: PrimitiveFeature = { id: 'extrude-1', name, kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: expressionValueFromNumber(x), sizeY: expressionValueFromNumber(y), sizeZ: expressionValueFromNumber(z) } };
    return appendSolid(createEmptyPartDocument(), feature);
  };
  const standing = await embedPart(EMPTY_PART_LIBRARY, box('standing', 100, 8, 50), 's.pcad', 's.pcad');
  const base = await embedPart(standing.library, box('base', 100, 60, 10), 'b.pcad', 'b.pcad');
  const child: AssemblyDocument = { ...createAssemblyDocument('shared child'), components: [
    leaf('standing', standing.partRef, weldTestPlacement([0, 26, 10])),
    leaf('base', base.partRef, DEFAULT_COMPONENT_PLACEMENT),
  ] };
  const owner = (id: string): AssemblyComponent => ({ id, name: id,
    source: { kind: 'subAssembly', assemblyRef: 'child' }, placement: rootPlacement,
    fixed: false, visible: true, suppressed: false });
  const document = { ...createAssemblyDocument('root'), components: [owner(A), owner(B)] };
  const subAssemblies = new Map([['child', child]]);
  const inputs = { document, library: { ...base.library, assemblies: subAssemblies }, subAssemblies };
  const request = teeRequest();
  const picks: OccurrenceWeldPicks = { first: { path: [A, 'standing'], ref: request.first.face },
    edge: { path: [A, 'standing'], ref: request.edge.edge }, second: { path: [B, 'base'], ref: request.second.face } };
  const context: JointOccurrenceCommandContext = { inputs,
    view: { source: inputs, resolved: resolveAssembly(document, { library: inputs.library, subAssemblies }) },
    partDocument: occurrence => occurrence.leafComponent.source.kind === 'part'
      ? inputs.library.parts.get(occurrence.leafComponent.source.partRef) ?? null : null,
    resolveFace: () => ({ status: 'missing' }),
    resolveWeldGeometry: (occurrence, ref) => ref.fingerprint.kind === 'edge'
      ? { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }
      : occurrence.leafComponent.id === 'standing'
        ? { kind: 'face', surfaceKind: 'plane', area: 5000, position: [50, 8, 25], axis: [0, 1, 0], radius: null }
        : { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: [0, 0, 1], radius: null },
    bodiesOf: occurrence => [occurrence.leafComponent.id === 'standing' ? STANDING_BOX : BASE_BOX],
  };
  const choices = { legOnFirst: 8, legOnSecond: 6, materialId: 'aluminum', segments: [{ start: 10, length: 20 }] };
  return { context, child, picks, choices };
}

function replaceRoot(context: JointOccurrenceCommandContext, document: AssemblyDocument): JointOccurrenceCommandContext {
  const inputs = { ...context.inputs, document };
  return { ...context, inputs, view: { source: inputs,
    resolved: resolveAssembly(document, { library: inputs.library, subAssemblies: inputs.subAssemblies }) } };
}

describe('nested joint commands: zero-motion adapter', () => {
  it('commits a through bolt and nut between repeated child plates at independently known seats', async () => {
    const value = expressionValueFromNumber;
    const ref = (bodyFeatureId: string, index: number): SubShapeRef => ({ bodyFeatureId, index,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 800, position: [20, 10, 0], axis: [0, 0, 1], radius: null } });
    let part = createEmptyPartDocument();
    const sketch = part.sketches[0];
    if (sketch === undefined) throw new Error('initial sketch missing');
    const point = createPointFeature(sketch, absoluteCoordinate(20, 10, 0));
    part = replaceSketch(part, appendFeature(sketch, point));
    const box: PrimitiveFeature = { id: 'base-1', name: 'plate', kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, -10) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: value(40), sizeY: value(20), sizeZ: value(10) } };
    const hole: HoleFeature = { id: 'hole-1', name: 'clearance', kind: 'hole', suppressed: false,
      targetFeatureId: box.id, face: ref(box.id, 0), centers: [{ sketchId: sketch.id, pointFeatureId: point.id }],
      diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) };
    part = appendSolid(appendSolid(part, box), hole);
    const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'plate.pcad', 'plate.pcad');
    const child: AssemblyDocument = { ...createAssemblyDocument('plate child'),
      components: [leaf('plate', embedded.partRef, DEFAULT_COMPONENT_PLACEMENT)] };
    const owner = (id: string, placement: Placement): AssemblyComponent => ({ id, name: id, placement,
      source: { kind: 'subAssembly', assemblyRef: 'child' }, fixed: false, visible: true, suppressed: false });
    const document = { ...createAssemblyDocument('root'), components: [owner(A, DEFAULT_COMPONENT_PLACEMENT),
      owner(B, weldTestPlacement([0, 20, 0], [1, 0, 0, 0]))] };
    const subAssemblies = new Map([['child', child]]);
    const inputs = { document, library: { ...embedded.library, assemblies: subAssemblies }, subAssemblies };
    const context: JointOccurrenceCommandContext = { inputs,
      view: { source: inputs, resolved: resolveAssembly(document, { library: inputs.library, subAssemblies }) },
      partDocument: () => part, bodiesOf: () => null, resolveWeldGeometry: () => null,
      resolveFace: (_occurrence, reference) => reference.index === 1
        ? { status: 'matched', geometry: { kind: 'face', surfaceKind: 'cylinder', area: 90 * Math.PI,
          position: [20, 10, -5], axis: [0, 0, 1], axisOrigin: [20, 10, -5], cylinderSpan: [-5, 5], radius: 4.5 },
          wall: { status: 'hole', origin: { kind: 'hole-face', featureId: hole.id,
            center: { sketchId: sketch.id, producer: { kind: 'point', featureId: point.id } },
            placement: { kind: 'original' }, stage: 'bore', role: 'wall' } } }
        : { status: 'matched', geometry: { kind: 'face', surfaceKind: 'plane', area: 800,
          position: [20, 10, 0], axis: [0, 0, 1], radius: null }, wall: { status: 'unnamed' } },
    };
    const pick = { componentId: 'plate', holeFeatureId: hole.id, holeFace: ref(hole.id, 1), matingFace: ref(hole.id, 2) };
    const first: OccurrenceHolePick = { path: [A, 'plate'], pick }, second: OccurrenceHolePick = { path: [B, 'plate'], pick };
    const choices: BoltedJointChoices = { explicitBolt: { nominal: 'M8', threadSeries: 'coarse' },
      dimensionSeries: 'annexJA', headWashers: [], nutWashers: [], minimumProtrusion: 2,
      engagement: 12, blindBottomClearance: 2, lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA',
        lengths: [30], basis: 'perDiameterEvidence', verified: true, source: 'independent test fixture, not JIS availability' }] };
    const before = JSON.stringify([document, child, part]);
    const preview = previewOccurrenceBoltedJoint(context, first, second, choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    expect(preview.plan.boltLength).toBe(30);
    const result = commitOccurrenceBoltedJoint(context, first, second, choices, preview);
    if (!result.ok) throw new Error(result.reason);
    expect(result.componentIds).toHaveLength(2);
    const hardware = result.document.components.filter(component => result.componentIds.includes(component.id));
    expect(hardware.map(component => component.placement.position.map(entry => entry.value))).toEqual([[20, 10, -10], [20, 10, 10]]);
    expect(result.document.components.map(component => component.id)).toEqual([A, B, ...result.componentIds]);
    expect(result.document.components.slice(0, 2).map(component => component.placement)).toEqual(document.components.map(component => component.placement));
    expect(result.connection).toEqual({ kind: 'bolt', firstPath: [A, 'plate'], secondPath: [B, 'plate'], componentIds: result.componentIds });
    expect(JSON.stringify([document, child, part])).toBe(before);
    const changed = replaceRoot(context, { ...document, name: 'changed ancestor snapshot' });
    const refused = commitOccurrenceBoltedJoint(changed, first, second, choices, preview);
    expect(refused).toEqual({ ok: false, document: changed.inputs.document, reason: 'preview-changed' });
    expect(refused.document).toBe(changed.inputs.document);
  });

  it('composes noncommuting ancestor rotations in order before committing the world-space bead', async () => {
    const f = await fixture(weldTestPlacement([5, -7, 3], [0, 0, Math.SQRT1_2, Math.SQRT1_2]));
    const turn: AssemblyComponent = { id: 'turn', name: 'turn', source: { kind: 'subAssembly', assemblyRef: 'inner' },
      placement: weldTestPlacement([0, 0, 0], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]), fixed: false, visible: true, suppressed: false };
    const wrapper = { ...createAssemblyDocument('wrapper'), components: [turn] };
    const subAssemblies = new Map([['child', wrapper], ['inner', f.child]]);
    const inputs = { ...f.context.inputs, subAssemblies, library: { ...f.context.inputs.library, assemblies: subAssemblies } };
    const context = { ...f.context, inputs, view: { source: inputs,
      resolved: resolveAssembly(inputs.document, { library: inputs.library, subAssemblies }) } };
    const picks: OccurrenceWeldPicks = { first: { ...f.picks.first, path: [A, 'turn', 'standing'] },
      edge: { ...f.picks.edge, path: [A, 'turn', 'standing'] }, second: { ...f.picks.second, path: [B, 'turn', 'base'] } };
    const preview = previewOccurrenceFilletWeld(context, picks, f.choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    // Rx90: (0,34,10)->(0,-10,34); Rz90 then translation: (15,-7,37).
    preview.plan.frame.origin.forEach((entry, index) => expect(entry).toBeCloseTo([15, -7, 37][index] ?? NaN, 10));
    const result = commitOccurrenceFilletWeld(context, picks, f.choices, preview);
    if (!result.ok) throw new Error(result.reason);
    const bead = result.document.components.find(component => result.componentIds.includes(component.id));
    expect(bead).toBeDefined();
    bead?.placement.position.forEach((entry, index) => expect(entry.value).toBeCloseTo([15, 3, 37][index] ?? NaN, 10));
    expect(inputs.subAssemblies.get('inner')).toBe(f.child);
    expect(result.connection.firstPath).toEqual([A, 'turn', 'standing']);
  });

  it('uses a solved leaf pose different from its saved pose without changing the child', async () => {
    const f = await fixture();
    const child = { ...f.child, components: f.child.components.map(component => component.id === 'standing'
      ? { ...component, placement: DEFAULT_COMPONENT_PLACEMENT } : component) };
    const subAssemblies = new Map([['child', child]]);
    const inputs = { ...f.context.inputs, subAssemblies, library: { ...f.context.inputs.library, assemblies: subAssemblies } };
    const saved = resolveAssembly(inputs.document, { library: inputs.library, subAssemblies });
    const nested = saved.subAssemblies?.get(A);
    if (nested === undefined) throw new Error('nested solve missing');
    // Inject an independently specified completed constraint-solver pose, not a saved placement.
    const placements = new Map(nested.resolved.placements);
    placements.set('standing', { position: [0, 26, 10], rotation: [0, 0, 0, 1] });
    const solvedChildren = new Map(saved.subAssemblies);
    solvedChildren.set(A, { ...nested, resolved: { ...nested.resolved, placements } });
    const context = { ...f.context, inputs, view: { source: inputs, resolved: { ...saved, subAssemblies: solvedChildren } } };
    const before = JSON.stringify(child);
    const preview = previewOccurrenceFilletWeld(context, f.picks, f.choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    expect(preview.plan.frame.origin).toEqual([0, 34, 10]);
    const result = commitOccurrenceFilletWeld(context, f.picks, f.choices, preview);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.components.find(component => result.componentIds.includes(component.id))?.placement.position.map(entry => entry.value))
      .toEqual([10, 34, 10]);
    expect(JSON.stringify(child)).toBe(before);
  });

  it('inserts a real weld at the independently known frame, with only root-owned generated IDs', async () => {
    const f = await fixture();
    const beforeChild = JSON.stringify(f.child);
    const preview = previewOccurrenceFilletWeld(f.context, f.picks, f.choices);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    expect(preview.plan.frame.origin).toEqual([0, 34, 10]);
    expect(preview.plan.nominalVolume).toBe(480);
    const result = commitOccurrenceFilletWeld(f.context, f.picks, f.choices, preview);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.connection.firstPath).toEqual([A, 'standing']);
    expect(result.connection.secondPath).toEqual([B, 'base']);
    expect(result.componentIds).toHaveLength(1);
    const bead = result.document.components.find(component => result.componentIds.includes(component.id));
    expect(bead?.placement.position.map(value => value.value)).toEqual([10, 34, 10]);
    expect(result.document.components.map(component => component.id)).toEqual([A, B, ...result.componentIds]);
    expect(result.document.components.every(component => !component.id.startsWith('['))).toBe(true);
    expect(bead?.source.kind).toBe('standardPart');
    if (bead?.source.kind !== 'standardPart') throw new Error('generated weld missing');
    expect(filletWeldSegmentOptions(bead.source.options)?.parts).toEqual([A, B]);
    expect(JSON.stringify(f.child)).toBe(beforeChild);
    expect(f.context.inputs.subAssemblies.get('child')).toBe(f.child);
    expect(f.context.inputs.document.components).toHaveLength(2);
  });

  it('rotates world geometry once and retains distinct repeated leaf identities', async () => {
    const f = await fixture(weldTestPlacement([5, -7, 3], [0, 0, Math.SQRT1_2, Math.SQRT1_2]));
    const preview = previewOccurrenceFilletWeld(f.context, f.picks, f.choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    preview.plan.frame.origin.forEach((value, index) => expect(value).toBeCloseTo([-29, -7, 13][index] ?? NaN, 10));
    const pair = prepareJointOccurrencePair(f.context, [A, 'standing'], [B, 'standing']);
    if (!pair.ok) throw new Error(pair.reason);
    expect(pair.pair.first.sourceKey).toBe(pair.pair.second.sourceKey);
    expect(pair.pair.first.occurrenceKey).not.toBe(pair.pair.second.occurrenceKey);
    expect(pair.pair.first.motionOwnerId).toBe(A);
    expect(pair.pair.second.motionOwnerId).toBe(B);
  });

  it.each<'contentHash' | 'attachmentsDigest'>(['contentHash', 'attachmentsDigest'])('refuses stale %s changes atomically', async field => {
    const f = await fixture();
    const preview = previewOccurrenceFilletWeld(f.context, f.picks, f.choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const inputs = { ...f.context.inputs, library: { ...f.context.inputs.library,
      partFiles: f.context.inputs.library.partFiles.map(file => ({ ...file, [field]: `${file[field]}-changed` })) } };
    const context = { ...f.context, inputs, view: { ...f.context.view, source: inputs } };
    const result = commitOccurrenceFilletWeld(context, f.picks, f.choices, preview);
    expect(result).toEqual({ ok: false, document: inputs.document, reason: 'preview-changed' });
    expect(result.document).toBe(inputs.document);
    expect(inputs.document.components).toHaveLength(2);
  });

  it('refuses same-owner leaves, suppression and incompatible root solved pose', async () => {
    const f = await fixture();
    expect(prepareJointOccurrencePair(f.context, [A, 'standing'], [A, 'base']))
      .toEqual({ ok: false, reason: 'same-owner-unsupported' });
    const suppressed = replaceRoot(f.context, { ...f.context.inputs.document,
      components: f.context.inputs.document.components.map(component => ({ ...component, suppressed: true })) });
    expect(previewOccurrenceFilletWeld(suppressed, f.picks, f.choices).ok).toBe(false);
    const resolved = { ...f.context.view.resolved, placements: new Map(f.context.view.resolved.placements) };
    resolved.placements.set(A, { position: [10, 0, 0], rotation: [0, 0, 0, 1] });
    expect(previewOccurrenceFilletWeld({ ...f.context, view: { ...f.context.view, resolved } }, f.picks, f.choices).ok).toBe(false);
  });

  it('keeps fixed owners fixed and rejects an affected mate without deleting it', async () => {
    const f = await fixture();
    const fixed = replaceRoot(f.context, { ...f.context.inputs.document,
      components: f.context.inputs.document.components.map(component => ({ ...component, fixed: true, rigidGroupId: 'existing' })) });
    const preview = previewOccurrenceFilletWeld(fixed, f.picks, f.choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const result = commitOccurrenceFilletWeld(fixed, f.picks, f.choices, preview);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.components.slice(0, 2).every(component => component.fixed)).toBe(true);
    expect(result.document.components[2]?.fixed).toBe(false);
    const mate: Mate = { id: 'mate-1', name: 'existing mate', kind: 'coincident', flipped: false, suppressed: false,
      a: { kind: 'origin', componentId: A, element: 'origin' },
      b: { kind: 'origin', componentId: B, element: 'origin' } };
    const constrained = replaceRoot(f.context, { ...f.context.inputs.document, mates: [mate] });
    const refused = previewOccurrenceFilletWeld(constrained, f.picks, f.choices);
    expect(refused).toEqual({ ok: false, reason: 'owner-constrained', rejections: [] });
    const noCommit = commitOccurrenceFilletWeld(constrained, f.picks, f.choices, preview);
    expect(noCommit.ok).toBe(false);
    expect(noCommit.document).toBe(constrained.inputs.document);
    expect(noCommit.document.mates[0]).toBe(mate);
  });

  it('routes nested bolt picks through the real binder and refuses absent hole geometry without mutation', async () => {
    const f = await fixture();
    const ref: SubShapeRef = f.picks.first.ref;
    const first: OccurrenceHolePick = { path: [A, 'standing'], pick: { componentId: 'standing',
      holeFeatureId: 'missing-hole', holeFace: ref, matingFace: ref } };
    const second: OccurrenceHolePick = { path: [B, 'base'], pick: { componentId: 'base',
      holeFeatureId: 'missing-hole', holeFace: ref, matingFace: ref } };
    const result = previewOccurrenceBoltedJoint(f.context, first, second,
      { dimensionSeries: 'annexJA', headWashers: [], nutWashers: [], engagement: 12, blindBottomClearance: 2, lengthAvailability: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('absent holes must fail');
    expect(result.reason).toBe('geometry-rejected');
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(f.context.inputs.document.components).toHaveLength(2);
  });
});
