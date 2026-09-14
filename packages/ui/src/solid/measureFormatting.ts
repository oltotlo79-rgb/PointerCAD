import { expressionValueFromNumber } from '@pointercad/expression';
import { INCH_DISPLAY_DIGITS, MM_PER_INCH, type LengthUnit } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/**
 * 体積の表示(P6 タスク3、FR-811)。**単位の記号は付けずに数だけ**を返す
 * (記号は呼び出し側が `VOLUME_UNIT_KEYS` を引いて添える。既存の呼び出しと同じ形)。
 *
 * - `unit` が `'mm'`(既定): mm³ のまま、有効数字 12 桁で指数表記にしない(§2.4)。
 *   式エンジンの表示規則をそのまま使い、欄ごとに丸め方が違う状態を作らない。
 *   **P5 までの見た目を 1 文字も変えない**ので、引数を省いた呼び出しは以前と同じ文字を返す。
 * - `unit` が `'inch'`: in³ へ換算して小数 `INCH_DISPLAY_DIGITS` 桁(§2.9 の inch の桁)。
 *   例: `formatVolume(8000, 'inch')` = `(20/25.4)³` = `0.488189952757…` → `'0.488'`。
 *   **inch の桁を長さと体積で変えない**(`formatDisplayLength` と同じ 1 つの定数を見る)。
 */
export function formatVolume(volume: number, unit: LengthUnit = 'mm'): string {
  switch (unit) {
    case 'mm':
      return expressionValueFromNumber(volume).display;
    case 'inch':
      return (volume / (MM_PER_INCH * MM_PER_INCH * MM_PER_INCH)).toFixed(INCH_DISPLAY_DIGITS);
  }
}

/**
 * 面積の表示(P6 タスク3、FR-811)。`formatVolume` と同じ書式で、**換算の次数だけが違う**
 * (面積は 25.4 の 2 乗、体積は 3 乗)。
 *
 * P5 までは面積も `formatVolume` に通していた(mm のままなら数を整えるだけなので同じ結果に
 * なる)。inch では次数が違うと値そのものが間違うので、ここで分ける。`unit` を省いた
 * 呼び出しは `formatVolume` と 1 文字も変わらない。
 */
export function formatArea(area: number, unit: LengthUnit = 'mm'): string {
  switch (unit) {
    case 'mm':
      return expressionValueFromNumber(area).display;
    case 'inch':
      return (area / (MM_PER_INCH * MM_PER_INCH)).toFixed(INCH_DISPLAY_DIGITS);
  }
}

/** 体積に添える単位の記号の文言キー(NFR-MA-5)。単位が増えたら型検査がここを落とす。 */
export const VOLUME_UNIT_KEYS: Readonly<Record<LengthUnit, MessageKey>> = {
  mm: 'propertyPanel.unitCubicMillimeter',
  inch: 'propertyPanel.unitCubicInch',
};

/** 面積に添える単位の記号の文言キー(NFR-MA-5)。 */
export const AREA_UNIT_KEYS: Readonly<Record<LengthUnit, MessageKey>> = {
  mm: 'propertyPanel.unitSquareMillimeter',
  inch: 'propertyPanel.unitSquareInch',
};
