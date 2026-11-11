import { describe, expect, it } from 'vitest';
import type { DrawingDocument, DrawingView } from '@pointercad/drawing';
import { createDrawingDocument, IDENTITY_PLACEMENT,
  type DrawingSourceResolution, type ResolvedDrawingView, type SolidBody } from '@pointercad/model';
import { pickDrawingFace, pickDrawingGeometry } from './drawingPick.js';

const metadata = { sourceRef: 'source', sourceKind: 'part' as const, fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '' };
const drawingView: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: 1,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const document: DrawingDocument = { ...createDrawingDocument('図面', metadata), views: [drawingView] };
const edgeOrigin = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'box', role: 'bottom-front' } } as const;
const vertexOrigin = { version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId: 'box', role: 'bottom-front-left' } } as const;
const faceOrigin = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box', role: 'top' } } as const;

const edgeBody: SolidBody = {
  featureId: 'box', isValid: true, volume: 1, bodyKind: 'solid', threadMarks: [], faces: [],
  mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
    edgePositions: new Float32Array(), triangleCount: 0 },
  edges: [{ index: 0, curveKind: 'line', length: 20, midpoint: [10, 0, 0], start: [0, 0, 0], end: [20, 0, 0],
    axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 1 }],
  vertices: [{ index: 0, position: [0, 0, 0] }, { index: 1, position: [20, 0, 0] }],
  origins: { version: 1, state: 'tracked', bindings: [
    { origin: edgeOrigin, state: 'unique', current: { kind: 'edge', index: 0 } },
    { origin: vertexOrigin, state: 'unique', current: { kind: 'vertex', index: 0 } },
  ] },
};
function source(body: SolidBody = edgeBody, sourceRef = 'source'): DrawingSourceResolution {
  return { bodyIds: ['worker'], center: [0, 0, 0], dimensionInstances: [
    { sourceRef, bodyId: 'worker', body, placement: IDENTITY_PLACEMENT },
  ] };
}
const segment: ResolvedDrawingView = { viewId: 'front', name: '正面', position: [100, 100], scale: 1,
  visible: [{ curve: { kind: 'segment', from: [100, 100], to: [120, 100] },
    provenance: { kind: 'edge', dimensionTarget: true, bodyId: 'worker', edgeIndex: 0, occurrenceId: null, parameterRange: [0, 20] } }],
  hidden: [], cuttingCurves: [] };

describe('図面ピックの現body意味参照', () => {
  it('線端の頂点は元edgeの起点でなく同instanceの現vertex起点を保存する', () => {
    const picked = pickDrawingGeometry(document, source(), [segment], [100, 100], 1);
    expect(picked).toMatchObject({ kind: 'subShape', ref: { index: 0, origin: vertexOrigin,
      fingerprint: { kind: 'vertex' } } });
    const ambiguous: SolidBody = { ...edgeBody, origins: { version: 1, state: 'tracked', bindings: [
      { origin: edgeOrigin, state: 'unique', current: { kind: 'edge', index: 0 } },
      { origin: vertexOrigin, state: 'split', candidates: [{ kind: 'vertex', index: 0 }, { kind: 'vertex', index: 9 }] },
    ] } };
    expect(pickDrawingGeometry(document, source(ambiguous), [segment], [100, 100], 1))
      .toMatchObject({ kind: 'subShape', ref: { origin: edgeOrigin, fingerprint: { kind: 'edge' } } });
    const legacy = { ...edgeBody, origins: undefined };
    expect(pickDrawingGeometry(document, source(legacy), [segment], [100, 100], 1))
      .toMatchObject({ kind: 'subShape', ref: { fingerprint: { kind: 'vertex' } } });
    const duplicate = source();
    const first = duplicate.dimensionInstances?.[0];
    if (first === undefined) throw new Error('instanceなし');
    expect(pickDrawingGeometry(document, { ...duplicate, dimensionInstances: [first, { ...first, bodyId: 'other-worker' }] },
      [segment], [100, 100], 1)).toMatchObject({ kind: 'subShape', ref: { fingerprint: { kind: 'edge' } } });
  });

  it('実meshのface自身の起点だけを採り、追跡不明と重複instanceを採らない', () => {
    const faceView: DrawingView = { ...drawingView, direction: [0, 0, -1] };
    const faceDocument: DrawingDocument = { ...document, views: [faceView] };
    const projection: ResolvedDrawingView = { ...segment, visible: [] };
    const faceBody: SolidBody = { ...edgeBody,
      mesh: { positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 20, 0]), normals: new Float32Array(),
        indices: new Uint32Array([0, 1, 2]), edgePositions: new Float32Array(), triangleCount: 1 },
      faces: [{ index: 4, surfaceKind: 'plane', area: 200, centroid: [20 / 3, 20 / 3, 0], axis: [0, 0, 1],
        radius: null, triangleOffset: 0, triangleCount: 1 }],
      origins: { version: 1, state: 'tracked', bindings: [
        { origin: faceOrigin, state: 'unique', current: { kind: 'face', index: 4 } },
      ] } };
    expect(pickDrawingFace(faceDocument, source(faceBody), [projection], [105, 105]))
      .toMatchObject({ kind: 'subShape', ref: { index: 4, origin: faceOrigin } });
    const split: SolidBody = { ...faceBody, origins: { version: 1, state: 'tracked', bindings: [
      { origin: faceOrigin, state: 'split', candidates: [{ kind: 'face', index: 4 }, { kind: 'face', index: 9 }] },
    ] } };
    expect(pickDrawingFace(faceDocument, source(split), [projection], [105, 105])).toBeNull();
    expect(pickDrawingFace(faceDocument, source({ ...faceBody, origins: undefined }), [projection], [105, 105]))
      .toMatchObject({ kind: 'subShape', ref: { fingerprint: { kind: 'face' } } });
    const first = source(faceBody).dimensionInstances?.[0];
    if (first === undefined) throw new Error('instanceなし');
    expect(pickDrawingFace(faceDocument,
      { ...source(faceBody), dimensionInstances: [first, { ...first, bodyId: 'another' }] }, [projection], [105, 105])).toBeNull();
    expect(pickDrawingFace(faceDocument, source(faceBody, 'foreign'), [projection], [105, 105])).toBeNull();
  });
});
