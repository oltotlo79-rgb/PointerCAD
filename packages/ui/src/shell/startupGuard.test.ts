import { describe, expect, it, vi } from 'vitest';
import { installStartupGuard, STARTUP_GUARD_RETRY_KEY, type StartupGuardHost, type StartupGuardResult } from './startupGuard.js';
import { RETRY_KEY } from './startupRecovery.js';

function fixture(options: { stage?: string; stored?: string; denyStorage?: boolean; ignoreWrites?: boolean } = {}) {
  const page = new EventTarget();
  const document = new EventTarget();
  const storage = new Map<string, string>();
  if (options.stored !== undefined) storage.set(STARTUP_GUARD_RETRY_KEY, options.stored);
  const shell = { dataset: {} as DOMStringMap };
  const loading = { hidden: false, setAttribute: vi.fn() };
  const failure = { hidden: true, setAttribute: vi.fn() };
  const reload = vi.fn();
  const markFailed = vi.fn();
  let stage = options.stage;
  const host: StartupGuardHost = {
    page, document,
    stage: () => stage,
    markFailed,
    element: selector => selector === '[data-startup-loading]' ? loading : selector === '[data-startup-failure]' ? failure : null,
    shell: () => shell,
    storage: () => {
      if (options.denyStorage === true) throw new Error('denied');
      return {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => { if (options.ignoreWrites !== true) storage.set(key, value); },
      };
    },
    address: () => 'http://127.0.0.1:4173/',
    reload,
  };
  const results: StartupGuardResult[] = [];
  const dispose = installStartupGuard(host, result => { results.push(result); });
  return { page, document, storage, shell, loading, failure, reload, markFailed, results, dispose,
    setStage: (value: string) => { stage = value; },
    loaded: () => { document.dispatchEvent(new Event('DOMContentLoaded')); } };
}

describe('起動入口そのものが動かなかった時だけ、一度だけ読み直す', () => {
  it('起動入口と同じ印を使い、二つの経路を合わせても読み直しは一度だけになる', () => {
    expect(STARTUP_GUARD_RETRY_KEY).toBe(RETRY_KEY);
  });

  it('起動入口が動いた(起動の段の印がある)なら何もしない。その後の失敗は入口の復旧が受け持つ', () => {
    const guard = fixture();
    guard.setStage('bootstrap');
    guard.loaded();
    expect(guard.results).toEqual(['started']);
    expect(guard.reload).not.toHaveBeenCalled();
    expect(guard.storage.size).toBe(0);
    expect(guard.shell.dataset['state']).toBeUndefined();
  });

  it('起動入口が動かなければ、印を書いて読み返せた時に一度だけ読み直す', () => {
    const guard = fixture();
    guard.loaded();
    expect(guard.results).toEqual(['reloading']);
    expect(guard.reload).toHaveBeenCalledTimes(1);
    expect(guard.storage.get(STARTUP_GUARD_RETRY_KEY)).toBe('http://127.0.0.1:4173/');
    expect(guard.shell.dataset['state']).toBeUndefined();
  });

  it('同じ場所で既に読み直した後なら繰り返さず、失敗の案内と手動の再読込みを残す', () => {
    const guard = fixture({ stored: 'http://127.0.0.1:4173/' });
    guard.loaded();
    expect(guard.results).toEqual(['failed']);
    expect(guard.reload).not.toHaveBeenCalled();
    expect(guard.shell.dataset['state']).toBe('failed');
    expect(guard.loading.hidden).toBe(true);
    expect(guard.failure.hidden).toBe(false);
    expect(guard.failure.setAttribute).toHaveBeenCalledWith('role', 'alert');
    expect(guard.markFailed).toHaveBeenCalledTimes(1);
  });

  it('印を保存できない・読み返せない場合は自動で進めず、繰り返しの輪を作らない', () => {
    for (const options of [{ denyStorage: true }, { ignoreWrites: true }]) {
      const guard = fixture(options);
      guard.loaded();
      expect(guard.results).toEqual(['failed']);
      expect(guard.reload).not.toHaveBeenCalled();
      expect(guard.failure.hidden).toBe(false);
    }
  });

  it('頁を離れる途中の取得の取消しでは読み直さない(開こうとしている頁を置き換えない)', () => {
    for (const type of ['beforeunload', 'pagehide']) {
      const guard = fixture();
      guard.page.dispatchEvent(new Event(type));
      guard.loaded();
      expect(guard.results).toEqual(['leaving']);
      expect(guard.reload).not.toHaveBeenCalled();
      expect(guard.storage.size).toBe(0);
    }
    const restored = fixture();
    restored.page.dispatchEvent(new Event('pagehide'));
    restored.page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    restored.loaded();
    expect(restored.results).toEqual(['reloading']);
  });

  it('判定は一度だけで、その後は窓と文書に何も残さない', () => {
    const guard = fixture();
    guard.loaded();
    guard.loaded();
    guard.page.dispatchEvent(new Event('beforeunload'));
    expect(guard.results).toEqual(['reloading']);
    expect(guard.reload).toHaveBeenCalledTimes(1);
    const disposed = fixture();
    disposed.dispose();
    disposed.loaded();
    expect(disposed.results).toEqual([]);
  });
});
