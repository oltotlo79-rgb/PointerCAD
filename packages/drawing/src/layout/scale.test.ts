import { describe, expect, it } from 'vitest';

import { STANDARD_SCALES, autoScale } from './scale.js';

const base = {
  paperSizeId: 'A3-landscape' as const,
  orientation: 'landscape' as const,
  titleBlockHeight: 56,
  gap: 20,
};

describe('標準縮尺と自動縮尺', () => {
  it('標準縮尺は11件で昇順かつ重複しない', () => {
    expect(STANDARD_SCALES).toHaveLength(11);
    expect([...STANDARD_SCALES].sort((a, b) => a - b)).toEqual(STANDARD_SCALES);
    expect(new Set(STANDARD_SCALES).size).toBe(STANDARD_SCALES.length);
  });

  it('既存の7件をすべて保つ', () => {
    expect(STANDARD_SCALES).toEqual(expect.arrayContaining([0.1, 0.2, 0.5, 1, 2, 5, 10]));
  });

  it('100×40×60は訂正式で2:1になる', () => {
    expect(autoScale({ ...base, extents: [100, 40, 60] })).toBe(2);
  });

  it('400×150×250は訂正式で1:2になる', () => {
    // min((390−20)/(400+150), (221−20)/(250+150)) = min(0.6727…, 0.5025)
    expect(autoScale({ ...base, extents: [400, 150, 250] })).toBe(0.5);
  });

  it('20×10×15をA4横へ置くと2:1になる', () => {
    expect(autoScale({
      ...base, paperSizeId: 'A4-landscape', extents: [20, 10, 15],
    })).toBe(2);
  });

  it('1200×400×800は1:10になる', () => {
    expect(autoScale({ ...base, extents: [1200, 400, 800] })).toBe(0.1);
  });

  it('極端に大きな物体はnullになる', () => {
    expect(autoScale({
      ...base,
      paperSizeId: 'A4-portrait',
      orientation: 'portrait',
      extents: [100_000, 100_000, 100_000],
    })).toBeNull();
  });

  it('gapを0にしても最大標準値2を選ぶ', () => {
    expect(autoScale({ ...base, gap: 0, extents: [100, 40, 60] })).toBe(2);
  });

  it('訂正例600×160×40は旧式の0.5でなく0.2になる', () => {
    expect(autoScale({ ...base, extents: [600, 160, 40] })).toBe(0.2);
  });

  it('最終境界がはみ出す候補を1段下げる', () => {
    expect(autoScale({
      ...base,
      extents: [100, 40, 60],
      finalBoundsAtScale: (scale) => ({ width: scale === 2 ? 391 : 200, height: 200 }),
    })).toBe(1);
  });

  it('負の寸法は断る', () => {
    expect(autoScale({ ...base, extents: [-1, 20, 20] })).toBeNull();
  });
});
