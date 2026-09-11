/** R11: Web/DesktopのHTMLと配信側が共用する文字列。
 * 画面は文字列からのJavaScript生成を許可しない。現OCCTのembindだけが必要とする
 * 動的生成の許可は、正規kernel Workerのレスポンスへ限定する。 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const KERNEL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self' 'unsafe-eval'", "connect-src 'self'", "worker-src 'none'",
].join('; ');

/** 固定の配信名だけ。未知のassets/*.js全体へ例外を拡げない。 */
export function isKernelWorkerAsset(pathname: string): boolean {
  return /^\/assets\/kernel\.worker-[A-Za-z0-9_-]+\.js$/u.test(pathname);
}

export function contentSecurityPolicyFor(pathname: string): string {
  return isKernelWorkerAsset(pathname) ? KERNEL_CONTENT_SECURITY_POLICY : APP_CONTENT_SECURITY_POLICY;
}

/** metaで無効なframe-ancestorsはHTTP応答/X-Frame-Options側で指定する。 */
export const APP_META_CONTENT_SECURITY_POLICY = APP_CONTENT_SECURITY_POLICY
  .split('; ').filter((directive) => !directive.startsWith('frame-ancestors ')).join('; ');

/** Cloudflareは重なる同名ヘッダーを連結するため、CSPの対象を重ねない。
 * SPAの拡張子なしURLへのfallbackでもindex.htmlのmetaが本文の制限を持つ。
 * https://developers.cloudflare.com/pages/configuration/headers/ */
export function appendCloudflareSecurityHeaders(base: string): string {
  if (/^\s*Content-Security-Policy\s*:/imu.test(base)) {
    throw new Error('Content-Security-Policyは共有ポリシーからだけ生成してください');
  }
  return [base.trimEnd(), '',
    '/*', '  X-Frame-Options: DENY', '  Referrer-Policy: no-referrer',
    '', '/', `  Content-Security-Policy: ${APP_CONTENT_SECURITY_POLICY}`,
    '', '/*.html', `  Content-Security-Policy: ${APP_CONTENT_SECURITY_POLICY}`,
    '', '/assets/kernel.worker-*.js', `  Content-Security-Policy: ${KERNEL_CONTENT_SECURITY_POLICY}`, '',
  ].join('\n');
}
