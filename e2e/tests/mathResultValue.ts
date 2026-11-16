import type { Locator } from '@playwright/test';

/**
 * 数式の窓の結果の欄(.pcad-math-editor__result)の「値の文」を、1 回の評価で読む。
 *
 * 実数の結果が有効 7 桁以上の時、1 行目は「≈ 6 桁」で、全部の桁は畳んだ「全部の桁」の中の値だけを持つ要素
 * (.pcad-math-editor__full-value。「= 6.2831853…」)にある(UI の点検の指摘 36)。欄の文字全体は「≈ 6.28319全部の桁= 6.28…」と
 * つながるので、値を数に読む・値の全体で照らす所は、この関数で値の文だけを受け取る。
 * 全部の桁を持たない結果(厳密な値・6 桁以下・候補・断り)は、今までどおり 1 行目の文を返す。
 */
export async function mathResultValueText(result: Locator): Promise<string> {
  return result.evaluate(element => {
    const full = element.querySelector('.pcad-math-editor__full-value');
    if (full !== null) return (full.textContent ?? '').trim();
    return (element.querySelector(':scope > p')?.textContent ?? '').trim();
  });
}
