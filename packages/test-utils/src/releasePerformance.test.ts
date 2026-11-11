import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeSaveResponse, observeDuration, observePositiveDuration, observeViewportRate, observeStartupReuse, reportDuration, reportViewportRate } from './releasePerformance.js';

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

describe('曲面返信の複合窓は既存の参考時間観測へ渡す', () => {
  it('120.5381msの未達と元100msを保持し、別の数値境界で合格を作らない', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(observeDuration(120.53810000000158, 100, 'surface whole window')).toEqual({
      label: 'surface whole window', actualMs: 120.53810000000158, referenceTargetMs: 100,
      meetsTarget: false, decisionUse: 'observation',
    });
    expect(log).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    '欠測または不正な複合窓の実測%sを成功として記録しない', actual => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(() => { Reflect.apply(observeDuration, undefined, [actual, 100, 'surface whole window']); }).toThrow('不正');
      expect(log).not.toHaveBeenCalled();
    });
});

describe('保存応答の全100標本と厳密な100ms参考目標', () => {
  const input = (): { pageLatencyMs: unknown[]; roundTripMs: unknown[]; stages: unknown[] } => ({ pageLatencyMs: Array.from({ length: 100 }, () => 1),
    roundTripMs: Array.from({ length: 100 }, () => 2), stages: Array.from({ length: 100 }, () => 'preparing') });

  it('実CIの128.0462msと遅い8標本を捨てず、未達の参考値として保持する', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Actual save-128-1 raw SHA 2a744e480c79250886e9bb596609e36e4683e80587952272afef82d6c790c971.
    const actual = {"pageLatencyMs":[8.570000000065193,5.959999999962747,3.25,11.400000000023283,0.965000000083819,5.834999999962747,1.3699999999953434,1.3950000000186265,1.4399999999441206,1.1600000000325963,0.9450000000651926,13.625,1.6450000000186265,5.059999999939464,10.729999999981374,0.9899999999906868,4.98499999998603,10.605000000097789,0.9200000000419095,8.56000000005588,19.165000000037253,8.130000000004657,16.130000000004657,4.739999999990687,2.0300000000279397,10.604999999981374,16.699999999953434,5.875,14.199999999953434,1.9499999999534339,6.744999999995343,16.510000000009313,18.160000000032596,12.26500000001397,0.9849999999860302,6.0200000000186265,14.709999999962747,4.689999999944121,13.694999999948777,4.5,12.255000000004657,2.2550000000046566,9.074999999953434,19.800000000046566,9.775000000023283,15.130000000004657,2.3700000001117587,8.619999999995343,21.885000000009313,9.335000000079162,19.044999999925494,17.46999999997206,4.839999999967404,8.48499999998603,6.6700000000419095,13.114999999990687,9.555000000051223,1.1700000000419095,4.010000000009313,1.0600000000558794,1.7550000000046566,1.1750000000465661,1.1899999999441206,1.0949999999720603,1.2699999999022111,1.275000000023283,1.2600000000093132,1.0949999999720603,10.559999999939464,1.1350000000093132,1.099999999976717,1.0399999999208376,1.0449999999254942,10.67499999993015,12.64000000001397,9.520000000018626,20.68999999994412,10.139999999897555,17.369999999995343,6.224999999976717,10.309999999939464,13.565000000060536,1.375,6.89000000001397,14.020000000018626,4.4200000000419095,1.1700000000419095,10.604999999981374,19.04500000004191,7.535000000032596,16.599999999976717,5.319999999948777,17.28000000002794,5.650000000023283,16.875,5.3549999999813735,16.150000000023283,5.135000000009313,16.169999999925494,5.10999999998603],"roundTripMs":[21.040600000007544,15.152700000006007,14.807100000005448,82.55590000000666,31.63969999999972,122.15929999999935,128.0462000000116,145.3993000000046,61.25899999999092,48.42740000000049,41.72729999999865,13.94529999999213,17.371099999989383,15.982799999997951,10.97630000000936,16.808199999999488,13.352499999993597,10.38969999999972,11.841899999999441,9.741500000003725,11.48760000000766,9.492899999997462,12.979200000001583,22.011700000002747,14.949099999997998,11.351399999999558,14.415399999998044,10.993900000001304,12.46370000000752,16.30449999999837,9.975200000000768,13.288200000009965,37.410599999988335,12.08190000000468,13.577600000004168,10.576000000000931,11.733600000006845,10.130699999994249,10.17609999999695,10.103699999992386,10.318699999988894,12.246199999994133,9.702399999994668,11.97149999999965,10.191299999991315,14.815300000002026,14.38279999999213,10.79200000000128,13.976600000009057,10.154000000009546,21.716700000004494,14.959300000002258,12.745699999999488,44.23630000000412,15.611399999994319,24.73309999999765,39.439299999998184,21.53870000000461,33.099400000006426,27.552700000000186,26.306100000001607,67.68439999999828,144.95609999999579,371.36359999999695,196.63230000001204,215.1039000000019,24.54120000000694,31.38489999999001,118.48429999999644,71.47669999999925,38.514200000005076,35.23110000000452,13.314899999997579,10.10099999999511,52.11460000000079,11.638399999996182,11.295200000007753,11.492299999998068,13.947000000000116,16.9149000000034,11.059599999993225,19.45449999999255,15.232600000003004,10.423099999999977,13.867899999997462,51.69000000000233,14.975400000010268,11.626600000003236,12.952499999999418,11.145300000003772,13.597600000008242,11.30449999999837,11.937200000000303,11.805299999992712,11.966499999994994,11.521500000002561,11.23410000000149,10.979300000006333,11.421100000006845,10.958599999998114],"stages":["preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","preparing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing","compressing"]};
    const before = structuredClone(actual);
    const observed = observeSaveResponse(actual, '実CI128MiB 2/3');
    expect(observed).toMatchObject({ p95: 128.0462000000116, activeP95: 128.0462000000116,
      referenceTargetMs: 100, comparison: '<', meetsTarget: false, activeMeetsTarget: false, decisionUse: 'observation' });
    expect(observed.samples).toHaveLength(100); expect(observed.activeSamples).toHaveLength(100);
    expect(observed.samples.filter(ms => ms >= 100)).toHaveLength(8);
    expect(observed.samples).toEqual(actual.pageLatencyMs.map((ms, index) => Math.max(ms, actual.roundTripMs[index] ?? Infinity)).sort((a, b) => a - b));
    expect(actual).toEqual(before);
    expect(log).toHaveBeenCalledWith('[性能観測]', JSON.stringify(observed));
  });

  it.each([{ ms: 99.99, meets: true }, { ms: 100, meets: false }, { ms: 128.0462, meets: false }])(
    'p95=$msの厳密な達否を残し、別の上限へ変更しない', ({ ms, meets }) => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const observed = observeSaveResponse({ ...input(), roundTripMs: Array.from({ length: 100 }, () => ms) }, '境界');
      expect(observed).toMatchObject({ p95: ms, activeP95: ms, meetsTarget: meets, activeMeetsTarget: meets });
      expect(observeDuration(100, 100, '既存の境界').meetsTarget).toBe(true);
    });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    '末尾の不正標本%sもp95の外へ落として成功にしない', value => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      for (const field of ['pageLatencyMs', 'roundTripMs'] as const) {
        const bad = input(); bad[field][99] = value;
        expect(() => observeSaveResponse(bad, '不正')).toThrow();
      }
      expect(log).not.toHaveBeenCalled();
    });

  it('各配列の穴・欠落・99/101件とstage型不正・保存中0件を拒否する', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const field of ['pageLatencyMs', 'roundTripMs', 'stages'] as const) {
      const sparse = input(); Reflect.deleteProperty(sparse[field], '50');
      expect(() => observeSaveResponse(sparse, '穴')).toThrow();
      for (const length of [99, 101]) {
        const bad = input(); bad[field] = Array.from({ length }, () => field === 'stages' ? 'preparing' : 1);
        expect(() => observeSaveResponse(bad, '件数')).toThrow();
      }
      const missing = input(); Reflect.deleteProperty(missing, field);
      expect(() => observeSaveResponse(missing, '欠落')).toThrow();
    }
    for (const value of [undefined, null, 0, '', ' ']) {
      const bad = input(); bad.stages[50] = value;
      expect(() => observeSaveResponse(bad, 'stage不正')).toThrow();
    }
    expect(() => observeSaveResponse({ ...input(), stages: Array.from({ length: 100 }, () => 'complete') }, '保存後のみ')).toThrow();
    for (const value of [undefined, null, {}, []]) expect(() => observeSaveResponse(value, '欠測')).toThrow();
    expect(() => observeSaveResponse(input(), ' ')).toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it('完了後の速い入力で保存中の遅い標本を隠さず、入力の配列を変えない', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const rows = input(); rows.roundTripMs[99] = 200; rows.stages = Array.from({ length: 100 }, (_, index) => index === 99 ? 'compressing' : 'complete');
    const before = structuredClone(rows), observed = observeSaveResponse(rows, '保存中の分離');
    expect(observed.samples).toHaveLength(100); expect(observed.samples.at(-1)).toBe(200);
    expect(observed.activeSamples).toEqual([200]); expect(observed.activeP95).toBe(200);
    expect(observed.activeMeetsTarget).toBe(false); expect(rows).toEqual(before);
  });
});

describe('保存応答のp95と保存中p95は100msを参考値とし、共通の5倍の実用上限500msを超えたら失敗する', () => {
  const rows = (ms: number, stage = 'compressing'): { pageLatencyMs: number[]; roundTripMs: number[]; stages: string[] } => ({
    pageLatencyMs: Array.from({ length: 100 }, () => 1), roundTripMs: Array.from({ length: 100 }, () => ms),
    stages: Array.from({ length: 100 }, () => stage) });
  // e2e/tests/saveResponsivenessFlow.ts と同じ渡し方。参考値100msを共通の判定へ渡すと許容境界は5倍の500msになる。
  const judge = (observed: ReturnType<typeof observeSaveResponse>): ReturnType<typeof reportDuration>[] => [
    reportDuration(observed.p95, observed.referenceTargetMs, `${observed.label} p95`),
    reportDuration(observed.activeP95, observed.referenceTargetMs, `${observed.label} 保存中p95`)];

  it.each([
    { ms: 99.9, meetsTarget: true },
    { ms: 100, meetsTarget: false },
    { ms: 499.9, meetsTarget: false },
    { ms: 500, meetsTarget: false },
  ])('p95と保存中p95が$msのとき許容境界500ms以内で通過し、100msの達否$meetsTargetを残す', ({ ms, meetsTarget }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const observed = observeSaveResponse(rows(ms), '保存境界');
    expect(observed).toMatchObject({ p95: ms, activeP95: ms, referenceTargetMs: 100, meetsTarget, activeMeetsTarget: meetsTarget,
      decisionUse: 'observation' });
    for (const measurement of judge(observed)) {
      expect(measurement).toMatchObject({ actual: ms, target: 100, practicalLimit: 500, unit: 'ms', meetsTarget, usable: true });
      expect(log).toHaveBeenCalledWith('[性能記録]', JSON.stringify(measurement));
    }
  });

  it.each([500.01, 600, 128_000])('p95と保存中p95が%sのとき許容境界500ms超として失敗する', ms => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const observed = observeSaveResponse(rows(ms), '保存超過');
    expect(observed).toMatchObject({ meetsTarget: false, activeMeetsTarget: false });
    expect(() => judge(observed)).toThrow('実用上の遅延: 保存超過 p95');
    expect(() => reportDuration(observed.activeP95, observed.referenceTargetMs, '保存超過 保存中p95')).toThrow('許容境界500ms');
  });

  it('保存後の速い入力でp95が小さくても、保存中p95の500ms超を失敗にする', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const input = rows(2, 'complete'); input.roundTripMs[99] = 600; input.stages[99] = 'compressing';
    const observed = observeSaveResponse(input, '保存中だけ遅い');
    expect(observed).toMatchObject({ p95: 2, activeP95: 600, meetsTarget: true, activeMeetsTarget: false });
    expect(reportDuration(observed.p95, observed.referenceTargetMs, '保存中だけ遅い p95').usable).toBe(true);
    expect(() => judge(observed)).toThrow('実用上の遅延: 保存中だけ遅い 保存中p95');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])('p95と保存中p95の非有限・負の値%sを許容境界内として通さない', value => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const observed = observeSaveResponse(rows(1), '保存不正');
    expect(() => judge({ ...observed, p95: value })).toThrow('不正');
    expect(() => judge({ ...observed, activeP95: value })).toThrow('不正');
    const raw = rows(1); raw.roundTripMs[0] = value;
    expect(() => observeSaveResponse(raw, '保存不正')).toThrow('不正');
  });
});
