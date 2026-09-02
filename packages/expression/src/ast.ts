/**
 * 構文木の節。計画書 docs/plans/P1-式とスケッチ.md §2.1 の BNF に対応する。
 *
 * position はいずれも「元の式の何文字目か」(0 始まり)。二項・単項の節は演算子の位置、
 * 関数呼び出しの節は関数名(√ のときは √ そのもの)の位置を持つ。括弧は節を作らず、
 * 中の式の節をそのまま返すので、位置は括弧の中の演算子を指す。
 */
export type Node =
  | { readonly kind: 'number'; readonly text: string; readonly position: number }
  | { readonly kind: 'constant'; readonly name: 'pi' | 'e'; readonly position: number }
  | { readonly kind: 'variable'; readonly name: string; readonly position: number }
  | {
      readonly kind: 'unary';
      readonly operator: '+' | '-';
      readonly operand: Node;
      readonly position: number;
    }
  | {
      readonly kind: 'binary';
      readonly operator: '+' | '-' | '*' | '/' | '^';
      readonly left: Node;
      readonly right: Node;
      readonly position: number;
    }
  | {
      readonly kind: 'call';
      readonly name: string;
      readonly args: readonly Node[];
      readonly position: number;
    };
