import { beforeAll, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const windows: FakeWindow[] = [];
  const sessionListeners = new Map<string, (...args: unknown[]) => void>();
  const appListeners = new Map<string, () => void>();
  const load = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  class FakeWindow {
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    readonly webContents = {
      mainFrame: { url: 'app://pointercad/index.html' },
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { this.listeners.set(name, listener); }),
      setWindowOpenHandler: vi.fn<(handler: (details: { url: string }) => { action: string }) => void>(),
      executeJavaScript: vi.fn(() => Promise.resolve()),
      print: vi.fn((_options: unknown, callback: (success: boolean) => void) => { callback(true); }),
    };
    readonly once = vi.fn();
    readonly show = vi.fn();
    readonly destroy = vi.fn();
    readonly isDestroyed = vi.fn(() => false);
    readonly loadURL = vi.fn((url: string) => load(url));
    constructor(readonly options: { webPreferences: Record<string, unknown> }) { windows.push(this); }
    static getAllWindows() { return windows; }
  }
  return { FakeWindow, windows, sessionListeners, appListeners, load, handlers,
    openExternal: vi.fn(() => Promise.resolve()),
    denyBrowserPermissions: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: true, whenReady: () => Promise.resolve(),
    on: (name: string, listener: () => void) => { native.appListeners.set(name, listener); }, quit: vi.fn() },
  BrowserWindow: native.FakeWindow,
  ipcMain: { handle: (name: string, callback: (...args: unknown[]) => unknown) => { native.handlers.set(name, callback); } },
  Menu: { setApplicationMenu: vi.fn() },
  session: { defaultSession: {
    on: (name: string, callback: (...args: unknown[]) => void) => { native.sessionListeners.set(name, callback); },
  } },
  shell: { openExternal: native.openExternal },
}));
vi.mock('@pointercad/ui/open-with', () => ({ isAllowedCamUrl: (url: string) => url === 'https://approved.example/' }));
vi.mock('./appProtocol.js', () => ({
  APP_SCHEME: 'app', APP_HOST: 'pointercad', APP_ENTRY_URL: 'app://pointercad/index.html',
  registerAppScheme: vi.fn(), handleAppScheme: vi.fn(),
}));
vi.mock('./pcadDialogs.js', () => ({ PCAD_PRINT_CHANNEL: 'pcad:print', registerPcadIpc: vi.fn() }));
vi.mock('./sessionPermissions.js', () => ({ denyBrowserPermissions: native.denyBrowserPermissions }));
vi.mock('./drawingPrintDocument.js', () => ({ drawingPrintDocument: vi.fn() }));

beforeAll(async () => {
  await import('./main.js');
  await vi.waitFor(() => { expect(native.windows).toHaveLength(1); });
});

function event(url?: string) {
  let prevented = false;
  return { url, preventDefault: () => { prevented = true; }, get prevented() { return prevented; } };
}

function windowListener(index: number, name: string): (...args: unknown[]) => void {
  const listener = native.windows[index]?.listeners.get(name);
  if (listener === undefined) throw new Error(`窓${index}の${name}が未登録`);
  return listener;
}

describe('主窓と印刷窓の境界', () => {
  it('主窓の安全な設定と外部遷移・リダイレクト・webview拒否を固定する', () => {
    const main = native.windows[0];
    if (main === undefined) throw new Error('主窓なし');
    expect(main.options.webPreferences).toMatchObject({
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    });
    expect(main.options).toMatchObject({ show: true, backgroundColor: '#16181d' });
    expect(main.once).not.toHaveBeenCalledWith('ready-to-show', expect.any(Function));
    const navigation = event();
    windowListener(0, 'will-navigate')(navigation, 'https://untrusted.example/');
    expect(navigation.prevented).toBe(true);
    const redirect = event('https://untrusted.example/');
    windowListener(0, 'will-redirect')(redirect);
    expect(redirect.prevented).toBe(true);
    const internal = event('app://pointercad/help');
    windowListener(0, 'will-redirect')(internal);
    expect(internal.prevented).toBe(false);
    const webview = event();
    windowListener(0, 'will-attach-webview')(webview);
    expect(webview.prevented).toBe(true);
    const openHandler = main.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (openHandler === undefined) throw new Error('新窓拒否なし');
    expect(Reflect.apply(openHandler, undefined, [{ url: 'https://untrusted.example/' }])).toEqual({ action: 'deny' });
    expect(native.openExternal).not.toHaveBeenCalled();
    expect(Reflect.apply(openHandler, undefined, [{ url: 'https://approved.example/' }])).toEqual({ action: 'deny' });
    expect(native.openExternal).toHaveBeenCalledExactlyOnceWith('https://approved.example/');
  });

  it('印刷は許可した主窓だけが使い、隠し窓にも同じ制限を付ける', async () => {
    const handler = native.handlers.get('pcad:print');
    const main = native.windows[0];
    if (handler === undefined || main === undefined) throw new Error('印刷口なし');
    expect(await Reflect.apply(handler, undefined, [{ sender: main.webContents, senderFrame: null }, Uint8Array.of(1)])).toBe(false);
    expect(native.windows).toHaveLength(1);
    expect(await Reflect.apply(handler, undefined, [{ sender: main.webContents, senderFrame: main.webContents.mainFrame }, Uint8Array.of(1)])).toBe(true);
    const print = native.windows[1];
    if (print === undefined) throw new Error('印刷窓なし');
    expect(print.options.webPreferences).toMatchObject({
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    });
    expect(print.options.webPreferences).not.toHaveProperty('preload');
    expect(print.options).toMatchObject({ show: false });
    const navigation = event();
    windowListener(1, 'will-navigate')(navigation, 'https://untrusted.example/');
    expect(navigation.prevented).toBe(true);
    const redirect = event('https://untrusted.example/');
    windowListener(1, 'will-redirect')(redirect);
    expect(redirect.prevented).toBe(true);
    const webview = event();
    windowListener(1, 'will-attach-webview')(webview);
    expect(webview.prevented).toBe(true);
    const openHandler = print.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (openHandler === undefined) throw new Error('印刷窓の新窓拒否なし');
    expect(Reflect.apply(openHandler, undefined, [{ url: 'https://approved.example/' }])).toEqual({ action: 'deny' });
    expect(print.destroy).toHaveBeenCalledOnce();
  });

  it('許可済みsenderでも pcad:print の不正な引数を例外で断り、隠し窓を作らない', async () => {
    const handler = native.handlers.get('pcad:print');
    const main = native.windows[0];
    if (handler === undefined || main === undefined) throw new Error('印刷口なし');
    const windowsBefore = native.windows.length;
    await expect(Reflect.apply(handler, undefined,
      [{ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'not-bytes'])).rejects.toThrow('印刷の依頼の形が正しくありません。');
    await expect(Reflect.apply(handler, undefined,
      [{ sender: main.webContents, senderFrame: main.webContents.mainFrame }, Uint8Array.of(1), { pageSize: 'unknown-size' }])).rejects.toThrow('図面の印刷設定が正しくありません。');
    expect(native.windows).toHaveLength(windowsBefore);
  });

  it('sessionのブラウザーダウンロードを拒否する', () => {
    expect(native.denyBrowserPermissions).toHaveBeenCalledOnce();
    const download = native.sessionListeners.get('will-download');
    if (download === undefined) throw new Error('ダウンロード拒否なし');
    const attempted = event();
    download(attempted);
    expect(attempted.prevented).toBe(true);
  });

  it('初回のHTML読込みが失敗しても同じ窓で復旧表示を出す', async () => {
    const activate = native.appListeners.get('activate');
    if (activate === undefined) throw new Error('窓を作り直す入口なし');
    const error = new Error('renderer document unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const windows = vi.spyOn(native.FakeWindow, 'getAllWindows').mockReturnValueOnce([]);
    try {
      native.load.mockRejectedValueOnce(error);
      const count = native.windows.length;
      activate();
      await vi.waitFor(() => { expect(native.windows[count]?.loadURL).toHaveBeenCalledTimes(2); });
      const failedWindow = native.windows[count];
      const address = failedWindow?.loadURL.mock.calls[1]?.[0];
      if (address === undefined) throw new Error('復旧の文書なし');
      expect(address).toMatch(/^data:text\/html;charset=utf-8,/u);
      const html = decodeURIComponent(address.slice(address.indexOf(',') + 1));
      expect(html).toContain('data-startup-failure role="alert"');
      expect(html).toContain('<a href="app://pointercad/index.html">');
      expect(log).toHaveBeenCalledWith('PointerCAD document load failed', error);
      expect(native.windows).toHaveLength(count + 1);
    } finally { windows.mockRestore(); log.mockRestore(); }
  });
});
