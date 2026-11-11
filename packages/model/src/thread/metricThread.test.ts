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


describe('公開メーカー表と独立した基本山形の回帰', () => {
  // OSG「ねじ」PDF20頁（§14）の各径、M64はYAMAWA Quick Guide p.50のSize列。
  // 製品表から期待値を生成しない。細目は「本アプリの採用値」で、選択順位ではない。
  it('原典の28行の呼び径・並目・採用細目を固定表へ一致させる', () => {
    expect(METRIC_THREADS.map((size) => [
      size.designation, size.diameter, size.coarsePitch, size.finePitch,
    ])).toEqual([
      ['M2', 2, 0.4, 0.25],
      ['M2.5', 2.5, 0.45, 0.35],
      ['M3', 3, 0.5, 0.35],
      ['M3.5', 3.5, 0.6, 0.35],
      ['M4', 4, 0.7, 0.5],
      ['M5', 5, 0.8, 0.5],
      ['M6', 6, 1, 0.75],
      ['M8', 8, 1.25, 1],
      ['M10', 10, 1.5, 1.25],
      ['M12', 12, 1.75, 1.25],
      ['M14', 14, 2, 1.5],
      ['M16', 16, 2, 1.5],
      ['M18', 18, 2.5, 1.5],
      ['M20', 20, 2.5, 1.5],
      ['M22', 22, 2.5, 1.5],
      ['M24', 24, 3, 2],
      ['M27', 27, 3, 2],
      ['M30', 30, 3.5, 2],
      ['M33', 33, 3.5, 2],
      ['M36', 36, 4, 3],
      ['M39', 39, 4, 3],
      ['M42', 42, 4.5, 3],
      ['M45', 45, 4.5, 3],
      ['M48', 48, 5, 3],
      ['M52', 52, 5, 3],
      ['M56', 56, 5.5, 4],
      ['M60', 60, 5.5, 4],
      ['M64', 64, 6, 4],
    ]);
  });

  // NBK「一般用メートルねじ」PDF1頁の60°基本山形から独立に導出。
  // H=P√3/2、D1=d−5H/4、d2=d−3H/4を50桁Decimalで手順計算した固定値。
  // NBKの寸法表は0.001mm丸め。ここでは丸め前の式を検査し、工具下穴径は使わない。
  it.each([
    ['M2', 'coarse', 2, 0.4, 0.34641016151378, 1.56698729810778, 1.74019237886467],
    ['M2', 'fine', 2, 0.25, 0.21650635094611, 1.72936706131736, 1.83762023679042],
    ['M6', 'coarse', 6, 1, 0.86602540378444, 4.91746824526945, 5.35048094716167],
    ['M6', 'fine', 6, 0.75, 0.64951905283833, 5.18810118395209, 5.51286071037125],
    ['M10', 'coarse', 10, 1.5, 1.29903810567666, 8.37620236790418, 9.02572142074251],
    ['M10', 'fine', 10, 1.25, 1.08253175473055, 8.64683530658681, 9.18810118395209],
    ['M64', 'coarse', 64, 6, 5.19615242270663, 57.50480947161671, 60.10288568297003],
    ['M64', 'fine', 64, 4, 3.46410161513775, 59.66987298107781, 61.40192378864668],
  ] as const)('%s %sのH・基本内径D1・有効径を独立式の固定値で確認', (
    _designation, _series, diameter, pitch, height, minorDiameter, pitchDiameter,
  ) => {
    expect(threadTriangleHeight(pitch)).toBeCloseTo(height, 11);
    expect(threadMinorDiameter(diameter, pitch)).toBeCloseTo(minorDiameter, 11);
    expect(threadPitchDiameter(diameter, pitch)).toBeCloseTo(pitchDiameter, 11);
  });
});
