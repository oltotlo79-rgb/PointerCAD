import Decimal from 'decimal.js';

import type { Node } from './ast.js';
import {
  EXPRESSION_MAX_EXPONENT,
  expressionError,
  ExpressionFailure,
  wrongArgumentCountError,
} from './errors.js';
import { lengthUnitFactor } from './lengthUnits.js';

/**
 * 内部の演算桁数(計画書 docs/plans/P1-式とスケッチ.md §2.4、§0.a-0.7)。
 * double の有効桁は約 15.95 桁。式1本の演算は数十回なので、40 桁あれば
 * 途中の桁落ちが double の精度を侵さない。
 */
export const EXPRESSION_PRECISION = 40;

/**
 * 式の評価だけに使う Decimal。clone するのは、Decimal.set が decimal.js の全体設定を
 * 書き換えてしまい、他の場所やテストの実行順で結果が変わるのを避けるため(§2.4)。
 */
export const ExpressionDecimal = Decimal.clone({
  precision: EXPRESSION_PRECISION,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -9,
  toExpPos: 21,
});

/** 円周率。桁数を変えても定義がずれないよう、リテラルではなく計算で得る(§2.4)。 */
export const PI = ExpressionDecimal.acos(-1);
/** 自然対数の底。同上。 */
export const E = ExpressionDecimal.exp(1);

/**
 * 使える関数と、その引数の個数(§2.3)。
 * 輸出するのは、この名前の集合をパラメータ名の予約語判定(variableNames.ts の
 * checkVariableName)からも使うため。関数名の一覧を2か所に書かない
 * (docs/plans/P4b-スケッチの仕上げ.md タスク1)。
 */
export const FUNCTION_ARITY: ReadonlyMap<string, number> = new Map([
  ['sqrt', 1],
  ['cbrt', 1],
  ['abs', 1],
  ['rad', 1],
  ['root', 2],
]);

/** 度とラジアンの換算に使う。rad(x) は「x ラジアン」を度へ直す(FR-205)。 */
const DEGREES_IN_HALF_TURN = 180;

type BinaryNode = Extract<Node, { kind: 'binary' }>;
type CallNode = Extract<Node, { kind: 'call' }>;
type UnitNode = Extract<Node, { kind: 'unit' }>;

/**
 * 部分式の値と、それが**長さの単位を明示して持っているか**(§2.9.1)。
 *
 * 変数(パラメータ)は `hasUnit: false` とする。中身が長さかどうかは表からは分からず、
 * 単位の空間の中では「その単位の数」として扱う決まりだから(§0.a-0.63)。
 */
interface UnitAwareValue {
  readonly value: Decimal;
  readonly hasUnit: boolean;
}

/** 評価の途中で持ち回るもの。 */
interface EvaluateContext {
  readonly variables: ReadonlyMap<string, number>;
  /**
   * いま単位の空間の中にいるなら、その mm への倍率(inch なら 25.4)。外にいるなら null。
   * 単位の入れ子(`(1.5in*2)in`)はここが null でないことで見つける。
   */
  readonly scale: Decimal | null;
  /** 長さでないパラメータの名前(角度・無次元)。単位の空間の中でも換算しない。 */
  readonly nonLengthVariables: ReadonlySet<string>;
}

/** 既定の「長さでないパラメータ」。呼び出しごとに Set を作らないよう 1 つだけ持つ。 */
const NO_NON_LENGTH_VARIABLES: ReadonlySet<string> = new Set<string>();

export interface EvaluateNodeOptions {
  /**
   * 長さでないパラメータの名前(§0.a-0.63、計画書 タスク1b 手順5b)。
   *
   * 単位の空間の中では、パラメータの値(内部は mm)を単位の倍率で割ってから式へ入れる。
   * ここに挙げた名前だけはその割り算をしない。`packages/model` のパラメータは
   * `ParameterUnit`(`'mm' | 'degree' | 'none'`)を持つので、呼び出し側は `degree` と
   * `none` の名前をここへ渡す。渡さなければ**すべてを長さとして扱う**。
   */
  readonly nonLengthVariables?: ReadonlySet<string>;
}

/** n 乗根。負の数が実数の n 乗根を持つのは、n が奇数の整数のときだけ。 */
function evaluateRoot(value: Decimal, degree: Decimal, position: number): Decimal {
  if (degree.isZero()) {
    throw new ExpressionFailure(expressionError('rootDegreeZero', '', position));
  }
  const exponent = new ExpressionDecimal(1).dividedBy(degree);
  if (value.isNegative()) {
    if (!degree.isInteger() || degree.modulo(2).isZero()) {
      throw new ExpressionFailure(expressionError('negativeRoot', value.toString(), position));
    }
    // 大きさだけを求めてから符号を戻す。負の底のまま pow を呼ぶと NaN になるため。
    return requireFinite(value.negated().pow(exponent), position).negated();
  }
  return requireFinite(value.pow(exponent), position);
}

/** 数として表せない結果(NaN・無限大)をここで断る(§2.5 #15)。 */
function requireFinite(value: Decimal, position: number): Decimal {
  if (!value.isFinite()) {
    throw new ExpressionFailure(expressionError('notFinite', '', position));
  }
  return value;
}

function evaluateVariable(name: string, position: number, context: EvaluateContext): Decimal {
  const found = context.variables.get(name);
  if (found === undefined) {
    throw new ExpressionFailure(expressionError('unknownVariable', name, position));
  }
  // 変数は double で受け取る(§0.a-0.6)。十進表記のまま Decimal へ移すので、
  // ここで新たな誤差は入らない。
  const value = new ExpressionDecimal(found);
  if (context.scale === null || context.nonLengthVariables.has(name)) {
    return value;
  }
  // 単位の空間の中では、パラメータも「その単位の数」として扱う(§0.a-0.63)。
  // 内部の値は mm なので倍率で割ってから式へ入れ、最後に単位の節が倍率を掛け直す。
  // 割り算も任意精度のまま行い、double へ丸めるのは最終段だけ(NFR-RE-4)。
  return value.dividedBy(context.scale);
}

/** 単位が合っていないことを断る(§2.9.1)。 */
function unitMismatch(position: number): ExpressionFailure {
  return new ExpressionFailure(expressionError('unitMismatch', '', position));
}

function evaluateBinary(node: BinaryNode, context: EvaluateContext): UnitAwareValue {
  const left = evaluateWithUnit(node.left, context);
  const right = evaluateWithUnit(node.right, context);
  switch (node.operator) {
    case '+':
    case '-':
      // 足し引きは両辺の次元がそろっているときだけ(`1in + 2` は断り、`1in + 2mm` は通す)。
      if (left.hasUnit !== right.hasUnit) {
        throw unitMismatch(node.position);
      }
      return {
        value: node.operator === '+' ? left.value.plus(right.value) : left.value.minus(right.value),
        hasUnit: left.hasUnit,
      };
    case '*':
      // 掛け算の相手は無次元(`1in * 2` は通し、`1in * 2in` は面積になるので断る)。
      if (left.hasUnit && right.hasUnit) {
        throw unitMismatch(node.position);
      }
      return { value: left.value.times(right.value), hasUnit: left.hasUnit || right.hasUnit };
    case '/':
      // 割る側に単位は付けられない(`1in / 2` は通し、`1in / 2in` や `2 / 1in` は断る)。
      if (right.hasUnit) {
        throw unitMismatch(node.position);
      }
      if (right.value.isZero()) {
        throw new ExpressionFailure(expressionError('divisionByZero', '', node.position));
      }
      return { value: left.value.dividedBy(right.value), hasUnit: left.hasUnit };
    case '^':
      // 単位つきの累乗は面積・体積になるので断る(`1in^2`)。指数側の単位も意味を持たない。
      if (left.hasUnit || right.hasUnit) {
        throw unitMismatch(node.position);
      }
      // 指数の上限を先に見るのは、9^9^9 のような式で任意精度の計算が長時間止まるのを
      // 防ぐため(§2.4)。判定は比較1回で終わる。
      if (right.value.abs().greaterThan(EXPRESSION_MAX_EXPONENT)) {
        throw new ExpressionFailure(expressionError('exponentTooLarge', '', node.position));
      }
      return { value: requireFinite(left.value.pow(right.value), node.position), hasUnit: false };
  }
}

/**
 * 単位つきの式(`1.5in`、`(10*2)in`)。中身をその単位の空間で評価し、最後に倍率を掛ける。
 * `値(mm) = 25.4 × f(リテラルはそのまま, パラメータは値/25.4)`(§0.a-0.63)。
 */
function evaluateUnit(node: UnitNode, context: EvaluateContext): UnitAwareValue {
  if (context.scale !== null) {
    // 単位の入れ子(`(1.5in*2)in`、`1in*2in`)。どちらの単位で読むべきか決められない。
    throw unitMismatch(node.position);
  }
  const factor = new ExpressionDecimal(lengthUnitFactor(node.unit));
  const inner = evaluateWithUnit(node.operand, { ...context, scale: factor });
  return { value: inner.value.times(factor), hasUnit: true };
}

function evaluateCall(node: CallNode, context: EvaluateContext): Decimal {
  const arity = FUNCTION_ARITY.get(node.name);
  if (arity === undefined) {
    throw new ExpressionFailure(expressionError('unknownFunction', node.name, node.position));
  }
  if (node.args.length !== arity) {
    throw new ExpressionFailure(
      wrongArgumentCountError(node.name, arity, node.args.length, node.position),
    );
  }
  const values = node.args.map((argument) => {
    const result = evaluateWithUnit(argument, context);
    if (result.hasUnit) {
      // 単位は式の後ろにだけ付けられる(§2.9.1)。`sqrt(4in)` ではなく `sqrt(4)in` と書く。
      throw unitMismatch(argument.position);
    }
    return result.value;
  });
  const first = values[0];
  switch (node.name) {
    case 'sqrt':
      if (first.isNegative()) {
        throw new ExpressionFailure(
          expressionError('negativeRoot', first.toString(), node.position),
        );
      }
      return first.sqrt();
    case 'cbrt':
      return first.cbrt();
    case 'abs':
      return first.abs();
    case 'rad':
      return first.times(DEGREES_IN_HALF_TURN).dividedBy(PI);
    case 'root':
      return evaluateRoot(first, values[1], node.position);
    default:
      // FUNCTION_ARITY とこの分岐が食い違ったときだけ来る。
      throw new ExpressionFailure(expressionError('unknownFunction', node.name, node.position));
  }
}

/** 構文木を評価し、値と「単位を持つか」を返す(内部用)。 */
function evaluateWithUnit(node: Node, context: EvaluateContext): UnitAwareValue {
  switch (node.kind) {
    case 'number': {
      // ".5" のような書き方も decimal.js が確実に読めるよう 0 を補う。
      const text = node.text.startsWith('.') ? `0${node.text}` : node.text;
      return { value: new ExpressionDecimal(text), hasUnit: false };
    }
    case 'constant':
      // π・e は無次元。単位の空間の中でも換算しない(`π*1in` は 25.4π)。
      return { value: node.name === 'pi' ? PI : E, hasUnit: false };
    case 'variable':
      return { value: evaluateVariable(node.name, node.position, context), hasUnit: false };
    case 'unary': {
      const operand = evaluateWithUnit(node.operand, context);
      return {
        value: node.operator === '-' ? operand.value.negated() : operand.value,
        hasUnit: operand.hasUnit,
      };
    }
    case 'binary':
      return evaluateBinary(node, context);
    case 'call':
      // 関数の結果は無次元として扱う。単位は `sqrt(4)in` のように外側へ付ける。
      return { value: evaluateCall(node, context), hasUnit: false };
    case 'unit':
      return evaluateUnit(node, context);
  }
}

/**
 * 構文木を任意精度で評価する。中間結果は一度も number へ落とさない(NFR-RE-4)。
 * double へ丸めるのは呼び出し側が最後に 1 回だけ行う(§0.a-0.7)。
 * 変数表は FR-206 の土台。値は double で受け取る(§0.a-0.6)。P1 の UI は空の Map を渡す。
 *
 * 返す値は必ず **mm**(長さの単位を書いた式は、ここで倍率を掛け終えている。§2.9.1)。
 */
export function evaluateNode(
  node: Node,
  variables: ReadonlyMap<string, number>,
  options: EvaluateNodeOptions = {},
): Decimal {
  return evaluateWithUnit(node, {
    variables,
    scale: null,
    nonLengthVariables: options.nonLengthVariables ?? NO_NON_LENGTH_VARIABLES,
  }).value;
}
