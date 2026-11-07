import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import { R22_THIN_SOLIDS } from './geometryAcceptanceFixtures.js';
import {
  GEOMETRIC_CONFUSION_MM,
  validateToleranceMm,
} from './tolerances.js';

/** R22 の近接の入力(booleanOp.test.ts と同じ値。もとは geometryAcceptanceFixtures.ts の検査用の値)。 */
const R22_NEAR_CONTACT = {
  overlapMm: 1e-4,
  intersectionVolumeMm3: 0.04,
  subtractVolumeMm3: 7999.96,
  unionVolumeMm3: 15999.96,
} as const;

/** 面の縫合で隙間を修復する幅の既定値(mm)。model の既定値 0.01 mm と同じ。 */
const DEFAULT_SEWING_REPAIR_TOLERANCE_MM = 0.01;

/** 修復幅の上限(mm)。製品の値と同じ 1 を、拒む文言と境目(1 は受理、1 を少し超えると拒む)で確かめる。 */
const MAXIMUM_SEWING_REPAIR_TOLERANCE_MM = 1;

describe('用途別の許容誤差', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('幾何一致・縫合修復・近似曲面の値を別々に保つ', () => {
    expect(GEOMETRIC_CONFUSION_MM).toBe(1e-7);
    expect(() => validateToleranceMm(1.000001)).toThrow('つなぎ目の許容量は 1 mm 以下にしてください。');
  });

  it('固定 OCCT WASM の幾何一致と角度の実測値に一致する', () => {
    expect(oc.Precision.Confusion()).toBe(GEOMETRIC_CONFUSION_MM);
    expect(oc.Precision.Angular()).toBe(1e-12);
  });

  it('R22 の近接・薄板・短辺は修復幅へ丸めず、幾何一致幅と別の寸法として保つ', () => {
    expect(R22_NEAR_CONTACT.overlapMm / GEOMETRIC_CONFUSION_MM).toBeCloseTo(1000, 9);
    expect(R22_THIN_SOLIDS[0].size[2]).toBe(0.001);
    expect(R22_THIN_SOLIDS[1].size[0]).toBe(0.0001);
    expect(R22_THIN_SOLIDS[0].size[2]).toBeLessThan(DEFAULT_SEWING_REPAIR_TOLERANCE_MM);
    expect(R22_THIN_SOLIDS[1].size[0]).toBeLessThan(DEFAULT_SEWING_REPAIR_TOLERANCE_MM);
    expect(R22_THIN_SOLIDS[1].size[0]).toBeGreaterThan(GEOMETRIC_CONFUSION_MM);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0.01])(
    '有限の正数でない修復幅 %s を拒む',
    (value) => {
      expect(() => validateToleranceMm(value)).toThrow(
        'つなぎ目の許容量は 0 より大きい数にしてください。',
      );
    },
  );

  it('上限を超える修復幅を拒む', () => {
    expect(() => validateToleranceMm(MAXIMUM_SEWING_REPAIR_TOLERANCE_MM + 0.01)).toThrow(
      'つなぎ目の許容量は 1 mm 以下にしてください。',
    );
  });

  it.each([GEOMETRIC_CONFUSION_MM, DEFAULT_SEWING_REPAIR_TOLERANCE_MM, 1])(
    '正常な修復幅 %s mm をそのまま受理する',
    (value) => {
      expect(validateToleranceMm(value)).toBe(value);
    },
  );
});
