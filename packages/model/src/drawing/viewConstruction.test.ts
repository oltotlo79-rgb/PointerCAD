import { describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import type { Dimension, DimensionTarget, DrawingDocument, DrawingView, DrawingViewConstruction, Point2, Vector3 } from '@pointercad/drawing';
import { createDrawingDocument } from './createDrawingDocument.js';
import { resolveDrawing, type DrawingResolveKernel, type DrawingSourceResolution } from './resolveDrawing.js';
import { refreshDrawing } from './refreshDrawing.js';
import { resolveViewConstructions } from './viewConstruction.js';
import { resolveDrawingPlane } from './resolveDrawingPlane.js';

const expression = expressionValueFromNumber;
const metadata = { sourceRef: 'part', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-10T00:00:00.000Z' } as const;
const source: DrawingSourceResolution = { bodyIds: ['box'], center: [5, 0, 0], dimensionInstances: [] };
const front: DrawingView = { id: 'front', kind: 'front', name: '正面', direction: [0, 0, 1], xDir: [1, 0, 0],
  position: [100, 100], scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const document = (views: readonly DrawingView[], extra: Partial<DrawingDocument> = {}): DrawingDocument => ({ ...createDrawingDocument('図面', metadata), views, ...extra });
const derived = (id: string, construction: DrawingViewConstruction): DrawingView => ({ ...front, id, name: id, kind: construction.kind, construction });
const point = (viewId: string, modelPoint: Vector3): DimensionTarget => ({ kind: 'point', viewId, modelPoint, paperPoint: [0, 0] });
const dimension = (viewId: string): Dimension => ({ id: 'dimension', kind: 'length', measurement: 'trueDistance',
  targets: [point(viewId, [0, 0, 0]), point(viewId, [10, 0, 0])], placement: { commonNormalCoordinate: 120, textPosition: null },
  origin: 'manual', reference: false, layerId: 'layer-4' });
const detail = (sourceViewId = 'front'): DrawingViewConstruction => ({ kind: 'detail', sourceViewId, center: [0, 0], radius: expression(2), scale: expression(2), label: 'B' });
const section = (offset = expression(2)): DrawingViewConstruction => ({ kind: 'section', plane: { kind: 'workPlane', planeId: 'xy', offset },
  mode: 'full', keepSide: 'positive', reversed: false, label: 'A' });
function kernel() {
  return {
    prepareDrawingSource: vi.fn(() => Promise.resolve(source)),
    hiddenLineViews: vi.fn<DrawingResolveKernel['hiddenLineViews']>((request) => Promise.resolve({ cancelled: false, failures: [], views: request.views.map((view) => ({ viewId: view.id,
      visible: [{ curve: { kind: 'segment' as const, from: [0, 0] as Point2, to: [10, 0] as Point2 }, provenance: { bodyId: 'box', edgeIndex: 0 } },
        { curve: { kind: 'segment' as const, from: [9, 1] as Point2, to: [10, 1] as Point2 }, provenance: { bodyId: 'box', edgeIndex: 1 } }], hidden: [] })) })),
    sectionViews: vi.fn<DrawingResolveKernel['sectionViews']>((request) => Promise.resolve({ viewId: request.view.id, visible: [], hidden: [],
      cuttingCurves: [{ kind: 'segment' as const, from: [0, 0] as Point2, to: [10, 0] as Point2 }], cancelled: false, failures: [] })),
  } satisfies DrawingResolveKernel;
}

describe('保存条件から投影・寸法を共通に解く派生図', () => {
  it('個別に隠した中心マークの出自を保持し、表示変更ではHLRを再実行しない', async () => {
    const bridge = kernel(), saved = document([front]);
    bridge.hiddenLineViews.mockImplementation((request) => Promise.resolve({ cancelled: false, failures: [], views: request.views.map((view) => ({ viewId: view.id,
      visible: [{ curve: { kind: 'arc' as const, center: [5, 0] as Point2, radius: 4, startAngle: 0, endAngle: 2 * Math.PI },
        provenance: { bodyId: 'box', kind: 'edge', edgeIndex: 1 } }], hidden: [] })) }));
    const first = await resolveDrawing(saved, bridge); expect(first.ok).toBe(true); if (!first.ok) return;
    const mark = first.views[0].centerMarks?.[0]; if (mark === undefined) throw new Error('中心マーク');
    expect(first.views[0].centerCurves).toHaveLength(2);
    const hidden = await resolveDrawing({ ...saved, views: [{ ...front, hiddenCenterMarkIds: mark.sourceIds }] }, bridge);
    expect(hidden.ok).toBe(true); if (!hidden.ok) return;
    expect(hidden.views[0].centerCurves ?? []).toEqual([]); expect(hidden.views[0].centerMarks?.[0].sourceIds).toEqual(mark.sourceIds);
    expect(bridge.hiddenLineViews).toHaveBeenCalledOnce();
  });
  it('詳細範囲の円と符号を親図へ、倍率の見出しを子図へ置き、移動ではHLRを再実行しない', async () => {
    const bridge = kernel(), saved = document([front, { ...derived('detail', detail()), position: [180, 160] }]);
    const result = await resolveDrawing(saved, bridge); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.views[0].decorations).toMatchObject([{ ownerId: 'detail', style: { lineWidth: 0.25 },
      curves: [{ kind: 'arc', center: [100, 100], radius: 2 }], texts: [{ text: 'B', sizeMm: 3.5 }] }]);
    expect(result.views[1].decorations?.[0].texts).toMatchObject([{ text: 'B (2:1)', position: [180, 152], sizeMm: 3.5 }]);
    const moved = await resolveDrawing({ ...saved, views: saved.views.map((view) => view.id === 'front' ? { ...view, position: [120, 110] } : view) }, bridge);
    expect(moved.ok && moved.views[0].decorations?.[0].curves?.[0]).toMatchObject({ center: [120, 110], radius: 2 });
    expect(bridge.hiddenLineViews).toHaveBeenCalledOnce();
    expect(saved.views[1].construction).not.toHaveProperty('decorations');
  });
  it('図上の切断線の矢印は実際の視線を向き、反転・拡大でも太線と矢の紙面寸法を保つ', async () => {
    const construction: DrawingViewConstruction = { kind: 'section', mode: 'full', keepSide: 'positive', reversed: false, label: 'C',
      plane: { kind: 'viewLine', sourceViewId: 'front', from: [-15, 0], to: [15, 0] } };
    const saved = document([{ ...front, scale: 2 }, derived('cut', construction)]);
    const first = await resolveDrawing(saved, kernel()); expect(first.ok).toBe(true); if (!first.ok) return;
    const lines = first.views[0].decorations ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ style: { lineType: 'chain', lineWidth: 0.25 }, curves: [{ from: [70, 100], to: [130, 100] }] });
    expect(lines[1]).toMatchObject({ style: { lineWidth: 0.5 } });
    for (const curve of lines[1].curves ?? []) {
      if (curve.kind !== 'segment') throw new Error('切断線の太線');
      expect(Math.hypot(curve.to[0] - curve.from[0], curve.to[1] - curve.from[1])).toBeCloseTo(5);
    }
    expect(lines[2].texts?.map((text) => text.text)).toEqual(['C', 'C']);
    expect(lines[2].fills).toHaveLength(2);
    expect(first.views[1].decorations?.[0].texts?.[0].text).toBe('C–C');
    const opposite = await resolveDrawing(document([{ ...front, scale: 2 }, derived('cut', { ...construction, reversed: true })]), kernel());
    expect(opposite.ok).toBe(true); if (!opposite.ok) return;
    const firstArrow = lines[2].curves?.[0], reverseArrow = opposite.views[0].decorations?.[2].curves?.[0];
    if (firstArrow?.kind !== 'segment' || reverseArrow?.kind !== 'segment') throw new Error('切断線の矢印が必要');
    expect(firstArrow.to).toEqual(reverseArrow.to);
    expect(firstArrow.from[1] - firstArrow.to[1]).toBeCloseTo(-(reverseArrow.from[1] - reverseArrow.to[1]));
  });
  it('交差する部分図と部分断面は投影・切断の前に断る', async () => {
    const boundary: readonly Point2[] = [[0, 0], [10, 10], [0, 10], [10, 0]];
    const partial: DrawingViewConstruction = { kind: 'partial', sourceViewId: 'front', region: { kind: 'polygon', points: boundary } };
    const local: DrawingViewConstruction = { kind: 'section', mode: 'local', keepSide: 'positive', reversed: false, label: 'A',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expression(0) }, boundary };
    for (const definition of [partial, local]) {
      const bridge = kernel(), result = await resolveDrawing(document([front, derived('invalid', definition)]), bridge);
      expect(result.ok).toBe(false); expect(bridge.hiddenLineViews).not.toHaveBeenCalled(); expect(bridge.sectionViews).not.toHaveBeenCalled();
    }
  });
  it('断面のハッチと面選択用の切り口を同じ紙面座標へ写し、詳細範囲の外へハッチを描かない', async () => {
    const bridge = kernel();
    const curves = [{ kind: 'polyline' as const, closed: true, points: [[0, -10], [10, -10], [10, 10], [0, 10]] as readonly Point2[] }];
    bridge.sectionViews.mockImplementation((request) => Promise.resolve({ viewId: request.view.id, visible: [], hidden: [], cuttingCurves: curves,
      cuttingAreas: [{ bodyId: 'box', occurrenceId: null, point: [0, 0, 2], normal: [0, 0, -1], curves }], cancelled: false, failures: [] }));
    const result = await resolveDrawing(document([derived('section', section()), derived('detail', detail('section'))]), bridge);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.views[0].hatchCurves?.length).toBeGreaterThan(2);
    expect(result.views[0].cuttingAreas?.[0]).toMatchObject({ point: [0, 0, 2], normal: [0, 0, -1], loops: [[[95, 90], [105, 90], [105, 110], [95, 110]]] });
    expect(result.views[1].hatchCurves?.length).toBeGreaterThan(0);
    for (const curve of result.views[1].hatchCurves ?? []) {
      if (curve.kind !== 'segment') throw new Error('ハッチは線分');
      for (const point of [curve.from, curve.to]) expect(Math.hypot(point[0] - 100, point[1] - 100)).toBeLessThanOrEqual(4 + 1e-8);
    }
  });
  it('親より前に置いた詳細図も実寸範囲を切り、独自縮尺で配置し、投影を共有する', async () => {
    const bridge = kernel();
    const saved = document([derived('detail', detail()), front]);
    const result = await resolveDrawing(saved, bridge);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.views[0].visible).toEqual([{ curve: { kind: 'segment', from: [96, 100], to: [104, 100] }, provenance: { bodyId: 'box', edgeIndex: 0 } }]);
    expect(bridge.hiddenLineViews).toHaveBeenCalledOnce();
    expect(vi.mocked(bridge.hiddenLineViews).mock.calls[0][0].views).toHaveLength(1);
    expect(saved.views[0].scale).toBeNull();
  });

  it('詳細中心を移すと、寸法端点と投影が同じ原点へ移り、測定値は変わらない', async () => {
    const view = derived('detail', { kind: 'detail', sourceViewId: 'front', center: [3, 0], radius: expression(10), scale: expression(2), label: 'B' });
    const saved = document([front, view], { dimensions: [dimension('detail')] });
    const result = await refreshDrawing(saved, kernel());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toBe(saved);
    expect(result.dimensions[0]).toMatchObject({ value: 10, targets: [{ paperPoint: [84, 100] }, { paperPoint: [104, 100] }] });
    expect(result.projection.views[1].visible[0].curve).toMatchObject({ from: [84, 100], to: [104, 100] });
  });

  it('部分図の切り抜きは詳細図にも適用し、切断境界と線の出自も保持する', async () => {
    const saved = document([front, derived('partial', { kind: 'partial', sourceViewId: 'front', region: { kind: 'polygon', points: [[-1, -2], [1, -2], [1, 2], [-1, 2]] } }),
      derived('detail', detail('partial'))]);
    const result = await resolveDrawing(saved, kernel());
    expect(result.ok && result.views[2].visible[0]).toMatchObject({ curve: { from: [98, 100], to: [102, 100] }, provenance: { edgeIndex: 0 } });
  });

  it('断面条件をそのまま再評価してsectionViewsへ渡し、詳細図も切断した形状を使う', async () => {
    const bridge = kernel();
    const result = await resolveDrawing(document([derived('section', section()), derived('detail', detail('section'))]), bridge);
    expect(result.ok).toBe(true);
    expect(bridge.hiddenLineViews).not.toHaveBeenCalled();
    expect(bridge.sectionViews).toHaveBeenCalledOnce();
    expect(vi.mocked(bridge.sectionViews).mock.calls[0][0]).toMatchObject({ plane: { origin: [0, 0, 2] }, view: { normal: [0, 0, -1] }, keepSide: 'positive' });
    expect(result.ok && result.views[1].cuttingCurves[0]).toMatchObject({ from: [96, 100], to: [104, 100] });
  });

  it('平面の式は保存済みの古い数値を信用せず評価し、式変更だけで断面を再計算する', async () => {
    const bridge = kernel();
    const offset = { ...expression(999), source: '8 / 2' };
    const saved = document([derived('section', section(offset))]);
    await resolveDrawing(saved, bridge);
    await resolveDrawing({ ...saved, views: [{ ...saved.views[0], position: [150, 120], scale: 2 }] }, bridge);
    expect(bridge.sectionViews).toHaveBeenCalledOnce();
    expect(vi.mocked(bridge.sectionViews).mock.calls[0][0].plane.origin).toEqual([0, 0, 4]);
    await resolveDrawing(document([derived('section', section({ ...offset, source: '10 / 2' }))]), bridge);
    expect(bridge.sectionViews).toHaveBeenCalledTimes(2);
  });

  it('破断区間より先の独立した辺も移り、寸法の実寸10と端点を保持する', async () => {
    const saved = document([front, derived('broken', { kind: 'broken', sourceViewId: 'front', axis: 'u', from: expression(-2), to: expression(2), gap: expression(1) })],
      { dimensions: [dimension('broken')] });
    const result = await refreshDrawing(saved, kernel());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dimensions[0]).toMatchObject({ value: 10, targets: [{ paperPoint: [95, 100] }, { paperPoint: [102, 100] }] });
    expect(result.projection.views[1].visible).toEqual([
      { curve: { kind: 'segment', from: [95, 100], to: [98, 100] }, provenance: { bodyId: 'box', edgeIndex: 0 } },
      { curve: { kind: 'segment', from: [99, 100], to: [102, 100] }, provenance: { bodyId: 'box', edgeIndex: 0 } },
      { curve: { kind: 'segment', from: [101, 101], to: [102, 101] }, provenance: { bodyId: 'box', edgeIndex: 1 } },
    ]);
    expect(result.projection.views[1].breakCurves).toHaveLength(2);
  });

  it.each([0.5, 2, 5])('縮尺%sでも破断後の紙面の隙間は1mm', async (scale) => {
    const view = { ...derived('broken', { kind: 'broken', sourceViewId: 'front', axis: 'u', from: expression(-2), to: expression(2), gap: expression(1) }), scale };
    const result = await resolveDrawing(document([front, view]), kernel());
    if (!result.ok) throw new Error(result.message);
    const [before, after] = result.views[1].visible;
    expect(before.curve.kind).toBe('segment'); expect(after.curve.kind).toBe('segment');
    if (before.curve.kind === 'segment' && after.curve.kind === 'segment') expect(after.curve.from[0] - before.curve.to[0]).toBeCloseTo(1);
  });

  it.each([
    [derived('self', detail('self'))],
    [derived('a', detail('b')), derived('b', detail('a'))],
    [derived('missing', detail('gone'))],
    [front, front],
  ])('欠落・循環・重複参照を断りカーネルを呼ばない: %j', async (...views) => {
    const bridge = kernel();
    expect((await resolveDrawing(document(views), bridge)).ok).toBe(false);
    expect(bridge.hiddenLineViews).not.toHaveBeenCalled(); expect(bridge.sectionViews).not.toHaveBeenCalled();
  });

  it('補助投影では親の視線ではなく指定面の法線を用いる', () => {
    const result = resolveViewConstructions(document([front, derived('aux', { kind: 'auxiliary', sourceViewId: 'front', plane: { kind: 'workPlane', planeId: 'yz', offset: expression(0) } })]), source);
    expect(result.ok && result.views.get('aux')?.view).toMatchObject({ direction: [1, 0, 0], xDir: [0, -1, 0] });
  });

  it('図上の実寸切断線と見る方向から平面を作る', () => {
    const result = resolveDrawingPlane({ kind: 'viewLine', sourceViewId: 'front', from: [-5, 0], to: [5, 0] }, document([front]), { instances: [], modelCenter: source.center });
    expect(result.ok && result.plane).toMatchObject({ origin: [0, 0, 0], normal: [0, -1, 0] });
  });

  it('3点の参照は実座標で解き、同一直線なら既存の平面検証で断る', () => {
    const points = [point('front', [0, 0, 3]), point('front', [1, 0, 3]), point('front', [0, 1, 3])] as const;
    const saved = document([front]); const context = { instances: [], modelCenter: source.center };
    const result = resolveDrawingPlane({ kind: 'threePoints', points }, saved, context);
    expect(result.ok && result.plane.origin).toEqual([0, 0, 3]);
    expect(resolveDrawingPlane({ kind: 'threePoints', points: [points[0], points[1], point('front', [2, 0, 3])] }, saved, context).ok).toBe(false);
  });
});
