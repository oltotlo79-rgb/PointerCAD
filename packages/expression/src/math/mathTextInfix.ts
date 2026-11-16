import type { MathNode } from './mathInputContract.js';

/**
 * 利用者の書き方(中置の + - * / ^ と前置の -)で式の文字を作る(C-02k)。
 * 記号の名前を変えた後の式の文字に、内部の書き方 `Add(sum(…),…)` が出ないようにするための道具。
 * 木の形が読み直しでそのまま戻る物だけを扱う(演算子の優先順位と結合は mathTextSyntax.ts の INFIX 表と同じ)。
 * 扱えない式(3 つ以上の項、負の数の直書き、足す・引く・掛ける・割る・冪・符号反転以外)は null を返し、呼び元が今までの書き方にする。
 */
interface InfixKind { readonly symbol: string; readonly binding: number; readonly right: boolean }
const BINARY: Readonly<Record<string, InfixKind>> = {
  add: { symbol: '+', binding: 50, right: false },
  subtract: { symbol: '-', binding: 50, right: false },
  multiply: { symbol: '*', binding: 60, right: false },
  divide: { symbol: '/', binding: 60, right: false },
  power: { symbol: '^', binding: 80, right: true },
};
const NEGATE_BINDING = 70;
const ATOM = 100;

/** 子の式が中置で書けるなら、その優先順位。それ以外の部品は関数呼び出しか単独の値なので ATOM。 */
function bindingOf(node: MathNode): number {
  if (node.kind !== 'operation') return ATOM;
  const binary = BINARY[node.operation];
  if (binary !== undefined && node.operands.length === 2) return binary.binding;
  if (node.operation === 'negate' && node.operands.length === 1) return NEGATE_BINDING;
  return ATOM;
}

/** 中置にできる演算なら、子を `formatChild` で書いて組み立てる。できなければ null(子の一部が書けない時も null)。 */
export function formatInfixOperation(node: MathNode, formatChild: (child: MathNode) => string): string | null {
  if (node.kind !== 'operation' || !infixable(node)) return null;
  // 演算子の右に来る符号反転は、読みやすさのため括弧で囲む(3*(-2)、2^(-1))。
  const parenthesized = (child: MathNode, needed: number, rightOfOperator = false): string =>
    bindingOf(child) >= needed && !(rightOfOperator && child.kind === 'operation' && child.operation === 'negate')
      ? formatChild(child) : `(${formatChild(child)})`;
  if (node.operation === 'negate') return `-${parenthesized(node.operands[0], NEGATE_BINDING)}`;
  const binary = BINARY[node.operation];
  const [left, right] = node.operands;
  return `${parenthesized(left, binary.right ? binary.binding + 1 : binary.binding)}${binary.symbol}${parenthesized(right, binary.right ? binary.binding : binary.binding + 1, true)}`;
}

function infixable(node: Extract<MathNode, { kind: 'operation' }>): boolean {
  const binary = BINARY[node.operation];
  const arity = binary === undefined ? (node.operation === 'negate' ? 1 : -1) : 2;
  if (node.operands.length !== arity) return false;
  // `-3` は読み直すと数ではなく符号反転になるので、負の数の直書きは関数呼び出しの書き方に任せる。
  return node.operands.every(child => child.kind !== 'number' || !child.decimal.startsWith('-'));
}
