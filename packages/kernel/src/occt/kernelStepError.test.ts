/**
 * 失敗の種類を文ではなく符号で運ぶ(0b-1、kernelStepError.ts)。立体が残らない断りは、文はそのままで符号 'nothingLeft' を持ち、
 * 包み直す所(isNothingLeft)は文ではなく符号で見分ける。
 */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { booleanOp } from './booleanOp.js';
import { isNothingLeft, KernelStepError } from './kernelStepError.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });

/** 投げられた物を返す(投げなければ検査を止める)。 */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('断られなかった');
}

describe('計算部の段の失敗の符号', () => {
  it('含まれている側から含んでいる側を引くと、文はそのままで符号 nothingLeft を持つ', () => {
    const big = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const small = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      const error = thrown(() => booleanOp(oc, 'subtract', small.shape, big.shape));
      expect(error).toBeInstanceOf(KernelStepError);
      expect(error).toMatchObject({ code: 'nothingLeft', message: '組み合わせた結果、ソリッドが残りませんでした。' });
      expect(isNothingLeft(error)).toBe(true);
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('同じ文でも符号の無い誤りと、ほかの符号は nothingLeft と見なさない', () => {
    expect(isNothingLeft(new Error('組み合わせた結果、ソリッドが残りませんでした。'))).toBe(false);
    expect(isNothingLeft(new KernelStepError('missingSubShape', '選んだ面(辺)が見つかりません。'))).toBe(false);
    expect(isNothingLeft('nothingLeft')).toBe(false);
  });
});
