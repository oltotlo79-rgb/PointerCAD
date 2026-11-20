/**
 * 管用ねじの表の検査: 規格の式(P = 25.4 ÷ n、h = 0.640327P、r = 0.137278P、d2 = d − h、d1 = d − 2h)と表の値が、表の桁で一致する事、
 * テーパねじの 15 の呼びと平行ねじの 23 の呼びが引けて、呼びが細い順に外径が増え、テーパねじの基準の長さが減らない事。
 * 2 つ目の出どころとの照らしは catalog/families/pipeFittingOracle.test.ts。
 */
import { describe, expect, it } from 'vitest';

import { findPipeThread } from './pipeThread.js';

const TAPER_SIZES = ['1/16', '1/8', '1/4', '3/8', '1/2', '3/4', '1', '1 1/4', '1 1/2', '2', '2 1/2', '3', '4', '5', '6'];
const PARALLEL_SIZES = ['1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8', '1', '1 1/8', '1 1/4', '1 1/2', '1 3/4', '2', '2 1/4', '2 1/2',
  '2 3/4', '3', '3 1/2', '4', '4 1/2', '5', '5 1/2', '6'];
const CASES = [...TAPER_SIZES.map((size) => ['taper', size] as const), ...PARALLEL_SIZES.map((size) => ['parallel', size] as const)];

/** 表の桁(ピッチは 4 桁、ほかは 3 桁、丸みは 2 桁)で丸める。 */
const rounded = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

function threadOf(standard: 'taper' | 'parallel', size: string): NonNullable<ReturnType<typeof findPipeThread>> {
  const thread = findPipeThread(standard, size);
  if (thread === undefined) throw new Error(`${standard} の呼び ${size} が無い`);
  return thread;
}

describe('管用ねじの表', () => {
  it.each(CASES)('%s の呼び %s: ピッチ・山の高さ・丸み・有効径・谷の径が規格の式と表の桁で一致する', (standard, size) => {
    const thread = threadOf(standard, size);
    expect(rounded(25.4 / thread.threadsPerInch, 4)).toBe(thread.pitch);
    expect(rounded(0.640327 * thread.pitch, 3)).toBe(thread.height);
    expect(rounded(0.137278 * thread.pitch, 2)).toBe(thread.roundness);
    expect(rounded(thread.majorDiameter - thread.height, 3)).toBe(thread.pitchDiameter);
    expect(rounded(thread.majorDiameter - 2 * thread.height, 3)).toBe(thread.minorDiameter);
  });

  it('テーパねじの 15 の呼びは細い順に外径が増え、基準の長さは減らない。表に無い呼びは引けない', () => {
    const threads = TAPER_SIZES.map((size) => threadOf('taper', size));
    threads.slice(1).forEach((thread, index) => {
      const previous = threads[index];
      expect(thread.majorDiameter).toBeGreaterThan(previous?.majorDiameter ?? Infinity);
      expect(thread.gaugeLength ?? -Infinity).toBeGreaterThanOrEqual(previous?.gaugeLength ?? Infinity);
    });
    expect(threadOf('taper', '1/2').majorDiameter).toBe(20.955);
    expect(findPipeThread('taper', '7')).toBeUndefined();
    expect(findPipeThread('taper', '5/8')).toBeUndefined();
  });

  it('平行ねじの 23 の呼びは細い順に外径が増え、基準の長さを持たない。同じ呼びのテーパねじと外径・山数が同じ。G1/16 は引けない', () => {
    const threads = PARALLEL_SIZES.map((size) => threadOf('parallel', size));
    threads.slice(1).forEach((thread, index) => {
      expect(thread.majorDiameter).toBeGreaterThan(threads[index]?.majorDiameter ?? Infinity);
    });
    expect(threads.every((thread) => thread.gaugeLength === null)).toBe(true);
    for (const size of TAPER_SIZES.slice(1)) {
      const taper = threadOf('taper', size), parallel = threadOf('parallel', size);
      expect([parallel.majorDiameter, parallel.threadsPerInch], size).toEqual([taper.majorDiameter, taper.threadsPerInch]);
    }
    expect(findPipeThread('parallel', '1/16')).toBeUndefined();
  });
});
