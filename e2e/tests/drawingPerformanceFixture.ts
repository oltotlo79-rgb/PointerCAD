import type { Dimension, DrawingDocument, DrawingView, GdtShapeTarget } from '../../packages/drawing/src/index.js';
import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { writePcaddFile } from '../../packages/io/src/index.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import { absoluteCoordinate, appendSolid, createDirectKernelBridge, createDrawingDocument, createEmptyPartDocument,
  createPrimitiveFeature, drawingSourceInputHash, IDENTITY_PLACEMENT, recomputePart, resolveDimensionTarget } from '../../packages/model/src/index.js';

/** 100個の独立フィーチャーを正規履歴から計算し、50本を実際の辺へ関連付ける。 */
export async function drawingPerformanceFixture(): Promise<Uint8Array> {
  let part = createEmptyPartDocument();
  for (let i = 0; i < 100; i++) {
    const box = createPrimitiveFeature(part, 'box', { kind: 'coordinate', value: absoluteCoordinate(i % 10 * 30, Math.floor(i / 10) * 30, 0) });
    if (box.shape.kind !== 'box') throw new Error('box required');
    part = appendSolid(part, { ...box, shape: { ...box.shape, sizeX: number(20), sizeY: number(20), sizeZ: number(20) } });
  }
  const partId = 'drawing-performance-fixture', api = createKernelApi(loadOcctForNode);
  try {
    const result = await recomputePart(part, createDirectKernelBridge(api), { partId, generation: 1 });
    if (result.errors.length !== 0 || result.cancelled || result.bodies.length !== 100) throw new Error('100フィーチャーの計算失敗');
    const source = { sourceKind: 'part' as const, document: part };
    const base = createDrawingDocument('100フィーチャーと50寸法', { sourceRef: 'source-1', sourceKind: 'part', path: '', fileName: '100フィーチャー.pcad',
      contentHash: await drawingSourceInputHash(source), importedAt: '2026-09-10T00:00:00.000Z' });
    const views: readonly DrawingView[] = [
      { id: 'view-1', name: '正面図', kind: 'front', position: [110, 65], direction: [0, 1, 0], xDir: [1, 0, 0], scale: 0.4, showHidden: true, showCenterLines: true, layerId: 'layer-1' },
      { id: 'view-2', name: '平面図', kind: 'top', position: [110, 205], direction: [0, 0, -1], xDir: [1, 0, 0], scale: 0.4, showHidden: true, showCenterLines: true, layerId: 'layer-1' },
      { id: 'view-3', name: '右側面図', kind: 'right', position: [280, 65], direction: [-1, 0, 0], xDir: [0, 1, 0], scale: 0.4, showHidden: true, showCenterLines: true, layerId: 'layer-1' },
    ];
    const document: DrawingDocument = { ...base, views };
    const context = { modelCenter: [135, 135, 0] as const, instances: result.bodies.map((body) => ({ sourceRef: 'source-1', bodyId: body.featureId, body, placement: IDENTITY_PLACEMENT })) };
    const dimensions: Dimension[] = result.bodies.slice(0, 50).map((body, i) => {
      const edge = body.edges.filter((edge) => edge.curveKind === 'line' && edge.axis !== null && Math.abs(edge.axis[0]) > 0.99
        && Math.abs(edge.midpoint[2] - 10) < 1e-6).sort((a, b) => a.midpoint[1] - b.midpoint[1])[0];
      if (edge === undefined) throw new Error('上面の実稜線なし');
      const target: GdtShapeTarget = { kind: 'subShape', sourceRef: 'source-1', viewId: 'view-2', ref: { bodyFeatureId: body.featureId, index: edge.index,
        fingerprint: { kind: 'edge', curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } } };
      const resolved = resolveDimensionTarget(target, document, context); if (resolved?.kind !== 'line') throw new Error('寸法参照失敗');
      const dx = resolved.paperTo[0] - resolved.paperFrom[0], dy = resolved.paperTo[1] - resolved.paperFrom[1], length = Math.hypot(dx, dy);
      const commonNormalCoordinate = (-(resolved.paperFrom[0] + resolved.paperTo[0]) * dy + (resolved.paperFrom[1] + resolved.paperTo[1]) * dx) / (2 * length) - 3;
      return { id: `perf-dim-${i}`, kind: 'length', measurement: 'trueDistance', targets: [target],
        placement: { commonNormalCoordinate, textPosition: null }, origin: 'manual', reference: false, layerId: 'layer-4' };
    });
    return writePcaddFile({ ...document, dimensions }, { source, savedAt: '2026-09-10T00:00:00.000Z' });
  } finally { await api.releasePart(partId); }
}
