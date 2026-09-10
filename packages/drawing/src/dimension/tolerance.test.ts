import { describe, expect, it } from 'vitest';
import { layoutDimensionTolerance, resolveDimensionTolerance, type MeasureDimensionText } from './tolerance.js';
import type { DimensionTolerance } from './types.js';

// 比例書体の幅は入力文字の長さに比例しない。レイアウトは渡された実測を使う。
const measure: MeasureDimensionText = (text, sizeMm) => ({
  fontId: 'measured-test-font', sizeMm, advanceMm: (text === '50' ? 1.1 : 1.4) * sizeMm,
  inkBounds: { left: -0.02 * sizeMm, bottom: -0.2 * sizeMm, right: sizeMm, top: 0.8 * sizeMm },
});
const layout = (tolerance: DimensionTolerance) => layoutDimensionTolerance({
  mainText: '50', tolerance, sizeMm: 3.5, measure,
});

describe('寸法の公差と実測字体による上下2段配置', () => {
  it('対称公差は寸法値と同じ大きさの1行', () => {
    const result = layout({ kind: 'symmetric', value: 0.1 });
    expect(result?.runs).toHaveLength(1);
    expect(result?.runs[0]).toMatchObject({ text: '50±0.1', position: [0, 0], metrics: { sizeMm: 3.5 } });
  });
  it('上下偏差は寸法値と2段の小さい文字', () => {
    const result = layout({ kind: 'deviation', upper: 0.1, lower: -0.05 });
    expect(result?.runs.map((run) => run.text)).toEqual(['50', '+0.1', '−0.05']);
    expect(result?.runs[1].metrics.sizeMm).toBe(3.5 * 0.7);
    expect(result?.runs[2].metrics.sizeMm).toBe(3.5 * 0.7);
    expect(result?.runs[1].position[1]).toBeGreaterThan(result?.runs[2].position[1] ?? Infinity);
  });
  it.each([[0.1, 0, '+0.1', '0'], [0, -0.1, '0', '−0.1'], [0, -0, '0', '0']])(
    '上下%s/%sの0には符号を付けない', (upper, lower, upperText, lowerText) => {
      expect(layout({ kind: 'deviation', upper: Number(upper), lower: Number(lower) })?.runs.map((run) => run.text))
        .toEqual(['50', upperText, lowerText]);
    },
  );
  it('上下が逆なら断る', () => {
    expect(layout({ kind: 'deviation', upper: -0.1, lower: 0.1 })).toBeNull();
  });
  it.each([NaN, Infinity, -0.1])('非有限・負の対称%sは断る', (value) => {
    expect(layout({ kind: 'symmetric', value })).toBeNull();
  });
  it('式を変更せず評価値で配置する', () => {
    const source = Object.freeze({ source: '板厚/20', value: 0.15, display: '0.15' });
    const tolerance = Object.freeze({ kind: 'symmetric' as const, value: source });
    expect(layout(tolerance)?.runs[0].text).toBe('50±0.15');
    expect(tolerance.value).toBe(source);
    expect(resolveDimensionTolerance(tolerance)).toEqual({ kind: 'symmetric', value: 0.15 });
  });
  it('非有限の式の評価値を断る', () => {
    expect(resolveDimensionTolerance({ kind: 'deviation', upper: { source: 'x', value: Infinity, display: '' }, lower: 0 })).toBeNull();
  });
  it('実測が未取得なら架空の文字幅で配置しない', () => {
    expect(layoutDimensionTolerance({ mainText: '50', sizeMm: 3.5, tolerance: { kind: 'symmetric', value: 0.1 }, measure: () => null })).toBeNull();
  });
  it('上下の墨は重ならず、寸法値の中央にそろう', () => {
    const result = layout({ kind: 'deviation', upper: 0.1, lower: -0.05 });
    if (result === null) throw new Error('配置できません');
    const [main, upper, lower] = result.runs;
    const upperBottom = upper.position[1] + upper.metrics.inkBounds.bottom;
    const lowerTop = lower.position[1] + lower.metrics.inkBounds.top;
    expect(upperBottom - lowerTop).toBeCloseTo(0.35, 12);
    expect(upper.position[0] + upper.metrics.inkBounds.left).toBeGreaterThan(main.metrics.inkBounds.right);
    const center = (upper.position[1] + upper.metrics.inkBounds.top + lower.position[1] + lower.metrics.inkBounds.bottom) / 2;
    expect(center).toBeCloseTo((main.metrics.inkBounds.bottom + main.metrics.inkBounds.top) / 2, 12);
  });
  it('同じ入力は同じ位置と幅になる', () => {
    expect(layout({ kind: 'deviation', upper: 0.1, lower: -0.05 })).toEqual(layout({ kind: 'deviation', upper: 0.1, lower: -0.05 }));
  });
  it('対称公差の後ろに補足文字を置き参考括弧で全体を囲む', () => {
    expect(layoutDimensionTolerance({ mainText: '4×20', suffix: ' 通し', reference: true, sizeMm: 3.5,
      tolerance: { kind: 'symmetric', value: 0.2 }, measure })?.runs[0].text).toBe('(4×20±0.2 通し)');
  });
  it('上下偏差と補足文字が重ならず、墨の範囲に補足全体を含める', () => {
    const result = layoutDimensionTolerance({ mainText: '20H7', suffix: ' 通し', reference: true, sizeMm: 3.5,
      tolerance: { kind: 'deviation', upper: 0.021, lower: 0 }, decimals: 4, measure });
    if (result === null) throw new Error('配置なし');
    expect(result.runs.map((run) => run.text)).toEqual(['(20H7', '+0.021', '0', ' 通し)']);
    const [, upper, lower, suffix] = result.runs;
    expect(suffix.position[0] + suffix.metrics.inkBounds.left).toBeGreaterThan(Math.max(
      upper.position[0] + upper.metrics.inkBounds.right, lower.position[0] + lower.metrics.inkBounds.right));
    expect(result.inkBounds.right).toBeGreaterThanOrEqual(suffix.position[0] + suffix.metrics.inkBounds.right);
  });
});
