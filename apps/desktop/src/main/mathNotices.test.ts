import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectMathNotices, verifyMathFontAssets } from '../../../../scripts/vite/mathNotices.mjs';
import { installedMathDependencies, verifyMathDependencyInventory } from '../../../../scripts/vite/mathDependencyInventory.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const font = Buffer.from('original font bytes');
const expected = new Map([['KaTeX_Main-Regular.woff2', createHash('sha256').update(font).digest('hex')]]);
const asset = { type: 'asset', fileName: 'assets/KaTeX_Main-Regular-hash.woff2', source: font };

describe('数学の許諾と字体をWebとDesktopへ同梱する', () => {
  it('固定した実依存の原文と字体20個を読み、配布用の参照一覧へ含める', () => {
    const distribution = collectMathNotices(root);
    expect(distribution.fonts.size).toBe(20);
    for (const name of ['compute-engine.txt', 'mathlive.txt', 'mathlive-fonts.txt', 'ofl-1.1.txt']) {
      expect(distribution.assets.get(`licenses/${name}`))
        .toEqual(readFileSync(new URL(`../../../../docs/standards/licenses/${name}`, import.meta.url)));
      expect(distribution.assets.get('licenses/index.html')?.toString('utf8')).toContain(`./${name}`);
    }
  });

  it('同じ字体の内容を持つViteのハッシュ付きファイル名を受け入れる', () => {
    expect(() => verifyMathFontAssets({ font: asset }, expected)).not.toThrow();
  });

  it('配布から消えた字体を拒否する', () => {
    expect(() => verifyMathFontAssets({}, expected)).toThrow('missing or duplicated');
  });

  it('名前が同じでも未確認の字体の内容へ置き換わったら拒否する', () => {
    expect(() => verifyMathFontAssets({ font: { ...asset, source: Buffer.from('changed') } }, expected))
      .toThrow('Unreviewed mathematics font');
  });

  it('同じ内容を複数の字体として出力する変更を拒否する', () => {
    expect(() => verifyMathFontAssets({ first: asset, second: { ...asset, fileName: 'assets/KaTeX_New.woff2' } }, expected))
      .toThrow('missing or duplicated');
  });

  it('異なる版を含む7依存を、未確認の2件も漏らさず数える', () => {
    const actual = installedMathDependencies(root);
    expect(actual.map(entry => `${entry.name}@${entry.version}`).sort()).toEqual([
      '@arnog/colors@0.5.0', '@arnog/colors@0.7.0', '@cortex-js/compute-engine@0.128.6',
      '@cortex-js/compute-engine@0.58.0', 'complex-esm@2.1.1-esm1', 'decimal.js@10.6.0', 'mathlive@0.110.0',
    ]);
    expect(() => verifyMathDependencyInventory(actual, actual)).not.toThrow();
  });

  it('既存の原文が同じでも、新しい間接依存・版・許諾を黙って配布しない', () => {
    const previous = [{ name: 'calculation', version: '1.0.0', license: 'MIT' }];
    expect(() => verifyMathDependencyInventory([...previous, { name: 'transitive', version: '1', license: 'MIT' }], previous))
      .toThrow('dependency inventory');
    expect(() => verifyMathDependencyInventory([{ ...previous[0], version: '1.1.0' }], previous)).toThrow('version and license');
    expect(() => verifyMathDependencyInventory([{ ...previous[0], license: 'BSD-3-Clause' }], previous)).toThrow('version and license');
    expect(() => verifyMathDependencyInventory([], previous)).toThrow('dependency inventory');
  });

  it('同じ依存の重複記録や、実依存の二重計上で欠落を隠せない', () => {
    const entry = { name: 'calculation', version: '1.0.0', license: 'MIT' };
    expect(() => verifyMathDependencyInventory([entry, entry], [entry, entry])).toThrow('Duplicate');
    expect(() => verifyMathDependencyInventory([entry, entry], [entry, { ...entry, name: 'missing' }]))
      .toThrow('version and license');
  });
});
