import { describe, expect, it } from 'vitest';
import { renderStartupMessages } from './startupMarkup.js';
import template from '../index.html?raw';
import source from './bootstrap.ts?raw';
import messageSource from '../../../packages/ui/src/i18n/ja/view.json?raw';

const messages: unknown = JSON.parse(messageSource);
describe('起動案内は本体や文言ファイルを取得できなくてもHTMLに残る', () => {
  it('実際の入口に日本語の案内とスクリプト不要の同じ画面へのリンクを含める', () => {
    const html = renderStartupMessages(template, messages);
    expect(html).toContain('<a href="">画面を読み込み直す</a>');
    expect(html).toContain('画面に必要なファイルを読み込めませんでした。');
    expect(html).not.toContain('{{startup:');
    expect(html).toContain('src="/src/bootstrap.ts"');
    expect(source).not.toMatch(/from ['"](?:react|@pointercad\/ui)/u);
  });

  it('文言の記号をHTMLやスクリプトとして追加しない', () => {
    const entries = Object.fromEntries(['loading', 'hint', 'failed', 'retry'].map(key => [`bootstrap.${key}`, '<script>&"\'']));
    const html = renderStartupMessages(template, entries);
    expect(html).toContain('&lt;script&gt;&amp;&quot;&#39;');
    expect(html).not.toContain('<script>&');
  });

  it('欠けた文言・誤った参照・未対応の入力を黙って公開しない', () => {
    for (const input of [undefined, null, [], {}, { 'bootstrap.loading': '' }]) {
      expect(() => renderStartupMessages(template, input)).toThrow();
    }
    expect(() => renderStartupMessages(template.replace('{{startup:hint}}', ''), messages)).toThrow('Missing startup message');
    expect(() => renderStartupMessages(template + '{{startup:unknown}}', messages)).toThrow('Unknown startup message');
  });
});
