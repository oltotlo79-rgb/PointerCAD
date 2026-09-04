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

/**
 * 識別子として使える追加のコードポイント範囲(日本語の変数名。§0.16、記法バージョン2)。
 * 範囲はコードポイントのエスケープで書く。文字そのものを書くと、この行を写した先の
 * コメント等で no-irregular-whitespace に触れ、見た目では原因が分からなくなる
 * (docs/報告記録.md 2026-09-02 15:09 の教訓)。
 * 全角英数・全角記号は含めない(normalizeExpressionSource がここへ来る前に半角へ直すため。
 * 含めると演算子や数字が名前の一部になってしまう)。
 * 基本多言語面(BMP)の範囲だけを扱う。サロゲートペアを使う拡張漢字(U+20000 以降)は対象外
 * (このファイルの走査は1 UTF-16単位ずつであり、コードポイント単位に全面的に書き直す
 * ほどの範囲ではないと判断した。docs/plans/P4b-スケッチの仕上げ.md タスク1の落とし穴)。
 */
const IDENTIFIER_RANGES: readonly (readonly [number, number])[] = [
  [0x3041, 0x309f], // ひらがな
  [0x30a0, 0x30ff], // カタカナ(長音符 U+30FC を含む)
  [0x4e00, 0x9fff], // CJK統合漢字
];

function isIdentifierRangeCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  return IDENTIFIER_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** `checkVariableName`(variableNames.ts)からも使う。数字1文字かどうかの判定。 */
export function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

/** `checkVariableName`(variableNames.ts)からも使う。識別子の先頭に来てよい1文字かどうか。 */
export function isIdentifierStart(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    character === '_' ||
    character === 'π' ||
    isIdentifierRangeCharacter(character)
  );
}

/** `checkVariableName`(variableNames.ts)からも使う。識別子の2文字目以降に来てよい1文字かどうか。 */
export function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character);
}

/**
 * 添字の位置にある1文字を、コードポイント単位で取り出す。絵文字のように UTF-16 で
 * 2 単位を占める文字を半分に切らないため(docs/報告記録.md 2026-09-02 18:10 の残件)。
 * 切れた片割れを文言へ入れると「使えない文字があります: 「□」」のように読めない字が出る。
 * 範囲外では空文字を返し、どの判定にも当たらない。
 */
function characterAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint);
}

/**
 * 式を字句へ分ける。分けられない文字があれば ExpressionFailure を投げる。
 * 数字・名前の続きの判定は 1 単位ずつで足りる(該当する文字はすべて UTF-16 で 1 単位)ので
 * charAt を使い、字句の先頭の1文字だけ characterAt でコードポイント単位に取る。
 * 位置は UTF-16 の添字のままとする。式の入力欄(タスク18)がカーソル位置を
 * `HTMLInputElement.selectionStart` で扱い、これも UTF-16 の添字であるため。
 */
export function tokenize(source: string): readonly Token[] {
  if (source.length > EXPRESSION_MAX_LENGTH) {
    throw new ExpressionFailure(expressionError('tooLong', ''));
  }

  const text = normalizeExpressionSource(source);
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const character = characterAt(text, index);

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
