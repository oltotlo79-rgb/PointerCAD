import { describe, expect, it } from 'vitest';

import type { CurveSpec, HiddenLineViewRequest, SolidStepRequest } from '../types.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { createKernelApi } from './kernelApi.js';

const square: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [20, 0, 0] },
  { kind: 'segment', from: [20, 0, 0], to: [20, 20, 0] },
  { kind: 'segment', from: [20, 20, 0], to: [0, 20, 0] },
  { kind: 'segment', from: [0, 20, 0], to: [0, 0, 0] },
];

function boxStep(key: string): SolidStepRequest {
  return {
    id: key, key, label: key, visible: true,
    step: { kind: 'extrude', profile: square, direction: [0, 0, 1], distance: 20 },
  };
}

const view = (id: string, normal: readonly [number, number, number], xDir: readonly [number, number, number]): HiddenLineViewRequest => ({
  id, origin: [0, 0, 0], normal, xDir, includeHidden: true, mode: 'precise',
});

describe('KernelApi drawing RPC', () => {
  it.each(['positive', 'negative'] as const)('残す%s側の切り口だけを外側から見せ、裏面越しにハッチを重ねない', async (keepSide) => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'cut-facing', generation: 1, steps: [boxStep('facing-box')] });
    const outward = keepSide === 'positive' ? -1 : 1;
    try {
      const plane = { origin: [0, 0, 10] as const, axisU: [1, 0, 0] as const, normal: [0, 0, 1] as const };
      const front = await api.sectionViews({ bodyIds: ['facing-box'], plane, keepSide, view: view('front', [0, 0, outward], [1, 0, 0]) });
      expect(front.failures).toEqual([]); expect(front.cuttingCurves).toHaveLength(4);
      expect(front.cuttingAreas?.[0].normal).toEqual([0, 0, outward]);
      expect(front.cuttingAreas?.[0].point[2]).toBeCloseTo(10);
      const back = await api.sectionViews({ bodyIds: ['facing-box'], plane, keepSide, view: view('back', [0, 0, -outward], [1, 0, 0]) });
      expect(back.failures).toEqual([]); expect(back.visible.length).toBeGreaterThan(0);
      expect(back.cuttingCurves).toEqual([]); expect(back.cuttingAreas).toEqual([]);
    } finally { await api.releasePart('cut-facing'); }
  });
  it('切断後の辺番号を流用せず、残った元辺だけを元の番号で寸法参照にする', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'section-reference', generation: 1, steps: [boxStep('reference-box')] });
    const direction = view('reference', [1, 1, 1], [1, -1, 0]);
    try {
      const original = await api.hiddenLineViews({ bodyIds: ['reference-box'], views: [direction] });
      const cut = await api.sectionViews({ bodyIds: ['reference-box'], view: direction,
        plane: { origin: [0, 0, 10], axisU: [1, 0, 0], normal: [0, 0, 1] }, keepSide: 'positive' });
      expect(cut.failures).toEqual([]);
      const supported = [...cut.visible, ...cut.hidden].filter((item) => item.provenance.kind === 'edge' && item.provenance.dimensionTarget);
      expect(supported.length).toBeGreaterThan(0);
      expect([...cut.visible, ...cut.hidden].some((item) => item.provenance.kind === 'edge' && !item.provenance.dimensionTarget)).toBe(true);
      const originals = original.views.flatMap((item) => [...item.visible, ...item.hidden]);
      for (const current of supported) {
        const provenance = current.provenance; if (provenance.kind !== 'edge') throw new Error('edge required');
        const same = originals.filter((item) => item.provenance.kind === 'edge' && item.provenance.edgeIndex === provenance.edgeIndex);
        expect(same.some((item) => JSON.stringify(item.curve) === JSON.stringify(current.curve))).toBe(true);
      }
    } finally { await api.releasePart('section-reference'); }
  });

  it('3方向を1回の依頼で返し、入力idを保つ', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'drawing', generation: 1, steps: [boxStep('box')] });
    try {
      const result = await api.hiddenLineViews({
        partId: 'drawing', bodyIds: ['box'],
        views: [view('front', [0, 0, 1], [1, 0, 0]), view('top', [0, 1, 0], [1, 0, 0]), view('right', [1, 0, 0], [0, 1, 0])],
      });
      expect(result.cancelled).toBe(false);
      expect(result.failures).toEqual([]);
      expect(result.views.map((item) => item.viewId)).toEqual(['front', 'top', 'right']);
      expect(result.views.every((item) => item.visible.length >= 4)).toBe(true);
    } finally { await api.releasePart('drawing'); }
  });

  it('まとめた結果は1方向ずつ頼んだ結果と一致する', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'batch', generation: 1, steps: [boxStep('batch-box')] });
    const directions = [view('front', [0, 0, 1], [1, 0, 0]), view('iso', [1, 1, 1], [1, -1, 0])];
    try {
      const batch = await api.hiddenLineViews({ bodyIds: ['batch-box'], views: directions });
      const singles = await Promise.all(directions.map(async (item) => api.hiddenLineViews({ bodyIds: ['batch-box'], views: [item] })));
      expect(batch.views).toEqual(singles.flatMap((item) => item.views));
    } finally { await api.releasePart('batch'); }
  });

  it('図の間で中止し、進捗は完了分だけ通知する', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'cancel', generation: 1, steps: [boxStep('cancel-box')] });
    let checks = 0;
    const progress: number[] = [];
    try {
      const result = await api.hiddenLineViews(
        { bodyIds: ['cancel-box'], views: [view('a', [0, 0, 1], [1, 0, 0]), view('b', [0, 1, 0], [1, 0, 0])] },
        (item) => { progress.push(item.completed); },
        () => { checks += 1; return Promise.resolve(checks > 1); },
      );
      expect(result.cancelled).toBe(true);
      expect(result.views).toHaveLength(1);
      expect(progress).toEqual([1]);
    } finally { await api.releasePart('cancel'); }
  });

  it('無い形状キーは理由を返す', async () => {
    const api = createKernelApi(loadOcctForNode);
    const result = await api.hiddenLineViews({ bodyIds: ['missing'], views: [view('front', [0, 0, 1], [1, 0, 0])] });
    expect(result.views).toEqual([]);
    expect(result.failures.some((failure) => failure.bodyId === 'missing')).toBe(true);
  });

  it('中央断面は切断後HLRと切断面の交線を返す', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'section', generation: 1, steps: [boxStep('section-box')] });
    try {
      const result = await api.sectionViews({
        bodyIds: ['section-box'],
        view: view('A-A', [0, 0, 1], [1, 0, 0]),
        plane: { origin: [5, 7, 10], axisU: [0, 1, 0], normal: [0, 0, 1] },
        keepSide: 'negative',
      });
      expect(result.cancelled).toBe(false);
      expect(result.failures).toEqual([]);
      expect(result.visible.length).toBeGreaterThan(0);
      expect(result.cuttingCurves).toHaveLength(4);
      expect(result.cuttingAreas).toMatchObject([{ bodyId: 'section-box', occurrenceId: null, normal: [0, 0, 1], curves: result.cuttingCurves }]);
      const corners = result.cuttingCurves.flatMap((curve) => curve.kind === 'segment' ? [curve.from, curve.to] : []);
      expect(Math.min(...corners.map((point) => point[0]))).toBeCloseTo(0, 7);
      expect(Math.max(...corners.map((point) => point[0]))).toBeCloseTo(20, 7);
      expect(Math.min(...corners.map((point) => point[1]))).toBeCloseTo(0, 7);
      expect(Math.max(...corners.map((point) => point[1]))).toBeCloseTo(20, 7);
    } finally { await api.releasePart('section'); }
  });
  it('計算前の中止ではHLRも進捗通知も実行しない', async () => {
    const api = createKernelApi(loadOcctForNode); const progress: number[] = [];
    const result = await api.hiddenLineViews({ bodyIds: [], views: [view('front', [0, 0, 1], [1, 0, 0])] },
      (value) => { progress.push(value.completed); }, () => true);
    expect(result).toEqual({ views: [], failures: [], cancelled: true }); expect(progress).toEqual([]);
  });
  it('存在しないボディでの断面は当該ボディの理由を返す', async () => {
    const api = createKernelApi(loadOcctForNode);
    const result = await api.sectionViews({ bodyIds: ['missing'], view: view('A-A', [0, 0, 1], [1, 0, 0]),
      plane: { origin: [0, 0, 10], axisU: [1, 0, 0], normal: [0, 0, 1] }, keepSide: 'positive' });
    expect(result.visible).toEqual([]); expect(result.failures.some((failure) => failure.bodyId === 'missing')).toBe(true);
  });
  it('断面の開始前の中止で切り口も返さない', async () => {
    const api = createKernelApi(loadOcctForNode);
    const result = await api.sectionViews({ bodyIds: ['missing'], view: view('A-A', [0, 0, 1], [1, 0, 0]),
      plane: { origin: [0, 0, 10], axisU: [1, 0, 0], normal: [0, 0, 1] }, keepSide: 'positive' }, undefined, () => true);
    expect(result).toEqual({ viewId: 'A-A', visible: [], hidden: [], cuttingCurves: [], failures: [], cancelled: true });
  });
  it('回転断面は断面輪郭だけを返し、奥の隠線を描かない', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'revolved', generation: 1, steps: [boxStep('revolved-box')] });
    try {
      const result = await api.sectionViews({ bodyIds: ['revolved-box'], view: view('R', [0, 0, 1], [1, 0, 0]),
        kind: 'revolved', plane: { origin: [5, 7, 10], axisU: [0, 1, 0], normal: [0, 0, 1] }, keepSide: 'positive' });
      expect(result.failures).toEqual([]); expect(result.visible).toHaveLength(4); expect(result.hidden).toEqual([]);
      expect(result.visible.map((item) => item.curve)).toEqual(result.cuttingCurves);
      const corners = result.cuttingCurves.flatMap((curve) => curve.kind === 'segment' ? [curve.from, curve.to] : []);
      expect(Math.min(...corners.map((point) => point[0]))).toBeCloseTo(0);
      expect(Math.min(...corners.map((point) => point[1]))).toBeCloseTo(0);
      expect(Math.max(...corners.map((point) => point[0]))).toBeCloseTo(20);
      expect(Math.max(...corners.map((point) => point[1]))).toBeCloseTo(20);
    } finally { await api.releasePart('revolved'); }
  });
  it('切断面が外なら空の図を成功扱いにせず理由を返す', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'miss', generation: 1, steps: [boxStep('miss-box')] });
    try {
      const result = await api.sectionViews({ bodyIds: ['miss-box'], view: view('A-A', [0, 0, 1], [1, 0, 0]),
        plane: { origin: [0, 0, 30], axisU: [1, 0, 0], normal: [0, 0, 1] }, keepSide: 'positive' });
      expect(result.visible).toEqual([]);
      expect(result.failures.some((failure) => failure.message === 'この位置では切り口ができません。切断線を動かしてください。')).toBe(true);
    } finally { await api.releasePart('miss'); }
  });
  it('同じ部品の配置2個を別々の位置・発生元IDで投影する', async () => {
    const api = createKernelApi(loadOcctForNode);
    await api.recomputeSolids({ partId: 'instances', generation: 1, steps: [boxStep('shared-box')] });
    const instances = [
      { bodyId: 'shared-box', occurrenceId: 'a', placement: { position: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const } },
      { bodyId: 'shared-box', occurrenceId: 'b', placement: { position: [40, 0, 0] as const, rotation: [0, 0, 0, 1] as const } },
    ];
    try {
      const result = await api.hiddenLineViews({ bodyIds: ['shared-box'], instances, views: [view('front', [0, 0, 1], [1, 0, 0])] });
      expect(result.failures).toEqual([]);
      const visible = result.views[0]?.visible ?? [];
      expect(visible.filter((item) => item.provenance.occurrenceId === 'a')).toHaveLength(4);
      const second = visible.filter((item) => item.provenance.occurrenceId === 'b');
      expect(second).toHaveLength(4);
      const xs = second.flatMap((item) => item.curve.kind === 'segment' ? [item.curve.from[0], item.curve.to[0]] : []);
      expect(Math.min(...xs)).toBe(40); expect(Math.max(...xs)).toBe(60);
      const section = await api.sectionViews({ bodyIds: ['shared-box'], instances,
        view: view('cut', [0, 0, 1], [1, 0, 0]), plane: { origin: [0, 0, 10], axisU: [1, 0, 0], normal: [0, 0, 1] }, keepSide: 'negative' });
      expect(section.failures).toEqual([]);
      expect(new Set(section.visible.map((item) => item.provenance.occurrenceId))).toEqual(new Set(['a', 'b']));
      expect(section.cuttingAreas?.map((area) => area.occurrenceId)).toEqual(['a', 'b']);
      const original = await api.hiddenLineViews({ bodyIds: ['shared-box'], views: [view('front', [0, 0, 1], [1, 0, 0])] });
      const originalXs = original.views[0]?.visible.flatMap((item) => item.curve.kind === 'segment' ? [item.curve.from[0], item.curve.to[0]] : []) ?? [];
      expect(Math.max(...originalXs)).toBe(20);
    } finally { await api.releasePart('instances'); }
  });
});
