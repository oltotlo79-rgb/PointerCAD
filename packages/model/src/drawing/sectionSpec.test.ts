import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';

import { createCuttingLine, sectionLetter, validateSectionSpec, type SectionSpec } from './sectionSpec.js';

const plane: SectionSpec['plane'] = {
  kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(0),
};

describe('sectionSpec', () => {
  it('見る側を反転すると両端の矢印だけが逆を向く', () => {
    const right = createCuttingLine([[0, 0], [10, 0]], 0, 'right');
    const left = createCuttingLine([[0, 0], [10, 0]], 0, 'left');
    expect(right?.arrows.map((arrow) => arrow.direction[1])).toEqual([1, 1]);
    expect(left?.arrows.map((arrow) => arrow.direction[1])).toEqual([-1, -1]);
    expect(right?.chain).toEqual(left?.chain);
  });
  it('非有限の境界と3点の半断面をカーネルに渡す前に断る', () => {
    expect(createCuttingLine([[0, 0], [Infinity, 0]], 0)).toBeNull();
    expect(validateSectionSpec({ kind: 'half', plane, keepSide: 'positive', boundary: [[0, 0], [1, 0], [2, 0]] })).not.toBeNull();
    expect(validateSectionSpec({ kind: 'local', plane, keepSide: 'negative', boundary: [[0, 0], [1, 0], [0, NaN]] })).not.toBeNull();
  });
  it.each([[0, 'A'], [25, 'Z'], [26, 'AA'], [27, 'AB']] as const)(
    '符号 %i を %s にする', (index, expected) => expect(sectionLetter(index)).toBe(expected),
  );
  it('切断線は細い一点鎖線、全頂点の太線、2矢印、A–Aを返す', () => {
    const result = createCuttingLine([[0, 0], [10, 0], [10, 10]], 0);
    expect(result?.chain).toHaveLength(2);
    expect(result?.chain.every((line) => line.style === 'thin-chain')).toBe(true);
    expect(result?.heavyMarks).toHaveLength(3);
    expect(result?.heavyMarks.every((line) => line.style === 'thick-solid')).toBe(true);
    expect(result?.arrows).toHaveLength(2);
    expect(result?.title).toBe('A–A');
  });
  it('退化した切断線を断る', () => {
    expect(createCuttingLine([[0, 0], [0, 0]], 0)).toBeNull();
  });
  it.each([Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('不正な符号番号 %s を無限ループさせず断る', (index) => {
    expect(() => sectionLetter(index)).toThrow(RangeError);
    expect(createCuttingLine([[0, 0], [10, 0]], index)).toBeNull();
  });
  it('段付きは横座標順と幅を要求し、垂直な段差を許す', () => {
    const spec = { kind: 'stepped', plane, keepSide: 'positive' } as const;
    expect(validateSectionSpec({ ...spec, boundary: [[0, 0], [10, 0], [10, 5], [20, 5]] })).toBeNull();
    for (const boundary of [
      [[0, 0], [10, 0], [5, 5]], [[0, 0], [0, 5]],
      [[0, 0], [10, 0], [10, 5], [10, 2], [20, 2]], [[0, 0], [0, 0], [10, 0]],
    ] as const) expect(validateSectionSpec({ ...spec, boundary })).not.toBeNull();
  });
  it('半断面の同一点と部分断面の交差を断る', () => {
    expect(validateSectionSpec({ kind: 'half', plane, keepSide: 'positive', boundary: [[1, 2], [1, 2]] })).not.toBeNull();
    expect(validateSectionSpec({ kind: 'local', plane, keepSide: 'positive', boundary: [[0, 0], [10, 10], [0, 10], [10, 0]] })).not.toBeNull();
  });
  it.each(['full', 'revolved'] as const)('%s は境界なしで有効', (kind) => {
    expect(validateSectionSpec({ kind, plane, keepSide: 'positive' })).toBeNull();
  });
  it('half は中心線の2点を要求する', () => {
    expect(validateSectionSpec({ kind: 'half', plane, keepSide: 'positive' })).not.toBeNull();
    expect(validateSectionSpec({ kind: 'half', plane, keepSide: 'positive', boundary: [[0, 0], [1, 0]] })).toBeNull();
  });
  it('local は閉じた輪郭に足る3点を要求する', () => {
    expect(validateSectionSpec({ kind: 'local', plane, keepSide: 'negative', boundary: [[0, 0], [1, 0]] })).not.toBeNull();
    expect(validateSectionSpec({ kind: 'local', plane, keepSide: 'negative', boundary: [[0, 0], [1, 0], [0, 1]] })).toBeNull();
  });
});
