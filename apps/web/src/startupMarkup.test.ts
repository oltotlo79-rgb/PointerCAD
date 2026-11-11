import ts from 'typescript';
import uiPackage from '../../../packages/ui/package.json';
import { describe, expect, it } from 'vitest';
import { renderStartupMessages } from './startupMarkup.js';
import template from '../index.html?raw';
import source from './bootstrap.ts?raw';
import messageSource from '../../../packages/ui/src/i18n/ja/view.json?raw';

const STARTUP_ENTRY = '@pointercad/ui/startup-presentation';
function staticStartupImports(text: string): readonly string[] {
  const file = ts.createSourceFile('bootstrap.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return file.statements.filter(ts.isImportDeclaration).map(statement =>
    ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : statement.moduleSpecifier.getText(file));
}

const messages: unknown = JSON.parse(messageSource);
describe('起動案内は本体や文言ファイルを取得できなくてもHTMLに残る', () => {
  it('実際の入口に日本語の案内とスクリプト不要の同じ画面へのリンクを含める', () => {
    const html = renderStartupMessages(template, messages);
    expect(html).toContain('<a href="">画面を読み込み直す</a>');
    expect(html).toContain('画面に必要なファイルを読み込めませんでした。');
    expect(html).not.toContain('{{startup:');
    expect(html).toContain('src="/src/bootstrap.ts"');
    expect(staticStartupImports(source)).toEqual([STARTUP_ENTRY]);
    expect(html).toContain('aria-labelledby="pcad-startup-title"');
    expect(html).toContain('class="pcad-startup__mark"');
    expect(html).toContain('M8 1.75 14 5.25v5.5L8 14.25 2 10.75v-5.5z');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).toContain('animation: none');
  });

  it('起動の公開口は元の独立した処理を直接指し、本体を経由しない', () => {
    expect(uiPackage.exports['./startup-presentation']).toEqual({
      default: './src/shell/startupPresentation.ts', types: './dist/shell/startupPresentation.d.ts',
    });
  });

  it('ReactやUI本体や別の公開口を起動入口へ混ぜた変更を拒否する', () => {
    for (const dependency of ['react', 'react/jsx-runtime', '@pointercad/ui', '@pointercad/ui/startup-recovery']) {
      for (const statement of [`import value from '${dependency}';`, `import '${dependency}';`]) {
        expect(staticStartupImports(statement)).not.toEqual([STARTUP_ENTRY]);
        expect(staticStartupImports(source + '\n' + statement)).not.toEqual([STARTUP_ENTRY]);
      }
    }
  });

  it('復旧案内だけを8秒待ち、失敗時は即座に表示できるCSSをHTMLへ同梱する', () => {
    const html = renderStartupMessages(template, messages);
    expect(html).toMatch(/\.pcad-startup__recovery \{[^}]*visibility: hidden;[^}]*animation: pcad-startup-recovery 0s 8s forwards;/u);
    expect(html).toContain('@keyframes pcad-startup-recovery { to { visibility: visible; } }');
    expect(html).toContain('[data-startup-shell][data-state="failed"] .pcad-startup__recovery { animation: none; visibility: visible; }');
    // Reduced motion stops the moving progress line, but never disables recovery.
    const reducedMotion = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toContain('.pcad-startup__track::after { animation: none; width: 100%; }');
    expect(reducedMotion).not.toContain('pcad-startup__recovery {');
    expect(html.indexOf('@keyframes pcad-startup-recovery')).toBeLessThan(html.indexOf('<script'));
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
