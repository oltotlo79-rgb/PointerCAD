/**
 * 質量特性の密度の掛け算と、測定結果の表示用の書式(FR-1101、FR-1102、
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.10.2、§0.a-0.32、タスク29)。
 *
 * `kernelBridge.ts` の `measure` が返す体積・慣性モーメントは**密度を掛けていない**
 * (mm³・mm⁵)。密度(g/cm³)を持っているのは model 側(質量の材料の表、
 * `appearance/densityMaterials.ts`)なので、**密度の掛け算はこのファイルの 2 関数
 * (`massFromVolume` / `inertiaWithDensity`)だけで行う**(統括の決定。kernel 側にも
 * 同じ計算をする `massProperties`(`occt/measureShape.ts`)があったが、二重に持たない
 * ため P5 §0.a-0.78・タスク42b で削除した。いま密度の掛け算はここだけにある)。
 *
 * `packages/model/src/kernelBridge.ts` は kernel の型を扱う唯一の場所(P0 §0.11)なので、
 * ここは kernel を一切 import しない**純粋な数値計算**だけを持つ。単位の変換
 * (g/cm³ → g/mm³)は `GRAM_PER_CM3_TO_GRAM_PER_MM3` の 1 か所だけで行う
 * (model は `kernelBridge.ts` 以外から `@pointercad/kernel` を import しない約束、
 * P0 §0.11。kernel 側にあった同名の定数はタスク42b で消えたので、いまはここが唯一の定義)。
 *
 * **数値精度(rules/04-設計の規律.md):** 計算そのもの(`massFromVolume` /
 * `inertiaWithDensity`)は一切丸めない。`formatMass` / `formatLength` は表示用の文字列
 * を作る関数で、桁数は `@pointercad/expression` の `expressionValueFromNumber` が使う
 * 表示規則(有効数字 12 桁、指数表記にしない)をそのまま流用する。欄ごとに丸め方が
 * 違う状態を作らないため(`packages/ui/src/solid/solidSummary.ts` の `formatVolume` と
 * 同じ考え方)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

/**
 * g/cm³ を g/mm³ へ直す係数(1 cm³ = 1000 mm³)。単位の変換はこの 1 か所だけで行う
 * (§0.a-0.32「密度の入力は g/cm³」)。
 */
export const GRAM_PER_CM3_TO_GRAM_PER_MM3 = 1e-3;

/** 1000g を超えたら kg で表示する(§0.a-0.32「質量は g(1000g 以上は kg)」)。 */
const GRAMS_PER_KILOGRAM = 1000;

/**
 * 1000mm を超えたら m で表示する。**この閾値は §0.a-0.32 に明記が無く、担当が
 * `formatMass` の g/kg の切替(1000 を境に)に揃えて決めたもの**(利用者への報告事項)。
 * 測定(FR-1102)で扱う距離・重心は通常 mm オーダーだが、大きい部品を測ったときに
 * 桁数がふくれないよう、質量と同じ切替を用意しておく。
 */
const MM_PER_METER = 1000;

/**
 * 体積(mm³)と密度(g/cm³)から質量(g)を求める(FR-1101)。
 * `体積 × 密度 × 1e-3`(§2.10.2 の表)。丸めない。
 */
export function massFromVolume(volumeMm3: number, densityGPerCm3: number): number {
  return volumeMm3 * densityGPerCm3 * GRAM_PER_CM3_TO_GRAM_PER_MM3;
}

/**
 * 密度を掛けていない体積の 2 次モーメント(mm⁵、kernel の `MeasureOutcome.principalMoments`
 * そのまま)を、密度(g/cm³)つきの慣性モーメント(g·mm²)へ直す(FR-1101、§0.a-0.32)。
 * 密度が一様なので重心・主軸の向きは変わらず、大きさに `1e-3 × densityGPerCm3` を
 * 掛けるだけでよい(`kernelBridge.ts` の `MeasureOutcome` の注釈と同じ理屈)。丸めない。
 */
export function inertiaWithDensity(momentMm5: number, densityGPerCm3: number): number {
  return momentMm5 * densityGPerCm3 * GRAM_PER_CM3_TO_GRAM_PER_MM3;
}

/**
 * 質量(g)を表示用の文字列にする(FR-1101)。**1000g 以上は kg**(§0.a-0.32)。
 * 数の書式は `expressionValueFromNumber(...).display` に任せる(有効数字 12 桁、
 * 指数表記にしない。桁を丸めるための独自の書式は作らない)。
 */
export function formatMass(grams: number): string {
  if (Math.abs(grams) >= GRAMS_PER_KILOGRAM) {
    return `${expressionValueFromNumber(grams / GRAMS_PER_KILOGRAM).display} kg`;
  }
  return `${expressionValueFromNumber(grams).display} g`;
}

/**
 * 長さ(mm)を表示用の文字列にする(FR-1102)。**1000mm 以上は m**(担当の判断。
 * このファイル冒頭の `MM_PER_METER` の注釈を参照)。`formatMass` と同じく数の書式は
 * `expressionValueFromNumber(...).display` に任せる。
 */
export function formatLength(millimeters: number): string {
  if (Math.abs(millimeters) >= MM_PER_METER) {
    return `${expressionValueFromNumber(millimeters / MM_PER_METER).display} m`;
  }
  return `${expressionValueFromNumber(millimeters).display} mm`;
}
