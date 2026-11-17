/**
 * 段の並びの部品の形(2 冊目のパイプ形のフレームのキャップとフット)の検査: 形が成り立つ時だけ作り、体積と高さが段の式と合う事。
 * 寸法は検査のための汎用の値(資料の値ではない)。
 */
import { describe, expect, it } from 'vitest';

import { findMetricThread } from '../../../thread/metricThread.js';
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
