import { beforeEach, describe, expect, it } from 'vitest';
import type { DatumDefinition, Dimension, DimensionTarget, GdtFeature, GdtFrameSegment, GdtShapeTarget, GeometricToleranceFrame, OutlinedText } from '@pointercad/drawing';
import { compatibleGdtSizeDimensions, createDrawingDocument, drawingDimensionContext, IDENTITY_PLACEMENT, resolveDrawingDimensions,
  resolveDrawingGdt, type SolidBody, type SolidEdgeEntry, type SolidFaceEntry } from '@pointercad/model';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingDatum, commitDrawingGdtFrame, drawingGdtFeature, duplicateSelectedDrawingGdt, moveSelectedDrawingGdt, startDrawingGdt } from './gdtCommands.js';
import { deleteSelectedDrawingElements, pickDrawingTarget } from './dimensionCommands.js';
import { displayDrawingGdt } from './gdtDisplay.js';
import { displayDrawingDimension } from './dimensionDisplay.js';

const metadata = { sourceRef: 'source', sourceKind: 'part' as const, fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' };
const faces: readonly SolidFaceEntry[] = [
  { index: 0, surfaceKind: 'plane', area: 100, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 0 },
  { index: 1, surfaceKind: 'plane', area: 100, centroid: [0, 10, 0], axis: [0, 1, 0], radius: null, triangleOffset: 0, triangleCount: 0 },
  { index: 2, surfaceKind: 'cylinder', area: 200, centroid: [20, 0, 5], axis: [0, 0, 1], axisOrigin: [20, 0, 0], radius: 5, triangleOffset: 0, triangleCount: 0 },
  { index: 3, surfaceKind: 'plane', area: 100, centroid: [0, 0, 10], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 0 },
];
const circle: SolidEdgeEntry = { index: 0, curveKind: 'circle', length: Math.PI * 10, midpoint: [20, 0, 0], start: [25, 0, 0], end: [25, 0, 0],
  axis: [0, 0, 1], axisOrigin: [20, 0, 0], radius: 5, segmentOffset: 0, segmentCount: 0 };
const body: SolidBody = { featureId: 'body', mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
  edgePositions: new Float32Array(), triangleCount: 0 }, volume: 1000, isValid: true, bodyKind: 'solid', faces, edges: [circle], vertices: [], threadMarks: [] };
const target = (index: number): GdtShapeTarget => ({ kind: 'subShape', viewId: 'view', sourceRef: 'source',
  ref: { bodyFeatureId: 'body', index, fingerprint: { kind: 'face', surfaceKind: faces[index].surfaceKind, area: faces[index].area,
    position: faces[index].centroid, axis: faces[index].axis, radius: faces[index].radius } } });
const surface: GdtFeature = { kind: 'surface', target: target(0) }, axis: GdtFeature = { kind: 'axis', target: target(2) };
const datumInput: Omit<DatumDefinition, 'id'> = { label: 'A', feature: { kind: 'surface', target: target(1) }, position: [70, 130], height: 3.5, layerId: 'layer-5' };
const segment: GdtFrameSegment = { characteristic: 'flatness', zone: 'betweenPlanes', material: 'none',
  tolerance: { expression: { source: '0.05', value: 500, display: 'wrong' }, unit: 'mm' }, datums: [], basicDimensionIds: [] };
const frameInput: Omit<GeometricToleranceFrame, 'id'> = { feature: surface, segments: [segment], position: [130, 125], height: 3.5, layerId: 'layer-5' };
// 既存の直径寸法は実円周を参照する。円筒面の軸と同じ解析軸であることを照合する。
const circleTarget: GdtShapeTarget = { kind: 'subShape', viewId: 'view', sourceRef: 'source', ref: { bodyFeatureId: 'body', index: 0,
  fingerprint: { kind: 'edge', curveKind: 'circle', length: circle.length, position: circle.midpoint, axis: circle.axis, radius: circle.radius } } };
const size: Dimension = { id: 'size', kind: 'diameter', measurement: 'radius', targets: [circleTarget],
  placement: { commonNormalCoordinate: 120, textPosition: null }, origin: 'manual', reference: false, layerId: 'layer-4' };
const outline = (text: string, sizeMm: number): OutlinedText => ({ status: 'ready', fillRule: 'nonzero', subpaths: [], missingCharacters: [],
  metrics: { fontId: 'fixture', sizeMm, advanceMm: text.length * sizeMm / 2, inkBounds: { left: 0, right: text.length * sizeMm / 2, bottom: 0, top: sizeMm } } });
const state = () => useAppStore.getState();
function document() { const value = state().drawing; if (value === null) throw new Error('drawing missing'); return value; }
function context() { const source = state().drawingSourceResolution; if (source === null) throw new Error('source missing'); return drawingDimensionContext(source); }
function displays() {
  const doc = document(), ctx = context();
  const dimensions = resolveDrawingDimensions(doc, ctx).map((entry) => displayDrawingDimension(doc, entry, outline, ctx));
  return displayDrawingGdt(doc, resolveDrawingGdt(doc, ctx), dimensions, outline);
}

describe('幾何公差の作成・編集・寸法線への関連付け', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    state().openDrawing({ ...createDrawingDocument('部品図', metadata), views: [{ id: 'view', name: '平面', kind: 'top', position: [100, 100],
      direction: [0, 0, 1], xDir: [1, 0, 0], scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' }] });
    useAppStore.setState({ drawingSourceResolution: { bodyIds: ['worker'], center: [0, 0, 0],
      dimensionInstances: [{ sourceRef: 'source', bodyId: 'worker', body, placement: IDENTITY_PLACEMENT }] } });
  });
  it('面・二面以外の選択や頂点を形体にすり替えない', () => {
    const point: DimensionTarget = { kind: 'point', viewId: 'view', paperPoint: [0, 0] };
    const vertex: DimensionTarget = { ...target(0), ref: { bodyFeatureId: 'body', index: 0, fingerprint: { kind: 'vertex', position: [0, 0, 0] } } };
    expect(drawingGdtFeature('surface', [target(0)])).toEqual(surface);
    expect(drawingGdtFeature('medianPlane', [target(0), target(3)])).toMatchObject({ kind: 'medianPlane' });
    for (const targets of [[point], [vertex], [target(0), point], []]) expect(drawingGdtFeature('surface', targets)).toBeNull();
  });
  it('道具先行と対象先行を保持し、再選択中も編集対象IDを失わない', () => {
    state().setDrawingTargets([target(0)]); expect(startDrawingGdt('gdt')).toBe(true);
    expect(state().drawingTargets).toEqual([target(0)]); expect(state().drawingEditor).toMatchObject({ kind: 'annotation', manufacturingKind: 'gdt' });
    commitDrawingGdtFrame(frameInput); const id = document().gdtFrames[0].id;
    startDrawingGdt('gdt', id); pickDrawingTarget(target(1));
    expect(state().drawingEditor).toMatchObject({ elementId: id }); expect(state().drawingTargets).toEqual([target(1)]);
  });
  it('平面度の実値で枠と矢印を作り、作成1回をUndo・Redoする', () => {
    const before = document(); expect(commitDrawingGdtFrame(frameInput)).toBe(true);
    expect(displays()[0]).toMatchObject({ unresolved: false });
    expect(displays()[0].element.texts?.map((text) => text.text)).toEqual(['0.05']);
    expect(displays()[0].element.fills).toHaveLength(2); expect(state().drawingTool).toBe('select');
    const made = document(); state().undo(); expect(document()).toBe(before); state().redo(); expect(document()).toBe(made);
  });
  it('データム改名は公差枠の安定ID参照を保って表示へ追従する', () => {
    commitDrawingDatum(datumInput); const datum = document().datums[0];
    commitDrawingGdtFrame({ ...frameInput, segments: [{ ...segment, characteristic: 'perpendicularity', datums: [{ kind: 'single', member: { datumId: datum.id, material: 'none' } }] }] });
    const frame = document().gdtFrames[0]; state().selectDrawingIds([datum.id]);
    expect(commitDrawingDatum({ ...datumInput, label: 'B' }, datum)).toBe(true);
    expect(document().gdtFrames[0]).toBe(frame); expect(displays()[1].element.texts?.map((text) => text.text)).toEqual(['0.05', 'B']);
  });
  it('重複基準名・負の公差・不正な形体は履歴も紙面位置も変えない', () => {
    commitDrawingDatum(datumInput); const before = document(), history = state().drawingUndoStack;
    expect(commitDrawingDatum(datumInput)).toBe(false);
    expect(commitDrawingGdtFrame({ ...frameInput, segments: [{ ...segment, tolerance: { ...segment.tolerance, expression: { source: '-1', value: 1, display: '1' } } }] })).toBe(false);
    expect(commitDrawingGdtFrame({ ...frameInput, feature: axis })).toBe(false);
    expect(document()).toBe(before); expect(state().drawingUndoStack).toBe(history);
  });
  it('サイズ寸法のない軸を面への指示で代用せず、対応する直径を付けて作成する', () => {
    const input = { ...frameInput, feature: axis, segments: [{ ...segment, characteristic: 'position' as const, zone: 'cylinder' as const }] };
    expect(commitDrawingGdtFrame(input)).toBe(false);
    state().applyDrawing({ ...document(), dimensions: [size] });
    expect(compatibleGdtSizeDimensions(axis, document(), context()).map((entry) => entry.dimension.id)).toEqual(['size']);
    expect(commitDrawingGdtFrame({ ...input, sizeDimensionId: size.id })).toBe(true);
    expect(displays()[0].unresolved).toBe(false);
    expect(displays()[0].element.curves?.at(-1)).toEqual({ kind: 'segment', from: [125, 100], to: [133, 100] });
    state().selectDrawingIds([size.id]); deleteSelectedDrawingElements();
    expect(resolveDrawingGdt(document(), context()).unresolvedCount).toBe(1); expect(displays()[0].unresolved).toBe(true);
    state().undo(); expect(displays()[0].unresolved).toBe(false);
  });
  it('同じ寸法値でも別配置・参照寸法・基本寸法をサイズの関連先にしない', () => {
    const doc = { ...document(), dimensions: [{ ...size, targets: [{ ...target(2), componentId: 'other' }] },
      { ...size, id: 'reference', reference: true }, { ...size, id: 'basic', basic: true }] };
    expect(compatibleGdtSizeDimensions(axis, doc, context())).toEqual([]);
  });
  it('データム三角の底辺を直径寸法線の延長に合わせる', () => {
    state().applyDrawing({ ...document(), dimensions: [size] });
    expect(commitDrawingDatum({ ...datumInput, feature: axis, sizeDimensionId: size.id, position: [140, 120] })).toBe(true);
    const display = displays()[0]; expect(display.unresolved).toBe(false);
    const commands = display.element.fills?.[0].subpaths[0].commands;
    expect(commands?.[1]).toMatchObject({ kind: 'L', to: [131 - 3.5 * 0.7 * 0.58, 100] });
    expect(commands?.[2]).toMatchObject({ kind: 'L', to: [131 + 3.5 * 0.7 * 0.58, 100] });
  });
  it('基準の削除は枠を残して未解決にし、Undoで同じ基準へ戻す', () => {
    commitDrawingDatum(datumInput); const datum = document().datums[0];
    commitDrawingGdtFrame({ ...frameInput, segments: [{ ...segment, characteristic: 'parallelism', datums: [{ kind: 'single', member: { datumId: datum.id, material: 'none' } }] }] });
    const frame = document().gdtFrames[0]; state().selectDrawingIds([datum.id]); deleteSelectedDrawingElements();
    expect(document().gdtFrames[0]).toBe(frame); expect(displays()[0].unresolved).toBe(true);
    state().undo(); expect(document().datums[0]).toBe(datum); expect(displays().every((display) => !display.unresolved)).toBe(true);
  });
  it('枠の移動では形体・式・基準を保持し、Undoは1回だけで戻る', () => {
    commitDrawingGdtFrame(frameInput); const before = document(), frame = before.gdtFrames[0];
    expect(moveSelectedDrawingGdt([7, -4])).toBe(true);
    expect(document().gdtFrames[0]).toMatchObject({ position: [137, 121] });
    expect(document().gdtFrames[0].feature).toBe(frame.feature); expect(document().gdtFrames[0].segments).toBe(frame.segments);
    state().undo(); expect(document()).toBe(before);
    expect(moveSelectedDrawingGdt([NaN, 1])).toBe(false); expect(document()).toBe(before);
  });
  it('再選択前のフォームと検査中の操作は文書を書き換えない', () => {
    commitDrawingGdtFrame(frameInput); const before = document(), frame = before.gdtFrames[0];
    state().selectDrawingIds([]); expect(commitDrawingGdtFrame({ ...frameInput, height: 5 }, frame)).toBe(false);
    useAppStore.setState({ drawingBusy: true }); expect(commitDrawingDatum(datumInput)).toBe(false);
    expect(deleteSelectedDrawingElements()).toBe(false); expect(document()).toBe(before);
  });
  it('基準と枠を一緒に複製すると新しい名前・IDへ参照を結び、全体をUndo1回で戻す', () => {
    commitDrawingDatum(datumInput); const datum = document().datums[0];
    commitDrawingGdtFrame({ ...frameInput, segments: [{ ...segment, characteristic: 'perpendicularity',
      datums: [{ kind: 'single', member: { datumId: datum.id, material: 'none' } }] }] });
    const before = document(); state().selectDrawingIds([datum.id, before.gdtFrames[0].id]);
    expect(duplicateSelectedDrawingGdt()).toBe(true);
    const copied = document(); expect(copied.datums[1]).toMatchObject({ label: 'B', position: [80, 140] });
    expect(copied.gdtFrames[1].segments[0].datums[0]).toEqual({ kind: 'single', member: { datumId: copied.datums[1].id, material: 'none' } });
    expect(copied.gdtFrames[0]).toBe(before.gdtFrames[0]); expect(copied.datums[0]).toBe(datum);
    state().undo(); expect(document()).toBe(before); state().redo(); expect(document()).toBe(copied);
  });
  it('枠だけを複製した場合は既存の基準を共有し、不正な枠を含む複製は全て取り消す', () => {
    commitDrawingDatum(datumInput); const datum = document().datums[0];
    commitDrawingGdtFrame({ ...frameInput, segments: [{ ...segment, characteristic: 'parallelism',
      datums: [{ kind: 'single', member: { datumId: datum.id, material: 'none' } }] }] });
    expect(duplicateSelectedDrawingGdt()).toBe(true); expect(document().datums).toHaveLength(1);
    expect(document().gdtFrames[1].segments[0].datums[0]).toMatchObject({ member: { datumId: datum.id } });
    state().applyDrawing({ ...document(), gdtFrames: [{ ...document().gdtFrames[0], feature: axis }] });
    const before = document(); state().selectDrawingIds([datum.id, before.gdtFrames[0].id]);
    expect(duplicateSelectedDrawingGdt()).toBe(false); expect(document()).toBe(before); expect(document().datums).toHaveLength(1);
  });
});
