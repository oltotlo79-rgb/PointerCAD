import type { Node } from './ast.js';
import { expressionError, ExpressionFailure } from './errors.js';
import { tokenize, type Token } from './tokenize.js';

/**
 * 定数として扱う識別子の名前(`pi` / `π` / `e`)。
 * 輸出するのは、この名前の集合をパラメータ名の予約語判定(variableNames.ts の
 * checkVariableName)からも使うため。定数名の一覧を2か所に書かない
 * (docs/plans/P4b-スケッチの仕上げ.md タスク1)。
 */
export const CONSTANT_TOKEN_NAMES: ReadonlySet<string> = new Set(['pi', 'π', 'e']);

/**
 * 式を構文木へ直す(計画書 docs/plans/P1-式とスケッチ.md §2.1 の BNF)。優先順位は
 * 「+ -(2項) < * / < + -(単項) < ^ < √ < 括弧・関数」。^ は右結合。
 * 失敗したら ExpressionFailure を投げる。
 *
 * 演算子の種類を絞るときは as による強制変換を使わず、`text === '+' ? '+' : '-'` の形で
 * 型を得る(docs/報告記録.md 2026-09-02 14:50 / 15:42 の教訓)。
 */
export function parse(source: string): Node {
  const tokens = tokenize(source);
  let index = 0;

  function peek(): Token | null {
    return index < tokens.length ? tokens[index] : null;
  }

  function parseAddExpr(): Node {
    let left = parseMulExpr();
    for (;;) {
      const token = peek();
      if (token === null || token.type !== 'operator') {
        return left;
      }
      if (token.text !== '+' && token.text !== '-') {
        return left;
      }
      const operator = token.text === '+' ? '+' : '-';
      index += 1;
      const right = parseMulExpr();
      left = { kind: 'binary', operator, left, right, position: token.position };
    }
  }

  function parseMulExpr(): Node {
    let left = parseUnaryExpr();
    for (;;) {
      const token = peek();
      if (token === null || token.type !== 'operator') {
        return left;
      }
      if (token.text !== '*' && token.text !== '/') {
        return left;
      }
      const operator = token.text === '*' ? '*' : '/';
      index += 1;
      const right = parseUnaryExpr();
      left = { kind: 'binary', operator, left, right, position: token.position };
    }
  }

  function parseUnaryExpr(): Node {
    const token = peek();
    if (token !== null && token.type === 'operator' && (token.text === '+' || token.text === '-')) {
      const operator = token.text === '+' ? '+' : '-';
      index += 1;
      const operand = parseUnaryExpr();
      return { kind: 'unary', operator, operand, position: token.position };
    }
    return parsePowExpr();
  }

  function parsePowExpr(): Node {
    const base = parsePrimary();
    const token = peek();
    if (token !== null && token.type === 'operator' && token.text === '^') {
      index += 1;
      // 指数側を単項式にすることで 2^-3 が書け、2^3^2 が右結合になる。
      const exponent = parseUnaryExpr();
      return {
        kind: 'binary',
        operator: '^',
        left: base,
        right: exponent,
        position: token.position,
      };
    }
    return base;
  }

  function parsePrimary(): Node {
    const token = peek();
    if (token === null) {
      throw new ExpressionFailure(expressionError('unexpectedEnd', ''));
    }
    index += 1;

    if (token.type === 'number') {
      return { kind: 'number', text: token.text, position: token.position };
    }

    if (token.type === 'operator' && token.text === '√') {
      const operand = parseUnaryExpr();
      // √x は sqrt(x) と同じ節にする。節の種類を増やさないため(§2.1)。
      return { kind: 'call', name: 'sqrt', args: [operand], position: token.position };
    }

    if (token.type === 'leftParenthesis') {
      const inner = parseAddExpr();
      const closing = peek();
      if (closing === null) {
        throw new ExpressionFailure(expressionError('unclosedParenthesis', '', token.position));
      }
      if (closing.type !== 'rightParenthesis') {
        throw new ExpressionFailure(
          expressionError('unexpectedToken', closing.text, closing.position),
        );
      }
      index += 1;
      return inner;
    }

    if (token.type === 'identifier') {
      const after = peek();
      if (after !== null && after.type === 'leftParenthesis') {
        index += 1;
        // 閉じ括弧が足りないときの位置は、関数名ではなく開き括弧を指す。括弧の式と
        // 関数呼び出しで同じ場所を指すよう統一する(docs/報告記録.md 2026-09-02 18:23 の判断③)。
        const args = parseArguments(after.position);
        return { kind: 'call', name: token.text, args, position: token.position };
      }
      if (CONSTANT_TOKEN_NAMES.has(token.text)) {
        return {
          kind: 'constant',
          name: token.text === 'e' ? 'e' : 'pi',
          position: token.position,
        };
      }
      return { kind: 'variable', name: token.text, position: token.position };
    }

    throw new ExpressionFailure(expressionError('unexpectedToken', token.text, token.position));
  }

  /** openPosition は引数列の開き括弧の位置。閉じ括弧が足りないときの報告に使う。 */
  function parseArguments(openPosition: number): readonly Node[] {
    const args: Node[] = [];
    const first = peek();
    if (first !== null && first.type === 'rightParenthesis') {
      index += 1;
      return args;
    }
    for (;;) {
      args.push(parseAddExpr());
      const token = peek();
      if (token === null) {
        throw new ExpressionFailure(expressionError('unclosedParenthesis', '', openPosition));
      }
      if (token.type === 'comma') {
        index += 1;
        continue;
      }
      if (token.type === 'rightParenthesis') {
        index += 1;
        return args;
      }
      throw new ExpressionFailure(expressionError('unexpectedToken', token.text, token.position));
    }
  }

  const node = parseAddExpr();
  const rest = peek();
  if (rest !== null) {
    throw new ExpressionFailure(expressionError('unexpectedTrailing', rest.text, rest.position));
  }
  return node;
}
