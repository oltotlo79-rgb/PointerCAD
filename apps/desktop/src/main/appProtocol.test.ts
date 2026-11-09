import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Protocol } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, handleAppScheme, registerAppScheme } from './appProtocol.js';
import { startupFailureDocument } from './startupHtml.js';
import { DESKTOP_OCCT_TRANSPORT_ORIGIN } from '@pointercad/ui/desktop-occt-transport';
import { APP_META_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { desktopAppContentSecurityPolicy, launchOcctTransportEphemeralPort, OCCT_TRANSPORT_TEST_PORT_ENV } from '../occtHttpPolicy.js';

const electron = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn<Protocol['registerSchemesAsPrivileged']>(),
  handle: vi.fn<Protocol['handle']>(),
  fetch: vi.fn<(url: string) => Promise<Response>>(),
}));
vi.mock('electron', () => ({
  protocol: { handle: electron.handle, registerSchemesAsPrivileged: electron.registerSchemesAsPrivileged },
  net: { fetch: electron.fetch },
}));

const root = join(process.cwd(), 'dist', 'renderer');

async function request(url: string): Promise<Response> {
  const handler = electron.handle.mock.calls[0]?.[1];
  if (handler === undefined) throw new Error('独自スキームの応答処理がありません');
  return handler(new Request(url));
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.fetch.mockImplementation(() => Promise.resolve(new Response('asset')));
  handleAppScheme(root);
});

describe('画面の独自スキームで不正なURLを拒否する', () => {
  it('Desktop主文書だけへ固定HTTP originを追加しmanual/Workerの権限を広げない', async () => {
    expect((await request(APP_ORIGIN + '/index.html')).headers.get('Content-Security-Policy'))
      .toContain("connect-src 'self' " + DESKTOP_OCCT_TRANSPORT_ORIGIN);
    for (const path of ['/manual/index.html', '/assets/kernel.worker-test.js', '/assets/other.js']) {
      expect((await request(APP_ORIGIN + path)).headers.get('Content-Security-Policy'))
        .not.toContain(DESKTOP_OCCT_TRANSPORT_ORIGIN);
    }
    expect(desktopAppContentSecurityPolicy("default-src 'none'; connect-src 'self'; worker-src 'none'"))
      .toContain("worker-src 'none'");
    expect(() => desktopAppContentSecurityPolicy("connect-src 'none'")).toThrow();
    expect(() => desktopAppContentSecurityPolicy("default-src 'none'")).toThrow();
  });
  it('検査の起動で所有した1つのloopback originだけを主文書へ追加し、固定originを足さない', async () => {
    const owned = 'http://127.0.0.1:50123';
    vi.clearAllMocks();
    electron.fetch.mockImplementation(() => Promise.resolve(new Response(readFileSync(join(root, 'index.html'), 'utf8'))));
    handleAppScheme(root, owned);
    const policy = (await request(APP_ORIGIN + '/index.html')).headers.get('Content-Security-Policy');
    expect(policy).toContain("connect-src 'self' " + owned);
    expect(policy).not.toContain(DESKTOP_OCCT_TRANSPORT_ORIGIN);
    for (const path of ['/manual/index.html', '/assets/kernel.worker-test.js', '/assets/other.js']) {
      expect((await request(APP_ORIGIN + path)).headers.get('Content-Security-Policy')).not.toContain(owned);
    }
  });
  it('所有originは実生成HTMLのmetaとHTTP headerで一致し、既定HTMLはそのまま保持する', async () => {
    const built = readFileSync(join(root, 'index.html'), 'utf8');
    const owned = 'http://127.0.0.1:50123';
    const tags = (html: string): string[] => html.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/giu) ?? [];
    const decoded = (tag: string): string => (tag.match(/content="([^"]*)"/u)?.[1] ?? '')
      .replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    expect(tags(built)).toHaveLength(1);
    expect(decoded(tags(built)[0])).toBe(desktopAppContentSecurityPolicy(APP_META_CONTENT_SECURITY_POLICY));
    vi.clearAllMocks();
    electron.fetch.mockImplementation(() => Promise.resolve(new Response(built)));
    handleAppScheme(root, owned);
    const response = await request(APP_ORIGIN + '/index.html');
    const html = await response.text();
    expect(tags(html)).toHaveLength(1);
    expect(decoded(tags(html)[0])).toBe(desktopAppContentSecurityPolicy(APP_META_CONTENT_SECURITY_POLICY, owned));
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self' " + owned);
    expect(decoded(tags(html)[0])).not.toContain(DESKTOP_OCCT_TRANSPORT_ORIGIN);
    expect(response.headers.get('Content-Security-Policy')).not.toContain(DESKTOP_OCCT_TRANSPORT_ORIGIN);
    const assetTags = (value: string): string[] => value.match(/<(?:script|link)\b[^>]*>/gu) ?? [];
    expect(assetTags(html)).toEqual(assetTags(built));
    for (const path of ['/manual/index.html', '/assets/kernel.worker-test.js']) {
      const untouched = await request(APP_ORIGIN + path);
      expect(await untouched.text()).toBe(built);
      expect(untouched.headers.get('Content-Security-Policy')).not.toContain(owned);
    }
    vi.clearAllMocks();
    electron.fetch.mockResolvedValue(new Response(built));
    handleAppScheme(root);
    expect(tags(await (await request(APP_ORIGIN + '/index.html')).text())).toEqual(tags(built));
  });
  it('所有originのHTMLで複数meta・欠落・生成形式不一致を黙って通さない', async () => {
    const built = readFileSync(join(root, 'index.html'), 'utf8');
    const meta = built.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/iu)?.[0];
    if (meta === undefined) throw new Error('Missing actual built CSP meta');
    for (const html of [built.replace(meta, meta + meta), built.replace(meta, ''),
      built.replace(meta, meta.replace('http-equiv=', 'HTTP-EQUIV='))]) {
      vi.clearAllMocks();
      electron.fetch.mockResolvedValue(new Response(html));
      handleAppScheme(root, 'http://127.0.0.1:50123');
      await expect(request(APP_ORIGIN + '/index.html')).rejects.toThrow('Unexpected built Desktop CSP meta');
    }
  });
  it('パッケージ版は検査用の印を読まず、未パッケージは0だけを受け付けて不正な値で起動を止める', () => {
    expect(launchOcctTransportEphemeralPort(false, undefined)).toBe(false);
    expect(launchOcctTransportEphemeralPort(true, '0')).toBe(false);
    expect(launchOcctTransportEphemeralPort(true, 'not-a-port')).toBe(false);
    expect(launchOcctTransportEphemeralPort(false, '0')).toBe(true);
    for (const value of ['', '1', '00', '-0', '+0', ' 0', '0 ', '0x0', '49721', '50123', 'true']) {
      expect(() => launchOcctTransportEphemeralPort(false, value)).toThrow(`Invalid ${OCCT_TRANSPORT_TEST_PORT_ENV}`);
    }
  });
  it('launchDesktop は省略時に印を付けず、W21 だけが付け、再起動のキャッシュ計測の経路は設定なしのまま', () => {
    const repository = fileURLToPath(new URL('../../../../', import.meta.url));
    // The helper is checked out with CRLF on some runners; compare its text with LF line ends.
    const flow = readFileSync(resolve(repository, 'e2e/tests/electronAppFlow.ts'), 'utf8').replace(/\r\n/gu, '\n');
    expect(flow).toContain(`OCCT_TRANSPORT_PORT_ENV = '${OCCT_TRANSPORT_TEST_PORT_ENV}'`);
    expect(flow.split(OCCT_TRANSPORT_TEST_PORT_ENV)).toHaveLength(2);
    // Omitted or false option: the inserted text is empty, so entry.cjs keeps its previous bytes.
    expect(flow).toContain("return ephemeralPort === true ? `process.env[${JSON.stringify(OCCT_TRANSPORT_PORT_ENV)}] = '0';\\n` : '';");
    expect(flow.split('occtTransportEntryLine(')).toHaveLength(3);
    expect(flow).toContain("process.env[${JSON.stringify(CLOSE_CONFIRM_BYPASS_ENV)}] = '1';\n${occtTransportEntryLine(options.occtTransportEphemeralPort)}// Native desktop input");
    const tests = resolve(repository, 'e2e/tests');
    const opting = readdirSync(tests).filter(name => name.endsWith('.ts') && name !== 'electronAppFlow.ts'
      && readFileSync(resolve(tests, name), 'utf8').includes('occtTransportEphemeralPort'));
    expect(opting).toEqual(['electronOcctTransportNegativeFlow.ts']);
    const main = readFileSync(resolve(repository, 'apps/desktop/src/main/main.ts'), 'utf8');
    expect(main).toContain('launchOcctTransportEphemeralPort(app.isPackaged, process.env[OCCT_TRANSPORT_TEST_PORT_ENV])');
    expect(main).toContain('handleAppScheme(rendererRoot, occtTransportEphemeralPort ? await ownedOcctTransportOrigin(occtTransport) : undefined)');
  });
  it('標準appスキームでコードキャッシュを有効にし、CSPを迂回する権限を追加しない', () => {
    registerAppScheme();
    expect(electron.registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([
      {
        scheme: 'app',
        privileges: {
          standard: true,
          codeCache: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ]);
  });

  it('HTML自体の読込み失敗でもJSに頼らない復旧表示と安全な読み直し先を残す', () => {
    const html = startupFailureDocument(APP_ORIGIN + '/index.html');
    expect(html).toContain('data-startup-shell data-state="failed"');
    expect(html).toContain('data-startup-loading hidden');
    expect(html).toContain('data-startup-failure role="alert"');
    expect(html).toContain('[data-startup-shell][data-state="failed"] .pcad-startup__recovery { animation: none; visibility: visible; }');
    expect(html).toContain(`<a href="${APP_ORIGIN}/index.html">`);
    expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'");
    expect(html).not.toContain('<script');
    expect(startupFailureDocument('https://localhost/?a="&b=<')).toContain('a=&quot;&amp;b=&lt;');
  });

  it('JSを実行する前のHTMLへ起動画面を載せ、資源URLと保護を保持する', async () => {
    electron.fetch.mockResolvedValue(new Response('<!doctype html><html><head><script type="module" src="./assets/entry.js"></script></head><body><div id="root"></div></body></html>',
      { headers: { 'Content-Length': '10' } }));
    const response = await request(APP_ORIGIN + '/index.html');
    const html = await response.text();
    expect(html).toContain('<main data-startup-shell');
    expect(html).toContain('画面を準備しています。');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).toContain('animation: pcad-startup-recovery 0s 8s forwards;');
    expect(html).toContain('@keyframes pcad-startup-recovery { to { visibility: visible; } }');
    expect(html).toContain('<script type="module" src="./assets/entry.js"></script>');
    expect(html).not.toContain('/src/bootstrap.ts');
    expect(html).not.toContain('{{startup:');
    expect(response.headers.has('Content-Length')).toBe(false);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('起動画面はHTMLの正常応答だけへ挿入する', async () => {
    electron.fetch.mockResolvedValue(new Response('<body>missing</body>', { status: 404 }));
    expect(await (await request(APP_ORIGIN + '/index.html')).text()).toBe('<body>missing</body>');
    electron.fetch.mockResolvedValue(new Response('<body>asset</body>'));
    expect(await (await request(APP_ORIGIN + '/assets/other.html')).text()).toBe('<body>asset</body>');
  });

  it.each(['/%', '/%GG', '/%C0%AF', '/%E3%81', '/%00.js'])(
    '%sを400で断り、ファイルを読み込まず次の要求に応答する', async (path) => {
      expect((await request(APP_ORIGIN + path)).status).toBe(400);
      expect(electron.fetch).not.toHaveBeenCalled();
      expect((await request(APP_ORIGIN + '/')).status).toBe(200);
    },
  );

  it.each(['app://elsewhere/index.html', 'https://pointercad/index.html',
    `${APP_ORIGIN}/%2e%2e%2fsecret`,
    ...(process.platform === 'win32' ? [`${APP_ORIGIN}/%2e%2e%5csecret`] : [])])(
    '%sから配信元の外を読まない', async (url) => {
      expect((await request(url)).status).toBe(403);
      expect(electron.fetch).not.toHaveBeenCalled();
    },
  );

  it('日本語・空白の正規パスを復号し、通常の保護ヘッダーを付ける', async () => {
    const response = await request(`${APP_ORIGIN}/assets/${encodeURIComponent('図面 1.svg')}`);
    expect(electron.fetch).toHaveBeenCalledExactlyOnceWith(pathToFileURL(join(root, 'assets', '図面 1.svg')).href);
    expect(await response.text()).toBe('asset');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Content-Security-Policy')).not.toContain("'unsafe-eval'");
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });
});
