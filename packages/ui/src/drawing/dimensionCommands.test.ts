import type { DimensionTarget, DrawingView, Point2 } from '@pointercad/drawing';
import { createDrawingDocument, drawingDimensionContext, IDENTITY_PLACEMENT, resolveDrawingDimensions, type SolidBody, type SolidEdgeEntry } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginDrawingDimensionDrag, commitDrawingDimension, deleteSelectedDrawingElements, finishDrawingDimensionDrag,
  pickDrawingTarget, previewDrawingDimensionDrag, previewDrawingDimensionsDrag, startDrawingDimension } from './dimensionCommands.js';

const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'plate.pcad', path: '', contentHash: 'hash', importedAt: '' };
const front: DrawingView = { id: 'view-1', name: '正面', kind: 'front', position: [100, 100], scale: null,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const line: SolidEdgeEntry = { index: 0, curveKind: 'line', length: 20, midpoint: [10, 0, 0], start: [0, 0, 0], end: [20, 0, 0],
  axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 1 };
const circle: SolidEdgeEntry = { ...line, index: 1, curveKind: 'circle', radius: 4, length: Math.PI * 8,
  axis: [0, 1, 0], axisOrigin: [10, 0, 10], midpoint: [6, 0, 10], start: [14, 0, 10], end: [14, 0, 10] };
const body: SolidBody = { featureId: 'solid-1', mesh: { positions: new Float32Array([0, 0, 0, 20, 10, 30]),
  normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
  volume: 6000, isValid: true, bodyKind: 'solid', faces: [], edges: [line, circle], vertices: [], threadMarks: [] };
function edgeTarget(edge = line): DimensionTarget {
  return { kind: 'subShape', sourceRef: source.sourceRef, viewId: front.id,
    ref: { bodyFeatureId: body.featureId, index: edge.index, fingerprint: { kind: 'edge', curveKind: edge.curveKind,
      length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } } };
}
function pointTarget(point: Point2): DimensionTarget {
  return { kind: 'point', viewId: front.id, paperPoint: [100 + point[0], 100 + point[1]], modelPoint: [point[0], 0, point[1]] };
}
function openDrawing(): void {
  const state = useAppStore.getState();
  state.openDrawing({ ...createDrawingDocument('図面', source), views: [front] });
  useAppStore.setState({ drawingSourceResolution: { bodyIds: ['worker-key'], center: [0, 0, 0],
    dimensionInstances: [{ sourceRef: source.sourceRef, bodyId: 'worker-key', body, placement: IDENTITY_PLACEMENT }] } });
}
const state = () => useAppStore.getState();
const dimensions = () => state().drawing?.dimensions ?? [];
const lengthKind = { kind: 'length', measurement: 'trueDistance' } as const;

describe('図面寸法の確定・選択・移動(P8-28)', () => {
  beforeEach(() => { useAppStore.setState(createInitialDocumentState()); openDrawing(); });

  it('辺を選んでから長さを押すと1本増える', () => {
    pickDrawingTarget(edgeTarget());
    expect(startDrawingDimension(lengthKind)).toBe(true);
    expect(dimensions()).toHaveLength(1);
    expect(dimensions()[0]).toMatchObject({ ...lengthKind, targets: [edgeTarget()], origin: 'manual' });
  });
  it('寸法用の既定レイヤーを削除した後も有効なレイヤーへ寸法を作る', () => {
    const document = state().drawing;
    if (document === null) throw new Error('図面なし');
    state().applyDrawing({ ...document, layers: document.layers.filter((layer) => layer.id !== 'layer-4') });
    pickDrawingTarget(edgeTarget());
    expect(commitDrawingDimension()).toBe(true);
    expect(state().drawing?.layers.some((layer) => layer.id === dimensions()[0].layerId)).toBe(true);
  });
  it('長さを押してから辺を選んでも同じ対象で1本増える', () => {
    startDrawingDimension(lengthKind);
    expect(dimensions()).toHaveLength(0);
    expect(pickDrawingTarget(edgeTarget())).toBe(true);
    expect(dimensions()[0]).toMatchObject({ ...lengthKind, targets: [edgeTarget()] });
  });
  it('円を選んでEnterの確定を呼ぶと直径になる', () => {
    pickDrawingTarget(edgeTarget(circle));
    expect(commitDrawingDimension()).toBe(true);
    expect(dimensions()[0].kind).toBe('diameter');
  });
  it('Ctrl/Shiftで始めた線間距離は2本目まで待ち、1本の長さへ早期確定しない', () => {
    const other: SolidEdgeEntry = { ...line, index: 2, start: [0, 0, 30], end: [20, 0, 30], midpoint: [10, 0, 30] };
    const sourceResolution = state().drawingSourceResolution;
    if (sourceResolution === null) throw new Error('source missing');
    useAppStore.setState({ drawingSourceResolution: { ...sourceResolution, dimensionInstances: [{ ...sourceResolution.dimensionInstances?.[0],
      sourceRef: source.sourceRef, bodyId: 'worker-key', placement: IDENTITY_PLACEMENT, body: { ...body, edges: [...body.edges, other] } }] } });
    startDrawingDimension(lengthKind); const history = state().drawingUndoStack;
    expect(pickDrawingTarget(edgeTarget(), true)).toBe(true); expect(dimensions()).toHaveLength(0); expect(state().drawingUndoStack).toBe(history);
    expect(pickDrawingTarget(edgeTarget(other), true)).toBe(true); expect(dimensions()[0].targets).toHaveLength(2);
    const current = state().drawing, geometry = state().drawingSourceResolution;
    if (current === null || geometry === null) throw new Error('drawing missing');
    expect(resolveDrawingDimensions(current, drawingDimensionContext(geometry))[0].value).toBe(30);
    expect(dimensions()[0].placement.commonNormalCoordinate).toBe(-92);
    state().undo(); expect(dimensions()).toHaveLength(0);
  });
  it('弧長を明示すると元の円への参照を残し、値を保存しない', () => {
    pickDrawingTarget(edgeTarget(circle));
    expect(startDrawingDimension({ kind: 'arcLength', measurement: 'radius' })).toBe(true);
    expect(dimensions()[0]).toMatchObject({ kind: 'arcLength', targets: [edgeTarget(circle)] });
    expect(dimensions()[0]).not.toHaveProperty('value'); state().undo(); expect(dimensions()).toHaveLength(0);
  });
  it('座標寸法は2点を基準・測定点の順で残して一度に確定する', () => {
    startDrawingDimension({ kind: 'coordinate', measurement: 'coordinate' });
    pickDrawingTarget(pointTarget([10, 20])); expect(dimensions()).toHaveLength(0);
    pickDrawingTarget(pointTarget([-20, 60]), true);
    expect(dimensions()[0]).toMatchObject({ kind: 'coordinate', measurement: 'coordinate', targets: [pointTarget([10, 20]), pointTarget([-20, 60])] });
  });
  it('確定直後は道具が選択に戻り作成した木の行が選択済み', () => {
    startDrawingDimension(); pickDrawingTarget(edgeTarget());
    expect(state()).toMatchObject({ drawingTool: 'select', drawingSelectedIds: ['dim-1'], drawingTargets: [] });
  });
  it('確定のUndo1回で消えRedo1回で式と対象も戻る', () => {
    pickDrawingTarget(edgeTarget()); commitDrawingDimension();
    const made = dimensions()[0];
    state().undo(); expect(dimensions()).toHaveLength(0);
    state().redo(); expect(dimensions()).toEqual([made]);
  });
  it('道具先行の1点目では履歴を変えず、2点で確定する', () => {
    startDrawingDimension(lengthKind);
    const version = state().documentVersion;
    pickDrawingTarget(pointTarget([0, 0]));
    expect(state().documentVersion).toBe(version);
    pickDrawingTarget(pointTarget([20, 30]), true);
    expect(dimensions()[0].targets).toHaveLength(2);
  });
  it('対象先行の2点でも1本だけ確定する', () => {
    pickDrawingTarget(pointTarget([0, 0])); pickDrawingTarget(pointTarget([20, 30]), true);
    startDrawingDimension(lengthKind);
    expect(dimensions()).toHaveLength(1);
  });
  it('異なる投影図の対象の混在を断り既存選択を残す', () => {
    pickDrawingTarget(edgeTarget());
    expect(pickDrawingTarget({ ...edgeTarget(), viewId: 'view-2' }, true)).toBe(false);
    expect(state().drawingTargets).toEqual([edgeTarget()]);
    expect(state().drawingMessage).toContain('記入できません');
  });
  it('同じ対象の追加選択をもう一度押すと選択を解除する', () => {
    pickDrawingTarget(edgeTarget()); pickDrawingTarget(edgeTarget(), true);
    expect(state().drawingTargets).toEqual([]);
  });
  it('対象なしのEnterは断りを出し履歴を増やさない', () => {
    expect(commitDrawingDimension()).toBe(false);
    expect(dimensions()).toHaveLength(0);
    expect(state().canUndo).toBe(false);
    expect(state().drawingMessage).toContain('記入できません');
  });
  it('解決できない曲面の参照を断り文書を壊さない', () => {
    pickDrawingTarget({ kind: 'subShape', sourceRef: source.sourceRef, viewId: front.id,
      ref: { bodyFeatureId: body.featureId, index: 7,
        fingerprint: { kind: 'face', surfaceKind: 'other', area: 10, position: [0, 0, 0], axis: null, radius: null } } });
    expect(startDrawingDimension()).toBe(false);
    expect(dimensions()).toEqual([]);
  });
  it('再計算中は前の形で寸法を確定しない', () => {
    pickDrawingTarget(edgeTarget()); useAppStore.setState({ drawingBusy: true });
    expect(commitDrawingDimension()).toBe(false);
    expect(state().drawingMessage).toContain('見つかりません');
  });
  it('ドラッグの100回のプレビューで文書も履歴も変えない', () => {
    pickDrawingTarget(edgeTarget()); commitDrawingDimension();
    const document = state().drawing, version = state().documentVersion;
    const drag = beginDrawingDimensionDrag('dim-1', [0, 1], [110, 109], [110, 109]);
    expect(drag).not.toBeNull();
    if (drag === null) return;
    for (let index = 0; index < 100; index++) previewDrawingDimensionDrag(drag, [110 + index, 109 + index]);
    expect(state().drawing).toBe(document);
    expect(state().documentVersion).toBe(version);
    expect(finishDrawingDimensionDrag(drag, [115, 119])).toBe(true);
    expect(state().documentVersion).toBe(version + 1);
    expect(dimensions()[0].placement).toEqual({ commonNormalCoordinate: 118, textPosition: [115, 119] });
    state().undo(); expect(state().drawing).toBe(document);
  });
  it('ドラッグ開始後に文書が変わった場合は古い操作を反映しない', () => {
    pickDrawingTarget(edgeTarget()); commitDrawingDimension();
    const drag = beginDrawingDimensionDrag('dim-1', [0, 1], [110, 109], [110, 109]);
    state().undo();
    expect(drag === null ? null : finishDrawingDimensionDrag(drag, [120, 120])).toBe(false);
    expect(dimensions()).toEqual([]);
  });
  it('法線の異なる2寸法を同じ差分で移動し、1回のUndoで両方を戻す', () => {
    pickDrawingTarget(edgeTarget()); commitDrawingDimension();
    pickDrawingTarget(edgeTarget(circle)); commitDrawingDimension();
    const document = state().drawing, original = dimensions(), version = state().documentVersion;
    const drag = beginDrawingDimensionDrag('dim-1', [0, 1], [110, 109], [110, 109],
      [{ id: 'dim-2', normal: [1, 0], textPosition: [120, 120] }]);
    if (drag === null) throw new Error('group drag');
    const preview = previewDrawingDimensionsDrag(drag, [115, 119]);
    expect(preview?.map((item) => item.placement)).toEqual([
      { commonNormalCoordinate: original[0].placement.commonNormalCoordinate + 10, textPosition: [115, 119] },
      { commonNormalCoordinate: original[1].placement.commonNormalCoordinate + 5, textPosition: [125, 130] },
    ]);
    expect(state().drawing).toBe(document); expect(state().documentVersion).toBe(version);
    expect(finishDrawingDimensionDrag(drag, [115, 119])).toBe(true);
    expect(dimensions()).toEqual(preview); expect(state().documentVersion).toBe(version + 1);
    expect(state().drawingSelectedIds).toEqual(['dim-1', 'dim-2']);
    state().undo(); expect(state().drawing).toBe(document);
    state().redo(); expect(dimensions()).toEqual(preview);
  });
  it('移動対象の一部が無効な場合や再計算中は、どの寸法も更新しない', () => {
    pickDrawingTarget(edgeTarget()); commitDrawingDimension(); const original = state().drawing;
    expect(beginDrawingDimensionDrag('dim-1', [0, 1], [110, 109], [110, 109],
      [{ id: 'missing', normal: [1, 0], textPosition: [0, 0] }])).toBeNull();
    const drag = beginDrawingDimensionDrag('dim-1', [0, 1], [110, 109], [110, 109]);
    if (drag === null) throw new Error('drag');
    useAppStore.setState({ drawingBusy: true });
    expect(finishDrawingDimensionDrag(drag, [115, 119])).toBe(false); expect(state().drawing).toBe(original);
  });
  it('動かなかったドラッグとNaN座標で履歴を増やさない', () => {
    pickDrawingTarget(edgeTarget()); commitDrawingDimension();
    const version = state().documentVersion;
    const drag = beginDrawingDimensionDrag('dim-1', [0, 1], [110, 109], [110, 109]);
    if (drag === null) throw new Error('drag');
    expect(finishDrawingDimensionDrag(drag, [110, 109])).toBe(false);
    expect(finishDrawingDimensionDrag(drag, [NaN, 120])).toBe(false);
    expect(state().documentVersion).toBe(version);
  });
  it('選択した寸法だけを消してUndo1回で戻す', () => {
    pickDrawingTarget(edgeTarget()); commitDrawingDimension();
    pickDrawingTarget(edgeTarget(circle)); commitDrawingDimension();
    expect(deleteSelectedDrawingElements()).toBe(true);
    expect(dimensions().map((dimension) => dimension.id)).toEqual(['dim-1']);
    state().undo(); expect(dimensions()).toHaveLength(2);
  });
});
