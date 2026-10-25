import { describe, expect, it, vi } from 'vitest';
import type { Dimension, DimensionTarget, DrawingDocument, DrawingView, Vector3 } from '@pointercad/drawing';
import { createDrawingDocument } from './createDrawingDocument.js';
import { drawingTargetFromProjection, resolveDimensionTarget, resolveDrawingAnnotationTarget, resolveDrawingDimensions, type DrawingDimensionInstance } from './dimensionTarget.js';
import { IDENTITY_PLACEMENT } from '../assembly/placementMath.js';
import * as bridge from '../kernelBridge.js';
import type { SolidBody, SolidEdgeEntry } from '../kernelBridge.js';
import { scoreSubShapeMatch } from '../kernelBridge/subShapeMatching.js';

const view: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: null,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'outlines' };
const source = { sourceRef: 'source', sourceKind: 'part' as const, fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: '' };
function edge(to: Vector3 = [20, 0, 0], patch: Partial<SolidEdgeEntry> = {}): SolidEdgeEntry {
  return { index: 0, curveKind: 'line', length: Math.hypot(...to), midpoint: [to[0] / 2, to[1] / 2, to[2] / 2],
    start: [0, 0, 0], end: to, axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 1, ...patch };
}
function body(edges: readonly SolidEdgeEntry[] = [edge()], patch: Partial<SolidBody> = {}): SolidBody {
  return { featureId: 'body', mesh: { positions: new Float32Array([-50, -50, -50, 50, 50, 50]),
    normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
    volume: 1, isValid: true, bodyKind: 'solid', edges, faces: [], vertices: [], threadMarks: [], ...patch };
}
function instance(current = body(), patch: Partial<DrawingDimensionInstance> = {}): DrawingDimensionInstance {
  return { sourceRef: 'source', bodyId: 'worker-body', body: current, placement: IDENTITY_PLACEMENT, ...patch };
}
function target(current = edge()): DimensionTarget {
  return { kind: 'subShape', sourceRef: 'source', viewId: 'front', ref: { bodyFeatureId: 'body', index: current.index,
    fingerprint: { kind: 'edge', curveKind: current.curveKind, length: current.length, position: current.midpoint, axis: current.axis, radius: current.radius } } };
}
function dimension(targets: readonly DimensionTarget[] = [target()], patch: Partial<Dimension> = {}): Dimension {
  return { id: 'dim-1', kind: 'length', measurement: 'trueDistance', targets, placement: { commonNormalCoordinate: 10, textPosition: null },
    reference: false, origin: 'manual', layerId: 'dimensions', ...patch };
}
function document(dimensions: readonly Dimension[] = [dimension()], patch: Partial<DrawingDocument> = {}): DrawingDocument {
  return { ...createDrawingDocument('図面', source), views: [view], dimensions, ...patch };
}
const resolve = (doc = document(), instances = [instance()]) => resolveDrawingDimensions(doc, { instances, modelCenter: [0, 0, 0] });

describe('元の3D形状から解決する寸法(P8-25)', () => {
  it('理論的に正確な寸法は通常値を測り、公差・はめあい・参考括弧との混在は未解決にする', () => {
    expect(resolve(document([dimension(undefined, { basic: true })]))[0]).toMatchObject({ status: 'resolved', value: 20 });
    for (const conflict of [{ reference: true }, { tolerance: { kind: 'symmetric' as const, value: 0.1 } }, { fit: { symbol: 'H7', showDeviation: true } }]) {
      expect(resolve(document([dimension(undefined, { basic: true, ...conflict })]))[0].status).toBe('unresolved');
    }
  });
  it('箱の20mmの辺を20として解く', () => expect(resolve()[0]).toMatchObject({ status: 'resolved', value: 20, text: '20' }));
  it('視線方向へ傾いた30×40の辺は紙上30でも実距離50', () => {
    const current = edge([30, 40, 0]);
    expect(resolve(document([dimension([target(current)])]), [instance(body([current]))])[0]).toMatchObject({ value: 50,
      targets: [{ kind: 'line', paperFrom: [100, 100], paperTo: [130, 100] }] });
  });
  it('正面に平行な30×40の辺は実距離も投影長も50', () => {
    const current = edge([30, 0, 40]);
    const result = resolve(document([dimension([target(current)])]), [instance(body([current]))])[0];
    expect(result.value).toBe(50);
    expect(result.targets[0]).toMatchObject({ paperFrom: [100, 100], paperTo: [130, 140] });
  });
  it.each([['horizontal', 30], ['vertical', 40]] as const)('%sは図の基底成分%sを返す', (measurement, expected) => {
    const current = edge([30, 12, 40]);
    expect(resolve(document([dimension([target(current)], { measurement })]), [instance(body([current]))])[0].value).toBe(expected);
  });
  it('縮尺と図の位置を変えても値は20のまま', () => {
    expect(resolve(document(undefined, { views: [{ ...view, scale: 0.5, position: [10, 20] }] }))[0]).toMatchObject({ value: 20,
      targets: [{ paperFrom: [10, 20], paperTo: [20, 20] }] });
  });
  it('座標寸法は3D長さでなく図の符号付きX/Y成分を返す', () => {
    const current = edge([-30, 12, 40]);
    const result = resolve(document([dimension([target(current)], { kind: 'coordinate', measurement: 'coordinate' })]), [instance(body([current]))])[0];
    expect(result).toMatchObject({ status: 'resolved', value: null, coordinates: [-30, 40], text: 'X: -30 / Y: 40' });
  });
  it('座標寸法の各成分にも許容差を評価し、前後文字・参考括弧を保つ', () => {
    const current = edge([-30, 12, 40]);
    const result = resolve(document([dimension([target(current)], { kind: 'coordinate', measurement: 'coordinate',
      tolerance: { kind: 'symmetric', value: 0.1 }, prefix: '位置 ', suffix: ' mm', reference: true })]), [instance(body([current]))])[0];
    expect(result).toMatchObject({ status: 'resolved', coordinates: [-30, 40], text: '(位置 X: -30±0.1 / Y: 40±0.1 mm)' });
    const invalid = resolve(document([dimension([target(current)], { kind: 'coordinate', measurement: 'coordinate',
      tolerance: { kind: 'symmetric', value: -0.1 } })]), [instance(body([current]))])[0];
    expect(invalid.status).toBe('unresolved');
  });
  it('球面の重心と異なる解析中心から球径を得る', () => {
    const face = { index: 0, surfaceKind: 'sphere' as const, area: 200 * Math.PI, centroid: [12, -8, 35] as const,
      axis: null, axisOrigin: [12, -8, 30] as const, radius: 10, triangleOffset: 0, triangleCount: 0 };
    const sphere: DimensionTarget = { kind: 'subShape', sourceRef: 'source', viewId: 'front', ref: { bodyFeatureId: 'body', index: 0,
      fingerprint: { kind: 'face', surfaceKind: 'sphere', area: face.area, position: face.centroid, axis: null, radius: 10 } } };
    expect(resolve(document([dimension([sphere], { kind: 'sphereDiameter', measurement: 'radius' })]), [instance(body([], { faces: [face] }))])[0])
      .toMatchObject({ value: 20, text: 'Sφ20', targets: [{ center: [12, -8, 30] }] });
  });
  it('辺が残る編集では保存済みの値を表示せず現在の25を測る', () => {
    expect(resolve(document(), [instance(body([edge([25, 0, 0])]))])[0].value).toBe(25);
  });
  it('辺の番号が変わっても指紋照合で同じ辺へ追従する', () => {
    expect(resolve(document(), [instance(body([edge([20, 0, 0], { index: 9 })]))])[0].value).toBe(20);
  });
  it.each([[0, 1], [1, 0]])('同点の10mmと40mmの候補（番号%s/%s）を正常寸法へ採用しない', (shortIndex, longIndex) => {
    const original = target(edge([20, 0, 0], { index: 99, midpoint: [0, 0, 0] }));
    if (original.kind !== 'subShape') throw new Error('対象が違います');
    const short = edge([5, -2, 0], { index: shortIndex, length: 10, midpoint: [0, -2, 0], start: [-5, -2, 0] });
    const long = edge([20, 2, 0], { index: longIndex, length: 40, midpoint: [0, 2, 0], start: [-20, 2, 0] });
    const current = body([short, long]);
    expect(scoreSubShapeMatch(current, original.ref)).toMatchObject({ score: 0.670381197846483, runnerUpScore: 0.670381197846483 });
    const doc = document([dimension([original])]);
    const saved = JSON.stringify(doc);
    const result = resolve(doc, [instance(current)])[0];
    expect(result).toMatchObject({ status: 'unresolved', value: null, text: '？', reason: 'target' });
    expect(result.dimension).toBe(doc.dimensions[0]);
    expect(JSON.stringify(doc)).toBe(saved);
    const context = { instances: [instance(current)], modelCenter: [0, 0, 0] as const };
    expect(resolveDimensionTarget(original, doc, context)).toBeNull();
    expect(resolveDrawingAnnotationTarget(original, doc, context)).toBeNull();
    expect(resolve(doc, [instance(body([long, short]))])[0].status).toBe('unresolved');
    // 利用者が現在の辺を明示して記入し直した参照は、選んだ実長を測れる。
    for (const chosen of [short, long]) expect(resolve(document([dimension([target(chosen)])]), [instance(current)])[0].value).toBe(chosen.length);
  });
  it.each(['plane', 'cylinder'] as const)('同点の%s面を寸法にも注記にも採用しない', (surfaceKind) => {
    const faces = [-2, 2].map((y, index) => ({ index, surfaceKind, area: 20, centroid: [0, y, 0] as const,
      axis: [0, 0, 1] as const, radius: surfaceKind === 'cylinder' ? 2 : null, triangleOffset: 0, triangleCount: 0 }));
    const original: DimensionTarget = { kind: 'subShape', sourceRef: 'source', viewId: 'front', ref: {
      bodyFeatureId: 'body', index: 99, fingerprint: { kind: 'face', surfaceKind, area: 20, position: [0, 0, 0],
        axis: [0, 0, 1], radius: faces[0].radius },
    } };
    const doc = document([dimension([original])]), saved = JSON.stringify(doc);
    for (const ordered of [faces, [...faces].reverse()]) {
      const context = { instances: [instance(body([], { faces: ordered }))], modelCenter: [0, 0, 0] as const };
      expect(resolveDimensionTarget(original, doc, context)).toBeNull();
      expect(resolveDrawingAnnotationTarget(original, doc, context)).toBeNull();
      expect(resolveDrawingDimensions(doc, context)[0]).toMatchObject({ status: 'unresolved', value: null, reason: 'target' });
    }
    expect(JSON.stringify(doc)).toBe(saved);
    // 一意な現在の曲面は注記の引出点として使える。
    expect(resolveDrawingAnnotationTarget(original, doc, { instances: [instance(body([], { faces: [faces[0]] }))], modelCenter: [0, 0, 0] })).toEqual([100, 100]);
  });
  it('同点で頂点番号が重複した表では寸法・注記の指示点を推測しない', () => {
    const original: DimensionTarget = { kind: 'subShape', sourceRef: 'source', viewId: 'front', ref: {
      bodyFeatureId: 'body', index: 0, fingerprint: { kind: 'vertex', position: [0, 0, 0] },
    } };
    const doc = document([dimension([original])]), saved = JSON.stringify(doc);
    const vertices = [-2, 2].map(y => ({ index: 0, position: [0, y, 0] as const }));
    for (const ordered of [vertices, [...vertices].reverse()]) {
      const context = { instances: [instance(body([], { vertices: ordered }))], modelCenter: [0, 0, 0] as const };
      expect(resolveDimensionTarget(original, doc, context)).toBeNull();
      expect(resolveDrawingAnnotationTarget(original, doc, context)).toBeNull();
    }
    expect(JSON.stringify(doc)).toBe(saved);
  });
  it('消えた辺の寸法を残し、0でなく？を表示する', () => {
    const doc = document();
    const result = resolve(doc, [instance(body([]))])[0];
    expect(result).toMatchObject({ value: null, text: '？', status: 'unresolved', reason: 'target' });
    expect(result.dimension).toBe(doc.dimensions[0]);
  });
  it('別の部品に同じfeatureIdがあっても付け替えない', () => {
    const original = target();
    if (original.kind !== 'subShape') throw new Error('対象が違います');
    const doc = document([dimension([{ ...original, componentId: 'A' }])]);
    expect(resolve(doc, [instance(body(), { componentId: 'B' })])[0].status).toBe('unresolved');
  });
  it('部品配置の回転を一度だけ掛けて水平/垂直成分を測る', () => {
    const original = target();
    if (original.kind !== 'subShape') throw new Error('対象が違います');
    const doc = document([dimension([{ ...original, componentId: 'A' }], { measurement: 'vertical' })]);
    const placed = instance(body(), { componentId: 'A', placement: { position: [30, 0, 40], rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2] } });
    const result = resolve(doc, [placed])[0];
    expect(result.value).toBeCloseTo(20, 10);
    expect(result.targets[0]).toMatchObject({ paperFrom: [130, 140] });
  });
  it.each([['diameter', 16], ['radius', 8]] as const)('φ16の円を%sで%sと測る', (kind, expected) => {
    const round = edge([8, 0, 0], { curveKind: 'circle', start: [8, 0, 0], length: 16 * Math.PI, radius: 8, axis: [0, 1, 0], axisOrigin: [0, 0, 0] });
    expect(resolve(document([dimension([target(round)], { kind, measurement: 'radius' })]), [instance(body([round]))])[0].value).toBe(expected);
  });
  it('2平面のなす角は90°', () => {
    const faces = [
      { index: 0, surfaceKind: 'plane' as const, area: 400, centroid: [0, 0, 0] as const, axis: [1, 0, 0] as const, radius: null, triangleOffset: 0, triangleCount: 0 },
      { index: 1, surfaceKind: 'plane' as const, area: 400, centroid: [0, 0, 0] as const, axis: [0, 0, 1] as const, radius: null, triangleOffset: 0, triangleCount: 0 },
    ];
    const targets: DimensionTarget[] = faces.map((face) => ({ kind: 'subShape', sourceRef: 'source', viewId: 'front', ref: { bodyFeatureId: 'body', index: face.index,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 400, position: face.centroid, axis: face.axis, radius: null } } }));
    expect(resolve(document([dimension(targets, { kind: 'angle', measurement: 'angle' })]), [instance(body([], { faces }))])[0].value).toBe(90);
  });
  it('同じ参照を持つ100寸法は1回の照合結果を共有する', () => {
    const spy = vi.spyOn(bridge, 'resolveSubShapeReference');
    try {
      const result = resolve(document(Array.from({ length: 100 }, (_, index) => dimension(undefined, { id: `dim-${index}` }))));
      expect(result.every((item) => item.value === 20)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  it('紙面だけの2点から縮尺で割った偽の寸法を作らない', () => {
    const targets: DimensionTarget[] = [{ kind: 'point', viewId: 'front', paperPoint: [0, 0] }, { kind: 'point', viewId: 'front', paperPoint: [10, 0] }];
    expect(resolve(document([dimension(targets)]))[0].status).toBe('unresolved');
  });
  it('元文書を書き換えず同じ結果を返す', () => {
    const doc = document(); const snapshot = JSON.stringify(doc);
    expect(resolve(doc)).toEqual(resolve(doc));
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
  it('HLRの確定した由来から現在の辺の指紋を保存する', () => {
    const projected = { curve: { kind: 'segment' as const, from: [0, 0] as const, to: [20, 0] as const },
      provenance: { kind: 'edge', bodyId: 'worker-body', occurrenceId: null, edgeIndex: 0, parameterRange: [0, 20], dimensionTarget: true } };
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance()])).toEqual(target());
    expect(drawingTargetFromProjection({ ...projected, provenance: { ...projected.provenance, dimensionTarget: false } }, 'front', 'source', [instance()])).toBeNull();
    expect(drawingTargetFromProjection({ ...projected, provenance: { ...projected.provenance, kind: 'silhouette' } }, 'front', 'source', [instance()])).toBeNull();
  });
  it('同じ画面位置の別occurrenceへ由来を付け替えない', () => {
    const projected = { curve: { kind: 'segment' as const, from: [0, 0] as const, to: [20, 0] as const },
      provenance: { kind: 'edge', bodyId: 'worker-body', occurrenceId: 'A', edgeIndex: 0, parameterRange: [0, 20], dimensionTarget: true } };
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance(body(), { componentId: 'B' })])).toBeNull();
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance(body(), { componentId: 'A' })])).toMatchObject({ componentId: 'A' });
  });
  it.each(['legacy', 'imported'] as const)('履歴のない%sの失効bodyから保存参照を作らない', reason => {
    const projected = { curve: { kind: 'segment' as const, from: [0, 0] as const, to: [20, 0] as const },
      provenance: { kind: 'edge', bodyId: 'worker-body', occurrenceId: null, edgeIndex: 0, parameterRange: [0, 20], dimensionTarget: true } };
    const current = body([edge()], { isValid: false, origins: { version: 1, state: 'untracked', reason } });
    const before = JSON.stringify(current);
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance(current)])).toBeNull();
    expect(JSON.stringify(current)).toBe(before);
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance({ ...current, isValid: true })])).toEqual(target());
  });
  it.each([false, true])('履歴のない輸入bodyの重複辺番号を列挙順%sで選ばない', reverse => {
    const projected = { curve: { kind: 'segment' as const, from: [0, 0] as const, to: [20, 0] as const },
      provenance: { kind: 'edge', bodyId: 'worker-body', occurrenceId: null, edgeIndex: 0, parameterRange: [0, 20], dimensionTarget: true } };
    const edges = [edge(), edge([30, 0, 0])];
    const current = body(reverse ? [...edges].reverse() : edges,
      { origins: { version: 1, state: 'untracked', reason: 'imported' } });
    const before = JSON.stringify(current);
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance(current)])).toBeNull();
    expect(JSON.stringify(current)).toBe(before);
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance(body([edges[0]],
      { origins: current.origins }))])).toEqual(target());
  });
  it('HLRの現辺の意味起点を保存し、番号と寸法が変わっても元参照で同じ辺を解く', () => {
    const origin = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'body', role: 'bottom-front' } } as const;
    const projected = { curve: { kind: 'segment' as const, from: [0, 0] as const, to: [20, 0] as const },
      provenance: { kind: 'edge', bodyId: 'worker-body', occurrenceId: null, edgeIndex: 0, parameterRange: [0, 20], dimensionTarget: true } };
    const current = body([edge()], { origins: { version: 1, state: 'tracked', bindings: [
      { origin, state: 'unique', current: { kind: 'edge', index: 0 } },
    ] } });
    const picked = drawingTargetFromProjection(projected, 'front', 'source', [instance(current)]);
    expect(picked).toMatchObject({ kind: 'subShape', ref: { index: 0, origin } });
    if (picked?.kind !== 'subShape') throw new Error('意味参照がない');
    const saved = JSON.stringify(picked);
    const replacement = body([edge([25, 0, 0], { index: 7 })], { origins: { version: 1, state: 'tracked', bindings: [
      { origin, state: 'unique', current: { kind: 'edge', index: 7 } },
    ] } });
    expect(resolveDimensionTarget(picked, document([dimension([picked])]),
      { instances: [instance(replacement)], modelCenter: [0, 0, 0] })).toMatchObject({ kind: 'line', length: 25 });
    expect(JSON.stringify(picked)).toBe(saved);
  });
  it('trackedのsplit・merged・重複claim・失効辺は裸のHLR参照へ戻さない', () => {
    const origin = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'body', role: 'bottom-front' } } as const;
    const address = { kind: 'edge', index: 0 } as const;
    const unique = { origin, state: 'unique', current: address } as const;
    const projected = { curve: { kind: 'segment' as const, from: [0, 0] as const, to: [20, 0] as const },
      provenance: { kind: 'edge', bodyId: 'worker-body', occurrenceId: null, edgeIndex: 0, parameterRange: [0, 20], dimensionTarget: true } };
    const failures: readonly SolidBody[] = [
      body([edge()], { origins: { version: 1, state: 'tracked', bindings: [
        { origin, state: 'split', candidates: [address, { kind: 'edge', index: 1 }] },
      ] } }),
      body([edge()], { origins: { version: 1, state: 'tracked', bindings: [
        { origin, state: 'merged', current: address, coOrigins: [origin, origin] },
      ] } }),
      body([edge()], { origins: { version: 1, state: 'tracked', bindings: [unique, unique] } }),
      body([edge()], { isValid: false, origins: { version: 1, state: 'tracked', bindings: [unique] } }),
    ];
    for (const current of failures) expect(drawingTargetFromProjection(projected, 'front', 'source', [instance(current)])).toBeNull();
    expect(drawingTargetFromProjection(projected, 'front', 'source', [instance(body())])).toEqual(target());
  });
});
