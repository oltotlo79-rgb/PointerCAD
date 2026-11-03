import { describe, expect, it } from 'vitest';
import { resolveHelpUiReferences } from './uiReferences.js';

describe('説明と画面で同じ操作名を使う', () => {
  it('本文の複数の参照を実際の文言から解決する', () => {
    expect(resolveHelpUiReferences('「{{ui:point.search}}」の後で「{{ui:point.apply}}」。',
      { 'point.search': '候補を探す', 'point.apply': '選んだ点を作成' })).toBe('「候補を探す」の後で「選んだ点を作成」。');
  });

  it('名前変更や欠落を曖昧な代替表示にせず拒否する', () => {
    for (const source of ['{{ui:missing}}', '{{ui:constructor}}', '{{ui:point.search', '{{ui: }}']) {
      expect(() => resolveHelpUiReferences(source, {})).toThrow(/help UI reference/u);
    }
    expect(() => resolveHelpUiReferences('{{ui:point.search}}', { 'point.search': '' })).toThrow('Invalid help UI label');
  });

  it('操作名の記号をMarkdownのリンクや見出しへ読み替えない', () => {
    expect(resolveHelpUiReferences('{{ui:label}}', { label: '[開く](https://example.com) *太字*' }))
      .toBe('\\[開く\\]\\(https://example\\.com\\) \\*太字\\*');
    expect(() => resolveHelpUiReferences('{{ui:label}}', { label: '次へ\n# 新しい節' })).toThrow('Invalid help UI label');
  });
});
