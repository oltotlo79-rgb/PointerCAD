import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegistrationImportProbe } from './occtRegistrationImportProbe.js';
import { createOcctInstantiationHook } from './compiledOcctModule.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function setup(imports: WebAssembly.Imports, times: number[], enabled = true) {
  const clock = vi.fn(() => { const value = times.shift(); if (value === undefined) throw new Error('clock exhausted'); return value; });
  const observer = vi.fn<(phase: string) => void>();
  const probe = createRegistrationImportProbe(imports, enabled, observer, clock);
  return { probe, clock, observer };
}

function invoke(imports: WebAssembly.Imports, name: string, receiver: unknown, args: unknown[] = []): unknown {
  const fn = imports['a']?.[name];
  if (typeof fn !== 'function') throw new Error('function absent');
  return Reflect.apply(fn, receiver, args);
}

function ticket(observer: ReturnType<typeof vi.fn<(phase: string) => void>>) {
  expect(observer).toHaveBeenCalledTimes(1);
  const phase = observer.mock.calls[0]?.[0];
  if (phase === undefined || !phase.startsWith('registration-import-probe:')) throw new Error('ticket absent');
  const value: unknown = JSON.parse(phase.slice('registration-import-probe:'.length));
  if (typeof value !== 'object' || value === null ||
      !('completed' in value) || typeof value.completed !== 'boolean' ||
      !('valid' in value) || typeof value.valid !== 'boolean' ||
      !('bounded' in value) || typeof value.bounded !== 'boolean' ||
      !('coverageComplete' in value) || typeof value.coverageComplete !== 'boolean' ||
      !('rows' in value) || !Array.isArray(value.rows)) throw new Error('invalid ticket');
  const rows = value.rows.map((row: unknown) => {
    if (typeof row !== 'object' || row === null ||
        !('name' in row) || typeof row.name !== 'string' ||
        !('calls' in row) || typeof row.calls !== 'number' ||
        !('exclusiveMs' in row) || typeof row.exclusiveMs !== 'number') throw new Error('invalid row');
    return { name: row.name, calls: row.calls, exclusiveMs: row.exclusiveMs };
  });
  return { completed: value.completed, valid: value.valid, bounded: value.bounded,
    coverageComplete: value.coverageComplete, rows };
}

describe('登録importの独立診断', () => {
  it('offは表の同一参照を返しclockとobserverを呼ばない', () => {
    const imports = { a: { y: vi.fn(() => 7) } };
    const { probe, clock, observer } = setup(imports, [], false);
    expect(probe.imports).toBe(imports); probe.begin();
    expect(invoke(probe.imports, 'y', null)).toBe(7); probe.finish(true);
    expect(clock).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
  });
  it('元関数を1回だけ呼びthis・引数・戻り値を保持する', () => {
    const receiver = {}, arg = {}, result = {};
    const original = vi.fn(function (this: unknown, value: unknown, n: number) { expect(this).toBe(receiver); expect(value).toBe(arg); expect(n).toBe(3); return result; });
    const { probe, observer } = setup({ a: { y: original } }, [10, 17]); probe.begin();
    expect(invoke(probe.imports, 'y', receiver, [arg, 3])).toBe(result); probe.finish(true);
    expect(original).toHaveBeenCalledTimes(1);
    expect(ticket(observer)).toEqual({ completed: true, valid: true, bounded: false, coverageComplete: false, rows: [{ name: 'y', calls: 1, exclusiveMs: 7 }] });
  });
  it('同一例外objectを再送出し失敗票は未完了', () => {
    const error = new Error('original'); const original = vi.fn(() => { throw error; });
    const { probe, observer } = setup({ a: { y: original } }, [2, 5]); probe.begin();
    let actual: unknown; try { invoke(probe.imports, 'y', undefined); } catch (caught) { actual = caught; }
    expect(actual).toBe(error); probe.finish(false); expect(ticket(observer).completed).toBe(false);
    expect(original).toHaveBeenCalledTimes(1);
  });
  it('observerのthrowで戻り値や元例外を変えない', () => {
    const error = new Error('native');
    for (const fails of [false, true]) {
      const probe = createRegistrationImportProbe({ a: { y() { if (fails) throw error; return 8; } } }, true, () => { throw new Error('sink'); }, () => 0);
      probe.begin(); if (fails) expect(() => invoke(probe.imports, 'y', null)).toThrow(error);
      else expect(invoke(probe.imports, 'y', null)).toBe(8);
      expect(() => probe.finish(!fails)).not.toThrow();
    }
  });
  it('ネスト時間を親から引き排他的に計上する', () => {
    let prepared: WebAssembly.Imports = {};
    const original = { a: { y() { invoke(prepared, 'z', null); }, z() { return 1; } } };
    const { probe, observer } = setup(original, [0, 2, 5, 10]); prepared = probe.imports; probe.begin();
    invoke(prepared, 'y', null); probe.finish(true);
    expect(ticket(observer).rows).toEqual([{ name: 'y', calls: 1, exclusiveMs: 7 }, { name: 'z', calls: 1, exclusiveMs: 3 }]);
  });
  it('非関数property・descriptor・非対象関数・prototypeを保持する', () => {
    const memory = new WebAssembly.Memory({ initial: 1 }), table = new WebAssembly.Table({ element: 'anyfunc', initial: 0 });
    const global = new WebAssembly.Global({ value: 'i32' }, 4), module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
    const untouched = () => 12, getter = vi.fn(() => 2); const a = { y: () => 3, memory, table, global, unknown: untouched };
    Object.defineProperty(a, 'module', { value: module, enumerable: true });
    Object.defineProperty(a, 'y', { writable: false, configurable: false, enumerable: false });
    Object.defineProperty(a, 'Wi', { get: getter, configurable: false, enumerable: false });
    const imports = { a }; const { probe, clock } = setup(imports, []);
    expect(probe.imports).not.toBe(imports); expect(getter).not.toHaveBeenCalled();
    for (const key of ['memory', 'table', 'global', 'module', 'unknown', 'Wi']) expect(Object.getOwnPropertyDescriptor(probe.imports['a'], key)).toEqual(Object.getOwnPropertyDescriptor(a, key));
    const descriptor = Object.getOwnPropertyDescriptor(probe.imports['a'], 'y');
    expect(descriptor?.writable).toBe(false); expect(descriptor?.configurable).toBe(false); expect(descriptor?.enumerable).toBe(false);
    expect(Object.getPrototypeOf(probe.imports['a'])).toBe(Object.getPrototypeOf(a));
    expect(clock).not.toHaveBeenCalled(); expect(a.y()).toBe(3);
  });
  it('未知名とaccessorだけなら表を複写せずclock0', () => {
    const imports = { a: { unknown: () => 2 } }; const { probe, clock } = setup(imports, []);
    expect(probe.imports).toBe(imports); probe.begin(); invoke(probe.imports, 'unknown', null); probe.finish(true);
    expect(clock).not.toHaveBeenCalled();
  });
  it('receiveの前後を測らず票は1回・引数やbody値を含めない', () => {
    const { probe, observer, clock } = setup({ a: { y: () => 'secret body' } }, [0, 1]);
    invoke(probe.imports, 'y', null, ['secret arg']); probe.begin(); invoke(probe.imports, 'y', null); probe.finish(true);
    probe.finish(false); invoke(probe.imports, 'y', null); expect(clock).toHaveBeenCalledTimes(2);
    const raw = JSON.stringify(ticket(observer)); expect(raw).not.toContain('secret'); expect(raw).not.toContain('args');
  });
  it('取消・close相当は未完了で後続呼出しを採録しない', () => {
    const { probe, observer, clock } = setup({ a: { y: () => 1 } }, []); probe.begin(); probe.finish(false);
    invoke(probe.imports, 'y', null); expect(ticket(observer).completed).toBe(false); expect(clock).not.toHaveBeenCalled();
  });
  it('ネスト中の取消は1票の未完了で固定する', () => {
    const observer = vi.fn<(phase: string) => void>();
    const probe = createRegistrationImportProbe({ a: { y() { probe.finish(false); return 5; } } }, true, observer, () => 0);
    probe.begin(); expect(invoke(probe.imports, 'y', null)).toBe(5); probe.finish(true);
    expect(ticket(observer).completed).toBe(false);
  });
  it('clock逆行・非有限・例外を元関数へ伝えず未完了にする', () => {
    for (const times of [[3, 2], [NaN, 2], []]) {
      const { probe, observer } = setup({ a: { y: () => 42 } }, times); probe.begin();
      expect(invoke(probe.imports, 'y', null)).toBe(42); probe.finish(true);
      expect(ticket(observer).completed).toBe(false); expect(ticket.bind(null, observer)).not.toThrow();
    }
  });
  it('15行と100万回の固定上限を超えた票を成功にしない', () => {
    let calls = 0; const observer = vi.fn<(phase: string) => void>();
    const probe = createRegistrationImportProbe({ a: { y() { calls += 1; return 1; } } }, true, observer, () => 0);
    // 元関数の1000001回を削らず、保存行数・計数を増やし続けない。
    probe.begin(); for (let i = 0; i < 1_000_001; i += 1) invoke(probe.imports, 'y', null); probe.finish(true);
    const value = ticket(observer); expect(value.completed).toBe(false); expect(value.bounded).toBe(true);
    expect(value.rows).toHaveLength(1); expect(value.rows[0].calls).toBe(1_000_000); expect(calls).toBe(1_000_001);
  });
  it('実hookのoff経路は元import表をそのままnativeへ渡す', async () => {
    const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
    const instance = new WebAssembly.Instance(module), imports = { a: { y: () => 6 } };
    const native = vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue(instance);
    const stages: string[] = [], hook = createOcctInstantiationHook(module, undefined, phase => stages.push(phase));
    hook.instantiateWasm(imports, () => undefined); await hook.completion; hook.close();
    expect(native).toHaveBeenCalledExactlyOnceWith(module, imports);
    expect(stages.some(phase => phase.startsWith('registration-import-probe:'))).toBe(false);
  });
  it('実hookはreceiver失敗・abort・closeを完了票にしない', async () => {
    vi.stubEnv('VITE_PCAD_E2E', '1'); vi.stubEnv('VITE_PCAD_OCCT_REGISTRATION_PROBE', '1');
    const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue(new WebAssembly.Instance(module));
    for (const mode of ['receiver', 'abort', 'close']) {
      const error = new Error('receiver'), controller = new AbortController(), observer = vi.fn<(phase: string) => void>();
      const hook = createOcctInstantiationHook(module, controller.signal, phase => {
        if (phase.startsWith('registration-import-probe:')) observer(phase);
      });
      hook.instantiateWasm({ a: { y: () => 1 } }, () => { throw error; });
      if (mode === 'abort') controller.abort();
      if (mode === 'close') hook.close();
      if (mode === 'receiver') await expect(hook.completion).rejects.toBe(error);
      else await expect(hook.completion).rejects.toThrow();
      expect(ticket(observer).completed).toBe(false); hook.close();
    }
  });
});

/** 登録間の未分類wallを、追加clockやnative実行なしで独立時刻から照合する。 */
describe('登録importの外側区間', () => {
  function outerSpan(observer: ReturnType<typeof vi.fn<(phase: string) => void>>): unknown {
    expect(observer).toHaveBeenCalledTimes(1);
    const phase = observer.mock.calls[0]?.[0];
    if (phase === undefined) throw new Error('ticket absent');
    const value: unknown = JSON.parse(phase.slice('registration-import-probe:'.length));
    if (typeof value !== 'object' || value === null || !('outerSpan' in value)) throw new Error('span absent');
    return value.outerSpan;
  }

  it('入れ子を二重計上せず、区間35と呼出し間18を既存8clockだけで測る', () => {
    let prepared: WebAssembly.Imports = {};
    let nested = true;
    const original = { a: { y() { if (nested) invoke(prepared, 'z', null); }, z() { return 1; }, n() { return 2; } } };
    const { probe, observer, clock } = setup(original, [0, 2, 5, 10, 20, 22, 30, 35]);
    prepared = probe.imports; probe.begin();
    invoke(prepared, 'y', null); invoke(prepared, 'n', null); nested = false;
    invoke(prepared, 'y', null); probe.finish(true);
    expect(outerSpan(observer)).toEqual({ calls: 3, spanMs: 35, betweenCallsMs: 18,
      largestGapMs: 10, largestGapAfter: 'y', largestGapBefore: 'n' });
    expect(ticket(observer).rows.reduce((sum, row) => sum + row.exclusiveMs, 0)).toBe(17);
    expect(clock).toHaveBeenCalledTimes(8);
  });

  it('1回だけなら呼出し間0で、存在しない境界名を作らない', () => {
    const { probe, observer, clock } = setup({ a: { y: () => 9 } }, [4, 9]);
    probe.begin(); expect(invoke(probe.imports, 'y', null)).toBe(9); probe.finish(true);
    expect(outerSpan(observer)).toEqual({ calls: 1, spanMs: 5, betweenCallsMs: 0,
      largestGapMs: 0, largestGapAfter: null, largestGapBefore: null });
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it('個別呼出し内が正でも呼出し間clock逆行を成功票にしない', () => {
    const { probe, observer } = setup({ a: { y: () => 9 } }, [10, 12, 5, 8]);
    probe.begin(); invoke(probe.imports, 'y', null); invoke(probe.imports, 'y', null); probe.finish(true);
    expect(ticket(observer).completed).toBe(false); expect(outerSpan(observer)).toBeNull();
  });

  it('未呼出しと失敗途中は観測した0時間へ置き換えない', () => {
    for (const completed of [false, true]) {
      const { probe, observer, clock } = setup({ a: { y: () => 1 } }, []);
      probe.begin(); probe.finish(completed);
      expect(outerSpan(observer)).toBeNull(); expect(clock).not.toHaveBeenCalled();
    }
    const error = new Error('original'), original = vi.fn(() => { throw error; });
    const { probe, observer } = setup({ a: { y: original } }, [3, 6]);
    probe.begin(); let caught: unknown;
    try { invoke(probe.imports, 'y', null); } catch (value) { caught = value; }
    probe.finish(false);
    expect(caught).toBe(error); expect(original).toHaveBeenCalledTimes(1);
    expect(outerSpan(observer)).toBeNull();
  });
});


/** Nは登録間Gに属する非登録importの排他時間だけ。時計は独立の手計算値。 */
describe('非登録importの登録間区分', () => {
  function nonRegistration(observer: ReturnType<typeof vi.fn<(phase: string) => void>>): unknown {
    const phase = observer.mock.calls[0]?.[0];
    if (phase === undefined) throw new Error('ticket absent');
    const value: unknown = JSON.parse(phase.slice('registration-import-probe:'.length));
    if (typeof value !== 'object' || value === null || !('nonRegistration' in value)) throw new Error('section absent');
    return value.nonRegistration;
  }

  it('offでは既知の非登録関数も元表・時計0のまま保持する', () => {
    const imports = { a: { y: () => 1, dj: () => 2 } };
    const { probe, clock, observer } = setup(imports, [], false);
    probe.begin(); expect(invoke(probe.imports, 'dj', null)).toBe(2); probe.finish(true);
    expect(probe.imports).toBe(imports); expect(clock).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
  });

  it('前後のspan外を除き、次登録で確定した2msだけを採る', () => {
    const { probe, observer, clock } = setup({ a: { y: () => 1, dj: () => 2 } }, [0, 3, 5, 7, 8, 10, 12, 15, 20, 30]);
    probe.begin(); invoke(probe.imports, 'dj', null); invoke(probe.imports, 'y', null);
    invoke(probe.imports, 'dj', null); invoke(probe.imports, 'y', null); invoke(probe.imports, 'dj', null); probe.finish(true);
    expect(nonRegistration(observer)).toEqual({ calls: 3, gapExclusiveMs: 2,
      largestContributor: { name: 'dj', calls: 3, gapExclusiveMs: 2 } });
    expect(ticket(observer).rows).toEqual([{ name: 'y', calls: 2, exclusiveMs: 5 }]);
    expect(clock).toHaveBeenCalledTimes(10);
  });

  it('登録内の非登録は元Eに含み、GのNには足さない', () => {
    let prepared: WebAssembly.Imports = {};
    let nested = true;
    const { probe, observer } = setup({ a: { y() { if (nested) invoke(prepared, 'dj', null); }, dj: () => 2 } }, [0, 2, 4, 10, 20, 22]);
    prepared = probe.imports; probe.begin(); invoke(prepared, 'y', null); nested = false; invoke(prepared, 'y', null); probe.finish(true);
    expect(nonRegistration(observer)).toEqual({ calls: 1, gapExclusiveMs: 0, largestContributor: null });
    expect(ticket(observer).rows).toEqual([{ name: 'y', calls: 2, exclusiveMs: 12 }]);
  });

  it('登録を包む非登録の両端を切り、登録間10msだけを採る', () => {
    let prepared: WebAssembly.Imports = {};
    const { probe, observer } = setup({ a: { dj() { invoke(prepared, 'y', null); invoke(prepared, 'y', null); }, y: () => 1 } }, [0, 5, 10, 20, 25, 50]);
    prepared = probe.imports; probe.begin(); invoke(prepared, 'dj', null); probe.finish(true);
    expect(nonRegistration(observer)).toEqual({ calls: 1, gapExclusiveMs: 10,
      largestContributor: { name: 'dj', calls: 1, gapExclusiveMs: 10 } });
    expect(ticket(observer).rows).toEqual([{ name: 'y', calls: 2, exclusiveMs: 10 }]);
  });

  it('非登録同士の入れ子を二重計上せず6と3の合計9にする', () => {
    let prepared: WebAssembly.Imports = {};
    const { probe, observer } = setup({ a: { y: () => 1, dj() { invoke(prepared, 'Oh', null); }, Oh: () => 2 } }, [0, 1, 3, 5, 8, 12, 15, 16]);
    prepared = probe.imports; probe.begin(); invoke(prepared, 'y', null); invoke(prepared, 'dj', null); invoke(prepared, 'y', null); probe.finish(true);
    expect(nonRegistration(observer)).toEqual({ calls: 2, gapExclusiveMs: 9,
      largestContributor: { name: 'dj', calls: 1, gapExclusiveMs: 6 } });
  });

  it('非登録と登録が交互に入れ子でも13msだけを排他的に採る', () => {
    let prepared: WebAssembly.Imports = {};
    const { probe, observer } = setup({ a: {
      dj() { invoke(prepared, 'y', null); invoke(prepared, 'Oh', null); invoke(prepared, 'y', null); },
      Oh() { invoke(prepared, 'y', null); }, y: () => 1,
    } }, [0, 2, 5, 7, 10, 12, 17, 20, 23, 30]);
    prepared = probe.imports; probe.begin(); invoke(prepared, 'dj', null); probe.finish(true);
    expect(nonRegistration(observer)).toEqual({ calls: 2, gapExclusiveMs: 13,
      largestContributor: { name: 'Oh', calls: 1, gapExclusiveMs: 8 } });
    expect(ticket(observer).rows).toEqual([{ name: 'y', calls: 3, exclusiveMs: 8 }]);
  });

  it('非登録のthis・引数・戻り値・一回呼出しとdescriptorを保持する', () => {
    const receiver = {}, arg = {}, result = {};
    const original = vi.fn(function (this: unknown, value: unknown) { expect(this).toBe(receiver); expect(value).toBe(arg); return result; });
    const imports = { a: { y: () => 1, dj: original } };
    Object.defineProperty(imports.a, 'dj', { writable: false, configurable: false, enumerable: false });
    const { probe, observer } = setup(imports, [0, 1, 2, 5, 10, 11]); probe.begin();
    invoke(probe.imports, 'y', null); expect(invoke(probe.imports, 'dj', receiver, [arg])).toBe(result); invoke(probe.imports, 'y', null); probe.finish(true);
    expect(original).toHaveBeenCalledTimes(1);
    const descriptor = Object.getOwnPropertyDescriptor(probe.imports['a'], 'dj');
    expect(descriptor?.writable).toBe(false); expect(descriptor?.configurable).toBe(false); expect(descriptor?.enumerable).toBe(false);
    expect(nonRegistration(observer)).toEqual({ calls: 1, gapExclusiveMs: 3,
      largestContributor: { name: 'dj', calls: 1, gapExclusiveMs: 3 } });
    expect(observer.mock.calls[0]?.[0]).not.toContain('secret');
  });

  it('非登録の同一throwを保持し、finish成功指定でも無効票にする', () => {
    const error = new Error('native'), original = vi.fn(() => { throw error; });
    const { probe, observer } = setup({ a: { y: () => 1, dj: original } }, [0, 1, 2, 3]); probe.begin(); invoke(probe.imports, 'y', null);
    let actual: unknown; try { invoke(probe.imports, 'dj', null); } catch (caught) { actual = caught; }
    probe.finish(true); expect(actual).toBe(error); expect(original).toHaveBeenCalledTimes(1);
    expect(ticket(observer).completed).toBe(false); expect(nonRegistration(observer)).toBeNull();
  });

  it('非登録clockの逆行・非有限・例外は処理を変えず無効票にする', () => {
    for (const times of [[0, 1, 5, 4], [0, 1, NaN, 5], [0, 1]]) {
      const { probe, observer } = setup({ a: { y: () => 1, dj: () => 42 } }, times); probe.begin(); invoke(probe.imports, 'y', null);
      expect(invoke(probe.imports, 'dj', null)).toBe(42); probe.finish(true);
      expect(ticket(observer).completed).toBe(false); expect(nonRegistration(observer)).toBeNull();
    }
  });

  it('呼出し中の完了・取消を成功や確定0へ変換しない', () => {
    for (const completed of [true, false]) {
      let finish: (completed: boolean) => void = () => undefined;
      const { probe, observer } = setup({ a: { y: () => 1, dj() { finish(completed); return 3; } } }, [0, 1, 2, 5]);
      finish = completed => probe.finish(completed); probe.begin(); invoke(probe.imports, 'y', null); expect(invoke(probe.imports, 'dj', null)).toBe(3);
      expect(ticket(observer).completed).toBe(false); expect(nonRegistration(observer)).toBeNull();
      expect(observer).toHaveBeenCalledTimes(1);
    }
  });

  it('非登録の深さ上限で元呼出しを削らずbounded未完了にする', () => {
    let prepared: WebAssembly.Imports = {}, calls = 0;
    const observer = vi.fn<(phase: string) => void>();
    const probe = createRegistrationImportProbe({ a: { y: () => 1, dj(n: number): number { calls += 1; return n === 0 ? 7 : Number(invoke(prepared, 'dj', null, [n - 1])); } } }, true, observer, () => 0);
    prepared = probe.imports; probe.begin(); invoke(prepared, 'y', null); expect(invoke(prepared, 'dj', null, [256])).toBe(7); probe.finish(true);
    expect(calls).toBe(257); expect(ticket(observer).bounded).toBe(true);
    expect(ticket(observer).completed).toBe(false); expect(nonRegistration(observer)).toBeNull();
  });

  it('非登録の100万回上限を超えても実処理は全て一回ずつ呼ぶ', () => {
    let calls = 0; const observer = vi.fn<(phase: string) => void>();
    const probe = createRegistrationImportProbe({ a: { dj() { calls += 1; return 1; } } }, true, observer, () => 0);
    probe.begin(); for (let i = 0; i < 1_000_001; i += 1) invoke(probe.imports, 'dj', null); probe.finish(true);
    expect(calls).toBe(1_000_001); expect(ticket(observer).bounded).toBe(true); expect(nonRegistration(observer)).toBeNull();
  });
});


describe('非登録診断の失敗先と非関数', () => {
  it('observerのthrowでも非登録の戻り値と同じthrowを変えない', () => {
    const error = new Error('original');
    for (const fail of [false, true]) {
      const probe = createRegistrationImportProbe({ a: { y: () => 1, dj() { if (fail) throw error; return 42; } } }, true,
        () => { throw new Error('sink'); }, () => 0);
      probe.begin(); invoke(probe.imports, 'y', null);
      if (fail) {
        let actual: unknown; try { invoke(probe.imports, 'dj', null); } catch (caught) { actual = caught; }
        expect(actual).toBe(error);
      } else expect(invoke(probe.imports, 'dj', null)).toBe(42);
      expect(() => probe.finish(!fail)).not.toThrow();
    }
  });

  it('固定aliasのaccessorと非関数を評価も置換もしない', () => {
    const getter = vi.fn(() => 3), memory = new WebAssembly.Memory({ initial: 1 });
    const a = { y: () => 1, dj: memory };
    Object.defineProperty(a, 'Oh', { get: getter, enumerable: false, configurable: false });
    const { probe, clock } = setup({ a }, []);
    expect(getter).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    for (const name of ['dj', 'Oh']) expect(Object.getOwnPropertyDescriptor(probe.imports['a'], name)).toEqual(Object.getOwnPropertyDescriptor(a, name));
  });
});
