/** 本番HTML・preview応答・公開用_headersへ同じCSPを配る（R11）。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import {
  APP_META_CONTENT_SECURITY_POLICY,
  appendCloudflareSecurityHeaders,
  contentSecurityPolicyFor,
} from '@pointercad/ui/security-policy';

export function webSecurityPolicy(): Plugin {
  return {
    name: 'pointercad-security-policy',
    // previewのConfigEnv.commandもserveになるため、isPreviewを明示して取り込む。
    // 開発サーバーだけはReact refresh/HMRの別条件にする。
    apply: (_config, environment) => environment.command === 'build' || environment.isPreview === true,
    transformIndexHtml: {
      order: 'post',
      handler: () => [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: APP_META_CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      }],
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        // pathの判定だけに使う固定base。Hostヘッダーは許可表へ流し込まない。
        const path = new URL(request.url ?? '/', 'http://pointercad.invalid').pathname;
        response.setHeader('Content-Security-Policy', contentSecurityPolicyFor(path));
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Referrer-Policy', 'no-referrer');
        next();
      });
    },
    generateBundle() {
      // 接続先はapps/web/build/securityPolicy.ts。その位置からpublicを解決する。
      const base = readFileSync(fileURLToPath(new URL('../public/_headers', import.meta.url)), 'utf8');
      this.emitFile({ type: 'asset', fileName: '_headers', source: appendCloudflareSecurityHeaders(base) });
    },
  };
}
