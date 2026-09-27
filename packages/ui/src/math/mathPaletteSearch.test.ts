import { describe, expect, it } from 'vitest';
import { searchMathPalette } from './mathPalette.js';
import { MATH_INPUT_PALETTE } from './mathPaletteExamples.js';

/**
 * MC-02a の合格条件「別名で検索できる検査が成功」の証拠（17-13）。
 * `searchMathPalette`（`mathPalette.ts`）は label・symbol・id・meaning・keywords を検索対象にする。
 * 双曲線逆関数は symbol 欄に電卓表記の別名（asinh・acosh・atanh 等）を持つため、その別名で見つかる。
 */
describe('searchMathPalette は双曲線逆関数を電卓表記の別名でも検索できる', () => {
  const findIds = (query: string) => searchMathPalette(query, MATH_INPUT_PALETTE).map(entry => entry.id);

  it.each([
    ['asinh', 'arsinh'],
    ['acosh', 'arcosh'],
    ['atanh', 'artanh'],
  ] as const)('%s で検索すると %s が見つかる（symbol欄の別名表記）', (query, expectedId) => {
    expect(findIds(query)).toContain(expectedId);
  });

  it('検索語は大文字・全角でも同じ結果になる（正規化・大小無視の確認）', () => {
    expect(findIds('ASINH')).toEqual(findIds('asinh'));
    expect(findIds('ａｓｉｎｈ')).toEqual(findIds('asinh'));
  });
});

/**
 * 逆三角関数も電卓表記の別名（asin・acos・atan 等）で検索できることの証拠（17-13、統括の追加指示）。
 * arccos・arctan・arccot・arcsec・arccsc は既存の keywords 欄に別名を持つ。arcsin だけ欠けていたため、
 * `mathPaletteBasic.ts`・`mathPaletteBasic.json` へ acos・atan 等と同じ形（keywords への別名の追加）で
 * `asin` を足した（symbol欄は表示用の正式表記 `arcsin` のまま変えていない）。
 */
describe('searchMathPalette は逆三角関数を電卓表記の別名でも検索できる', () => {
  const findIds = (query: string) => searchMathPalette(query, MATH_INPUT_PALETTE).map(entry => entry.id);

  it.each([
    ['asin', 'arcsin'],
    ['acos', 'arccos'],
    ['atan', 'arctan'],
    ['acot', 'arccot'],
    ['asec', 'arcsec'],
    ['acsc', 'arccsc'],
  ] as const)('%s で検索すると %s が見つかる（keywords欄の別名表記）', (query, expectedId) => {
    expect(findIds(query)).toContain(expectedId);
  });

  it('検索語は大文字・全角でも同じ結果になる（正規化・大小無視の確認）', () => {
    expect(findIds('ASIN')).toEqual(findIds('asin'));
    expect(findIds('ａｓｉｎ')).toEqual(findIds('asin'));
  });
});
