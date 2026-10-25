import { createAssemblyDocument, createComponentFor, createDrawingDocument, IDENTITY_PLACEMENT,
  type AssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { beginReferenceRepair, cancelReferenceRepair, commitReferenceRepair, hoverReferenceRepair, referenceRepairImpacts } from './referenceRepair.js';
import { repairFixture } from './referenceRepairFixture.js';
import { repairCandidates, repairResolution } from './referenceRepairCandidates.js';
import type { Dimension, DrawingDocument } from '@pointercad/drawing';
import type { SolidBody } from '@pointercad/model';

beforeEach(resetTestStore);
afterEach(resetTestStore);

function assemblyFixture() {
  const { body, reference } = repairFixture(), empty = createAssemblyDocument('組立');
  const first = createComponentFor(empty, { kind: 'part', partRef: 'p1' });
  const second = createComponentFor({ ...empty, components: [first] }, { kind: 'part', partRef: 'p2' });
  const document: AssemblyDocument = { ...empty, components: [first, second], mates: [{
    id: 'mate', name: '平行', kind: 'parallel', suppressed: false, flipped: false,
    a: { kind: 'subShape', componentId: first.id, ref: reference },
    b: { kind: 'subShape', componentId: second.id, ref: reference },
  }] };
  useAppStore.getState().openAssembly(document);
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: document,
    resolved: { parts: new Map(), errors: [], placements: new Map([[first.id, IDENTITY_PLACEMENT], [second.id, IDENTITY_PLACEMENT]]),
      partKeys: new Map([[first.id, 'p1'], [second.id, 'p2']]) },
    bodies: new Map([['p1', [body]], ['p2', [body]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
  } });
  return { document, first, second, body };
}

function drawingFixture() {
  const { body, reference } = repairFixture();
  const document = { ...createDrawingDocument('図面', { sourceRef: 's', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: '' }),
    dimensions: [{ id: 'dimension', kind: 'length' as const, measurement: 'trueDistance' as const,
      targets: ['s', 'other'].map(sourceRef => ({ kind: 'subShape' as const, sourceRef, viewId: 'front', ref: reference })),
      placement: { commonNormalCoordinate: 12, textPosition: null }, reference: false, origin: 'manual' as const, layerId: 'layer-1' }] };
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingBusy: false, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 1, sourceChangedExternally: false },
    drawingSourceResolution: { bodyIds: ['one', 'two'], center: [0, 0, 0],
    dimensionInstances: ['s', 'other'].map(sourceRef => ({ sourceRef, bodyId: sourceRef, body, placement: IDENTITY_PLACEMENT })) } });
  return { document, body };
}

function setDrawingGeometry(document: DrawingDocument, body: SolidBody): void {
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingBusy: false, drawingResolution: { ok: true, document,
    projection: { ok: true, views: [], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 0, sourceChangedExternally: false },
    drawingSourceResolution: { bodyIds: ['one'], center: [0, 0, 0],
      dimensionInstances: [{ sourceRef: 's', bodyId: 'one', body, placement: IDENTITY_PLACEMENT }] } });
}

describe('寸法・合致の参照所有者と全影響先', () => {
  it.each(['radius', 'diameter', 'arcLength'] as const)('%s の候補は測定可能な円弧だけを出す', kind => {
    const { document, body } = drawingFixture();
    const dimension: Dimension = { ...document.dimensions[0], kind, measurement: 'radius', targets: [document.dimensions[0].targets[0]] };
    const curved: SolidBody = { ...body, edges: [
      { ...body.edges[0], curveKind: 'circle', radius: 4, length: 8 * Math.PI, axis: [0, 0, 1], axisOrigin: [0, 0, 0] },
      body.edges[1],
      { ...body.edges[0], index: 2, curveKind: 'circle', radius: 9, length: 18 * Math.PI, axis: [0, 0, 1] },
      { ...body.edges[0], index: 3, curveKind: 'circle', radius: 12, length: 24 * Math.PI, axis: [0, 0, 1], axisOrigin: null },
    ] };
    setDrawingGeometry({ ...document, dimensions: [dimension] }, curved);
    expect(repairCandidates(currentRepairSlots(useAppStore.getState())[0]).map(item => item.reference.index)).toEqual([0]);
  });
  it.each(['sphereRadius', 'sphereDiameter'] as const)('%s は平面・円筒・中心不明の球面を候補から外す', kind => {
    const { document, body } = drawingFixture(), target = document.dimensions[0].targets[0];
    const dimension: Dimension = { ...document.dimensions[0], kind, measurement: 'radius', targets: [{ ...target,
      ref: { bodyFeatureId: 'base', index: 99, fingerprint: { kind: 'face', surfaceKind: 'sphere', area: 100,
        position: [0, 0, 0], axis: null, radius: 4 } } }] };
    const face: SolidBody['faces'][number] = { index: 0, surfaceKind: 'sphere', area: 100, centroid: [0, 0, 0],
      axis: null, radius: 4, axisOrigin: [0, 0, 0], triangleOffset: 0, triangleCount: 1 };
    const { axisOrigin: omitted, ...withoutOrigin } = face;
    expect(omitted).toEqual([0, 0, 0]);
    setDrawingGeometry({ ...document, dimensions: [dimension] }, { ...body, faces: [face,
      { ...face, index: 1, surfaceKind: 'plane', axis: [0, 0, 1], radius: null },
      { ...face, index: 2, surfaceKind: 'cylinder', axis: [0, 0, 1] },
      { ...withoutOrigin, index: 3, radius: 8, area: 400 }] });
    expect(repairCandidates(currentRepairSlots(useAppStore.getState())[0]).map(item => item.reference.index)).toEqual([0]);
  });
  it('参照が一意でも寸法の再計算に残った問題を影響欄へ伝える', () => {
    const { document, body } = drawingFixture();
    setDrawingGeometry(document, { ...body, edges: [body.edges[0]] });
    const resolution = useAppStore.getState().drawingResolution;
    if (resolution?.ok !== true) throw new Error('図面結果が必要');
    useAppStore.setState({ drawingResolution: { ...resolution, dimensions: [{ dimension: document.dimensions[0],
      targets: [], value: null, coordinates: null, text: '？', status: 'unresolved', reason: 'measurement' }] } });
    const impacts = referenceRepairImpacts(useAppStore.getState(), currentRepairSlots(useAppStore.getState())[0]);
    expect(impacts[0].status).toBe('matched');
    expect(impacts[0].issue).toBe('寸法を測定できません。対象の組み合わせを確認してください。');
  });
  it('公差・溶接は参照の一致だけで正常とせず共通の再検査結果を表示する', () => {
    const { document, body } = drawingFixture(), target = document.dimensions[0].targets[0];
    const drawing: DrawingDocument = { ...document,
      datums: [{ id: 'datum', label: 'A', feature: { kind: 'line', target }, sizeDimensionId: 'dimension',
        position: [10, 10], height: 3.5, layerId: 'layer-1' }],
      gdtFrames: [{ id: 'frame', feature: { kind: 'line', target }, position: [20, 20], height: 3.5, layerId: 'layer-1', segments: [{
        characteristic: 'angularity', tolerance: { expression: { source: '0.1', value: 0.1, display: '0.1' }, unit: 'mm' },
        zone: 'betweenLines', material: 'none', datums: [{ kind: 'single', member: { datumId: 'datum', material: 'none' } }],
        basicDimensionIds: ['dimension'],
      }] }],
      weldSymbols: [{ id: 'weld', target, system: 'B', sides: [], position: [30, 30], height: 3.5, layerId: 'layer-1',
        allAround: false, fieldWeld: false, tail: '' }] };
    setDrawingGeometry(drawing, { ...body, edges: [body.edges[0]] });
    const impacts = referenceRepairImpacts(useAppStore.getState(), currentRepairSlots(useAppStore.getState())[0]);
    const datum = impacts.find(item => item.ownerId === 'datum'), frame = impacts.find(item => item.ownerId === 'frame');
    const weld = impacts.find(item => item.ownerId === 'weld');
    expect(datum?.status).toBe('matched');
    expect(datum?.issue).toContain('面や線の指示にはサイズ寸法を関連付けません。');
    expect(frame?.status).toBe('matched');
    expect(frame?.issue).toContain('参照する理論的に正確な寸法の対象が未解決です。');
    expect(weld?.status).toBe('matched');
    expect(weld?.issue).toBeTypeOf('string');
    expect(weld?.issue?.length).toBeGreaterThan(0);
  });
  it('合致の左右を別配置として保持し、両側を再検査して一履歴で片側を修復する', () => {
    const { document } = assemblyFixture(), slots = currentRepairSlots(useAppStore.getState()), session = beginReferenceRepair(slots[0].key);
    if (session === null) throw new Error('組立セッションが必要');
    expect(session.impacts.map(item => item.status)).toEqual(['ambiguous', 'ambiguous']);
    const before = useAppStore.getState(), candidate = session.candidates[0];
    hoverReferenceRepair(session, candidate);
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(commitReferenceRepair(session, candidate)).toBe('applied');
    const after = useAppStore.getState();
    expect(after.assemblyUndoStack?.past).toHaveLength((before.assemblyUndoStack?.past.length ?? 0) + 1);
    expect(after.assembly?.mates[0].b).toBe(document.mates[0].b);
    const view = after.assemblyView;
    if (view === null || after.assembly === null) throw new Error('組立結果が必要');
    useAppStore.setState({ isComputing: false, assemblyView: { ...view, sourceDocument: after.assembly } });
    expect(referenceRepairImpacts(useAppStore.getState(), session.slot).map(item => item.status)).toEqual(['matched', 'ambiguous']);
  });
  it('図面寸法の別ソース側も再検査し、取消0・確定1履歴を守る', () => {
    const { document } = drawingFixture(), slots = currentRepairSlots(useAppStore.getState());
    const first = beginReferenceRepair(slots[0].key);
    if (first === null) throw new Error('図面セッションが必要');
    expect(first.impacts).toHaveLength(2);
    const before = useAppStore.getState();
    hoverReferenceRepair(first, first.candidates[0]); cancelReferenceRepair(first);
    expect(useAppStore.getState().drawing).toBe(document);
    expect(useAppStore.getState().drawingUndoStack).toBe(before.drawingUndoStack);
    const next = beginReferenceRepair(slots[0].key);
    if (next === null) throw new Error('再選択セッションが必要');
    expect(commitReferenceRepair(next, next.candidates[0])).toBe('applied');
    expect(useAppStore.getState().drawingUndoStack?.past).toHaveLength((before.drawingUndoStack?.past.length ?? 0) + 1);
    expect(useAppStore.getState().drawing?.dimensions[0].targets[1]).toBe(document.dimensions[0].targets[1]);
  });
  it.each(['assembly', 'drawing'])('%s の解決結果を更新したら旧候補は拒否する', kind => {
    if (kind === 'assembly') assemblyFixture(); else drawingFixture();
    const slot = currentRepairSlots(useAppStore.getState())[0], session = beginReferenceRepair(slot.key);
    if (session === null) throw new Error('セッションが必要');
    if (kind === 'assembly') useAppStore.setState({ assemblyView: null });
    else useAppStore.setState({ drawingSourceResolution: null });
    expect(commitReferenceRepair(session, session.candidates[0])).toBe('stale');
  });
  it('同じbodyFeatureIdでも別ソース・別配置を候補に混ぜない', () => {
    drawingFixture();
    const slot = currentRepairSlots(useAppStore.getState())[0], resolution = useAppStore.getState().drawingSourceResolution;
    if (resolution === null) throw new Error('図面結果が必要');
    useAppStore.setState({ drawingSourceResolution: { ...resolution,
      dimensionInstances: resolution.dimensionInstances?.filter(instance => instance.sourceRef !== slot.sourceRef) } });
    expect(repairResolution(currentRepairSlots(useAppStore.getState())[0]).status).toBe('missing');
  });
});
