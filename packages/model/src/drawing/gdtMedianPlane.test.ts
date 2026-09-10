import { describe, expect, it } from 'vitest';
import type { Dimension, GdtShapeTarget, Vector3 } from '@pointercad/drawing';
import { IDENTITY_PLACEMENT } from '../assembly/placementMath.js';
import type { SolidBody, SolidEdgeEntry, SolidFaceEntry } from '../kernelBridge.js';
import { createDrawingDocument } from './createDrawingDocument.js';
import { compatibleGdtSizeDimensions } from './gdtAttachment.js';
import { drawingMedianPlaneFeature } from './gdtMedianPlane.js';
import { resolveGdtFeature } from './gdt.js';

function fixture() {
  const positions: number[] = [], indices: number[] = [], faces: SolidFaceEntry[] = [];
  function addFace(points: readonly Vector3[], centroid: Vector3, axis: Vector3): void {
    const offset = positions.length / 3, triangleOffset = indices.length / 3;
    positions.push(...points.flat()); indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    faces.push({ index: faces.length, surfaceKind: 'plane', area: 80, centroid, axis, radius: null, triangleOffset, triangleCount: 2 });
  }
  addFace([[-10, -5, 0], [10, -5, 0], [10, 5, 0], [-10, 5, 0]], [0, 0, 0], [0, 0, 1]);
  for (const x of [-10, 10]) addFace([[x, -5, -4], [x, 5, -4], [x, 5, 4], [x, -5, 4]], [x, 0, 0], [1, 0, 0]);
  // 同一無限平面にあるが、この辺とは無関係な別領域。
  addFace([[-10, 100, -4], [-10, 110, -4], [-10, 110, 4], [-10, 100, 4]], [-10, 105, 0], [1, 0, 0]);
  const edges: SolidEdgeEntry[] = [-10, 10].map((x, index) => ({ index, curveKind: 'line', length: 10,
    start: [x, -5, 0], end: [x, 5, 0], midpoint: [x, 0, 0], axis: null, radius: null, segmentOffset: 0, segmentCount: 1 }));
  const body: SolidBody = { featureId: 'box', mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices),
    normals: new Float32Array(), edgePositions: new Float32Array(), triangleCount: indices.length / 3 }, faces, edges, vertices: [],
    volume: 1600, isValid: true, bodyKind: 'solid', threadMarks: [] };
  const targets: readonly GdtShapeTarget[] = edges.map((edge) => ({ kind: 'subShape', sourceRef: 'source', viewId: 'front',
    ref: { bodyFeatureId: 'box', index: edge.index, fingerprint: { kind: 'edge', curveKind: 'line', length: edge.length,
      position: edge.midpoint, axis: null, radius: null } } }));
  const size: Dimension = { id: 'width', kind: 'length', measurement: 'trueDistance', targets,
    placement: { commonNormalCoordinate: 120, textPosition: null }, origin: 'manual', reference: false, layerId: 'layer-4' };
  const document = { ...createDrawingDocument('二面幅', { sourceRef: 'source', sourceKind: 'part', path: '', fileName: 'box.pcad', contentHash: '', importedAt: '' }),
    views: [{ id: 'front', name: '正面', kind: 'front' as const, position: [100, 100] as const, direction: [0, 0, 1] as const,
      xDir: [1, 0, 0] as const, scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' }], dimensions: [size] };
  const context = { modelCenter: [0, 0, 0] as Vector3, instances: [{ sourceRef: 'source', bodyId: 'worker', body, placement: IDENTITY_PLACEMENT }] };
  return { targets, document, context, body, faces, size };
}

describe('二面幅を示す投影辺から実二面を選ぶ', () => {
  it('表の共通面や離れた同一平面を除き、左右の実面と幅寸法を関連付ける', () => {
    const { targets, document, context } = fixture();
    const feature = drawingMedianPlaneFeature(targets, document, context);
    expect(feature?.targets.map((target) => target.ref.index)).toEqual([1, 2]);
    if (feature === null) throw new Error('二面なし');
    expect(resolveGdtFeature(feature, document, context)).toMatchObject({ kind: 'medianPlane', point: [0, 0, 0], nominalSizeMm: 20 });
    expect(compatibleGdtSizeDimensions(feature, document, context).map((item) => item.dimension.id)).toEqual(['width']);
    expect(drawingMedianPlaneFeature([...targets].reverse(), document, context)?.targets.map((target) => target.ref.index)).toEqual([2, 1]);
  });
  it('同値でも無関係な幅寸法・基本寸法・参考寸法はサイズ寸法にしない', () => {
    const { targets, document, context, size } = fixture(); const feature = drawingMedianPlaneFeature(targets, document, context);
    if (feature === null) throw new Error('二面なし');
    const other: Dimension = { ...size, id: 'other', targets: [{ kind: 'point', viewId: 'front', paperPoint: [0, 0], modelPoint: [0, 0, 0] },
      { kind: 'point', viewId: 'front', paperPoint: [20, 0], modelPoint: [20, 0, 0] }] };
    for (const candidate of [other, { ...size, basic: true }, { ...size, reference: true }]) {
      expect(compatibleGdtSizeDimensions(feature, { ...document, dimensions: [candidate] }, context)).toEqual([]);
    }
  });
  it('別図・別配置・重複配置・違う部品・同じ辺を混ぜて推測しない', () => {
    const { targets, document, context } = fixture();
    for (const second of [{ ...targets[1], viewId: 'other' }, { ...targets[1], componentId: 'other' },
      { ...targets[1], sourceRef: 'other' }, targets[0]]) expect(drawingMedianPlaneFeature([targets[0], second], document, context)).toBeNull();
    expect(drawingMedianPlaneFeature(targets, document, { ...context, instances: [...context.instances, ...context.instances] })).toBeNull();
  });
  it('2組の候補がある面分割は勝手に選ばず、直接面を選んだときだけ確定できる', () => {
    const { targets, document, context, body, faces } = fixture();
    const geometry = { ...context, instances: [{ ...context.instances[0], body: { ...body, faces: [...faces, { ...faces[1], index: 4 }] } }] };
    expect(drawingMedianPlaneFeature(targets, document, geometry)).toBeNull();
    const feature = drawingMedianPlaneFeature(targets, document, context);
    if (feature === null) throw new Error('二面なし');
    expect(drawingMedianPlaneFeature(feature.targets, document, geometry)?.targets.map((target) => target.ref.index)).toEqual([1, 2]);
  });
  it('壊れた三角形・解析面だけの仮データから接続面を捏造しない', () => {
    const { targets, document, context, body } = fixture();
    for (const indices of [new Uint32Array(), new Uint32Array(body.mesh.indices.length).fill(999)]) {
      expect(drawingMedianPlaneFeature(targets, document, { ...context, instances: [{ ...context.instances[0],
        body: { ...body, mesh: { ...body.mesh, indices } } }] })).toBeNull();
    }
  });
});
