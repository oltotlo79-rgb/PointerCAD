import { expressionError, ExpressionFailure, type ExpressionError } from './errors.js';
import { evaluateNode, ExpressionDecimal } from './evaluate.js';
import { parse } from './parse.js';

/** 表示用に丸める有効数字の桁数(計画書 docs/plans/P1-式とスケッチ.md §2.4)。値そのものには使わない。 */
export const DISPLAY_SIGNIFICANT_DIGITS = 12;

/**
 * 式文字列と評価値のペア。これが .pcad に保存される最小単位(要件§8、FR-202)。
 * 評価結果だけを保存せず、必ず source も一緒に持つ。
 */
export interface ExpressionValue {
  /** 利用者が入力した式そのもの。編集時にこれを再表示する。 */
  readonly source: string;
  /** 評価値。長さ欄は mm、角度欄は度、個数欄は整数。丸めはここで1回だけ(NFR-RE-4)。 */
  readonly value: number;
  /** 表示用に有効数字 12 桁へ丸めた文字列。値には使わない。 */
  readonly display: string;
}

export type ExpressionResult =
  | { readonly ok: true; readonly value: ExpressionValue }
  | { readonly ok: false; readonly error: ExpressionError };

export interface EvaluateOptions {
  /** 変数表(FR-206)。P1 の UI は渡さない(= 空として扱う)。 */
  readonly variables?: ReadonlyMap<string, number>;
  /**
   * 長さでないパラメータの名前(角度・無次元。§0.a-0.63)。
   * 単位つきの式(`(w+10)in`)の中では、長さのパラメータだけを単位の倍率で割る。
   * 渡さなければ**すべてを長さとして扱う**(単位を書かない式の値は変わらない)。
   */
  readonly nonLengthVariables?: ReadonlySet<string>;
}

/**
 * 変数表を渡されなかったときに使う空の表。呼び出しごとに Map を作らないよう1つだけ持つ。
 * 値は double のまま `evaluateNode` へ渡す(§0.a-0.6。Decimal へ詰め替えない)。
 */
const NO_VARIABLES: ReadonlyMap<string, number> = new Map<string, number>();

/**
 * 式を評価する。例外を投げず、成功か理由つきの失敗かを返す(FR-204、NFR-UX-5)。
 * 入力欄は1文字打つごとにこれを呼び、失敗ならその場で赤く出す。
 */
export function evaluateExpression(
  source: string,
  options: EvaluateOptions = {},
): ExpressionResult {
  try {
    const node = parse(source);
    const result = evaluateNode(node, options.variables ?? NO_VARIABLES, {
      nonLengthVariables: options.nonLengthVariables,
    });
    if (!result.isFinite()) {
      // 変数表から無限大を渡された場合など、評価の途中では弾かれない経路がある。
      return { ok: false, error: expressionError('notFinite', '') };
    }
    return {
      ok: true,
      value: {
        source,
        // 丸めはここ1回だけ。double へ落とすのが最終段(NFR-RE-4、FR-203)。
        value: result.toNumber(),
        display: result.toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS).toString(),
      },
    };
  } catch (error) {
    if (error instanceof ExpressionFailure) {
      return { ok: false, error: error.detail };
    }
    // 想定していない例外(decimal.js の内部エラー等)も外へ出さない。1文字打つごとに
    // 呼ばれる入力欄が例外で壊れるより、理由つきの失敗として赤で出すほうが安全(NFR-RE-1)。
    return { ok: false, error: expressionError('notFinite', '') };
  }
}

/**
 * 数値から ExpressionValue を作る。欄の既定値(NFR-UX-4)や、ビューポートを
 * クリックして入った座標(FR-107)に使う。
 * source を評価すると必ず value になるよう、丸めた値を source にも使う。
 */
export function expressionValueFromNumber(value: number): ExpressionValue {
  const rounded = new ExpressionDecimal(value).toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS);
  // toString() は 1e-9 より小さい値などを指数表記にするが、この式の文法(§2.1)に
  // 指数表記は無いので、そのままでは source を読み戻せない。固定小数点の書き方に揃える。
  const text = rounded.toFixed();
  return { source: text, value: rounded.toNumber(), display: text };
}

/**
 * 数値から ExpressionValue を作る(**丸めない**版、FR-331)。
 *
 * `expressionValueFromNumber` は source を短く読みやすくするため有効数字 12 桁へ丸めるので、
 * 1/3 や √150 のような値は別の数になってしまう。立体の頂点を原点にするとき(式を持たない点を
 * シフト量にするとき)はそれでは模型がずれるため、**倍精度を過不足なく表す最短の 10 進表記**
 * を source にする。読み直すと必ず同じ倍精度に戻る(`String(value)` の往復可能性)。
 *
 * 指数表記(1e-7 など)はこの式の文法に無いので、普通の 10 進へ展開する。
 */
export function exactExpressionValueFromNumber(value: number): ExpressionValue {
  if (!Number.isFinite(value)) {
    // 数でない値は式として書けない。既定の作り方(NaN の表示)へ委ねる。
    return expressionValueFromNumber(value);
  }
  const source = plainDecimalText(value);
  return {
    source,
    // 丸めずそのままの倍精度を持つ。source を評価すると必ずこの値に戻る。
    value,
    display: new ExpressionDecimal(value).toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS).toString(),
  };
}

/** 倍精度の最短表記を、指数表記を使わない 10 進の文字列にする。 */
function plainDecimalText(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (match === null) {
    return text;
  }
  const sign = match[1];
  const digits = match[2] + (match[3] ?? '');
  // 小数点の位置。整数部の桁数に指数を足したもの。
  const pointIndex = match[2].length + Number(match[4]);
  if (pointIndex <= 0) {
    return `${sign}0.${'0'.repeat(-pointIndex)}${digits}`;
  }
  if (pointIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(pointIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}
