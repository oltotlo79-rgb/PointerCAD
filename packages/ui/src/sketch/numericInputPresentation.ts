/** 表示用の札と値の整形。入力の遷移・確定や文書の更新を持たない。 */
import { DEFAULT_INCH_DENOMINATOR, isSamePoint, toDisplayLength, toFractionalInch, type LengthUnit } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { isLengthFieldUnit, type FieldUnit } from './numericFieldUnits.js';
import type { CoordinateMode } from './numericInputTools.js';

/** 座標モードのタブの並び。Alt+1 / Alt+2 / Alt+3 の順でもある。 */
export const COORDINATE_MODES: readonly CoordinateMode[] = ['absolute', 'relative', 'polar'];

/** タブの見出し。 */
export const MODE_LABEL_KEYS: Readonly<Record<CoordinateMode, MessageKey>> = {
  absolute: 'numericInput.mode.absolute',
  relative: 'numericInput.mode.relative',
  polar: 'numericInput.mode.polar',
};

/** タブのホバー説明(FR-904、NFR-UX-7)。 */
export const MODE_TOOLTIP_KEYS: Readonly<Record<CoordinateMode, MessageKey>> = {
  absolute: 'numericInput.mode.absoluteTooltip',
  relative: 'numericInput.mode.relativeTooltip',
  polar: 'numericInput.mode.polarTooltip',
};

/** 欄の中に置く単位札(NFR-RE-3)。 */
export const UNIT_KEYS: Readonly<Record<FieldUnit, MessageKey>> = {
  mm: 'numericInput.unit.mm',
  degree: 'numericInput.unit.degree',
  count: 'numericInput.unit.count',
  ratio: 'numericInput.unit.ratio',
  N: 'strength.unit.N',
  MPa: 'strength.unit.MPa',
  Nmm: 'strength.unit.Nmm',
};

/**
 * 表示が inch のときに長さの欄へ出す札(FR-811)。
 * 測定の帯と同じ文言(`measure.unit.inch` = `in`)を引く——同じ語を 2 か所に書かない。
 */
const INCH_FIELD_UNIT_KEY: MessageKey = 'measure.unit.inch';

/**
 * 欄の単位札のキー。**長さの欄だけ**が表示の単位で変わり、角度・個数は
 * `UNIT_KEYS` のまま(FR-205)。`unit` を省くと mm なので、従来の呼び出しは変わらない。
 */
export function fieldUnitLabelKey(unit: FieldUnit, lengthUnit: LengthUnit = 'mm'): MessageKey {
  return isLengthFieldUnit(unit) && lengthUnit === 'inch' ? INCH_FIELD_UNIT_KEY : UNIT_KEYS[unit];
}

/**
 * 欄の下へ添える値の桁数(有効数字)。
 *
 * 利用者の決定「解の表示は 9 桁で丸める」と同じ桁にする。
 * mm を inch へ割ると `10 / 25.4 = 0.3937007874015748` のように末尾が伸びるので、
 * **表示だけ**をここで丸める。**保存する式には 1 文字も書き戻さない**(丸めた値を式へ
 * 入れると、単位を切り替えるたびに文書が変わってしまう)。
 */
export const FIELD_VALUE_DISPLAY_DIGITS = 9;

/**
 * 数値 1 つを有効数字 `digits` 桁へ丸める(末尾の 0 は落ちる。`String()` の癖どおり)。
 * `0` と有限でない値はそのまま返す(`log10(0)` が `-Infinity` になるのを避ける)。
 *
 * `shell/PropertyPanel.tsx` にあった同名の関数をここへ移した。
 * **丸め方を 2 通り持たない**ため、あちらはこれを輸入して使う。
 */
export function roundToSignificantDigits(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) {
    return value;
  }
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, digits - 1 - magnitude);
  return Math.round(value * factor) / factor;
}

/**
 * 画面に出す数の有効桁数(利用者の決定 2026-11-14「数値は有効 6 桁で表示し、全部の桁はマウスを載せた時の
 * 説明に出す」)。**表示だけ**に使い、計算の中の値・保存する値・欄の中の式は変えない。
 */
const DISPLAY_SIGNIFICANT_DIGITS = 6;

/** 画面に出す数 1 つ。`text` は画面の文字、`full` はマウスを載せた時の説明へ出す全部の桁。 */
interface DisplayNumber {
  readonly text: string;
  readonly full: string;
}

/**
 * 数の表示の整形(プロパティ・結果の表示が呼ぶ 1 か所。UI の点検の指摘 26・48)。
 * 製品の長さの許容差(`SKETCH_TOLERANCE_MM`)以内の値は `0`(計算の端数の 9e-16 などを出さない)、
 * ほかは有効 6 桁へ丸める(末尾の 0 は落ちる。-0 は 0)。有限でない値はそのまま出す。
 * 許容差で 0 とみなす判定は新しく書かず、model の点の一致の判定(`isSamePoint`。既定の許容差が
 * `SKETCH_TOLERANCE_MM`)で原点と一致するかを見る(許容差の比較を 1 か所に保つ。toleranceBaseline)。
 */
export function displayNumber(value: number): DisplayNumber {
  const full = String(value);
  if (!Number.isFinite(value)) {
    return { text: full, full };
  }
  if (isSamePoint([value, 0, 0], [0, 0, 0])) {
    return { text: '0', full };
  }
  return { text: String(Number(value.toPrecision(DISPLAY_SIGNIFICANT_DIGITS))), full };
}

/** 1/64 インチの刻みに「ちょうど」乗っているとみなす、刻みの数の誤差(浮動小数の丸めの分だけ)。 */
const FRACTIONAL_INCH_STEP_TOLERANCE = 1e-6;

/**
 * 1/64 インチの刻みで**ちょうど**表せる長さ(内部 mm)だけ、分数インチの表記を返す(FR-814)。
 *
 * 刻みへ丸めた分数を出すと元と違う長さを示してしまう(`10`mm は `25/64"` = 9.921875mm)ので、
 * 割り切れない長さには出さない(null)。整数のインチ(`1"`)も小数の `1 in` と同じなので出さない。
 */
export function exactFractionalInchText(millimeters: number): string | null {
  const steps = toDisplayLength(millimeters, 'inch') * DEFAULT_INCH_DENOMINATOR;
  if (!Number.isFinite(steps)) return null;
  const rounded = Math.round(steps);
  if (Math.abs(steps - rounded) > FRACTIONAL_INCH_STEP_TOLERANCE || rounded % DEFAULT_INCH_DENOMINATOR === 0) return null;
  return toFractionalInch(millimeters);
}

/**
 * 欄の下へ添える「= 値」の右辺。
 *
 * 長さの欄で表示が inch のときだけ、**評価した値だけ**を inch へ直して単位を添える
 * (例: 内部 `10`mm → `0.393700787 in`)。式そのものは書き換えない(FR-202)。
 * 1/64 インチでちょうど表せる長さには分数インチも添える(`9.525`mm → `0.375 in (3/8")`。FR-814)。
 * それ以外(mm・角度・個数)は式エンジンの表示文字列をそのまま出す(従来の見え方)。
 */
export function fieldValueText(
  unit: FieldUnit,
  /* `ExpressionValue` をそのまま渡せる形。パラメータ表のように式を持たない値も渡せる。 */
  value: { readonly value: number; readonly display: string },
  lengthUnit: LengthUnit = 'mm',
): string {
  const text = fieldValueNumberText(unit, value, lengthUnit);
  if (!isLengthFieldUnit(unit) || lengthUnit !== 'inch') return text;
  const fraction = exactFractionalInchText(value.value);
  return fraction === null ? `${text} ${t(INCH_FIELD_UNIT_KEY)}` : `${text} ${t(INCH_FIELD_UNIT_KEY)} (${fraction})`;
}

/**
 * 同じ値の**数だけ**(単位の札を添えない)。単位を別の場所へ出す欄——読み取り専用の
 * 欄(derived)のように、札が横に並んでいる場所で使う。
 */
export function fieldValueNumberText(
  unit: FieldUnit,
  value: { readonly value: number; readonly display: string },
  lengthUnit: LengthUnit = 'mm',
): string {
  if (!isLengthFieldUnit(unit) || lengthUnit !== 'inch') {
    return value.display;
  }
  return String(
    roundToSignificantDigits(toDisplayLength(value.value, 'inch'), FIELD_VALUE_DISPLAY_DIGITS),
  );
}

/** ポップアップ共通の文字列キー。文言そのものは持たない(NFR-MA-5)。 */
export const NUMERIC_INPUT_KEYS: Readonly<
  Record<'commit' | 'commitTooltip' | 'cancel' | 'cancelTooltip', MessageKey>
> = {
  commit: 'numericInput.commit',
  commitTooltip: 'numericInput.commitTooltip',
  cancel: 'numericInput.cancel',
  cancelTooltip: 'numericInput.cancelTooltip',
};
