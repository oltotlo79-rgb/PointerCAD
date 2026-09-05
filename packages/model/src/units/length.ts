/**
 * 表示と入力の長さの単位(要件 FR-811・FR-814、計画書 docs/plans/P6-入出力.md
 * §2.9・§2.9.1、§0.a-0.1・§0.a-0.63)。
 *
 * **内部は mm 固定**(NFR-RE-3)。換算するのは**表示と入力の境目だけ**で、文書には
 * 単位を保存しない(表示を mm ↔ inch で切り替えても `.pcad` は 1 バイトも変わらない)。
 * ここに置くのは**内部の値に一切触れない純関数だけ**とする。
 *
 * 厳密値(任意精度)を扱うのは `@pointercad/expression` の中だけという約束(rules/04)に
 * 従い、この換算は double で行う。式の中に書かれた `1.5in` の評価は expression の側が
 * 任意精度のまま行うので、こちらの double の割り算がその精度を落とすことはない。
 *
 * **入力の受け方(`parseDisplayInput`)が返すのは「式の文字列」**であって値ではない。
 * 保存されるのは式の文字列のまま(FR-202)で、評価は `evaluateExpression` の役目である。
 */

import { containsLengthUnit } from '@pointercad/expression';

import { formatLength as formatMillimeters } from '../measure/massProperties.js';
import type { Parameter, ParameterUnit } from '../parameters/types.js';

/**
 * 画面に出す長さの単位(FR-811)。**端末の設定であって文書の属性ではない**(§0.a-0.1)。
 * 式の中に書ける単位(`@pointercad/expression` の `ExpressionLengthUnit` = `mm` / `in` / `"`)
 * とは別物で、あちらは綴り、こちらは表示の選択肢である。
 */
export type LengthUnit = 'mm' | 'inch';

/**
 * 表示の単位の一覧。設定の読み込み(タスク3)が「知らない単位」を断るときの正本にする
 * (同じ一覧を 2 か所に書かない。`parameters/types.ts` の `PARAMETER_UNITS` と同じ流儀)。
 */
export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'inch'];

/**
 * 1 inch = 25.4 mm(国際インチの定義値。厳密)。
 *
 * `@pointercad/expression` の `MM_PER_INCH_TEXT`(10 進の文字列 `'25.4'`)と同じ値だが、
 * `expression` は `model` に依存できない(rules/04 の依存方向)ので、それぞれが持つ。
 * **2 か所に別の値が入らないよう、両者が一致することを `length.test.ts` で固定する。**
 */
export const MM_PER_INCH = 25.4;

/** inch で表示するときの小数の桁数(§2.9)。0.001in ≒ 0.0254mm で、機械加工の読みに足りる。 */
export const INCH_DISPLAY_DIGITS = 3;

/**
 * 内部の値(mm)を、表示の単位の数へ直す(FR-811)。mm のときは恒等。
 * `switch` に `default` を書かないので、単位が増えたら型検査で落ちる。
 */
export function toDisplayLength(millimeters: number, unit: LengthUnit): number {
  switch (unit) {
    case 'mm':
      return millimeters;
    case 'inch':
      return millimeters / MM_PER_INCH;
  }
}

/** 表示の単位の数を、内部の値(mm)へ戻す(FR-811)。`toDisplayLength` の逆。 */
export function fromDisplayLength(value: number, unit: LengthUnit): number {
  switch (unit) {
    case 'mm':
      return value;
    case 'inch':
      return value * MM_PER_INCH;
  }
}

/**
 * 長さ(内部の mm)を、表示の単位つきの文字列にする(FR-811、FR-1102)。
 *
 * **mm の書式は `measure/massProperties.ts` の `formatLength` に任せる**(1000mm 以上は m、
 * 数の桁は有効数字 12 桁)。同じ規則を 2 か所に書くと、片方だけ直したときに欄ごとに
 * 見え方が変わるため、こちらは呼ぶだけにする。名前が重なるので `formatMillimeters` として
 * 輸入する(`packages/model` の輸出は `formatLength` 1 つのままにする)。
 *
 * `inchDigits` は **inch のときだけ**効く。mm 側は上記のとおり既存の書式に任せており、
 * 桁数の指定を受け取る口が無いため(引数の名前で効く範囲が分かるようにしてある)。
 */
export function formatDisplayLength(
  millimeters: number,
  unit: LengthUnit,
  inchDigits: number = INCH_DISPLAY_DIGITS,
): string {
  switch (unit) {
    case 'mm':
      return formatMillimeters(millimeters);
    case 'inch':
      return `${toDisplayLength(millimeters, 'inch').toFixed(inchDigits)} in`;
  }
}

/** 分数インチの既定の分母(FR-814)。製図と工具の慣習に合わせて 1/64 刻みにする。 */
export const DEFAULT_INCH_DENOMINATOR = 64;

/** 最大公約数(ユークリッドの互除法)。約分にだけ使う。どちらも 0 以上の整数を渡す。 */
function greatestCommonDivisor(left: number, right: number): number {
  let larger = left;
  let smaller = right;
  while (smaller !== 0) {
    const remainder = larger % smaller;
    larger = smaller;
    smaller = remainder;
  }
  return larger;
}

/**
 * 長さ(内部の mm)を**分数インチの表記**にする(FR-814)。
 *
 * `denominator` の刻み(既定は 1/64)で四捨五入し、**既約分数**にして返す。整数になったら
 * 分数を出さない(`25.4` → `1"`)。1 を超える端数は「帯分数」で書く(`38.1` → `1 1/2"`)。
 * 0 は符号を付けずに `0"`。負の値は先頭に半角の `-` を付ける(`formatMass` /
 * `formatLength` が使う `expressionValueFromNumber(...).display` と同じ半角の記号にそろえる)。
 *
 * **刻みへ丸めるので、元の mm へは戻らない**(`10mm` は `25/64"` = `9.921875mm`。差
 * `0.078125mm`)。値そのものを扱う欄には使わず、**読ませるための表記**にだけ使う。
 * 表示の既定は小数(`formatDisplayLength`)のままで、分数にするかは画面が選ぶ(タスク3b)。
 *
 * 丸めは符号を外した大きさで行う(`Math.round` は負の 0.5 を 0 側へ寄せるため、
 * 正負で刻みの取り方が変わらないようにする)。
 */
export function toFractionalInch(
  millimeters: number,
  denominator: number = DEFAULT_INCH_DENOMINATOR,
): string {
  const inches = toDisplayLength(millimeters, 'inch');
  const steps = Math.round(Math.abs(inches) * denominator);
  if (steps === 0) {
    // 刻みより小さい値は 0 に見せる。`-0"` と書かないよう符号もここで落とす。
    return '0"';
  }
  const sign = inches < 0 ? '-' : '';
  const whole = Math.floor(steps / denominator);
  const remainder = steps - whole * denominator;
  if (remainder === 0) {
    return `${sign}${String(whole)}"`;
  }
  const divisor = greatestCommonDivisor(remainder, denominator);
  const fraction = `${String(remainder / divisor)}/${String(denominator / divisor)}`;
  return whole === 0 ? `${sign}${fraction}"` : `${sign}${String(whole)} ${fraction}"`;
}

/**
 * inch の別名として使われる引用符のうち、半角の `"` へ直すもの。
 *
 * 日本語入力(IME)で `3/8"` と打つと閉じ引用符 U+201D(”)が入り、式としては
 * 「使えない文字」になる。ここで半角へ直しておく(`docs/報告記録.md` 2026-09-06 02:16 の
 * 統括の決定「全角 ” の正規化は入力の受け方の純関数で」)。
 *
 * `expression` の `normalizeExpressionSource`(全角の数字・記号 → 半角)へ足さないのは、
 * 引用符が**入力欄の都合**であって式の文法の話ではないため。1 文字を 1 文字へ置き換えるので
 * 文字数は変わらず、欄のカーソル位置(UTF-16 の添字)がずれない。
 */
const INCH_QUOTE_MAP: ReadonlyMap<string, string> = new Map([
  ['“', '"'], // “ 開き二重引用符
  ['”', '"'], // ” 閉じ二重引用符
  ['″', '"'], // ″ ダブルプライム(製図で inch に使われる)
  ['＂', '"'], // ＂ 全角の二重引用符
]);

/** 入力欄の引用符を半角の `"` へ直す。文字数は変えない。 */
export function normalizeInchQuotes(source: string): string {
  let normalized = '';
  for (const character of source) {
    normalized += INCH_QUOTE_MAP.get(character) ?? character;
  }
  return normalized;
}

/**
 * 数値欄に打たれた文字列を、**保存する式の文字列**へ直す(§0.a-0.63、§2.9.1 ②)。
 * 値ではなく式を返す(FR-202「式は文字列のまま保存される」)。
 *
 * - 表示が inch で、打った文字列に単位が 1 つも書かれていないときは、**全体を `(…)in` で
 *   包む。** 数だけの入力も式を含む入力も同じ扱いにする(`10` → `(10)in`、`10*2` →
 *   `(10*2)in`、`w*2` → `(w*2)in`)。一部だけを包まない(`10*2` を `10in*2` にしない。
 *   掛け算の相手は無次元という規則と衝突するため)。
 * - **単位が 1 つでも書かれていれば触らない**(`2mm`、`1.5in`、`2*1.5in`)。判定は
 *   `expression` の字句(`containsLengthUnit`)に任せる。自前の正規表現を書くと、単位の
 *   綴りの規則が 2 か所に分かれて食い違う。
 * - **表示が mm のときは何も包まない**(`(10)mm` と書かない。既存の式と 1 バイトも
 *   変えないため)。
 * - 引用符の正規化だけは表示の単位に関わらず行う(mm の欄でも `3/8”` と打てる)。
 * - 空(空白だけを含む)の入力は包まない。`()in` は読めない式になり、断りの文言が
 *   「式が空です」ではなくなってしまうため。
 */
export function parseDisplayInput(source: string, unit: LengthUnit): string {
  const normalized = normalizeInchQuotes(source);
  switch (unit) {
    case 'mm':
      return normalized;
    case 'inch':
      if (normalized.trim() === '' || containsLengthUnit(normalized)) {
        return normalized;
      }
      return `(${normalized})in`;
  }
}

/**
 * そのパラメータの単位が「長さ」か(`parameters/types.ts` の `ParameterUnit`)。
 * `switch` に `default` を書かないので、単位が増えたら型検査で落ちる。
 */
function isLengthParameterUnit(unit: ParameterUnit): boolean {
  switch (unit) {
    case 'mm':
      return true;
    case 'degree':
    case 'none':
      return false;
  }
}

/**
 * 長さでないパラメータ(角度・無次元)の名前の集合(§0.a-0.63)。
 * `evaluateExpression` の `nonLengthVariables` へそのまま渡す。
 *
 * 単位つきの式(`(w+10)in`)の中では、**長さのパラメータだけ**を単位の倍率で割ってから
 * 式へ入れる。個数や角度まで割ると、`n+10`(n = 5 個)が `(5/25.4+10)×25.4` になって
 * 意味の無い値になるため。渡さなければ expression は**すべてを長さとして扱う**ので、
 * 呼び出し側がこの集合を渡し忘れても単位を書かない式の値は変わらない(安全側)。
 *
 * 引数を文書ではなくパラメータの配列にしてあるのは、パラメータ表だけを持っている
 * 呼び出し側(パラメータの一覧の画面)からも使えるようにするため(`document.parameters`
 * を渡す)。
 */
export function nonLengthVariables(parameters: readonly Parameter[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (!isLengthParameterUnit(parameter.unit)) {
      names.add(parameter.name);
    }
  }
  return names;
}
