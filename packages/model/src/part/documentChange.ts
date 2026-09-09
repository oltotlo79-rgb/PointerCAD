/**
 * 文書の差が「形に影響するか」の判定(要件§4.12、FR-1106〜1110、NFR-PF-1、NFR-PF-2)。
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.3.2、§0.a-0.3、タスク2。
 *
 * 外観(色・材質・柄)は形を変えない割り当てなので、外観だけが変わったときに
 * 再計算(全フィーチャーの解決 → カーネルとの往復)も「計算中」の札も起こしてはならない。
 * その判定を 1 か所に集めたのがこのファイルで、ui は
 * ①ストアの購読(再計算を起こすか)②`applyDocument` の `isComputing`(札を立てるか)
 * の 2 か所からだけ呼ぶ(§0.a-0.3「別の口は作らない」)。
 *
 * **なぜ参照の比較だけでよいか**: `PartDocument` とその配列は不変で、変更のたびに
 * 新しい配列・新しい文書を作る(`part/types.ts` の注釈、`createPartDocument.ts` の流儀)。
 * したがって「中身が同じなら同じ参照」であり、深い比較をしなくても
 * 「その欄が書き換えられたか」を参照の不一致だけで正しく判定できる。
 * 深い比較にすると 100 フィーチャーぶんの走査が毎回入り、NFR-PF-1 の 60fps を脅かす。
 */

import type { PartDocument } from './types.js';

/**
 * 欄ごとの「形に影響するか」の対応表。**`PartDocument` に欄が増えたら
 * `Record<keyof PartDocument, …>` が埋まらず型検査が落ちる**ので、
 * 新しい欄を足した担当は必ずここで「形に影響するか」を決めることになる
 * (rules/00-施行の仕組み.md の「気をつけるだけの対策を認めない」と同じ考え方)。
 *
 * 値は「その欄を取り出す関数」または `null`(形に影響しない欄)。
 * 関数にしているのは、欄の名前を文字列で索くと `as` が要るためで、
 * `as` / `any` を 1 つも使わずに網羅性だけを型で守るための形である。
 *
 * - `sketches` / `solids`: 形そのものの履歴。
 * - `references`: 基準ジオメトリ(FR-328、FR-329)。作業平面を動かすとその上のスケッチ、
 *   ひいては立体の形が変わる(§2.3.2 の表は P4 より前に書かれており、この欄が無かった)。
 * - `parameters`: 名前を付けた数値(FR-207)。値を変えると参照している全ての式が変わる
 *   (実際の書き換えは `reevaluatePart.ts` が `sketches` / `solids` も作り直すが、
 *   ここで見落とすと「パラメータだけ差し替えた文書」が再計算されずに残るため入れる)。
 * - `activeSketchId`: 編集中のスケッチが変わると `applyRecompute` が
 *   `resolvedSketch` / `sketchMesh` を差し替える必要がある(§2.3.2)。
 * - `id` / `name` / `schemaVersion`: 呼び名と版だけ。形は変わらない。
 * - `appearance`: **本題**。外観の割り当ては形を変えない(要件§4.12)。
 * - `selectionSets`: 選んだ組に名前を付けただけの札(FR-112、P6 §0.a-0.44)。指している
 *   面・辺・頂点は指紋(`SubShapeRef`)で持つので、セットを足しても消しても立体の形は
 *   1 ドットも変わらない。**外観とまったく同じ理由で `null`。**
 * - `canvases`: 下絵の画像(FR-332、P6 §0.a-0.45)。作図面に貼るだけで材料にならず、
 *   線への吸着も持たない(§0.a-0.47)ので形に影響しない。入切・不透明度・寸法合わせを
 *   変えても再計算を起こさない(§2.14 の表)。
 */
const SHAPE_FIELDS: Readonly<
  Record<keyof PartDocument, ((document: PartDocument) => unknown) | null>
> = {
  id: null,
  name: null,
  schemaVersion: null,
  sketches: (document) => document.sketches,
  activeSketchId: (document) => document.activeSketchId,
  references: (document) => document.references,
  solids: (document) => document.solids,
  parameters: (document) => document.parameters,
  appearance: null,
  selectionSets: null,
  canvases: null,
  namedViews: null,
  configurations: null,
  activeConfigurationId: null,
};

/**
 * 2 つの文書の差が形に影響するか(§2.3.2)。
 * 外観の割り当てだけが変わったときは `false` を返し、再計算を起こさない。
 */
export function affectsShape(previous: PartDocument, next: PartDocument): boolean {
  if (previous === next) {
    return false;
  }
  for (const select of Object.values(SHAPE_FIELDS)) {
    if (select !== null && select(previous) !== select(next)) {
      return true;
    }
  }
  return false;
}
