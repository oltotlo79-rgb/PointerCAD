import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MANUAL_CHAPTERS } from '@pointercad/help-content';
import { renderManualChapter } from './manualHtml.js';

describe('実ヘルプの描画を再利用した取扱説明書', () => {
  it('現行の全章を同じ本文から出力し、未解決のUI参照を残さない', () => {
    for (const chapter of MANUAL_CHAPTERS) {
      const markdown = readFileSync(new URL(`../../../help-content/${chapter.path}`, import.meta.url), 'utf8');
      const html = renderManualChapter(chapter, markdown, {}, { combined: true });
      expect(html, chapter.id).toContain(`<article id="chapter-${chapter.id}"`);
      expect(html, chapter.id).toContain('<h1');
      expect(html, chapter.id).not.toContain('{{ui:');
      expect(html, chapter.id).not.toContain('<script');
    }
  });
  const chapter = MANUAL_CHAPTERS[0];
  it('同じUI文言と安全な本文を使い、章リンクは実ファイルへつながる', () => {
    const html = renderManualChapter(chapter, '# 説明\n\n**{{ui:help.back}}** [式](numeric-input.md#数値) [危険](javascript:alert)\n\n<script>alert(1)</script>', {});
    expect(html).toContain('<strong>戻る</strong>');
    expect(html).toContain('href="../chapters/numeric-input.html#help-数値"');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<button');
  });
  it('分冊で章が続いても見出しのIDが衝突せず、画像は指定した実画像だけを使う', () => {
    const html = renderManualChapter(chapter, '# 同じ見出し\n\n[本文](#同じ見出し)\n\n![実画面](images/screen.png)',
      { 'images/screen.png': '../images/screen.png' }, { combined: true });
    expect(html).toContain(`id="${chapter.id}-help-同じ見出し"`);
    expect(html).toContain(`href="#${chapter.id}-help-同じ見出し"`);
    expect(html).toContain('src="../images/screen.png"'); expect(html).toContain('alt="実画面"');
    expect(() => renderManualChapter(chapter, '{{ui:missing.key}}', {})).toThrow();
  });
});
