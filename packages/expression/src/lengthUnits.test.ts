import { describe, expect, it } from 'vitest';

import {
  LENGTH_UNITS,
  lengthUnitFactor,
  MM_PER_INCH_TEXT,
  toLengthUnit,
} from './lengthUnits.js';

/**
 * 期待値の出どころ:
 * 倍率 25.4 は国際インチの定義値(1 inch = 25.4 mm、厳密)。
 * `packages/model/src/units/length.ts` の `MM_PER_INCH` と同じ値になるが、
 * 依存方向(rules/04)によりそれぞれが持つので、ここでは 25.4 を直接書いて固定する。
 */
describe('長さの単位の表(FR-814、計画書 docs/plans/P6-入出力.md §2.9.1)', () => {
  it('置く単位は mm / in / " の 3 つだけ(cm・m は要件に無いので足さない)', () => {
    expect(LENGTH_UNITS).toEqual(['mm', 'in', '"']);
  });

  it('倍率は mm が 1、in と " が 25.4(10 進の文字列で厳密に持つ)', () => {
    expect(lengthUnitFactor('mm')).toBe('1');
    expect(lengthUnitFactor('in')).toBe('25.4');
    expect(lengthUnitFactor('"')).toBe('25.4');
    expect(MM_PER_INCH_TEXT).toBe('25.4');
  });

  it('綴りは大文字小文字を問わず、正規形(小文字)へ直す', () => {
    expect(toLengthUnit('mm')).toBe('mm');
    expect(toLengthUnit('MM')).toBe('mm');
    expect(toLengthUnit('Mm')).toBe('mm');
    expect(toLengthUnit('in')).toBe('in');
    expect(toLengthUnit('IN')).toBe('in');
    expect(toLengthUnit('In')).toBe('in');
    expect(toLengthUnit('"')).toBe('"');
  });

  it('単位でない綴りは null(cm・m・ft・inch は受けない)', () => {
    expect(toLengthUnit('cm')).toBeNull();
    expect(toLengthUnit('m')).toBeNull();
    expect(toLengthUnit('ft')).toBeNull();
    expect(toLengthUnit('inch')).toBeNull();
    expect(toLengthUnit("'")).toBeNull();
    expect(toLengthUnit('')).toBeNull();
    expect(toLengthUnit('板厚')).toBeNull();
  });
});
