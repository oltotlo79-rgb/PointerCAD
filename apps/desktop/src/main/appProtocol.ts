import { net, protocol } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 画面の配信に使う独自スキーム。Web 版と同じ「http のような」条件を再現する。 */
export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://pointercad`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * app.whenReady() より前に呼ぶ必要がある。
 * fetch と CORS を有効にしないと、WASM の読み込みが Chromium にブロックされる。
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** app.whenReady() の後に呼ぶ。rendererRoot の外へは出さない。 */
export function handleAppScheme(rendererRoot: string): void {
  const root = normalize(rendererRoot);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const relativePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = normalize(join(root, decodeURIComponent(relativePath)));

    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    // Web 版(apps/web/public/_headers)と同じ隔離状態を作る(FR-1003)。
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');

    return new Response(response.body, { status: response.status, headers });
  });
}
