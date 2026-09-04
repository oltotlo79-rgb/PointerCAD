/**
 * 部品文書に対する外観の操作と、割り当ての優先順位(FR-1106、FR-1110、要件§4.12)。
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.2.2、§0.a-0.1、タスク2。
 *
 * `appearanceTable.ts`(タスク1)は「表」だけを扱う。ここはその上に薄く乗る層で、
 * `PartDocument` を受け取って新しい `PartDocument` を返す純関数だけを置く
 * (`part/createPartDocument.ts` の `appendSolid` / `replaceSolid` と同じ流儀)。
 * 表の作り方そのものは 1 か所(`appearanceTable.ts`)にしかない。
 *
 * **何も変わらないときは元の文書を同一参照のまま返す。** 外観の変更が再計算を起こさない
 * 仕組み(`part/documentChange.ts` の `affectsShape`)は参照の比較で動くので、
 * 無駄に作り直すと「何も変えていないのに再計算」が起きうるため。
 */

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { liveBodyIds } from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';
import {
  assignAppearance,
  bodyAppearanceOf,
  clearAppearance,
  emptyAppearanceTable,
  isSameAppearanceTarget,
  pruneAppearance,
  removeAppearance,
} from './appearanceTable.js';
import { DEFAULT_APPEARANCE } from './materialPresets.js';
import type { AppearanceSpec, AppearanceTable, AppearanceTarget } from './types.js';

/**
 * 欄が無いときに使う空の表。**毎回作らず 1 つを使い回す**ので、割り当てが 1 つも無い文書
 * どうしでは `appearanceOf` の戻りが同一参照になり、`affectsShape` が余計に真にならない。
 */
const EMPTY_TABLE: AppearanceTable = emptyAppearanceTable();

/**
 * 文書の外観の表(FR-1106)。`appearance` の欄は版 6(タスク5)で `packages/io` が
 * 読み書きするまで省略できる(`part/types.ts` の注釈)ので、無ければ空の表として扱う。
 * 欄が必須になった後もこの関数を通しておけば呼び出し側は変わらない。
 */
export function appearanceOf(document: PartDocument): AppearanceTable {
  return document.appearance ?? EMPTY_TABLE;
}

/** 表を差し替えた文書を返す。表が変わっていなければ元の文書をそのまま返す。 */
function withAppearance(document: PartDocument, table: AppearanceTable): PartDocument {
  if (table === appearanceOf(document)) {
    return document;
  }
  return { ...document, appearance: table };
}

/**
 * 立体 1 つ(= フィーチャー 1 つが作るボディ)へ外観を割り当てる(FR-1106)。
 * 同じ立体にすでに割り当てがあれば差し替える(§2.2.2「同じ対象に 2 つ以上の割り当てを重ねない」)。
 */
export function assignBodyAppearance(
  document: PartDocument,
  bodyFeatureId: string,
  spec: AppearanceSpec,
): PartDocument {
  const target: AppearanceTarget = { kind: 'body', bodyFeatureId };
  return withAppearance(document, assignAppearance(appearanceOf(document), target, spec));
}

/**
 * 面 1 枚へ外観を割り当てる(FR-1106)。面は部分形状の指紋(`SubShapeRef`)で持ち、
 * 再計算のたびにカーネルが選び直す(§2.2.3、タスク3・4)。
 */
export function assignFaceAppearance(
  document: PartDocument,
  ref: SubShapeRef,
  spec: AppearanceSpec,
): PartDocument {
  const target: AppearanceTarget = { kind: 'face', ref };
  return withAppearance(document, assignAppearance(appearanceOf(document), target, spec));
}

/** 割り当てを 1 つ外す(FR-1110)。見つからなければ元の文書をそのまま返す。 */
export function removeDocumentAppearance(document: PartDocument, id: string): PartDocument {
  return withAppearance(document, removeAppearance(appearanceOf(document), id));
}

/** すべての割り当てを外して既定の外観に戻す(FR-1110「すべて既定に戻す」)。 */
export function clearDocumentAppearance(document: PartDocument): PartDocument {
  return withAppearance(document, clearAppearance(appearanceOf(document)));
}

/**
 * 上流のフィーチャーが消えた・消費された・抑制されたことで**画面に出なくなったボディ**を
 * 指す割り当てを落とす(掃除)。
 *
 * 生きているボディの判定は `liveBodyIds`(`part/createPartDocument.ts`)を正本にする。
 * 「押し出しを消すと、その面に付けた色の割り当ても消える」のはこの掃除による。
 * 掃除するものが無ければ元の文書をそのまま返す。
 */
export function pruneDocumentAppearance(document: PartDocument): PartDocument {
  return withAppearance(document, pruneAppearance(appearanceOf(document), liveBodyIds(document)));
}

/**
 * ある対象に効いている外観(§2.2.2 の 3 段の優先順位)。
 *
 * ```
 * 1. その面を直接指す面の割り当て
 * 2. 無ければ、その面が属するボディ(立体)の割り当て
 * 3. 無ければ既定の外観
 * ```
 *
 * ここで見るのは**指紋が同じ面**だけである(`isSameAppearanceTarget`)。形が変わって
 * 面の通し番号がずれたときの「選び直し」は採点付きの照合が要り、カーネルが再計算の
 * ついでに行う(§0.a-0.2、タスク3・4)。採点を model に複製しないための線引き。
 */
export function resolveAppearanceFor(
  table: AppearanceTable,
  target: AppearanceTarget,
): AppearanceSpec {
  const direct = table.entries.find((entry) => isSameAppearanceTarget(entry.target, target));
  if (direct !== undefined) {
    return direct.appearance;
  }
  const bodyFeatureId = target.kind === 'body' ? target.bodyFeatureId : target.ref.bodyFeatureId;
  return bodyAppearanceOf(table, bodyFeatureId) ?? DEFAULT_APPEARANCE;
}
