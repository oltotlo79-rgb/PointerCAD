import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectWithinBudget } from '@pointercad/test-utils';
import { HELP_TOPICS } from './index.js';
import { createHelpSearchIndex, normalizeHelpSearch } from './searchIndex.js';

const index = createHelpSearchIndex(HELP_TOPICS.map(topic => ({ ...topic,
  body: readFileSync(fileURLToPath(new URL(`../${topic.path}`, import.meta.url)), 'utf8'),
})));

describe('ヘルプと説明書の共通検索', () => {
  it('全角・半角、英字の大小、ひらがな・カタカナを区別せず検索する', () => {
    expect(normalizeHelpSearch('  ＡＰＩ　ﾊﾟﾗﾒｰﾀ  ')).toBe('api ぱらめーた');
    expect(index.search('ぱらめーた').slice(0, 5).map(hit => hit.id)).toContain('parameters');
  });

  it('題、道具の語、本文の順で重みを付け、複数語を別々の欄でも探す', () => {
    const corpus = createHelpSearchIndex([
      { id: 'body', title: '補足', body: '穴 あな' },
      { id: 'command', title: '機能一覧', keywords: ['穴'], body: 'あな' },
      { id: 'title', title: '穴', body: '作成 あな' },
    ]);
    expect(corpus.search('穴').map(hit => hit.id)).toEqual(['title', 'command', 'body']);
    expect(corpus.search('穴 作成').map(hit => hit.id)).toEqual(['title']);
    expect(corpus.search('')).toEqual([{ id: 'body', score: 0 }, { id: 'command', score: 0 }, { id: 'title', score: 0 }]);
    expect(corpus.search('未収録')).toEqual([]);
    expect(() => createHelpSearchIndex([{ id: 'same', title: 'a', body: '' }, { id: 'same', title: 'b', body: '' }])).toThrow('Duplicate');
  });

  it.each([
    ['画面 回す', 'viewport'], ['数値 式', 'numeric-input'], ['構造化 数式', 'math-input'],
    ['XYZ 曲線', 'function-curve'], ['XYZ 曲面', 'function-surface'], ['パラメータ', 'parameters'],
    ['点 線 円弧', 'sketch-tools'], ['交点 分割', 'sketch-intersections'], ['多角形', 'shapes'],
    ['楕円', 'ellipse'], ['スプライン', 'spline'], ['作図面', 'work-plane'],
    ['JavaScript', 'scripts'], ['API リファレンス', 'script-api'], ['道具 登録', 'script-tools'],
    ['加工ソフト', 'cam'], ['板金 基板', 'sheet-metal'], ['フランジ', 'sheet-metal-flange'],
    ['リリーフ', 'sheet-metal-bend-relief'], ['穴表 展開', 'sheet-metal-flat'],
    ['公差 はめあい', 'dimension-tolerance'], ['断面図', 'drawing-section'], ['用紙 縮尺', 'drawing-scale'],
    ['幾何公差', 'gdt'], ['溶接記号', 'welding'], ['部品表 部品番号', 'drawing-bom'],
    ['文字 輪郭', 'text-outline'], ['表面性状', 'surface-finish'], ['視点 名前', 'named-view'], ['図面 印刷', 'drawing-export'],
  ] as const)('実際の全章から「%s」の目的章を上位5件で返し、検索時間を記録する', (query, topic) => {
    const started = performance.now();
    const matches = index.search(query);
    const elapsed = performance.now() - started;
    expect(matches.slice(0, 5).map(hit => hit.id)).toContain(topic);
    expectWithinBudget(elapsed, 100, `ヘルプ検索「${query}」`);
  });
});
