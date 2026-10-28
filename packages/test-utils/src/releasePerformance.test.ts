import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeDuration, observePositiveDuration, observeViewportRate, observeStartupReuse, reportDuration, reportViewportRate } from './releasePerformance.js';

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

  it('次の面までの押し出しは500ms目標と実測を残し、5秒超を拒否する', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(reportDuration(3_379.5556, 500, '次の面まで', 'solid-end')).toMatchObject({
      actual: 3_379.5556, target: 500, practicalLimit: 5_000, meetsTarget: false, usable: true,
    });
    expect(reportDuration(5_000, 500, '次の面まで', 'solid-end').usable).toBe(true);
    expect(() => reportDuration(5_000.01, 500, '次の面まで', 'solid-end')).toThrow('実用上の遅延');
    expect(() => reportDuration(3_379.5556, 500, '通常の短い操作')).toThrow('実用上の遅延');
  });

  it('描画の元の30fps目標を記録し、10fpsの境界と停止を区別する', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(reportViewportRate(26.662, '50部品')).toMatchObject({ target: 30, meetsTarget: false, usable: true });
    expect(reportViewportRate(10, '50部品').usable).toBe(true);
    expect(reportViewportRate(60, '50部品').meetsTarget).toBe(true);
    expect(() => reportViewportRate(9.99, '50部品')).toThrow('実用上の遅延');
    expect(() => reportViewportRate(0, '50部品')).toThrow('実用上の遅延');
  });

  it.each([500, 2_000])('干渉計算の目標%sは保持し、部品数によらず10秒を超えたら拒否する', target => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(reportDuration(4_939.5501, target, '干渉', 'interference')).toMatchObject({
      target, actual: 4_939.5501, practicalLimit: 10_000, meetsTarget: false, usable: true,
    });
    expect(reportDuration(10_000, target, '干渉', 'interference').usable).toBe(true);
    expect(() => reportDuration(10_001, target, '干渉', 'interference')).toThrow('実用上の遅延');
    expect(() => reportDuration(4_939.5501, 500, '通常の短い操作')).toThrow('実用上の遅延');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])('不正な実測%sを成功にしない', actual => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => reportDuration(actual, 500, '測定')).toThrow('不正');
    expect(() => reportDuration(actual, 500, '測定', 'interference')).toThrow('不正');
    expect(() => reportDuration(actual, 500, '測定', 'solid-end')).toThrow('不正');
    expect(() => reportViewportRate(actual, '測定')).toThrow('不正');
    expect(log).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, Number.MAX_VALUE])('不正または許容境界が表現できない目標%sを拒否する', target => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => reportDuration(1, target, '測定')).toThrow('不正');
    expect(() => reportDuration(1, target, '測定', 'interference')).toThrow('不正');
    expect(() => reportDuration(1, target, '測定', 'solid-end')).toThrow('不正');
  });

  it('対象名の欠落を拒否して追跡不能な測定を作らない', () => {
    expect(() => reportDuration(1, 5, ' ')).toThrow('不正');
  });
});

describe('機能の合否から分離した参考時間の観測', () => {
  it.each([127.925, 236.33])('100ms超の実測%sも保持し、目標未達の観測として記録する', actualMs => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const observation = observeDuration(actualMs, 100, '1000点の実scene描画');
    expect(observation).toEqual({ label: '1000点の実scene描画', actualMs, referenceTargetMs: 100,
      meetsTarget: false, decisionUse: 'observation' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[性能観測]', JSON.stringify(observation));
  });

  it('ゼロと目標ちょうどを保持し、有限な参考目標に別の上限を作らない', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(observeDuration(0, 100, '分解能以下').meetsTarget).toBe(true);
    expect(observeDuration(100, 100, '目標ちょうど').meetsTarget).toBe(true);
    expect(observeDuration(Number.MAX_VALUE, Number.MAX_VALUE, '有限最大値').meetsTarget).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])('不正実測%sを観測成功にしない', actual => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => observeDuration(actual, 100, '実測')).toThrow('不正');
    expect(log).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0])('不正参考目標%sを拒否する', target => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => observeDuration(1, target, '実測')).toThrow('不正');
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '\t'])('名前欠落%sを拒否し追跡不能な観測を作らない', label => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => observeDuration(1, 100, label)).toThrow('不正');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('cold/warmの根拠なし比率目標を機能の合否へ転用しない', () => {
  it.each([
    { warm: 70, ratio: .7, meetsTarget: true },
    { warm: 80, ratio: .8, meetsTarget: true },
    { warm: 120, ratio: 1.2, meetsTarget: false },
  ])('中央値比率$ratioを未達も含めて記録する', ({ warm, ratio, meetsTarget }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const coldValues = [100, 1, 101, 99, 900], warmValues = [warm, warm-1, warm+1, 2, 1000];
    const before = structuredClone({ coldValues, warmValues });
    const observed = observeStartupReuse(coldValues, warmValues, 'OCCT 5組');
    expect(observed).toEqual({ label: 'OCCT 5組', cold: 100, warm, ratio, referenceRatio: .8,
      meetsTarget, decisionUse: 'observation' });
    expect({ coldValues, warmValues }).toEqual(before);
    expect(log).toHaveBeenCalledWith('[性能観測]', JSON.stringify(observed));
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('不正標本%sを中央値で隠さない', value => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const index of [0, 2, 4]) {
      const bad = [100, 100, 100, 100, 100]; bad[index] = value;
      expect(() => observeStartupReuse(bad, [80, 80, 80, 80, 80], 'cold不正')).toThrow();
      expect(() => observeStartupReuse([100, 100, 100, 100, 100], bad, 'warm不正')).toThrow();
    }
    expect(log).not.toHaveBeenCalled();
  });
  it('空・欠測・6件・疎配列・追跡不能な名前と表現できない比率を拒否する', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const good = [100, 100, 100, 100, 100], sparse = new Array<number>(5); sparse[2] = 1;
    for (const bad of [[], [1, 2, 3, 4], [1, 2, 3, 4, 5, 6], sparse]) {
      expect(() => observeStartupReuse(bad, good, 'cold欠測')).toThrow();
      expect(() => observeStartupReuse(good, bad, 'warm欠測')).toThrow();
    }
    expect(() => observeStartupReuse(good, good, ' ')).toThrow();
    expect(() => observeStartupReuse(Array.from({ length: 5 }, () => Number.MIN_VALUE), Array.from({ length: 5 }, () => Number.MAX_VALUE), 'overflow')).toThrow();
    expect(() => observeStartupReuse(Array.from({ length: 5 }, () => Number.MAX_VALUE), Array.from({ length: 5 }, () => Number.MIN_VALUE), 'underflow')).toThrow();
  });
  it('参考比率を分離しても取消と有限上限の失敗を観測成功にしない', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(observeStartupReuse([100, 100, 100, 100, 100], [120, 120, 120, 120, 120], '参考未達').meetsTarget).toBe(false);
    expect(() => reportDuration(1001, 200, '取消')).toThrow('実用上の遅延');
    expect(() => reportDuration(150001, 30000, '有限待機')).toThrow('実用上の遅延');
    expect(() => reportDuration(Number.NaN, 200, '機能失敗・欠測')).toThrow('不正');
  });
});

describe('1000部品の根拠なし速度境界と機能条件を分離する', () => {
  it.each([30_000, 120_000])('正の実操作%smsを5000msの参考未達として保持する', actualMs => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(observePositiveDuration(actualMs, 5000, '1000定義を開く')).toEqual({
      label: '1000定義を開く', actualMs, referenceTargetMs: 5000, meetsTarget: false, decisionUse: 'observation' });
    expect(observeDuration(0, 100, '既存の時間分解能').actualMs).toBe(0);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('操作時間%sを成功観測にしない', value => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => observePositiveDuration(value, 5000, '開く')).toThrow();
    expect(log).not.toHaveBeenCalled();
  });
  it.each([1, 30, 60])('実FPS%sと実描画回数を30fpsの参考値と併記する', fps => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const measurement = { fps, completedRenders: fps, elapsedMs: 1000 }, before = structuredClone(measurement);
    const result = observeViewportRate(measurement, '1000定義の描画');
    expect(result).toEqual({ label: '1000定義の描画', actualFps: fps, completedRenders: fps, elapsedMs: 1000,
      referenceTargetFps: 30, meetsTarget: fps >= 30, decisionUse: 'observation' });
    expect(measurement).toEqual(before);
    expect(log).toHaveBeenCalledWith('[性能観測]', JSON.stringify(result));
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('FPS・描画数・窓の不正値%sを拒否する', value => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const valid = { fps: 1, completedRenders: 1, elapsedMs: 1000 };
    for (const field of ['fps', 'completedRenders', 'elapsedMs']) {
      expect(() => observeViewportRate({ ...valid, [field]: value }, '描画')).toThrow();
    }
    expect(log).not.toHaveBeenCalled();
  });
  it('欠測・小数の描画回数・FPS不整合と名前なしを拒否する', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const value of [undefined, null, {}, [], { fps: 1, elapsedMs: 1000 },
      { fps: 1, completedRenders: .5, elapsedMs: 500 }, { fps: 2, completedRenders: 1, elapsedMs: 1000 }]) {
      expect(() => observeViewportRate(value, '描画')).toThrow();
    }
    expect(() => observeViewportRate({ fps: 1, completedRenders: 1, elapsedMs: 1000 }, ' ')).toThrow();
  });
  it('取消と干渉の実用失敗、ほかの50部品のFPS拒否を免除しない', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(observeViewportRate({ fps: 1, completedRenders: 1, elapsedMs: 1000 }, '参考描画').meetsTarget).toBe(false);
    expect(() => reportViewportRate(1, '既存50部品')).toThrow('実用上の遅延');
    expect(() => reportDuration(1001, 200, '取消')).toThrow('実用上の遅延');
    expect(() => reportDuration(10001, 2000, '干渉', 'interference')).toThrow('実用上の遅延');
    expect(() => reportDuration(Number.NaN, 2000, '未完の干渉', 'interference')).toThrow('不正');
  });
});
