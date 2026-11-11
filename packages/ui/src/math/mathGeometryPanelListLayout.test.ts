/**
 * 図形の測定値の一覧で、長い値による見出しの消失と「測る量」の左余白の欠落を防ぐ。
 *
 * 1. `.pcad-properties` (`packages/ui/src/shell/appShell.css`) の `minmax(0, 1fr) auto` は
 *    値の幅を優先し、見出しの列を0まで縮めていた。まず `.pcad-parameter__properties` で
 *    測定値の一覧を保護した。長い慣性値で質量特性の見出しも消えたため、P102で共有gridにも
 *    保護を広げた。板金と強度のレイアウトは独自の上書きを保つ。
 * 2. 「測る量」の `.pcad-field` と `.pcad-section` までの祖先には横余白がない。
 *    `ParameterPanel` と共有する `.pcad-parameters__fields { padding: 0 }` は変えず、
 *    専用 `.pcad-parameters__quantity-field` で余白を付ける。他の欄は
 *    `.pcad-panel__note`・`.pcad-parameters__list`・`.pcad-parameters__footer` が余白を持つ。
 *
 * NodeのVitestは実CSS gridを配置できないため、見出しが潰れず長い値が折り返す規則の本文を検査する。
 * 実コンポーネントの適用は `MeasurementSections.test.ts` / `MathGeometryPanel.test.ts`、
 * 実際の画素寸法はブラウザー画面で確認する。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../shell/appShell.css');
/** コメントを除いてから探す(themeColors.test.ts と同じ手法)。 */
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 選び方1つぶんの `{ … }` の中身。入れ子の `{}` は無い前提。 */
function blockOf(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('P102・GR-19d: 共通プロパティと図形の測定値の見出し・折り返しの規則', () => {
  it('共通の見出し列にも最小幅を確保し、長い値の列は残り幅へ収める', () => {
    const shared = blockOf('.pcad-properties {');
    expect(shared).toContain('grid-template-columns: minmax(4.5em, max-content) minmax(0, 1fr);');
  });

  it('共通の値も小数や空白のない長い式を折り返し、全桁と単位を保持する', () => {
    const value = blockOf('.pcad-properties__value {');
    expect(value).toContain('min-width: 0;');
    expect(value).toContain('overflow-wrap: anywhere;');
    expect(value).not.toMatch(/(?:overflow:\s*hidden|text-overflow:\s*ellipsis|white-space:\s*nowrap)/);
  });

  it('図形の測定値の専用の class でも、見出し列(1列目)が潰れない比率を維持する', () => {
    const scoped = blockOf('.pcad-properties.pcad-parameter__properties');
    expect(scoped).toMatch(/grid-template-columns:\s*minmax\([^,]+,\s*max-content\)\s+minmax\(0,\s*1fr\)\s*;/);
  });

  it('図形の測定値の専用の class も、長い文字列を折り返して横にはみ出さない', () => {
    const wrap = blockOf('.pcad-parameter__properties .pcad-properties__value');
    expect(wrap).toContain('overflow-wrap: anywhere;');
  });

  it('「測る量」の追加欄専用の class だけ、区画の左右の余白を持つ', () => {
    const field = blockOf('.pcad-parameters__quantity-field');
    expect(field).toContain('padding: 0 var(--pcad-space-3);');
  });

  it('.pcad-parameters__fields 単体の規則(ParameterPanel と共有)は変えていない(左右 padding 0 のまま)', () => {
    const fields = blockOf('.pcad-parameters__fields {');
    expect(fields).toContain('padding: 0;');
  });

  it('板金の曲げ要約と強度結果は共通の二列配置より専用の縦並びを優先する', () => {
    const directory = dirname(cssPath);
    const sheet = readFileSync(resolve(directory, '../sheetMetal/sheetMetal.css'), 'utf8');
    const strength = readFileSync(resolve(directory, '../strength/strength.css'), 'utf8');
    expect(sheet).toMatch(/\.pcad-properties\.pcad-sheet-metal__dimensions\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}/);
    expect(sheet).toMatch(/\.pcad-sheet-metal__dimensions\s+\.pcad-properties__key\s*\{[^}]*white-space:\s*normal;[^}]*overflow:\s*visible;/);
    expect(strength).toMatch(/\.pcad-strength__results\s+\.pcad-properties\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;/);
  });
});
