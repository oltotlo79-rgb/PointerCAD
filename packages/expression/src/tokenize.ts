import { EXPRESSION_MAX_LENGTH, expressionError, ExpressionFailure } from './errors.js';

export type TokenType =
  | 'number'
  | 'identifier'
  | 'operator'
  | 'leftParenthesis'
  | 'rightParenthesis'
  | 'comma';

export interface Token {
  readonly type: TokenType;
  /** 正規化した後の文字列。number なら "3.5"、operator なら "+"。 */
  readonly text: string;
  /** 式の中での開始位置(0 始まり)。 */
  readonly position: number;
}

/**
 * 全角の数字・記号を半角へ直す表(§2.3)。日本語入力のまま打っても通るようにする(NFR-UX-5)。
 * すべて 1 文字を 1 文字へ置き換えるので、位置は元の式とずれない。
 * 全角空白は U+3000 のエスケープで書く。文字そのものを書くと、この行を写した先の
 * コメントなどで no-irregular-whitespace に触れ、見た目では原因が分からなくなる
 * (docs/報告記録.md 2026-09-02 15:09 の教訓)。
 */
const NORMALIZE_MAP: ReadonlyMap<string, string> = new Map([
  ['０', '0'], ['１', '1'], ['２', '2'], ['３', '3'], ['４', '4'],
  ['５', '5'], ['６', '6'], ['７', '7'], ['８', '8'], ['９', '9'],
  ['．', '.'], ['，', ','],
  ['＋', '+'], ['－', '-'], ['−', '-'],
  ['×', '*'], ['＊', '*'], ['÷', '/'], ['／', '/'],
  ['（', '('], ['）', ')'], ['＾', '^'],
  ['\u3000', ' '],
]);

/** 全角を半角へ直す。文字数は変わらない。 */
export function normalizeExpressionSource(source: string): string {
  let normalized = '';
  for (const character of source) {
    normalized += NORMALIZE_MAP.get(character) ?? character;
  }
  return normalized;
}

const OPERATOR_CHARACTERS: ReadonlySet<string> = new Set(['+', '-', '*', '/', '^', '√']);
const SPACE_CHARACTERS: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r']);

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '_' ||
    character === 'π'
  );
}

function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character);
}

/**
 * 式を字句へ分ける。分けられない文字があれば ExpressionFailure を投げる。
 * 範囲外の添字で undefined を扱わずに済むよう、文字の取り出しは charAt を使う
 * (範囲外では空文字を返し、どの判定にも当たらない)。
 */
export function tokenize(source: string): readonly Token[] {
  if (source.length > EXPRESSION_MAX_LENGTH) {
    throw new ExpressionFailure(expressionError('tooLong', ''));
  }

  const text = normalizeExpressionSource(source);
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);

    if (SPACE_CHARACTERS.has(character)) {
      index += 1;
      continue;
    }

    if (isDigit(character) || (character === '.' && isDigit(text.charAt(index + 1)))) {
      const start = index;
      while (isDigit(text.charAt(index))) {
        index += 1;
      }
      if (text.charAt(index) === '.') {
        index += 1;
        while (isDigit(text.charAt(index))) {
          index += 1;
        }
      }
      tokens.push({ type: 'number', text: text.slice(start, index), position: start });
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      while (isIdentifierPart(text.charAt(index))) {
        index += 1;
      }
      tokens.push({ type: 'identifier', text: text.slice(start, index), position: start });
      continue;
    }

    if (OPERATOR_CHARACTERS.has(character)) {
      tokens.push({ type: 'operator', text: character, position: index });
      index += 1;
      continue;
    }

    if (character === '(') {
      tokens.push({ type: 'leftParenthesis', text: character, position: index });
      index += 1;
      continue;
    }

    if (character === ')') {
      tokens.push({ type: 'rightParenthesis', text: character, position: index });
      index += 1;
      continue;
    }

    if (character === ',') {
      tokens.push({ type: 'comma', text: character, position: index });
      index += 1;
      continue;
    }

    throw new ExpressionFailure(expressionError('unexpectedCharacter', character, index));
  }

  if (tokens.length === 0) {
    throw new ExpressionFailure(expressionError('empty', ''));
  }
  return tokens;
}
