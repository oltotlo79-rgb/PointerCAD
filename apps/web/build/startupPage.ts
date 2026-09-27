import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { renderStartupMessages } from '../src/startupMarkup.js';
import { assertStartupIsolation } from '../src/startupBundle.js';

/** Use the same messages in development, the built page and the help documentation. */
export function startupPage(): Plugin {
  return {
    name: 'pointercad-startup-page',
    transformIndexHtml(html) {
      const labels: unknown = JSON.parse(readFileSync(new URL('../../../packages/ui/src/i18n/ja/view.json', import.meta.url), 'utf8'));
      return renderStartupMessages(html, labels);
    },
    generateBundle(_options, bundle) { assertStartupIsolation(bundle); },
  };
}
