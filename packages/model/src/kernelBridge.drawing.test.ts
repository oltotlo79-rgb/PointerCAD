/** 投影平面の法線と「見る向き」の逆転を実OCCTで検査する(P8-25/41)。 */
import { beforeAll, describe, expect, it } from 'vitest';
import { THIRD_ANGLE_DIRECTIONS, type DrawingDocument, type DrawingView } from '@pointercad/drawing';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { makeBox } from '../../kernel/src/occt/makeBox.js';
import { hiddenLineView } from '../../kernel/src/occt/makeHiddenLineViews.js';
import { createDrawingDocument } from './drawing/createDrawingDocument.js';
import { resolveDrawing, type DrawingResolveKernel, type DrawingProjectionCurve } from './drawing/resolveDrawing.js';
import { resolveDrawingDimensions } from './drawing/dimensionTarget.js';

describe('実OCCTの三面図と寸法の向きの一致', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  beforeAll(async () => {
    const started = performance.now();
    oc = await loadOcctForNode();
    console.log(`三面図検査のOCCT初期化: ${(performance.now() - started).toFixed(1)}ms`);
  }, 180_000); // kernelと同じ初期化上限。形状計算や性能判定の上限とは分ける。
  it.each([
    ['front', 20, 40], ['top', 20, 30], ['right', 30, 40],
  ] as const)('%sは左右と上下を反転せず、投影幅%s・高さ%sになる', async (kind, width, height) => {
    const handle = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    try {
      const basis = THIRD_ANGLE_DIRECTIONS[kind];
      const view: DrawingView = { id: kind, name: kind, kind, direction: basis.normal, xDir: basis.xDir,
        position: [100, 100], scale: null, showHidden: false, showCenterLines: false, layerId: 'layer-1' };
      const base = createDrawingDocument('三面図', { sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'box', importedAt: '' });
      const document: DrawingDocument = { ...base, views: [view], dimensions: [{ id: 'diagonal', kind: 'length', measurement: 'vertical',
        targets: [{ kind: 'point', viewId: kind, modelPoint: [0, 0, 0], paperPoint: [0, 0] },
          { kind: 'point', viewId: kind, modelPoint: [20, 30, 40], paperPoint: [0, 0] }],
        placement: { commonNormalCoordinate: 0, textPosition: null }, origin: 'manual', reference: false, layerId: 'layer-4' }] };
      const kernel: DrawingResolveKernel = {
        prepareDrawingSource: () => Promise.resolve({ bodyIds: ['body'], center: [0, 0, 0] }),
        sectionViews: () => Promise.reject(new Error('断面を呼ばない')),
        hiddenLineViews: (request) => {
          const views = request.views.map((spec) => {
            const outcome = hiddenLineView(oc, { ...spec, viewId: spec.id, bodyId: 'body', shape: handle.shape });
            if (!outcome.ok) throw new Error(outcome.message);
            const visible: DrawingProjectionCurve[] = outcome.result.visible.flatMap((item) => item.curve.kind === 'segment'
              ? [{ curve: item.curve, provenance: { ...item.provenance } }] : []);
            return { viewId: spec.id, visible, hidden: [] };
          });
          return Promise.resolve({ views, failures: [], cancelled: false });
        },
      };
      const drawing = await resolveDrawing(document, kernel);
      if (!drawing.ok) throw new Error(drawing.message);
      const points = drawing.views[0].visible.flatMap(({ curve }) => curve.kind === 'segment' ? [curve.from, curve.to] : []);
      expect(points.length).toBeGreaterThanOrEqual(8);
      expect(Math.min(...points.map((point) => point[0]))).toBeCloseTo(100, 8);
      expect(Math.max(...points.map((point) => point[0]))).toBeCloseTo(100 + width, 8);
      expect(Math.min(...points.map((point) => point[1]))).toBeCloseTo(100, 8);
      expect(Math.max(...points.map((point) => point[1]))).toBeCloseTo(100 + height, 8);
      const dimension = resolveDrawingDimensions(document, { instances: [], modelCenter: [0, 0, 0] })[0];
      expect(dimension.value).toBeCloseTo(height, 8);
      expect(dimension.targets[1]).toMatchObject({ paperPoint: [100 + width, 100 + height] });
    } finally { handle.delete(); }
  });
});
