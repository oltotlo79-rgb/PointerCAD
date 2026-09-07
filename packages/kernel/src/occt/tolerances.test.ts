import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import {
  DEFAULT_SEWING_REPAIR_TOLERANCE_MM,
  GEOMETRIC_CONFUSION_MM,
  MAXIMUM_SEWING_REPAIR_TOLERANCE_MM,
  THRU_SECTIONS_APPROXIMATION_TOLERANCE_MM,
  validateToleranceMm,
} from './tolerances.js';

describe('用途別の許容誤差', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('幾何一致・縫合修復・近似曲面の値を別々に保つ', () => {
    expect(GEOMETRIC_CONFUSION_MM).toBe(1e-7);
    expect(DEFAULT_SEWING_REPAIR_TOLERANCE_MM).toBe(0.01);
    expect(THRU_SECTIONS_APPROXIMATION_TOLERANCE_MM).toBe(1e-6);
    expect(MAXIMUM_SEWING_REPAIR_TOLERANCE_MM).toBe(1);
  });

  it('固定 OCCT WASM の幾何一致と角度の実測値に一致する', () => {
    expect(oc.Precision.Confusion()).toBe(GEOMETRIC_CONFUSION_MM);
    expect(oc.Precision.Angular()).toBe(1e-12);
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
