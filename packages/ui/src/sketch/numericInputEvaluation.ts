/** 入力欄の式・単位・許容範囲を評価する。道具の段階遷移や文書更新は担当しない。 */
import { type ExpressionError, type ExpressionValue } from '@pointercad/expression';
import type { LengthUnit } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { applyDisplayUnit, usesDisplayInputUnit } from './numericFieldUnits.js';
import { evaluateNumericMath, evaluatePendingExpression, pendingVariablesFor } from './numericMathValues.js';
import type { NumericField, NumericFieldRange, NumericInputState } from './numericInput.js';

export interface NumericFieldResult {
  readonly key: string;
  readonly value: ExpressionValue | null;
  readonly error: ExpressionError | null;
}

export interface NumericInputEvaluation {
  readonly carriedError?: ExpressionError;
  readonly results: readonly NumericFieldResult[];
  /** すべての欄が妥当なら true。false のときは決定させない(NFR-UX-5)。 */
  readonly canCommit: boolean;
  /** 最初にエラーになった欄。無ければ -1。 */
  readonly firstErrorIndex: number;
}

/** 範囲外を表す識別子(packages/expression の ExpressionErrorCode、P3 §0.a-0.23 ①)。 */
const RANGE_ERROR_CODE = 'outOfRange';

/**
 * 範囲外の理由文を組み立てる。
 * 限界値を差し込んだ文になるので ja.json のキー1つでは組み立てられない
 * (packages/expression/src/errors.ts が日本語を持っているのと同じ事情)。
 * 見出しの語だけは ja.json から引く(NFR-MA-5)。
 */
function describeRange(label: string, range: NumericFieldRange): string {
  const min = String(range.min);
  if (range.max === null) {
    const lower = range.minInclusive ? `${min} 以上の` : `${min} より大きい`;
    return `${label}は ${lower}値を入れてください。`;
  }
  const lower = range.minInclusive ? `${min} 以上` : `${min} より大きく`;
  const upper = `${String(range.max)} ${range.maxInclusive ? '以下' : '未満'}`;
  return `${label}は ${lower} ${upper}の値を入れてください。`;
}

/** 欄の範囲を確かめる。範囲内なら null(NFR-UX-5)。 */
export function rangeErrorFor(field: NumericField, value: ExpressionValue): ExpressionError | null {
  const { range } = field;
  if (range === undefined) {
    return null;
  }
  const belowMin = range.minInclusive ? value.value < range.min : value.value <= range.min;
  const aboveMax =
    range.max !== null && (range.maxInclusive ? value.value > range.max : value.value >= range.max);
  if (!belowMin && !aboveMax) {
    return null;
  }
  return {
    code: RANGE_ERROR_CODE,
    message: describeRange(t(field.labelKey), range),
    position: -1,
  };
}

/** 空欄は既定値として扱う。Enter を連打するだけで意味のある形になる(NFR-UX-4)。 */
export function effectiveSource(field: NumericField): string {
  return field.source.trim() === '' ? field.defaultSource : field.source;
}

/**
 * その欄を評価する式の文字列(P6 タスク3b、§0.a-0.63)。**保存されるのもこの文字列**で、
 * 評価した値ではない(FR-202)。
 *
 * 打った文字が残っている長さの欄だけを、表示の単位で包む(`applyDisplayUnit`)。
 * 空欄(= 既定値で埋まる)と、吸い付きで入った座標は**すでに内部の mm** なので包まない
 * (`NumericField.typed` の注釈を見よ)。表示が mm のときは何を通しても包まれないので、
 * P1〜P5 の振る舞いは 1 文字も変わらない。
 */
export function fieldExpression(field: NumericField, unit: LengthUnit = 'mm'): string {
  if (!usesDisplayInputUnit(field)) {
    return effectiveSource(field);
  }
  return applyDisplayUnit(field.source, field.unit, unit);
}

/**
 * 空欄を既定値の文字列で埋めた状態を返す(NFR-UX-4)。
 * 決定のときに一度だけ通し、利用者が実際に使われた値を目で確かめられるようにする。
 * 埋めるものが無ければ同じ状態をそのまま返す。
 */
export function fillDefaults(state: NumericInputState): NumericInputState {
  if (state.fields.every((field) => field.source === effectiveSource(field))) {
    return state;
  }
  return {
    ...state,
    // 埋めるのは既定値(内部の mm)なので、打った文字の印は落とす(タスク3b)。
    fields: state.fields.map((field) => ({
      ...field,
      source: effectiveSource(field),
      typed: field.source.trim() === '' ? false : field.typed,
    })),
  };
}

/**
 * 表示の単位に関わる選択肢(P6 タスク3b、§0.a-0.63)。
 *
 * どちらも省くと**表示が mm・パラメータはすべて長さ**になる。つまり P1〜P5 の呼び出しと
 * 検査は 1 文字も書き換えずに同じ値を返す(安全側の既定)。
 */
export interface DisplayUnitOptions {
  readonly pendingVariables?: ReadonlySet<string>;
  /** パラメータ間の精度を決定時まで保持する。 */
  readonly exactVariables?: ReadonlyMap<string, string>;
  /** 画面に出している長さの単位(`DisplaySettings.lengthUnit`)。省くと mm。 */
  readonly lengthUnit?: LengthUnit;
  /**
   * 長さでないパラメータの名前(model の `nonLengthVariables(document.parameters)`)。
   * 単位の空間の中で「個数や角度まで倍率で割る」のを防ぐ(§0.a-0.63)。
   */
  readonly nonLengthVariables?: ReadonlySet<string>;
}

/** すべての欄を評価する。1 文字打つごとに呼んでよい軽さにする。 */
export function evaluateNumericInput(
  state: NumericInputState,
  variables: ReadonlyMap<string, number> = new Map(),
  display: DisplayUnitOptions = {},
): NumericInputEvaluation {
  const results: NumericFieldResult[] = state.fields.map((field) => {
    const result = evaluateNumericField(field, variables, display);
    if (!result.ok) {
      return { key: field.key, value: null, error: result.error };
    }
    // 式としては読めても、その道具が使えない値は決定させない(NFR-UX-5)。
    // 個数(パターンの count)が整数かどうかはここでは確かめない。NumericFieldRange は
    // min/max しか表現できず、ここへ整数判定を足すと他の欄(距離等)へ影響しない設計を
    // 保つのが難しいため、整数かどうかの検査は加工コマンド側(タスク25
    // machiningCommands.ts)で行う判断とした(計画書タスク24 検証表の注記への回答)。
    const rangeError = rangeErrorFor(field, result.value);
    return rangeError === null
      ? { key: field.key, value: result.value, error: null }
      : { key: field.key, value: null, error: rangeError };
  });
  const firstErrorIndex = results.findIndex((result) => result.error !== null);
  for (const field of state.carriedStage1?.fields ?? []) {
    const result = evaluateNumericField(field, variables, display);
    const error = result.ok ? rangeErrorFor(field, result.value) : result.error;
    if (error !== null) {
      return { results, canCommit: false, firstErrorIndex: Math.max(0, firstErrorIndex),
        carriedError: { ...error, message: `前の入力「${t(field.labelKey)}」: ${error.message}` } };
    }
  }
  return { results, canCommit: firstErrorIndex === -1, firstErrorIndex };
}

/** Use the same validation for visible fields and values carried from a previous step. */
export function evaluateNumericField(field: NumericField, variables: ReadonlyMap<string, number>, display: DisplayUnitOptions) {
  if (field.mathValue !== undefined) {
    if (field.source !== field.mathValue.source) return { ok: false as const, error: { code: 'unknownVariable' as const,
      position: -1, message: '数式を変更したため再確認が必要です。「数式で入力」を開いてください。' } };
    return evaluateNumericMath(field.mathValue, variables, display.exactVariables, display.pendingVariables ?? pendingVariablesFor(variables));
  }
  return evaluatePendingExpression(fieldExpression(field, display.lengthUnit ?? 'mm'), {
    variables, nonLengthVariables: display.nonLengthVariables, exactVariables: display.exactVariables,
  }, display.pendingVariables ?? pendingVariablesFor(variables));
}

/** 評価できた値だけを順に取り出す。決定のときに使う。 */
export function commitValues(evaluation: NumericInputEvaluation): ExpressionValue[] | null {
  if (!evaluation.canCommit) {
    return null;
  }
  const values: ExpressionValue[] = [];
  for (const result of evaluation.results) {
    if (result.value === null) {
      return null;
    }
    values.push(result.value);
  }
  return values;
}

/**
 * 決定した値を欄の名前で引く(円弧の `radius` など)。
 * 並び順の取り違えを防ぐため、タスク17 が履歴へ積むときはこちらを使う。
 */
export function valueByFieldKey(
  state: NumericInputState,
  values: readonly ExpressionValue[],
  key: string,
): ExpressionValue | undefined {
  const index = state.fields.findIndex((field) => field.key === key);
  return index === -1 ? undefined : values[index];
}
