/**
 * XML の文字列と数の書き方(計画書 docs/plans/P6-入出力.md §2.6、タスク14)。
 *
 * 3MF は ZIP の中に XML を入れた形式で、`packages/io` が自前で組み立てる(§0.a-0.18)。
 * ここに置くのは「文字をそのまま書くと XML が壊れる」箇所の逃がしと、
 * 「同じ形からは必ず同じバイト列ができる」ための数の書き方だけで、3MF の中身は知らない。
 * タスク19(3MF の読み込み)も同じ書式を読むので、**書き方の決めはこの 1 か所**に置く。
 *
 * 数の書き方を関数にまとめた理由は決定性(§0.a-0.62)である。`toString()` をそのまま使うと
 * 計算機によって末尾の桁がぶれ、`-0` や指数表記(`1e-7`)が混じって、同じ形から違う
 * バイト列ができてしまう。丸め・末尾の 0 落とし・`-0` の扱いを 1 か所へ寄せておけば、
 * 座標も色も同じ規則で書ける。
 */

/** 数が有限でない・XML へ書けないほど大きいときの断り(FR-504、NFR-UX-5)。 */
export const XML_INVALID_NUMBER_MESSAGE = 'ファイルへ書けない数が含まれています。';

/** 小数点以下の桁数(§2.6「小数点以下 6 桁で丸める」= 0.001µm)。 */
const DECIMALS = 6;

/** 丸めの倍率(10 の `DECIMALS` 乗)。 */
const SCALE = 10 ** DECIMALS;

/** XML 1.0 が本文にも属性にも書くことを許さない下限(この符号位置より小さい文字)。 */
const CONTROL_CHAR_LIMIT = 0x20;

/** 上の下限より小さくても書いてよい 3 つ(水平タブ・改行・復帰)。 */
const ALLOWED_CONTROL_CHARS: readonly number[] = [0x09, 0x0a, 0x0d];

/**
 * XML が許さない制御文字を落とす。逃がしの前に通す。
 *
 * 立体の名前は利用者が打った文字列なので、制御文字が紛れ込むことがある。そのまま書くと
 * XML として読めないファイルになり、しかも書いた側は気づけない。**正規表現を使わない**のは
 * 制御文字を書いた正規表現そのものが点検(`no-control-regex`)に引っかかるためで、
 * 符号位置の比較で落とす(逃がすのは名前だけなので、1 文字ずつ見ても費用にならない)。
 */
function stripForbiddenChars(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= CONTROL_CHAR_LIMIT || ALLOWED_CONTROL_CHARS.includes(code)) {
      result += char;
    }
  }
  return result;
}

/**
 * 要素の本文として書ける形に逃がす。
 *
 * `>` は XML の仕様では本文にそのまま書けるが、`]]>` の並びだけは書けないので、
 * 場合分けせず常に逃がす(読み手はどちらも同じ文字として読む)。
 */
export function escapeXmlText(value: string): string {
  return (
    stripForbiddenChars(value)
      // `&` を最初に置き換える。後回しにすると、他の逃がしが作った `&` まで二重に逃がしてしまう。
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  );
}

/**
 * 属性の値として書ける形に逃がす。
 *
 * 属性は `"` で囲むので `"` を逃がす。`'` も逃がすのは、囲みの記号を変えても壊れない
 * ようにするため。`\t` `\n` `\r` は XML の読み手が空白 1 つへ潰してしまう(属性値の正規化)
 * ので、数値参照にして元の文字のまま読めるようにする。
 */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/**
 * 数を XML の属性へ書く形にする(§2.6)。
 *
 * - 小数点以下 6 桁で丸める(それより細かい桁は 3D プリントでも CAD でも意味を持たない)。
 * - **末尾の 0 を落とす**(`1.5000000` ではなく `1.5`。10 万三角形では数 MB の差になる)。
 * - **`-0` を書かない**(`0` にする。同じ形から違うバイト列ができないようにするため)。
 * - **指数表記にしない**(`1e-7` のような書き方を受け取れない読み手があるため)。
 *
 * 有限でない数(`NaN` / `±Infinity`)と、指数表記になるほど大きい数は書けないので断る。
 * 三角形の座標は kernel が作った時点で有限な数に揃っている(面積 0 や `NaN` の三角形は
 * kernel の書き出し側で落としてある)ので、ここへ来るのは呼び出し側の作り間違いだけである。
 */
export function formatXmlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(XML_INVALID_NUMBER_MESSAGE);
  }
  const rounded = Math.round(value * SCALE) / SCALE;
  // `-0 === 0` なので、丸めて 0 になった負の数もここで符号が消える。
  if (rounded === 0) {
    return '0';
  }
  const text = rounded.toString();
  if (text.includes('e')) {
    // 10 の 21 乗以上でしか起きない。mm の座標としては現実に無い大きさなので、書かずに断る。
    throw new Error(XML_INVALID_NUMBER_MESSAGE);
  }
  return text;
}
