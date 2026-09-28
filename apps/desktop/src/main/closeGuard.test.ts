/**
 * デスクトップ版の窓を閉じるときの未保存の確認(レビュー R03)を、本体の入口 `main.ts` から検査する。
 *
 * 確かめること:
 *  - 本体が作った主窓は、画面が確認の用意を知らせた後だけ、×・Alt+F4 などの「閉じる」を止めて画面へ問い合わせる。
 *  - 画面の答え(閉じる・戻る)どおりにし、問合せ中に重ねて閉じても確認を二重に出さない。
 *  - 画面が答えないときは強制的に閉じるかを本体の窓で聞き、閉じられなくならない。
 *  - 送信元の確認(appSender.ts)を通らない画面・印刷用の隠し窓からの知らせは受けない。
 *  - Windows の終了・再起動・サインアウト(query-session-end)では、未保存があるときだけ止めて確認する。
 *  - アプリ全体の終了(app.quit。Linux の終了の合図も同じ道)でも止めて確認し、画面検査の入口が渡す印が
 *    あるときだけ、検査の後片付けの終了を止めない。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLOSE_GUARD_TEST_BYPASS_ENV } from './closeGuard.js';

const native = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const appListeners = new Map<string, Listener[]>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const windows: FakeWindow[] = [];
  function emitTo(listeners: Map<string, Listener[]>, name: string, args: unknown[]): void {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  }
  function preventable() {
    let prevented = false;
    return { preventDefault: () => { prevented = true; }, get prevented() { return prevented; } };
  }
  class FakeContents {
    readonly listeners = new Map<string, Listener[]>();
    readonly mainFrame = { url: 'app://pointercad/index.html' };
    readonly send = vi.fn<(channel: string, ...args: unknown[]) => void>();
    readonly setWindowOpenHandler = vi.fn();
    readonly executeJavaScript = vi.fn(() => Promise.resolve());
    crashed = false;
    readonly on = vi.fn((name: string, listener: Listener) => {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    });
    isDestroyed(): boolean { return false; }
    isCrashed(): boolean { return this.crashed; }
    emit(name: string, ...args: unknown[]): void { emitTo(this.listeners, name, args); }
  }
  class FakeWindow {
    readonly listeners = new Map<string, Listener[]>();
    readonly webContents = new FakeContents();
    closed = false;
    readonly on = vi.fn((name: string, listener: Listener) => {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    });
    readonly once = vi.fn();
    readonly show = vi.fn();
    readonly loadURL = vi.fn(() => Promise.resolve());
    /** Electron と同じく、閉じる前に `close` を出し、止められなければ閉じる。 */
    readonly close = vi.fn(() => {
      const event = preventable();
      this.emit('close', event);
      if (!event.prevented) this.closed = true;
    });
    /** `close` を出さずに閉じる(Electron の destroy と同じ)。 */
    readonly destroy = vi.fn(() => { this.closed = true; });
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      windows.push(this);
      // Electron は窓を作るたびに app の browser-window-created を出す。
      emitTo(appListeners, 'browser-window-created', [preventable(), this]);
    }
    emit(name: string, ...args: unknown[]): void { emitTo(this.listeners, name, args); }
    static getAllWindows() { return windows; }
  }
  return {
    FakeWindow, windows, handlers, appListeners, preventable,
    showMessageBox: vi.fn<(window: unknown, options: { buttons: string[]; message: string; detail?: string;
      cancelId?: number; defaultId?: number }) => Promise<{ response: number; checkboxChecked: boolean }>>(),
    emitApp: (name: string, ...args: unknown[]) => { emitTo(appListeners, name, args); },
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    whenReady: () => Promise.resolve(),
    on: (name: string, listener: (...args: unknown[]) => void) => {
      native.appListeners.set(name, [...(native.appListeners.get(name) ?? []), listener]);
    },
    quit: vi.fn(),
  },
  BrowserWindow: native.FakeWindow,
  dialog: { showMessageBox: native.showMessageBox },
  ipcMain: { handle: (name: string, callback: (...args: unknown[]) => unknown) => { native.handlers.set(name, callback); } },
  Menu: { setApplicationMenu: vi.fn() },
  session: { defaultSession: { on: vi.fn() } },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
}));
vi.mock('@pointercad/ui/open-with', () => ({ isAllowedCamUrl: () => false }));
vi.mock('./appProtocol.js', () => ({
  APP_SCHEME: 'app', APP_HOST: 'pointercad', APP_ENTRY_URL: 'app://pointercad/index.html',
  registerAppScheme: vi.fn(), handleAppScheme: vi.fn(),
}));
vi.mock('./pcadDialogs.js', () => ({ PCAD_PRINT_CHANNEL: 'pcad:print', registerPcadIpc: vi.fn() }));
vi.mock('./sessionPermissions.js', () => ({ denyBrowserPermissions: vi.fn() }));
vi.mock('./drawingPrintDocument.js', () => ({ drawingPrintDocument: vi.fn() }));

type Window = InstanceType<typeof native.FakeWindow>;

const TEXTS = {
  message: '保存していない変更があります。', detail: '閉じると失われます。',
  save: '保存して閉じる', discard: '保存せずに閉じる', cancel: '戻る',
  unresponsiveMessage: '画面が応答していません。', unresponsiveDetail: '強制的に閉じると失われます。',
  forceClose: '強制的に閉じる',
};

let registerAppWindow: (window: Window) => void = () => { throw new Error('未準備'); };

beforeAll(async () => {
  await import('./main.js');
  await vi.waitFor(() => { expect(native.windows).toHaveLength(1); });
  const sender = await import('./appSender.js');
  registerAppWindow = (window) => { Reflect.apply(sender.registerAppWindow, undefined, [window]); };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  native.showMessageBox.mockReset();
});

function invoke(channel: string, window: Window, ...args: unknown[]): unknown {
  const handler = native.handlers.get(channel);
  if (handler === undefined) throw new Error(`IPC未登録: ${channel}`);
  return Reflect.apply(handler, undefined, [{ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args]);
}

/** 利用者が×を押したときと同じく `close` を出し、止められたかを返す。 */
function pressClose(window: Window): boolean {
  const event = native.preventable();
  window.emit('close', event);
  return event.prevented;
}

/** main.ts の主窓と同じく、送信元として登録した窓を作る。 */
function appWindow(): Window {
  const window = new native.FakeWindow({ webPreferences: {} });
  registerAppWindow(window);
  return window;
}

async function readyWindow(unsaved = true): Promise<Window> {
  const window = appWindow();
  expect(await invoke('pcad:closeGuardReady', window, TEXTS)).toBe(true);
  expect(await invoke('pcad:closeGuardState', window, unsaved)).toBe(true);
  return window;
}

function lastRequest(window: Window): string {
  const call = window.webContents.send.mock.calls.at(-1);
  if (call?.[0] !== 'pcad:closeRequest' || typeof call[1] !== 'string') throw new Error('閉じる問合せが送られていません');
  return call[1];
}

describe('デスクトップ版の窓を閉じるときの未保存の確認(R03)', () => {
  it('main.ts の主窓は、画面の用意の前は止めず、用意の後は×を止めて画面へ問い合わせる', async () => {
    const main = native.windows[0];
    if (main === undefined) throw new Error('主窓なし');
    expect(pressClose(main)).toBe(false);
    expect(await invoke('pcad:closeGuardReady', main, TEXTS)).toBe(true);
    expect(pressClose(main)).toBe(true);
    const id = lastRequest(main);
    // 戻る: 窓は開いたまま、次の×でまた問い合わせる。
    expect(await invoke('pcad:closeAnswer', main, id, false)).toBe(true);
    expect(main.close).not.toHaveBeenCalled();
    expect(pressClose(main)).toBe(true);
    expect(lastRequest(main)).not.toBe(id);
  });

  it('画面が閉じてよいと答えたら閉じ、その後の close は止めない', async () => {
    const window = await readyWindow(false);
    expect(pressClose(window)).toBe(true);
    expect(await invoke('pcad:closeAnswer', window, lastRequest(window), true)).toBe(true);
    expect(window.close).toHaveBeenCalledOnce();
    expect(window.closed).toBe(true);
    expect(native.showMessageBox).not.toHaveBeenCalled();
  });

  it('3つの選択肢を本体の窓で1回だけ出し、選んだものを画面へ返す', async () => {
    const window = await readyWindow();
    for (const [response, choice] of [[0, 'save'], [1, 'discard'], [2, 'cancel']] as const) {
      native.showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false });
      expect(pressClose(window)).toBe(true);
      const id = lastRequest(window);
      // 問い合わせ中に重ねて×を押しても、新しい問合せも確認も出さない。
      expect(pressClose(window)).toBe(true);
      expect(window.webContents.send).toHaveBeenCalledTimes(response + 1);
      expect(await invoke('pcad:closeChoice', window, id)).toBe(choice);
      expect(await invoke('pcad:closeAnswer', window, id, false)).toBe(true);
    }
    expect(native.showMessageBox).toHaveBeenCalledTimes(3);
    const [parent, options] = native.showMessageBox.mock.calls[0] ?? [];
    expect(parent).toBe(window);
    expect(options).toMatchObject({ buttons: [TEXTS.save, TEXTS.discard, TEXTS.cancel], message: TEXTS.message,
      detail: TEXTS.detail, defaultId: 0, cancelId: 2 });
    expect(window.close).not.toHaveBeenCalled();
  });

  it('古い問合せの番号・形の違う答えは受けず、窓を閉じない', async () => {
    const window = await readyWindow();
    expect(pressClose(window)).toBe(true);
    const id = lastRequest(window);
    expect(await invoke('pcad:closeAnswer', window, 'old-request', true)).toBe(false);
    expect(await invoke('pcad:closeAnswer', window, id, 'yes')).toBe(false);
    expect(await invoke('pcad:closeChoice', window, 'old-request')).toBe('cancel');
    expect(native.showMessageBox).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
    expect(await invoke('pcad:closeAnswer', window, id, false)).toBe(true);
  });

  it('送信元として登録していない窓(印刷用の隠し窓など)と、形の違う文言の知らせは受けない', async () => {
    const hidden = new native.FakeWindow({ webPreferences: {} });
    expect(await invoke('pcad:closeGuardReady', hidden, TEXTS)).toBe(false);
    expect(await invoke('pcad:closeGuardState', hidden, true)).toBe(false);
    expect(pressClose(hidden)).toBe(false);
    const window = appWindow();
    expect(await invoke('pcad:closeGuardReady', window, { ...TEXTS, save: 1 })).toBe(false);
    expect(await invoke('pcad:closeGuardReady', window, { ...TEXTS, save: '' })).toBe(false);
    expect(pressClose(window)).toBe(false);
    // 子frameからの知らせも受けない。
    const handler = native.handlers.get('pcad:closeGuardReady');
    expect(await Reflect.apply(handler ?? (() => undefined), undefined,
      [{ sender: window.webContents, senderFrame: { url: 'app://pointercad/index.html' } }, TEXTS])).toBe(false);
    expect(pressClose(window)).toBe(false);
  });

  it('画面が5秒答えず未保存が残っていれば強制的に閉じるかを聞き、選べば閉じる', async () => {
    vi.useFakeTimers();
    const window = await readyWindow(true);
    native.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(pressClose(window)).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(native.showMessageBox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(native.showMessageBox).toHaveBeenCalledOnce();
    expect(native.showMessageBox.mock.calls[0]?.[1]).toMatchObject({ buttons: [TEXTS.forceClose, TEXTS.cancel],
      message: TEXTS.unresponsiveMessage, detail: TEXTS.unresponsiveDetail, defaultId: 1, cancelId: 1 });
    // 戻るを選ぶと窓は残り、遅れて届いた答えは受けない。
    expect(window.destroy).not.toHaveBeenCalled();
    const late = lastRequest(window);
    expect(await invoke('pcad:closeAnswer', window, late, true)).toBe(false);
    expect(window.closed).toBe(false);
    // もう一度閉じると新しく問い合わせ、また答えが無ければ今度は強制的に閉じる。
    expect(pressClose(window)).toBe(true);
    expect(lastRequest(window)).not.toBe(late);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(native.showMessageBox).toHaveBeenCalledTimes(2);
    expect(window.destroy).toHaveBeenCalledOnce();
  });

  it('画面が答えず未保存も無いと知らされていれば、聞かずに閉じる', async () => {
    vi.useFakeTimers();
    const window = await readyWindow(false);
    expect(pressClose(window)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(native.showMessageBox).not.toHaveBeenCalled();
    expect(window.destroy).toHaveBeenCalledOnce();
  });

  it('保存の途中で画面が固まったら、次の×で強制的に閉じるかを聞く', async () => {
    const window = await readyWindow();
    native.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(pressClose(window)).toBe(true);
    expect(await invoke('pcad:closeChoice', window, lastRequest(window))).toBe('save');
    // 応答している間の×は、保存を待つ(確認を重ねない)。
    expect(pressClose(window)).toBe(true);
    expect(native.showMessageBox).toHaveBeenCalledOnce();
    window.emit('unresponsive');
    expect(pressClose(window)).toBe(true);
    await vi.waitFor(() => { expect(window.destroy).toHaveBeenCalledOnce(); });
    expect(native.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('画面が落ちた・読み直した後は、用意の知らせが来るまで止めない', async () => {
    const crashed = await readyWindow();
    crashed.webContents.emit('render-process-gone', native.preventable(), { reason: 'crashed' });
    expect(pressClose(crashed)).toBe(false);
    const reloaded = await readyWindow();
    expect(pressClose(reloaded)).toBe(true);
    reloaded.webContents.emit('did-navigate', native.preventable(), 'app://pointercad/index.html');
    expect(pressClose(reloaded)).toBe(false);
    expect(await invoke('pcad:closeGuardReady', reloaded, TEXTS)).toBe(true);
    expect(pressClose(reloaded)).toBe(true);
  });

  it('Windows の終了要求は、未保存があるときだけ止めて確認し、無ければ止めない', async () => {
    const dirty = await readyWindow(true);
    const shutdown = native.preventable();
    dirty.emit('query-session-end', shutdown);
    expect(shutdown.prevented).toBe(true);
    expect(dirty.webContents.send).toHaveBeenCalledWith('pcad:closeRequest', expect.any(String));
    const clean = await readyWindow(false);
    const cleanShutdown = native.preventable();
    clean.emit('query-session-end', cleanShutdown);
    expect(cleanShutdown.prevented).toBe(false);
    expect(clean.webContents.send).not.toHaveBeenCalled();
    expect(await invoke('pcad:closeGuardState', clean, 'dirty')).toBe(false);
  });

  it('アプリ全体の終了でも止めて確認し、検査の印があるときだけ後片付けの終了を止めない', async () => {
    const window = await readyWindow(true);
    // 印が無い: app.quit() が出す before-quit の後の close も止めて問い合わせる。
    vi.stubEnv(CLOSE_GUARD_TEST_BYPASS_ENV, '0');
    native.emitApp('before-quit', native.preventable());
    expect(pressClose(window)).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledOnce();
    expect(await invoke('pcad:closeAnswer', window, lastRequest(window), false)).toBe(true);
    // 画面検査の入口が渡す印: 終了の時点で読み、後片付けの終了は止めない。
    vi.stubEnv(CLOSE_GUARD_TEST_BYPASS_ENV, '1');
    expect(pressClose(window)).toBe(true);
    expect(await invoke('pcad:closeAnswer', window, lastRequest(window), false)).toBe(true);
    native.emitApp('before-quit', native.preventable());
    expect(pressClose(window)).toBe(false);
    expect(window.webContents.send).toHaveBeenCalledTimes(2);
  });
});
