import { describe, expect, it } from 'vitest';
import { cadWeldThroatFrame } from './cadWeldThroatFrame.js';

describe('保存した実断面の有効のどframe', () => {
  it.each([
    [6, 8, {}, 4.8, .8, .6],
    [6, 8, { interiorAngleDegrees: 60 }, 12 * Math.sqrt(3 / 13), 2 * Math.sqrt(3 / 13), 1 / Math.sqrt(13)],
    [5 * Math.PI / 3, 6, { cylindricalRadius: 10 }, 3.3780041879094953, .8264564199451158, .5630006979849158],
    [5 * Math.PI / 3, 6, { cylindricalRadius: 10, cylindricalSide: 'interior' as const }, 4.389138483845052, .6818166780665695, .731523080640842],
  ] as const)('脚%s/%sの自由面の内点投影を独立値で照合する', (a, b, options, h, dx, dy) => {
    const before = structuredClone(options), actual = cadWeldThroatFrame(a, b, options);
    expect(actual).not.toBeNull();
    expect(actual?.heightMm).toBeCloseTo(h, 12);
    expect(actual?.direction[0]).toBeCloseTo(dx, 12);
    expect(actual?.direction[1]).toBeCloseTo(dy, 12);
    expect(options).toEqual(before);
  });

  it('円弧長を弦長と取り違えた断面を同じのどとして返さない', () => {
    const actual = cadWeldThroatFrame(5, 6, { cylindricalRadius: 10 });
    expect(actual).not.toBeNull();
    expect(Math.abs((actual?.heightMm ?? NaN) - 3.3780041879094953)).toBeGreaterThan(.01);
  });

  it.each([
    [1, 2, { interiorAngleDegrees: 30 }],
    [1, 2, { interiorAngleDegrees: 60 }],
    [2, 1, { interiorAngleDegrees: 30 }],
    [10 * .6, 1, { cylindricalRadius: 10 }],
    [10, 1, { cylindricalRadius: 10, cylindricalSide: 'interior' as const }],
    [2, 20, { cylindricalRadius: 10, cylindricalSide: 'interior' as const }],
    [2, 3, { cylindricalRadius: 10, interiorAngleDegrees: 60 }],
    [2, 3, { cylindricalSide: 'interior' as const }],
    [0, 3, {}], [NaN, 3, {}], [2, Infinity, {}],
    [2, 3, { cylindricalRadius: -1 }], [2, 3, { interiorAngleDegrees: 90 }],
  ] as const)('端点/外点投影・材料侵入・不正断面%s/%sを拒否する', (a, b, options) => {
    expect(cadWeldThroatFrame(a, b, options)).toBeNull();
  });
});
