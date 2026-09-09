import { describe, expect, it } from 'vitest';
import { THIRD_ANGLE_DIRECTIONS } from '../layout/thirdAngle.js';
import { dimensionSeries, drawingViewBasis, type DimensionSeriesInput, type DimensionSeriesPoint } from './series.js';
const points: readonly DimensionSeriesPoint[] = [0, 20, 50, 90].map((value, index) => ({
  id: `p${index}`, modelPoint: [value, 0, 0], paperPoint: [value, 0],
}));
const input: DimensionSeriesInput = { kind: 'chain', points, view: THIRD_ANGLE_DIRECTIONS.front, commonNormalCoordinate: 10 };

describe('直列・並列・座標・累進の寸法(P8-29)', () => {
  it('0/20/50/90の直列は20/30/40で同じhへ並ぶ', () => {
    const result = dimensionSeries(input);
    expect(result.ok && result.kind).toBe('chain');
    if (!result.ok || result.kind !== 'chain') throw new Error('直列寸法がありません');
    expect(result.dimensions.map((dim) => dim.value)).toEqual([20, 30, 40]);
    expect(result.dimensions.map((dim) => dim.commonNormalCoordinate)).toEqual([10, 10, 10]);
    expect(result.dimensions.map((dim) => [dim.fromId, dim.toId])).toEqual([['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3']]);
  });
  it('並列は基準から20/50/90、hを8mmずつ増やす', () => {
    const result = dimensionSeries({ ...input, kind: 'parallel' });
    if (!result.ok || result.kind !== 'parallel') throw new Error('並列寸法がありません');
    expect(result.dimensions.map((dim) => dim.value)).toEqual([20, 50, 90]);
    expect(result.dimensions.map((dim) => dim.commonNormalCoordinate)).toEqual([10, 18, 26]);
    expect(result.dimensions.map((dim) => dim.fromId)).toEqual(['p0', 'p0', 'p0']);
  });
  it('累進は1本の線に4目盛と基準からの値を置く', () => {
    const result = dimensionSeries({ ...input, kind: 'progressive' });
    if (!result.ok || result.kind !== 'progressive') throw new Error('累進寸法がありません');
    expect(result.line).toEqual({ from: [0, 10], to: [90, 10] });
    expect(result.ticks.map((tick) => tick.value)).toEqual([0, 20, 50, 90]);
    expect(result.ticks).toHaveLength(4);
    expect(result.ticks[0].arrow).toBeNull();
    expect(result.ticks[1].arrow?.points[0]).toEqual([20, 10]);
  });
  it('座標表は4行で図のX/Yの2成分を持つ', () => {
    const result = dimensionSeries({ ...input, kind: 'coordinate' });
    if (!result.ok || result.kind !== 'coordinate') throw new Error('座標寸法がありません');
    expect(result.rows.map(({ x, y }) => [x, y])).toEqual([[0, 0], [20, 0], [50, 0], [90, 0]]);
  });
  it('座標の基準を変更すると全点を新しい原点から測る', () => {
    const result = dimensionSeries({ ...input, kind: 'coordinate', baseIndex: 2 });
    if (!result.ok || result.kind !== 'coordinate') throw new Error('座標寸法がありません');
    expect(result.basePointId).toBe('p2');
    expect(result.rows.map((row) => row.x)).toEqual([-50, -30, 0, 40]);
  });
  it('並列の基準を中間点にしても同じhの向きで両側へ引く', () => {
    const result = dimensionSeries({ ...input, kind: 'parallel', baseIndex: 2 });
    if (!result.ok || result.kind !== 'parallel') throw new Error('並列寸法がありません');
    expect(result.dimensions.map((dim) => dim.value)).toEqual([50, 30, 40]);
    expect(result.dimensions[0].geometry.dimensionLine).toEqual({ from: [50, 10], to: [0, 10] });
    expect(result.dimensions[1].geometry.dimensionLine).toEqual({ from: [50, 18], to: [20, 18] });
  });
  it('累進の基準が途中なら符号を保持する', () => {
    const result = dimensionSeries({ ...input, kind: 'progressive', baseIndex: 1 });
    if (!result.ok || result.kind !== 'progressive') throw new Error('累進寸法がありません');
    expect(result.ticks.map((tick) => tick.value)).toEqual([-20, 0, 30, 70]);
  });
  it('半分の縮尺でも値はモデルの20/30/40のまま', () => {
    const result = dimensionSeries({ ...input, points: points.map((point) => ({ ...point, paperPoint: [point.paperPoint[0] / 2 + 100, 20] })) });
    if (!result.ok || result.kind !== 'chain') throw new Error('直列寸法がありません');
    expect(result.dimensions.map((dim) => dim.value)).toEqual([20, 30, 40]);
    expect(result.dimensions[0].geometry).toMatchObject({ value: 20, dimensionLine: { from: [100, 10], to: [110, 10] } });
  });
  it('正面図の高さはZ成分で、3Dの斜め距離を代入しない', () => {
    const result = dimensionSeries({ ...input, kind: 'coordinate', points: [points[0], { id: 'p1', modelPoint: [3, 12, 4], paperPoint: [3, 4] }] });
    if (!result.ok || result.kind !== 'coordinate') throw new Error('座標寸法がありません');
    expect(result.rows[1]).toMatchObject({ x: 3, y: 4 });
    expect(result.rows[1].x).not.toBe(13);
  });
  it('上面図ではY成分を用紙のYにする', () => {
    const result = dimensionSeries({ ...input, kind: 'coordinate', view: THIRD_ANGLE_DIRECTIONS.top,
      points: [points[0], { id: 'p1', modelPoint: [3, 12, 4], paperPoint: [3, 12] }] });
    if (!result.ok || result.kind !== 'coordinate') throw new Error('座標寸法がありません');
    expect(result.rows[1]).toMatchObject({ x: 3, y: 12 });
  });
  it('縦の並列寸法は共通法線座標が左向きになる', () => {
    const result = dimensionSeries({ ...input, kind: 'parallel', axis: 'y', points: points.map((point) => ({
      ...point, modelPoint: [0, 0, point.modelPoint[0]], paperPoint: [0, point.paperPoint[0]],
    })) });
    if (!result.ok || result.kind !== 'parallel') throw new Error('並列寸法がありません');
    expect(result.dimensions.map((dim) => dim.value)).toEqual([20, 50, 90]);
    expect(result.dimensions[0].geometry.dimensionLine).toEqual({ from: [-10, 0], to: [-10, 20] });
  });
  it('斜めに並ぶ点でも水平補助線は元の点から伸びる', () => {
    const result = dimensionSeries({ ...input, points: [points[0], { id: 'p1', modelPoint: [30, 0, 40], paperPoint: [30, 40] }], commonNormalCoordinate: 50 });
    if (!result.ok || result.kind !== 'chain') throw new Error('直列寸法がありません');
    expect(result.dimensions[0]).toMatchObject({ value: 30, geometry: {
      dimensionLine: { from: [0, 50], to: [30, 50] }, extensionLines: [{ from: [0, 1], to: [0, 52] }, { from: [30, 41], to: [30, 52] }],
    } });
  });
  it('実文字幅が収まらない寸法は外側へ矢印を配置する', () => {
    const result = dimensionSeries({ ...input, textWidth: () => 30 });
    if (!result.ok || result.kind !== 'chain') throw new Error('直列寸法がありません');
    expect(result.dimensions[0].geometry.outwardArrows).toBe(true);
  });
  it('文字測定に失敗したときに推測幅で代替しない', () => expect(dimensionSeries({ ...input, textWidth: () => null })).toMatchObject({ ok: false, reason: 'text' }));
  it('1点は2点以上を選ぶ案内になる', () => expect(dimensionSeries({ ...input, points: points.slice(0, 1) })).toEqual({
    ok: false, reason: 'points', message: '2 点以上を選んでください。',
  }));
  it('投影上同じ座標の両端を断る', () => expect(dimensionSeries({ ...input, points: [points[0], { ...points[1], paperPoint: [0, 1] }] })).toMatchObject({ ok: false, reason: 'projection' }));
  it('不正な基準・重複ID・非有限座標を断る', () => {
    expect(dimensionSeries({ ...input, baseIndex: -1 }).ok).toBe(false);
    expect(dimensionSeries({ ...input, points: [points[0], points[0]] }).ok).toBe(false);
    expect(dimensionSeries({ ...input, points: [points[0], { ...points[1], modelPoint: [NaN, 0, 0] }] }).ok).toBe(false);
  });
  it('不正な図の向きを断る', () => expect(dimensionSeries({ ...input, view: { normal: [0, 1, 0], xDir: [0, 2, 0] } })).toMatchObject({ ok: false, reason: 'view' }));
  it('入力順を保持して決定的に生成する', () => {
    const snapshot = JSON.stringify(input);
    expect(dimensionSeries(input)).toEqual(dimensionSeries(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it('任意の図の基底を直交正規化する', () => {
    const basis = drawingViewBasis({ normal: [0, 0, -2], xDir: [2, 2, 1] })!;
    expect(Math.hypot(...basis.x)).toBeCloseTo(1, 12);
    expect(Math.hypot(...basis.y)).toBeCloseTo(1, 12);
    expect(basis.x[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(basis.y[0]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(basis.y[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });
});
