import { describe, expect, it } from 'vitest';
import type { DrawingDocument, WeldKind, WeldLengthValue, WeldSideSpec, WeldSymbol } from '@pointercad/drawing';
import { IDENTITY_PLACEMENT } from '../assembly/placementMath.js';
import type { SolidBody, SolidEdgeEntry, SolidFaceEntry } from '../kernelBridge.js';
import { createDrawingDocument } from './createDrawingDocument.js';
import type { DimensionResolveContext } from './dimensionTarget.js';
import { putDrawingWeld, resolveWeldSymbol } from './welding.js';
import { weldDisplaySides } from './weldDisplay.js';

const expression = (source: string) => ({ source, value: 999, display: 'stale' });
const length = (source: string, unit: 'mm' | 'inch' = 'mm'): WeldLengthValue => ({ expression: expression(source), unit });
const face: SolidFaceEntry = { index: 0, surfaceKind: 'plane', area: 100, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 0 };
const edge: SolidEdgeEntry = { index: 0, curveKind: 'line', length: 20, midpoint: [10, 0, 0], start: [0, 0, 0], end: [20, 0, 0],
  axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 0 };
const body: SolidBody = { featureId: 'body', mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
  edgePositions: new Float32Array(), triangleCount: 0 }, volume: 1000, isValid: true, bodyKind: 'solid', faces: [face], edges: [edge], vertices: [], threadMarks: [] };
const document: DrawingDocument = { ...createDrawingDocument('溶接図', { sourceRef: 'source', sourceKind: 'part', path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' }),
  views: [{ id: 'front', name: '正面', kind: 'front', direction: [0, 0, 1], xDir: [1, 0, 0], position: [100, 100], scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
const context: DimensionResolveContext = { modelCenter: [0, 0, 0], instances: [{ sourceRef: 'source', bodyId: 'worker', body, placement: IDENTITY_PLACEMENT }] };
const target: WeldSymbol['target'] = { kind: 'subShape', viewId: 'front', sourceRef: 'source', ref: { bodyFeatureId: 'body', index: 0,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 20, position: [10, 0, 0], axis: [1, 0, 0], radius: null } } };
const side: WeldSideSpec = { kind: 'fillet', side: 'arrow', size: { kind: 'throat', value: length('5') }, contour: 'none', finish: 'none' };
const symbol = (sides: readonly WeldSideSpec[] = [side], patch: Partial<WeldSymbol> = {}): WeldSymbol => ({ id: 'weld-1', system: 'B', target, sides,
  position: [130, 130], height: 3.5, layerId: 'layer-5', allAround: false, fieldWeld: false, tail: '', ...patch });
const resolve = (current = symbol(), doc = document, ctx = context) => resolveWeldSymbol(current, doc, ctx);
const codes = (current: WeldSymbol, doc = document) => resolve(current, doc).issues.map((issue) => issue.code);

describe('Z3021溶接指示の意味・式・実形状参照', () => {
  it.each<WeldKind>(['fillet', 'squareButt', 'vButt', 'bevelButt', 'uButt', 'jButt', 'spot', 'seam'])('%sを現在の継手へ結び付ける', (kind) => {
    const sizeKind = kind === 'fillet' ? 'leg' : kind === 'spot' ? 'diameter' : kind === 'seam' ? 'width' : 'penetration';
    const result = resolve(symbol([{ ...side, kind, size: { kind: sizeKind, value: length('5') } }]));
    expect(result.issues).toEqual([]); expect(result.feature?.paperPoint).toEqual([110, 100]); expect(result.sides[0].sizeMm).toBe(5);
  });
  it('のど厚・断続長・個数・中心間隔をa5と100(4)-200で示す', () => {
    const result = resolve(symbol([{ ...side, length: length('100'), count: expression('2+2'), pitch: length('200'), contour: 'flush', finish: 'polish' }]));
    expect(weldDisplaySides(result)).toMatchObject([{ size: 'a5', length: '100(4)-200', finish: 'P' }]);
    expect(result.symbol.sides[0].count?.source).toBe('2+2');
  });
  it('inchと長さパラメータを再評価し、キャッシュ999は表示に使わない', () => {
    const doc = { ...document, parameters: [{ name: '幅', unit: 'mm' as const, description: '', value: expression('25.4') }] };
    expect(resolve(symbol([{ ...side, size: { kind: 'leg', value: length('1', 'inch') } }]), doc).sides[0].sizeMm).toBeCloseTo(25.4, 8);
    expect(resolve(symbol([{ ...side, size: { kind: 'leg', value: length('幅/2', 'inch') } }]), doc).sides[0].sizeMm).toBeCloseTo(12.7, 8);
  });
  it('間接参照でも角度を長さへ、長さを個数や角度へ流用しない', () => {
    const doc = { ...document, parameters: [{ name: '角度', unit: 'degree' as const, description: '', value: expression('30') },
      { name: '間接', unit: 'none' as const, description: '', value: expression('角度/10') },
      { name: '幅', unit: 'mm' as const, description: '', value: expression('3') }] };
    expect(codes(symbol([{ ...side, size: { kind: 'leg', value: length('間接') } }]), doc)).toContain('size');
    expect(codes(symbol([{ ...side, count: expression('幅'), pitch: length('100'), length: length('20') }]), doc)).toContain('count');
    expect(codes(symbol([{ ...side, kind: 'vButt', size: undefined, grooveAngle: expression('幅') }]), doc)).toContain('groove');
  });
  it.each(['-1', '0', '1/0', '未定義'])('不正なサイズ式%sを止める', (source) => {
    expect(codes(symbol([{ ...side, size: { kind: 'leg', value: length(source) } }]))).toContain('size');
  });
  it('両側は独立指定し、X開先は上下Vで寸法を失わない', () => {
    const result = resolve(symbol([{ ...side, kind: 'vButt', size: { kind: 'penetration', value: length('6') }, grooveDepth: length('4'),
      rootGap: length('2'), grooveAngle: expression('60') }, { ...side, side: 'opposite', kind: 'vButt', size: undefined }]));
    expect(result.issues).toEqual([]); expect(weldDisplaySides(result)).toMatchObject([{ size: '4(6)', grooveAngle: '60°', rootGap: '2' }, { size: '' }]);
  });
  it('抵抗スポットは基線中央、直径と個数・中心間隔を示す', () => {
    const result = resolve(symbol([{ ...side, kind: 'spot', side: 'center', size: { kind: 'diameter', value: length('6') }, count: expression('3'), pitch: length('30') }]));
    expect(result.issues).toEqual([]); expect(weldDisplaySides(result)).toMatchObject([{ size: '6', length: '(3)-30' }]);
    expect(codes(symbol([{ ...side, side: 'center' }]))).toContain('side');
  });
  it('全周と断続・部分長・スポットの矛盾、仕上げだけの指示を断る', () => {
    expect(codes(symbol([{ ...side, length: length('20') }], { allAround: true }))).toContain('allAround');
    expect(codes(symbol([{ ...side, length: length('20'), pitch: length('10'), count: expression('2.5') }]))).toEqual(expect.arrayContaining(['pitch', 'count']));
    expect(codes(symbol([{ ...side, finish: 'grind' }]))).toContain('finish');
    expect(codes(symbol([side, side]))).toContain('side');
    expect(codes(symbol([side], { closedTail: true }))).toContain('placement');
  });
  it('他配置・他source・消えた辺を代替形体へ付け替えず、紙上点にも変えない', () => {
    expect(resolve(symbol(), document, { ...context, instances: [{ ...context.instances[0], componentId: 'other' }] }).feature).toBeNull();
    expect(resolve(symbol(), document, { ...context, instances: [{ ...context.instances[0], body: { ...body, edges: [] } }] }).feature).toBeNull();
    expect(codes(symbol([side], { target: { kind: 'point', viewId: 'front', paperPoint: [110, 100] } }))).toContain('target');
  });
  it('作成と編集は不変更新し、失敗や古い編集対象は文書を変えない', () => {
    const created = putDrawingWeld(document, symbol(), context); expect(created.ok).toBe(true); if (!created.ok) return;
    expect(document.weldSymbols).toEqual([]); expect(created.document.weldSymbols).toHaveLength(1);
    const current = created.document.weldSymbols[0];
    expect(putDrawingWeld(created.document, current, context, current)).toMatchObject({ ok: true, document: created.document });
    expect(putDrawingWeld(created.document, current, context, { ...current }).ok).toBe(false);
    expect(putDrawingWeld(document, symbol([{ ...side, size: undefined }]), context).ok).toBe(false);
  });
});
