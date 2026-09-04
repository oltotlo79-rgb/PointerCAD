/**
 * 外観(色・材質・柄・透過率/光沢/粗さ)の型(要件§4.12、FR-1106〜1110、
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.2.1、§0.a-0.1、タスク1)。
 *
 * 外観は形を変えない「割り当て」であり、フィーチャー履歴(`part/types.ts` の
 * `PartDocument.solids`)には入れず、`PartDocument.appearance`(タスク2)に別に持つ。
 * 色を変えても再計算(B-rep の作り直し)を起こさないための決めであり、鍵(`cacheKeyFor`)
 * にも混ぜない(§2.2.3)。
 *
 * 置き場について: `part`(立体の履歴)にも `sketch` にも実体として依存させたくないので、
 * `geometry/subShapeRef.ts` と同じ中立の置き場(`appearance/`)にまとめる。面の割り当て先は
 * 部分形状の指紋(`SubShapeRef`)で持ち、再計算のたびにカーネルが選び直す
 * (§2.2.3、タスク3・4)。
 *
 * 依存方向について: `@pointercad/kernel` は import しない(rules/04-設計の規律.md)。
 */

import type { ExpressionValue } from '@pointercad/expression';

import type { SubShapeRef } from '../geometry/subShapeRef.js';

/**
 * 材質プリセットの id(§2.4.1、11 種)。`'custom'` はプリセットの値を利用者が個別に
 * 変えたときの状態を表し、`materialPresets.ts` の表を介さず `AppearanceSpec` の値を
 * そのまま使う(FR-1109「個別の調整」)。
 */
export type AppearancePresetId =
  | 'default'
  | 'steel'
  | 'checkerPlate'
  | 'expandedMetal'
  | 'aluminum'
  | 'stainless'
  | 'plastic'
  | 'wood'
  | 'mirror'
  | 'glass'
  | 'custom';

/** 木材の樹種(6 種、§0.a-0.5)。 */
export type WoodSpecies = 'hinoki' | 'sugi' | 'oak' | 'walnut' | 'teak' | 'maple';

/**
 * 外観の割り当て先(§0.a-0.1)。立体全体(`kind: 'body'`。フィーチャー id で指す。
 * 「1 フィーチャー = 最大 1 ボディ」の規約により、ボディの id はフィーチャー id と同じ)、
 * または面 1 枚(`kind: 'face'`。部分形状の指紋(`SubShapeRef`)で持ち、再計算のたびに
 * カーネルが選び直す。FR-1106)。
 */
export type AppearanceTarget =
  | { readonly kind: 'body'; readonly bodyFeatureId: string }
  | { readonly kind: 'face'; readonly ref: SubShapeRef };

/**
 * 柄(手続き的テクスチャ、FR-1108)。繰り返しの間隔(mm)は式で持ち、テクスチャを作り直さずに
 * `texture.repeat` を変えるだけで反映する(§0.a-0.6、ui タスク8)。画像ファイルは使わない。
 */
export type AppearancePattern =
  | { readonly kind: 'none' }
  | { readonly kind: 'expandedMetal'; readonly spacing: ExpressionValue }
  | { readonly kind: 'checkerPlate'; readonly spacing: ExpressionValue }
  | {
      readonly kind: 'woodGrain';
      readonly spacing: ExpressionValue;
      readonly species: WoodSpecies;
    };

/**
 * 見た目そのもの(FR-1107、FR-1109)。プリセットを選ぶと下の 5 つがまとめて決まるが、
 * 選んだ後にそれぞれを個別に式で調整できる(FR-1109)。
 */
export interface AppearanceSpec {
  /** 材質プリセットの id(§2.4.1)。値を個別に変えると `'custom'` になる(ui タスク11)。 */
  readonly preset: AppearancePresetId;
  /** 色(`#rrggbb`、小文字16進)。色見本と数値(RGB / 16進)の両方で指定できる(FR-1109)。 */
  readonly color: string;
  /** 透過率 0〜100(%)。ガラスは式で指定できる(FR-1107)。 */
  readonly transmission: ExpressionValue;
  /** 光沢 0〜100(%)。ui 側で three.js の `metalness` へ写す。 */
  readonly gloss: ExpressionValue;
  /** 粗さ 0〜100(%)。ui 側で three.js の `roughness` へ写す。 */
  readonly roughness: ExpressionValue;
  readonly pattern: AppearancePattern;
}

/** 外観の割り当て 1 つ(FR-1106〜1110)。id は Undo と「1 つずつ外す」に使う。 */
export interface AppearanceEntry {
  /** 割り当ての id(採番は `appearance-<n>`、`appearanceTable.ts` の `nextAppearanceId`)。 */
  readonly id: string;
  readonly target: AppearanceTarget;
  readonly appearance: AppearanceSpec;
}

/** 外観の割り当て表。`PartDocument.appearance`(タスク2)の中身。 */
export interface AppearanceTable {
  readonly entries: readonly AppearanceEntry[];
}
