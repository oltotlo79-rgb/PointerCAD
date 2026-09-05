/**
 * 式のエラー(FR-204)。code は機械が分岐するための識別子、message は利用者へ
 * そのまま見せる日本語の文言。文言は計画書 docs/plans/P1-式とスケッチ.md §2.5 の表に対応する。
 *
 * ja.json へ移さないのは、位置や名前を差し込んだ文になるためキーだけでは組み立てられず、
 * このパッケージが @pointercad/ui に依存できない(rules/04-設計の規律.md の依存方向)ため。
 */
export type ExpressionErrorCode =
  | 'empty'
  | 'tooLong'
  | 'unexpectedCharacter'
  | 'unexpectedToken'
  | 'unexpectedEnd'
  | 'unclosedParenthesis'
  | 'unexpectedTrailing'
  | 'unknownFunction'
  | 'wrongArgumentCount'
  | 'unknownVariable'
  | 'divisionByZero'
  | 'negativeRoot'
  | 'rootDegreeZero'
  | 'exponentTooLarge'
  | 'notFinite'
  /**
   * 長さの単位の付け方が合っていない(§2.9.1)。`1in + 2`(片方だけ単位)、`1in * 2in`
   * (面積になる)、`1in^2`、`(1.5in*2)in`(単位の入れ子)が当たる。
   * 既存の code で代用しなかったのは、これらがどれも「構文としては読めているが単位が
   * そろっていない」ものであり、`unexpectedToken`(読めない)とも `notFinite`(計算不能)とも
   * 原因が違うため。利用者へ「単位をそろえてください。」と伝える必要がある(NFR-UX-5)。
   */
  | 'unitMismatch'
  /**
   * 値は数として正しいが、その欄が受け付ける範囲の外(NFR-UX-5)。
   * 限界値を差し込んだ文になるため、message はこのパッケージの外(呼び出し側)が組み立て、
   * detail としてそのまま渡す(wrongArgumentCount と同じ形、P3 §0.a-0.23 ①)。
   */
  | 'outOfRange';

export interface ExpressionError {
  readonly code: ExpressionErrorCode;
  /** 利用者へそのまま見せる理由。 */
  readonly message: string;
  /** 式の何文字目か(0 始まり)。定まらないときは -1。 */
  readonly position: number;
}

/** 式の長さの上限。貼り付け事故で解析が止まらないようにする(§2.4)。 */
export const EXPRESSION_MAX_LENGTH = 1000;
/** 累乗の指数の上限。9^9^9 のような式で任意精度の計算が長時間止まるのを防ぐ(§2.4)。 */
export const EXPRESSION_MAX_EXPONENT = 1000;

/** 位置を「(N 文字目)」の形にする。1 始まりで示す。位置が無ければ空文字。 */
export function describePosition(position: number): string {
  return position < 0 ? '' : `(${String(position + 1)} 文字目)`;
}

/**
 * エラーを1つ作る。detail は文言へ差し込む語(文字・名前など)。要らない code では空文字を渡す。
 * wrongArgumentCount だけは語が2つ要るので wrongArgumentCountError を使う。
 */
export function expressionError(
  code: ExpressionErrorCode,
  detail: string,
  position = -1,
): ExpressionError {
  const where = describePosition(position);
  switch (code) {
    case 'empty':
      return { code, message: '式が空です。', position };
    case 'tooLong':
      return {
        code,
        message: `式が長すぎます(${String(EXPRESSION_MAX_LENGTH)} 文字まで)。`,
        position,
      };
    case 'unexpectedCharacter':
      return { code, message: `使えない文字があります: 「${detail}」${where}`, position };
    case 'unexpectedToken':
      return { code, message: `ここには数値か ( が必要です: 「${detail}」${where}`, position };
    case 'unexpectedEnd':
      return { code, message: '式が途中で終わっています。', position };
    case 'unclosedParenthesis':
      return { code, message: '閉じ括弧 ) が足りません。', position };
    case 'unexpectedTrailing':
      return { code, message: `式の後ろに余分なものがあります: 「${detail}」${where}`, position };
    case 'unknownFunction':
      return { code, message: `知らない関数です: 「${detail}」${where}`, position };
    case 'wrongArgumentCount':
      // 文言は wrongArgumentCountError が組み立てて detail へ渡す。
      return { code, message: detail, position };
    case 'unknownVariable':
      return { code, message: `決まっていない名前です: 「${detail}」${where}`, position };
    case 'divisionByZero':
      return { code, message: '0 で割ることはできません。', position };
    case 'negativeRoot':
      return { code, message: `負の数の平方根は求められません: ${detail}`, position };
    case 'rootDegreeZero':
      return { code, message: '乗根の n に 0 は指定できません。', position };
    case 'exponentTooLarge':
      return {
        code,
        message: `累乗の指数が大きすぎます(±${String(EXPRESSION_MAX_EXPONENT)} まで)。`,
        position,
      };
    case 'notFinite':
      return { code, message: '計算結果が数として表せません。', position };
    case 'unitMismatch':
      return { code, message: `単位をそろえてください。${where}`, position };
    case 'outOfRange':
      // 文言は呼び出し側(packages/ui)が組み立てて detail へ渡す(wrongArgumentCount と同じ形)。
      return { code, message: detail, position };
  }
}

export function wrongArgumentCountError(
  name: string,
  expected: number,
  actual: number,
  position: number,
): ExpressionError {
  const message = `関数 ${name} には引数が ${String(expected)} 個必要です(${String(actual)} 個でした)。`;
  return expressionError('wrongArgumentCount', message, position);
}

/**
 * 解析・評価を途中で打ち切るための例外。公開 API(evaluateExpression)が受け止めて
 * ExpressionResult へ直すので、このパッケージの外へは出さない。
 */
export class ExpressionFailure extends Error {
  readonly detail: ExpressionError;

  constructor(detail: ExpressionError) {
    super(detail.message);
    this.name = 'ExpressionFailure';
    this.detail = detail;
  }
}
