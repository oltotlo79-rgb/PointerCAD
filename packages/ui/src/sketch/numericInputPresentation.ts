/** 表示用の札と値の整形。入力の遷移・確定や文書の更新を持たない。 */
import { toDisplayLength, type LengthUnit } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { isLengthFieldUnit, type FieldUnit } from './numericFieldUnits.js';
import type { CoordinateMode } from './numericInputTools.js';

/** 座標モードのタブの並び(§2.9)。Alt+1 / Alt+2 / Alt+3 の順でもある。 */
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
 * 表示が inch のときに長さの欄へ出す札(P6 タスク3b、FR-811)。
 * 測定の帯と同じ文言(`measure.unit.inch` = `in`)を引く——同じ語を 2 か所に書かない。
 */
const INCH_FIELD_UNIT_KEY: MessageKey = 'measure.unit.inch';

/**
 * 欄の単位札のキー(P6 タスク3b)。**長さの欄だけ**が表示の単位で変わり、角度・個数は
 * `UNIT_KEYS` のまま(FR-205)。`unit` を省くと mm なので、P1〜P5 の呼び出しは変わらない。
 */
export function fieldUnitLabelKey(unit: FieldUnit, lengthUnit: LengthUnit = 'mm'): MessageKey {
  return isLengthFieldUnit(unit) && lengthUnit === 'inch' ? INCH_FIELD_UNIT_KEY : UNIT_KEYS[unit];
}

/**
 * 欄の下へ添える値の桁数(有効数字。P6 タスク3b)。
 *
 * 利用者の決定「解の表示は 9 桁で丸める」(docs/報告記録.md 2026-09-05)と同じ桁にする。
 * mm を inch へ割ると `10 / 25.4 = 0.3937007874015748` のように末尾が伸びるので、
 * **表示だけ**をここで丸める。**保存する式には 1 文字も書き戻さない**(丸めた値を式へ
 * 入れると、単位を切り替えるたびに文書が変わってしまう)。
 */
export const FIELD_VALUE_DISPLAY_DIGITS = 9;

/**
 * 数値 1 つを有効数字 `digits` 桁へ丸める(末尾の 0 は落ちる。`String()` の癖どおり)。
 * `0` と有限でない値はそのまま返す(`log10(0)` が `-Infinity` になるのを避ける)。
 *
 * P4b タスク23b-1 で `shell/PropertyPanel.tsx` に置いた同名の関数をここへ移した
 * (タスク3b)。**丸め方を 2 通り持たない**ため、あちらはこれを輸入して使う。
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
 * 欄の下へ添える「= 値」の右辺(P6 タスク3b)。
 *
 * 長さの欄で表示が inch のときだけ、**評価した値だけ**を inch へ直して単位を添える
 * (例: 内部 `10`mm → `0.393700787 in`)。式そのものは書き換えない(FR-202)。
 * それ以外(mm・角度・個数)は式エンジンの表示文字列をそのまま出す(P1 からの見え方)。
 */
export function fieldValueText(
  unit: FieldUnit,
  /* `ExpressionValue` をそのまま渡せる形。パラメータ表のように式を持たない値も渡せる。 */
  value: { readonly value: number; readonly display: string },
  lengthUnit: LengthUnit = 'mm',
): string {
  const text = fieldValueNumberText(unit, value, lengthUnit);
  return isLengthFieldUnit(unit) && lengthUnit === 'inch'
    ? `${text} ${t(INCH_FIELD_UNIT_KEY)}`
    : text;
}

/**
 * 同じ値の**数だけ**(単位の札を添えない)。単位を別の場所へ出す欄——読み取り専用の
 * 欄(derived、§0.a-0.30)のように、札が横に並んでいる場所で使う。
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
