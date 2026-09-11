import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSheetMetalLBend, type SheetMetalLBendInput } from './makeSheetMetalBend.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

const input: SheetMetalLBendInput = { thickness: 2, radius: 3, width: 20, firstLength: 50, secondLength: 30, angle: 90 };
let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
describe('P10-1 円筒曲げのL板と資源所有者', () => {
  it.each([90, -90, 45, -45])('角度%dで有効な厚み付き立体ができ、円筒殻と直線板の手計算体積に一致する', (angle) => {
    const handle = makeSheetMetalLBend(oc, { ...input, angle });
    try {
      expect(hasSolid(oc, handle.shape)).toBe(true); expect(isValidShape(oc, handle.shape)).toBe(true);
      // 円筒殻の面積 = 1/2*(25-9)*theta、直線部面積 = (50+30)*2。
      const expected = 20 * (160 + 8 * Math.abs(angle) * Math.PI / 180);
      expect(Math.abs(measureVolume(oc, handle.shape) - expected) / expected).toBeLessThan(1e-6);
    } finally { handle.delete(); }
    expect(() => handle.delete()).not.toThrow();
  });
  it('別の形を保持したまま不正入力を断り、直後に同じ入力を再生成できる', () => {
    const existing = makeSheetMetalLBend(oc, input);
    try {
      const volume = measureVolume(oc, existing.shape);
      for (const change of [{ thickness: 0 }, { radius: -1 }, { angle: 180 }, { angle: Number.NaN }, { width: Number.POSITIVE_INFINITY }]) {
        expect(() => makeSheetMetalLBend(oc, { ...input, ...change })).toThrow();
        expect(measureVolume(oc, existing.shape)).toBe(volume);
      }
      for (let index = 0; index < 20; index++) {
        const repeated = makeSheetMetalLBend(oc, input);
        try { expect(measureVolume(oc, repeated.shape)).toBe(volume); } finally { repeated.delete(); }
      }
    } finally { existing.delete(); }
  });
});
