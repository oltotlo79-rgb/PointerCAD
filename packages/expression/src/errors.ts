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

type ExpressionHint =
  | { readonly key: 'explicitMultiplication'; readonly numberText: string; readonly name: string }
  | { readonly key: 'supportedFunctions'; readonly names: readonly string[] };

interface PositionText {
  readonly key: 'expression.error.position';
  readonly parameters: { readonly position: string };
}

interface ExpressionDiagnostic {
  readonly key: `expression.error.${Exclude<ExpressionErrorCode, 'outOfRange'>}` | 'assembly.error.internal';
  readonly parameters: Readonly<Record<string, string | PositionText>>;
}

export interface ExpressionError {
  readonly code: ExpressionErrorCode;
  /** 利用者へそのまま見せる理由。 */
  readonly message: string;
  readonly diagnostic?: ExpressionDiagnostic;
  /** 式の何文字目か(0 始まり)。定まらないときは -1。 */
  readonly position: number;
  readonly suggestions?: readonly string[];
  /** UI の文言を選ぶ鍵と、差し込む値。 */
  readonly hint?: ExpressionHint;
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
function attachExpressionDiagnostic(error: ExpressionError, diagnostic: ExpressionDiagnostic): ExpressionError {
  // 公開エラーの列挙・コピー・保存は従来の欄だけ。翻訳は診断を直接読む。
  Object.defineProperty(error, 'diagnostic', { value: diagnostic });
  return error;
}

/** 解析・評価中に、同じ失敗へ補助情報を追加して診断を保つ。 */
export function withExpressionErrorDetails(
  error: ExpressionError,
  details: Pick<ExpressionError, 'hint' | 'suggestions'>,
): ExpressionError {
  const enriched = { ...error, ...details };
  return error.diagnostic === undefined ? enriched : attachExpressionDiagnostic(enriched, error.diagnostic);
}

function diagnosedExpressionError(
  code: Exclude<ExpressionErrorCode, 'outOfRange'>,
  message: string,
  position: number,
  parameters: ExpressionDiagnostic['parameters'] = {},
): ExpressionError {
  return attachExpressionDiagnostic({ code, message, position }, { key: `expression.error.${code}`, parameters });
}

export function internalExpressionError(cause: unknown, report?: (cause: unknown) => void): ExpressionError {
  try {
    report?.(cause);
  } catch {
    // A diagnostics sink must not turn the calculation failure into an exception.
  }
  return attachExpressionDiagnostic({ ...expressionError('notFinite', '') },
    { key: 'assembly.error.internal', parameters: {} });
}

export function expressionError(
  code: ExpressionErrorCode,
  detail: string,
  position = -1,
): ExpressionError {
  const where = describePosition(position);
  const location: string | PositionText = position < 0 ? '' : {
    key: 'expression.error.position', parameters: { position: String(position + 1) },
  };
  switch (code) {
    case 'empty':
      return diagnosedExpressionError(code, '式が空です。', position);
    case 'tooLong':
      return diagnosedExpressionError(code, `式が長すぎます(${String(EXPRESSION_MAX_LENGTH)} 文字まで)。`,
        position, { limit: String(EXPRESSION_MAX_LENGTH) });
    case 'unexpectedCharacter':
      return diagnosedExpressionError(code, `使えない文字があります: 「${detail}」${where}`, position, { detail, location });
    case 'unexpectedToken':
      return diagnosedExpressionError(code, `ここには数値か ( が必要です: 「${detail}」${where}`, position, { detail, location });
    case 'unexpectedEnd':
      return diagnosedExpressionError(code, '式が途中で終わっています。', position);
    case 'unclosedParenthesis':
      return diagnosedExpressionError(code, '閉じ括弧 ) が足りません。', position);
    case 'unexpectedTrailing':
      return diagnosedExpressionError(code, `式の後ろに余分なものがあります: 「${detail}」${where}`, position, { detail, location });
    case 'unknownFunction':
      return diagnosedExpressionError(code, `知らない関数です: 「${detail}」${where}`, position, { detail, location });
    case 'wrongArgumentCount':
      // 文言は wrongArgumentCountError が組み立てて detail へ渡す。
      return { code, message: detail, position };
    case 'unknownVariable':
      return diagnosedExpressionError(code, `決まっていない名前です: 「${detail}」${where}`, position, { detail, location });
    case 'divisionByZero':
      return diagnosedExpressionError(code, '0 で割ることはできません。', position);
    case 'negativeRoot':
      return diagnosedExpressionError(code, `負の数の平方根は求められません: ${detail}`, position, { detail });
    case 'rootDegreeZero':
      return diagnosedExpressionError(code, '乗根の n に 0 は指定できません。', position);
    case 'exponentTooLarge':
      return diagnosedExpressionError(code, `累乗の指数が大きすぎます(±${String(EXPRESSION_MAX_EXPONENT)} まで)。`,
        position, { limit: String(EXPRESSION_MAX_EXPONENT) });
    case 'notFinite':
      return diagnosedExpressionError(code, '計算結果が数として表せません。', position);
    case 'unitMismatch':
      return diagnosedExpressionError(code, `単位をそろえてください。${where}`, position, { location });
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
  return diagnosedExpressionError('wrongArgumentCount', message, position,
    { name, expected: String(expected), actual: String(actual) });
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
