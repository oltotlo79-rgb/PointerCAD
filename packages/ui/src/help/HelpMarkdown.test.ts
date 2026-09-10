import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HelpMarkdown } from './HelpMarkdown.js';

const render = (source: string): string => renderToStaticMarkup(createElement(HelpMarkdown, { source, onTopic: () => undefined, onAnchor: () => undefined }));
describe('ヘルプMarkdownの表示', () => {
  it('同梱の実画面だけを表示し、外部画像や存在しないパスは説明文として残す', () => {
    const html = renderToStaticMarkup(createElement(HelpMarkdown, { source: '![実画面](images/welding.png) ![外部](https://example.com/tracking.png) ![不明](constructor)',
      images: { 'images/welding.png': '/assets/welding.png' }, onTopic: () => undefined, onAnchor: () => undefined }));
    expect(html).toContain('<img'); expect(html).toContain('src="/assets/welding.png"'); expect(html).toContain('alt="実画面"');
    expect(html).not.toContain('https://'); expect(html).not.toContain('src="constructor"'); expect(html).toContain('外部'); expect(html).toContain('不明');
  });
  it('生HTMLを実行せず、リンクの危険なスキームも出力しない', () => {
    const html = render('<script>alert(1)</script>\n\n[危険](javascript:alert) [安全](drawing.md)');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:'); expect(html).toContain('pcad-help__link');
  });
  it('見出し、入れ子の手順、表、強調、コードを読み順どおりに描く', () => {
    const html = render('# 図面の操作\n\n1. **作る**\n   - `保存`する\n2. 開く\n\n| 名前 | 説明 |\n| --- | --- |\n| 寸法 | モデルから測る |\n\n```ts\n<x />\n```');
    expect(html).toContain('id="help-図面の操作"'); expect(html).toContain('<strong>作る</strong>');
    expect(html).toContain('<ul><li><p><code>保存</code>する</p></li></ul>');
    expect(html).toContain('<th scope="col">名前</th>'); expect(html).toContain('<td>モデルから測る</td>');
    expect(html).toContain('<pre><code>&lt;x /&gt;</code></pre>');
  });
  it('同じ見出しでもIDを重複させず、表中のコードの縦棒を区切りにしない', () => {
    const html = render('## 手順\n\n## 手順\n\n| 式 | 意味 |\n| --- | --- |\n| `a|b` | 選択 |');
    expect(html).toContain('id="help-手順-1"'); expect(html).toContain('<td><code>a|b</code></td>');
  });
});
