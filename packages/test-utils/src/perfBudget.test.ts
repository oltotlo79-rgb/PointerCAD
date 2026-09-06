import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectWithinBudget } from './perfBudget.js';

/**
 * 判定の切替そのものを検査する。
 *
 * この関数は「上限を緩めずに、落とすか記録にとどめるかだけを切り替える」ためのもの
 * (`rules/03-品質ゲート.md` §7.1)。切替の合図は `POINTERCAD_PERF_STRICT` で、
 * `scripts/check.ps1` が `-Level Push`(CI 以外)のときだけ `'1'` を入れる。
 * ここでは環境変数を直接動かして、同じ実測・同じ上限でも結果が変わることを確かめる。
 */
describe('expectWithinBudget', () => {
  // 検査の中で環境変数を書き換えるので、元の値へ必ず戻す(他の検査へ漏らさないため)。
  const originalFlag = process.env.POINTERCAD_PERF_STRICT;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.POINTERCAD_PERF_STRICT;
    } else {
      process.env.POINTERCAD_PERF_STRICT = originalFlag;
    }
    vi.restoreAllMocks();
  });

  it('厳密(POINTERCAD_PERF_STRICT=1)のとき、上限を超えたら落ちる', () => {
    process.env.POINTERCAD_PERF_STRICT = '1';

    // 収まっているときは何も起きない。
    expect(() => {
      expectWithinBudget(4.0, 5.0, '収まっている例');
    }).not.toThrow();

    // 超えたら検査を落とす(上限の数値は呼び出し側のまま。緩めていない)。
    expect(() => {
      expectWithinBudget(6.0, 5.0, '超えた例');
    }).toThrow();
  });

  it('参考(合図が無い)のとき、上限を超えても落ちず、実測と上限をログへ残す', () => {
    delete process.env.POINTERCAD_PERF_STRICT;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => {
      expectWithinBudget(6.0, 5.0, '超えた例');
    }).not.toThrow();

    // 実測と上限を人が読める形で残すことまで確かめる(何の所要かの名前・実測・上限の 3 つ)。
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[参考] 上限超過: 超えた例'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('実測 6.0 ms'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('上限 5 ms'));

    // 収まっているときは参考モードでも何も出さない。
    expectWithinBudget(4.0, 5.0, '収まっている例');
    expect(log).toHaveBeenCalledTimes(1);
  });
});
