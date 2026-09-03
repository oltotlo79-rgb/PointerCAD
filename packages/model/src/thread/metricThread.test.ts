import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THREAD_DESIGNATION, findMetricThread, METRIC_THREAD_DESIGNATIONS, METRIC_THREADS,
  metricThreadPitch, threadMinorDiameter, threadPitchDiameter, threadTriangleHeight,
} from './metricThread.js';

describe('JIS メートルねじの規格データ', () => {
  it('M2〜M64 の28行を持つ', () => {
    expect(METRIC_THREADS.length).toBe(28);
  });

  it('呼びの重複が無い', () => {
    const designations = METRIC_THREADS.map((size) => size.designation);
    expect(new Set(designations).size).toBe(28);
  });

  it('呼び径が昇順に並んでいる', () => {
    for (let index = 1; index < METRIC_THREADS.length; index += 1) {
      expect(METRIC_THREADS[index].diameter).toBeGreaterThan(METRIC_THREADS[index - 1].diameter);
    }
  });

  it('基本山形の高さ H = P·√3/2', () => {
    expect(threadTriangleHeight(1)).toBeCloseTo(0.8660254037844386, 12);
  });

  it('めねじ内径 D1(M6)', () => {
    expect(threadMinorDiameter(6, 1)).toBeCloseTo(4.917468, 6);
  });

  it('めねじ内径 D1(M8)', () => {
    expect(threadMinorDiameter(8, 1.25)).toBeCloseTo(6.646835, 6);
  });

  it('めねじ内径 D1(M10)', () => {
    expect(threadMinorDiameter(10, 1.5)).toBeCloseTo(8.376202, 6);
  });

  it('めねじ内径 D1(M12)', () => {
    expect(threadMinorDiameter(12, 1.75)).toBeCloseTo(10.105569, 6);
  });

  it('めねじ内径 D1(M16)', () => {
    expect(threadMinorDiameter(16, 2)).toBeCloseTo(13.834936, 6);
  });

  it('めねじ内径 D1(M20)', () => {
    expect(threadMinorDiameter(20, 2.5)).toBeCloseTo(17.293671, 6);
  });

  it('めねじ内径 D1(M24)', () => {
    expect(threadMinorDiameter(24, 3)).toBeCloseTo(20.752405, 6);
  });

  it('有効径 d2(M6)', () => {
    expect(threadPitchDiameter(6, 1)).toBeCloseTo(5.350481, 6);
  });

  it('有効径 d2(M10)', () => {
    expect(threadPitchDiameter(10, 1.5)).toBeCloseTo(9.025721, 6);
  });

  it('findMetricThread で呼びからサイズを引ける', () => {
    const m6 = findMetricThread('M6');
    expect(m6).toMatchObject({ diameter: 6, coarsePitch: 1, finePitch: 0.75 });
  });

  it('findMetricThread は大文字小文字を区別する(小文字は見つからない)', () => {
    expect(findMetricThread('m6')).toBeUndefined();
  });

  it('findMetricThread は表に無い呼びで undefined', () => {
    expect(findMetricThread('M5.5')).toBeUndefined();
  });

  it('metricThreadPitch が並目・細目を切り替える', () => {
    const m6 = findMetricThread('M6');
    if (m6 === undefined) {
      throw new Error('M6 が見つからない(表の異常)');
    }
    expect(metricThreadPitch(m6, 'coarse')).toBe(1);
    expect(metricThreadPitch(m6, 'fine')).toBe(0.75);
  });

  it('呼びの一覧は M2 で始まり M64 で終わる', () => {
    expect(METRIC_THREAD_DESIGNATIONS[0]).toBe('M2');
    expect(METRIC_THREAD_DESIGNATIONS[METRIC_THREAD_DESIGNATIONS.length - 1]).toBe('M64');
  });

  it('既定の呼びは M6', () => {
    expect(DEFAULT_THREAD_DESIGNATION).toBe('M6');
  });

  it('全28行の D1 が正の数で呼び径未満(基本山形の性質)', () => {
    for (const size of METRIC_THREADS) {
      const d1 = threadMinorDiameter(size.diameter, size.coarsePitch);
      expect(d1).toBeGreaterThan(0);
      expect(d1).toBeLessThan(size.diameter);
    }
  });
});
