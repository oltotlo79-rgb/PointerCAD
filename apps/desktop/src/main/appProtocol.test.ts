import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Protocol } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, handleAppScheme } from './appProtocol.js';

const electron = vi.hoisted(() => ({
  handle: vi.fn<Protocol['handle']>(),
  fetch: vi.fn<(url: string) => Promise<Response>>(),
}));
vi.mock('electron', () => ({ protocol: { handle: electron.handle }, net: { fetch: electron.fetch } }));

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
