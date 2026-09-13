import { describe, expect, it } from 'vitest';
import { validateManualLinks } from './manualLinks.js';

describe('取扱説明書の章・画像・見出しへの接続', () => {
  const pages = new Map([['index.html', '<a href="chapters/curve.html#help-%E7%82%B9">点</a>'],
    ['chapters/curve.html', '<h1 id="help-点">点</h1><img src="../images/point.png" alt="点" /><a href="https://example.com/">資料</a>']]);
  it('ローカルの章・日本語の見出し・画像を実際の出力一覧で照合する', () => {
    expect(() => validateManualLinks(pages, new Set(['images/point.png']))).not.toThrow();
  });
  it('章の抜け・孤立した見出し・同じIDの重複・危険な接続を拒否する', () => {
    expect(() => validateManualLinks(pages, new Set())).toThrow('target');
    const missing = new Map(pages); missing.set('index.html', '<a href="chapters/curve.html#old-title">旧見出し</a>');
    expect(() => validateManualLinks(missing, new Set(['images/point.png']))).toThrow('anchor');
    expect(() => validateManualLinks(new Map([['index.html', '<h1 id="title"/><p id="title"/>']]), new Set())).toThrow('Duplicate');
    expect(() => validateManualLinks(new Map([['index.html', '<a href="javascript:alert(1)">危険</a>']]), new Set())).toThrow('Unsafe');
  });
});
