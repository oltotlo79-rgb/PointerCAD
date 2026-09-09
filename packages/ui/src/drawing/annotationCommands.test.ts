import { expressionValueFromNumber as num } from '@pointercad/expression';
import type { DimensionTarget, DrawingView, OutlinedText } from '@pointercad/drawing';
import { createDrawingDocument, createEmptyPartDocument, IDENTITY_PLACEMENT,
  type DrawingSourceLibrary, type SolidBody, type SolidFaceEntry, type ThreadHoleFeature } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { addDrawingMachiningNote, addDrawingSurfaceFinish, startDrawingAnnotation } from './annotationCommands.js';
import { displayDrawingAnnotations } from './annotationDisplay.js';
import { pickDrawingFace } from './drawingPick.js';

const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'plate.pcad', path: '', contentHash: 'hash', importedAt: '' };
const view: DrawingView = { id: 'view-1', name: '正面', kind: 'front', position: [100, 100], scale: null,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const face: SolidFaceEntry = { index: 0, surfaceKind: 'cylinder', area: 100, centroid: [5, 0, 5], axis: [0, 0, 1], radius: 4,
  triangleOffset: 0, triangleCount: 1 };
const body: SolidBody = { featureId: 'thread-1', mesh: { positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 0, 20]),
  normals: new Float32Array(), indices: new Uint32Array([0, 1, 2]), edgePositions: new Float32Array(), triangleCount: 1 },
  volume: 100, isValid: true, bodyKind: 'solid', faces: [face], edges: [], vertices: [], threadMarks: [] };
const target: DimensionTarget = { kind: 'subShape', viewId: view.id, sourceRef: source.sourceRef,
  ref: { bodyFeatureId: body.featureId, index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind,
    area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } } };
const thread: ThreadHoleFeature = { id: body.featureId, name: 'ねじ穴', suppressed: false, kind: 'threadHole', targetFeatureId: 'box',
  face: target.ref, centers: [{ sketchId: 'sketch', pointFeatureId: 'point' }], designation: 'M8', series: 'coarse',
  pitch: num(1.25), drillDiameter: num(6.647), depth: { kind: 'through' }, threadLength: num(10), representation: 'simplified',
  tiltAngle: num(0), tiltAzimuth: num(0) };
function outline(text: string, sizeMm: number): OutlinedText {
  return { status: 'ready', missingCharacters: [], fillRule: 'nonzero', subpaths: [], metrics: { fontId: 'fixture', sizeMm,
    advanceMm: text.length * sizeMm, inkBounds: { left: 0, right: text.length * sizeMm, bottom: 0, top: sizeMm } } };
}
const state = () => useAppStore.getState();
const input = { target, position: [125, 120] as const, process: 'basic' as const, parameter: 'Ra' as const, value: '3.2' };
function displays() {
  const current = state();
  if (current.drawing === null || current.drawingSourceResolution === null) throw new Error('図面なし');
  return displayDrawingAnnotations(current.drawing, current.drawingSourceResolution, current.drawingSources, outline);
}
function text() { return displays().flatMap((element) => element.texts?.map((item) => item.text) ?? []).join(''); }

describe('表面性状と加工注記の操作・再評価(P8-36)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    const library: DrawingSourceLibrary = { sources: [{ metadata: source, document: { ...createEmptyPartDocument(), solids: [thread] } }] };
    state().openDrawing({ ...createDrawingDocument('部品図', source), views: [view] }, { sources: library });
    useAppStore.setState({ drawingSourceResolution: { bodyIds: ['key'], center: [0, 0, 0],
      dimensionInstances: [{ sourceRef: source.sourceRef, bodyId: 'key', body, placement: IDENTITY_PLACEMENT }] } });
  });
  it('円筒面にRa3.2の記号と引出線・黒矢印を置く', () => {
    expect(addDrawingSurfaceFinish(input)).toBe(true);
    expect(text()).toBe('Ra 3.2');
    expect(displays()[0].curves?.length).toBeGreaterThan(2);
    expect(displays()[0].fills).toHaveLength(1);
    expect(state().drawing?.annotations[0]).toMatchObject({ sourceTarget: target, surfaceFinish: { value: { source: '3.2' } } });
  });
  it('除去加工の指定は横棒を加える', () => {
    addDrawingSurfaceFinish({ ...input, process: 'removal' });
    expect(displays()[0].curves).toHaveLength(5);
  });
  it('除去加工禁止は丸で区別する', () => {
    addDrawingSurfaceFinish({ ...input, process: 'noRemoval', parameter: 'Rz' });
    expect(displays()[1].curves?.[0].kind).toBe('arc'); expect(text()).toBe('Rz 3.2');
  });
  it('注記はUndo1回で消えRedoで戻る', () => {
    addDrawingSurfaceFinish(input); state().undo(); expect(state().drawing?.annotations).toHaveLength(0);
    state().redo(); expect(text()).toBe('Ra 3.2');
  });
  it('作成後に選択へ戻して作った注記を選ぶ', () => {
    startDrawingAnnotation(); addDrawingSurfaceFinish(input);
    expect(state().drawingTool).toBe('select'); expect(state().drawingSelectedIds).toEqual([state().drawing?.annotations[0].id]);
  });
  it('面先行でも注記の道具先行でも対象を保持できる', () => {
    state().setDrawingTargets([target]); startDrawingAnnotation(); expect(state().drawingTargets).toEqual([target]);
    state().setDrawingTool('select'); startDrawingAnnotation(); expect(state().drawingMessage).not.toBeNull();
  });
  it('負の粗さは断り文を出してUndoを増やさない', () => {
    expect(addDrawingSurfaceFinish({ ...input, value: '-1' })).toBe(false);
    expect(state().drawingMessage).not.toBeNull(); expect(state().canUndo).toBe(false);
  });
  it('式の評価失敗でもアプリの文書は壊さない', () => {
    expect(addDrawingSurfaceFinish({ ...input, value: '1/0' })).toBe(false); expect(state().drawing?.annotations).toHaveLength(0);
  });
  it('消えた面の古い注記値を残さず？にする', () => {
    addDrawingSurfaceFinish(input);
    useAppStore.setState({ drawingSourceResolution: { bodyIds: [], dimensionInstances: [], center: [0, 0, 0] } });
    expect(text()).toBe('？'); expect(displays()[0].style?.color).toBe('#c2410c');
  });
  it('選んだねじ穴の加工情報からM8×1.25を入れる', () => {
    expect(addDrawingMachiningNote(target, input.position)).toBe(true); expect(text()).toBe('M8×1.25');
    expect(state().drawing?.annotations[0].machiningFeatureId).toBe(thread.id);
  });
  it('元部品のピッチの式を再評価して表示する', () => {
    addDrawingMachiningNote(target, input.position);
    const document = { ...createEmptyPartDocument(), solids: [{ ...thread, pitch: { source: '1/2', value: 99, display: '99' } }] };
    useAppStore.setState({ drawingSources: { sources: [{ metadata: source, document }] } });
    expect(text()).toBe('M8×0.5');
  });
  it('加工フィーチャーが消えたら古いM8を表示しない', () => {
    addDrawingMachiningNote(target, input.position);
    useAppStore.setState({ drawingSources: { sources: [{ metadata: source, document: createEmptyPartDocument() }] } });
    expect(text()).toBe('？');
  });
  it('加工情報のない形を断って帯へ理由を出す', () => {
    useAppStore.setState({ drawingSources: { sources: [] } });
    expect(addDrawingMachiningNote(target, input.position)).toBe(false); expect(state().drawingMessage).not.toBeNull();
  });
  it('再計算中は表面性状・加工注記とも文書を変えない', () => {
    useAppStore.setState({ drawingBusy: true });
    expect(addDrawingSurfaceFinish(input)).toBe(false); expect(addDrawingMachiningNote(target, input.position)).toBe(false);
    expect(state().canUndo).toBe(false);
  });
  it('実三角形の内部を面として選び、境界矩形内の空白は選ばない', () => {
    const document = state().drawing, resolved = state().drawingSourceResolution;
    if (document === null || resolved === null) throw new Error('図面なし');
    const views = [{ viewId: view.id, name: view.name, position: view.position, scale: 1, visible: [], hidden: [], cuttingCurves: [] }];
    expect(pickDrawingFace(document, resolved, views, [105, 105])).toEqual(target);
    expect(pickDrawingFace(document, resolved, views, [119, 119])).toBeNull();
  });
});
