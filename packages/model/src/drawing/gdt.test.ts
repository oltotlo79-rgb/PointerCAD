import { describe, expect, it } from 'vitest';
import type { DatumDefinition, DrawingDocument, GdtFrameSegment, GdtFeature, GdtShapeTarget, GeometricToleranceFrame,
  ToleranceCharacteristic, ToleranceZone, Vector3 } from '@pointercad/drawing';
import { IDENTITY_PLACEMENT } from '../assembly/placementMath.js';
import type { SolidBody, SolidEdgeEntry, SolidFaceEntry } from '../kernelBridge.js';
import { createDrawingDocument } from './createDrawingDocument.js';
import type { DimensionResolveContext } from './dimensionTarget.js';
import { resolveGdtFeature } from './gdt.js';
import { defaultGdtToleranceZone, gdtFrameDisplayRows, resolveDrawingDatums, resolveGdtFrame } from './gdtValidation.js';

const plane = (index: number, centroid: Vector3 = [0, 0, index * 10], axis: Vector3 = [0, 0, 1]): SolidFaceEntry => ({
  index, surfaceKind: 'plane', area: 400, centroid, axis, radius: null, triangleOffset: 0, triangleCount: 0,
});
const cylinder: SolidFaceEntry = { ...plane(3, [20, 0, 5]), surfaceKind: 'cylinder', radius: 5, area: 100 * Math.PI, axisOrigin: [20, 0, 0] };
const datumCylinder: SolidFaceEntry = { ...cylinder, index: 4, centroid: [20, 0, 25] };
const edge: SolidEdgeEntry = { index: 0, curveKind: 'line', length: 20, midpoint: [10, 0, 0], start: [0, 0, 0], end: [20, 0, 0],
  axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 0 };
const circle: SolidEdgeEntry = { ...edge, index: 1, curveKind: 'circle', length: 10 * Math.PI, midpoint: [20, 0, 0],
  start: [25, 0, 0], end: [25, 0, 0], axis: [0, 0, 1], axisOrigin: [20, 0, 0], radius: 5 };
const body: SolidBody = { featureId: 'body', mesh: { positions: new Float32Array(), normals: new Float32Array(),
  indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 }, volume: 1000, isValid: true, bodyKind: 'solid',
edges: [edge, circle], faces: [plane(0), plane(1), plane(2, [30, 0, 0], [1, 0, 0]), cylinder, datumCylinder], vertices: [], threadMarks: [] };
const context: DimensionResolveContext = { modelCenter: [0, 0, 0], instances: [{ sourceRef: 'source', bodyId: 'worker-body', body, placement: IDENTITY_PLACEMENT }] };
const document: DrawingDocument = { ...createDrawingDocument('図面', { sourceRef: 'source', sourceKind: 'part', path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' }),
  views: [{ id: 'front', name: '正面図', kind: 'front', direction: [0, 1, 0], xDir: [1, 0, 0], position: [100, 100], scale: null,
    showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
function faceTarget(face: SolidFaceEntry): GdtShapeTarget {
  return { kind: 'subShape', viewId: 'front', sourceRef: 'source', ref: { bodyFeatureId: 'body', index: face.index,
    fingerprint: { kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } } };
}
function edgeTarget(item = edge): GdtShapeTarget {
  return { kind: 'subShape', viewId: 'front', sourceRef: 'source', ref: { bodyFeatureId: 'body', index: item.index,
    fingerprint: { kind: 'edge', curveKind: item.curveKind, length: item.length, position: item.midpoint, axis: item.axis, radius: item.radius } } };
}
const surface: GdtFeature = { kind: 'surface', target: faceTarget(plane(0)) };
const axis: GdtFeature = { kind: 'axis', target: faceTarget(cylinder) };
const median: GdtFeature = { kind: 'medianPlane', targets: [faceTarget(plane(0)), faceTarget(plane(1))] };
const datum = (id = 'datum-a', feature: GdtFeature = { kind: 'surface', target: faceTarget(plane(2, [30, 0, 0], [1, 0, 0])) }, label = 'A'): DatumDefinition => ({
  id, label, feature, position: [10, 20], height: 3.5, layerId: 'layer-5',
});
const ref = (datumId = 'datum-a') => ({ kind: 'single' as const, member: { datumId, material: 'none' as const } });
function segment(characteristic: ToleranceCharacteristic = 'flatness', zone: ToleranceZone = 'betweenPlanes', patch: Partial<GdtFrameSegment> = {}): GdtFrameSegment {
  return { characteristic, zone, tolerance: { expression: { source: '0.05', value: 999, display: '999' }, unit: 'mm' }, material: 'none', datums: [], basicDimensionIds: [], ...patch };
}
const frame = (feature: GdtFeature = surface, segments = [segment()]): GeometricToleranceFrame => ({ id: 'gdt-1', feature, segments,
  position: [40, 50], height: 3.5, layerId: 'layer-5' });
const resolve = (current = frame(), datums = [datum()], doc = document, geometry = context) => resolveGdtFrame(current, doc, geometry, resolveDrawingDatums(datums, doc, geometry));

describe('幾何公差の意味と現在形状の参照', () => {
  it('公差種類を変えた初期公差域は平面・軸・線の対象に合わせる', () => {
    expect(defaultGdtToleranceZone('perpendicularity', 'plane')).toBe('betweenPlanes');
    expect(defaultGdtToleranceZone('parallelism', 'medianPlane')).toBe('betweenPlanes');
    expect(defaultGdtToleranceZone('perpendicularity', 'axis')).toBe('cylinder');
    expect(defaultGdtToleranceZone('parallelism', 'line')).toBe('betweenLines');
    expect(defaultGdtToleranceZone('surfaceProfile', 'plane')).toBe('surfaceProfile');
  });
  it('孔内にある面重心へ指示点を置かず、現在の面三角形の内部へ置く', () => {
    const doc = { ...document, views: [{ ...document.views[0], direction: [0, 0, 1] as const }] };
    const geometry = { ...context, instances: [{ ...context.instances[0], body: { ...body, faces: [{ ...plane(0), triangleCount: 1 }],
      mesh: { ...body.mesh, positions: new Float32Array([2, 0, 0, 4, 0, 0, 2, 2, 0]), indices: new Uint32Array([0, 1, 2]), triangleCount: 1 } } }] };
    const result = resolveGdtFeature(surface, doc, geometry);
    expect(result?.point).toEqual([0, 0, 0]); expect(result?.paperPoint[0]).toBeCloseTo(100 + 8 / 3, 8);
    // directionは視線方向。+Zを見る図の紙上+Yはモデル-Yになる。
    expect(result?.paperPoint[1]).toBeCloseTo(100 - 2 / 3, 8);
    expect(resolveGdtFeature(surface, doc, { ...geometry, instances: [{ ...geometry.instances[0], body: { ...geometry.instances[0].body,
      mesh: { ...geometry.instances[0].body.mesh, indices: new Uint32Array([0, 1, 999]) } } }] })).toBeNull();
  });
  it('円筒軸の点は面重心ではなく解析軸上点で、二面の中心平面は実幅から解く', () => {
    expect(resolveGdtFeature(axis, document, context)).toMatchObject({ kind: 'axis', point: [20, 0, 0], nominalSizeMm: 10, sizeFeature: true });
    expect(resolveGdtFeature(median, document, context)).toMatchObject({ kind: 'medianPlane', point: [0, 0, 5], direction: [0, 0, 1], nominalSizeMm: 10 });
    expect(resolveGdtFeature({ kind: 'axis', target: faceTarget(plane(0)) }, document, context)).toBeNull();
    expect(resolveGdtFeature({ kind: 'medianPlane', targets: [faceTarget(plane(0)), faceTarget(plane(2, [30, 0, 0], [1, 0, 0]))] }, document, context)).toBeNull();
  });
  it('面の重心が破断で消えても、残った実三角形へ指示点を解き直す', () => {
    const view = { ...document.views[0], direction: [0, 0, -1] as const };
    const face = { ...plane(0, [20 / 3, 20 / 3, 0]), triangleCount: 1 };
    const geometry: DimensionResolveContext = { ...context, viewFrames: new Map([[view.id, { view, modelCenter: [0, 0, 0],
      breakSpec: { axis: 'u', from: 103, to: 115, keepGap: 2 } }]]),
      instances: [{ ...context.instances[0], body: { ...body, faces: [face], mesh: { ...body.mesh,
        positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 20, 0]), indices: new Uint32Array([0, 1, 2]), triangleCount: 1 } } }] };
    const result = resolveGdtFeature({ kind: 'surface', target: faceTarget(face) }, { ...document, views: [view] }, geometry);
    expect(result).not.toBeNull(); expect(result?.paperPoint[0]).toBeLessThanOrEqual(103);
    expect(result?.point).toEqual(face.centroid);
  });
  it('番号変更は指紋で追い、他配置・他sourceの同形体へ逃がさない', () => {
    const changed = { ...context, instances: [{ ...context.instances[0], body: { ...body, faces: [{ ...cylinder, index: 12 }] } }] };
    expect(resolveGdtFeature(axis, document, changed)?.shapeKeys[0]).toContain('12');
    expect(resolveGdtFeature(axis, document, { ...context, instances: [{ ...context.instances[0], componentId: 'other' }] })).toBeNull();
    expect(resolveGdtFeature(axis, { ...document, source: { ...document.source, sourceRef: 'other' } }, context)).toBeNull();
  });
  it('部分円弧は円筒サイズ形体にせず、閉円だけをサイズ形体として扱う', () => {
    expect(resolveGdtFeature({ kind: 'axis', target: edgeTarget(circle) }, document, context)?.sizeFeature).toBe(true);
    const arc = { ...circle, length: 5 * Math.PI, end: [15, 0, 0] as const };
    expect(resolveGdtFeature({ kind: 'axis', target: edgeTarget(arc) }, document,
      { ...context, instances: [{ ...context.instances[0], body: { ...body, edges: [arc] } }] })?.sizeFeature).toBe(false);
  });
  it.each<[ToleranceCharacteristic, ToleranceZone, GdtFeature, boolean]>([
    ['straightness', 'betweenLines', { kind: 'line', target: edgeTarget() }, false], ['flatness', 'betweenPlanes', surface, false],
    ['roundness', 'concentricCircles', { kind: 'surface', target: faceTarget(cylinder) }, false],
    ['cylindricity', 'coaxialCylinders', { kind: 'surface', target: faceTarget(cylinder) }, false],
    ['lineProfile', 'lineProfile', { kind: 'line', target: edgeTarget(circle) }, false], ['surfaceProfile', 'surfaceProfile', surface, false],
    ['parallelism', 'betweenPlanes', surface, true], ['perpendicularity', 'betweenPlanes', surface, true],
    ['angularity', 'betweenPlanes', median, true], ['position', 'cylinder', axis, true], ['coaxiality', 'cylinder', axis, true],
    ['symmetry', 'betweenPlanes', median, true], ['circularRunout', 'radialRunout', { kind: 'surface', target: faceTarget(cylinder) }, true],
    ['totalRunout', 'radialRunout', { kind: 'surface', target: faceTarget(cylinder) }, true],
  ])('%sの合法な対象・公差域・基準を解決する', (characteristic, zone, feature, needsDatum) => {
    const datumFeature: GdtFeature = ['coaxiality', 'circularRunout', 'totalRunout'].includes(characteristic)
      ? { kind: 'axis', target: faceTarget(datumCylinder) } : datum().feature;
    const result = resolve(frame(feature, [segment(characteristic, zone, { datums: needsDatum ? [ref()] : [] })]), [datum('datum-a', datumFeature)]);
    expect(result.issues).toEqual([]); expect(result.segments[0].valueMm).toBe(0.05);
    expect(gdtFrameDisplayRows(result)?.[0].characteristic).toBe(characteristic);
  });
  it('式の保存値を信用せずmm/inchとパラメータを物理的な長さへ再評価する', () => {
    const doc = { ...document, parameters: [{ name: '幅', unit: 'mm' as const, description: '', value: { source: '25.4', value: 999, display: '999' } }] };
    for (const [source, expected] of [['0.01', 0.254], ['幅/100', 0.254], ['0.1mm', 0.1]] as const) {
      const current = segment('flatness', 'betweenPlanes', { tolerance: { expression: { source, value: 999, display: '' }, unit: 'inch' } });
      const result = resolve(frame(surface, [current]), [], doc);
      expect(result.issues).toEqual([]); expect(result.segments[0].valueMm).toBeCloseTo(expected, 12);
    }
  });
  it('ゼロとMMCを許し、JIS B0023第1部8.2の同軸度MMCを誤って拒否しない', () => {
    const current = segment('coaxiality', 'cylinder', { material: 'maximum', datums: [ref()],
      tolerance: { expression: { source: '0', value: 999, display: '' }, unit: 'mm' } });
    const result = resolve(frame(axis, [current]), [datum('datum-a', { kind: 'axis', target: faceTarget(datumCylinder) })]);
    expect(result.issues).toEqual([]);
    expect(gdtFrameDisplayRows(result)?.[0].value).toEqual([{ kind: 'symbol', symbol: 'diameter' }, { kind: 'text', text: '0' }, { kind: 'symbol', symbol: 'maximum' }]);
    expect(resolve(frame(surface, [segment('flatness', 'betweenPlanes', { material: 'maximum' })])).issues.some((issue) => issue.code === 'material')).toBe(true);
  });
  it('基準なし位置度は許すが、形状公差の基準・姿勢公差の基準不足は断る', () => {
    expect(resolve(frame(axis, [segment('position', 'cylinder')])).issues).toEqual([]);
    expect(resolve(frame(surface, [segment('flatness', 'betweenPlanes', { datums: [ref()] })])).issues.some((issue) => issue.code === 'datum')).toBe(true);
    expect(resolve(frame(surface, [segment('perpendicularity', 'betweenPlanes')])).issues.some((issue) => issue.code === 'datum')).toBe(true);
  });
  it('共通基準の1欄と優先順の2欄を保持し、改名は安定IDを保つ', () => {
    const datums = [datum('datum-a', { kind: 'axis', target: faceTarget(cylinder) }), datum('datum-b', { kind: 'axis', target: faceTarget(datumCylinder) }, 'B')];
    const common = segment('perpendicularity', 'betweenPlanes', { datums: [{ kind: 'common', members: [{ datumId: 'datum-a', material: 'none' }, { datumId: 'datum-b', material: 'none' }] }] });
    const a = resolve(frame(surface, [common]), datums);
    expect(a.issues).toEqual([]); expect(a.segments[0].datums).toHaveLength(1); expect(a.segments[0].datums[0]).toHaveLength(2);
    const b = resolve(frame(surface, [{ ...common, datums: [ref('datum-b'), ref()] }]), [{ ...datums[0], label: 'C' }, datums[1]]);
    expect(b.issues).toEqual([]);
    expect(gdtFrameDisplayRows(b)?.[0].datums).toEqual([[{ kind: 'text', text: 'B' }], [{ kind: 'text', text: 'C' }]]);
  });
  it('重複・自己参照・消失したデータムは理由付きで残し、正常な出力用枠を作らない', () => {
    for (const [references, datums] of [[[ref(), ref()], [datum()]], [[ref()], [datum('datum-a', surface)]], [[ref()], []]] as const) {
      const result = resolve(frame(surface, [segment('perpendicularity', 'betweenPlanes', { datums: references })]), [...datums]);
      expect(result.issues.some((issue) => issue.code === 'datum')).toBe(true); expect(gdtFrameDisplayRows(result)).toBeNull();
    }
  });
  it('斜交する基準を共通データムにせず、間接参照した角度も長さの公差に使わない', () => {
    const common = segment('perpendicularity', 'betweenPlanes', { datums: [{ kind: 'common', members: [ref().member, ref('datum-b').member] }] });
    const result = resolve(frame(surface, [common]), [datum(), datum('datum-b', { kind: 'surface', target: faceTarget(plane(1)) }, 'B')]);
    expect(result.issues.some((issue) => issue.code === 'datum')).toBe(true);
    const doc = { ...document, parameters: [
      { name: '角度', unit: 'degree' as const, description: '', value: { source: '30', value: 30, display: '30' } },
      { name: '間接', unit: 'none' as const, description: '', value: { source: '角度/100', value: 0.3, display: '0.3' } },
    ] };
    const invalid = resolve(frame(surface, [segment('flatness', 'betweenPlanes', { tolerance: { expression: { source: '間接', value: 0.3, display: '0.3' }, unit: 'mm' } })]), [], doc);
    expect(invalid.issues.some((issue) => issue.code === 'unit')).toBe(true);
  });
  it.each(['-0.1', '0', '1/0', '未知', 'sqrt(-1)'])('不正な公差値%sを製作指示へ渡さない', (source) => {
    const result = resolve(frame(surface, [segment('flatness', 'betweenPlanes', { tolerance: { expression: { source, value: 1, display: '' }, unit: 'mm' } })]));
    expect(result.issues.some((issue) => issue.code === 'value')).toBe(true); expect(gdtFrameDisplayRows(result)).toBeNull();
  });
  it('複数段の意味・値・順序を保持し、1段だけ不正でも枠全体の正常出力を止める', () => {
    const current = frame(axis, [segment('position', 'cylinder', { datums: [ref()] }), segment('straightness', 'cylinder')]);
    const result = resolve(current); expect(result.issues).toEqual([]); expect(result.segments.map((row) => row.segment.characteristic)).toEqual(['position', 'straightness']);
    const invalid = resolve({ ...current, segments: [current.segments[0], { ...current.segments[1], datums: [ref()] }] });
    expect(invalid.issues).toContainEqual(expect.objectContaining({ segmentIndex: 1, code: 'datum' })); expect(gdtFrameDisplayRows(invalid)).toBeNull();
  });
});
