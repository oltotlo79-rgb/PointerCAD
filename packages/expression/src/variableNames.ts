/**
 * 式が参照する変数名の一覧・書き換え・妥当性判定(要件 FR-207・FR-201・FR-204、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md タスク1)。
 *
 * パラメータ表(FR-207)が「この式はどの変数を参照しているか」「この名前を書き換えたら
 * 式はどう変わるか」「この名前はパラメータ名として使えるか」を扱うための土台。
 * このパッケージの外へは index.ts から輸出する。
 */

import type { Node } from './ast.js';
import { FUNCTION_ARITY } from './evaluate.js';
import { CONSTANT_TOKEN_NAMES, parse } from './parse.js';
import { isDigit, isIdentifierPart, isIdentifierStart, tokenize, type Token } from './tokenize.js';

/**
 * パラメータ名として使えない予約語(関数名+定数名)。
 * `evaluate.ts` の `FUNCTION_ARITY` と `parse.ts` の `CONSTANT_TOKEN_NAMES` から作り、
 * 名前の集合をここへ書き直さない(2か所に書かない。タスク1の実装内容)。
 */
const RESERVED_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  ...FUNCTION_ARITY.keys(),
  ...CONSTANT_TOKEN_NAMES,
]);

/** 構文木を辿り、`variable` ノードの名前を最初に出た順に集める(補助関数)。 */
function collectFromNode(node: Node, names: string[], seen: Set<string>): void {
  switch (node.kind) {
    case 'variable':
      if (!seen.has(node.name)) {
        seen.add(node.name);
        names.push(node.name);
      }
      return;
    case 'unary':
      collectFromNode(node.operand, names, seen);
      return;
    case 'binary':
      collectFromNode(node.left, names, seen);
      collectFromNode(node.right, names, seen);
      return;
    case 'call':
      for (const argument of node.args) {
        collectFromNode(argument, names, seen);
      }
      return;
    case 'number':
    case 'constant':
      return;
  }
}

/**
 * 式が参照する変数の名前(定数 `pi` / `π` / `e` と関数名は含まない)。並び順は最初に出た順。
 * 読めない式(構文エラー)は例外を投げず、空の配列を返す。
 */
export function collectVariableNames(source: string): readonly string[] {
  let node: Node;
  try {
    node = parse(source);
  } catch {
    return [];
  }
  const names: string[] = [];
  collectFromNode(node, names, new Set());
  return names;
}

/**
 * 式の中の変数 `from` を `to` へ書き換える。字句(トークン)単位で判定するので、
 * `板厚さ` の中の `板厚` のような部分一致では置き換わらない。
 *
 * 対象にするのは `identifier` の字句のうち、直後が `(` でないもの(関数呼び出しの名前で
 * ない)かつ `pi` / `π` / `e`(定数)でないものだけ。`Token.position` は
 * `normalizeExpressionSource` が全角→半角を1文字ずつ変換する(文字数を変えない)ため
 * 元の `source` の添字と一致し、後ろの字句から順に差し替えれば先に処理した位置がずれない。
 * 読めない式(構文エラー)は例外を投げず、元の文字列をそのまま返す。
 */
export function renameVariable(source: string, from: string, to: string): string {
  let tokens: readonly Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return source;
  }
  let result = source;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.type !== 'identifier' || token.text !== from) {
      continue;
    }
    if (CONSTANT_TOKEN_NAMES.has(token.text)) {
      continue;
    }
    const next = tokens[index + 1];
    if (next !== undefined && next.type === 'leftParenthesis') {
      continue;
    }
    result =
      result.slice(0, token.position) + to + result.slice(token.position + token.text.length);
  }
  return result;
}

/**
 * その式が「数値リテラル1つ」か(拘束の変数にしてよいか。P4b §0.2)。
 * 構文木が `number` 1つ、または前置の `+` / `-` の中身が `number` 1つのときだけ true。
 * `10 + 0` のような式は false(式なので定数扱い。FR-202「式は文字列のまま保存」と両立させるため)。
 * 読めない式(構文エラー)は false。
 */
export function isNumericLiteral(source: string): boolean {
  let node: Node;
  try {
    node = parse(source);
  } catch {
    return false;
  }
  if (node.kind === 'number') {
    return true;
  }
  return node.kind === 'unary' && node.operand.kind === 'number';
}

/** パラメータ名として使えない理由。使える名前なら `checkVariableName` は null を返す。 */
export type VariableNameIssue = 'empty' | 'startsWithDigit' | 'reserved' | 'invalidCharacter';

/**
 * パラメータの名前として使えるか(§2.6の5つの規則)。使えない理由をコードで返し、
 * 使えるなら null を返す。
 *
 * 判定は `tokenize.ts` の識別子の判定(`isIdentifierStart` / `isIdentifierPart`)と
 * 完全に揃える(ここだけ別の文字集合で判定すると、パラメータ表では通ったのに式としては
 * 読めない名前が作れてしまう)。
 */
export function checkVariableName(name: string): VariableNameIssue | null {
  const characters = Array.from(name);
  if (characters.length === 0) {
    return 'empty';
  }
  const first = characters[0];
  if (isDigit(first)) {
    return 'startsWithDigit';
  }
  if (!isIdentifierStart(first)) {
    return 'invalidCharacter';
  }
  for (const character of characters.slice(1)) {
    if (!isIdentifierPart(character)) {
      return 'invalidCharacter';
    }
  }
  if (RESERVED_VARIABLE_NAMES.has(name)) {
    return 'reserved';
  }
  return null;
}
