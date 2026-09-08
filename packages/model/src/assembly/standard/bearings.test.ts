import { describe, expect, it } from 'vitest';

import {
  bearingBoreFromDesignation, bearingSizes, DEEP_GROOVE_BALL_BEARINGS,
  findDeepGrooveBallBearing,
} from './bearings.js';

describe('深溝玉軸受の寸法表', () => {
  it('3系列×内径5段階の15行を持つ', () => {
    expect(DEEP_GROOVE_BALL_BEARINGS).toHaveLength(15);
    expect(bearingSizes('6000')).toHaveLength(5);
    expect(bearingSizes('6200')).toHaveLength(5);
    expect(bearingSizes('6300')).toHaveLength(5);
  });

  it('呼び番号は重複せず、全行で外径が内径より大きい', () => {
    expect(new Set(DEEP_GROOVE_BALL_BEARINGS.map((row) => row.size)).size).toBe(15);
    expect(DEEP_GROOVE_BALL_BEARINGS.every((row) => row.outsideDiameter > row.boreDiameter)).toBe(true);
  });

  it('6000は10×26×8mm', () => {
    expect(findDeepGrooveBallBearing('6000')).toMatchObject({
      boreDiameter: 10, outsideDiameter: 26, width: 8, minimumChamfer: 0.3,
    });
  });

  it('6200は10×30×9mm', () => {
    expect(findDeepGrooveBallBearing('6200')).toMatchObject({
      boreDiameter: 10, outsideDiameter: 30, width: 9, minimumChamfer: 0.6,
    });
  });

  it('同じ内径なら6200系列の外径が6000系列より大きい', () => {
    for (const bore of [10, 20, 30, 40, 50]) {
      const light = DEEP_GROOVE_BALL_BEARINGS.find(
        (row) => row.series === '6000' && row.boreDiameter === bore,
      );
      const medium = DEEP_GROOVE_BALL_BEARINGS.find(
        (row) => row.series === '6200' && row.boreDiameter === bore,
      );
      expect(medium?.outsideDiameter).toBeGreaterThan(light?.outsideDiameter ?? Number.POSITIVE_INFINITY);
    }
  });

  it.each([
    ['6000', 10], ['6001', 12], ['6002', 15], ['6003', 17], ['6004', 20], ['6310', 50],
  ])('呼び番号%sから内径%smmを導く', (designation, expected) => {
    expect(bearingBoreFromDesignation(designation)).toBe(expected);
  });

  it('4桁でない呼び番号は断る', () => {
    expect(bearingBoreFromDesignation('600')).toBeNull();
    expect(bearingBoreFromDesignation('60A0')).toBeNull();
    expect(findDeepGrooveBallBearing('9999')).toBeUndefined();
  });
});
