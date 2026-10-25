import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createUndoStack, pushUndo, redo, undo } from '../history/undoStack.js';
import { appendSolid, createEmptyPartDocument } from '../part/createPartDocument.js';
import type { PrimitiveFeature } from '../part/types.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import type { JointOccurrenceInputs, JointOccurrencePath } from './jointOccurrence.js';
import type { JointOccurrenceCommandContext } from './jointOccurrenceSelection.js';
import { embedPart, EMPTY_PART_LIBRARY } from './partLibrary.js';
import { resolveAssembly } from './resolveAssembly.js';
import { buildStandardPartFromSource, standardPartNominalVolume } from './standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';
import { commitOccurrenceFilletWeld, commitOccurrenceFilletWeldEdit, previewOccurrenceFilletWeld,
  previewOccurrenceFilletWeldEdit, type OccurrenceWeldPicks } from './welding/bindWeldSelection.js';
import { createFilletWeldSource, filletWeldSegmentOptions } from './welding/filletWeldPart.js';
import { BASE_BOX, STANDING_BOX, teeRequest, weldTestPlacement } from './welding/filletWeld.testSupport.js';
import type { FilletWeldEditRequest } from './welding/planFilletWeld.js';

const A = 'a/子,"α', B = 'b/子,"β';
const EDIT: FilletWeldEditRequest = { weldId: 'weld-1', legOnFirst: 5, legOnSecond: 4, materialId: 'steel',
  segments: [{ start: 5, length: 10 }, { start: 40, length: 15 }, { start: 80, length: 10 }] };

function refreshed(context: JointOccurrenceCommandContext, inputs: JointOccurrenceInputs): JointOccurrenceCommandContext {
  return { ...context, inputs, view: { source: inputs, resolved: resolveAssembly(inputs.document,
    { library: inputs.library, subAssemblies: inputs.subAssemblies, standardPart: buildStandardPartFromSource }) } };
}

async function fixture(mode: 'nested' | 'mixed' | 'rotated' = 'nested') {
  const box = (x: number, y: number, z: number) => {
    const feature: PrimitiveFeature = { id: 'extrude-1', name: 'box', kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: expressionValueFromNumber(x), sizeY: expressionValueFromNumber(y), sizeZ: expressionValueFromNumber(z) } };
    return appendSolid(createEmptyPartDocument(), feature);
  };
  const standing = await embedPart(EMPTY_PART_LIBRARY, box(100, 8, 50), 's.pcad', 's.pcad');
  const base = await embedPart(standing.library, box(100, 60, 10), 'b.pcad', 'b.pcad');
  const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [
    { id: 'standing', name: 'standing', source: { kind: 'part', partRef: standing.partRef },
      placement: weldTestPlacement([0, 26, 10]), fixed: false, visible: true, suppressed: false },
    { id: 'base', name: 'base', source: { kind: 'part', partRef: base.partRef },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false },
  ] };
  const subAssemblies = new Map([['child', child]]);
  if (mode === 'rotated') {
    const turn: AssemblyComponent = { id: 'turn', name: 'turn', source: { kind: 'subAssembly', assemblyRef: 'inner' },
      placement: weldTestPlacement([0, 0, 0], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]), fixed: false, visible: true, suppressed: false };
    subAssemblies.set('inner', child);
    subAssemblies.set('child', { ...createAssemblyDocument('wrapper'), components: [turn] });
  }
  const placement = mode === 'rotated' ? weldTestPlacement([5, -7, 3], [0, 0, Math.SQRT1_2, Math.SQRT1_2]) : DEFAULT_COMPONENT_PLACEMENT;
  const owners: AssemblyComponent[] = [
    { id: A, name: A, source: { kind: 'subAssembly', assemblyRef: 'child' }, placement, fixed: true, visible: true, suppressed: false },
    { id: B, name: B, source: mode === 'mixed' ? { kind: 'part', partRef: base.partRef } : { kind: 'subAssembly', assemblyRef: 'child' },
      placement, fixed: false, visible: true, suppressed: false },
  ];
  const inputs = { document: { ...createAssemblyDocument('root'), components: owners },
    library: { ...base.library, assemblies: subAssemblies }, subAssemblies };
  let context: JointOccurrenceCommandContext = { inputs,
    view: { source: inputs, resolved: resolveAssembly(inputs.document, { library: inputs.library, subAssemblies }) },
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
  const firstPath: JointOccurrencePath = mode === 'rotated' ? [A, 'turn', 'standing'] : [A, 'standing'];
  const secondPath: JointOccurrencePath = mode === 'rotated' ? [B, 'turn', 'base'] : mode === 'mixed' ? [B] : [B, 'base'];
  const request = teeRequest();
  const picks: OccurrenceWeldPicks = { first: { path: firstPath, ref: request.first.face },
    edge: { path: firstPath, ref: request.edge.edge }, second: { path: secondPath, ref: request.second.face } };
  for (const segments of [[{ start: 10, length: 20 }, { start: 50, length: 20 }], [{ start: 25, length: 10 }]]) {
    const choices = { legOnFirst: 8, legOnSecond: 6, materialId: 'aluminum', segments };
    const preview = previewOccurrenceFilletWeld(context, picks, choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const result = commitOccurrenceFilletWeld(context, picks, choices, preview);
    if (!result.ok) throw new Error(result.reason);
    context = refreshed(context, { ...context.inputs, document: result.document });
  }
  expect(context.inputs.document.components.map(component => component.id)).toEqual([A, B, 'component-1', 'component-2', 'component-3']);
  return { context, child, firstPath, secondPath };
}

describe('edit an existing occurrence weld', () => {
  it.each<'nested' | 'mixed' | 'rotated'>(['nested', 'mixed', 'rotated'])('replaces multiple beads for %s geometry in one immutable result', async mode => {
    const f = await fixture(mode), before = f.context.inputs.document;
    const snapshot = JSON.stringify([before, f.child]);
    const preview = previewOccurrenceFilletWeldEdit(f.context, EDIT);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const expectedOrigin = mode === 'rotated' ? [15, -7, 37] : [0, 34, 10];
    preview.plan.frame.origin.forEach((entry, index) => expect(entry).toBeCloseTo(expectedOrigin[index] ?? NaN, 10));
    expect(preview.plan.nominalVolume).toBe(350); // (4*5/2)*(10+15+10)
    expect(preview.plan.replacedComponentIds).toEqual(['component-1', 'component-2']);
    const result = commitOccurrenceFilletWeldEdit(f.context, EDIT, preview);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.componentIds).toEqual(['component-4', 'component-5', 'component-6']);
    expect(result.document.components.map(component => component.id)).toEqual([A, B, 'component-3', 'component-4', 'component-5', 'component-6']);
    expect(result.connection.firstPath).toEqual(f.firstPath);
    expect(result.connection.secondPath).toEqual(f.secondPath);
    expect(result.document.jointOccurrenceConnections).toHaveLength(2);
    expect(result.document.jointOccurrenceConnections?.[0]).toBe(result.connection);
    expect(result.document.jointOccurrenceConnections?.[1]).toBe(before.jointOccurrenceConnections?.[1]);
    expect(result.document.components.find(component => component.id === 'component-3')).toBe(before.components[4]);
    const beads = result.document.components.filter(component => result.componentIds.includes(component.id));
    let volume = 0;
    for (const [index, bead] of beads.entries()) {
      const station = [5, 40, 80][index] ?? NaN;
      const expected = mode === 'rotated' ? [15, station - 7, 37] : [station, 34, 10];
      bead.placement.position.forEach((entry, axis) => expect(entry.value).toBeCloseTo(expected[axis] ?? NaN, 10));
      expect(bead.materialId).toBe('steel');
      if (bead.source.kind !== 'standardPart') throw new Error('missing standard weld');
      expect(filletWeldSegmentOptions(bead.source.options)?.parts).toEqual([A, B]);
      expect(filletWeldSegmentOptions(bead.source.options)?.weldId).toBe('weld-1');
      volume += standardPartNominalVolume(bead.source.catalog, bead.source.size, bead.source.options) ?? NaN;
    }
    expect(volume).toBe(350);
    expect(JSON.stringify([before, f.child])).toBe(snapshot);
    expect(result.document.components[0]).toMatchObject({ id: A, fixed: true });
    const history = pushUndo(createUndoStack(before), result.document, { now: 1 });
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toBe(before);
    expect(redo(undo(history)).present).toBe(result.document);
  });

  it('rejects a changed valid request after preview without mutating the original document', async () => {
    const { context } = await fixture();
    const preview = previewOccurrenceFilletWeldEdit(context, EDIT);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const result = commitOccurrenceFilletWeldEdit(context, { ...EDIT, legOnFirst: 6 }, preview);
    expect(result).toEqual({ ok: false, reason: 'preview-changed', rejections: [], document: context.inputs.document });
    expect(result.document).toBe(context.inputs.document);
  });

  it.each<'contentHash' | 'attachmentsDigest'>(['contentHash', 'attachmentsDigest'])('rejects changed %s after preview', async field => {
    const { context } = await fixture();
    const preview = previewOccurrenceFilletWeldEdit(context, EDIT);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const library = { ...context.inputs.library, partFiles: context.inputs.library.partFiles.map(file => ({ ...file, [field]: `${file[field]}-new` })) };
    const current = refreshed(context, { ...context.inputs, library });
    const result = commitOccurrenceFilletWeldEdit(current, EDIT, preview);
    expect(result).toEqual({ ok: false, reason: 'preview-changed', rejections: [], document: current.inputs.document });
    expect(result.document).toBe(current.inputs.document);
  });

  it('rejects a suppressed leaf with the occurrence-specific reason', async () => {
    const f = await fixture();
    const child = { ...f.child, components: f.child.components.map(component => component.id === 'standing' ? { ...component, suppressed: true } : component) };
    const subAssemblies = new Map([['child', child]]);
    const context = refreshed(f.context, { ...f.context.inputs, subAssemblies, library: { ...f.context.inputs.library, assemblies: subAssemblies } });
    expect(previewOccurrenceFilletWeldEdit(context, EDIT)).toEqual({ ok: false, reason: 'occurrence-unavailable', rejections: [] });
  });

  it('distinguishes missing, damaged and ambiguous ownership records', async () => {
    const { context } = await fixture();
    const connections = context.inputs.document.jointOccurrenceConnections;
    const first = connections?.[0];
    if (connections === undefined || first === undefined) throw new Error('fixture association missing');
    for (const [records, reason] of [
      [[], 'weld-association-missing'],
      [[{ ...first, componentIds: ['component-1'] }, ...connections.slice(1)], 'weld-association-damaged'],
      [[first, ...connections], 'weld-association-ambiguous'],
    ] as const) {
      const document = { ...context.inputs.document, jointOccurrenceConnections: records };
      expect(previewOccurrenceFilletWeldEdit(refreshed(context, { ...context.inputs, document }), EDIT))
        .toEqual({ ok: false, reason, rejections: [] });
    }
  });

  it('refuses a broken shared bead frame using the existing weldDamaged oracle', async () => {
    const { context } = await fixture();
    const document = { ...context.inputs.document, components: context.inputs.document.components.map(component => component.id === 'component-2'
      ? { ...component, placement: weldTestPlacement([51, 34, 10], component.placement.rotation) } : component) };
    const result = previewOccurrenceFilletWeldEdit(refreshed(context, { ...context.inputs, document }), EDIT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('damaged frame accepted');
    expect(result.reason).toBe('geometry-rejected');
    expect(result.rejections.map(rejection => rejection.code)).toEqual(['weldDamaged']);
  });

  it('rejects a bead used as another connection owner rather than cascading deletion into that connection', async () => {
    const { context } = await fixture();
    const connections = context.inputs.document.jointOccurrenceConnections;
    const first = connections?.[0], second = connections?.[1];
    if (first === undefined || second === undefined) throw new Error('fixture connections missing');
    const document: AssemblyDocument = { ...context.inputs.document,
      jointOccurrenceConnections: [first, { ...second, firstPath: ['component-1'] }] };
    const current = refreshed(context, { ...context.inputs, document });
    expect(previewOccurrenceFilletWeldEdit(current, EDIT))
      .toEqual({ ok: false, reason: 'weld-association-damaged', rejections: [] });
    expect(document.components).toBe(context.inputs.document.components);
  });

  it.each<'missing' | 'suppressed' | 'foreign-part' | 'duplicate-segment'>(['missing', 'suppressed', 'foreign-part', 'duplicate-segment'])('atomically rejects a %s saved bead association', async mode => {
    const { context } = await fixture();
    const preview = previewOccurrenceFilletWeldEdit(context, EDIT);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const components = context.inputs.document.components.flatMap(component => {
      if (component.id !== 'component-2') return [component];
      if (mode === 'missing') return [];
      if (mode === 'suppressed') return [{ ...component, suppressed: true }];
      if (component.source.kind !== 'standardPart') throw new Error('missing bead');
      const options = filletWeldSegmentOptions(component.source.options);
      if (options === null) throw new Error('damaged fixture');
      return [{ ...component, source: createFilletWeldSource(6, 8, mode === 'duplicate-segment'
        ? { ...options, segment: 0 } : { ...options, parts: [A, 'unrelated-owner'] }) }];
    });
    const document = { ...context.inputs.document, components };
    const current = refreshed(context, { ...context.inputs, document });
    const result = commitOccurrenceFilletWeldEdit(current, EDIT, preview);
    expect(result).toEqual({ ok: false, reason: 'weld-association-damaged', rejections: [], document });
    expect(result.document).toBe(document);
    expect(context.inputs.document.components).toHaveLength(5);
  });

  it('refuses absent current leaf bodies and invalid dimensions for their intended reasons', async () => {
    const { context } = await fixture();
    const missing = previewOccurrenceFilletWeldEdit({ ...context, bodiesOf: () => null }, EDIT);
    if (missing.ok) throw new Error('missing contact geometry accepted');
    expect(missing.reason).toBe('geometry-rejected');
    expect(missing.rejections.map(rejection => rejection.code)).toEqual(['contactFaceUnavailable', 'contactFaceUnavailable']);
    const invalid = previewOccurrenceFilletWeldEdit(context, { ...EDIT, legOnFirst: 0 });
    if (invalid.ok) throw new Error('zero leg accepted');
    expect(invalid.reason).toBe('geometry-rejected');
    expect(invalid.rejections.map(rejection => rejection.code)).toEqual(['invalidDimension']);
  });
});
