import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterStartupPaint, dismissStartupSplash, showStartupFailure, startApplicationWithSplash, waitForStartupView } from './startupPresentation.js';

function fixture() {
  const present = new Set<string>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let changed = (): void => {};
  const observe = vi.fn(), disconnect = vi.fn();
  const root = { inert: false };
  const shell = { dataset: {} as Record<string, string>, inert: false, remove: vi.fn() };
  const loading = { hidden: false };
  const failure = { hidden: true, setAttribute: vi.fn() };
  const window = new EventTarget();
  const elements = new Map<string, object>([
    ['[data-startup-shell]', shell], ['[data-startup-loading]', loading], ['[data-startup-failure]', failure],
  ]);
  vi.stubGlobal('document', {
    documentElement: { dataset: {} }, body: {}, getElementById: () => root,
    querySelector: (selector: string) => elements.get(selector) ?? (present.has(selector) ? {} : null),
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { changed = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const storage = new Map([['user-document', 'keep']]);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  const reload = vi.fn();
  vi.stubGlobal('location', { href: 'app://pointercad/index.html', reload });
  function frame(): void {
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => { callback(0); });
  }
  function ready(): void {
    ['.pcad-shell', 'canvas.pcad-viewport__canvas', 'canvas.pcad-viewcube'].forEach(selector => present.add(selector));
    changed();
  }
  return { present, frames, root, shell, loading, failure, window, storage, reload, frame, ready, changed: () => { changed(); }, observe, disconnect };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); performance.clearMarks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); performance.clearMarks(); });

describe('起動画面と実際の画面の準備を同期する', () => {
  it('最初の描画と次のタスクまで重いJSの読込みを始めない', async () => {
    const f = fixture(), done = vi.fn();
    const pending = afterStartupPaint().then(done);
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    f.frame(); expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0); await pending;
    expect(done).toHaveBeenCalledOnce();
  });

  it('ツールバーだけでは終わらず、3Dとキューブの描画の後に終わる', async () => {
    const f = fixture(), done = vi.fn();
    const pending = waitForStartupView(new AbortController().signal).then(done);
    f.present.add('.pcad-shell'); f.changed(); f.frame(); f.frame();
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    f.ready(); f.frame(); expect(done).not.toHaveBeenCalled(); f.frame(); await pending;
    expect(done).toHaveBeenCalledWith('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('描画の途中で現れた既存の失敗表示を覆い隠さない', async () => {
    const f = fixture();
    const pending = waitForStartupView(new AbortController().signal);
    f.ready(); f.frame(); f.present.add('.pcad-viewport [role="alert"]'); f.frame();
    expect(await pending).toBe('failed');
  });

  it.each(['abort', 'error', 'timeout'] as const)('%sで待機を止め、監視とタイマーを残さない', async reason => {
    const f = fixture(), controller = new AbortController();
    const pending = waitForStartupView(controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    if (reason === 'abort') controller.abort();
    else if (reason === 'error') f.window.dispatchEvent(Object.assign(new Event('error'), { message: 'render failed' }));
    else await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(f.disconnect).toHaveBeenCalled(); expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('背景のタブで描画が休止されても失敗にせず、戻って描いた時に終わる', async () => {
    const f = fixture(), done = vi.fn();
    Object.assign(document, { visibilityState: 'hidden' });
    const pending = waitForStartupView(new AbortController().signal).then(done);
    f.ready(); await vi.advanceTimersByTimeAsync(60_000);
    expect(done).not.toHaveBeenCalled();
    Object.assign(document, { visibilityState: 'visible' });
    f.frame(); f.frame(); await pending;
    expect(done).toHaveBeenCalledWith('ready'); expect(vi.getTimerCount()).toBe(0);
  });

  it('通常は180msで消え、動きを減らす設定では直ちに消える', async () => {
    const f = fixture();
    const pending = dismissStartupSplash();
    expect(f.shell.dataset['state']).toBe('leaving'); expect(f.shell.inert).toBe(true);
    await vi.advanceTimersByTimeAsync(179); expect(f.shell.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await pending; expect(f.shell.remove).toHaveBeenCalledOnce();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    await dismissStartupSplash(); expect(f.shell.remove).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('取得失敗の案内は読み直し可能なまま残す', () => {
    const f = fixture(); showStartupFailure();
    expect(f.loading.hidden).toBe(true); expect(f.failure.hidden).toBe(false);
    expect(f.failure.setAttribute).toHaveBeenCalledWith('role', 'alert');
    expect(f.shell.dataset['state']).toBe('failed'); expect(f.shell.inert).toBe(false);
    expect(f.shell.remove).not.toHaveBeenCalled();
  });

  it('本体の読み込みから実描画まで入力を待ち、使える時に解除して記録する', async () => {
    const f = fixture(), load = vi.fn(() => Promise.resolve()), log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const pending = startApplicationWithSplash(load);
    expect(f.root.inert).toBe(true); expect(load).not.toHaveBeenCalled();
    f.frame(); await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledOnce(); expect(f.root.inert).toBe(true);
    f.ready(); f.frame(); f.frame(); await vi.advanceTimersByTimeAsync(180); await pending;
    expect(f.root.inert).toBe(false); expect(f.shell.remove).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pcad:startup:splash-hidden'));
    expect([...f.storage]).toEqual([['user-document', 'keep']]);
  });

  it('本体の取得失敗は1回だけ再読み込みし、続く失敗を表示する', async () => {
    const f = fixture(), error = new TypeError('Failed to fetch dynamically imported module');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi.fn(() => Promise.reject(error));
    let pending = startApplicationWithSplash(load); f.frame(); await vi.advanceTimersByTimeAsync(0); await pending;
    expect(f.reload).toHaveBeenCalledOnce();
    pending = startApplicationWithSplash(load); f.frame(); await vi.advanceTimersByTimeAsync(0); await pending;
    expect(f.reload).toHaveBeenCalledOnce(); expect(f.failure.hidden).toBe(false); expect(f.root.inert).toBe(true);
    expect(f.storage.get('user-document')).toBe('keep'); expect(vi.getTimerCount()).toBe(0);
  });

  it('本体の要求が返らない時も期限で復旧を示し、遅い応答で失敗表示を上書きしない', async () => {
    const f = fixture(); vi.spyOn(console, 'error').mockImplementation(() => {});
    let release = (): void => {};
    const module = new Promise<void>(resolve => { release = resolve; });
    const pending = startApplicationWithSplash(() => module);
    f.frame(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    expect(f.failure.hidden).toBe(false); expect(f.root.inert).toBe(true);
    expect(f.shell.inert).toBe(false); expect(f.shell.remove).not.toHaveBeenCalled();
    release(); await Promise.resolve();
    expect(document.documentElement.dataset['startupStage']).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['during-fade', 'after-fade'] as const)('起動後の遅延読込み失敗で起動画面を戻さない: %s', async phase => {
    const f = fixture();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const pending = startApplicationWithSplash(() => Promise.resolve());
    f.frame(); await vi.advanceTimersByTimeAsync(0);
    f.ready(); f.frame(); f.frame(); await vi.advanceTimersByTimeAsync(0);
    if (phase === 'after-fade') { await vi.advanceTimersByTimeAsync(180); await pending; }
    const stage = document.documentElement.dataset['startupStage'];
    f.window.dispatchEvent(Object.assign(new Event('error'), { message: 'Failed to fetch dynamically imported module: panel.js' }));
    const preload = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new Error('Unable to preload CSS for panel.css') });
    f.window.dispatchEvent(preload);
    // Also exercise a previously queued recovery callback while the fading node still exists.
    showStartupFailure();
    expect(f.shell.dataset['state']).toBe('leaving'); expect(f.shell.inert).toBe(true);
    expect(f.failure.hidden).toBe(true); expect(f.root.inert).toBe(false);
    expect(document.documentElement.dataset['startupStage']).toBe(stage);
    expect(preload.defaultPrevented).toBe(false); expect(errorLog).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled(); expect([...f.storage]).toEqual([['user-document', 'keep']]);
    await vi.advanceTimersByTimeAsync(180); await pending;
    expect(f.shell.remove).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['render-error', 'timeout', 'module-error'] as const)('起動失敗の後でも実描画が完了すれば覆いを外す: %s', async reason => {
    const f = fixture();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = new Error('render or module evaluation failed');
    const pending = startApplicationWithSplash(() => reason === 'module-error' ? Promise.reject(error) : Promise.resolve());
    f.frame(); await vi.advanceTimersByTimeAsync(0);
    if (reason === 'render-error') f.window.dispatchEvent(Object.assign(new Event('error'), { message: error.message }));
    else if (reason === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(f.shell.dataset['state']).toBe('failed'); expect(f.failure.hidden).toBe(false);
    expect(f.root.inert).toBe(true); expect(f.reload).not.toHaveBeenCalled();
    expect(errorLog.mock.calls[0]?.[1]).toContain('Error:');
    expect(vi.getTimerCount()).toBe(0);
    f.ready(); f.frame(); expect(f.root.inert).toBe(true);
    f.frame(); await vi.advanceTimersByTimeAsync(180);
    expect(f.root.inert).toBe(false); expect(f.shell.remove).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset['startupStage']).toBe('splash-hidden');
    expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect([...f.storage]).toEqual([['user-document', 'keep']]);
    showStartupFailure(); expect(f.shell.dataset['state']).toBe('leaving');
  });

  it('失敗通知時に本体が描けていれば、失敗の全画面表示へ切り替えない', async () => {
    const f = fixture(); vi.spyOn(console, 'info').mockImplementation(() => {});
    f.ready(); showStartupFailure();
    expect(f.failure.hidden).toBe(true);
    f.frame(); f.frame(); await vi.advanceTimersByTimeAsync(180);
    expect(f.root.inert).toBe(false); expect(f.shell.remove).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset['startupStage']).toBe('splash-hidden');
  });

  it('起動失敗の後に区画内の復旧表示が描けた場合も、その再試行を覆わない', async () => {
    const f = fixture(); vi.spyOn(console, 'info').mockImplementation(() => {});
    showStartupFailure();
    f.present.add('.pcad-viewport [role="alert"]'); f.changed();
    f.frame(); f.frame(); await vi.advanceTimersByTimeAsync(180);
    expect(f.root.inert).toBe(false); expect(f.shell.remove).toHaveBeenCalledOnce();
  });

  it('失敗後の描画確認中に本体が消えたら、実描画が揃うまで復旧案内を残す', async () => {
    const f = fixture(); vi.spyOn(console, 'info').mockImplementation(() => {});
    showStartupFailure(); showStartupFailure();
    f.ready(); f.frame(); f.present.delete('canvas.pcad-viewcube'); f.frame();
    expect(f.shell.dataset['state']).toBe('failed'); expect(f.root.inert).toBe(true);
    expect(f.shell.remove).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
    f.ready(); f.frame(); f.frame(); await vi.advanceTimersByTimeAsync(180);
    expect(f.root.inert).toBe(false); expect(f.shell.remove).toHaveBeenCalledOnce();
    f.changed(); expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('描画エラーの元の例外と、例外がない場合の発生元を診断へ残す', async () => {
    const f = fixture(), error = new TypeError('render source failed');
    let pending = waitForStartupView(new AbortController().signal);
    const original = expect(pending).rejects.toBe(error);
    f.window.dispatchEvent(Object.assign(new Event('error'), { error })); await original;
    pending = waitForStartupView(new AbortController().signal);
    const located = expect(pending).rejects.toThrow('Script error. (renderer.js:12:34)');
    f.window.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.', filename: 'renderer.js', lineno: 12, colno: 34 }));
    await located;
  });

  it.each([
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
  ])('例外を伴わない ResizeObserver の知らせ「%s」では起動の失敗にせず、描画の完了を待つ', async message => {
    const f = fixture(), done = vi.fn();
    const pending = waitForStartupView(new AbortController().signal).then(done);
    f.ready();
    f.window.dispatchEvent(Object.assign(new Event('error'), { message, error: null }));
    f.frame(); f.frame(); await pending;
    expect(done).toHaveBeenCalledWith('ready'); expect(f.frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('ResizeObserver の知らせの後でも、本当の描画の例外は起動の失敗にする', async () => {
    const f = fixture(), error = new TypeError('render failed after a layout loop');
    const pending = waitForStartupView(new AbortController().signal);
    const rejected = expect(pending).rejects.toBe(error);
    f.window.dispatchEvent(Object.assign(new Event('error'), { message: 'ResizeObserver loop completed with undelivered notifications.' }));
    f.window.dispatchEvent(Object.assign(new Event('error'), { message: 'ResizeObserver loop completed with undelivered notifications.', error }));
    await rejected;
    expect(f.disconnect).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('起動の失敗を記録する文に、Firefox の stack に無い例外の名前と本文を含める', async () => {
    const f = fixture();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = new Error('view evaluation failed');
    error.stack = 'a@http://127.0.0.1:4173/assets/index.js:2:3434\nm@http://127.0.0.1:4173/assets/index.js:2:3194\n';
    const pending = startApplicationWithSplash(() => Promise.reject(error));
    f.frame(); await vi.advanceTimersByTimeAsync(0); await pending;
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]?.[1]).toBe(`Error: view evaluation failed\n${error.stack}`);
    expect(errorLog.mock.calls[0]?.[2]).toBe(error);
  });

  it('読み直し・移動で離れ始めた後の失敗は起動の失敗として記録も全画面表示もしない', async () => {
    const f = fixture();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reject: (error: Error) => void = () => {};
    const module = new Promise<void>((...handlers) => { reject = handlers[1]; });
    const pending = startApplicationWithSplash(() => module);
    f.frame(); await vi.advanceTimersByTimeAsync(0);
    f.window.dispatchEvent(new Event('beforeunload'));
    reject(new TypeError('NetworkError when attempting to fetch resource.'));
    await vi.advanceTimersByTimeAsync(0); await pending;
    expect(errorLog).not.toHaveBeenCalled(); expect(f.reload).not.toHaveBeenCalled();
    expect(f.failure.hidden).toBe(true); expect(f.root.inert).toBe(false);
    expect([...f.storage]).toEqual([['user-document', 'keep']]);
    // If the navigation is called off, the page still gets the recovery notice.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.failure.hidden).toBe(false); expect(errorLog).not.toHaveBeenCalled();
  });
});
