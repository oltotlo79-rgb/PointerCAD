/**
 * 段の並びの部品の形(2 冊目のパイプ形のフレームのキャップとフット)の検査: 形が成り立つ時だけ作り、体積と高さが段の式と合う事。
 * 寸法は検査のための汎用の値(資料の値ではない)。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread, metricThreadPitch, threadMinorDiameter } from '../../../thread/metricThread.js';
import { buildStackedPart, stackedPartHeight, stackedPartVolume, type StackedPartDimensions } from './stackedPart.js';

const CAP: StackedPartDimensions = {
  segments: [{ shape: 'square', width: 30, depth: 30, height: 3, bore: null }, { shape: 'circle', diameter: 25, height: 12, bore: null }],
  thread: null,
};

describe('段の並びの部品の形', () => {
  it('四角の頭と円の差し込みの体積は段ごとの体積の和で、高さは段の高さの和', () => {
    expect(buildStackedPart(CAP)).not.toBeNull();
    expect(stackedPartVolume(CAP)).toBeCloseTo(30 * 30 * 3 + Math.PI * 12.5 ** 2 * 12, 9);
    expect(stackedPartHeight(CAP)).toBe(15);
  });

  it('中の穴は段の体積から引き、おねじは一番上の段の上に呼びの径の円柱を足す', () => {
    const tube: StackedPartDimensions = { segments: [{ shape: 'circle', diameter: 33, height: 100, bore: 30 }], thread: null };
    expect(stackedPartVolume(tube)).toBeCloseTo(Math.PI * (16.5 ** 2 - 15 ** 2) * 100, 9);
    const adjuster: StackedPartDimensions = { segments: [{ shape: 'circle', diameter: 38, height: 12, bore: null }], thread: { size: 'M8', length: 60 } };
    const radius = (findMetricThread('M8')?.diameter ?? NaN) / 2;
    expect(buildStackedPart(adjuster)).not.toBeNull();
    expect(stackedPartVolume(adjuster)).toBeCloseTo(Math.PI * 19 ** 2 * 12 + Math.PI * radius ** 2 * 60, 9);
    expect(stackedPartHeight(adjuster)).toBe(72);
  });

  it('段が無い・寸法が正でない・中の穴が段より太い・ねじが段より太いか中の穴の段に立つ・呼びが表に無い時は形を作らない', () => {
    const cases: readonly StackedPartDimensions[] = [
      { segments: [], thread: null },
      { segments: [{ shape: 'circle', diameter: 0, height: 5, bore: null }], thread: null },
      { segments: [{ shape: 'circle', diameter: 20, height: 5, bore: 20 }], thread: null },
      { segments: [{ shape: 'circle', diameter: 6, height: 5, bore: null }], thread: { size: 'M8', length: 10 } },
      { segments: [{ shape: 'circle', diameter: 30, height: 5, bore: 10 }], thread: { size: 'M8', length: 10 } },
      { segments: [{ shape: 'circle', diameter: 30, height: 5, bore: null }], thread: { size: 'M7.3', length: 10 } },
    ];
    for (const dims of cases) {
      expect(buildStackedPart(dims)).toBeNull();
      expect(stackedPartVolume(dims)).toBeNull();
    }
  });
});

describe('段の並びの部品の、全部の段を通すめねじ(統括の決定 2026-11-18 07:5x)', () => {
  const size = findMetricThread('M5');
  const minor = size === undefined ? NaN : threadMinorDiameter(size.diameter, metricThreadPitch(size, 'coarse'));
  const NUT: StackedPartDimensions = { segments: [{ shape: 'circle', diameter: 12, height: 9, bore: null }], thread: null, threadHole: 'M5' };

  it('めねじは並目の谷の径の円柱で全部の段を抜き、体積は段の体積 − 谷の径の円 × 全高、高さは段の高さの和', () => {
    expect(buildStackedPart(NUT)).not.toBeNull();
    expect(stackedPartVolume(NUT)).toBeCloseTo(Math.PI * 6 ** 2 * 9 - Math.PI * (minor / 2) ** 2 * 9, 9);
    expect(stackedPartHeight(NUT)).toBe(9);
  });

  it('呼びが表に無い・段より太い・おねじや段の中の穴と一緒のめねじは断る', () => {
    for (const dims of [{ ...NUT, threadHole: 'M0' }, { ...NUT, threadHole: 'M20' }, { ...NUT, thread: { size: 'M5', length: 10 } },
      { ...NUT, segments: [{ shape: 'circle' as const, diameter: 12, height: 9, bore: 3 }] }]) {
      expect(buildStackedPart(dims)).toBeNull();
      expect(stackedPartVolume(dims)).toBeNull();
    }
  });
});
