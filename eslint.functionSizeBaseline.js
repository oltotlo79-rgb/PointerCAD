// @ts-check
/**
 * 関数ごとの行数の上限（レビューE09）。製品の全関数は FUNCTION_SIZE_CAP 行まで（ESLint の
 * max-lines-per-function。空行とコメントだけの行は数えない）。
 *
 * FUNCTION_SIZE_BASELINE は、2026-11-02 の実測で上限を超えていた既存の関数だけを、その関数自身の実測値で
 * 固定する。識別子は囲む宣言の名前を「::」でつないだもの（行番号は使わない）。値は下げることだけができる:
 * 関数を縮めたら値を実測へ下げ、200行以下になったら行を消す。新しい行や値を上げる変更は追加しない。
 * packages/test-utils/src/functionSizePolicy.test.ts が実物の各関数と照合し、増加・縮小後の放置・消えた関数・
 * 一覧外の超過・識別できない重複を拒否する。eslint.config.js はファイルごとに最大の値を上限にする。
 */
export const FUNCTION_SIZE_CAP = 200;

/** @type {ReadonlyArray<{ readonly file: string, readonly functions: ReadonlyArray<readonly [string, number]> }>} */
export const FUNCTION_SIZE_BASELINE = [
];
