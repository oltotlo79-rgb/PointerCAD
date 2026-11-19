import { describe, expect, it } from 'vitest';

import { currentGridSetting, DEFAULT_GRID_SETTING, gridSettingOf, validGridCount, validGridStep } from './gridSetting.js';

/* 配置の補助 P-C: 方眼の幅と数(利用者ごとの表示の設定)。既定は自動で、今までと同じ。 */
describe('方眼の幅と数の設定', () => {
  it('既定は自動(固定へ切り替えた時の初めの値は 10 mm × 20 本)', () => {
    expect(DEFAULT_GRID_SETTING).toEqual({ mode: 'auto', stepMm: 10, count: 20 });
    expect(currentGridSetting(undefined)).toBe(DEFAULT_GRID_SETTING);
    expect(currentGridSetting({})).toBe(DEFAULT_GRID_SETTING);
  });

  it('保存の値は形と範囲を確かめて読み、違う物は既定へ戻す', () => {
    expect(gridSettingOf({ mode: 'fixed', stepMm: 200, count: 5 })).toEqual({ mode: 'fixed', stepMm: 200, count: 5 });
    for (const raw of [null, 'fixed', [], { mode: 'huge', stepMm: 10, count: 5 }, { mode: 'fixed', stepMm: '10', count: 5 },
      { mode: 'fixed', stepMm: 0, count: 5 }, { mode: 'fixed', stepMm: 10, count: 2.5 }, { mode: 'fixed', stepMm: 10, count: 51 }]) {
      expect(gridSettingOf(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(currentGridSetting({ grid: { mode: 'fixed', stepMm: Number.NaN, count: 5 } })).toBe(DEFAULT_GRID_SETTING);
  });

  it('読める保存の値は同じ参照で返す(画面の選び出しが毎回新しい物を返して描き直しが止まらなくならないように)', () => {
    const stored = { mode: 'fixed', stepMm: 200, count: 5 } as const;
    expect(currentGridSetting({ grid: stored })).toBe(stored);
    expect(currentGridSetting({ grid: DEFAULT_GRID_SETTING })).toBe(DEFAULT_GRID_SETTING);
  });

  it('幅は 0.1〜10000 mm、片側の線の数は 1〜50 の整数', () => {
    expect([validGridStep(0.1), validGridStep(0.09), validGridStep(10_000), validGridStep(10_001)]).toEqual([true, false, true, false]);
    expect([validGridCount(1), validGridCount(0), validGridCount(50), validGridCount(51)]).toEqual([true, false, true, false]);
  });
});
