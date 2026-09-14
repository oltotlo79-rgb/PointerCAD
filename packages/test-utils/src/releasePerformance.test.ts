import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportDuration, reportViewportRate } from './releasePerformance.js';

afterEach(() => vi.restoreAllMocks());

describe('速度目標の未達を記録し、異常値と実用上の大幅な遅延を拒否する', () => {
  it('目標未達でも境界内の完了値を保持し、短い処理を100msより厳しく制限しない', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(reportDuration(22, 16, '寸法移動')).toMatchObject({ actual: 22, target: 16, meetsTarget: false, usable: true });
    expect(reportDuration(100, 16, '寸法移動').usable).toBe(true);
    expect(() => reportDuration(100.01, 16, '寸法移動')).toThrow('実用上の遅延');
    expect(reportDuration(0, 500, '計測分解能以下').usable).toBe(true);
    expect(reportDuration(2_500, 500, '典型形状').usable).toBe(true);
    expect(() => reportDuration(2_501, 500, '典型形状')).toThrow('実用上の遅延');
  });

  it('描画の元の30fps目標を記録し、10fpsの境界と停止を区別する', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(reportViewportRate(26.662, '50部品')).toMatchObject({ target: 30, meetsTarget: false, usable: true });
    expect(reportViewportRate(10, '50部品').usable).toBe(true);
    expect(reportViewportRate(60, '50部品').meetsTarget).toBe(true);
    expect(() => reportViewportRate(9.99, '50部品')).toThrow('実用上の遅延');
    expect(() => reportViewportRate(0, '50部品')).toThrow('実用上の遅延');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])('不正な実測%sを成功にしない', actual => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => reportDuration(actual, 500, '測定')).toThrow('不正');
    expect(() => reportViewportRate(actual, '測定')).toThrow('不正');
    expect(log).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, Number.MAX_VALUE])('不正または許容境界が表現できない目標%sを拒否する', target => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => reportDuration(1, target, '測定')).toThrow('不正');
  });

  it('対象名の欠落を拒否して追跡不能な測定を作らない', () => {
    expect(() => reportDuration(1, 5, ' ')).toThrow('不正');
  });
});
