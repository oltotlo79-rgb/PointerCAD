import template from '../../../web/index.html?raw';
import messageSource from '../../../../packages/ui/src/i18n/ja/view.json?raw';
import { renderStartupMessages } from '../../../../packages/ui/src/shell/startupMarkup.js';

const labels: unknown = JSON.parse(messageSource);
const startupHtml = renderStartupMessages(template, labels);
const style = startupHtml.match(/<style data-startup-style>[\s\S]*?<\/style>/u)?.[0];
const shell = startupHtml.match(/<main data-startup-shell[\s\S]*?<\/main>/u)?.[0];
if (style === undefined || shell === undefined) throw new Error('Missing static startup presentation');

/** The app:// document carries the same no-JavaScript splash as the Web document. */
export function injectStartupShell(html: string): string {
  if (html.includes('data-startup-shell')) return html;
  // Keep scripts, preload links, security policy and relative asset URLs exactly as built.
  return html.replace('</head>', `${style}</head>`).replace('<body>', `<body>${shell}`);
}

/** Even a missing/unreadable renderer document keeps a working, script-free retry link. */
export function startupFailureDocument(retryUrl: string): string {
  const address = retryUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const failure = shell?.replace('data-startup-shell', 'data-startup-shell data-state="failed"')
    .replace('data-startup-loading role="status"', 'data-startup-loading hidden')
    .replace('data-startup-failure hidden', 'data-startup-failure role="alert"')
    .replace('<a href="">', `<a href="${address}">`);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>PointerCAD</title>`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + `${style}</head><body>${failure}</body></html>`;
}
