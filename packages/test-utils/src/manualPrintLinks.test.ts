import { describe, it, expect } from 'vitest';
import { createManualPrintLinkResolver } from '../../../scripts/manual/print-links.mjs';

const manifest = {
  volumes: [{ id: 'sketch', title: 'スケッチ' }, { id: 'solid', title: '立体' }],
  chapters: [{ id: 'points', title: '座標入力', volumeId: 'sketch' }, { id: 'box', title: '箱', volumeId: 'solid' }],
};
const resolve = createManualPrintLinkResolver(manifest, 'sketch');
describe('PDFの巻内移動と印刷後にも残る巻間参照', () => {
  it('巻内の目次と章内見出しへ移動できる', () => {
    expect(resolve('#chapter-points')).toEqual({ kind: 'anchor', href: '#chapter-points' });
    expect(resolve('../chapters/points.html')).toEqual({ kind: 'anchor', href: '#chapter-points' });
    expect(resolve('../chapters/points.html#help-原点')).toEqual({ kind: 'anchor', href: '#points-help-原点' });
    expect(resolve('../index.html')).toEqual({ kind: 'anchor', href: '#manual-all-volumes' });
  });
  it('別の巻は保存場所に依存しない巻名・章名で示す', () => {
    expect(resolve('../chapters/box.html#help-寸法')).toEqual({ kind: 'reference', text: '（立体 → 箱）' });
    expect(resolve('../volumes/solid.html')).toEqual({ kind: 'reference', text: '（立体）' });
  });
  it('実在する外部URLをそのまま保持する', () => {
    expect(resolve('https://example.com/manual?a=1')).toEqual({ kind: 'external', href: 'https://example.com/manual?a=1' });
  });
  it('存在しない章・巻、未解決のローカルファイルを出力に残さない', () => {
    for (const href of ['../chapters/missing.html', '../volumes/missing.html', 'file:///C:/private/input.html',
      'javascript:alert(1)', '//elsewhere.invalid/input', '../chapters/points.html#missing', '../chapters/points.html?x=1']) {
      expect(() => resolve(href), href).toThrow();
    }
    expect(() => createManualPrintLinkResolver(manifest, 'missing')).toThrow();
  });
});
