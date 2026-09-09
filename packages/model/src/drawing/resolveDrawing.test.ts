import { describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import type { DrawingDocument, DrawingView } from '@pointercad/drawing';

import { createDrawingDocument } from './createDrawingDocument.js';
import { resolveDrawing, type DrawingProjectionRequest, type DrawingResolveKernel, type DrawingResolutionOptions } from './resolveDrawing.js';

const source = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'hash-1', importedAt: '2026-09-09T00:00:00.000Z' } as const;
const baseView: DrawingView = {
  id: 'front', name: '正面図', kind: 'front', position: [100, 100], scale: null,
  direction: [0, 0, 1], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'visible',
};

const planeContext: NonNullable<DrawingResolutionOptions['planeContext']> = {
  point: () => null, axis: () => null,
  workPlane: () => ({ origin: [0, 0, 0], normal: [0, 0, 1], axisU: [1, 0, 0], axisV: [0, 1, 0] }),
};
const section: NonNullable<DrawingResolutionOptions['sections']>[string] = {
  kind: 'full', keepSide: 'positive', plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(10) },
};

function documentWith(views: readonly DrawingView[], sheetScale = 1): DrawingDocument {
  const document = createDrawingDocument('図面', source);
  return { ...document, sheet: { ...document.sheet, scale: sheetScale }, views };
}

function fakeKernel(bodyIds: readonly string[] = ['body-1']) {
  const calls: DrawingProjectionRequest[] = [];
  let prepareCalls = 0;
  const kernel: DrawingResolveKernel = {
    prepareDrawingSource() { prepareCalls += 1; return Promise.resolve({ bodyIds, center: [5, 0, 0] }); },
    sectionViews(request) {
      return Promise.resolve({ viewId: request.view.id, visible: [], hidden: [], cuttingCurves: [], failures: [], cancelled: false });
    },
    hiddenLineViews(request) {
      calls.push(request);
      return Promise.resolve({
        cancelled: false, failures: [],
        views: request.views.map((view) => ({
          viewId: view.id,
          visible: [
            { curve: { kind: 'segment' as const, from: [0, 0], to: [10, 0] }, provenance: { bodyId: 'body-1' } },
            { curve: { kind: 'arc' as const, center: [5, 5], radius: 2, startAngle: 0, endAngle: Math.PI }, provenance: {} },
            { curve: { kind: 'polyline' as const, points: [[0, 0], [5, 5]], closed: false }, provenance: {} },
          ],
          hidden: view.includeHidden ? [{ curve: { kind: 'segment' as const, from: [0, 1], to: [10, 1] }, provenance: {} }] : [],
        })),
      });
    },
  };
  return { kernel, calls, prepareCalls: () => prepareCalls };
}

describe('resolveDrawing', () => {
  it('三面図を1回のカーネル呼び出しで解決する', async () => {
    const fake = fakeKernel();
    const views = [
      baseView,
      { ...baseView, id: 'top', name: '平面図', kind: 'top' as const, direction: [0, 1, 0] as const },
      { ...baseView, id: 'right', name: '右側面図', kind: 'right' as const, direction: [1, 0, 0] as const, xDir: [0, 1, 0] as const },
    ];
    const result = await resolveDrawing(documentWith(views), fake.kernel);
    expect(result.ok && result.views).toHaveLength(3);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.views).toHaveLength(3);
  });

  it('同じ向きの図2つは投影依頼1件へまとめる', async () => {
    const fake = fakeKernel();
    const result = await resolveDrawing(documentWith([baseView, { ...baseView, id: 'front-copy', position: [200, 100] }]), fake.kernel);
    expect(result.ok && result.views).toHaveLength(2);
    expect(fake.calls[0]?.views).toHaveLength(1);
  });

  it('縮尺変更ではカーネルを呼ばず用紙座標だけ変える', async () => {
    const fake = fakeKernel();
    const first = await resolveDrawing(documentWith([baseView]), fake.kernel);
    const second = await resolveDrawing(documentWith([baseView], 2), fake.kernel);
    expect(fake.calls).toHaveLength(1);
    expect(first.ok && first.views[0]?.visible[0]?.curve).toMatchObject({ from: [95, 100], to: [105, 100] });
    expect(second.ok && second.views[0]?.visible[0]?.curve).toMatchObject({ from: [90, 100], to: [110, 100] });
  });

  it('個別縮尺が用紙全体の縮尺より優先される', async () => {
    const fake = fakeKernel();
    const result = await resolveDrawing(documentWith([{ ...baseView, scale: 0.5 }], 2), fake.kernel);
    expect(result.ok && result.views[0]?.scale).toBe(0.5);
  });

  it('位置変更では投影を再計算せず中心を移す', async () => {
    const fake = fakeKernel();
    await resolveDrawing(documentWith([baseView]), fake.kernel);
    const moved = await resolveDrawing(documentWith([{ ...baseView, position: [200, 150] }]), fake.kernel);
    expect(fake.calls).toHaveLength(1);
    expect(moved.ok && moved.views[0]?.visible[0]?.curve).toMatchObject({ from: [195, 150] });
  });

  it('向きを変えるとその向きだけを追加計算する', async () => {
    const fake = fakeKernel();
    await resolveDrawing(documentWith([baseView]), fake.kernel);
    await resolveDrawing(documentWith([{ ...baseView, direction: [1, 0, 0], xDir: [0, 1, 0] }]), fake.kernel);
    expect(fake.calls).toHaveLength(2);
  });

  it('円弧の中心と半径を縮尺で写す', async () => {
    const fake = fakeKernel();
    const result = await resolveDrawing(documentWith([baseView], 2), fake.kernel);
    expect(result.ok && result.views[0]?.visible[1]?.curve).toMatchObject({ center: [100, 110], radius: 4 });
  });

  it('折れ線の全点を用紙へ写す', async () => {
    const fake = fakeKernel();
    const result = await resolveDrawing(documentWith([baseView]), fake.kernel);
    expect(result.ok && result.views[0]?.visible[2]?.curve).toMatchObject({ points: [[95, 100], [100, 105]] });
  });

  it('隠線表示を切ると隠線を頼まず結果も空', async () => {
    const fake = fakeKernel();
    const result = await resolveDrawing(documentWith([{ ...baseView, showHidden: false }]), fake.kernel);
    expect(fake.calls[0]?.views[0]?.includeHidden).toBe(false);
    expect(result.ok && result.views[0]?.hidden).toEqual([]);
  });

  it('立体が0個なら理由を返しHLRを呼ばない', async () => {
    const fake = fakeKernel([]);
    expect(await resolveDrawing(documentWith([baseView]), fake.kernel)).toEqual({ ok: false, message: '図にできる立体がありません。' });
    expect(fake.calls).toEqual([]);
  });

  it('抱き込んだ元文書を解決のたびに再評価する', async () => {
    const fake = fakeKernel();
    await resolveDrawing(documentWith([baseView]), fake.kernel);
    await resolveDrawing(documentWith([baseView]), fake.kernel);
    expect(fake.prepareCalls()).toBe(2);
  });

  it('同じ入力の解決結果は決定的', async () => {
    const firstFake = fakeKernel();
    const secondFake = fakeKernel();
    expect(await resolveDrawing(documentWith([baseView]), firstFake.kernel))
      .toEqual(await resolveDrawing(documentWith([baseView]), secondFake.kernel));
  });

  it('断面はHLR通常口へ流さず、解決した平面でsectionViewsを呼ぶ', async () => {
    const fake = fakeKernel(); const call = vi.spyOn(fake.kernel, 'sectionViews');
    const result = await resolveDrawing(documentWith([{ ...baseView, kind: 'section' }]), fake.kernel, { planeContext, sections: { front: section } });
    expect(result.ok).toBe(true); expect(fake.calls).toEqual([]);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[0]).toMatchObject({ kind: 'full', plane: { origin: [0, 0, 10], normal: [0, 0, 1] } });
  });

  it('断面の種類・位置が変われば再計算し、縮尺だけなら再利用する', async () => {
    const fake = fakeKernel(); const call = vi.spyOn(fake.kernel, 'sectionViews');
    const views = [{ ...baseView, kind: 'section' as const }];
    const options = { planeContext, sections: { front: section } };
    await resolveDrawing(documentWith(views), fake.kernel, options);
    await resolveDrawing(documentWith(views, 2), fake.kernel, options);
    expect(call).toHaveBeenCalledOnce();
    await resolveDrawing(documentWith(views), fake.kernel, { planeContext, sections: {
      front: { ...section, kind: 'half', boundary: [[0, 0], [1, 0]] },
    } });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('補助投影は指定面の向きをHLRへ渡す', async () => {
    const fake = fakeKernel();
    const context = { ...planeContext, workPlane: () => ({ origin: [0, 0, 0] as const,
      normal: [0, -1, 0] as const, axisU: [1, 0, 0] as const, axisV: [0, 0, 1] as const }) };
    await resolveDrawing(documentWith([{ ...baseView, kind: 'auxiliary' }]), fake.kernel, {
      planeContext: context, auxiliary: { front: { plane: section.plane, originalViewV: [0, 0, 1] } },
    });
    expect(fake.calls[0]?.views[0]).toMatchObject({ normal: [0, -1, 0], xDir: [0, 0, 1] });
  });

  it('部分投影の輪郭は生の投影座標で切り、線の出自を保って用紙へ置く', async () => {
    const fake = fakeKernel();
    const result = await resolveDrawing(documentWith([{ ...baseView, kind: 'partial' }]), fake.kernel, {
      partial: { front: { kind: 'polygon', points: [[2, -1], [8, -1], [8, 1], [2, 1]] } },
    });
    expect(result.ok && result.views[0]?.visible[0]).toMatchObject({
      curve: { kind: 'segment', from: [97, 100], to: [103, 100] }, provenance: { bodyId: 'body-1' },
    });
  });

  it('部品の3D中心を図ごとに投影し、別方向へ同じ2D中心を流用しない', async () => {
    const fake = fakeKernel();
    fake.kernel.prepareDrawingSource = () => Promise.resolve({ bodyIds: ['body-1'], center: [5, 20, 30] });
    const result = await resolveDrawing(documentWith([{ ...baseView, direction: [1, 0, 0], xDir: [0, 1, 0] }]), fake.kernel);
    expect(result.ok && result.views[0]?.visible[0]?.curve).toMatchObject({ from: [80, 70], to: [90, 70] });
  });

  it('切断指定のない断面を通常図として黙って作らない', async () => {
    const fake = fakeKernel();
    expect((await resolveDrawing(documentWith([{ ...baseView, kind: 'section' }]), fake.kernel)).ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('参照元の読み込み失敗を理由つきで返す', async () => {
    const fake = fakeKernel(); fake.kernel.prepareDrawingSource = () => Promise.reject(new Error('参照元がありません。'));
    expect(await resolveDrawing(documentWith([baseView]), fake.kernel)).toEqual({ ok: false, message: '参照元がありません。' });
  });
});
