/**
 * 式どうしの足し算・引き算(FR-331「原点の再設定」、計画書 docs/plans/P4-スケッチ拡張.md
 * §0.a-0.25 ①・タスク35 ①)。
 *
 * 原点を選び直すと、文書の中の絶対座標は「元の式 − シフトの式」へ書き換わる。このとき
 * **式のまま**書き換えるのがこの機能の要(FR-331、rules/04-設計の規律.md の数値精度)。
 * したがってここは評価値を経由せず、**文字列としての式を組み立てる**のが役目である。
 *
 * 簡約は「厳密に計算できるところだけ」に限る(FR-331)。具体的には次の 3 つだけ。
 *   ①同じ式どうしの差は `0`(引き算だけ。原点にした点自身がここに当たる)。
 *   ②両方が有理数リテラル(整数・小数・分数)なら、有理数のまま厳密に計算した差・和。
 *     整数どうしは整数、小数どうしは 10 進で厳密に書ける形、分数が混じれば既約分数にする。
 *   ③片方が 0 のリテラルなら、もう片方をそのまま返す。
 * π・sqrt・変数・べき乗などを含む式は 1 文字も変えず、括弧で囲って連結するだけにする。
 * **小数へ丸めることは決してしない**(丸めると元の式へ戻せなくなるため)。
 *
 * 簡約に使う整数は `Number.MAX_SAFE_INTEGER` の範囲に収める(タスク35 の落とし穴)。
 * 桁が溢れるものは簡約せず、括弧つきの式のまま残す(誤った値を作るより式を残すほうが安全)。
 */

import type Decimal from 'decimal.js';

import type { Node } from './ast.js';
import { ExpressionDecimal } from './evaluate.js';
import {
  evaluateExpression,
  expressionValueFromNumber,
  type EvaluateOptions,
  type ExpressionValue,
} from './evaluateExpression.js';
import { parse } from './parse.js';

/** 簡約してよい整数の上限。これを超えたら簡約せず式のまま残す(タスク35 の落とし穴)。 */
const MAX_SAFE = new ExpressionDecimal(Number.MAX_SAFE_INTEGER);

const TEN = new ExpressionDecimal(10);

/** 有理数のリテラル。分母は必ず正で、符号は分子だけが持つ。 */
interface RationalLiteral {
  readonly numerator: Decimal;
  readonly denominator: Decimal;
  /** 元の式が分数の書き方(`p/q`)だったか。差を小数で書くか分数で書くかの判断に使う。 */
  readonly fraction: boolean;
}

function isSafeInteger(value: Decimal): boolean {
  return value.isFinite() && value.isInteger() && value.abs().lessThanOrEqualTo(MAX_SAFE);
}

/** 数のリテラル 1 つを有理数へ直す。`1.25` なら 125/100 のように 10 のべきを分母にする。 */
function rationalFromNumber(text: string): RationalLiteral | null {
  // ".5" のような書き方も decimal.js が確実に読めるよう 0 を補う(evaluate.ts と同じ扱い)。
  const parsed = new ExpressionDecimal(text.startsWith('.') ? `0${text}` : text);
  if (!parsed.isFinite()) {
    return null;
  }
  const denominator = TEN.pow(parsed.decimalPlaces());
  const numerator = parsed.times(denominator);
  if (!isSafeInteger(numerator) || !isSafeInteger(denominator)) {
    return null;
  }
  return { numerator, denominator, fraction: false };
}

/**
 * 構文木が有理数リテラルなら、その値を返す。そうでなければ null。
 *
 * 認めるのは「数」「単項の +/-」「有理数どうしの割り算」だけで、足し算・掛け算・べき乗・
 * 関数・π・変数は認めない。式の中の一部分だけを簡約することもしない(タスク35 の手順1)。
 */
function rationalOf(node: Node): RationalLiteral | null {
  switch (node.kind) {
    case 'number':
      return rationalFromNumber(node.text);
    case 'unary': {
      const inner = rationalOf(node.operand);
      if (inner === null) {
        return null;
      }
      return node.operator === '-'
        ? { ...inner, numerator: inner.numerator.negated() }
        : inner;
    }
    case 'binary': {
      if (node.operator !== '/') {
        return null;
      }
      const left = rationalOf(node.left);
      const right = rationalOf(node.right);
      if (left === null || right === null || right.numerator.isZero()) {
        return null;
      }
      const numerator = left.numerator.times(right.denominator);
      const denominator = left.denominator.times(right.numerator);
      // 符号は分子だけが持つ形へ揃える(約分と表示を 1 通りにするため)。
      const negative = denominator.isNegative();
      const signedNumerator = negative ? numerator.negated() : numerator;
      const signedDenominator = negative ? denominator.negated() : denominator;
      if (!isSafeInteger(signedNumerator) || !isSafeInteger(signedDenominator)) {
        return null;
      }
      return { numerator: signedNumerator, denominator: signedDenominator, fraction: true };
    }
    default:
      return null;
  }
}

/** 式を構文木へ。読めない式(保存ファイルから読み戻した壊れた式など)は null。 */
function parseOrNull(source: string): Node | null {
  try {
    return parse(source);
  } catch {
    // 読めない式でも書き換えを止めない。括弧で囲って連結する側へ倒す(FR-504)。
    return null;
  }
}

function rationalOfSource(source: string): RationalLiteral | null {
  const node = parseOrNull(source);
  return node === null ? null : rationalOf(node);
}

/** 最大公約数(いずれも整数)。約分に使う。 */
function greatestCommonDivisor(a: Decimal, b: Decimal): Decimal {
  let x = a.abs();
  let y = b.abs();
  while (!y.isZero()) {
    const next = x.modulo(y);
    x = y;
    y = next;
  }
  return x;
}

type CombineOperator = '+' | '-' | '*' | '/';

/**
 * 有理数どうしを厳密に計算し、簡約した式の文字列を返す。桁が溢れるなど厳密に書けない
 * ときは null(簡約せず元の式を連結する)。四則演算の 4 つを 1 つの関数にまとめる
 * (足し算・引き算・掛け算・割り算は「分子・分母をどう組むか」だけが違うため)。
 */
function combineRationals(
  a: RationalLiteral,
  b: RationalLiteral,
  operator: CombineOperator,
): string | null {
  let numerator: Decimal;
  let denominator: Decimal;
  switch (operator) {
    case '+':
      numerator = a.numerator.times(b.denominator).plus(b.numerator.times(a.denominator));
      denominator = a.denominator.times(b.denominator);
      break;
    case '-':
      numerator = a.numerator.times(b.denominator).minus(b.numerator.times(a.denominator));
      denominator = a.denominator.times(b.denominator);
      break;
    case '*':
      numerator = a.numerator.times(b.numerator);
      denominator = a.denominator.times(b.denominator);
      break;
    case '/':
      // 0 で割ることになる式は簡約しない(呼び出し側が事前にはじく)。
      if (b.numerator.isZero()) {
        return null;
      }
      numerator = a.numerator.times(b.denominator);
      denominator = a.denominator.times(b.numerator);
      break;
  }
  if (denominator.isNegative()) {
    // 分母は必ず正に保つ(`RationalLiteral` の決まり。割り算で符号が分母へ回るため)。
    numerator = numerator.negated();
    denominator = denominator.negated();
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  if (divisor.isZero()) {
    return null;
  }
  const reducedNumerator = numerator.dividedBy(divisor);
  const reducedDenominator = denominator.dividedBy(divisor);
  if (!isSafeInteger(reducedNumerator) || !isSafeInteger(reducedDenominator)) {
    return null;
  }
  if (reducedDenominator.equals(1)) {
    return reducedNumerator.toFixed();
  }
  // 割り算は割り切れないかぎり常に既約分数で返す(10/3 を 3.3333… のように丸めて書ける
  // 10 進表記が無いため。タスク35 ②の決定)。
  if (a.fraction || b.fraction || operator === '/') {
    return `${reducedNumerator.toFixed()}/${reducedDenominator.toFixed()}`;
  }
  // 足し算・引き算・掛け算の小数どうしは 10 進の桁を保った厳密な値にする(統括の決定 2026-09-04)。
  const quotient = reducedNumerator.dividedBy(reducedDenominator);
  return quotient.times(reducedDenominator).equals(reducedNumerator) ? quotient.toFixed() : null;
}

/**
 * 括弧で囲まずに連結してよい式か。数・π・e・変数・関数呼び出しだけが対象。
 *
 * 単項のマイナスや二項演算は必ず囲む。`a - b - c` の `b - c` を囲まないと符号が変わるため
 * (タスク35 の落とし穴)。読めない式も囲む側へ倒す。
 */
function isAtomicSource(source: string): boolean {
  const node = parseOrNull(source);
  if (node === null) {
    return false;
  }
  return (
    node.kind === 'number' ||
    node.kind === 'constant' ||
    node.kind === 'variable' ||
    node.kind === 'call'
  );
}

function wrapSource(source: string): string {
  return isAtomicSource(source) ? source : `(${source})`;
}

/** 積・商の式を簡約せず連結し、入力された部分式と演算順序を保つ。 */
export function composeExpressionSource(left: string, right: string, operator: '*' | '/'): string {
  return `${wrapSource(left)}${operator}${wrapSource(right)}`;
}

/**
 * 組み立てた式から `ExpressionValue` を作る。値は再評価して得る(2 通りの評価を作らない)。
 *
 * 評価できないときだけ、元の 2 つの値から計算した値を添えて式そのものは残す。変数を含む式は
 * 変数表を渡さないと評価できず(FR-206)、そこで式を捨てると原点の再設定が式を壊してしまう。
 * 値は後で `reevaluateDocument` が変数表つきで求め直せる(recomputeSketch.ts)。
 */
function buildValue(source: string, fallback: number, options: EvaluateOptions): ExpressionValue {
  const result = evaluateExpression(source, options);
  if (result.ok) {
    return result.value;
  }
  return { source, value: fallback, display: expressionValueFromNumber(fallback).display };
}

/**
 * 2 つの式の差 `a − b`(FR-331)。
 *
 * 既定は `(a) - (b)` の連結で、`a` / `b` が単項(数・π・変数・関数呼び出し)のときだけ
 * その括弧を省く。簡約はこのファイル冒頭の 3 つだけ行う。
 */
export function subtractExpression(
  a: ExpressionValue,
  b: ExpressionValue,
  options: EvaluateOptions = {},
): ExpressionValue {
  // 同じ式どうしの差は、中身が何であれ厳密に 0(§0.a-0.25 ⑤。原点にした点自身がここ)。
  if (a.source === b.source) {
    return expressionValueFromNumber(0);
  }
  const left = rationalOfSource(a.source);
  const right = rationalOfSource(b.source);
  if (left !== null && right !== null) {
    const simplified = combineRationals(left, right, '-');
    if (simplified !== null) {
      return buildValue(simplified, a.value - b.value, options);
    }
  }
  // 0 を引いても式は変わらない。括弧を増やさないためにここで返す。
  if (right !== null && right.numerator.isZero()) {
    return a;
  }
  return buildValue(`${wrapSource(a.source)} - ${wrapSource(b.source)}`, a.value - b.value, options);
}

/**
 * 2 つの式の和 `a + b`(FR-331)。差と同じ規則で組み立てる。
 *
 * 原点の再設定では、①基準の 3 面のうち法線が世界の軸の負の向きを向くもの(XZ 面の法線は
 * −Y)のオフセットを直すとき、②相対座標の連なりを「基準の式 + ずれの式」へまとめるときに使う。
 */
export function addExpression(
  a: ExpressionValue,
  b: ExpressionValue,
  options: EvaluateOptions = {},
): ExpressionValue {
  const left = rationalOfSource(a.source);
  const right = rationalOfSource(b.source);
  if (left !== null && right !== null) {
    const simplified = combineRationals(left, right, '+');
    if (simplified !== null) {
      return buildValue(simplified, a.value + b.value, options);
    }
  }
  if (right !== null && right.numerator.isZero()) {
    return a;
  }
  if (left !== null && left.numerator.isZero()) {
    return b;
  }
  return buildValue(`${wrapSource(a.source)} + ${wrapSource(b.source)}`, a.value + b.value, options);
}

/** 有理数リテラルの値がちょうど 1 か(分子と分母が等しいか。約分前でも判定できる)。 */
function isUnitLiteral(literal: RationalLiteral): boolean {
  return literal.numerator.equals(literal.denominator);
}

/**
 * 2 つの式の積 `a * b`(タスク35、矩形の中心・幅・高さの換算で使う「値を半分にする」計算に使う)。
 *
 * 差・和と同じ規則で組み立てる。単位元 `0` と `1` は式を増やさないためにその場で省く
 * (`0 * a → 0`、`a * 1 → a`、`1 * a → a`)。
 */
export function multiplyExpression(
  a: ExpressionValue,
  b: ExpressionValue,
  options: EvaluateOptions = {},
): ExpressionValue {
  const left = rationalOfSource(a.source);
  const right = rationalOfSource(b.source);
  if (left !== null && right !== null) {
    const simplified = combineRationals(left, right, '*');
    if (simplified !== null) {
      return buildValue(simplified, a.value * b.value, options);
    }
  }
  // 0 を掛けた結果は常に 0(順序を問わない)。
  if ((right !== null && right.numerator.isZero()) || (left !== null && left.numerator.isZero())) {
    return expressionValueFromNumber(0);
  }
  // 1 を掛けても式は変わらない。括弧を増やさないためにここで返す。
  if (right !== null && isUnitLiteral(right)) {
    return a;
  }
  if (left !== null && isUnitLiteral(left)) {
    return b;
  }
  return buildValue(`${wrapSource(a.source)} * ${wrapSource(b.source)}`, a.value * b.value, options);
}

/**
 * 2 つの式の商 `a / b`(タスク35、矩形の幅・高さから半分の大きさを作るときに使う)。
 *
 * 積と同じ規則で組み立てる。0 で割ることになる式は簡約せず括弧つきで連結する
 * (0 割りの値は定まらないため、式を壊すより残すほうを選ぶ)。単位元 `1` で割っても式は変わらない
 * (`a / 1 → a`)。
 */
export function divideExpression(
  a: ExpressionValue,
  b: ExpressionValue,
  options: EvaluateOptions = {},
): ExpressionValue {
  const left = rationalOfSource(a.source);
  const right = rationalOfSource(b.source);
  if (left !== null && right !== null && !right.numerator.isZero()) {
    const simplified = combineRationals(left, right, '/');
    if (simplified !== null) {
      return buildValue(simplified, a.value / b.value, options);
    }
  }
  if (right !== null && isUnitLiteral(right)) {
    return a;
  }
  return buildValue(`${wrapSource(a.source)} / ${wrapSource(b.source)}`, a.value / b.value, options);
}
