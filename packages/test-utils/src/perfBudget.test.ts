import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectWithinBudget } from './perfBudget.js';

/**
 * 既存の全パッケージ用入口にも、正確性を優先する共通判定が届くことを検査する。
 *
 * 旧環境変数の有無で速度目標の厳密判定が復活したり、大幅な遅延を見逃したりしない。
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

  it('旧厳密指定でも目標超過を記録に留め、大幅な遅延は拒否する', () => {
    process.env.POINTERCAD_PERF_STRICT = '1';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // 収まっているときは何も起きない。
    expect(() => {
      expectWithinBudget(4.0, 5.0, '収まっている例');
    }).not.toThrow();

    // 元の目標を少し超えても機能の失敗にはしない。
    expect(() => {
      expectWithinBudget(6.0, 5.0, '超えた例');
    }).not.toThrow();
    expect(() => expectWithinBudget(101, 5, '実用上の遅延')).toThrow('実用上の遅延');
  });

  it('旧指定が無くても同じ判定で実測・改善目標・実用上限を記録する', () => {
    delete process.env.POINTERCAD_PERF_STRICT;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => {
      expectWithinBudget(6.0, 5.0, '超えた例');
    }).not.toThrow();

    // 実測と上限を人が読める形で残すことまで確かめる(何の所要かの名前・実測・上限の 3 つ)。
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[性能記録]', expect.stringContaining('"label":"超えた例"'));
    expect(log).toHaveBeenCalledWith('[性能記録]', expect.stringContaining('"actual":6'));
    expect(log).toHaveBeenCalledWith('[性能記録]', expect.stringContaining('"target":5'));
    expect(log).toHaveBeenCalledWith('[性能記録]', expect.stringContaining('"meetsTarget":false'));

    // 目標に収まった実績も同じ形式で保持する。
    expectWithinBudget(4.0, 5.0, '収まっている例');
    expect(log).toHaveBeenCalledTimes(2);
    expect(() => expectWithinBudget(101, 5, '実用上の遅延')).toThrow('実用上の遅延');
  });
});
