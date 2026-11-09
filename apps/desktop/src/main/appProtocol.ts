import { net, protocol } from 'electron';
import { APP_META_CONTENT_SECURITY_POLICY, contentSecurityPolicyFor } from '@pointercad/ui/security-policy';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { injectStartupShell } from './startupHtml.js';
import { desktopAppContentSecurityPolicy } from '../occtHttpPolicy.js';

/** 画面の配信に使う独自スキーム。Web 版と同じ「http のような」条件を再現する。 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'pointercad';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
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
        // Custom schemes must opt in to Chromium's managed code cache.
        codeCache: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Only an explicitly owned test listener changes the built primary document's CSP meta. */
function indexHtmlWithOwnedTransport(html: string, occtOrigin: string | undefined): string {
  if (occtOrigin === undefined) return html;
  const meta = (policy: string): string => `<meta http-equiv="Content-Security-Policy" content="${
    policy.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')}">`;
  const expected = meta(desktopAppContentSecurityPolicy(APP_META_CONTENT_SECURITY_POLICY));
  const tags = html.match(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/giu) ?? [];
  // This exact shape comes from Vite's generated renderer/index.html. Do not
  // silently retain a second policy or succeed when the emitted shape changed.
  if (tags.length !== 1 || tags[0] !== expected) throw new Error('Unexpected built Desktop CSP meta');
  return html.replace(expected, meta(desktopAppContentSecurityPolicy(APP_META_CONTENT_SECURITY_POLICY, occtOrigin)));
}

/** app.whenReady() の後に呼ぶ。rendererRoot の外へは出さない。occtOrigin は主文書の connect-src に足す OCCT の送信先(省略時は製品の固定値)。 */
export function handleAppScheme(rendererRoot: string, occtOrigin?: string): void {
  const root = normalize(rendererRoot);

  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL;
    let relativePath: string;
    try {
      url = new URL(request.url);
      relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (relativePath.includes('\0')) {
      return new Response('Bad Request', { status: 400 });
    }
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) {
      return new Response('Forbidden', { status: 403 });
    }
    const filePath = normalize(join(root, relativePath));

    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    const policy = contentSecurityPolicyFor(url.pathname);
    headers.set('Content-Security-Policy', relativePath === '/index.html'
      ? desktopAppContentSecurityPolicy(policy, occtOrigin) : policy);
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    // Web 版(apps/web/public/_headers)と同じ隔離状態を作る(FR-1003)。
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');

    if (relativePath === '/index.html' && response.ok) {
      const html = injectStartupShell(indexHtmlWithOwnedTransport(await response.text(), occtOrigin));
      headers.delete('Content-Length');
      return new Response(html, { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  });
}
