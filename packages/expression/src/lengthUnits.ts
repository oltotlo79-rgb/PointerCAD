/**
 * 式の中に書ける長さの単位(要件 FR-201・FR-814、計画書 docs/plans/P6-入出力.md §2.9.1)。
 *
 * 綴りと mm への倍率を**ここ 1 か所**に持ち、字句(tokenize.ts)・構文(parse.ts)・
 * 評価(evaluate.ts)はすべてこの表を見る。2 か所に別の綴りや倍率が入らないようにするため。
 *
 * 置くのは `mm` / `in` / `"` の 3 つだけ。要件にあるのは mm と inch だけなので
 * `cm` / `m` は足さない(足したくなったら作業を止めて統括へ提案する。§2.9.1)。
 * `"`(ダブルクォート)は inch の別名として受ける(製図の慣習)。`'`(フィート)は受けない。
 *
 * 倍率を数(number)ではなく **10 進の文字列**で持つのは、`25.4` が 2 進の倍精度では
 * 厳密に表せないため。文字列のまま `decimal.js` へ渡せば厳密値になる(NFR-RE-4)。
 * ここで `ExpressionDecimal` を作らないのは、evaluate.ts がこの表を import するので
 * 逆向きの import が輪になるため。Decimal へ移すのは evaluate.ts の役目とする。
 */

/**
 * 単位の綴り(正規形)。大文字小文字を問わず打てるが、トークンと構文木にはこの形で入る。
 * `packages/model` の `LengthUnit`(表示の単位。`'mm' | 'inch'`)とは別物なので名前を分ける。
 */
export type ExpressionLengthUnit = 'mm' | 'in' | '"';

/** 使える単位の一覧。検査と、単位の綴りを列挙したい呼び出し側のために輸出する。 */
export const LENGTH_UNITS: readonly ExpressionLengthUnit[] = ['mm', 'in', '"'];

/**
 * 1 inch = 25.4 mm(国際インチの定義値。厳密)。
 * `packages/model/src/units/length.ts` の `MM_PER_INCH` と同じ値になるが、
 * `expression` は `model` に依存できない(rules/04 の依存方向)ので、それぞれが持つ。
 */
export const MM_PER_INCH_TEXT = '25.4';

/**
 * 単位 1 つ分の mm への倍率(10 進の文字列)。
 * switch にしているのは、単位を増やしたときに書き忘れを型検査で見つけるため。
 */
export function lengthUnitFactor(unit: ExpressionLengthUnit): string {
  switch (unit) {
    case 'mm':
      return '1';
    case 'in':
    case '"':
      return MM_PER_INCH_TEXT;
  }
}

/**
 * 綴り(大文字小文字を問わない)を正規形へ直す。単位でなければ null。
 * `as` を使わずに 1 つずつ比べるのは、綴りの表と型が食い違ったときに型検査で気付くため。
 */
export function toLengthUnit(spelling: string): ExpressionLengthUnit | null {
  const lower = spelling.toLowerCase();
  if (lower === 'mm') {
    return 'mm';
  }
  if (lower === 'in') {
    return 'in';
  }
  if (lower === '"') {
    return '"';
  }
  return null;
}
