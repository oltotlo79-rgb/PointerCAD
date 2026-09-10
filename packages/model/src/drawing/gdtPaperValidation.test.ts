import { describe, expect, it } from 'vitest';
import type { Dimension, DrawingDocument, GdtShapeTarget } from '@pointercad/drawing';
import { IDENTITY_PLACEMENT } from '../assembly/placementMath.js';
import type { SolidBody, SolidEdgeEntry } from '../kernelBridge.js';
import { createDrawingDocument } from './createDrawingDocument.js';
import type { DimensionResolveContext } from './dimensionTarget.js';
import { resolveDrawingGdt } from './gdtValidation.js';

const edges: readonly SolidEdgeEntry[] = [
  { index: 0, curveKind: 'line', length: 20, midpoint: [10, 0, 0], start: [0, 0, 0], end: [20, 0, 0], axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 0 },
  { index: 1, curveKind: 'line', length: Math.sqrt(800), midpoint: [10, 10, 0], start: [0, 0, 0], end: [20, 20, 0], axis: [Math.SQRT1_2, Math.SQRT1_2, 0], radius: null, segmentOffset: 0, segmentCount: 0 },
];
const body: SolidBody = { featureId: 'body', mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
  edgePositions: new Float32Array(), triangleCount: 0 }, volume: 1000, isValid: true, bodyKind: 'solid', faces: [], edges, vertices: [], threadMarks: [] };
const target = (index: number): GdtShapeTarget => ({ kind: 'subShape', sourceRef: 'source', viewId: 'view', ref: { bodyFeatureId: 'body', index,
  fingerprint: { kind: 'edge', curveKind: 'line', length: edges[index].length, position: edges[index].midpoint, axis: edges[index].axis, radius: null } } });
const angle: Dimension = { id: 'angle', kind: 'angle', measurement: 'angle', targets: [target(0), target(1)],
  placement: { commonNormalCoordinate: 120, textPosition: null }, origin: 'manual', reference: false, basic: true, layerId: 'layer-4' };
const document: DrawingDocument = { ...createDrawingDocument('傾斜度図', { sourceRef: 'source', sourceKind: 'part', path: '', fileName: 'part.pcad', contentHash: '', importedAt: '' }),
  views: [{ id: 'view', name: '正面', kind: 'front', direction: [0, 0, 1], xDir: [1, 0, 0], position: [100, 100], scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' }],
  dimensions: [angle], datums: [{ id: 'datum-a', label: 'A', feature: { kind: 'line', target: target(0) }, position: [80, 70], height: 3.5, layerId: 'layer-5' }],
  gdtFrames: [{ id: 'frame', feature: { kind: 'line', target: target(1) }, position: [130, 130], height: 3.5, layerId: 'layer-5', segments: [
    { characteristic: 'angularity', zone: 'betweenLines', material: 'none', basicDimensionIds: ['angle'], tolerance: { expression: { source: '0.05', value: 0.05, display: '0.05' }, unit: 'mm' },
      datums: [{ kind: 'single', member: { datumId: 'datum-a', material: 'none' } }] },
  ] }] };
const context: DimensionResolveContext = { modelCenter: [0, 0, 0], instances: [{ sourceRef: 'source', bodyId: 'worker', body, placement: IDENTITY_PLACEMENT }] };

describe('紙面に必要な理論的に正確な寸法の参照', () => {
  it('実線2本の45度の基本寸法と基準を持つ傾斜度を解決する', () => {
    expect(resolveDrawingGdt(document, context).frames[0].issues).toEqual([]);
  });
  it('角度の指定を持たない傾斜度は公差幅だけで出力させない', () => {
    const frame = document.gdtFrames[0];
    const current = { ...document, gdtFrames: [{ ...frame, segments: [{ ...frame.segments[0], basicDimensionIds: [] }] }] };
    expect(resolveDrawingGdt(current, context).frames[0].issues).toContainEqual(expect.objectContaining({ code: 'basicDimension' }));
  });
  it('単なる長さ寸法を傾斜度の角度指定に流用しない', () => {
    const length: Dimension = { ...angle, kind: 'length', measurement: 'trueDistance', targets: [target(0)] };
    expect(resolveDrawingGdt({ ...document, dimensions: [length] }, context).frames[0].issues).toContainEqual(expect.objectContaining({ code: 'basicDimension' }));
  });
  it('寸法自体の参照が壊れたら、角度の基本寸法フラグだけで成功させない', () => {
    const broken: Dimension = { ...angle, targets: [{ ...target(0), sourceRef: 'lost' }, target(1)] };
    expect(resolveDrawingGdt({ ...document, dimensions: [broken] }, context).frames[0].issues).toContainEqual(expect.objectContaining({ code: 'basicDimension' }));
  });
});
