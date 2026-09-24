import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedAppUrl, registerAppWindow, validateAppSender } from './appSender.js';

vi.mock('./appProtocol.js', () => ({ APP_SCHEME: 'app', APP_HOST: 'pointercad' }));

afterEach(() => { vi.unstubAllEnvs(); });

function sender(url: string, registered = true) {
  const mainFrame = { url };
  const webContents = { mainFrame };
  if (registered) Reflect.apply(registerAppWindow, undefined, [{ webContents }]);
  return { webContents, mainFrame };
}

function validate(webContents: object, senderFrame: object | null): boolean {
  return Reflect.apply(validateAppSender, undefined, [{ sender: webContents, senderFrame }]) as boolean;
}

describe('許可する画面のURL', () => {
  it('app配信元の入口を許可する', () => {
    expect(isAllowedAppUrl('app://pointercad/index.html')).toBe(true);
  });
  it('app配信元の別のページも許可する', () => {
    expect(isAllowedAppUrl('app://pointercad/help/index.html')).toBe(true);
  });
  it('別のappホストは拒否する', () => {
    expect(isAllowedAppUrl('app://other/index.html')).toBe(false);
  });
  it('開発サーバーを指定しなければWeb配信元を拒否する', () => {
    expect(isAllowedAppUrl('http://localhost:4173/index.html')).toBe(false);
  });
  it('明示した開発サーバーと同じoriginを許可する', () => {
    expect(isAllowedAppUrl('http://localhost:4173/help', 'http://localhost:4173/')).toBe(true);
  });
  it('開発サーバーと違うポートを拒否する', () => {
    expect(isAllowedAppUrl('http://localhost:4174/', 'http://localhost:4173/')).toBe(false);
  });
  it('開発サーバーと違うホストを拒否する', () => {
    expect(isAllowedAppUrl('http://example.com:4173/', 'http://localhost:4173/')).toBe(false);
  });
  it('不正な候補URLを拒否する', () => {
    expect(isAllowedAppUrl('not a URL', 'http://localhost:4173/')).toBe(false);
  });
  it('不正な開発サーバーURLを許可の根拠にしない', () => {
    expect(isAllowedAppUrl('https://example.com/', 'not a URL')).toBe(false);
  });
});

describe('IPCを呼んだ画面の認証', () => {
  it('登録された主窓のmain frameを許可する', () => {
    const { webContents, mainFrame } = sender('app://pointercad/index.html');
    expect(validate(webContents, mainFrame)).toBe(true);
  });
  it('未登録の画面を拒否する', () => {
    const { webContents, mainFrame } = sender('app://pointercad/index.html', false);
    expect(validate(webContents, mainFrame)).toBe(false);
  });
  it('登録済み画面でも子frameを拒否する', () => {
    const { webContents } = sender('app://pointercad/index.html');
    expect(validate(webContents, { url: 'app://pointercad/index.html' })).toBe(false);
  });
  it('登録済みのmain frameでも許可外のURLを拒否する', () => {
    const { webContents, mainFrame } = sender('https://example.com/');
    expect(validate(webContents, mainFrame)).toBe(false);
  });
  it('senderFrameがnullなら拒否する', () => {
    const { webContents } = sender('app://pointercad/index.html');
    expect(validate(webContents, null)).toBe(false);
  });
  it('開発サーバーoriginのmain frameは明示設定があるときだけ許可する', () => {
    const { webContents, mainFrame } = sender('http://localhost:4173/index.html');
    expect(validate(webContents, mainFrame)).toBe(false);
    vi.stubEnv('PCAD_DEV_SERVER_URL', 'http://localhost:4173/');
    expect(validate(webContents, mainFrame)).toBe(true);
  });
});
