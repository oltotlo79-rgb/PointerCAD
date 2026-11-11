import { describe, expect, it } from 'vitest';

import { buildFilletWeldPart, createFilletWeldSource, filletWeldSegmentOptions } from './filletWeldPart.js';
import {
  intermittentSegments, MAX_WELD_SEGMENTS, occupiedLength, segmentsFromLengthsAndGaps, segmentWithinContact, stationRejections,
} from './stationing.js';
import { WELD_LENGTH_TOLERANCE_MM } from './types.js';

function codes(segments: Parameters<typeof stationRejections>[0], contactLength: number): string[] {
  return stationRejections(segments, contactLength).map((rejection) => rejection.code);
}

describe('溶接ビードの区間割り', () => {
  it('長さと間隔が不揃いな断続ビードを、手で数えた始点と合計長さで置く', () => {
    // 始点5、ビード 12・30・7.5、間隔 8・20.5 → 始点 5, 25, 75.5、合計 49.5。
    const segments = segmentsFromLengthsAndGaps(5, [12, 30, 7.5], [8, 20.5]) ?? [];
    expect(segments).toEqual([{ start: 5, length: 12 }, { start: 25, length: 30 }, { start: 75.5, length: 7.5 }]);
    expect(occupiedLength(segments)).toBe(49.5);
    expect(codes(segments, 83)).toEqual([]);
    // 最後の終わりは 83 なので、接触の長さ 82.9 には収まらない。
    expect(codes(segments, 82.9)).toEqual(['segmentOutsideContact']);
  });

  it('等間隔の断続ビードはピッチで始点を進め、連続ビードは1区間', () => {
    expect(intermittentSegments(10, 20, 50, 3)).toEqual([
      { start: 10, length: 20 }, { start: 60, length: 20 }, { start: 110, length: 20 },
    ]);
    expect(occupiedLength(intermittentSegments(10, 20, 50, 3) ?? [])).toBe(60);
    expect(codes([{ start: 0, length: 100 }], 100)).toEqual([]);
  });

  it('端が接するビードは別のビードとして許し、重なり・逆順・範囲外は理由付きで断る', () => {
    expect(codes([{ start: 0, length: 30 }, { start: 30, length: 10 }], 100)).toEqual([]);
    const overlap = stationRejections([{ start: 0, length: 30 }, { start: 20, length: 30 }], 100);
    expect(overlap.map((rejection) => rejection.code)).toEqual(['segmentsOverlap']);
    expect(overlap[0]?.detail).toEqual({ segment: 1, overlap: 10 });
    expect(codes([{ start: 50, length: 10 }, { start: 0, length: 10 }], 100)).toEqual(['segmentsUnordered']);
    expect(codes([{ start: -1, length: 10 }], 100)).toEqual(['segmentOutsideContact']);
    expect(codes([{ start: 95, length: 10 }], 100)).toEqual(['segmentOutsideContact']);
  });

  it('区間が無い・長さが0以下・NaN・無限大は寸法の誤りとして断る', () => {
    expect(codes([], 100)).toEqual(['noSegments']);
    expect(codes([{ start: 0, length: 0 }], 100)).toEqual(['invalidDimension']);
    expect(codes([{ start: 0, length: -5 }], 100)).toEqual(['invalidDimension']);
    expect(codes([{ start: Number.NaN, length: 5 }], 100)).toEqual(['invalidDimension']);
    expect(codes([{ start: 0, length: Number.NaN }], 100)).toEqual(['invalidDimension']);
    expect(codes([{ start: 0, length: Number.POSITIVE_INFINITY }], 100)).toEqual(['invalidDimension']);
    // 壊れた区間の後ろの区間は、壊れた区間と比べずに自分の範囲だけを確かめる。
    expect(codes([{ start: 0, length: Number.NaN }, { start: 10, length: 5 }], 100)).toEqual(['invalidDimension']);
  });

  it('始点は 0 以上だけ(許容差の内の負も断る)、終点は辺の長さ + 許容差まで。計画と保存の読み取りは同じ規則', () => {
    expect(codes([{ start: -5e-7, length: 10 }], 100)).toEqual(['segmentOutsideContact']);
    expect(segmentWithinContact(-5e-7, 10, 100)).toBe(false);
    expect(codes([{ start: 0, length: 100 }], 100)).toEqual([]);
    expect(codes([{ start: 90, length: 10 + WELD_LENGTH_TOLERANCE_MM / 2 }], 100)).toEqual([]);
    expect(codes([{ start: 90, length: 10 + 2 * WELD_LENGTH_TOLERANCE_MM }], 100)).toEqual(['segmentOutsideContact']);
    expect(codes([{ start: 0, length: WELD_LENGTH_TOLERANCE_MM }], 100)).toEqual(['invalidDimension']);
    // 計画が通る境界の区間は、そのまま保存の台本として読み戻せる(計画が通って足すと失敗する、を作らない)。
    for (const segment of [{ start: 0, length: 100 }, { start: 90, length: 10 + WELD_LENGTH_TOLERANCE_MM / 2 }, { start: 1e-7, length: 5 }]) {
      expect(stationRejections([segment], 100)).toEqual([]);
      const source = createFilletWeldSource(6, 6, { weldId: 'weld-1', segment: 0, station: segment.start, length: segment.length,
        contactLength: 100, parts: ['component-1', 'component-2'] });
      expect(filletWeldSegmentOptions(source.options)).toEqual({ weldId: 'weld-1', segment: 0, station: segment.start,
        length: segment.length, contactLength: 100, parts: ['component-1', 'component-2'] });
    }
  });

  it('保存する数は指数表記を使わない普通の 10 進で書き、長さの式も同じ値に評価できる', () => {
    const station = 2 ** -23;
    const source = createFilletWeldSource(6, 8, { weldId: 'weld-1', segment: 0, station, length: 20 + 2 ** -22, contactLength: 100,
      parts: ['component-1', 'component-2'] });
    // String(2^-23) は '1.1920928955078125e-7'(式の文法に無い指数表記)。
    expect(source.options.weldStation).toBe('0.00000011920928955078125');
    expect([source.options.weldStation, source.options.length, source.options.contactLength].some((text) => /e/i.test(text ?? ''))).toBe(false);
    expect(filletWeldSegmentOptions(source.options)?.station).toBe(station);
    expect(buildFilletWeldPart(source)?.solids[0]).toMatchObject({ kind: 'extrude', distance: { value: 20 + 2 ** -22 } });
  });

  it('本数・長さ・間隔が有限でない・整数でない・上限超え・間隔の数が合わない時は、配列を作らずに断る', () => {
    expect(MAX_WELD_SEGMENTS).toBe(100);
    for (const count of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, MAX_WELD_SEGMENTS + 1]) {
      expect(intermittentSegments(0, 1, 2, count)).toBeNull();
    }
    expect(intermittentSegments(0, 1, 2, MAX_WELD_SEGMENTS)).toHaveLength(MAX_WELD_SEGMENTS);
    expect(intermittentSegments(Number.NaN, 1, 2, 3)).toBeNull();
    expect(intermittentSegments(0, 1, Number.POSITIVE_INFINITY, 3)).toBeNull();
    // 足りない間隔を 0 で補わない。
    expect(segmentsFromLengthsAndGaps(0, [10, 10, 10], [5])).toBeNull();
    expect(segmentsFromLengthsAndGaps(0, [10, 10], [5, 5])).toBeNull();
    expect(segmentsFromLengthsAndGaps(0, [], [])).toBeNull();
    expect(segmentsFromLengthsAndGaps(0, [10, Number.NaN], [5])).toBeNull();
    expect(segmentsFromLengthsAndGaps(0, Array.from({ length: MAX_WELD_SEGMENTS + 1 }, () => 1),
      Array.from({ length: MAX_WELD_SEGMENTS }, () => 0))).toBeNull();
    const many = Array.from({ length: MAX_WELD_SEGMENTS + 1 }, (_, index) => ({ start: index, length: 0.5 }));
    expect(codes(many, 1000)).toEqual(['tooManySegments']);
  });

  it('保存した区間の記録は、安全な整数の番号・別々の2部品・辺の内側の区間だけを受ける(正しい値は今までどおり読む)', () => {
    const valid = createFilletWeldSource(6, 8, { weldId: 'weld-2', segment: 3, station: 40, length: 15, contactLength: 100,
      parts: ['component-1', 'component-2'] }).options;
    expect(filletWeldSegmentOptions(valid)).toEqual({ weldId: 'weld-2', segment: 3, station: 40, length: 15, contactLength: 100,
      parts: ['component-1', 'component-2'] });
    // 1 欄だけを壊した保存値。要素の型を保存の形(文字列の欄の表)に揃える(欠けた鍵が undefined にならない)。
    const brokenFields: readonly Readonly<Record<string, string>>[] = [
      { weldSegment: '9007199254740993' }, { weldSegment: '100' }, { weldSegment: '01' }, { weldSegment: '-1' }, { weldSegment: '1.5' },
      { weldParts: 'component-1,component-1' }, { weldStation: '90' }, { weldStation: '-0.0000005' }, { contactLength: '50' },
    ];
    for (const broken of brokenFields) {
      expect(filletWeldSegmentOptions({ ...valid, ...broken }), JSON.stringify(broken)).toBeNull();
    }
  });
});
