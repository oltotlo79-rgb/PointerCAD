import Decimal from 'decimal.js';

import type { Node } from './ast.js';
import {
  EXPRESSION_MAX_EXPONENT,
  expressionError,
  ExpressionFailure,
  wrongArgumentCountError,
} from './errors.js';

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

function evaluateVariable(
  name: string,
  position: number,
  variables: ReadonlyMap<string, number>,
): Decimal {
  const found = variables.get(name);
  if (found === undefined) {
    throw new ExpressionFailure(expressionError('unknownVariable', name, position));
  }
  // 変数は double で受け取る(§0.a-0.6)。十進表記のまま Decimal へ移すので、
  // ここで新たな誤差は入らない。
  return new ExpressionDecimal(found);
}

function evaluateBinary(node: BinaryNode, variables: ReadonlyMap<string, number>): Decimal {
  const left = evaluateNode(node.left, variables);
  const right = evaluateNode(node.right, variables);
  switch (node.operator) {
    case '+':
      return left.plus(right);
    case '-':
      return left.minus(right);
    case '*':
      return left.times(right);
    case '/':
      if (right.isZero()) {
        throw new ExpressionFailure(expressionError('divisionByZero', '', node.position));
      }
      return left.dividedBy(right);
    case '^':
      // 指数の上限を先に見るのは、9^9^9 のような式で任意精度の計算が長時間止まるのを
      // 防ぐため(§2.4)。判定は比較1回で終わる。
      if (right.abs().greaterThan(EXPRESSION_MAX_EXPONENT)) {
        throw new ExpressionFailure(expressionError('exponentTooLarge', '', node.position));
      }
      return requireFinite(left.pow(right), node.position);
  }
}

function evaluateCall(node: CallNode, variables: ReadonlyMap<string, number>): Decimal {
  const arity = FUNCTION_ARITY.get(node.name);
  if (arity === undefined) {
    throw new ExpressionFailure(expressionError('unknownFunction', node.name, node.position));
  }
  if (node.args.length !== arity) {
    throw new ExpressionFailure(
      wrongArgumentCountError(node.name, arity, node.args.length, node.position),
    );
  }
  const values = node.args.map((argument) => evaluateNode(argument, variables));
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

/**
 * 構文木を任意精度で評価する。中間結果は一度も number へ落とさない(NFR-RE-4)。
 * double へ丸めるのは呼び出し側が最後に 1 回だけ行う(§0.a-0.7)。
 * 変数表は FR-206 の土台。値は double で受け取る(§0.a-0.6)。P1 の UI は空の Map を渡す。
 */
export function evaluateNode(node: Node, variables: ReadonlyMap<string, number>): Decimal {
  switch (node.kind) {
    case 'number': {
      // ".5" のような書き方も decimal.js が確実に読めるよう 0 を補う。
      const text = node.text.startsWith('.') ? `0${node.text}` : node.text;
      return new ExpressionDecimal(text);
    }
    case 'constant':
      return node.name === 'pi' ? PI : E;
    case 'variable':
      return evaluateVariable(node.name, node.position, variables);
    case 'unary': {
      const operand = evaluateNode(node.operand, variables);
      return node.operator === '-' ? operand.negated() : operand;
    }
    case 'binary':
      return evaluateBinary(node, variables);
    case 'call':
      return evaluateCall(node, variables);
  }
}
