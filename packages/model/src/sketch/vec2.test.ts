import { describe, expect, it } from 'vitest';
import { crossVec2 } from './vec2.js';

describe('ordered two-dimensional determinant', () => {
  it('retains orientation, signed zero and non-finite arithmetic', () => {
    expect(crossVec2([2, 3], [5, 7])).toBe(-1);
    expect(crossVec2([5, 7], [2, 3])).toBe(1);
    expect(Object.is(crossVec2([-0, 0], [0, 1]), -0)).toBe(true);
    expect(Object.is(crossVec2([0, -0], [1, 0]), 0)).toBe(true);
    expect(crossVec2([Number.MAX_VALUE, 0], [0, 2])).toBe(Infinity);
    expect(crossVec2([Infinity, Infinity], [1, 1])).toBeNaN();
  });

  it('reads each input coordinate once in the original multiplication order', () => {
    const reads: string[] = [];
    const a: [number, number] = [2, 3];
    const b: [number, number] = [5, 7];
    const left = new Proxy(a, { get(target, key) {
      reads.push('a.' + String(key));
      if (key === '0') return target[0];
      if (key === '1') return target[1];
      throw new Error('Unexpected coordinate access');
    } });
    const right = new Proxy(b, { get(target, key) {
      reads.push('b.' + String(key));
      if (key === '0') return target[0];
      if (key === '1') return target[1];
      throw new Error('Unexpected coordinate access');
    } });
    expect(crossVec2(left, right)).toBe(-1);
    expect(reads).toEqual(['a.0', 'b.1', 'a.1', 'b.0']);
  });
});
